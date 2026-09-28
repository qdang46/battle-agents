import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where this machine keeps which server it talks to and what it presents.
 *
 * This is configuration, not game state, which is why it is allowed to live
 * here at all. The iron rule from plan section 31 is that the CLI touches no
 * database and holds no game logic; remembering a base URL and a bearer token
 * is neither. Everything the CLI can DO still goes through the five primitives.
 *
 * The file is created 0600 because it holds a credential, and the directory
 * 0700 for the same reason. On a shared machine a 0644 token file is a
 * credential readable by every account on it.
 */

/** What a session needs in order to make a call. */
export interface StoredSession {
  readonly baseUrl: string;
  readonly token: string;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * The session file's directory, overridable for a test or a second identity.
 *
 * `AGENT_BATTLE_HOME` rather than a full path, because the file inside it is an
 * implementation detail — a test that names the file has to be rewritten if the
 * layout ever moves, and one that names the directory does not.
 *
 * This exists because it could not be tested without it. `logout` deletes the
 * session, so a test that ran it against the default path deleted the REAL
 * session of whoever ran the suite — which is how the CLI under test logged the
 * developer out mid-run. Point it at a temp directory and `logout` becomes a
 * thing a test can assert about instead of a thing a test has to avoid.
 */
const HOME_VARIABLE = 'AGENT_BATTLE_HOME';

export function sessionDirectory(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env[HOME_VARIABLE];
  return override === undefined || override.trim() === '' ? homedir() : override;
}

export function sessionPath(): string {
  return join(sessionDirectory(), '.agent-battle', 'session.json');
}

/** The stored session, or undefined when this machine has not logged in. */
export function readSession(path = sessionPath()): StoredSession | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'baseUrl' in parsed &&
      'token' in parsed &&
      typeof (parsed as { baseUrl: unknown }).baseUrl === 'string' &&
      typeof (parsed as { token: unknown }).token === 'string'
    ) {
      return parsed as StoredSession;
    }
  } catch {
    // A file that is not the JSON we wrote is not a session. Falling through
    // to "not logged in" is recoverable; throwing here would make a corrupted
    // file unfixable without a shell.
  }
  return undefined;
}

/** Stores the session, replacing whatever was there. */
export function writeSession(session: StoredSession, path = sessionPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, { mode: FILE_MODE });
  // `writeFileSync`'s mode applies only when it CREATES the file. On the second
  // login the file already exists, the mode is ignored, and a file left at 0644
  // by an older version — or restored from a backup — keeps those permissions
  // while its contents are replaced with a fresh token. chmod is unconditional
  // for that reason.
  //
  // There is a window between the write and the chmod in which a pre-existing
  // loose mode is paired with the new token. Closing it needs a temp file and a
  // rename, which is more machinery than a local session file earns; the window
  // is microseconds and the alternative left the wrong mode in place forever.
  chmodSync(path, FILE_MODE);
}

/**
 * Removes the stored session.
 *
 * Only "there was nothing there" is swallowed, and the distinction is the whole
 * point of this function.
 *
 * The previous version caught everything and wrote `{}` regardless of why the
 * write failed. `ENOENT` — no session file — really is the same end state, and
 * logging out twice must not be an error. But `EACCES` on a file this process
 * cannot write, a full disk, a read-only mount: those leave the bearer token
 * sitting on disk while the caller reports success. A logout that says it worked
 * and did not is worse than a logout that fails, because the person stops
 * believing the message the next time it is right.
 *
 * So the absence is tolerated and everything else is re-thrown with the cause
 * intact.
 */
export function clearSession(path = sessionPath()): void {
  try {
    writeFileSync(path, '{}\n', { mode: FILE_MODE });
  } catch (error) {
    if (!isAbsent(error)) throw error;
  }
}

/** Whether a filesystem error means "there was nothing there". */
function isAbsent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}
