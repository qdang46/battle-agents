import type { AgentEvent } from '@battle-agents/protocol';
import { normalizeToolName } from '@battle-agents/protocol';

/**
 * Amp's vocabulary, translated.
 *
 * ## What is assumption and what is contract
 *
 * The record shape below is this adapter's reading of what Amp writes. That is
 * the one part of a file-watching adapter that cannot be derived from our side:
 * a real contributor substitutes their harness's actual on-disk format here and
 * nowhere else. Everything above and below this is fixed by the protocol, and
 * that split is the reason an adapter is one subdirectory.
 *
 * What is NOT assumed: that a new harness needs a new event type, a new tool
 * map, or a change to the protocol's harness enum. `amp` was already a member
 * of `harnessSchema` before this package existed, `normalizeToolName` already
 * answers for any tool name, and every event emitted below is a member of the
 * frozen union. An adapter that had needed any of those three would be the
 * finding this package exists to rule out.
 */

/** One parsed record, or null when the record is not worth emitting. */
export type ParsedLine = AgentEvent | null;

/** The identity a harness stamps on its own records, before we namespace it. */
export interface RawThreadRef {
  /** The thread id, exactly as it appears in Amp's files. */
  readonly threadId: string;
  /** Namespaced and lowercase. An unnamespaced id merges into someone else's. */
  readonly providerId: string;
}

/** The namespaced provider id for this adapter. */
export const AMP_PROVIDER_ID = 'sourcegraph.amp';

/**
 * Tool names are per-harness; the event is not.
 *
 * `read_file`, `Read` and `cat` are the same activity, and the activity log,
 * the zone map and the game client all key on the canonical name. Skipping this
 * produces a stream that is correct and unreadable, because every one of those
 * names becomes a separate thing.
 */
export function canonicalToolName(harnessName: string): string {
  return normalizeToolName(harnessName);
}

/**
 * The events this adapter can emit.
 *
 * It meets the template's list in full, which is a commitment rather than an
 * assertion: `tests/unit/adapter-contract.test.ts` deliberately does not hold
 * any adapter to this list, because the shipped ones do not all meet it. This
 * package's own tests are what make the claim true.
 */
export const REQUIRED_EVENT_TYPES: readonly string[] = [
  'session.started',
  'session.ended',
  'tool.started',
  'tool.completed',
];

/** One line of an Amp thread file, as this adapter reads it. */
export interface AmpRecord {
  readonly id?: unknown;
  readonly role?: unknown;
  readonly createdAt?: unknown;
  /** Present on a tool invocation: the tool's own name and arguments. */
  readonly toolName?: unknown;
  readonly input?: unknown;
  /** Present on a tool result: whether the call succeeded. */
  readonly ok?: unknown;
  readonly durationMs?: unknown;
  /** Present on a failed tool result. */
  readonly reason?: unknown;
  readonly stopReason?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * A record is only usable if it can be placed on the timeline.
 *
 * Two things make a record unusable and both are silent otherwise: a missing
 * timestamp and a missing thread id. An event with neither is a row in nobody's
 * replay, and emitting it anyway is how an activity log grows holes nobody
 * notices until a dispute needs the missing minute.
 */
function asRecord(value: unknown): AmpRecord | null {
  return isRecord(value) ? (value as AmpRecord) : null;
}

function timestampOf(record: AmpRecord): string | undefined {
  return typeof record.createdAt === 'string' && record.createdAt !== '' ? record.createdAt : undefined;
}

function toolOf(record: AmpRecord): string | undefined {
  return typeof record.toolName === 'string' && record.toolName !== '' ? record.toolName : undefined;
}

/**
 * One Amp record, or null.
 *
 * Null is a legitimate answer and is not a parse error: a record with no tool
 * name and no stop reason carries no activity, and a thread's first user
 * message is already accounted for by `session.started`. Dropping those is the
 * difference between a stream that is readable and one that is a transcript.
 */
export function parseRecord(value: unknown, ref: RawThreadRef): ParsedLine {
  const record = asRecord(value);
  if (record === null) return null;

  const at = timestampOf(record);
  if (at === undefined) return null;

  const tool = toolOf(record);
  if (tool !== undefined) {
    return toolResultOf(record, ref, at, tool) ?? toolStartOf(record, ref, at, tool);
  }

  if (record.stopReason !== undefined) {
    return {
      type: 'session.ended',
      sessionId: ref.threadId,
      at,
      reason: stopReasonOf(record.stopReason),
    };
  }

  return null;
}

function toolStartOf(
  record: AmpRecord,
  ref: RawThreadRef,
  at: string,
  tool: string,
): AgentEvent {
  return {
    type: 'tool.started',
    sessionId: ref.threadId,
    at,
    // The one place a harness's own spelling meets the game's. Skipping it
    // splits one activity across however many names the harness happens to use.
    tool: canonicalToolName(tool),
    ...(record.input === undefined ? {} : { input: record.input }),
  };
}

function toolResultOf(
  record: AmpRecord,
  ref: RawThreadRef,
  at: string,
  tool: string,
): AgentEvent | null {
  if (record.ok === undefined && record.durationMs === undefined) return null;

  // A failure is `tool.failed`, not `tool.completed` with ok:false, and the
  // protocol says why in so many words: the game reads a failed tool
  // differently from a tool that returned successfully with a false result, and
  // an adapter deciding between them from one exit path is exactly where that
  // distinction gets lost. An adapter is the only place this choice exists.
  if (record.ok === false) {
    return {
      type: 'tool.failed',
      sessionId: ref.threadId,
      at,
      tool: canonicalToolName(tool),
      ...(typeof record.reason === 'string' && record.reason !== ''
        ? { reason: record.reason }
        : {}),
    };
  }

  return {
    type: 'tool.completed',
    sessionId: ref.threadId,
    at,
    tool: canonicalToolName(tool),
    // Required by the schema, and there is no honest "unknown" to put here.
    // Zero says the harness did not measure it, which is what it means; omitting
    // it would be refused at the door with a 400 and take the whole batch.
    ok: true,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
  };
}

/**
 * Amp's stop reasons, mapped onto the three the protocol accepts.
 *
 * The default is `crashed` rather than `completed`, and that is a deliberate
 * asymmetry: a stop reason this adapter does not recognise is far more likely
 * to be a shape it has not seen than a session that genuinely finished, and
 * reporting an interrupted session as a completed one is the error a replay and
 * a dispute are settled from.
 */
function stopReasonOf(value: unknown): 'completed' | 'abandoned' | 'crashed' {
  if (value === 'completed' || value === 'end_turn' || value === 'stop') return 'completed';
  if (value === 'abandoned' || value === 'user_exit') return 'abandoned';
  return 'crashed';
}
