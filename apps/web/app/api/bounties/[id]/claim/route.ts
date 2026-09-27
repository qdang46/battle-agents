import { sharedBountyGateway } from '@/bounty-gateway.js';
import type { HttpRequest, HttpResponse } from '@/routes.js';

/**
 * `POST /api/bounties/[id]/claim` — the Next.js adapter.
 *
 * The path is rebuilt from the route segment rather than read off `request.url`,
 * because the segment is the one Next.js has already matched: reading the URL
 * back would re-parse a path the router has an answer for.
 * `encodeURIComponent` here and `decodeURIComponent` in the handler are a round
 * trip, so the handler sees exactly the id Next.js put in `params` — whether
 * Next hands that over decoded or raw, the two ends cancel out. The segment is
 * never interpolated into a bare string, so a `..` or a slash in it cannot walk
 * the URL somewhere else.
 *
 * Everything else is in `bounty-routes.ts`, where it can be tested without a
 * server.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const url = new URL(request.url);
  url.pathname = `/api/bounties/${encodeURIComponent(id)}/claim`;

  const body: unknown = await request.json().catch(() => undefined);
  const httpRequest: HttpRequest = {
    method: request.method,
    url: url.toString(),
    headers: { get: (name: string) => request.headers.get(name) },
    ...(body === undefined ? {} : { body }),
  };

  const response: HttpResponse = await (await sharedBountyGateway()).handle(httpRequest);
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
