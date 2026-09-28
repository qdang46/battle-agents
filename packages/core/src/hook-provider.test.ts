import { describe, expect, it } from 'vitest';

import { NAMESPACED_ID_PATTERN } from './actions.js';

import {
  HOOK_PROVIDER_ID_PATTERN,
  isHookProviderId,
  namespacedSessionId,
  type HookProvider,
  type TeamProvider,
} from './hook-provider.js';
import type { GameEvent } from './event.js';

/**
 * The seam, checked at the boundary that matters.
 *
 * A provider is the one place a harness's own vocabulary meets the runtime's.
 * Two properties have to hold and neither is visible from the type: a provider
 * must not be able to mint its own event shape, and two harnesses must not be
 * able to collide. The second is the more dangerous, because a shared id means
 * a shared installation, a shared consent record and shared hooks, and none of
 * those fail loudly.
 */

/** A provider that satisfies the interface and records what it was asked. */
function stubProvider(overrides: Partial<HookProvider> = {}): HookProvider & {
  readonly installed: string[];
  readonly stopped: number;
} {
  const installed: string[] = [];
  let stopped = 0;
  const provider = {
    kind: 'hook' as const,
    id: 'anthropic.claude',
    displayName: 'Claude Code',
    protocolVersion: 1,
    translateHookEvent: (raw: Record<string, unknown>) =>
      raw.kind === 'ignored'
        ? null
        : { sessionId: 's1', event: { type: 'x' } as unknown as GameEvent },
    installHooks: async (target: { serverUrl: string; authToken: string }) => {
      installed.push(target.serverUrl);
    },
    uninstallHooks: async () => {
      stopped += 1;
      installed.length = 0;
    },
    areHooksInstalled: async () => installed.length > 0,
    consentDisclosure: () => ({
      headline: 'Install hooks?',
      disclosure: 'Writes to settings.json.',
    }),
    permissionExemptTools: new Set(['Read']),
    subagentToolNames: new Set(['Agent']),
    readingTools: new Set(['Read', 'Grep']),
    ...overrides,
    installed,
    get stopped() {
      return stopped;
    },
  };
  return provider as HookProvider & { installed: string[]; stopped: number };
}

describe('provider ids', () => {
  it('accepts a namespaced id', () => {
    expect(isHookProviderId('anthropic.claude')).toBe(true);
    // 'vendor.some-cli' was valid HERE and invalid as an action id, because this
    // file's regex allowed a hyphen in a later segment and actions.ts's did not.
    // One pattern means the answer is the same in both places, and a provider id
    // is now exactly as strict as an action id.
    expect(isHookProviderId('vendor.some-cli')).toBe(false);
    expect(isHookProviderId('vendor.somecli')).toBe(true);
  });

  it('rejects a bare harness name', () => {
    // The case that matters: the first provider ships as `anthropic.claude`, and
    // someone later writes `claude` because that is what the vendor calls it.
    // Two ids then key two different installs, and the older hooks are orphaned
    // with no uninstall path.
    expect(isHookProviderId('claude')).toBe(false);
    expect(isHookProviderId('copilot')).toBe(false);
  });

  it('rejects an id that is not lower-case or is malformed', () => {
    expect(isHookProviderId('Anthropic.Claude')).toBe(false);
    expect(isHookProviderId('anthropic..claude')).toBe(false);
    expect(isHookProviderId('.claude')).toBe(false);
    expect(isHookProviderId('anthropic.')).toBe(false);
    expect(isHookProviderId('')).toBe(false);
  });

  it('exposes the same pattern it tests with', () => {
    // If the function and the pattern were separate they could drift, and the
    // function is the one callers use.
    expect(HOOK_PROVIDER_ID_PATTERN.test('anthropic.claude')).toBe(true);
  });
});

describe('namespacedSessionId', () => {
  it('keeps two harnesses apart when they mint the same raw id', () => {
    // Not hypothetical: the CLIs here use UUIDs and hyphens, and a harness that
    // ships its own id scheme will eventually collide.
    const claude = namespacedSessionId('anthropic.claude', 'abc-123');
    const codex = namespacedSessionId('openai.codex', 'abc-123');
    expect(claude).not.toBe(codex);
  });

  it('round-trips so the provider can be recovered from the id', () => {
    const id = namespacedSessionId('anthropic.claude', 'abc-123');
    const [provider] = id.split(':');
    expect(provider).toBe('anthropic.claude');
  });

  it('refuses to namespace under an invalid provider id', () => {
    // Throwing rather than producing `claude:abc` is the point: the helper is
    // the last place a bare name could still take root.
    expect(() => namespacedSessionId('claude', 'abc-123')).toThrow(/namespaced/);
  });

  it('leaves a session id containing the separator unambiguous enough to read', () => {
    const id = namespacedSessionId('anthropic.claude', 'a:b:c');
    expect(id.startsWith('anthropic.claude:')).toBe(true);
  });
});

describe('the provider contract', () => {
  it('installs against a named target rather than two positional strings', async () => {
    const provider = stubProvider();
    await provider.installHooks({ serverUrl: 'http://127.0.0.1:3000', authToken: 't' });
    expect(provider.installed).toEqual(['http://127.0.0.1:3000']);
  });

  it('reports installed state from what it actually installed', async () => {
    const provider = stubProvider();
    expect(await provider.areHooksInstalled()).toBe(false);
    await provider.installHooks({ serverUrl: 'http://127.0.0.1:3000', authToken: 't' });
    expect(await provider.areHooksInstalled()).toBe(true);
    await provider.uninstallHooks();
    expect(await provider.areHooksInstalled()).toBe(false);
  });

  it('returns null for a payload it does not model, rather than throwing', () => {
    // A harness posts events this seam has no interest in. Throwing here would
    // take down the ingest path for every other event in the batch.
    const provider = stubProvider();
    expect(provider.translateHookEvent({ kind: 'ignored' })).toBeNull();
  });

  it('carries a consent disclosure, because installing anything must state its terms', () => {
    const { headline, disclosure } = stubProvider().consentDisclosure();
    expect(headline.length).toBeGreaterThan(0);
    expect(disclosure.length).toBeGreaterThan(0);
  });
});

describe('the optional team extension', () => {
  it('is satisfiable by a single-agent harness that simply has none', () => {
    // Absence is the normal case, and `exactOptionalPropertyTypes` is on, so the
    // real shape of a single-agent provider has no `team` key at all rather than
    // an explicit undefined. A single-agent adapter must not be made to write
    // four methods that always return nothing.
    const singleAgent = stubProvider();
    expect('team' in singleAgent).toBe(false);
    expect(singleAgent.kind).toBe('hook');
  });

  it('carries the team extension only when a provider opts in', () => {
    const team: TeamProvider = {
      discoverTeammates: async () => ['a', 'b'],
      getTeamMembers: async () => ['lead', 'a', 'b'],
      getTeamMetadataForSession: async () => ({ teamName: 'squad' }),
      isTeammateSpawnCall: () => true,
    };
    const withTeams = stubProvider({ team });
    expect(withTeams.team?.isTeammateSpawnCall('Agent', {})).toBe(true);
  });
  it('uses the SAME pattern as an action id, so the two cannot drift again', () => {
    // This file's comment and actions.ts's comment both said they were the same
    // rule. They were not: the provider pattern allowed a hyphen in a later
    // segment and the action pattern did not, so 'vendor.some-cli' was a valid
    // provider and an invalid action — and a test on either side alone would
    // have passed.
    expect(HOOK_PROVIDER_ID_PATTERN).toBe(NAMESPACED_ID_PATTERN);
  });
});
