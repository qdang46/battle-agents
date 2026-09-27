import { issueCredential } from '@battle-agents/agent';
import { createApplicationApi } from '@battle-agents/api';
import { authenticate } from '@battle-agents/db';
import {
  agents,
  closeDatabasePool,
  createDatabase,
  DrizzleCredentialStore,
  DrizzleInstallationRepository,
  DrizzleSessionRepository,
  installations,
  sessions,
  users,
  type Database,
} from '@battle-agents/db';
import { OUTCOME_TYPES } from '@battle-agents/progression';
import { AgentEventSchema, type AgentEvent } from '@battle-agents/protocol';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEventGateway, type EventGateway } from '../../apps/web/src/event-gateway.js';
import { createMcpRoutes } from '../../apps/web/src/mcp-routes.js';
import { createMcpSessionStore, serverFactoryFor } from '../../apps/web/src/mcp-sessions.js';
import type { HttpRequest, HttpResponse } from '../../apps/web/src/routes.js';
import { createSessionRoutes } from '../../apps/web/src/session-routes.js';
import { readProtocolBlock, readPublishedFile } from '../support/published-docs.js';

/**
 * The fresh-agent conformance test.
 *
 * ── What it actually is ──────────────────────────────────────────────────────
 *
 * A client whose ENTIRE protocol vocabulary is parsed out of the four published
 * documents, driving a real server over the real routes, against a real
 * Postgres. It is not an LLM, and it is not a demonstration: the thing under
 * test is the claim that the documents are sufficient for a third party with no
 * repository access. Sufficiency has one falsifiable form — a client that knows
 * nothing except what the documents say, and either completes the loop or does
 * not.
 *
 * The rule that makes it a test rather than a demo is stated in the type
 * `DocumentedAgent`: it is constructed from four strings and from a transport,
 * and it holds no protocol constant of its own. Every action id, every input
 * field name, every event type, every batching number, every endpoint path and
 * the protocol version are read out of the documents. If a document drops a
 * step, renames a field, or names something the server does not have, the agent
 * either cannot find it or sends the wrong thing, and this test fails.
 *
 * ── What the loop proves, step by step ──────────────────────────────────────
 *
 *   HELLO      the character is resolved from (owner, name) and a run is opened
 *   telemetry  a batch built to the documented shape is accepted, and the
 *              documented split between persisted and transient holds
 *   observe    a live frame arrives and the agent reads it
 *   heartbeat  the documented route answers for a run that owns itself
 *   act        an action the document names runs, and battle weights are public
 *   end        the run closes and the character is still there
 *
 * ── What it cannot prove, and must not be read as proving ───────────────────
 *
 * It does not prove the documents are CLEAR. A client that parses a table can
 * work perfectly well on prose a person would find ambiguous. The bead says this
 * outright: the test's job is to catch the documents being WRONG.
 *
 * It also does not prove the documents are OPEN-ENDED. A scripted client uses
 * the steps the documents give it; the claim being tested is that those steps
 * are sufficient for one full loop, not that they are the only loop possible.
 *
 * ── The mutations, and why they are in the file ─────────────────────────────
 *
 * The last describe block damages the documents on disk — in memory, through
 * the same reader — and asserts the loop stops working. A conformance test
 * that has only ever been seen green proves that a loop can be completed by
 * someone who already knows the answer. These are what make it a check.
 */

const DATABASE_URL_VARIABLE = 'DATABASE_URL';
const POOL_MAX_CONNECTIONS = 4;
const AT = '2026-09-26T12:00:00.000Z';
const ORIGIN = 'https://agentbattle.test';

let pool: Pool;
let database: Database;
let gateway: EventGateway;
let sessionRoutes: (request: HttpRequest) => Promise<HttpResponse>;
let mcpRoutes: (request: HttpRequest) => Promise<HttpResponse>;

/**
 * The application's own routing table.
 *
 * Harness code, and the reason it is here rather than inside the transport: the
 * agent sends a path the documents gave it, and something has to decide which
 * pure handler serves it. In the running app that is Next.js, matching the
 * `route.ts` file under `apps/web/app/api`. Here the same decision is three
 * prefixes. It knows no protocol vocabulary — a request to a path nothing serves
 * is a 404 here, exactly as it would be in the app, and that is what lets a
 * document naming an unmounted path fail.
 */
function app(request: HttpRequest): Promise<HttpResponse> {
  const path = new URL(request.url).pathname;
  if (path === '/api/mcp') return mcpRoutes(request);
  if (path.startsWith('/api/sessions/')) return sessionRoutes(request);
  if (path.startsWith('/api/events')) return gateway.handle(request);
  return Promise.resolve({ status: 404, body: { error: 'not found', path } });
}

let ownerId = '';
let token = '';

/** The values an operator hands an agent. The agent adds nothing to them. */
const BOOTSTRAP = {
  ownerId: '',
  installationKey: '',
  agentName: '',
  harness: 'claude',
};

function headers(entries: Record<string, string>): HttpRequest['headers'] {
  return new Map(Object.entries(entries)) as unknown as HttpRequest['headers'];
}

/* ─────────────────────────── the transport ─────────────────────────── */

/**
 * The network, and nothing else.
 *
 * A client that knows how to open a TCP connection and speak JSON-RPC knows no
 * game vocabulary: it moves bytes to a URL and reads a status. Everything that
 * decides WHAT to send lives in `DocumentedAgent`, which is why this half can
 * be written without reading the documents.
 */
interface Transport {
  /** A `tools/call` over the control plane the documents name. */
  mcpCall(tool: string, args: unknown): Promise<unknown>;
  /** A plain HTTP request to a path the documents name. */
  request(options: {
    method: string;
    path: string;
    bearer?: string;
    body?: unknown;
  }): Promise<HttpResponse>;
  /**
   * Opens a server-sent-event stream and hands back a reader for it.
   *
   * Split from reading on purpose, and the split is the whole subtlety: the
   * stream delivers what is broadcast AFTER it subscribes, so an agent that
   * opens it after doing its work waits forever for a delta that was published
   * to nobody. Opening first is what a spectator does and what an agent must.
   */
  openStream(path: string): Promise<{ read(n: number): Promise<readonly unknown[]> }>;
}

function buildTransport(): Transport {
  return {
    async mcpCall(tool, args) {
      const response = await mcpRoutes({
        method: 'POST',
        url: `${ORIGIN}/api/mcp`,
        headers: headers({
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          // The server refuses a client that cannot take either encoding, and
          // refusing is the right answer: a client that misreads the response is
          // worse than one that never got one.
          accept: 'application/json, text/event-stream',
        }),
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        },
      });
      expect(
        response.status,
        `the control plane answered ${response.status}: ${JSON.stringify(response.body)}`,
      ).toBe(200);
      const envelope = response.body as {
        result?: { content?: ReadonlyArray<{ text?: string }>; isError?: boolean };
      };
      const result = envelope.result;
      const text = result?.content?.[0]?.text;
      if (result === undefined || text === undefined) {
        throw new Error(`the control plane returned no result: ${JSON.stringify(response.body)}`);
      }
      // A tool that refused answers 200 with the error INSIDE the result, because
      // the JSON-RPC call itself succeeded. A client that reads only the
      // transport status would treat a refused action as a completed one, which
      // is the most expensive thing to get wrong about an action.
      if (result.isError === true) {
        throw new Error(text);
      }
      return JSON.parse(text) as unknown;
    },

    async request({ method, path, bearer = token, body }) {
      return app({
        method,
        url: `${ORIGIN}${path}`,
        headers: headers({
          ...(method === 'GET' ? {} : { authorization: `Bearer ${bearer}` }),
          'content-type': 'application/json',
        }),
        ...(body === undefined ? {} : { body }),
      });
    },

    async openStream(path) {
      const response = await app({
        method: 'GET',
        url: `${ORIGIN}${path}`,
        headers: headers({ accept: 'text/event-stream' }),
      });
      expect(response.status).toBe(200);
      if (!(response.body instanceof ReadableStream)) {
        throw new Error('the stream the documents describe did not come back as a stream');
      }
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      return {
        async read(n) {
          const frames: unknown[] = [];
          while (frames.length < n) {
            const { value, done } = await reader.read();
            if (done) break;
            buffered += decoder.decode(value, { stream: true });
            // SSE frames are separated by a blank line, and the encoding writes
            // both an `event:` line and a `data:` line — read the data, which is
            // what carries `kind` and the frame itself.
            let split = buffered.indexOf('\n\n');
            while (split !== -1 && frames.length < n) {
              const message = buffered.slice(0, split);
              buffered = buffered.slice(split + 2);
              const data = message
                .split('\n')
                .find((line) => line.startsWith('data: '))
                ?.slice('data: '.length);
              if (data !== undefined) {
                frames.push(JSON.parse(data) as unknown);
              }
              split = buffered.indexOf('\n\n');
            }
          }
          return frames;
        },
      };
    },
  };
}

/* ─────────────────────────── the agent ─────────────────────────── */

interface DocumentedAction {
  readonly id: string;
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly purpose: string;
}

interface DocumentedEventType {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

interface DocumentedOutcome {
  readonly event: string;
  readonly xp: number;
}

/**
 * A client that knows only what the four documents say.
 *
 * Every method here answers a question in the agent's own terms — "I want to
 * start a run", "I want to report that a suite passed" — and looks the answer up
 * in the documents. There is no fallback to a hardcoded id, because a fallback
 * is how a conformance test ends up passing on knowledge the reader does not
 * have.
 */
class DocumentedAgent {
  readonly #skill: Record<string, unknown>;
  readonly #events: Record<string, unknown>;
  readonly #heartbeat: Record<string, unknown>;
  readonly #messaging: Record<string, unknown>;
  readonly #transport: Transport;
  readonly #bootstrap: typeof BOOTSTRAP;

  constructor(
    documents: Record<string, string>,
    transport: Transport,
    bootstrap: typeof BOOTSTRAP,
  ) {
    this.#skill = readProtocolBlock(documents['skill.md'] as string, 'actions');
    this.#events = readProtocolBlock(documents['events.md'] as string, 'ingest');
    this.#heartbeat = readProtocolBlock(documents['heartbeat.md'] as string, 'heartbeat');
    this.#messaging = readProtocolBlock(documents['messaging.md'] as string, 'messaging');
    this.#transport = transport;
    this.#bootstrap = bootstrap;
  }

  /**
   * The action that does what this fragment of purpose says, or nothing.
   *
   * The lookup is BY INTENT, not by id. An agent that already knows the id
   * `session.create` is not what this file is: the question is whether a reader
   * with only these documents can find the step they need, and a lookup that
   * hardcoded the id would pass no matter what the documents said.
   */
  #action(purposeFragment: string, block: 'skill' | 'messaging' = 'skill'): DocumentedAction {
    const owner = block === 'skill' ? 'skill.md' : 'messaging.md';
    const actions = (block === 'skill' ? this.#skill : this.#messaging)['actions'] as ReadonlyArray<
      Record<string, unknown>
    >;
    const found = actions.find((action) =>
      String(action['purpose'] ?? '')
        .toLowerCase()
        .includes(purposeFragment.toLowerCase()),
    );
    if (found === undefined) {
      throw new Error(
        `no action in ${owner} has a purpose containing "${purposeFragment}"; that document does not say how to do this`,
      );
    }
    return {
      id: found['id'] as string,
      required: (found['required'] ?? []) as string[],
      optional: (found['optional'] ?? []) as string[],
      purpose: found['purpose'] as string,
    };
  }

  /** A payload assembled from the field names the document lists, and only those. */
  #payload(
    action: DocumentedAction,
    values: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const field of [...action.required, ...action.optional]) {
      if (values[field] !== undefined) {
        payload[field] = values[field];
      }
    }
    for (const field of action.required) {
      if (payload[field] === undefined) {
        throw new Error(
          `the documented action ${action.id} requires "${field}" and nothing supplies it`,
        );
      }
    }
    return payload;
  }

  #act(purposeFragment: string, values: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.act(purposeFragment, values);
  }

  /**
   * Runs the action the documents say does this, with a payload assembled from
   * the field names the documents list. Public so the mutation cases below can
   * drive it against a deliberately damaged document set.
   */
  act(
    purposeFragment: string,
    values: Readonly<Record<string, unknown>>,
    block: 'skill' | 'messaging' = 'skill',
  ): Promise<unknown> {
    const action = this.#action(purposeFragment, block);
    return this.#transport.mcpCall('act', {
      action: action.id,
      input: this.#payload(action, values),
    });
  }

  /** HELLO. Opens or resumes a run for the character the operator registered. */
  async hello(): Promise<{
    sessionId: string;
    agentId: string;
    installationId: string;
    resumed: boolean;
  }> {
    const result = (await this.#act('starts or resumes a run', {
      installationKey: this.#bootstrap.installationKey,
      ownerId: this.#bootstrap.ownerId,
      agentName: this.#bootstrap.agentName,
      harness: this.#bootstrap.harness,
    })) as Record<string, unknown>;
    return result as {
      sessionId: string;
      agentId: string;
      installationId: string;
      resumed: boolean;
    };
  }

  #ingestPath(): string {
    return (this.#events['ingest'] as Record<string, unknown>)['path'] as string;
  }

  #streamPath(): string {
    return (this.#events['stream'] as Record<string, unknown>)['path'] as string;
  }

  #batchFields(): readonly string[] {
    return (this.#events['ingest'] as Record<string, unknown>)['bodyFields'] as string[];
  }

  #batching(): {
    flushIntervalMs: number;
    maxBatchEvents: number;
    maxRejectEvents: number;
    retryAfterSeconds: number;
  } {
    return this.#events['batching'] as {
      flushIntervalMs: number;
      maxBatchEvents: number;
      maxRejectEvents: number;
      retryAfterSeconds: number;
    };
  }

  #eventTypes(): readonly string[] {
    return this.#events['agentEventTypes'] as string[];
  }

  #eventFields(type: string): DocumentedEventType {
    const map = this.#events['agentEventFields'] as Record<string, DocumentedEventType>;
    const fields = map[type];
    if (fields === undefined) {
      throw new Error(`events.md lists no fields for ${type}`);
    }
    return fields;
  }

  /**
   * Builds one event to the shape events.md gives for that type.
   *
   * `at` is written with an explicit offset, which is the one rule the document
   * singles out and the one adapters get wrong most often.
   */
  event(type: string, values: Readonly<Record<string, unknown>>, sessionId: string): AgentEvent {
    if (!this.#eventTypes().includes(type)) {
      throw new Error(`${type} is not one of the event types events.md lists`);
    }
    const fields = this.#eventFields(type);
    const payload: Record<string, unknown> = { type, sessionId, at: AT };
    for (const field of [...fields.required, ...fields.optional]) {
      if (values[field] !== undefined) {
        payload[field] = values[field];
      }
    }
    for (const field of fields.required) {
      if (payload[field] === undefined) {
        throw new Error(`events.md says ${type} requires "${field}" and nothing supplies it`);
      }
    }
    return payload as unknown as AgentEvent;
  }

  /**
   * Posts a batch, split the way the documents say to split it.
   *
   * The client-side ceiling is taken from the document rather than from the
   * server's, so a document that raised it would produce a batch the server
   * refuses — which is the failure this is shaped to expose.
   */
  async report(events: readonly AgentEvent[]): Promise<HttpResponse[]> {
    const fields = this.#batchFields();
    if (!fields.includes('protocolVersion') || !fields.includes('events')) {
      throw new Error(
        `events.md does not describe the batch body; it names [${fields.join(', ')}]`,
      );
    }
    const size = this.#batching().maxBatchEvents;
    const responses: HttpResponse[] = [];
    for (let at = 0; at < events.length; at += size) {
      const body: Record<string, unknown> = {};
      for (const field of fields) {
        body[field] =
          field === 'protocolVersion'
            ? this.#events['protocolVersion']
            : events.slice(at, at + size);
      }
      responses.push(
        await this.#transport.request({ method: 'POST', path: this.#ingestPath(), body }),
      );
    }
    return responses;
  }

  /** Says this run is still alive, over the route the document names. */
  async beat(sessionId: string): Promise<HttpResponse> {
    const resource = this.#heartbeat['resource'] as Record<string, unknown>;
    const path = (resource['path'] as string).replace('{sessionId}', encodeURIComponent(sessionId));
    return this.#transport.request({ method: resource['method'] as string, path });
  }

  /** Closes the run. */
  async finish(sessionId: string, reason: string): Promise<unknown> {
    return this.#act('Close the run', { sessionId, reason });
  }

  /** Subscribes to the documented stream. Open this BEFORE doing the work. */
  openLive(): Promise<{ read(n: number): Promise<readonly unknown[]> }> {
    return this.#transport.openStream(this.#streamPath());
  }

  /**
   * Opens a battle for this run. Battles bind sessions, not characters.
   *
   * The id comes off the reply's `id`, which is the field skill.md names. If
   * that sentence were wrong the call below would send `undefined` and the
   * weights read would be refused, so the document is checked by using it.
   */
  async createBattle(sessionId: string): Promise<{ id: string }> {
    return (await this.#act('Open a battle', { sessionId })) as { id: string };
  }

  /** The published scoring rubric, which the documents say is readable mid-match. */
  weights(battleId: string): Promise<{
    weights: Record<string, number>;
    criteria: readonly string[];
    status: string;
    published: boolean;
  }> {
    return this.#act('scoring rubric', { battleId }) as Promise<{
      weights: Record<string, number>;
      criteria: readonly string[];
      status: string;
      published: boolean;
    }>;
  }

  /** What the documents promise each outcome is worth. */
  outcomes(): readonly DocumentedOutcome[] {
    return this.#skill['outcomes'] as DocumentedOutcome[];
  }

  /** What the documents say the statuses a session can be in are. */
  statuses(): readonly string[] {
    return this.#heartbeat['statuses'] as string[];
  }

  endReasons(): readonly string[] {
    return this.#heartbeat['endReasons'] as string[];
  }

  /** Tries to send a message, because the documents say what happens when it does. */
  send(fromAgentId: string, toAgentId: string, body: string): Promise<unknown> {
    return this.act('Send a direct message', { fromAgentId, toAgentId, body }, 'messaging');
  }

  /** Reads an agent's mail, which the documents say is the half that works. */
  inbox(agentId: string): Promise<readonly unknown[]> {
    return this.act('Everything waiting for one agent', { agentId }, 'messaging') as Promise<
      readonly unknown[]
    >;
  }

  messagingCapability(): string {
    return this.#messaging['requiredCapability'] as string;
  }

  protocolVersion(): string {
    return this.#events['protocolVersion'] as string;
  }
}

/* ─────────────────────────── the documents ─────────────────────────── */

function publishedDocuments(): Record<string, string> {
  return {
    'skill.md': readPublishedFile('skill.md'),
    'heartbeat.md': readPublishedFile('heartbeat.md'),
    'messaging.md': readPublishedFile('messaging.md'),
    'events.md': readPublishedFile('events.md'),
  };
}

function agentFor(documents: Record<string, string> = publishedDocuments()): DocumentedAgent {
  return new DocumentedAgent(documents, buildTransport(), BOOTSTRAP);
}

/* ─────────────────────────── the server ─────────────────────────── */

async function logRowsFor(sessionId: string): Promise<readonly { type: string }[]> {
  const result = await database.execute<{ type: string }>(
    sql`SELECT type FROM event_log WHERE session_id = ${sessionId}::uuid ORDER BY id`,
  );
  return result.rows;
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

  // ── the operator's half ──
  //
  // Registering a character and issuing a credential are the things the
  // documents say an operator does for an agent, because the platform has no
  // self-service registration route. Doing it here rather than through the API
  // is the honest shape of the test: the agent under test never performs it.
  const githubId = randomUUID();
  const [owner] = await database
    .insert(users)
    .values({ githubId, login: githubId })
    .returning({ id: users.id });
  ownerId = owner?.id ?? '';
  BOOTSTRAP.ownerId = ownerId;
  BOOTSTRAP.installationKey = randomUUID();
  BOOTSTRAP.agentName = `Docs-${githubId.slice(0, 8)}`;

  await database
    .insert(agents)
    .values({ userId: ownerId, name: BOOTSTRAP.agentName, harness: BOOTSTRAP.harness });
  const [installation] = await database
    .insert(installations)
    .values({ userId: ownerId, installationKey: BOOTSTRAP.installationKey })
    .returning({ id: installations.id });

  const issued = issueCredential(AT);
  // The `mcp` scope, because the MCP surface refuses a token without it. The
  // telemetry and heartbeat surfaces require none — the token proves the
  // installation and the query proves ownership.
  await new DrizzleCredentialStore(database).insert({
    id: randomUUID(),
    tokenHash: issued.hash,
    installationId: installation?.id ?? '',
    agentId: null,
    scopes: ['mcp'],
    expiresAt: issued.expiresAt,
  });
  token = issued.token;

  gateway = createEventGateway({
    database,
    authenticate: async (request) => {
      const caller = await authenticate(
        { store: new DrizzleCredentialStore(database), now: AT },
        request as never,
      );
      return { installationId: caller.installationId };
    },
    now: () => AT,
  });

  const api = createApplicationApi(gateway.runtime, gateway.bus);
  const credentialStore = new DrizzleCredentialStore(database);
  const asCaller = async (request: HttpRequest) => {
    const caller = await authenticate({ store: credentialStore, now: AT }, request as never);
    return { installationId: caller.installationId };
  };

  mcpRoutes = createMcpRoutes({
    authenticate: asCaller,
    // The real store and the real server factory, not a stub. A `tools/call`
    // that presents no `Mcp-Session-Id` is stateless, so the route opens a
    // session, answers, and closes it again — but the session it opens has to
    // be a working MCP server, and a stub proved that only by accident.
    sessions: createMcpSessionStore({ createServer: serverFactoryFor(api) }),
    newSessionId: randomUUID,
  });

  sessionRoutes = createSessionRoutes({
    api,
    authenticate: async (request) => ({ installationId: (await asCaller(request)).installationId }),
    resolveSession: (id, installationId) =>
      new DrizzleSessionRepository(database).findOwnedByInstallation(id, installationId),
    // The real installation→user query, for the `POST /api/sessions` route. This
    // harness drives the documented run lifecycle over MCP, where `act` is still
    // the door and the identity comes from the payload — so this file is not the
    // place the handshake is exercised, and the port is wired rather than faked
    // so that a future case that DOES use the route is not testing a double.
    resolveOwner: (installationId) =>
      new DrizzleInstallationRepository(database).findOwner(installationId),
  });
});

afterAll(async () => {
  // Optional because beforeAll can fail before anything exists, and a teardown
  // that throws on the way out hides the error that caused it.
  gateway?.close();
  if (pool === undefined) return;
  if (ownerId !== '') {
    await database.execute(
      sql`DELETE FROM event_log WHERE actor_id = ${ownerId} OR session_id IN (SELECT id FROM sessions WHERE agent_id IN (SELECT id FROM agents WHERE user_id = ${ownerId}::uuid))`,
    );
    await database.delete(users).where(eq(users.id, ownerId));
  }
  await closeDatabasePool(pool);
});

/* ─────────────────────────── the loop ─────────────────────────── */

describe('a client that has read nothing but the four documents', () => {
  it('completes a full loop: hello, telemetry, observe, heartbeat, act, end', async () => {
    const agent = agentFor();

    // ── HELLO ──
    const hello = await agent.hello();
    expect(hello.agentId, 'HELLO returned no agentId').toBeTruthy();
    expect(hello.sessionId).toBeTruthy();
    expect(hello.resumed).toBe(false);

    // The character is not the human. A session hangs off the character, and
    // the character hangs off the owner — never the owner's session cookie, and
    // never the credential.
    const [row] = await database
      .select({ agentId: sessions.agentId, status: sessions.status, endReason: sessions.endReason })
      .from(sessions)
      .where(eq(sessions.id, hello.sessionId));
    expect(row, 'HELLO created no session row').toBeDefined();
    expect(row?.agentId).toBe(hello.agentId);
    const [character] = await database
      .select({ userId: agents.userId })
      .from(agents)
      .where(eq(agents.id, hello.agentId));
    expect(character?.userId).toBe(ownerId);

    // ── observe: subscribe BEFORE the work ──
    //
    // The stream carries what is broadcast after it subscribes, so opening it
    // after reporting waits for a delta that was already published to nobody.
    // An agent that reads the documented stream has to know that, and this is
    // where the document's advice is either right or is not.
    const live = await agent.openLive();

    // ── telemetry ──
    //
    // A key event and a transient one in the same batch, which is the pair the
    // persistence split is defined by: one becomes a row, the other does not,
    // and both reach a live subscriber.
    const reported: readonly AgentEvent[] = [
      agent.event('test.passed', { suite: 'unit', count: 12 }, hello.sessionId),
      agent.event('tool.started', { tool: 'Read' }, hello.sessionId),
    ];
    for (const event of reported) {
      // The agent cannot invent a shape: everything it emits is checked against
      // the frozen union before it goes anywhere.
      expect(
        AgentEventSchema.safeParse(event).success,
        `the agent emitted an invalid ${event.type}`,
      ).toBe(true);
    }
    const responses = await agent.report(reported);
    for (const response of responses) {
      expect(
        response.status,
        `ingest answered ${response.status}: ${JSON.stringify(response.body)}`,
      ).toBe(200);
      expect(response.body).toMatchObject({
        accepted: reported.length,
        sessionId: hello.sessionId,
      });
    }
    const rows = await logRowsFor(hello.sessionId);
    // `session.started` is in core's FROZEN `PERSISTED_EVENT_TYPES`, so a
    // session that begins writes a row. It did not used to, and this assertion
    // encoded that: the handshake produced no event at all, so the only row was
    // the one the agent had just reported. The assertion was pinned to the
    // absence of a producer rather than to the contract, and the contract says
    // otherwise -- `packages/core/src/persistence.ts` lists it.
    //
    // Asserted in order and as a set of the types, because the ORDER is also
    // meaningful here: the handshake row precedes the reported one, which is
    // what makes the log a story rather than a pile.
    expect(
      rows.map((r) => r.type),
      'the persisted set is not what the documents describe',
    ).toEqual(['session.started', 'test.passed']);

    // ── observe ──
    //
    // A frame arrives on the documented stream and the agent can read it. The
    // public view is a strict subset, and `test.passed` is one of the few that
    // survives whole, which is why it is the event this asserts on.
    const frames = await live.read(2);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const kinds = frames.map((frame) => (frame as { kind: string }).kind);
    expect(kinds[0], 'the first frame must be the snapshot').toBe('full_state');
    const deltas = frames.filter((frame) => (frame as { kind: string }).kind === 'delta');
    expect(deltas.length, 'no delta arrived for a run that just did work').toBeGreaterThan(0);
    const eventTypes = deltas.map((frame) => (frame as { event: { type: string } }).event.type);
    expect(eventTypes).toContain('test.passed');

    // ── heartbeat ──
    const beat = await agent.beat(hello.sessionId);
    expect(
      beat.status,
      `the heartbeat route answered ${beat.status}: ${JSON.stringify(beat.body)}`,
    ).toBe(200);
    expect(agent.statuses()).toContain((beat.body as { status: string }).status);

    // ── act, on a claim the documents make about being public ──
    //
    // "Battle scoring weights are public, and readable while a battle is still
    // running" is a claim an agent can be harmed by being wrong about, so it is
    // checked against a battle that exists and has not been judged. The
    // criterion names are read off the reply, not off a constant in this file.
    const battle = await agent.createBattle(hello.sessionId);
    expect(
      battle.id,
      'battle.create answered with no id, and the documents name it as the one',
    ).toBeTruthy();
    const weights = await agent.weights(battle.id);
    expect(weights.published, 'the rubric was not published').toBe(true);
    expect(weights.criteria.length).toBeGreaterThan(0);
    const sum = Object.values(weights.weights).reduce((total, value) => total + value, 0);
    expect(Math.abs(sum - 1), 'the published weights do not describe a rubric').toBeLessThan(1e-6);
    // Every criterion the reply names must have a weight, or the reply is
    // promising a criterion the judge will not score.
    for (const criterion of weights.criteria) {
      expect(weights.weights[criterion], `criterion ${criterion} has no weight`).toBeDefined();
    }

    // ── the economy, and the misreading the documents exist to prevent ──
    //
    // The set of outcomes is checked for COMPLETENESS, not just for the ones the
    // table happens to list: a platform that started paying for something new
    // while the document still listed five would leave an agent working for a
    // price that no longer exists.
    const outcomes = agent.outcomes();
    expect(outcomes.map((outcome) => outcome.event).sort()).toEqual([...OUTCOME_TYPES].sort());
    for (const outcome of outcomes) {
      const answer = (await agent.act('what an outcome is worth', {
        eventType: outcome.event,
      })) as { xp?: number; recognised?: boolean };
      expect(
        answer.recognised,
        `${outcome.event} is documented as paying and is not recognised`,
      ).toBe(true);
      // A document that misprices an outcome sends an agent to work for the
      // wrong number, which is the whole reason the table is in the machine-
      // readable block rather than only in the prose.
      expect(
        answer.xp,
        `${outcome.event} pays ${String(answer.xp)}; the documents say ${outcome.xp}`,
      ).toBe(outcome.xp);
    }

    // ── messaging: the half that works, and the half that refuses ──
    //
    // Checked here rather than only in the mutation section, because a document
    // claiming BOTH halves work is the specific lie the bead warns about, and
    // only a real run distinguishes it.
    expect(await agent.inbox(hello.agentId), 'reading the inbox did not work').toEqual([]);
    const refusal = await agent.send(hello.agentId, hello.agentId, 'hello').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal, 'social.send succeeded; messaging.md says it cannot').toBeInstanceOf(Error);
    expect(String((refusal as Error).message)).toContain(agent.messagingCapability());

    // ── end ──
    const reason = agent.endReasons()[0] as string;
    const ended = (await agent.finish(hello.sessionId, reason)) as {
      status: string;
      reason: string;
    };
    expect(ended.status).toBe('ended');
    expect(ended.reason).toBe(reason);
    const [after] = await database
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, hello.sessionId));
    expect(after?.status).toBe('ended');

    // The character outlived the run, which is the claim the whole identity
    // model exists to make.
    const [stillThere] = await database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, hello.agentId));
    expect(stillThere, 'ending a run deleted the character').toBeDefined();
  });

  it('gives the same character a second run rather than a second one', async () => {
    // The documents promise: "Reopening a terminal gives you the same character,
    // not a new one." Two HELLOs from the same install, the same owner and the
    // same character name must resolve to ONE agent id and TWO session ids. If
    // the lookup were keyed on anything transient, this is where it shows.
    const agent = agentFor();
    const first = await agent.hello();
    const second = await agent.hello();

    expect(second.agentId).toBe(first.agentId);
    expect(second.sessionId).not.toBe(first.sessionId);
    await agent.finish(second.sessionId, 'completed');
    await agent.finish(first.sessionId, 'completed');
  });

  it('refuses a batch carrying the wrong protocol version, naming both', async () => {
    // The version pin, which is the one number the documents publish, refusing
    // to be decorative. A batch claiming a version this server does not speak
    // is a 400 that names what was expected and what arrived — it is not
    // admitted, and it is not admitted quietly.
    const agent = agentFor();
    const hello = await agent.hello();
    const event = agent.event('test.passed', { suite: 'unit' }, hello.sessionId);

    const response = await buildTransport().request({
      method: 'POST',
      path: '/api/events',
      body: { protocolVersion: '9.9.9', events: [event] },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      expectedProtocol: agent.protocolVersion(),
      receivedProtocol: '9.9.9',
    });
    // Scoped to the refused event's own type, and deliberately NOT the whole
    // session log. The handshake above legitimately wrote a `session.started`
    // row -- it is in core's frozen durable set -- so a whole-log assertion
    // would be asserting that a session may not begin, which is not what this
    // test is about. What it is about is the batch: a refused one writes no row
    // of the type it carried, and naming the type is a sharper claim than
    // emptying the table.
    const after = await logRowsFor(hello.sessionId);
    expect(
      after.filter((row) => row.type === event.type),
      'a refused batch wrote a row anyway',
    ).toEqual([]);
    await agent.finish(hello.sessionId, 'completed');
  });

  it('refuses a batch spanning two sessions, naming the rule', async () => {
    const agent = agentFor();
    const mine = await agent.hello();
    const other = await agent.hello();
    const responses = await agent.report([
      agent.event('test.passed', { suite: 'unit' }, mine.sessionId),
      agent.event('test.passed', { suite: 'unit' }, other.sessionId),
    ]);

    expect(responses[0]?.status).toBe(400);
    expect(String((responses[0]?.body as { error: string }).error)).toMatch(/one session/i);
    await agent.finish(mine.sessionId, 'completed');
    await agent.finish(other.sessionId, 'completed');
  });

  it('refuses a batch over the documented ceiling, with a Retry-After', async () => {
    // Read off the documents rather than the code, so this asserts the
    // DOCUMENT's number is the one the server enforces.
    const documented = readProtocolBlock(publishedDocuments()['events.md'] as string, 'ingest')[
      'batching'
    ] as { maxRejectEvents: number; retryAfterSeconds: number };
    const agent = agentFor();
    const hello = await agent.hello();
    const oversized = Array.from({ length: documented.maxRejectEvents + 1 }, () =>
      agent.event('tool.started', { tool: 'Read' }, hello.sessionId),
    );

    // Bypasses the client's own flush ceiling on purpose: this is what a client
    // gets wrong, and the server is what catches it.
    const response = await buildTransport().request({
      method: 'POST',
      path: '/api/events',
      body: { protocolVersion: agent.protocolVersion(), events: oversized },
    });

    expect(response.status).toBe(413);
    expect(response.headers?.['Retry-After']).toBe(String(documented.retryAfterSeconds));
    await agent.finish(hello.sessionId, 'completed');
  });

  it('refuses a heartbeat for a run that belongs to somebody else', async () => {
    // The heartbeat route resolves ownership through a query, so a session this
    // installation does not own is refused exactly like one that does not exist.
    // An agent that assumed otherwise would be keeping another character's run
    // alive, which is exactly what the sweeper exists to stop.
    // A real second installation, because `agent_credentials.installation_id` is
    // a foreign key and a random uuid is a refusal rather than a stranger.
    const otherGithubId = randomUUID();
    const [otherOwner] = await database
      .insert(users)
      .values({ githubId: otherGithubId, login: otherGithubId })
      .returning({ id: users.id });
    const [otherInstallation] = await database
      .insert(installations)
      .values({ userId: otherOwner?.id ?? '', installationKey: randomUUID() })
      .returning({ id: installations.id });
    const stranger = issueCredential(AT);
    await new DrizzleCredentialStore(database).insert({
      id: randomUUID(),
      tokenHash: stranger.hash,
      installationId: otherInstallation?.id ?? '',
      agentId: null,
      scopes: ['mcp'],
      expiresAt: stranger.expiresAt,
    });
    const agent = agentFor();
    const hello = await agent.hello();

    const response = await app({
      method: 'POST',
      url: `${ORIGIN}/api/sessions/${encodeURIComponent(hello.sessionId)}/heartbeat`,
      headers: headers({ authorization: `Bearer ${stranger.token}` }),
    });

    expect(response.status).toBe(404);
    await agent.finish(hello.sessionId, 'completed');
  });
});

/**
 * The mutations.
 *
 * Each damages the documents in memory — through the same reader the agent
 * uses — and asserts the loop stops working. These are what make the file
 * above a check rather than a demonstration: a conformance test nobody has seen
 * fail is indistinguishable from a script that happens to succeed.
 *
 * They are mutations of the DOCUMENT, never of the code. Mutating the server
 * would prove the server can be broken, which is not in question; the claim
 * under test is about the documents, so the damage goes there.
 */
describe('a document set that is wrong fails the loop', () => {
  /**
   * Runs HELLO against a damaged document set and returns the failure, or
   * undefined when it completed.
   *
   * The mutations damage the DOCUMENT, never the code. Mutating the server would
   * prove the server can be broken, which is not in question; the claim under
   * test is about the documents, so that is where the damage goes. A conformance
   * test nobody has seen fail is indistinguishable from a script that happens to
   * succeed, which is the failure this repository keeps paying for.
   */
  async function helloFailure(documents: Record<string, string>): Promise<unknown> {
    try {
      await agentFor(documents).hello();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  /**
   * Rewrites one type's field list inside the machine-readable block.
   *
   * Anchored on the type name and closed at the matching brace, so it does not
   * care how the block is laid out. A mutation anchored on the current
   * formatting stops working the first time somebody runs the formatter, and it
   * stops working SILENTLY — which is the exact shape of the no-op that reports
   * itself as a pass.
   */
  function withEventFieldList(
    documents: Record<string, string>,
    type: string,
    fields: { required: string[]; optional: string[] },
  ): Record<string, string> {
    const text = documents['events.md'] as string;
    const block = new RegExp(`("${type.replace('.', '\\.')}"\\s*:\\s*\\{)([\\s\\S]*?)(\\n\\s*\\})`);
    const match = block.exec(text);
    if (match === null) {
      throw new Error(
        `the mutation could not find the field list for ${type}, so it would be a no-op`,
      );
    }
    const body =
      `\n      "required": ${JSON.stringify(fields.required)},` +
      `\n      "optional": ${JSON.stringify(fields.optional)}`;
    return { ...documents, 'events.md': text.replace(block, `$1${body}$3`) };
  }

  /** Fails if a mutation did not actually change the text, which would be a no-op. */
  function assertDamaged(documents: Record<string, string>, needle: string): void {
    expect(
      Object.values(documents).some((text) => text.includes(needle)),
      `the mutation did not reach the documents, so this case would pass vacuously`,
    ).toBe(true);
  }

  it('fails when the document names an action the build does not register', async () => {
    const broken = publishedDocuments();
    broken['skill.md'] = broken['skill.md']?.replace(
      '"id": "session.create"',
      '"id": "session.begin"',
    ) as string;
    assertDamaged(broken, 'session.begin');

    const failure = await helloFailure(broken);
    expect(failure, 'an unregistered action id was accepted').toBeInstanceOf(Error);
  });

  it('fails when the document drops a field the action requires', async () => {
    const broken = publishedDocuments();
    // The owner id is what scopes a character lookup. Remove it from the
    // documented payload and an agent has no way to say who it is.
    broken['skill.md'] = broken['skill.md']?.replace(
      '"required": ["installationKey", "ownerId", "agentName", "harness"]',
      '"required": ["installationKey", "agentName", "harness"]',
    ) as string;
    assertDamaged(broken, '"required": ["installationKey", "agentName", "harness"]');

    const failure = await helloFailure(broken);
    expect(failure, 'a session was opened with no owner').toBeInstanceOf(Error);
    // The refusal comes from the server rather than from the agent, because an
    // agent reading this document genuinely cannot know the field is needed.
    // Both spellings are accepted because both are true sentences about the
    // same omission: the documented name and the server's reason code.
    expect(String((failure as Error).message)).toMatch(/ownerId|owner-id-not-a-string/);
  });

  it('fails when the document drops the step that opens a run entirely', async () => {
    const broken = publishedDocuments();
    broken['skill.md'] = broken['skill.md']?.replace(
      'The HELLO handshake. Starts or resumes a run.',
      'Reserved.',
    ) as string;
    assertDamaged(broken, 'Reserved.');

    // No action has a purpose the agent can match, so it cannot find the step.
    // This is the "the document leaves a required step implicit" case, and the
    // agent stalls rather than guessing an id.
    const failure = await helloFailure(broken);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/does not say how to do this/);
  });

  it('fails when the document misprices an outcome', async () => {
    const broken = publishedDocuments();
    broken['skill.md'] = broken['skill.md']?.replace(
      '{ "event": "test.passed", "xp": 100 }',
      '{ "event": "test.passed", "xp": 100000 }',
    ) as string;
    assertDamaged(broken, '100000');

    const agent = agentFor(broken);
    const hello = await agent.hello();
    const answer = (await agent.act('what an outcome is worth', {
      eventType: 'test.passed',
    })) as { xp?: number };
    // The platform is the authority and the document is the claim; this is the
    // direction of the disagreement that matters, because the document is what
    // an agent prices its work by.
    expect(answer.xp).not.toBe(100000);
    expect(answer.xp).toBe(100);
    await agent.finish(hello.sessionId, 'completed');
  });

  it('fails when the document points telemetry at a path nothing serves', async () => {
    const broken = publishedDocuments();
    broken['events.md'] = broken['events.md']?.replace(
      '"path": "/api/events"',
      '"path": "/api/telemetry"',
    ) as string;
    assertDamaged(broken, '/api/telemetry');

    const agent = agentFor(broken);
    const hello = await agent.hello();
    const response = (
      await agent.report([agent.event('test.passed', { suite: 'unit' }, hello.sessionId)])
    )[0];
    expect(response?.status, 'a batch sent to an unmounted path was accepted').not.toBe(200);
    await agent.finish(hello.sessionId, 'completed');
  });

  it('fails when the document states a version the server does not speak', async () => {
    const broken = publishedDocuments();
    // Anchored on the opening of the machine-readable block, NOT on the first
    // `"protocolVersion": "0.1.0"` in the file. Section 2 shows the same key in
    // a prose example, so an unanchored replace mutates the example and the test
    // passes on a document that is entirely unchanged — a mutation that is a
    // no-op and looks like a pass.
    broken['events.md'] = broken['events.md']?.replace(
      ['{', '  "protocolVersion": "0.1.0",', '  "ingest": {'].join('\n'),
      ['{', '  "protocolVersion": "0.2.0",', '  "ingest": {'].join('\n'),
    ) as string;
    assertDamaged(broken, ['  "protocolVersion": "0.2.0",', '  "ingest": {'].join('\n'));

    const agent = agentFor(broken);
    const hello = await agent.hello();
    const response = (
      await agent.report([agent.event('test.passed', { suite: 'unit' }, hello.sessionId)])
    )[0];
    expect(response?.status, 'a batch declaring an unknown protocol version was accepted').toBe(
      400,
    );
    expect(response?.body).toMatchObject({ receivedProtocol: '0.2.0' });
    await agent.finish(hello.sessionId, 'completed');
  });

  it('fails when the document names an event type the union does not have', async () => {
    const agent = agentFor();
    expect(() => agent.event('test.passed!', {}, 'any-session')).toThrow(
      /not one of the event types/,
    );
  });

  it('fails when the document under-requires a field the union demands', async () => {
    // The sharper of the two directions. `command.run` needs an `argv0`, and a
    // document that lists it as optional teaches an agent to omit it — so the
    // batch is refused and the agent reports a broken platform.
    //
    // Written as a REGEX rather than as an exact multi-line string, because the
    // first version of these two cases matched on prettier's line breaking and
    // `pnpm format` collapsed the arrays and turned both mutations into no-ops
    // that still reported green. A mutation that cannot survive the formatter
    // is a mutation that checks nothing, and the fix is to stop depending on
    // layout rather than to keep the layout stable.
    const broken = withEventFieldList(publishedDocuments(), 'command.run', {
      required: [],
      optional: ['argv0', 'exitCode'],
    });
    assertDamaged(broken, '"command.run"');

    const agent = agentFor(broken);
    const hello = await agent.hello();
    const response = (await agent.report([agent.event('command.run', {}, hello.sessionId)]))[0];
    expect(response?.status, 'a command.run with no argv0 was accepted').toBe(400);
    await agent.finish(hello.sessionId, 'completed');
  });

  it('fails when the document demands a field the event does not have', async () => {
    // The other direction, checked because it is the failure the brief names:
    // an agent that cannot produce the field the document asks for stops, and
    // it stops rather than guessing.
    const broken = withEventFieldList(publishedDocuments(), 'test.passed', {
      required: ['coverage'],
      optional: ['suite', 'count'],
    });
    assertDamaged(broken, '"coverage"');

    const agent = agentFor(broken);
    const hello = await agent.hello();
    // The agent throws while BUILDING the event rather than while sending it, so
    // the call goes inside the expectation rather than beside it.
    expect(() => agent.event('test.passed', { suite: 'unit' }, hello.sessionId)).toThrow(
      /requires "coverage"/,
    );
    await agent.finish(hello.sessionId, 'completed');
  });

  it('fails when the document routes the heartbeat at a path nothing serves', async () => {
    const broken = publishedDocuments();
    broken['heartbeat.md'] = broken['heartbeat.md']?.replace(
      '"path": "/api/sessions/{sessionId}/heartbeat"',
      '"path": "/api/session/{sessionId}/beat"',
    ) as string;
    assertDamaged(broken, '/api/session/{sessionId}/beat');

    const agent = agentFor(broken);
    const hello = await agent.hello();
    const response = await agent.beat(hello.sessionId);
    expect(response.status, 'a heartbeat to an unmounted path was accepted').toBe(404);
    await agent.finish(hello.sessionId, 'completed');
  });
});
