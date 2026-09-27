import { harnessSchema, sessionEndReasonSchema } from '@battle-agents/protocol';

import type { ActivityEntry } from './activity.js';

/**
 * The public replay: a battle's timeline, projected for somebody who is not
 * logged in.
 *
 * WHY THIS LIVES IN THE ACTIVITY FEATURE, which is the decision a reader will
 * look for first. A replay is not a lifecycle: it has no capability, no action,
 * no handler and nothing to write. It is a projection of the log this feature
 * owns, and it depends on the log's ordering, on the log's retention window and
 * on the log's guarantee that a row's fields are unbounded strings. A second
 * package holding that projection would have to redeclare the read port — the
 * layering rules stop features importing each other, so it could not ask — and
 * the two answers would then be free to disagree about what happened first and
 * how long a log row survives. That disagreement is the failure this feature's
 * own header exists to prevent, so the projection is here rather than beside it.
 *
 * WHY THE ALLOW-LIST IS A PROJECTION AND NOT A FILTER, which is the whole
 * shape of this file. `docs/design/public-event-stream.md` settled the
 * argument for the live stream and it applies verbatim here: in
 * `packages/protocol/src/agent-event.ts` every payload field is
 * `z.string().min(1)`, so `test.failed.failure`, `test.passed.suite` and every
 * other string in the log is an arbitrary string of arbitrary length. An event
 * cannot be published and then have its dangerous field removed, because nothing
 * in the type says which field was the dangerous one. So every beat below is
 * BUILT here, field by field, from a closed list, and an event with nothing
 * publishable in it produces no beat at all rather than an empty one.
 *
 * THE PUBLIC BOUNDARY, in one paragraph, because the plan does not spell it out
 * and a reader should not have to reverse it out of a table. A logged-out viewer
 * sees WHICH HARNESSES competed, WHEN each step happened, and HOW THE RUBRIC
 * SCORED — and sees nothing about WHO they are or WHAT they were working on. No
 * agent id, no session id, no repository, no issue number, no bounty id, no
 * prompt, no file path, no command, no reasoning. The reason is that a replay
 * link is permanent and public while everything in that list is either an
 * internal handle that would let a reader bridge a public page to an
 * authenticated surface, or a pointer to somebody's private work. The harness is
 * the exception because it names a TOOL rather than a person, it is drawn from a
 * closed enum the protocol already defines, and "claude versus codex" is the
 * whole reason a stranger would click the link. `docs/design/public-replay.md`
 * is the long form.
 */

/* ───────────────────────────── the public shapes ───────────────────────────── */

/**
 * What a viewer can be told about the replay's availability.
 *
 * Three and not four. `unknown` is not one of them because it is not a replay:
 * an id that matches no battle is a 404 at the boundary, decided before this
 * projection runs, because only the row that owns the id can say whether it
 * exists.
 */
export type PublicReplayState =
  /** A finished battle, with a `battle.finished` beat. */
  | 'available'
  /** A battle still running: the timeline so far, and no verdict. */
  | 'in-progress'
  /** No events for this battle are in the log any more. */
  | 'expired';

export interface PublicCriterion {
  readonly criterion: string;
  readonly weight: number;
  readonly score: number;
  readonly weighted: number;
}

export interface PublicFighter {
  /**
   * `Fighter A`, `Fighter B`, ... in join order.
   *
   * NOT the session id, and not the agent id. Both are internal handles, and a
   * permanent public link carrying one is a way for a reader to correlate this
   * page with a live stream or an authenticated API. The label is derived from
   * the log rather than invented, so it is stable for the life of the battle.
   */
  readonly label: string;
  /** From the fighter's own `session.started`, and only if the protocol's enum
   *  still accepts it. A log written by a build with a wider enum must not widen
   *  this one, which is the failure `harnessSchema` is imported to prevent. */
  readonly harness: string | null;
  readonly score: readonly PublicCriterion[] | null;
  readonly total: number | null;
  readonly won: boolean;
}

export interface PublicBeat {
  /** The row's own `occurredAt`, verbatim. */
  readonly at: string;
  /**
   * Milliseconds since the first beat.
   *
   * Derived from the first row, never from a clock. A replay that read the wall
   * clock here would render the same battle differently for two people opening
   * the same link seconds apart, which is the property this file exists to keep.
   */
  readonly offsetMs: number;
  /** A name from {@link REPLAY_BEAT_NAMES}, never a raw event type. */
  readonly beat: string;
  /** The fighter's label, when the beat is about one. */
  readonly fighter: string | null;
  /** Allow-listed scalars only. Every value is a number, a boolean, or a
   *  string that passed a named check below. */
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

export interface PublicReplay {
  readonly replayId: string;
  readonly state: PublicReplayState;
  /** The battle's mode, from the log. Null only when the log has no opening. */
  readonly mode: string | null;
  /** `won` or `no-winner`, as the judge recorded it. */
  readonly outcome: string | null;
  /** Why a winner won, or why a battle ended without one. Closed set. */
  readonly reason: string | null;
  /** The published rubric, as the judge froze it. The fairness claim, and the
   *  one thing a reader cannot check for themselves, so it is published. */
  readonly rubric: Readonly<Record<string, number>> | null;
  readonly fighters: readonly PublicFighter[];
  readonly beats: readonly PublicBeat[];
  /** How long the battle took, from the first beat to the last. */
  readonly durationMs: number | null;
}

/**
 * Every beat name this projection can emit.
 *
 * Declared as data rather than left implicit in the projectors, so a renderer
 * can exhaustively switch on a closed set instead of treating a name as any
 * string, and so the test that a beat name is public can enumerate the set. A
 * raw event type reaching a page is a field the allow-list does not govern.
 */
export const REPLAY_BEAT_NAMES = [
  'battle.opened',
  'battle.expired',
  'battle.abandoned',
  'battle.finished',
  'fighter.joined',
  'fighter.join_refused',
  'fighter.paused',
  'fighter.resumed',
  'session.started',
  'session.ended',
  'session.resumed',
  'test.passed',
  'test.failed',
] as const;

export type ReplayBeatName = (typeof REPLAY_BEAT_NAMES)[number];

/* ───────────────────────────── building it ───────────────────────────── */

export interface ReplayInput {
  /**
   * The public handle from the URL. Copied, never derived: the projection mints
   * no identifier, so two viewers holding the same log and the same id see the
   * same bytes.
   */
  readonly replayId: string;
  /** The battle's rows, in log order, already scoped to this battle. */
  readonly entries: readonly ActivityEntry[];
}

/**
 * The replay, as a pure function of the log.
 *
 * PURE MEANS PURE, and the constraint is load-bearing rather than tidy: a replay
 * is shared, so two people opening the same link have to see the same thing. The
 * ways this could break are each a real bug rather than a style question — read
 * the clock for an offset, mint a uuid for a beat, depend on which key a jsonb
 * row happened to list first — and each of them is closed by construction here
 * and watched by a test rather than by a comment. See `replay.test.ts`.
 */
export function buildPublicReplay(input: ReplayInput): PublicReplay {
  const ordered = [...input.entries].sort(bySequence);
  const labels = fighterLabels(ordered);
  const opened = ordered.find((entry) => entry.type === 'battle.created');
  const finished = ordered.find((entry) => isBattleLevelFinish(entry));

  const context: ProjectionContext = {
    labelOf: (sessionId) => labels.get(sessionId) ?? null,
    fighterHarness(sessionId) {
      const start = ordered.find(
        (entry) => entry.type === 'session.started' && entry.sessionId === sessionId,
      );
      return harnessOf(start);
    },
  };

  const beats = ordered
    .map((entry) => projectBeat(entry, context))
    .filter((beat): beat is PublicBeat => beat !== undefined);
  // The offset is a property of the timeline, so it is applied after every beat
  // is projected and the first one is known. The zero origin is reachable only
  // for a timeline with no beats, and it is never used because nothing is
  // offset by it.
  const origin = beats[0] === undefined ? 0 : Date.parse(beats[0].at);
  const offset = beats.map((beat) => ({ ...beat, offsetMs: Date.parse(beat.at) - origin }));

  const fighterIds = [...labels.keys()];
  const judgement = judgementOf(finished);
  const fighters = fighterIds.map((sessionId, index): PublicFighter => {
    const scored = judgement.scores.get(sessionId);
    return {
      label: labels.get(sessionId) ?? `Fighter ${letterOf(index)}`,
      harness: context.fighterHarness(sessionId),
      score: scored?.criteria ?? null,
      total: scored?.total ?? null,
      won: judgement.winners.has(sessionId),
    };
  });

  const rubric = weightsOf(opened) ?? weightsOf(finished);
  const last = offset[offset.length - 1];

  return {
    replayId: input.replayId,
    // No beats at all is the only evidence the log has about this battle, and it
    // is what a battle whose rows have aged out looks like. `expired` claims
    // nothing beyond that, and the retention window it points at is this
    // feature's own, so a reader is told where to look rather than why.
    state: offset.length === 0 ? 'expired' : finished === undefined ? 'in-progress' : 'available',
    mode: modeOf(opened),
    outcome: outcomeOf(finished),
    reason: reasonOf(finished),
    rubric,
    fighters,
    beats: offset,
    durationMs: last === undefined ? null : last.offsetMs,
  };
}

function bySequence(left: ActivityEntry, right: ActivityEntry): number {
  return left.sequence - right.sequence;
}

interface ProjectionContext {
  readonly labelOf: (sessionId: string) => string | null;
  readonly fighterHarness: (sessionId: string) => string | null;
}

/* ───────────────────────────── fighter labels ───────────────────────────── */

/**
 * The fighter labels, in join order, learned from the log.
 *
 * `battle.created` carries the participants as the feature listed them, which
 * is the creator first and joiners after, so the order is the battle's own and
 * not the order a query happened to return. The fallback is first-appearance
 * order over the ordered rows, which is stable because the rows are ordered; it
 * is reached only when the opening beat is gone, which retention makes
 * vanishingly unlikely and which is why the labels could in principle change if
 * it ever happened.
 */
function fighterLabels(entries: readonly ActivityEntry[]): Map<string, string> {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (sessionId: string): void => {
    if (sessionId.length === 0 || seen.has(sessionId)) return;
    seen.add(sessionId);
    ordered.push(sessionId);
  };

  for (const entry of entries) {
    if (entry.type === 'battle.created') {
      for (const sessionId of stringArray(entry.payload['participants'])) add(sessionId);
    }
  }
  for (const entry of entries) {
    for (const sessionId of stringArray(entry.payload['participants'])) add(sessionId);
    if (entry.sessionId !== null) add(entry.sessionId);
  }
  return new Map(ordered.map((sessionId, index) => [sessionId, `Fighter ${letterOf(index)}`]));
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A, B, ... Z, then AA. Not reached by a real battle; defined so it is total. */
function letterOf(index: number): string {
  if (index < LETTERS.length) return LETTERS[index] ?? '?';
  return `${LETTERS[Math.floor(index / LETTERS.length) - 1] ?? '?'}${LETTERS[index % LETTERS.length] ?? '?'}`;
}

/* ───────────────────────────── the projectors ───────────────────────────── */

type Projector = (entry: ActivityEntry, context: ProjectionContext) => PublicBeat | undefined;

function beatOf(
  name: ReplayBeatName,
  entry: ActivityEntry,
  extra: Partial<PublicBeat>,
): PublicBeat {
  return {
    at: entry.occurredAt,
    // Overwritten by the caller once the timeline's origin is known. Kept here
    // so a projector cannot forget the field and produce a beat the type does
    // not accept.
    offsetMs: 0,
    beat: name,
    fighter: null,
    detail: {},
    ...extra,
  };
}

/**
 * One projector per event type this projection publishes.
 *
 * A map rather than a switch, so an event type nobody has thought about is
 * absent — and therefore dropped — instead of falling through a `default` arm
 * that forwards the payload. That distinction is the whole boundary: the safe
 * answer to an unknown type is no beat, and a `default` that published the raw
 * row would make every future event public by accident.
 */
const PROJECTORS: Readonly<Record<string, Projector>> = {
  'battle.created': (entry) => {
    const mode = modeOf(entry);
    return beatOf('battle.opened', entry, mode === null ? {} : { detail: { mode } });
  },
  'battle.joined': (entry, context) =>
    beatOf('fighter.joined', entry, { fighter: labelOfEntry(entry, context) }),
  'battle.join_refused': (entry, context) => {
    // `why` is a closed union in the feature that emits it. Re-checked here
    // rather than trusted, because a log row is data and a future build may
    // widen the union — and an unrecognised value is dropped rather than shown,
    // which is the difference between a narrower page and a hole in the page.
    const why = closed(entry.payload['why'], JOIN_REFUSALS);
    return beatOf('fighter.join_refused', entry, {
      fighter: labelOfEntry(entry, context),
      detail: why === null ? {} : { why },
    });
  },
  'battle.paused': (entry, context) =>
    beatOf('fighter.paused', entry, { fighter: labelOfEntry(entry, context) }),
  'battle.resumed': (entry, context) =>
    beatOf('fighter.resumed', entry, { fighter: labelOfEntry(entry, context) }),
  'battle.finished': (entry) =>
    // Only the battle-level record becomes a beat. The battle feature also emits
    // one `battle.finished` per winner, and rendering those too would put N+1
    // "finished" beats on a timeline for one finish. The battle-level row is the
    // one carrying `outcome`; the per-winner rows carry `won` and are the same
    // instant seen again.
    isBattleLevelFinish(entry)
      ? beatOf('battle.finished', entry, { detail: finishDetail(entry) })
      : undefined,
  'battle.expired': (entry) => beatOf('battle.expired', entry, { detail: reasonDetail(entry) }),
  'battle.abandoned': (entry) => beatOf('battle.abandoned', entry, { detail: reasonDetail(entry) }),
  'session.started': (entry, context) => {
    const harness = harnessOf(entry);
    return beatOf('session.started', entry, {
      fighter: labelOfEntry(entry, context),
      detail: harness === null ? {} : { harness },
    });
  },
  'session.ended': (entry, context) => {
    const reason = entry.payload['reason'];
    const parsed =
      typeof reason === 'string' ? sessionEndReasonSchema.safeParse(reason) : undefined;
    return beatOf('session.ended', entry, {
      fighter: labelOfEntry(entry, context),
      detail: parsed?.success === true ? { reason: parsed.data } : {},
    });
  },
  'session.resumed': (entry, context) =>
    beatOf('session.resumed', entry, { fighter: labelOfEntry(entry, context) }),
  'test.passed': (entry, context) =>
    beatOf('test.passed', entry, {
      fighter: labelOfEntry(entry, context),
      // Merged, not chained. `suiteDetail(x) ?? countDetail(x)` reads as "the
      // suite, or the count if there is no suite", which is a plausible-sounding
      // rule and a wrong one: a passing run normally has BOTH, and the chain
      // threw the count away whenever the suite survived the pattern.
      detail: { ...suiteDetail(entry), ...countDetail(entry) },
    }),
  'test.failed': (entry, context) =>
    // `failure` is never read here, and that is the point: it is the field the
    // live-stream classification also drops, for the same reason — an unbounded
    // string that a stack fragment lands in.
    beatOf('test.failed', entry, {
      fighter: labelOfEntry(entry, context),
      detail: suiteDetail(entry) ?? {},
    }),
};

/**
 * The closed vocabularies this projection re-checks before it publishes a
 * string.
 *
 * Written out rather than imported, and the reason is specific: the battle
 * feature cannot export them without this projection's owner being coupled to a
 * sibling, and a projection that widened its own list to match a sibling's
 * export would be a second copy of a taxonomy — the failure the battle schema
 * comment names about criterion names. So the sets live here, and the test that
 * a published value is a member of one of them is what keeps them honest. They
 * are the values the emitting feature writes today; a value outside them is
 * dropped from the page rather than shown, which fails safe.
 */
const JOIN_REFUSALS: ReadonlySet<string> = new Set([
  'not-found',
  'not-running',
  'full',
  'already-in-it',
]);

/** Why a battle ended without a verdict: the sweep's two reasons. */
const LIFECYCLE_REASONS: ReadonlySet<string> = new Set([
  'match-duration-elapsed',
  'resume-grace-expired',
]);

/** Why the judge decided what it decided: the tie policy and the two no-winner
 *  cases, all of which the judge writes as literals today. */
const OUTCOME_REASONS: ReadonlySet<string> = new Set([
  'outscored',
  'fastest-valid',
  'shared',
  'no-valid-submission',
  'no-participants',
]);

/** The value, if it is a string this projection is willing to publish. */
function closed(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function projectBeat(entry: ActivityEntry, context: ProjectionContext): PublicBeat | undefined {
  return PROJECTORS[entry.type]?.(entry, context);
}

function labelOfEntry(entry: ActivityEntry, context: ProjectionContext): string | null {
  return entry.sessionId === null ? null : context.labelOf(entry.sessionId);
}

function isBattleLevelFinish(entry: ActivityEntry | undefined): entry is ActivityEntry {
  return entry !== undefined && entry.type === 'battle.finished' && 'outcome' in entry.payload;
}

function finishDetail(entry: ActivityEntry): Readonly<Record<string, string | number | boolean>> {
  const detail: Record<string, string | number | boolean> = {};
  const outcome = entry.payload['outcome'];
  if (typeof outcome === 'string') detail['outcome'] = outcome;
  const reason = reasonOf(entry);
  if (reason !== null) detail['reason'] = reason;
  return detail;
}

function reasonDetail(entry: ActivityEntry): Readonly<Record<string, string | number | boolean>> {
  const reason = closed(entry.payload['reason'], LIFECYCLE_REASONS);
  return reason === null ? {} : { reason };
}

/* ───────────────────────────── the narrowings ───────────────────────────── */

/**
 * The harness, but only one the protocol still accepts.
 *
 * Imported rather than written out, on the principle the battle schema comment
 * states about criteria names: a closed list in a second place is a second copy
 * of a taxonomy, free to drift. `safeParse` rather than membership in a local
 * set is what makes that true — a build that adds a harness cannot widen this
 * projection by accident, it has to widen the protocol, which is a reviewed
 * change.
 */
function harnessOf(entry: ActivityEntry | undefined): string | null {
  const value = entry?.payload['harness'];
  if (typeof value !== 'string') return null;
  const parsed = harnessSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A suite name, and only one that cannot be a path.
 *
 * STRICTER THAN THE LIVE STREAM, deliberately. `docs/design/public-event-stream.md`
 * publishes `test.failed.suite` as-is on the argument that it carries no
 * sensitive field. That argument is weaker than it looks here for one reason: a
 * suite name is derived from a command line, so `pnpm test packages/db/src/verify.test.ts`
 * is a perfectly ordinary value for it and it is a repository path. The live
 * stream is ephemeral and reaches a spectator who is already on the site; a
 * replay is a permanent public artefact that gets cached and re-shared. So the
 * pattern below is a narrowing this projection adds, not a correction of the
 * other one, and it is here rather than in that document because the two
 * surfaces have different lifetimes.
 *
 * The pattern is letters, digits, dot, underscore, dash — no slash, no space, no
 * backslash, and bounded, so a path or a command line cannot pass it.
 */
const SUITE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function suiteDetail(entry: ActivityEntry): Readonly<Record<string, string | number>> | undefined {
  const value = entry.payload['suite'];
  if (typeof value !== 'string' || !SUITE_PATTERN.test(value)) return undefined;
  return { suite: value };
}

function countDetail(entry: ActivityEntry): Readonly<Record<string, number>> | undefined {
  const value = entry.payload['count'];
  return typeof value === 'number' && Number.isFinite(value) ? { count: value } : undefined;
}

/* ───────────────────────────── the judge output ───────────────────────────── */

interface FighterScore {
  readonly total: number;
  readonly criteria: readonly PublicCriterion[];
}

interface Judgement {
  readonly scores: Map<string, FighterScore>;
  readonly winners: ReadonlySet<string>;
}

const NO_JUDGEMENT: Judgement = { scores: new Map(), winners: new Set() };

/**
 * The judge's arithmetic, as the log recorded it.
 *
 * The brief's condition is that the replay is a pure function of the event
 * stream PLUS the judge output, and that the judge output is an ordered
 * attributable stream rather than a collapsed number — "a judge that returns
 * only a weighted number cannot seed an explainable replay". So this reads the
 * per-participant scores the battle-level `battle.finished` row carries, not a
 * total somebody recomputed here, and it sorts the criteria by name rather than
 * trusting the array order: jsonb does not preserve key order, so an array whose
 * order follows the row is a replay that reads differently on the next request.
 */
function judgementOf(finished: ActivityEntry | undefined): Judgement {
  if (finished === undefined) return NO_JUDGEMENT;
  const scores = new Map<string, FighterScore>();
  const winners = new Set<string>();
  for (const sessionId of stringArray(finished.payload['winnerSessionIds'])) winners.add(sessionId);

  const rows = finished.payload['scores'];
  if (!Array.isArray(rows)) return { scores, winners };
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const sessionId = record['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
    const total = record['total'];
    const criteria = criteriaOf(record['criteria']);
    scores.set(sessionId, { total: numberOr(total, 0), criteria });
  }
  return { scores, winners };
}

function criteriaOf(value: unknown): readonly PublicCriterion[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && typeof entry['criterion'] === 'string',
    )
    .map((entry) => ({
      criterion: entry['criterion'] as string,
      weight: numberOr(entry['weight'], 0),
      score: numberOr(entry['score'], 0),
      weighted: numberOr(entry['weighted'], 0),
    }))
    .sort((left, right) => left.criterion.localeCompare(right.criterion));
}

/* ───────────────────────────── small readers ───────────────────────────── */

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function modeOf(entry: ActivityEntry | undefined): string | null {
  const mode = entry?.payload['mode'];
  return typeof mode === 'string' && mode.length > 0 ? mode : null;
}

function outcomeOf(entry: ActivityEntry | undefined): string | null {
  const outcome = entry?.payload['outcome'];
  return typeof outcome === 'string' && outcome.length > 0 ? outcome : null;
}

function reasonOf(entry: ActivityEntry | undefined): string | null {
  return entry === undefined ? null : closed(entry.payload['reason'], OUTCOME_REASONS);
}

/**
 * The published rubric.
 *
 * A weight, not a string, and only a finite one: the rubric is the fairness
 * claim a spectator cannot verify for themselves, so it is published — but a
 * `weights` object that held a string would put it on the page verbatim, and
 * nothing upstream says it cannot. Keys are sorted so two renders of the same
 * row agree.
 */
function weightsOf(entry: ActivityEntry | undefined): Record<string, number> | null {
  const weights = entry?.payload['weights'];
  if (typeof weights !== 'object' || weights === null || Array.isArray(weights)) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(weights as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/* ───────────────────────────── share metadata ───────────────────────────── */

export interface ReplayShareMetadata {
  readonly title: string;
  readonly description: string;
  readonly url: string;
}

/**
 * What a chat client shows under a pasted link.
 *
 * A pure function of the replay and an origin, and it reads the PROJECTION
 * rather than the log. That is deliberate: this string is the most widely copied
 * artefact the feature produces — it is what ends up in a Discord preview and in
 * a search index — so it must be incapable of carrying anything the projection
 * already refused, and it cannot be if it is downstream of the same filter.
 */
export function replayShareMetadata(replay: PublicReplay, origin: string): ReplayShareMetadata {
  const root = origin.replace(/\/+$/, '');
  const url = `${root}/replay/${replay.replayId}`;
  const named = replay.fighters
    .map((fighter) =>
      fighter.harness === null ? fighter.label : `${fighter.label} (${fighter.harness})`,
    )
    .join(' vs ');

  if (replay.state === 'expired') {
    // Same discipline as the page's ExpiredNotice, and it was missing here: the
    // notice was corrected for asserting a retention the log cannot support, and
    // these two strings went on asserting it. "Finished" is a claim about the
    // battle, and a battle with no beats gets the same state whether it ended
    // an hour ago or is RUNNING RIGHT NOW -- the state machine cannot tell them
    // apart, so this text must not. "No longer retained" says the same thing
    // more quietly: that there was something and it is gone.
    //
    // Found by rendering /replay in a browser against a real battle row with
    // status `running` and no tagged events, and reading what it said.
    return {
      title: 'Battle replay — no events in the log',
      description:
        'The activity log holds no events for this battle. It cannot say whether they were pruned or were never written.',
      url,
    };
  }
  if (replay.state === 'in-progress') {
    return {
      title: `Battle in progress${named === '' ? '' : `: ${named}`}`,
      description: 'A battle is running. The replay shows the timeline so far.',
      url,
    };
  }

  const winner = replay.fighters.find((fighter) => fighter.won);
  const verdict =
    winner === undefined
      ? 'ended with no winner'
      : `won by ${winner.harness === null ? winner.label : `${winner.label} (${winner.harness})`}`;
  const criteria = replay.rubric === null ? 0 : Object.keys(replay.rubric).length;
  return {
    title: `Battle replay${named === '' ? '' : `: ${named}`}`,
    description:
      `${verdict}${replay.durationMs === null ? '' : ` in ${describeDuration(replay.durationMs)}`}. ` +
      `Judged on ${criteria} published ${criteria === 1 ? 'criterion' : 'criteria'}.`,
    url,
  };
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

/** `1h 04m 12s`, from a duration the projection derived from the log. */
export function describeDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}
