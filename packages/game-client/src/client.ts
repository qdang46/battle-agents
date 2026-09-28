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
import { CITY, type SceneConfig } from './scenes/scene-config.js';

/** The default SSE endpoint. Relative, because the client is same-origin. */
export const DEFAULT_STREAM_URL = '/api/events/stream';

export interface GameClientOptions {
  /** Any view; defaults to the Pixi one. A counting view is the test seam. */
  readonly view?: WorldViewLike;
  /**
   * Which scene the DEFAULT view draws. Read only when no `view` is supplied,
   * because a supplied view was built over a scene already and asking for
   * another here would be a second opinion nobody acts on.
   *
   * Defaults to the city because that is what this package was built as, and a
   * client with no view and no scene is a client that only ever showed the
   * Coding City. Every real host passes a scene: `/city`, `/arena` and
   * `/guild-hall` all build their own view, because a view is what a scene
   * config is FOR.
   */
  readonly scene?: SceneConfig;
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
  #view: WorldViewLike;
  readonly #loop: FrameLoop;
  readonly #unsubscribe: () => void;
  #stream: StreamClient | undefined;

  constructor(options: GameClientOptions = {}) {
    this.store = options.store ?? new WorldStore();
    this.#view =
      options.view ??
      new PixiWorldView({
        store: this.store,
        scene: options.scene ?? CITY,
        cache: options.cache ?? spriteCache(),
      });

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

  /**
   * Points the client at a different view over the SAME store.
   *
   * Exists so switching scenes is a camera move rather than a page load. A view
   * is built per scene because the scene decides which zones exist and how big
   * the grid is; the store, the client and the SSE connection are not per scene,
   * and rebuilding those to change the map would drop every character and the
   * stream with them.
   *
   * The store is not a parameter because it must not change: a view over a
   * different store is the silent empty-world failure, and making the caller pass
   * it back in would be an invitation.
   */
  rebindView(view: WorldViewLike): void {
    this.#view = view;
    // The new view starts empty, so it is told what already exists rather than
    // waiting for a delta that may not come for another minute.
    this.#view.rebuild();
  }

  /** Opens the SSE stream. Throws if no source factory was supplied. */  connect(): void {
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

  /**
   * The view in use right now.
   *
   * A getter rather than a public field, because `rebindView` REPLACES it. A
   * public field would be two ways to say the same thing, and one of them would
   * quietly stop working the first time the other was used. Read it; the only
   * way to change it is `rebindView`.
   */
  get view(): WorldViewLike {
    return this.#view;
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
    this.#view.applyAgentDelta(agentIds);
  }

  resync(): void {
    // The stream is untrustworthy, so the store stops accepting deltas and the
    // next snapshot rebuilds. The view is NOT swept here: the store is the
    // authority on who exists, and it will tell us on the next hydrate.
    //
    // THE ORDER IS THE WHOLE FIX. `store.invalidate()` PUBLISHES a resync, and
    // this client is subscribed to the store's channel, so the call that is
    // supposed to be acting on a resync re-requests one — synchronously, inside
    // itself. The loop then set its flag, called this, the flag got set again,
    // and every frame after that took the resync branch and drained nothing. The
    // game rendered a frozen world with a clean status line beside it.
    //
    // The sweep is a VIEW operation and is done first, while the store is still
    // considered in sync; the store is invalidated last, so the publication
    // happens after this call has finished what it was called to do.
    this.#view.sweep();
    this.store.invalidate();
  }

  /**
   * Advances the animation, when the view has one.
   *
   * Delegated rather than implemented so a counting view — the test seam, and
   * the thing that proves the O(changes) property — is not made to carry an
   * animation it has no art for. The optional call is what the loop already
   * does, so a view without one simply does not move.
   */
  animate(elapsedMs: number): void {
    this.#view.animate?.(elapsedMs);
  }

  #handlers(): StreamHandlers {
    return {
      onSnapshot: (snapshot: WorldSnapshot) => {
        this.store.hydrate(snapshot);
        // A snapshot is authoritative and may contradict every delta since the
        // last one, so it is a rebuild rather than a merge.
        this.#view.rebuild();
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
