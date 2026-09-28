import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run, runsWithoutSession, parseArgv } from '../../packages/cli/src/commands.js';
import { readSession } from '../../packages/cli/src/session.js';
import type { ApplicationApi } from '../../packages/api/src/index.js';

/**
 * The verbs that must work before a session exists.
 *
 * ## What was actually broken
 *
 * `main()` read the session file and refused to dispatch anything when there was
 * none — before the dispatcher ran, so before it could see that the verb WAS
 * `login`. The first command a new operator could type was rejected with the
 * instruction to run the command that could not be reached:
 *
 *     $ agent-battle login http://127.0.0.1:3000 <token>
 *     not logged in. Run `agent-battle login <server-url> <token>`, or …
 *
 * `help` was refused the same way, so there was no way to discover the CLI
 * offered anything. The bead that built the CLI was closed; nothing had run it.
 *
 * ## Why the client throws here rather than being a stub
 *
 * The fix routes four verbs past the session check with no client at all, which
 * makes a new question: do any of them quietly reach for the API? A comment in
 * main.ts saying they do not is worth nothing — this file is the check, and it
 * fails the moment somebody adds a verb to `SESSIONLESS_VERBS` that needs a
 * server. Every method throws, so a reach is a red test rather than a request
 * that happens to succeed against whatever is on localhost.
 */

interface MethodNames {
  [key: string]: unknown;
}

function explodingApi(): ApplicationApi {
  const methods: MethodNames = {};
  for (const name of [
    'discover',
    'search',
    'act',
    'inspect',
    'observe',
    'capabilities',
    'schema',
  ]) {
    methods[name] = () => {
      throw new Error(`the sessionless path called api.${name}()`);
    };
  }
  return methods as unknown as ApplicationApi;
}

describe('which verbs run without a session', () => {
  it('admits the four that create or inspect one', () => {
    // The list is the fix. `discover` and `status` are deliberately absent: they
    // need a server, and "not logged in" is a real answer for them.
    for (const verb of ['help', '--help', 'login', 'init', 'logout']) {
      expect(runsWithoutSession([verb]), `${verb} should run without a session`).toBe(true);
    }
  });

  it('refuses the verbs that genuinely need a server', () => {
    for (const verb of ['discover', 'status', 'doctor', 'quest', 'battle', 'bounty']) {
      expect(runsWithoutSession([verb]), `${verb} should require a session`).toBe(false);
    }
  });

  it('refuses an empty invocation rather than treating it as help', () => {
    // `agent-battle` with no arguments reaches the dispatcher's usage branch,
    // but it is not a verb anybody named, and treating "" as sessionless would
    // let a future refactor route unknown input around the check.
    expect(runsWithoutSession([])).toBe(false);
  });

  it('sees the verb through --json, which is stripped before dispatch', () => {
    // The check runs on the PARSED argv. If it ran on the raw argv, then
    // `agent-battle --json login …` would look sessionless while dispatch saw
    // `login` — fine — and `agent-battle login --json` would look like the verb
    // is `--json` and be refused. Both orders have to work.
    expect(runsWithoutSession(parseArgv(['--json', 'login', 'http://x', 't']).argv)).toBe(true);
    expect(runsWithoutSession(parseArgv(['login', 'http://x', 't', '--json']).argv)).toBe(true);
  });
});

describe('the four verbs never reach for the server', () => {
  it('help prints usage and does not touch the API', async () => {
    const result = await run(explodingApi(), parseArgv(['help']));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('agent-battle');
  });

  it('init reports an unconfigured machine and does not touch the API', async () => {
    // `init` reads the session FILE, which is a local read, not a server call.
    // The result depends on whether this machine is logged in, so the assertion
    // is on the shape and the exit code rather than on either answer.
    const result = await run(explodingApi(), parseArgv(['init']));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/configured/);
  });

  it('logout succeeds without a session, because that is the state it targets', async () => {
    // Pointed at a temp directory for the reason in session.ts: `logout` DELETES
    // the session file, and the first version of this test ran it against the
    // real one. It passed, and it logged the developer out of their own server
    // mid-suite — the next `agent-battle bounty claim` answered "not logged in"
    // and looked like the fix had regressed.
    //
    // The side effect is the assertion, and it is asserted as "no session
    // afterwards" rather than "no file". `clearSession` writes `{}` rather than
    // unlinking, deliberately: the file then always exists, so its 0600 mode
    // never lapses and `login` never has to create a directory under a
    // different umask. The version of this test that asserted the file was gone
    // was asserting a deletion the CLI does not do.
    const home = mkdtempSync(join(tmpdir(), 'agent-battle-home-'));
    const path = join(home, '.agent-battle', 'session.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ baseUrl: 'http://x.test', token: 't' }), { mode: 0o600 });
    expect(readSession(path)).toBeDefined();

    const priorHome = process.env.AGENT_BATTLE_HOME;
    try {
      process.env.AGENT_BATTLE_HOME = home;
      const result = await run(explodingApi(), parseArgv(['logout']));

      expect(result.exitCode).toBe(0);
      expect(readSession(path)).toBeUndefined();
    } finally {
      if (priorHome === undefined) delete process.env.AGENT_BATTLE_HOME;
      else process.env.AGENT_BATTLE_HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
