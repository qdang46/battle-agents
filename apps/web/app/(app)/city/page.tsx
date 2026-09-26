'use client';

/**
 * The Coding City: the game's second view, mounted.
 *
 * ## Why this page exists and is not a landing page
 *
 * `packages/game-client` was built and deliberately left unmounted — DESIGN.md
 * section 3 settles the Bounty Board as the first screen and the city as a view
 * REACHED FROM it, so a client package that mounted itself would have been a
 * landing page. This is that mounting, at `/city`, and nothing navigates here on
 * its own.
 *
 * ## What it actually is
 *
 * A PixiJS `Application`, a `GameClient` wired to the real SSE endpoint, and
 * nothing else. Every agent on screen arrived as an event: the store is empty
 * before the first `full_state` frame and there is no fixture anywhere in this
 * file, so a world that rendered a character nobody sent would be visible here
 * as a character that should not be there.
 *
 * The frame budget and the delta discipline are in the client package and are
 * measured there. What this page is responsible for is the wiring and the
 * teardown, because a client that is never stopped leaks a ticker, a socket and
 * every sprite it built.
 */

import { Application } from 'pixi.js';
import { GameClient, type WorldViewLike } from '@battle-agents/game-client';
import { useEffect, useRef, useState } from 'react';

type Status = 'starting' | 'streaming' | 'stopped' | 'failed';

export default function CityPage(): React.JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status>('starting');
  const [agents, setAgents] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = host.current;
    if (container === null) {
      return;
    }

    // A ref, not state: the client is an object with a lifetime, and putting it
    // in state would re-run this effect every time the count changed.
    const live: { current?: { app: Application; client: GameClient } } = {};

    let cancelled = false;
    void (async () => {
      try {
        const app = new Application();
        await app.init({
          background: '#0b0e14',
          resizeTo: container,
          antialias: false,
          // A fixed logical resolution the canvas scales up from, so a sprite is
          // the same size on every display and the pixel art stays crisp rather
          // than being resampled per device.
          resolution: 1,
          autoDensity: true,
        });
        if (cancelled) {
          app.destroy(true);
          return;
        }
        container.appendChild(app.canvas);

        // The real stream, and the real browser EventSource. The client refuses
        // to default this so that a missing factory fails at wiring time rather
        // than at connect time — which is exactly what would happen here.
        const client = new GameClient({
          createSource: (url) => new EventSource(url),
          url: '/api/events/stream',
        });

        const view = client.view as WorldViewLike;
        app.stage.addChild(view.root);
        live.current = { app, client };

        // A count for the page, read from the view rather than kept alongside
        // it. A second source of truth for "how many agents" is a number that
        // can disagree with the world.
        const readCount = (): void => {
          setAgents((previous) => {
            const next = (view as { nodeCount?: number }).nodeCount ?? 0;
            return next === previous ? previous : next;
          });
        };
        const timer = setInterval(readCount, 500);

        client.connect();
        client.start();
        setStatus('streaming');

        // Pixi owns its own ticker; the client's loop is scheduled on rAF and
        // drives the view. Both run, and the ticker is what presents.
        app.ticker.add(() => {
          /* the client's rAF loop mutates the scene; this presents it */
        });

        return () => {
          clearInterval(timer);
        };
      } catch (thrown) {
        setError(thrown instanceof Error ? thrown.message : String(thrown));
        setStatus('failed');
      }
    })();

    return () => {
      cancelled = true;
      const current = live.current;
      if (current !== undefined) {
        current.client.destroy();
        current.app.destroy(true, { children: true });
        live.current = undefined;
      }
    };
  }, []);

  return (
    <main style={{ padding: '1.5rem', fontFamily: 'ui-monospace, monospace' }}>
      <h1 style={{ fontSize: '1.25rem', margin: '0 0 0.25rem' }}>Coding City</h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.7, fontSize: '0.85rem' }}>
        Every character here arrived as an event on /api/events/stream. Nothing on
        this page is seeded from a fixture.
      </p>

      <div
        ref={host}
        data-testid="city-canvas"
        style={{
          border: '1px solid #232a3a',
          borderRadius: '6px',
          overflow: 'hidden',
          width: '100%',
          height: '460px',
        }}
      />

      <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', opacity: 0.75 }} data-testid="city-status">
        status: {status} · agents on screen: {agents}
        {error === null ? '' : ` · ${error}`}
      </p>
    </main>
  );
}
