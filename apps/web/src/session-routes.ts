import type { ApplicationApi } from '@battle-agents/api';
import type { RegisteredActionId } from '@battle-agents/protocol';

import { describeHttpFailure } from './http-failure.js';
import type { HttpRequest, HttpResponse } from './routes.js';

/**
 * The session resource routes, as pure functions.
 *
 * Split out from `routes.ts` for the reason `event-routes.ts` gives its own
 * split: the five primitives never look at a request body and neither looks at
 * the path beyond an exact match, while a resource route is addressed BY its
 * path. `createRoutes` switches on `` `${method} ${pathname}` ``, which has
 * exactly one spelling per route; a session id is a value, not a spelling.
 *
 * Three routes, and all three exist for the same reason rather than because
 * they are useful: each one reaches a registered action that names its caller,
 * and `act()` structurally cannot see the caller. `/api/act` refuses those three
 * ids outright (see `CALLER_SCOPED_ACTIONS` in `routes.ts`), so these are the
 * only way over HTTP to start a run, keep one alive, or end one — and each of
 * them fills in the identity from the credential rather than from the body.
 */

/** The installation a presented Bearer token resolved to. */
export interface SessionCaller {
  readonly installationId: string;
}

/** A session the caller's installation owns, as the ownership query returns it. */
export interface OwnedSession {
  readonly id: string;
  readonly agentId: string;
  readonly status: string;
}

/**
 * The human and the machine a caller's installation belongs to, as the ownership
 * query returns them.
 *
 * Two fields rather than one, and the second is not a convenience. The handshake
 * takes an `installationKey`, and `findOrCreateInstallation` is unique on
 * (owner, key) — so a key the client guessed wrong does not fail, it quietly
 * creates a SECOND installation, and the session that lands on it belongs to an
 * installation the presented credential does not own. Every ownership-checked
 * route then refuses it, so a caller cannot use the run it just opened on
 * anything else. Nothing over HTTP tells a client which key its credential was
 * issued against, which makes the body's copy of it a field a client gets wrong
 * rather than one it can supply.
 */
export interface OwnedOwner {
  readonly userId: string;
  readonly installationKey: string;
}

export interface SessionRouteDependencies {
  readonly api: ApplicationApi;
  /**
   * Resolves the Bearer token to an installation. Throws an authentication
   * failure (an `Error` carrying a `reason`) when the token is absent, unknown,
   * revoked, expired or in a URL.
   */
  readonly authenticate: (request: HttpRequest) => Promise<SessionCaller>;
  /**
   * Finds a session ONLY if the named installation owns it.
   *
   * This is the reason the route exists, so it is worth stating plainly:
   * `ApplicationApi.act` has no principal. The frozen Extension API puts no
   * caller in `RuntimeContext`, so an action cannot ask whose token is on the
   * request — the transport has already thrown that away by the time the
   * command runs. A heartbeat that skipped this check would let any agent with
   * a valid credential keep another installation's session `active` indefinitely,
   * which is not a nuisance: it is exactly what the stale-session sweeper
   * exists to end. An unauthenticated-feeling write path that is in fact
   * authenticated-and-unscoped is the failure this port closes.
   *
   * Ownership lives in the query, not in a comparison a route could forget: a
   * session belonging to somebody else is `undefined`, the same answer as one
   * that does not exist.
   */
  readonly resolveSession: (
    sessionId: string,
    installationId: string,
  ) => Promise<OwnedSession | undefined>;
  /**
   * The human and the machine the caller's installation belongs to.
   *
   * `session.create` takes an `ownerId`, and it is the most consequential of
   * the three: the handshake resolves the installation AND the character by
   * that id, so a caller naming somebody else's gets a live session on their
   * account — one it then holds the id of, and the id is the join key to every
   * other surface. It is also the only one of the three where the answer is
   * never a question about an existing row, because the caller's installation
   * ALWAYS has an owner (`installations.user_id` is NOT NULL) and a credential
   * whose installation is gone cannot authenticate at all.
   *
   * REQUIRED, for the reason `authenticate` is: an optional resolver would mean
   * a surface that could start a run as anybody, and the only signal that it
   * could would be the shape of the wiring.
   */
  readonly resolveOwner: (installationId: string) => Promise<OwnedOwner | undefined>;
}

/**
 * The action this route reaches, written out rather than imported.
 *
 * `SESSION_HEARTBEAT` and its two siblings are exported by the agent feature,
 * and this app is not allowed to import a feature outside the composition root:
 * `scripts/removal-test.sh` strips the feature's import from `composition.ts`
 * and its dependency and path from the workspace, then typechecks the tree, so a
 * second importer turns "remove a feature" into "edit three files".
 * `composition.ts` is currently the only place in `apps/web` that names a
 * feature, and that is a property the gate depends on, not a coincidence.
 *
 * The `satisfies` is what stops the literals from rotting. The union is
 * generated from every feature's manifest, so renaming an id upstream and
 * regenerating turns these lines into compile errors rather than routes that
 * quietly 404 for everybody.
 */
const SESSION_CREATE = 'session.create' satisfies RegisteredActionId;
const SESSION_HEARTBEAT = 'session.heartbeat' satisfies RegisteredActionId;
const SESSION_END = 'session.end' satisfies RegisteredActionId;

/** `{id}` is the whole addressable part of a session, so one segment matches. */
const HEARTBEAT_PATH = /^\/api\/sessions\/([^/]+)\/heartbeat$/;
const END_PATH = /^\/api\/sessions\/([^/]+)\/end$/;

export function createSessionRoutes(
  dependencies: SessionRouteDependencies,
): (request: HttpRequest) => Promise<HttpResponse> {
  return async (request: HttpRequest) => {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/api/sessions') {
        return await create(dependencies, request);
      }
      if (request.method !== 'POST') {
        return { status: 404, body: { error: 'not found', path: url.pathname } };
      }
      // The two `{id}` routes are told apart by their own patterns, and a
      // segment is only decoded once one of them has matched: a path this
      // surface does not address is a 404, and a `%` that is not valid
      // percent-encoding in a path that IS addressed is a 400.
      const beat = HEARTBEAT_PATH.exec(url.pathname);
      const stop = beat === null ? END_PATH.exec(url.pathname) : null;
      const segment = beat?.[1] ?? stop?.[1];
      if (segment === undefined) {
        return { status: 404, body: { error: 'not found', path: url.pathname } };
      }
      const sessionId = decodeSegment(segment);
      if (sessionId === undefined) {
        return { status: 400, body: { error: 'session id is not a valid URL segment' } };
      }
      return beat !== null
        ? await heartbeat(dependencies, request, sessionId)
        : await end(dependencies, request, sessionId);
    } catch (error) {
      return describeHttpFailure(error);
    }
  };
}

/**
 * `POST /api/sessions` — "this run is starting".
 *
 * BOTH identity fields are filled from the credential and neither is read from
 * the body. The `ownerId` is who the run belongs to; the `installationKey` is
 * which machine it is on, and the second is not cosmetic — see `OwnedOwner` for
 * what a guessed key does.
 *
 * A body naming either one is REFUSED rather than ignored: 403 for every value
 * that is not the caller's own, whether or not the named user or key exists, so
 * the answer carries no information about which ids are real. Refusing rather
 * than quietly substituting is the point, and it is the same trade
 * `bounty.fund` makes for the same reason — a client whose idea of who it is has
 * drifted is told so instead of being handed a run on somebody else's account.
 *
 * `agentName`, `harness` and an optional `projectKey` ARE read from the body: a
 * property of the RUN rather than of the caller. Each is shape-checked here, and
 * a field that is not a string is a 400 rather than a rejection from the
 * feature, because the feature's rejection is a MALFORMED INPUT and reads as
 * "the platform refused your input" to a client that in fact sent the wrong type
 * in a field it filled in itself.
 */
async function create(
  dependencies: SessionRouteDependencies,
  request: HttpRequest,
): Promise<HttpResponse> {
  const caller = await dependencies.authenticate(request);
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 400, body: { error: 'body must be a handshake' } };
  }
  const fields = body as Record<string, unknown>;
  const { agentName, harness } = fields;
  const projectKey = fields['projectKey'];
  const harnessSessionRef = fields['harnessSessionRef'];
  if (
    typeof agentName !== 'string' ||
    agentName.trim() === '' ||
    typeof harness !== 'string' ||
    harness.trim() === '' ||
    (projectKey !== undefined && (typeof projectKey !== 'string' || projectKey.trim() === '')) ||
    (harnessSessionRef !== undefined &&
      (typeof harnessSessionRef !== 'string' || harnessSessionRef.trim() === ''))
  ) {
    return {
      status: 400,
      body: {
        error:
          'body must carry a non-empty agentName and harness string, ' +
          'and a projectKey or harnessSessionRef string if it carries one at all',
      },
    };
  }
  // The body is checked before the store is asked anything: a request that was
  // built wrong should not cost a query, and the caller is already authenticated
  // by the time it arrives.
  const owner = await dependencies.resolveOwner(caller.installationId);
  if (owner === undefined) {
    // Unreachable through the real store, because `installations.user_id` is NOT
    // NULL and a credential whose installation is deleted cascades away with
    // it. It is here so that if the schema ever moves, a session is refused
    // rather than started for an owner nobody can name.
    return { status: 404, body: { error: 'no owner for this credential' } };
  }
  const namedOwner = fields['ownerId'];
  if (typeof namedOwner === 'string' && namedOwner !== owner.userId) {
    return { status: 403, body: { error: 'a run belongs to the credential, not to the body' } };
  }
  const namedKey = fields['installationKey'];
  if (typeof namedKey === 'string' && namedKey !== owner.installationKey) {
    return { status: 403, body: { error: 'a run belongs to the credential, not to the body' } };
  }
  return {
    status: 201,
    body: await dependencies.api.act(SESSION_CREATE, {
      installationKey: owner.installationKey,
      ownerId: owner.userId,
      agentName,
      harness,
      ...(projectKey === undefined ? {} : { projectKey }),
      // The id this HARNESS calls the run, when the client knows one. A Claude
      // Code adapter has it — the transcript filename — and without it every
      // batch that adapter posts is refused with `no such session`, because the
      // platform's id comes from the database and can never be that filename.
      // See `CreateSessionInput.harnessSessionRef`.
      ...(harnessSessionRef === undefined ? {} : { harnessSessionRef }),
    }),
  };
}

/**
 * `POST /api/sessions/{id}/end` — "this run is over".
 *
 * The same order as the heartbeat, and the same ownership query, because it is
 * the same authorization question with a different verb: without it any
 * credential-holder could end a run they have merely seen the id of, which
 * stops an agent mid-task and releases its resume window to whoever gets there
 * first.
 *
 * `reason` is the one field that reaches the action from the body. It is a
 * label on the caller's OWN run — who asked for the end — so unlike the
 * identities it names nobody, and the feature maps anything it does not
 * recognise onto `crashed`, which is its decision and not this route's.
 */
async function end(
  dependencies: SessionRouteDependencies,
  request: HttpRequest,
  sessionId: string,
): Promise<HttpResponse> {
  const caller = await dependencies.authenticate(request);
  const session = await dependencies.resolveSession(sessionId, caller.installationId);
  if (session === undefined) {
    return { status: 404, body: { error: 'no such session' } };
  }
  const reason = stringField(request.body, 'reason');
  return {
    status: 200,
    body: await dependencies.api.act(SESSION_END, {
      sessionId,
      ...(reason === undefined ? {} : { reason }),
    }),
  };
}

/**
 * `POST /api/sessions/{id}/heartbeat` — "this run is still alive".
 *
 * The order is the contract. Authenticate, so nothing else happens to an
 * unpresented token. Resolve ownership, so a caller cannot keep somebody else's
 * run alive. Then act.
 *
 * What comes back is whatever the action returned, and nothing here interprets
 * it. In particular this route does not check whether the session is still
 * `active` before heartbeating it: that question is answered by the repository
 * the action calls, which refuses anything but a live session, and a second
 * opinion up here would be one more place to keep in step.
 *
 * So a heartbeat for a session that is not running reaches the shared mapping as
 * a plain `Error` and becomes a 500. Classifying it would mean this route
 * recognising a failure the ACTION defined, which is the game-logic-in-a-handler
 * rule this file exists to respect; it belongs to `packages/api`, which owns the
 * vocabulary every surface is allowed to share.
 */
async function heartbeat(
  dependencies: SessionRouteDependencies,
  request: HttpRequest,
  sessionId: string,
): Promise<HttpResponse> {
  const caller = await dependencies.authenticate(request);
  const session = await dependencies.resolveSession(sessionId, caller.installationId);
  if (session === undefined) {
    return { status: 404, body: { error: 'no such session' } };
  }
  return {
    status: 200,
    body: await dependencies.api.act(SESSION_HEARTBEAT, { sessionId }),
  };
}

/**
 * A path segment back to the value it stood for.
 *
 * `undefined` for a segment that is not valid percent-encoding, which is a
 * client that built the URL wrong rather than a server fault — hence 400 from
 * the caller rather than a thrown `URIError` that would read as a 500.
 */
function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * A non-blank string from a body, or undefined.
 *
 * Absent and blank are the same answer, which is what a client that sent
 * `reason: ''` meant: it named no reason. `bounty-routes.ts` reads its fields
 * the same way, and the two must agree — a route that treated one as present
 * and the other as absent would answer differently for the same mistake.
 */
function stringField(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
