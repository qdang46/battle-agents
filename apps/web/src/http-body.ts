/**
 * The body a Next.js route hands to `new Response`, from whatever the pure
 * handler returned.
 *
 * ## Why this is a function and not a line in a route
 *
 * Because the line in the route was wrong twice, in opposite directions, and
 * neither mistake had a test able to see it.
 *
 * The first version was `JSON.stringify(response.body)`, which is right for a
 * JSON-RPC answer and silently wrong for a stream: `JSON.stringify` of a
 * `ReadableStream` is `{}`, so every client that opened the notification stream
 * got an empty object instead of one.
 *
 * The fix for that removed the stringification entirely and passed the body
 * straight to `new Response` — which calls `toString()` on it, so a plain
 * object became the literal eight characters `[object Object]`. Every path in
 * `McpHttpResponse` builds a plain object except the GET stream, so the whole
 * `/api/mcp` surface answered that, with `content-type: text/plain`, to every
 * client that reached it: the JSON-RPC answer, the 401, the 404, the
 * JSON-RPC failure. A surface the plan names as the agent-facing entry point.
 *
 * Found by curling it, not by reading it. The route lived under `app/api/`,
 * which no test glob covers, so there was nowhere a test could have looked.
 * This function is the seam, and it is in `src/` where one does.
 */

/** The subset of `BodyInit` this codebase produces. Named, not `any`. */
export type ResponseBody = string | ReadableStream<Uint8Array> | null;

function isStream(payload: unknown): payload is ReadableStream<Uint8Array> {
  return typeof ReadableStream === 'function' && payload instanceof ReadableStream;
}

/**
 * The value to pass as `new Response`'s first argument, and whether the caller
 * still owes a content-type.
 *
 * The boolean is the second half of the contract and is easy to miss: a body
 * that was serialised here needs `application/json` said so, or the client
 * gets correct JSON announced as text. The stream and the null carry their own
 * content-type from the handler, so neither is touched.
 */
export function toResponseBody(payload: unknown): {
  readonly body: ResponseBody;
  readonly needsJsonContentType: boolean;
} {
  if (isStream(payload)) return { body: payload, needsJsonContentType: false };
  if (typeof payload === 'string') return { body: payload, needsJsonContentType: false };
  if (payload === null) return { body: null, needsJsonContentType: false };
  return { body: JSON.stringify(payload), needsJsonContentType: true };
}
