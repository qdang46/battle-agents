import { describe, expect, it } from 'vitest';

import { findGridPath, type GridPoint, type Walkable } from './waypoint-graph.js';

/**
 * The grid router.
 *
 * A shortest-path search is the one piece of routing code that can be
 * simultaneously typechecked, non-hanging and wrong, because "wrong" here means
 * a path that is a legal sequence of steps and goes somewhere useless. So the
 * assertions are about the path's SHAPE — contiguity, endpoints, every cell
 * walkable, the number of steps — and not merely that something came back.
 */

const open = (): Walkable => () => true;

/** The Manhattan distance, which is the floor for any 4-neighbour route. */
const manhattan = (a: GridPoint, b: GridPoint): number =>
  Math.abs(a.gx - b.gx) + Math.abs(a.gy - b.gy);

/**
 * Steps walked, not cells returned.
 *
 * A path is inclusive of both endpoints, so its length is one more than the
 * distance walked. Comparing `path.length` against a step count is the
 * off-by-one this whole file would otherwise repeat.
 */
const stepsOf = (path: readonly GridPoint[] | null): number => (path?.length ?? 0) - 1;

const isCardinalStep = (from: GridPoint, to: GridPoint): boolean =>
  manhattan(from, to) === 1;

describe('findGridPath', () => {
  it('crosses open ground in the fewest possible steps', () => {
    const walkable = open();
    const from: GridPoint = { gx: 0, gy: 0 };
    const to: GridPoint = { gx: 7, gy: 7 };

    const path = findGridPath(from, to, walkable);

    expect(path).not.toBeNull();
    // The corner-to-corner diagonal is 14 steps, and any detour would be
    // longer — so a shorter route would mean the search is not measuring steps
    // at all.
    expect(stepsOf(path)).toBe(manhattan(from, to));
    expect(path?.[0]).toEqual(from);
    expect(path?.[path.length - 1]).toEqual(to);
  });

  it('emits one cardinal step at a time, through walkable cells only', () => {
    const walkable: Walkable = (gx, gy) => gx >= 0 && gx < 8 && gy >= 0 && gy < 8;
    const path = findGridPath({ gx: 1, gy: 6 }, { gx: 6, gy: 1 }, walkable);

    expect(path).not.toBeNull();
    for (const cell of path ?? []) {
      expect(walkable(cell.gx, cell.gy)).toBe(true);
    }
    for (let i = 1; i < (path?.length ?? 0); i += 1) {
      // A diagonal here would be a two-cell move emitted as one step, which is
      // exactly the corner-clipping `motion.ts` is written to prevent.
      expect(isCardinalStep(path![i - 1]!, path![i]!)).toBe(true);
    }
  });

  it('goes around a wall instead of through it', () => {
    // A full-height wall on gx = 3, open only along the bottom row.
    const walkable: Walkable = (gx, gy) => gx >= 0 && gx < 7 && gy >= 0 && gy < 7 && !(gx === 3 && gy <= 5);

    const path = findGridPath({ gx: 0, gy: 0 }, { gx: 6, gy: 3 }, walkable);

    expect(path).not.toBeNull();
    // 6 down to the gap, 6 across, 3 back up = 15 steps, against a straight-line
    // 9. Beating neither of those is the whole assertion: a search that ignored
    // the wall would return 9.
    expect(stepsOf(path)).toBe(15);
    expect(stepsOf(path)).toBeGreaterThan(manhattan({ gx: 0, gy: 0 }, { gx: 6, gy: 3 }));
    for (const cell of path ?? []) {
      expect(walkable(cell.gx, cell.gy)).toBe(true);
    }
  });

  it('returns null when the target is walled off', () => {
    // A 5x5 region with its middle column removed, so the two halves touch
    // nothing and the region is closed at every edge.
    const walled: Walkable = (gx, gy) =>
      gx >= 0 && gx <= 4 && gy >= 0 && gy <= 4 && gx !== 2;

    expect(findGridPath({ gx: 0, gy: 0 }, { gx: 4, gy: 0 }, walled)).toBeNull();
    // The same grid with the wall opened at gy = 4. Without this second
    // assertion the first one would also pass on a search that never works.
    // 4 down, 4 across, 4 back up.
    const gap: Walkable = (gx, gy) =>
      gx >= 0 && gx <= 4 && gy >= 0 && gy <= 4 && !(gx === 2 && gy <= 3);
    expect(stepsOf(findGridPath({ gx: 0, gy: 0 }, { gx: 4, gy: 0 }, gap))).toBe(12);
  });

  it('returns null rather than a path into an unwalkable target', () => {
    // The ported reference returns [start, end] when its search fails: a
    // straight line through whatever is in the way. This is the assertion that
    // keeps that fallback out, and it is a value assertion because the bad
    // version returns a plausible-looking array.
    const water = new Set(['1,0', '2,0', '3,0', '4,0']);
    const walkable: Walkable = (gx, gy) => !water.has(`${gx},${gy}`);

    expect(findGridPath({ gx: 0, gy: 0 }, { gx: 4, gy: 0 }, walkable)).toBeNull();
  });

  it('is a single cell when the caller is already standing on the target', () => {
    const walkable: Walkable = (gx, gy) => gx < 4 && gy < 4;
    expect(findGridPath({ gx: 2, gy: 2 }, { gx: 2, gy: 2 }, walkable)).toEqual([{ gx: 2, gy: 2 }]);
  });

  it('gives the same answer for the same question', () => {
    const walkable = open();
    const from: GridPoint = { gx: 0, gy: 0 };
    const to: GridPoint = { gx: 5, gy: 5 };

    expect(findGridPath(from, to, walkable)).toEqual(findGridPath(from, to, walkable));
  });

  it('gives up rather than searching an unbounded walkable region', () => {
    // An all-walkable plane is a legal input for a predicate with no bounds, and
    // the search it drives has no end. The target here is walkable and reachable
    // the whole way, so this returns null on the search cap alone — which is
    // what makes it a test of the cap: delete MAX_SEARCH_CELLS and this call
    // never returns, rather than returning something wrong.
    const corridor: Walkable = (gx, gy) => gx === 0 && gy >= 0;

    expect(findGridPath({ gx: 0, gy: 0 }, { gx: 0, gy: 30_000 }, corridor)).toBeNull();
  });
});
