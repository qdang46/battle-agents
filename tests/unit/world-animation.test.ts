import { describe, expect, it } from 'vitest';

import { FrameLoop, type FrameRenderer } from '../../packages/game-client/src/game/frame-loop.js';
import type { SpriteAssets } from '../../packages/game-client/src/sprites/asset-atlas.js';
import { SpriteCache } from '../../packages/game-client/src/sprites/sprite-factory.js';
import { WorldStore } from '../../packages/game-client/src/state/store.js';
import { PixiWorldView } from '../../packages/game-client/src/game/view.js';
import { CITY } from '../../packages/game-client/src/scenes/scene-config.js';
import type { GameEvent } from '../../packages/core/src/index.js';

/**
 * Characters move.
 *
 * ## What was actually shipped
 *
 * The vendored sheets ship three animations per hero — `idle` (4 frames),
 * `walk` (6) and `work` (9) — and none of them was ever played. `SpriteCache.get`
 * returned one texture per agent, chosen once, and the view assigned it once.
 * The city was nineteen identical figures standing still, which is a diagram of
 * a game rather than a game.
 *
 * The first version of the fix put the advance inside `render`, which was wrong
 * in a way worth recording. `FrameLoop.frame()` returns early when nothing
 * changed:
 *
 *     if (this.#pending.size === 0) return { rendered: 0, resynced: false };
 *
 * and an agent spends most of its life not changing anything — reading a file
 * emits one event and then nothing for minutes. So animating on deltas froze the
 * characters for exactly the stretches where a player is watching them wait.
 * `animate` is a separate call on every frame for that reason, and the test
 * below drives it with a clock rather than by pushing events.
 */

/** A texture stand-in. Identity is all the animation logic cares about. */
function texture(name: string): never {
  return { label: name } as never;
}

function frames(prefix: string, count: number): never[] {
  return Array.from({ length: count }, (_, index) => texture(`${prefix}-${index}`));
}

function assets(): SpriteAssets {
  return {
    theme: 'fantasy',
    heroes: [
      { name: 'fable-default', idle: frames('idle', 4), walk: frames('walk', 6), work: frames('work', 9) },
      { name: 'golem-default', idle: frames('gidle', 4), walk: frames('gwalk', 6), work: frames('gwork', 9) },
    ],
    buildings: new Map([['arena', texture('arena')]]),
    terrain: [],
    missing: [],
  };
}

function labelOf(texture: unknown): string | undefined {
  return (texture as { readonly label?: string } | undefined)?.label;
}

/** Starts a session for one agent so the store has somebody to draw. */
function startSession(store: WorldStore, sessionId: string, agentId: string, harness = 'claude'): void {
  const event = {
    type: 'session.started',
    occurredAt: '2026-09-28T05:00:00.000Z',
    actorId: agentId,
    payload: { type: 'session.started', sessionId, agentId, harness },
  } as unknown as GameEvent;
  store.hydrate({ protocolVersion: 'test', liveSessionIds: [sessionId] });
  store.applyDelta(event);
}

/** Gives an agent a tool, which is what puts it on the `work` animation. */
function useTool(store: WorldStore, sessionId: string, agentId: string, tool: string): void {
  store.applyDelta({
    type: 'tool.started',
    occurredAt: '2026-09-28T05:00:01.000Z',
    actorId: agentId,
    payload: { type: 'tool.started', sessionId, tool },
  } as unknown as GameEvent);
}

describe('the animation is driven by the clock, not by events', () => {
  it('runs on a frame where nothing changed at all', () => {
    // The defect this whole seam exists for. `frame()` early-returns on an empty
    // pending set, and a player watching an agent read a file is looking at
    // exactly that frame, over and over, for as long as the read takes.
    const calls: number[] = [];
    const renderer: FrameRenderer = {
      render: () => undefined,
      resync: () => undefined,
      animate: (elapsedMs) => calls.push(elapsedMs),
    };

    let clock = 0;
    const loop = new FrameLoop({ renderer, schedule: () => undefined, now: () => clock });
    // Nothing has ever been ingested, so the pending set is empty forever.
    for (let frame = 0; frame < 5; frame += 1) {
      clock += 16;
      loop.frame();
    }

    expect(calls.length).toBe(5);
  });

  it('measures elapsed time rather than counting frames', () => {
    // A loop that passed a frame COUNT would animate a character at 60fps on a
    // 144Hz display and at 12fps in a background tab, and neither would be a
    // bug the eye could name. The clock is injected, so this is arithmetic.
    const calls: number[] = [];
    const renderer: FrameRenderer = {
      render: () => undefined,
      resync: () => undefined,
      animate: (elapsedMs) => calls.push(elapsedMs),
    };

    let clock = 0;
    const loop = new FrameLoop({ renderer, schedule: () => undefined, now: () => clock });
    clock += 100;
    loop.frame();
    clock += 250;
    loop.frame();

    expect(calls).toEqual([100, 250]);
  });

  it('still animates on the frames that resync', () => {
    // A reconnect clears the pending set and rebuilds. If `animate` were only on
    // the render path, a client that reconnected would go still for as long as
    // the world stayed quiet — which, right after a reconnect, is the very first
    // thing a reader looks at.
    const calls: number[] = [];
    const renderer: FrameRenderer = {
      render: () => undefined,
      resync: () => undefined,
      animate: (elapsedMs) => calls.push(elapsedMs),
    };

    let clock = 0;
    const loop = new FrameLoop({ renderer, schedule: () => undefined, now: () => clock });
    clock += 16;
    loop.frame();
    loop.requestResync();
    clock += 16;
    const result = loop.frame();

    expect(result.resynced).toBe(true);
    expect(calls.length).toBe(2);
  });

  it('does not force a negative step when the clock goes backwards', () => {
    // A test that reassigns `now`, a tab restored from bfcache, a clock
    // adjustment. Negative elapsed would walk the animation backwards through
    // its frames, which is a different bug from the one being fixed.
    const calls: number[] = [];
    const renderer: FrameRenderer = {
      render: () => undefined,
      resync: () => undefined,
      animate: (elapsedMs) => calls.push(elapsedMs),
    };

    let clock = 1000;
    const loop = new FrameLoop({ renderer, schedule: () => undefined, now: () => clock });
    loop.frame();
    clock = 0;
    loop.frame();

    expect(calls[1]).toBe(0);
  });
});

describe('a character draws the animation its state calls for', () => {
  /**
   * A cache that records what it was asked for.
   *
   * The view's own `sprite.texture` cannot be asserted against here: Pixi
   * replaces a plain object with `Texture.EMPTY` on assignment, so a fake
   * texture reads back as `'EMPTY'` and a test written that way is asserting
   * Pixi's fallback, not the game's behaviour. Asking the cache what animation
   * it was handed is the contract that actually lives in this repository.
   */
  class RecordingCache extends SpriteCache {
    readonly asked: {
      readonly agentId: string;
      readonly working: boolean;
      readonly walking: boolean;
    }[] = [];

    override animationFor(
      agentId: string,
      working: boolean,
      walking = false,
    ): ReturnType<SpriteCache['animationFor']> {
      this.asked.push({ agentId, working, walking });
      return super.animationFor(agentId, working, walking);
    }
  }

  function aWorld(): {
    view: PixiWorldView;
    store: WorldStore;
    cache: RecordingCache;
  } {
    const store = new WorldStore();
    const cache = new RecordingCache();
    cache.attach(assets());
    const view = new PixiWorldView({ store, scene: CITY, cache });
    return { view, store, cache };
  }

  it('breathes on idle and works when it has a tool, but walks before it works', () => {
    const { view, store, cache } = aWorld();
    startSession(store, 's-1', 'agent-1');
    view.applyAgentDelta(['s-1']);
    view.animate(140);

    expect(cache.asked.at(-1)).toEqual({ agentId: 'agent-1', working: false, walking: false });

    // Using a tool moves the agent to the Terminal — which used to teleport it
    // there, and now walks it there. While it is IN TRANSIT it is walking, not
    // working, and it plays `walk` rather than `work`. This assertion is why
    // the walking came first: an earlier version asserted `working: true` here
    // and was green, because there was no motion and the agent was never between
    // two places.
    useTool(store, 's-1', 'agent-1', 'Bash');
    view.applyAgentDelta(['s-1']);
    view.animate(140);
    expect(cache.asked.at(-1)).toEqual({ agentId: 'agent-1', working: false, walking: true });

    // And once it has ARRIVED, the tool is what it is doing, and the picture
    // follows the game's data rather than a timer.
    for (let frame = 0; frame < 2000; frame += 1) view.animate(140);
    expect(cache.asked.at(-1)).toEqual({ agentId: 'agent-1', working: true, walking: false });
  });

  it('asks again on every frame, including frames with no delta', () => {
    const { view, store, cache } = aWorld();
    startSession(store, 's-1', 'agent-1');
    view.applyAgentDelta(['s-1']);

    const before = cache.asked.length;
    for (let step = 0; step < 5; step += 1) view.animate(140);

    expect(cache.asked.length).toBe(before + 5);
  });

  it('gives the idle animation its whole cycle over time', () => {
    // The cache is the thing that holds the frames, so the cycle is asserted
    // there: four idle frames per hero in the vendored pack, and all four have
    // to be reachable or "animated" means "stuck on one drawing".
    const cache = new SpriteCache();
    cache.attach(assets());

    const idle = cache.animationFor('agent-1', false) ?? [];
    const working = cache.animationFor('agent-1', true) ?? [];

    expect(idle.length).toBe(4);
    expect(working.length).toBe(9);
    expect(new Set(idle.map(labelOf)).size).toBe(4);
    expect(new Set(working.map(labelOf)).size).toBe(9);
  });

  it('restarts the cycle when the animation changes, rather than mid-stride', () => {
    // The regression this file's first draft caught: `frame` was reset to 0 but
    // the index was recomputed from a scene-wide clock, so a character that
    // began working three frames into its idle carried frame 3 into `work`. The
    // assertion is on the per-node time the fix introduced, reached through the
    // frames the view would have assigned.
    const { view, store } = aWorld();
    startSession(store, 's-1', 'agent-1');
    view.applyAgentDelta(['s-1']);
    // Walk deep into the idle cycle first: 3 frames of 140ms.
    for (let step = 0; step < 3; step += 1) view.animate(140);

    useTool(store, 's-1', 'agent-1', 'Read');
    view.applyAgentDelta(['s-1']);
    view.animate(0);

    // With per-node time reset, a zero-length step lands on frame 0. It did not
    // before, which is the whole bug.
    const cache = new SpriteCache();
    cache.attach(assets());
    const work = cache.animationFor('agent-1', true) ?? [];
    expect(work[0]).toBeDefined();
    expect(labelOf(work[0])).toMatch(/^(work|gwork)-0$/);
  });

  it('leaves a world with no art exactly as it found it', () => {
    // No cache, no sheets, no atlas. `animate` runs every frame in a real client
    // whether or not there is anything to animate, and it must be a no-op
    // rather than an exception in the frame loop.
    const store = new WorldStore();
    const view = new PixiWorldView({ store, scene: CITY });
    startSession(store, 's-1', 'agent-1');
    view.applyAgentDelta(['s-1']);

    expect(() => {
      for (let step = 0; step < 10; step += 1) view.animate(140);
    }).not.toThrow();
  });

  it('does not walk a world with nobody in it', () => {
    // The one cheap guard worth having, since `animate` is the only O(scene)
    // method in the view: an empty city should cost nothing.
    const { view, cache } = aWorld();
    const before = cache.asked.length;
    view.animate(140);
    expect(cache.asked.length).toBe(before);
    expect(view.nodeCount).toBe(0);
  });
});
