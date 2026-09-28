import { and, desc, eq, isNull } from 'drizzle-orm';

import type { Database } from '../client.js';
import { agents, installations, projects, sessions } from '../schema/index.js';
import type { SessionEndReason, SessionStatus } from '../schema/index.js';

/**
 * Postgres storage for the session lifecycle.
 *
 * It does not import the agent feature, for the same reason the agent
 * repository does not: infrastructure may not depend on the layers that
 * consume it. The shapes here are the ones the feature's session contract
 * declares, and the composition root's call site is where the two are checked
 * against each other.
 *
 * `statusChangedAt` is not a column. It is derived: for a disconnected session
 * it is when the session stopped, which is the moment the sweeper last moved
 * it, and for the resume decision that is the only timestamp that matters.
 * Storing it would be a second source of truth for something already implied.
 */

export class DrizzleSessionRepository {
  readonly #database: Database;
  constructor(database: Database) {
    this.#database = database;
  }

  /**
   * A session, but only for the installation that owns it.
   *
   * The event ingest route is handed a session id by an agent and a caller from
   * a presented credential, and those two are separate inputs: the id is chosen
   * by the agent and is therefore attacker-controlled, the installation comes
   * from a token that was not. Joining the two here rather than fetching the
   * session and comparing in a route is the difference between a check that
   * cannot be forgotten and one that can — a route that fetched by id alone and
   * compared afterwards would work right up until the day somebody added a
   * second call site.
   *
   * A session belonging to somebody else is `undefined`, the same answer as one
   * that does not exist, so the route cannot be used to discover which session
   * ids are real.
   */
  async findOwnedByInstallation(
    sessionId: string,
    installationId: string,
  ): Promise<{ id: string; agentId: string; status: SessionStatus } | undefined> {
    const [row] = await this.#database
      .select({
        id: sessions.id,
        agentId: sessions.agentId,
        status: sessions.status,
      })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.installationId, installationId)))
      .limit(1);
    return row;
  }

  async findOrCreateInstallation(input: {
    ownerId: string;
    installationKey: string;
    now: string;
  }): Promise<{ id: string }> {
    const [created] = await this.#database
      .insert(installations)
      .values({
        userId: input.ownerId,
        installationKey: input.installationKey,
        lastSeenAt: new Date(input.now),
      })
      .onConflictDoUpdate({
        // Scoped to the owner, matching the unique index. Targeting the bare key
        // matched any user's row, so a colliding key silently returned
        // somebody else's installation and the session built on top of it
        // pointed at their data.
        target: [installations.userId, installations.installationKey],
        // Touched on every handshake so "last seen" answers the question the
        // dashboard actually asks, which is when this machine was last in use.
        set: { lastSeenAt: new Date(input.now) },
      })
      .returning({ id: installations.id });
    return requiredId(created, 'installation');
  }

  async findAgentByName(ownerId: string, name: string): Promise<{ id: string } | undefined> {
    const [row] = await this.#database
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.userId, ownerId), eq(agents.name, name)))
      .limit(1);
    return row === undefined ? undefined : { id: row.id };
  }

  async findOrCreateProject(input: {
    ownerId: string;
    name: string;
    now: string;
  }): Promise<{ id: string }> {
    const [created] = await this.#database
      .insert(projects)
      .values({ userId: input.ownerId, name: input.name })
      .onConflictDoNothing()
      .returning({ id: projects.id });
    if (created !== undefined) {
      return { id: created.id };
    }
    // No unique index on (user, name), so a concurrent handshake can lose the
    // race and insert nothing. Falling back to a read means two handshakes
    // arriving together still agree on one project rather than diverging.
    const [existing] = await this.#database
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.userId, input.ownerId), eq(projects.name, input.name)))
      .limit(1);
    return requiredId(existing, 'project');
  }

  async findResumableSessions(input: {
    agentId: string;
    installationId: string;
    projectId: string | null;
  }): Promise<readonly { id: string; statusChangedAt: string }[]> {
    const projectMatches =
      input.projectId === null
        ? isNull(sessions.projectId)
        : eq(sessions.projectId, input.projectId);
    const rows = await this.#database
      .select({
        id: sessions.id,
        // endedAt is set when a run stops for any reason, so it is the closest
        // thing to "when this stopped being live" that the table already holds.
        statusChangedAt: sessions.endedAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.agentId, input.agentId),
          eq(sessions.installationId, input.installationId),
          eq(sessions.status, 'disconnected'),
          projectMatches,
        ),
      )
      .orderBy(desc(sessions.endedAt));
    return rows
      .filter((row) => row.statusChangedAt !== null)
      .map((row) => ({ id: row.id, statusChangedAt: row.statusChangedAt!.toISOString() }));
  }

  async createSession(input: {
    agentId: string;
    installationId: string;
    projectId: string | null;
    now: string;
    /**
     * The id the HARNESS uses for this run, when it has one.
     *
     * Stored rather than used as the primary key, deliberately: the platform
     * owns `sessions.id` and does not let a client name a session. What it does
     * do is remember which of the harness's own runs this is, so `POST /api/
     * events` — which is addressed by the harness's id, because the adapter
     * derived it from a filename — can find the row. See
     * `findOwnedByHarnessRef`.
     */
    readonly harnessSessionRef?: string | undefined;
  }): Promise<{ id: string }> {
    const startedAt = new Date(input.now);
    const [created] = await this.#database
      .insert(sessions)
      .values({
        agentId: input.agentId,
        installationId: input.installationId,
        projectId: input.projectId,
        startedAt,
        lastHeartbeatAt: startedAt,
        harnessSessionRef: input.harnessSessionRef ?? null,
      })
      .returning({ id: sessions.id });
    return requiredId(created, 'session');
  }

  /**
   * Finds a session by the name ITS HARNESS uses, scoped to one installation.
   *
   * The second half of the pairing `createSession` starts: an adapter posts
   * events under the id Claude Code wrote into a filename, and the platform has
   * to find the row the handshake created for it. Without this the real adapter
   * is refused with `no such session` on every batch forever, which is what
   * happens when a column exists, is seeded, and is read by nothing.
   *
   * Ownership is in the query for the same reason `findOwnedByInstallation` has
   * it: a ref is guessable — it is a filename — so a lookup that did not scope
   * it would let one installation write events into another's run.
   *
   * A ref that matches nothing is `undefined`, the same answer as an id that
   * does not exist, so this cannot be used to discover which harness session ids
   * are real.
   */
  async findOwnedByHarnessRef(
    harnessSessionRef: string,
    installationId: string,
  ): Promise<{ id: string; agentId: string; status: string } | undefined> {
    const [row] = await this.#database
      .select({ id: sessions.id, agentId: sessions.agentId, status: sessions.status })
      .from(sessions)
      .where(
        and(
          eq(sessions.harnessSessionRef, harnessSessionRef),
          eq(sessions.installationId, installationId),
        ),
      )
      .limit(1);
    return row;
  }

  async markSessionActive(sessionId: string, now: string): Promise<void> {
    const at = new Date(now);
    await this.#database
      .update(sessions)
      .set({ status: 'active', endedAt: null, lastHeartbeatAt: at })
      .where(eq(sessions.id, sessionId));
  }

  /**
   * Touches a run that is still alive.
   *
   * The `status = 'active'` predicate is load-bearing: without it a heartbeat
   * from a process that outlived its run would move an ended or abandoned
   * session back to active, and the sweeper would never reap it again.
   */
  async heartbeat(sessionId: string, now: string): Promise<SessionStatus | undefined> {
    const [row] = await this.#database
      .update(sessions)
      .set({ lastHeartbeatAt: new Date(now) })
      .where(and(eq(sessions.id, sessionId), eq(sessions.status, 'active')))
      .returning({ status: sessions.status });
    return row?.status;
  }

  /** Ends a run. The character it played is untouched, by design. */
  async end(
    sessionId: string,
    reason: SessionEndReason,
    now: string,
  ): Promise<{ readonly status: SessionStatus; readonly agentId: string } | undefined> {
    const [row] = await this.#database
      .update(sessions)
      .set({ status: 'ended', endReason: reason, endedAt: new Date(now) })
      .where(and(eq(sessions.id, sessionId), eq(sessions.status, 'active')))
      .returning({ status: sessions.status, agentId: sessions.agentId });
    if (row === undefined) {
      return undefined;
    }
    return { status: row.status, agentId: row.agentId };
  }
}

/** A sweeper over the same table, for the cron that reaps stale sessions. */
export class DrizzleSessionSweeper {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  /**
   * Who is in the world, as CHARACTERS rather than as session ids.
   *
   * `findActiveSessions` answers the sweeper's question — which sessions are
   * alive — and its rows carry no identity, because nothing downstream of the
   * sweeper needs any. The world view does: a client opening the event stream
   * gets a `full_state` snapshot, and with session ids alone the game client can
   * only draw one anonymous figure per session standing in the plaza. Joining to
   * `agents` here is what lets a character arrive with its name, harness and
   * level instead of being a placeholder waiting for a delta that may never come.
   *
   * A session whose agent row is missing is DROPPED rather than sent with nulls.
   * That should not happen — the session resolved an agent when it was created —
   * and if it does, a character with no name is the one figure in the city that
   * is visibly a lie, so the honest answer is to leave it out.
   */
  async findLivePresence(): Promise<
    readonly {
      readonly sessionId: string;
      readonly agentId: string;
      readonly agentName: string;
      readonly harness: string;
      readonly level: number;
    }[]
  > {
    const rows = await this.#database
      .select({
        sessionId: sessions.id,
        agentId: agents.id,
        agentName: agents.name,
        harness: agents.harness,
        level: agents.level,
      })
      .from(sessions)
      .innerJoin(agents, eq(agents.id, sessions.agentId))
      .where(eq(sessions.status, 'active'));

    return rows.map((row) => ({
      sessionId: row.sessionId,
      agentId: row.agentId,
      agentName: row.agentName,
      harness: row.harness,
      level: row.level,
    }));
  }

  async findActiveSessions(): Promise<readonly { id: string; lastHeartbeatAt: string }[]> {
    const rows = await this.#database
      .select({
        id: sessions.id,
        lastHeartbeatAt: sessions.lastHeartbeatAt,
        startedAt: sessions.startedAt,
      })
      .from(sessions)
      .where(eq(sessions.status, 'active'));
    return rows.map((row) => ({
      id: row.id,
      // A session that never sent a heartbeat is judged from when it started.
      // Treating the absence as "not stale" would keep a session that died
      // between being created and first reporting in alive forever.
      lastHeartbeatAt: (row.lastHeartbeatAt ?? row.startedAt).toISOString(),
    }));
  }

  async findDisconnectedSessions(): Promise<readonly { id: string; statusChangedAt: string }[]> {
    const rows = await this.#database
      .select({ id: sessions.id, endedAt: sessions.endedAt })
      .from(sessions)
      .where(eq(sessions.status, 'disconnected'));
    return rows
      .filter((row) => row.endedAt !== null)
      .map((row) => ({ id: row.id, statusChangedAt: row.endedAt!.toISOString() }));
  }

  async markSessionStatus(sessionId: string, status: SessionStatus, now: string): Promise<void> {
    // Typed, not a string. The column is text rather than a Postgres enum, so
    // nothing downstream would reject a typo: the status would be written, no
    // query would ever match it again, and the session would be stranded. The
    // cast is a no-op on a text column and is gone.
    await this.#database
      .update(sessions)
      .set({ status, endedAt: new Date(now) })
      .where(eq(sessions.id, sessionId));
  }
}

/**
 * A write that should have created a row and did not.
 *
 * Thrown rather than returned as undefined: the caller asked to create
 * something, so an absent row is a broken invariant, and continuing would hand
 * back a session id that does not exist.
 */
function requiredId(row: { id: string } | undefined, what: string): { id: string } {
  if (row === undefined) {
    throw new Error(`database returned no ${what} for a write that should have created one`);
  }
  return row;
}
