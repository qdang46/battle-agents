import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { gateFor } from './viewer-gate.js';
import { SIGN_IN_PATH, type Viewer } from '../viewer-view.js';

/**
 * The three gates, and that they stay three.
 *
 * ## Why this file is here and not under tests/unit
 *
 * Because `gateFor` returns React elements out of a `.tsx` file, and the root
 * tsconfig deliberately has no `jsx` setting: the first version of this suite
 * lived at `tests/unit/viewer-gate.test.ts` and `tsc` refused it with
 * "'--jsx' is not set". Every other root test imports `.ts` from `apps/web` and
 * never a component, and that boundary is load-bearing rather than incidental —
 * the root typecheck is what proves a library package cannot quietly acquire
 * browser globals, and a component import would have meant loosening it.
 *
 * Here the app's own tsconfig has `jsx` configured and `react-dom` resolves,
 * because this file is inside `apps/web`. The unit stage includes test files
 * under an app's `src`, so it still runs in the same gate — a test moved to a
 * directory nothing globs would be the same defect as a check nobody invokes.
 *
 * The companion at `tests/unit/viewer-gate.test.ts` covers the `.ts` half:
 * `resolveViewer`'s catch, and the reader predicate.
 */

/**
 * The three answers a visitor can get, and that they stay three.
 *
 * `viewer-view.ts` says the states "look alike in a browser and mean three
 * different things to the person looking: they need to sign in, the operator
 * needs to finish `cp .env.example .env`, and everything is fine. A gate that
 * collapsed them would tell a developer their OAuth app is broken when they
 * have simply not signed in yet, and tell a signed-out visitor that the
 * platform is misconfigured."
 *
 * None of that was asserted anywhere. The conflation is the failure, so most of
 * what follows is about the gates being DISTINCT rather than about any one of
 * them being present.
 */

/**
 * `createElement` rather than JSX, and the reason is the filename.
 *
 * The unit stage globs test files under an app's `src` and only as `.ts`;
 * renaming this to `.tsx` would take it out of the run entirely and leave a
 * test file nothing executes. The `.tsx` problem is therefore solved in the
 * call rather than in the glob.
 */
function rendered(viewer: Viewer): string {
  return renderToStaticMarkup(createElement(Fragment, null, gateFor(viewer)));
}

describe('the gate each answer renders', () => {
  it('opens for a signed-in viewer, and only for one', () => {
    expect(gateFor({ kind: 'signed-in', login: 'octocat' })).toBeNull();
  });

  it('tells a signed-out visitor to sign in, and does NOT blame the operator', () => {
    // A logged-out reader must never be told the platform is misconfigured,
    // because nothing is misconfigured and they will go looking for a problem
    // that is not there.
    const markup = rendered({ kind: 'signed-out' });

    expect(markup).toContain('Sign in to see the board');
    expect(markup).toContain(SIGN_IN_PATH);
    expect(markup).not.toContain('not configured');
    expect(markup).not.toContain('.env');
  });

  it('tells an operator which variables are empty, and does NOT offer a sign-in link', () => {
    // The mirror image. A sign-in button to somebody whose OAuth app does not
    // exist sends them through a flow that cannot complete.
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
