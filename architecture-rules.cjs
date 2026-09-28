'use strict';

// Single source of truth for the layering contract (`plan section 19`):
// presentation -> features -> core <- infrastructure, features never import each
// other, adapters and interfaces import core + protocol only. It exports the
// ARCHITECTURE RULE ENGINE. Read this before reaching for a tool.
//
// This is NOT a dependency-cruiser config and no dependency-cruiser CLI can
// consume it. The real CLI expects a config object and structured-clones the
// module; running "npx dependency-cruiser --config architecture-rules.cjs"
// fails, and "npx depcruise" resolves to an unrelated security tool that exits 0
// no matter what is in the tree. A file once named .dependency-cruiser.cjs made both
// of those look plausible, which is worse than not having the file.
//
// The single supported entry point is checkImports(), plus checkContent() for the
// rules that are about what code SAYS rather than what it imports. Both are
// exercised by tests/unit/dependency-rules.test.ts against a fixture, and by
// scripts/check-architecture.ts against the real tree, which is a pipeline
// stage. If you add a rule, add a fixture that triggers it: the test asserts
// every declared rule is exercised, so a rule nobody watches work fails CI.
//
// Layer rules expressed as forbidden pairs plus the rule engine that
// `tests/dependency-rules.test.ts` runs over both fixtures and this repository.

const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join, posix, relative, sep } = require('node:path');

const WORKSPACE_SCOPE = '@battle-agents/';

// Returned when a specifier is inside our own scope but names no package we can
// find. It used to be null, which is the same value used for a genuinely
// external import, so a typo or a stale specifier was skipped without a word.
// The "typecheck will catch it" argument only holds if typecheck always runs
// alongside, and this config is also runnable on its own, so the file has to
// speak up for itself.
// A string, not a Symbol. The real dependency-cruiser CLI structured-clones
// module state, and Symbol cannot be cloned, so the CLI died with "Symbol(...)
// could not be cloned" on a CLEAN tree. vitest never surfaced it because it
// calls checkImports in-process, so the two paths disagreed and only one was
// ever exercised.
const UNRESOLVED_WORKSPACE_IMPORT = '@@unresolved-workspace-import@@';

// It does not fit FORBIDDEN, whose rules are shaped source-layer to
// target-layers, because there is no target: the import resolves to nothing. It
// is still a rule, and it is declared in one place so the test that asserts the
// contract is complete does not have to know the name by heart.
const UNRESOLVED_RULE = {
  name: 'unresolved-workspace-import',
  reason:
    'Specifier is inside the @battle-agents scope but no package with that name exists. ' +
    'An import nobody can resolve is also an import no rule can check, so it is reported ' +
    'rather than skipped.',
};
const UNCLASSIFIED_LAYER = 'unclassified';
const UNCLASSIFIED_RULE = 'unclassified-layer';
const UNCLASSIFIED_REASON =
  'Classify this package in architecture-rules.cjs before depending on it, otherwise the layering guarantee silently stops covering it.';
const SOURCE_ROOTS = ['apps', 'packages', 'drizzle'];
// packages/db holds the schema source and the database client, which the plan
// taxonomy puts in infrastructure. It is scanned because an import that resolves
// to nothing in the schema is as invisible as one in a package, and while it
// lived at the repository root the engine skipped the one directory the
// schema-hygiene gate cares about. Unclassified code is reported rather than
// ignored, so adding a root without classifying it fails loudly, which is the
// behaviour that makes this safe to extend.
const FEATURES_DIR = 'packages/features';
const ADAPTERS_DIR = 'packages/adapters';
// A fourth container, and the reason the infrastructure LAYER entry below
// matches a nested path (`packages/infrastructure/<name>`) rather than a flat
// one. Infrastructure packages nest the way features do, so the discovery walk
// has to descend one level here too — otherwise it finds a container with no
// manifest, registers nothing below it, and every `@battle-agents/<name>` import
// from one is reported as unresolved.
const INFRASTRUCTURE_DIR = 'packages/infrastructure';
const PACKAGE_CONTAINERS = [...SOURCE_ROOTS, ADAPTERS_DIR, FEATURES_DIR, INFRASTRUCTURE_DIR];
const IGNORED_DIRECTORY_NAMES = ['dist', 'node_modules', '.git', '.tmp', '.beads'];
const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
// A NUL cannot occur in a rule name, path or specifier, so it joins the dedupe key
// without the ambiguity a space or a dash would introduce. Written as an escape so the
// file stays plain text and every text tool can read it.
const VIOLATION_KEY_SEPARATOR = '\0';
const IMPORT_SPECIFIER_PATTERNS = [
  /(?:from|import)\s+['"]([^'"]+)['"]/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const FEATURE_PATH = `${FEATURES_DIR}/*/**/*.ts`;

const LAYERS = [
  {
    name: 'feature',
    instance: /^packages\/features\/([^/]+)(?:\/|$)/,
    files: [FEATURE_PATH],
  },
  {
    name: 'adapter',
    instance: /^packages\/adapters\/([^/]+)(?:\/|$)/,
    files: ['packages/adapters/*/**/*.ts'],
  },
  {
    name: 'interface',
    // packages/api is the shared Application API the three surfaces consume.
    // It is classified here rather than given a layer of its own because it
    // imports core and nothing else: it decides nothing about the game, it
    // reads the registry and calls through it. A layer of its own would let it
    // grow imports the other consumers are forbidden.
    instance: /^(?:packages\/(?:api|cli|mcp-server)(?:\/|$)|packages\/interfaces\/[^/]+(?:\/|$))/,
    files: [
      'packages/api/**/*.ts',
      'packages/cli/**/*.ts',
      'packages/mcp-server/**/*.ts',
      'packages/interfaces/*/**/*.ts',
    ],
  },
  {
    name: 'infrastructure',
    instance: /^(?:drizzle(?:\/|$)|packages\/(?:infrastructure(?:\/[^/]+)?|db)(?:\/|$))/,
    files: ['packages/infrastructure/*/**/*.ts', 'packages/db/**/*.ts'],
  },
  {
    name: 'core',
    instance: /^packages\/core(?:\/|$)/,
    files: ['packages/core/**/*.ts'],
  },
  {
    name: 'protocol',
    instance: /^packages\/protocol(?:\/|$)/,
    files: ['packages/protocol/**/*.ts'],
  },
  {
    // A process runner, not a wire format — it reads the filesystem to tell a
    // file from a directory and installs signal handlers, which protocol
    // deliberately stays free of. Classified separately rather than folded into
    // protocol so an adapter's `bin` can depend on it without adapters at large
    // gaining a filesystem/process dependency through protocol.
    name: 'harness-runner',
    instance: /^packages\/harness-runner(?:\/|$)/,
    files: ['packages/harness-runner/**/*.ts'],
  },
  {
    name: 'presentation',
    instance:
      /^(?:apps\/web|apps\/presentation\/[^/]+|packages\/game-client|packages\/presentation\/[^/]+)(?:\/|$)/,
    files: [
      'apps/web/**/*.ts',
      'apps/presentation/*/**/*.ts',
      'packages/game-client/**/*.ts',
      'packages/presentation/*/**/*.ts',
    ],
  },
];

const FORBIDDEN = [
  {
    name: 'no-feature-cross-import',
    from: { layer: 'feature' },
    to: { layers: ['feature'], differentInstance: true },
    reason:
      'Features never import each other; a cross-feature need goes through a capability declared in core (plan section 19).',
  },
  {
    name: 'no-feature-import-of-outer-layers',
    from: { layer: 'feature' },
    to: { layers: ['adapter', 'interface', 'infrastructure', 'presentation'] },
    reason:
      'A feature depends on core and protocol only; features never import Docker, Compose or Postgres-container concepts (plan sections 19 and 37).',
  },
  {
    name: 'no-core-import-of-outer-layers',
    from: { layer: 'core' },
    to: { layers: ['feature', 'adapter', 'interface', 'infrastructure', 'presentation'] },
    reason:
      'Core knows only primitives, so core importing a feature, adapter, interface or infrastructure package is the God-Engine antipattern (plan section 19).',
  },
  {
    name: 'no-adapter-game-code',
    from: { layer: 'adapter' },
    to: { layers: ['feature', 'adapter', 'interface', 'infrastructure', 'presentation'] },
    reason:
      'Adapters import core and protocol only; no adapter imports game code (plan sections 19 and 23).',
  },
  {
    name: 'no-interface-feature-implementation',
    from: { layer: 'interface' },
    to: { layers: ['feature', 'adapter', 'infrastructure', 'presentation'] },
    reason:
      'Interfaces consume features through the capability registry, never by importing a feature implementation (plan section 36).',
  },
  {
    name: 'no-route-handler-game-logic',
    from: {
      layer: 'presentation',
      // Only the Next.js route tree, not the whole presentation layer. The
      // composition root in apps/web/src imports features on purpose and is the
      // one place that decides which features exist.
      files: ['apps/web/app/**/*.ts', 'apps/web/app/**/*.tsx'],
    },
    to: { layers: ['feature', 'adapter'] },
    reason:
      'A route handler authenticates, translates a request into an application command, and translates the answer back. Reaching into a feature or an adapter makes it the second place that knows a capability exists, and the CLI and MCP cannot reach that decision (plan sections 22 and 32).',
  },
  {
    name: 'no-infrastructure-import-of-upper-layers',
    from: { layer: 'infrastructure' },
    to: { layers: ['feature', 'adapter', 'interface', 'presentation'] },
    reason:
      'Infrastructure implements the core persistence boundary, so it must not depend on the layers that consume it (plan section 19).',
  },
];

/**
 * The rule the layer pairs above cannot express, because it is about the ROUTE
 * an import takes rather than the layers it connects.
 *
 * Every entry in `FORBIDDEN` is a question about direction: may this layer
 * depend on that one. None of them is a question about the public surface, and
 * that gap was demonstrable rather than theoretical. An adapter may depend on
 * `core`, so nothing fired when the template's parser reached for
 * `'../../../core/src/runtime.js'` — a file in a package that is frozen, read
 * past its own barrel, resolving to a legal layer. `pnpm architecture` reported
 * "no violations" for exactly that edit, and the guarantee the plan makes in
 * section 23, that an adapter imports core and protocol and nothing else, was
 * being kept by the convention that people import packages by name.
 *
 * So the answer is a rule on the specifier form, checked only after the layer
 * rules have declined. That ordering is what keeps this additive: a relative
 * import that already breaks a layer rule is still reported under that rule, so
 * no existing fixture changes which rule it trips and every layer rule keeps
 * being proved by the fixture that was written for it. What is left is exactly
 * the case with no other name attached — a legal dependency taken illegally.
 *
 * The tree agrees: there is no cross-package relative import outside
 * `dependency-rules.test.ts`'s own fixture, so this is green on the day it is
 * added rather than a rule that needs a migration.
 */
const CROSS_PACKAGE_RELATIVE_RULE = {
  name: 'no-cross-package-relative-import',
  reason:
    'Reach another package by its name, not by its path. A relative import into a different package bypasses that package’s public surface, which is the surface its contract and its version are published through; a file nobody agreed to freeze becomes a dependency that no manifest records and no release note mentions (plan sections 16 and 23).',
};

/* ── content rules ──
 *
 * Everything above is about EDGES: which package may import which. A content
 * rule is about TEXT. They are declared here rather than in a script of their
 * own for the reason the whole file is one file: tests/unit/dependency-rules.test.ts
 * asserts that every declared rule has a fixture that trips it, and a second
 * file with a second registry is a second list to forget.
 *
 * The one rule here is the integrity property no layering rule can express. An
 * experience award computed from a token count typechecks, imports nothing, and
 * passes all seven forbidden pairs, because what it breaks is an ECONOMY rather
 * than a dependency. Plan sections 10.2, 10.3 and 17 are explicit that
 * experience comes from work and never from tokens or tool counts, and a
 * comment saying so is a claim rather than a check.
 */

/**
 * A token COUNT, which is not the same word as a credential.
 *
 * `packages/features/agent/src/credential.ts` mints bearer tokens, and that is
 * an identity concern with nothing to do with pricing. No allowlist is needed:
 * a line only trips the rule when it ALSO mentions experience, and a line that
 * hashed a token and priced something on the same line would be a bug of a
 * different and more interesting kind.
 */
const TOKEN_COUNT = /\w*tokens?\w*/i;
const EXPERIENCE_AMOUNT = /\bxp\b|experience/i;

/**
 * Comments and string literals, removed.
 *
 * Not an optimisation. `rules.test.ts` asserts that no outcome type contains
 * "token", and the string that says so contains the word; scanning raw text
 * would report the guard against the economy as an instance of the economy, and
 * a guard that cries wolf gets switched off. The replacement keeps newlines, so
 * the line a violation is reported at is the line it is on.
 */
function stripCommentsAndLiterals(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, (literal) => literal.replace(/[^\n]/g, ' '));
}

const CONTENT_RULES = [
  {
    name: 'no-token-derived-experience',
    files: [FEATURE_PATH],
    reason:
      'Experience is awarded from outcomes — a completed bounty, a merged pull request, a passed test, a recovery, a won battle — and never from how much the agent spent running them (plan sections 10.2, 10.3 and 17). A token economy would pay an agent for spending tokens to earn experience for spending tokens, which is the one design in this plan that makes the product worse the more people use it.',
    detect: (line) => TOKEN_COUNT.test(line) && EXPERIENCE_AMOUNT.test(line),
  },
];

/**
 * The line-level limit of that rule, stated where the rule is declared.
 *
 * A derivation split across two statements, with the count stashed in a local
 * whose name does not mention tokens, is not on one line and is not caught. What
 * IS caught is every shape that has appeared in practice — `xp: payload.tokens / 100`,
 * `Math.floor(outcome.tokensSpent * 0.1)`, `const xp = tokens;` — and a check
 * that quietly implied it covered the rest would be the exact defect this file
 * exists to prevent, so the limit is written down rather than left to be
 * discovered.
 */
function checkContent({ files }) {
  const violations = [];
  for (const file of files) {
    if (
      !matchesAnyGlob(
        CONTENT_RULES.flatMap((rule) => rule.files),
        file.path,
      )
    ) {
      continue;
    }
    const lines = stripCommentsAndLiterals(file.source).split('\n');
    lines.forEach((line, index) => {
      for (const rule of CONTENT_RULES) {
        if (rule.detect(line)) {
          violations.push(
            buildViolation({
              rule: rule.name,
              from: `${file.path}:${index + 1}`,
              to: line.trim(),
              specifier: null,
              reason: rule.reason,
            }),
          );
        }
      }
    });
  }
  const deduplicated = new Map(violations.map((violation) => [violationKey(violation), violation]));
  return [...deduplicated.values()].sort((left, right) =>
    violationKey(left).localeCompare(violationKey(right)),
  );
}

function toPosix(filePath) {
  return filePath.split(sep).join('/');
}

function toPosixRelative(repoRoot, absolutePath) {
  return toPosix(relative(repoRoot, absolutePath));
}

function isContainerDir(repoRelativeDir) {
  return (
    repoRelativeDir === FEATURES_DIR ||
    repoRelativeDir === ADAPTERS_DIR ||
    repoRelativeDir === INFRASTRUCTURE_DIR
  );
}

function listDirectoryNames(absoluteDir) {
  if (!existsSync(absoluteDir)) {
    return [];
  }
  return readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !IGNORED_DIRECTORY_NAMES.includes(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function readManifestName(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return typeof manifest.name === 'string' ? manifest.name : null;
}

function discoverWorkspacePackages(repoRoot) {
  const packages = [];
  for (const container of PACKAGE_CONTAINERS) {
    for (const name of listDirectoryNames(join(repoRoot, container))) {
      const dir = toPosix(join(container, name));
      if (isContainerDir(dir)) {
        continue;
      }
      const manifestPath = join(repoRoot, dir, 'package.json');
      const packageName = existsSync(manifestPath) ? readManifestName(manifestPath) : null;
      if (packageName !== null) {
        packages.push({ dir, name: packageName });
      }
    }
  }
  return packages.sort((left, right) => left.dir.localeCompare(right.dir));
}

function listFeatureInstances(repoRoot) {
  return listDirectoryNames(join(repoRoot, FEATURES_DIR));
}

function listSourceFiles(repoRoot) {
  const files = [];
  const visit = (absoluteDir) => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      if (IGNORED_DIRECTORY_NAMES.includes(entry.name)) {
        continue;
      }
      const absolutePath = join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (TYPESCRIPT_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        files.push({
          path: toPosixRelative(repoRoot, absolutePath),
          source: readFileSync(absolutePath, 'utf8'),
        });
      }
    }
  };
  for (const root of SOURCE_ROOTS) {
    if (existsSync(join(repoRoot, root))) {
      visit(join(repoRoot, root));
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * The package a repo-relative path belongs to: everything up to and including
 * the leaf package directory, so `packages/adapters/claude/src/parser.ts` and
 * `packages/adapters/claude/src/index.ts` share `packages/adapters/claude`.
 *
 * A package importing its own files is not crossing a layer. The rule set has
 * to say so explicitly, because `no-adapter-game-code` lists 'adapter' among
 * the forbidden targets to stop one adapter reaching into another, and without
 * this that same rule flags an adapter importing a sibling file in its own
 * directory. That is not a cosmetic difference: it would make "a new CLI is one
 * subdirectory" impossible to keep, because any adapter with more than one file
 * would fail the gate.
 */
function packageRootOf(repoRelativePath) {
  const parts = repoRelativePath.split('/');
  // FEATURES_DIR and ADAPTERS_DIR are full prefixes like 'packages/features',
  // so the test is on the first two segments, not on a leaf name. Comparing
  // the wrong thing here silently collapsed every feature into one package,
  // and the exemption then swallowed feature-to-feature imports, which is the
  // one thing the rule exists to catch.
  const head = parts.slice(0, 2).join('/');
  const featuresAt = head === FEATURES_DIR ? 1 : -1;
  const adaptersAt = head === ADAPTERS_DIR ? 1 : -1;
  const cut =
    featuresAt === -1
      ? adaptersAt
      : adaptersAt === -1
        ? featuresAt
        : Math.min(featuresAt, adaptersAt);
  if (cut === -1) {
    // Not a nested package: apps/web, or a top-level package like core.
    return parts.slice(0, 2).join('/');
  }
  return parts.slice(0, cut + 2).join('/');
}

function isSamePackage(fromPath, toPath) {
  return packageRootOf(fromPath) === packageRootOf(toPath);
}

function classifyPath(repoRelativePath) {
  for (const layer of LAYERS) {
    const match = layer.instance.exec(repoRelativePath);
    if (match) {
      return { layer: layer.name, instance: match[1] ?? null };
    }
  }
  return { layer: UNCLASSIFIED_LAYER, instance: null };
}

function collectImportSpecifiers(source) {
  return IMPORT_SPECIFIER_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)])
    .map((match) => match[1])
    .filter((specifier) => specifier !== undefined);
}

function candidateModulePaths(resolvedPath) {
  const withoutJsExtension = resolvedPath.endsWith('.js')
    ? `${resolvedPath.slice(0, -'.js'.length)}.ts`
    : resolvedPath;
  return [
    withoutJsExtension,
    resolvedPath,
    `${withoutJsExtension}.ts`,
    `${withoutJsExtension}.tsx`,
    posix.join(withoutJsExtension, 'index.ts'),
  ];
}

function resolveRelativeImport(fromPath, specifier, knownPaths) {
  const resolvedPath = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  return (
    candidateModulePaths(resolvedPath).find((candidate) => knownPaths.has(candidate)) ??
    resolvedPath
  );
}

function resolveWorkspaceTarget({ fromPath, specifier, knownPaths, packageDirsByName }) {
  if (specifier.startsWith('.')) {
    return resolveRelativeImport(fromPath, specifier, knownPaths);
  }
  if (!specifier.startsWith(WORKSPACE_SCOPE)) {
    return null;
  }
  return packageDirsByName.get(specifier) ?? UNRESOLVED_WORKSPACE_IMPORT;
}

/**
 * A `from.files` list narrows a rule to part of its layer.
 *
 * Layers are path-prefixed and too coarse for a rule that applies to one corner
 * of a layer: the composition root in `apps/web/src` imports features on
 * purpose, while a route handler under `apps/web/app` that imports one is
 * deciding game questions at the transport edge. Without this the only options
 * were to forbid the legal direction or to leave the illegal one unchecked.
 */
function globToRegExp(glob) {
  // Split on `**/` rather than substituting a sentinel character, so a glob that
  // legitimately contains the sentinel cannot be corrupted by it.
  const [head, ...tail] = glob.split('**/');
  const segments = [head, ...tail].map((part) =>
    part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'),
  );
  return new RegExp(`^${segments.join('(?:.*/)?')}$`);
}

function matchesAnyGlob(patterns, repoRelativePath) {
  return patterns.some((pattern) => globToRegExp(pattern).test(repoRelativePath));
}

function violatesRule(rule, source, target, fromPath) {
  if (source.layer !== rule.from.layer || !rule.to.layers.includes(target.layer)) {
    return false;
  }
  if (rule.from.files !== undefined && !matchesAnyGlob(rule.from.files, fromPath)) {
    return false;
  }
  if (!rule.to.differentInstance) {
    return true;
  }
  return (
    source.instance !== null && target.instance !== null && source.instance !== target.instance
  );
}

function buildViolation({ rule, from, to, specifier, reason }) {
  const subject = specifier === null ? from : `${from} imports '${specifier}'`;
  return {
    rule,
    from,
    to,
    specifier,
    message: `${rule}: ${subject} (resolves to ${to}). ${reason}`,
  };
}

function violationKey(violation) {
  return [violation.rule, violation.from, violation.to, violation.specifier].join(
    VIOLATION_KEY_SEPARATOR,
  );
}

function checkImports({ files, packages }) {
  const knownPaths = new Set(files.map((file) => file.path));
  const packageDirsByName = new Map(packages.map((entry) => [entry.name, entry.dir]));
  const violations = [];

  for (const file of files) {
    const source = classifyPath(file.path);
    if (source.layer === UNCLASSIFIED_LAYER) {
      violations.push(
        buildViolation({
          rule: UNCLASSIFIED_RULE,
          from: file.path,
          to: file.path,
          specifier: null,
          reason: UNCLASSIFIED_REASON,
        }),
      );
      continue;
    }
    for (const specifier of collectImportSpecifiers(file.source)) {
      const target = resolveWorkspaceTarget({
        fromPath: file.path,
        specifier,
        knownPaths,
        packageDirsByName,
      });
      if (target === null) {
        // A genuinely external import, which this file has no opinion about.
        continue;
      }
      if (target === UNRESOLVED_WORKSPACE_IMPORT) {
        violations.push(
          buildViolation({
            rule: 'unresolved-workspace-import',
            from: file.path,
            to: specifier,
            specifier,
            reason: UNRESOLVED_RULE.reason,
          }),
        );
        continue;
      }
      // An import that stays inside one package is not a layer crossing, and
      // several rules list their own layer among the forbidden targets. Check
      // this before consulting the rules, or a multi-file adapter cannot exist.
      if (isSamePackage(file.path, target)) {
        continue;
      }

      const rule = FORBIDDEN.find((candidate) =>
        violatesRule(candidate, source, classifyPath(target), file.path),
      );
      if (rule) {
        violations.push(
          buildViolation({
            rule: rule.name,
            from: file.path,
            to: target,
            specifier,
            reason: rule.reason,
          }),
        );
        continue;
      }

      // The layer pairs all declined, so the dependency itself is legal. What
      // is left to ask is whether it was taken through the other package's
      // source tree, which no layer question covers.
      if (specifier.startsWith('.')) {
        violations.push(
          buildViolation({
            rule: CROSS_PACKAGE_RELATIVE_RULE.name,
            from: file.path,
            to: target,
            specifier,
            reason: CROSS_PACKAGE_RELATIVE_RULE.reason,
          }),
        );
      }
    }
  }

  const deduplicated = new Map(violations.map((violation) => [violationKey(violation), violation]));
  return [...deduplicated.values()].sort((left, right) =>
    violationKey(left).localeCompare(violationKey(right)),
  );
}

function formatReport(violations) {
  return violations.map((violation) => violation.message).join('\n');
}

module.exports = {
  FORBIDDEN,
  CONTENT_RULES,
  CROSS_PACKAGE_RELATIVE_RULE,
  UNRESOLVED_RULE,
  UNRESOLVED_WORKSPACE_IMPORT,
  LAYERS,
  checkContent,
  checkImports,
  classifyPath,
  discoverWorkspacePackages,
  formatReport,
  listFeatureInstances,
  listSourceFiles,
};
