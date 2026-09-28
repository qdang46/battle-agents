/**
 * The vendored art, loaded.
 *
 * ## What this is for
 *
 * The 3,436 files under `apps/web/public/art/` sat on disk, licensed, recorded
 * in `THIRD-PARTY-NOTICES.md` and referenced only from comments. The renderer
 * drew rectangles out of `PixelCanvas` instead, and the file that drew them said
 * why that was acceptable:
 *
 * > A placeholder that tries to be a character illustration is a placeholder
 * > nobody can distinguish from real art, and the moment real art lands the
 * > difference has to be obvious or the placeholders quietly ship.
 *
 * The placeholders shipped. That is the whole reason this module exists, and the
 * reason the art it loads is plan §28.1 item 6 — the `age-of-agents` `fantasy` and
 * `scifi` packs, which are MIT *including their art*, and whose building names
 * already match DESIGN.md §4's Coding City: `guild` is the Guild Hall, `library`
 * the Research Lab, `forge` the Workshop, `market` the Bounty Board, `arena` the
 * Arena.
 *
 * ## The sheets come with their own manifests
 *
 * Each PNG has a TexturePacker JSON beside it — for the animated ones — so a
 * frame is LOOKED UP by name rather than computed from a frame count somebody
 * typed. The single-frame buildings have no manifest because they need none, and
 * `buildingIds` is the pack's own `index.json` rather than a list kept here,
 * which is the same reason: adding a building to the pack adds it to the city.
 *
 * ## Failure is a fallback, not a throw
 *
 * A missing sheet, an unreadable manifest or a 404 leaves the programmatic
 * factory in charge. The client must still render, because a client that renders
 * nothing tells a developer nothing, and the one thing a broken asset path must
 * not do is take the game down with it. `loadSpriteAssets` therefore resolves
 * with whatever it managed to read and records what it did not, so the caller
 * can say so rather than discovering it as an empty city.
 */
import { Assets, Rectangle, Texture } from 'pixi.js';

import { ZONE_PLACEMENT } from '../zones.js';
import type { ZoneId } from '@battle-agents/protocol';

/** Where the pack lives, relative to the app root. */
export const ART_BASE = '/art/age-of-agents';

/** The two themes §28.1 item 6 vendors. */
export type ArtTheme = 'fantasy' | 'scifi';

export interface HeroSheet {
  readonly name: string;
  /** Idle frames, in order. Four per hero in the vendored pack. */
  readonly idle: readonly Texture[];
  /** Six frames. A character that is somewhere it is not standing still. */
  readonly walk: readonly Texture[];
  /**
   * Nine frames, and the reason this is animation rather than decoration.
   *
   * The pack ships a `work` animation per hero, and the game already knows the
   * difference between an agent doing something and an agent idle — `AgentView`
   * carries the tool. So the frames the game plays are chosen by the same state
   * that chooses a zone: an agent with a tool works, and one without breathes.
   */
  readonly work: readonly Texture[];
}

/** The animations a hero sheet carries, in the order they are preferred. */
const ANIMATIONS = ['idle', 'walk', 'work'] as const;

export interface SpriteAssets {
  readonly theme: ArtTheme;
  readonly heroes: readonly HeroSheet[];
  /** By building id — `guild`, `arena`, `forge`, and so on. */
  readonly buildings: ReadonlyMap<string, Texture>;
  /** Ground tiles, in sheet order. */
  readonly terrain: readonly Texture[];
  /** Ids that were named but could not be loaded. */
  readonly missing: readonly string[];
}

/** Buildings the Coding City is drawn from, and the zone each one stands on. */
const ZONE_BUILDING: Readonly<Record<string, string>> = {
  'battle-arena': 'arena',
  'guild-hall': 'guild',
  thinking: 'library',
  files: 'forge',
  'bounty-board': 'market',
  messaging: 'tavern',
  terminal: 'tower',
  search: 'shrine',
  spawn: 'barracks',
};

/** Terrain, in the order the client walks it. Named here, not discovered. */
const TERRAIN_IDS: readonly string[] = ['dirt', 'rock', 'water'];

/**
 * A Kenney tileset, loaded as a grid of 16px tiles.
 *
 * The age-of-agents terrain sheets are TexturePacker JSON; the Kenney ones are a
 * plain PNG at an exact tile size, measured from the file rather than assumed
 * (`kenney-rpg-urban-pack` is 432x288 = 27x18 tiles of 16). Splitting the sheet
 * here rather than handing the client a 432px image is what makes it a GROUND
 * the city stands on rather than a picture of one.
 */
async function loadKenneyTerrain(
  url: string,
  tilePx: number,
): Promise<readonly Texture[] | undefined> {
  try {
    const sheet = await Assets.load<Texture>(url);
    const tiles: Texture[] = [];
    for (let gy = 0; gy * tilePx < Math.floor(sheet.height); gy += 1) {
      for (let gx = 0; gx * tilePx < Math.floor(sheet.width); gx += 1) {
        tiles.push(
          new Texture({
            source: sheet.source,
            frame: new Rectangle(gx * tilePx, gy * tilePx, tilePx, tilePx),
          }),
        );
      }
    }
    return tiles;
  } catch {
    return undefined;
  }
}

interface RawSheet {
  readonly textures?: Readonly<Record<string, Texture>>;
}

/**
 * The frames of a sheet whose manifest NAME carries this animation.
 *
 * TexturePacker names them `<sheet>__<animation>_<nn>` — `fable-default__idle_00`
 * — and Pixi's spritesheet parser keys the loaded textures by exactly that. So
 * the animation is a filter on the KEY, which is why this reads the record
 * rather than the texture list: an earlier version went looking for the names
 * inside `texture.source.data.frames`, which is not a thing Pixi exposes, and
 * would have silently fallen through to "whichever frames sort first" — an
 * animation named idle that is really somebody walking.
 */
function framesOf(loaded: unknown, animation?: string): readonly Texture[] {
  const sheet = loaded as RawSheet;
  if (sheet.textures === undefined) return [];
  const entries = Object.entries(sheet.textures);
  if (animation === undefined) return entries.map(([, texture]) => texture);
  const suffix = `__${animation}_`;
  const matching = entries.filter(([name]) => name.includes(suffix));
  // An animation the sheet does not carry yields the whole sheet rather than
  // nothing: a hero with no idle frames is a hero that cannot be drawn, and the
  // first frame of the sheet is a better answer than no sprite at all.
  const chosen = matching.length > 0 ? matching : entries;
  return chosen.map(([, texture]) => texture);
}

async function loadOne(path: string, animation?: string): Promise<readonly Texture[] | undefined> {
  try {
    return framesOf(await Assets.load(`${path}.json`), animation);
  } catch {
    return undefined;
  }
}

/** Loads one PNG as a single texture — the path for the manifest-less buildings. */
async function loadTexture(path: string): Promise<Texture | undefined> {
  try {
    return await Assets.load<Texture>(path);
  } catch {
    return undefined;
  }
}

export interface LoadSpriteAssetsOptions {
  readonly theme?: ArtTheme;
  /** Prepended to every path. Set it when the app is served under a sub-path. */
  readonly baseUrl?: string;
}

/**
 * Loads the pack, or as much of it as answers.
 *
 * Never throws. Every sheet is loaded independently and a failure is recorded in
 * `missing`, because the alternative — refusing to start the world because one
 * building 404s — trades a small hole for a blank screen.
 */
export async function loadSpriteAssets(
  options: LoadSpriteAssetsOptions = {},
): Promise<SpriteAssets> {
  const theme = options.theme ?? 'fantasy';
  const root = `${options.baseUrl ?? ''}${ART_BASE}/${theme}`;
  const missing: string[] = [];

  const buildingIds = await loadBuildingIds(root, missing);
  const heroes = await loadHeroes(root, missing);
  const terrain = await loadTerrain(root, missing);

  const buildings = new Map<string, Texture>();
  await Promise.all(
    buildingIds.map(async (id) => {
      // Manifest first: an animated building is a spritesheet and loading the PNG
      // alone would give one frame stretched across a sheet.
      const sheet = await loadOne(`${root}/buildings/${id}`);
      const first = sheet?.[0];
      if (first !== undefined) {
        buildings.set(id, first);
        return;
      }
      const single = await loadTexture(`${root}/buildings/${id}.png`);
      if (single === undefined) missing.push(`buildings/${id}`);
      else buildings.set(id, single);
    }),
  );

  return { theme, heroes, buildings, terrain, missing };
}

/**
 * The building ids, from the pack's own `index.json`.
 *
 * Read rather than hardcoded so a building added upstream is a building in the
 * city. A list kept in this file is a list that drifts from the art next to it.
 */
async function loadBuildingIds(root: string, missing: string[]): Promise<readonly string[]> {
  try {
    const index = await Assets.load<{ readonly ids?: readonly string[] }>(
      `${root}/buildings/index.json`,
    );
    if (index.ids !== undefined && index.ids.length > 0) return index.ids;
  } catch {
    // Fall through: the fallback below is the pack as vendored, not an error.
  }
  missing.push('buildings/index.json');
  return ['arena', 'barracks', 'citadel', 'forge', 'guild', 'library', 'market', 'mine', 'shrine', 'tavern', 'tower'];
}

async function loadHeroes(root: string, missing: string[]): Promise<readonly HeroSheet[]> {
  const names = [
    'fable-default',
    'familiar-default',
    'golem-default',
    'haiku-default',
    'local-default',
    'opus-default',
    'oracle-default',
    'sonnet-default',
  ];
  const loaded = await Promise.all(
    names.map(async (name) => {
      // Every animation, in one load pass. A hero missing one animation is
      // still a hero — the cache falls back down the list — so an absent
      // animation is a shorter cycle, not a hole in the world.
      const byAnimation = await Promise.all(
        ANIMATIONS.map((animation) => loadOne(`${root}/heroes/${name}`, animation)),
      );
      const idle = byAnimation[0] ?? [];
      if (idle.length === 0) {
        missing.push(`heroes/${name}`);
        return undefined;
      }
      return {
        name,
        idle,
        walk: byAnimation[1] ?? idle,
        work: byAnimation[2] ?? byAnimation[1] ?? idle,
      } satisfies HeroSheet;
    }),
  );
  return loaded.filter((hero): hero is HeroSheet => hero !== undefined) as readonly HeroSheet[];
}

async function loadTerrain(root: string, missing: string[]): Promise<readonly Texture[]> {
  const sheets = await Promise.all(TERRAIN_IDS.map((id) => loadOne(`${root}/tilemap/${id}`)));
  sheets.forEach((frames, index) => {
    if (frames === undefined || frames.length === 0) missing.push(`tilemap/${TERRAIN_IDS[index]}`);
  });
  const fromPacker = sheets.flatMap((frames) => frames ?? []);

  // The Kenney tilesets, which are the actual GROUND. The age-of-agents sheets
  // are three large framed tiles; these are 16px cells that tile, and a city
  // whose floor is three repeated 256px textures is a backdrop rather than a
  // place. The urban pack is the largest (27x18 cells) and reads as a city
  // street, which is what a Coding City is.
  const kenney = await loadKenneyTerrain(
    '/art/kenney-rpg-urban-pack/Tilemap/tilemap_packed.png',
    16,
  );
  if (kenney === undefined || kenney.length === 0) {
    missing.push('kenney-rpg-urban-pack/Tilemap/tilemap_packed.png');
    return fromPacker;
  }
  return [...fromPacker, ...kenney];
}

/**
 * The building a zone stands on, or undefined when this pack has none for it.
 *
 * Undefined is a real answer and the caller draws a marker instead. The first
 * version fell back to the tower, on the reasoning that a zone with no building
 * would otherwise go missing — and that put a tower on the PLAZA, which every
 * idle agent in the world stands on. Open ground with a monument on it reads as
 * a building the designer chose; open ground reads as open ground, and a reader
 * can tell which one the game meant.
 */
export function buildingForZone(
  buildings: ReadonlyMap<string, Texture>,
  zone: ZoneId,
): Texture | undefined {
  const id = ZONE_BUILDING[zone];
  return id === undefined ? undefined : buildings.get(id);
}

/** The zones this pack can draw a building for, for a test to walk. */
export const ZONES_WITH_BUILDINGS: readonly ZoneId[] = Object.keys(
  ZONE_BUILDING,
) as ZoneId[];

/** Every placeable zone, so a test can assert none of them is left unbuilt. */
export const ALL_ZONES: readonly ZoneId[] = Object.keys(ZONE_PLACEMENT) as ZoneId[];
