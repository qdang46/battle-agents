import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * That the composition root APPLIES the boundary, rather than merely importing it.
 *
 * ## Why this is a source check and not a runtime one
 *
 * `packages/api/src/handler-isolation.test.ts` proves the boundary works: a
 * throwing handler stops at itself and the handlers after it still run. It
 * builds its own runtime to do that, which is exactly the gap — a helper that
 * works and is never called looks identical to a helper that works and is
 * called, from inside the helper's own test suite.
 *
 * `apps/web/src/auth/wiring.test.ts` records this exact failure having happened
 * in this repository: `bootstrapGameAccount` was correct, exported, and covered
 * by a green e2e test that called it three times, and no code on the login path
 * called it at all. A real first login created the Better Auth user and no game
 * account.
 *
 * ## Why not a runtime test
 *
 * `createGameRuntime` takes concrete Drizzle repositories, so proving this
 * end-to-end means a real database and a broken feature injected into the real
 * extension list — and there is no way to make a real feature throw on demand
 * without adding a fault-injection switch to production code, which is a worse
 * thing to own than a source check. The check below is the strongest claim
 * available without it, and it is a claim about the actual file rather than
 * about a copy of it.
 *
 * ## The failure it is aimed at
 *
 * Reverting the `.map` is the edit that would silently unfix the bug: every
 * behavioural test in the api package would still pass, the import would still
 * be used by nothing, and the game would go back to starving every consumer
 * after the first throwing handler.
 */

const COMPOSITION = readFileSync(
  fileURLToPath(new URL('../../apps/web/src/composition.ts', import.meta.url)),
  'utf8',
);

describe('the composition root applies the per-handler boundary', () => {
  it('maps the whole extensions list through isolateHandlers', () => {
    // The `.map` and not an `isolateHandlers(...)` call per entry: a per-entry
    // wrap is nine edits to keep in step with nine features, and the first
    // feature added without it is the one that starves. Both the call and the
    // fact that it is applied to the ARRAY rather than to one entry are
    // asserted, because either one alone is satisfiable by a boundary that is
    // mounted on a single feature.
    expect(COMPOSITION).toMatch(/\]\.map\(\(feature\) => isolateHandlers\(feature, /);

    // Every feature is constructed inside that one array. If a feature were
    // added to a different `createRuntime` call it would be unprotected, and
    // the regex above would still pass.
    const runtimeCalls = COMPOSITION.match(/createRuntime\(/g) ?? [];
    expect(runtimeCalls).toHaveLength(1);
  });

  it('reports a failure loudly and durably, not by swallowing it', () => {
    // A reporter that only logged would leave the failure in a place nobody
    // looks, which is the outcome runtime.ts's own comment warns about — and
    // the comment in isolation.ts is worth exactly as much as the last time
    // somebody believed one.
    expect(COMPOSITION).toMatch(/dependencies\.log\?\.warn\(/);
    expect(COMPOSITION).toMatch(/store\.append\(fault\)/);
    expect(COMPOSITION).toMatch(/bus\.publish\(fault\)/);
  });

  it('names HANDLER_FAILED rather than repeating the string', () => {
    // A fault logged under one name and queried under another is a fault nobody
    // finds, and the two spellings would differ invisibly.
    const literals = COMPOSITION.match(/'handler\.failed'/g) ?? [];
    expect(literals).toHaveLength(0);
    expect(COMPOSITION).toMatch(/type: HANDLER_FAILED/);
  });
});
