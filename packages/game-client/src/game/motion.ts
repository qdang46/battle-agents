/**
 * Walking, and not teleporting.
 *
 * ## What was wrong
 *
 * A character's position was its ZONE's tile. When a `tool.started` event said an
 * agent picked up a shell, the sprite was re-parented to the Terminal's grid
 * coordinate on the very next delta. The agent blinked from one end of the city
 * to the other.
 *
 * That is the single most obvious thing that makes a world read as a dashboard
 * rather than a game, and it is invisible in a screenshot — every frame is
 * perfectly correct, and no two consecutive frames are.
 *
 * ## What this adds
 *
 * A position that is its OWN thing, which chases the zone the game says the
 * agent is in, at a fixed speed, and arrives eventually. The game still decides
 * WHERE; this decides HOW, and the two are separable: the store's `zone` is the
 * truth, and this is the truth being carried there by a pair of legs.
 *
 * ## Why the stepping, and why the tile
 *
 * The world is on a tile grid, so a walk is a path along that grid and not a
 * straight line across it. Characters take the L-shaped route — along one axis
 * then the other — because diagonal movement across a tile map is what makes
 * characters clip corners, and a character clipping a corner of the Workshop
 * reads as a bug in a way that a character walking the long way round does not.
 *
 * ## Why it is not in the view
 *
 * The view draws. This moves. A position that changed as a side effect of being
 * drawn would make the frame loop the owner of game state, and the loop is the
 * one thing in this package that must stay ignorant of zones.
 */

import { ZONE_PLACEMENT } from '../zones.js';
import { findGridPath } from './waypoint-graph.js';
import { terrainSampler, type TerrainId } from './terrain-map.js';
import type { ZoneId } from '@battle-agents/protocol';

/** World pixels a character covers in one second. Slower than it feels. */
export const WALK_SPEED_PX_PER_MS = 0.06;

/** One tile, in the same units the projection multiplies grid coords by. */
export const WALK_TILE_PX = 48;

/** How close to a tile counts as having arrived. */
const ARRIVE_EPSILON = 0.5;

export interface CharacterMotion {
  /** Where it is right now, in grid coordinates. Fractional mid-walk. */
  gx: number;
  gy: number;
  /** The tile it is walking to. Equal to its position when it has arrived. */
  targetGx: number;
  targetGy: number;
  /** The zone it is walking to, and the one it left. `undefined` before either. */
  headingTo: ZoneId | undefined;
  /** False while walking, and the reason a frame should play `walk`. */
  moving: boolean;
  /**
   * The waypoints still to be walked, nearest first.
   *
   * Empty means "go direct", which is the fallback for an unreachable
   * destination. A character that is asked to cross water is routed around it
   * when a route exists and walks through it when one does not — arriving
   * matters more than the scenery between here and there.
   */
  route: { gx: number; gy: number }[];
}

export function motionAt(zone: ZoneId): CharacterMotion {
  const placement = placementInScene(zone);
  const gx = placement?.gx ?? 0;
  const gy = placement?.gy ?? 0;
  return {
    gx,
    gy,
    targetGx: gx,
    targetGy: gy,
    headingTo: undefined,
    moving: false,
    route: [],
  };
}

/**
 * The tile for a zone, in whatever scene that zone is drawn in.
 *
 * Read from the one placement table rather than a copy, so a zone added there is
 * walkable the moment it exists. A zone with no placement lands on the origin,
 * which is a real answer — an unplaced zone has nowhere to walk to.
 */
function placementInScene(zone: ZoneId): { gx: number; gy: number } | undefined {
  const placement = ZONE_PLACEMENT[zone];
  return placement === undefined ? undefined : { gx: placement.gx, gy: placement.gy };
}

/**
 * Advances one character by `elapsedMs`, toward the zone it is headed for.
 *
 * Mutates in place and returns the same object, deliberately: this runs for
 * every visible character on every frame, and allocating a fresh motion per
 * character per frame is the kind of cost that shows up as a stutter at exactly
 * the moment the world gets busy enough to be worth looking at.
 */
export function advanceMotion(motion: CharacterMotion, zone: ZoneId, elapsedMs: number): CharacterMotion {
  const target = placementInScene(zone);
  if (target === undefined) {
    // A zone with no row in the placement table has nowhere to walk to, and the
    // origin is not it. The first version substituted (0,0) and every character
    // given an unplaced zone set off for the top-left corner of the map, which
    // is a place no zone is and therefore a place nobody can name.
    //
    // Standing still is the honest answer: the character is somewhere the game
    // drew, and there is no instruction about where to go.
    motion.moving = false;
    motion.headingTo = undefined;
    return motion;
  }

  // A different destination cancels the previous route rather than finishing it.
  // An agent that was told to walk to the Workshop and is now told to run the
  // tests does not walk to the Workshop first.
  //
  // The comparison is against where it is STANDING, not against the old
  // target, so a character that has arrived and is told to stay is not
  // re-departing every frame — which is what a target-only comparison does the
  // moment the two drift apart by a sub-pixel.
  const alreadyThere =
    motion.gx === target.gx && motion.gy === target.gy && !motion.moving;
  if (target.gx !== motion.targetGx || target.gy !== motion.targetGy) {
    motion.targetGx = target.gx;
    motion.targetGy = target.gy;
    motion.headingTo = alreadyThere ? undefined : zone;
    // Plan the route ONCE per destination, not per frame. Recomputing it every
    // frame would mean a BFS per character per frame, and a path that changed
    // every frame is a character that never commits to a direction.
    motion.route = planRoute(motion, target);
  }

  if (arrived(motion, target.gx, target.gy)) {
    snapTo(motion, target.gx, target.gy);
    // The route is DROPPED on arrival, not merely left alone. A character that
    // reached its destination still holding the waypoints it walked is one
    // destination change away from following a stale path, because `step`
    // prefers the route over the direct walk and nothing else would clear it.
    motion.route = [];
    motion.moving = false;
    motion.headingTo = undefined;
    return motion;
  }

  step(motion, target.gx, target.gy, elapsedMs);
  motion.moving = true;
  return motion;
}

/** True when the character is close enough that moving further would overshoot. */
function arrived(motion: CharacterMotion, gx: number, gy: number): boolean {
  return (
    Math.abs(motion.gx - gx) * WALK_TILE_PX < ARRIVE_EPSILON * WALK_TILE_PX &&
    Math.abs(motion.gy - gy) * WALK_TILE_PX < ARRIVE_EPSILON * WALK_TILE_PX
  );
}

function snapTo(motion: CharacterMotion, gx: number, gy: number): void {
  motion.gx = gx;
  motion.gy = gy;
}

/**
 * One step, one axis per call, along a ROUTE rather than straight at the target.
 *
 * ## Why there is a route at all
 *
 * The L-shaped walk — along one axis, then the other — is right for an open grid
 * and wrong the moment there is anything in the way, because both legs are
 * computed without asking whether the cell is standable. A character crossing
 * from the Plaza to the Quest Board goes straight through a lake and reads as a
 * bug, not as a shortcut.
 *
 * So the route is `findGridPath` over the scene's terrain, with water and rock
 * refused, and the L-shape is the FALLBACK for when no route exists. It is the
 * fallback rather than the primary because a character must arrive even if its
 * destination is walled off — stranded in the plaza forever is a worse answer
 * than a straight line through scenery, and arriving is the promise.
 *
 * @param onArrive called once when the last waypoint is reached, so the caller
 *   can re-plan without this module owning a goal.
 */
function step(motion: CharacterMotion, gx: number, gy: number, elapsedMs: number): void {
  const budgetPx = WALK_SPEED_PX_PER_MS * Math.max(0, elapsedMs);
  if (budgetPx <= 0) return;

  // Follow the route when there is one. A waypoint is consumed the moment the
  // character is standing on it, so a route is walked to the end and then the
  // direct walk takes over for the last tile.
  const waypoint = motion.route[0];
  if (waypoint !== undefined) {
    // A waypoint is reached when BOTH axes are there, and the axes are walked
    // with the same one-axis-then-the-other rule the direct walk uses — a route
    // that turned diagonally through a lake would defeat the routing.
    const before = { gx: motion.gx, gy: motion.gy };
    walkL(motion, waypoint.gx, waypoint.gy, budgetPx);
    if (motion.gx === before.gx && motion.gy === before.gy) {
      // No ground made this frame. Re-plan from here rather than grinding at a
      // waypoint the character cannot reach, which is what strands it.
      motion.route = [];
    } else if (motion.gx === waypoint.gx && motion.gy === waypoint.gy) {
      motion.route.shift();
    }
    return;
  }

  // No route: walk straight, an L at a time.
  walkL(motion, gx, gy, budgetPx);
}

/**
 * One L, axis by axis, sharing one budget.
 *
 * The first axis takes what it needs and returns what it did not spend; the
 * second gets the remainder. The turn happens only once the first axis is DONE,
 * which is what keeps a character from cutting a corner — and what the first
 * version got wrong, re-measuring which axis was longer every frame and leaving
 * characters stranded one tile short, walking in place.
 */
function walkL(motion: CharacterMotion, gx: number, gy: number, budgetPx: number): void {
  if (budgetPx <= 0) return;
  const xFirst = Math.abs(gx - motion.gx) >= Math.abs(gy - motion.gy);
  const spentFirst = xFirst ? moveAlong(motion, 'gx', budgetPx) : moveAlong(motion, 'gy', budgetPx);
  const remainder = budgetPx - spentFirst;
  if (remainder <= 0) return;
  const firstDone = xFirst ? motion.gx === gx : motion.gy === gy;
  if (firstDone) moveAlong(motion, xFirst ? 'gy' : 'gx', remainder);
}

/** Moves along one axis by at most `budgetPx`, and reports how far it got. */
function moveAlong(motion: CharacterMotion, axis: 'gx' | 'gy', budgetPx: number): number {
  if (budgetPx <= 0) return 0;
  const wantPx = (axis === 'gx' ? motion.targetGx - motion.gx : motion.targetGy - motion.gy) * WALK_TILE_PX;
  if (wantPx === 0) return 0;
  const magnitude = Math.min(Math.abs(wantPx), budgetPx) * Math.sign(wantPx);
  if (axis === 'gx') motion.gx += magnitude / WALK_TILE_PX;
  else motion.gy += magnitude / WALK_TILE_PX;
  return Math.abs(magnitude);
}

/**
 * The waypoints from here to there, avoiding water and rock.
 *
 * Returns an empty route — meaning "go direct" — when there is no path, when
 * the character is already there, or when nothing is in the way. A character
 * whose destination is unreachable still walks there, because arriving is the
 * promise and the scenery between here and there is not.
 */
function planRoute(
  motion: CharacterMotion,
  target: { gx: number; gy: number },
): { gx: number; gy: number }[] {
  const from = { gx: Math.round(motion.gx), gy: Math.round(motion.gy) };
  const to = { gx: target.gx, gy: target.gy };
  if (from.gx === to.gx && from.gy === to.gy) return [];

  const terrain = terrainSampler(SCENE_TERRAIN_SEED);
  // The target is walked onto whatever is under it: zones are placed on
  // buildings and a character walks INTO the door. Only the route is filtered.
  const walkable = (gx: number, gy: number): boolean =>
    (gx === to.gx && gy === to.gy) || !IMMOVABLE.has(terrain(gx, gy));
  const path = findGridPath(from, to, walkable);
  if (path === null) return [];
  // The first point is where the character already is.
  return path.slice(1);
}

/** The seed the scene terrain is generated from; one city, one world. */
const SCENE_TERRAIN_SEED = 1;

/** Ground a character will not cross. */
const IMMOVABLE: ReadonlySet<TerrainId> = new Set<TerrainId>(['water', 'rock']);
