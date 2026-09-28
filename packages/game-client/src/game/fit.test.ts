import { describe, expect, it } from 'vitest';

import { PixiWorldView } from './view.js';
import { placementFor, ZONE_PLACEMENT } from '../zones.js';
import type { ZoneId } from '@battle-agents/protocol';
import { TILE_WORLD_PX } from '../sprites/sprite-factory.js';
import { WorldStore } from '../state/store.js';
import { ARENA, CITY, GUILD_HALL, SCENES, type SceneConfig } from '../scenes/scene-config.js';

/**
 * The camera, proven as arithmetic rather than as pixels.
 *
 * ## What was actually wrong
 *
 * Measured in a running browser against a real session: the canvas was 1230x458,
 * an idle agent's sprite sat at world pixel (864, 864), it had a valid 16x16
 * texture, `visible: true`, the right parent and the right scale — and it was
 * 400px below the bottom of the picture. `topdown(48)` maps the 32x32 grid to
 * 1536 square pixels and nothing ever scaled that to the viewport, so the middle
 * of the map was simply off-screen.
 *
 * A screenshot cannot be the assertion for this. It failed as one: a
 * headless context that has lost its drawing buffer shows the same empty canvas
 * whether the transform is right or wrong, which is how a correct fix gets
 * reverted for looking like a regression. The property here is a transform, so
 * the test is a transform.
 */

/** The world-space pixel of a placement, straight from the projection's own rule. */
function worldOf(zone: ZoneId): { x: number; y: number } {
  const placement = placementFor(zone);
  return { x: placement.gx * TILE_WORLD_PX, y: placement.gy * TILE_WORLD_PX };
}

/** The zones a scene actually draws, read off the table the view reads. */
function zonesIn(scene: SceneConfig): ZoneId[] {
  return (Object.keys(ZONE_PLACEMENT) as ZoneId[]).filter(
    (zone) => ZONE_PLACEMENT[zone].scene === scene.id,
  );
}

function aView(scene: SceneConfig = CITY): PixiWorldView {
  return new PixiWorldView({ store: new WorldStore(), scene });
}

/** Where a world pixel lands on screen, through the view's own transform. */
function screenOf(view: PixiWorldView, world: { x: number; y: number }) {
  const root = view.root;
  return {
    x: world.x * root.scale.x + root.x,
    y: world.y * root.scale.y + root.y,
  };
}

const VIEWPORT = { width: 1230, height: 458 };

describe('fitting the city to the viewport', () => {
  it('brings a placement that was off-screen inside it', () => {
    // The failing case, as a number: idle is grid (18,18), which is 864px down
    // in a 458px canvas. Nothing rendered it.
    const view = aView();
    view.fit(VIEWPORT.width, VIEWPORT.height);

    const point = screenOf(view, worldOf('idle'));

    expect(point.x).toBeGreaterThanOrEqual(0);
    expect(point.x).toBeLessThanOrEqual(VIEWPORT.width);
    expect(point.y).toBeGreaterThanOrEqual(0);
    expect(point.y).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('brings EVERY placed zone inside it, not just the one that was reported', () => {
    // The reported symptom was one agent; the defect is the whole map, and a
    // fix aimed at the one placement would leave `battle-arena` off-screen.
    const view = aView();
    view.fit(VIEWPORT.width, VIEWPORT.height);

    // Driven off the placement TABLE rather than a hand-written list, for the
    // reason view.ts gives: a zone added to the table must appear without a
    // change here, and a list here would be a second copy that drifts.
    //
    // Scoped to the city, which is the change this test records: the table
    // covers all three scenes, and a zone belonging to the arena is not on the
    // city map to be brought into view.
    for (const zone of zonesIn(CITY)) {
      const point = screenOf(view, worldOf(zone));
      expect(
        point.x >= 0 && point.x <= VIEWPORT.width && point.y >= 0 && point.y <= VIEWPORT.height,
        `${zone} lands at (${Math.round(point.x)}, ${Math.round(point.y)}), outside ${VIEWPORT.width}x${VIEWPORT.height}`,
      ).toBe(true);
    }
  });

  it('fits EVERY scene, not only the city the first bug was found on', () => {
    // The defect this whole change exists for was that the view ignored its
    // scene, so the arena and the guild hall were drawn on a 32-wide city grid.
    // The city is the scene that bug was REPORTED against, which is exactly why
    // the other two need their own assertion: nothing in the original suite
    // would have gone red if only they were broken.
    for (const scene of SCENES) {
      const zones = zonesIn(scene);
      expect(zones.length, `${scene.id} has no zones in the placement table`).toBeGreaterThan(0);

      const view = aView(scene);
      view.fit(VIEWPORT.width, VIEWPORT.height);

      for (const zone of zones) {
        const point = screenOf(view, worldOf(zone));
        expect(
          point.x >= 0 &&
            point.x <= VIEWPORT.width &&
            point.y >= 0 &&
            point.y <= VIEWPORT.height,
          `${scene.id}/${zone} lands at (${Math.round(point.x)}, ${Math.round(point.y)}), outside ${VIEWPORT.width}x${VIEWPORT.height}`,
        ).toBe(true);
      }
    }
  });

  it('draws only its own zones, so the arena is not the city with an extra marker', () => {
    // The property the two routes actually differ by. Counting children rather
    // than comparing pictures: the arena has one zone and the city has ten, and
    // a view that drew the whole table made them identical.
    const city = aView(CITY);
    const arena = aView(ARENA);
    const guild = aView(GUILD_HALL);

    expect(arena.zoneLayer.children.length).toBe(zonesIn(ARENA).length);
    expect(arena.zoneLayer.children.length).toBeLessThan(city.zoneLayer.children.length);
    expect(guild.zoneLayer.children.length).toBe(zonesIn(GUILD_HALL).length);
    expect(guild.zoneLayer.children.length).toBeLessThan(city.zoneLayer.children.length);
  });

  it('scales uniformly, so a round sprite stays round', () => {
    // A non-uniform "fit" would fill the screen and squash every character into
    // an ellipse. Uniform is the whole reason `min` is used rather than two
    // independent ratios.
    const view = aView();
    view.fit(VIEWPORT.width, VIEWPORT.height);

    const { x, y } = view.root.scale;
    expect(x).toBeCloseTo(y, 10);
  });

  it('centres, so the map is not pinned to a corner', () => {
    const view = aView();
    view.fit(VIEWPORT.width, VIEWPORT.height);

    const worldPx = CITY.w * TILE_WORLD_PX * view.root.scale.x;
    expect(view.root.x).toBeCloseTo((VIEWPORT.width - worldPx) / 2, 6);
    expect(view.root.y).toBeCloseTo((VIEWPORT.height - worldPx) / 2, 6);
  });

  it('does nothing for a zero-sized viewport instead of scaling the world away', () => {
    // The first layout pass has no size, and a scale of zero leaves the world
    // invisible until something refits it. Skipping is the honest answer.
    const view = aView();

    view.fit(0, 0);
    expect(view.root.scale.x).toBe(1);

    view.fit(-5, 100);
    expect(view.root.scale.x).toBe(1);
  });

  it('refits when the viewport changes, rather than fitting once and staying wrong', () => {
    // The page resizes its canvas to its container, so a single fit at mount is
    // correct only until the window moves.
    const view = aView();
    view.fit(600, 300);
    const small = view.root.scale.x;
    view.fit(1200, 900);
    const large = view.root.scale.x;

    expect(large).toBeGreaterThan(small);
  });

  it('leaves the node count alone — this is a camera, not a scene change', () => {
    // The cost boundary the whole view design rests on: a fit must not walk the
    // scene. Nothing is added, removed or re-created.
    const view = aView();
    const before = view.nodeCount;
    const layersBefore = view.root.children.length;

    view.fit(VIEWPORT.width, VIEWPORT.height);

    expect(view.nodeCount).toBe(before);
    // The layer COUNT is not a fixed number and stopped being one when the sky
    // wash was added beneath the zones. What a camera must not do is CHANGE it,
    // and that is what this asserts now.
    expect(view.root.children.length).toBe(layersBefore);
  });
});
