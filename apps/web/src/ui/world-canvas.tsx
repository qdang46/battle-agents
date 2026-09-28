'use client';

import { Application, Graphics } from 'pixi.js';
import {
  GameClient,
  PixiWorldView,
  WorldStore,
  loadSpriteAssets,
  spriteCache,
  type SceneConfig,
  type SpriteAssets,
} from '@battle-agents/game-client';
import { useEffect, useRef, useState } from 'react';

import { browserEventSource } from './browser-event-source.js';
import { idlePointer, reducePointer } from '@battle-agents/game-client';

/**
 * One PixiJS world, with the scene as a prop rather than a page.
 *
 * ## Why changing scene does not reload the world
 *
 * The first version rebuilt EVERYTHING on a scene change, because the setup was
 * one effect that depended on the scene: a new `Application`, a new store, a new
 * client, and the art re-fetched. That is a page load wearing a costume, and it
 * is the thing `GameShell` exists to stop — pressing a scene should be a camera
 * move, not a navigation.
 *
 * So the three lifetimes are separated, and each is re-created only when it has
 * to be:
 *
 * - the **art** is fetched once, ever, and cached in a ref;
 * - the **application, store and client** are built once and kept in refs, which
 *   is what keeps the SSE connection and every character alive across a switch;
 * - the **view** is rebuilt per scene, because a view is where the scene lives.
 *
 * ## What is on screen came from an event
 *
 * There is no fixture and no seed in this file. The store is empty before the
 * first `full_state`, and an agent appears when a `session.started` delta lands.
 * A world that rendered a character nobody sent would be visible here as a
 * character that should not be there, which is the property the page is for.
 */
export type WorldStatus = 'starting' | 'streaming' | 'stopped' | 'failed';

export interface WorldCanvasProps {
  readonly scene: SceneConfig;
  /** Reported to the shell, which draws the footer rather than the component. */
  readonly onStatus?: (status: WorldStatus) => void;
  readonly onAgents?: (count: number) => void;
  readonly onArt?: (note: string) => void;
  /** Character ids lit by a control group. Recalled in the shell. */
  readonly highlighted?: readonly string[];
  /** Notified whenever the group membership changes, so the shell can keep it. */
  readonly onGroupsChange?: (agentIds: readonly string[]) => void;
  /** The shell pushes recalled group membership in here. */
  /** Fills its parent instead of taking a fixed height. */
  readonly fill?: boolean;
  /** The fixed height, when not filling. */
  readonly height?: number;
  /** The description line, for the standalone form. Omitted in the full-bleed one. */
  readonly description?: string;
}

interface World {
  readonly app: Application;
  readonly store: WorldStore;
  readonly client: GameClient;
  /** The agent-count poll, cleared by the effect's own cleanup. */
  readonly timer: ReturnType<typeof setInterval>;
  /** The view, so a caller can reach what the world owns — highlight, sweep. */
  readonly view: PixiWorldView;
}

export function WorldCanvas({
  scene,
  onStatus,
  onAgents,
  onArt,
  fill = false,
  height = 460,
  highlighted = [],
  description,
}: WorldCanvasProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const world = useRef<World | undefined>(undefined);
  /**
   * The pointer handlers, held so the effect's cleanup can remove them.
   *
   * A ref rather than a local, because the handlers are created deep inside an
   * async IIFE and the cleanup runs outside it — a `const` from the IIFE is not
   * in scope where the cleanup needs it, and an inline arrow in the cleanup would
   * be a DIFFERENT function object, so the remove would silently match nothing
   * and the listener would outlive the world.
   */
  const pointerHandlers = useRef<{
    down: (event: PointerEvent) => void;
    move: (event: PointerEvent) => void;
    up: (event: PointerEvent) => void;
  } | null>(null);
  const [artNote, setArtNote] = useState('art: loading…');

  /**
   * The art, loaded ONCE, and STATE rather than a ref.
   *
   * State, and that is the fix for a bug that made the game invisible.
   *
   * The first version kept the assets in a ref and attached them to the shared
   * cache from this effect, then built the view in a SEPARATE effect. Effects run
   * in order but this one is async, so the view was always constructed against an
   * empty cache — placeholder rectangles — and the art arrived afterwards to a
   * cache nothing was reading from. `attach()` clears the cache's entries so the
   * NEXT lookup gets real art; the sprites already built kept the textures they
   * had been given, which were the placeholders.
   *
   * The result was a fully working game rendering rectangles, with 3,436
   * licensed files loaded, a font loaded, and an "art: 8 heroes" note in the
   * footer saying it had all worked. Nothing reported a problem, because nothing
   * was broken — the art was simply attached to a cache that had already been
   * read from.
   *
   * Holding it in state makes the world effect depend on it, so the first view
   * is built AFTER the art is there.
   */
  const [assets, setAssets] = useState<SpriteAssets | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadSpriteAssets();
        if (cancelled) return;
        spriteCache().attach(loaded);
        setAssets(loaded);
        const note =
          loaded.missing.length === 0
            ? `art: ${loaded.heroes.length} heroes, ${loaded.buildings.size} buildings, ${loaded.terrain.length} terrain`
            : `art: ${loaded.heroes.length} heroes, ${loaded.buildings.size} buildings, ${loaded.missing.length} missing`;
        setArtNote(note);
        onArt?.(note);
      } catch (error) {
        const note = `art unavailable: ${error instanceof Error ? error.message : String(error)}`;
        setArtNote(note);
        onArt?.(note);
        // Attaching nothing is still an answer: the programmatic factory draws
        // the placeholders, so a world appears either way.
        setAssets(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onArt]);

  /**
   * Wait for the art before building anything.
   *
   * The programmatic factory is the fallback, not the plan. Building the view
   * first and hoping the art catches up is what put rectangles on the map with a
   * green status line beside them.
   */
  const ready = assets !== null || artNote.startsWith('art unavailable');

  // The application, the store and the client: built once and kept. A scene
  // change must not cost the SSE connection or the characters already on the map.
  useEffect(() => {
    const container = host.current;
    // NOT ready yet: the art is still loading, and a view built now would be
    // built against placeholders. See the note on the art effect.
    if (!ready || container === null || world.current !== undefined) return;

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

        const store = new WorldStore();
        // ONE store for the client's whole life, and the view is built over the
        // one it was handed. A view over a different store is the silent
        // empty-world failure: the client writes deltas into a store the view
        // never reads.
        const view = new PixiWorldView({ store, scene });
        app.stage.addChild(view.root);

        const observer = new ResizeObserver(() => {
          view.fit(container.clientWidth, container.clientHeight);
        });
        observer.observe(container);
        view.fit(container.clientWidth, container.clientHeight);

        // Pointer input, through the pure state machine so the gesture rules
        // (drag-threshold, marquee commitment, click-vs-pan) live in one tested
        // module rather than in a dozen DOM listeners here.
        //
        // The canvas pans by moving the world container, and the marquee draws as
        // a rectangle over it. Both are read-only affordances — nothing here
        // mutates the world, because a spectator watching agents work should not
        // be able to change what they see by dragging.
        let pointer = idlePointer();
        const marquee = new Graphics();
        marquee.visible = false;
        app.stage.addChild(marquee);
        const toLocal = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
          const rect = container.getBoundingClientRect();
          return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        };
        const onPointerDown = (event: PointerEvent): void => {
          const step = reducePointer(pointer, {
            type: 'pointerDown',
            button: event.button === 2 ? 'secondary' : 'primary',
            point: toLocal(event),
          });
          pointer = step.state;
          container.setPointerCapture(event.pointerId);
        };
        const onPointerMove = (event: PointerEvent): void => {
          const step = reducePointer(pointer, { type: 'pointerMove', point: toLocal(event) });
          pointer = step.state;
          const intent = step.intent;
          if (intent.kind === 'pan') {
            view.root.x += intent.deltaX;
            view.root.y += intent.deltaY;
          } else if (intent.kind === 'select' && intent.live) {
            marquee
              .clear()
              .rect(intent.rect.x, intent.rect.y, intent.rect.width, intent.rect.height)
              .fill({ color: 0x5b8dd6, alpha: 0.15 })
              .stroke({ color: 0x8ab4f8, width: 1 });
            marquee.visible = true;
          }
        };
        const onPointerUp = (event: PointerEvent): void => {
          const step = reducePointer(pointer, { type: 'pointerUp', point: toLocal(event) });
          pointer = step.state;
          if (step.intent.kind === 'select' && !step.intent.live) {
            // A committed marquee selects nobody yet: `onSelect` is where a host
            // with a selection model would take the ids under the rect. The world
            // here is a spectator view, so the rect is drawn and released.
            marquee.visible = false;
            marquee.clear();
          }
          if (container.hasPointerCapture(event.pointerId)) {
            container.releasePointerCapture(event.pointerId);
          }
        };
        pointerHandlers.current = { down: onPointerDown, move: onPointerMove, up: onPointerUp };
        container.addEventListener('pointerdown', onPointerDown);
        container.addEventListener('pointermove', onPointerMove);
        container.addEventListener('pointerup', onPointerUp);
        container.addEventListener('contextmenu', preventDefaultContextMenu);

        const client = new GameClient({
          store,
          view,
          createSource: browserEventSource,
          url: '/api/events/stream',
        });
        const timer = setInterval(() => {
          onAgents?.(view.nodeCount);
        }, 500);

        client.connect();
        client.start();
        onStatus?.('streaming');
        // Assigned once, complete. There was a `world.current = {app, store,
        // client}` before this, without the timer — so for the moment between
        // the two assignments the effect's cleanup had a half-built world to
        // destroy, and the type said the object was not a `World` at all.
        world.current = { app, store, client, timer, view };

        return undefined;
      } catch (thrown) {
        onStatus?.('failed');
        setArtNote((previous) => previous);
        throw thrown instanceof Error ? thrown : new Error(String(thrown));
      }
    })();

    return () => {
      cancelled = true;
      // The pointer listeners are removed here for the same reason the interval
      // is cleared here: a handler left on the container outlives the world and
      // keeps calling into a destroyed view. `node:false` because a container
      // that is going away should not keep the window from releasing its
      // pointer capture either.
      const handlers = pointerHandlers.current;
      if (handlers !== null) {
        container.removeEventListener('pointerdown', handlers.down);
        container.removeEventListener('pointermove', handlers.move);
        container.removeEventListener('pointerup', handlers.up);
        pointerHandlers.current = null;
      }
      container.removeEventListener('contextmenu', preventDefaultContextMenu);
      const current = world.current;
      if (current !== undefined) {
        // The interval is cleared HERE, in the effect's own cleanup. It used to
        // be cleared by a `return` from inside the async IIFE above, which makes
        // it the promise's resolved VALUE — and `void` discards that. So the
        // timer was never cleared, and every scene change (which re-ran this
        // effect) left another one calling setAgents after unmount.
        clearInterval(current.timer);
        current.client.destroy();
        current.app.destroy(true, { children: true });
        world.current = undefined;
      }
    };
    // `scene` is DELIBERATELY not a dependency, and that is the whole point of
    // this effect existing.
    //
    // It was in the array, so React ran the cleanup above and rebuilt the entire
    // world on every scene press: a new Application, a new store, a new client,
    // a new SSE connection and a full refetch — while the header comment three
    // hundred lines up promised the opposite. The scene is read through the
    // effect below, which builds a new VIEW over the same store. The only
    // dependency that rebuilds the world is `ready`, which flips once.
  }, [onAgents, onStatus, ready]);

  // The control-group highlight, pushed into the world when the group changes.
  // The shell owns the groups; the view owns the rings. Nothing in between.
  useEffect(() => {
    world.current?.view.setHighlighted(highlighted ?? []);
  }, [highlighted]);

  // The view is the only thing the scene changes. Rebuilding it re-fits the
  // existing world rather than reloading it, so the characters stay.
  useEffect(() => {
    const container = host.current;
    const current = world.current;
    // `ready` is in the dependency list, so this runs again once the art lands
    // and the world exists to be rebound. Before that there is nothing to draw
    // into, and a view built against no world would be a view that renders into
    // a detached container.
    if (!ready || container === null || current === undefined) return;
    const previous = current.app.stage.children[0];
    if (previous !== undefined) current.app.stage.removeChild(previous);
    const view = new PixiWorldView({ store: current.store, scene });
    current.app.stage.addChild(view.root);
    view.fit(container.clientWidth, container.clientHeight);
    // A rebuild attaches a NEW view, and the client holds the old one. Pointing
    // the client at this view is what makes a switched scene render at all
    // instead of rendering nothing into a detached container.
    current.client.rebindView(view);
  }, [scene]);

  return (
    <div style={{ width: '100%', height: fill ? '100%' : `${height}px` }}>
      <div
        ref={host}
        data-testid={`${scene.id}-canvas`}
        style={{ width: '100%', height: '100%', border: '1px solid #232a3a', borderRadius: '6px', overflow: 'hidden' }}
      />
      {description === undefined ? null : (
        <p style={{ marginTop: '0.5rem', opacity: 0.7, fontSize: '0.85rem' }}>
          {description}
          {artNote === '' ? '' : ` · ${artNote}`}
        </p>
      )}
    </div>
  );
}

/**
 * The heading a scene page carries, shared so the three read as one family.
 */
export function ScenePage({ scene, description }: { readonly scene: SceneConfig; readonly description: string }) {
  return (
    <main style={{ padding: '1.5rem', fontFamily: 'ui-monospace, monospace' }}>
      <h1 style={{ fontSize: '1.25rem', margin: '0 0 0.25rem' }}>{scene.label}</h1>
      <WorldCanvas scene={scene} description={description} />
    </main>
  );
}

/**
 * The right button pans, so it must not also open the browser menu.
 *
 * Without this a right-drag pans the map and opens a context menu on the first
 * pixel, which is the most-annoying way a pan control can be built.
 */
function preventDefaultContextMenu(event: Event): void {
  event.preventDefault();
}
