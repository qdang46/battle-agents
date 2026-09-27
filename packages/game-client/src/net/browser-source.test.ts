import { describe, expect, it } from 'vitest';

import { GameClient } from '../client.js';
import type { EventSourceLike } from './client.js';

/**
 * A source that hands over what a BROWSER actually hands over.
 *
 * The suite this sits beside drives the client with a `FakeSource` that passes
 * the raw SSE wire text — `event: kind\ndata: {...}\n\n`. A browser's
 * `MessageEvent.data` is the PAYLOAD ALONE: the `event:` line and the `data: `
 * prefix are gone by the time any handler runs.
 *
 * The fake and the thing it stands in for disagreed, and the disagreement was
 * invisible to every test in the package. In the real app the city mounted a
 * canvas, reported `streaming`, opened a real 200 `text/event-stream`, received
 * every frame the browser could see — and rendered a permanent,
 * correct-looking, completely empty world. `decodeFrame` found no `data: ` line
 * in a bare payload, returned undefined, and the client tore the connection down
 * and resynced on every frame, for ever.
 *
 * Found by running the game in a real browser and reading what the page actually
 * received, not by reading this package.
 *
 * SCOPE, because the fix and the bug sat on opposite sides of a boundary. The
 * client is deliberately transport-shaped: `EventSourceLike` has no
 * `addEventListener`, so a client cannot subscribe to a named SSE event and does
 * not try. Deciding which frames reach it is the HOST's job, and the host for
 * `/city` is `apps/web/src/ui/browser-event-source.ts`, which has its own test.
 * What this file pins is the half the client owns: given the payload a browser
 * hands over, it must produce a display node.
 */

type Handler = (event: { readonly data: string }) => void;

/** A source that delivers `MessageEvent.data` and nothing else, as a browser does. */
class BrowserSource implements EventSourceLike {
  onmessage: Handler | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  close(): void {
    this.closed = true;
  }

  /** The payload a browser's handler receives for a frame. */
  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

/** Counts display nodes without pulling Pixi into the assertion. */
class CountingView {
  applied: string[] = [];
  get nodeCount(): number {
    return this.applied.length;
  }
  applyAgentDelta(agentIds: readonly string[]): void {
    this.applied.push(...agentIds);
  }
  sweep(): void {
    this.applied = [];
  }
  rebuild(): void {
    this.applied = [];
  }
}

const AT = '2026-09-27T00:00:00.000Z';

function fullState(liveSessionIds: readonly string[]) {
  return { kind: 'full_state', state: { protocolVersion: '0.1.0', liveSessionIds } };
}

function sessionStarted(sessionId: string) {
  return {
    kind: 'delta',
    event: {
      type: 'session.started',
      occurredAt: AT,
      actorId: 'agent-1',
      payload: { sessionId, agentId: 'agent-1', harness: 'claude' },
    },
  };
}

function aClient() {
  const view = new CountingView();
  let source: BrowserSource | undefined;
  const client = new GameClient({
    view,
    url: '/api/events/stream',
    createSource: (url) => {
      source = new BrowserSource(url);
      return source;
    },
  });
  return { client, view, source: () => source };
}

describe('a host whose EventSource behaves like a browser', () => {
  it('applies a delta the browser hands over, and makes a display node', () => {
    // Before the fix this returned undefined for every frame: `decodeFrame`
    // scanned for a `data: ` prefix, a bare payload has none, so the client
    // tore the connection down and resynced, and the world stayed empty while
    // looking perfectly healthy.
    const { client, view, source } = aClient();
    client.connect();

    source()?.deliver(fullState([]));
    source()?.deliver(sessionStarted('s1'));
    // The loop drains on a frame, and a frame is driven explicitly here for the
    // same reason the sibling suite drives it: an auto-scheduled rAF makes a
    // synchronous assertion a race.
    client.frame();

    expect(view.applied).toContain('s1');
    expect(view.nodeCount).toBeGreaterThan(0);
  });

  it('hydrates from a browser-shaped full_state rather than waiting for ever', () => {
    // The observable proof the snapshot landed: a delta afterwards is applied,
    // where before the snapshot it is refused as "before the first full_state".
    const { client, view, source } = aClient();
    client.connect();

    source()?.deliver(fullState([]));
    source()?.deliver(sessionStarted('s2'));
    client.frame();

    expect(view.applied).toEqual(['s2']);
  });

  it('still accepts the raw wire text, so a non-browser host is not broken by this', () => {
    // The shape the sibling suite already uses. Both are legitimate sources and
    // accepting one must not cost the other — the fix widened the decoder rather
    // than replacing what it understood.
    const view = new CountingView();
    const raw = new RawSource();
    const client = new GameClient({ view, url: '/api/events/stream', createSource: () => raw });
    client.connect();

    raw.deliver(`event: full_state\ndata: ${JSON.stringify(fullState([]))}\n\n`);
    raw.deliver(`event: delta\ndata: ${JSON.stringify(sessionStarted('s9'))}\n\n`);
    client.frame();

    expect(view.applied).toContain('s9');
  });
});

/** A source that hands over the raw wire text, as the sibling suite's does. */
class RawSource {
  onmessage: Handler | null = null;
  onerror: ((event: unknown) => void) | null = null;
  close(): void {}
  deliver(message: string): void {
    this.onmessage?.({ data: message });
  }
}
