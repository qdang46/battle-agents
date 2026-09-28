import { UnknownDomainError } from '@battle-agents/api';
import { isRegisteredActionId } from '@battle-agents/protocol';

import { clearSession, readSession, writeSession } from './session.js';
import type { ApplicationApi, Discovery, DomainDetail } from '@battle-agents/api';

/**
 * The CLI's whole vocabulary.
 *
 * There is no per-feature code anywhere in this package, and that is the point
 * rather than an accident of a young codebase. `quest list` and `battle accept`
 * are the same three lines: resolve the domain, resolve the verb inside it, act.
 * A feature added tomorrow is reachable from the CLI today with no change here,
 * which is what "CLI and MCP evolve independently of feature count" has to mean
 * if it is to mean anything.
 *
 * What this file deliberately does NOT have: a switch over known domains, a
 * --with-xp convenience, a local cache, a direct read. Each would make the CLI
 * behave differently from the web and MCP surfaces, and the difference would
 * only show up as a bug report from somebody whose agent worked on one surface
 * and not the other.
 */

/** How a command prints. `--json` exists because an agent drives this too. */
export type OutputFormat = 'text' | 'json';

export interface Invocation {
  readonly argv: readonly string[];
  readonly format: OutputFormat;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Raised for anything a caller can fix, with the fix in the message. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Raised when the platform said no, reported rather than swallowed. */
export class CommandFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandFailedError';
  }
}

interface Resolved {
  readonly detail: DomainDetail;
  /** Whether this domain offers the named action. */
  offers(actionId: string): boolean;
}

const PLATFORM_COMMANDS = new Set([
  'status',
  'doctor',
  'help',
  'discover',
  'login',
  'init',
  'logout',
]);

/**
 * The verbs that must work BEFORE a session exists.
 *
 * This list exists because the entry point checked for a session before it
 * dispatched anything, and `login` is a verb. So the first command anybody could
 * possibly type was refused with "not logged in. Run `agent-battle login …`",
 * which is the shape of a deadlock: the instruction to fix it is the command
 * that cannot be reached. `agent-battle help` was refused the same way, so
 * there was no way to find out what the CLI offered.
 *
 * The set is the whole of the fix and it is small. `login` and `logout` write
 * the session file, `init` reports it, and `help` prints usage — none of them
 * can talk to a server, because there is nothing to talk to a server WITH yet.
 * `discover` and `status` DO need an API, so they stay behind the check and
 * answer the "not logged in" message, which is a real answer for them.
 *
 * Derived from what the dispatcher handles rather than kept in main.ts, because
 * the two places disagreeing is how this happened: main.ts had a policy and
 * dispatch had the commands, and nothing reconciled them.
 */
export const SESSIONLESS_VERBS: ReadonlySet<string> = new Set([
  'help',
  '--help',
  'login',
  'init',
  'logout',
]);

/** Whether this invocation can be served with no session file on disk. */
export function runsWithoutSession(argv: readonly string[]): boolean {
  return SESSIONLESS_VERBS.has(argv[0] ?? '');
}

/**
 * The agent runtime verbs.
 *
 * `start` and `stop` are NOT special-cased into game knowledge. They are
 * resolved as ordinary domain actions the same way `quest.claim` is, so if a
 * future build has no `session.start` the CLI says so and names what it does
 * offer, rather than failing on an action that was never wired.
 *
 * `login` and `init` are the two that touch local state, and they do it through
 * session.ts rather than here. Neither knows what a game concept is.
 */
interface RuntimeVerb {
  readonly domain: string;
  readonly action: string;
}

const RUNTIME_VERBS: Readonly<Record<string, RuntimeVerb>> = {
  start: { domain: 'session', action: 'session.start' },
  stop: { domain: 'session', action: 'session.end' },
};

/**
 * Runs one invocation against the application API.
 *
 * The shape is fixed so the dispatcher stays small: `<domain> [<verb>] [args…]`.
 * Everything after the verb is joined and handed to the action, because an
 * action's input shape belongs to the feature and the CLI has no business
 * knowing it.
 */
export async function run(api: ApplicationApi, invocation: Invocation): Promise<CommandResult> {
  try {
    return await dispatch(api, invocation);
  } catch (error) {
    return reportError(error, invocation.format);
  }
}

async function dispatch(api: ApplicationApi, invocation: Invocation): Promise<CommandResult> {
  const [first, ...rest] = invocation.argv;
  // One place decides how output is rendered, so a command cannot forget to
  // pass the format and silently print text where --json was asked for. That
  // failure is invisible to a person and fatal to the agent that asked.
  const emit = (value: unknown): CommandResult => ok(render(value, invocation.format));

  if (first === undefined || first === 'help' || first === '--help') {
    return ok(usage());
  }

  if (first === 'discover') {
    const domain = rest[0];
    return emit(domain === undefined ? await api.discover() : await api.discover(domain));
  }

  const runtime = first === undefined ? undefined : RUNTIME_VERBS[first];
  if (runtime !== undefined) {
    const resolved = await resolve(api, runtime.domain);
    if (!resolved.offers(runtime.action)) {
      throw new UsageError(
        `"${first}" needs ${runtime.action}, which this build does not register. ` +
          `The ${runtime.domain} domain offers: ${describeActions(resolved.detail).join(', ')}`,
      );
    }
    return await actOn(api, emit, runtime.action, rest);
  }

  if (first === 'login') {
    return login(rest, emit);
  }

  if (first === 'init') {
    return init(rest, emit);
  }

  if (first === 'logout') {
    clearSession();
    return emit({ loggedOut: true });
  }

  if (first === 'status') {
    // A platform fact, not a game one: is anything registered, and is anything
    // degraded. It answers from the API, never from a local database.
    const domains = (await api.discover()).domains ?? [];
    return emit({
      domains,
      note:
        domains.length === 0
          ? 'no features are installed'
          : `${domains.length} domain(s) available`,
    });
  }

  if (first === 'doctor') {
    return await doctor(api, emit);
  }

  if (PLATFORM_COMMANDS.has(first)) {
    throw new UsageError(`"${first}" takes no domain argument`);
  }

  const resolved = await resolve(api, first);
  const verb = rest[0];

  if (verb === undefined) {
    return emit({
      domain: first,
      can: describeActions(resolved.detail),
      try: `${first} <verb> [args…] — see 'agent-battle discover ${first}'`,
    });
  }

  const actionId = `${first}.${verb}`;
  if (!resolved.offers(actionId)) {
    // The verb is not an action, so it is a filter: `quest list` lists.
    const results = await api.search({ type: first, name: verb });
    if (results.length === 0) {
      throw new UsageError(
        `no "${verb}" under "${first}". This domain offers: ${describeActions(resolved.detail).join(', ')}`,
      );
    }
    return emit(results);
  }

  return await actOn(api, emit, actionId, rest.slice(1), describeActions(resolved.detail));
}

/**
 * Runs one action and reports the failure in terms a caller can act on.
 *
 * Shared by the domain path and the runtime verbs, because both do the same
 * three things: refuse an id this build does not register, hand the arguments
 * to the action, and turn a rejection into a message naming the action. Two
 * copies of that is two places for the error text to drift.
 *
 * The action's input shape belongs to the feature, so the arguments arrive as
 * the single string the dispatcher has always passed. The CLI does not parse
 * them, and doing so is how a surface ends up behaving differently from the
 * others.
 */
/**
 * Parses one `--key value` payload.
 *
 * A value that starts with `{` or `[` is parsed as JSON, and that is what makes
 * the CLI able to reach a structured field at all. Nearly every action with real
 * parameters has one — `battle.finish` takes an array of per-fighter results,
 * `battle.create` takes a weights object — and a CLI whose values are all
 * strings cannot express either. It is not a convenience: it is the difference
 * between the CLI reaching the arena and the CLI reaching nothing past `list`.
 *
 * A value that does NOT parse is left as the string it is, rather than refused.
 * A PR body or a commit message can begin with a brace and mean it literally, and
 * a CLI that turns that into an error has replaced a wrong value with a missing
 * one. The features validate their own fields, so the worst case is the feature
 * saying the field was not the shape it wanted — which names itself.
 */
function payload(value: string): unknown {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Turns command-line arguments into the object an action receives.
 *
 * ## What this replaces
 *
 * `act()` was called with `{ args: args.join(' ') }` — every argument collapsed
 * into one string under a key named `args`. `/api/act` then handed that object
 * straight to the feature, so `bounty.claim` was asked for a `bountyId` on an
 * object that had neither a `bountyId` nor any other field a real action
 * recognises. Every action invoked through the CLI failed on its input:
 *
 *     $ agent-battle bounty claim 00000000-0000-4000-8000-00000000000a
 *     bounty.claim refused its input: bounty-id-not-a-string
 *
 * and the same call with a correct body over HTTP worked, which is what made
 * this a CLI defect and not a feature one. The tests did not catch it because
 * their fake actions were written to read `input.args` — the test agreed with
 * the bug.
 *
 * ## The three accepted forms, and why there is no fourth
 *
 * `--key=value` and `--key value` for ordinary arguments; a single JSON object
 * for anything structured; and nothing else. A bare positional has no honest
 * default, because the two ways to guess it — "first argument is the id" or
 * "join them" — are both wrong for some action, and a CLI that guesses sends the
 * feature a plausible object it will refuse with a message about the wrong
 * field. Refusing here, naming the two forms, is the answer a person or an
 * agent can act on.
 */
export function actionInput(
  args: readonly string[],
  actionId: string,
): Record<string, unknown> {
  if (args.length === 0) return {};

  if (args.length === 1 && args[0]!.trimStart().startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args[0]!);
    } catch (error) {
      throw new UsageError(
        `${actionId}: the single argument looked like JSON but did not parse ` +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          'Pass an object, or use --key value pairs.',
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new UsageError(`${actionId}: the JSON argument must be an object, not ${describe(parsed)}.`);
    }
    return parsed as Record<string, unknown>;
  }

  const input: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith('--')) {
      throw new UsageError(
        `${actionId}: "${argument}" is a bare value and this build will not guess which ` +
          'field it belongs to. Use --name value, --name=value, or pass one JSON object.',
      );
    }
    const withoutDashes = argument.slice(2);
    const equals = withoutDashes.indexOf('=');
    if (equals !== -1) {
      input[withoutDashes.slice(0, equals)] = payload(withoutDashes.slice(equals + 1));
      continue;
    }
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new UsageError(`${actionId}: --${withoutDashes} needs a value.`);
    }
    input[withoutDashes] = payload(next);
    index += 1;
  }
  return input;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

async function actOn(
  api: ApplicationApi,
  emit: (value: unknown) => CommandResult,
  actionId: string,
  args: readonly string[],
  offered?: readonly string[],
): Promise<CommandResult> {
  try {
    if (!isRegisteredActionId(actionId)) {
      const suffix = offered === undefined ? '' : ` This domain offers: ${offered.join(', ')}`;
      throw new UsageError(`no action "${actionId}" in this build.${suffix}`);
    }
    return emit(await api.act(actionId, actionInput(args, actionId)));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new CommandFailedError(
      `${actionId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * `login <server-url> <token>` — remember which server and what to present.
 *
 * The one command that writes local state, and it writes nothing a game would
 * recognise: an origin and a bearer credential. That is what keeps the iron
 * rule intact while still letting the CLI work against a running server.
 *
 * The token is taken as an argument rather than fetched, because there is no
 * device flow to fetch it with yet. That is a real gap and it is stated here
 * rather than hidden behind a prompt that pretends to do more than it does.
 */
function login(args: readonly string[], emit: (value: unknown) => CommandResult): CommandResult {
  const [baseUrl, token] = args;
  if (baseUrl === undefined || token === undefined) {
    throw new UsageError(
      'login needs a server URL and a token: `agent-battle login <server-url> <token>`',
    );
  }
  writeSession({ baseUrl, token });
  return emit({ loggedIn: true, serverUrl: baseUrl });
}

/**
 * `init` — show what this machine is configured to talk to, or say it is not.
 *
 * A read, not a write, and deliberately so. The plan puts `init` in the agent
 * runtime group, but "initialise" for a machine already means writing an
 * installation record, and that record belongs to the agent feature rather than
 * to a file on disk the CLI keeps for itself. Until a registration action is
 * registered for it, the honest answer is what the configuration is.
 */
function init(args: readonly string[], emit: (value: unknown) => CommandResult): CommandResult {
  if (args.length > 0) {
    throw new UsageError("init takes no arguments; it reports this machine's configuration");
  }
  const session = readSession();
  return emit(
    session === undefined
      ? { configured: false, next: 'agent-battle login <server-url> <token>' }
      : { configured: true, serverUrl: session.baseUrl, tokenStored: true },
  );
}

/**
 * Resolves a domain and the verb inside it, from one lazy discover.
 *
 * One round trip rather than two: the domain detail already lists every action,
 * so the verb can be matched without a second call — and a client that has just
 * been told what exists should not immediately ask again.
 */
async function resolve(api: ApplicationApi, domain: string): Promise<Resolved> {
  // The API throws its own UnknownDomainError for a domain it does not have,
  // and it gets there first. Re-raising as a UsageError is not cosmetic: the
  // `kind` an agent reads decides whether it corrects its command or reports a
  // platform failure, and a misfiled usage error reads as the latter.
  //
  // Both exits below say the same thing, so they say it in one place. The two
  // reasons a discovery can come back empty are different — the API refused, or
  // it answered without detail — and a caller should not be able to tell which.
  let discovery: Discovery;
  try {
    discovery = await api.discover(domain);
  } catch (error) {
    if (!(error instanceof UnknownDomainError)) {
      throw error;
    }
    throw unknownDomain(domain, (await api.discover()).domains ?? []);
  }

  if (discovery.detail === undefined) {
    throw unknownDomain(domain, (await api.discover()).domains ?? []);
  }
  const offered = new Set(discovery.detail.actions.map((action) => action.id));
  return {
    detail: discovery.detail,
    offers: (actionId) => offered.has(actionId),
  };
}

function unknownDomain(domain: string, known: readonly string[]): UsageError {
  return new UsageError(
    known.length === 0
      ? `unknown domain "${domain}" — no features are installed`
      : `unknown domain "${domain}". Known: ${known.join(', ')}`,
  );
}

/**
 * The verb part of an action id: everything after the domain.
 *
 * `slice(1)` rather than `[1]`, because ids may have more than two segments —
 * `quest.admin.revoke` is valid under the registry's pattern. Taking only the
 * second segment would list that action as "admin", and `agent-battle quest
 * admin` would build `quest.admin`, which is not a registered action, so the
 * command would fall through to a search and report that nothing matched while
 * the thing the caller asked for exists.
 */
function describeActions(detail: DomainDetail): string[] {
  return detail.actions.map((action) => action.id.split('.').slice(1).join('.'));
}

async function doctor(
  api: ApplicationApi,
  emit: (value: unknown) => CommandResult,
): Promise<CommandResult> {
  const domains = (await api.discover()).domains ?? [];
  return emit({
    reachable: true,
    domains: domains.length,
    check: 'the application API answered; deeper checks belong to the platform, not the CLI',
  });
}

function usage(): string {
  return [
    'agent-battle — drive your coding agents from the terminal',
    '',
    'USAGE',
    '  agent-battle <domain> <verb> [args…]   run a registered action',
    '  agent-battle <domain>                  list what that domain can do',
    '  agent-battle <domain> <filter>          list what matches',
    '  agent-battle discover [domain]         list domains, or one domain in full',
    '  agent-battle status                    what is installed',
    '  agent-battle doctor                    check the platform is reachable',
    '',
    'There is no per-feature help: every action a domain offers is shown by',
    'running the domain on its own, and a feature added to the platform is',
    'reachable here immediately without this binary changing.',
    '',
    'Add --json for machine-readable output. This command is driven by agents as',
    'well as by people, so every result has a stable machine form.',
  ].join('\n');
}

function render(value: unknown, format: OutputFormat): string {
  return format === 'json' ? JSON.stringify(value, null, 2) : toText(value);
}

/**
 * Human output.
 *
 * Objects and arrays become lines rather than JSON, because a person reading a
 * terminal wants a list, not braces. The machine form is `--json`, and it is
 * the same data — never a second, looser shape.
 */
function toText(value: unknown): string {
  if (value === null || value === undefined) {
    return '(none)';
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? '(none)' : value.map(toText).join('\n');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return '(none)';
  }
  return entries
    .map(([key, each]) => {
      const rendered =
        typeof each === 'object' && each !== null ? JSON.stringify(each) : toText(each);
      return `${key}: ${rendered}`;
    })
    .join('\n');
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

/**
 * Failures print something a caller can act on, on stderr, with a non-zero
 * exit. A generic "request failed" is what an agent cannot recover from and a
 * person cannot debug.
 */
function reportError(error: unknown, format: OutputFormat): CommandResult {
  const message = error instanceof Error ? error.message : String(error);
  if (format === 'json') {
    return {
      exitCode: 1,
      stdout: '',
      stderr: JSON.stringify({ error: message, kind: errorName(error) }, null, 2),
    };
  }
  return { exitCode: 1, stdout: '', stderr: `${message}\n` };
}

function errorName(error: unknown): string {
  if (error instanceof UsageError) {
    return 'usage';
  }
  if (error instanceof CommandFailedError) {
    return 'failed';
  }
  return 'error';
}

/** Parses argv into an invocation, taking the global flags wherever they are. */
export function parseArgv(argv: readonly string[]): Invocation {
  const withoutFormat = argv.filter((argument) => argument !== '--json');
  return {
    argv: withoutFormat,
    format: argv.includes('--json') ? 'json' : 'text',
  };
}
