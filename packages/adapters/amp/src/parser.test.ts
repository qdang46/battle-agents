import { describe, expect, it } from 'vitest';

import { AgentEventSchema } from '@battle-agents/protocol';

import { canonicalToolName, parseRecord, REQUIRED_EVENT_TYPES, type RawThreadRef } from './parser.js';

/**
 * The parser, against the frozen union rather than against a local shape.
 *
 * `tests/unit/adapter-contract.test.ts` checks that the NAMES an adapter's
 * tests use are members of the union, and deliberately does not check per-harness
 * event coverage. These tests are what make this adapter's `REQUIRED_EVENT_TYPES`
 * claim true rather than aspirational — a claim the shared suite will not hold
 * it to.
 */

const REF: RawThreadRef = { threadId: 'T-1', providerId: 'sourcegraph.amp' };
const AT = '2026-09-27T10:00:00.000Z';

describe('parsing an Amp record', () => {
  it('emits tool.started with the tool name normalised', () => {
    const event = parseRecord(
      { role: 'assistant', createdAt: AT, toolName: 'read_file', input: { path: 'src/index.ts' } },
      REF,
    );

    expect(event).toMatchObject({
      type: 'tool.started',
      sessionId: 'T-1',
      at: AT,
      input: { path: 'src/index.ts' },
    });
    expect(event?.type === 'tool.started' ? event.tool : undefined).toBe(
      canonicalToolName('read_file'),
    );
  });

  it('emits tool.failed for a failure, not tool.completed with ok:false', () => {
    // The protocol separates these on purpose — "the game reads a failed tool
    // differently from a tool that returned successfully with a false result" —
    // and an adapter is the only place that choice exists. Collapsing them here
    // is the exact loss the schema's comment warns about.
    expect(
      parseRecord(
        { createdAt: AT, toolName: 'run_command', ok: false, durationMs: 12, reason: 'exit 1' },
        REF,
      ),
    ).toMatchObject({ type: 'tool.failed', tool: canonicalToolName('run_command'), reason: 'exit 1' });

    expect(
      parseRecord({ createdAt: AT, toolName: 'run_command', ok: true, durationMs: 5 }, REF),
    ).toMatchObject({ type: 'tool.completed', ok: true, durationMs: 5 });
  });

  it('fills the required fields when the harness measured nothing', () => {
    // `durationMs` is required by the schema and there is no honest "unknown"
    // to put there. Zero says the harness did not measure it, which is what it
    // means; omitting the field would be refused at the door with a 400 and take
    // the whole batch with it.
    const silent = parseRecord({ createdAt: AT, toolName: 'run_command', ok: true }, REF);
    expect(silent).toMatchObject({ type: 'tool.completed', ok: true, durationMs: 0 });
  });

  it('reads a record carrying no result marker as a start, not a result', () => {
    // There is nothing to tell a start from a result except a result marker, so
    // a record with neither `ok` nor a duration is a call being made. Reading it
    // as a completion would report a tool finishing before it started.
    expect(parseRecord({ createdAt: AT, toolName: 'run_command' }, REF)).toMatchObject({
      type: 'tool.started',
    });
  });

  it('emits session.ended, and reports an unrecognised stop as crashed', () => {
    expect(parseRecord({ createdAt: AT, stopReason: 'end_turn' }, REF)).toMatchObject({
      type: 'session.ended',
      reason: 'completed',
    });
    expect(parseRecord({ createdAt: AT, stopReason: 'user_exit' }, REF)).toMatchObject({
      reason: 'abandoned',
    });
    // The asymmetry is deliberate and asserted here so it cannot be flipped by
    // someone tidying the function: an unknown stop reason is far more likely
    // to be a shape this adapter has not seen than a session that finished.
    expect(parseRecord({ createdAt: AT, stopReason: 'something_new' }, REF)).toMatchObject({
      reason: 'crashed',
    });
  });

  it('returns null for a record that carries no activity', () => {
    // A thread's first user message is already accounted for by
    // session.started. Emitting it again would be a transcript, not a stream.
    expect(parseRecord({ role: 'user', createdAt: AT, content: 'hello' }, REF)).toBeNull();
    expect(parseRecord({ role: 'assistant', createdAt: AT, content: 'thinking' }, REF)).toBeNull();
  });

  it('returns null rather than throwing on a record it cannot place', () => {
    // A record with no timestamp, or that is not an object at all, has nowhere
    // to go on the timeline. Throwing would take the watcher down over one bad
    // line; emitting it anyway grows a hole nobody notices until a dispute.
    expect(parseRecord({ toolName: 'read_file' }, REF)).toBeNull();
    expect(parseRecord(null, REF)).toBeNull();
    expect(parseRecord('a string', REF)).toBeNull();
    expect(parseRecord({ createdAt: '', toolName: 'read_file' }, REF)).toBeNull();
  });

  it('produces only members of the frozen union', () => {
    // The real schema, not a local shape. `adapter-contract.test.ts` checks the
    // NAMES its tests use; this checks the values a real record produces,
    // which is the half a name check cannot see — a base-only probe is invalid
    // for every extended member, which is exactly how that suite's first version
    // reported a correct event as unknown.
    const records = [
      { createdAt: AT, toolName: 'read_file', input: { path: 'a' } },
      { createdAt: AT, toolName: 'run_command', ok: true, durationMs: 3 },
      { createdAt: AT, stopReason: 'end_turn' },
    ];
    for (const record of records) {
      const event = parseRecord(record, REF);
      expect(event).not.toBeNull();
      const result = AgentEventSchema.safeParse(event);
      expect(result.success, JSON.stringify(result.error?.issues ?? [])).toBe(true);
    }
  });

  it('declares the four event types the template requires, and can emit all four', () => {
    // The claim and the capability, in one test, because a list nothing emits
    // is the defect `REQUIRED_EVENT_TYPES` exists to prevent.
    expect([...REQUIRED_EVENT_TYPES]).toEqual([
      'session.started',
      'session.ended',
      'tool.started',
      'tool.completed',
    ]);
    // session.started is emitted by the watcher rather than parsed, so the
    // parser's own coverage is the other three; the watcher test covers the
    // fourth and the suite says so rather than implying otherwise.
    const emitted = new Set(
      [
        parseRecord({ createdAt: AT, toolName: 'read_file' }, REF),
        parseRecord({ createdAt: AT, toolName: 'run_command', ok: true, durationMs: 1 }, REF),
        parseRecord({ createdAt: AT, stopReason: 'end_turn' }, REF),
      ]
        .filter((event) => event !== null)
        .map((event) => event?.type),
    );
    expect([...emitted].sort()).toEqual(['session.ended', 'tool.completed', 'tool.started']);
  });
});
