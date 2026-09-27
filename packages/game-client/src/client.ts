/**
 * The composition root: store + view + frame loop, wired once.
 *
 * This exists because of a bug this package had, not for tidiness. `PixiWorldView`
 * takes a `WorldStore` and does not subscribe to it, so a host has to know to
 * connect the two. A host that does not gets a view with zero nodes and a store
 * full of agents — a blank world and no error anywhere. That is exactly the
 * class of failure the tests in this package are supposed to make impossible,
 * and leaving the wiring to every caller guarantees at least one caller gets it
 * wrong.
 *
 * So the wiring lives here, once, and `connect()` is the only supported way to
 * get a view onto a store. The pieces stay separately constructible because the
 * tests need them separately — a counting view with no Pixi, a loop with no
 * scheduler — but the default is correct rather than merely available.
 *
 * The layering note: this is presentation composing presentation. The game
 * client imports `core` for the event type and `protocol` for the zone set, and
 * reaches no feature, so the removal test — which strips features — has nothing
 * to strip here.
 */

import type { GameEvent } from '@battle-agents/core';

import { StreamClient, type EventSourceFactory, type StreamHandlers } from './net/client.js';
import { WorldStore, type WorldSnapshot } from './state/store.js';
import { FrameLoop, type FrameRenderer } from './game/frame-loop.js';
import { PixiWorldView, type WorldViewLike } from './game/view.js';
import { spriteCache, type SpriteCache } from './sprites/sprite-factory.js';

/** The default SSE endpoint. Relative, because the client is same-origin. */
export const DEFAULT_STREAM_URL = '/api/events/stream';

export interface GameClientOptions {
  /** Any view; defaults to the Pixi one. A counting view is the test seam. */
  readonly view?: WorldViewLike;
  readonly cache?: SpriteCache;
  /** The endpoint to stream from. */
  readonly url?: string;
  /**
   * The EventSource factory. Required to connect, and deliberately not
   * defaulted: a default would construct a global `EventSource`, which does not
   * exist outside a browser, and the failure would surface at connect time
   * rather than at wiring time.
   */
  /**
   * The store the supplied `view` reads, when a view is supplied.
   *
   * Optional because a host that lets the client build the view needs no say.
   * Required in practice whenever a view IS supplied, and passing a view over a
   * different store is the silent-empty-world failure this comment exists to
   * name.
   */
  readonly store?: WorldStore;
  readonly createSource?: EventSourceFactory;
  readonly reconnectDelayMs?: number;
  readonly schedule?: (callback: () => void) => void;
}

export class GameClient implements FrameRenderer {
  /**
   * The store. Host-supplied or built here, and ALWAYS the one `view` reads.
   *
   * This used to be `readonly store = new WorldStore()` — a field initialiser,
   * so a fresh store every time, whatever the host passed. A host that built its
   * own `PixiWorldView` over its own `WorldStore` and handed it in therefore got
   * a client writing deltas into a store the view never reads, and the view
   * looking every agent up in one that never receives any. The world was empty
   * and the status was `streaming`, with nothing red anywhere.
   *
   * The two are now one object by construction rather than by a comment. A host
   * that supplies a view supplies the store it was built on, and the alternative
   * — building the view from `client.store` after construction — is impossible
   * here because the view has to exist before the client that renders it.
   */
  readonly store: WorldStore;
  readonly view: WorldViewLike;
  readonly #loop: FrameLoop;
  readonly #unsubscribe: () => void;
  #stream: StreamClient | undefined;

  constructor(options: GameClientOptions = {}) {
    this.store = options.store ?? new WorldStore();
    this.view =
      options.view ??
      new PixiWorldView({ store: this.store, cache: options.cache ?? spriteCache() });

    // Spread rather than `key: value` pairs, because the base config sets
    // `exactOptionalPropertyTypes` and a present-but-undefined optional is a
    // different type from an absent one.
    this.#loop = new FrameLoop({
      renderer: this,
      ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    });
    // Subscribed HERE, which is the whole point of this file: the view is
    // wired to the store before anyone can push an event at it.
    this.#unsubscribe = this.store.subscribe((change) => this.#loop.ingest(change));

    if (options.createSource !== undefined) {
      this.#stream = new StreamClient({
        url: options.url ?? DEFAULT_STREAM_URL,
        createSource: options.createSource,
        handlers: this.#handlers(),
        ...(options.reconnectDelayMs === undefined
          ? {}
          : { reconnectDelayMs: options.reconnectDelayMs }),
        ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
      });
    }
  }

  /** Opens the SSE stream. Throws if no source factory was supplied. */
  connect(): void {
    if (this.#stream === undefined) {
      throw new Error(
        'GameClient.connect() needs a createSource factory; construct with one to stream.',
      );
    }
    this.#stream.connect();
  }

  /** Starts the rAF loop. */
  start(): void {
    this.#loop.start();
  }

  stop(): void {
    this.#loop.stop();
    this.#stream?.close();
  }

  /** Unsubscribes everything. For teardown and for tests. */
  destroy(): void {
    this.stop();
    this.#unsubscribe();
  }

  /** Runs one frame by hand. For tests that do not schedule their own. */
  frame(): void {
    this.#loop.frame();
  }

  get pendingEvents(): number {
    return this.#loop.pending;
  }

  /* ── FrameRenderer: called by the loop, once per frame ── */

  render(agentIds: readonly string[]): void {
    this.view.applyAgentDelta(agentIds);
  }

  resync(): void {
    // The stream is untrustworthy, so the store stops accepting deltas and the
    // next snapshot rebuilds. The view is NOT swept here: the store is the
    // authority on who exists, and it will tell us on the next hydrate.
    this.store.invalidate();
    this.view.sweep();
  }

  #handlers(): StreamHandlers {
    return {
      onSnapshot: (snapshot: WorldSnapshot) => {
        this.store.hydrate(snapshot);
        // A snapshot is authoritative and may contradict every delta since the
        // last one, so it is a rebuild rather than a merge.
        this.view.rebuild();
      },
      onDelta: (event: GameEvent) => {
        this.store.applyDelta(event);
      },
      onDisconnected: () => {
        this.store.invalidate();
      },
    };
  }
}
