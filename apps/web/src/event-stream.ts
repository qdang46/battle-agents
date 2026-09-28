import type { EventBus, GameEvent } from '@battle-agents/core';
import { PROTOCOL_VERSION, getZoneForTool } from '@battle-agents/protocol';

/**
 * The realtime fan-out: an in-process hub that turns the event bus into
 * `full_state`-then-`delta` server-sent streams.
 *
 * Plan section 7.2 is the reason this file exists and the reason it is NOT the
 * database: Neon stores durable state, and realtime is a different job done by a
 * different layer. A spectator watching a run must see the run move — every
 * transient `tool.started`, every `thinking` — while the same events are being
 * filtered on their way to the log. Those two paths are independent and this hub
 * sits only on the realtime one.
 *
 * The stream shape is `full_state` first, `delta` after, ported from agent-move's
 * Broadcaster and the diff-broadcast shape from codemoo/agent-world (plan
 * section 28.1 item 12). Broadcast diffs, not whole state: a client that
 * rehydrates a full world model per event pays the whole model per event, and
 * 2000 events/s is exactly when that stops being affordable.
 */

/** One character in the world, as the opening frame describes it. */
export interface LiveAgent {
  /** The store keys characters by session, because one agent may fight twice. */
  readonly sessionId: string;
  readonly agentId: string;
  readonly agentName: string;
  /** The harness enum value, or the string the agent row carries. */
  readonly harness: string;
  readonly level: number;
  /**
   * Where the character is standing.
   *
   * `idle` — the plaza — is an honest default rather than a placeholder: the hub
   * knows where somebody walked to while it was watching, and a character that
   * has not moved since the process started genuinely is in the plaza. It is NOT
   * recovered from the database, because position is realtime state and the
   * durable record holds no zone: a client that reconnects gets the character in
   * the right place on the map, and the next delta moves it.
   */
  readonly zone: string;
}

/** The world a subscriber starts from, before any delta arrives. */
export interface GameSnapshot {
  /** The protocol the stream speaks, so a client can refuse one it does not know. */
  readonly protocolVersion: string;
  /**
   * Sessions currently reporting on this channel, oldest first.
   *
   * Kept alongside `liveAgents` rather than replaced by it, because it is the
   * field a client built before `liveAgents` existed reads, and a snapshot that
   * dropped it would hand that client an empty world. A client that understands
   * `liveAgents` uses it and gets characters with names; one that does not still
   * gets the presence it always got. Both ends of a 0.x protocol ship together,
   * so the fallback is a courtesy rather than a compatibility story.
   */
  readonly liveSessionIds: readonly string[];
  /** The same sessions, described well enough to draw. */
  readonly liveAgents?: readonly LiveAgent[];
}

/** The opening frame: everything a client needs before deltas start. */
export interface FullStateFrame {
  readonly kind: 'full_state';
  readonly state: GameSnapshot;
}

/**
 * A subsequent frame: one event, and nothing else.
 *
 * There is deliberately NO `state` field on this variant. A delta that also
 * carried a `state` would make "this frame is a snapshot" and "this frame is a
 * change" the same question asked two ways, and a client that checked the wrong
 * one would hydrate from a delta or patch from a snapshot. The type makes the
 * two mutually exclusive at compile time and the test makes it true at runtime.
 */
/**
 * What the public stream may carry, and what it must not.
 *
 * The classification is not this file's invention: it is
 * docs/design/public-event-stream.md, written before the filter so that the
 * filter could be a consequence of a decision rather than a guess. Read that
 * document to change anything here.
 *
 * The shape of the fix follows from one fact about the protocol. In
 * packages/protocol/src/agent-event.ts the payload fields are
 * `identifierSchema`, which is `z.string().min(...)` — an unbounded string.
 * So `file.write.path`, `command.run.argv0`, `message.sent.body` and
 * `thinking` can hold anything, and an event cannot be published and then have
 * its dangerous field stripped. A public event is built here, field by field,
 * and an event with nothing publishable in it yields undefined rather than an
 * empty object.
 */

/** Events a spectator may see whole. None of them carries a free-form field. */
const PUBLISHED_WHOLE: ReadonlySet<string> = new Set([
  'session.started',
  'session.ended',
  'session.resumed',
  'subagent.spawned',
  'subagent.completed',
]);

/**
 * Events a spectator may see in reduced form.
 *
 * The reduction is not a filter applied afterwards. `test.failed.failure` and
 * `waiting.reason` are unbounded strings, so publishing the event and
 * deleting the field is the same as publishing the field.
 */
const PUBLISHED_REDUCED: Readonly<Record<string, readonly string[]>> = {
  'test.passed': ['suite', 'count'],
  'test.failed': ['suite'],
  waiting: [],
};

/**
 * The public form of an event, or undefined when it has none.
 *
 * Returning undefined rather than a stripped copy matters: an empty frame is a
 * frame a client has to interpret, and there is no sensible reading of a delta
 * with no event in it.
 */
export function toPublicEvent(event: GameEvent): GameEvent | undefined {
  if (PUBLISHED_WHOLE.has(event.type)) return event;

  const kept = PUBLISHED_REDUCED[event.type];
  if (kept === undefined) return undefined;

  const source = event.payload;
  const payload: Record<string, unknown> = {};
  for (const field of kept) {
    const value = (source as Record<string, unknown>)[field];
    // Copied only when present, so a reduced event never grows a key the
    // feature did not set.
    if (value !== undefined) payload[field] = value;
  }
  return { ...event, payload };
}

export interface DeltaFrame {
  readonly kind: 'delta';
  readonly event: GameEvent;
}

export type StreamFrame = FullStateFrame | DeltaFrame;

/**
 * The session an event is about, when it names one.
 *
 * The three lifecycle events all carry `sessionId` in their payload, and it is
 * read here rather than cast at each call site because the payload is
 * `identifierSchema` — an unbounded string — and a value that is not a
 * non-empty string is an event from a future protocol version, not a session.
 */
function readSessionId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('sessionId' in payload)) {
    return undefined;
  }
  return readString(payload, 'sessionId');
}

function readString(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null || !(key in payload)) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A character the hub knows exists and nothing else about.
 *
 * The agent id doubles as the display name, which is a lie in the way this file
 * spends most of its comments insisting not to. It is here because the
 * alternative is to leave the character out of the world, and a nameless figure
 * in the plaza is a smaller wrong than an absent one: a client that wants a name
 * can show the id, and the first `session.started` replaces both.
 */
function unidentified(sessionId: string, zone?: string): LiveAgent {
  return {
    sessionId,
    agentId: sessionId,
    agentName: sessionId,
    harness: 'other',
    level: 0,
    zone: zone ?? 'idle',
  };
}

/**
 * Where an event puts its session, when the event says.
 *
 * `getZoneForTool` is the SHARED table — `packages/protocol` owns the only
 * tool→zone mapping in this repository, ported from agent-move, and both ends
 * read it. That is the whole reason the opening frame and the first delta agree
 * about where a character is: there is one table, not two.
 *
 * The client's `ZONE_FOR_EVENT` — which maps a game event like `bounty.claimed`
 * to a place — is deliberately NOT used here. It lives in `game-client` because
 * a game event meaning a new place is the client's business, and a transport
 * reaching into the presentation package to read it would invert the layering
 * this repository is built to keep. An agent that claims a bounty therefore
 * stays where it was standing until a tool moves it, which is the conservative
 * answer rather than a wrong one.
 */
function zoneOf(event: GameEvent): string | undefined {
  const tool = readString(event.payload, 'tool') ?? readString(event.payload, 'toolName');
  return tool === undefined ? undefined : getZoneForTool(tool);
}

export interface EventStreamHubOptions {
  readonly bus: EventBus;
  /**
   * Sessions already running when this hub was built.
   *
   * Optional, and the hub works without it — it simply starts empty and learns
   * who exists from the bus. The composition root passes it because a hub that
   * starts empty is empty for exactly as long as nobody emits a lifecycle event,
   * which after a restart is until the next agent connects.
   */
  readonly initialLiveSessionIds?: readonly string[];
  /**
   * The same sessions described well enough to draw. Preferred over the ids
   * alone, which remain for a caller that has nothing better.
   */
  readonly initialLiveAgents?: readonly LiveAgent[];
  /** Read once per subscriber to build that subscriber's opening frame. */
  readonly snapshot?: () => GameSnapshot;
  /**
   * How many undelivered frames one subscriber may fall behind by.
   *
   * Past this the subscriber is CLOSED, not skipped. A delta stream cannot
   * survive a gap — a client that missed an event and kept going would be
   * permanently wrong, with nothing to tell it — so the only safe response to a
   * subscriber that cannot keep up is to hang up and let it reconnect for a
   * fresh `full_state`. Skipping frames would trade a visible reconnect for an
   * invisible corruption, which is the worse of the two.
   */
  readonly maxSubscriberLag?: number;
}

const DEFAULT_MAX_SUBSCRIBER_LAG = 1024;

/**
 * One connected client.
 *
 * The queue is the lag. `pull` is the only thing that removes from it, and the
 * transport only calls `pull` when the consumer is ready for bytes, so a client
 * that stops reading stops being pulled from, its queue grows, and the hub closes
 * it. The highWaterMark of whatever is writing these frames is the backpressure
 * signal; this queue is where the decision to give up on the client is made.
 */
/**
 * Who is receiving.
 *
 * `public` is a spectator: a socket anyone can open, so it gets the
 * classification and nothing more. `operator` is the game's own activity view,
 * which is entitled to the transient events the spectator view drops — a busy
 * agent is exactly what that view exists to show, and the ingest bead is
 * explicit that not persisting must not become dropping.
 *
 * The default is the strict one. A new caller gets the safe view unless it
 * says otherwise, so a forgotten argument narrows what is shared rather than
 * widening it.
 */
export type StreamView = 'public' | 'operator';

export class StreamSubscriber {
  readonly #queue: StreamFrame[] = [];
  readonly #maxLag: number;
  readonly #onClose: () => void;
  readonly view: StreamView;
  #closed = false;
  #waiter: (() => void) | undefined;

  constructor(maxLag: number, onClose: () => void, view: StreamView = 'public') {
    this.#maxLag = maxLag;
    this.#onClose = onClose;
    this.view = view;
  }

  /**
   * Queues a frame, or closes this subscriber if it has fallen too far behind.
   *
   * Returns false when the frame was not accepted — either because the
   * subscriber was already gone, or because accepting it would have taken the
   * queue past the lag limit, in which case the subscriber is closed and the
   * frame is discarded. The discard is not a silent skip: the close is the
   * signal, and the reconnect that follows fetches a new `full_state`.
   */
  offer(frame: StreamFrame): boolean {
    if (this.#closed) {
      return false;
    }
    if (this.#queue.length >= this.#maxLag) {
      this.close();
      return false;
    }
    this.#queue.push(frame);
    this.#wake();
    return true;
  }

  /**
   * The next frame, or undefined once the subscriber is closed.
   *
   * Resolves as soon as a frame is queued and the subscriber is not closed; it
   * does NOT drain what was already queued first. On close the queue is dropped,
   * because the client is resynchronising from a fresh snapshot and replaying a
   * partial tail of deltas it can no longer vouch for would defeat that.
   */
  async pull(): Promise<StreamFrame | undefined> {
    while (this.#queue.length === 0 && !this.#closed) {
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
      });
    }
    // Once closed, the queue is dropped rather than drained. A closed subscriber
    // is about to reconnect for a fresh full_state, and a partial tail of deltas
    // it can no longer vouch for is not worth delivering on the way out. This is
    // the difference between "closed" meaning one thing — no more frames — and
    // it quietly meaning "no more NEW frames, but here is the backlog anyway".
    return this.#closed ? undefined : this.#queue.shift();
  }

  /** Idempotent. Ends the stream; the client reconnects for a fresh snapshot. */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#onClose();
    this.#wake();
  }

  /** For tests and diagnostics: how many frames are waiting to be pulled. */
  get pending(): number {
    return this.#queue.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.();
  }
}

/** One hub, one bus, one snapshot provider. */
export class EventStreamHub {
  readonly #subscribers = new Set<StreamSubscriber>();
  readonly #snapshot: (() => GameSnapshot) | undefined;
  readonly #maxLag: number;
  /**
   * Who is in the world, as far as a NEW subscriber is concerned.
   *
   * This is the presence registry `event-stream.ts` used to say it did not have,
   * and its absence is why the Coding City was empty for every visitor who
   * arrived after the last agent did. The snapshot provider returned a literal
   * `liveSessionIds: []`, so `full_state` told every client that nobody existed
   * and the only agents a page could ever show were the ones that happened to
   * emit a delta in the seconds after it connected. A game where arriving late
   * means seeing nothing is a game nobody can look at twice.
   *
   * It is a Set in memory rather than a query because `subscribe` takes its
   * snapshot SYNCHRONOUSLY — the provider runs, and the subscriber joins the
   * broadcast set, without yielding, so no event can slip between "here is the
   * world" and "this client is watching". An async provider would reopen exactly
   * that window, which is the reason it is written that way.
   *
   * So presence is maintained from the bus: every `session.started`,
   * `session.resumed` and `session.ended` updates it, and `sharedEventGateway`
   * primes it once from the database at composition time. The cost of that
   * choice is stated rather than hidden: after a process restart the set is
   * empty until agents report in again, which is why the priming exists.
   */
  readonly #live = new Map<string, LiveAgent>();
  #unsubscribeBus: (() => void) | undefined;

  constructor(options: EventStreamHubOptions) {
    this.#snapshot = options.snapshot;
    this.#maxLag = options.maxSubscriberLag ?? DEFAULT_MAX_SUBSCRIBER_LAG;
    for (const agent of options.initialLiveAgents ?? []) {
      this.#live.set(agent.sessionId, agent);
    }
    for (const id of options.initialLiveSessionIds ?? []) {
      if (!this.#live.has(id)) this.#live.set(id, unidentified(id));
    }
    // The hub reads the bus directly. This is the realtime path, and it has no
    // dependency on the store: whether or not an event was persisted, everything
    // on the bus is a delta to whoever is watching.
    // Everything on the bus reaches the hub. The classification is applied per
    // subscriber instead, at the point of delivery, because there are two
    // different viewers and only one of them is a spectator.
    //
    // The first attempt filtered here, on the bus. That broke the property the
    // ingest bead cares most about: a transient event must reach the game's own
    // activity view, because "we do not persist it" must not quietly become "we
    // drop it". Filtering at the bus made every viewer public by default and
    // took the game with it. The activity log keeps the detail and so does the
    // operator view; the spectator view keeps the scoreboard.
    this.#unsubscribeBus = options.bus.subscribe((event) => {
      this.#trackPresence(event);
      this.broadcast(event);
    });
  }

  /**
   * Folds one event into the presence map.
   *
   * Driven off the event TYPE rather than a table, so a session that starts
   * without a row read and a session that ends without a row write both land
   * here. The lifecycle types change WHO is in the world; everything else only
   * changes where they are standing.
   *
   * A delta for a session this hub has never seen still creates the character.
   * That is deliberate: an event is proof somebody is working, and refusing to
   * show them because the priming missed them would be a worse failure than an
   * agent whose level is not known yet.
   */
  #trackPresence(event: GameEvent): void {
    const sessionId = readSessionId(event.payload);
    if (sessionId === undefined) return;

    if (event.type === 'session.ended') {
      this.#live.delete(sessionId);
      return;
    }

    const zone = zoneOf(event);
    const known = this.#live.get(sessionId);

    if (event.type === 'session.started' || event.type === 'session.resumed') {
      const payload = event.payload as Readonly<Record<string, unknown>>;
      this.#live.set(sessionId, {
        sessionId,
        agentId: readString(payload, 'agentId') ?? known?.agentId ?? sessionId,
        agentName: known?.agentName ?? readString(payload, 'agentId') ?? sessionId,
        harness: readString(payload, 'harness') ?? known?.harness ?? 'other',
        level: known?.level ?? 0,
        zone: zone ?? known?.zone ?? 'idle',
      });
      return;
    }

    if (known === undefined) {
      this.#live.set(sessionId, unidentified(sessionId, zone));
      return;
    }
    if (zone !== undefined && zone !== known.zone) {
      this.#live.set(sessionId, { ...known, zone });
    }
  }

  /** Seeds presence from durable state. Called once, at composition time. */
  prime(agents: Iterable<LiveAgent>): void {
    for (const agent of agents) {
      this.#live.set(agent.sessionId, agent);
    }
  }

  /**
   * Registers a subscriber and hands it the opening `full_state` frame.
   *
   * The snapshot is taken and queued before the subscriber joins the broadcast
   * set, and both happen without yielding, so no event can be published between
   * "this is the world" and "this client is watching". That is the ordering the
   * full_state-then-delta contract rests on, and it is why the snapshot provider
   * is synchronous: an async one would reopen exactly that window.
   */
  subscribe(view: StreamView = 'public'): StreamSubscriber {
    let subscriber: StreamSubscriber;
    const forget = (): void => {
      this.#subscribers.delete(subscriber);
    };
    subscriber = new StreamSubscriber(this.#maxLag, forget, view);
    subscriber.offer({
      kind: 'full_state',
      // The default snapshot, so a hub that was given nothing still answers with
      // the world it has accumulated. The option stays for a test that pins the
      // state it asserts against rather than reading the hub's.
      state: this.#snapshot?.() ?? this.#defaultSnapshot(),
    });
    this.#subscribers.add(subscriber);
    return subscriber;
  }

  #defaultSnapshot(): GameSnapshot {
    return {
      protocolVersion: PROTOCOL_VERSION,
      liveSessionIds: [...this.#live.keys()],
      liveAgents: [...this.#live.values()],
    };
  }

  /**
   * Fans one event out to the subscribers allowed to see it.
   *
   * Copied because offer can close a subscriber, which deletes it from the set
   * mid-iteration.
   */
  broadcast(event: GameEvent): void {
    for (const subscriber of [...this.#subscribers]) {
      if (subscriber.view === 'public') {
        const publishable = toPublicEvent(event);
        // Undefined rather than an empty frame: there is no sensible reading of
        // a delta carrying no event, and a client would have to invent one.
        if (publishable !== undefined) subscriber.offer({ kind: 'delta', event: publishable });
        continue;
      }
      subscriber.offer({ kind: 'delta', event });
    }
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /** Detaches from the bus. For shutdown, not for per-request cleanup. */
  close(): void {
    this.#unsubscribeBus?.();
    this.#unsubscribeBus = undefined;
    for (const subscriber of [...this.#subscribers]) {
      subscriber.close();
    }
  }
}

/**
 * Encodes a frame as one SSE message.
 *
 * The JSON body carries `kind`, and the `event:` line names it too — the former
 * is what a client switches on, the latter is what a browser's EventSource
 * dispatches on. Redundant on purpose: a client that only understands one of
 * them is still correct.
 */
export function encodeStreamFrame(frame: StreamFrame): string {
  return `event: ${frame.kind}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/** Pulls the JSON body back out of an SSE message, for a client or a test. */
export function decodeStreamFrame(message: string): StreamFrame | undefined {
  for (const line of message.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue;
    }
    try {
      return JSON.parse(line.slice('data: '.length)) as StreamFrame;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
