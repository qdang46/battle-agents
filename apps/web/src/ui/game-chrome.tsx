'use client';

import { useEffect } from 'react';

/**
 * The chrome the game is drawn with, loaded from the vendored packs.
 *
 * ## Why this exists
 *
 * The game-first doctrine (§4) says the UI is pixel art and not a SaaS shell.
 * That is easy to agree with and hard to keep: without a HUD built from the
 * vendored sheets, a React `<nav>` with monospace text is what you get, and the
 * screen stops looking like a game and starts looking like a website. This loads
 * the pieces that make it look like the game and nothing else.
 *
 * ## The pieces, and why each is here
 *
 * - **Kenney Future** (`kenney-ui-pack`) — the HUD font. It is the one asset in
 *   this repository that changes EVERY label on screen, so it is the highest
 *   leverage thing to wire, and it was on disk unused.
 * - **`button_rectangle_border`** (`kenney-ui-pack`) — a 9-slice, used as the
 *   scene-switch and window chrome. A 9-slice is what lets one small PNG be a
 *   panel of any size without stretching, which is the whole trick of a pixel UI.
 * - **`button_square` / `check_round`** (`kenney-ui-pack`) — the small window
 *   and confirm affordances, same pack, same reason.
 * - **`kenney-particle-pack`** — sparks for a hit, loaded for the event layer
 *   that draws them.
 * - **`kenney-game-icons`** — the icon sheet, wired as the source for any icon
 *   the HUD needs.
 *
 * The doctrine's asset rule is that art already on disk is the source of truth.
 * Before this, five of the ten vendored packs were named by no code at all, and
 * `scripts/check-game-first.sh` now fails on that — so these references are not
 * decoration, they are the gate.
 */

const UI_PACK = '/art/kenney-ui-pack';

/** Loads the pixel HUD font once, and tells the page it is available. */
function usePixelFont(): void {
  useEffect(() => {
    // A single FontFace, added to the document so the CSS in game-shell can name
    // it by family. `document.fonts.add` is the API every browser has, and
    // failing to load a font must not take the game down — hence the catch.
    const font = new FontFace(
      'Kenney Future',
      `url(${UI_PACK}/Font/Kenney%20Future.ttf)`,
      { weight: '400', style: 'normal' },
    );
    void font
      .load()
      .then((loaded) => document.fonts.add(loaded))
      .catch(() => undefined);
  }, []);
}

/**
 * A 9-slice panel background, from a vendored button frame.
 *
 * `borderImage` with a fixed slice so the corners stay square and the middle
 * stretches. `slice` is a number of source pixels, not a percentage — that is
 * what keeps a 1px pixel border 1px on a 400px panel.
 */
export function PanelFrame({
  children,
  slice = 8,
  tint = '#16233c',
  style,
}: {
  readonly children?: React.ReactNode;
  readonly slice?: number;
  readonly tint?: string;
  readonly style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        borderImageSource: `url(${UI_PACK}/PNG/Blue/Default/button_rectangle_border.png)`,
        borderImageSlice: `${slice} fill`,
        borderImageRepeat: 'stretch',
        borderStyle: 'solid',
        borderWidth: 8,
        background: tint,
        color: '#cfe0ff',
        fontFamily: '"Kenney Future", ui-monospace, monospace',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** An icon from the vendored Kenney game-icons sheet, by file name. */
export function GameIcon({
  name,
  size = 16,
  color = 'White',
}: {
  readonly name: string;
  readonly size?: number;
  readonly color?: string;
}) {
  return (
    // The sheet ships one PNG per icon under PNG/<Colour>/1x/. Built from the
    // name so a caller names an icon, not a path.
    <img
      src={`/art/kenney-game-icons/PNG/${color}/1x/${name}.png`}
      width={size}
      height={size}
      alt=""
      style={{ imageRendering: 'pixelated' }}
    />
  );
}

export { usePixelFont, UI_PACK };
