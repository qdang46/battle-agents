import { defineAction } from '@battle-agents/core';
import type { CommandHandler, GameEvent, GameFeature, RuntimeContext } from '@battle-agents/core';
import { SESSION_EVENTS } from '@battle-agents/protocol';

import {
  agentInputRejected,
  DESCRIBE_AGENTS_SHAPE,
  describeRejection,
  isCreateSessionInput,
  isDescribeAgentsInput,
  isEndSessionInput,
  isHeartbeatSessionInput,
  isReadAgentInput,
  READ_AGENT_SHAPE,
  SESSION_ACTION_SHAPE,
  whyCreateSessionIsRejected,
  toHarness,
  whyAgentNameIsRejected,
  whyDescribeAgentsIsRejected,
  whyEndSessionIsRejected,
  whyHeartbeatSessionIsRejected,
  whyReadAgentIsRejected,
  type AgentId,
  type Harness,
  type UserId,
} from './domain.js';
import {
  AGENT_NAME_TAKEN,
  isAgentStorageFailure,
  type AgentRepository,
  type StoredAgent,
} from './repository.js';
import { hello, type SessionRepository } from './hello.js';
import { SESSION_END_REASONS, type SessionEndReason } from './session.js';

export const AGENT_REGISTERED = 'agent.registered';
export const AGENT_REGISTRATION_REJECTED = 'agent.registration_rejected';

/** The payload of `session.ended`, which is what a battle's pause clock reads. */
export interface SessionEndedPayload {
  readonly sessionId: string;
  /** Whose run ended. Consumers that award read this, or the actor. */
  readonly agentId: string;
  readonly reason: SessionEndReason;
}

/**
 * The payload of `session.recovered` — §10.2's death rule, the 150 XP a crash
 * pays. `sessionId` is carried so a reader can tie the award to the run that
 * earned it; progression pays on sight and needs no other field.
 */
export interface SessionRecoveredPayload {
  readonly sessionId: string;
  readonly agentId: string;
  readonly reason: SessionEndReason;
}

/**
 * What this feature offers other features.
 *
 * Nothing may look up a character by id alone: a capability that hands out an
 * agent without an owner invites the exact bug the repository interface is
 * shaped to prevent.
 */
export const AGENT_READ = 'agent.read';
export const AGENT_DESCRIBE = 'agent.describe';

/** The two operations a run needs while it is going, and only while storage is wired. */
export const SESSION_CREATE = 'session.create';
export const SESSION_HEARTBEAT = 'session.heartbeat';
export const SESSION_END = 'session.end';

export interface RegisterAgentPayload {
  readonly ownerId: UserId;
  readonly name: string;
  readonly harness: Harness;
}

export interface AgentRegisteredPayload {
  readonly agentId: string;
  readonly ownerId: string;
  readonly name: string;
  readonly harness: Harness;
}

export interface AgentRegistrationRejectedPayload {
  readonly ownerId: string;
  readonly name: string;
  readonly reason: string;
}

/** One character, as a caller is allowed to see it. */
export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly harness: Harness;
  readonly presence: string;
  readonly level: number;
}

/**
 * The agent feature: who the characters are, and who may act as them.
 *
 * It owns nothing else. XP, reputation, presence and session lifecycle belong
 * to other features that react to `agent.registered`, which is the whole reason
 * features are not allowed to import one another — the reaction is the contract.
 */
export function agentFeature(dependencies: {
  readonly repository: AgentRepository;
  /**
   * Session storage. Optional, so a host that only registers characters can run
   * without wiring storage it does not use: the session actions are then absent
   * rather than registered and throwing. `discover` reports the difference, and
   * a required dependency would force every caller to provide it.
   */
  readonly sessionRepository?: SessionRepository;
}): GameFeature {
  const { repository, sessionRepository } = dependencies;

  const registerAgent: CommandHandler<RegisterAgentPayload> = {
    type: 'agent.register',
    async handle(command, context) {
      const { ownerId, name, harness } = command.payload;
      const nameRejection = whyAgentNameIsRejected(name);
      if (nameRejection !== undefined) {
        return [rejection(context, ownerId, name, describeRejection(nameRejection))];
      }

      try {
        const created = await repository.create(
          { ownerId, name: name.trim(), harness },
          context.now(),
        );
        return [
          {
            type: AGENT_REGISTERED,
            occurredAt: context.now(),
            actorId: ownerId,
            payload: {
              agentId: created.id,
              ownerId,
              name: created.name,
              harness: toHarness(created.harness),
            } satisfies AgentRegisteredPayload,
          },
        ];
      } catch (error) {
        // Only the one expected failure becomes a rejection. Anything else is a
        // real fault and propagates: reporting a dropped connection as "that
        // name is taken" would send the caller off to rename a character that
        // was never the problem.
        if (isAgentStorageFailure(error, AGENT_NAME_TAKEN)) {
          return [rejection(context, ownerId, name, 'name-taken')];
        }
        throw error;
      }
    },
  };

  return {
    id: 'agent',
    commands: [registerAgent],
    // `session.ended` is in core's durable set already; `session.recovered` is
    // not, so this feature is the only thing that can make the death rule's
    // award survive a restart. It is declared here rather than in core because
    // core knows nothing about what a crashed session is worth to the game.
    persistedEvents: [
      AGENT_REGISTERED,
      AGENT_REGISTRATION_REJECTED,
      SESSION_EVENTS.started,
      SESSION_EVENTS.resumed,
      SESSION_EVENTS.recovered,
    ],
    capabilities: [
      { name: AGENT_READ, description: 'Look up one of the callers own characters.' },
      { name: AGENT_DESCRIBE, description: 'List the characters the caller owns.' },
    ],
    actionDefs: [
      ...(sessionRepository === undefined ? [] : sessionActions(sessionRepository)),
      // Both take `unknown` and are guarded. The annotation they used to carry
      // was never checked: `act()` hands the payload through as a generic, so
      // `act('agent.describe', {})` compiled clean and answered with an empty
      // list, which is the same answer a brand-new user gets — and
      // `act('agent.read', { agentId })` asked for a character with no owner at
      // all, which is the one lookup this feature exists to refuse.
      defineAction({
        id: AGENT_DESCRIBE,
        permissions: [AGENT_DESCRIBE],
        run: async (input: unknown) => {
          if (!isDescribeAgentsInput(input)) {
            throw agentInputRejected(
              AGENT_DESCRIBE,
              whyDescribeAgentsIsRejected(input) ?? { reason: 'not-an-object' },
              DESCRIBE_AGENTS_SHAPE,
            );
          }
          return describeFor(repository, input.ownerId);
        },
      }),
      defineAction({
        id: AGENT_READ,
        permissions: [AGENT_READ],
        run: async (input: unknown) => {
          if (!isReadAgentInput(input)) {
            throw agentInputRejected(
              AGENT_READ,
              whyReadAgentIsRejected(input) ?? { reason: 'not-an-object' },
              READ_AGENT_SHAPE,
            );
          }
          return describeFor(repository, input.ownerId, input.agentId);
        },
      }),
    ],
  };
}

async function describeFor(
  repository: AgentRepository,
  ownerId: UserId,
  agentId?: AgentId,
): Promise<readonly AgentSummary[]> {
  const agents =
    agentId === undefined
      ? await repository.listForOwner(ownerId)
      : [await repository.requireOwned(ownerId, agentId)];
  return agents.map(toSummary);
}

function toSummary(agent: StoredAgent): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    harness: toHarness(agent.harness),
    presence: agent.presence,
    level: agent.level,
  };
}

function rejection(
  context: RuntimeContext,
  ownerId: UserId,
  name: string,
  reason: string,
): GameEvent {
  return {
    type: AGENT_REGISTRATION_REJECTED,
    occurredAt: context.now(),
    actorId: ownerId,
    payload: { ownerId, name, reason } satisfies AgentRegistrationRejectedPayload,
  };
}

/**
 * The actions a running session needs, or none at all.
 *
 * Returning an empty list rather than actions that throw keeps `discover` honest:
 * a host with no session storage has no session operations, and saying so is
 * what lets a caller find that out without triggering a failure.
 */
function sessionActions(sessionRepository: SessionRepository) {
  return [
    defineAction({
      id: SESSION_CREATE,
      permissions: [SESSION_CREATE],
      run: async (input: unknown, context) => {
        if (!isCreateSessionInput(input)) {
          throw agentInputRejected(
            SESSION_CREATE,
            whyCreateSessionIsRejected(input) ?? { reason: 'not-an-object' },
            SESSION_ACTION_SHAPE,
          );
        }
        // `now` is the runtime's clock rather than a field the caller supplies.
        // The caller's clock is exactly what a hostile or simply-skewed client
        // would control, and this row decides whether a session is inside its
        // resume grace window.
        const result = await hello(sessionRepository, { ...input, now: context.now() });

        // THE PRODUCER THIS EVENT HAD BEEN MISSING.
        //
        // `session.started` is in the protocol's `PUBLISHED_WHOLE` set, the
        // public stream carries it whole, and the game client's store reduces it
        // into a character standing in the city. Nothing emitted it: the action
        // returned the handshake's result and stopped, so a session began, a row
        // was written, and the world never heard about it. `/city` read "every
        // character here arrived as an event" and could never show one.
        //
        // Found by running the game, not by reading it: the stream answered
        // `full_state` with `liveSessionIds: []` and then nothing, forever, and
        // a live session created through the real handshake changed nothing.
        //
        // A RESUME emits `session.resumed` rather than a second `started`,
        // because the character did not start again — it is the same run picked
        // back up, and a spectator counting characters should not see one
        // arrive twice for one session.
        await context.runtime.emit({
          type: result.resumed ? SESSION_EVENTS.resumed : SESSION_EVENTS.started,
          occurredAt: context.now(),
          actorId: result.agentId,
          payload: {
            sessionId: result.sessionId,
            agentId: result.agentId,
            harness: input.harness,
            ...(result.projectId === null ? {} : { projectId: result.projectId }),
          },
        });
        return result;
      },
    }),
    defineAction({
      id: SESSION_HEARTBEAT,
      permissions: [SESSION_HEARTBEAT],
      run: async (input: unknown, context) => {
        if (!isHeartbeatSessionInput(input)) {
          throw agentInputRejected(
            SESSION_HEARTBEAT,
            whyHeartbeatSessionIsRejected(input) ?? { reason: 'not-an-object' },
            SESSION_ACTION_SHAPE,
          );
        }
        const status = await sessionRepository.heartbeat(input.sessionId, context.now());
        if (status === undefined) {
          throw new Error(`session ${input.sessionId} is not running`);
        }
        return { sessionId: input.sessionId, status };
      },
    }),
    defineAction({
      id: SESSION_END,
      permissions: [SESSION_END],
      run: async (input: unknown, context) => {
        if (!isEndSessionInput(input)) {
          throw agentInputRejected(
            SESSION_END,
            whyEndSessionIsRejected(input) ?? { reason: 'not-an-object' },
            SESSION_ACTION_SHAPE,
          );
        }
        const reason = toEndReason(input.reason);
        const ended = await sessionRepository.end(input.sessionId, reason, context.now());
        if (ended === undefined) {
          throw new Error(`session ${input.sessionId} is not running`);
        }
        const { status, agentId } = ended;

        // Ending a session used to be a state change and nothing else, so an
        // ending that came through the protocol was invisible to everything
        // downstream: the battle pause clock, the activity trail, the public
        // stream and the crash badge all learned about endings only from a
        // harness reporting one. Two ways to end a run, and the one a client
        // calls by hand was the one nothing could see.
        //
        // `actorId` is the session's AGENT, matching what `toGameEvent` does on
        // the ingest path, and that is not a detail. A consumer that awards on
        // the strength of an event reads the actor and treats any non-empty id
        // as a character — achievements warns only when there is nothing to
        // read. Putting the session id here looks like a character to every one
        // of them, and `achievements.agent_id` is a foreign key, so the crash
        // badge died on insert rather than being refused. `sessionId` is in the
        // payload as well, because battle's pause clock looks battles up by it.
        //
        // A harness that ALSO reports the ending produces a second event, which
        // is safe by construction rather than by luck: battle asks
        // `nextBattleStatus` for the transition and an already-paused battle has
        // none, and the award is keyed so a repeat is refused.
        await context.runtime.emit({
          type: SESSION_EVENTS.ended,
          occurredAt: context.now(),
          actorId: agentId,
          payload: { sessionId: input.sessionId, agentId, reason } satisfies SessionEndedPayload,
        });

        // And §10.2's death rule, which had a price and no producer at all:
        // HP 0 never kills the character, a crashed session grants experience,
        // and nothing in the tree emitted the event that pays it. A run that
        // ended any other way is not a death, so it pays nothing.
        //
        // The badge is a separate thing on a separate event: achievements reads
        // `session.ended` and gates on `reason === 'crashed'`, while this is the
        // 150 XP. Two consumers, two events, and this one had nobody producing
        // it — a price nothing pays fails no test.
        if (reason === 'crashed') {
          await context.runtime.emit({
            type: SESSION_EVENTS.recovered,
            occurredAt: context.now(),
            actorId: agentId,
            payload: { sessionId: input.sessionId, agentId, reason } satisfies SessionRecoveredPayload,
          });
        }

        return { sessionId: input.sessionId, status, reason };
      },
    }),
  ];
}

/**
 * An ending a session row can hold.
 *
 * Unrecognised input becomes 'crashed' rather than being passed through: a
 * caller inventing a reason would otherwise write a value no reader of this
 * codebase knows how to interpret, and the column is an enum precisely so that
 * cannot happen quietly.
 */
function toEndReason(reason: string | undefined): SessionEndReason {
  return SESSION_END_REASONS.includes(reason as SessionEndReason)
    ? (reason as SessionEndReason)
    : 'crashed';
}
