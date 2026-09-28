import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POINTER_CONFIG,
  MARQUEE_MIN_SIZE_PX,
  PAN_DRAG_THRESHOLD_PX,
  idlePointer,
  reducePointer,
  selectionRectFrom,
  type Point,
  type PointerButton,
  type PointerConfig,
  type PointerIntent,
} from './pointer-intent.js';

/**
 * Three gestures off one button, proven as arithmetic.
 *
 * The trichotomy is the whole contract, and every way of getting it wrong is
 * invisible from outside: a machine that resolves a drag as a click looks
 * correct right up until a selection happens that nobody asked for, and one
 * that resolves a click as a drag does nothing at all, which is indistinguishable
 * from a dead surface. So each outcome is asserted from the same press point,
 * and the cases that only differ by a few pixels — the threshold, the latch, the
 * discarded box — are asserted directly rather than left to the passing case
 * beside them.
 */

/** Replays a press followed by a list of moves, and reports what it produced. */
function drag(
  button: PointerButton,
  points: readonly Point[],
  config: PointerConfig = DEFAULT_POINTER_CONFIG,
) {
  const [first, ...rest] = points;
  if (first === undefined) throw new Error('a drag needs at least the press point');

  let step = reducePointer(idlePointer(), { type: 'pointerDown', button, point: first }, config);
  const intents: PointerIntent[] = [step.intent];
  for (const point of rest) {
    step = reducePointer(step.state, { type: 'pointerMove', point }, config);
    intents.push(step.intent);
  }
  return { state: step.state, intents };
}

function release(state: ReturnType<typeof drag>['state'], at: Point, config?: PointerConfig) {
  return reducePointer(state, { type: 'pointerUp', point: at }, config);
}

/** The single intent a whole gesture ended in, for the trichotomy comparison. */
function outcomeOf(button: PointerButton, points: readonly Point[], releaseAt: Point): PointerIntent {
  const run = drag(button, points);
  return release(run.state, releaseAt).intent;
}

/** What a camera would have done with every pan the gesture produced. */
function panTotal(intents: readonly PointerIntent[]): Point {
  return intents.reduce(
    (total, intent) =>
      intent.kind === 'pan'
        ? { x: total.x + intent.deltaX, y: total.y + intent.deltaY }
        : total,
    { x: 0, y: 0 },
  );
}

describe('pointer intent: pan, marquee and click are three outcomes', () => {
  it('resolves the same press point into exactly one of the three', () => {
    // Pan: secondary, travelled, released past where the last move landed.
    expect(outcomeOf('secondary', [{ x: 0, y: 0 }, { x: 40, y: 0 }], { x: 40, y: 12 })).toEqual({
      kind: 'pan',
      deltaX: 0,
      deltaY: 12,
    });
    // Marquee: the same travel on the primary button, committed on release.
    expect(outcomeOf('primary', [{ x: 0, y: 0 }, { x: 40, y: 0 }], { x: 40, y: 12 })).toEqual({
      kind: 'select',
      rect: { x: 0, y: 0, width: 40, height: 12 },
      live: false,
    });
    // Click: the primary button again, having not travelled.
    expect(outcomeOf('primary', [{ x: 0, y: 0 }], { x: 0, y: 0 })).toEqual({
      kind: 'click',
      at: { x: 0, y: 0 },
    });
  });

  it('hands the camera deltas that add up to the distance the pointer travelled', () => {
    const run = drag('secondary', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 23, y: -4 }]);
    expect(run.state.phase).toBe('panning');
    expect(panTotal(run.intents)).toEqual({ x: 23, y: -4 });
  });

  it('emits a move to the same point as no pan at all', () => {
    const run = drag('secondary', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }]);
    // Phase still says a pan is in progress; the intent says there is no new
    // distance. A caller that repaints on a non-idle intent is not woken for a
    // pointer sample that moved nothing.
    expect(run.state.phase).toBe('panning');
    expect(run.intents[2]).toEqual({ kind: 'idle' });
  });

  it('never turns a secondary press into a click', () => {
    const pressed = reducePointer(idlePointer(), {
      type: 'pointerDown',
      button: 'secondary',
      point: { x: 4, y: 4 },
    });
    const released = release(pressed.state, { x: 4, y: 4 });
    expect(released.intent).toEqual({ kind: 'idle' });
    expect(released.state.gesture).toBeNull();
  });
});

describe('pointer intent: a press is undecided until it travels', () => {
  it('leaves a sub-threshold press undecided, so releasing it is still a click', () => {
    const run = drag('primary', [{ x: 0, y: 0 }, { x: 3, y: 0 }]);
    expect(run.state.phase).toBe('idle');
    // The gesture is in flight even though the phase has not committed — this
    // is the distinction `gesture !== null` exists to answer.
    expect(run.state.gesture).not.toBeNull();
    expect(run.intents[1]).toEqual({ kind: 'idle' });

    const released = release(run.state, { x: 3, y: 0 });
    expect(released.intent).toEqual({ kind: 'click', at: { x: 0, y: 0 } });
  });

  it('measures the threshold from the press, so a slow drag still commits', () => {
    // Neither move reaches 4px from the PREVIOUS point. Both are inside the
    // threshold measured that way, so a per-move test would leave this press
    // undecided forever and the drag would silently do nothing.
    const run = drag('primary', [{ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 4, y: 4 }]);
    expect(run.intents[1]).toEqual({ kind: 'idle' });
    expect(run.state.phase).toBe('selecting');
    expect(run.intents[2]).toEqual({
      kind: 'select',
      rect: { x: 0, y: 0, width: 4, height: 4 },
      live: true,
    });
  });

  it('latches the commitment, so dragging back to the press is not a click', () => {
    const run = drag('primary', [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 0 }]);
    expect(run.state.phase).toBe('selecting');

    // Back on the press point. The gesture committed on the way out, so this is
    // a zero-sized box and NOT the click the same travel inverted would give.
    const released = release(run.state, { x: 0, y: 0 });
    expect(released.intent).toEqual({ kind: 'idle' });
    expect(released.state.phase).toBe('idle');
  });

  it('takes the threshold from the caller, and defaults to the exported constant', () => {
    expect(DEFAULT_POINTER_CONFIG.panDragThresholdPx).toBe(PAN_DRAG_THRESHOLD_PX);
    expect(DEFAULT_POINTER_CONFIG.marqueeMinSizePx).toBe(MARQUEE_MIN_SIZE_PX);

    const impatient: PointerConfig = { ...DEFAULT_POINTER_CONFIG, panDragThresholdPx: 0.5 };
    const run = drag('primary', [{ x: 0, y: 0 }, { x: 1, y: 0 }], impatient);
    expect(run.state.phase).toBe('selecting');
  });
});

describe('pointer intent: a click lands where it was pressed', () => {
  it('reports the press point, so a release that slid off still hits the target', () => {
    const pressed = reducePointer(idlePointer(), {
      type: 'pointerDown',
      button: 'primary',
      point: { x: 10, y: 10 },
    });
    // A release 200px away with no move between is a dropped move, not a drag,
    // and the thing under the finger at the press is still what was pressed.
    const released = release(pressed.state, { x: 210, y: 10 });
    expect(released.intent).toEqual({ kind: 'click', at: { x: 10, y: 10 } });
  });
});

describe('pointer intent: the marquee is normalised and bounded', () => {
  it('anchors a box dragged up and to the left at its minimum corner', () => {
    const run = drag('primary', [{ x: 100, y: 100 }, { x: 20, y: 40 }]);
    expect(run.intents[1]).toEqual({
      kind: 'select',
      rect: { x: 20, y: 40, width: 80, height: 60 },
      live: true,
    });
  });

  it('normalises a rect the same way whoever asks for it', () => {
    expect(selectionRectFrom({ x: 20, y: 40 }, { x: 100, y: 100 })).toEqual(
      selectionRectFrom({ x: 100, y: 100 }, { x: 20, y: 40 }),
    );
  });

  it('marks the rect provisional while dragging and committed on release', () => {
    const run = drag('primary', [{ x: 0, y: 0 }, { x: 40, y: 30 }]);
    expect(run.intents[1]).toMatchObject({ live: true });

    const released = release(run.state, { x: 40, y: 30 });
    expect(released.intent).toEqual({
      kind: 'select',
      rect: { x: 0, y: 0, width: 40, height: 30 },
      live: false,
    });
    expect(released.state.phase).toBe('idle');
    expect(released.state.gesture).toBeNull();
  });

  it('discards a box thin on either axis rather than sweeping a line of agents', () => {
    const run = drag('primary', [{ x: 0, y: 0 }, { x: 200, y: 0 }]);
    expect(run.state.phase).toBe('selecting');
    expect(release(run.state, { x: 200, y: 0 }).intent).toEqual({ kind: 'idle' });
  });
});

describe('pointer intent: events with no press in flight decide nothing', () => {
  it('ignores a hover and a stray release, and leaves the state untouched', () => {
    const start = idlePointer();

    const hovered = reducePointer(start, { type: 'pointerMove', point: { x: 10, y: 10 } });
    expect(hovered.state).toBe(start);
    expect(hovered.intent).toEqual({ kind: 'idle' });

    const released = reducePointer(start, { type: 'pointerUp', point: { x: 10, y: 10 } });
    expect(released.state).toBe(start);
    expect(released.intent).toEqual({ kind: 'idle' });
  });
});
