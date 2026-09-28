import { describe, expect, it } from 'vitest';

import {
  DEV_LOGIN_NAME,
  DEV_LOGIN_VARIABLE,
  devLoginEnabled,
  devLoginRefusal,
} from '../../apps/web/src/auth/dev-login.js';

/**
 * The development bypass, and the guard that makes it a development bypass.
 *
 * ## What is actually under test
 *
 * `devLoginEnabled` is two conditions ANDed, and only one of them is the
 * interesting one. That the flag turns it on is a fact about the string `'1'`.
 * That `NODE_ENV=production` turns it OFF is the property that makes this file
 * safe to exist at all, because the flag is read from the environment and
 * environments are shared with deployment tooling. So the production cases are
 * the ones written out individually, and each of them mutates something real
 * rather than asserting a table.
 *
 * ## The failure this guards
 *
 * The obvious way to write this is a host or origin check — "is this localhost".
 * A host check is satisfied by the `Host` header, which is attacker-controlled
 * on a network an attacker can reach, and by nothing at all in some proxies. An
 * origin check is the same problem with a longer name. `NODE_ENV` is set by the
 * platform and by Next itself, so it means "this is the build that faces users"
 * instead of "this request says so".
 *
 * ## The one behaviour worth breaking on purpose
 *
 * A guard nobody has watched refuse is a comment. The `NODE_ENV=production`
 * cases below are the guard refusing, and they were run before the bypass was
 * wired into `viewer-view.ts` -- which is the only way to know they were
 * asserting something rather than describing it.
 */
describe('devLoginEnabled', () => {
  it('is off with no flag at all, in development', () => {
    // The default. Every existing deployment has this, and a default that is on
    // would be the bug rather than the feature.
    expect(devLoginEnabled({ NODE_ENV: 'development' })).toBe(false);
  });

  it('is on with the flag and a non-production NODE_ENV', () => {
    expect(devLoginEnabled({ [DEV_LOGIN_VARIABLE]: '1', NODE_ENV: 'development' })).toBe(true);
  });

  it('is on with the flag and NO NODE_ENV at all', () => {
    // `next dev` sets NODE_ENV, but a bare `tsx` or a test runner does not, and
    // refusing there would make the flag untestable without faking a second
    // variable. Absence is not production.
    expect(devLoginEnabled({ [DEV_LOGIN_VARIABLE]: '1' })).toBe(true);
  });

  it('REFUSES when NODE_ENV is production, with the flag set', () => {
    // The load-bearing case, and the reason this module exists in this shape.
    // A deployment that copied .env.example and filled in the flag must be
    // exactly as closed as one that did not.
    expect(devLoginEnabled({ [DEV_LOGIN_VARIABLE]: '1', NODE_ENV: 'production' })).toBe(false);
  });

  it('REFUSES when NODE_ENV is passed as the explicit override and says production', () => {
    // The second parameter exists so a caller can state the environment rather
    // than inherit it. This asserts that path reaches the same verdict, because
    // a guard with two inputs and one tested input is half a guard.
    const env = { [DEV_LOGIN_VARIABLE]: '1', NODE_ENV: 'development' } as const;
    expect(devLoginEnabled(env, 'production')).toBe(false);
    expect(devLoginEnabled(env, 'development')).toBe(true);
  });

  it('treats every near-miss value as off', () => {
    // `'true'` is the value somebody reaches for first, so it is the one that
    // has to be wrong. A flag whose accepted spellings are negotiable is a flag
    // that gets set to the wrong thing and then looks broken.
    for (const value of ['true', 'yes', 'on', '0', 'false', ' 1', '1 ', '01', '']) {
      // Asserted per value rather than in a loop with a message argument:
      // `toBe` takes one, and passing a second to make the failure readable
      // makes the file not typecheck. The value is in the payload on failure.
      expect({
        value,
        enabled: devLoginEnabled({ [DEV_LOGIN_VARIABLE]: value, NODE_ENV: 'development' }),
      }).toEqual({ value, enabled: false });
    }
  });
});

describe('devLoginRefusal', () => {
  it('says nothing when the flag was never set', () => {
    // Silence is the correct answer here: a deployment that has never heard of
    // the flag has nothing to be told.
    expect(devLoginRefusal({ NODE_ENV: 'development' })).toBeUndefined();
    expect(devLoginRefusal({ [DEV_LOGIN_VARIABLE]: '', NODE_ENV: 'development' })).toBeUndefined();
  });

  it('says nothing when the flag is working, because there is nothing wrong', () => {
    expect(devLoginRefusal({ [DEV_LOGIN_VARIABLE]: '1', NODE_ENV: 'development' })).toBeUndefined();
  });

  it('names NODE_ENV when the flag is set in production', () => {
    // The operator who set this needs to know it was IGNORED, not that it was
    // misconfigured. Those are different mistakes with different fixes, and the
    // message that does not distinguish them sends somebody to check a value
    // that was never the problem.
    const reason = devLoginRefusal({ [DEV_LOGIN_VARIABLE]: '1', NODE_ENV: 'production' });
    expect(reason).toContain('NODE_ENV=production');
    expect(reason).toContain('ignored');
    // And it must not suggest the value is the issue.
    expect(reason).not.toContain('does not turn the bypass on');
  });

  it('names the accepted value when the flag is set to something else', () => {
    const reason = devLoginRefusal({ [DEV_LOGIN_VARIABLE]: 'true', NODE_ENV: 'development' });
    expect(reason).toContain('"true"');
    expect(reason).toContain('"1"');
  });
});

describe('the name the chrome shows', () => {
  it('is not a GitHub login anyone could be mistaken for', () => {
    // The banner in DashboardShell prints this. It has to read as a mode rather
    // than as an account, because a reader who sees `signed in as dev` believes
    // something about their session that is not true.
    expect(DEV_LOGIN_NAME).toBe('dev-login');
    expect(DEV_LOGIN_NAME).toContain('-');
  });
});
