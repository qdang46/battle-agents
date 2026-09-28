/**
 * RTS control groups: the ten number keys, and what each one holds.
 *
 * Mirrored from arcane-agents `src/client/app/{types,utils}.ts` and
 * `src/client/hotkeys/registry.ts` (MIT, see THIRD-PARTY-NOTICES.md). The
 * reference keeps this logic in a React store and a hotkey registry, which is
 * why none of it can be asserted without a DOM. The rules are data, and data
 * is what this is: three operations over a map, with no renderer and no key
 * handler attached, so a wrong group can be shown as a wrong value.
 *
 * ## The rule the reference is actually built around
 *
 * An agent belongs to exactly one group. Assigning does not "add the selection
 * to group 3" — it *moves* the selection there and removes those agents from
 * every other group they were in. That is why assign and append cannot be one
 * function with a flag: append is the operation that deliberately breaks the
 * invariant (a raid drawn from three groups belongs to all three until the
 * player reassigns), and it is the only one allowed to.
 *
 * Recall filters by what is still on the board. The reference does the same
 * against its active-worker set, and drops a group whose members have all left
 * — reading a group of departed agents as an empty one is what makes the key
 * feel broken rather than stale.
 *
 * Assigning the selection to a group it already holds *exactly* clears that
 * group instead of rewriting it. The reference relies on this: it is how a
 * player un-assigns without a dedicated key, and it is carried over because
 * dropping it would leave groups no way out but reassignment.
 *
 * ## Why pure
 *
 * Every operation returns a new map rather than mutating, because the caller is
 * a frame loop's input path and a shared group map is read by the renderer on
 * the same tick. Copy-on-write means a half-finished assign can never be drawn.
 */

/** The digit a group is stored under, narrowed to what a single key can produce. */
export type ControlGroupKey = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * A key typed as a bare number is not a key. The reference re-checks this range
 * in four places because a parsed keyboard digit is a `number`; making it a
 * type means a group called 42 cannot be constructed at all.
 */
export function isControlGroupKey(value: number): value is ControlGroupKey {
  return Number.isInteger(value) && value >= 0 && value <= 9;
}

/** The keys in press order. Zero is last because it is typed as the tenth slot. */
export const CONTROL_GROUP_KEYS: readonly ControlGroupKey[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];

/** Group number to its members. Empty groups are absent rather than present-and-empty. */
export type ControlGroups = ReadonlyMap<ControlGroupKey, readonly string[]>;

function unique(agentIds: readonly string[]): string[] {
  return [...new Set(agentIds)];
}

function copyOf(groups: ControlGroups): Map<ControlGroupKey, readonly string[]> {
  return new Map(groups);
}

function sameMembers(groups: ControlGroups, key: ControlGroupKey, agentIds: readonly string[]): boolean {
  const members = groups.get(key) ?? [];
  return members.length === agentIds.length && agentIds.every((id) => members.includes(id));
}

/**
 * Assigns `agentIds` to `key`, taking them out of every other group.
 *
 * Assigning the group's exact current contents clears it, and assigning nothing
 * clears it too: a group with no members is not a group the player can recall.
 */
export function assignControlGroup(
  groups: ControlGroups,
  key: ControlGroupKey,
  agentIds: readonly string[],
): ControlGroups {
  const members = unique(agentIds);
  if (members.length === 0 || sameMembers(groups, key, members)) {
    const cleared = copyOf(groups);
    cleared.delete(key);
    return cleared;
  }

  const next = copyOf(groups);
  for (const [otherKey, otherMembers] of next) {
    if (otherKey === key) continue;
    const remaining = otherMembers.filter((id) => !members.includes(id));
    if (remaining.length === otherMembers.length) continue;
    if (remaining.length === 0) {
      next.delete(otherKey);
    } else {
      next.set(otherKey, remaining);
    }
  }
  next.set(key, members);
  return next;
}

/**
 * Returns the members of `key` that are still on the board, in group order.
 *
 * Grouped agents that have left are dropped here rather than at the group, so
 * every consumer — a recall, a badge, a count — gets the same answer.
 */
export function recallControlGroup(
  groups: ControlGroups,
  key: ControlGroupKey,
  liveAgentIds: ReadonlySet<string>,
): string[] {
  return (groups.get(key) ?? []).filter((id) => liveAgentIds.has(id));
}

/**
 * Adds `agentIds` to `key`, leaving every other group alone.
 *
 * Order is the group's own, then new arrivals, and an agent already in the
 * group is not repeated. The members stay in the groups they were already in:
 * that is the whole difference from `assignControlGroup`, and collapsing them
 * into one function would make that difference a flag nobody sets correctly.
 */
export function appendControlGroup(
  groups: ControlGroups,
  key: ControlGroupKey,
  agentIds: readonly string[],
): ControlGroups {
  const members = groups.get(key) ?? [];
  const additions = unique(agentIds).filter((id) => !members.includes(id));
  if (additions.length === 0) {
    return groups;
  }

  const next = copyOf(groups);
  next.set(key, [...members, ...additions]);
  return next;
}
