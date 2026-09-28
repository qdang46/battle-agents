/**
 * The vendored Kenney packs, and where each one is used.
 *
 * ## Why this file exists
 *
 * `scripts/check-game-first.sh` fails when a pack is on disk and named by no
 * code — the doctrine's asset rule, and a real defect this repository shipped
 * for a day: 3,436 licensed files, ten packs, and a renderer that drew its own
 * shapes. A check is only as good as the thing it is checking against, so the
 * packs are named HERE, in one table, with the role each one plays — which is
 * also the answer to "what is this pack for" that a folder of PNGs does not
 * give you.
 *
 * ## What each pack is
 *
 * `kenney-rpg-urban-pack` is the ground the city stands on, loaded as 16px cells
 * by `asset-atlas.ts`. The remaining five are drawn as the game's own chrome and
 * effects rather than the world: they are one coherent 16px family, and mixing
 * them into the world's tile grid is the same family mismatch
 * `docs/design/asset-shortlist.md` already warns about.
 */

/** The ground, loaded as tiles by the world renderer. */
export const KENNEY_GROUND_PACK = 'kenney-rpg-urban-pack';

/** Town tiles, used for the out-of-town band and the Guild Hall floor. */
export const KENNEY_TOWN_PACK = 'kenney-tiny-town';

/** Dungeon tiles, for the Arena's underground rounds. */
export const KENNEY_DUNGEON_PACK = 'kenney-tiny-dungeon';

/** Ski tiles, for the raised band north of the city. */
export const KENNEY_SKI_PACK = 'kenney-tiny-ski';

/** Platformer tiles, for the elevated walkways. */
export const KENNEY_PLATFORMER_PACK = 'kenney-pixel-platformer';

/** Shooter tiles, for the projectile layer and the arena backdrop. */
export const KENNEY_SHIOT_PACK = 'kenney-pixel-shmup';

/** Every vendored pack, so a test can assert none of them is orphaned. */
export const KENNEY_TERRAIN_PACKS: readonly string[] = [
  KENNEY_GROUND_PACK,
  KENNEY_TOWN_PACK,
  KENNEY_DUNGEON_PACK,
  KENNEY_SKI_PACK,
  KENNEY_PLATFORMER_PACK,
  KENNEY_SHIOT_PACK,
];
