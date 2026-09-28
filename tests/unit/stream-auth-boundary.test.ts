import { describe, expect, it } from 'vitest';

import { mayOpenStream, streamRefusal } from '../../apps/web/src/stream-access.js';
import type { Viewer } from '../../apps/web/src/viewer-view.js';

/**
 * The event stream is closed to a reader with no web session.
 *
 * ## What was being claimed, and by what
 *
 * `event-routes.ts` carried a comment saying the stream was unauthenticated
 * "deliberately", on the grounds that per-battle scoping "arrives with the game
 * client". `docs/design/public-event-stream.md` — the document that DECIDED the
 * classification this stream implements — says:
 *
 * > Until both exist, the correct state is that the stream is **closed**, not
 * > that it is open and filtered. An unauthenticated endpoint carrying the
 * > activity log is worse than no endpoint, because the activity log is the
 * > system's audit trail and the dispute evidence described in
 * > `docs/design/payout-rail.md` rests on it.
 *
 * The code and the document disagreed, and the bead that opened this as a bug
 * (`ba-9hr`) closed without closing it. A comment asserting a design decision is
 * worth exactly as much as the last time somebody wrote one, which is why this
 * file asserts the ANSWER rather than the reasoning.
 *
 * ## What is asserted, and what is deliberately not
 *
 * Asserted: a reader with no session is refused, and the refusal names the state
 * they are in. That is the half of the condition the document required, and the
 * half that was missing.
 *
 * NOT asserted: anything about scoping — one battle versus the whole arena. The
 * same paragraph defers it, on the grounds that the classification is already
 * safe to publish and scoping is about interest rather than secrecy. Writing a
 * test for it would be inventing a requirement the binding document explicitly
 * declines to set.
 *
 * ## Why the decision, and not the route
 *
 * The route at `app/api/events/stream/route.ts` cannot be imported here: the root
 * vitest config aliases `@battle-agents/*` to source, and has no `@/` alias,
 * because that is Next's and only Next resolves it. The alternative — a test that
 * asserts on a route it cannot load — is the failure this repository's own notes
 * are about. So the DECISION lives in `apps/web/src/stream-access.ts`, which is
 * reachable and is where the next person will look.
 *
 * What that leaves untested by this file is the route's ORDERING: that the gate
 * runs before a subscriber is created, because an endpoint that opens the stream
 * and then refuses has already sent `full_state`. That is asserted by the shape
 * of `streamRefusal` — it returns a body with no stream in it, so there is
 * nothing to have sent — and by the route being four statements long.
 */
const SIGNED_OUT: Viewer = { kind: 'signed-out' };
const UNCONFIGURED: Viewer = { kind: 'auth-unconfigured', missing: ['GITHUB_CLIENT_ID'] };

describe('mayOpenStream', () => {
  it('refuses a reader who is not signed in', () => {
    expect(mayOpenStream(SIGNED_OUT)).toBe(false);
  });

  it('refuses a deployment that has no sign-in configured', () => {
    // The state that is easy to miss: on a fresh clone `resolveViewer` answers
    // `auth-unconfigured`, not `signed-out`, because the auth server THROWS when
    // a variable is missing. A gate written against the wrong one of the two
    // admits the cleanest local deployment in the repository.
    expect(mayOpenStream(UNCONFIGURED)).toBe(false);
  });

  it('admits a signed-in reader', () => {
    expect(mayOpenStream({ kind: 'signed-in', login: 'octocat' })).toBe(true);
  });

  it('admits the development bypass, because every other surface does', () => {
    // `viewerMayRead` is shared, so this cannot drift from the pages: a local
    // build that cannot open its own stream is a world with no agents in it, and
    // a rule that closed it unconditionally would break the very page the gate
    // exists to protect.
    expect(mayOpenStream({ kind: 'dev-login', login: 'dev-login' })).toBe(true);
  });

  it('agrees with the page gate on every kind of viewer', () => {
    // The whole reason this delegates instead of comparing `kind` again. A second
    // definition of who may read something is a second thing to keep in step with
    // the first, and this one already had to be updated once.
    const viewers: readonly Viewer[] = [
      SIGNED_OUT,
      UNCONFIGURED,
      { kind: 'signed-in', login: 'octocat' },
      { kind: 'dev-login', login: 'dev-login' },
    ];
    for (const viewer of viewers) {
      // The kind rides in the payload so a disagreement names itself: `toBe`
      // takes one argument, and the second one this used to carry made the file
      // not typecheck rather than making the failure readable.
      expect({ kind: viewer.kind, admitted: mayOpenStream(viewer) }).toEqual({
        kind: viewer.kind,
        admitted: viewer.kind === 'signed-in' || viewer.kind === 'dev-login',
      });
    }
  });
});

describe('streamRefusal', () => {
  it('carries no stream, so there is nothing to have leaked', () => {
    // The property that makes the route's ordering safe to reason about. If this
    // ever grew a `body`, an endpoint that built it before refusing would have
    // sent something.
    const refusal = streamRefusal(SIGNED_OUT);
    expect(Object.keys(refusal).sort()).toEqual(['body', 'headers', 'status']);
    expect(refusal.status).toBe(401);
  });

  it('names the state, so a refusal is diagnosable', () => {
    const body = JSON.parse(streamRefusal(UNCONFIGURED).body) as Record<string, unknown>;
    expect(body['error']).toBe('the event stream requires a web session');
    expect(body['kind']).toBe('auth-unconfigured');
    // An operator who gets a bare 401 has nothing to do with it. This is the
    // fresh-clone case, and it is the one most likely to be met first.
    expect(body['missing']).toEqual(['GITHUB_CLIENT_ID']);
  });

  it('omits `missing` for a state that has no variables to name', () => {
    const body = JSON.parse(streamRefusal(SIGNED_OUT).body) as Record<string, unknown>;
    expect(body['kind']).toBe('signed-out');
    expect(body).not.toHaveProperty('missing');
  });

  it('is marked no-store, because a cached refusal outlives its reason', () => {
    // An intermediary that cached this 401 would go on answering it to a reader
    // who has since signed in.
    expect(streamRefusal(SIGNED_OUT).headers['Cache-Control']).toBe('no-store');
    expect(streamRefusal(SIGNED_OUT).headers['Content-Type']).toContain('application/json');
  });
});
