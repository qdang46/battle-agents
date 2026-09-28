/**
 * The programmatic sprite factory: 16x16@3x placeholders drawn in code.
 *
 * Plan section 25: "programmatic 16x16@3x placeholders (agent-move pattern)
 * until the §14 shortlist lands". Two things about that sentence are worth
 * separating, because they are the two things a future contributor will
 * conflate.
 *
 * **16x16@3x is the PLACEHOLDER grid, not the asset grid.** The vendored
 * `tiny-swords-cc0` pack is 64px tiles in source sheets — measured, not assumed,
 * and `docs/design/asset-shortlist.md` records both the measurement and the
 * wrong "16×16" claim it replaced. A renderer built from the plan sentence alone
 * draws a 48px placeholder and a 64px real tile into the same world, and the
 * mismatch shows up as agents and buildings at subtly different scales, which is
 * the kind of bug nobody files because the screenshot looks fine. So the two
 * grids are separate constants and `TILE_SOURCE_PX` is what a real sheet is
 * scaled FROM.
 *
 * **Do not delete this file when real art lands.** The bead is explicit and the
 * reason outlives the art: it is what keeps V0 unblocked, and — the part that
 * makes the tests below possible — it is what lets the client render with no
 * asset pipeline at all. A cache that can only be exercised after a PNG fetch is
 * a cache nobody tests, and `SpriteCache` below is tested on every run.
 *
 * The CACHE is the hard requirement: two lookups of one key return the same
 * object, and the number of constructed sprites does not grow with frames
 * drawn. A fresh texture per lookup is not a cache, it is a leak with a map in
 * front of it, and it stays invisible until the frame budget goes red.
 */

import type { Texture } from 'pixi.js';

import type { ZoneId } from '@battle-agents/protocol';

import { PixelCanvas, hex, withAlpha } from './pixel-canvas.js';
import { buildingForZone, type SpriteAssets } from './asset-atlas.js';

/** The placeholder grid: a 16x16 sprite drawn at 3x. */
export const PLACEHOLDER_TILE_PX = 16;
export const PLACEHOLDER_SCALE = 3;

/**
 * The source tile size of the vendored pack, in pixels.
 *
 * 64, and MEASURED by reading the PNG headers of
 * `apps/web/public/assets/tiny-swords-cc0/` — `Deco/*.png` are 64x64 and the
 * buildings run from 210x420 to 400x505. Not the placeholder grid, and not to
 * be used as one.
 */
export const TILE_SOURCE_PX = 64;

/** One world tile in screen pixels, after the placeholder scale. */
export const TILE_WORLD_PX = PLACEHOLDER_TILE_PX * PLACEHOLDER_SCALE;

/**
 * How a real 64px sheet is drawn into the world.
 *
 * Not an integer, and that is the honest cost of the two grids differing: a
 * real sheet is resampled, so it will not be pixel-crisp at this scale. The
 * placeholders stay at an integer scale for exactly that reason, and the day the
 * asset grid is chosen properly this constant becomes 1 and the resampling goes
 * away. Written down rather than left as an inline division so that the
 * non-integer value is a decision somebody can see.
 */
export const REAL_ASSET_SCALE = TILE_WORLD_PX / TILE_SOURCE_PX;

export type SpriteKind = 'agent' | 'building' | 'zone-marker' | 'terrain-tile' | 'subagent';

/** A cache key. Two equal keys must return the same object. */
export interface SpriteKey {
  readonly kind: SpriteKind;
  /** Palette index, so N agents get N distinct colours. */
  readonly variant: number;
  /**
   * Which place this is, for a key that draws one.
   *
   * Present so the vendored art can answer "which building" rather than "which
   * colour": the Arena's marker draws the arena and the Guild Hall's draws the
   * guild, instead of both drawing a tinted square that happens to be keyed on a
   * hash of the zone name. It is part of the key because two zones in the same
   * scene are now genuinely different pictures, and a key that could not tell
   * them apart would make the cache hand one of them the other's sprite.
   */
  readonly zone?: string;
}

export function spriteKey(kind: SpriteKind, variant: number, zone?: string): SpriteKey {
  return zone === undefined ? { kind, variant } : { kind, variant, zone };
}

/**
 * Agent colours.
 *
 * DESIGN.md section 7 explicitly declines to set a palette, so these are the
 * client's own choice within the settled medium — a dark outline under a bright
 * body, because a 16px figure has to read against a terrain it also draws.
 */
const AGENT_COLORS: readonly number[] = [
  0xe24b4a, 0x378add, 0x1d9e75, 0xef9f27, 0xd4537e, 0x7f77dd, 0x5dcaa5, 0xf0997b,
];

/**
 * How many distinct pictures a kind has, derived rather than restated.
 *
 * Written once from the palette because a hardcoded `8` next to an 8-entry array
 * is a number waiting to drift, and the day it does, `keyOf` collapses two
 * distinct colours onto one cache key and serves the wrong sprite.
 */
const PALETTE_SIZE = AGENT_COLORS.length;

/**
 * The cache key, normalised to the picture the variant actually draws.
 *
 * Normalised, not raw, and that is a bug this file had: with eight palette
 * entries, variant 8 and variant 0 draw the same pixels, so keying on the raw
 * number gave the same image two cache slots and constructed it twice. The key
 * has to be the identity of the image, not the caller's integer — anything else
 * makes the cache hold duplicates and the construction count drift with the
 * number of callers rather than the number of pictures.
 */
function keyOf(key: SpriteKey): string {
  const index = ((key.variant % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
  return key.zone === undefined ? `${key.kind}:${index}` : `${key.kind}:${index}:${key.zone}`;
}

/** The dark line every placeholder is outlined in, so figures read on any tile. */
const OUTLINE = hex(0x14120c);
const SKIN = hex(0xe8d8c0);
const STONE = hex(0x6b6156);

/**
 * Draws one placeholder.
 *
 * Rectangles and one ellipse, deliberately. A placeholder that tries to be a
 * character illustration is a placeholder nobody can distinguish from real art,
 * and the moment real art lands the difference has to be obvious or the
 * placeholders quietly ship.
 */
function drawSprite(key: SpriteKey): PixelCanvas {
  const px = PLACEHOLDER_TILE_PX;
  const canvas = new PixelCanvas(px, px);
  const color = hex(AGENT_COLORS[key.variant % AGENT_COLORS.length] ?? 0x378add);

  switch (key.kind) {
    case 'agent': {
      canvas.fillRect(px * 0.3, px * 0.18, px * 0.4, px * 0.3, SKIN); // head
      canvas.fillRect(px * 0.25, px * 0.46, px * 0.5, px * 0.38, color); // body
      canvas.strokeRect(px * 0.25, px * 0.46, px * 0.5, px * 0.38, OUTLINE);
      break;
    }
    case 'subagent': {
      // Smaller and dimmer: a subagent is on the map but is not the character
      // the scene is about, and a full-size duplicate reads as a second agent
      // of equal importance.
      canvas.fillRect(px * 0.36, px * 0.3, px * 0.28, px * 0.22, withAlpha(SKIN, 0.85));
      canvas.fillRect(px * 0.32, px * 0.5, px * 0.36, px * 0.28, withAlpha(color, 0.8));
      canvas.strokeRect(px * 0.32, px * 0.5, px * 0.36, px * 0.28, OUTLINE);
      break;
    }
    case 'building': {
      canvas.fillRect(px * 0.1, px * 0.28, px * 0.8, px * 0.12, color); // roof band
      canvas.fillRect(px * 0.1, px * 0.4, px * 0.8, px * 0.5, STONE);
      canvas.strokeRect(px * 0.1, px * 0.28, px * 0.8, px * 0.62, OUTLINE);
      break;
    }
    case 'zone-marker': {
      // Flat and translucent, so a zone reads as ground rather than as an
      // object standing on the ground.
      canvas.fillRect(0, 0, px, px, withAlpha(color, 0.3));
      canvas.strokeRect(0, 0, px, px, withAlpha(color, 0.9), 1);
      break;
    }
    case 'terrain-tile': {
      canvas.fillRect(0, 0, px, px, color);
      break;
    }
  }

  return canvas;
}

export interface SpriteCacheStats {
  /** Distinct keys held. */
  readonly size: number;
  /** Textures actually constructed. The number that must not track frames. */
  readonly constructed: number;
  /** Lookups served. Grows forever; `constructed` must not. */
  readonly lookups: number;
  /**
   * Sprites served from the vendored art.
   *
   * The number that says whether the game is drawing its art or drawing
   * rectangles. It is a stat rather than a claim because the alternative was a
   * city full of grey squares and a comment saying the art was on disk.
   */
  readonly fromAssets: number;
}

/**
 * A cache that is a cache, over real art when there is any.
 *
 * Keyed by kind and variant — and now by zone, because two zones in a scene draw
 * different buildings and a key that could not tell them apart would serve one
 * of them the other's sprite.
 *
 * ## Why the art is optional rather than required
 *
 * `assets` is attached after construction, because loading a sheet is async and
 * this class is used synchronously from the view's constructor. Before the
 * attach, every lookup draws a placeholder; after it, the same lookup returns
 * the vendored sprite and the placeholders are not constructed at all. So a
 * client that never loads art is exactly the client this file was written for,
 * and a client that does gets the game's real pixels without a second cache,
 * a second key space or a branch in the view.
 */
export class SpriteCache {
  readonly #textures = new Map<string, Texture>();
  #assets: SpriteAssets | undefined;
  #constructed = 0;
  #lookups = 0;
  /** Sprites served from the vendored art rather than drawn. */
  #served = 0;

  /**
   * Hands the cache the vendored art.
   *
   * Idempotent, and a second attach REPLACES the first rather than merging: a
   * theme swap has to change what a key returns, and a cache that kept the old
   * texture under the same key would serve one theme's buildings from the
   * other's sheet.
   */
  attach(assets: SpriteAssets): void {
    this.#assets = assets;
    for (const id of [...this.#textures.keys()]) {
      this.#textures.delete(id);
    }
  }

  get(key: SpriteKey): Texture {
    this.#lookups += 1;
    const id = keyOf(key);
    const existing = this.#textures.get(id);
    if (existing !== undefined) return existing;

    const real = this.#realTexture(key);
    const texture = real ?? drawSprite(key).toTexture();
    if (real === undefined) {
      this.#constructed += 1;
    } else {
      this.#served += 1;
    }
    this.#textures.set(id, texture);
    return texture;
  }

  /**
   * The vendored texture for a key, or undefined when this build has none.
   *
   * A miss is a normal answer, not a failure: a zone with no building behind it,
   * an empty hero list because the sheet 404s, and a cache nobody attached art
   * to all land here, and each of them must still draw something.
   */
  #realTexture(key: SpriteKey): Texture | undefined {
    const assets = this.#assets;
    if (assets === undefined) return undefined;

    switch (key.kind) {
      case 'agent':
      case 'subagent':
        // The variant is ALREADY a stable hash of the agent id — `paletteIndexFor`
        // in view.ts is what produces it, and it is documented as stable across
        // reconnects for exactly this reason. So indexing the hero list with it
        // gives each character a face that does not change when they come back,
        // and two agents do not collide any more often than their colours do.
        //
        // The older version of this called `heroFor(heroes, String(variant))`,
        // which hashed a number a second time to pick a face — a second opinion
        // about who somebody is, held in a different file, for no gain.
        if (assets.heroes.length === 0) return undefined;
        return assets.heroes[((key.variant % assets.heroes.length) + assets.heroes.length) % assets.heroes.length]
          ?.idle[0];
      case 'zone-marker':
        return key.zone === undefined
          ? undefined
          : buildingForZone(assets.buildings, key.zone as ZoneId);
      case 'building':
        return assets.buildings.values().next().value as Texture | undefined;
      case 'terrain-tile':
        return assets.terrain[key.variant % Math.max(1, assets.terrain.length)];
      default:
        return undefined;
    }
  }

  has(key: SpriteKey): boolean {
    return this.#textures.has(keyOf(key));
  }

  get stats(): SpriteCacheStats {
    return {
      size: this.#textures.size,
      constructed: this.#constructed,
      lookups: this.#lookups,
      fromAssets: this.#served,
    };
  }

  /**
   * The animation frames a character should be playing, or undefined.
   *
   * The animation is chosen by the agent's STATE, not by a timer: an agent with
   * a tool is working and plays `work`, one without is idle and breathes. That
   * is the same state that picks a zone, so a character walks to the terminal
   * and then works at it, rather than standing in one place doing one thing.
   *
   * The array is returned rather than a frame because the CALLER holds the
   * clock: two holders of "the current frame" is how a character ends up on
   * frame 3 of its idle and frame 7 of its work with nothing reconciling them.
   */
  animationFor(
    agentId: string,
    working: boolean,
    walking = false,
  ): readonly Texture[] | undefined {
    const assets = this.#assets;
    if (assets === undefined || assets.heroes.length === 0) return undefined;
    const size = assets.heroes.length;
    const hero = assets.heroes[stableIndex(agentId, size)];
    if (hero === undefined) return undefined;
    // Walking outranks working, matching the order in `PixiWorldView.animate`.
    // A character crossing the map playing `work` slides through it, which is
    // the one combination that reads as a rendering fault rather than a choice.
    if (walking) return hero.walk;
    return working ? hero.work : hero.idle;
  }

  /**
   * Releases the textures.
   *
   * Present because a Pixi texture holds GPU memory, and a client that swaps
   * scenes without this leaks one texture per zone. Not on a hot path.
   */
  destroy(): void {
    for (const texture of this.#textures.values()) texture.destroy(true);
    this.#textures.clear();
  }
}

let sharedCache: SpriteCache | undefined;

/** The cache the view uses. One per client, not one per scene. */
export function spriteCache(): SpriteCache {
  sharedCache ??= new SpriteCache();
  return sharedCache;
}

/** Drops the shared cache. For tests, and for a full teardown. */
export function resetSpriteCache(): void {
  sharedCache?.destroy();
  sharedCache = undefined;
}

/**
 * A stable 31-multiplier hash of an id.
 *
 * ONE function, because a character's colour and a character's face are chosen
 * by the same rule and must never disagree: the same agent that is red on one
 * draw has to be the same hero on the next. This arithmetic existed twice — in
 * the cache and in the view — and two copies of a hash is two chances for one
 * of them to be edited.
 *
 * Stable means stable: it must not change between builds, or every character in
 * the world changes appearance on a deploy. The multiplier and the `>>> 0` are
 * therefore fixed, and the test beside this pins a value rather than asserting
 * "deterministic", which a broken hash still satisfies.
 */
export function stableHash(id: string): number {
  let hash = 0;
  for (const character of id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}

/** An index into a list of `size`, for a given id. Stable per id. */
export function stableIndex(id: string, size: number): number {
  if (size <= 0) return 0;
  return stableHash(id) % size;
}
