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
import { GameClient, PixiWorldView, WorldStore } from '@battle-agents/game-client';
import { useEffect, useRef, useState } from 'react';

import { browserEventSource } from '@/ui/browser-event-source.js';

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
    // in state would re-run this effect every time the count changed. Declared
    // as a nullable field rather than an optional one because
    // `exactOptionalPropertyTypes` makes `{ a?: T }` and `{ a: T | undefined }`
    // different types, and this one is genuinely assigned undefined.
    const live: { current: { app: Application; client: GameClient } | undefined } = { current: undefined };
    // Anything the async setup allocated and the effect's teardown must release.
    // Collected rather than returned from the IIFE, because a cleanup returned
    // from inside an async function is a promise nobody awaits — the first
    // version returned one and leaked the interval for the life of the page.
    const clearups: (() => void)[] = [];

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

        // The view is built HERE and handed in, not defaulted inside the client.
        // `WorldViewLike` is the seam the tests use and deliberately carries only
        // the delta methods; the stage node a host has to add is on the concrete
        // view, and asking the client for its own view and then reaching past its
        // interface for `root` is the shape that stops typechecking the moment
        // the seam is renamed.
        // ONE store, handed to both the view and the client. Passing a view
        // built on a different store is the silent failure this pair exists to
        // prevent: the client writes deltas into its own store, the view looks
        // agents up in the one it was built on, and the city renders an empty
        // world while reporting `streaming` and a clean console.
        const store = new WorldStore();
        const view = new PixiWorldView({ store });
        app.stage.addChild(view.root);

        // The real stream, and the real browser EventSource. The client refuses
        // to default this so that a missing factory fails at wiring time rather
        // than at connect time — which is exactly what would happen here.
        const client = new GameClient({
          store,
          view,
          createSource: browserEventSource,
          url: '/api/events/stream',
        });
        live.current = { app, client };

        // A count for the page, read from the view rather than kept alongside
        // it. A second source of truth for "how many agents" is a number that
        // can disagree with the world.
        const readCount = (): void => {
          setAgents((previous) => {
            const next = view.nodeCount;
            return next === previous ? previous : next;
          });
        };
        const timer = setInterval(readCount, 500);

        client.connect();
        client.start();
        setStatus('streaming');

        // Pixi owns its own ticker and presents the scene; the client's loop is
        // scheduled on rAF and mutates it. Nothing to add to the ticker.
        clearups.push(() => {
          clearInterval(timer);
        });
      } catch (thrown) {
        setError(thrown instanceof Error ? thrown.message : String(thrown));
        setStatus('failed');
      }
    })();

    return () => {
      cancelled = true;
      for (const cleanup of clearups.splice(0)) {
        cleanup();
      }
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
