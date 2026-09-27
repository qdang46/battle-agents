import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The delivery ledger is a SHARED table, so a suite that wipes it is a suite
 * that can delete another suite's rows mid-run.
 *
 * ## What this exists for
 *
 * `github-webhook-end-to-end.test.ts` and `github-delivery-store.test.ts` both
 * began with `await database.delete(githubDeliveryClaims)` — the entire table —
 * and vitest runs test files in parallel workers against one database. Two
 * blanket deletes race, and the loser loses rows it wrote. The suite was
 * intermittent rather than reliably red, which is the worst shape a defect can
 * have: it looks like a flake, so it gets rerun instead of fixed.
 *
 * It was misdiagnosed twice on the way. The brief blamed a process-wide bus,
 * because the failing assertion was a length check and the file is named after
 * the bus. The real assertion was `expect(rows).toHaveLength(1)` over the whole
 * table, and the 17 it reported were sixteen `d-*` rows belonging to the other
 * suite plus its own one. A comment in the webhook file had already recorded
 * that the bus was never involved; the comment was right and was not believed.
 *
 * ## Why a comment was not enough
 *
 * Both files now scope their cleanup, and both say why in prose. Prose is a
 * claim. This is the check, and it fails if a suite adds an unscoped delete back
 * — which is the change most likely to be made by someone who has no reason to
 * read either comment, and who will find the blanket delete waiting for them in
 * a dozen other fixtures.
 *
 * ## Deliberately narrow
 *
 * It checks THIS table, not "test isolation" in general. A general check here
 * would pass or fail on things this defect has nothing to do with, and would
 * eventually be disabled when it went red for an unrelated reason — which is how
 * the schema-hygiene gate died twice.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SUITE_DIR = join(REPO_ROOT, 'tests', 'integration');
/** The drizzle table, as a suite would name it at a call site. */
const DELETE_CALL = '.delete(githubDeliveryClaims)';

/** This file's own source contains the pattern as a string, so it excludes itself. */
const SELF = 'no-suite-wipes-the-shared-delivery-table.test.ts';

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * The line numbers of every delete of the shared table that has no WHERE.
 *
 * Reads to the next `;` rather than to the end of the line, because the scoped
 * form is written as a chained call across several lines:
 *
 *     await database
 *       .delete(githubDeliveryClaims)
 *       .where(...);
 *
 * A line-based check would call that unscoped and the guard would be noise.
 */
function unscopedDeletes(source: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(DELETE_CALL, from);
    if (at === -1) return found;
    from = at + DELETE_CALL.length;
    const statement = source.slice(from, source.indexOf(';', from));
    if (!statement.includes('.where(')) {
      found.push(lineOf(source, at));
    }
  }
}

function suiteFiles(): string[] {
  return readdirSync(SUITE_DIR)
    .filter((name) => name.endsWith('.test.ts') && name !== SELF)
    .map((name) => join(SUITE_DIR, name));
}

describe('no-suite-wipes-the-shared-delivery-table', () => {
  it('sees the two suites that write the table', () => {
    // A guard that reads no files passes vacuously, and that is the state both
    // dead gates in this repo were found in. So the file list is asserted
    // before it is trusted.
    const writers = suiteFiles().filter((path) =>
      readFileSync(path, 'utf8').includes(DELETE_CALL),
    );
    expect(writers.length).toBeGreaterThanOrEqual(2);
  });

  it('scopes every delete of github_delivery_claims to the rows the suite wrote', () => {
    const offenders: string[] = [];
    for (const path of suiteFiles()) {
      const source = readFileSync(path, 'utf8');
      for (const line of unscopedDeletes(source)) {
        offenders.push(`${path.slice(REPO_ROOT.length + 1)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('bites: a blanket delete is reported, and a scoped one is not', () => {
    // The check is exercised against planted source rather than trusted because
    // it is currently green. A guard whose detector has never returned a hit is
    // indistinguishable from a guard that matches nothing.
    expect(
      unscopedDeletes(`await database\n  .delete(githubDeliveryClaims);\n`),
    ).toEqual([2]);
    expect(
      unscopedDeletes(
        `await database\n  .delete(githubDeliveryClaims)\n  .where(inArray(id, IDS));\n`,
      ),
    ).toEqual([]);
    // Two calls in one file, the second unscoped: the first must not swallow
    // the scan, and the reported line must be the second one's.
    expect(
      unscopedDeletes(
        `await database\n  .delete(githubDeliveryClaims)\n  .where(x);\n` +
          `await database\n  .delete(githubDeliveryClaims);\n`,
      ),
    ).toEqual([5]);
  });
});
