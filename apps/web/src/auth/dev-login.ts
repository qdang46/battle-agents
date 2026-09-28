/**
 * The local development bypass: see the product without a GitHub OAuth app.
 *
 * ## What this is for
 *
 * The `(app)` route group gates every page behind a real GitHub OAuth session
 * (`apps/web/src/ui/viewer-gate.tsx`), and standing one up needs a registered
 * OAuth App with an exact loopback callback. That is a legitimate gate — the
 * board names a repository and an issue number, and `docs/design/public-replay.md`
 * rules that publishing a repository is publishing a place to look. But it means
 * the product cannot be LOOKED AT until somebody visits github.com/settings and
 * registers an app, and a game that cannot be seen cannot be judged.
 *
 * So: an opt-in, development-only, deliberately conspicuous way to see the
 * screens. It changes who the reader is. It does not change what any route will
 * serve that reader, so none of the boundaries `viewer-gate.tsx` draws move.
 *
 * ## What this deliberately is NOT
 *
 * It does not mint a session. There is no cookie, no row in Better Auth's tables
 * and nothing to log out of, because the alternative — writing a fake session —
 * creates state that outlives the flag and has to be found and cleaned up later.
 * A viewer is a render-time answer, so the bypass is a render-time answer too.
 *
 * ## Why `NODE_ENV` is the guard and not an "are we on localhost" check
 *
 * A host check asks the wrong question. A deployment behind a proxy answers to a
 * public origin and can still be someone's laptop; an origin check is satisfied
 * by whatever the `Host` header says, which an attacker on the same network can
 * set. `NODE_ENV` is set by the platform (Vercel sets `production`) and by Next
 * itself for `next start`, so it is the one signal that means "this build is the
 * one that faces users" rather than "this request claims to".
 *
 * The consequence is deliberate and worth stating: the bypass does NOT work under
 * `next start`, only under `next dev`. A production build is the thing being
 * protected, and a local production build is close enough to it that the
 * distinction is not worth the risk of getting wrong.
 */

/** The flag. Named so it cannot be set by accident while reaching for something else. */
export const DEV_LOGIN_VARIABLE = 'AGENT_BATTLE_DEV_LOGIN';

/** The only value that turns it on. `'true'`, `'yes'` and `'1 '` all stay off. */
const ENABLED_VALUE = '1';

/** The name the gate shows while the bypass is in force. */
export const DEV_LOGIN_NAME = 'dev-login';

export interface DevLoginEnvironment {
  readonly [DEV_LOGIN_VARIABLE]?: string | undefined;
  readonly NODE_ENV?: string | undefined;
}

/**
 * Whether this process should treat every reader as signed in.
 *
 * Both halves are required. The flag alone is a switch somebody could flip on a
 * deployed environment; `NODE_ENV` alone is not a decision anybody makes. Only
 * the conjunction is a decision, and only `1` counts as the decision being made.
 */
export function devLoginEnabled(
  env: Readonly<DevLoginEnvironment>,
  nodeEnv: string | undefined = env.NODE_ENV,
): boolean {
  if (nodeEnv === 'production') return false;
  return env[DEV_LOGIN_VARIABLE] === ENABLED_VALUE;
}

/**
 * Why the bypass is off, when a flag is set but the guard says no.
 *
 * Returns a reason only when the flag is present and wrong, so the operator is
 * told the flag they set is not doing anything rather than left to wonder. It is
 * surfaced by the gate and never thrown: a deployment that set the flag and is
 * in production should behave exactly as it would have without the flag, which
 * means a real gate and no new error path.
 */
export function devLoginRefusal(
  env: Readonly<DevLoginEnvironment>,
  nodeEnv: string | undefined = env.NODE_ENV,
): string | undefined {
  const requested = env[DEV_LOGIN_VARIABLE];
  if (requested === undefined || requested === '') return undefined;
  if (devLoginEnabled(env, nodeEnv)) return undefined;
  if (nodeEnv === 'production') {
    return (
      `${DEV_LOGIN_VARIABLE}=${JSON.stringify(requested)} is set but ignored: ` +
        'this process is running with NODE_ENV=production, and the local bypass is ' +
        'refused there. Remove the variable from the deployment rather than relying ' +
        'on this guard.'
    );
  }
  return (
    `${DEV_LOGIN_VARIABLE} is ${JSON.stringify(requested)}, which does not turn the ` +
      `bypass on. The only value that does is ${JSON.stringify(ENABLED_VALUE)}.`
  );
}
