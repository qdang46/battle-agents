/**
 * Standing places around a zone, so a crowd on one tile still reads as a crowd.
 *
 * ## What was wrong
 *
 * `motion.ts` walks a character to its ZONE's tile, and a zone has one tile. So
 * the moment two agents reported the same zone they were sent to the same
 * coordinate and drawn on top of each other. The Plaza looks like it holds one
 * occupant no matter how many agents are idle in it, and the number of agents at
 * a place is the one thing a world map exists to show.
 *
 * ## What this adds
 *
 * A standing place per agent: the zone centre plus an offset, fanned outward in
 * rings so a crowd spreads around the building instead of piling onto it. An
 * agent keeps its spot for as long as it is at that zone, because the offset
 * comes from the agent id rather than from arrival order, a frame counter, or a
 * random draw.
 *
 * It is deliberately inert: pure geometry, no imports, no store, no events. Who
 * is at a zone is somebody else's question; the only thing needed here is "given
 * these ids, where do they stand", which is a function, and a function is
 * testable with no world, no fixtures and no database.
 *
 * ## Mirrored from agent-world (codemoo/agent-world, MIT, declared in that repo's
 * `package.json`; recorded in THIRD-PARTY-NOTICES.md at 851ceee1d3f6)
 *
 * From `server/buildingAssignments.js` and `adapter/worldModel.js`: two ideas
 * worth taking are that a place has a fixed set of standing spots, and that
 * which spot you get is derived from your id rather than from a counter. The id
 * hash is mirrored from `hashString`. The hand-listed ring of ten coordinates
 * (`pickTentPosition` → `hashString(key) % spots.length`) is not: those are tiles
 * chosen against one specific building layout, and a layout decision about
 * buildings does not belong in a module about agents — the two drift apart the
 * moment either one is edited, and the first version of this file would have
 * silently inherited the other one's floor plan.
 *
 * ## What is not mirrored
 *
 * The reference PERSISTS the assignment: `assignSession` writes a desk into
 * `data/repoAssignments.json` and `nextDeskSlot` hands out the first unclaimed
 * one. That is a server owning durable state, and the client has no such store.
 * Re-reading an assignment from disk on every frame is a frame that is one failed
 * read away from putting two agents in the same chair, and the second copy of
 * the truth — the file and the world — is the kind of thing that disagrees
 * quietly.
 *
 * So the whole fan is derived from the roster on every call, which makes
 * distinctness structural instead of maintained: the ids sort, the sort order
 * indexes the rings, and two distinct ids cannot land on the same ring tile
 * because the mapping is a bijection. The price is the thing a persisted
 * assignment is buying — when an agent leaves, the ids behind it shift one place
 * inward. That is the right trade for a view that redraws every frame, and it is
 * bounded: only agents sorting after the departed one move, and they move to a
 * tile that is theirs by the same rule as before.
 */

/** A position on the tile grid. Fractional — characters are between tiles. */
export interface GridPoint {
  gx: number;
  gy: number;
}

/** Where one agent stands at a zone, and how it got there. */
export interface ZoneSlot {
  /** Centre plus offset: the coordinate the character is drawn at. */
  readonly position: GridPoint;
  /** The offset alone, in tiles. What the fan actually is. */
  readonly offset: GridPoint;
  /** Which standing place this is, counted outward from the zone tile. */
  readonly index: number;
  /** How many standing places are in use, this agent included. */
  readonly occupancy: number;
}

/**
 * The innermost ring's distance from the centre.
 *
 * One, and not zero: the centre tile is where the building is drawn, so an agent
 * standing on it is a sprite inside a wall. The crowd goes around.
 */
const RING_MIN_TILES = 1;

/** The reference's `hashString` multiplier, kept so an id hashes as it does there. */
const HASH_MULTIPLIER = 31;

/**
 * The standing place for one agent, given who is already standing at the zone.
 *
 * `occupants` is who else is there, so the count of agents already at the zone
 * is its length and the total is one more. It is a list rather than a number
 * because distinctness is a property of the ASSIGNMENT and not of one id: a
 * count says how many, and no function of one id and a count can promise that
 * two ids do not collide. Handing the roster in makes the collision impossible
 * to express, and `zoneSlots` exists so a caller holding the full crowd never
 * has to assemble it by hand.
 *
 * The answer depends on the roster only through which ids are in it — never on
 * their order, and never on a previous call.
 */
export function zoneSlot(
  centre: GridPoint,
  agentId: string,
  occupants: readonly string[],
): ZoneSlot {
  const roster = occupants.includes(agentId) ? occupants : [...occupants, agentId];
  return slotAt(centre, standingOrder(roster).indexOf(agentId), roster.length);
}

/**
 * The standing places for a whole crowd, keyed by agent id.
 *
 * A repeated id takes one place, not two, and the object is frozen because it
 * is read on the render path and a caller that mutated the map it was handed
 * would be editing the fan the next character walks into.
 */
export function zoneSlots(
  centre: GridPoint,
  agentIds: readonly string[],
): Readonly<Record<string, ZoneSlot>> {
  const roster = standingOrder(agentIds);
  const occupancy = roster.length;
  return Object.freeze(
    Object.fromEntries(
      roster.map((id, index): [string, ZoneSlot] => [id, slotAt(centre, index, occupancy)]),
    ),
  );
}

function slotAt(centre: GridPoint, index: number, occupancy: number): ZoneSlot {
  const offset = ringOffset(index);
  return {
    position: { gx: centre.gx + offset.gx, gy: centre.gy + offset.gy },
    offset,
    index,
    occupancy,
  };
}

/** The roster, deduplicated and in a fixed order derived from the ids themselves. */
function standingOrder(agentIds: readonly string[]): readonly string[] {
  return [...new Set(agentIds)].sort(byStandingRank);
}

function byStandingRank(left: string, right: string): number {
  const a = standingRank(left);
  const b = standingRank(right);
  // 32-bit hashes collide, and a sort whose order a collision gets to decide is
  // not a determinism anybody can pin in a test. The id breaks the tie, which
  // makes the order total and the answer identical on every engine.
  if (a !== b) return a - b;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The reference's `hashString` (MIT, codemoo/agent-world at 851ceee1d3f6).
 *
 * Hashing the id rather than sorting it keeps the ring order independent of how
 * ids happen to be named: agents are `agent-2` and `agent-10` far more often
 * than anyone means, and a lexicographic fan puts the first ten of them on one
 * side of the building.
 */
function standingRank(agentId: string): number {
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) {
    hash = (hash * HASH_MULTIPLIER + agentId.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * The `index`-th tile of the square ring at Chebyshev distance `radius`, walked
 * counter-clockwise from the zone tile's north-east corner.
 *
 * A square ring rather than a circle because a circle has to be rounded to the
 * grid, and rounding is where a fan quietly stops being a fan: at radius 1 and at
 * radius 2 the 45-degree point both round to (1, 1), so the tenth agent stands on
 * the second. Replacing this walk with a circle is exactly the mutation that
 * turns the ring-boundary test red. `8 * radius` integer tiles have no such
 * failure mode, and the walk emits each corner exactly once.
 */
function ringOffset(index: number): GridPoint {
  const radius = ringRadius(index);
  const perSide = 2 * radius;
  const step = index - tilesThroughRing(radius - 1);
  if (step < perSide) return { gx: radius, gy: -radius + step };
  if (step < 2 * perSide) return { gx: radius - 1 - (step - perSide), gy: -radius };
  if (step < 3 * perSide) return { gx: -radius, gy: -radius + 1 + (step - 2 * perSide) };
  return { gx: -radius + 1 + (step - 3 * perSide), gy: radius };
}

/** Tiles in every ring from the innermost out to and including `radius`. */
function tilesThroughRing(radius: number): number {
  return 4 * radius * (radius + 1);
}

/**
 * Which ring `index` lands in, found by solving `4r(r+1) > index` for `r`.
 *
 * The closed form is exact rather than approximate, and that is worth saying
 * because the obvious reading of `Math.sqrt` is that it rounds: IEEE 754 requires
 * it to be correctly rounded, and a ring boundary is `1 + index` being a perfect
 * square — exactly representable, so the root is the exact integer and
 * `(root - 1) / 2` has no error to carry into the comparison. An earlier version
 * of this added two correction loops "in case the root came back a hair under";
 * removing them changed no test result, which is what established there was
 * nothing there. The ring-boundary cases in the test are what keep that true —
 * deleting the arithmetic's exactness has to turn them red.
 */
function ringRadius(index: number): number {
  return Math.floor((Math.sqrt(1 + index) - 1) / 2) + RING_MIN_TILES;
}
