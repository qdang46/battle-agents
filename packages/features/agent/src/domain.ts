/**
 * Agent identity: the four id classes the plan keeps apart, and why blurring
 * any two of them is expensive.
 *
 *   User          a human, authenticated by GitHub. Owns things.
 *   Agent         a persistent character. Survives every terminal closing.
 *   Installation  a machine or container the agent runs on.
 *   Session       one run. Ends; the character does not.
 *
 * A credential is a fifth thing and deliberately not here: it is a revocable
 * secret rather than an identity, so it is modelled as a value the agent
 * feature stores, not as something that identifies anything.
 *
 * The ids are branded so they cannot be passed for one another. All four are
 * UUIDs in the database, which means a plain `string` lets `sessions.agent_id`
 * quietly receive a user id, and nothing complains until a character's history
 * is attributed to the wrong person.
 */

declare const brand: unique symbol;

/** A value of type T that is only T, produced by whatever created it. */
export type Branded<T, TBrand extends string> = T & { readonly [brand]?: TBrand };

/** The human. Never an agent. */
export type UserId = Branded<string, 'UserId'>;

/** The persistent character. Survives terminal close. */
export type AgentId = Branded<string, 'AgentId'>;

/** A machine the agent runs on: laptop, server, WSL, container. */
export type InstallationId = Branded<string, 'InstallationId'>;

/** One run of one agent on one installation. */
export type SessionId = Branded<string, 'SessionId'>;

/** A repository or workspace the agent is working in. */
export type ProjectId = Branded<string, 'ProjectId'>;

/** Which coding agent is behind the character. */
export type Harness =
  'claude' | 'codex' | 'opencode' | 'cursor' | 'pi' | 'gemini' | 'amp' | 'other';

/** Whether the character is reachable right now. */
export type AgentPresence = 'offline' | 'online' | 'busy' | 'disconnected';

const HARNESSES: ReadonlySet<string> = new Set<Harness>([
  'claude',
  'codex',
  'opencode',
  'cursor',
  'pi',
  'gemini',
  'amp',
]);

/**
 * Narrows whatever the store returned to a harness this domain knows.
 *
 * A store column is free text: a new coding agent ships an adapter before the
 * domain grows an entry for it, and an agent that cannot be recognised is still
 * an agent. 'other' is the escape hatch, so a character is never dropped
 * because its harness is newer than the code reading it.
 */
export function toHarness(stored: string): Harness {
  return HARNESSES.has(stored) ? (stored as Harness) : 'other';
}

/**
 * The character.
 *
 * Level, xp and reputation are here because the row is where they live, not
 * because this feature decides them: progression and reputation are separate
 * features that own those numbers. An agent that never plays a game still has
 * this record, with the counters at their defaults.
 */
export interface AgentIdentity {
  readonly id: AgentId;
  readonly ownerId: UserId;
  readonly name: string;
  readonly harness: Harness;
  readonly level: number;
  readonly xp: number;
  readonly reputation: number;
  readonly presence: AgentPresence;
  readonly lastSeenAt: string | null;
  readonly createdAt: string;
}

/** A machine an agent runs on. One user has many, possibly across devices. */
export interface Installation {
  readonly id: InstallationId;
  readonly ownerId: UserId;
  /**
   * Generated once per install and presented by the adapter on every handshake.
   * Stable across sessions, which is what lets a returning process be matched
   * to the installation it used last time rather than to a new one.
   */
  readonly installationKey: string;
  readonly label: string | null;
  readonly lastSeenAt: string | null;
}

/** A registered character that does not exist yet. */
export interface NewAgent {
  readonly ownerId: UserId;
  readonly name: string;
  readonly harness: Harness;
}

export const MIN_AGENT_NAME_LENGTH = 1;

/**
 * Why a proposed name cannot be used.
 *
 * Returned rather than thrown so a caller can show the reason, and so a
 * registration that fails because of a typo says so instead of reporting a
 * conflict. `name-taken` is deliberately absent: whether a name is free depends
 * on what the owner already has, which only the store knows.
 */
export type AgentNameRejection =
  | { readonly reason: 'name-empty' }
  | { readonly reason: 'name-too-long'; readonly max: number }
  | { readonly reason: 'name-reserved' };

export const MAX_AGENT_NAME_LENGTH = 64;

/**
 * Names the runtime will not let a user take, because they read as system
 * identities in the UI and in command output.
 */
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set([
  'agent',
  'all',
  'everyone',
  'none',
  'root',
  'system',
]);

/**
 * The one place a name is judged acceptable.
 *
 * It lives here rather than in the command handler because a caller validating
 * a name before submitting and the handler validating it on arrival have to
 * agree; two copies of the same rule is how one of them stops being updated.
 * Returns the reason rather than a boolean so the caller learns which rule it
 * broke instead of only that it broke one.
 */
export function whyAgentNameIsRejected(name: string): AgentNameRejection | undefined {
  const trimmed = name.trim();
  if (trimmed.length < MIN_AGENT_NAME_LENGTH) {
    return { reason: 'name-empty' };
  }
  if (name.length > MAX_AGENT_NAME_LENGTH) {
    return { reason: 'name-too-long', max: MAX_AGENT_NAME_LENGTH };
  }
  if (RESERVED_AGENT_NAMES.has(trimmed.toLowerCase())) {
    return { reason: 'name-reserved' };
  }
  return undefined;
}

/** The machine-readable half, for events and error payloads. */
export function describeRejection(rejection: AgentNameRejection): string {
  return rejection.reason === 'name-too-long' ? `name-too-long:${rejection.max}` : rejection.reason;
}

/* ───────────────────────────── the four actions that read a payload ───────────────────────────── */

/**
 * Every way this feature refuses a payload, or undefined when it accepts one.
 *
 * One union across all four reading actions: the reason exists to be written
 * into a sentence, and a caller that wanted to know WHICH action it was had
 * just named it.
 */
export type AgentInputRejection =
  | { readonly reason: 'not-an-object' }
  | { readonly reason: 'owner-id-not-a-string' }
  | { readonly reason: 'owner-id-empty' }
  | { readonly reason: 'agent-id-not-a-string' }
  | { readonly reason: 'agent-id-empty' }
  | { readonly reason: 'session-id-not-a-string' }
  | { readonly reason: 'session-id-empty' }
  | { readonly reason: 'reason-not-a-string' }
  | { readonly reason: 'installation-key-not-a-string' }
  | { readonly reason: 'installation-key-empty' }
  | { readonly reason: 'agent-name-not-a-string' }
  | { readonly reason: 'harness-not-a-string' }
  | { readonly reason: 'harness-empty' }
  | { readonly reason: 'project-key-not-a-string' }
  | { readonly reason: 'harness-session-ref-not-a-string' }
  | { readonly reason: 'harness-session-ref-empty' }
  | AgentNameRejection;

/**
 * The handshake, as a caller sends it.
 *
 * `harness` is typed rather than a bare string because the protocol fixes the
 * vocabulary: a harness this build does not know is a client and a server that
 * disagree about what happened, and it is better refused at the door than stored.
 */
export interface CreateSessionInput {
  readonly installationKey: string;
  readonly ownerId: UserId;
  readonly agentName: string;
  readonly harness: Harness;
  readonly projectKey?: string | undefined;
  /**
   * The session id the HARNESS uses, when it has one.
   *
   * This is the field that makes a real adapter possible, and its absence is why
   * `agent-battle-claude` runs, reads a real Claude Code transcript, and is then
   * refused with `no such session` forever.
   *
   * The two sides each own an id and neither was reading the other's. The
   * platform mints `sessions.id` from the database, so it can never be the
   * filename Claude Code wrote; the adapter derives the harness id from that
   * filename, so it can never be the platform's. `harness_session_ref` is the
   * column that was already in the schema, seeded with a value, and read by
   * nothing.
   *
   * So the handshake records what the harness calls this run, and ingest
   * resolves by it. The platform keeps its own id — a harness is not trusted to
   * name a session, only to say which of its own runs this is — and the two are
   * joined here rather than by letting either side mint the other's.
   */
  readonly harnessSessionRef?: string | undefined;
}

/**
 * Why a `session.create` cannot be asked for, or undefined when it can.
 *
 * Validated from `unknown` for the same reason every other input here is: `act()`
 * hands the payload through as a generic, so an annotation here would be a claim
 * nothing checked. This is the one action that CREATES the row every other action
 * then reads, so a field arriving as the wrong type would be written straight
 * into the sessions table rather than refused somewhere downstream.
 */
export function whyCreateSessionIsRejected(input: unknown): AgentInputRejection | undefined {
  if (typeof input !== 'object' || input === null) {
    return { reason: 'not-an-object' };
  }
  const { installationKey, ownerId, agentName, harness, projectKey, harnessSessionRef } = input as {
    readonly installationKey?: unknown;
    readonly ownerId?: unknown;
    readonly agentName?: unknown;
    readonly harness?: unknown;
    readonly projectKey?: unknown;
    readonly harnessSessionRef?: unknown;
  };

  if (typeof installationKey !== 'string') {
    return { reason: 'installation-key-not-a-string' };
  }
  if (installationKey.length === 0) {
    return { reason: 'installation-key-empty' };
  }
  if (typeof ownerId !== 'string') {
    return { reason: 'owner-id-not-a-string' };
  }
  if (ownerId.length === 0) {
    return { reason: 'owner-id-empty' };
  }
  if (typeof agentName !== 'string') {
    return { reason: 'agent-name-not-a-string' };
  }
  // The reserved and over-long name rules are the ones agent.register already
  // applies. Reusing them rather than restating them is the point: a name the
  // register would refuse must not become reachable by creating a session
  // instead, or the rule is a suggestion with two doors.
  const nameProblem = whyAgentNameIsRejected(agentName);
  if (nameProblem !== undefined) {
    return nameProblem;
  }
  if (typeof harness !== 'string') {
    return { reason: 'harness-not-a-string' };
  }
  if (harness.length === 0) {
    return { reason: 'harness-empty' };
  }
  // NOT checked against HARNESSES, on purpose. This domain already decided the
  // question in `toHarness`: 'other' is the escape hatch so a character is never
  // dropped because its harness is newer than the code reading it. A new coding
  // agent ships an adapter before the domain grows an entry for it, and refusing
  // its handshake would mean the newest adapters — the ones this repository is
  // built to add — could not start a session at all.
  // Absent is allowed — "no project context" is a real state, hello() types it
  // as optional. Present-and-wrong is not: it would reach a project lookup that
  // expects a key.
  if (projectKey !== undefined && typeof projectKey !== 'string') {
    return { reason: 'project-key-not-a-string' };
  }
  // Same rule as `projectKey`, for the same reason: a ref that arrives as the
  // wrong type is written straight into a TEXT column and then never matches a
  // lookup, so a real adapter is refused with `no such session` and the operator
  // has nothing to act on. Refusing here names the field instead.
  if (harnessSessionRef !== undefined && typeof harnessSessionRef !== 'string') {
    return { reason: 'harness-session-ref-not-a-string' };
  }
  if (typeof harnessSessionRef === 'string' && harnessSessionRef.trim() === '') {
    return { reason: 'harness-session-ref-empty' };
  }
  return undefined;
}

export function isCreateSessionInput(input: unknown): input is CreateSessionInput {
  return whyCreateSessionIsRejected(input) === undefined;
}

/** Listing a person's characters. */
export interface DescribeAgentsInput {
  readonly ownerId: UserId;
}

/** Reading one of them, which is the only way a character is ever looked up. */
export interface ReadAgentInput extends DescribeAgentsInput {
  readonly agentId: AgentId;
}

/** One run being told it is still alive. */
export interface HeartbeatSessionInput {
  readonly sessionId: string;
}

/** One run being told it is over. `reason` is optional; an absent one is a crash. */
export interface EndSessionInput {
  readonly sessionId: string;
  readonly reason?: string;
}

/**
 * Why an `agent.describe` cannot be asked for, or undefined when it can.
 *
 * The owner id is what scopes the query, and the store scopes it with an
 * equality, so an unchecked one matched nothing and answered with an empty
 * list — the same answer a user who has just signed up gets. The mistake was
 * invisible from the outside, which is the whole problem with it.
 */
export function whyDescribeAgentsIsRejected(input: unknown): AgentInputRejection | undefined {
  if (typeof input !== 'object' || input === null) {
    return { reason: 'not-an-object' };
  }
  return whyOwnerIdIsMissing((input as { readonly ownerId?: unknown }).ownerId);
}

/**
 * Why an `agent.read` cannot be asked for, or undefined when it can.
 *
 * Both ids, because the one this action exists to enforce is that a character
 * is only ever read by its owner: a missing `ownerId` with a present `agentId`
 * is the shape that turns "look up one of the caller's own characters" into
 * "look up this character".
 */
export function whyReadAgentIsRejected(input: unknown): AgentInputRejection | undefined {
  if (typeof input !== 'object' || input === null) {
    return { reason: 'not-an-object' };
  }
  const { ownerId, agentId } = input as {
    readonly ownerId?: unknown;
    readonly agentId?: unknown;
  };

  const missingOwner = whyOwnerIdIsMissing(ownerId);
  if (missingOwner !== undefined) {
    return missingOwner;
  }
  if (typeof agentId !== 'string') {
    return { reason: 'agent-id-not-a-string' };
  }
  if (agentId.length === 0) {
    return { reason: 'agent-id-empty' };
  }
  return undefined;
}

/** Why a `session.heartbeat` cannot be asked for, or undefined when it can. */
export function whyHeartbeatSessionIsRejected(input: unknown): AgentInputRejection | undefined {
  if (typeof input !== 'object' || input === null) {
    return { reason: 'not-an-object' };
  }
  return whySessionIdIsMissing((input as { readonly sessionId?: unknown }).sessionId);
}

/**
 * Why a `session.end` cannot be asked for, or undefined when it can.
 *
 * The reason is checked as a string and NOT against `SESSION_END_REASONS`,
 * because unrecognised input becoming 'crashed' is a decision this feature
 * makes on purpose (see `toEndReason`): a caller inventing a value is a thing
 * to absorb, not a thing to refuse, and refusing it would move the choice onto
 * every caller instead of leaving it in one place. A reason that is not a
 * string at all is a different mistake, and is the one refused here.
 */
export function whyEndSessionIsRejected(input: unknown): AgentInputRejection | undefined {
  if (typeof input !== 'object' || input === null) {
    return { reason: 'not-an-object' };
  }
  const { sessionId, reason } = input as {
    readonly sessionId?: unknown;
    readonly reason?: unknown;
  };

  const missing = whySessionIdIsMissing(sessionId);
  if (missing !== undefined) {
    return missing;
  }
  if (reason !== undefined && typeof reason !== 'string') {
    return { reason: 'reason-not-a-string' };
  }
  return undefined;
}

/**
 * The same four judgements, as guards.
 *
 * These narrow to the BRANDED ids rather than to `string`, and that is worth
 * being precise about: a brand here is a phantom symbol, so no runtime check
 * could ever have confirmed one. What the guard does is hand the caller the
 * type the actions are declared in terms of, so a payload that arrives from
 * `act()` cannot silently be a different id class than the code below it is
 * written against. The runtime half of the claim is `typeof === 'string'`, and
 * that is the half this function actually checks.
 */
export function isDescribeAgentsInput(input: unknown): input is DescribeAgentsInput {
  return whyDescribeAgentsIsRejected(input) === undefined;
}

export function isReadAgentInput(input: unknown): input is ReadAgentInput {
  return whyReadAgentIsRejected(input) === undefined;
}

export function isHeartbeatSessionInput(input: unknown): input is HeartbeatSessionInput {
  return whyHeartbeatSessionIsRejected(input) === undefined;
}

export function isEndSessionInput(input: unknown): input is EndSessionInput {
  return whyEndSessionIsRejected(input) === undefined;
}

/** What each action wanted, as a sentence the caller can act on. */
export const DESCRIBE_AGENTS_SHAPE =
  'A listing takes an ownerId, which must be a non-empty string.';
export const READ_AGENT_SHAPE =
  'A read takes an ownerId and an agentId, both of which must be non-empty strings.';
export const SESSION_ACTION_SHAPE =
  'A session action takes a sessionId, which must be a non-empty string, and for an end an optional reason, which must be a string.';

/**
 * The error a refused payload becomes.
 *
 * Built from the verdict, never from the payload: the caller guaranteed to be
 * handed the answer is the one that must not be reading the input.
 */
export function agentInputRejected(
  action: string,
  rejection: AgentInputRejection,
  expected: string,
): Error {
  return Object.assign(new Error(`${action} rejected: ${rejection.reason}. ${expected}`), {
    code: 'malformed-input',
  });
}

function whyOwnerIdIsMissing(ownerId: unknown): AgentInputRejection | undefined {
  if (typeof ownerId !== 'string') {
    return { reason: 'owner-id-not-a-string' };
  }
  if (ownerId.length === 0) {
    return { reason: 'owner-id-empty' };
  }
  return undefined;
}

function whySessionIdIsMissing(sessionId: unknown): AgentInputRejection | undefined {
  if (typeof sessionId !== 'string') {
    return { reason: 'session-id-not-a-string' };
  }
  if (sessionId.length === 0) {
    return { reason: 'session-id-empty' };
  }
  return undefined;
}
