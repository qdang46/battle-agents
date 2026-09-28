import { describe, expect, it } from 'vitest';

import {
  PLACEHOLDER_TILE_PX,
  PLACEHOLDER_SCALE,
  REAL_ASSET_SCALE,
  SpriteCache,
  TILE_SOURCE_PX,
  TILE_WORLD_PX,
  stableHash,
  stableIndex,
  spriteCache,
  spriteKey,
} from './sprite-factory.js';

/**
 * The two grids are different, and the test that pins it is the reason the
 * constants are named. docs/design/asset-shortlist.md records a row that claimed
 * "16×16 fantasy pixel" because plan §25 says "16x16@3x placeholders", and the
 * claim was wrong: the pack is 64px. This asserts the two are still distinct, so
 * the same conflation cannot come back through a different door.
 */
describe('the two tile grids', () => {
  it('keeps the placeholder grid at 16 and the real asset grid at 64', () => {
    expect(PLACEHOLDER_TILE_PX).toBe(16);
    expect(PLACEHOLDER_SCALE).toBe(3);
    expect(TILE_WORLD_PX).toBe(48);
    expect(TILE_SOURCE_PX).toBe(64);
    expect(TILE_SOURCE_PX).not.toBe(PLACEHOLDER_TILE_PX);
  });

  it('records that scaling a real sheet into the world is NOT an integer', () => {
    // 48/64 = 0.75. An integer would let a real pack stay pixel-crisp; this one
    // resamples, and that is a cost the constant makes visible rather than hides.
    expect(REAL_ASSET_SCALE).toBe(0.75);
    expect(Number.isInteger(REAL_ASSET_SCALE)).toBe(false);
  });
});

describe('SpriteCache is a cache', () => {
  it('returns the same object identity for two lookups of one key', () => {
    const cache = new SpriteCache();
    const first = cache.get(spriteKey('agent', 3));
    const second = cache.get(spriteKey('agent', 3));
    // Identity, not equality: a cache that rebuilt a texture and compared it
    // equal would pass a `toEqual` and still cost the whole construction per
    // frame, which is the entire failure this assertion exists to catch.
    expect(first).toBe(second);
  });

  it('constructs one texture per key no matter how many lookups arrive', () => {
    const cache = new SpriteCache();
    for (let i = 0; i < 1000; i += 1) {
      cache.get(spriteKey('agent', 1));
      cache.get(spriteKey('agent', 2));
      cache.get(spriteKey('building', 1));
    }
    const stats = cache.stats;
    expect(stats.lookups).toBe(3000);
    expect(stats.constructed).toBe(3);
    expect(stats.size).toBe(3);
  });

  it('does not grow its construction count as frames are drawn', () => {
    // The frames are simulated by repeated lookups, which is what a renderer
    // does per agent per frame. The property under test is that construction is
    // a function of KEYS, not of frames.
    const cache = new SpriteCache();
    const frames = 500;
    for (let frame = 0; frame < frames; frame += 1) {
      for (let agent = 0; agent < 8; agent += 1) {
        cache.get(spriteKey('agent', agent));
      }
    }
    expect(cache.stats.constructed).toBe(8);
    expect(cache.stats.lookups).toBe(frames * 8);
  });

  it('keeps distinct kinds apart', () => {
    const cache = new SpriteCache();
    expect(cache.get(spriteKey('agent', 1))).not.toBe(cache.get(spriteKey('building', 1)));
    expect(cache.stats.size).toBe(2);
  });

  it('wraps a same variant around rather than running off the index', () => {
    const cache = new SpriteCache();
    // 8 palette entries, so variant 8 and variant 0 are the same picture and
    // must be the same cached object rather than an undefined colour.
    expect(cache.get(spriteKey('agent', 8))).toBe(cache.get(spriteKey('agent', 0)));
  });

  it('builds a 16x16 texture', () => {
    const cache = new SpriteCache();
    const texture = cache.get(spriteKey('agent', 0));
    expect(texture.width).toBe(PLACEHOLDER_TILE_PX);
    expect(texture.height).toBe(PLACEHOLDER_TILE_PX);
  });
});

describe('the texture a sprite is built from', () => {
  it('is a BUFFER source, because a plain TextureSource uploads nothing', () => {
    // The property that was wrong, and every other property was right: the
    // texture reported a valid 16x16 size, a valid resource, and rendered as a
    // transparent rectangle. `renderer.extract` on the unit layer returned 48x48
    // bounds with ZERO opaque pixels and one colour (black) while the sprite was
    // in the tree, correctly parented, correctly positioned and correctly
    // scaled.
    //
    // A plain `TextureSource` has no `uploadMethodId`, so the renderer's bind
    // group has no way to put a raw typed array on the GPU. `BufferImageSource`
    // is the subclass that carries `uploadMethodId: 'buffer'` and this is the
    // only assertion here that would have caught it -- the size, the parent,
    // the alpha and the position were all correct and all invisible to it.
    const texture = spriteCache().get(spriteKey('agent', 1));
    const source = texture.source as unknown as { uploadMethodId?: string };

    expect(source.uploadMethodId).toBe('buffer');
  });

  it('states rgba8unorm rather than letting it be inferred as bgra', () => {
    // `BufferImageSource` infers `bgra8unorm` for a Uint8ClampedArray that
    // does not name a format, which is a sprite that renders in the wrong
    // colours rather than one that fails loudly.
    const texture = spriteCache().get(spriteKey('agent', 1));

    expect(texture.source.format).toBe('rgba8unorm');
  });
  it('pins the hash to VALUES, not merely to being deterministic', () => {
    // A character's colour and a character's face come from this one function,
    // so a change to it silently restyles every character in the world. Asserting
    // 'the same input gives the same output' is satisfied by a hash that returns
    // 0 for everything, so these are the actual numbers.
    expect(stableHash('')).toBe(0);
    expect(stableHash('a')).toBe(97);
    expect(stableHash('agent-1')).toBe(stableHash('agent-1'));
    expect(stableHash('agent-1')).not.toBe(stableHash('agent-2'));
    expect(stableIndex('agent-1', 8)).toBeGreaterThanOrEqual(0);
    expect(stableIndex('agent-1', 8)).toBeLessThan(8);
    // Zero is a real list size here, and it must not divide by zero.
    expect(stableIndex('agent-1', 0)).toBe(0);
  });
});
