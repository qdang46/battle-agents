import { describe, expect, it } from 'vitest';

import { toResponseBody } from './http-body.js';

/**
 * The serialisation boundary, tested at the layer it lives.
 *
 * Two wrong answers shipped from this seam, in opposite directions, and neither
 * had a test that could see it — the code was in `app/api/mcp/route.ts`, which no
 * test glob covers. `toResponseBody` is in `src/`, so it has one.
 */

describe('toResponseBody', () => {
  it('serialises an object, which is what every JSON-RPC answer and error is', () => {
    // THE bug. `new Response(obj)` does not serialise it; it calls toString(),
    // and a plain object's toString is the eight characters `[object Object]`.
    // Every path of McpHttpResponse builds an object except the GET stream, so
    // the whole /api/mcp surface answered that to every client.
    const answer = toResponseBody({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'agent-battle' } },
    });

    expect(answer.body).toBe(
      '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"agent-battle"}}}',
    );
    expect(String(answer.body)).not.toContain('[object Object]');
  });

  it('serialises an array, which a JSON-RPC batch answer is', () => {
    const answer = toResponseBody([{ jsonrpc: '2.0', id: 1, result: {} }]);

    expect(typeof answer.body).toBe('string');
    expect(JSON.parse(String(answer.body))).toHaveLength(1);
  });

  it('passes a stream through untouched, which the other half of the bug was', () => {
    // The first version was `JSON.stringify(response.body)`. That is `{}` for a
    // ReadableStream, so every client that opened the notification stream got
    // an empty object instead of a stream, and only a GET could have caught it.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ping\n\n'));
        controller.close();
      },
    });

    const answer = toResponseBody(stream);

    expect(answer.body).toBe(stream);
    expect(answer.needsJsonContentType).toBe(false);
  });

  it('leaves a string alone, because a string is already a BodyInit', () => {
    expect(toResponseBody('already serialised').body).toBe('already serialised');
  });

  it('passes null through, so 204 stays a 204 and not the four characters null', () => {
    expect(toResponseBody(null).body).toBeNull();
  });

  it('asks for a JSON content-type only when it actually serialised something', () => {
    // The easy half to miss: correct JSON announced as text/plain is a client
    // that refuses to parse a good answer.
    expect(toResponseBody({ a: 1 }).needsJsonContentType).toBe(true);
    expect(toResponseBody('raw').needsJsonContentType).toBe(false);
    expect(toResponseBody(null).needsJsonContentType).toBe(false);
  });
});
