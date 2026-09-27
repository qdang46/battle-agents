import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentWatcher } from '@battle-agents/core';
import { AgentEventSchema } from '@battle-agents/protocol';

import * as aiderModule from '../../packages/adapters/aider/src/index.js';
import * as ampModule from '../../packages/adapters/amp/src/index.js';
import * as claudeModule from '../../packages/adapters/claude/src/index.js';
import * as codexModule from '../../packages/adapters/codex/src/index.js';
import * as cursorModule from '../../packages/adapters/cursor/src/index.js';
import * as geminiModule from '../../packages/adapters/gemini/src/index.js';
import * as gooseModule from '../../packages/adapters/goose/src/index.js';
import * as opencodeModule from '../../packages/adapters/opencode/src/index.js';
import * as piModule from '../../packages/adapters/pi/src/index.js';

/**
 * The shared adapter contract suite.
 *
 * Two beads reported independently that the suite their briefs name does not
 * exist, and both were right: the only trace of it was a comment in tool-map.ts
 * claiming it "asserts against the map directly", which was false. A gate that
 * exists in a comment is the failure this repository keeps paying for.
 *
 * WHAT THIS DOES AND DOES NOT ASSERT, because a suite that claims more than it
 * checks is the same defect. It cannot assert per-harness event coverage:
 * packages/adapters/_template declares REQUIRED_EVENT_TYPES as
 * session.started, session.ended, tool.started and tool.completed, and the
 * already-shipped adapters do not all meet it — Cursor writes no tool result
 * anywhere in its format, so a tool.completed would assert an outcome the file
 * does not contain. Asserting the template's list would be red on day one, and a
 * permanently red suite is switched off, which is worse than a narrow one.
 *
 * So it asserts the three properties that are true of every adapter by
 * construction, and that are each a real way to drift:
 *
 *   1. SHAPE — every adapter's watcher satisfies the same AgentWatcher contract,
 *      so a surface that watches one can watch any.
 *   2. VOCABULARY — every event an adapter emits validates against the frozen
 *      zod union. An adapter inventing an event is refused at the door with a
 *      400, and finding that out from a live server is a debugging session.
 *   3. THE TOOL MAP IS SHARED — an adapter that grows its own tool-name table
 *      is the two-copies-drift failure again, at the layer where drift is
 *      hardest to notice, because each copy is individually correct.
 *
 * The per-harness event lists belong beside each adapter's own fixtures, which
 * is where that evidence already is.
 */

const repoRoot = resolve(import.meta.dirname, '../..');
const adaptersDir = join(repoRoot, 'packages/adapters');

const ADAPTERS = [
  'aider',
  'amp',
  'claude',
  'codex',
  'cursor',
  'gemini',
  'goose',
  'opencode',
  'pi',
] as const;

/**
 * Each watcher, as a value of the type it must be assignable to.
 *
 * The annotation is the assertion. There is no runtime comparison here, and
 * there does not need to be: if an adapter's start() or stop() drifts from the
 * contract, this map stops compiling. That is the property a signature change
 * can silently undo, and it is why `stop` returning `Promise<void>` is checked
 * rather than merely documented — a `void` stop compiles everywhere and flushes
 * fire-and-forget on the way down.
 */
const WATCHER_TYPES: Readonly<
  Record<(typeof ADAPTERS)[number], abstract new (...args: never[]) => AgentWatcher>
> = {
  aider: aiderModule.AiderWatcher,
  amp: ampModule.AmpWatcher,
  claude: claudeModule.ClaudeWatcher,
  codex: codexModule.CodexWatcher,
  cursor: cursorModule.CursorWatcher,
  gemini: geminiModule.GeminiWatcher,
  goose: gooseModule.GooseWatcher,
  opencode: opencodeModule.OpenCodeWatcher,
  pi: piModule.PiWatcher,
};

function adapterSource(name: string, relative: string): string {
  const path = join(adaptersDir, name, 'src', relative);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function adapterTestFiles(name: string): string[] {
  const src = join(adaptersDir, name, 'src');
  if (!existsSync(src)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.ts')) found.push(full);
    }
  };
  walk(src);
  return found;
}

describe('every adapter satisfies the shared contract', () => {
  it('lists adapters that actually exist, so an empty scan cannot pass', () => {
    // The same floor tests/unit/source-alias-coverage.test.ts asserts for
    // aliases. A glob matching nothing and a tree with no adapters are the same
    // observation, and only one of them is a pass.
    for (const name of ADAPTERS) {
      expect(
        existsSync(join(adaptersDir, name, 'src', 'index.ts')),
        `${name} has no index.ts`,
      ).toBe(true);
    }
  });

  it('covers every adapter on disk, so adding one cannot skip the contract', () => {
    // The other direction, and it was the one that was missing.
    //
    // The list above is hand-written because vitest cannot resolve a computed
    // dynamic import — the comment in the barrel test records that failing at
    // runtime — so a hand-written list has a failure mode a glob does not: a
    // new adapter that is simply not in it. That is not a red suite, it is a
    // SILENT one. `amp` was added to this repository and this suite reported
    // 6/6 green while holding it to nothing at all: no shape check, no
    // vocabulary check, no tool-map check.
    //
    // The template's README does tell a contributor to add themselves by hand,
    // which is the right advice and the wrong safety net — a README is read
    // sometimes. This is what makes the omission impossible rather than
    // discouraged, and it costs one readdirSync.
    const onDisk = readdirSync(adaptersDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // `_template` is the thing copied FROM, not a harness. It has a watcher
      // class and would otherwise be held to a contract it only models.
      .filter((name) => name !== '_template')
      .filter((name) => existsSync(join(adaptersDir, name, 'src', 'index.ts')))
      .sort();

    expect(
      [...ADAPTERS].sort(),
      'an adapter exists on disk but is not in ADAPTERS, so nothing in this suite is ' +
        'checking it. Add the import and the WATCHER_TYPES entry.',
    ).toEqual(onDisk);
  });

  it('exports a watcher that satisfies AgentWatcher', () => {
    // Static imports, not a computed one. Vitest cannot resolve
    // `import(\`../../packages/adapters/${name}/src/index.js\`)` — it fails at
    // runtime with "Unknown variable dynamic import" — so a loop over barrels
    // would have to be one hand-written line per adapter. Written out, the list of adapters
    // under contract is also visible in the file rather than hidden in a glob.
    const barrels: Readonly<Record<string, unknown>> = {
      aider: aiderModule,
      amp: ampModule,
      claude: claudeModule,
      codex: codexModule,
      cursor: cursorModule,
      gemini: geminiModule,
      goose: gooseModule,
      opencode: opencodeModule,
      pi: piModule,
    };

    for (const name of ADAPTERS) {
      const module = barrels[name] as Record<string, unknown>;
      const watcherName = Object.keys(module).find((key) => key.endsWith('Watcher'));
      expect(watcherName, `${name} does not export a named *Watcher class`).toBeDefined();

      const Watcher = module[watcherName as string] as { prototype: AgentWatcher };
      const proto = Watcher.prototype;

      // Checked on the PROTOTYPE, not on an instance. The first version of this
      // constructed every watcher with no arguments and failed on
      // `undefined.transcriptPath`, which says nothing about the contract — a
      // watcher legitimately needs its options. Assignability to AgentWatcher is
      // the actual guarantee, and it is checked at compile time by the
      // `WATCHER_TYPES` map below; this is the runtime half.
      expect(typeof proto.start, `${name}.start`).toBe('function');
      expect(typeof proto.stop, `${name}.stop`).toBe('function');
    }
  });

  it('keeps every watcher assignable to AgentWatcher at compile time', () => {
    // The real contract, and the only one that survives a signature change:
    // a watcher that returns void from stop() compiles everywhere and flushes
    // fire-and-forget on the way down. `stop` returning Promise<void> was a
    // deliberate departure from the reference implementation, and this is what
    // stops it being quietly undone.
    // The assertion is the type annotation on WATCHER_TYPES; this test only
    // confirms the map covers the adapter list, so a seventh adapter cannot be
    // added to the tree and quietly left outside the contract.
    expect(Object.keys(WATCHER_TYPES).sort()).toEqual([...ADAPTERS].sort());
  });

  it('keeps tool-name normalisation shared rather than reimplemented per adapter', () => {
    // The map lives in @battle-agents/protocol. An adapter with its own table is
    // individually correct and collectively a set of copies that drift, which is
    // the same failure that made EventBuffer a shared package in the first
    // place. A raw map literal in an adapter is the tell.
    for (const name of ADAPTERS) {
      const source = adapterSource(name, 'watcher.ts') + adapterSource(name, 'index.ts');
      const declaresOwnMap = /\bconst\s+\w*(TOOL_NAME_MAP|TOOL_ZONE_MAP)\b/.test(source);
      expect(
        declaresOwnMap,
        `${name} declares its own tool map. Import normalizeToolName/getZoneForTool from ` +
          '@battle-agents/protocol instead; a per-adapter copy is correct on the day it is written.',
      ).toBe(false);
    }
  });

  it('emits only event types the frozen protocol union declares', () => {
    // The set of type names is read from the protocol source rather than from a
    // local list, because a local list is a copy that drifts — the same defect
    // this suite exists to catch elsewhere.
    //
    // It checks the NAME, not a parsed value. The first version built a probe
    // object of {type, sessionId, at} and ran the real zod schema over it, which
    // reported `claude: file.write is not a member of the AgentEvent union` —
    // and file.write very much is (agent-event.ts:94). What failed is that the
    // event extends the base with a required `path`, so a base-only probe is
    // invalid for every extended member. Validating the name is the property
    // that is actually at stake here: an adapter inventing a type is refused at
    // the door, and a missing required field is the adapter's own test's job.
    const protocolSource = readFileSync(
      join(repoRoot, 'packages/protocol/src/agent-event.ts'),
      'utf8',
    );
    const declared = new Set(
      [...protocolSource.matchAll(/baseEvent\('([a-z_]+\.[a-z_]+)'\)/g)].map((m) => m[1]),
    );
    expect(
      declared.size,
      'the protocol source declares no events, so this scan proves nothing',
    ).toBeGreaterThan(0);

    for (const name of ADAPTERS) {
      for (const file of adapterTestFiles(name)) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/\btype:\s*'([a-z_]+\.[a-z_]+)'/g)) {
          expect(
            declared.has(match[1]),
            `${name}: ${match[1]} is not a member of the AgentEvent union, so the server would ` +
              `refuse it with a 400. Add the event to the protocol, or fix the literal.`,
          ).toBe(true);
        }
      }
    }
  });

  it('keeps the protocol union parseable, so the name check is not reading a dead file', () => {
    // A floor on the scan above: if AgentEventSchema stopped accepting a known
    // member, the name-based test would keep passing while the door it guards
    // stood open. This asserts one real member still validates.
    const result = AgentEventSchema.safeParse({
      type: 'file.write',
      sessionId: 's',
      at: '2026-01-01T00:00:00.000Z',
      path: 'src/index.ts',
    });
    expect(result.success).toBe(true);
  });
});
