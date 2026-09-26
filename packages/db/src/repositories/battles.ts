import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';

import { battleParticipants, battles } from '../schema/features/battle.js';
import type { BattleStatus } from '../schema/features/battle.js';
import type { Database } from '../client.js';

/**
 * What a transaction hands a callback.
 *
 * Spelled rather than imported from drizzle's internals: the type is inferred
 * from `database.transaction` and naming it here only says that `finish` runs its
 * two writes against one transaction rather than two connections.
 */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The battle store, against the real database.
 *
 * No feature import, for the same reason every adapter here carries none:
 * infrastructure may not depend on the layers that consume it. The shapes below
 * are declared locally and `apps/web` asserts conformance at the one call site
 * where the feature's port and this implementation are both in scope.
 *
 * ## Every move is one statement
 *
 * The port says each move takes the state it expects and the store performs the
 * check and the write together, because a join that read the participants, counted
 * them, decided there was room and then wrote would let two sessions both believe
 * they are the second fighter — and the loser's score would be judged against a
 * battle it is not in. The reads below are therefore not a convenience; they are
 * the WHERE clauses.
 */

/** A battle as this adapter reads it. */
export interface BattleRow {
  readonly id: string;
  readonly mode: string;
  readonly bountyId: string | null;
  readonly weightsJson: unknown;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly pausedAt: string | null;
  readonly resumeDeadline: string | null;
}

export interface BattleParticipantRow {
  readonly battleId: string;
  readonly sessionId: string;
  readonly joinedAt: string;
  readonly submittedAt: string | null;
  readonly won: boolean;
  readonly scoreJson: unknown;
}

export type JoinRefusalRow = 'not-found' | 'not-running' | 'full' | 'already-in-it';

export type JoinOutcomeRow =
  | {
      readonly joined: true;
      readonly battle: BattleRow;
      readonly participants: readonly BattleParticipantRow[];
    }
  | { readonly joined: false; readonly why: JoinRefusalRow; readonly battle?: BattleRow };

export interface BattleStore {
  create(input: {
    readonly mode: string;
    readonly bountyId: string | null;
    readonly weightsJson: unknown;
    readonly creatorSessionId: string;
    readonly now: string;
  }): Promise<BattleRow>;
  findById(battleId: string): Promise<BattleRow | undefined>;
  /**
   * A battle by the public handle its replay link carries.
   *
   * The only lookup the logged-out replay path performs, and it is deliberately
   * narrow: it answers whether a battle EXISTS behind a link and returns its
   * internal id so the caller can read the log. Nothing the row says about the
   * battle is used to build the replay, because the replay is a projection of
   * the event log and a table that could contradict it is a second source for
   * one fact.
   */
  findByReplayId(replayId: string): Promise<BattleRow | undefined>;
  list(filter: { readonly status?: string }): Promise<readonly BattleRow[]>;
  participants(battleId: string): Promise<readonly BattleParticipantRow[]>;
  /**
   * Every live battle a session is in, and each one's participants.
   *
   * The Battle#918 query. Keyed on `session_id` throughout, with no join to
   * `agents` anywhere near it: the query that keeps two concurrent sessions of
   * one character apart must not go through the one field they share.
   */
  battlesForSession(sessionId: string): Promise<
    readonly {
      readonly battle: BattleRow;
      readonly participants: readonly BattleParticipantRow[];
    }[]
  >;
  join(battleId: string, sessionId: string, capacity: number, now: string): Promise<JoinOutcomeRow>;
  move(
    battleId: string,
    from: BattleStatus,
    to: BattleStatus,
    now: string,
  ): Promise<BattleRow | undefined>;
  pause(battleId: string, resumeDeadline: string, now: string): Promise<BattleRow | undefined>;
  finish(finish: {
    readonly battleId: string;
    readonly from: BattleStatus;
    readonly to: BattleStatus;
    readonly results: readonly {
      readonly sessionId: string;
      readonly scoreJson: unknown;
      readonly submittedAt: string;
      readonly won: boolean;
    }[];
    readonly now: string;
  }): Promise<BattleRow | undefined>;
  pausedBefore(deadline: string): Promise<readonly BattleRow[]>;
}

export class DrizzleBattleRepository implements BattleStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async create(input: {
    mode: string;
    bountyId: string | null;
    weightsJson: unknown;
    creatorSessionId: string;
    now: string;
  }): Promise<BattleRow> {
    // The battle and its creator in ONE statement, via a CTE. Two statements
    // would leave a window in which the battle exists with no participant, and a
    // battle nobody is in cannot be joined, finished or abandoned — it is a
    // battle that hangs for ever, which is the one outcome the sweep exists to
    // prevent.
    const result = await this.#database.execute<{ id: string }>(sql`
      WITH created AS (
        INSERT INTO battles (mode, bounty_id, weights_json, status, started_at)
        VALUES (${input.mode}, ${input.bountyId}, ${JSON.stringify(input.weightsJson)}::jsonb, 'running', ${new Date(input.now)})
        RETURNING id
      )
      INSERT INTO battle_participants (battle_id, session_id, joined_at)
      SELECT created.id, ${input.creatorSessionId}, ${new Date(input.now)} FROM created
      RETURNING battle_id::text AS id
    `);
    const battle = await this.findById(result.rows[0]?.id ?? '');
    if (battle === undefined) {
      throw new Error('a battle was created and could not be read back');
    }
    return battle;
  }

  async findById(battleId: string): Promise<BattleRow | undefined> {
    const rows = await this.#database
      .select()
      .from(battles)
      .where(eq(battles.id, battleId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : toBattleRow(row);
  }

  async findByReplayId(replayId: string): Promise<BattleRow | undefined> {
    const rows = await this.#database
      .select()
      .from(battles)
      .where(eq(battles.replayId, replayId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : toBattleRow(row);
  }

  async list(filter: { status?: string }): Promise<readonly BattleRow[]> {
    // `::text` on the column rather than a typed comparison: the filter takes a
    // plain string because the feature stores a status it has not necessarily
    // recognised, and narrowing the column to the union here would make an
    // unrecognised value unqueryable — which is exactly the row a reader most
    // needs to be able to find.
    const where =
      filter.status === undefined ? undefined : sql`${battles.status}::text = ${filter.status}`;
    const rows = await this.#database
      .select()
      .from(battles)
      .where(where)
      .orderBy(asc(battles.startedAt), asc(battles.id));
    return rows.map(toBattleRow);
  }

  async participants(battleId: string): Promise<readonly BattleParticipantRow[]> {
    const rows = await this.#database
      .select()
      .from(battleParticipants)
      .where(eq(battleParticipants.battleId, battleId))
      .orderBy(asc(battleParticipants.joinedAt), asc(battleParticipants.sessionId));
    return rows.map(toParticipantRow);
  }

  async battlesForSession(sessionId: string) {
    // The join is on session_id and nothing else. There is deliberately no path
    // from this query to `agents.id`: a store that resolved the agent here would
    // make it possible for two battles of one character to be found through each
    // other, which is the bug the schema's `battle_participants` key exists to
    // make impossible.
    const rows = await this.#database
      .select({ battleId: battleParticipants.battleId })
      .from(battleParticipants)
      .where(eq(battleParticipants.sessionId, sessionId));

    if (rows.length === 0) {
      return [];
    }
    const battleIds = rows.map((row) => row.battleId);
    const found = await this.#database
      .select()
      .from(battles)
      .where(inArray(battles.id, battleIds))
      .orderBy(asc(battles.startedAt), asc(battles.id));
    return Promise.all(
      found.map(async (battle) => ({
        battle: toBattleRow(battle),
        participants: await this.participants(battle.id),
      })),
    );
  }

  async join(
    battleId: string,
    sessionId: string,
    capacity: number,
    now: string,
  ): Promise<JoinOutcomeRow> {
    // Read first, only to tell the four refusals apart. The INSERT that follows
    // carries the real condition: `battle_id = $1 AND status = 'running' AND
    // (SELECT count(*) ...) < capacity`, all in one statement, so the capacity is
    // enforced by the engine rather than by a decision a concurrent caller could
    // invalidate between the two.
    const battle = await this.findById(battleId);
    if (battle === undefined) {
      return { joined: false, why: 'not-found' };
    }
    if (battle.status !== 'running') {
      return { joined: false, why: 'not-running', battle };
    }
    const existing = await this.participants(battleId);
    if (existing.some((row) => row.sessionId === sessionId)) {
      return { joined: false, why: 'already-in-it', battle };
    }

    // WHY THIS IS A TRANSACTION AND NOT ONE STATEMENT, because the comment that
    // used to be here claimed otherwise and was wrong in a way that only showed
    // up under load.
    //
    // It said `FOR UPDATE` on the battle row was the mutex, that the second
    // transaction "blocks on the row lock until the first commits, and then its
    // count sees the first's participant". It blocks. Its count does not see it.
    //
    // Under READ COMMITTED a statement's snapshot is taken when the statement
    // STARTS. The second join starts, blocks inside the CTE on the row lock, and
    // by the time the first commits the second statement's snapshot is already
    // fixed — so `count(*)` still reads 1, `1 < 2` is true, and it inserts. Three
    // participants in a two-seat battle, which is the outcome the comment names
    // as the thing the mutex prevents. Measured: 28-38 oversells in 40 races,
    // against a test that passed 15 times out of 15 in isolation and failed once
    // under a full-suite run. `ON CONFLICT DO NOTHING` is no help — the conflict
    // target is (battle_id, session_id) and the two racers are DIFFERENT
    // sessions, so there is no conflict to do nothing about.
    //
    // So the mutex is taken in its OWN statement and the count is read in a
    // LATER one, which is the only ordering under which a fresh snapshot is even
    // possible. `pg_advisory_xact_lock` rather than the row lock because it is
    // keyed on the battle rather than on a row that does not exist yet — the row
    // to lock for "the second seat" is the seat, and there is no such row. It is
    // transaction-scoped, so the enclosing transaction holds it, and no advisory
    // lock is ever left behind by a crash.
    //
    // The capacity test still lives in the INSERT rather than in a read before
    // it, which is the part of the original design that was right: the decision
    // and the write are one statement, so nothing can invalidate the decision
    // between them. What changed is only WHICH snapshot the decision reads.
    const inserted = await this.#database.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${battleId}, 0))`);
      return tx.execute<{ session_id: string }>(sql`
        WITH locked AS (
          SELECT id, status FROM battles WHERE id = ${battleId}
        )
        INSERT INTO battle_participants (battle_id, session_id, joined_at)
        SELECT locked.id, ${sessionId}, ${new Date(now)}
        FROM locked
        WHERE locked.status = 'running'
          AND (SELECT count(*)::int FROM battle_participants p WHERE p.battle_id = locked.id) < ${capacity}
        ON CONFLICT DO NOTHING
        RETURNING session_id
      `);
    });

    if (inserted.rows.length === 0) {
      // Somebody else took the last place, or the battle stopped running between
      // the read above and this insert. Re-reading is the only way to tell which,
      // and the caller is told it lost either way.
      const after = await this.findById(battleId);
      const still = await this.participants(battleId);
      const why: JoinRefusalRow =
        after === undefined
          ? 'not-found'
          : after.status !== 'running'
            ? 'not-running'
            : still.some((row) => row.sessionId === sessionId)
              ? 'already-in-it'
              : 'full';
      return after === undefined ? { joined: false, why } : { joined: false, why, battle: after };
    }
    return {
      joined: true,
      battle: battle as BattleRow,
      participants: await this.participants(battleId),
    };
  }

  async move(
    battleId: string,
    from: BattleStatus,
    to: BattleStatus,
    now: string,
  ): Promise<BattleRow | undefined> {
    const rows = await this.#database
      .update(battles)
      .set({
        status: to,
        // A resumed battle is running again, so the pause it was in is over and
        // the columns describing it are cleared. Left in place they would say a
        // running battle is still waiting for somebody.
        ...(to === 'running' ? { pausedAt: null, resumeDeadline: null } : {}),
        ...(isEnding(to) ? { finishedAt: new Date(now) } : {}),
      })
      .where(and(eq(battles.id, battleId), eq(battles.status, from)))
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : toBattleRow(row);
  }

  async pause(
    battleId: string,
    resumeDeadline: string,
    now: string,
  ): Promise<BattleRow | undefined> {
    const rows = await this.#database
      .update(battles)
      .set({ status: 'paused', pausedAt: new Date(now), resumeDeadline: new Date(resumeDeadline) })
      .where(and(eq(battles.id, battleId), eq(battles.status, 'running')))
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : toBattleRow(row);
  }

  async finish(finish: {
    battleId: string;
    from: BattleStatus;
    to: BattleStatus;
    results: readonly {
      sessionId: string;
      scoreJson: unknown;
      submittedAt: string;
      won: boolean;
    }[];
    now: string;
  }): Promise<BattleRow | undefined> {
    // ONE TRANSACTION, AND THE STATE MOVE GOES FIRST.
    //
    // This was scores-first-then-move, on the reasoning that a partial score
    // write is the recoverable direction. It is not, and the integration suite is
    // what proved it: two hosts racing a finish, the first commits {total: 0.9},
    // the second's conditional move matches nothing and returns undefined — and
    // the second's scores, {total: 0.1}, have already been written. The caller
    // sees "you lost" and the database holds the loser's arithmetic under the
    // winner's name.
    //
    // The move first inverts it correctly: the conditional UPDATE is the gate, so
    // a caller that loses the race returns before touching a score, and the
    // transaction means a failure part-way through leaves the battle running with
    // its old scores rather than finished with none. Both halves are needed: the
    // gate alone still leaves a crash between the move and the scores, which is a
    // finished battle that pays nobody and can be neither shown nor disputed.
    return this.#database.transaction(async (tx: Transaction) => {
      const moved = await tx
        .update(battles)
        .set({
          status: finish.to,
          ...(isEnding(finish.to) ? { finishedAt: new Date(finish.now) } : {}),
        })
        .where(and(eq(battles.id, finish.battleId), eq(battles.status, finish.from)))
        .returning();

      const row = moved[0];
      if (row === undefined) {
        return undefined;
      }
      for (const result of finish.results) {
        await tx
          .update(battleParticipants)
          .set({
            scoreJson: result.scoreJson as Record<string, unknown>,
            submittedAt: new Date(result.submittedAt),
            won: result.won ? 1 : 0,
          })
          .where(
            and(
              eq(battleParticipants.battleId, finish.battleId),
              eq(battleParticipants.sessionId, result.sessionId),
            ),
          );
      }
      return toBattleRow(row);
    });
  }

  async pausedBefore(deadline: string): Promise<readonly BattleRow[]> {
    const rows = await this.#database
      .select()
      .from(battles)
      .where(
        and(
          eq(battles.status, 'paused'),
          isNotNull(battles.resumeDeadline),
          lte(battles.resumeDeadline, new Date(deadline)),
        ),
      )
      .orderBy(asc(battles.resumeDeadline), asc(battles.id));
    return rows.map(toBattleRow);
  }
}

/** The states a battle can be ended into, which is what stamps `finished_at`. */
function isEnding(status: BattleStatus): boolean {
  return status === 'completed' || status === 'abandoned' || status === 'expired';
}

function toBattleRow(row: typeof battles.$inferSelect): BattleRow {
  return {
    id: row.id,
    mode: row.mode,
    bountyId: row.bountyId,
    weightsJson: row.weightsJson,
    // The raw string, NOT narrowed to the union. A row written by a future build
    // can carry a state this one has never heard of, and the feature's answer to
    // that is to refuse every move on it — which it cannot do if the adapter has
    // already thrown the value away or, worse, coerced it to something legal.
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    resumeDeadline: row.resumeDeadline?.toISOString() ?? null,
  };
}

function toParticipantRow(row: typeof battleParticipants.$inferSelect): BattleParticipantRow {
  return {
    battleId: row.battleId,
    sessionId: row.sessionId,
    joinedAt: row.joinedAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    // `won` is an integer column with a CHECK, so `row.won === 1` is the only
    // truthy value a conforming row can hold. Anything else is stored corruption
    // and reads as false rather than as a winner.
    won: row.won === 1,
    scoreJson: row.scoreJson,
  };
}
