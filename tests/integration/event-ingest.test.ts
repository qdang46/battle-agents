import { issueCredential } from '@battle-agents/agent';
import { authenticate } from '@battle-agents/db';
import {
  agents,
  closeDatabasePool,
  createDatabase,
  DrizzleCredentialStore,
  installations,
  sessions,
  users,
  type Database,
} from '@battle-agents/db';
import { PROTOCOL_VERSION } from '@battle-agents/protocol';
import type { AgentEvent } from '@battle-agents/protocol';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createEventGateway, type EventGateway } from '../../apps/web/src/event-gateway.js';
import type { HttpRequest, HttpResponse } from '../../apps/web/src/routes.js';

/**
 * Event ingest and SSE, against a live Postgres.
 *
 * The unit tests prove the logic with an in-memory store. This proves the things
 * only the real database can settle: that a credential issued through the real
 * store authenticates a real ingest, that `findOwnedByInstallation` keeps one
 * installation out of another's session, and above all that a key event becomes
 * an actual ROW while 150 transient events become none.
 *
 * The last one is the requirement the whole split exists for. "Transient events
 * must still reach subscribers" is easy to satisfy by not filtering at all and
 * easy to break by filtering too early; the only test that tells them apart is
 * one that counts rows in one table and deltas on a stream in the same breath.
 */

const DATABASE_URL_VARIABLE = 'DATABASE_URL';
const POOL_MAX_CONNECTIONS = 4;
const AT = '2026-09-24T12:00:00.000Z';

let pool: Pool;
let database: Database;
let gateway: EventGateway;

let ownerUserId = '';
let installationId = '';
let otherInstallationId = '';
// Unique per run rather than fixed literals: a fixed id collides with the
// previous run's leftovers whenever beforeAll fails partway, and a test that can
// only pass once is a test nobody can iterate on.
let sessionId = '';
let otherSessionId = '';
let token = '';
let otherToken = '';

function headers(entries: Record<string, string>): HttpRequest['headers'] {
  return new Map(Object.entries(entries)) as unknown as HttpRequest['headers'];
}

function transient(): AgentEvent {
  return { type: 'tool.started', sessionId, at: AT, tool: 'Read' };
}

function keyEvent(): AgentEvent {
  return {
    type: 'test.passed',
    sessionId,
    at: AT,
    suite: 'unit',
    count: 12,
  };
}

function batch(events: readonly AgentEvent[]): unknown {
  return { protocolVersion: PROTOCOL_VERSION, events };
}

async function post(body: unknown, withToken: string = token): Promise<HttpResponse> {
  return gateway.handle({
    method: 'POST',
    url: 'https://agentbattle.test/api/events',
    headers: headers({ authorization: `Bearer ${withToken}` }),
    body,
  });
}

async function createInstallation(githubSuffix: string, newSessionId: string): Promise<string> {
  const githubId = `${randomUUID()}-${githubSuffix}`;
  const [owner] = await database
    .insert(users)
    .values({ githubId, login: githubId })
    .returning({ id: users.id });
  const ownerId = owner?.id ?? '';
  if (githubSuffix === 'primary') {
    ownerUserId = ownerId;
  }
  const [agent] = await database
    .insert(agents)
    .values({ userId: ownerId, name: `Ingest-${githubSuffix}`, harness: 'claude' })
    .returning({ id: agents.id });
  const [installation] = await database
    .insert(installations)
    .values({ userId: ownerId, installationKey: `${randomUUID()}-${githubSuffix}` })
    .returning({ id: installations.id });
  const id = installation?.id ?? '';

  // A real session row, because event_log.session_id is a foreign key and the
  // database is right to refuse a row pointing at a run that never happened.
  const [created] = await database
    .insert(sessions)
    .values({ id: newSessionId, agentId: agent?.id ?? '', installationId: id })
    .returning({ id: sessions.id });
  if (created === undefined) {
    throw new Error(`could not create a session for ${githubSuffix}`);
  }
  return id;
}

async function issueFor(installation: string): Promise<string> {
  const issued = issueCredential(AT);
  await new DrizzleCredentialStore(database).insert({
    id: randomUUID(),
    tokenHash: issued.hash,
    installationId: installation,
    agentId: null,
    scopes: [],
    expiresAt: issued.expiresAt,
  });
  return issued.token;
}

beforeAll(async () => {
  const connectionString = process.env[DATABASE_URL_VARIABLE];
  if (connectionString === undefined) {
    throw new Error(
      `${DATABASE_URL_VARIABLE} is not set. Run through scripts/test-m0.sh so the compose Postgres is up, or export it before running this suite.`,
    );
  }
  pool = new Pool({ connectionString, max: POOL_MAX_CONNECTIONS });
  database = createDatabase(pool);

  sessionId = randomUUID();
  otherSessionId = randomUUID();

  installationId = await createInstallation('primary', sessionId);
  token = await issueFor(installationId);

  otherInstallationId = await createInstallation('secondary', otherSessionId);
  otherToken = await issueFor(otherInstallationId);

  // The authenticator is supplied rather than imported, because the gateway is a
  // transport and must not reach into a feature. The composition root wires the
  // real one; a test wires the same thing against the same store.
  const credentialStore = new DrizzleCredentialStore(database);
  gateway = createEventGateway({
    database,
    authenticate: async (request) => {
      const caller = await authenticate({ store: credentialStore, now: AT }, request as never);
      return { installationId: caller.installationId };
    },
    // Pin the clock the credential expiry is judged against, so a token issued
    // at AT is live for the whole suite regardless of the wall clock.
    now: () => AT,
  });
});

afterAll(async () => {
  // Optional because beforeAll can fail before the gateway exists, and a
  // teardown that throws on the way out hides the error that caused it.
  gateway?.close();
  if (ownerUserId !== '') {
    // Cascades to agents, installations, sessions and their credentials. The
    // event_log rows are cleared first because that table outlives the session
    // by design (session_id is set null on delete, not cascaded), so deleting
    // the user would orphan them rather than remove them.
    await clearLog();
    await database.delete(users).where(sql`${users.id} = ${ownerUserId}`);
  }
  await closeDatabasePool(pool);
});

async function clearLog(): Promise<void> {
  // Parameterised, not interpolated: the ids are random per run, and a raw
  // interpolation of a value into SQL is exactly the habit this codebase's own
  // ownership work argues against.
  await database.execute(
    sql`DELETE FROM event_log WHERE session_id IN (${sessionId}::uuid, ${otherSessionId}::uuid)`,
  );
}

async function countRows(): Promise<number> {
  const result = await database.execute<{ total: number }>(
    sql`SELECT count(*)::integer AS total FROM event_log WHERE session_id = ${sessionId}::uuid`,
  );
  return result.rows[0]?.total ?? 0;
}

beforeEach(async () => {
  await clearLog();
});

describe('a real credential, ingesting a real batch', () => {
  it('authenticates a token it issued and accepts the batch', async () => {
    // Proves the gateway's authenticate wires the real credential store, and
    // that the whole POST path works end to end over a real database.
    const response = await post(batch([keyEvent()]));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ accepted: 1, sessionId, resumed: false });
  });

  it('refuses a token it never issued', async () => {
    const stranger = issueCredential(AT).token;
    const response = await post(batch([keyEvent()]), stranger);

    expect(response.status).toBe(401);
  });

  it('keeps one installation out of another installation session', async () => {
    // A valid token (the primary installation's) pointing at a session the
    // primary installation does NOT own — it belongs to the secondary one.
    // Ownership is a property of the query, so this is refused exactly like a
    // session that does not exist, and it writes no row.
    const response = await gateway.handle({
      method: 'POST',
      url: 'https://agentbattle.test/api/events',
      headers: headers({ authorization: `Bearer ${token}` }),
      body: {
        protocolVersion: PROTOCOL_VERSION,
        events: [{ ...keyEvent(), sessionId: otherSessionId }],
      },
    });

    expect(response.status).toBe(404);
    expect(await countRows()).toBe(0);
  });

  it('lets an installation write to its own session', async () => {
    const response = await gateway.handle({
      method: 'POST',
      url: 'https://agentbattle.test/api/events',
      headers: headers({ authorization: `Bearer ${otherToken}` }),
      body: {
        protocolVersion: PROTOCOL_VERSION,
        events: [{ ...keyEvent(), sessionId: otherSessionId }],
      },
    });

    expect(response.status).toBe(200);
  });
});

describe('the 413 gate, over HTTP-shaped requests', () => {
  it('refuses a batch over the limit with 413 and a Retry-After header', async () => {
    const response = await post(batch(Array.from({ length: 101 }, () => transient())));

    expect(response.status).toBe(413);
    expect(response.headers).toEqual({ 'Retry-After': '1' });
    expect(await countRows()).toBe(0);
  });
});

describe('the persistence split, over a real database', () => {
  it('writes a key event as a row', async () => {
    await post(batch([keyEvent()]));

    expect(await countRows()).toBe(1);
  });

  it('writes no row for a transient event', async () => {
    await post(batch([transient()]));

    expect(await countRows()).toBe(0);
  });

  it('emits 150 transient events across 3 batches and writes 0 rows while delivering 150 deltas', async () => {
    // The requirement, with both halves in one test so neither can be satisfied
    // by accident: 0 database rows AND 150 deltas. A filter placed on the way to
    // the bus instead of the way to the store would pass a persistence-only test
    // and fail this one.
    const subscriber = gateway.hub.subscribe('operator');
    // The opening full_state; the deltas follow it.
    expect(await subscriber.pull()).toMatchObject({ kind: 'full_state' });

    for (let batchIndex = 0; batchIndex < 3; batchIndex += 1) {
      const response = await post(batch(Array.from({ length: 50 }, () => transient())));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ accepted: 50 });
    }

    // 150 events crossed the wire; the database saw none of them.
    expect(await countRows()).toBe(0);

    // ...and every one of them was a delta to a live subscriber.
    const frames = [];
    for (let i = 0; i < 150; i += 1) {
      frames.push(await subscriber.pull());
    }
    expect(frames).toHaveLength(150);
    expect(frames.every((frame) => frame?.kind === 'delta')).toBe(true);
    subscriber.close();
  });

  it('writes the key events in the same batch and still delivers the transient ones', async () => {
    // A mixed batch: the filter is per event, not per batch. A key event and a
    // transient one in the same POST must split — one row, one delta each, no
    // coupling between the two.
    const subscriber = gateway.hub.subscribe('operator');
    await subscriber.pull(); // full_state

    const response = await post(batch([keyEvent(), transient(), keyEvent(), transient()]));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ accepted: 4 });

    // Two key events, two rows.
    expect(await countRows()).toBe(2);

    // Four deltas: the key events reached the stream too, not just the store.
    const kinds = [];
    for (let i = 0; i < 4; i += 1) {
      kinds.push((await subscriber.pull())?.kind);
    }
    expect(kinds).toEqual(['delta', 'delta', 'delta', 'delta']);
    subscriber.close();
  });
});

describe('the version pin, over HTTP-shaped requests', () => {
  // The refusal is implemented at apps/web/src/event-routes.ts and nothing
  // exercised it: every other test in this file sends the correct version, so
  // the branch was green while untested. That is the bead's exact complaint --
  // "without it, 'protocol-compatible' is a wish" -- and it is the mechanical
  // half of "forks are welcome IF protocol-compatible".
  //
  // The assertion is on the BODY, not only the status, for the reason the 413
  // test gives: a hosting platform answers 400 for its own reasons and the two
  // are not the same finding. A refusal that names the expected version is a
  // client that can fix itself; a bare 400 is a debugging session.

  it('refuses a client presenting a different version, and names the expected one', async () => {
    const response = await post({ protocolVersion: '9.9.9', events: [keyEvent()] });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'protocol version mismatch',
      expectedProtocol: PROTOCOL_VERSION,
      receivedProtocol: '9.9.9',
    });
  });

  it('refuses a malformed version rather than letting it past the pin', async () => {
    // The parser compares by EXACT string and never reaches the zod schema, so
    // 'not-a-version' is reported as a mismatch too. An earlier version of this
    // test asserted the opposite — that it would be a different failure — on
    // the assumption that protocolVersionSchema caught it first. It does not,
    // and the single comparison is the better design: every input that is not
    // the version this build speaks is refused the same way, so there is no
    // input shape that slips past.
    const response = await post({ protocolVersion: 'not-a-version', events: [keyEvent()] });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'protocol version mismatch',
      expectedProtocol: PROTOCOL_VERSION,
      receivedProtocol: 'not-a-version',
    });
  });

  it('refuses a batch with no version at all, which is the shape a stranger sends', async () => {
    // The other end of the same property. `received` is stringified rather than
    // left undefined, so the response still names what arrived.
    const response = await post({ events: [keyEvent()] });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'protocol version mismatch' });
    expect(await countRows()).toBe(0);
  });

  it('accepts the version this build speaks, so the pin is not a wall', async () => {
    // The other half, and the one that stops the pin from being tightened into
    // something that refuses everything. A check that only ever saw refusals
    // would pass on a route that admitted nobody.
    const response = await post(batch([keyEvent()]));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ accepted: 1 });
  });
});
