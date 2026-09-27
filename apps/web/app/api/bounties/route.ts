import { sharedBountyGateway } from '@/bounty-gateway.js';
import type { HttpRequest, HttpResponse } from '@/routes.js';

/**
 * `POST /api/bounties` and `GET /api/bounties` — the Next.js adapter.
 *
 * Thin for the reason the event route is: it turns a `Request` into the shape
 * the pure handler takes and the handler's `HttpResponse` back into a `Response`.
 * The lifecycle is not here and neither is the ownership check.
 *
 * A GET carries no body, and parsing one anyway would be the kind of thing that
 * works until a client sends an empty one. The method decides, not the body.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET has no body to read, and reading one is how an adapter invents a 400. */
async function toHttpRequest(request: Request): Promise<HttpRequest> {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  // A body that is not JSON is a client that built the request wrong, and the
  // handler answers that as a 400 on its own terms. Parsing failures therefore
  // become `undefined` rather than a thrown SyntaxError that would read as a
  // 500 — the fault is in the request, not in the platform.
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
  toResponse(await (await sharedBountyGateway()).handle(await toHttpRequest(request)));

export const GET = handle;
export const POST = handle;
