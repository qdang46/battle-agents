/**
 * The world store: normalized events in, a dirty-set out.
 *
 * Plan section 25 asks for an event-emitter store. The emitter is the small
 * half; the reason this file exists at all is the other half, which the plan
 * states as a performance clause and this file turns into a shape:
 *
 * **A delta marks the agents it touched. It does not invalidate the world.**
 *
 * A store that bumps a `version` counter on every event and lets the renderer
 * re-read everything is correct in every screenshot and costs O(scene) per
 * frame, forever. The shape here makes that mistake unrepresentable: the only
 * thing an event produces is a set of dirty agent ids, and the renderer is
 * handed that set rather than the store. So the expensive thing is not merely
 * discouraged, it has nowhere to go — the reconciler cannot see the whole scene
 * even if it wanted to.
 *
 * `applyDelta` returns what changed instead of publishing a "something
 * changed" signal, because the second is a claim a caller has to resolve by
 * diffing and the first is the diff. The emitter exists for the two things that
 * genuinely are world-wide — hydration and a dropped connection — and both of
 * those are rare by construction.
 *
 * Empty until the first `full_state`. Not "empty because nothing has happened
 * yet" — empty because a client that quietly seeds state from a fixture renders
 * beautifully and is lying, and the test that catches it is the assertion that
 * this map has no entries before the first frame.
 */

import type { GameEvent } from '@battle-agents/core';

import { ZONE_FOR_EVENT, zoneForTool } from '../zones.js';
import type { ZoneId } from '@battle-agents/protocol';

/** Everything the world draws about one agent. */
export interface AgentView {
  readonly agentId: string;
  readonly sessionId: string;
  /**
   * What the world calls this character, when the snapshot said.
   *
   * Absent for a client hydrating from bare `liveSessionIds`, which is the older
   * snapshot shape. It is a display concern and nothing derives from it: the
   * store keys on `sessionId` and the view draws whatever is here.
   */
  readonly name: string | undefined;
  /** Progression level, from the agent row. Undefined when the snapshot had none. */
  readonly level: number | undefined;
  /** Absent until a `session.started` says which harness is running. */
  readonly harness: string | undefined;
  readonly zone: ZoneId;
  /** The tool the agent is working with, or undefined when it is not working. */
  readonly tool: string | undefined;
  /** Subagents this agent has spawned, by child session id. */
  readonly children: readonly string[];
  /** False once `session.ended` has been seen. The agent stays on the map. */
  readonly online: boolean;
}

export type StoreListener = (change: StoreChange) => void;

/**
 * What changed, in terms the renderer can act on.
 *
 * `hydrated` and `resync` are the two world-wide cases, and they are the reason
 * a full re-read is not always wrong: a reconnect hands over a fresh snapshot
 * that may contradict every delta since the last one, so there is nothing
 * cheaper to do than rebuild. Both carry no agent ids, so a renderer that
 * handles them correctly does not have to know how big the scene is.
 */
export type StoreChange =
  | { readonly kind: 'agents-dirty'; readonly agentIds: readonly string[] }
  | { readonly kind: 'hydrated'; readonly agentIds: readonly string[] }
  | { readonly kind: 'resync' };

/**
 * The opening snapshot.
 *
 * Mirrors the `full_state` frame's `state` object. It is read as a structural
 * type rather than imported from apps/web, because the game client is
 * presentation and apps/web is a different presentation surface: the wire shape
 * is the contract between them, and importing the server's own type would make
 * a server refactor a client typecheck failure.
 */
export interface WorldSnapshot {
  readonly protocolVersion: string;
  readonly liveSessionIds: readonly string[];
  /**
   * The same sessions, described well enough to draw.
   *
   * Optional because a server that predates it sends only the ids, and a client
   * that insists on this field would then hydrate an EMPTY world from a stream
   * that plainly listed nineteen agents. Preferring it when present is what turns
   * a nameless figure in the plaza into a character with a name, a harness and a
   * level; ignoring it when absent is what keeps an older server usable.
   */
  readonly liveAgents?: readonly {
    readonly sessionId: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly harness: string;
    readonly level: number;
    readonly zone: string;
  }[];
}

/** A payload as the reducer reads it. The wire types it as `unknown`. */
type Payload = Readonly<Record<string, unknown>>;

function payloadOf(event: GameEvent): Payload {
  const payload: unknown = event.payload;
  return typeof payload === 'object' && payload !== null ? (payload as Payload) : {};
}

function stringAt(payload: Payload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const EMPTY: readonly string[] = Object.freeze([]);

export class WorldStore {
  readonly #agents = new Map<string, AgentView>();
  readonly #listeners = new Set<StoreListener>();
  #hydrated = false;
  #protocolVersion: string | undefined;

  /**
   * Installs the opening snapshot, discarding anything held.
   *
   * Discards rather than merges because a snapshot is authoritative: a client
   * that merged would keep an agent the server no longer lists, and the only
   * symptom would be a ghost walking the city forever.
   */
  hydrate(snapshot: WorldSnapshot): void {
    this.#agents.clear();
    this.#protocolVersion = snapshot.protocolVersion;
    this.#hydrated = true;

    // `liveAgents` when the server sends it, `liveSessionIds` when it does not.
    //
    // It used to be the second branch only, and that is why every character in
    // the Coding City was anonymous: a snapshot that names sessions produces one
    // figure per session with no name, no harness and a fixed zone, and a delta
    // only arrives for work that HAPPENS AFTER you connected. An agent that
    // finished its run an hour ago stayed a placeholder in the plaza forever,
    // which is a map full of ghosts rather than of people.
    const described = snapshot.liveAgents;
    if (described !== undefined && described.length > 0) {
      for (const live of described) {
        this.#agents.set(live.sessionId, {
          agentId: live.agentId,
          sessionId: live.sessionId,
          name: live.agentName,
          level: live.level,
          harness: live.harness as AgentView['harness'],
          zone: (live.zone.length > 0 ? live.zone : 'idle') as ZoneId,
          tool: undefined,
          children: EMPTY,
          online: true,
        });
      }
      this.#publish({ kind: 'hydrated', agentIds: [...this.#agents.keys()] });
      return;
    }

    for (const sessionId of snapshot.liveSessionIds) {
      this.#agents.set(sessionId, {
        agentId: sessionId,
        name: undefined,
        level: undefined,
        sessionId,
        harness: undefined,
        zone: 'idle',
        tool: undefined,
        children: EMPTY,
        online: true,
      });
    }
    this.#publish({ kind: 'hydrated', agentIds: [...this.#agents.keys()] });
  }

  /**
   * Applies one delta and returns the agents it touched.
   *
   * Returns an empty list for an event that carries no world state — a
   * heartbeat, a test result, an event type the client does not draw. The
   * alternative, mapping those onto some agent's zone, is how a client ends up
   * walking to the terminal because a test passed.
   */
  applyDelta(event: GameEvent): readonly string[] {
    if (!this.#hydrated) {
      // A delta before the opening snapshot would patch a world that does not
      // exist yet. Dropping it is correct: the snapshot is taken before the
      // subscriber joins the broadcast, so this ordering cannot happen against
      // a real server, and ignoring it keeps a malformed stream from inventing
      // agents.
      return EMPTY;
    }
    const payload = payloadOf(event);
    const sessionId = stringAt(payload, 'sessionId');
    if (sessionId === undefined) return EMPTY;

    const patch = this.#reduce(event, sessionId, payload);
    if (patch === undefined) return EMPTY;

    const dirty: string[] = [];
    for (const [key, next] of patch) {
      const current = this.#agents.get(key);
      // Written only when a field actually differs. A view that reassigns on
      // every event touches the sprite and the transform for a no-op, which is
      // the O(scene) cost wearing a smaller hat.
      if (current === undefined || !sameView(current, next)) {
        this.#agents.set(key, next);
        dirty.push(key);
      }
    }
    if (dirty.length > 0) this.#publish({ kind: 'agents-dirty', agentIds: dirty });
    return dirty;
  }

  /**
   * Tells every listener the world is untrustworthy and must be rebuilt.
   *
   * Called when the stream ends. A delta stream cannot survive a gap, so the
   * hub closes a subscriber that fell behind rather than skipping frames for
   * it; the client's only correct response is to stop patching and wait for a
   * fresh `full_state`.
   */
  invalidate(): void {
    this.#publish({ kind: 'resync' });
  }

  #reduce(
    event: GameEvent,
    sessionId: string,
    payload: Payload,
  ): Map<string, AgentView> | undefined {
    const base = this.#agents.get(sessionId) ?? {
      agentId: sessionId,
      name: undefined,
      level: undefined,
      sessionId,
      harness: undefined,
      zone: 'idle' as ZoneId,
      tool: undefined,
      children: EMPTY,
      online: true,
    };
    const patch = new Map<string, AgentView>();

    switch (event.type) {
      case 'session.started': {
        patch.set(
          sessionId,
          patching(base, {
            agentId: stringAt(payload, 'agentId') ?? base.agentId,
            harness: stringAt(payload, 'harness'),
            online: true,
            zone: 'idle',
            tool: undefined,
          }),
        );
        return patch;
      }
      case 'session.ended': {
        patch.set(sessionId, patching(base, { online: false, tool: undefined, zone: 'idle' }));
        return patch;
      }
      case 'tool.started': {
        const tool = stringAt(payload, 'tool');
        if (tool === undefined) return undefined;
        // The one place a tool becomes a place on the map. It calls the shared
        // table rather than reading a local copy, so a zone the protocol adds
        // is routed here without a change in this package.
        patch.set(sessionId, patching(base, { tool, zone: zoneForTool(tool) }));
        return patch;
      }
      case 'tool.completed':
      case 'tool.failed': {
        patch.set(sessionId, patching(base, { tool: undefined, zone: 'idle' }));
        return patch;
      }
      case 'waiting': {
        patch.set(sessionId, patching(base, { tool: undefined, zone: 'idle' }));
        return patch;
      }
      case 'thinking': {
        patch.set(sessionId, patching(base, { tool: undefined, zone: 'thinking' }));
        return patch;
      }
      case 'permission.requested': {
        const tool = stringAt(payload, 'tool');
        if (tool === undefined) return undefined;
        patch.set(sessionId, patching(base, { tool, zone: zoneForTool(tool) }));
        return patch;
      }
      case 'subagent.spawned': {
        const child = stringAt(payload, 'childSessionId');
        if (child === undefined) return undefined;
        const children = base.children.includes(child) ? base.children : [...base.children, child];
        patch.set(sessionId, patching(base, { children }));
        // The child is a real character on the map, spawned at the parent's
        // zone because nothing else has placed it yet.
        patch.set(child, {
          agentId: child,
          sessionId: child,
          // A subagent has no name of its own yet. Its parent's is deliberately
          // NOT borrowed: two characters on one map both called Claude is a worse
          // lie than one called by its id, and the child's own `session.started`
          // replaces this as soon as it reports in.
          name: undefined,
          level: undefined,
          harness: base.harness,
          zone: base.zone,
          tool: undefined,
          children: EMPTY,
          online: true,
        });
        return patch;
      }
      case 'subagent.completed': {
        const child = stringAt(payload, 'childSessionId');
        if (child === undefined) return undefined;
        const children = base.children.filter((id) => id !== child);
        patch.set(sessionId, patching(base, { children }));
        patch.set(child, patching(this.#agents.get(child) ?? emptyView(child), { online: false }));
        return patch;
      }
      default: {
        // An event type the world does not draw. The zone table is consulted
        // anyway so that a type added to the protocol routes without a change
        // here, but a type with no zone is not drawn rather than guessed at.
        const zone = ZONE_FOR_EVENT[event.type];
        if (zone === undefined) return undefined;
        patch.set(sessionId, patching(base, { zone, tool: stringAt(payload, 'tool') }));
        return patch;
      }
    }
  }

  get(agentId: string): AgentView | undefined {
    return this.#agents.get(agentId);
  }

  /**
   * Every known agent.
   *
   * Exists for `rebuild()`, which runs on hydration and resync and genuinely
   * needs the whole world. It is NOT on the delta path: `applyDelta` returns
   * the ids it touched, and the renderer is handed those, so a per-event caller
   * iterating this is a bug the counting test catches rather than a path this
   * package encourages.
   */
  allAgents(): readonly AgentView[] {
    return [...this.#agents.values()];
  }

  /** How many agents are known. Used by tests, never by the render path. */
  get size(): number {
    return this.#agents.size;
  }

  get hydrated(): boolean {
    return this.#hydrated;
  }

  get protocolVersion(): string | undefined {
    return this.#protocolVersion;
  }

  subscribe(listener: StoreListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Notifies from a copy, because a listener that unsubscribes itself while
   * being called would otherwise mutate the set mid-iteration.
   */
  #publish(change: StoreChange): void {
    for (const listener of [...this.#listeners]) listener(change);
  }
}

function emptyView(sessionId: string): AgentView {
  return {
    agentId: sessionId,
    name: undefined,
    level: undefined,
    sessionId,
    harness: undefined,
    zone: 'idle',
    tool: undefined,
    children: EMPTY,
    online: true,
  };
}

function patching(base: AgentView, changes: Partial<AgentView>): AgentView {
  return { ...base, ...changes };
}

function sameView(left: AgentView, right: AgentView): boolean {
  return (
    left.agentId === right.agentId &&
    left.name === right.name &&
    left.level === right.level &&
    left.sessionId === right.sessionId &&
    left.harness === right.harness &&
    left.zone === right.zone &&
    left.tool === right.tool &&
    left.online === right.online &&
    // Identity, not contents: `with` preserves the array it was handed, so a
    // field the event did not touch still compares equal to itself and only a
    // rebuild allocates.
    left.children === right.children
  );
}
