import { sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import {
  achievements,
  agentCredentials,
  agentStats,
  agents,
  battleParticipants,
  battles,
  bountyFunds,
  bounties,
  eventLog,
  installations,
  messages,
  projects,
  quests,
  sessions,
  users,
} from '../schema/index.js';
import {
  SEED_ACHIEVEMENT,
  SEED_AGENT_STATS,
  SEED_BATTLE,
  SEED_BATTLE_PARTICIPANTS,
  SEED_BOUNTY,
  SEED_CHALLENGER_AGENT,
  SEED_CHALLENGER_SESSION,
  SEED_CREDENTIAL,
  SEED_EVENTS,
  SEED_INSTALLATION,
  SEED_LEAD_FUNDING,
  SEED_MATCHING_FUNDING,
  SEED_MESSAGE,
  SEED_OPPONENT_AGENT,
  SEED_OPPONENT_SESSION,
  SEED_PROJECT,
  SEED_QUEST,
  SEED_USER,
} from './fixtures.js';

/**
 * Every fixture row carries a fixed id, so a conflict always means "this exact
 * row already exists" and the upsert restores it to its canonical value. Row
 * counts therefore stay stable no matter how often the seed runs.
 */
export async function seedDatabase(database: Database): Promise<void> {
  await database.transaction(async (tx) => {
    await seedPlatform(tx);
    await seedSessionFixtures(tx);
    await seedQuestAndBountyFixtures(tx);
    await seedBattleFixtures(tx);
    await seedSocialFixtures(tx);
    await seedActivityFixtures(tx);
  });
  await alignEventLogSequence(database);
}

type SeedTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function seedPlatform(tx: SeedTransaction): Promise<void> {
  await tx
    .insert(users)
    .values(SEED_USER)
    .onConflictDoUpdate({
      target: users.id,
      set: { githubId: SEED_USER.githubId, login: SEED_USER.login, avatarUrl: SEED_USER.avatarUrl },
    });

  await tx
    .insert(installations)
    .values(SEED_INSTALLATION)
    .onConflictDoUpdate({
      target: installations.id,
      set: { userId: SEED_INSTALLATION.userId, installationKey: SEED_INSTALLATION.installationKey },
    });

  await tx
    .insert(agents)
    .values([SEED_CHALLENGER_AGENT, SEED_OPPONENT_AGENT])
    .onConflictDoUpdate({
      target: agents.id,
      set: { userId: SEED_CHALLENGER_AGENT.userId, name: SEED_CHALLENGER_AGENT.name, harness: SEED_CHALLENGER_AGENT.harness },
    });

  await tx
    .insert(agentCredentials)
    .values(SEED_CREDENTIAL)
    .onConflictDoUpdate({
      target: agentCredentials.id,
      set: {
        tokenHash: SEED_CREDENTIAL.tokenHash,
        scopes: SEED_CREDENTIAL.scopes,
        revokedAt: SEED_CREDENTIAL.revokedAt,
      },
    });

  await tx
    .insert(projects)
    .values(SEED_PROJECT)
    .onConflictDoUpdate({
      target: projects.id,
      set: { userId: SEED_PROJECT.userId, repoUrl: SEED_PROJECT.repoUrl, name: SEED_PROJECT.name },
    });
}

async function seedSessionFixtures(tx: SeedTransaction): Promise<void> {
  await tx
    .insert(sessions)
    .values([SEED_CHALLENGER_SESSION, SEED_OPPONENT_SESSION])
    .onConflictDoUpdate({
      target: sessions.id,
      set: { status: SEED_CHALLENGER_SESSION.status, harnessSessionRef: SEED_CHALLENGER_SESSION.harnessSessionRef },
    });

  await tx
    .insert(agentStats)
    .values([...SEED_AGENT_STATS])
    .onConflictDoUpdate({
      target: agentStats.agentId,
      set: { skillsJson: SEED_AGENT_STATS[0]?.skillsJson },
    });
}

async function seedQuestAndBountyFixtures(tx: SeedTransaction): Promise<void> {
  await tx
    .insert(quests)
    .values(SEED_QUEST)
    .onConflictDoUpdate({
      target: quests.id,
      set: {
        title: SEED_QUEST.title,
        body: SEED_QUEST.body,
        difficulty: SEED_QUEST.difficulty,
        xpReward: SEED_QUEST.xpReward,
        status: SEED_QUEST.status,
      },
    });

  await tx
    .insert(bounties)
    .values(SEED_BOUNTY)
    .onConflictDoUpdate({
      target: bounties.id,
      set: {
        requirements: SEED_BOUNTY.requirements,
        status: SEED_BOUNTY.status,
        sponsorUserId: SEED_BOUNTY.sponsorUserId,
      },
    });

  await tx
    .insert(bountyFunds)
    .values([SEED_LEAD_FUNDING, SEED_MATCHING_FUNDING])
    .onConflictDoUpdate({
      target: bountyFunds.id,
      // The FIXTURE's value, not the column. `bountyFunds.amountCents` is a
      // drizzle `Column`, and a `Column` is a legal value for `set` — so the
      // statement compiled, ran, and rendered as
      //
      //     "amount_cents" = "bounty_funds"."amount_cents"
      //
      // which is a tautology. Re-seeding silently left every funding row at
      // whatever it was, and `checkSeedIsIdempotent` could not see it because a
      // no-op upsert leaves the row COUNT identical. The one column where being
      // wrong is worth money, wrong in a way no gate in this repository could
      // name.
      set: { amountCents: SEED_LEAD_FUNDING.amountCents },
    });
}

async function seedBattleFixtures(tx: SeedTransaction): Promise<void> {
  await tx
    .insert(battles)
    .values(SEED_BATTLE)
    .onConflictDoUpdate({
      target: battles.id,
      set: {
        mode: SEED_BATTLE.mode,
        weightsJson: SEED_BATTLE.weightsJson,
        status: SEED_BATTLE.status,
      },
    });

  await tx
    .insert(battleParticipants)
    .values([...SEED_BATTLE_PARTICIPANTS])
    .onConflictDoUpdate({
      target: [battleParticipants.battleId, battleParticipants.sessionId],
      // NOTHING is set here, which is a decision and not an omission.
      //
      // This upsert's conflict target is the PAIR (battleId, sessionId), and
      // each participant has its OWN score — 0.92 and 0.81. A `set` clause
      // applies one value to whichever row conflicted, so putting a fixture's
      // score here gives BOTH fighters the same number and makes the second
      // one's result a copy of the first. The `Column` reference that used to
      // be here was a tautology that changed nothing, and that accident is
      // exactly what the right answer looks like here: on a composite key with
      // per-row values, the correct `set` is none, and the insert already
      // supplied them.
      set: {},
    });
}

async function seedSocialFixtures(tx: SeedTransaction): Promise<void> {
  await tx
    .insert(achievements)
    .values(SEED_ACHIEVEMENT)
    .onConflictDoUpdate({ target: achievements.id, set: { code: SEED_ACHIEVEMENT.code } });

  await tx
    .insert(messages)
    .values(SEED_MESSAGE)
    .onConflictDoUpdate({ target: messages.id, set: { body: SEED_MESSAGE.body } });
}

async function seedActivityFixtures(tx: SeedTransaction): Promise<void> {
  await tx
    .insert(eventLog)
    .values([...SEED_EVENTS])
    .onConflictDoNothing();
}

/**
 * Seeding explicit bigserial ids leaves the sequence behind the inserted rows,
 * which would make the next runtime insert collide. Re-advance it so the log
 * stays writable after a seed.
 */
async function alignEventLogSequence(database: Database): Promise<void> {
  await database.execute(sql`
    SELECT setval(
      pg_get_serial_sequence('event_log', 'id'),
      GREATEST(COALESCE((SELECT MAX(id) FROM event_log), 1), 1)
    )
  `);
}
