/**
 * The colour of the light, as a function of how long the world has been running.
 *
 * ## What this is
 *
 * One overlay colour that walks a fixed curve over the clock, so the city is not
 * lit identically at 03:00 and at noon. The idea is ported from
 * `agent-world-smallville`'s `updateDayNight(hour)` in
 * `environment/frontend_server/static_dirs/viewer.html` (Apache-2.0,
 * https://github.com/sbenodiz/agent-world, revision 13d62dbdeeca; recorded in
 * THIRD-PARTY-NOTICES.md), which keeps a camera-fixed rectangle over the Phaser
 * world and re-tints it as that world's sim clock advances.
 *
 * ## What changed, and why
 *
 * The reference picks a colour in an `if` ladder over the hour and tweens the
 * result over 400ms. The ladder is kept as a table of stops — dawn orange, a
 * clear day, sunset, night blue, and the reference's own opacities — and the
 * value between two stops is interpolated rather than switched between.
 *
 * Switching pops, which is what the tween was there to hide: at 06:00 the
 * reference's alpha jumps from 0.15 to 0.12 in one tick and the colour snaps from
 * night blue to dawn orange, so without the tween a 15-minute sim step is a
 * visible cut. A tween needs a renderer, a tween manager and a clock, and none of
 * those exist in a pure function. Interpolation is that tween evaluated rather
 * than scheduled, which is the whole reason this can be a function and not a
 * scene.
 *
 * ## Why it is not in the view
 *
 * The view draws. This decides what colour to draw, and a tint that changed as a
 * side effect of being drawn would make the frame loop the owner of the clock —
 * the argument `motion.ts` makes about positions.
 *
 * Nothing here reads a Date, a frame counter or the store. The only input is
 * elapsed milliseconds, so the same input always yields the same tint, and that
 * is the only property that makes any of it testable.
 */

/** Hours in a cycle, because the reference's table is written in hours. */
const HOURS_PER_CYCLE = 24;

/**
 * Real milliseconds for one full day/night cycle.
 *
 * The reference's tick loop advances its sim clock by 15 minutes every 10 real
 * seconds, which is 96 ticks to the day: 16 minutes. Keeping its pace is the
 * point — a sky that cycles in forty seconds reads as a lamp being turned down.
 */
export const SKY_CYCLE_MS = 16 * 60 * 1000;

/** An RGB tint, one channel each in 0-255. Pixi's `Color.setRGB` takes these. */
export interface SkyColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** A colour, and how much of it to lay over the world. */
export interface SkyTint {
  readonly color: SkyColor;
  /** 0 lays down nothing at all, 1 lays the tint down opaquely. */
  readonly opacity: number;
}

export interface SkyStop {
  /**
   * Where on the clock this stop sits, 0 to 24. Ascending, opening at 0 and
   * closing at 24 — see `SKY_STOPS`.
   */
  readonly hour: number;
  /** `0xrrggbb`, the way the reference and DESIGN.md both write a colour. */
  readonly color: number;
  readonly opacity: number;
}

/**
 * The reference's own numbers, one row per change of behaviour.
 *
 * The two night rows below midnight are the reference's `0.35 - (hour/6) * 0.2`
 * and the two above are its `0.15 + ((hour-20)/4) * 0.2`; the two dawn rows are
 * its `0.12 * (1 - (hour-6)/2)`, and the single sunset row is its
 * `((hour-17)/3) * 0.15` at the midpoint. The seam where those meet is what the
 * interpolation is for.
 *
 * The last row restates the first at 24 so the cycle closes on itself. Without
 * it, the walk off the end of the night needs a modulo and a special case, and a
 * table that can be read one row past its end is a table that can throw.
 */
export const SKY_STOPS: readonly SkyStop[] = [
  { hour: 0, color: 0x000033, opacity: 0.35 },
  { hour: 5, color: 0x000033, opacity: 0.183333 },
  { hour: 6, color: 0xff8c00, opacity: 0.12 },
  { hour: 7, color: 0xff8c00, opacity: 0.06 },
  { hour: 8, color: 0x000000, opacity: 0 },
  { hour: 17, color: 0x000000, opacity: 0 },
  { hour: 19, color: 0xff6600, opacity: 0.1 },
  { hour: 20, color: 0x000033, opacity: 0.15 },
  { hour: 22, color: 0x000033, opacity: 0.25 },
  { hour: 24, color: 0x000033, opacity: 0.35 },
];

/**
 * `0xrrggbb` to channels — the three shifts `hex()` makes in
 * `../sprites/pixel-canvas.js`, written out here so this module has no runtime
 * import at all. A tint that needs the sprite package, and a renderer, to name a
 * colour is a tint that cannot be constructed in a test.
 */
function channels(value: number): SkyColor {
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function mix(from: SkyColor, to: SkyColor, t: number): SkyColor {
  return {
    r: Math.round(from.r + (to.r - from.r) * t),
    g: Math.round(from.g + (to.g - from.g) * t),
    b: Math.round(from.b + (to.b - from.b) * t),
  };
}

/** Positive remainder, so a clock that ran backwards wraps instead of going negative. */
function wrap(value: number): number {
  return ((value % SKY_CYCLE_MS) + SKY_CYCLE_MS) % SKY_CYCLE_MS;
}

/** Where elapsed time sits in the cycle, as a fractional hour in [0, 24). */
export function skyHour(elapsedMs: number): number {
  return (wrap(elapsedMs) / SKY_CYCLE_MS) * HOURS_PER_CYCLE;
}

/**
 * The tint for a moment in the cycle.
 *
 * Linear between the two stops that bracket the hour, and exact on a stop itself
 * — so `skyTint` at 08:00 is the table's clear row rather than an interpolation
 * that rounds near it.
 */
export function skyTint(elapsedMs: number): SkyTint {
  const hour = skyHour(elapsedMs);
  // The closing 24:00 stop is past any hour `skyHour` can return, so a bracket
  // always exists and the walk never runs off the end.
  const index = SKY_STOPS.reduce((last, stop, i) => (stop.hour <= hour ? i : last), 0);
  const from = SKY_STOPS[index]!;
  const to = SKY_STOPS[index + 1]!;
  const t = (hour - from.hour) / (to.hour - from.hour);

  return {
    color: mix(channels(from.color), channels(to.color), t),
    opacity: from.opacity + (to.opacity - from.opacity) * t,
  };
}
