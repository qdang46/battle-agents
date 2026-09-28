import { describe, expect, it } from 'vitest';

import { type AgentActivity, LINES_BY_ACTIVITY, pickLine } from './dialogue.js';

/**
 * The two properties ambient dialogue is only allowed to have.
 *
 * Both are invisible in a screenshot, which is why the reference could ship a
 * per-frame `Math.random()` and look fine: every single line it drew was a real
 * line from a real bank. The defect is in the sequence, so the assertions below
 * are about repetition and about change rather than about any one string.
 */

const ACTIVITIES: readonly AgentActivity[] = ['working', 'idle', 'walking'];

/** Shape of a real `agents.id`, because the hash is only exercised by real ids. */
const AGENT_IDS: readonly string[] = Array.from(
  { length: 64 },
  (_unused, i) => `a${(0x9e3779b1 * (i + 1)) % 0xffffffff}`,
);

describe('dialogue', () => {
  it('gives one agent the same line every time it is asked', () => {
    for (const agentId of AGENT_IDS) {
      for (const activity of ACTIVITIES) {
        const first = pickLine(agentId, activity);
        for (let repeat = 0; repeat < 5; repeat += 1) {
          expect(pickLine(agentId, activity)).toBe(first);
        }
      }
    }
  });

  it('keeps the banks disjoint, which is what makes a state change visible', () => {
    const seen = new Map<string, AgentActivity>();
    for (const activity of ACTIVITIES) {
      for (const line of LINES_BY_ACTIVITY[activity]) {
        const owner = seen.get(line);
        // Two banks sharing a line fail silently: the character appears to stop
        // talking whenever it passes through that one state, and no assertion
        // about `pickLine` output would ever notice.
        expect(owner, `"${line}" is in both the ${owner} and ${activity} banks`).toBe(undefined);
        seen.set(line, activity);
      }
    }
    expect(seen.size).toBe(
      ACTIVITIES.reduce((total, activity) => total + LINES_BY_ACTIVITY[activity].length, 0),
    );
  });

  it('says something different once the state changes', () => {
    for (const agentId of AGENT_IDS) {
      const lines = ACTIVITIES.map((activity) => pickLine(agentId, activity));
      expect(lines[0]).not.toBe(lines[1]);
      expect(lines[1]).not.toBe(lines[2]);
      expect(lines[0]).not.toBe(lines[2]);
    }
  });

  it('does not depend on the order the lines were asked for', () => {
    // A picker holding a cursor, or a memo that advances, passes both tests
    // above on the first agent and then gives every later agent a different
    // answer. Asking twice in opposite orders is what separates them.
    const forwards = AGENT_IDS.map((agentId) => pickLine(agentId, 'working'));
    const backwards = [...AGENT_IDS].reverse().map((agentId) => pickLine(agentId, 'working'));
    expect(backwards.reverse()).toEqual(forwards);
  });

  it('spreads a crowd across a bank rather than always speaking first', () => {
    for (const activity of ACTIVITIES) {
      const said = new Set(AGENT_IDS.map((agentId) => pickLine(agentId, activity)));
      // One line for every agent is a `bank[0]`, which satisfies determinism
      // and every assertion above while being the opposite of the point.
      expect(said.size).toBeGreaterThan(2);
      for (const line of said) {
        expect(LINES_BY_ACTIVITY[activity]).toContain(line);
      }
    }
  });

  it('treats an activity outside the union as idle instead of throwing', () => {
    // A caller holding a `ZoneId` holds strings like 'files' and 'terminal'.
    // The type says this cannot arrive; the frame loop is the wrong place to
    // find out.
    const zone = 'terminal' as AgentActivity;
    expect(pickLine(AGENT_IDS[0]!, zone)).toBe(pickLine(AGENT_IDS[0]!, 'idle'));
  });
});
