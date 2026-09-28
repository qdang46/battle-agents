import { AgentEventSchema, EventBuffer } from '@battle-agents/protocol';
import type { AgentEvent } from '@battle-agents/protocol';
import type { AgentWatcher } from '@battle-agents/core';

import {
  createHookLedger,
  parseJsonlLine,
  readNewLines,
  recordObservation,
  unreported,
  type HookLedger,
} from './parsers/jsonl.js';
import { discoverTranscripts, SessionCursors } from './transcript.js';

/**
 * Both planes, one buffer, one stream.
 *
 * The hook plane pushes in as it happens; the JSONL tail polls for whatever the
 * hooks missed. They share a buffer so the batching policy is the one the
 * ingest endpoint actually accepts — 250ms or 50 events, well short of the
 * 100-event refusal — and an adapter that invented a second policy would be
 * refused by the very endpoint it is posting to.
 *
 * The dedup ledger is the seam between them, and it belongs here rather than in
 * either plane. The hook plane records what it emitted; the tail asks whether
 * the line it just read was already reported. Deciding that inside the parser
 * would make the same transcript line correct in one deployment and a
 * duplicate in another depending on whether hooks were healthy, and the policy
 * would be unreachable from a test.
 *
 * The tail wins ties in the other direction: when hooks were not running at
 * all, the ledger is empty and every line through it reaches the stream, which
 * is the whole point of keeping a net.
 *
 * TWO THINGS THIS WATCHER OWES THE INGEST ENDPOINT, both of which the endpoint
 * enforces and neither of which it can enforce for us:
 *
 * - Every event is validated here, against the protocol's own schema, before it
 *   reaches the buffer. A single malformed timestamp from a transcript is
 *   enough to make `AgentEventSchema` reject the event, and the endpoint
 *   validates a BATCH — so one bad line would take up to 49 good events down
 *   with it and the 400 would emit nothing.
 * - Only one session's events are ever buffered at a time. A batch spanning two
 *   sessionIds is refused for the same reason ownership is per session, and a
 *   buffer shared across sessions would produce one by accident. Following a
 *   single current session is what keeps the accident out; the switch flushes
 *   before it reads.
 */

/** Where a watcher sends a batch. Injected so a test does not need a server. */
export type BatchSender = (batch: readonly AgentEvent[]) => Promise<void>;

export interface ClaudeWatcherOptions {
  readonly send: BatchSender;
  /**
   * Exactly one of these two names what to read.
   *
   * `transcriptPath` pins one file, which is what a caller that already knows
   * the session wants. `transcriptsRoot` is the projects directory, and the
   * watcher discovers which session is live and follows it — the shape the brief
   * asks for, where a session ends and a new file appears underneath a long
   * running tail.
   */
  readonly transcriptPath?: string;
  readonly transcriptsRoot?: string;
  /** Shared with the hook plane, so the two defer to each other. */
  readonly ledger?: HookLedger;
  readonly pollIntervalMs?: number;
  /** Injectable so a test can pin the dedup window instead of sleeping through it. */
  readonly now?: () => number;
}

const DEFAULT_POLL_INTERVAL_MS = 500;

export class ClaudeWatcher implements AgentWatcher {
  readonly #send: BatchSender;
  readonly #ledger: HookLedger;
  readonly #pollIntervalMs: number;
  readonly #now: () => number;
  readonly #buffer: EventBuffer;
  readonly #pinnedPath: string | undefined;
  readonly #root: string | undefined;
  readonly #cursors = new SessionCursors();
  #offset = 0;
  #session: string | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #rejected = 0;
  #lastRejection: string | undefined;

  constructor(options: ClaudeWatcherOptions) {
    if (options.transcriptPath === undefined && options.transcriptsRoot === undefined) {
      throw new Error('a watcher needs a transcriptPath or a transcriptsRoot to read');
    }
    if (options.transcriptPath !== undefined && options.transcriptsRoot !== undefined) {
      throw new Error('a watcher reads a transcriptPath or a transcriptsRoot, not both');
    }
    this.#send = options.send;
    this.#ledger = options.ledger ?? createHookLedger();
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#pinnedPath = options.transcriptPath;
    this.#root = options.transcriptsRoot;
    this.#buffer = new EventBuffer(
      {
        flushIntervalMs: 250,
        maxBatchEvents: 50,
        maxRejectEvents: 100,
        retryAfterSeconds: 1,
      },
      // The buffer gets the same clock, or a test pinning `now` for the dedup
      // window would still be waiting on real time for the 250ms flush and the
      // two halves of the watcher would disagree about what "now" means.
      { now: this.#now },
    );
  }

  /**
   * How many events the protocol schema refused.
   *
   * Counted rather than thrown, for the reason the hook normalizer counts its
   * skips: an adapter that throws on one bad line stops reporting entirely,
   * which is indistinguishable from an agent that did nothing. A count is the
   * difference between a stream that is quiet and a stream that is broken.
   */
  get rejectedCount(): number {
    return this.#rejected;
  }

  /**
   * Why the most recent event was refused, as the schema's own message.
   *
   * The count says how often; this says what happened the last time, which is
   * the half that names a Claude format change. One slot rather than a growing
   * list, because a watcher is meant to be cheap to leave running and nobody
   * reads a thousand of these.
   */
  get lastRejection(): string | undefined {
    return this.#lastRejection;
  }

  /**
   * The session being followed, or undefined before the first poll.
   *
   * Meaningful in discovery mode only. A pinned file is named by its caller and
   * the watcher never had to work out which session it belonged to.
   */
  get currentSessionId(): string | undefined {
    return this.#session;
  }

  async start(): Promise<void> {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#pollIntervalMs);
    await this.tick();
  }

  /**
   * Stops and flushes.
   *
   * The flush is awaited. A void stop makes it fire-and-forget, and the session
   * then ends with events either dropped or delivered after the runtime has
   * torn down — which is the same class of bug the tail exists to catch.
   */
  async stop(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    const remaining = this.#buffer.flush();
    if (remaining.length > 0) await this.#send(remaining);
  }

  /**
   * Accepts the events one hook payload produced.
   *
   * Recorded in the ledger BEFORE they are buffered, so a log line describing
   * the same tool call is deferred to these even if the buffer has not flushed
   * them yet. The alternative is a duplicate that depends on flush timing.
   */
  async recordHookEvent(observation: {
    readonly sessionId: string;
    readonly tool: string | undefined;
    readonly events: readonly AgentEvent[];
  }): Promise<void> {
    const accepted = this.#accept(observation.events);
    if (accepted.length === 0) {
      return;
    }
    recordObservation(this.#ledger, { ...observation, events: accepted }, this.#now());
    await this.#bufferAndMaybeFlush(accepted);
  }

  /** One poll: find the current session, read what is new, drop what the hooks said. */
  async tick(): Promise<void> {
    const target = await this.#currentTarget();
    if (target === undefined) {
      return;
    }
    if (target.sessionId !== this.#session) {
      // Flush before switching, not after reading. The buffer is one buffer for
      // the whole watcher, and a batch carrying two sessionIds is refused at
      // the door — so the previous session's events have to be on the wire
      // before the next session's are allowed into the same buffer.
      await this.#flush();
      this.#session = target.sessionId;
      // NO HANDSHAKE HERE, and that is deliberate. An earlier version of this
      // watcher took an `openSession` callback and called it on every session
      // change, which meant the handshake lived in the adapter — and had to be
      // written nine times, once per harness, for the M7 promise to be true.
      //
      // It now lives in the SENDER, in `@battle-agents/protocol`: the runner
      // wraps the ingest sender in one that opens a platform run for each
      // `sessionId` it sees, exactly once. A watcher that emits a sessionId is
      // connected, and this file no longer knows what a platform is.
      //
      // The eleven-runs-in-twenty-seconds bug moved with it and is fixed there
      // too: the set that deduplicates is the sender's, not this watcher's.
    }

    const discovered = target.sessionId !== undefined;
    const offset = discovered ? this.#cursors.offsetFor(target.sessionId) : this.#offset;
    const { lines, offset: next } = await readNewLines(target.path, offset);
    if (discovered) {
      this.#cursors.advanceTo(target.sessionId, next);
    } else {
      this.#offset = next;
    }
    const nowMs = this.#now();

    for (const line of lines) {
      const { observation } = parseJsonlLine(line);
      if (observation === null) {
        continue;
      }
      // In discovery mode the filename IS the partition, so a line naming a
      // different session is a transcript this adapter does not understand and
      // following it would put another session's events in this session's
      // batch. A pinned file has no such claim to check: the caller chose it.
      if (discovered && observation.sessionId !== target.sessionId) {
        continue;
      }
      const accepted = this.#accept(unreported(this.#ledger, observation, nowMs));
      for (const event of accepted) {
        await this.#bufferAndMaybeFlush([event]);
      }
    }

    const due = this.#buffer.flushIfDue();
    if (due !== undefined) await this.#send(due);
  }

  /**
   * The transcript to read this poll.
   *
   * `sessionId` is undefined for a pinned file: the partition there is the
   * caller's choice, not something the tail re-derives and can contradict.
   */
  async #currentTarget(): Promise<
    { readonly sessionId: string | undefined; readonly path: string } | undefined
  > {
    if (this.#pinnedPath !== undefined) {
      return { sessionId: undefined, path: this.#pinnedPath };
    }
    const [newest] = await discoverTranscripts(this.#root);
    return newest === undefined ? undefined : { sessionId: newest.sessionId, path: newest.path };
  }

  /**
   * The events the protocol's own schema will accept.
   *
   * Validated here, in the send path, against `AgentEventSchema` imported from
   * `protocol` — not a local copy of the contract, which would agree with
   * itself and disagree with the door.
   */
  #accept(events: readonly AgentEvent[]): readonly AgentEvent[] {
    const accepted: AgentEvent[] = [];
    for (const event of events) {
      const result = AgentEventSchema.safeParse(event);
      if (result.success) {
        accepted.push(event);
        continue;
      }
      this.#rejected += 1;
      this.#lastRejection = `${event.type}@${event.sessionId}: ${result.error.message}`;
    }
    return accepted;
  }

  async #flush(): Promise<void> {
    const remaining = this.#buffer.flush();
    if (remaining.length > 0) await this.#send(remaining);
  }

  /**
   * push() hands back a batch by itself the moment the buffer is full, so the
   * size limit does not need its own check here.
   */
  async #bufferAndMaybeFlush(events: readonly AgentEvent[]): Promise<void> {
    for (const event of events) {
      const batch = this.#buffer.push(event);
      if (batch !== undefined) await this.#send(batch);
    }
  }
}
