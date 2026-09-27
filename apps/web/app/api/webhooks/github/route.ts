import { sharedGithubWebhook } from '@/webhook-routes.js';
import type { WebhookHttpRequest } from '@/webhook-routes.js';

/**
 * `POST /api/webhooks/github` — the Next.js adapter.
 *
 * The only line in this file that matters is the first one inside the handler,
 * and it is the opposite of what app/api/events/route.ts does. `request.text()`
 * hands over the bytes GitHub signed; `request.json()` would hand over a value
 * whose re-serialisation is NOT those bytes, and a signature computed over the
 * re-serialisation is a signature an attacker chose. Everything downstream
 * lives in webhook-routes.ts, where it is testable without a server and without
 * this file having to be right about cryptography.
 */
export const POST = async (request: Request): Promise<Response> => {
  const rawBody = await request.text();

  const webhookRequest: WebhookHttpRequest = {
    method: request.method,
    url: request.url,
    headers: {
      get: (name: string) => request.headers.get(name),
    },
    rawBody,
  };

  const response = await (await sharedGithubWebhook())(webhookRequest);
  // `application/json` stated, for the reason the other fourteen routes carry:
  // a Response built without one announces `text/plain`, so this route served
  // correct JSON labelled as text.
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
};
