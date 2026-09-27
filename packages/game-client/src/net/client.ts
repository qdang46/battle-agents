/**
 * The SSE client: `full_state` to hydrate, deltas to patch.
 *
 * Plan section 25. The wire format is already fixed and shipped — see
 * `apps/web/src/event-stream.ts` for the server half — so this file consumes a
 * decided shape rather than proposing one.
 *
 * **Reconnect is a resync, never a resume.** The hub closes a subscriber that
 * falls more than 1024 frames behind rather than skipping frames for it, and
 * the reason is written into that code: a delta stream cannot survive a gap. A
 * client that missed an event and kept going would be permanently wrong, with
 * nothing to tell it. So when the stream ends — closed by the server, dropped by
 * the network, or overflowed locally — this client stops patching and waits for
 * a fresh `full_state`. It never reconnects onto the state it already had.
 *
 * **The payload is a shape, not a promise.** Today `/api/events/stream` is an
 * unauthenticated global broadcast that subscribes the `public` view, and
 * `toPublicEvent` drops every event carrying a free-form field — which includes
 * `tool.started`, `thinking`, `file.*`, `command.run` and `prompt.submitted`. So
 * a spectator client currently receives almost nothing that moves an agent: the
 * zones it can route are the ones keyed off `test.*`, `waiting` and the session
 * lifecycle. That is a real gap and it is tracked in `ba-9hr`, not designed
 * around here. This client is built against the frame SHAPE so that when the
 * filter is finished the events flow without another change, and it says so
 * rather than pretending today's payload is the contract.
 *
 * `EventSource` is injected rather than constructed, for the same reason the
 * frame loop takes its scheduler: a client that opens its own socket cannot be
 * driven from a test, and a reconnect path that has never been executed is a
 * reconnect path that does not work.
 */

import type { GameEvent } from '@battle-agents/core';

import type { WorldSnapshot } from '../state/store.js';

/** The two frame kinds, mutually exclusive by construction. */
export type StreamFrame =
  | { readonly kind: 'full_state'; readonly state: WorldSnapshot }
  | { readonly kind: 'delta'; readonly event: GameEvent };

/**
 * What the client needs from the platform's `EventSource`.
 *
 * Structural, so a test can pass a fake with three methods, and so this file
 * does not depend on a DOM lib that the rest of the package has no use for.
 */
export interface EventSourceLike {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export type ConnectionState = 'connecting' | 'open' | 'resyncing' | 'closed';

export interface StreamHandlers {
  /** The opening snapshot, or a replacement after a reconnect. */
  onSnapshot(snapshot: WorldSnapshot): void;
  /** One event. */
  onDelta(event: GameEvent): void;
  /**
   * The stream ended and the client's state can no longer be trusted.
   *
   * The caller is expected to stop drawing deltas and wait for the next
   * snapshot. This fires on server close, on transport error, and on a frame
   * that does not parse — the last of which is easy to skip and is how a client
   * ends up silently applying a partial tail.
   */
  onDisconnected(reason: string): void;
  onStateChange?(state: ConnectionState): void;
}

export interface StreamClientOptions {
  readonly url: string;
  readonly handlers: StreamHandlers;
  readonly createSource: EventSourceFactory;
  /** Reconnect delay. Injectable so a test does not wait on a real timer. */
  readonly reconnectDelayMs?: number;
  /** The scheduler, for the same reason the frame loop takes one. */
  readonly schedule?: (callback: () => void) => void;
}

const DEFAULT_RECONNECT_DELAY_MS = 1000;

/**
 * Parses one SSE message into a frame.
 *
 * Returns undefined rather than throwing. A frame the client cannot read is a
 * gap, and a gap is handled by resyncing — which is the one response that is
 * always safe. Throwing here would leave the socket open with no state change,
 * which is the silent-corruption outcome the hub's close-instead-of-skip rule
 * exists to prevent.
 */
export function decodeFrame(message: string): StreamFrame | undefined {
  // Two shapes reach here, and only one of them was ever handled.
  //
  // `EventSourceLike.onmessage` is declared as taking `{ data: string }` — the
  // browser's shape — and a browser's `MessageEvent.data` is the PAYLOAD ONLY:
  // the `event:` line and the `data: ` prefix have already been stripped by the
  // time the handler runs. The first version of this function scanned for a
  // `data: ` prefix, so in a real browser it found none, returned undefined, and
  // the client tore the connection down and resynced — on every frame, for ever.
  //
  // Its own tests never saw it, because the fake source hands over the RAW WIRE
  // TEXT (`event: kind\ndata: {...}\n\n`) rather than what a browser produces.
  // A fake that does not behave like the thing it stands in for is how a
  // transport bug survives a green suite.
  //
  // So both are accepted: a raw SSE frame for a host that reads the stream
  // itself, and a bare payload for a browser. Neither is guessed at — a string
  // that parses as one of the two frame kinds is a frame, and anything else is
  // still undefined.
  const dataLines = message
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));

  const candidates = dataLines.length > 0 ? dataLines : [message];

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      // A malformed frame among several is skipped rather than fatal, because
      // an SSE stream can carry a keep-alive comment or a partial line beside a
      // real frame and the real one is still worth delivering.
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const kind = (parsed as { kind?: unknown }).kind;
    if (kind === 'full_state') {
      const state = (parsed as { state?: unknown }).state;
      if (typeof state !== 'object' || state === null) return undefined;
      return { kind: 'full_state', state: state as WorldSnapshot };
    }
    if (kind === 'delta') {
      const event = (parsed as { event?: unknown }).event;
      if (typeof event !== 'object' || event === null) return undefined;
      return { kind: 'delta', event: event as GameEvent };
    }
    return undefined;
  }
  return undefined;
}

export class StreamClient {
  readonly #options: StreamClientOptions;
  readonly #reconnectDelayMs: number;
  readonly #schedule: (callback: () => void) => void;
  #source: EventSourceLike | undefined;
  #state: ConnectionState = 'closed';
  /** True once a snapshot has been seen, so a delta before one is a defect. */
  #hydrated = false;
  #closed = false;

  constructor(options: StreamClientOptions) {
    this.#options = options;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.#schedule =
      options.schedule ??
      ((callback) => {
        globalThis.setTimeout(callback, this.#reconnectDelayMs);
      });
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** Opens the stream. Safe to call once; a second call is ignored. */
  connect(): void {
    if (this.#source !== undefined) return;
    this.#closed = false;
    this.#setState('connecting');

    const source = this.#options.createSource(this.#options.url);
    this.#source = source;

    source.onmessage = (message) => {
      this.#onMessage(message.data);
    };
    source.onerror = () => {
      // The server closes the stream when a subscriber falls behind, and the
      // browser's EventSource also fires this for a dropped connection. Both
      // mean the same thing to us: the state we hold may have a hole in it.
      this.#onDisconnected('stream error');
    };
  }

  /**
   * Handles one frame.
   *
   * Public so a test can drive the client without a socket, and so the decision
   * about what a frame means is in one readable place rather than split between
   * a listener and a parser.
   */
  handleMessage(data: string): void {
    this.#onMessage(data);
  }

  #onMessage(data: string): void {
    const frame = decodeFrame(data);
    if (frame === undefined) {
      this.#onDisconnected('unparseable frame');
      return;
    }

    if (frame.kind === 'full_state') {
      // Every snapshot replaces. The reconnect path depends on this: a new
      // snapshot is the only thing that can repair a gap, so it is applied as a
      // replacement rather than merged onto whatever the last one left behind.
      this.#hydrated = true;
      this.#setState('open');
      this.#options.handlers.onSnapshot(frame.state);
      return;
    }

    if (!this.#hydrated) {
      // A delta before any snapshot patches a world that does not exist. The
      // hub cannot produce this ordering, so reaching it means a stream we do
      // not understand; resync is the only safe reading.
      this.#onDisconnected('delta before first full_state');
      return;
    }

    this.#setState('open');
    this.#options.handlers.onDelta(frame.event);
  }

  #onDisconnected(reason: string): void {
    this.#teardown();
    // Not `closed`: the client is going to try again, and a caller rendering a
    // dead client differently from a reconnecting one would flicker.
    this.#setState('resyncing');
    this.#hydrated = false;
    this.#options.handlers.onDisconnected(reason);
    if (this.#closed) return;
    // Reconnecting opens a fresh stream, whose FIRST frame is a fresh
    // full_state. There is no attempt to resume from a cursor, because there is
    // nothing to resume from that a gap-tolerant client could trust.
    this.#schedule(() => {
      this.connect();
    });
  }

  #teardown(): void {
    this.#source?.close();
    this.#source = undefined;
  }

  #setState(state: ConnectionState): void {
    this.#state = state;
    this.#options.handlers.onStateChange?.(state);
  }

  /** Stops for good. A later `connect()` starts a new stream. */
  close(): void {
    this.#closed = true;
    this.#teardown();
    this.#setState('closed');
  }
}
