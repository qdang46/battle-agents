import { sharedAuth, MissingAuthConfigurationError } from './auth/server.js';
import { DEV_LOGIN_NAME, devLoginEnabled, devLoginRefusal } from './auth/dev-login.js';

/**
 * Who is looking, as far as this page is concerned.
 *
 * ## The board is not public, and that is not a choice made here
 *
 * `bounty-routes.ts` authenticates every request on the bounty surface,
 * INCLUDING the list, and gives its reason in the code: a bounty names a
 * repository and an issue number, and `docs/design/public-replay.md` rules that
 * publishing a repository is publishing a place to look. A page that read the
 * same command with no check would publish exactly what the route refuses to,
 * through a door the route does not have.
 *
 * So the whole `(app)` route group is behind this one check. The alternative —
 * gating `/bounties` and leaving `/agents` open — would be defensible on the
 * narrowest reading and wrong on the one the codebase actually wrote down.
 * `/replay/[replayId]` stays outside the group, because that page is the
 * surface `docs/design/public-replay.md` is about and it decides its own
 * boundary.
 *
 * ## The three answers, and why there are three
 *
 * `signed-out`, `auth-unconfigured` and `signed-in` look alike in a browser and
 * mean three different things to the person looking: they need to sign in, the
 * operator needs to finish `cp .env.example .env`, and everything is fine. A
 * gate that collapsed them would tell a developer their OAuth app is broken
 * when they have simply not signed in yet, and tell a signed-out visitor that
 * the platform is misconfigured.
 *
 * `readAuthEnvironment` THROWS when a variable is missing, and that is the
 * correct behaviour for a startup. On a page render it would be a 500 for
 * somebody who did nothing wrong, so it is caught here and turned into a state
 * the page can render.
 */
export type Viewer =
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'auth-unconfigured'; readonly missing: readonly string[] }
  | { readonly kind: 'signed-in'; readonly login: string | null }
  /**
   * Signed in by the local development bypass rather than by GitHub.
   *
   * A FOURTH answer, added because the three above cannot express "you are
   * looking at a development build with no OAuth app behind it". Folding it into
   * `signed-in` would make a screen pass its gate silently, and the one thing
   * this repository's gate exists to prevent is a screen that renders without
   * anybody having decided it should. So the state is distinct, the chrome says
   * so, and no code has to remember to check.
   */
  | { readonly kind: 'dev-login'; readonly login: string };

/**
 * The signed-in human, or the state that explains why there is not one.
 *
 * The request headers are a PARAMETER rather than a `next/headers` call inside
 * this file, for the same reason `assemblePublicReplay` takes its sources: it
 * keeps Next out of the read models, so this can be exercised with a plain
 * `Headers` and the page stays the only place that knows about a request.
 */
export async function resolveViewer(requestHeaders: Headers): Promise<Viewer> {
  // Before the auth server, and before its configuration is read, so a developer
  // with no OAuth app gets the product rather than the setup instructions. The
  // refusal below keeps a set-but-ineffective flag from being silent.
  if (devLoginEnabled(process.env)) {
    reportDevLoginRefusal();
    return { kind: 'dev-login', login: DEV_LOGIN_NAME };
  }

  let auth: ReturnType<typeof sharedAuth>;
  try {
    auth = sharedAuth();
  } catch (error) {
    if (error instanceof MissingAuthConfigurationError) {
      return { kind: 'auth-unconfigured', missing: error.missing };
    }
    throw error;
  }

  const answer = await auth.api.getSession({ headers: requestHeaders });
  if (answer === null || answer.user === null || answer.user === undefined) {
    return { kind: 'signed-out' };
  }
  return { kind: 'signed-in', login: githubLogin(answer.user) };
}

/**
 * The GitHub login of the signed-in person, when the session carries one.
 *
 * Null rather than a fallback to an email or a synthetic name. The account is
 * keyed on the GitHub id (`bootstrapGameAccount`), so a value that is not that
 * id would greet somebody by a name the game does not hold for them, and a
 * greeting is not worth a wrong identity.
 */
function githubLogin(user: { readonly name?: unknown; readonly email?: unknown }): string | null {
  const candidate = user.name;
  if (typeof candidate !== 'string' || candidate.trim() === '') return null;
  return candidate.trim();
}

/**
 * Whether the gate is open, as the layout asks it.
 *
 * A type predicate rather than a boolean so the call site narrows and does not
 * have to re-check the discriminant — a `boolean` here produced a layout that
 * read `viewer.login` off a union that had no such field, which is a compile
 * error today and would become a `?.` tomorrow.
 */
export function viewerMayRead(
  viewer: Viewer,
): viewer is Extract<Viewer, { readonly kind: 'signed-in' } | { readonly kind: 'dev-login' }> {
  return viewer.kind === 'signed-in' || viewer.kind === 'dev-login';
}

/** The path a signed-out visitor is sent to. */
export const SIGN_IN_PATH = '/api/auth/sign-in/social';

/**
 * Says once, loudly, that a flag was set and did nothing.
 *
 * `warn` rather than `error` and rather than a throw, because the correct
 * behaviour of a production process with this flag set is to behave exactly as
 * it would without it. A developer who set `AGENT_BATTLE_DEV_LOGIN=true` on a
 * `next start` and found the gate still closed has one of two things to fix —
 * the value, or the environment — and this names both. The module-level `let`
 * makes it once per process rather than once per page render.
 */
let devLoginRefusalReported = false;

function reportDevLoginRefusal(): void {
  if (devLoginRefusalReported) return;
  const reason = devLoginRefusal(process.env);
  if (reason === undefined) return;
  devLoginRefusalReported = true;
  process.stderr.write(`[auth] ${reason}\n`);
}
