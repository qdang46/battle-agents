import { describe, expect, it } from 'vitest';

import type { ActivityEntry } from './activity.js';
import {
  buildPublicReplay,
  describeDuration,
  REPLAY_BEAT_NAMES,
  replayShareMetadata,
} from './replay.js';

/**
 * The public replay boundary, as a check that can fail.
 *
 * Every test here is about one of three things, and the third is the one this
 * file exists for: WHAT A STRANGER IS ALLOWED TO SEE. The log holds an
 * unbounded string in every payload field — `packages/protocol/src/agent-event.ts`
 * types them all as `z.string().min(1)` — so a test that reads a field and drops
 * it proves nothing about what the field held. These tests therefore assert on
 * the shape that goes out, built from a log whose every field has been seeded
 * with a recognisable secret, and they assert that the secret is not in it.
 *
 * The determinism tests are the second kind, and the argument they rest on is
 * the sharing argument: two people opening the same link have to see the same
 * bytes, so the construction cannot read a clock, mint an id, or depend on the
 * order a jsonb row happened to list its keys in.
 */

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SECRET_PATH = '/Users/someone/secret-project/src/auth.ts';
const SECRET_COMMAND = 'deploy-production --token=hunter2';
const SECRET_PROMPT = 'the user asked me to bypass the check';

/** One row, in the shape the log hands a reader. */
function entry(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
  options: { readonly at?: string; readonly sessionId?: string | null } = {},
): ActivityEntry {
  return {
    sequence,
    type,
    actorId: 'battle',
    sessionId: options.sessionId ?? null,
    causationId: null,
    payload,
    occurredAt:
      options.at ?? new Date(Date.UTC(2026, 0, 2, 12, 0, 0) + sequence * 1000).toISOString(),
  };
}

const RUBRIC = { correctness: 0.5, tests: 0.2, security: 0.3 };

/** A whole finished battle, with a secret in every field that could carry one. */
function finishedBattleLog(): readonly ActivityEntry[] {
  return [
    entry(1, 'battle.created', {
      battleId: 'battle-7',
      mode: 'speed',
      bountyId: 'bounty-3',
      weights: RUBRIC,
      participants: [ALICE, BOB],
      repo: SECRET_PATH,
    }),
    entry(
      2,
      'session.started',
      { agentId: 'agent-a', harness: 'claude', path: SECRET_PATH },
      { sessionId: ALICE },
    ),
    entry(3, 'session.started', { agentId: 'agent-b', harness: 'codex' }, { sessionId: BOB }),
    entry(4, 'test.passed', { suite: 'unit', count: 47 }, { sessionId: ALICE }),
    entry(
      5,
      'test.failed',
      { suite: 'integration', failure: `AssertionError at ${SECRET_PATH}:42` },
      { sessionId: ALICE },
    ),
    entry(6, 'test.passed', { suite: 'unit', count: 12 }, { sessionId: BOB }),
    entry(7, 'file.write', { path: SECRET_PATH, sessionId: ALICE }),
    entry(8, 'thinking', { text: SECRET_PROMPT }, { sessionId: BOB }),
    entry(9, 'command.run', { argv0: SECRET_COMMAND }, { sessionId: BOB }),
    entry(10, 'session.ended', { reason: 'completed' }, { sessionId: ALICE }),
    entry(11, 'battle.finished', {
      battleId: 'battle-7',
      mode: 'speed',
      weights: RUBRIC,
      outcome: 'won',
      reason: 'outscored',
      winnerSessionIds: [ALICE],
      participants: [ALICE, BOB],
      scores: [
        {
          sessionId: BOB,
          total: 0.61,
          criteria: [
            { criterion: 'tests', weight: 0.2, score: 0.9, weighted: 0.18 },
            { criterion: 'security', weight: 0.3, score: 0.7, weighted: 0.21 },
            { criterion: 'correctness', weight: 0.5, score: 0.44, weighted: 0.22 },
          ],
        },
        {
          sessionId: ALICE,
          total: 0.94,
          criteria: [
            { criterion: 'correctness', weight: 0.5, score: 0.96, weighted: 0.48 },
            { criterion: 'security', weight: 0.3, score: 0.9, weighted: 0.27 },
            { criterion: 'tests', weight: 0.2, score: 0.95, weighted: 0.19 },
          ],
        },
      ],
    }),
  ];
}

/* ───────────────────────────── the boundary ───────────────────────────── */

describe('what a logged-out viewer is shown', () => {
  const replay = buildPublicReplay({ replayId: 'replay-1', entries: finishedBattleLog() });

  it('publishes no string that was seeded into the log as a secret', () => {
    // The whole test. A projection that forgot one allow-list entry, or that
    // fell through to the raw payload, fails on exactly this line.
    const published = JSON.stringify(replay);
    for (const secret of [
      SECRET_PATH,
      SECRET_COMMAND,
      SECRET_PROMPT,
      'hunter2',
      'agent-a',
      'agent-b',
      ALICE,
      BOB,
      'bounty-3',
      'battle-7',
    ]) {
      expect(published).not.toContain(secret);
    }
  });

  it('does not carry the failure text of a failed test', () => {
    // The field the live-stream classification also drops, and the reason is the
    // same: it is an unbounded string a stack fragment lands in.
    expect(JSON.stringify(replay)).not.toContain('AssertionError');
    expect(replay.beats.some((beat) => beat.beat === 'test.failed')).toBe(true);
  });

  it('publishes nothing at all for an event type outside the allow-list', () => {
    // file.write, thinking and command.run are in the input on purpose. The
    // scoreboard is the public product; the audit trail is not, and a replay
    // that forwarded them would be the log with a nicer layout.
    const names = replay.beats.map((beat) => beat.beat);
    expect(names).not.toContain('file.write');
    expect(names).not.toContain('thinking');
    expect(names).not.toContain('command.run');
  });

  it('emits only beat names from the declared closed set', () => {
    // So a renderer can switch exhaustively, and so a raw event type reaching a
    // page is a test failure rather than a string nobody checked.
    for (const beat of replay.beats) {
      expect(REPLAY_BEAT_NAMES).toContain(beat.beat);
    }
  });

  it('shows which harnesses competed, and nothing about who they are', () => {
    expect(replay.fighters.map((fighter) => fighter.harness)).toEqual(['claude', 'codex']);
    expect(replay.fighters.map((fighter) => fighter.label)).toEqual(['Fighter A', 'Fighter B']);
  });

  it('shows the published rubric, because a spectator cannot check it themselves', () => {
    expect(replay.rubric).toEqual(RUBRIC);
  });

  it('shows the judge’s arithmetic, decomposed and named', () => {
    const winner = replay.fighters.find((fighter) => fighter.won);
    expect(winner?.total).toBe(0.94);
    expect(winner?.score?.map((criterion) => criterion.criterion)).toEqual([
      'correctness',
      'security',
      'tests',
    ]);
    expect(replay.outcome).toBe('won');
    expect(replay.reason).toBe('outscored');
  });
});

describe('the narrowings that are deliberate rather than incidental', () => {
  it('drops a suite name that could be a command line', () => {
    // `docs/design/public-event-stream.md` publishes `suite` on the live stream.
    // Here it is guarded, because a suite name is derived from a command and a
    // replay is a permanent cached artefact rather than an ephemeral stream.
    const replay = buildPublicReplay({
      replayId: 'r',
      entries: [
        entry(1, 'session.started', { harness: 'claude' }, { sessionId: ALICE }),
        entry(
          2,
          'test.passed',
          { suite: 'pnpm test packages/db/src/verify.test.ts', count: 3 },
          { sessionId: ALICE },
        ),
        entry(3, 'test.passed', { suite: 'unit', count: 4 }, { sessionId: ALICE }),
      ],
    });
    const passed = replay.beats.filter((beat) => beat.beat === 'test.passed');
    expect(passed).toHaveLength(2);
    expect(passed[0]?.detail).toEqual({ count: 3 });
    expect(passed[1]?.detail).toEqual({ suite: 'unit', count: 4 });
  });

  it('drops a harness the protocol no longer accepts', () => {
    // A log written by a build whose protocol enum was wider must not widen this
    // projection. The enum is imported rather than copied, so widening it is a
    // reviewed change to the protocol and not an accident here.
    const replay = buildPublicReplay({
      replayId: 'r',
      entries: [
        entry(1, 'session.started', { harness: 'rogue-harness' }, { sessionId: ALICE }),
        entry(2, 'session.started', { harness: 'claude' }, { sessionId: BOB }),
      ],
    });
    expect(replay.fighters.map((fighter) => fighter.harness)).toEqual([null, 'claude']);
  });

  it('drops a refusal or lifecycle reason outside the closed set', () => {
    const replay = buildPublicReplay({
      replayId: 'r',
      entries: [
        entry(1, 'battle.created', {
          battleId: 'b',
          mode: 'speed',
          weights: RUBRIC,
          participants: [ALICE],
        }),
        entry(
          2,
          'battle.join_refused',
          { battleId: 'b', why: 'the moon is in the wrong phase' },
          { sessionId: BOB },
        ),
        entry(3, 'battle.expired', { battleId: 'b', reason: 'the operator got bored' }),
      ],
    });
    const refused = replay.beats.find((beat) => beat.beat === 'fighter.join_refused');
    expect(refused?.detail).toEqual({});
    expect(replay.beats.find((beat) => beat.beat === 'battle.expired')?.detail).toEqual({});
  });

  it('publishes a known reason it does recognise', () => {
    const replay = buildPublicReplay({
      replayId: 'r',
      entries: [
        entry(1, 'battle.created', {
          battleId: 'b',
          mode: 'speed',
          weights: RUBRIC,
          participants: [ALICE],
        }),
        entry(2, 'battle.join_refused', { battleId: 'b', why: 'full' }, { sessionId: BOB }),
        entry(3, 'battle.expired', { battleId: 'b', reason: 'match-duration-elapsed' }),
      ],
    });
    expect(replay.beats.find((beat) => beat.beat === 'fighter.join_refused')?.detail).toEqual({
      why: 'full',
    });
    expect(replay.beats.find((beat) => beat.beat === 'battle.expired')?.detail).toEqual({
      reason: 'match-duration-elapsed',
    });
  });

  it('ignores a weights object that holds something other than numbers', () => {
    // The rubric is published, so a `weights` object carrying a string would put
    // it on the page. Nothing upstream says it cannot, so the projection checks.
    const replay = buildPublicReplay({
      replayId: 'r',
      entries: [
        entry(1, 'battle.created', { battleId: 'b', mode: 'speed', weights: { tests: '3/10' } }),
      ],
    });
    expect(replay.rubric).toBeNull();
  });
});

/* ───────────────────────────── determinism ───────────────────────────── */

describe('determinism', () => {
  const entries = finishedBattleLog();

  it('builds the same replay from the same log every time', () => {
    expect(buildPublicReplay({ replayId: 'r', entries })).toEqual(
      buildPublicReplay({ replayId: 'r', entries }),
    );
  });

  it('reads no clock, so a decade-old battle renders its own dates', () => {
    // A construction that reached for the wall clock would put today's date in
    // the output here, and a viewer comparing two replays would see a
    // difference that has nothing to do with the battle.
    const ancient = entries.map((row) => ({ ...row, occurredAt: '2019-04-01T00:00:00.000Z' }));
    const replay = buildPublicReplay({ replayId: 'r', entries: ancient });
    expect(JSON.stringify(replay)).not.toMatch(/202[0-9]/);
    expect(replay.beats[0]?.at).toBe('2019-04-01T00:00:00.000Z');
  });

  it('measures every offset against the first beat, not against now', () => {
    // The test above did NOT catch a wall-clock read, which is why this one
    // exists: `Date.now()` is a bare number, and a number of about 1.8e12
    // contains no year, so the string assertion above passed while the replay
    // was still wrong. The bound is the real property — an offset is a distance
    // INSIDE the battle, so it cannot exceed the battle's own span, and a clock
    // read exceeds it by eight orders of magnitude.
    const stale = entries.map((row) => ({ ...row, occurredAt: '2019-04-01T00:00:00.000Z' }));
    const replay = buildPublicReplay({ replayId: 'r', entries: stale });
    expect(replay.beats[0]?.offsetMs).toBe(0);
    for (const beat of replay.beats) {
      expect(beat.offsetMs).toBeLessThanOrEqual(replay.durationMs ?? 0);
    }
    expect(replay.durationMs).toBe(0);
  });

  it('mints no identifier that was not in the log', () => {
    // A replay that minted an id would give two viewers of the same battle
    // different links to it, which is the sharing argument in one assertion.
    const replay = buildPublicReplay({ replayId: 'r', entries });
    const uuidShape = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
    const inLog = new Set(JSON.stringify(entries).match(uuidShape) ?? []);
    for (const found of JSON.stringify(replay).match(uuidShape) ?? []) {
      expect(inLog).toContain(found);
    }
  });

  it('does not depend on the order the rows arrive in', () => {
    const reversed = [...entries].reverse();
    expect(buildPublicReplay({ replayId: 'r', entries: reversed })).toEqual(
      buildPublicReplay({ replayId: 'r', entries }),
    );
  });

  it('does not depend on the order the criteria are listed in', () => {
    // jsonb does not preserve key order, so a projection that trusted the array
    // order of a payload would render the scoreboard in a different order on the
    // next request, and two quotes of the same replay would not match.
    const swapped = entries.map((row) => {
      if (row.type !== 'battle.finished') return row;
      const payload = row.payload as { scores: { criteria: unknown[] }[] };
      return {
        ...row,
        payload: {
          ...row.payload,
          scores: payload.scores.map((score) => ({
            ...score,
            criteria: [...score.criteria].reverse(),
          })),
        },
      };
    });
    expect(buildPublicReplay({ replayId: 'r', entries: swapped })).toEqual(
      buildPublicReplay({ replayId: 'r', entries }),
    );
  });

  it('does not depend on the order the rubric keys are listed in', () => {
    const swapped = entries.map((row) =>
      row.type === 'battle.created'
        ? {
            ...row,
            payload: { ...row.payload, weights: { security: 0.3, tests: 0.2, correctness: 0.5 } },
          }
        : row,
    );
    expect(buildPublicReplay({ replayId: 'r', entries: swapped }).rubric).toEqual(RUBRIC);
  });
});

/* ───────────────────────────── the states ───────────────────────────── */

describe('the three states a link can be in', () => {
  it('is available once the battle has finished', () => {
    const replay = buildPublicReplay({ replayId: 'r', entries: finishedBattleLog() });
    expect(replay.state).toBe('available');
    expect(replay.durationMs).toBe(10_000);
  });

  it('is in-progress while the battle is running, with no verdict', () => {
    const replay = buildPublicReplay({
      replayId: 'r',
      entries: [
        entry(1, 'battle.created', {
          battleId: 'b',
          mode: 'speed',
          weights: RUBRIC,
          participants: [ALICE],
        }),
        entry(2, 'session.started', { harness: 'claude' }, { sessionId: ALICE }),
        entry(3, 'battle.paused', { battleId: 'b' }, { sessionId: ALICE }),
        entry(4, 'battle.resumed', { battleId: 'b' }, { sessionId: ALICE }),
      ],
    });
    expect(replay.state).toBe('in-progress');
    expect(replay.outcome).toBeNull();
    expect(replay.beats.map((beat) => beat.beat)).toEqual([
      'battle.opened',
      'session.started',
      'fighter.paused',
      'fighter.resumed',
    ]);
  });

  it('is expired when the log holds nothing for this battle', () => {
    // The far end of the 365-day window features/activity owns. A stated state,
    // not an error, and not an empty timeline that reads as "nothing happened".
    const replay = buildPublicReplay({ replayId: 'r', entries: [] });
    expect(replay.state).toBe('expired');
    expect(replay.beats).toEqual([]);
    expect(replay.durationMs).toBeNull();
  });

  it('credits both winners of a shared win', () => {
    // A shared win has two winners, which is why `battles.winner_session_id` was
    // dropped: a column can hold one and a flag per participant cannot.
    const replay = buildPublicReplay({
      replayId: 'r',
      entries: [
        entry(1, 'battle.created', {
          battleId: 'b',
          mode: 'chaos',
          weights: RUBRIC,
          participants: [ALICE, BOB],
        }),
        entry(2, 'battle.finished', {
          battleId: 'b',
          mode: 'chaos',
          weights: RUBRIC,
          outcome: 'won',
          reason: 'shared',
          winnerSessionIds: [ALICE, BOB],
          participants: [ALICE, BOB],
          scores: [
            { sessionId: ALICE, total: 0.5, criteria: [] },
            { sessionId: BOB, total: 0.5, criteria: [] },
          ],
        }),
      ],
    });
    expect(replay.fighters.every((fighter) => fighter.won)).toBe(true);
  });

  it('renders one finish beat for one finish, not one per winner', () => {
    // The battle feature emits a battle.finished per winner as well as the
    // battle-level one. Rendering all of them would put N+1 "finished" beats on
    // the timeline for a single finish.
    const replay = buildPublicReplay({
      replayId: 'r',
      entries: [
        entry(1, 'battle.created', {
          battleId: 'b',
          mode: 'speed',
          weights: RUBRIC,
          participants: [ALICE, BOB],
        }),
        entry(
          2,
          'battle.finished',
          {
            battleId: 'b',
            sessionId: ALICE,
            agentId: 'agent-a',
            won: true,
            reason: 'outscored',
            mode: 'speed',
            weights: RUBRIC,
          },
          { sessionId: ALICE },
        ),
        entry(
          3,
          'battle.finished',
          {
            battleId: 'b',
            sessionId: BOB,
            agentId: 'agent-b',
            won: true,
            reason: 'outscored',
            mode: 'speed',
            weights: RUBRIC,
          },
          { sessionId: BOB },
        ),
        entry(4, 'battle.finished', {
          battleId: 'b',
          mode: 'speed',
          weights: RUBRIC,
          outcome: 'won',
          reason: 'outscored',
          winnerSessionIds: [ALICE, BOB],
          participants: [ALICE, BOB],
          scores: [],
        }),
      ],
    });
    expect(replay.beats.filter((beat) => beat.beat === 'battle.finished')).toHaveLength(1);
  });
});

/* ───────────────────────────── share metadata ───────────────────────────── */

describe('the share metadata', () => {
  const replay = buildPublicReplay({ replayId: 'replay-1', entries: finishedBattleLog() });

  it('is built from the projection, so it cannot carry what the projection refused', () => {
    const share = replayShareMetadata(replay, 'https://agentbattle.gg');
    expect(share.url).toBe('https://agentbattle.gg/replay/replay-1');
    expect(share.title).toBe('Battle replay: Fighter A (claude) vs Fighter B (codex)');
    expect(share.description).toContain('won by Fighter A (claude)');
    expect(JSON.stringify(share)).not.toMatch(/hunter2|secret-project|agent-a/);
  });

  it('says so when the timeline is gone rather than showing an empty one', () => {
    const share = replayShareMetadata(
      buildPublicReplay({ replayId: 'replay-1', entries: [] }),
      'https://agentbattle.gg',
    );
    expect(share.title).toContain('no events in the log');
  });

  it('does not claim the battle finished, which the log cannot know', () => {
    // A battle with no beats gets the same `expired` state whether it ended an
    // hour ago or is RUNNING RIGHT NOW -- the state machine cannot tell them
    // apart. The share text asserted both that it finished and that its events
    // aged out, which are two separate claims neither of which the log supports.
    // The page's own ExpiredNotice was corrected for exactly this and these two
    // strings were missed. Found by rendering /replay against a real `running`
    // battle row and reading what it said.
    const share = replayShareMetadata(
      buildPublicReplay({ replayId: 'replay-1', entries: [] }),
      'https://agentbattle.gg',
    );
    expect(`${share.title} ${share.description}`).not.toMatch(/finished|retention/i);
  });

  it('formats a duration the way a reader reads one', () => {
    expect(describeDuration(740_000)).toBe('12m 20s');
    expect(describeDuration(3_845_000)).toBe('1h 04m 05s');
    expect(describeDuration(9_000)).toBe('9s');
  });
});
