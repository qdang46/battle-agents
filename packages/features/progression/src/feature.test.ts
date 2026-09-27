import { createInMemoryEventBus, createRuntime, InMemoryStateStore } from '@battle-agents/core';
import type { GameEvent, Runtime } from '@battle-agents/core';
import { describe, expect, it } from 'vitest';

import {
  AGENT_LEVEL_UP,
  isProgressionAwardsInput,
  isProgressionGateInput,
  isProgressionReadInput,
  whyProgressionAwardsIsRejected,
  whyProgressionGateIsRejected,
  whyProgressionReadIsRejected,
  type AgentProgress,
} from './domain.js';
import type { ProgressionRepository } from './repository.js';
import { apply, progressionFeature, xpRewardFromEvent, type GateDecision, type LevelGateView } from './feature.js';
import {
  DEFAULT_BUILD,
  DEFAULT_BUILD_WEIGHTS,
  EMPTY_SKILLS,
  LEVEL_GATES,
  meetsGate,
  OUTCOMES,
  SKILLS,
  totalXpToReach,
  type BuildWeights,
} from './rules.js';

const NOW = '2026-09-24T12:00:00.000Z';
const AGENT = 'agent-1';
const SESSION = 'session-1';

/** A store held in memory, so the handler path is tested without a database. */
class InMemoryProgressionRepository implements ProgressionRepository {
  readonly rows = new Map<string, AgentProgress>();
  saves = 0;
  /**
   * Counts the reads, so a test can assert a malformed call was refused BEFORE
   * the store was asked. Nothing about an empty map would show that: a lookup
   * for `undefined` misses and returns nothing.
   */
  reads = 0;

  async find(agentId: string): Promise<AgentProgress | undefined> {
    this.reads += 1;
    return this.rows.get(agentId);
  }

  async ensure(progress: { agentId: string }, now: string): Promise<AgentProgress> {
    const existing = this.rows.get(progress.agentId);
    if (existing !== undefined) {
      return existing;
    }
    const created: AgentProgress = {
      agentId: progress.agentId,
      xp: 0,
      level: 1,
      build: DEFAULT_BUILD,
      skills: EMPTY_SKILLS,
      history: [],
      updatedAt: now,
    };
    this.rows.set(progress.agentId, created);
    return created;
  }

  async save(progress: AgentProgress): Promise<void> {
    this.saves += 1;
    this.rows.set(progress.agentId, progress);
  }
}

function harness(weights?: BuildWeights): {
  runtime: Runtime;
  repository: InMemoryProgressionRepository;
  seen: GameEvent[];
} {
  const repository = new InMemoryProgressionRepository();
  const bus = createInMemoryEventBus();
  const seen: GameEvent[] = [];
  bus.subscribe((event) => seen.push(event));
  const runtime = createRuntime({
    extensions: [
      progressionFeature(weights === undefined ? { repository } : { repository, weights }),
    ],
    store: new InMemoryStateStore(),
    bus,
    now: () => NOW,
  });
  return { runtime, repository, seen };
}

function outcomeEvent(
  type: string,
  agentId: string | null = AGENT,
  extra: Record<string, unknown> = {},
): GameEvent {
  return {
    type,
    occurredAt: NOW,
    actorId: 'system',
    payload: agentId === null ? { ...extra } : { agentId, ...extra },
  };
}

/**
 * An event as `toGameEvent` in `apps/web/src/event-routes.ts` really builds it
 * from a harness batch: the WHOLE AgentEvent becomes the payload, and the
 * session's agent goes on the envelope.
 *
 * Deliberately not a second spelling of `outcomeEvent`. This is the other
 * producer, and the two differ in the field the award depends on — see the test
 * that uses it. A helper that quietly filled in `agentId` would make the
 * distinction invisible, which is the distinction the test exists to make.
 */
function ingestedEvent(type: string, extra: Record<string, unknown> = {}): GameEvent {
  return {
    type,
    occurredAt: NOW,
    actorId: AGENT,
    payload: { type, sessionId: SESSION, at: NOW, ...extra },
  };
}

describe('experience arrives because something happened', () => {
  it('awards for a bounty completion and records it', async () => {
    const { runtime, repository } = harness();

    await runtime.emit(outcomeEvent('bounty.completed'));

    expect(repository.rows.get(AGENT)?.xp).toBe(OUTCOMES['bounty.completed'].xp);
  });

  it('ignores an event that is not an outcome', async () => {
    const { runtime, repository } = harness();

    for (const transient of ['file.write', 'thinking', 'session.heartbeat', 'tool.completed']) {
      await runtime.emit(outcomeEvent(transient));
    }

    // Nothing created either: an event with no agentId on it, or with one, is
    // not a reason to conjure a progress record.
    expect(repository.rows.size).toBe(0);
  });

  it('ignores an outcome that names no agent', async () => {
    const { runtime, repository } = harness();

    await runtime.emit(outcomeEvent('bounty.completed', null));

    expect(repository.rows.size).toBe(0);
  });

  it('pays a harness event, whose payload names a session and never an agent', async () => {
    // Every other test in this file builds its event with a payload carrying
    // `agentId`, and that is the shape a FEATURE emits. A harness does not send
    // it: `testPassedEventSchema` is `baseEvent('test.passed')` — `type`,
    // `sessionId`, `at` — so the agent is nowhere in the payload, and
    // `toGameEvent` puts it on the envelope's `actorId` instead.
    //
    // So `agentIdOf` has a second branch, reading the agent off the envelope
    // when the payload names a session, and that branch had no test at all. It
    // could have been deleted and every other test here would still pass, while
    // a real agent stopped being paid for passing its tests — a hundred XP, on
    // the one outcome in this file a working harness produces routinely.
    const { runtime, repository } = harness();

    await runtime.emit(ingestedEvent('test.passed', { suite: 'unit', count: 42 }));

    // Credited to the agent, not to the session: the row is keyed on the agent
    // and the level is what the rest of the game reads.
    expect(repository.rows.get(AGENT)?.xp).toBe(OUTCOMES['test.passed'].xp);
    expect(repository.rows.has(SESSION), 'the session was credited as if it were an agent').toBe(
      false,
    );
  });

  it('accumulates across many outcomes', async () => {
    const { runtime, repository } = harness();

    await runtime.emit(outcomeEvent('test.passed'));
    await runtime.emit(outcomeEvent('test.passed'));
    // The merge award only pays for a merge that completed no bounty, so the
    // payload has to say so. See the `pr.merged` row in rules.ts.
    await runtime.emit(outcomeEvent('pr.merged', AGENT, { completedBounty: false }));

    expect(repository.rows.get(AGENT)?.xp).toBe(100 + 100 + 500);
  });

  it('does not pay a merge twice for a bounty, whichever of the two events fires', async () => {
    // The bounty feature emits BOTH `bounty.completed` and `pr.merged` for a
    // merge that completed a bounty — the first is the award, the second is the
    // fact — and the price of the second is zero in that case. So the order does
    // not matter, a re-delivery does not matter, and the only thing that changes
    // the total is which of the two carries `completedBounty: true`.
    const { runtime, repository } = harness();

    await runtime.emit(outcomeEvent('bounty.completed'));
    await runtime.emit(outcomeEvent('pr.merged', AGENT, { completedBounty: true }));
    await runtime.emit(outcomeEvent('pr.merged', AGENT, { completedBounty: true }));

    expect(repository.rows.get(AGENT)?.xp).toBe(OUTCOMES['bounty.completed'].xp);
    expect(repository.rows.get(AGENT)?.xp).not.toBe(1500);
  });

  it('pays a merge that names no case at all nothing, because it said nothing', async () => {
    // Fail-closed on purpose. A `pr.merged` whose payload omits the field has
    // not stated which of the two cases it is, and an award that guesses is an
    // award nobody can audit. See the `pr.merged` row in rules.ts.
    const { runtime, repository } = harness();

    await runtime.emit(outcomeEvent('pr.merged'));

    expect(repository.rows.size).toBe(0);
  });

  it('emits agent.level_up when a level is crossed, and not on every award', async () => {
    const { runtime, seen } = harness();

    await runtime.emit(outcomeEvent('bounty.completed'));
    await runtime.emit(outcomeEvent('test.passed'));

    const levelUps = seen.filter((event) => event.type === AGENT_LEVEL_UP);
    expect(levelUps).toHaveLength(1);
    // A bounty is worth a thousand, which carries a character from level 1 to 4
    // in one award. One event, saying where it ended up, rather than three
    // pretending it arrived one level at a time.
    expect(levelUps[0]?.payload).toMatchObject({ agentId: AGENT, level: 4, previousLevel: 1 });
  });
});

describe('a failed run still teaches', () => {
  it('grants experience for a recovery and keeps the character', async () => {
    // Section 10.2's death rule: HP 0 never kills the character. A run that
    // failed and was recovered is experience, and the character is untouched.
    const { runtime, repository } = harness();

    await runtime.emit(outcomeEvent('session.recovered'));

    const progress = repository.rows.get(AGENT);
    expect(progress?.xp).toBe(150);
    expect(progress?.build).toBe('debugger');
  });

  it('never deletes or zeroes a record, whatever arrives', async () => {
    const { runtime, repository } = harness();
    await runtime.emit(outcomeEvent('bounty.completed'));
    const before = repository.rows.get(AGENT);

    for (const type of ['session.recovered', 'test.passed']) {
      await runtime.emit(outcomeEvent(type));
    }

    const after = repository.rows.get(AGENT);
    expect(repository.rows.size).toBe(1);
    expect(after?.xp).toBeGreaterThan(before?.xp ?? 0);
    expect(after?.agentId).toBe(AGENT);
  });
});

describe('a battle pays for winning, not for happening', () => {
  it('pays the win bonus when the payload says the battle was won', async () => {
    const { runtime, repository } = harness();

    await runtime.emit(outcomeEvent('battle.finished', AGENT, { won: true }));

    const progress = repository.rows.get(AGENT);
    expect(progress?.xp).toBe(OUTCOMES['battle.finished'].xp);
    expect(progress?.build).toBe('infrastructure');
  });

  it('pays nothing for a loss, and leaves the character where it was', async () => {
    // The trap in the rename: awardFor used to look at event.type alone, so
    // subscribing to battle.finished as it is named in the plan would have
    // handed a defeated agent the same five hundred as a victorious one.
    const { runtime, repository } = harness();
    await runtime.emit(outcomeEvent('test.passed'));
    const before = repository.rows.get(AGENT);

    await runtime.emit(outcomeEvent('battle.finished', AGENT, { won: false }));

    const after = repository.rows.get(AGENT);
    expect(after?.xp).toBe(before?.xp);
    expect(after?.history).toHaveLength(before?.history.length ?? 0);
    // And the loss is not evidence for anything: an infrastructure build from
    // a defeat is a character the classifier was never told about.
    expect(after?.build).toBe('tester');
  });

  it('pays nothing for a battle whose result nobody recorded', async () => {
    const { runtime, repository } = harness();

    await runtime.emit(outcomeEvent('battle.finished'));

    expect(repository.rows.size).toBe(0);
  });

  it('no longer pays an event called battle.won', async () => {
    // The name the plan does not use. If it ever pays again, two spellings of
    // one event are live and only the one a real emitter sends can work.
    const { runtime, repository } = harness();

    await runtime.emit(outcomeEvent('battle.won'));

    expect(repository.rows.size).toBe(0);
  });
});

describe('the same model, two histories', () => {
  it('specialises two characters differently from behaviour alone', async () => {
    const { runtime, repository } = harness();

    for (let index = 0; index < 4; index += 1) {
      await runtime.emit(outcomeEvent('session.recovered', 'the-debugger'));
      await runtime.emit(outcomeEvent('bounty.completed', 'the-builder'));
    }

    // Nothing above names a model, and nothing above could: the feature is
    // never told one. The two characters are the same model by construction,
    // because the only thing that differs is what they did.
    expect(repository.rows.get('the-debugger')?.build).toBe('debugger');
    expect(repository.rows.get('the-builder')?.build).toBe('builder');
  });
});

describe('reading progress', () => {
  it('reports experience, level, build and all eight skills', async () => {
    const { runtime } = harness();
    await runtime.emit(outcomeEvent('bounty.completed'));

    const summary = await runtime.runAction<
      { agentId: string },
      {
        xp: number;
        level: number;
        build: string;
        exists: boolean;
        skills: readonly { skill: string; xp: number; level: number }[];
      }
    >('progression.read', { agentId: AGENT });

    expect(summary).toMatchObject({ xp: 1000, level: 4, build: 'builder', exists: true });
    // All eight, always. A skill at zero has to be on the sheet, because the
    // plan's "specialisation without maxing everything" is only visible if the
    // untrained ones are next to the trained one.
    expect(summary.skills.map((entry) => entry.skill)).toEqual([...SKILLS]);
    expect(summary.skills.find((entry) => entry.skill === 'coding')).toEqual({
      skill: 'coding',
      xp: 1000,
      level: 4,
    });
  });

  it('answers for a character nobody has heard of rather than refusing', async () => {
    const { runtime } = harness();

    const summary = await runtime.runAction<
      { agentId: string },
      {
        agentId: string;
        xp: number;
        level: number;
        build: string;
        exists: boolean;
        skills: readonly { skill: string; xp: number; level: number }[];
      }
    >('progression.read', { agentId: 'never-seen' });

    // The read used to throw `no-such-progress`, which made the one caller it
    // was built for — a character sheet for a new agent — handle an exception
    // before it could draw anything. The distinction the throw protected is not
    // lost: `exists` carries it, in the reply, where a client can use it.
    expect(summary).toMatchObject({ agentId: 'never-seen', exists: false, xp: 0, level: 1 });
    // Level 1 and not level 0, and all eight skills reported at zero rather than
    // absent. `levelForXp(0)` is where the number comes from, so a retune of the
    // ladder cannot leave an unearned character on a level that does not exist.
    expect(summary.level).toBe(1);
    expect(summary.skills).toHaveLength(SKILLS.length);
    expect(summary.skills.every((entry) => entry.xp === 0 && entry.level === 1)).toBe(true);
  });

  it('distinguishes a character that has done nothing from one nobody has heard of', async () => {
    const { runtime, repository } = harness();
    // Seeded rather than produced by an event. Every path that creates a record
    // also writes an award to it, so an empty one only exists in the store — and
    // the read has to tell the two apart anyway, which is the whole reason the
    // old throw existed.
    repository.rows.set(AGENT, {
      agentId: AGENT,
      xp: 0,
      level: 1,
      build: DEFAULT_BUILD,
      skills: EMPTY_SKILLS,
      history: [],
      updatedAt: NOW,
    });

    const summary = await runtime.runAction<
      { agentId: string },
      { xp: number; level: number; exists: boolean }
    >('progression.read', { agentId: AGENT });

    // Same numbers as the unknown character above, and a different answer,
    // because the flag is the only thing that carries the distinction now.
    expect(summary).toMatchObject({ exists: true, xp: 0, level: 1 });
  });

  it('answers what an outcome is worth before it happens', async () => {
    const { runtime } = harness();

    await expect(
      runtime.runAction<{ eventType: string }, { xp: number; recognised: boolean }>(
        'progression.awards',
        { eventType: 'bounty.completed' },
      ),
    ).resolves.toMatchObject({ xp: 1000, recognised: true });

    await expect(
      runtime.runAction<{ eventType: string }, { xp: number; recognised: boolean }>(
        'progression.awards',
        { eventType: 'tokens.spent' },
      ),
    ).resolves.toMatchObject({ xp: 0, recognised: false });
  });

  it('reports the condition a battle has to meet, so a caller can predict it', async () => {
    const { runtime } = harness();

    // The row is spread into the reply, so a predicate function in the table
    // would cross the wire as a value nothing can call. What comes back is
    // data: the field, and the one value that satisfies it.
    await expect(
      runtime.runAction<{ eventType: string }, { requires?: { field: string; equals: boolean } }>(
        'progression.awards',
        { eventType: 'battle.finished' },
      ),
    ).resolves.toMatchObject({ requires: { field: 'won', equals: true } });
  });
});

describe('a payload nobody checked', () => {
  // These three actions read their payload off an annotation. `act()` takes its
  // input as a generic, so `act('progression.read', {})` compiled clean and went
  // to the store asking for `agentId = undefined`; `act('progression.gate', {})`
  // asked the same question about everybody. The suite had no malformed case at
  // all, which is why a guard that cannot fail looked like a working one.
  it('refuses a read that names no character, before the store is asked', async () => {
    const { runtime, repository } = harness();
    await runtime.emit(outcomeEvent('bounty.completed'));

    for (const input of [{}, null, 'agent-1', { agentId: 7 }, { agentId: '' }]) {
      await expect(runtime.runAction('progression.read', input)).rejects.toThrow(
        /progression\.read rejected/,
      );
    }

    expect(repository.reads).toBe(0);
    // The well-formed call still works, so this is not a blanket refusal.
    await expect(
      runtime.runAction<{ agentId: string }, { xp: number }>('progression.read', {
        agentId: AGENT,
      }),
    ).resolves.toMatchObject({ xp: 1000 });
    expect(repository.reads).toBe(1);
  });

  it('names which half of a gate was refused', async () => {
    const { runtime, repository } = harness();

    await expect(runtime.runAction('progression.gate', {})).rejects.toThrow(
      /progression\.gate rejected: agent-id-not-a-string/,
    );
    await expect(
      runtime.runAction('progression.gate', { agentId: AGENT, requiredLevel: 'five' }),
    ).rejects.toThrow(/progression\.gate rejected: required-level-not-a-number/);
    await expect(
      runtime.runAction('progression.gate', { agentId: AGENT, requiredLevel: 5.5 }),
    ).rejects.toThrow(/progression\.gate rejected: required-level-not-a-whole-number/);
    // A level below the ladder would be answered `allowed: true`, because every
    // character is at least level 1. A gate that opens on a nonsense level is
    // the failure this refuses.
    await expect(
      runtime.runAction('progression.gate', { agentId: AGENT, requiredLevel: 0 }),
    ).rejects.toThrow(/progression\.gate rejected: required-level-below-one/);

    expect(repository.reads).toBe(0);
  });

  it('refuses an awards question with no event type in it', async () => {
    const { runtime } = harness();

    for (const input of [{}, null, { eventType: 42 }, { eventType: '' }]) {
      await expect(runtime.runAction('progression.awards', input)).rejects.toThrow(
        /progression\.awards rejected/,
      );
    }
    // An event type this build has never heard of is an ANSWER, not a
    // malformed call, and refusing it would leave a caller on a newer adapter
    // with no way to ask. This is the distinction the guard has to keep.
    await expect(
      runtime.runAction<{ eventType: string }, { recognised: boolean }>('progression.awards', {
        eventType: 'battle.won.by.atmospheric.events',
      }),
    ).resolves.toMatchObject({ recognised: false });
  });

  it('agrees with the guard it is built from, on every verdict', () => {
    // The guard is defined in terms of the validator, so a payload it accepts
    // is one the action can read with no cast under it.
    for (const [validator, guard] of [
      [whyProgressionReadIsRejected, isProgressionReadInput],
      [whyProgressionGateIsRejected, isProgressionGateInput],
      [whyProgressionAwardsIsRejected, isProgressionAwardsInput],
    ] as const) {
      for (const input of [
        null,
        {},
        'nonsense',
        { agentId: 1 },
        { eventType: 1 },
        { agentId: '' },
      ]) {
        expect(guard(input), String(input)).toBe(validator(input) === undefined);
      }
    }
  });
});

describe('a level is access, and a gate is the question that enforces it', () => {
  const GATE_LEVEL = 5;

  it('refuses one level below a gate and allows at it', async () => {
    const { runtime } = harness();
    await runtime.emit(outcomeEvent('test.passed'));
    await runtime.emit(outcomeEvent('test.passed'));
    // 200 experience is level 2, so the level-5 gate is out of reach.
    const below = await runtime.runAction<
      { agentId: string; requiredLevel: number },
      { allowed: boolean; level: number; unlocks: string | null }
    >('progression.gate', { agentId: AGENT, requiredLevel: GATE_LEVEL });
    expect(below).toMatchObject({ allowed: false, level: 2, unlocks: 'advanced bounties' });

    // Walk up to exactly the gate from the curve rather than a number written
    // here, so retuning the curve does not quietly make this test a lie.
    const stillNeeded = totalXpToReach(GATE_LEVEL) - 200;
    for (let index = 0; index < stillNeeded / OUTCOMES['test.passed'].xp; index += 1) {
      await runtime.emit(outcomeEvent('test.passed'));
    }

    const at = await runtime.runAction<
      { agentId: string; requiredLevel: number },
      { allowed: boolean; level: number }
    >('progression.gate', { agentId: AGENT, requiredLevel: GATE_LEVEL });
    expect(at).toMatchObject({ allowed: true, level: GATE_LEVEL });
  });

  it('answers for a character nobody has heard of, rather than refusing', async () => {
    // A gate that throws is a gate that fails open: every caller wrapping the
    // call defensively turns the exception into "allow". The character is level
    // 1, and the only question is whether 1 is enough — which it is not.
    const { runtime } = harness();

    await expect(
      runtime.runAction<{ agentId: string; requiredLevel: number }, GateDecision>(
        'progression.gate',
        { agentId: 'never-seen', requiredLevel: 5 },
      ),
    ).resolves.toMatchObject({ allowed: false, level: 1, unlocks: 'advanced bounties' });
  });

  it('says nothing is unlocked at a level the ladder does not name', async () => {
    const { runtime } = harness();
    await runtime.emit(outcomeEvent('bounty.completed'));

    await expect(
      runtime.runAction<{ agentId: string; requiredLevel: number }, GateDecision>(
        'progression.gate',
        { agentId: AGENT, requiredLevel: 7 },
      ),
    ).resolves.toMatchObject({ allowed: false, unlocks: null });
  });

  it('lists the ladder, so a client renders the gates rather than hardcoding them', async () => {
    const { runtime } = harness();

    const tiers = await runtime.runAction<unknown, LevelGateView[]>('progression.tiers', {});

    expect(tiers.length).toBeGreaterThan(0);
    expect(tiers).toEqual(
      LEVEL_GATES.map((gate) => ({ level: gate.level, unlocks: gate.unlocks })),
    );
  });

  it('agrees with the rules it wraps, at every level on the ladder', async () => {
    // The action is a transport, not a second opinion. A gate whose answer
    // disagreed with meetsGate would be worse than having no gate at all.
    const { runtime } = harness();
    await runtime.emit(outcomeEvent('bounty.completed'));
    const { level } = await runtime.runAction<
      { agentId: string; requiredLevel: number },
      GateDecision
    >('progression.gate', {
      agentId: AGENT,
      requiredLevel: 1,
    });

    for (const gate of LEVEL_GATES) {
      const decision = await runtime.runAction<
        { agentId: string; requiredLevel: number },
        { allowed: boolean }
      >('progression.gate', { agentId: AGENT, requiredLevel: gate.level });
      expect(decision.allowed, gate.unlocks).toBe(meetsGate(level, gate.level));
    }
  });
});

describe('a retune changes what the feature believes, not only what it says', () => {
  it('stores the build the configured weights produce', async () => {
    // Two recoveries and one bounty: a debugger by default, a builder once the
    // retune says a shipped bounty is stronger evidence than a repair.
    const builderHeavy: BuildWeights = { ...DEFAULT_BUILD_WEIGHTS, builder: 5 };
    const { runtime, repository } = harness(builderHeavy);

    await runtime.emit(outcomeEvent('session.recovered'));
    await runtime.emit(outcomeEvent('session.recovered'));
    await runtime.emit(outcomeEvent('bounty.completed'));

    // The row, not the classification. apply() used to call classifyBuild with
    // no weights, so a retune reached explainBuild and changed nothing the
    // feature had actually decided.
    expect(repository.rows.get(AGENT)?.build).toBe('builder');
  });

  it('stores the opposite build under the default weights, from the same history', async () => {
    const { runtime, repository } = harness();

    await runtime.emit(outcomeEvent('session.recovered'));
    await runtime.emit(outcomeEvent('session.recovered'));
    await runtime.emit(outcomeEvent('bounty.completed'));

    expect(repository.rows.get(AGENT)?.build).toBe('debugger');
  });

  it('never reports a build that disagrees with its own classification', async () => {
    // The defect this fixes was visible on the read: `build` came from storage
    // and `classification.build` was computed with the custom weights, so the
    // two parted the moment anyone supplied non-default ones.
    const builderHeavy: BuildWeights = { ...DEFAULT_BUILD_WEIGHTS, builder: 5 };
    const { runtime } = harness(builderHeavy);
    await runtime.emit(outcomeEvent('session.recovered'));
    await runtime.emit(outcomeEvent('session.recovered'));
    await runtime.emit(outcomeEvent('bounty.completed'));

    const summary = await runtime.runAction<
      { agentId: string },
      { build: string; classification: { build: string } }
    >('progression.read', { agentId: AGENT });

    expect(summary.build).toBe('builder');
    expect(summary.classification.build).toBe(summary.build);
  });
});

describe('applying an outcome', () => {
  it('is pure, so a mis-awarded outcome self-corrects on the next one', () => {
    const start: AgentProgress = {
      agentId: AGENT,
      xp: 0,
      level: 1,
      build: DEFAULT_BUILD,
      skills: EMPTY_SKILLS,
      history: [],
      updatedAt: NOW,
    };

    const after = apply(start, OUTCOMES['bounty.completed'], NOW);

    // The input is untouched, which is what makes a re-award safe to replay.
    expect(start.xp).toBe(0);
    expect(start.history).toEqual([]);
    expect(start.skills).toEqual(EMPTY_SKILLS);
    expect(after.xp).toBe(1000);
    expect(after.build).toBe('builder');
  });

  it('recomputes the build from the whole history rather than adjusting it', () => {
    const asBuilder: AgentProgress = {
      agentId: AGENT,
      xp: 1000,
      level: 2,
      build: 'builder',
      skills: { ...EMPTY_SKILLS, coding: 1000 },
      history: [{ build: 'builder', weight: 1, at: NOW }],
      updatedAt: NOW,
    };

    // Six more builder outcomes on top of one: still a builder, and the
    // history says why rather than the build having been incremented.
    let progress = asBuilder;
    for (let index = 0; index < 6; index += 1) {
      progress = apply(progress, OUTCOMES['bounty.completed'], NOW);
    }
    expect(progress.build).toBe('builder');
    expect(progress.history).toHaveLength(7);
  });

  it('completes a record written before the skills model existed', () => {
    // A stored row from before this model landed has no `skills` key at all. The
    // reducer must not spread undefined into arithmetic, and must not leave the
    // record permanently one field short. The cast is the point rather than an
    // escape: a row in that shape is what the store can hand back, and typing it
    // as a real `AgentProgress` would hide the very case under test.
    const legacy = {
      agentId: AGENT,
      xp: 0,
      level: 1,
      build: DEFAULT_BUILD,
      history: [],
      updatedAt: NOW,
    } as unknown as AgentProgress;

    const after = apply(legacy, OUTCOMES['test.passed'], NOW);

    expect(Object.keys(after.skills).sort()).toEqual([...SKILLS].sort());
    expect(after.skills.testing).toBe(100);
  });
});

describe('a skill is not a build', () => {
  // The two are separate claims about a character and the plan is explicit that
  // they stay separate: a build is what a classifier infers from a whole
  // history, a skill is something that happened once. Conflating them rebuilds
  // the single power scalar section 10.2 forbids, and these are the assertions
  // that say so.
  it('moves the skill the outcome is evidence of, through the real runtime', async () => {
    const { runtime } = harness();
    await runtime.emit(outcomeEvent('test.passed'));
    await runtime.emit(outcomeEvent('session.recovered'));

    const read = await runtime.runAction<
      { agentId: string },
      { skills: readonly { skill: string; xp: number; level: number }[] }
    >('progression.read', { agentId: AGENT });

    const bySkill = Object.fromEntries(read.skills.map((entry) => [entry.skill, entry.xp]));
    expect(bySkill['testing']).toBe(100);
    expect(bySkill['debugging']).toBe(150);
    // The three that nothing was evidence of. A bug that added to the wrong one
    // would still leave the right ones correct, so the untouched ones are part of
    // the claim rather than an afterthought.
    expect(bySkill['coding']).toBe(0);
    expect(bySkill['collaboration']).toBe(0);
    expect(bySkill['research']).toBe(0);
  });

  it('keeps every skill below the character, because the character is a sum of them', async () => {
    const { runtime } = harness();
    await runtime.emit(outcomeEvent('bounty.completed'));

    const read = await runtime.runAction<
      { agentId: string },
      {
        xp: number;
        level: number;
        skills: readonly { skill: string; xp: number; level: number }[];
      }
    >('progression.read', { agentId: AGENT });

    // A bounty is the only outcome so far that trains a skill, and it pays all
    // of its 1000 to `coding`, so the two levels are equal rather than the skill
    // being lower. What must never happen is the reverse.
    const totals = read.skills.reduce((sum, entry) => sum + entry.xp, 0);
    expect(totals).toBeLessThanOrEqual(read.xp);
    for (const entry of read.skills) {
      expect(entry.level, `${entry.skill} outran the character`).toBeLessThanOrEqual(read.level);
    }
  });

  it('leaves no aggregate a caller could mistake for a power score', async () => {
    const { runtime } = harness();
    await runtime.emit(outcomeEvent('bounty.completed'));

    const read = (await runtime.runAction('progression.read', { agentId: AGENT })) as Record<
      string,
      unknown
    >;

    // Named rather than computed: the failure this forbids is a `power` or
    // `totalSkillLevel` appearing in the reply, and a rule about arithmetic on
    // skills would not have caught that.
    for (const forbidden of [
      'power',
      'total',
      'totalSkillLevel',
      'strength',
      'rating',
      'average',
    ]) {
      expect(read[forbidden], `${forbidden} is a power scalar`).toBeUndefined();
    }
    // And the skills are eight separate objects, not one number eight times.
    expect(Array.isArray(read['skills'])).toBe(true);
  });

  it('does not let a battle win train a skill it is not evidence of', async () => {
    const { runtime } = harness();
    await runtime.emit(outcomeEvent('battle.finished', AGENT, { won: true }));

    const read = await runtime.runAction<
      { agentId: string },
      { xp: number; skills: readonly { skill: string; xp: number }[] }
    >('progression.read', { agentId: AGENT });

    // The character is level 3 from a 500 award and every skill is at zero. That
    // is the honest answer: a win is a reward, and it is not evidence that the
    // agent is better at any of the eight disciplines.
    expect(read.xp).toBe(500);
    expect(read.skills.every((entry) => entry.xp === 0)).toBe(true);
  });

  it('survives a save that arrives with the skills of a different shape', async () => {
    // The repository may hand back a map with a key the feature does not know —
    // a skill added by a newer build, or corrupted on disk. The reducer must
    // neither crash nor let the unknown key back into the record it writes.
    const { runtime, repository } = harness();
    await runtime.emit(outcomeEvent('test.passed'));

    const row = repository.rows.get(AGENT);
    expect(row).toBeDefined();
    repository.rows.set(AGENT, {
      ...(row as AgentProgress),
      skills: { ...(row as AgentProgress).skills, carpentry: 4000 } as never,
    });

    await runtime.emit(outcomeEvent('session.recovered'));

    const after = repository.rows.get(AGENT);
    expect(Object.keys((after as AgentProgress).skills).sort()).toEqual([...SKILLS].sort());
    expect((after as AgentProgress).skills.testing).toBe(100);
  });
});

describe('a quest that completed', () => {
  it('pays the reward the quest NAMED, not the table default', () => {
    // The quest publishes its own reward and it varies with difficulty, so a
    // fixed table entry alone would make `xpReward` decorative in the other
    // direction: every quest paying the same amount while the API reported a
    // different one.
    const event = {
      type: 'quest.completed',
      occurredAt: '2026-01-01T00:00:00.000Z',
      actorId: 'agent-1',
      payload: { agentId: 'agent-1', questId: 'q-1', xpReward: 900 },
    };

    expect(xpRewardFromEvent(event)).toEqual({ xp: 900 });
    // Without the payload, the table's number stands.
    expect(xpRewardFromEvent({ ...event, payload: { agentId: 'agent-1' } })).toEqual({});
  });

  it('ignores a reward another feature got wrong, rather than writing it', () => {
    // The payload belongs to another feature, so it is untrusted by
    // construction. A string, a negative, or an infinity must not become an
    // award that the level curve then has to cope with.
    const base = { type: 'quest.completed', occurredAt: '2026-01-01T00:00:00.000Z', actorId: 'agent-1' };
    for (const xpReward of ['900', -1, Number.POSITIVE_INFINITY, Number.NaN, null, undefined]) {
      expect(xpRewardFromEvent({ ...base, payload: { agentId: 'agent-1', xpReward } })).toEqual({});
    }
  });

  it('leaves a bounty completion on the table amount, which names no reward of its own', () => {
    // A bounty's worth is fixed by the table and the event does not carry one,
    // so reading the payload must not invent an override for it.
    expect(
      xpRewardFromEvent({
        type: 'bounty.completed',
        occurredAt: '2026-01-01T00:00:00.000Z',
        actorId: 'agent-1',
        payload: { agentId: 'agent-1', xpReward: 99999 },
      }),
    ).toEqual({});
  });
});
