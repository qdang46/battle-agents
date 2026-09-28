import type { Viewer } from './viewer-view.js';
import { viewerMayRead } from './viewer-view.js';

/**
 * Who may open the event stream, and what a reader who may not is told.
 *
 * ## Why this is a decision and not a header check inside the route
 *
 * `docs/design/public-event-stream.md` decided the classification this stream
 * carries, and it closed with the condition on shipping it:
 *
 * > Until both exist, the correct state is that the stream is **closed**, not
 * > that it is open and filtered. An unauthenticated endpoint carrying the
 * > activity log is worse than no endpoint, because the activity log is the
 * > system's audit trail and the dispute evidence described in
 * > `docs/design/payout-rail.md` rests on it.
 *
 * The endpoint was open anyway, with a comment in `event-routes.ts` saying that
 * was deliberate. Two pieces of the codebase disagreed and the code won, which
 * is how `ba-9hr` closed without closing anything.
 *
 * ## Which half of the condition this is
 *
 * AUTHENTICATION. The same paragraph says a browser `EventSource` cannot set an
 * `Authorization` header and this repository forbids tokens in URLs, so the
 * credential has to be the web session cookie — which is what `viewerMayRead`
 * already reads for every page. Reusing it is deliberate: a second definition of
 * who may read something is a second thing to keep in step with the first, and
 * this one already had to be updated once when the development bypass was added.
 *
 * SCOPING — whether a viewer sees one battle, one user, or the whole arena — is
 * explicitly deferred by the same paragraph, on the grounds that the
 * classification is already safe to publish and scoping is about interest rather
 * than secrecy. It is therefore not implemented here, and there is no test for
 * it, because writing one would be inventing a requirement the binding document
 * declines to set.
 *
 * The classification filter in `event-stream.ts` is unchanged and still
 * load-bearing: it is what makes the stream safe to hand to a SIGNED-IN viewer.
 */
export function mayOpenStream(viewer: Viewer): boolean {
  return viewerMayRead(viewer);
}

const REFUSAL_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
  // `no-store` because an intermediary that cached this 401 would go on
  // answering it to a reader who has since signed in — a refusal that outlives
  // the reason for it is its own kind of wrong.
  'Cache-Control': 'no-store',
};

/**
 * The refusal, as a body a reader can act on.
 *
 * It names the viewer's state and, when the deployment is simply unconfigured,
 * the variables that would fix it. A bare 401 tells an operator nothing they can
 * do, and the state that is easiest to reach on a fresh clone is exactly the one
 * where "nothing you can do" would be the answer.
 */
export function streamRefusal(viewer: Viewer): {
  readonly status: 401;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
} {
  return {
    status: 401,
    headers: REFUSAL_HEADERS,
    body: JSON.stringify({
      error: 'the event stream requires a web session',
      kind: viewer.kind,
      ...(viewer.kind === 'auth-unconfigured' ? { missing: viewer.missing } : {}),
    }),
  };
}
