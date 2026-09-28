import {
  DEFAULT_RESUME_GRACE_MS,
  isHeartbeatStale,
  isWithinResumeGrace,
  nextSessionStatus,
} from './session.js';
import type { SessionEndReason, SessionStatus } from './session.js';

/**
 * The HELLO handshake: an adapter announcing itself, and the server deciding
 * whether this is a returning character or a new one.
 *
 * This is the function the whole identity model exists to make correct. A
 * terminal closed and reopened is the SAME agent with a NEW session, and the
 * one thing that must never happen is a second character appearing for the same
 * person because the lookup was keyed on something transient like a process
 * name. Three concurrent Claudes are indistinguishable by process name, so
 * nothing here reads one.
 *
 * It is a pure function over a repository for the same reason the state machine
 * is: the resume-vs-new decision is the part worth testing exhaustively, and
 * testing it through HTTP and Postgres would test the plumbing instead.
 */

/** What an adapter sends when a run starts. */
export interface HelloRequest {
  /** Stable per install, so a returning process is recognised as the same machine. */
  readonly installationKey: string;
  /** The owner's login. Names are unique per owner, never globally. */
  readonly ownerId: string;
  /** The character being played. */
  readonly agentName: string;
  readonly harness: string;
  /** The repository or workspace. Absent means "no project context". */
  readonly projectKey?: string | undefined;
  /**
   * The id the HARNESS calls this run, when it has one.
   *
   * Recorded rather than used as an identity: a Claude Code adapter knows the id
   * in the transcript filename and the platform mints its own, so ingest needs
   * the mapping to find this row again. Absent means "this client posts under
   * the platform id", which is the MCP path and every test.
   */
  readonly harnessSessionRef?: string | undefined;
  readonly now: string;
}

export interface HelloResult {
  readonly sessionId: string;
  readonly installationId: string;
  readonly agentId: string;
  readonly projectId: string | null;
  /** True when an existing session was picked up rather than one created. */
  readonly resumed: boolean;
}

/** The storage the handshake needs, stated without naming a database. */
export interface SessionRepository {
  findOrCreateInstallation(input: {
    ownerId: string;
    installationKey: string;
    now: string;
  }): Promise<{ id: string }>;

  findAgentByName(ownerId: string, name: string): Promise<{ id: string } | undefined>;

  findOrCreateProject(input: {
    ownerId: string;
    name: string;
    now: string;
  }): Promise<{ id: string }>;

  /**
   * Sessions this agent could resume: disconnected, same installation and
   * project, newest first. Returning a list rather than one lets the caller
   * apply the grace window to each, which is a rule about time and belongs with
   * the time-based decision.
   */
  findResumableSessions(input: {
    agentId: string;
    installationId: string;
    projectId: string | null;
  }): Promise<readonly ResumableSession[]>;

  createSession(input: {
    agentId: string;
    installationId: string;
    projectId: string | null;
    now: string;
  }): Promise<{ id: string }>;

  markSessionActive(sessionId: string, now: string): Promise<void>;

  /**
   * Records that a run is still alive.
   *
   * Refused for anything but an active session, and the refusal is the point: a
   * heartbeat from a process that outlived its run must not resurrect a
   * character that has moved on. The sweeper decides what went quiet; a
   * heartbeat is evidence from the run itself and has no standing to undo that.
   */
  heartbeat(sessionId: string, now: string): Promise<SessionStatus | undefined>;

  /**
   * Ends a run, recording why.
   *
   * A run that ends is over even though its character is not — that is the
   * whole reason sessions and agents are different things. A late heartbeat
   * cannot reopen it.
   *
   * It reports the AGENT back as well as the status, and that is not a
   * convenience. An ending is an event, and §10.2's death rule pays the
   * character that crashed — so the event has to name a character. Returning
   * only a status left the emitter with nothing but the session id to put on
   * it, and a downstream feature that awards on the strength of an event will
   * award against whatever non-empty id it is given: the crash badge went into
   * `achievements` with a session id in its `agent_id` and the insert failed on
   * the foreign key. The agent is already in the row this updates, so returning
   * it costs no query; looking it up afterwards would be a second round trip to
   * learn something the first one had.
   */
  end(
    sessionId: string,
    reason: SessionEndReason,
    now: string,
  ): Promise<EndedSession | undefined>;
}

/** What ending a run reports back: how it ended, and whose run it was. */
export interface EndedSession {
  readonly status: SessionStatus;
  /** NOT NULL in the schema — every session belongs to exactly one agent. */
  readonly agentId: string;
}

export interface ResumableSession {
  readonly id: string;
  /** When the run stopped being live, which is what the grace window is measured from. */
  readonly statusChangedAt: string;
}

export interface HelloOptions {
  /** Overridable so the decision can be tested at its exact boundary. */
  readonly resumeGraceMs?: number;
}

export async function hello(
  repository: SessionRepository,
  request: HelloRequest,
  options: HelloOptions = {},
): Promise<HelloResult> {
  const graceMs = options.resumeGraceMs ?? DEFAULT_RESUME_GRACE_MS;

  const installation = await repository.findOrCreateInstallation({
    ownerId: request.ownerId,
    installationKey: request.installationKey,
    now: request.now,
  });

  const agent = await requireExistingAgent(repository, request);

  const project =
    request.projectKey === undefined
      ? null
      : await repository.findOrCreateProject({
          ownerId: request.ownerId,
          name: request.projectKey,
          now: request.now,
        });

  const candidates = await repository.findResumableSessions({
    agentId: agent.id,
    installationId: installation.id,
    projectId: project?.id ?? null,
  });

  const resumable = candidates.find((candidate) =>
    isWithinResumeGrace(candidate.statusChangedAt, request.now, graceMs),
  );

  if (resumable !== undefined) {
    await repository.markSessionActive(resumable.id, request.now);
    return {
      sessionId: resumable.id,
      installationId: installation.id,
      agentId: agent.id,
      projectId: project?.id ?? null,
      resumed: true,
    };
  }

  const created = await repository.createSession({
    agentId: agent.id,
    installationId: installation.id,
    projectId: project?.id ?? null,
    now: request.now,
    // Carried so ingest can find this row by the name the HARNESS knows it by.
    // Absent for a client that does not have one — the MCP path, a test — and
    // the column stays null, which is what "this harness names its runs
    // differently" looks like rather than an empty string that matches nothing.
    ...(request.harnessSessionRef === undefined
      ? {}
      : { harnessSessionRef: request.harnessSessionRef }),
  });
  return {
    sessionId: created.id,
    installationId: installation.id,
    agentId: agent.id,
    projectId: project?.id ?? null,
    resumed: false,
  };
}

/**
 * An agent must already exist before a session can.
 *
 * Not a convenience: creating the character here would create a second one
 * every time someone reopened a terminal, which is the exact failure the
 * identity model exists to prevent. Registering a character is a deliberate act
 * with a deliberate command; connecting a session is not.
 */
async function requireExistingAgent(
  repository: SessionRepository,
  request: HelloRequest,
): Promise<{ id: string }> {
  const agent = await repository.findAgentByName(request.ownerId, request.agentName);
  if (agent === undefined) {
    throw new UnknownAgentError(request.ownerId, request.agentName);
  }
  return agent;
}

/** No character of that name exists for that owner. */
export class UnknownAgentError extends Error {
  readonly ownerId: string;
  readonly agentName: string;

  constructor(ownerId: string, agentName: string) {
    super(`user ${ownerId} has no agent named "${agentName}"; register it first`);
    this.name = 'UnknownAgentError';
    this.ownerId = ownerId;
    this.agentName = agentName;
  }
}

/**
 * The sweep that reaps sessions nobody came back for.
 *
 * Kept next to the handshake rather than in a route, because it answers the
 * same question from the other side: which disconnected sessions are still
 * inside the window. A cron that duplicates this arithmetic is a cron that
 * eventually disagrees with the handshake about what "resumable" means, and the
 * disagreement shows up as a character that can be resumed by one path and not
 * by the other.
 *
 * The order matters. Active sessions are disconnected first and abandoned
 * afterwards, and the grace window is measured from when a session became
 * disconnected — so a session the same sweep just disconnected is not also
 * abandoned by it, however long it had been idle as an active session.
 */
export interface SweepResult {
  readonly disconnected: readonly string[];
  readonly abandoned: readonly string[];
}

export interface SweepRepository {
  findActiveSessions(): Promise<readonly { id: string; lastHeartbeatAt: string }[]>;
  findDisconnectedSessions(): Promise<readonly { id: string; statusChangedAt: string }[]>;
  markSessionStatus(sessionId: string, status: SessionStatus, now: string): Promise<void>;
}

export async function sweepStaleSessions(
  repository: SweepRepository,
  options: {
    readonly now: string;
    readonly heartbeatTimeoutMs: number;
    readonly resumeGraceMs: number;
  },
): Promise<SweepResult> {
  const disconnected: string[] = [];
  const abandoned: string[] = [];

  for (const session of await repository.findActiveSessions()) {
    const transition = isHeartbeatStale(
      session.lastHeartbeatAt,
      options.now,
      options.heartbeatTimeoutMs,
    )
      ? nextSessionStatus('active', { kind: 'disconnected' })
      : undefined;
    if (transition !== undefined) {
      await repository.markSessionStatus(session.id, transition, options.now);
      disconnected.push(session.id);
    }
  }

  for (const session of await repository.findDisconnectedSessions()) {
    const stillInGrace = isWithinResumeGrace(
      session.statusChangedAt,
      options.now,
      options.resumeGraceMs,
    );
    const transition = stillInGrace
      ? undefined
      : nextSessionStatus('disconnected', { kind: 'grace-expired' });
    if (transition !== undefined) {
      await repository.markSessionStatus(session.id, transition, options.now);
      abandoned.push(session.id);
    }
  }

  return { disconnected, abandoned };
}
