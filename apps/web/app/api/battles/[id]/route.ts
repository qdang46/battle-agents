import { sharedBattleGateway } from '@/battle-gateway.js';
import type { HttpRequest, HttpResponse } from '@/routes.js';

/**
 * `GET /api/battles/[id]` — the Next.js adapter, for `battle.read`.
 *
 * It authenticates like every other route on this surface even though the
 * feature would serve the rubric to anyone, and `battle-routes.ts` says why in
 * full: `BattleView` carries session ids, and
 * docs/design/public-replay.md rules those never public. The narrowing is
 * deliberate and the comment above the dispatcher is where to argue with it.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const url = new URL(request.url);
  url.pathname = `/api/battles/${encodeURIComponent(id)}`;

  const httpRequest: HttpRequest = {
    method: request.method,
    url: url.toString(),
    headers: { get: (name: string) => request.headers.get(name) },
  };

  const response: HttpResponse = await (await sharedBattleGateway()).handle(httpRequest);
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
