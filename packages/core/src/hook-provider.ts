/**
 * The seam a hook-based harness plugs into.
 *
 * Ported from pixel-agents, `core/src/provider.ts` and `core/src/teamProvider.ts`
 * at commit `3537e140c209`, which plan section 28.1 item 3 classifies as a
 * direct copy. `THIRD-PARTY-NOTICES.md` carries the attribution; the upstream
 * files carry no copyright header, so there is none here to keep.
 *
 * Why this lives in core and not in an adapter: the plan makes "a new CLI is one
 * subdirectory" structural only if the seam is something an adapter can
 * implement without core knowing which adapters exist. The layering checker
 * enforces the direction, so a seam placed in an adapter would let a
 * hook-based harness and a log-watching one enter the runtime by different
 * doors, and the game core would grow two vocabularies.
 *
 * FOUR DEPARTURES from upstream, each of which would otherwise read as a typo
 * when someone diffs this against pixel-agents:
 *
 * 1. The translation target is core's `GameEvent`, not a hook-shaped event of
 *    our own. Upstream defines its own `AgentEvent` union keyed on `kind`,
 *    which is right there because their runtime is theirs. Here it would be a
 *    second event vocabulary sitting beside the frozen one, and the whole point
 *    of the seam is that a hook-based harness and a log-watching one arrive at
 *    `runtime.emit` speaking the same type. A provider that had to mint its own
 *    event shapes would be a second front door into the game.
 * 2. `installHooks` takes a target object rather than a bare url and token. The
 *    upstream signature is two positional strings, and a caller cannot tell
 *    from the call which is the server and which is the credential.
 * 3. `stop()` returns a Promise. The watcher contract this seam settles is in
 *    `lifecycle.ts`, and the reasoning is there. Upstream's AgentWatcher returns
 *    void; that shape has nowhere to await a shutdown flush, and a hook
 *    provider that has buffered a batch has exactly that to do.
 * 4. Provider ids are namespaced and validated, because two harnesses that both
 *    call themselves "code" would otherwise share one installation, one consent
 *    record and one set of hooks. The same collision problem the feature-agent
 *    identity work solves one level up; this is the lower half of it.
 *
 * Zero imports outside this package, on purpose. `packages/core/package.json`
 * has no dependencies and the layering checker reads that as structural.
 */

import { NAMESPACED_ID_PATTERN } from './actions.js';
import type { GameEvent } from './event.js';

// ── The watcher lifecycle this seam settles ─────────────────────────────

/**
 * What every adapter implements, hook-based or log-watching.
 *
 * `stop` returns a Promise and that is the one deliberate difference from the
 * reference implementation, which returns void. A watcher that has buffered
 * activity — and a hook provider always buffers, because hooks arrive faster
 * than the bus drains — has a flush to await on the way down. A void `stop`
 * makes that flush fire-and-forget, and the session then ends with events
 * either dropped or delivered after the runtime has already torn down. The
 * sibling adapter beads are told to match this shape rather than the reference's.
 */
export interface AgentWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ── Hook provider ───────────────────────────────────────────────────────

/** Where a provider should send its hook payloads. */
export interface HookInstallTarget {
  /** Origin the harness posts to, e.g. `http://127.0.0.1:3000`. */
  readonly serverUrl: string;
  /** Bearer credential presented on every hook POST. */
  readonly authToken: string;
}

/** What a provider tells the user before its first write to their machine. */
export interface HookConsentDisclosure {
  /** One line naming the ask. */
  readonly headline: string;
  /**
   * The body: what is written where, what data moves, and how to undo it.
   * Paragraphs split on blank lines. A provider that installs anything must
   * state its terms, and shipping the text from the provider means no client
   * copy can drift from what the installer actually does.
   */
  readonly disclosure: string;
}

/** A raw harness payload, normalised into the one event type the runtime knows. */
export interface HookTranslation {
  /**
   * The harness's own session id. This is namespaced per provider before it
   * reaches anything durable, so a Codex session is never mistaken for a Claude
   * session that happens to share an id.
   */
  readonly sessionId: string;
  readonly event: GameEvent;
}

/**
 * A harness that can push events at us.
 *
 * One of two ways a harness reaches the runtime; the other is a watcher
 * reading a transcript. Both produce the same `GameEvent` and go through the
 * same `runtime.emit`, which is what keeps the game core ignorant of which
 * harnesses exist.
 */
export interface HookProvider {
  readonly kind: 'hook';
  /**
   * Stable id, lower-case and namespaced (`claude`, `copilot`, a future
   * `vendor-cli`). Never a bare harness name: installation, consent and hook
   * identity are all keyed on this, and two providers sharing it would share
   * all three.
   */
  readonly id: string;
  readonly displayName: string;
  /**
   * Bumped on any breaking change to what this provider emits. The runtime
   * refuses a version it does not understand rather than guessing at a payload.
   */
  readonly protocolVersion: number;

  /**
   * Translate one raw hook payload, or return null for something to ignore.
   * Returning null is normal and not an error: a harness may post events this
   * seam has no interest in, and dropping them here is cheaper than modelling
   * them.
   */
  translateHookEvent(raw: Readonly<Record<string, unknown>>): HookTranslation | null;

  installHooks(target: HookInstallTarget): Promise<void>;
  uninstallHooks(): Promise<void>;
  areHooksInstalled(): Promise<boolean>;
  consentDisclosure(): HookConsentDisclosure;

  /** Tools that should not raise a permission prompt, e.g. reads. */
  readonly permissionExemptTools: ReadonlySet<string>;
  /** Tools that spawn a subagent, so the UI can show it as one. */
  readonly subagentToolNames: ReadonlySet<string>;
  /** Tools that read rather than write, so the UI can pick the right animation. */
  readonly readingTools: ReadonlySet<string>;

  /**
   * Set only by a harness that has a lead-and-teammates model. Absent is the
   * normal case, and a single-agent adapter must not be made to write four
   * methods that always return nothing.
   */
  readonly team?: TeamProvider;
}

// ── Team provider, an optional extension ────────────────────────────────

/**
 * Optional extension for harnesses with a lead-and-teammates model.
 *
 * Absent for single-agent harnesses, and that absence is the normal case: this
 * is a capability some harnesses have, not a shape every adapter must satisfy.
 * A provider supplies its own storage strategy; core asks questions and never
 * reads the strategy's files.
 */
export interface TeamProvider {
  /** Teammates the given lead session can see. */
  discoverTeammates(leadSessionId: string): Promise<readonly string[]>;
  /** The members of the team a session belongs to, including the lead. */
  getTeamMembers(teamName: string): Promise<readonly string[]>;
  /** The team a session belongs to, or undefined when it belongs to none. */
  getTeamMetadataForSession(sessionId: string): Promise<{ readonly teamName: string } | undefined>;
  /** Whether a spawn call created a teammate rather than a plain subagent. */
  isTeammateSpawnCall(toolName: string, input: unknown): boolean;
}

// ── The guard that keeps the namespace honest ───────────────────────────

/**
 * A provider id: lower-case, at least two segments, dot separated.
 *
 * Two segments minimum is the same rule the action-id and capability-name
 * guards use, and for the same reason. A bare `claude` and a bare `copilot` are
 * both plausible ids, and the day a second one appears the first one's
 * installation, consent record and hooks are silently shared with it. Requiring
 * a namespace makes the collision a startup error instead of a support ticket.
 *
 * It IS the same rule, and now it is literally the same regex. This used to be
 * a second copy that had drifted — it allowed a hyphen in a later segment where
 * ACTION_ID_PATTERN did not — so vendor.some-cli was a valid provider and an
 * invalid action, while both files claimed one rule. The single pattern lives
 * in actions.ts; a test compares the two, so a future divergence is a red test
 * rather than a comment nobody believes.
 */
export const HOOK_PROVIDER_ID_PATTERN = NAMESPACED_ID_PATTERN;

/** Whether an id is shaped like a provider id. */
export function isHookProviderId(id: string): boolean {
  return HOOK_PROVIDER_ID_PATTERN.test(id);
}

/**
 * Prefix a harness's own session id with its provider, so the id is unique
 * across harnesses before anything persists it.
 *
 * The separator is `:` rather than `/` or `.` because harness session ids
 * contain hyphens and, for the CLIs that use UUIDs, neither of the other two.
 * Two harnesses minting the same raw id is not hypothetical; it is a collision
 * waiting for the first provider that does.
 */
export function namespacedSessionId(providerId: string, sessionId: string): string {
  if (!isHookProviderId(providerId)) {
    throw new Error(`provider id must be lower-case, dotted and namespaced, got "${providerId}"`);
  }
  return `${providerId}:${sessionId}`;
}
