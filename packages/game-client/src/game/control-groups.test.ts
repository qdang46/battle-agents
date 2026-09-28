import { describe, expect, it } from 'vitest';

import {
  appendControlGroup,
  assignControlGroup,
  CONTROL_GROUP_KEYS,
  type ControlGroupKey,
  type ControlGroups,
  isControlGroupKey,
  recallControlGroup,
} from './control-groups.js';

/**
 * Control groups, as values.
 *
 * The reference keeps these rules in a hotkey registry reading a React store,
 * so upstream they are only reachable through a rendered app. A wrong group
 * there is a sprite with the wrong number on it, which a screenshot cannot
 * distinguish from a correct one — and the reference's own copy is the
 * authority for what "wrong" means, so the port is what has to be checked.
 *
 * The three operations are asserted separately because they disagree with each
 * other on purpose. Assign moves an agent out of its other groups; append
 * leaves it in them. A single shared helper with a flag would pass a test that
 * only ever exercised one of them, so the last case in this file runs all three
 * over identical input and demands three different answers.
 */

const ALIVE = new Set(['a1', 'a2', 'a3', 'b1']);

function groups(...entries: [ControlGroupKey, string[]][]): ControlGroups {
  return new Map(entries);
}

describe('control group keys', () => {
  it('accepts the ten digits a number row can produce and nothing else', () => {
    expect(CONTROL_GROUP_KEYS).toHaveLength(10);
    for (const key of CONTROL_GROUP_KEYS) {
      expect(isControlGroupKey(key)).toBe(true);
    }
    for (const notAKey of [-1, 10, 1.5, Number.NaN]) {
      expect(isControlGroupKey(notAKey)).toBe(false);
    }
  });
});

describe('assigning a control group', () => {
  it('replaces the contents of the key it is assigned to', () => {
    const before = groups([1, ['a1', 'a2']]);
    const after = assignControlGroup(before, 1, ['b1', 'a3']);

    expect(after.get(1)).toEqual(['b1', 'a3']);
    expect(before.get(1)).toEqual(['a1', 'a2']);
  });

  it('takes the assigned agents out of the other groups, deleting any it empties', () => {
    const before = groups([1, ['a1', 'a2']], [4, ['a2', 'b1']]);
    const after = assignControlGroup(before, 1, ['a2', 'a3']);

    expect(after.get(1)).toEqual(['a2', 'a3']);
    expect(after.get(4)).toEqual(['b1']);
    expect(after.has(2)).toBe(false);
  });

  it('clears the group when the selection is already exactly its contents', () => {
    // The only way a player un-assigns; there is no separate key for it.
    const after = assignControlGroup(groups([2, ['a1', 'a3']]), 2, ['a3', 'a1']);

    expect(after.has(2)).toBe(false);
  });

  it('clears the group when nothing is selected', () => {
    const after = assignControlGroup(groups([2, ['a1']]), 2, []);

    expect(after.has(2)).toBe(false);
  });

  it('leaves the other groups alone when the assignment does not reach them', () => {
    const before = groups([1, ['a1']], [2, ['b1']]);
    const after = assignControlGroup(before, 1, ['a1', 'a2']);

    expect(after.get(2)).toEqual(['b1']);
  });
});

describe('recalling a control group', () => {
  it('returns its members in group order', () => {
    const before = groups([3, ['a3', 'a1']]);
    expect(recallControlGroup(before, 3, ALIVE)).toEqual(['a3', 'a1']);
  });

  it('drops members that are no longer on the board', () => {
    const before = groups([3, ['a1', 'gone', 'a2']]);
    expect(recallControlGroup(before, 3, ALIVE)).toEqual(['a1', 'a2']);
  });

  it('reads an unassigned key as an empty group rather than as a missing one', () => {
    expect(recallControlGroup(groups([3, ['a1']]), 7, ALIVE)).toEqual([]);
  });
});

describe('appending to a control group', () => {
  it('adds after the existing members and repeats nothing', () => {
    const before = groups([1, ['a1', 'a2']]);
    const after = appendControlGroup(before, 1, ['a2', 'a3', 'a3']);

    expect(after.get(1)).toEqual(['a1', 'a2', 'a3']);
  });

  it('creates the group when the key is unused', () => {
    const after = appendControlGroup(new Map(), 6, ['b1']);
    expect(after.get(6)).toEqual(['b1']);
  });

  it('leaves the agents in the groups they were already in', () => {
    // The one place append and assign must disagree. A raid drawn from three
    // groups belongs to all three until the player reassigns.
    const before = groups([1, ['a1']], [4, ['a2']]);
    const after = appendControlGroup(before, 7, ['a1', 'a2']);

    expect(after.get(7)).toEqual(['a1', 'a2']);
    expect(after.get(1)).toEqual(['a1']);
    expect(after.get(4)).toEqual(['a2']);
  });

  it('is a no-op when every id is already in the group', () => {
    const before = groups([1, ['a1']]);
    expect(appendControlGroup(before, 1, ['a1'])).toBe(before);
  });
});

describe('the three operations are not one operation', () => {
  it('answers differently for the same agents and the same key', () => {
    const start = groups([1, ['a1']], [4, ['a1', 'a2']]);

    const assigned = assignControlGroup(start, 7, ['a1', 'a2']);
    const appended = appendControlGroup(start, 7, ['a1', 'a2']);
    const recalled = recallControlGroup(start, 7, ALIVE);

    // Assign moved a1 and a2 out of 4; append created 7 and left 4 intact.
    expect(assigned.get(4)).toBeUndefined();
    expect(appended.get(4)).toEqual(['a1', 'a2']);
    // Recall of a key nobody assigned to is empty, not a guess at the selection.
    expect(recalled).toEqual([]);
    // And none of the three touched the map it was handed.
    expect(start.get(1)).toEqual(['a1']);
    expect(start.get(4)).toEqual(['a1', 'a2']);
  });
});
