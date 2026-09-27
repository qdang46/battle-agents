import { sharedSessionGateway } from '@/session-gateway.js';
import type { HttpRequest, HttpResponse } from '@/routes.js';

/**
 * `POST /api/sessions` — the Next.js adapter for the handshake.
 *
 * Thin for the reason the heartbeat adapter is: it turns a `Request` into the
 * shape the pure handler takes and the handler's `HttpResponse` back into a
 * `Response`. The owner is not named here, and that is the reason this route
 * exists at all: whoever is calling is the owner, and the body gets no say.
 *
 * A body that is not JSON becomes `undefined` rather than a thrown
 * SyntaxError, because the fault is in the request rather than in the platform
 * and the handler answers it as a 400 on its own terms.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const body: unknown = await request.json().catch(() => undefined);
  const httpRequest: HttpRequest = {
    method: request.method,
    url: url.toString(),
    headers: { get: (name: string) => request.headers.get(name) },
    ...(body === undefined ? {} : { body }),
  };

  const response: HttpResponse = await (await sharedSessionGateway()).handle(httpRequest);
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
};
