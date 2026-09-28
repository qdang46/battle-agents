import {
  createRuntime,
  defineAction,
  createInMemoryEventBus,
  InMemoryStateStore,
} from '@battle-agents/core';
import { createApplicationApi } from '@battle-agents/api';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseArgv, run } from './commands.js';

const SOURCE_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Two domains, so "the CLI did not special-case one" is observable. */
function api() {
  return createApplicationApi(
    createRuntime({
      extensions: [
        {
          id: 'quest',
          capabilities: [{ name: 'quest.read', description: 'read quests' }],
          actionDefs: [
            defineAction({
              id: 'quest.claim',
              permissions: ['quest.claim'],
              run: async (input: { questId: string }) => ({ claimed: input.questId }),
            }),
            defineAction({
              // Three segments on purpose. The registry pattern allows them, and
              // a CLI that read only the second segment would list this as
              // "admin" and send 'quest admin' to a search that finds
              // nothing, while the action the caller asked for sits there.
              id: 'quest.admin.revoke',
              permissions: ['quest.admin.revoke'],
              run: async (input: { questId: string }) => ({ revoked: input.questId }),
            }),
            defineAction({
              id: 'quest.submit',
              permissions: ['quest.submit'],
              run: async (input: { questId: string; prUrl: string }) => ({ submitted: input.prUrl }),
            }),
          ],
        },
        {
          // A second REAL domain, deliberately. The test proves the CLI has no
          // per-feature code, and an invented domain would now prove nothing:
          // the generated union describes this build, so an id that is not in it
          // is refused at the boundary, whatever the CLI thinks it can reach.
          id: 'reputation',
          capabilities: [{ name: 'reputation.read', description: 'read reputation' }],
          actionDefs: [
            defineAction({
              id: 'reputation.read',
              permissions: ['reputation.read'],
              run: async (input: { agentId: string }) => ({ trust: input.agentId }),
            }),
          ],
        },
      ],
      store: new InMemoryStateStore(),
      bus: createInMemoryEventBus(),
      now: () => '2026-09-24T12:00:00.000Z',
    }),
  );
}

function invoke(...argv: string[]) {
  return run(api(), parseArgv(argv));
}

describe('the CLI reaches every domain it has never heard of', () => {
  it('runs an action from a domain it has no code for', async () => {
    const result = await invoke('quest', 'claim', '--questId', 'abc123');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('claimed: abc123');
  });

  it('reaches a second domain with the same three lines', async () => {
    const result = await invoke('reputation', 'read', '--agentId', 'r-9');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('trust: r-9');
  });

  it('reaches an action whose id has more than two segments', async () => {
    const result = await invoke('quest', 'admin.revoke', '--questId', 'q-9');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('revoked: q-9');
  });

  it('lists what a domain can do when given no verb', async () => {
    const result = await invoke('quest');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('claim');
    expect(result.stdout).toContain('submit');
    // The whole verb, not just its first segment.
    expect(result.stdout).toContain('admin.revoke');
  });

  it('lists every domain at once', async () => {
    const result = await invoke('discover');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('reputation');
    expect(result.stdout).toContain('quest');
  });

  it('reports what is installed without knowing what it is', async () => {
    const result = await invoke('status');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('2 domain(s) available');
  });
});

describe('a verb that is not an action', () => {
  it('searches instead of failing', async () => {
    const result = await invoke('quest', 'cla');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('quest.claim');
  });

  it('says what the domain does offer when nothing matches', async () => {
    const result = await invoke('quest', 'zzz');

    expect(result.exitCode).toBe(1);
    // Each verb, rather than the exact list: the list grows every time a
    // feature adds an action, and a test that breaks on that teaches people to
    // delete the test.
    expect(result.stderr).toContain('This domain offers:');
    for (const verb of ['admin.revoke', 'claim', 'submit']) {
      expect(result.stderr).toContain(verb);
    }
  });
});

describe('failures a caller can act on', () => {
  it('names the known domains when the one asked for does not exist', async () => {
    const result = await invoke('guild', 'join');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown domain "guild"');
    expect(result.stderr).toContain('quest, reputation');
  });

  it('prints usage when given nothing at all', async () => {
    const result = await invoke();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('USAGE');
  });
});

describe('--json, because an agent drives this too', () => {
  it('returns the same data in a machine form', async () => {
    const result = await invoke('quest', 'claim', '--questId', 'abc123', '--json');

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ claimed: 'abc123' });
  });

  it('strips the flag wherever it appears', async () => {
    const result = await invoke('--json', 'quest', 'claim', '--questId', 'abc123');

    expect(JSON.parse(result.stdout)).toEqual({ claimed: 'abc123' });
  });

  it('reports failures in the machine form too, on stderr', async () => {
    const result = await invoke('guild', 'join', '--json');

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ kind: 'usage' });
  });
});

describe('the CLI contains no per-feature code', () => {
  it('names no game domain anywhere in the package', () => {
    // The review guard from plan section 36, as a test rather than a review
    // note. A CLI that grows an `if (domain === 'quest')` branch is correct
    // until the second feature arrives, and the difference it makes is invisible
    // until an agent's command works on one surface and not another.
    const reserved = /\b(quest|quests|battle|battles|bounty|bounties|guild|guilds)\b/i;

    for (const file of readdirSync(SOURCE_DIR).filter((name) => name.endsWith('.ts'))) {
      // Test fixtures name domains on purpose; the shipped code must not.
      if (file.endsWith('.test.ts')) {
        continue;
      }
      const code = neutraliseOwnName(stripComments(readFileSync(join(SOURCE_DIR, file), 'utf8')));
      const offender = code.match(reserved)?.[0];
      expect(offender, `${file} names the game domain "${offender}"`).toBeUndefined();
    }
  });
});

/**
 * Blanks the two things that are always allowed to contain a game word.
 *
 * The binary is called `agent-battle` and the packages are `@battle-agents/*`,
 * so a naive scan trips on the tool's own name and its own imports — which is
 * the fastest way to get a guard deleted. A hyphen is a word boundary, so
 * `\bbattle\b` matches inside `agent-battle` just as happily as inside
 * `battle.accept`.
 */
function neutraliseOwnName(source: string): string {
  return source.replace(/agent-battle/g, 'the-cli').replace(/@battle-agents[\w/-]*/g, '@pkg');
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the agent runtime verbs', () => {
  it('routes start and stop through the ordinary domain path', async () => {
    // Not special-cased into game knowledge: a runtime verb resolves a domain,
    // checks the action is registered, and dispatches exactly as `quest.claim`
    // does. That is the property that keeps a new feature reachable from the
    // CLI with no change here.
    const started = await invoke('start');
    const stopped = await invoke('stop');

    // Both are answered by the same dispatcher, so both look the same to a
    // caller: the failure is in stderr and the exit code says so.
    expect(started.stderr).toBe(stopped.stderr);
    expect(started.exitCode).toBe(stopped.exitCode);
  });

  it('names what this build actually has, not a missing command', async () => {
    // There is no session domain in this build, so the answer a caller gets is
    // the one that is useful: which domains DO exist. An earlier expectation
    // here wanted the message to name session.start, which would have been
    // worse advice, since naming an action this build does not register is
    // how someone wires a call that cannot work.
    const result = await invoke('start');

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/session/);
    expect(result.stderr).toMatch(/quest|Known:/);
  });
});

describe('the local configuration commands', () => {
  it('answers rather than failing, and says what to do next', async () => {
    // The assertion is on the message, not on the presence or absence of a
    // session: init is a read, and a read that cannot answer is a read the
    // caller has to guess at. What they need is the next command.
    //
    // Which is why this takes EITHER answer. The version it replaces asserted
    // `/login/`, which is only true on a machine that has never logged in — so
    // it went red the moment it did, and the fix a person reaches for is to
    // delete the session rather than to notice that the test was asserting the
    // machine's history. "Configured" is as useful an answer as "not yet", and
    // both are answers.
    const result = await invoke('init').catch((error: unknown) => error);
    const text = JSON.stringify(result);

    expect(text).toMatch(/configured: (true|false)/);
    expect(text).toMatch(/login|serverUrl/);
  });

  it('refuses login without both halves, rather than storing half a session', async () => {
    const result = await invoke('login', 'http://api.test').catch((error: unknown) => error);

    // A session with a base URL and no token fails on the first call, and the
    // failure would name the API rather than the login that caused it.
    expect(JSON.stringify(result)).toMatch(/token/i);
  });
});
