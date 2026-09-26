import {
  closeDatabasePool,
  createDatabase,
  DrizzleAgentRepository,
  DrizzleBattleRepository,
  installations,
  sessions,
  users,
  type Database,
} from '@battle-agents/db';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The last seat, decided under contention.
 *
 * ## Why this file exists when `battle-repository.test.ts` already tests it
 *
 * Because the test there does not work, and it does not work in the exact way
 * that hid a live bug.
 *
 * It races two joins into a two-seat battle and asserts that exactly one is
 * admitted. It passed 15 times out of 15 in isolation. `DrizzleBattleRepository.join`
 * was overselling the last seat — three participants in a two-seat battle — in
 * 28 to 38 races out of 40 when the race was repeated. One round is a coin flip
 * that lands heads almost every time, which is what a broken mutex looks like
 * from inside a green suite.
 *
 * So the assertion here is repeated, and the property asserted is the one the
 * file's own comment used to claim: a battle must never hold more fighters than
 * its capacity, whoever is clicking. A test that only sometimes races is a
 * report that a reader has to know to distrust.
 */

const AT = '2026-09-27T12:00:00.000Z';
const ROUNDS = 25;
const CAPACITY = 2;

let pool: Pool;
let database: Database;
let repository: DrizzleBattleRepository;
let installationId: string;
let ownerId: string;

beforeAll(async () => {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined) {
    throw new Error('DATABASE_URL is not set. Run through scripts/test-m0.sh.');
  }
  pool = new Pool({ connectionString, max: 6 });
  database = createDatabase(pool);
  repository = new DrizzleBattleRepository(database);

  const login = `race-${randomUUID()}`;
  const [owner] = await database
    .insert(users)
    .values({ githubId: login, login })
    .returning({ id: users.id });
  ownerId = owner?.id ?? '';
  const [installation] = await database
    .insert(installations)
    .values({ userId: ownerId, installationKey: `race-${randomUUID()}` })
    .returning({ id: installations.id });
  installationId = installation?.id ?? '';
});

afterAll(async () => {
  await closeDatabasePool(pool);
});

let sessionCounter = 0;
async function aSession(): Promise<string> {
  const agents = new DrizzleAgentRepository(database);
  const agentId = (await agents.create({ ownerId, name: `racer-${randomUUID().slice(0, 8)}`, harness: 'claude' }, AT)).id;
  const [row] = await database
    .insert(sessions)
    .values({
      agentId,
      installationId,
      harnessSessionRef: `race-${sessionCounter++}-${randomUUID().slice(0, 8)}`,
      status: 'active',
      startedAt: new Date(AT),
    })
    .returning({ id: sessions.id });
  if (row === undefined) throw new Error('a session was created and could not be read back');
  return row.id;
}

describe('two racers, one seat', () => {
  it('never seats more than the capacity allows, over many rounds', async () => {
    const oversold: string[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      // Fresh sessions and a fresh battle every round, so round N cannot pass by
      // inheriting a battle that is already full.
      const [creator, second, third] = await Promise.all([aSession(), aSession(), aSession()]);
      const battle = await repository.create({
        mode: 'speed',
        bountyId: null,
        weightsJson: {},
        creatorSessionId: creator,
        now: AT,
      });

      const [left, right] = await Promise.all([
        repository.join(battle.id, second, CAPACITY, AT),
        repository.join(battle.id, third, CAPACITY, AT),
      ]);

      const seated = await repository.participants(battle.id);
      const admitted = [left, right].filter((outcome) => outcome.joined).length;
      if (admitted > 1 || seated.length > CAPACITY) {
        oversold.push(
          `round ${String(round)}: ${String(admitted)} admitted, ${String(seated.length)} seated in a ${String(CAPACITY)}-seat battle`,
        );
      }
    }

    expect(
      oversold,
      `A battle held more fighters than its capacity. The judge scores a two-way match, and three participants is a battle nobody can score:\n  ${oversold.join('\n  ')}`,
    ).toEqual([]);
  }, 60_000);

  it('admits the second seat when there genuinely is one', async () => {
    // The other half, and the one a mutex that is simply "always refuse" would
    // pass. A creator seats itself, so the battle has one place taken and one
    // free, and two racers for that one place must produce exactly one winner.
    const [creator, second, third] = await Promise.all([aSession(), aSession(), aSession()]);
    const battle = await repository.create({
      mode: 'speed',
      bountyId: null,
      weightsJson: {},
      creatorSessionId: creator,
      now: AT,
    });

    const [left, right] = await Promise.all([
      repository.join(battle.id, second, CAPACITY, AT),
      repository.join(battle.id, third, CAPACITY, AT),
    ]);

    expect([left, right].filter((outcome) => outcome.joined)).toHaveLength(1);
    expect(await repository.participants(battle.id)).toHaveLength(CAPACITY);
    // And the loser is told why, with a reason a caller can act on.
    const loser = left.joined ? right : left;
    expect(loser.joined).toBe(false);
    if (!loser.joined) {
      expect(loser.why).toBe('full');
    }
  });
});
