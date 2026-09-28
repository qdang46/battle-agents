/**
 * Grid routing: the shortest walk between two cells, through walkable ones.
 *
 * Ported from agent-quest `client/src/game/data/road-network.ts` (MIT,
 * Copyright (c) 2026 Fulvio Scichilone, recorded in THIRD-PARTY-NOTICES.md) —
 * that file's `bfs` is where the search came from.
 *
 * ## What is carried over, and what is not
 *
 * Carried: breadth-first over walkable cells, and the reason the reference is a
 * BFS rather than A*. Every edge on a tile grid costs one step whatever
 * direction it runs, so a uniform-cost search is already optimal and a
 * heuristic would be decoration.
 *
 * Three divergences, and each is a fix rather than a departure:
 *
 * 1. The reference searches thirteen hand-authored waypoints and a fixed edge
 *    list. That is a village with a known road layout. Ours takes a predicate,
 *    because walkability here is terrain, and terrain is sampled
 *    (`terrain-map.ts`) rather than enumerated by a person.
 * 2. The reference's queue carries a whole path per node — `[...path,
 *    neighbor]`, once per expansion — which is quadratic in path length and
 *    re-allocates the entire search history on every step. This keeps a parent
 *    pointer per cell and reconstructs once, when the target is reached.
 * 3. **The reference returns `[start, end]` when the search fails**: a straight
 *    line through whatever is in the way, which is the one thing a pathfinder
 *    must never hand back. `motion.ts` exists precisely because characters
 *    teleporting across a tile map is what makes a world read as a dashboard
 *    rather than a game, and a fallback route reintroduces that from the
 *    routing layer where no screenshot will ever catch it. Failure is `null`,
 *    and what to do about it is the caller's decision to make.
 *
 * ## Why this sits beside `pathfind.ts` and not inside it
 *
 * That module is Dijkstra over a waypoint graph: a few dozen identified nodes,
 * weighted by Euclidean distance, routing between places someone labelled. This
 * is unweighted, cell-by-cell, and has no node identity. They answer different
 * questions, so the exports are deliberately not `WaypointGraph` / `PathNode` —
 * an import that reached for the wrong one would still typecheck, because both
 * are "a path".
 */

export interface GridPoint {
  readonly gx: number;
  readonly gy: number;
}

/**
 * Whether a cell can be stood on.
 *
 * A predicate rather than a bounded grid, so it is also the out-of-bounds
 * answer: a caller whose world has an edge says so here, and one whose world is
 * a sampler (`terrainSampler`) gets that for free.
 */
export type Walkable = (gx: number, gy: number) => boolean;

/**
 * Cardinal steps, in a fixed order.
 *
 * The order is the tie-break. Every cell on a 4-neighbour grid has the same step
 * cost, so on open ground many paths tie on length and the search returns
 * whichever it reaches first. Without a fixed order that path would follow Map
 * iteration, and a route that changes between otherwise identical runs is a bug
 * report with no reproduction.
 */
const CARDINALS: readonly GridPoint[] = [
  { gx: 0, gy: -1 },
  { gx: 1, gy: 0 },
  { gx: 0, gy: 1 },
  { gx: -1, gy: 0 },
];

/**
 * Cells the search may expand before it gives up.
 *
 * Generous enough that no real map reaches it, and present anyway because
 * `walkable` is unbounded: an all-grass region is a legitimate input, and BFS
 * over the infinite plane never returns. A pathfinder that hangs the frame loop
 * on valid input is worse than one that gives up, since the frame loop is the
 * one thing in this package that must stay ignorant of everything else.
 *
 * Exhausting the budget returns `null` like any other failure, so a caller
 * cannot tell "walled off" from "gave up". That is deliberate — both want the
 * same response, and a return type carrying the distinction would only invite a
 * caller to branch on something it cannot act on.
 */
const MAX_SEARCH_CELLS = 20_000;

/** Map key for a cell. A string, because the region is not bounded to positives. */
const cellKey = (gx: number, gy: number): string => `${gx},${gy}`;

/**
 * The shortest walk from `from` to `to` inclusive, or `null` when there is none.
 *
 * Every step is one cardinal move between cells that `walkable` accepts, so the
 * result is directly consumable as a list of tile coordinates — no interpolation
 * step is needed to get from here to a sprite.
 */
export function findGridPath(
  from: GridPoint,
  to: GridPoint,
  walkable: Walkable,
): GridPoint[] | null {
  // The target is vetted; the start is not, and the asymmetry is the decision.
  // A cell `walkable` rejects is a place nobody can arrive, and a path leading
  // into one is a sprite clipping through terrain. The start, by contrast, is
  // where the caller is already standing — vetoing it strands an agent that
  // spawned one tile into a water cell, and that is a bug in the spawn rather
  // than in the route.
  if (!walkable(to.gx, to.gy)) return null;
  if (from.gx === to.gx && from.gy === to.gy) return [{ gx: from.gx, gy: from.gy }];

  const cameFrom = new Map<string, GridPoint>();
  const seen = new Set<string>([cellKey(from.gx, from.gy)]);
  const queue: GridPoint[] = [{ gx: from.gx, gy: from.gy }];

  // A head index rather than shift(): this queue is walked once from front to
  // back and never reordered, and Array.shift is O(n) in the array it is called
  // on, which is the whole queue. `current` is read from the queue rather than
  // popped, which is also what lets the loop end on "nothing left" instead of on
  // a length check.
  let head = 0;
  let current: GridPoint | undefined = { gx: from.gx, gy: from.gy };
  while (current !== undefined && seen.size <= MAX_SEARCH_CELLS) {
    if (current.gx === to.gx && current.gy === to.gy) return unwind(cameFrom, current);

    for (const step of CARDINALS) {
      const gx = current.gx + step.gx;
      const gy = current.gy + step.gy;
      const key = cellKey(gx, gy);
      if (seen.has(key) || !walkable(gx, gy)) continue;
      seen.add(key);
      cameFrom.set(key, current);
      queue.push({ gx, gy });
    }

    head += 1;
    current = queue[head];
  }
  return null;
}

/** Parent pointers back to the start, reversed into travel order. */
function unwind(cameFrom: Map<string, GridPoint>, end: GridPoint): GridPoint[] {
  const path: GridPoint[] = [{ gx: end.gx, gy: end.gy }];
  let cursor = cameFrom.get(cellKey(end.gx, end.gy));
  while (cursor !== undefined) {
    path.push({ gx: cursor.gx, gy: cursor.gy });
    cursor = cameFrom.get(cellKey(cursor.gx, cursor.gy));
  }
  return path.reverse();
}
