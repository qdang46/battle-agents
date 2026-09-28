import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The repo root is two levels up: this file lives in tests/unit/. Resolving a
// single '..' would anchor the workspace scan at tests/ and every discovery
// helper below would read a path that does not exist.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKSPACE_SCOPE = '@battle-agents/';
const CORE_DIR = 'packages/core';
const ADAPTERS_DIR = 'packages/adapters';
const FEATURES_DIR = 'packages/features';
const INFRASTRUCTURE_DIR = 'packages/infrastructure';
const PACKAGE_CONTAINER_DIRS: readonly string[] = [ADAPTERS_DIR, FEATURES_DIR, INFRASTRUCTURE_DIR];
const TYPESCRIPT_EXTENSION = '.ts';
const IGNORED_DIRECTORIES: readonly string[] = ['dist', 'node_modules'];
const LAYER_ALLOWED_PACKAGES: readonly string[] = ['core', 'protocol', 'harness-runner'];
const GAME_VOCABULARY: readonly string[] = [
  'battle',
  'bounty',
  'guild',
  'level',
  'pet',
  'quest',
  'reputation',
  'xp',
];
// The workspace skeleton is fixed and must always exist. The FEATURE set is
// deliberately NOT listed here: section 12.1 requires that a feature be
// addable and removable as a unit, and scripts/removal-test.sh removes each
// feature directory in turn. Asserting a fixed feature list here would make the
// removal test fail for the wrong reason, on an assertion about layout rather
// than about coupling.
const REQUIRED_PACKAGE_DIRS: readonly string[] = [
  'apps/web',
  'packages/adapters/_template',
  'packages/adapters/claude',
  'packages/adapters/codex',
  'packages/adapters/cursor',
  'packages/adapters/gemini',
  'packages/adapters/opencode',
  'packages/adapters/pi',
  'packages/cli',
  'packages/core',
  'packages/game-client',
  'packages/mcp-server',
  'packages/protocol',
];
const IMPORT_SPECIFIER_PATTERNS: readonly RegExp[] = [
  /(?:from|import)\s+['"]([^'"]+)['"]/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
];

interface WorkspacePackage {
  readonly dir: string;
  readonly name: string;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function toRepoRelative(absolutePath: string): string {
  return toPosix(relative(REPO_ROOT, absolutePath));
}

/**
 * Reads a JSON file that is allowed to be JSONC.
 *
 * tsconfig.json is JSONC by TypeScript's own specification, and a config that
 * explains WHY it is shaped a particular way is more useful than one that is
 * silent. Parsing it with plain JSON.parse made the scaffold gate fail the
 * moment anybody wrote a comment in a tsconfig, which is a strong incentive to
 * delete every explanation in every config in the repository.
 *
 * Comments and trailing commas go; string contents do not, so a URL or a path
 * containing "//" is not mangled into a comment.
 */
function readJson(filePath: string): unknown {
  const source = readFileSync(filePath, 'utf8');
  // Group 1 captures a string, group 2 a comment. The callback keeps whatever
  // group 1 matched and blanks the rest — the alternative is to capture the
  // comment and get the indices backwards, which blanks every string too.
  const withoutComments = source
    .replace(/("(?:\\.|[^"\\])*")|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, (match, string) =>
      string === undefined ? ' ' : match,
    )
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(withoutComments) as unknown;
}

function readStringProperty(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected a JSON object');
  }
  const property: unknown = (value as Record<string, unknown>)[key];
  if (typeof property !== 'string') {
    throw new Error(`Expected "${key}" to be a string`);
  }
  return property;
}

function readBooleanProperty(value: unknown, key: string): boolean {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected a JSON object');
  }
  const property: unknown = (value as Record<string, unknown>)[key];
  if (typeof property !== 'boolean') {
    throw new Error(`Expected "${key}" to be a boolean`);
  }
  return property;
}

function listDirectories(absoluteDir: string): string[] {
  return readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !IGNORED_DIRECTORIES.includes(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function listTypeScriptFiles(absoluteDir: string): string[] {
  return readdirSync(absoluteDir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(TYPESCRIPT_EXTENSION))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function discoverPackageDirs(): string[] {
  const discovered: string[] = [];
  const parents = ['apps', 'packages', ADAPTERS_DIR, FEATURES_DIR, INFRASTRUCTURE_DIR].map((dir) =>
    join(REPO_ROOT, dir),
  );
  for (const parent of parents) {
    for (const child of listDirectories(parent)) {
      const dir = toRepoRelative(join(parent, child));
      if (!PACKAGE_CONTAINER_DIRS.includes(dir)) {
        discovered.push(dir);
      }
    }
  }
  return discovered.sort();
}

function discoverWorkspacePackages(): WorkspacePackage[] {
  return discoverPackageDirs().map((dir) => ({
    dir,
    name: readStringProperty(readJson(join(REPO_ROOT, dir, 'package.json')), 'name'),
  }));
}

function collectImportSpecifiers(absoluteFile: string): string[] {
  const source = readFileSync(absoluteFile, 'utf8');
  const matches = IMPORT_SPECIFIER_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)]);
  return matches.map((match) => match[1] ?? '');
}

function collectWorkspaceImports(packageDir: string): string[] {
  const sourceDir = join(REPO_ROOT, packageDir, 'src');
  return listTypeScriptFiles(sourceDir)
    .flatMap(collectImportSpecifiers)
    .filter((specifier) => specifier.startsWith(WORKSPACE_SCOPE));
}

// Comments and string literals are stripped before the vocabulary scan. Scanning
// raw text produced a false positive the moment anyone wrote a comment such as
// "a feature must not know about quests", which is exactly the kind of comment
// this codebase wants, and a guard that cries wolf gets switched off.
function stripCommentsAndLiterals(source: string): string {
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      // Strings in ONE pass, blanked to spaces rather than collapsed to a quote
      // or two, so the line structure the caller reports stays intact.
      //
      // Three separate passes, one per quote character, is what this replaced and
      // it was wrong in a way that only showed up on a real test name: the
      // single-quote pass ran first and did not know it was inside a
      // double-quoted string, so an apostrophe in a title like "the feature's
      // own objects" opened a "string" that ran to the next apostrophe in the
      // file. The match can span newlines, so it swallowed the rest of the file
      // and the guard reported every game word in it. One pass with a back
      // reference cannot be confused that way, because the closing quote it looks
      // for is the quote that opened the match.
      .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, (literal) => literal.replace(/[^\r\n]/g, ' '))
  );
}

// English does not pluralise uniformly: "bounty" becomes "bounties" by dropping
// the y, which a naive word+s or word+es pattern walks straight past. Generate
// the real forms instead of guessing suffixes.
function pluralPattern(word: string): RegExp {
  const forms = [word, `${word}s`, `${word}es`];
  if (word.endsWith('y')) {
    forms.push(`${word.slice(0, -1)}ies`);
  }
  if (/(s|x|z|ch|sh)$/.test(word)) {
    forms.push(`${word}es`);
  }
  const alternation = [...new Set(forms)].sort((a, b) => b.length - a.length).join('|');
  return new RegExp(`\\b(?:${alternation})\\b`, 'i');
}

function findGameVocabulary(packageDir: string): string[] {
  const sourceDir = join(REPO_ROOT, packageDir, 'src');
  return listTypeScriptFiles(sourceDir).flatMap((file) => {
    const source = stripCommentsAndLiterals(readFileSync(file, 'utf8'));
    return GAME_VOCABULARY.filter((word) => pluralPattern(word).test(source)).map(
      (word) => `${toRepoRelative(file)}: ${word}`,
    );
  });
}

function packageDirsUnder(parentDir: string): WorkspacePackage[] {
  return discoverWorkspacePackages().filter((workspacePackage) =>
    workspacePackage.dir.startsWith(`${parentDir}/`),
  );
}

describe('game vocabulary scanner', () => {
  // The scanner is a guard, and a guard that cannot be trusted is worse than
  // none: it either reports words that are not there, which teaches people to
  // ignore it, or misses words that are.
  const scansClean = (source: string): boolean =>
    !/\bquest\b/i.test(stripCommentsAndLiterals(source));

  it('does not read a word out of a comment', () => {
    expect(scansClean('// a feature must not know about quests\n')).toBe(true);
    expect(scansClean('/* quests are somebody else\x27s problem */\n')).toBe(true);
  });

  it('does not read a word out of a string in any quote style', () => {
    expect(scansClean("const id = 'quest.claim';\n")).toBe(true);
    expect(scansClean('const id = "quest.claim";\n')).toBe(true);
    expect(scansClean('const id = `quest.claim`;\n')).toBe(true);
  });

  it('does not lose the rest of the file over an apostrophe in a double-quoted string', () => {
    // This is the regression: the single-quote pass ran first and treated the
    // apostrophe in "the feature's own objects" as an opening quote, then
    // matched across newlines to the next apostrophe in the file. The real
    // declaration on the next line was swallowed into a "string" and the guard
    // reported the opposite of the truth — clean code called a violation, and a
    // genuine violation in the same file would have been read as part of it.
    const source = ['const a = "the feature\'s own objects";', 'const quest = 1;', ''].join('\n');

    const stripped = stripCommentsAndLiterals(source);

    expect(stripped.split('\n')).toHaveLength(3);
    expect(stripped.split('\n')[0]).not.toMatch(/\bobjects\b/);
    // Line two is code, not a string, so it must still be readable.
    expect(stripped.split('\n')[1]).toMatch(/\bquest\b/);
  });

  it('still reports a word that really is in the code', () => {
    expect(scansClean('const quest = 1;\n')).toBe(false);
    expect(scansClean('quest.claim();\n')).toBe(false);
  });
});

describe('monorepo scaffold', () => {
  it('keeps the workspace skeleton intact and allows new packages', () => {
    // Subset, not exact equality: extra dirs are always allowed, so adding a
    // feature or adapter needs no edit here.
    const actual = discoverPackageDirs();
    const missing = REQUIRED_PACKAGE_DIRS.filter((dir) => !actual.includes(dir));
    expect(missing).toEqual([]);
  });

  it('names every package after its directory inside the workspace scope', () => {
    for (const workspacePackage of discoverWorkspacePackages()) {
      expect(workspacePackage.name).toBe(`${WORKSPACE_SCOPE}${basename(workspacePackage.dir)}`);
    }
  });

  it('keeps every package private and buildable from the shared base config', () => {
    for (const workspacePackage of discoverWorkspacePackages()) {
      const packageRoot = join(REPO_ROOT, workspacePackage.dir);
      const manifest = readJson(join(packageRoot, 'package.json'));
      const tsconfig = readJson(join(packageRoot, 'tsconfig.json'));

      expect(readBooleanProperty(manifest, 'private'), workspacePackage.dir).toBe(true);
      expect(manifest, workspacePackage.dir).toHaveProperty('exports');
      expect(readStringProperty(tsconfig, 'extends')).toMatch(/tsconfig\.base\.json$/);
      expect(listTypeScriptFiles(join(packageRoot, 'src'))).toContain(
        join(packageRoot, 'src', `index${TYPESCRIPT_EXTENSION}`),
      );
    }
  });

  it('never lets a feature import another feature', () => {
    for (const feature of packageDirsUnder(FEATURES_DIR)) {
      for (const specifier of collectWorkspaceImports(feature.dir)) {
        const imported = specifier.slice(WORKSPACE_SCOPE.length);
        expect(
          LAYER_ALLOWED_PACKAGES.includes(imported),
          `${feature.name} must not import ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('confines adapters to core and protocol', () => {
    for (const adapter of packageDirsUnder(ADAPTERS_DIR)) {
      for (const specifier of collectWorkspaceImports(adapter.dir)) {
        const imported = specifier.slice(WORKSPACE_SCOPE.length);
        expect(
          LAYER_ALLOWED_PACKAGES.includes(imported),
          `${adapter.name} must not import ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('keeps core free of workspace imports and game vocabulary', () => {
    expect(collectWorkspaceImports(CORE_DIR)).toEqual([]);
    expect(findGameVocabulary(CORE_DIR)).toEqual([]);
  });
});
