import { sharedEventGateway } from '@/event-gateway.js';
import { mayOpenStream, streamRefusal } from '@/stream-access.js';
import { resolveViewer } from '@/viewer-view.js';
import type { HttpRequest } from '@/routes.js';

/**
 * `GET /api/events/stream` — the Next.js adapter for the SSE fan-out.
 *
 * As thin as the POST adapter: it hands the pure handler a `Request`-shaped
 * object and wraps the `ReadableStream` the handler returns in a `Response` with
 * the stream headers the handler decided on. The first frame is `full_state` and
 * every later frame is a delta — a property of the hub, established and tested
 * there, and deliberately not re-decided in a transport file.
 *
 * The `runtime`/`dynamic` hints keep Next.js from statically optimising a
 * long-lived stream at build time and from caching it at the edge: this response
 * is per-connection and never cacheable.
 *
 * ## The refusal comes first, and it comes before anything is built
 *
 * The gate is the first statement, and it runs before `sharedEventGateway()`. That
 * ordering is the whole of the fix and it is why it is here rather than inside
 * the handler: an endpoint that opens the stream and then discovers there is no
 * session has already sent `full_state` — the protocol version and every live
 * session id — to whoever asked. There is no way to take a frame back.
 *
 * So nothing is constructed, nothing is subscribed and no database is touched
 * until a reader is admitted. The decision itself, and the reason the endpoint is
 * closed at all, are in `apps/web/src/stream-access.ts` and
 * `docs/design/public-event-stream.md`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: Request): Promise<Response> => {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    headers.append(name, value);
  });

  // Resolved ONCE. The first version of this called `resolveViewer` twice — once
  // for the decision and once for the body — and two calls are two reads of the
  // same session, so a session that expired between them produced a refusal
  // describing a viewer that was not the one refused.
  const viewer = await resolveViewer(headers);
  if (!mayOpenStream(viewer)) {
    const refusal = streamRefusal(viewer);
    return new Response(refusal.body, {
      status: refusal.status,
      headers: refusal.headers,
    });
  }

  const httpRequest: HttpRequest = {
    method: request.method,
    url: request.url,
    headers: {
      get: (name: string) => request.headers.get(name),
    },
  };

  const response = await (await sharedEventGateway()).handle(httpRequest);
  // The first argument to `new Response` is its body; `ResponseInit` (the second)
  // has no `body` field. Derived from the constructor rather than naming
  // `BodyInit`, which is not a global in this project (no DOM lib, and @types/node
  // does not export it globally).
  return new Response(response.body as ConstructorParameters<typeof Response>[0], {
    status: response.status,
    ...(response.headers === undefined ? {} : { headers: response.headers }),
  });
};
