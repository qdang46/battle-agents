import { describe, expect, it } from 'vitest';

import { createSessionOpeningSender } from '../../packages/protocol/src/ingest.js';
import type { AgentEvent } from '../../packages/protocol/src/agent-event.js';
import type { FetchLike, HttpResponseLike } from '../../packages/protocol/src/ingest.js';

/**
 * The handshake lives in the sender, and the sender opens each session once.
 *
 * ## Where this used to live, and why it moved
 *
 * The handshake was first added as an `openSession` callback on
 * `ClaudeWatcher`, called when the watcher noticed a new session. That worked for
 * Claude and could not work for anything else: eight more adapters would each
 * have needed the same callback, the same "have I opened this one yet" set, and
 * the same call in the same place — which is plan §28.1 item 3's promise ("a new
 * CLI is one subdirectory") becoming nine ways to be subtly wrong.
 *
 * So it lives in the sender now. Every watcher already emits events carrying a
 * `sessionId` and every one already posts through `createIngestSender`, so
 * wrapping THAT is the one place where "did we connect" is a question with a
 * single answer. The watcher is untouched: an adapter that emits a sessionId is
 * connected, and no adapter has code that can forget to connect.
 *
 * ## The bug the set exists for
 *
 * Measured, not assumed. A watcher following the most recently written
 * transcript alternates between two files that were written in the same second.
 * With a handshake in the watcher, each alternation opened a NEW platform run:
 * three live transcripts produced eleven runs in twenty seconds, and the world
 * filled with one character standing in several places. A test that only checked
 * "did it handshake" would have watched eleven correct handshakes.
 */
function anEvent(sessionId: string): AgentEvent {
  return {
    type: 'tool.started',
    sessionId,
    at: '2026-09-28T06:00:00.000Z',
    tool: 'Bash',
  } as unknown as AgentEvent;
}

interface Wire {
  readonly fetch: FetchLike;
  readonly handshakes: string[];
  readonly batches: number;
}

function aWire(handshakeStatus = 201): Wire {
  const handshakes: string[] = [];
  let batches = 0;
  const fetch: FetchLike = (url, init) => {
    if (url.endsWith('/api/sessions')) {
      const body = JSON.parse(init.body) as { readonly harnessSessionRef: string };
      handshakes.push(body.harnessSessionRef);
      return Promise.resolve({
        status: handshakeStatus,
        headers: { get: () => null },
        text: async () => JSON.stringify({ sessionId: 'platform-1', agentId: 'agent-1' }),
      } satisfies HttpResponseLike);
    }
    batches += 1;
    return Promise.resolve({
      status: 200,
      headers: { get: () => null },
      text: async () => '{}',
    } satisfies HttpResponseLike);
  };
  return {
    fetch,
    handshakes,
    get batches() {
      return batches;
    },
  } as Wire;
}

const BASE = {
  baseUrl: 'http://server.test',
  token: 't',
  agentName: 'CodeKnight',
  harness: 'claude',
} as const;

/**
 * The inner sender, standing in for `createIngestSender`.
 *
 * It POSTS to the same wire rather than doing nothing. The first version was
 * `async () => undefined`, which made every "the batch went out" assertion
 * count zero — and the failure read like the handshake not having run, when the
 * handshake had run perfectly and the stub simply never posted.
 */
function aSender(wire: Wire): (batch: readonly AgentEvent[]) => Promise<void> {
  return (batch) =>
    wire.fetch('http://server.test/api/events', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ events: batch }),
    }).then(() => undefined);
}

describe('opening a run before posting', () => {
  it('shakes hands for a session it has not seen, and then posts', async () => {
    const wire = aWire();
    const send = createSessionOpeningSender({ ...BASE, fetch: wire.fetch }, aSender(wire));

    await send([anEvent('sess-1')]);

    expect(wire.handshakes).toEqual(['sess-1']);
    expect(wire.batches).toBe(1);
  });

  it('opens each session EXACTLY once, however many batches it appears in', async () => {
    // The failure the set exists for. Eleven handshakes for one session is not
    // eleven correct handshakes; it is eleven runs and a world full of ghosts.
    const wire = aWire();
    const send = createSessionOpeningSender({ ...BASE, fetch: wire.fetch }, aSender(wire));

    for (let batch = 0; batch < 10; batch += 1) {
      await send([anEvent('sess-1'), anEvent('sess-2')]);
    }

    expect(wire.handshakes.sort()).toEqual(['sess-1', 'sess-2']);
  });

  it('opens a NEW session without disturbing the old one', async () => {
    const wire = aWire();
    const send = createSessionOpeningSender({ ...BASE, fetch: wire.fetch }, aSender(wire));

    await send([anEvent('sess-1')]);
    await send([anEvent('sess-2')]);
    await send([anEvent('sess-1')]);

    expect(wire.handshakes).toEqual(['sess-1', 'sess-2']);
  });

  it('sends the harness id, not the platform one', async () => {
    // The whole point. The platform mints its own id; the adapter only has the
    // one in the filename, and the handshake is what records the two together.
    const wire = aWire();
    const send = createSessionOpeningSender({ ...BASE, fetch: wire.fetch }, aSender(wire));

    await send([anEvent('5cfbafee-d3b2-46a7-8bb8-c627adb195bd')]);

    expect(wire.handshakes[0]).toBe('5cfbafee-d3b2-46a7-8bb8-c627adb195bd');
  });

  it('posts NOTHING when the handshake is refused', async () => {
    // An adapter that posts into a session it failed to open produces events the
    // server refuses with `no such session` — the same symptom as never having
    // connected at all, one step further away from the cause.
    const wire = aWire(500);
    const send = createSessionOpeningSender({ ...BASE, fetch: wire.fetch }, aSender(wire));

    await expect(send([anEvent('sess-1')])).rejects.toThrow(/refused/);
    expect(wire.batches).toBe(0);
  });

  it('ignores a batch that names no session, and posts it anyway', async () => {
    // A heartbeat or a malformed event is not a reason to refuse the batch it
    // arrived in; the server decides what it accepts, and this layer's job is
    // only to have opened the runs it needed to.
    const wire = aWire();
    const send = createSessionOpeningSender({ ...BASE, fetch: wire.fetch }, aSender(wire));

    await send([{ type: 'test.passed' } as unknown as AgentEvent]);

    expect(wire.handshakes).toEqual([]);
    expect(wire.batches).toBe(1);
  });

  it('reports what it opened, so a process can say so', async () => {
    const wire = aWire();
    const send = createSessionOpeningSender(
      { ...BASE, fetch: wire.fetch, onOpened: (id) => opened.push(id) },
      aSender(wire),
    );
    const opened: string[] = [];

    await send([anEvent('sess-1')]);
    await send([anEvent('sess-1')]);
    await send([anEvent('sess-2')]);

    expect(opened).toEqual(['sess-1', 'sess-2']);
    expect([...send.opened].sort()).toEqual(['sess-1', 'sess-2']);
  });
});
