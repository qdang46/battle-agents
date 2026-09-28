import { existsSync, readFileSync, statSync } from 'node:fs';

import type { AgentWatcher } from '@battle-agents/core';
import { EventBuffer, type AgentEvent } from '@battle-agents/protocol';

/** A newline, as a byte — the cursor is measured in bytes and searches this. */

/** A newline as a BYTE. The cursor is measured in bytes and searches for this. */
const NEWLINE_BYTE = 0x0a;
import { AMP_PROVIDER_ID, parseRecord, type RawThreadRef } from './parser.js';

/**
 * Watching an Amp thread: read, normalise, buffer, post.
 *
 * `AgentWatcher` is two methods, and that is the whole seam a host has to know.
 * Everything below it — the poll interval, the batching, the flush on the way
 * down — is the same in every adapter, and copying it per harness is how four
 * adapters end up with four subtly different shutdowns.
 *
 * ## Why the offset is a byte count and not a line count
 *
 * A line count re-reads the whole file after a truncation, and a thread file IS
 * truncated: a user clears a thread, or a new thread reuses the path. Counting
 * lines then silently re-emits the entire history as if it were new activity,
 * which is a replay that disagrees with itself. A byte offset past the end of a
 * shrunken file resets to zero, and the same growth is a no-op.
 *
 * ## Why `stop()` returns a Promise
 *
 * A watcher has a flush to await on the way down. A `void` stop makes that
 * flush fire-and-forget, and the session then ends with events either dropped
 * or delivered after the host has torn down. The template's README calls this
 * the first thing to get wrong and it is why `AgentWatcher` was declared with a
 * Promise in the first place.
 */

/** Where a watcher sends a batch. Injected so a test does not need a server. */
export type BatchSender = (batch: readonly AgentEvent[]) => Promise<void>;

export interface AmpWatcherOptions {
  /** The thread file to follow. Read on every tick; it may not exist yet. */
  readonly threadPath: string;
  /** The harness's own thread id, which is what every event's sessionId is. */
  readonly threadId: string;
  /** Identifies the agent, the installation and the project on session.started. */
  readonly agentId: string;
  readonly installationId: string;
  readonly projectId: string;
  /** Called with each batch. The only thing a watcher does with the network. */
  readonly send: BatchSender;
  readonly pollIntervalMs?: number;
  /** Injected so a test does not have to assert on the wall clock. */
  readonly now?: () => string;
}

const DEFAULT_POLL_INTERVAL_MS = 500;

export class AmpWatcher implements AgentWatcher {
  readonly #options: AmpWatcherOptions;
  readonly #buffer: EventBuffer;
  readonly #pollIntervalMs: number;
  readonly #now: () => string;
  /** Bytes consumed so far. See the note above on why this is not a line count. */
  #offset = 0;
  #started = false;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AmpWatcherOptions) {
    this.#options = options;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#now = options.now ?? ((): string => new Date().toISOString());
    this.#buffer = new EventBuffer({
      flushIntervalMs: 250,
      maxBatchEvents: 50,
      maxRejectEvents: 100,
      retryAfterSeconds: 1,
    });
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    // Emitted here rather than parsed out of the file, because the file's first
    // line is a user message and the session is the thing that contains it.
    await this.#post({
      type: 'session.started',
      sessionId: this.#options.threadId,
      at: this.#now(),
      agentId: this.#options.agentId,
      installationId: this.#options.installationId,
      projectId: this.#options.projectId,
      harness: 'amp',
    });
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#pollIntervalMs);
    await this.tick();
  }

  /**
   * Stops and flushes.
   *
   * The flush is unconditional rather than only when due: a shutdown is exactly
   * the case where a partial batch still belongs in the record.
   */
  async stop(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#started = false;
    const remaining = this.#buffer.flush();
    if (remaining.length > 0) await this.#options.send(remaining);
  }

  private async tick(): Promise<void> {
    for (const event of this.readNewRecords()) {
      // push() hands back a batch by itself the moment the buffer is full, so
      // the size limit does not need its own check here.
      const batch = this.#buffer.push(event);
      if (batch !== undefined) await this.#options.send(batch);
    }
    const due = this.#buffer.flushIfDue();
    if (due !== undefined) await this.#options.send(due);
  }

  /**
   * The lines written since the last tick, already translated.
   *
   * Split before parsing, because a thread file is APPENDED to and a partially
   * written last line is a real possibility: parsing it would drop a record, and
   * a dropped record is a hole in the replay. An unterminated tail is left for
   * the next tick, and the offset only advances past lines that were complete.
   */
  readNewRecords(): readonly AgentEvent[] {
    const path = this.#options.threadPath;
    if (!existsSync(path)) return [];

    const size = statSync(path).size;
    if (size < this.#offset) {
      // Truncated or replaced. Everything after the new end is new by definition.
      this.#offset = 0;
    }
    if (size === this.#offset) return [];

    // SLICE BYTES, THEN DECODE. The offset counts BYTES and must be applied
    // before the bytes become a string, because a JavaScript string indexes
    // CHARACTERS.
    //
    // The first version read the whole file as utf8 and sliced THAT by a byte
    // offset. For ASCII the two are the same number and nothing looks wrong.
    // The first non-ASCII character makes them differ — `🐛` is four bytes and
    // one character — so the offset ran ahead by three per emoji, and every
    // subsequent read started that many bytes late. The bytes in between are
    // lost, not deferred: a JSON line cut in half fails to parse, is swallowed
    // by the `catch` below, and the cursor has already moved past it. One
    // emoji in one prompt cost every record after it, silently.
    //
    // `adapters/pi/src/parsers/session.ts` already does it this way, and
    // `it('does not lose a record when a prompt contains an emoji')` exists
    // because the difference is invisible until it is not.
    const buffer = readFileSync(path);
    const slice = buffer.subarray(this.#offset);
    const lastBreak = slice.lastIndexOf(NEWLINE_BYTE);
    if (lastBreak === -1) return [];

    const complete = slice.subarray(0, lastBreak);
    this.#offset += complete.length + 1;
    const text = complete.toString('utf8');

    const ref: RawThreadRef = {
      threadId: this.#options.threadId,
      providerId: AMP_PROVIDER_ID,
    };
    const events: AgentEvent[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A line that is not JSON is not this adapter's to interpret, and
        // throwing would take the whole watcher down over one bad record.
        continue;
      }
      const event = parseRecord(parsed, ref);
      if (event !== null) events.push(event);
    }
    return events;
  }

  /** Posts one event outside the buffer, for the events the buffer never sees. */
  async #post(event: AgentEvent): Promise<void> {
    await this.#buffer.push(event);
    const due = this.#buffer.flush();
    if (due.length > 0) await this.#options.send(due);
  }
}
