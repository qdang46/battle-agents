import { describe, expect, it } from 'vitest';

import { zoneSlot, zoneSlots, type GridPoint } from './zone-slot.js';

/**
 * The fan, proven as geometry rather than as a screenshot.
 *
 * Two agents on one tile is a frame nobody can check by looking: the second
 * sprite is behind the first, the picture is uncorrupted, and whether that
 * happened is only visible if you know the answer. The failure is also silent in
 * the other direction — a fan that scatters agents to opposite corners is still
 * "distinct", so `distinct` alone is a gate that passes a broken fan.
 *
 * So the properties asserted are the three that actually have to hold at once:
 * every agent has its own tile, the tile is not the zone's own tile, and the
 * assignment is the same function of the id set every time. The counts here are
 * chosen to cross ring boundaries (8, 24, 48 tiles) and not to stop at a happy
 * first ring, because the duplicated-tile bug this guards lives in the rounding
 * at the boundary and is invisible at index 7.
 */

const CENTRE: GridPoint = { gx: 18, gy: 18 };
const OTHER_CENTRE: GridPoint = { gx: 5, gy: 31 };

/** A crowd comfortably past the second ring, and past the third. */
const CROWD_SIZE = 60;

function agentIds(count: number): string[] {
  return Array.from({ length: count }, (_unused, i) => `agent-${i}`);
}

/** Chebyshev distance in tiles — the grid's own notion of how far apart. */
function ringDistance(a: GridPoint, centre: GridPoint): number {
  return Math.max(Math.abs(a.gx - centre.gx), Math.abs(a.gy - centre.gy));
}

describe('zoneSlots', () => {
  it('gives every agent at a zone its own tile', () => {
    const ids = agentIds(CROWD_SIZE);
    const slots = zoneSlots(CENTRE, ids);

    const positions = ids.map((id) => `${slots[id]?.position.gx},${slots[id]?.position.gy}`);

    // Set size, not Set size vs array length: a duplicate is invisible to a
    // count and is the entire bug.
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('stays distinct across every ring boundary, not just the first', () => {
    // 8, 24 and 48 are where the first, second and third rings end. An
    // off-by-one in the ring arithmetic shows up as a collision on exactly one
    // of these, and a test that stops at 7 never sees it.
    for (const size of [8, 24, 48, CROWD_SIZE]) {
      const ids = agentIds(size);
      const slots = zoneSlots(CENTRE, ids);
      const offsets = ids.map((id) => {
        const offset = slots[id]?.offset;
        return `${offset?.gx},${offset?.gy}`;
      });
      expect(new Set(offsets).size).toBe(size);
    }
  });

  it('never puts an agent on the zone tile, which is where the building is', () => {
    const slots = zoneSlots(CENTRE, agentIds(CROWD_SIZE));

    for (const id of agentIds(CROWD_SIZE)) {
      expect(ringDistance(slots[id]?.position ?? CENTRE, CENTRE)).toBeGreaterThanOrEqual(1);
    }
  });

  it('fans outward rather than scattering', () => {
    // A fan is a crowd CLOSE to the zone. Distinct-but-far is the other way to
    // pass the distinctness check, and it puts an agent's tile outside the
    // building the zone names, which is a different bug wearing this one.
    const slots = zoneSlots(CENTRE, agentIds(CROWD_SIZE));
    const distances = agentIds(CROWD_SIZE).map((id) => ringDistance(slots[id]?.position ?? CENTRE, CENTRE));

    expect(Math.max(...distances)).toBeLessThanOrEqual(5);
    expect(new Set(distances).size).toBeGreaterThan(1);
  });

  it('gives the same agent the same tile for the same roster, every call', () => {
    const ids = agentIds(CROWD_SIZE);
    const first = zoneSlots(CENTRE, ids);
    const second = zoneSlots(CENTRE, ids);

    for (const id of ids) {
      expect(second[id]?.position).toEqual(first[id]?.position);
    }
  });

  it('does not depend on the order the roster arrives in', () => {
    // Arrival order is what the client happens to observe, and it is not what
    // the answer may be derived from: a delta that reorders the agent list would
    // otherwise shuffle the whole city on every frame.
    const ids = agentIds(CROWD_SIZE);
    const forward = zoneSlots(CENTRE, ids);
    const reversed = zoneSlots(CENTRE, [...ids].reverse());
    const shuffled = zoneSlots(CENTRE, [...ids].sort(() => Math.random() - 0.5));

    for (const id of ids) {
      expect(reversed[id]?.position).toEqual(forward[id]?.position);
      expect(shuffled[id]?.position).toEqual(forward[id]?.position);
    }
  });

  it('moves a departing agent inward but leaves nobody standing on the tile', () => {
    const ids = agentIds(8);
    const before = zoneSlots(CENTRE, ids);
    const after = zoneSlots(CENTRE, ids.slice(1));

    for (const id of ids.slice(1)) {
      expect(ringDistance(after[id]?.position ?? CENTRE, CENTRE)).toBeGreaterThanOrEqual(1);
    }
    // The change is real: recomputing a roster and ignoring it is the other
    // way to make this test green forever.
    expect(after[ids[1]!]?.position).not.toEqual(before[ids[1]!]?.position);
  });

  it('counts a repeated id once', () => {
    const slots = zoneSlots(CENTRE, ['a', 'a', 'b', 'a']);

    expect(Object.keys(slots)).toHaveLength(2);
    expect(slots.a?.occupancy).toBe(2);
  });

  it('places the same crowd at a different zone by moving the whole fan', () => {
    const ids = agentIds(12);
    const here = zoneSlots(CENTRE, ids);
    const there = zoneSlots(OTHER_CENTRE, ids);

    for (const id of ids) {
      // The offset is the zone-independent part, and that is what makes the
      // agent keep its place in the crowd when the crowd moves to a new tile.
      expect(there[id]?.offset).toEqual(here[id]?.offset);
      expect(there[id]?.position).toEqual({
        gx: OTHER_CENTRE.gx + (here[id]?.offset.gx ?? 0),
        gy: OTHER_CENTRE.gy + (here[id]?.offset.gy ?? 0),
      });
    }
  });

  it('reports occupancy as the whole crowd, the agent included', () => {
    const slots = zoneSlots(CENTRE, agentIds(5));

    for (const id of agentIds(5)) {
      expect(slots[id]?.occupancy).toBe(5);
    }
  });
});

describe('zoneSlot', () => {
  it('agrees with the batch answer for the same roster', () => {
    const ids = agentIds(20);
    const batch = zoneSlots(CENTRE, ids);

    for (const id of ids) {
      const one = zoneSlot(CENTRE, id, ids.filter((other) => other !== id));
      expect(one.position).toEqual(batch[id]?.position);
      expect(one.index).toBe(batch[id]?.index);
    }
  });

  it('treats an id already in the occupant list as not a second arrival', () => {
    const listed = zoneSlot(CENTRE, 'agent-0', ['agent-0', 'agent-1']);
    const once = zoneSlot(CENTRE, 'agent-0', ['agent-1']);

    expect(listed.position).toEqual(once.position);
    expect(listed.occupancy).toBe(2);
  });

  it('seats a lone agent in the innermost ring, not where the crowd left it', () => {
    // This is the price of deriving the fan from the roster, and it is pinned on
    // purpose: an agent that was fourth in a crowd of four comes back to the
    // first ring when the zone empties. A future change that "fixes" this by
    // persisting spots has to move this assertion rather than inherit it.
    const ids = agentIds(4);
    const crowd = zoneSlots(CENTRE, ids);
    const alone = zoneSlot(CENTRE, ids[2]!, []);

    expect(alone.index).toBe(0);
    expect(ringDistance(alone.position, CENTRE)).toBe(1);
    expect(alone.position).not.toEqual(crowd[ids[2]!]?.position);
  });

  it('puts a lone agent beside the zone, not on it', () => {
    const slot = zoneSlot(CENTRE, 'agent-0', []);

    expect(slot.occupancy).toBe(1);
    expect(slot.index).toBe(0);
    expect(slot.position).not.toEqual(CENTRE);
  });
});
