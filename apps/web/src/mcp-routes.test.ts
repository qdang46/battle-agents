import { createApplicationApi } from '@battle-agents/api';
import type { ApplicationApi } from '@battle-agents/api';
import {
  createInMemoryEventBus,
  createRuntime,
  defineAction,
  InMemoryStateStore,
} from '@battle-agents/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AuthenticationError } from '@battle-agents/db';

import { describe, expect, it } from 'vitest';

import { createMcpRoutes } from './mcp-routes.js';
import { createMcpSessionStore, serverFactoryFor } from './mcp-sessions.js';
import type { McpNotification } from './mcp-sessions.js';
import type { HttpRequest } from './routes.js';

/**
 * The MCP routes' two jobs: refuse a bad credential, and keep a session's
 * subscriptions alive across the requests that use them.
 *
 * The lifetime one is the interesting half. A server built per request cannot
 * deliver a notification, because the subscription dies with the response that
 * opened it — which is what the first version of this file asserted as correct.
 * It is not correct; it is the bug the session store exists to remove, and a
 * test that pinned it would have pinned the wrong thing.
 */

const SESSION_ID = 'session-under-test';
const NOW = '2026-09-25T12:00:00.000Z';

const FIXTURE = {
  id: 'quest',
  capabilities: [{ name: 'quest.read', description: 'reads quests' }],
  actionDefs: [
    defineAction({
      id: 'quest.claim',
      permissions: ['quest.claim'],
      run: async () => ({ claimed: 'an-issue' }),
    }),
  ],
};

function apiWithBus(): { api: ApplicationApi; publish: (type: string) => void } {
  const bus = createInMemoryEventBus();
  const runtime = createRuntime({
    extensions: [FIXTURE],
    store: new InMemoryStateStore(),
    bus,
    now: () => NOW,
  });
  return {
    api: createApplicationApi(runtime, bus),
    publish: (type) => {
      bus.publish({ type, occurredAt: NOW, actorId: 'agent-1', payload: { questId: 'q-1' } });
    },
  };
}

function request(body: unknown, init: { sessionId?: string; method?: string } = {}): HttpRequest {
  const headers = new Map<string, string>([
    ['accept', 'application/json, text/event-stream'],
    ['content-type', 'application/json'],
    ['authorization', 'Bearer agent_battle_a_valid_token'],
  ]);
  if (init.sessionId !== undefined) {
    headers.set('mcp-session-id', init.sessionId);
  }
  return {
    method: init.method ?? 'POST',
    url: 'https://host/api/mcp',
    headers: { get: (name) => headers.get(name) ?? null },
    body,
  };
}

function toolsCall(id: number, name: string, args: unknown = {}) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18' },
};

function routesWith(
  authenticate: (req: HttpRequest) => Promise<unknown> = async () => ({ installationId: 'inst-1' }),
  keepAliveMs = 5,
) {
  const { api, publish } = apiWithBus();
  const sessions = createMcpSessionStore({ createServer: serverFactoryFor(api) });
  const handle = createMcpRoutes({
    authenticate,
    sessions,
    newSessionId: () => SESSION_ID,
    keepAliveMs,
  });
  return { handle, sessions, publish };
}

describe('a refused credential', () => {
  it('answers 401 and names the reason, for each refusal the credential layer can make', async () => {
    // Each reason is asserted rather than lumped into one case, because the
    // reason is the only thing that tells a caller which of the two things to
    // fix. A single "401 for all of them" test would pass against a route that
    // had lost the reason entirely.
    for (const reason of ['missing', 'token-in-url', 'expired', 'revoked', 'unknown'] as const) {
      const { handle } = routesWith(async () => {
        throw new AuthenticationError({ reason });
      });

      const response = await handle(request(toolsCall(1, 'act')));

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ error: 'authentication failed', reason });
    }
  });

  it('names the missing scope, so the caller knows to issue a wider credential', async () => {
    // `explain` puts the required scope in the message and nowhere else, so a
    // 401 that carried only the reason tag would say "unauthorized" and send
    // the caller to renew a credential that would be refused identically.
    const { handle } = routesWith(async () => {
      throw new AuthenticationError({ reason: 'scope-missing', required: 'mcp' });
    });

    const response = await handle(request(toolsCall(1, 'act')));

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ reason: 'scope-missing' });
    expect((response.body as { message: string }).message).toContain('"mcp"');
  });

  it('never reaches the protocol', async () => {
    const { handle, sessions } = routesWith(async () => {
      throw new AuthenticationError({ reason: 'expired' });
    });

    await handle(request(toolsCall(1, 'act')));

    expect(sessions.size).toBe(0);
  });
});

describe('an authenticator that is itself broken', () => {
  it('answers 500, because the credential was never the problem', async () => {
    const { handle } = routesWith(async () => {
      throw new Error('connection pool exhausted');
    });

    const response = await handle(request(toolsCall(1, 'act')));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'the authenticator failed',
      detail: 'connection pool exhausted',
    });
  });
});

describe('a session outlives the request that opened it', () => {
  it('mints an id on initialize and stores the session under that same id', async () => {
    const { handle, sessions } = routesWith();

    const response = await handle(request(INITIALIZE));

    expect(response.status).toBe(200);
    expect(response.headers?.['mcp-session-id']).toBe(SESSION_ID);
    expect(sessions.find(SESSION_ID)).toBeDefined();
  });

  it('keeps a subscription open for a later request on the same session', async () => {
    // The bug this store exists for. With a server per request, the observe call
    // below would succeed and then be discarded, and the publish would reach
    // nothing.
    const { handle, sessions, publish } = routesWith();

    await handle(request(INITIALIZE));
    const observed = await handle(request(toolsCall(2, 'observe'), { sessionId: SESSION_ID }));
    expect(observed.status).toBe(200);

    publish('quest.claimed');

    const session = sessions.find(SESSION_ID);
    const queued = session?.drain() as readonly McpNotification[] | undefined;
    expect(queued).toHaveLength(1);
    expect(queued?.[0]?.method).toBe('notifications/event');
  });

  it('drops the session when neither an id was presented nor one was returned', async () => {
    // Otherwise a client that never calls initialize accumulates one unreachable
    // session per request.
    const { handle, sessions } = routesWith();

    await handle(request(toolsCall(1, 'act')));

    expect(sessions.size).toBe(0);
  });

  it('refuses a GET for a session it does not have', async () => {
    const { handle } = routesWith();

    const response = await handle(request(undefined, { sessionId: 'never-opened', method: 'GET' }));

    expect(response.status).toBe(404);
  });

  it('closes a session on DELETE, and forgets it', async () => {
    const { handle, sessions } = routesWith();
    await handle(request(INITIALIZE));

    const response = await handle(request(undefined, { sessionId: SESSION_ID, method: 'DELETE' }));

    expect(response.status).toBe(204);
    expect(sessions.find(SESSION_ID)).toBeUndefined();
  });

  it('refuses a method it does not speak', async () => {
    const { handle } = routesWith();

    const response = await handle(request(undefined, { method: 'PUT' }));

    expect(response.status).toBe(405);
    expect(response.headers?.allow).toBe('POST, GET, DELETE');
  });
});

describe('the notification stream', () => {
  it('writes an observed event down the stream, as an SSE message', async () => {
    const { handle, publish } = routesWith();

    await handle(request(INITIALIZE));
    await handle(request(toolsCall(2, 'observe'), { sessionId: SESSION_ID }));
    const opened = await handle(request(undefined, { sessionId: SESSION_ID, method: 'GET' }));
    const stream = opened.body as ReadableStream<Uint8Array>;
    const reader = stream.getReader();

    publish('quest.claimed');

    // Read past any keepalive rather than asserting the first chunk is the
    // event. Whether a keepalive lands first is a scheduling accident; whether
    // the event arrives at all is the property.
    let text = '';
    for (let attempt = 0; attempt < 5 && !text.includes('notifications/event'); attempt += 1) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      text += new TextDecoder().decode(chunk.value);
    }

    expect(text).toContain('event: message');
    expect(text).toContain('notifications/event');
    expect(text).toContain('"jsonrpc":"2.0"');

    await handle(request(undefined, { sessionId: SESSION_ID, method: 'DELETE' }));
    await reader.cancel();
  });
});

describe('the Next.js adapter passes the body through unserialised', () => {
  // The first version of the route returned `JSON.stringify(response.body)`,
  // which is correct for a JSON-RPC answer and silently wrong for the stream:
  // JSON.stringify of a ReadableStream is `{}`, so every client that opened the
  // GET got an empty object. A handler test could not catch it, because the
  // handler was fine and the adapter was not.
  //
  // A source assertion rather than a behavioural one, because the route builds
  // a database pool on first use and the alternative was a test that could only
  // run against a live Postgres to check a one-line transport detail. It is
  // deliberately narrow: it forbids one specific call, not a style.
  const ROUTE_SOURCE = readFileSync(
    fileURLToPath(new URL('../app/api/mcp/route.ts', import.meta.url)),
    'utf8',
  );

  // Comments are stripped first, for the reason tests/unit/scaffold.test.ts
  // strips them: the paragraph explaining this very bug quotes the forbidden
  // call verbatim, and a guard that matched its own documentation would have to
  // be deleted the moment somebody documented what went wrong.
  const ROUTE_CODE = ROUTE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('does not stringify the handler body', () => {
    expect(ROUTE_CODE).not.toContain('JSON.stringify(response.body)');
  });

  it('routes the body through toResponseBody, which is where the stream rule lives', () => {
    // This used to assert that the route contained the literal
    // `response.body as ConstructorParameters<typeof Response>[0]`, which
    // PINNED THE BUG: passing the body straight to `new Response` is what made
    // every non-stream response the eight characters `[object Object]`. The
    // test's intent -- a ReadableStream must survive -- was right and its
    // mechanism was wrong, because asserting an implementation string cannot
    // see that the implementation is broken.
    //
    // The property is now a behaviour, asserted in http-body.test.ts: a stream
    // passes through, an object is serialised, and a content-type is owed only
    // when something was. This case now checks only that the route delegates
    // there, which is the part this file can see.
    expect(ROUTE_CODE).toContain('toResponseBody(response.body)');
  });

  it('exports the three verbs the transport needs', () => {
    for (const verb of ['POST', 'GET', 'DELETE']) {
      expect(ROUTE_CODE).toContain(`export const ${verb} = respond;`);
    }
  });
});
