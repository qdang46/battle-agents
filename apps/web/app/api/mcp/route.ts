import { toResponseBody } from '@/http-body.js';
import { sharedMcpGateway } from '@/mcp-gateway.js';
import type { HttpRequest, HttpResponse } from '@/routes.js';

/**
 * `/api/mcp` — the Next.js adapter for the MCP Streamable HTTP transport.
 *
 * Thin for the same reason the event route is: it turns a `Request` into the
 * shape the pure handler takes, and the handler's `HttpResponse` back into a
 * `Response`. Authentication, the JSON-RPC envelope, the session lifetime and
 * the `Accept` gate all live behind `await sharedMcpGateway()`, where they are
 * reachable from a test without a server.
 *
 * Three verbs, because the transport needs three. POST carries the JSON-RPC.
 * GET opens the server-to-client notification stream for a session, which is
 * what an `observe` call's events travel down. DELETE ends a session. The route
 * decides none of that; it maps one to one.
 *
 * The body is passed through unserialised. The first version of this file
 * returned `JSON.stringify(response.body)`, which is right for a JSON-RPC
 * answer and silently wrong for the stream: `JSON.stringify` of a
 * `ReadableStream` is `{}`, so the GET would have returned an empty object to
 * every client that opened it. A test that only exercised POST could not see it.
 *
 * The `runtime`/`dynamic` hints keep Next.js from statically optimising a
 * long-lived stream at build time and from caching it at the edge. The GET
 * response is per-connection and never cacheable.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function respond(request: Request): Promise<Response> {
  const body: unknown =
    request.method === 'GET' ? undefined : await request.json().catch(() => undefined);
  const httpRequest: HttpRequest = {
    method: request.method,
    url: request.url,
    headers: {
      get: (name: string) => request.headers.get(name),
    },
    // exactOptionalPropertyTypes: a request with no body omits the field rather
    // than carrying an explicit undefined.
    ...(body === undefined ? {} : { body }),
  };

  const response: HttpResponse = await (await sharedMcpGateway()).handle(httpRequest);
  // The first argument to `new Response` is its body; `ResponseInit` (the second)
  // has no `body` field. Derived from the constructor rather than naming
  // `BodyInit`, which is not a global in this project (no DOM lib, and
  // @types/node does not export it globally).
  // `toResponseBody` owns the decision and the reason, and lives in src/ so a
  // test can reach it: this file is under app/api/, which no test glob covers,
  // and two wrong serialisations shipped from exactly here.
  const serialised = toResponseBody(response.body);
  const headers: Record<string, string> = { ...(response.headers ?? {}) };
  if (serialised.needsJsonContentType && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }

  return new Response(serialised.body as ConstructorParameters<typeof Response>[0], {
    status: response.status,
    headers,
  });
}

export const POST = respond;
export const GET = respond;
export const DELETE = respond;
