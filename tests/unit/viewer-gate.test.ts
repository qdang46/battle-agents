import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveViewer, viewerMayRead } from '../../apps/web/src/viewer-view.js';

/**
 * The three answers a visitor can get, and that they stay three.
 *
 * ## Why this exists
 *
 * `viewer-view.ts` says the three states "look alike in a browser and mean three
 * different things to the person looking: they need to sign in, the operator
 * needs to finish `cp .env.example .env`, and everything is fine. A gate that
 * collapsed them would tell a developer their OAuth app is broken when they
 * have simply not signed in yet, and tell a signed-out visitor that the
 * platform is misconfigured."
 *
 * There was no test for any of it. `resolveViewer` and `gateFor` had zero
 * coverage, so the module's own stated reason for existing was a comment.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT. Only the `.ts` half. `gateFor` returns
 * React elements from a `.tsx` file, and the ROOT tsconfig deliberately has no
 * `jsx` setting, so a test under `tests/unit/` cannot import one -- the first
 * version of this file did, and `tsc` refused it with "'--jsx' is not set".
 * That is the shape working: every other root test imports `.ts` from apps/web
 * and never a component. The rendering half is `apps/web/src/ui/viewer-gate.test.ts`,
 * which runs in the same unit stage and is typechecked by the app's own config.
 *
 * ## What the sharp edge actually is
 *
 * `readAuthEnvironment` THROWS when a variable is missing, and the module calls
 * that "the correct behaviour for a startup". It is not correct on a page
 * render: uncaught it is a 500 for somebody who did nothing wrong, on a fresh
 * clone, for every route in the `(app)` group. So the catch in `resolveViewer`
 * is the difference between a gate that names the missing variables and a stack
 * trace on the front page — which is what a first-time visitor sees instead.
 *
 * The environment is deleted and restored rather than stubbed, because the
 * variable's absence is the thing under test. Removing it and putting it back
 * is not a shortcut here; it is the scenario.
 */

const AUTH_VARIABLES = [
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
] as const;

/**
 * Everything `sharedAuth` touches, which is the four plus the pool.
 *
 * `AGENT_BATTLE_DEV_LOGIN` is in this list and not because `sharedAuth` reads it.
 * It is here because a developer who has followed the .env.example instructions
 * and exported the flag in their shell would otherwise have every assertion in
 * this file fail for a reason that has nothing to do with what it is testing —
 * and the fix a person reaches for is to delete the flag, not to notice that the
 * test depends on ambient environment. The environment under test is deleted and
 * restored; a variable this file does not name is not part of it.
 */
const TOUCHED = [...AUTH_VARIABLES, 'DATABASE_URL', 'AGENT_BATTLE_DEV_LOGIN'] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of TOUCHED) saved.set(name, process.env[name]);
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('resolveViewer on a deployment with nothing configured', () => {
  it('turns the startup throw into a state the page can render', async () => {
    // The behaviour that separates a helpful gate from a 500 on the front page.
    for (const name of TOUCHED) delete process.env[name];

    await expect(resolveViewer(new Headers())).resolves.toMatchObject({
      kind: 'auth-unconfigured',
    });
  });

  it('names every variable that is missing, not just the first', async () => {
    // An operator reading this gate should be able to fix it in one pass. A gate
    // that names one variable sends them round the loop once per restart.
    for (const name of TOUCHED) delete process.env[name];
    process.env.BETTER_AUTH_SECRET = 'a-secret-that-is-long-enough-for-the-check';

    const viewer = await resolveViewer(new Headers());

    expect(viewer.kind).toBe('auth-unconfigured');
    if (viewer.kind !== 'auth-unconfigured') return;
    expect([...viewer.missing].sort()).toEqual(
      ['BETTER_AUTH_URL', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'].sort(),
    );
  });

  it('does not claim it is unconfigured when every variable is present', async () => {
    // The other direction, and the one that stops the catch above from being a
    // blanket "always report unconfigured". With a complete environment the
    // module must get as far as asking the auth server, which is a different
    // kind of answer. A connection error here is expected and is swallowed: the
    // point is only that the unconfigured branch was not taken.
    process.env.BETTER_AUTH_SECRET = 'a-secret-that-is-long-enough-for-the-check';
    process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3000';
    process.env.GITHUB_CLIENT_ID = 'a-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'a-client-secret';
    process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5433/battle_test';

    const answer = await resolveViewer(new Headers()).catch(() => 'unreachable' as const);

    expect(answer).not.toMatchObject({ kind: 'auth-unconfigured' });
  });
});

describe('resolveViewer under the development bypass', () => {
  it('answers dev-login WITHOUT reading the auth configuration', async () => {
    // The order matters as much as the answer: a developer with no OAuth app
    // must not have to configure one to look at the product, so the bypass is
    // consulted before `sharedAuth()` is ever called. Deleting every auth
    // variable is what makes that observable -- if the bypass were checked after
    // the config read, this would answer `auth-unconfigured` and the whole
    // feature would be dead on a clean clone, which is precisely the case it
    // exists for.
    for (const name of TOUCHED) delete process.env[name];
    process.env.AGENT_BATTLE_DEV_LOGIN = '1';

    await expect(resolveViewer(new Headers())).resolves.toEqual({ kind: 'dev-login', login: 'dev-login' });
  });

  it('still refuses under NODE_ENV=production, and says why', async () => {
    // The guard, exercised through the function that consumes it rather than
    // only through `devLoginEnabled`. A deployment that sets the flag in its
    // environment must land on the ordinary gate.
    //
    // NODE_ENV is restored by hand rather than through the TOUCHED list, which
    // is about variables this file deletes to provoke a branch. This one is
    // overwritten to provoke a branch, and leaving it set to `production` would
    // change what every test after this one resolves.
    const priorNodeEnv = process.env.NODE_ENV;
    try {
      for (const name of TOUCHED) delete process.env[name];
      process.env.AGENT_BATTLE_DEV_LOGIN = '1';
      process.env.NODE_ENV = 'production';

      const answer = await resolveViewer(new Headers());

      // Asserting the SHAPE rather than the specific state, and the reason is
      // worth recording: `sharedAuth` memoises its instance, so whichever test
      // first builds it decides whether a later unconfigured render throws
      // (`auth-unconfigured`) or gets a cached server and a null session
      // (`signed-out`). Both are closed. Asserting one of them would make this
      // file's verdict depend on its own ordering, which is a test that passes
      // for a reason nobody can state.
      expect(answer).not.toMatchObject({ kind: 'dev-login' });
      expect(['auth-unconfigured', 'signed-out']).toContain(answer.kind);
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });
});

describe('viewerMayRead', () => {
  it('admits a signed-in viewer and refuses the other two', () => {
    expect(viewerMayRead({ kind: 'signed-in', login: 'octocat' })).toBe(true);
    expect(viewerMayRead({ kind: 'signed-out' })).toBe(false);
    // An unconfigured deployment is NOT a free pass. The gate exists to keep
    // the board empty until it is answered, and a reader predicate that
    // admitted this state would put it straight back.
    expect(viewerMayRead({ kind: 'auth-unconfigured', missing: ['X'] })).toBe(false);
  });

  it('admits the development bypass, because admitting it is the whole point of it', () => {
    // Stated rather than assumed, because this is the assertion that makes the
    // bypass a way to SEE the product. The counterweight is not here: it is that
    // `devLoginEnabled` refuses under NODE_ENV=production, tested in
    // dev-login.test.ts, so this predicate only ever sees a state the guard has
    // already cleared.
    expect(viewerMayRead({ kind: 'dev-login', login: 'dev-login' })).toBe(true);
  });
});
