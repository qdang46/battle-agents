/**
 * The world view: the reconciliation that has to stay O(changes).
 *
 * Mirrored from age-of-agents `packages/client/src/game/view.ts` (MIT, see
 * THIRD-PARTY-NOTICES.md) in its DECOMPOSITION — a Pixi scene with a terrain
 * layer, a unit layer, and a reconcile that maps world state onto units — and
 * deliberately not mirrored in its reconcile. The reference walks every hero and
 * every peon on every state change, because its store is a whole-world snapshot
 * it re-reads. At five units that is free; at five hundred agents receiving two
 * thousand events a second it is the entire frame budget, and it is invisible in
 * a screenshot.
 *
 * So `applyAgentDelta(ids)` here is handed the agents that changed and touches
 * exactly those. It never reads the store's size and never iterates the
 * container, and it cannot be made to: the store passes a list, not a reference.
 * The two places that genuinely must look at everything — `sweep` and
 * `rebuild` — are separate methods with names that say so, and neither is
 * reachable from a delta.
 */

import { Container, Sprite } from 'pixi.js';

import { ZONE_PLACEMENT, placementFor } from '../zones.js';
import type { AgentView, WorldStore } from '../state/store.js';
import {
  PLACEHOLDER_SCALE,
  TILE_WORLD_PX,
  spriteCache,
  spriteKey,
  type SpriteCache,
  type SpriteKind,
} from '../sprites/sprite-factory.js';
import { topdown, type Projection } from './projection.js';

/** Grid size of a scene. Large enough to feel like a city, small enough to test. */
export const DEFAULT_GRID = { w: 32, h: 32 } as const;

/**
 * The view contract, so a test can substitute a counting implementation.
 *
 * Deliberately tiny. The moment it grows a method the reconciler needs, the
 * question "could this walk the whole scene?" has to be asked again, and the
 * property under test is that the answer stays no.
 */
export interface WorldViewLike {
  /** Applies a delta for exactly these agents. */
  applyAgentDelta(agentIds: readonly string[]): void;
  /** Removes agents the store no longer has. Resync only. */
  sweep(): void;
  /** Rebuilds everything from the store. Hydrate and resync only. */
  rebuild(): void;
  /** How many display nodes exist. Diagnostics and tests. */
  readonly nodeCount: number;
}

interface UnitNode {
  readonly sprite: Sprite;
  zone: string;
  online: boolean;
}

/** The sprite kind an agent draws as. A spawning subagent is drawn smaller. */
function spriteKindFor(agent: AgentView): SpriteKind {
  return agent.children.length > 0 ? 'subagent' : 'agent';
}

/**
 * A stable palette index per agent id.
 *
 * Hashed rather than counted, so an agent that reconnects keeps its colour. A
 * counter assigns a different colour on every reconnect, and a city whose
 * characters change colour when you look away is worse than one with too few
 * colours.
 */
function paletteIndexFor(agentId: string): number {
  let hash = 0;
  for (const character of agentId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export interface PixiViewOptions {
  readonly store: WorldStore;
  readonly projection?: Projection;
  readonly cache?: SpriteCache;
}

/**
 * The Pixi-backed world view.
 *
 * One `Sprite` per agent, plus one zone marker per placed zone built once at
 * construction and never rebuilt on a delta.
 */
export class PixiWorldView implements WorldViewLike {
  readonly #store: WorldStore;
  readonly #projection: Projection;
  readonly #cache: SpriteCache;

  /** Everything the host draws into. */
  readonly worldLayer = new Container();
  /** Zone markers. Static: added once, never touched by a delta. */
  readonly zoneLayer = new Container();
  /** Agent sprites, added and removed as agents come and go. */
  readonly unitLayer = new Container();

  readonly #units = new Map<string, UnitNode>();

  constructor(options: PixiViewOptions) {
    this.#store = options.store;
    this.#projection = options.projection ?? topdown(TILE_WORLD_PX);
    this.#cache = options.cache ?? spriteCache();
    this.worldLayer.addChild(this.zoneLayer, this.unitLayer);
    this.#drawZones();
  }

  get nodeCount(): number {
    return this.#units.size;
  }

  get root(): Container {
    return this.worldLayer;
  }

  /**
   * Fits the whole grid into a viewport of this size, and centres it.
   *
   * ## Why this exists
   *
   * `topdown(TILE_WORLD_PX)` maps the 32x32 grid to 32 * 48 = 1536 square
   * pixels and nothing scaled that to the canvas, so the world stayed 1536x1536
   * inside a viewport a few hundred pixels tall. Measured in a running browser:
   * canvas 1230x458, an idle agent's sprite at world (864, 864). The sprite
   * existed, its texture was a valid 16x16, it was visible, correctly parented
   * and correctly scaled — and it was 400px below the bottom of the picture.
   *
   * There is no camera, so this is the camera. Uniform on both axes and
   * centred, not stretched to fill: a non-uniform scale turns a round sprite
   * into an ellipse, and letterboxing keeps the whole map readable instead of
   * filling the screen with a third of it.
   *
   * ## Why it is here and not on `WorldViewLike`
   *
   * That seam is four members wide on purpose, and a resize method is exactly
   * the kind of thing that makes it a fifth: every host would be handed a
   * viewport question it cannot answer without knowing the grid. The grid and
   * the tile size are this class's own, and `CountingView` has neither.
   */
  fit(width: number, height: number): void {
    // A zero-sized viewport happens on the first layout pass, and a scale of
    // zero would leave the world invisible until something refitted it. Skipping
    // is the honest answer: there is nothing to fit INTO yet.
    if (width <= 0 || height <= 0) return;
    const worldPx = DEFAULT_GRID.w * TILE_WORLD_PX;
    const scale = Math.min(width / worldPx, height / worldPx);
    this.worldLayer.scale.set(scale);
    this.worldLayer.position.set(
      (width - worldPx * scale) / 2,
      (height - worldPx * scale) / 2,
    );
  }

  /**
   * Applies a delta for the named agents, and nothing else.
   *
   * The loop is over `agentIds` and there is no second loop. A view that needed
   * to know whether some OTHER agent also changed would have to iterate the
   * store, and that is the O(scene) cost this design exists to make
   * unrepresentable — so the signature takes ids and there is nothing to
   * iterate.
   */
  applyAgentDelta(agentIds: readonly string[]): void {
    for (const id of agentIds) {
      const agent = this.#store.get(id);
      if (agent === undefined) {
        this.#remove(id);
        continue;
      }
      this.#applyOne(agent);
    }
  }

  /**
   * Removes agents the store no longer holds.
   *
   * Separate from the delta path because the store never removes an agent: one
   * that stops reporting stays on the map as OFFLINE, since DESIGN.md section 4
   * is explicit that a dead session must not make a character vanish. This is
   * for the resync case, where a fresh snapshot is authoritative and an agent it
   * does not list is genuinely gone.
   */
  sweep(): void {
    for (const id of [...this.#units.keys()]) {
      if (this.#store.get(id) === undefined) this.#remove(id);
    }
  }

  /** Full rebuild. The one O(scene) path, and it is not reachable from a delta. */
  rebuild(): void {
    for (const id of [...this.#units.keys()]) this.#remove(id);
    for (const agent of this.#store.allAgents()) this.#applyOne(agent);
  }

  #applyOne(agent: AgentView): void {
    const placement = placementFor(agent.zone);
    const screen = this.#projection.toScreen(placement.gx, placement.gy);
    const depth = this.#projection.depth(placement.gx, placement.gy);
    const existing = this.#units.get(agent.agentId);

    if (existing === undefined) {
      const sprite = new Sprite(
        this.#cache.get(spriteKey(spriteKindFor(agent), paletteIndexFor(agent.agentId))),
      );
      sprite.anchor.set(0.5, 0.5);
      sprite.scale.set(PLACEHOLDER_SCALE);
      sprite.position.set(screen.x, screen.y);
      sprite.zIndex = depth;
      sprite.alpha = agent.online ? 1 : 0.45;
      this.unitLayer.addChild(sprite);
      this.#units.set(agent.agentId, {
        sprite,
        zone: agent.zone,
        online: agent.online,
      });
      return;
    }

    // Field by field, each write guarded by the value it changes. Reassigning
    // the whole node on every event is the O(scene) cost in a small hat, and
    // the store's `sameView` comparison exists to stop a delta arriving here
    // that has nothing to draw.
    if (existing.zone !== agent.zone) {
      existing.zone = agent.zone;
      existing.sprite.position.set(screen.x, screen.y);
      existing.sprite.zIndex = depth;
    }
    if (existing.online !== agent.online) {
      existing.online = agent.online;
      // Dimmed, not removed. DESIGN.md section 4.
      existing.sprite.alpha = agent.online ? 1 : 0.45;
    }
  }

  #remove(id: string): void {
    const node = this.#units.get(id);
    if (node === undefined) return;
    this.unitLayer.removeChild(node.sprite);
    node.sprite.destroy();
    this.#units.delete(id);
  }

  /**
   * One marker per placed zone, built once.
   *
   * Driven off the placement table so a zone added to `ZONE_PLACEMENT` appears
   * without a change here. The dependency runs one way — `zones.ts` decides
   * where things are, this draws them — which is why the view reads the table
   * instead of the view owning a list of buildings.
   */
  #drawZones(): void {
    for (const zone of Object.keys(ZONE_PLACEMENT) as (keyof typeof ZONE_PLACEMENT)[]) {
      const placement = ZONE_PLACEMENT[zone];
      const screen = this.#projection.toScreen(placement.gx, placement.gy);
      const marker = new Sprite(this.#cache.get(spriteKey('zone-marker', paletteIndexFor(zone))));
      marker.anchor.set(0.5, 0.5);
      marker.scale.set(PLACEHOLDER_SCALE);
      marker.position.set(screen.x, screen.y);
      // One behind the units, so an agent standing on a zone is in front of it.
      marker.zIndex = this.#projection.depth(placement.gx, placement.gy) - 1;
      this.zoneLayer.addChild(marker);
    }
  }
}

/**
 * A view that counts what it touches.
 *
 * The seam that makes the O(changes) property testable without a GPU, and the
 * reason `WorldViewLike` exists. `touches` accumulates every agent this view
 * applied, so a test asserts the number directly instead of inferring cost from
 * a frame time.
 */
export class CountingView implements WorldViewLike {
  readonly #store: WorldStore;
  readonly #live = new Set<string>();
  touches = 0;
  sweeps = 0;
  rebuilds = 0;
  resyncs = 0;

  constructor(store: WorldStore) {
    this.#store = store;
  }

  get nodeCount(): number {
    return this.#live.size;
  }

  applyAgentDelta(agentIds: readonly string[]): void {
    for (const id of agentIds) {
      this.touches += 1;
      if (this.#store.get(id) === undefined) this.#live.delete(id);
      else this.#live.add(id);
    }
  }

  sweep(): void {
    this.sweeps += 1;
    for (const id of [...this.#live]) {
      if (this.#store.get(id) === undefined) this.#live.delete(id);
    }
  }

  rebuild(): void {
    this.rebuilds += 1;
    this.touches += this.#store.size;
    this.#live.clear();
    for (const agent of this.#store.allAgents()) this.#live.add(agent.agentId);
  }
}
