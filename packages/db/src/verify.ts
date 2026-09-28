import { sql } from 'drizzle-orm';

import { closeDatabasePool, createDatabase, createDatabasePool } from './client.js';
import { applyMigrations } from './migrate.js';
import {
  FEATURE_TABLES,
  OWNED_TABLES,
  PLATFORM_TABLES,
  PLATFORM_TABLES_OWNING_USER_ID,
} from './schema/ownership.js';
import { seedDatabase } from './seed/seed.js';
import { SEEDED_BOUNTY_TOTAL_CENTS, SEED_BOUNTY } from './seed/fixtures.js';
import type { Database } from './client.js';

const PUBLIC_SCHEMA = 'public';
const MONEY_FLOAT_TYPES: readonly string[] = ['numeric', 'real', 'double precision'];
const MONEY_COLUMN_TABLES: readonly string[] = [
  'bounties',
  'bounty_funds',
  'payout_intents',
  'guild_treasury_entries',
];
// payout_intents.amount_cents is a STATED TARGET, not a stored total, and it is
// still money: a float there loses a cent and the refund arithmetic in
// docs/design/payout-rail.md section 3.1 stops reconciling. Listed so the
// integer-cents check covers it rather than only the tables that existed when
// the check was written.
const REQUIRED_MONEY_COLUMNS: readonly string[] = [
  'bounty_funds.amount_cents',
  'payout_intents.amount_cents',
  'guild_treasury_entries.amount_cents',
];
const EVENTS_SEQUENCE_TABLE = 'event_log';
const EVENT_LOG_PROBE_TYPE = 'verify.probe';
const EVENT_LOG_PROBE_ACTOR = 'verify';

export class SchemaVerificationError extends Error {
  constructor(failures: readonly string[]) {
    super(`Schema verification failed:\n${failures.map((failure) => `  - ${failure}`).join('\n')}`);
    this.name = 'SchemaVerificationError';
  }
}

interface TableNameRow {
  readonly table_name: string;
}

interface ColumnRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
}

interface ForeignKeyRow extends ColumnRow {
  readonly foreign_table_name: string;
  readonly foreign_column_name: string;
}

interface PrimaryKeyRow extends ColumnRow {
  readonly ordinal_position: number;
}

interface CheckConstraintRow {
  readonly table_name: string;
  readonly constraint_name: string;
  readonly check_clause: string;
}

interface CountRow {
  readonly row_count: number;
}

interface ColumnDefaultRow {
  readonly column_default: string | null;
}

interface ProbeIdRow {
  readonly id: number;
}

interface FundingTotalRow {
  readonly bounty_id: string;
  readonly funded_cents: number;
  readonly sponsor_count: number;
}

export interface SchemaSnapshot {
  readonly tableNames: readonly string[];
  readonly columns: readonly ColumnRow[];
  readonly foreignKeys: readonly ForeignKeyRow[];
  readonly primaryKeys: readonly PrimaryKeyRow[];
  readonly checkConstraints: readonly CheckConstraintRow[];
}

async function readRows<TRow>(result: unknown, label: string): Promise<readonly TRow[]> {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    throw new Error(`Expected ${label} to return a row array`);
  }
  const rows: unknown = (result as { rows: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new Error(`Expected ${label} rows to be an array`);
  }
  return rows as readonly TRow[];
}

async function readSchemaSnapshot(database: Database): Promise<SchemaSnapshot> {
  const tableNames = await readRows<TableNameRow>(
    await database.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${PUBLIC_SCHEMA} AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `),
    'tables',
  );

  const columns = await readRows<ColumnRow>(
    await database.execute(sql`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = ${PUBLIC_SCHEMA}
      ORDER BY table_name, ordinal_position
    `),
    'columns',
  );

  const foreignKeys = await readRows<ForeignKeyRow>(
    await database.execute(sql`
      SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name,
             ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.table_schema = ${PUBLIC_SCHEMA} AND tc.constraint_type = 'FOREIGN KEY'
      ORDER BY tc.table_name, kcu.column_name
    `),
    'foreign keys',
  );

  const primaryKeys = await readRows<PrimaryKeyRow>(
    await database.execute(sql`
      SELECT tc.table_name, kcu.column_name, kcu.ordinal_position
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      WHERE tc.table_schema = ${PUBLIC_SCHEMA} AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY tc.table_name, kcu.ordinal_position
    `),
    'primary keys',
  );

  const checkConstraints = await readRows<CheckConstraintRow>(
    await database.execute(sql`
      SELECT tc.table_name, tc.constraint_name, cc.check_clause
      FROM information_schema.table_constraints tc
      JOIN information_schema.check_constraints cc
        ON cc.constraint_name = tc.constraint_name AND cc.constraint_schema = tc.table_schema
      WHERE tc.table_schema = ${PUBLIC_SCHEMA} AND tc.constraint_type = 'CHECK'
      ORDER BY tc.table_name, cc.check_clause
    `),
    'check constraints',
  );

  return {
    tableNames: tableNames.map((row) => row.table_name),
    columns,
    foreignKeys,
    primaryKeys,
    checkConstraints,
  };
}

function columnNames(snapshot: SchemaSnapshot, tableName: string): readonly string[] {
  return snapshot.columns
    .filter((column) => column.table_name === tableName)
    .map((column) => column.column_name);
}

function findForeignKey(
  snapshot: SchemaSnapshot,
  tableName: string,
  columnName: string,
): ForeignKeyRow | undefined {
  return snapshot.foreignKeys.find(
    (key) => key.table_name === tableName && key.column_name === columnName,
  );
}

export function checkTablesExist(snapshot: SchemaSnapshot): readonly string[] {
  const actual = new Set(snapshot.tableNames);
  return OWNED_TABLES.filter((table) => !actual.has(table)).map(
    (table) => `missing table "${table}" from the platform/feature ownership manifest`,
  );
}

/**
 * Every check the schema declares, by table and name.
 *
 * `readSchemaSnapshot` has always collected `checkConstraints` and nothing has
 * ever read it, so deleting a constraint left the database able to accept a
 * negative amount while every gate stayed green: the money is enforced by
 * these constraints and by nothing else at the storage layer. A collected
 * field that no assertion reads is the same defect as no guard at all, so the
 * manifest is here and the check below is what reads it.
 *
 * Matching is by constraint NAME, not by clause text. Postgres reports every
 * NOT NULL as a CHECK, so `amount_cents IS NOT NULL` is a row in the same
 * table as the real money guard. A substring match on the column name is
 * satisfied by the NOT NULL row, which is a passing check that guards nothing.
 * The name is what distinguishes the constraint, and the clause is only read
 * to confirm it still mentions the column it is supposed to protect.
 */
const REQUIRED_CHECK_CONSTRAINTS: readonly {
  readonly table: string;
  readonly name: string;
  readonly mustMention: string;
}[] = [
  {
    table: 'bounty_funds',
    name: 'bounty_funds_amount_cents_non_negative',
    mustMention: 'amount_cents',
  },
  {
    table: 'payout_intents',
    name: 'payout_intents_amount_cents_non_negative',
    mustMention: 'amount_cents',
  },
  {
    // The attribution rule, enforced where the row is written. payout.ts refuses
    // to build an intent with an empty reporter, and this is what makes a row
    // written by anything else obey the same rule.
    table: 'payout_intents',
    name: 'payout_intents_reported_by_not_empty',
    mustMention: 'reported_by',
  },
  { table: 'bounties', name: 'bounties_issue_number_positive', mustMention: 'issue_number' },
  {
    // The dedup key's domain. Without it, a row written by anything that is not
    // this adapter can carry a kind the feature has no case for, and the unique
    // index would then be refusing to double-count two rows the feature reads
    // as the same outcome.
    table: 'reputation_outcomes',
    name: 'reputation_outcomes_kind_known',
    mustMention: 'kind',
  },
  {
    // An empty bounty id is a key nothing can be recognised by, so a row
    // carrying one disables the dedup for the outcomes it claims to cover.
    table: 'reputation_outcomes',
    name: 'reputation_outcomes_bounty_id_not_empty',
    mustMention: 'bounty_id',
  },
  { table: 'agents', name: 'agents_level_min', mustMention: 'level' },
  { table: 'agents', name: 'agents_xp_non_negative', mustMention: 'xp' },
  { table: 'agents', name: 'agents_reputation_non_negative', mustMention: 'reputation' },
  { table: 'sessions', name: 'sessions_disconnected_has_ended_at', mustMention: 'ended_at' },
  { table: 'agent_stats', name: 'agent_stats_prs_opened_non_negative', mustMention: 'prs_opened' },
  { table: 'agent_stats', name: 'agent_stats_prs_merged_non_negative', mustMention: 'prs_merged' },
  {
    table: 'agent_stats',
    name: 'agent_stats_prs_rejected_non_negative',
    mustMention: 'prs_rejected',
  },
  {
    table: 'agent_stats',
    name: 'agent_stats_tests_passed_non_negative',
    mustMention: 'tests_passed',
  },
  {
    table: 'agent_stats',
    name: 'agent_stats_tests_failed_non_negative',
    mustMention: 'tests_failed',
  },
  { table: 'agent_stats', name: 'agent_stats_recoveries_non_negative', mustMention: 'recoveries' },
  {
    table: 'agent_stats',
    name: 'agent_stats_battles_won_non_negative',
    mustMention: 'battles_won',
  },
  {
    table: 'agent_stats',
    name: 'agent_stats_battles_lost_non_negative',
    mustMention: 'battles_lost',
  },
];

export function checkRequiredCheckConstraints(snapshot: SchemaSnapshot): readonly string[] {
  const problems: string[] = [];
  for (const required of REQUIRED_CHECK_CONSTRAINTS) {
    const found = snapshot.checkConstraints.find(
      (constraint) =>
        constraint.table_name === required.table && constraint.constraint_name === required.name,
    );
    if (found === undefined) {
      problems.push(`check constraint "${required.name}" is missing from "${required.table}"`);
      continue;
    }
    if (!found.check_clause.includes(required.mustMention)) {
      problems.push(
        `check constraint "${required.name}" no longer mentions ${required.mustMention}, ` +
          `so it no longer guards the column it was written for`,
      );
    }
  }
  return problems;
}

export function checkAgentIdentityInvariant(snapshot: SchemaSnapshot): readonly string[] {
  const failures: string[] = [];
  const sessionColumns = columnNames(snapshot, 'sessions');
  const agentIdKey = findForeignKey(snapshot, 'sessions', 'agent_id');

  if (!sessionColumns.includes('agent_id')) {
    failures.push('sessions.agent_id is missing; agent identity must hang off agents.id');
  }
  if (agentIdKey === undefined || agentIdKey.foreign_table_name !== 'agents') {
    failures.push('sessions.agent_id must reference agents.id');
  }

  const userScoped = sessionColumns.filter((column) => column.includes('user'));
  if (userScoped.length > 0) {
    failures.push(`sessions must carry no user identity column, found: ${userScoped.join(', ')}`);
  }
  return failures;
}

export function checkUserIdOwnership(snapshot: SchemaSnapshot): readonly string[] {
  const allowed = new Set<string>(PLATFORM_TABLES_OWNING_USER_ID);
  return snapshot.columns
    .filter((column) => column.column_name === 'user_id' && !allowed.has(column.table_name))
    .map((column) => `table "${column.table_name}" owns a user_id column outside the platform set`);
}

export function checkCredentialStoresOnlyHashes(snapshot: SchemaSnapshot): readonly string[] {
  const columns = columnNames(snapshot, 'agent_credentials');
  if (!columns.includes('token_hash')) {
    return ['agent_credentials.token_hash is missing'];
  }
  const rawTokenColumns = columns.filter(
    (column) => column.includes('token') && column !== 'token_hash',
  );
  return rawTokenColumns.map(
    (column) => `agent_credentials must not store a raw token, found column "${column}"`,
  );
}

export function checkMoneyIsIntegerCents(snapshot: SchemaSnapshot): readonly string[] {
  const failures: string[] = [];
  const moneyColumns = snapshot.columns.filter((column) =>
    MONEY_COLUMN_TABLES.includes(column.table_name),
  );

  for (const column of moneyColumns) {
    if (MONEY_FLOAT_TYPES.includes(column.data_type)) {
      failures.push(
        `${column.table_name}.${column.column_name} is ${column.data_type}; money must be integer cents`,
      );
    }
  }

  const present = new Set(
    moneyColumns
      .filter((column) => column.column_name.endsWith('_cents'))
      .map((column) => `${column.table_name}.${column.column_name}`),
  );
  for (const required of REQUIRED_MONEY_COLUMNS) {
    if (!present.has(required)) {
      failures.push(`missing required money column "${required}"`);
    }
  }

  // The `bounties.amount_cents` scalar this function used to forbid here is
  // forbidden by checkNoCachedTotals instead, and the message is byte-identical.
  // Keeping both would report every violation twice, which trains a reader to
  // skim past the one that matters.
  return failures;
}

/**
 * Scalars the guild feature must never grow, and what derives each one instead.
 *
 * `bounties.amount_cents` is already forbidden above, and it was forbidden
 * because a stored total is right until the second funder arrives and then is
 * right about nothing. The guild feature sits on the same money and the same
 * scoreboard, so the same failure is available twice over: a cached treasury
 * balance that disagrees with the entries behind it, and a cached quest counter
 * that disagrees with the work log. Either one turns a guild's standing into a
 * number nobody can reconstruct, and §10.4's no-pay-to-win rule is a claim
 * about the economy being honest — which it cannot be while the score is
 * stored and the evidence is not.
 *
 * Declared as data rather than as two hand-written blocks, because the block
 * form is where a third table's rule would be forgotten. `derivedFrom` is in
 * the message because an operator reading the failure needs to know what to
 * read the number from instead.
 */
const FORBIDDEN_CACHED_TOTALS: readonly {
  readonly table: string;
  readonly columns: readonly string[];
  readonly derivedFrom: string;
}[] = [
  {
    table: 'bounties',
    columns: ['amount_cents'],
    derivedFrom: 'bounty_funds',
  },
  {
    table: 'guilds',
    // Any money-shaped column, not a named one: a balance called `treasury` or
    // `funds` is the same defect wearing a different noun, and this check is
    // the only thing standing between the two.
    columns: ['amount_cents', 'balance_cents'],
    derivedFrom: 'guild_treasury_entries',
  },
  {
    table: 'guild_quests',
    columns: ['progress'],
    derivedFrom: 'guild_work_log',
  },
];

export function checkNoCachedTotals(snapshot: SchemaSnapshot): readonly string[] {
  const failures: string[] = [];
  for (const rule of FORBIDDEN_CACHED_TOTALS) {
    const present = columnNames(snapshot, rule.table);
    for (const column of rule.columns) {
      if (present.includes(column)) {
        failures.push(
          `${rule.table}.${column} stores a drifting scalar; the total must be derived from ` +
            `${rule.derivedFrom}`,
        );
      }
    }
  }
  return failures;
}

export function checkBattleParticipantIdentity(snapshot: SchemaSnapshot): readonly string[] {
  const failures: string[] = [];
  const participants = columnNames(snapshot, 'battle_participants');
  const keyColumns = snapshot.primaryKeys
    .filter((key) => key.table_name === 'battle_participants')
    .sort((left, right) => left.ordinal_position - right.ordinal_position)
    .map((key) => key.column_name);

  if (keyColumns.join(',') !== 'battle_id,session_id') {
    failures.push(
      `battle_participants primary key must be (battle_id, session_id), found (${keyColumns.join(', ')})`,
    );
  }
  if (participants.includes('agent_id')) {
    failures.push('battle_participants must reference sessions, not agents');
  }

  const sessionKey = findForeignKey(snapshot, 'battle_participants', 'session_id');
  if (sessionKey?.foreign_table_name !== 'sessions') {
    failures.push('battle_participants.session_id must reference sessions.id');
  }
  return failures;
}

export function checkBattleReplayHandle(snapshot: SchemaSnapshot): readonly string[] {
  const failures: string[] = [];
  const battles = columnNames(snapshot, 'battles');
  if (!battles.includes('replay_id')) {
    failures.push(
      'battles.replay_id is missing. It is the only handle a public replay link carries, ' +
        'and without it every shared link is either a guess at battles.id or a dead link.',
    );
    return failures;
  }
  return failures;
}

/**
 * The public handle is present, random and one-per-battle.
 *
 * The three properties are the ones a bulk scrape of every battle on the
 * platform would need, and the third is the only one a column list can answer:
 * a shared link resolving to two battles is not an address. The first two are
 * read out of `information_schema` rather than assumed, because the assumption
 * is exactly what a later migration would quietly break — swapping a random
 * default for a sequence keeps the column, keeps it non-null, and turns the
 * platform's entire battle history into an enumerable list.
 */
async function checkBattleReplayIds(database: Database): Promise<readonly string[]> {
  const failures: string[] = [];
  const columns = await readRows<ColumnDefaultRow>(
    await database.execute(sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = ${PUBLIC_SCHEMA} AND table_name = 'battles' AND column_name = 'replay_id'
    `),
    'battles.replay_id default',
  );
  const columnDefault = columns[0]?.column_default;
  if (columnDefault === undefined || columnDefault === null) {
    failures.push('battles.replay_id has no default, so a battle is created with no public link');
  } else if (!columnDefault.includes('gen_random_uuid()')) {
    failures.push(
      `battles.replay_id defaults to "${columnDefault}", which is not a random value. A public ` +
        'handle that is sequential lets anybody enumerate every battle on the platform.',
    );
  }

  const duplicates = await readRows<CountRow>(
    await database.execute(sql`
      SELECT COUNT(*)::integer AS row_count FROM (
        SELECT replay_id FROM battles WHERE replay_id IS NOT NULL
        GROUP BY replay_id HAVING COUNT(*) > 1
      ) duplicated
    `),
    'duplicate battles.replay_id',
  );
  if ((duplicates[0]?.row_count ?? 0) > 0) {
    failures.push(
      'two or more battles share a replay_id, so a shared link does not identify one battle',
    );
  }
  return failures;
}

export function checkPlatformAndFeatureSplit(snapshot: SchemaSnapshot): readonly string[] {
  const managed = new Set<string>([...PLATFORM_TABLES, ...FEATURE_TABLES]);
  return snapshot.tableNames
    .filter((table) => !managed.has(table) && !table.startsWith('drizzle'))
    .map((table) => `table "${table}" is not assigned to the platform or a feature`);
}

async function readFundingTotal(database: Database): Promise<FundingTotalRow | undefined> {
  try {
    const rows = await readRows<FundingTotalRow>(
      await database.execute(sql`
        SELECT bounty_id, funded_cents, sponsor_count FROM bounty_funding_totals
        WHERE bounty_id = ${SEED_BOUNTY.id}
      `),
      'bounty funding totals',
    );
    return rows[0];
  } catch {
    return undefined;
  }
}

async function countRowsOwnedTables(database: Database): Promise<readonly number[]> {
  const counts: number[] = [];
  for (const table of OWNED_TABLES) {
    const rows = await readRows<CountRow>(
      await database.execute(
        sql`SELECT COUNT(*)::integer AS row_count FROM ${sql.identifier(table)}`,
      ),
      `count for ${table}`,
    );
    counts.push(rows[0]?.row_count ?? 0);
  }
  return counts;
}

async function checkSeedIsIdempotent(database: Database): Promise<readonly string[]> {
  await seedDatabase(database);
  const firstRun = await countRowsOwnedTables(database);
  await seedDatabase(database);
  const secondRun = await countRowsOwnedTables(database);

  return firstRun
    .map((count, index) => ({
      table: OWNED_TABLES[index] ?? 'unknown',
      count,
      after: secondRun[index],
    }))
    .filter(({ count, after }) => count !== after)
    .map(
      ({ table, count, after }) =>
        `re-running the seed changed "${table}" from ${String(count)} to ${String(after)} rows`,
    );
}

async function checkEventLogSequenceIsWritable(database: Database): Promise<readonly string[]> {
  try {
    const inserted = await database.execute(sql`
      INSERT INTO ${sql.identifier(EVENTS_SEQUENCE_TABLE)} (type, actor_id)
      VALUES (${EVENT_LOG_PROBE_TYPE}, ${EVENT_LOG_PROBE_ACTOR})
      RETURNING id
    `);
    const rows = await readRows<ProbeIdRow>(inserted, 'event log probe');
    return rows.length === 1
      ? []
      : ['event_log sequence is not writable after seeding explicit ids'];
  } catch {
    return ['event_log sequence is not writable after seeding explicit ids'];
  } finally {
    await removeEventLogProbe(database);
  }
}

async function removeEventLogProbe(database: Database): Promise<void> {
  await database.execute(sql`
    DELETE FROM ${sql.identifier(EVENTS_SEQUENCE_TABLE)}
    WHERE type = ${EVENT_LOG_PROBE_TYPE} AND actor_id = ${EVENT_LOG_PROBE_ACTOR}
  `);
}

export async function runSchemaVerification(database: Database): Promise<readonly string[]> {
  await applyMigrations(database);
  const snapshot = await readSchemaSnapshot(database);
  const funding = await readFundingTotal(database);

  const failures: string[] = [
    ...checkTablesExist(snapshot),
    ...checkRequiredCheckConstraints(snapshot),
    ...checkPlatformAndFeatureSplit(snapshot),
    ...checkAgentIdentityInvariant(snapshot),
    ...checkUserIdOwnership(snapshot),
    ...checkCredentialStoresOnlyHashes(snapshot),
    ...checkMoneyIsIntegerCents(snapshot),
    ...checkNoCachedTotals(snapshot),
    ...checkBattleParticipantIdentity(snapshot),
    ...checkBattleReplayHandle(snapshot),
  ];

  if (funding === undefined) {
    failures.push('bounty_funding_totals view is missing or returned no row for the seeded bounty');
  } else {
    if (funding.funded_cents !== SEEDED_BOUNTY_TOTAL_CENTS) {
      failures.push(
        `bounty total should derive to ${String(SEEDED_BOUNTY_TOTAL_CENTS)} cents, ` +
          `got ${String(funding.funded_cents)}`,
      );
    }
    if (funding.sponsor_count !== 2) {
      failures.push(`seeded bounty should have 2 sponsors, got ${String(funding.sponsor_count)}`);
    }
  }

  failures.push(...(await checkSeedIsIdempotent(database)));
  failures.push(...(await checkEventLogSequenceIsWritable(database)));
  failures.push(...(await checkBattleReplayIds(database)));
  return failures;
}

// The migrations stage runs this before the seed exists, so it needs a mode
// that checks shape only. Without it, "db:verify -- --tables-only" would run the
// full data assertions and fail on an unseeded database, which is the opposite
// of what the flag is for.
const TABLES_ONLY_FLAG = '--tables-only';

async function verifyTablesExist(database: Database): Promise<readonly string[]> {
  const result = await database.execute<{ table_name: string }>(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = ${PUBLIC_SCHEMA}`,
  );
  const present = new Set(result.rows.map((row: { table_name: string }) => row.table_name));
  // `OWNED_TABLES` rather than a list written out here, and this is the one
  // place that difference showed up as a hole in the gate.
  //
  // The list this used to name thirty of the thirty-two tables in
  // `OWNED_TABLES` and never heard of `agent_reputation` or `agent_bases`, both
  // of which their feature migrations create. Dropping either one left this
  // reporting "Migrated tables are present" — the stage whose whole job is
  // proving the migration applied was the stage that had the hole, which is the
  // failure AGENTS.md names when it warns that a migration reporting success is
  // not proof. A second list was never going to stay current: the drift was
  // silent, and `pnpm db:seed` is what noticed the previous one, long after it
  // landed.
  return OWNED_TABLES.filter((table) => !present.has(table)).map(
    (table) => `table "${table}" does not exist, so the migration did not apply`,
  );
}

async function main(): Promise<void> {
  const pool = createDatabasePool();
  try {
    const database = createDatabase(pool);
    const tablesOnly = process.argv.includes(TABLES_ONLY_FLAG);
    const failures = tablesOnly
      ? await verifyTablesExist(database)
      : await runSchemaVerification(database);
    if (failures.length > 0) {
      throw new SchemaVerificationError(failures);
    }
    process.stdout.write(
      tablesOnly ? 'Migrated tables are present.\n' : 'Schema verification passed.\n',
    );
  } finally {
    await closeDatabasePool(pool);
  }
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
