#!/usr/bin/env node
import { parseArgv, run, runsWithoutSession } from './commands.js';
import { HttpApiClient } from './api-client.js';
import { readSession } from './session.js';

/**
 * The `agent-battle` entry point.
 *
 * Assembles a client from what is on this machine and hands the invocation to
 * the dispatcher. Everything else lives in those three modules, so the only
 * thing decided here is which client the verbs talk to.
 *
 * ## The session check is not a gate on the dispatcher
 *
 * It was, and that made `login` unreachable: the check ran first, refused
 * because no session existed, and told the operator to run `login`. This file
 * now asks `runsWithoutSession` — which lives next to the commands it describes
 * — so the four verbs that create or inspect a session are dispatched with the
 * server-less client they need and everything else still refuses.
 *
 * The reason the answer lives in commands.ts and not here is that both halves of
 * this decision are already there: the dispatcher knows which verbs exist, and
 * putting a second list here is what let the two disagree.
 */
/**
 * A client for the verbs that must work with no session.
 *
 * The four sessionless verbs — `help`, `login`, `init`, `logout` — return from
 * the dispatcher without reaching for `api` at all, so this object exists only to
 * satisfy a parameter that is not going to be used. The base URL is a name that
 * cannot resolve, rather than a plausible-looking one: if a future verb ever
 * does reach it, the failure is a DNS error naming THIS constant, not a request
 * quietly sent somewhere real with no credential on it.
 *
 * `tests/unit/cli-sessionless.test.ts` is the actual guarantee — it runs each of
 * the four through `run()` with a client that throws on any method, so "unused"
 * is verified rather than asserted in a comment here.
 */
const UNREACHABLE = new HttpApiClient({ baseUrl: 'http://sessionless.invalid' });

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const session = readSession();

  if (session === undefined && !runsWithoutSession(parseArgv(argv).argv)) {
    process.stderr.write(
      'not logged in. Run `agent-battle login <server-url> <token>`, or pass an ' +
        'ApplicationApi in-process when embedding the CLI.\n',
    );
    return 1;
  }

  const invocation = parseArgv(argv);
  const result = await run(session === undefined ? UNREACHABLE : new HttpApiClient(session), invocation);
  if (result.stdout !== '') process.stdout.write(`${result.stdout}\n`);
  if (result.stderr !== '') process.stderr.write(`${result.stderr}\n`);
  return result.exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
