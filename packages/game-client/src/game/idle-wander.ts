/**
 * Idleness that is not stillness.
 *
 * ## What was wrong
 *
 * A character with nothing to do was a character frozen on its tile. Every idle
 * agent in the city stood at exactly the same sub-pixel, forever, until some
 * event moved it. A screenshot cannot show this; two consecutive frames can, and
 * the gap between them is the whole difference between a world and a diagram.
 *
 * ## What this adds
 *
 * A small offset the character drifts around its tile while it has no work, so
 * a still character is still alive. Nothing else in the client may read it — it
 * is presentation only, and it is deliberately the one thing here that knows
 * nothing about zones, agents or the protocol, so it can be reasoned about and
 * pinned by a test with no fixtures.
 *
 * ## Mirrored from pixel-agents (MIT, Copyright (c) 2026 Pablo De Lucca;
 * recorded in THIRD-PARTY-NOTICES.md)
 *
 * From `webview-ui/src/constants.ts` and `webview-ui/src/office/engine/petEntity.ts`
 * at 3537e140c209: the idle *cadence* — a 4-step `[0, 1, 2, 1]` sequence at 0.3s
 * per step, and a 3s floor on how long a wander decision holds. The reference
 * spends that sequence on sprite frames, because its idle is drawn; we have no
 * idle frames yet, so the same sequence is spent on position, which produces
 * the sway the frames were standing in for.
 *
 * ## What is not mirrored
 *
 * The reference's wander is a *decision* loop: a timer expires, a path is
 * recomputed, `Math.random` picks where. That is right for a process that owns
 * one pet and one loop, and wrong for us twice over — a client that recomputes
 * from wall-clock cannot redraw the same frame twice, and randomness makes a
 * position untestable. So the decision becomes a pure function of the agent id
 * and the dwell bucket, and only the sway is a function of time. Two clients,
 * or a reload, land on the same drift.
 */

/** A position on the tile grid. Fractional — characters are between tiles. */
export interface GridPoint {
  gx: number;
  gy: number;
}

/** Where an idle character has drifted to, and by how much it drifted. */
export interface WanderOffset {
  /** Drift from the zone centre, in tiles. What the drift actually is. */
  dx: number;
  dy: number;
  /** The centre plus the drift: where to draw the character. */
  gx: number;
  gy: number;
}

/** The reference's idle step (`PET_IDLE_FRAME_DURATION_SEC`, 0.3s). */
const IDLE_STEP_MS = 300;

/**
 * The reference's idle cycle (`PET_IDLE_SEQUENCE`). Out and back, never
 * monotonic — a sequence that walked 0,1,2,3 would read as a character
 * steadily setting off, which is the opposite of idle.
 */
const IDLE_SEQUENCE: readonly number[] = Object.freeze([0, 1, 2, 1]);

/** The furthest step in `IDLE_SEQUENCE`, used to normalise it to 0..1. */
const IDLE_SEQUENCE_PEAK = 2;

/** The sequence's rest pose, and the answer for a step the sequence lacks. */
const IDLE_SEQUENCE_REST = 0;

/**
 * The reference's wander pause floor (`PET_WANDER_PAUSE_MIN_SEC`, 3s). Held as
 * a minimum rather than copied as a range because a range needs a random
 * source, and this module's whole contract is that the same inputs give the
 * same answer; bucketing time gives the same hold for free.
 */
const DWELL_MS = 3000;

/**
 * Largest drift, in tiles.
 *
 * Half a tile, deliberately. A drift of a whole tile or more reads as a
 * character that went somewhere, and these characters have not gone anywhere —
 * at the limit the sway can reach a quarter of a tile from centre, which is
 * visible as life and not as displacement.
 */
export const MAX_WANDER_TILES = 0.5;

/** Separates the reach draw from the heading draw; two draws, one dwell. */
const REACH_SALT = 0x9e3779b9;

/** FNV-1a 32-bit basis and prime. */
const FNV_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** One past the top of a uint32, so a hash divides to a fraction in [0, 1). */
const UINT32_RANGE = 0x1_0000_0000;

/** The direction the character leans, and how far out, for one dwell bucket. */
interface DwellTarget {
  angle: number;
  reachTiles: number;
}

/**
 * The idle offset for `agentId` at `timeMs`, around `centre`.
 *
 * Deterministic in both inputs, so a frame can be redrawn, replayed, or
 * received twice and land in the same place — which is the whole reason this
 * is a function of the clock rather than a decision made when the clock ticks.
 */
export function wanderOffset(agentId: string, timeMs: number, centre: GridPoint): WanderOffset {
  const at = Number.isFinite(timeMs) ? Math.max(0, timeMs) : 0;
  const target = dwellTarget(agentId, Math.floor(at / DWELL_MS));
  // Phase is absolute, not relative to the dwell, so a new dwell does not snap
  // the character back to centre: only the heading it leans in changes, and a
  // change of heading mid-sway is something a person does.
  //
  // The fallback is unreachable — the step is a modulus of the sequence length —
  // but TypeScript cannot see that, and 0 is the right answer if it ever is:
  // 0 is the sequence's rest pose, so an out-of-range step stands the character
  // square rather than inventing a pose no sequence has.
  const step = Math.floor(at / IDLE_STEP_MS) % IDLE_SEQUENCE.length;
  const sway = (IDLE_SEQUENCE[step] ?? IDLE_SEQUENCE_REST) / IDLE_SEQUENCE_PEAK;

  const dx = withoutNegativeZero(Math.cos(target.angle) * target.reachTiles * sway);
  const dy = withoutNegativeZero(Math.sin(target.angle) * target.reachTiles * sway);
  return { dx, dy, gx: centre.gx + dx, gy: centre.gy + dy };
}

/**
 * Turns -0 into 0.
 *
 * `cos(angle) * 0` is -0 for half the angles, and -0 is not `0` to a strict
 * comparison or to `Object.is`. A drift that is nothing has to read as nothing
 * to whatever inspects it next, so it is normalized here rather than at each
 * call site that would otherwise have to know this about trigonometry.
 */
function withoutNegativeZero(value: number): number {
  return value + 0;
}

/** The heading and reach a character holds for the dwell containing `dwellIndex`. */
function dwellTarget(agentId: string, dwellIndex: number): DwellTarget {
  const heading = mix(hashAgent(agentId), dwellIndex);
  const reach = mix(heading, REACH_SALT);
  return {
    angle: (heading / UINT32_RANGE) * Math.PI * 2,
    reachTiles: (reach / UINT32_RANGE) * MAX_WANDER_TILES,
  };
}

/** FNV-1a over the agent id, so two agents never share a wander. */
function hashAgent(agentId: string): number {
  let hash = FNV_BASIS;
  for (let i = 0; i < agentId.length; i += 1) {
    hash ^= agentId.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * Folds a dwell index into a seed, and finishes the avalanche.
 *
 * The trailing shifts are the point: without them a dwell index one apart from
 * another changes only the low bits of the FNV state, and adjacent dwells
 * would lean in near-identical directions — visible as a character that
 * twitches rather than a character that picks somewhere else to stand.
 */
function mix(seed: number, value: number): number {
  let hash = (seed ^ Math.imul(value, FNV_PRIME)) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, FNV_PRIME) >>> 0;
  hash ^= hash >>> 13;
  return hash >>> 0;
}
