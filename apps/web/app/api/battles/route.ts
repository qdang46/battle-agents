import { sharedBattleGateway } from '@/battle-gateway.js';
import type { HttpRequest, HttpResponse } from '@/routes.js';

/**
 * `GET /api/battles` and `POST /api/battles` — the Next.js adapter.
 *
 * The bounty adapter is this file with a different resource, including the
 * method-driven body read: a GET carries no body, and parsing one anyway is the
 * kind of thing that works until a client sends an empty one.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function toHttpRequest(request: Request): Promise<HttpRequest> {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.json().catch(() => undefined) : undefined;
  return {
    method: request.method,
    url: request.url,
    headers: { get: (name: string) => request.headers.get(name) },
    ...(body === undefined ? {} : { body }),
  };
}

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

const handle = async (request: Request): Promise<Response> =>
  toResponse(await (await sharedBattleGateway()).handle(await toHttpRequest(request)));

export const GET = handle;
export const POST = handle;
