import { isBattleWeights, JUDGE_CRITERIA, whyWeightsAreRejected } from './domain.js';
import type { BattleWeights, JudgeCriterion, WeightsRejection } from './domain.js';

/**
 * Payload guards.
 *
 * Every action takes `unknown` and every one of them is narrowed here first, and
 * that is not defensive style. `act()` hands the payload through as a generic, so
 * a signature reading `input: CreateBattleInput` is an annotation the registry
 * never checks: `act('battle.create', {})` compiles clean and arrives as `{}`.
 * features/quest and features/bounty each had to be taught this separately.
 *
 * Separate from `domain.ts` for the reason features/bounty's is: `domain.ts` says
 * what a battle IS, this says what a caller may send. Merging them produced a
 * 500-line file in an earlier draft of the bounty feature and the guards were the
 * half nobody could find.
 */

/**
 * Every way this feature refuses a payload, or undefined when it accepts one.
 *
 * One union across the reading actions, because the reason exists to be written
 * into a sentence and a caller that wanted to know WHICH action it was had just
 * named it.
 */
export type BattleRejection =
  | { readonly reason: 'not-an-object' }
  | { readonly reason: 'battle-id-not-a-string' }
  | { readonly reason: 'battle-id-empty' }
  | { readonly reason: 'session-id-not-a-string' }
  | { readonly reason: 'session-id-empty' }
  | { readonly reason: 'agent-id-not-a-string' }
  | { readonly reason: 'agent-id-empty' }
  | { readonly reason: 'mode-not-a-string' }
  | { readonly reason: 'mode-empty' }
  | { readonly reason: 'bounty-id-not-a-string' }
  | { readonly reason: 'results-not-an-array' }
  | { readonly reason: 'results-empty' }
  | { readonly reason: 'result-not-an-object' }
  | { readonly reason: 'result-criteria-not-an-array' }
  | { readonly reason: 'result-criterion-unknown' }
  | { readonly reason: 'result-score-not-finite' }
  | { readonly reason: 'result-score-out-of-range' }
  | { readonly reason: 'result-duplicate-criterion' }
  | { readonly reason: 'submitted-at-not-an-instant' }
  | WeightsRejection;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** An ISO 8601 instant. `Date.parse` accepting a bare word is the risk this rejects. */
/**
 * An ISO 8601 instant that CARRIES ITS OFFSET, not merely one Date.parse can
 * chew.
 *
 * `Date.parse` is not this check. It accepts `'2026-01-01 00:00:00'`, reads it
 * as LOCAL time, and returns a number — so a submittedAt with no zone was being
 * written into the record a dispute is settled from, ambiguous to whoever reads
 * it on a machine in a different one.
 *
 * The protocol already decided this for the same reason and enforced it at the
 * wire: `agent-event.ts` says "Adapters in several languages emit local
 * timestamps without a zone designator. Those are ambiguous once the event
 * leaves the machine that wrote it, so the wire contract requires an explicit
 * offset and rejects them at the boundary." A scored battle is at least as
 * consequential as a tool event, and it was the one place the rule was not
 * applied.
 *
 * The trailing `Z` or `±HH:MM` is what makes it an instant rather than a local
 * time someone hopes is obvious.
 */
function isInstant(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  if (Number.isNaN(Date.parse(value))) return false;
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
}

/**
 * The two ways an id is missing, named rather than built from a template.
 *
 * A `` `${kind}-id-empty` `` literal typechecks fine as a value and then fails to
 * assign to the union, because TypeScript widens a template literal to `string`
 * and `string` is not one of the three reasons. Spelling the cases out is the
 * fix, and the compiler is what forced it: the reason a caller matches on is the
 * reason it has to be a closed set.
 */
function whyIdentifierIsMissing(
  value: unknown,
  kind: 'battle' | 'session' | 'agent',
): BattleRejection | undefined {
  if (typeof value !== 'string') {
    return kind === 'battle'
      ? { reason: 'battle-id-not-a-string' }
      : kind === 'session'
        ? { reason: 'session-id-not-a-string' }
        : { reason: 'agent-id-not-a-string' };
  }
  if (value.length === 0) {
    return kind === 'battle'
      ? { reason: 'battle-id-empty' }
      : kind === 'session'
        ? { reason: 'session-id-empty' }
        : { reason: 'agent-id-empty' };
  }
  return undefined;
}

/* ───────────────────────────── create ───────────────────────────── */

/**
 * A create that has been proven creatable.
 *
 * Flat, and every field checked by `whyCreateBattleIsRejected`, because a type
 * that describes a shape the guard never proved is how the first read after the
 * guard throws on `undefined`.
 */
export interface CreateBattleInput {
  /**
   * The session that is fighting. Required even though `create` also names a
   * creator inside the repository: making the caller repeat it would be two
   * sources for one fact, and a caller that disagreed with itself would create a
   * battle its own second argument contradicts.
   */
  readonly sessionId: string;
  readonly mode?: string;
  readonly bountyId?: string;
  readonly weights?: BattleWeights;
}

export const CREATE_BATTLE_SHAPE =
  'A create takes a sessionId, which must be a non-empty string, and optionally a mode, a bountyId and a weights object whose five criteria sum to one.';

export function whyCreateBattleIsRejected(input: unknown): BattleRejection | undefined {
  const draft = asObject(input);
  if (draft === undefined) {
    return { reason: 'not-an-object' };
  }
  const session = whyIdentifierIsMissing(draft['sessionId'], 'session');
  if (session !== undefined) {
    return session;
  }
  if (draft['mode'] !== undefined && typeof draft['mode'] !== 'string') {
    return { reason: 'mode-not-a-string' };
  }
  if (typeof draft['mode'] === 'string' && draft['mode'].trim() === '') {
    return { reason: 'mode-empty' };
  }
  if (draft['bountyId'] !== undefined && !isNonEmptyString(draft['bountyId'])) {
    return { reason: 'bounty-id-not-a-string' };
  }
  if (draft['weights'] !== undefined) {
    return whyWeightsAreRejected(draft['weights']);
  }
  return undefined;
}

export function isCreateBattleInput(input: unknown): input is CreateBattleInput {
  return whyCreateBattleIsRejected(input) === undefined;
}

/* ───────────────────────────── join ───────────────────────────── */

export interface JoinBattleInput {
  readonly battleId: string;
  readonly sessionId: string;
}

export const JOIN_BATTLE_SHAPE =
  'A join takes a battleId and a sessionId, each of which must be a non-empty string. A session, never an agent: one agent can be in two battles through two sessions, and a join that named an agent could not tell them apart.';

export function whyJoinBattleIsRejected(input: unknown): BattleRejection | undefined {
  const draft = asObject(input);
  if (draft === undefined) {
    return { reason: 'not-an-object' };
  }
  return (
    whyIdentifierIsMissing(draft['battleId'], 'battle') ??
    whyIdentifierIsMissing(draft['sessionId'], 'session')
  );
}

export function isJoinBattleInput(input: unknown): input is JoinBattleInput {
  return whyJoinBattleIsRejected(input) === undefined;
}

/* ───────────────────────────── finish ───────────────────────────── */

/** One participant's judgement, as a caller reports it. */
export interface BattleResultInput {
  readonly sessionId: string;
  /** One entry per criterion the rubric names. A criterion with no entry scores nothing. */
  readonly criteria: readonly { readonly criterion: JudgeCriterion; readonly score: number }[];
  /** When this participant's submission was accepted. The speed tiebreak reads it. */
  readonly submittedAt: string;
}

export interface FinishBattleInput {
  readonly battleId: string;
  readonly results: readonly BattleResultInput[];
}

export const FINISH_BATTLE_SHAPE =
  'A finish takes a battleId and a non-empty results array. Each result names a sessionId, an ISO 8601 submittedAt, and one entry per criterion in correctness, tests, regression, quality and efficiency, each scored 0..1.';

/**
 * One reported judgement, after the shape checks, in the judge's own types.
 *
 * A separate function from the guard because the guard answers "may this be
 * acted on" and this one hands back something with no `unknown` left in it. The
 * cast lives here, once, next to the checks that justify it — rather than in the
 * handler, where a reviewer has to walk back up to find out whether it was earned.
 */
export function finishResultsOf(input: unknown): readonly BattleResultInput[] {
  const draft = asObject(input);
  if (draft === undefined) {
    return [];
  }
  const results = draft['results'];
  if (!Array.isArray(results)) {
    return [];
  }
  return results.filter(isBattleResultInput);
}

function isBattleResultInput(value: unknown): value is BattleResultInput {
  const draft = asObject(value);
  if (draft === undefined) {
    return false;
  }
  return whyBattleResultIsRejected(draft) === undefined;
}

export function whyBattleResultIsRejected(input: unknown): BattleRejection | undefined {
  const draft = asObject(input);
  if (draft === undefined) {
    return { reason: 'result-not-an-object' };
  }
  const session = whyIdentifierIsMissing(draft['sessionId'], 'session');
  if (session !== undefined) {
    return session;
  }
  if (!isInstant(draft['submittedAt'])) {
    return { reason: 'submitted-at-not-an-instant' };
  }
  const criteria = draft['criteria'];
  if (!Array.isArray(criteria)) {
    // Its OWN reason, and not the general `not-an-object`. That one describes
    // the RESULT not being an object, and a caller who sent the criteria as a
    // keyed object instead of a list was told the entry itself was malformed --
    // which is not the thing they got wrong, and reads as a bug in their result
    // rather than as a shape they had not read. Found by calling the real
    // endpoint with `score: {...}`, which is the natural guess, and being told
    // `not-an-object` by a route that otherwise names every field precisely.
    return { reason: 'result-criteria-not-an-array' };
  }
  const seen = new Set<string>();
  for (const entry of criteria) {
    const criterion = asObject(entry);
    if (criterion === undefined) {
      return { reason: 'result-not-an-object' };
    }
    const name = criterion['criterion'];
    if (typeof name !== 'string' || !(JUDGE_CRITERIA as readonly string[]).includes(name)) {
      return { reason: 'result-criterion-unknown' };
    }
    if (seen.has(name)) {
      return { reason: 'result-duplicate-criterion' };
    }
    seen.add(name);
    const score = criterion['score'];
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      return { reason: 'result-score-not-finite' };
    }
    if (score < 0 || score > 1) {
      return { reason: 'result-score-out-of-range' };
    }
  }
  return undefined;
}

export function whyFinishBattleIsRejected(input: unknown): BattleRejection | undefined {
  const draft = asObject(input);
  if (draft === undefined) {
    return { reason: 'not-an-object' };
  }
  const battle = whyIdentifierIsMissing(draft['battleId'], 'battle');
  if (battle !== undefined) {
    return battle;
  }
  const results = draft['results'];
  if (!Array.isArray(results)) {
    return { reason: 'results-not-an-array' };
  }
  if (results.length === 0) {
    return { reason: 'results-empty' };
  }
  for (const result of results) {
    const rejection = whyBattleResultIsRejected(result);
    if (rejection !== undefined) {
      return rejection;
    }
  }
  return undefined;
}

export function isFinishBattleInput(input: unknown): input is FinishBattleInput {
  return whyFinishBattleIsRejected(input) === undefined;
}

/* ───────────────────────────── read ───────────────────────────── */

export interface BattleRefInput {
  readonly battleId: string;
}

/**
 * The public read shape, and the one a logged-out spectator uses.
 *
 * A battleId and nothing else. No agentId, no sessionId, no credential — and
 * that is the whole assertion behind the fairness property in section 17.4: if
 * the rubric were behind any of those, a rubric published after the verdict would
 * be the only kind anybody could ever read.
 */
export const READ_BATTLE_SHAPE =
  'A read takes a battleId, which must be a non-empty string, and nothing else. The rubric a battle is judged by is public before it is judged, so the read asks for no identity.';

export function whyBattleRefIsRejected(input: unknown): BattleRejection | undefined {
  const draft = asObject(input);
  if (draft === undefined) {
    return { reason: 'not-an-object' };
  }
  return whyIdentifierIsMissing(draft['battleId'], 'battle');
}

export function isBattleRefInput(input: unknown): input is BattleRefInput {
  return whyBattleRefIsRejected(input) === undefined;
}

export const LIST_BATTLES_SHAPE =
  'A list takes no payload: an empty object. It reads the battles that are open to be joined, each with its rubric.';

/* ───────────────────────────── the error a refusal becomes ───────────────────────────── */

/**
 * Built from the verdict, never from the payload: the caller guaranteed to be
 * handed the answer is the one that must not be reading the input back.
 */
export function battleInputRejected(
  action: string,
  rejection: BattleRejection,
  expected: string,
): Error {
  return Object.assign(new Error(`${action} rejected: ${rejection.reason}. ${expected}`), {
    code: 'malformed-input',
  });
}

/** Re-exported so a caller validating a rubric reads the same answer this file does. */
export { isBattleWeights };
