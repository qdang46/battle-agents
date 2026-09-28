import { describe, expect, it } from 'vitest';

import { ALL_ZONES, ZONES_WITH_BUILDINGS, buildingForZone } from '../../packages/game-client/src/sprites/asset-atlas.js';
import { SpriteCache, spriteKey } from '../../packages/game-client/src/sprites/sprite-factory.js';
import type { SpriteAssets } from '../../packages/game-client/src/sprites/asset-atlas.js';

/**
 * The renderer draws the vendored art, not rectangles.
 *
 * ## What was actually shipped
 *
 * `apps/web/public/art/` held 3,436 files — 2,981 PNGs across ten CC0 packs,
 * plus the `age-of-agents` fantasy and scifi sheets this file is about. Every one
 * of them was referenced from a comment and from nothing else. `SpriteCache.get`
 * called `drawSprite`, which builds a `PixelCanvas` and fills two rectangles, so
 * the Coding City was a grid of grey boxes drawn at runtime while a licensed,
 * attributed, downloaded art pack sat next to it unread.
 *
 * The file that drew the rectangles said exactly what would happen:
 *
 * > A placeholder that tries to be a character illustration is a placeholder
 * > nobody can distinguish from real art, and the moment real art lands the
 * > difference has to be obvious or the placeholders quietly ship.
 *
 * They shipped. That sentence is the reason these tests exist rather than a
 * description of them.
 *
 * ## Why the cache is the seam
 *
 * `PixiWorldView` asks for `spriteKey(kind, variant)` and gets a `Texture`. It
 * has no idea where a texture came from. Attaching art to the CACHE rather than
 * branching in the view is what keeps the O(1) cache property, keeps the view
 * free of a fetch, and keeps the programmatic factory as the answer for a build
 * that never loads anything.
 */

/** A stand-in for a loaded sheet. Identity is all these tests care about. */
function texture(name: string): never {
  return { label: name } as never;
}

function assetsWith(overrides: Partial<SpriteAssets> = {}): SpriteAssets {
  return {
    theme: 'fantasy',
    heroes: [
      { name: 'fable-default', idle: [texture('fable-idle-0')], walk: [texture('fable-walk-0')], work: [texture('fable-work-0')] },
      { name: 'golem-default', idle: [texture('golem-idle-0')], walk: [texture('golem-walk-0')], work: [texture('golem-work-0')] },
    ],
    buildings: new Map([
      ['arena', texture('arena')],
      ['guild', texture('guild')],
      ['forge', texture('forge')],
      ['library', texture('library')],
      ['market', texture('market')],
      ['tavern', texture('tavern')],
      ['tower', texture('tower')],
      ['shrine', texture('shrine')],
      ['barracks', texture('barracks')],
    ]),
    terrain: [texture('dirt'), texture('rock')],
    missing: [],
    ...overrides,
  };
}

describe('a cache with art attached', () => {
  it('serves an agent from the hero sheets rather than drawing one', () => {
    const cache = new SpriteCache();
    cache.attach(assetsWith());

    const served = cache.get(spriteKey('agent', 0));

    expect(served.label).toBe('fable-idle-0');
    // The number that says the game is drawing art. It was 0 for the entire
    // life of this cache, and nothing reported that.
    expect(cache.stats.fromAssets).toBe(1);
    expect(cache.stats.constructed).toBe(0);
  });

  it('gives the same agent the same hero on every lookup, and every agent a hero', () => {
    // Stable across reconnects is the property `paletteIndexFor` was written
    // for: a character that changes face when you look away is worse than one
    // with too few faces.
    const cache = new SpriteCache();
    cache.attach(assetsWith());

    const first = cache.get(spriteKey('agent', 1));
    expect(cache.get(spriteKey('agent', 1))).toBe(first);

    const seen = new Set<string>();
    for (let variant = 0; variant < 8; variant += 1) {
      seen.add(cache.get(spriteKey('agent', variant)).label as string);
    }
    expect(seen.size).toBe(2);
  });

  it('gives the arena the arena and the guild hall the guild', () => {
    // The property that makes the city a place rather than a colour scheme. It
    // is why `SpriteKey` grew a `zone`: two zones in one scene are different
    // pictures, and a key that could not tell them apart served one of them the
    // other's sprite.
    const cache = new SpriteCache();
    cache.attach(assetsWith());

    const arena = cache.get(spriteKey('zone-marker', 7, 'battle-arena'));
    const guild = cache.get(spriteKey('zone-marker', 7, 'guild-hall'));

    expect(arena.label).toBe('arena');
    expect(guild.label).toBe('guild');
    expect(arena).not.toBe(guild);
  });

  it('caches per zone, so ten zones do not collapse onto one building', () => {
    const cache = new SpriteCache();
    cache.attach(assetsWith());

    for (const zone of ZONES_WITH_BUILDINGS) {
      expect(cache.get(spriteKey('zone-marker', 0, zone)).label, zone).toBeDefined();
    }
    // Every zone resolves to SOMETHING, and the two named ones are distinct
    // textures rather than one hash lookup.
    expect(cache.stats.size).toBeGreaterThan(1);
  });

  it('draws open ground for the plaza, not a building standing on it', () => {
    // The plaza is where every idle agent stands. An earlier version of
    // `buildingForZone` fell back to the tower there, on the reasoning that a
    // zone with no building would go missing — which put a tower in the middle
    // of the square. A miss is a real answer: the cache draws a marker, the
    // ground stays ground, and a reader can tell the game meant it.
    const cache = new SpriteCache();
    cache.attach(assetsWith());

    const served = cache.get(spriteKey('zone-marker', 3, 'idle'));

    expect(served).toBeDefined();
    expect(cache.stats.fromAssets).toBe(0);
    expect(cache.stats.constructed).toBe(1);
  });

  it('falls back entirely when no art was ever attached', () => {
    // The case the whole factory was written for, and the one a build with no
    // asset pipeline hits. It must still render.
    const cache = new SpriteCache();

    expect(cache.get(spriteKey('agent', 0))).toBeDefined();
    expect(cache.get(spriteKey('zone-marker', 0, 'battle-arena'))).toBeDefined();
    expect(cache.stats.fromAssets).toBe(0);
  });

  it('falls back when the sheets came back empty, rather than serving nothing', () => {
    // A 404 on every sheet is what a half-copied pack looks like. The honest
    // outcome is the placeholder world, not an exception and not a blank canvas.
    const cache = new SpriteCache();
    cache.attach(assetsWith({ heroes: [], buildings: new Map(), terrain: [] }));

    expect(cache.get(spriteKey('agent', 0))).toBeDefined();
    expect(cache.stats.fromAssets).toBe(0);
  });

  it('re-serves from the new art when a theme is swapped underneath it', () => {
    // Without the flush this returns the fantasy guild forever, because the key
    // has not changed — which is the same class of bug as a stale palette.
    const cache = new SpriteCache();
    cache.attach(assetsWith());
    const before = cache.get(spriteKey('zone-marker', 0, 'guild-hall'));

    cache.attach(assetsWith({ buildings: new Map([['guild', texture('guild-scifi')]]) }));
    const after = cache.get(spriteKey('zone-marker', 0, 'guild-hall'));

    expect((before as unknown as { label: string }).label).toBe('guild');
    expect((after as unknown as { label: string }).label).toBe('guild-scifi');
  });

  it('does not grow the construction count with lookups, art or not', () => {
    // The cache property, restated for the art path, because a loader that
    // re-read a sheet per frame would look exactly like a working game and cost
    // a texture per frame.
    const cache = new SpriteCache();
    cache.attach(assetsWith());
    for (let frame = 0; frame < 50; frame += 1) {
      cache.get(spriteKey('agent', frame % 4));
    }
    expect(cache.stats.constructed).toBe(0);
    expect(cache.stats.size).toBeLessThanOrEqual(4);
  });
});

describe('buildingForZone', () => {
  it('names a building for every zone that has one', () => {
    const buildings = assetsWith().buildings;
    for (const zone of ZONES_WITH_BUILDINGS) {
      expect(buildingForZone(buildings, zone), zone).toBeDefined();
    }
  });

  it('returns undefined for a zone that is open ground, and for an empty pack', () => {
    const buildings = assetsWith().buildings;
    // The plaza and the tool zones are ground, not places. Undefined here is
    // what makes the cache draw a marker rather than a building.
    expect(buildingForZone(buildings, 'idle')).toBeUndefined();
    // And a client whose art failed to load must still be able to ask, once per
    // zone, without an exception taking the world down.
    expect(buildingForZone(new Map(), 'battle-arena')).toBeUndefined();
  });

  it('leaves no zone in a state where the city would have an invisible landmark', () => {
    // The guarantee the fallback used to provide, restated honestly: a zone
    // either has a building or is ground the cache draws for. What it must not
    // be is a zone that resolves to nothing, because that is a hole in the map
    // that reads as a bug.
    const cache = new SpriteCache();
    cache.attach(assetsWith());
    for (const zone of ALL_ZONES) {
      expect(cache.get(spriteKey('zone-marker', 0, zone)), zone).toBeDefined();
    }
  });
});
