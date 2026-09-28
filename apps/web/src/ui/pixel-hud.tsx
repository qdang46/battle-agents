'use client';

import { CITY, ARENA, GUILD_HALL, type SceneConfig, type SceneId } from '@battle-agents/game-client';

import { GameIcon } from './game-chrome.js';

/**
 * The scene switcher, drawn as a game HUD.
 *
 * ## Why this is not a tab strip
 *
 * It was four `<button>`s in a row with a border, which is a browser tab bar
 * wearing a game's colours, and the two look the same from across a room: a
 * horizontal list of equal rectangles with text in them. Every one of those
 * properties is web. A game's navigation is not a row of equal rectangles.
 *
 * So this is a set of PLATES — distinct shapes, a distinct icon each, a distinct
 * silhouette — hung along the top-left of the screen the way a game hangs its
 * quick-travel icons, plus a number key on each. The number is the part that
 * matters: it is how you move between places in a game, and a key that does
 * something is not a tab.
 *
 * ## Why the icons differ
 *
 * Three identical circles in a row is a segmented control. The shapes and the
 * glyphs are different on purpose, so the three are told apart by silhouette
 * before they are read — which is what lets someone who cannot read the labels
 * still travel, and what makes the row read as a set of places rather than a
 * set of links.
 */

/** A travel plate: icon, name, and the key that goes there. */
interface Plate {
  readonly scene: SceneConfig;
  /** The key that travels here. Number row, because a game uses a number row. */
  readonly key: string;
  /** A distinct glyph per place, from the vendored icon sheet. */
  readonly icon: string;
  /** The tint, so the three are separable at a glance and when colour is off. */
  readonly tint: string;
}

/**
 * The three plates, and why these icons.
 *
 * The names are ones that EXIST in `kenney-game-icons` — the sheet has 105 and
 * no `sword`, no `shield` and no `city`. A first version guessed those, and a
 * guessed icon is a 404: the plate renders with a broken image in it, which is
 * the game failing at exactly the point it is trying to look finished.
 *
 * So: `home` is a place you live, `target` is a thing you aim at, `trophy` is
 * something a hall of fame is for. They are also three different shapes, which
 * is the property that makes the row readable without reading it.
 */
const PLATES: readonly Plate[] = [
  { scene: CITY, key: '1', icon: 'home', tint: '#5b8dd6' },
  { scene: ARENA, key: '2', icon: 'target', tint: '#c85b5b' },
  { scene: GUILD_HALL, key: '3', icon: 'trophy', tint: '#c9a227' },
];

/** Where each glyph lives, if the guessed name is not in the sheet. */
const ICON_FALLBACK = 'star';

export function ScenePlates({
  current,
  onTravel,
}: {
  readonly current: SceneId;
  readonly onTravel: (id: SceneId) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: '0.5rem',
        alignItems: 'flex-start',
      }}
    >
      {PLATES.map((plate) => {
        const here = plate.scene.id === current;
        return (
          <button
            key={plate.scene.id}
            type="button"
            onClick={() => onTravel(plate.scene.id)}
            aria-pressed={here}
            title={`${plate.scene.label} (${plate.key})`}
            style={{
              // A PLATE, not a tab: the active one is a raised tile with a lit
              // edge, the inactive ones are sunk. A row of equal rectangles
              // reads as tabs; tiles at two depths read as places.
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '0.15rem',
              width: '4.4rem',
              padding: '0.35rem 0.25rem 0.3rem',
              appearance: 'none',
              font: 'inherit',
              cursor: 'pointer',
              color: here ? '#ffffff' : '#8b93a7',
              // The "sunken" state for everywhere you are not, and the "raised"
              // one for where you are. Two depths, not two colours.
              background: here
                ? 'linear-gradient(180deg, #1e2c47 0%, #16233c 100%)'
                : 'linear-gradient(180deg, #0d1119 0%, #141a26 100%)',
              border: `1px solid ${here ? plate.tint : '#232a3a'}`,
              borderTop: here ? `2px solid ${plate.tint}` : '1px solid #1b2230',
              boxShadow: here
                ? `0 0 0 1px ${plate.tint}44, 0 0 12px ${plate.tint}33`
                : 'inset 0 1px 0 #0a0e15',
              imageRendering: 'pixelated',
            }}
          >
            <GameIcon name={plate.icon} color="White" size={20} />
            <span style={{ fontSize: '0.6rem', letterSpacing: '0.06em' }}>{plate.key}</span>
            <span style={{ fontSize: '0.58rem', opacity: here ? 1 : 0.75 }}>{plate.scene.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export { ICON_FALLBACK, PLATES };
