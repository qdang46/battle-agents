import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from '@battle-agents/protocol';

import { AmpWatcher } from './watcher.js';

/**
 * The watcher, against real files.
 *
 * A watcher test that fakes the filesystem cannot catch the two failures this
 * loop actually has: a partially written last line, and a file that shrinks.
 * Both are ordinary events on a thread file, and both produce a stream that is
 * wrong in a way nothing downstream can detect.
 */

const AT = '2026-09-27T10:00:00.000Z';
const THREAD = 'T-1';

let dir: string;
let path: string;
let sent: AgentEvent[][];

function watcher(overrides: Partial<ConstructorParameters<typeof AmpWatcher>[0]> = {}) {
  return new AmpWatcher({
    threadPath: path,
    threadId: THREAD,
    agentId: 'A-1',
    installationId: 'I-1',
    projectId: 'P-1',
    send: async (batch) => {
      sent.push([...batch]);
    },
    now: () => AT,
    ...overrides,
  });
}

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amp-watcher-'));
  path = join(dir, 'thread.jsonl');
  sent = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the Amp watcher', () => {
  it('emits session.started on start, which the file does not contain', async () => {
    const w = watcher();
    await w.start();
    await w.stop();

    expect(sent.flat().map((event) => event.type)).toEqual(['session.started']);
    expect(sent.flat()[0]).toMatchObject({
      sessionId: THREAD,
      agentId: 'A-1',
      installationId: 'I-1',
      projectId: 'P-1',
      harness: 'amp',
    });
  });

  it('reads only what was appended since the last tick', async () => {
    writeFileSync(path, line({ createdAt: AT, toolName: 'read_file' }));
    const w = watcher();
    await w.start();
    await w.stop();
    const afterFirst = sent.flat().length;

    // A second start on the same watcher must not re-read what it already read.
    // This is the property a line count gets wrong after a truncation, and the
    // one that makes a replay disagree with itself.
    appendFileSync(path, line({ createdAt: AT, toolName: 'write_file' }));
    expect(w.readNewRecords().map((event) => event.type)).toEqual(['tool.started']);
    expect(w.readNewRecords()).toEqual([]);
    expect(sent.flat().length).toBe(afterFirst);
  });

it('does not lose a record when an earlier one holds a multi-byte character', () => {
    // THE REGRESSION THIS FILE EXISTS FOR.
    //
    // The cursor advanced by  — bytes — and was applied to a
    // string read with utf8, which indexes CHARACTERS. For ASCII the two agree and
    // every test above passes. A prompt containing  is four bytes and one
    // character, so after it the cursor sat three bytes too far along, and the
    // next read began inside a record.
    //
    // A record cut in half does not fail loudly: JSON.parse throws, the catch
    // below it swallows, and the cursor has ALREADY moved past the line. The
    // record is not deferred to the next tick — it is gone. One emoji in one
    // prompt cost every tool call after it, and nothing reported it.
    writeFileSync(path, line({ createdAt: AT, toolName: 'read_file', path: 'a/🐛/b.ts' }));
    const w = watcher();
    w.start();
    const first = w.readNewRecords();
    expect(first.map((event) => event.type)).toEqual(['tool.started']);

    appendFileSync(path, line({ createdAt: AT, toolName: 'write_file' }));
    const second = w.readNewRecords();
    expect(second.map((event) => event.type)).toEqual(['tool.started']);
  });

  it('leaves a half-written line for the next tick rather than dropping it', async () => {
    // A thread file is appended to, so a reader can land between two writes.
    // Parsing the partial line would drop the record; advancing the offset past
    // it would drop it AND skip whatever completes it.
    //
    // The file is written after start(), because start() reads once and the
    // assertion here is about what a later read does.
    const w = watcher();
    await w.start();
    writeFileSync(path, `{"createdAt":"${AT}","toolName":"read_fi`);
    expect(w.readNewRecords()).toEqual([]);

    appendFileSync(path, `le","input":{}}\n`);
    expect(w.readNewRecords().map((event) => event.type)).toEqual(['tool.started']);
  });

  it('treats a shrunken file as new rather than re-emitting its history', async () => {
    // The replacement is deliberately SHORTER than what it replaces. That is
    // the case the byte offset is there for, and a first version of this test
    // replaced a short line with a longer one — saw no shrink, sliced from the
    // middle of a record, and read nothing, which is the same green it would
    // have been had the reset never been written.
    writeFileSync(path, line({ createdAt: AT, toolName: 'read_file', input: { path: 'a/very/long/path'.repeat(8) } }));
    const w = watcher();
    await w.start();
    expect(w.readNewRecords()).toHaveLength(0);

    // The user cleared the thread. A line count would be past the end and would
    // either re-read everything or read nothing, depending on which way it
    // happened to be implemented; a byte offset resets and reads the new file.
    writeFileSync(path, line({ createdAt: AT, toolName: 'read_file' }));
    expect(w.readNewRecords().map((event) => event.type)).toEqual(['tool.started']);
  });

  it('skips a line that is not JSON without stopping', async () => {
    // One bad line must not take the watcher down: the whole session's history
    // would stop arriving, and the gap would look like an idle agent.
    writeFileSync(
      path,
      `not json at all\n${line({ createdAt: AT, toolName: 'read_file' })}\n`,
    );
    const w = watcher();
    await w.start();
    // stop() before asserting, because the buffer flushes on a timer and a
    // record read during start() is still sitting in it. Asserting straight
    // after start() would be asserting the timer's schedule, not the reader.
    await w.stop();

    expect(sent.flat().map((event) => event.type)).toEqual([
      'session.started',
      'tool.started',
    ]);
  });

  it('flushes what is left on stop, because a shutdown is when a partial batch matters', async () => {
    // The buffer's flush is on a timer. Stopping before it fires must still
    // deliver, or a short session ends with its last events dropped and nobody
    // can tell the difference from an agent that went quiet.
    writeFileSync(path, line({ createdAt: AT, toolName: 'read_file' }));
    const w = watcher();
    await w.start();
    const before = sent.flat().length;
    await w.stop();

    expect(sent.flat().length).toBeGreaterThanOrEqual(before);
    expect(sent.flat().map((event) => event.type)).toContain('tool.started');
  });

  it('emits all four required event types across a whole session', async () => {
    // The claim `REQUIRED_EVENT_TYPES` makes, discharged. The shared contract
    // suite deliberately does not hold adapters to it, so this is the only place
    // it is true for this one.
    writeFileSync(
      path,
      [
        line({ createdAt: AT, toolName: 'read_file' }),
        line({ createdAt: AT, toolName: 'run_command', ok: true, durationMs: 7 }),
        line({ createdAt: AT, stopReason: 'end_turn' }),
      ].join(''),
    );
    const w = watcher();
    await w.start();
    await w.stop();

    expect(new Set(sent.flat().map((event) => event.type))).toEqual(
      new Set(['session.started', 'tool.started', 'tool.completed', 'session.ended']),
    );
  });

  it('survives a thread file that does not exist yet', async () => {
    // A watcher started before Amp has written anything is the normal case, not
    // an error: an adapter that throws here cannot be started at boot.
    const w = watcher({ threadPath: join(dir, 'not-created-yet.jsonl') });
    await expect(w.start()).resolves.toBeUndefined();
    await expect(w.stop()).resolves.toBeUndefined();
  });
});
