/**
 * The long-lived process every adapter's bin runs, written once.
 *
 * ## Why this is in `protocol` and not nine bins
 *
 * The M7 promise is that a new coding CLI is "one subdirectory" — see
 * `packages/adapters/_template`. That promise was not true: each adapter had its
 * own watcher, and the thing that turns a watcher into a CONNECTED process (the
 * HELLO handshake, the ingest sender, the base URL, the token, the signal
 * handling) did not exist anywhere, so each one would have had to reimplement
 * it — and the first adapter to be wired that way, `claude`, took a day and
 * three bugs to find.
 *
 * So the runner lives here, in the package both ends already share, and an
 * adapter's bin becomes: name the watcher, hand it a sender, call `runHarness`.
 * That is the whole of what "one subdirectory" now means.
 *
 * ## What a bin still has to supply
 *
 * A WATCHER and a HARNESS NAME. The watcher knows the file layout; the runner
 * knows the platform. Neither needs to know the other's half, which is the
 * isolation the layering in AGENTS.md is for.
 */
import { statSync } from 'node:fs';

import { createIngestSender, createSessionOpeningSender, sayHello } from '@battle-agents/protocol';
import type { IngestSender } from '@battle-agents/protocol';
import { PROTOCOL_VERSION } from '@battle-agents/protocol';

/** The minimum a watcher has to offer to be runnable as a process. */
export interface RunnableWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface HarnessRunnerOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** The character this installation plays, resolved BY NAME at handshake. */
  readonly agentName: string;
  /** The protocol harness enum value — `claude`, `codex`, and so on. */
  readonly harness: string;
  /**
   * Builds the watcher, GIVEN the sender.
   *
   * A factory rather than a finished watcher, and the reason is a bug this file
   * had in its first version: it constructed the handshake-wrapped sender and
   * then started a watcher that had already been built with the UNWRAPPED one.
   * The handshake ran for nothing and every batch was refused with
   * `no such session` — a runner that looks correct, is wired, and connects to
   * nothing. A factory makes the sender unreachable except through the runner.
   */
  readonly createWatcher: (send: IngestSender) => RunnableWatcher;
  /** Printed to stderr, so a person can see what connected. */
  readonly log?: (line: string) => void;
  /** Run one tick and exit, for a test or a health probe. */
  readonly once?: boolean;
  /** Ends the process. Injectable so a test does not end the test runner. */
  readonly exit?: (code: number) => void;
}

/**
 * The version handshake, as a startup check.
 *
 * PROTOCOL_VERSION is pinned on ingest and a mismatch answers 400 naming both
 * values. Finding that out after a session has been running for an hour is the
 * wrong time, and the adapter is the only process that knows it is about to
 * start talking to a particular server.
 */
export async function checkProtocol(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/events/stream`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 200) {
    // A live stream is not a handshake and must not be left open; the check is
    // that the server answered at all, so the body is dropped and the socket
    // closed with it.
    void response.body?.cancel();
    return;
  }
  throw new Error(
    `agent-battle: ${baseUrl} answered ${response.status} for the event stream. ` +
      `This client speaks protocol ${PROTOCOL_VERSION}.`,
  );
}

export async function runHarness(options: HarnessRunnerOptions): Promise<void> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  // The handshake, applied to every session this process opens. The watcher is
  // untouched by it, which is the point: an adapter that emits a `sessionId`
  // is connected, and there is no per-harness code that can forget to connect.
  const opening = createSessionOpeningSender(
    {
      baseUrl: options.baseUrl,
      token: options.token,
      agentName: options.agentName,
      harness: options.harness,
      onOpened: (sessionId) => log(`agent-battle: opened a run for harness session ${sessionId}`),
    },
    createIngestSender({ baseUrl: options.baseUrl, token: options.token }),
  );

  log(`agent-battle: watching for ${options.harness}, posting to ${options.baseUrl}`);

  const watcher = options.createWatcher(opening);

  await watcher.start();
  if (options.once === true) {
    await watcher.stop();
    return;
  }

  // A watcher that outlives the process it belongs to is a leaked timer and a
  // socket. SIGINT is what a terminal sends; SIGTERM is what a supervisor sends.
  // Both have to flush, because the last batch is the one carrying the work that
  // actually happened.
  const shutdown = (): void => {
    void (async () => {
      try {
        await watcher.stop();
      } finally {
        (options.exit ?? ((code: number) => process.exit(code)))(0);
      }
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export { sayHello };

/**
 * The argument parsing every adapter's bin needs, and the process around it.
 *
 * ## Why this exists
 *
 * Eight adapters each had a `bin` that did not exist, and the one that did
 * (`claude`) parses `--endpoint --token --root --poll --once --agent` by hand.
 * Copying that file nine times is how the M7 promise — "a new coding CLI is one
 * subdirectory" — becomes nine ways to be subtly wrong, and the copies would
 * drift from each other the first time a flag was added.
 *
 * So the flags live here, once, and a bin is the two lines that name its harness
 * and its watcher. Adding a flag now touches one file and every adapter gets it.
 */
export interface HarnessBinOptions {
  /** The protocol harness enum value this bin speaks for. */
  readonly harness: string;
  /** Builds the watcher from the resolved sender and the `--root` argument. */
  readonly createWatcher: (
    send: IngestSender,
    root: Readonly<Record<string, string>>,
  ) => RunnableWatcher;
  /** The default when `--root` is absent. Each harness writes somewhere else. */
  /**
   * Omitted by most bins: every watcher already defaults its own path, and a bin
   * that repeats it is a second copy of the same fact. The first generated codex
   * bin named CLAUDE's transcripts directory as codex's default, which would
   * have watched the wrong harness's files on every run without `--root`.
   */
  readonly defaultRoot?: () => string;
  /**
   * What `--root` names, and which option key carries it.
   *
   * Added because three harnesses were wrong in the same way. Codex, Cursor and
   * Aider each take a DIRECTORY (`sessionsRoot`, `projectsRoot`) OR a single
   * FILE (`rolloutPath`, `transcriptPath`), and the generated bins all passed
   * `--root` to the directory key. Pointing `--root` at one rollout file — the
   * obvious thing to do, and the only thing that works when you want one
   * session — silently watched a directory that did not exist: the process
   * started, printed "watching for codex", and connected to nothing.
   *
   * Both keys are declared rather than one, because `either` has to pick a
   * DIFFERENT key per answer and a single `rootOption` string could not. The
   * first version of this computed the kind and then ignored it, which is the
   * same bug one level up.
   */
  readonly rootKind: 'directory' | 'file' | 'either';
  /** The option key each answer uses. `either` picks between them. */
  readonly rootOptions: { readonly file: string; readonly directory: string };
  /** Extra flags this bin understands, for a harness with a special one. */
  readonly extraFlags?: Readonly<Record<string, (value: string | undefined) => void>>;
}

export interface BinOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly agent: string;
  readonly root: string | undefined;
  readonly pollMs: number;
  readonly once: boolean;
  readonly help: boolean;
}

const BIN_USAGE = (harness: string, root: string): string => `
agent-battle-${harness} — run the ${harness} adapter until interrupted

  --endpoint <url>    where to POST batches   (default http://127.0.0.1:3000)
  --token <bearer>    installation credential  (required; or AGENT_BATTLE_TOKEN)
  --agent <name>      the character to play    (default Claude, or AGENT_BATTLE_AGENT)
  --root <dir>        ${root}   (default: this harness's own directory)
  --poll <ms>         poll interval            (default 500)
  --once              run one tick and exit, for a test or a health probe
  --help              this text

Writes nothing to ${harness}'s configuration.
`;

/**
 * Runs a bin. Never returns; exits with a code.
 *
 * A refusal is exit 1 with the server's own words on stderr, and a usage problem
 * is exit 2. Both are distinct from a silent success, which is the failure this
 * whole runner was written to remove.
 */
export async function runHarnessBin(
  argv: readonly string[],
  options: HarnessBinOptions,
): Promise<void> {
  const parsed = parseBinArgv(argv, options);
  if (parsed.help) {
    // `exitCode` rather than `exit()`. A `process.exit` immediately after a
    // write to a PIPE discards whatever has not been flushed yet, so
    // `agent-battle-codex --help | head` printed nothing while running it in a
    // terminal printed the whole usage — the kind of difference that makes a
    // working command look broken in exactly the place somebody would use it.
    process.stdout.write(BIN_USAGE(options.harness, describeRoot(options)));
    process.exitCode = 0;
    return;
  }
  try {
    await runHarness({
      baseUrl: parsed.endpoint,
      token: parsed.token,
      agentName: parsed.agent,
      harness: options.harness,
      createWatcher: (send) => options.createWatcher(send, resolveRoot(options, parsed.root)),
      once: parsed.once,
    });
  } catch (error) {
    process.stderr.write(
      `agent-battle-${options.harness}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

function parseBinArgv(
  argv: readonly string[],
  options: HarnessBinOptions,
): BinOptions {
  let endpoint = process.env['AGENT_BATTLE_ENDPOINT'] ?? 'http://127.0.0.1:3000';
  let token = process.env['AGENT_BATTLE_TOKEN'] ?? '';
  let agent = process.env['AGENT_BATTLE_AGENT'] ?? 'Claude';
  let root: string | undefined;
  let pollMs = 500;
  let once = false;
  let help = false;

  const extra = new Map(Object.entries(options.extraFlags ?? {}));

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) binUsage(options, `${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--endpoint':
        endpoint = next();
        break;
      case '--token':
        token = next();
        break;
      case '--agent':
        agent = next();
        break;
      case '--root':
        root = next();
        break;
      case '--poll':
        pollMs = Number(next());
        break;
      case '--once':
        once = true;
        break;
      case '--help':
        help = true;
        break;
      default: {
        const handler = extra.get(arg);
        if (handler !== undefined) {
          handler(argv[i + 1]);
          i += 1;
          break;
        }
        binUsage(options, `unknown argument ${arg}`);
      }
    }
  }

  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    binUsage(options, '--poll must be a positive number of milliseconds');
  }
  if (!help && token.trim() === '') {
    binUsage(options, 'no credential. Pass --token, or set AGENT_BATTLE_TOKEN.');
  }
  return { endpoint, token, agent, root, pollMs, once, help };
}

function binUsage(options: HarnessBinOptions, problem: string): never {
  // Same reason as the help path: `exit()` after a write to a pipe loses the
  // write. A usage message that only appears in a terminal is a usage message
  // nobody sees when they are reading a CI log.
  process.stderr.write(
    `agent-battle-${options.harness}: ${problem}\n${BIN_USAGE(options.harness, describeRoot(options))}`,
  );
  process.exit(2);
  // Unreachable, and the return type says so. `process.exit` is typed `never`,
  // so the throw is what keeps a future edit that adds a branch honest.
  throw new Error('unreachable');
}

/**
 * The `--root` argument, under whichever key this harness calls it.
 *
 * `either` asks the filesystem. A path that does not exist yet is a DIRECTORY,
 * because every harness that takes either form creates the directory first and
 * writes the file into it — so a rollout that has not been written yet is
 * reached through its parent. Guessing the other way produces a watcher pinned
 * to a file that does not exist, which finds nothing and never says why.
 */
function resolveRoot(
  options: HarnessBinOptions,
  root: string | undefined,
): Readonly<Record<string, string>> {
  // No `--root` and no default means the watcher's OWN default applies, and the
  // correct thing to pass it is nothing at all.
  const path = root ?? options.defaultRoot?.();
  if (path === undefined) return {};
  const kind =
    options.rootKind === 'either' ? (isDirectory(path) ? 'directory' : 'file') : options.rootKind;
  return { [options.rootOptions[kind]]: path };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return true;
  }
}

/** The usage line's description of `--root`, for a bin that names a default. */
function describeRoot(options: HarnessBinOptions): string {
  const named = options.rootOptions;
  if (options.rootKind === 'either') {
    return `${named.directory} directory, or a single ${named.file} file`;
  }
  if (options.rootKind === 'file') return `${named.file} file`;
  return `${named.directory} directory`;
}
