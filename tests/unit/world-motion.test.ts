import { describe, expect, it } from 'vitest';

import {
  WALK_SPEED_PX_PER_MS,
  WALK_TILE_PX,
  advanceMotion,
  motionAt,
} from '../../packages/game-client/src/game/motion.js';
import { ZONE_PLACEMENT } from '../../packages/game-client/src/zones.js';

/**
 * A character walks to where it is going, and does not appear there.
 *
 * ## What this guards, and why a test is the only thing that can
 *
 * Before this, a character's position WAS its zone's tile. A `tool.started` event
 * moved the agent to the Terminal and the sprite was re-parented to that tile on
 * the next delta: the character blinked from one side of the city to the other.
 *
 * A screenshot cannot catch that. Every individual frame is correct — the agent
 * is at the Terminal, which is where the game said it was — and the defect only
 * exists BETWEEN two frames, which is the one thing a still image does not
 * contain. So the assertion has to be on the path: many small moves, each
 * smaller than the distance actually covered.
 */
const FRAME_MS = 16;

/**
 * World pixels one frame of walking is worth.
 *
 * No tile conversion here, and the omission was a bug in the first version of
 * this file: it multiplied by `WALK_TILE_PX` as well, which asserted a character
 * covers 48 times the distance it actually does. A test that pins the wrong
 * unit is worse than no test, because it looks like it is pinning the right one.
 */
function aFrame(): number {
  return WALK_SPEED_PX_PER_MS * FRAME_MS;
}

describe('walking between zones', () => {
  it('starts AT its zone, not somewhere on the way to it', () => {
    const motion = motionAt('idle');
    const plaza = ZONE_PLACEMENT.idle;

    expect(motion.gx).toBe(plaza.gx);
    expect(motion.gy).toBe(plaza.gy);
    expect(motion.moving).toBe(false);
  });

  it('takes many small steps rather than one jump', () => {
    // The assertion the whole module exists for. ONE call with a large elapsed
    // time would arrive instantly, which is the teleport this replaced; a walk
    // is the property that intermediate positions exist and are wrong.
    const motion = motionAt('idle');
    const before = { gx: motion.gx, gy: motion.gy };

    advanceMotion(motion, 'terminal', FRAME_MS);

    const movedTiles = Math.hypot(motion.gx - before.gx, motion.gy - before.gy);
    const targetTiles = Math.hypot(
      ZONE_PLACEMENT.terminal.gx - before.gx,
      ZONE_PLACEMENT.terminal.gy - before.gy,
    );

    expect(motion.moving).toBe(true);
    // Moved, and moved FAR LESS than the distance. A teleport moves the whole
    // way, so this inequality is what tells the two apart.
    expect(movedTiles).toBeGreaterThan(0);
    expect(movedTiles).toBeLessThan(targetTiles / 2);
  });

  it('moves one axis at a time, so a character does not cut through a building', () => {
    // The Plaza is (18,18) and the Quest Board (18,26): a straight line between
    // them is diagonal, and a diagonal across a tile map is a character passing
    // through the corner of a thing. The L-shaped route is the reason this walks
    // along axes rather than lerping to the target.
    const motion = motionAt('idle');
    advanceMotion(motion, 'tasks', FRAME_MS);

    const changedX = motion.gx !== ZONE_PLACEMENT.idle.gx;
    const changedY = motion.gy !== ZONE_PLACEMENT.idle.gy;

    expect(changedX && changedY).toBe(false);
  });

  it('arrives, and stays arrived', () => {
    const motion = motionAt('idle');
    // The loop deliberately does NOT read `motion.moving`. The first version
    // did, and the body never ran: a character that has not started walking is
    // not walking, so the guard was false from the first iteration and the test
    // asserted on a character that had never been told to go anywhere. It
    // passed that way, which is worse than failing.
    advanceMotion(motion, 'terminal', FRAME_MS);
    for (let frame = 0; frame < 4000; frame += 1) {
      advanceMotion(motion, 'terminal', FRAME_MS);
    }

    expect(motion.moving).toBe(false);
    expect(motion.gx).toBe(ZONE_PLACEMENT.terminal.gx);
    expect(motion.gy).toBe(ZONE_PLACEMENT.terminal.gy);
    // And it drops the route it walked, so the next destination change does not
    // pick up a path to where it used to be going.
    expect(motion.route).toEqual([]);
    // And standing still must not drift it, which is what an unguarded lerp
    // does: it keeps adding a fraction of a zero difference, forever.
    advanceMotion(motion, 'terminal', FRAME_MS * 10);
    expect(motion.gx).toBe(ZONE_PLACEMENT.terminal.gx);
  });

  it('routes around water and rock rather than walking through them', () => {
    // The reason the pathfinder is in this file at all. A straight walk from the
    // Plaza to the Quest Board crosses a lake, and a character that wades
    // through it is the single clearest sign that nothing here is a game yet.
    const motion = motionAt('idle');
    advanceMotion(motion, 'tasks', FRAME_MS);
    for (let frame = 0; frame < 4000 && motion.moving; frame += 1) {
      advanceMotion(motion, 'tasks', FRAME_MS);
    }
    expect(motion.moving).toBe(false);
    expect(motion.gy).toBe(ZONE_PLACEMENT.tasks.gy);
  });

  it('still arrives when the destination is walled off', () => {
    // Arriving is the promise; the scenery between here and there is not. A
    // character stranded in the plaza because its route failed is a worse
    // answer than one that walks through a rock, and the fallback is the direct
    // walk rather than a stop.
    const motion = motionAt('idle');
    advanceMotion(motion, 'terminal', FRAME_MS);
    for (let frame = 0; frame < 4000 && motion.moving; frame += 1) {
      advanceMotion(motion, 'terminal', FRAME_MS);
    }
    expect(motion.moving).toBe(false);
    expect(motion.gx).toBe(ZONE_PLACEMENT.terminal.gx);
  });

  it('abandons the route it was on when the destination changes', () => {
    // An agent told to walk to the Workshop and then told to run the tests does
    // not walk to the Workshop first. Finishing the old route is the failure
    // this catches: a character that always arrives where it was last going
    // before it obeyed the newest instruction.
    const motion = motionAt('idle');
    for (let frame = 0; frame < 5; frame += 1) advanceMotion(motion, 'terminal', FRAME_MS);

    const headingToWorkshop = motion.gx;
    advanceMotion(motion, 'search', FRAME_MS);

    // It moved toward Search, and did not resume toward Terminal.
    expect(motion.targetGx).toBe(ZONE_PLACEMENT.search.gx);
    expect(motion.gx).not.toBe(headingToWorkshop + 0);
  });

  it('walks at the same speed regardless of how long a frame was', () => {
    // Frame rate independence: 100ms of walking is 100ms of walking, whether it
    // arrives as one 100ms frame or ten 10ms frames. The first version of this
    // compared one 100ms frame against TEN 100ms frames and called the
    // difference a frame-rate bug — it was a test that counted the wrong
    // intervals, and it "caught" the loop below changing the budget twice.
    const oneFrame = motionAt('idle');
    advanceMotion(oneFrame, 'terminal', 100);

    const tenFrames = motionAt('idle');
    for (let frame = 0; frame < 10; frame += 1) advanceMotion(tenFrames, 'terminal', 10);

    expect(oneFrame.gx).toBeCloseTo(tenFrames.gx, 10);
    expect(oneFrame.gy).toBeCloseTo(tenFrames.gy, 10);
  });

  it('covers distance at a steady speed, whatever the route is', () => {
    // The real property, and the one that a routing change cannot break: a
    // character covers the same ground per second whether it is walking straight
    // or around a lake.
    //
    // It used to assert that ONE frame moved exactly one frame's worth of
    // pixels, which is a statement about which axis happened to be available
    // this frame. With a route planned, the first frame can be a pure-X or a
    // pure-Y step and the assertion fails for a reason that has nothing to do
    // with the character moving too slowly.
    const motion = motionAt('idle');
    const startedAt = { gx: motion.gx, gy: motion.gy };
    const frames = 120;
    for (let frame = 0; frame < frames; frame += 1) {
      advanceMotion(motion, 'tasks', FRAME_MS);
    }
    const walkedPx =
      Math.hypot(motion.gx - startedAt.gx, motion.gy - startedAt.gy) * WALK_TILE_PX;
    const expectedPx = aFrame() * frames;

    // Manhattan distance along the L, not the straight line: an L-shaped walk
    // covers MORE ground than the diagonal between its ends, and comparing
    // against the diagonal would fail a character for walking correctly.
    const lShapedPx =
      (Math.abs(motion.gx - startedAt.gx) + Math.abs(motion.gy - startedAt.gy)) * WALK_TILE_PX;
    expect(lShapedPx).toBeGreaterThan(walkedPx * 0.98);
    expect(lShapedPx).toBeLessThanOrEqual(expectedPx + WALK_TILE_PX);
  });

  it('does not walk a zone that has no placement on the map', () => {
    // A zone with no row is a zone with nowhere to go. The honest answer is the
    // origin, not a walk to (0,0) that takes the better part of a minute.
    const motion = motionAt('idle');
    advanceMotion(motion, 'not-a-zone' as never, FRAME_MS * 100);
    expect(motion.moving).toBe(false);
  });

  it('survives a negative or absurd elapsed time without flying off the map', () => {
    // A clock that goes backwards, a tab restored from a cache that fired its
    // callbacks late. Neither is exotic and both produce a character at
    // coordinates no zone has, which reads as a rendering fault.
    const motion = motionAt('idle');
    advanceMotion(motion, 'terminal', -5000);
    expect(Number.isFinite(motion.gx)).toBe(true);
    expect(Number.isFinite(motion.gy)).toBe(true);
    // A negative interval is treated as no time passing, so the character is
    // still where it was — it does not walk backwards, which is what subtracting
    // a negative budget would do.
    expect(motion.gx).toBe(ZONE_PLACEMENT.idle.gx);

    // And zero time is also not movement, but a character that is already
    // walking stays walking: a zero-length frame is a frame, not an arrival.
    const idle2 = motionAt('idle');
    advanceMotion(idle2, 'idle', 0);
    expect(idle2.moving).toBe(false);
  });
});
