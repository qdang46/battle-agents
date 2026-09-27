import { describe, expect, it } from 'vitest';

import { isFinishBattleInput, whyFinishBattleIsRejected } from './input.js';

/**
 * The finish validator, which had none.
 *
 * `whyFinishBattleIsRejected` is exported from the barrel and is what every
 * caller is told when a finish is refused, and nothing tested it. Found by
 * calling the real endpoint three wrong ways in a row and being told `not-an-object`
 * twice, for two entirely different mistakes.
 *
 * The shape it wants is a LIST of `{criterion, score}` entries rather than a
 * keyed object of scores. That is not a preference, and the reason codes are
 * how a caller discovers it, so the codes have to name the thing that is
 * actually wrong.
 */

const AT = '2026-01-01T00:00:00.000Z';
const FIVE = [
  { criterion: 'correctness', score: 0.9 },
  { criterion: 'tests', score: 0.8 },
  { criterion: 'regression', score: 0.7 },
  { criterion: 'quality', score: 0.6 },
  { criterion: 'efficiency', score: 0.5 },
];

function aFinish(results: unknown[]): unknown {
  return { battleId: 'battle-1', results };
}

describe('whyFinishBattleIsRejected', () => {
  it('accepts a well-formed finish', () => {
    const input = aFinish([{ sessionId: 's1', submittedAt: AT, criteria: FIVE }]);

    expect(whyFinishBattleIsRejected(input)).toBeUndefined();
    expect(isFinishBattleInput(input)).toBe(true);
  });

  it('says the criteria must be a LIST, not the result for being an object', () => {
    // The one that cost a real debugging session. `score: {...}` is the natural
    // guess, and the general `not-an-object` names the RESULT as malformed --
    // which it is not, and which reads as a bug in the entry rather than a
    // shape the caller had not read.
    const rejection = whyFinishBattleIsRejected(
      aFinish([{ sessionId: 's1', submittedAt: AT, score: { tests: 0.9 } }]),
    );

    expect(rejection).toEqual({ reason: 'result-criteria-not-an-array' });
  });

  it('still reports a result that is not an object as exactly that', () => {
    // The two are different mistakes and must not share a code, which is the
    // whole point of the case above existing.
    expect(whyFinishBattleIsRejected(aFinish(['nope']))).toEqual({
      reason: 'result-not-an-object',
    });
  });

  it('names a criterion it does not publish', () => {
    const rejection = whyFinishBattleIsRejected(
      aFinish([{ sessionId: 's1', submittedAt: AT, criteria: [{ criterion: 'vibes', score: 1 }] }]),
    );

    expect(rejection).toEqual({ reason: 'result-criterion-unknown' });
  });

  it('rejects a score outside 0..1 rather than clamping it', () => {
    const high = whyFinishBattleIsRejected(
      aFinish([{ sessionId: 's1', submittedAt: AT, criteria: [{ criterion: 'tests', score: 1.5 }] }]),
    );
    const negative = whyFinishBattleIsRejected(
      aFinish([{ sessionId: 's1', submittedAt: AT, criteria: [{ criterion: 'tests', score: -0.1 }] }]),
    );

    expect(high).toEqual({ reason: 'result-score-out-of-range' });
    expect(negative).toEqual({ reason: 'result-score-out-of-range' });
  });

  it('rejects a duplicated criterion rather than counting it twice', () => {
    // A rubric where one criterion silently counted double is a score nobody can
    // audit, and the weights published beside it would not match.
    const rejection = whyFinishBattleIsRejected(
      aFinish([
        {
          sessionId: 's1',
          submittedAt: AT,
          criteria: [
            { criterion: 'tests', score: 0.9 },
            { criterion: 'tests', score: 0.1 },
          ],
        },
      ]),
    );

    expect(rejection).toEqual({ reason: 'result-duplicate-criterion' });
  });

  it('rejects an empty results array, and a missing one', () => {
    expect(whyFinishBattleIsRejected(aFinish([]))).toEqual({ reason: 'results-empty' });
    expect(whyFinishBattleIsRejected({ battleId: 'battle-1', results: 'nope' })).toEqual({
      reason: 'results-not-an-array',
    });
  });

  it('rejects a submittedAt that is not an instant with a zone', () => {
    // The same rule the event schema applies: a local timestamp is ambiguous
    // once the record leaves the machine that wrote it.
    const rejection = whyFinishBattleIsRejected(
      aFinish([{ sessionId: 's1', submittedAt: '2026-01-01 00:00:00', criteria: FIVE }]),
    );

    expect(rejection).toEqual({ reason: 'submitted-at-not-an-instant' });
  });

  it('keeps the guard and the reason in step, because one is defined as the other', () => {
    // `isFinishBattleInput` is literally `whyFinishBattleIsRejected(x) === undefined`.
    // A case where they disagree would mean the guard accepts an input the
    // caller is told is broken, or refuses one with no explanation.
    for (const input of [
      aFinish([{ sessionId: 's1', submittedAt: AT, criteria: FIVE }]),
      aFinish([]),
      aFinish(['nope']),
      aFinish([{ sessionId: 's1', submittedAt: AT, score: {} }]),
      'not an object',
    ]) {
      expect(isFinishBattleInput(input)).toBe(whyFinishBattleIsRejected(input) === undefined);
    }
  });
});
