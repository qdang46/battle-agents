import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { clearSession, readSession, writeSession } from './session.js';

/**
 * The file holds a bearer token, so the assertions that matter are about
 * permissions and about a corrupted file not bricking the command.
 */
function scratchFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'agent-battle-')), 'session.json');
}

describe('the stored session', () => {
  it('round-trips a base URL and token', () => {
    const path = scratchFile();
    writeSession({ baseUrl: 'http://api.test', token: 'secret' }, path);

    expect(readSession(path)).toEqual({ baseUrl: 'http://api.test', token: 'secret' });
  });

  // Windows has no POSIX permission bits: Node synthesises 0o666 for a writable
  // file regardless of what chmod was asked for, so the assertion below cannot
  // pass there and its failure says nothing about the credential. Skipping is
  // the honest response — a test that fails on a platform that cannot express
  // the property trains people to ignore the one test guarding it.
  const PERMISSIONS_APPLY = process.platform !== 'win32';

  it.skipIf(!PERMISSIONS_APPLY)('creates the file so only its owner can read it', () => {
    // A credential readable by every account on a shared machine is a leaked
    // credential, and the mode is the only thing standing between them.
    const path = scratchFile();
    writeSession({ baseUrl: 'http://api.test', token: 'secret' }, path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!PERMISSIONS_APPLY)('tightens a pre-existing loose file when it replaces it', () => {
    // The create path is the easy half. `writeFileSync`'s mode is ignored when
    // the file already exists, so a second login against a file left at 0644 —
    // by an older build, or by a backup restore — used to keep 0644 while its
    // contents became a fresh token.
    const path = scratchFile();
    writeFileSync(path, JSON.stringify({ baseUrl: 'http://api.test', token: 'old' }), {
      mode: 0o644,
    });
    expect(statSync(path).mode & 0o777).toBe(0o644);

    writeSession({ baseUrl: 'http://api.test', token: 'new' }, path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('reports no session when the file is absent', () => {
    expect(readSession(join(scratchFile(), 'never-created.json'))).toBeUndefined();
  });

  it('treats a corrupted file as no session rather than throwing', () => {
    // Throwing here would make the file unfixable without a shell, and the
    // recoverable answer and the same answer: not logged in.
    const path = scratchFile();
    writeFileSync(path, 'not json at all');

    expect(readSession(path)).toBeUndefined();
  });

  it('treats a file of the wrong shape as no session', () => {
    const path = scratchFile();
    writeFileSync(path, JSON.stringify({ baseUrl: 42, token: null }));

    expect(readSession(path)).toBeUndefined();
  });

  it('logs out without complaining that there was nothing to log out of', () => {
    const path = scratchFile();
    writeSession({ baseUrl: 'http://api.test', token: 'secret' }, path);

    clearSession(path);
    expect(readSession(path)).toBeUndefined();

    expect(() => {
      clearSession(path);
    }).not.toThrow();
  });
  it('FAILS when the session file cannot be written, rather than claiming a logout', () => {
    // A bearer token left on disk while the CLI reports you logged out is the
    // wrong KIND of success: the person stops believing the message, and the next
    // time it is right they stop acting on it too. Only ENOENT means 'there was
    // nothing here' — a file that cannot be written still holds the token.
    //
    // A directory where the file should be makes the write fail as EISDIR on
    // every platform, which a chmod does not: Windows ignores the mode bits for
    // a process that owns the file, so a test written with chmod passes there and
    // never exercises the branch it was written for.
    const asDirectory = join(mkdtempSync(join(tmpdir(), 'agent-battle-')), 'session.json');
    mkdirSync(asDirectory, { recursive: true });

    expect(() => clearSession(asDirectory)).toThrow();
  });
});
