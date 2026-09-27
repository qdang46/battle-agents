import { sharedSessionGateway } from '@/session-gateway.js';
import type { HttpRequest, HttpResponse } from '@/routes.js';

/**
 * `POST /api/sessions/[id]/heartbeat` — the Next.js adapter.
 *
 * Thin for the same reason the event route is: it turns a `Request` into the
 * shape the pure handler takes and the handler's `HttpResponse` back into a
 * `Response`. Authentication, the ownership check and the translation into
 * `session.heartbeat` all live behind `await sharedSessionGateway()`, where they are
 * reachable from a test without a server.
 *
 * The path is rebuilt from the route segment rather than read off `request.url`,
 * because the segment is the one Next.js has already matched: reading the URL
 * back would re-parse a path the router has an answer for. `encodeURIComponent`
 * and the handler's `decodeURIComponent` are a round trip, so the handler sees
 * exactly the id Next.js put in `params` — whether Next hands that over decoded
 * or raw, the two ends cancel out. The segment is never interpolated into a
 * bare string, so a `..` or a slash in it cannot walk the URL somewhere else.
 */
export const POST = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const url = new URL(request.url);
  url.pathname = `/api/sessions/${encodeURIComponent(id)}/heartbeat`;

  const httpRequest: HttpRequest = {
    method: request.method,
    url: url.toString(),
    headers: {
      get: (name: string) => request.headers.get(name),
    },
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
