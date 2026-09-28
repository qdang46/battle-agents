import type { GameEvent } from '@battle-agents/core';
import type { AgentEvent } from '@battle-agents/protocol';

import { checkBatchSize, parseEventBatch, type BatchLimits } from './event-batch.js';
import { describeHttpFailure } from './http-failure.js';
import { encodeStreamFrame, type EventStreamHub } from './event-stream.js';
import type { HttpRequest, HttpResponse } from './routes.js';

/**
 * The two telemetry-plane routes, as pure functions.
 *
 * They take their collaborators as arguments and return an `HttpResponse`, so
 * the whole ingest path — auth, size gate, parse, session resolution, emit, SSE
 * — is exercisable in a unit test with fakes and no server, a socket or a
 * database. That is the property the existing five-primitive routes have and the
 * reason this file is split out from `routes.ts` rather than appended to it:
 * those route the application API, this one owns a request body it must inspect
 * before it can even be turned into one.
 *
 * Like the routes in `routes.ts`, these decide nothing about the game. Whether
 * an event is worth a row belongs to the runtime's persistence policy, not to a
 * handler; whether it is worth showing belongs to the hub. A handler that grew a
 * second opinion of either would be a second answer to a question another layer
 * already owns.
 */

/** The installation a presented Bearer token resolved to. */
export interface EventCaller {
  readonly installationId: string;
}

/** A session the caller's installation owns, as the ownership query returns it. */
export interface ResolvedSession {
  readonly id: string;
  readonly agentId: string;
  readonly status: string;
}

export interface EventRouteDependencies {
  readonly limits: BatchLimits;
  /**
   * Resolves the Bearer token to an installation. Throws an authentication
   * failure (an `Error` carrying a `reason` string) when the token is absent,
   * unknown, revoked, expired or in a URL.
   */
  readonly authenticate: (request: HttpRequest) => Promise<EventCaller>;
  /**
   * Finds a session ONLY if the named installation owns it.
   *
   * Ownership lives in the query, not in a comparison a route could forget: a
   * session belonging to somebody else is `undefined`, the same answer as one
   * that does not exist, so this route cannot be used to discover which session
   * ids are real.
   */
  readonly resolveSession: (
    sessionId: string,
    installationId: string,
  ) => Promise<ResolvedSession | undefined>;
  /**
   * Finds a session by the id ITS HARNESS uses, for the same installation.
   *
   * Separate from `resolveSession` rather than folded into it, because the two
   * answer different questions and conflating them would let a harness name a
   * session by an id it does not own. `resolveSession` is "is this the platform's
   * id"; this is "is this one of MY runs, which you happen to call that".
   *
   * Without it the real adapter is dead on arrival: `agent-battle-claude` posts
   * under the id Claude Code wrote into a filename, the platform's ids come from
   * the database, and every batch is refused with `no such session`.
   */
  readonly resolveSessionByHarnessRef?: (
    harnessSessionRef: string,
    installationId: string,
  ) => Promise<ResolvedSession | undefined>;
  /** The runtime's emit. Persists key events and publishes to the bus. */
  readonly emit: (event: GameEvent) => Promise<void>;
  /** The realtime fan-out. Read by the stream route, never by the ingest route. */
  readonly hub: EventStreamHub;
}

const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Proxies that buffer a response would defeat the whole point of a stream.
  'X-Accel-Buffering': 'no',
};

/**
 * Both event routes, as one dispatcher.
 *
 * Separate from `createRoutes` because it is a different surface with a
 * different body: the five primitives never look at a request body, and this one
 * cannot route without doing so. Same `HttpRequest`/`HttpResponse` shapes, so
 * the Next.js adapters and their tests read identically.
 */
export function createEventRoutes(
  dependencies: EventRouteDependencies,
): (request: HttpRequest) => Promise<HttpResponse> {
  return async (request: HttpRequest) => {
    const url = new URL(request.url);
    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'POST /api/events':
          return await postEvents(dependencies, request);
        case 'GET /api/events/stream':
          return streamEvents(dependencies);
        default:
          return { status: 404, body: { error: 'not found', path: url.pathname } };
      }
    } catch (error) {
      return describeHttpFailure(error);
    }
  };
}

/**
 * `POST /api/events` — a batch of agent telemetry, in.
 *
 * The order of the steps is the contract, not a style choice:
 *
 *   1. size gate, before authentication and before any parsing, so a flood is
 *      refused in constant time and the server never does the flood's work;
 *   2. authenticate, so nothing else happens to an unpresented token;
 *   3. parse, which is where the per-event zod validation and the protocol
 *      version check actually cost anything, and only a batch already known to
 *      be a reasonable size gets that far;
 *   4. resolve the session against the caller's installation;
 *   5. emit, which persists the key events and publishes every event to the bus.
 *
 * `resumed` reports that the resolved session was `disconnected` — this batch is
 * a run that had gone quiet and is reporting in again. It is a report, not a
 * transition: moving a session's status is the session lifecycle's job (via
 * heartbeat and the sweeper), and doing it here would give the ingest path a
 * second, quieter opinion about when a run is alive.
 */
/**
 * The session a batch of events is about, by either name.
 *
 * The platform id is tried first, and the harness ref second. The order is the
 * whole contract: a client that has a real platform session is on the fast, exact
 * path, and only an adapter that has no way to learn the platform's id falls
 * through to the ref it supplied at handshake.
 *
 * Both lookups are ownership-scoped by the same installation, so a fallback here
 * widens nothing — it only recognises a run the caller was already entitled to
 * write to, under a different name.
 *
 * ## Why the first lookup is GUARDED
 *
 * `sessions.id` is a `uuid` column, and a harness's own id is whatever that
 * harness calls a run. Goose names them `20260926_104500`; Aider names them
 * `<transcript path>#<timestamp>`. Passing either to the id query does not
 * return nothing — Postgres raises `invalid input syntax for type uuid`, the
 * whole ingest answers 500, and the batch is lost.
 *
 * It looks like a data problem and is a type problem, which is why the check is
 * here rather than in the repository: a repository cannot be asked "is this not
 * a uuid, then do not look" without every caller remembering to ask.
 */
async function resolveForIngest(
  dependencies: EventRouteDependencies,
  sessionId: string,
  installationId: string,
): Promise<ResolvedSession | undefined> {
  if (isPlatformSessionId(sessionId)) {
    const byId = await dependencies.resolveSession(sessionId, installationId);
    if (byId !== undefined) return byId;
  }
  if (dependencies.resolveSessionByHarnessRef === undefined) return undefined;
  return await dependencies.resolveSessionByHarnessRef(sessionId, installationId);
}

/**
 * Whether this could be a platform session id at all.
 *
 * Deliberately the same shape the column accepts, and deliberately not a parse:
 * a stricter check would reject ids the database would have found, and the
 * fallback below is ownership-scoped, so a wrong guess costs a query and not
 * access.
 */
function isPlatformSessionId(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

async function postEvents(
  dependencies: EventRouteDependencies,
  request: HttpRequest,
): Promise<HttpResponse> {
  const oversize = checkBatchSize(request.body, dependencies.limits);
  if (oversize !== undefined) {
    return tooLarge(oversize.limit, dependencies.limits);
  }

  // A failed authenticate throws an authentication failure and is turned into
  // a 401 by the shared failure mapping, the same as any other failure —
  // so there is no second mapping to drift out of step with the first.
  const caller = await dependencies.authenticate(request);

  const parsed = parseEventBatch(request.body);
  if (!parsed.ok) {
    if (parsed.kind === 'protocol-mismatch') {
      return {
        status: 400,
        body: {
          error: 'protocol version mismatch',
          expectedProtocol: parsed.expected,
          receivedProtocol: parsed.received,
        },
      };
    }
    return { status: 400, body: { error: parsed.message } };
  }

  // One session per batch. The response names a single `sessionId` and
  // ownership is resolved for one, so a batch spanning two sessions is either a
  // client bug or an attempt to write one session's events into another's log.
  // Both are refused rather than guessed at.
  const first = parsed.events[0];
  if (first === undefined) {
    return { status: 400, body: { error: 'batch carries no events' } };
  }
  const sessionId = first.sessionId;
  if (parsed.events.some((event) => event.sessionId !== sessionId)) {
    return {
      status: 400,
      body: { error: 'a batch must carry events for exactly one session' },
    };
  }

  const session = await resolveForIngest(dependencies, sessionId, caller.installationId);
  if (session === undefined) {
    return { status: 404, body: { error: 'no such session' } };
  }

  for (const event of parsed.events) {
    // The harness's own session id STOPS HERE.
    //
    // It is how the batch was addressed and it is how the run was found, and
    // past this line it is not a thing the platform has. Everything downstream —
    // `event_log.session_id`, the store, the replay, the world's characters — is
    // keyed on the platform's id, and that column is a `uuid`. A harness that
    // names its runs `20260926_104500`, or `<transcript path>#<timestamp>`,
    // otherwise writes its own vocabulary into a uuid column and the insert
    // fails with a query error that names a table rather than a boundary.
    //
    // So the id is translated on the way in, which is what "adapters translate,
    // the game decides" means at the last point where both are present.
    await dependencies.emit(toGameEvent(event, session.agentId, session.id));
  }

  return {
    status: 200,
    body: {
      accepted: parsed.events.length,
      sessionId,
      resumed: session.status === 'disconnected',
    },
  };
}

/**
 * `GET /api/events/stream` — the realtime fan-out, as server-sent events.
 *
 * The response body is a `ReadableStream` and the frames are pulled from the hub
 * by the stream's own `pull` callback. That is deliberate rather than incidental:
 * a `pull`-driven stream only asks for a frame when the consumer is ready for
 * one, so a browser that stops reading stops being pulled from, its hub queue
 * grows, and the hub closes it for falling behind. The backpressure is the
 * browser's own, and no polling loop is needed to notice it.
 *
 * AUTHENTICATION IS NOT HERE, and that is deliberate rather than an omission.
 * This function is pure — collaborators in, `HttpResponse` out — and it knows
 * nothing about web sessions. The check lives in the Next.js adapter at
 * `app/api/events/stream/route.ts`, which reads the session cookie through
 * `resolveViewer`, because a browser `EventSource` cannot present a Bearer
 * header and this repository forbids tokens in URLs.
 *
 * It was open, and the comment above used to say that was on purpose, on the
 * grounds that scoping "arrives with the game client". `docs/design/
 * public-event-stream.md` rules the other way and is the document that decided
 * the classification: until authentication AND scoping exist, the stream is
 * closed, not open and filtered. The endpoint now answers 401 to a reader with
 * no session. Scoping — one battle, one user, or the whole arena — the same
 * paragraph defers, because the classification is already safe for anyone.
 *
 * The classification below is therefore still load-bearing: it is what makes the
 * stream safe to hand to a signed-in viewer rather than what makes it safe to
 * hand to the internet.
 */
function streamEvents(dependencies: EventRouteDependencies): HttpResponse {
  // Explicit: this is the spectator view, so the public classification applies.
  const subscriber = dependencies.hub.subscribe('public');
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const frame = await subscriber.pull();
      if (frame === undefined) {
        // The hub closed this subscriber — it fell too far behind, or the server
        // is shutting down. Ending the stream is what makes the browser
        // reconnect, and the reconnect is what fetches the fresh full_state.
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(encodeStreamFrame(frame)));
    },
    cancel() {
      subscriber.close();
    },
  });

  return { status: 200, headers: SSE_HEADERS, body };
}

/**
 * An agent event as a platform event.
 *
 * The whole validated event becomes the payload, so `sessionId` travels with it
 * and the store lifts it into the `session_id` column — the value the replay
 * filters on. `occurredAt` is the agent's own `at`, not the arrival time: a
 * delayed batch should be ordered by when things happened, not by when the
 * network finished. `actorId` is the session's agent, which is the one that owns
 * this run.
 */
function toGameEvent(event: AgentEvent, actorId: string, platformSessionId: string): GameEvent {
  return {
    type: event.type,
    occurredAt: event.at,
    actorId,
    // The payload is the whole validated event, re-addressed. `sessionId` is the
    // ONE field rewritten, because it is the one field the platform owns a
    // different name for; everything else — the harness, the tool, the suite,
    // the test count — is the adapter's to choose and is carried through as
    // written. The rewrite is conditional so a caller that already holds a
    // platform id is not handed a copy that merely looks rewritten.
    payload:
      event.sessionId === platformSessionId
        ? event
        : { ...event, sessionId: platformSessionId },
  };
}

function tooLarge(limit: number, limits: BatchLimits): HttpResponse {
  const retryAfter = String(limits.retryAfterSeconds);
  return {
    status: 413,
    // The header is the instruction. A refusal with no timing in it is a
    // backpressure signal the client can only respond to by guessing, and the
    // guess it is most likely to make — retry now — is the one that turns a
    // refusal into a stampede.
    headers: { 'Retry-After': retryAfter },
    body: { error: 'batch too large', limit, retryAfterSeconds: limits.retryAfterSeconds },
  };
}
