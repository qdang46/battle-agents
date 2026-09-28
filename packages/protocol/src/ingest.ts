import { PROTOCOL_VERSION } from './version.js';
import type { AgentEvent } from './agent-event.js';

/**
 * The way out: `POST /api/events`, which is the only thing an adapter does with
 * the network.
 *
 * WHY IT LIVES HERE. It was one adapter's file — `packages/adapters/codex/src/
 * ingest.ts` — whose own comment said the duplication was deliberate "for now"
 * and named the condition that would end it: "the honest fix is one client in
 * protocol once the second adapter needs it". The second adapter is here. An
 * adapter may not import another adapter, so a copy per adapter was the only
 * alternative, and a third copy of a 150-line transport is the drift this
 * package already exists to prevent — the batching rules were lifted here for
 * exactly that reason, one bead earlier. Adapters may import this; nothing else
 * outside protocol should.
 *
 * The batching RULES stayed here too, so the client and the buffer that feeds
 * it are one contract in one package. A client that invented its own size limit
 * would be refused by the very endpoint it posts to.
 *
 * The body shape is `{ protocolVersion, events }` under a Bearer token, read off
 * apps/web/src/event-batch.ts. A client that sends a bare array is refused with a
 * 400 naming a body that must be an object.
 */

/** The part of a `Response` this client reads, so a test can pass a plain object. */
export interface HttpResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface FetchLike {
  (url: string, init: HttpRequestInit): Promise<HttpResponseLike>;
}

export interface HttpRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface IngestOptions {
  /** The server root. `/api/events` is appended; a trailing slash is tolerated. */
  readonly baseUrl: string;
  /** The installation's credential, presented as a Bearer token. */
  readonly token: string;
  /** Injectable so a test exercises the wire without a socket. */
  readonly fetch?: FetchLike;
  /** Injectable so a test proves the backoff without sleeping through it. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Where a watcher hands off a batch. Structurally the type every adapter declares. */
export type IngestSender = (batch: readonly AgentEvent[]) => Promise<void>;

/** A batch the server would not take, carrying enough to say why. */
export class IngestRefusedError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`the ingest endpoint refused a batch with ${status}: ${detail}`);
    this.name = 'IngestRefusedError';
    this.status = status;
    this.detail = detail;
  }
}

const EVENTS_PATH = '/api/events';
const CONTENT_TYPE = 'application/json';

/**
 * A server that advertises a `Retry-After` this client cannot read is treated
 * as having said nothing, and the default is used. A refusal with no timing in
 * it is a signal the client can only answer by guessing, and the guess that
 * turns a refusal into a stampede is the one not to make.
 */
const DEFAULT_RETRY_AFTER_MS = 1_000;

const MAX_RETRY_AFTER_MS = 60_000;

function eventsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${EVENTS_PATH}`;
}

function retryAfterMs(response: HttpResponseLike): number {
  const raw = response.headers.get('retry-after');
  if (raw === null) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/**
 * A sender that posts batches to the ingest endpoint.
 *
 * The three server rules are all answered here rather than assumed. The size
 * limit is answered by `EventBuffer`, so this client is already inside it; a
 * refusal still arrives when a deployment configures the server tighter than
 * the client, and waiting alone cannot fix that — the batch is still too big a
 * second later. So a 413 is answered by BOTH halves of the instruction: the
 * `Retry-After` pause the header asks for, and a split, because the thing the
 * server objected to was the size. Splitting halves a batch and strictly
 * reduces it, so it terminates, and every event is still sent exactly once.
 *
 * Everything else is refused rather than retried. A 400 means the bytes are
 * wrong and the same bytes are wrong next time; a 404 means the session is not
 * one this installation owns, which is a registration problem and not something
 * a loop can talk its way out of; a 5xx leaves it genuinely unknown whether the
 * batch landed, and an event carries no id for the server to deduplicate a
 * second copy against, so retrying would trade a possible loss for a possible
 * duplicate. The honest answer to that is a caller that decides, which is the
 * daemon's job and not this file's.
 */
export function createIngestSender(options: IngestOptions): IngestSender {
  const url = eventsUrl(options.baseUrl);
  const doFetch: FetchLike = options.fetch ?? ((u, init) => fetch(u, init));
  const wait: (ms: number) => Promise<void> = options.sleep ?? defaultSleep;

  async function post(batch: readonly AgentEvent[]): Promise<void> {
    // An empty batch is not a request. The server answers a body with no events
    // with a 400, and a caller whose buffer emptied between the check and the
    // call would learn nothing useful from that.
    if (batch.length === 0) return;

    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': CONTENT_TYPE,
        authorization: `Bearer ${options.token}`,
      },
      // The version travels with every batch because the server refuses a
      // mismatch outright rather than guessing, and a client that only sends
      // it at handshake has no way to learn it is wrong until it is too late.
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, events: batch }),
    });

    if (response.status === 200) return;

    if (response.status === 413) {
      await wait(retryAfterMs(response));
      const middle = Math.ceil(batch.length / 2);
      await post(batch.slice(0, middle));
      await post(batch.slice(middle));
      return;
    }

    throw new IngestRefusedError(response.status, await response.text());
  }

  return post;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `POST /api/sessions` — the HELLO handshake an adapter has to make before it
 * can post anything.
 *
 * ## Why this exists here
 *
 * The ingest sender posts a batch and, until this was written, nothing else
 * existed on the client side of the handshake. So a real adapter started, read a
 * real transcript, derived a real session id from the filename, and was refused
 * with `no such session` on every batch forever — because the platform mints its
 * own session ids from the database and the two could never be the same string.
 *
 * It lives beside the ingest sender because that is the transport for "this
 * harness is talking to that platform", and the handshake is the first half of
 * that sentence. A separate `handshake.ts` would be a second place that knows
 * the base URL and the token.
 *
 * ## What it sends
 *
 * `harnessSessionRef` is the whole point. The platform keeps its own id and does
 * not let a client name a session; recording which of the HARNESS's runs this is
 * is what lets `POST /api/events` — addressed by the id in a filename — find the
 * row again. See `CreateSessionInput.harnessSessionRef`.
 */
export interface HelloOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly agentName: string;
  readonly harness: string;
  /** The id THIS harness uses for the run. The adapter reads it off the filename. */
  readonly harnessSessionRef: string;
  readonly projectKey?: string | undefined;
  readonly fetch?: FetchLike;
}

export interface HelloResult {
  readonly sessionId: string;
  readonly agentId: string;
  readonly resumed: boolean;
}

/** The handshake was refused, carrying the server's own words. */
export class HelloRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`the handshake was refused (${status}): ${describeBody(body)}`);
    this.name = 'HelloRefusedError';
  }
}

function describeBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null && 'error' in body) {
    return String((body as { readonly error: unknown }).error);
  }
  return JSON.stringify(body);
}

export async function sayHello(options: HelloOptions): Promise<HelloResult> {
  const doFetch: FetchLike = options.fetch ?? ((u, init) => fetch(u, init));
  const response = await doFetch(`${options.baseUrl.replace(/\/$/, '')}/api/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.token}`,
    },
    body: JSON.stringify({
      agentName: options.agentName,
      harness: options.harness,
      harnessSessionRef: options.harnessSessionRef,
      ...(options.projectKey === undefined ? {} : { projectKey: options.projectKey }),
    }),
  });

  // `text()` rather than `json()`: `HttpResponseLike` is the narrow shape the
  // ingest sender already declared so a test can pass a plain object, and it
  // exposes no `json`. Reading the body as text and parsing here keeps one
  // response type for both halves of this client.
  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  if (response.status !== 201 && response.status !== 200) {
    // Named rather than swallowed. An adapter that cannot open a run is not an
    // adapter that is idle, and the difference is the whole reason a person
    // looks at the log at all.
    throw new HelloRefusedError(response.status, body);
  }
  const result = body as { readonly sessionId?: unknown; readonly agentId?: unknown };
  if (typeof result.sessionId !== 'string') {
    throw new HelloRefusedError(response.status, body);
  }
  return {
    sessionId: result.sessionId,
    agentId: typeof result.agentId === 'string' ? result.agentId : '',
    resumed: false,
  };
}

/**
 * An ingest sender that opens the platform run before it posts.
 *
 * ## Why this wraps the sender rather than living in a watcher
 *
 * Every adapter's watcher already emits events carrying a `sessionId`, and
 * every one of them posts through `createIngestSender`. The missing piece — the
 * HELLO handshake — was therefore added, once, here, rather than to nine
 * watchers. An adapter that emits a `sessionId` is connected; one that does not
 * is not, and there is no per-harness code to forget.
 *
 * That is also the shape the M7 promise needs to be true: "a new CLI is one
 * subdirectory" has to mean one subdirectory. With the handshake here, it does.
 *
 * ## Why it opens lazily
 *
 * A watcher does not know a session exists until it has read a line about it, so
 * a handshake taken at start-up would name a session nothing has observed yet.
 * Keying on the id found in the events means the run is opened at the moment it
 * becomes real, and each id is opened exactly once — measured, not assumed: a
 * watcher that alternates between the two most recently written transcripts
 * opened a new run on every alternation, eleven in twenty seconds, and the city
 * filled with one character standing in several places.
 *
 * ## What a refusal does
 *
 * Throws. An adapter that cannot open a run is not an adapter that is idle, and
 * the difference is the whole reason a person reads the log. A swallowed refusal
 * is an adapter running happily into a server that refuses every batch.
 */
export interface SessionOpeningOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** The character this installation plays. Resolved BY NAME at handshake. */
  readonly agentName: string;
  /** The harness enum value this process speaks for. */
  readonly harness: string;
  readonly fetch?: FetchLike;
  /** Notified once per opened run. For a log line, and for a test. */
  readonly onOpened?: (sessionId: string) => void;
}

export interface SessionOpeningSender {
  (batch: readonly AgentEvent[]): Promise<void>;
  /** Harness sessions this sender has opened a run for. */
  readonly opened: ReadonlySet<string>;
}

export function createSessionOpeningSender(
  options: SessionOpeningOptions,
  send: IngestSender,
): SessionOpeningSender {
  const opened = new Set<string>();

  const guarded = async (batch: readonly AgentEvent[]): Promise<void> => {
    // Every session id in the batch, opened before any of it goes out. A batch
    // is refused at the door if the session is unknown, so this has to happen
    // first — and doing it per batch rather than per event means a batch that
    // names one session costs one lookup, which the set makes free anyway.
    const seen = new Set<string>();
    for (const event of batch) {
      const id = event.sessionId;
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      if (opened.has(id)) continue;
      opened.add(id);
      await sayHello({
        baseUrl: options.baseUrl,
        token: options.token,
        agentName: options.agentName,
        harness: options.harness,
        harnessSessionRef: id,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      options.onOpened?.(id);
    }
    await send(batch);
  };

  return Object.assign(guarded, { opened });
}
