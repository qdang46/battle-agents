import { authenticate, DrizzleCredentialStore } from '@battle-agents/db';

import { createRoutes, type HttpRequest, type HttpResponse } from '@/routes.js';
import { sharedApi } from '@/routes.js';
import { sharedRuntime } from '@/shared-runtime.js';

/**
 * `GET /api/discover`, `/api/search`, `/api/inspect` and `POST /api/act` — the
 * five primitives over HTTP, mounted.
 *
 * These were BUILT and not reachable. apps/web/src/routes.ts has been a pure
 * dispatcher over the same `createApplicationApi` the CLI and MCP consume since
 * the contract landed, but no Next.js route ever called it, so a running server
 * answered 404 to all four. That is invisible from inside the app and fatal to
 * everything outside it: packages/cli is an HTTP client now, so the CLI could not
 * reach a running instance either, and an agent had no surface to act through.
 *
 * A CATCH-ALL rather than four files, and the specific routes win: Next.js
 * prefers the more specific match, so /api/events, /api/events/stream, /api/mcp,
 * /api/auth/[...all], /api/sessions/[id]/heartbeat and /api/webhooks/github are
 * untouched by this. A test asserts that, because a catch-all that shadowed a
 * sibling would be a regression with no symptom except a 404 somewhere else.
 *
 * AUTHENTICATION IS WIRED AND FAIL-CLOSED. `RouteDependencies.authenticate` is
 * optional in the type, and omitting it is how an unauthenticated /api/act
 * becomes an open door to every capability the game grows. There is no fallback
 * that permits: if the authenticator is unavailable the request is refused
 * rather than served, because "unreachable in practice" is not a property worth
 * betting a write path on — the same reasoning event-gateway.ts records.
 *
 * The credential is the Bearer installation token, which is what
 * `authenticate` in @battle-agents/db reads, and which a token in a URL is
 * REFUSED for: it would already have leaked to access logs, referrers and shell
 * history by the time a correct header arrived, so a client that does it once is
 * told so loudly rather than served.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function toHttpRequest(request: Request, body: unknown): Promise<HttpRequest> {
  return {
    method: request.method,
    url: request.url,
    headers: { get: (name: string) => request.headers.get(name) },
    ...(body === undefined ? {} : { body }),
  };
}

/** Response construction shared by every method, so they cannot disagree. */
function toResponse(response: HttpResponse): Response {
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    // `application/json` is STATED rather than left to the default. A Response
    // built without a content-type announces `text/plain`, so this API was
    // serving correct JSON labelled as text -- the shape
    // `docs/design/cloud-deploy-docket.md` already recorded as a trap for
    // whoever wired the deploy workflow. Same class of fault as the `/api/mcp`
    // adapter, which answered every request with the eight characters
    // `[object Object]`.
    //
    // The handler's own headers are spread LAST so a route that sets a
    // content-type deliberately is not overridden by this default.
    headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
  });
}

const handle = async (request: Request): Promise<Response> => {
  const api = await sharedApi();
  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : ((await request.json()) as unknown);

  const respond = createRoutes({
    api,
    // Never a permissive fallback. If this ever stops resolving, every primitive
    // refuses rather than every write path becoming anonymous.
    authenticate: async (httpRequest) => {
      const { database } = await sharedRuntime();
      return authenticate(
        { store: new DrizzleCredentialStore(database), now: new Date().toISOString() },
        httpRequest as never,
      );
    },
  });

  return toResponse(await respond(await toHttpRequest(request, body)));
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
