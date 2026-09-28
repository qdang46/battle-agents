/**
 * The game client: the PixiJS world, M5.
 *
 * Plan section 25, and the decomposition of
 * `.tmp/age-of-agents/packages/client/src/game/` (MIT, Copyright (c) 2026
 * Mateusz Pawelczuk, recorded in THIRD-PARTY-NOTICES.md).
 *
 * **Where the mirroring stops, and why that is a decision rather than drift.**
 * The reference's `view.ts` reconciles by walking every entity on every state
 * change, because its store is a whole-world snapshot. Ours takes a list of the
 * agents a delta touched, because at the event rates plan section 7.2 targets
 * (2000/s) a full walk is the entire frame budget and looks perfect in every
 * screenshot. The pixel math — `projection.ts`, the corner mask, the waypoint
 * graph, the terrain sampler, the camera guards — is mirrored and is the right
 * thing to copy. The reconcile is not, and the tests in this package are the
 * reason the difference is enforced rather than merely intended.
 *
 * The other divergence is the zone set. `TOOL_ZONE_MAP` belongs to
 * `@battle-agents/protocol` and is consumed, never restated; see `zones.ts`.
 *
 * A note on what this package does NOT do: it does not mount anything. There is
 * no `Application.init()`, no React root and no route, because DESIGN.md
 * section 3 settles the first screen as the modern Bounty Board and the Coding
 * City as a second view reached from it. A client package that mounted itself
 * would be a landing page, and that is the decision DESIGN.md exists to have
 * already made.
 */

/* ── the world ── */

export { topdown, isometric, type Projection } from './game/projection.js';
export {
  CountingView,
  PixiWorldView,
  type PixiViewOptions,
  type WorldViewLike,
} from './game/view.js';
export { WaypointGraph, type GraphSpec, type PathNode } from './game/pathfind.js';
export {
  DELTA_FRAME_BUDGET_MS,
  FrameLoop,
  MAX_EVENTS_PER_FRAME,
  type FrameLoopOptions,
  type FrameRenderer,
} from './game/frame-loop.js';
export { installCameraGuards } from './game/camera-guards.js';

/* ── terrain ── */

export {
  DUAL_GRID_LOOKUP,
  NE,
  NW,
  SE,
  SW,
  cornerMask,
  drawsTile,
  frameForMask,
  type IsUpper,
} from './game/autotile.js';
export {
  TERRAINS,
  TERRAIN_LAYER_ORDER,
  buildTerrainMap,
  terrainSampler,
  tilesForTerrain,
  type GridSpec,
  type TerrainId,
  type TilePlacement,
} from './game/terrain-map.js';

/* ── state and transport ── */

export {
  WorldStore,
  type AgentView,
  type StoreChange,
  type StoreListener,
  type WorldSnapshot,
} from './state/store.js';
export {
  StreamClient,
  decodeFrame,
  type ConnectionState,
  type EventSourceFactory,
  type EventSourceLike,
  type StreamClientOptions,
  type StreamFrame,
  type StreamHandlers,
} from './net/client.js';

/* ── zones ── */

export {
  ZONE_FOR_EVENT,
  ZONE_PLACEMENT,
  placementFor,
  zoneForTool,
  type ZonePlacement,
} from './zones.js';
export type { ZoneId } from '@battle-agents/protocol';

/* ── scenes ── */

export { ARENA, CITY, GUILD_HALL, SCENES, sceneById, type SceneConfig, type SceneId } from './scenes/scene-config.js';
export { cityScene } from './scenes/city.js';
export { arenaScene } from './scenes/arena.js';
export { guildHallScene } from './scenes/guild-hall.js';

/* ── the client that ties them together ── */

export { DEFAULT_STREAM_URL, GameClient, type GameClientOptions } from './client.js';

/* ── sprites ── */

export {
  PLACEHOLDER_SCALE,
  PLACEHOLDER_TILE_PX,
  REAL_ASSET_SCALE,
  SpriteCache,
  TILE_SOURCE_PX,
  TILE_WORLD_PX,
  resetSpriteCache,
  spriteCache,
  spriteKey,
  type SpriteCacheStats,
  type SpriteKey,
  type SpriteKind,
} from './sprites/sprite-factory.js';
export {
  ALL_ZONES,
  ART_BASE,
  ZONES_WITH_BUILDINGS,
  buildingForZone,
  loadSpriteAssets,
  type ArtTheme,
  type HeroSheet,
  type LoadSpriteAssetsOptions,
  type SpriteAssets,
} from './sprites/asset-atlas.js';
export {
  KENNEY_DUNGEON_PACK,
  KENNEY_GROUND_PACK,
  KENNEY_PLATFORMER_PACK,
  KENNEY_SHIOT_PACK,
  KENNEY_SKI_PACK,
  KENNEY_TERRAIN_PACKS,
  KENNEY_TOWN_PACK,
} from './sprites/kenney-packs.js';
export { PixelCanvas, hex, withAlpha, type Rgba } from './sprites/pixel-canvas.js';
export {
  DEFAULT_POINTER_CONFIG,
  idlePointer,
  reducePointer,
  selectionRectFrom,
  type Point,
  type PointerConfig,
  type PointerEvent,
  type PointerIntent,
  type PointerPhase,
  type PointerState,
  type PointerStep,
  type SelectionRect,
} from './game/pointer-intent.js';
export {
  CONTROL_GROUP_KEYS,
  appendControlGroup,
  assignControlGroup,
  isControlGroupKey,
  recallControlGroup,
  type ControlGroupKey,
  type ControlGroups,
} from './game/control-groups.js';
