/**
 * Progression rules, as data.
 *
 * Everything tunable lives here rather than inside a handler, because the numbers
 * will be wrong and tuning them should not mean reading a reducer. The handlers
 * apply what this file decides and nothing else.
 *
 * Nothing here does I/O, which is what makes the interesting claims testable:
 * that experience comes from outcomes and not from token counts, and that two
 * behaviour histories produce two different builds.
 */

/* ───────────────────────────── outcomes ───────────────────────────── */

/**
 * The only events that mean anything to progression.
 *
 * A closed union on purpose. Experience is awarded by looking an event type up
 * in this table and nowhere else, so an event that is not listed cannot pay — a
 * `tokens.spent` event arriving on the bus is simply not an outcome. That is the
 * whole defence against a token economy, and it is structural: there is no code
 * path from a token count to experience, because there is no token count in this
 * file and the table does no arithmetic on anything but literal amounts.
 *
 * A token economy would reward spending tokens to earn experience for spending
 * tokens. It is the one design in this plan that would make the product worse
 * the more people used it.
 *
 * The name is not always the whole condition — `battle.finished` pays only when
 * the payload says the battle was won — so a lookup that finds a row is not yet
 * an award. `qualifies` is what turns the row into a decision.
 */
export const OUTCOME_TYPES = [
  'bounty.completed',
  'pr.merged',
  'test.passed',
  'session.recovered',
  'battle.finished',
  // The quest feature's own header says "The XP a quest is worth is read by
  // progression from `quest.completed`", and it emits that event with
  // `xpReward` in the payload. There was no entry here, so `outcomeFor` returned
  // undefined, `awardFor` returned, and a completed quest paid NOTHING while
  // the submit response handed the caller its xpReward as though it had been
  // earned. Found by claiming and submitting a real quest over HTTP and reading
  // the agent's experience afterwards: 0.
  //
  // Its table xp is a FALLBACK. A quest names its own reward, and the reward
  // varies with difficulty, so a fixed number would make `xpReward` decorative
  // in the other direction. `xpRewardFromEvent` prefers the payload.
  'quest.completed',
] as const;

export type OutcomeType = (typeof OUTCOME_TYPES)[number];

/**
 * A condition the event's payload must satisfy before the row pays.
 *
 * A field name and the one value that satisfies it, rather than a predicate
 * function. `progression.awards` spreads a row into its reply, so a function
 * here would travel with it and cross the wire as a value nothing can call.
 */
export interface OutcomeCondition {
  readonly field: string;
  readonly equals: boolean;
}

/**
 * One outcome, described once.
 *
 * Experience and behaviour sit in the same row on purpose. Every award is also
 * evidence of what the character is becoming, and splitting the two into
 * separate tables is how they drift — a new award added to one and not the
 * other pays experience that teaches nothing, which is how a progression system
 * ends up with a leaderboard nobody understands.
 *
 * `weight` is separate from `xp` on purpose. Experience is the reward and is
 * tuned for pacing; weight is evidence, and a big payout is not automatically
 * strong evidence. A bounty is worth a thousand experience and counts once
 * towards being a builder, because completing one is a statement about scope
 * rather than about volume.
 */
export interface Outcome {
  readonly xp: number;
  readonly build: Exclude<Build, 'generalist'>;
  readonly weight: number;
  /**
   * Which skill this outcome is evidence of, and the only thing that ever moves
   * one. Absent when the outcome trains none of the eight, which `battle.finished`
   * is: a win is the plan's reward for a match, and it is not evidence that the
   * agent is better at any of the disciplines.
   *
   * Here, beside the price, rather than in the reducer, because the two are one
   * decision: an outcome that pays experience without saying what it teaches
   * moves the character's level and none of its skills. `skillsEvidencedByOutcomes`
   * is asserted by a test, so the set changes when a row is added and the failure
   * is somebody having to say which discipline the new thing trains — or to say
   * out loud that it trains none, which `battle.finished` does.
   */
  readonly skill?: Skill;
  /**
   * What the payload has to carry for this row to pay, when the event name
   * alone does not decide it. `battle.finished` arrives for a loss as well as a
   * win, and an award table keyed only on the event name would hand a defeated
   * agent the same five hundred experience as a victorious one.
   *
   * It is also how one fact is priced once rather than twice. `pr.merged` and
   * `bounty.completed` are two names for a merge that finished a bounty, and
   * which of them pays is stated HERE, in the price table, rather than left to
   * whichever feature emits the events to remember not to emit both. The
   * condition is written so that a payload which never says which case it is
   * does not pay at all: silence about money is the wrong default in both
   * directions.
   */
  readonly requires?: OutcomeCondition;
}

export const OUTCOMES: Readonly<Record<OutcomeType, Outcome>> = {
  // A bounty is the whole job: the issue was opened, the work was done, the
  // change shipped. That is the definition of having practised coding.
  'bounty.completed': { xp: 1000, build: 'builder', weight: 1, skill: 'coding' },
  // Five hundred is the plan's price for a merged pull request, and it is
  // payable only for a merge that completed no bounty. A merge that did complete
  // one is already paid a thousand by the row above, and the same pull request
  // paying 1500 is the failure this condition exists to make impossible — not
  // 50% more expensive than the plan's own number for the larger award, but a
  // leaderboard that looks briefly generous for a reason nobody can find.
  //
  // The gate is fail-closed on purpose: a `pr.merged` whose payload omits
  // `completedBounty` has not made the statement, and pays nothing. Whoever
  // emits it has to say which case it is.
  //
  // The skill is collaboration rather than a second bite at coding, and the two
  // never pay for the same merge anyway. A pull request is the moment somebody
  // else read the work and accepted it, which is the part of shipping that is
  // not coding.
  'quest.completed': { xp: 250, build: 'builder', weight: 1, skill: 'coding' },
  'pr.merged': {
    xp: 500,
    build: 'refactorer',
    weight: 1,
    skill: 'collaboration',
    requires: { field: 'completedBounty', equals: false },
  },
  'test.passed': { xp: 100, build: 'tester', weight: 1, skill: 'testing' },
  'session.recovered': { xp: 150, build: 'debugger', weight: 1, skill: 'debugging' },
  'battle.finished': {
    xp: 500,
    build: 'infrastructure',
    weight: 1,
    requires: { field: 'won', equals: true },
  },
};

/**
 * Whether an outcome's row applies to the payload that arrived.
 *
 * False rather than an error, and checked before anything is written, so a
 * defeat pays nothing AND leaves no behaviour signal. The second half is the
 * one that matters: the table has no entry saying a lost battle is evidence of
 * anything, and recording one anyway would make losing fights a route to an
 * infrastructure build that winning them is supposed to be.
 *
 * An outcome with no condition always applies, which is what makes the field
 * optional.
 */
export function qualifies(outcome: Outcome, payload: unknown): boolean {
  const condition = outcome.requires;
  if (condition === undefined) {
    return true;
  }
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  return (payload as { [key: string]: unknown })[condition.field] === condition.equals;
}

/** What an outcome is worth, or undefined when the event is not one. */
export function outcomeFor(eventType: string): Outcome | undefined {
  return isOutcomeType(eventType) ? OUTCOMES[eventType] : undefined;
}

export function isOutcomeType(eventType: string): eventType is OutcomeType {
  return (OUTCOME_TYPES as readonly string[]).includes(eventType);
}

/* ───────────────────────────── levels ───────────────────────────── */

/**
 * The cost of advancing OUT of a level, which is what section 24's formula
 * computes: 100 * n * (n+1) / 2.
 *
 * It is the cost of leaving level n, not the total to reach it, and the
 * distinction is the difference between starting at level 1 for free and
 * starting at level 1 after 100 experience. Reading it as a running total makes
 * a brand-new character level 0, which is not a state this game has.
 */
export function xpToAdvanceFrom(level: number): number {
  if (level < 1) {
    throw new RangeError(`level must be at least 1, got ${level}`);
  }
  return (100 * level * (level + 1)) / 2;
}

/**
 * Total experience to reach a level from scratch.
 *
 * The sum of every step before it, so each level costs more than the last:
 * 100 to reach 2, 300 more to reach 3, 600 more to reach 4. A flat cost per
 * level would make high levels a formality.
 */
export function totalXpToReach(level: number): number {
  if (level < 1) {
    throw new RangeError(`level must be at least 1, got ${level}`);
  }
  let total = 0;
  for (let step = 1; step < level; step += 1) {
    total += xpToAdvanceFrom(step);
  }
  return total;
}

/** The level every character starts at, and the lowest a gate may ask about. */
export const MIN_LEVEL = 1;

/** The level a given amount of experience has earned. Never below 1. */
export function levelForXp(xp: number): number {
  if (xp < 0) {
    throw new RangeError(`experience cannot be negative, got ${xp}`);
  }
  let level = 1;
  while (totalXpToReach(level + 1) <= xp) {
    level += 1;
  }
  return level;
}

export interface LevelGate {
  readonly level: number;
  readonly unlocks: string;
}

/**
 * What each level unlocks.
 *
 * Section 10.2 takes this from EVE Online: level is access, not cosmetics.
 * Every entry is content or capability a character may now reach, never a
 * number that only looks like progress. A cosmetic-only gate is a gate nobody
 * feels, and a gate nobody feels is not a gate.
 */
export const LEVEL_GATES: readonly LevelGate[] = [
  { level: 5, unlocks: 'advanced bounties' },
  { level: 10, unlocks: 'the arena' },
  { level: 15, unlocks: 'team bounties' },
  { level: 20, unlocks: 'guild creation' },
  { level: 30, unlocks: 'sponsoring' },
];

/**
 * Whether a level clears a gate.
 *
 * A plain comparison, deliberately. A level nobody has reached is not met, and
 * inventing a rule that opens unknown gates would mean content appears for
 * everybody the moment it ships, which is the opposite of a gate.
 */
export function meetsGate(level: number, requiredLevel: number): boolean {
  return level >= requiredLevel;
}

/* ───────────────────────────── skills ───────────────────────────── */

/**
 * The eight disciplines a character practises independently.
 *
 * Section 10.2 names them and calls this model the best fit of the four it
 * weighed: independent skills, each with its own level, and NO single power
 * scalar. That last clause is the load-bearing one. A design with a power score
 * has exactly one answer to "who is stronger", and from the moment that number
 * exists every other system quietly becomes a function of it — matchmaking, tier
 * access, rewards, the lot. The alternative this model takes is a character that
 * is good at four things and hopeless at the rest, where a matchup is decided by
 * which of those the two sides brought.
 *
 * The names are the plan's, not mine, and they are deliberately NOT the BUILDS.
 * A build is a specialisation a classifier infers from a whole history; a skill
 * is something that happened, once. `builder` and `coding` are different claims,
 * and collapsing them rebuilds the single scalar the plan forbids: one number
 * that says both what a character is and what it can do.
 */
export const SKILLS = [
  'coding',
  'debugging',
  'testing',
  'research',
  'refactoring',
  'security',
  'documentation',
  'collaboration',
] as const;

export type Skill = (typeof SKILLS)[number];

/**
 * Experience in each skill. A count per skill, never a level.
 *
 * A skill level is `levelForXp(skills[skill])` and is deliberately not stored.
 * The curve is data in this file, and a stored level is a second copy of it that
 * a retune leaves behind: the character keeps a level the rules no longer
 * produce and nothing in the tree can say so. The character's own level is the
 * opposite case and is stored twice, on `agents`, so a leaderboard can sort
 * without reading a history — that duplication has an owner and a comment.
 */
export type Skills = Readonly<Record<Skill, number>>;

/** Every skill at zero: what a character has before it has done anything. */
export const EMPTY_SKILLS: Skills = Object.freeze(
  Object.fromEntries(SKILLS.map((skill) => [skill, 0])) as Record<Skill, number>,
);

export interface SkillProgress {
  readonly skill: Skill;
  readonly xp: number;
  readonly level: number;
}

/**
 * Every skill with the level its own experience has earned.
 *
 * All eight, always, in the plan's order rather than in the order they happen to
 * have amounts, so a character sheet does not reshuffle as it grows. A skill at
 * zero is present and reads as level 1: the plan's "specialization without
 * maxing everything" is only visible if the untrained skills are on the sheet.
 *
 * There is deliberately no total, no average and no power figure. Returning
 * eight numbers and letting a caller combine them is what keeps the decision
 * about what a strong character is out of the rules and in the game that asks
 * the question.
 */
export function describeSkills(skills: Skills): readonly SkillProgress[] {
  return SKILLS.map((skill) => {
    const xp = skills[skill] ?? 0;
    return { skill, xp, level: levelForXp(xp) };
  });
}

/**
 * What one outcome does to a skill map.
 *
 * Pure, and the only path by which a skill ever moves. The identity of the
 * skill is a field on the price row, so retuning which discipline an outcome
 * trains is a change to the table beside it and never to this function.
 *
 * An outcome with no skill returns the map it was given, by reference. Copying
 * it would imply the caller had to be careful about aliasing a value nothing
 * mutates.
 */
export function awardSkill(before: Skills, outcome: Outcome): Skills {
  if (outcome.skill === undefined) {
    return before;
  }
  // Seeded from EMPTY_SKILLS so a map that arrives with a key missing — a record
  // written before a skill was added to this list — comes back complete rather
  // than staying short one field forever.
  const next: Record<Skill, number> = { ...EMPTY_SKILLS };
  for (const skill of SKILLS) {
    next[skill] = (before[skill] ?? 0) + (skill === outcome.skill ? outcome.xp : 0);
  }
  return next;
}

/**
 * The skills the current outcome set can actually move.
 *
 * Four of the eight, and that is a fact about the outcomes rather than about the
 * skills. `research`, `refactoring`, `security` and `documentation` have no
 * outcome that is evidence of them yet, because no event says they happened.
 * Inventing an award to fill the gap would be the opposite: a skill that levels
 * for something nobody did.
 *
 * The test that pins this set is the one that makes adding an outcome a decision.
 * A sixth outcome lands, the set changes, and the test fails until somebody
 * says which discipline it trains.
 */
export function skillsEvidencedByOutcomes(): readonly Skill[] {
  const seen = new Set<Skill>();
  for (const outcomeType of OUTCOME_TYPES) {
    const skill = OUTCOMES[outcomeType].skill;
    if (skill !== undefined) {
      seen.add(skill);
    }
  }
  return SKILLS.filter((skill) => seen.has(skill));
}

/* ───────────────────── behaviour to build ───────────────────── */

/**
 * What a character can specialise in.
 *
 * These are behaviours, not job titles. "Debugger" is something an agent did
 * enough of; there is no model named Debugger and there never will be, because
 * section 10.2 is explicit that a model is not a class. The same Claude is a
 * debugger in one project and a builder in another.
 */
export const BUILDS = [
  'debugger',
  'researcher',
  'builder',
  'tester',
  'refactorer',
  'security',
  'infrastructure',
  'generalist',
] as const;

export type Build = (typeof BUILDS)[number];

/** The build a character starts with, before any evidence says otherwise. */
export const DEFAULT_BUILD: Build = 'generalist';

export type Specialist = Exclude<Build, 'generalist'>;

/** One observed behaviour, already interpreted by whoever saw it. */
export interface BehaviourSignal {
  readonly build: Specialist;
  readonly weight: number;
  readonly at: string;
}

/**
 * How strongly each behaviour counts.
 *
 * Weights rather than a raw count because "recovered 40 test failures" and
 * "skimmed 200 files" are not the same evidence, and counting them equally
 * would make a character that read a lot look like one that thought a lot.
 *
 * Configurable because this is the piece most likely to need iteration, and a
 * classifier nobody can retune is a classifier nobody will try to improve.
 */
export type BuildWeights = Readonly<Record<Build, number>>;

export const DEFAULT_BUILD_WEIGHTS: BuildWeights = Object.freeze(
  Object.fromEntries(BUILDS.map((build) => [build, 1])) as Record<Build, number>,
);

/**
 * The build a behaviour history adds up to.
 *
 * Generalist unless the evidence is one-sided. A tie is not a specialisation:
 * a character that recovered exactly as many failures as it merged pull
 * requests has not chosen anything, and naming it a debugger because "debugger"
 * happens to sort first would be a label it did not earn. It also makes the
 * result independent of event order, which a "first one wins" tie-break does
 * not — and a character that changes specialisation when two events arrive in a
 * different order is a visible, unexplained bug.
 */
export function classifyBuild(
  history: readonly BehaviourSignal[],
  weights: BuildWeights = DEFAULT_BUILD_WEIGHTS,
): Build {
  const scores = BUILDS.map((build) => ({ build, score: scoreOf(build, history, weights) }));
  const best = Math.max(...scores.map((entry) => entry.score));
  if (best === 0) {
    return DEFAULT_BUILD;
  }
  const leaders = scores.filter((entry) => entry.score === best);
  return leaders.length === 1 ? (leaders[0]?.build ?? DEFAULT_BUILD) : DEFAULT_BUILD;
}

/**
 * A trace of a classification.
 *
 * Returned rather than only logged, because the bead asks for a surprising
 * result to be debuggable rather than mysterious, and a feature that can only
 * explain itself through a logger is one whose explanations vanish in tests.
 */
export interface BuildClassification {
  readonly build: Build;
  readonly scores: Readonly<Record<Build, number>>;
  readonly considered: number;
}

export function explainBuild(
  history: readonly BehaviourSignal[],
  weights: BuildWeights = DEFAULT_BUILD_WEIGHTS,
): BuildClassification {
  const scores = Object.fromEntries(
    BUILDS.map((build) => [build, scoreOf(build, history, weights)]),
  ) as Record<Build, number>;
  return { build: classifyBuild(history, weights), scores, considered: history.length };
}

function scoreOf(build: Build, history: readonly BehaviourSignal[], weights: BuildWeights): number {
  if (build === DEFAULT_BUILD) {
    return 0;
  }
  return history
    .filter((signal) => signal.build === build)
    .reduce((total, signal) => total + signal.weight * weights[build], 0);
}
