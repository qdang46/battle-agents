import { defineAction } from '@battle-agents/core';
import type { EventHandler, GameEvent, GameFeature, RuntimeContext } from '@battle-agents/core';

import {
  AGENT_LEVEL_UP,
  isProgressionAwardsInput,
  isProgressionGateInput,
  isProgressionReadInput,
  PROGRESSION_AWARDS_SHAPE,
  PROGRESSION_GATE_SHAPE,
  PROGRESSION_READ_SHAPE,
  progressionInputRejected,
  whyProgressionAwardsIsRejected,
  whyProgressionGateIsRejected,
  whyProgressionReadIsRejected,
  type AgentLevelUpPayload,
  type AgentProgress,
} from './domain.js';
import type { ProgressionRepository } from './repository.js';
import {
  awardSkill,
  classifyBuild,
  DEFAULT_BUILD,
  DEFAULT_BUILD_WEIGHTS,
  describeSkills,
  EMPTY_SKILLS,
  explainBuild,
  LEVEL_GATES,
  levelForXp,
  meetsGate,
  outcomeFor,
  OUTCOME_TYPES,
  qualifies,
  type BehaviourSignal,
  type BuildWeights,
  type Outcome,
  type SkillProgress,
} from './rules.js';

export const PROGRESSION_READ = 'progression.read';
export const PROGRESSION_AWARDS = 'progression.awards';
export const PROGRESSION_GATE = 'progression.gate';
export const PROGRESSION_TIERS = 'progression.tiers';

export interface ProgressionSummary {
  readonly agentId: string;
  readonly xp: number;
  readonly level: number;
  readonly build: string;
  /**
   * All eight skills, each with its own level. There is no combined figure
   * anywhere in this reply, and adding one would be the plan's forbidden single
   * power scalar arriving through the read path.
   */
  readonly skills: readonly SkillProgress[];
  readonly classification: ReturnType<typeof explainBuild>;
  /**
   * False when the character has no progress record at all.
   *
   * The read answers rather than throwing, because a caller asking about a new
   * agent needs an answer and an exception is not one. This is the flag that
   * keeps "has done nothing" and "nobody has heard of" apart: a character at
   * level 1 with zero experience may be a week-old veteran of nothing, and
   * rendering them identically is how a missing record comes to look like a
   * new player.
   */
  readonly exists: boolean;
}

/** What a caller asking "may this character have this?" is told. */
export interface GateDecision {
  readonly agentId: string;
  readonly requiredLevel: number;
  readonly allowed: boolean;
  readonly level: number;
  /** What the level being asked about unlocks, or null when nothing does. */
  readonly unlocks: string | null;
}

/** The ladder, so a client can render the gates without hardcoding them. */
export interface LevelGateView {
  readonly level: number;
  readonly unlocks: string;
}

export interface ProgressionDependencies {
  readonly repository: ProgressionRepository;
  /** Exposed so the classifier can be retuned without editing the feature. */
  readonly weights?: BuildWeights;
}

/**
 * Progression: experience, levels, and what a character is becoming.
 *
 * There is no command here for granting experience, and that is the design
 * rather than an omission. A command would be a door, and anything with a door
 * can be pushed through by a caller that finds it. Experience arrives because
 * something real happened — a bounty completed, a test passed, a battle won —
 * and this feature is the only thing that decides what that is worth.
 *
 * That is also why every other feature is a peer here: progression reacts to
 * their events rather than being wired to them, so any feature can be added or
 * removed without editing this file.
 */
export function progressionFeature(dependencies: ProgressionDependencies): GameFeature {
  const { repository } = dependencies;
  const weights = dependencies.weights ?? DEFAULT_BUILD_WEIGHTS;

  /**
   * One handler per outcome type, because the runtime dispatches by exact event
   * name and has no wildcard. Registering them from the same table the awards
   * come from is what keeps the two in step: an outcome nobody listens to
   * cannot pay, and a listener for an outcome that cannot pay is dead code.
   */
  const handlers: EventHandler[] = OUTCOME_TYPES.map((outcomeType) => ({
    on: outcomeType,
    handle: (event: GameEvent, context: RuntimeContext) => awardFor(event, context),
  }));

  async function awardFor(event: GameEvent, context: RuntimeContext): Promise<void> {
    const outcome = outcomeFor(event.type);
    if (outcome === undefined) {
      return;
    }
    // The event name finds the row; the payload decides whether the row applies.
    // A battle that was lost is dropped whole — no experience and no history
    // entry — because the award table has nothing to say a defeat is evidence
    // of, and a signal written anyway would let an agent collect the build by
    // losing.
    if (!qualifies(outcome, event.payload)) {
      return;
    }
    const agentId = agentIdOf(event);
    if (agentId === undefined) {
      return;
    }

    const before = await repository.ensure({ agentId }, context.now());
    // A quest names its own reward and the table's number is only its default.
    // Reading the payload is what makes `xpReward` mean anything: difficulty
    // varies per quest, so a fixed entry would make the published field
    // decorative in the OTHER direction -- every quest paying the same amount
    // while the API reported a different one.
    const paid: Outcome = { ...outcome, ...xpRewardFromEvent(event) };
    const after = apply(before, paid, context.now(), weights);
    if (after.xp === before.xp && after.level === before.level) {
      return;
    }
    await repository.save(after);

    if (after.level > before.level) {
      // `emit`, not `bus.publish`. The event is declared in `persistedEvents`
      // below, and the two are not interchangeable: `emit` appends to the state
      // store before it publishes, and `bus.publish` skips straight to the bus.
      // So the level-up was in the durability list and absent from the log — a
      // row the store promised to keep and nothing had written. The reason to
      // reach for the bus directly was to avoid re-entering the dispatcher, and
      // it costs nothing: `agent.level_up` is not an entry in this feature's own
      // outcome table, so nothing here handles it.
      await context.runtime.emit({
        type: AGENT_LEVEL_UP,
        occurredAt: context.now(),
        actorId: after.agentId,
        ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
        payload: {
          agentId: after.agentId,
          level: after.level,
          previousLevel: before.level,
          xp: after.xp,
        } satisfies AgentLevelUpPayload,
      });
    }
  }

  return {
    id: 'progression',
    eventHandlers: handlers,
    persistedEvents: [AGENT_LEVEL_UP],
    capabilities: [
      { name: PROGRESSION_READ, description: "Read a character's experience, level and build." },
      { name: PROGRESSION_AWARDS, description: 'Ask what an outcome is worth before it happens.' },
      { name: PROGRESSION_GATE, description: 'Ask whether a character has reached a level.' },
      { name: PROGRESSION_TIERS, description: 'List the levels and what each one unlocks.' },
    ],
    actionDefs: [
      // Every `run` that reads its payload takes `unknown` and is guarded. The
      // annotation these used to carry was never checked: `act()` hands the
      // payload through as a generic, so `act('progression.read', {})` compiled
      // clean and queried `agentId = undefined`. `progression.tiers` is the one
      // action with no payload, and it has nothing to guard.
      defineAction({
        id: PROGRESSION_READ,
        permissions: [PROGRESSION_READ],
        run: async (input: unknown) => {
          if (!isProgressionReadInput(input)) {
            throw progressionInputRejected(
              PROGRESSION_READ,
              whyProgressionReadIsRejected(input) ?? { reason: 'not-an-object' },
              PROGRESSION_READ_SHAPE,
            );
          }
          return summarize(repository, input.agentId, weights);
        },
      }),
      defineAction({
        id: PROGRESSION_AWARDS,
        permissions: [PROGRESSION_AWARDS],
        run: async (input: unknown) => {
          if (!isProgressionAwardsInput(input)) {
            throw progressionInputRejected(
              PROGRESSION_AWARDS,
              whyProgressionAwardsIsRejected(input) ?? { reason: 'not-an-object' },
              PROGRESSION_AWARDS_SHAPE,
            );
          }
          const outcome = outcomeFor(input.eventType);
          return outcome === undefined
            ? { eventType: input.eventType, xp: 0, recognised: false }
            : { eventType: input.eventType, ...outcome, recognised: true };
        },
      }),
      defineAction({
        id: PROGRESSION_GATE,
        permissions: [PROGRESSION_GATE],
        run: async (input: unknown) => {
          if (!isProgressionGateInput(input)) {
            throw progressionInputRejected(
              PROGRESSION_GATE,
              whyProgressionGateIsRejected(input) ?? { reason: 'not-an-object' },
              PROGRESSION_GATE_SHAPE,
            );
          }
          return decideGate(repository, input.agentId, input.requiredLevel);
        },
      }),
      defineAction({
        id: PROGRESSION_TIERS,
        permissions: [PROGRESSION_TIERS],
        run: async () => LEVEL_GATES.map<LevelGateView>((gate) => ({ ...gate })),
      }),
    ],
  };
}

/**
 * Whether a character has reached a level.
 *
 * Answers for an agent with no record rather than refusing, because a decision a
 * caller has to catch an exception to make is a decision that fails open — every
 * defensive caller turns the error into "allow". A character nobody has heard of
 * is level 1, and the only question here is whether level 1 is enough.
 */
async function decideGate(
  repository: ProgressionRepository,
  agentId: string,
  requiredLevel: number,
): Promise<GateDecision> {
  const progress = await repository.find(agentId);
  const level = progress?.level ?? levelForXp(0);
  const gate = LEVEL_GATES.find((entry) => entry.level === requiredLevel);
  return {
    agentId,
    requiredLevel,
    allowed: meetsGate(level, requiredLevel),
    level,
    unlocks: gate?.unlocks ?? null,
  };
}

/**
 * The character sheet, which answers for a character who has not earned anything.
 *
 * A gate and a read get the same answer about a missing record, and the
 * difference is the `exists` flag rather than an exception. This reverses a
 * contract this feature used to hold: it threw `no-such-progress`, which meant
 * the one caller it was built for — a gate about a brand-new agent — had to
 * catch an error before it could let anybody play. Reputation already answers the
 * same question the same way, and two features disagreeing about what an unknown
 * character is is how a gate ends up open in one place and shut in another.
 *
 * The distinction the throw existed to protect is not lost. It moved into the
 * reply, where a client can render "never seen" differently from "level 1",
 * which is more use to it than a rejected call was.
 */
async function summarize(
  repository: ProgressionRepository,
  agentId: string,
  weights: BuildWeights,
): Promise<ProgressionSummary> {
  const progress = await repository.find(agentId);
  if (progress === undefined) {
    return {
      agentId,
      xp: 0,
      level: levelForXp(0),
      build: DEFAULT_BUILD,
      skills: describeSkills(EMPTY_SKILLS),
      classification: explainBuild([], weights),
      exists: false,
    };
  }
  return {
    agentId: progress.agentId,
    xp: progress.xp,
    level: progress.level,
    build: progress.build,
    skills: describeSkills(progress.skills ?? EMPTY_SKILLS),
    classification: explainBuild(progress.history, weights),
    exists: true,
  };
}

/**
 * Applies one outcome, recomputing everything that follows from it.
 *
 * Pure, so the rule that a level is a function of experience rather than a
 * counter somebody increments is testable without a store. The build is
 * recomputed from the whole history on every award rather than adjusted, so a
 * mis-awarded outcome self-corrects instead of leaving a permanently wrong
 * specialisation behind. Skills move by the same rule: one award moves one
 * skill, and everything else is recomputed from the whole map.
 *
 * The weights belong on this signature and not only on the read path. A build
 * stored under one set of weights and reported under another is a record that
 * disagrees with itself, and a retune that only reaches `explainBuild` changes
 * what the feature SAYS about a character without changing what it BELIEVES.
 */
/**
 * The reward an event names for itself, when it names one.
 *
 * Only a finite, non-negative number is honoured, so a quest that published a
 * string, a negative, or nothing at all falls back to the table rather than
 * writing a nonsensical award. The payload is another feature's, so it is
 * untrusted by construction.
 */
export function xpRewardFromEvent(event: GameEvent): { readonly xp?: number } {
  if (event.type !== 'quest.completed') return {};
  const value = (event.payload as { readonly xpReward?: unknown }).xpReward;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return {};
  return { xp: value };
}

export function apply(
  before: AgentProgress,
  outcome: Outcome,
  now: string,
  weights: BuildWeights = DEFAULT_BUILD_WEIGHTS,
): AgentProgress {
  const history: BehaviourSignal[] = [
    ...before.history,
    { build: outcome.build, weight: outcome.weight, at: now },
  ];
  const xp = before.xp + outcome.xp;
  return {
    ...before,
    xp,
    level: levelForXp(xp),
    build: classifyBuild(history, weights),
    // Seeded from EMPTY_SKILLS rather than from `before.skills` alone so a
    // record written before the skills model landed still comes out complete.
    skills: awardSkill(before.skills ?? EMPTY_SKILLS, outcome),
    history,
    updatedAt: now,
  };
}

/** The agent an event is about, if it names one. */
/**
 * Whose run this was.
 *
 * TWO SHAPES EXIST AND ONLY ONE NAMES AN AGENT IN ITS PAYLOAD.
 *
 * An event emitted INSIDE the runtime — bounty.completed, pr.merged — names the
 * agent in `payload.agentId` and puts a FEATURE's name on `actorId` ('bounty',
 * 'system'). That is the shape the tests here model, and it is the right one:
 * the feature that emitted an event is its actor.
 *
 * An event that arrived over `/api/events` is different. `toGameEvent` in
 * apps/web/src/event-routes.ts makes the whole validated AgentEvent the payload
 * and puts the SESSION'S AGENT on the envelope's `actorId`. That payload has no
 * `agentId` at all, which is why the previous version of this function — payload
 * only — made every reward from a real harness UNREACHABLE. `test.passed` paid
 * 100 XP nothing could claim, `session.recovered` had no producer, and a crash
 * paid a badge and zero experience: §10.2's death rule with the experience
 * quietly removed.
 *
 * So the envelope is a fallback, taken only when the payload has the shape of
 * the thing ingest produces. `sessionId` is the discriminator, not the NAME on
 * the envelope: an in-runtime event's actorId is a feature or 'system', and
 * crediting experience to a domain is worse than paying nothing. Reading the
 * envelope unconditionally is what an earlier attempt at this did, and the
 * "names no agent" test caught it.
 */
function agentIdOf(event: GameEvent): string | undefined {
  const payload = event.payload;
  if (typeof payload === 'object' && payload !== null) {
    const fields = payload as { readonly agentId?: unknown; readonly sessionId?: unknown };
    if (typeof fields.agentId === 'string' && fields.agentId.length > 0) {
      return fields.agentId;
    }
    // Ingest shape: the payload IS the agent's own AgentEvent, which always
    // carries a sessionId, and the envelope's actorId is that session's agent.
    if (typeof fields.sessionId === 'string' && fields.sessionId.length > 0) {
      const onEnvelope = event.actorId;
      if (typeof onEnvelope === 'string' && onEnvelope.length > 0) {
        return onEnvelope;
      }
    }
  }
  return undefined;
}

