/**
 * Pointer intent: telling a pan, a marquee and a click apart.
 *
 * ## Why this exists
 *
 * A press is ambiguous until it ends. Press at (10,10) and release at (10,10)
 * is a click. Press at (10,10) and release at (400,10) is a drag that may have
 * crossed every agent on screen. The event carries no verdict, so something has
 * to decide — and the two obvious ways to decide are both wrong. A timer makes
 * a slow, deliberate drag read as a long press. The button alone does not work
 * either, because the common button is the primary one: click, marquee and
 * trackpad pan all start there.
 *
 * ## The rule
 *
 * The button picks the gesture. The distance commits it.
 *
 * A secondary press is a pan, and there is nothing to decide. A primary press
 * is ambiguous and stays undecided until the pointer has travelled
 * `PAN_DRAG_THRESHOLD_PX` from where it went down; past that it is a marquee,
 * and a release before that is a click. One rule, both gestures, no timers.
 *
 * The distance is measured from the press and never from the previous move. A
 * threshold applied per-move is a threshold a slow drag never reaches, and the
 * failure is silent: the camera simply does not move, on a machine that is
 * fast enough.
 *
 * ## `idle` means two different things
 *
 * `phase` is `idle` both when no button is down and while a button is down and
 * still undecided. Callers need to tell those apart, and `state.gesture` is
 * the question that does it: an input layer asks `gesture !== null` to decide
 * whether a press is in flight. The intent is the other question — whether
 * there is anything to act on — and an `idle` intent means this event changed
 * nothing a caller can see.
 *
 * ## Port
 *
 * The idea is ported from arcane-agents
 * `src/client/map/input/pointerStateMachine.ts` (MIT, Copyright (c) 2026
 * Thomas Rice, `edcaf4018ab4`; recorded in THIRD-PARTY-NOTICES.md). The
 * reference is a class over DOM-adjacent inputs that also resolves hits,
 * selection membership and pinch-zoom; this keeps the gesture decision, which
 * is the part worth having, and leaves resolution to whoever owns the entities.
 * No code is shared, and no DOM type appears: a rectangle is four numbers, and
 * a machine that needs a `PointerEvent` to run cannot be tested in a suite
 * that has no window.
 *
 * Pinch is deliberately absent. It needs an id per finger and a rule for which
 * finger owns the gesture, and this module's entire contract is one pointer as
 * `{x, y}`.
 */

/** A position, in whatever units the caller feeds the machine. Screen pixels, in practice. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The area a marquee covers, anchored at its top-left corner.
 *
 * Normalised rather than signed, because every consumer downstream of it — a
 * hit test, a renderer, a bounds check — wants a positive width, and the
 * alternative is every one of them re-deriving `abs` and hoping the callers
 * agreed on which corner is the origin.
 */
export interface SelectionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type PointerPhase = 'idle' | 'panning' | 'selecting';

/** Which button the press came from. Names, not DOM button numbers. */
export type PointerButton = 'primary' | 'secondary';

/** How far a press must travel before it stops being a click. */
export const PAN_DRAG_THRESHOLD_PX = 4;

/**
 * How small a finished marquee may be on an axis and still count.
 *
 * Discarded if it is thinner than this on EITHER axis, so a zero-height sweep
 * across 200px selects nothing. That is the conservative reading, and it is
 * taken deliberately: a band one pixel tall is far more often a slip than a
 * request to select a line, and the failure of guessing wrong is a selection
 * the player cannot see the reason for and did not ask for.
 */
export const MARQUEE_MIN_SIZE_PX = 2;

export interface PointerConfig {
  readonly panDragThresholdPx: number;
  readonly marqueeMinSizePx: number;
}

export const DEFAULT_POINTER_CONFIG: PointerConfig = {
  panDragThresholdPx: PAN_DRAG_THRESHOLD_PX,
  marqueeMinSizePx: MARQUEE_MIN_SIZE_PX,
};

/** The press in flight. Null exactly when no button is down. */
export interface PointerGesture {
  readonly button: PointerButton;
  /** Where the button went down. A click reports this, not the release. */
  readonly start: Point;
  /** The most recent sample. A pan delta is measured from here. */
  readonly last: Point;
  /** Latched once the press has travelled far enough to have stopped being a click. */
  readonly committed: boolean;
}

export interface PointerState {
  readonly phase: PointerPhase;
  readonly gesture: PointerGesture | null;
}

export type PointerEvent =
  | { readonly type: 'pointerDown'; readonly button: PointerButton; readonly point: Point }
  | { readonly type: 'pointerMove'; readonly point: Point }
  | { readonly type: 'pointerUp'; readonly point: Point };

export type PointerIntent =
  /** Nothing to act on. The event did not change anything a caller can see. */
  | { readonly kind: 'idle' }
  /** The camera moves by this much. Incremental, never absolute. */
  | { readonly kind: 'pan'; readonly deltaX: number; readonly deltaY: number }
  /**
   * A selection rectangle. `live` marks it provisional: while it is true the
   * caller draws the rect, and when it turns false the same rect is the one to
   * apply. One rect, two instructions, and no second event to keep in step.
   */
  | { readonly kind: 'select'; readonly rect: SelectionRect; readonly live: boolean }
  /** A press and release that never travelled. It landed at `at`. */
  | { readonly kind: 'click'; readonly at: Point };

export interface PointerStep {
  readonly state: PointerState;
  readonly intent: PointerIntent;
}

/** Shared so the common answer is one object rather than one per event. */
const IDLE_INTENT: PointerIntent = { kind: 'idle' };

export function idlePointer(): PointerState {
  return { phase: 'idle', gesture: null };
}

/**
 * The rectangle between two points, whatever order they arrived in.
 *
 * Exported because a hit test written later needs the same normalisation, and
 * two implementations of `min`/`abs` over a marquee is the same class of bug as
 * a second projection convention: correct alone, disagreeing at the edges.
 */
export function selectionRectFrom(start: Point, end: Point): SelectionRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

/**
 * Feeds one event to the machine and reports what became true.
 *
 * Pure: the input state is never touched, and an event that changes nothing
 * returns the same state object, so a caller can compare identity to skip work.
 */
export function reducePointer(
  state: PointerState,
  event: PointerEvent,
  config: PointerConfig = DEFAULT_POINTER_CONFIG,
): PointerStep {
  if (event.type === 'pointerDown') return press(event.button, event.point);

  const gesture = state.gesture;
  // A move with no button down is a hover and a release with no button down is
  // a stranger. Neither is a gesture, and inventing a verdict for one would be
  // a guess about something that never started.
  if (gesture === null) return { state, intent: IDLE_INTENT };

  return event.type === 'pointerMove'
    ? drag(gesture, event.point, config)
    : release(state, gesture, event.point, config);
}

/**
 * A new press discards whatever was in flight.
 *
 * There are no pointer ids here, so a second button down while one is held
 * cannot be told apart from the first; treating it as a fresh press is the
 * reading that cannot desynchronise, and a caller wanting multi-pointer
 * ownership is calling the wrong module.
 */
function press(button: PointerButton, point: Point): PointerStep {
  return {
    state: { phase: 'idle', gesture: { button, start: point, last: point, committed: false } },
    intent: IDLE_INTENT,
  };
}

function drag(gesture: PointerGesture, point: Point, config: PointerConfig): PointerStep {
  const travelled = Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y);
  const committed = gesture.committed || travelled >= config.panDragThresholdPx;
  const phase = phaseFor(gesture.button, committed);

  return {
    state: { phase, gesture: { ...gesture, last: point, committed } },
    intent: intentFor(phase, gesture, point),
  };
}

function release(
  state: PointerState,
  gesture: PointerGesture,
  point: Point,
  config: PointerConfig,
): PointerStep {
  const done = idlePointer();
  const deltaX = point.x - gesture.last.x;
  const deltaY = point.y - gesture.last.y;

  switch (state.phase) {
    case 'idle': {
      // Still undecided, so this is a click if it can be one. A secondary press
      // that never travelled is not a pan: it moved nothing, and a right-click
      // belongs to the surface rather than to a camera.
      if (gesture.button !== 'primary') return { state: done, intent: IDLE_INTENT };
      return { state: done, intent: { kind: 'click', at: gesture.start } };
    }
    case 'panning':
      // The release is the most accurate sample of where the pointer ended, so
      // whatever distance separates it from the last move is a delta the camera
      // has not been given. Browsers coalesce and drop moves under load, and
      // this is where a pan that stops short of the cursor loses the error.
      return { state: done, intent: panIntent(deltaX, deltaY) };
    case 'selecting': {
      const rect = selectionRectFrom(gesture.start, point);
      if (rect.width < config.marqueeMinSizePx || rect.height < config.marqueeMinSizePx) {
        // The press moved, so it is not the click it would otherwise have been,
        // and a box this small has no honest contents. Discarding claims
        // nothing; downgrading it to a click would select the thing under the
        // press, which is a different claim and not one the gesture made.
        return { state: done, intent: IDLE_INTENT };
      }
      return { state: done, intent: { kind: 'select', rect, live: false } };
    }
  }
}

/** Uncommitted is `idle` whichever button is down; committed is the button's gesture. */
function phaseFor(button: PointerButton, committed: boolean): PointerPhase {
  if (!committed) return 'idle';
  return button === 'secondary' ? 'panning' : 'selecting';
}

function intentFor(phase: PointerPhase, gesture: PointerGesture, point: Point): PointerIntent {
  if (phase === 'panning') return panIntent(point.x - gesture.last.x, point.y - gesture.last.y);
  if (phase === 'selecting') {
    return { kind: 'select', rect: selectionRectFrom(gesture.start, point), live: true };
  }
  return IDLE_INTENT;
}

/** A pan of no distance is not a pan, and a caller told otherwise acts on a no-op. */
function panIntent(deltaX: number, deltaY: number): PointerIntent {
  if (deltaX === 0 && deltaY === 0) return IDLE_INTENT;
  return { kind: 'pan', deltaX, deltaY };
}
