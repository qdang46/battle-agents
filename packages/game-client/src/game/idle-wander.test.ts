import { describe, expect, it } from 'vitest';

import { MAX_WANDER_TILES, wanderOffset, type GridPoint, type WanderOffset } from './idle-wander.js';

/**
 * The drift an idle character is allowed to make.
 *
 * Both properties here are things a broken version passes silently. A wander
 * that is not deterministic still animates — it just animates differently every
 * reload, which nobody watching a single session can see. A wander that escapes
 * its radius is a wander that has walked an agent off its tile, and that is
 * also only visible if you happen to be looking at the one that did it. So both
 * are sampled across the whole agent and time space rather than checked at one
 * point, where the reference implementation would have passed.
 */

const CENTRE: GridPoint = { gx: 4, gy: 7 };

const AGENTS = ['agent-1', 'agent-2', 'agent-3', 'a', '', 'ünïcødé-agent', 'agent-1 '] as const;

/** A span long enough to cross many dwells: 40s is thirteen of them. */
const SPAN_MS = 40_000;
const SAMPLE_STEP_MS = 37;

function sampleAll(agentId: string): WanderOffset[] {
  const points: WanderOffset[] = [];
  for (let t = 0; t < SPAN_MS; t += SAMPLE_STEP_MS) {
    points.push(wanderOffset(agentId, t, CENTRE));
  }
  return points;
}

describe('wanderOffset', () => {
  it('gives the same answer for the same agent and time', () => {
    for (const agentId of AGENTS) {
      for (const t of [0, 1, 299, 300, 301, 3000, 12_345, SPAN_MS]) {
        expect(wanderOffset(agentId, t, CENTRE)).toEqual(wanderOffset(agentId, t, CENTRE));
      }
    }
  });

  it('stays within a small radius of the centre, for every agent and every dwell', () => {
    for (const agentId of AGENTS) {
      for (const point of sampleAll(agentId)) {
        const distance = Math.hypot(point.dx, point.dy);
        expect(distance).toBeLessThanOrEqual(MAX_WANDER_TILES);
        expect(Math.hypot(point.gx - CENTRE.gx, point.gy - CENTRE.gy)).toBeCloseTo(distance, 10);
      }
    }
  });

  it('is bounded in tiles, not in some other unit', () => {
    // The radius is only meaningful against a scale. A drift of 0.5 of a tile
    // is a character shifting its weight; the same 0.5 against a pixel grid
    // would be a character standing still, and against a screen it would be off
    // the map. motion.ts measures a tile as 48 world px.
    expect(MAX_WANDER_TILES).toBeGreaterThan(0);
    expect(MAX_WANDER_TILES).toBeLessThanOrEqual(0.5);
  });

  it('moves, rather than returning a constant that passes every other test', () => {
    // Every assertion above is satisfied by a function that always returns the
    // centre. This is the one that a no-op fails, so it has to be here.
    for (const agentId of AGENTS) {
      const points = sampleAll(agentId);
      const distinct = new Set(points.map((p) => `${p.dx},${p.dy}`));
      expect(distinct.size).toBeGreaterThan(1);
    }
  });

  it('gives different agents different drifts, so a crowd is not one character', () => {
    const at = 7_000;
    const drifts = AGENTS.map((agentId) => {
      const { dx, dy } = wanderOffset(agentId, at, CENTRE);
      return `${dx},${dy}`;
    });
    expect(new Set(drifts).size).toBeGreaterThan(1);
  });

  it('returns to the centre at the start of each sway, and never leaves the tile', () => {
    // The reference's idle sequence is [0, 1, 2, 1]: the first step of every
    // cycle is the character standing square. Holding that is what makes the
    // sequence read as a breath rather than a drift that ratchets outward.
    for (const agentId of AGENTS) {
      for (let t = 0; t < SPAN_MS; t += 4 * 300) {
        const { dx, dy } = wanderOffset(agentId, t, CENTRE);
        expect(dx).toBe(0);
        expect(dy).toBe(0);
      }
    }
  });

  it('treats a clock before the epoch as the epoch, and a broken one as zero', () => {
    // A non-finite time is not a case worth an error at a per-frame call site;
    // a NaN coordinate propagates into the projection and the character is
    // drawn nowhere, which is worse than it standing still.
    expect(wanderOffset('agent-1', -5_000, CENTRE)).toEqual(wanderOffset('agent-1', 0, CENTRE));
    expect(wanderOffset('agent-1', Number.NaN, CENTRE)).toEqual(wanderOffset('agent-1', 0, CENTRE));
    expect(Number.isFinite(wanderOffset('agent-1', Number.POSITIVE_INFINITY, CENTRE).gx)).toBe(true);
  });
});
