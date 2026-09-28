/**
 * Ambient dialogue: the line a character says when nobody asked it anything.
 *
 * ## Why this exists
 *
 * A sprite that only ever draws is a telemetry dashboard with pictures on it.
 * The moment a character says something unprompted, a viewer starts reading the
 * world as inhabited rather than plotted — and the cheapest inhabitant signal
 * is the one that costs nothing to render, needs no model, and cannot be
 * wrong about the game: a line chosen out of a small bank by what the character
 * is doing right now.
 *
 * The words are the whole trick. "Standing by for a claim" reads as this world;
 * "Ready for a break?" reads as an office. So the banks are spoken in the
 * repository's vocabulary — bounty, guild, arena, quest, PR — because that
 * vocabulary is load-bearing, and a line that does not use it is decoration.
 *
 * ## Why it is keyed by agent id and not by time
 *
 * The same sprite is drawn sixty times a second. A line drawn at random per
 * frame flickers, and flicker is the one thing ambient dialogue exists to
 * prevent: it reads as noise, and noise costs the viewer more attention than a
 * still sprite would have. So the choice is a pure function of (agent, state).
 * Stable while the state is stable, different the instant the state changes,
 * and the same on every client and every replay.
 *
 * A test asserts both halves, because "random enough" is the failure mode here
 * and it passes a screenshot: nobody sees a wrong line in a still frame, and
 * every line looks fine in motion for a second.
 *
 * ## What is ported, and what deliberately is not
 *
 * The word-bank idea, the FNV-1a pick and the rule that a character's words
 * match its situation are ported from `agent-world-codemoo`
 * (`frontend/agentDialogues.mjs`, MIT — see THIRD-PARTY-NOTICES.md), which
 * solved the same problem for two agents meeting rather than for one agent
 * existing.
 *
 * Its `buildConversation` is NOT ported. That is a two-sided dialogue over a
 * priority ladder — same repo, then errored, then waiting on a permission, then
 * reconnect, then time of day — and every rung of that ladder is a fact about
 * the *pair*. Nothing here has a second character to be in a repo with, so the
 * whole ladder would be a conversation with itself. Half a structure kept for
 * the shape of it is a structure the next agent will try to complete.
 */

/**
 * What a character is doing, which is what its line is about.
 *
 * `'idle'` is also a `ZoneId`, and the two are not the same thing: the zone is
 * a place on the map, this is a claim about whether a tool is running. They
 * agree often enough that a caller will eventually hold one where the other is
 * wanted, so this is its own type rather than a reuse of the zone.
 */
export type AgentActivity = 'working' | 'idle' | 'walking';

/**
 * One bank per state.
 *
 * The banks are pairwise disjoint, and that is a contract rather than a
 * coincidence: it is what makes a state change observable as a changed line,
 * which is the reason the picker is keyed by state at all. `dialogue.test.ts`
 * pins it, because two banks that drift into sharing a line fail silently —
 * the character appears to stop talking whenever it passes through that one.
 */
export const LINES_BY_ACTIVITY: Readonly<Record<AgentActivity, readonly string[]>> = Object.freeze({
  working: [
    'Claimed another bounty.',
    'Tests are green. Finally.',
    'One more edge case.',
    'Pushing a branch.',
    'Rerunning the suite.',
    'Who owns this file?',
    'Almost ready to open a PR.',
    'Someone review this diff.',
  ],
  idle: [
    'Good to see you.',
    'Standing by for a claim.',
    'Long one this morning.',
    'Quest finished. Taking another.',
    'Taking five.',
    'How is the arena treating you?',
    'Back in a bit.',
    'Nice spot by the board.',
  ],
  walking: [
    'Heading to the arena.',
    'Wrong way. Sorry.',
    'On my way to the bounty board.',
    'Escorting this diff over.',
    'Crossing the square.',
    'Two minutes out.',
    'Back to the terminal.',
  ],
});

/** FNV-1a. The reference picks with a hash and not an rng on purpose. */
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

/** Stable, non-negative, and identical on every platform — unlike `String.hashCode` habits. */
function hashToInt(value: string): number {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/**
 * The line `agentId` says while `activity` is true.
 *
 * The state is part of the hashed seed and not only the bank index, so two
 * states do not just draw different pools — they draw different entries of
 * them. Without that, every agent's first working line would be its first idle
 * line whenever the two banks happened to be the same length.
 *
 * An activity outside the union is resolved to `idle` before the pick rather
 * than throwing. The signature says it cannot happen, and the type is the
 * reason to believe that; but a caller holding an agent's zone has a `ZoneId`,
 * most of which are not activities, and the frame loop asking a speech bubble
 * for a line is not a good place to discover it. Idle is also the honest
 * reading — an agent in a state we cannot name is not one we know to be
 * working.
 *
 * It is resolved BEFORE the seed is hashed, not after. Falling back to the
 * idle bank while still hashing the unknown state gives a line from the idle
 * pool at an idle agent's index plus an offset, so an unnamed state and a real
 * `idle` would disagree about what the same character says — and the fallback
 * would buy nothing over a wrong answer.
 */
export function pickLine(agentId: string, activity: AgentActivity): string {
  const state = LINES_BY_ACTIVITY[activity] ? activity : 'idle';
  const bank = LINES_BY_ACTIVITY[state];
  // The modulo makes the index in range; the assertion only satisfies
  // `noUncheckedIndexedAccess`, which cannot see that.
  return bank[hashToInt(`${agentId}:${state}`) % bank.length]!;
}
