import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gateFor } from '../../apps/web/src/ui/viewer-gate.js';
import { resolveViewer, SIGN_IN_PATH, viewerMayRead } from '../../apps/web/src/viewer-view.js';
import type { Viewer } from '../../apps/web/src/viewer-view.js';

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

/**
 * Every string reachable in a returned element tree, including attributes.
 *
 * Not `renderToStaticMarkup`, and the reason is worth recording: `react` is a
 * dependency of `apps/web`, not of the workspace root, and the unit stage runs
 * from the root. A test that imports react to render a gate is a test that
 * cannot be written where it is needed — and the existing suites do not render
 * components for exactly that reason. Reading the element the function already
 * built needs nothing but the object it returns.
 */
function textsOf(node: unknown, into: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') {
    into.push(String(node));
  } else if (Array.isArray(node)) {
    for (const child of node) textsOf(child, into);
  } else if (typeof node === 'object' && node !== null) {
    const props = (node as { readonly props?: Record<string, unknown> }).props;
    for (const value of Object.values(props ?? {})) textsOf(value, into);
  }
  return into;
}

function rendered(viewer: Viewer): string {
  return textsOf(gateFor(viewer)).join('\n');
}

/**
 * The four `readAuthEnvironment` checks, and only those.
 *
 * `DATABASE_URL` is deliberately NOT in this list. It is not an auth variable:
 * `sharedAuth()` reads the four, then builds a pool from the database URL, so a
 * gate listing it would be reporting something `readAuthEnvironment` never
 * checks. The first version of this test listed five and asserted on five, and
 * failed — which is the failure working, not a defect in the code.
 */
const AUTH_VARIABLES = [
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
] as const;

/** Everything `sharedAuth` touches, which is the four plus the pool. */
const TOUCHED = [...AUTH_VARIABLES, 'DATABASE_URL'] as const;

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

describe('the gate each answer renders', () => {
  it('opens for a signed-in viewer, and only for one', () => {
    expect(gateFor({ kind: 'signed-in', login: 'octocat' })).toBeNull();
  });

  it('tells a signed-out visitor to sign in, and does NOT blame the operator', () => {
    // The conflation the module exists to prevent. A logged-out reader must
    // never be told the platform is misconfigured, because nothing is
    // misconfigured and they will go looking for a problem that is not there.
    const markup = rendered({ kind: 'signed-out' });

    expect(markup).toContain('Sign in to see the board');
    expect(markup).toContain(SIGN_IN_PATH);
    expect(markup).not.toContain('not configured');
    expect(markup).not.toContain('.env');
  });

  it('tells an operator which variables are empty, and does NOT offer a sign-in link', () => {
    // The mirror image. Offering a sign-in button to somebody whose OAuth app
    // does not exist sends them through a flow that cannot complete.
    const markup = rendered({ kind: 'auth-unconfigured', missing: ['GITHUB_CLIENT_ID'] });

    expect(markup).toContain('Sign-in is not configured on this deployment');
    expect(markup).toContain('GITHUB_CLIENT_ID');
    expect(markup).not.toContain(SIGN_IN_PATH);
  });

  it('keeps the three answers distinguishable, which is the whole reason there are three', () => {
    // Asserted as distinct OUTPUTS rather than as three separate cases, because
    // the failure is a COLLAPSE: any two of these rendering the same thing is
    // the bug, and three individually-passing tests would not notice it.
    const outputs = new Set([
      rendered({ kind: 'signed-out' }),
      rendered({ kind: 'auth-unconfigured', missing: ['X'] }),
      rendered({ kind: 'signed-in', login: 'a' }),
    ]);

    expect(outputs.size).toBe(3);
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
});
