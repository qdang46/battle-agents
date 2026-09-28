import { describe, expect, it } from 'vitest';

import { SKY_CYCLE_MS, SKY_STOPS, skyHour, skyTint, type SkyColor, type SkyTint } from './sky.js';

/**
 * The sky, proven as arithmetic rather than as pixels.
 *
 * A tint cannot be asserted from a screenshot for the same reason the camera
 * cannot (see `fit.test.ts`): a headless context that has lost its drawing buffer
 * shows the same empty canvas whether the overlay colour is right or wrong. The
 * property here is a function of elapsed time, so the test is that function.
 *
 * The two properties everything else depends on are that the tint MOVES — the sky
 * is not one colour for twenty-four hours — and that it is a FUNCTION, so the
 * same instant twice is the same tint and the frame loop can ask every frame
 * without the sky drifting.
 */

/** A tint as a string, so two tints can be compared without a field-by-field test. */
function key(tint: SkyTint): string {
  return `${tint.color.r},${tint.color.g},${tint.color.b}@${tint.opacity}`;
}

/** The elapsed time at a given hour of the cycle. */
function at(hour: number): number {
  return (hour / 24) * SKY_CYCLE_MS;
}

/** A stop's stored `0xrrggbb`, in the channels the tint comes back as. */
function channelsOf(value: number): SkyColor {
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

/** Every hour of a day, plus one step inside each hour, sampled across the cycle. */
function sampleEveryHalfHour(): number[] {
  return Array.from({ length: 48 }, (_, i) => at(i / 2));
}

describe('skyTint', () => {
  it('is not the same tint at every hour of the day', () => {
    const noon = key(skyTint(at(12)));
    const midnight = key(skyTint(at(0)));
    const dawn = key(skyTint(at(6)));
    const dusk = key(skyTint(at(19)));

    expect(new Set([noon, midnight, dawn, dusk]).size).toBe(4);
    expect(key(skyTint(at(3)))).not.toBe(midnight);
    expect(key(skyTint(at(6.5)))).not.toBe(dawn);
  });

  it('holds still through the middle of the day', () => {
    // 08:00-17:00 is one clear row in the reference's table, so a sky that
    // drifted inside it would be inventing light the port does not have.
    for (const hour of [8, 9, 12, 15, 17]) {
      expect(key(skyTint(at(hour)))).toBe(key(skyTint(at(12))));
    }
  });

  it('is the same tint for the same instant twice', () => {
    for (const elapsedMs of sampleEveryHalfHour()) {
      expect(key(skyTint(elapsedMs))).toBe(key(skyTint(elapsedMs)));
    }
  });

  it('agrees with itself about a tint it has already returned', () => {
    // The frame loop asks once per frame from its own clock, so the value has to
    // survive being held rather than only being recomputed from the same input.
    const elapsedMs = at(19.5);
    expect(skyTint(elapsedMs)).toEqual(skyTint(elapsedMs));
  });

  it('cycles, so a world left running comes back round to the same sky', () => {
    for (const elapsedMs of sampleEveryHalfHour()) {
      expect(key(skyTint(elapsedMs + SKY_CYCLE_MS))).toBe(key(skyTint(elapsedMs)));
    }
  });

  it('wraps a negative clock rather than shading backwards', () => {
    const elapsedMs = at(6);
    expect(key(skyTint(elapsedMs - SKY_CYCLE_MS))).toBe(key(skyTint(elapsedMs)));
  });

  it('is dark and blue at midnight, and clear at noon', () => {
    const midnight = skyTint(at(0));
    expect(midnight.opacity).toBeGreaterThan(0.3);
    expect(midnight.color.b).toBeGreaterThan(midnight.color.r);

    const noon = skyTint(at(12));
    expect(noon.opacity).toBe(0);
    expect(noon.color).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('is warmer at dawn than at midnight', () => {
    const dawn = skyTint(at(6));
    const midnight = skyTint(at(0));
    expect(dawn.color.r).toBeGreaterThan(midnight.color.r);
  });

  it('never leaves the range a renderer will accept', () => {
    for (const elapsedMs of sampleEveryHalfHour()) {
      const { color, opacity } = skyTint(elapsedMs);
      expect(opacity).toBeGreaterThanOrEqual(0);
      expect(opacity).toBeLessThanOrEqual(1);
      for (const channel of [color.r, color.g, color.b]) {
        expect(Number.isInteger(channel)).toBe(true);
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe('the stop table', () => {
  it('starts at midnight and ascends, because the tint walks it in order', () => {
    const hours = SKY_STOPS.map((stop) => stop.hour);
    expect(hours[0]).toBe(0);
    for (let i = 1; i < hours.length; i += 1) {
      expect(hours[i]).toBeGreaterThan(hours[i - 1]!);
    }
  });

  it('closes on itself at 24:00, so the cycle needs no special case', () => {
    const last = SKY_STOPS[SKY_STOPS.length - 1]!;
    const first = SKY_STOPS[0]!;
    expect(last.hour).toBe(24);
    expect(key({ color: channelsOf(last.color), opacity: last.opacity })).toBe(
      key({ color: channelsOf(first.color), opacity: first.opacity }),
    );
  });

  it('spends part of the cycle lit and part of it not', () => {
    // A table of one stop would pass every test above by returning a constant.
    expect(SKY_STOPS.some((stop) => stop.opacity === 0)).toBe(true);
    expect(SKY_STOPS.some((stop) => stop.opacity > 0)).toBe(true);
  });
});

describe('skyHour', () => {
  it('stays inside the cycle for any elapsed time, including a negative one', () => {
    for (const elapsedMs of [...sampleEveryHalfHour(), -1, 0, SKY_CYCLE_MS, -SKY_CYCLE_MS]) {
      const hour = skyHour(elapsedMs);
      expect(hour).toBeGreaterThanOrEqual(0);
      expect(hour).toBeLessThan(24);
    }
  });
});
