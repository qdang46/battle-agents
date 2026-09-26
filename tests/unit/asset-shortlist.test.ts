import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The asset shortlist, and the licenses that back it.
 *
 * ## Why the license is checked against the SHIPPED file
 *
 * The failure this guards is the one where a pack is relicensed upstream between
 * selection and merge. The shortlist still says CC0, a `LICENSE.txt` still
 * exists, and a check that only asks "does a license file exist?" passes while
 * the repository asserts something untrue. So the recorded license is compared
 * against the text actually shipped beside the pack.
 *
 * ## Why no style check exists here
 *
 * The plan makes style consistency the selection criterion, and it would be easy
 * to write a check that greps the shortlist for the word "pixel" and calls that
 * a style gate. It would be worthless: no script can judge whether five packs
 * look like one game, and a check that claims to would be the exact failure this
 * repository keeps meeting — a guard that returns nothing and is trusted anyway.
 * The style claim is a declared column, reviewed by a human, and the
 * `SHORTLIST.md` section on what is and is not true is the artifact of that
 * judgment.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const ASSET_ROOT = join(REPO_ROOT, 'apps/web/public/art');
const SHORTLIST = join(REPO_ROOT, 'docs/design/asset-shortlist.md');

/** One row of the shortlist table. */
interface Row {
  readonly pack: string;
  readonly source: string;
  readonly license: string;
  readonly style: string;
}

/**
 * The shortlist, parsed out of its markdown table.
 *
 * Parsed rather than hardcoded, because a check that compares a hardcoded list
 * against a file proves only that a file was not edited. A row is only counted
 * if it carries a pack, a source, a license and a style — so dropping a column
 * makes rows disappear and the count check fails, which is the point.
 */
function rows(): readonly Row[] {
  const markdown = readFileSync(SHORTLIST, 'utf8');
  const parsed: Row[] = [];
  for (const line of markdown.split('\n')) {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    // A data row is five cells, the second of which is a number.
    if (cells.length !== 5) continue;
    if (!/^\d+$/.test(cells[0] ?? '')) continue;
    parsed.push({
      // cells[0] is the row number, already matched above.
      pack: cells[1] ?? '',
      source: cells[2] ?? '',
      license: cells[3] ?? '',
      style: cells[4] ?? '',
    });
  }
  return parsed;
}

/**
 * The same license, however it is spelled.
 *
 * SPDX writes the public-domain dedication `CC0-1.0`; every Kenney pack writes
 * `Creative Commons Zero, CC0` plus the canonical
 * `creativecommons.org/publicdomain/zero/1.0/` URL; the tiny-swords file writes
 * its own wording again. A check that demanded one exact string would fail on
 * correct licenses, and a check that cries wolf gets switched off — so the
 * comparison is on the LICENSE, with the punctuation normalised away, and the
 * canonical URL counts as a mention because it is the one unambiguous marker of
 * this particular dedication.
 */
function sameLicense(recorded: string, shipped: string): boolean {
  const norm = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/10$/, '');
  if (norm(recorded).includes(norm(shipped)) || norm(shipped).includes(norm(recorded))) {
    return true;
  }
  return /publicdomain\/zero\/1\.0|creative commons zero/i.test(shipped) && /cc0/i.test(recorded);
}

/** The pack directories, discovered rather than listed. */
function packDirs(): readonly string[] {
  if (!existsSync(ASSET_ROOT)) return [];
  return readdirSync(ASSET_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

describe('every art pack is licensed, and the license is the one we recorded', () => {
  it('found the shortlist and some packs, so the checks below are not vacuous', () => {
    // The floor. A parser bug that found nothing would leave every other
    // assertion here green, and a directory read that returned nothing would
    // make "every pack ships a license" true of no packs at all.
    expect(existsSync(SHORTLIST), 'the shortlist is the deliverable and it is missing').toBe(true);
    expect(rows().length, 'the shortlist table parsed to nothing').toBeGreaterThan(0);
    expect(packDirs().length, 'no pack directories exist, so nothing is being checked').toBeGreaterThan(0);
  });

  it('lists between 10 and 20 packs, which is the plan section 14 band', () => {
    // A TARGET, not a floor to pad. The shortlist says which packs were rejected
    // and why, so a count that lands low is a decision on the record rather than
    // an invitation to add a fifth visual style to make a number go green.
    const count = rows().length;
    expect(
      count,
      'the shortlist is outside the 10-20 band. If the count is low that is the selection being fixed, not padded.',
    ).toBeGreaterThanOrEqual(10);
    expect(count, 'the shortlist is outside the 10-20 band').toBeLessThanOrEqual(20);
  });

  it('gives every pack a source, a license and a declared style', () => {
    const incomplete = rows()
      .filter((row) => row.pack === '' || row.source === '' || row.license === '' || row.style === '')
      .map((row) => row.pack || '(unnamed row)');
    expect(
      incomplete,
      'every row must carry a pack name, a source URL, a license and a style. A row with an empty cell is where a per-pack license goes missing.',
    ).toEqual([]);
  });

  it('ships a LICENSE.txt beside every pack, which is the clause with teeth', () => {
    // This is the one that runs on every merge rather than at selection time.
    // Proven against real directories: the first directory to appear under the
    // asset root was tiny-swords-cc0, and a check that has never seen a real
    // directory has never run.
    const missing = packDirs().filter(
      (pack) => !existsSync(join(ASSET_ROOT, pack, 'LICENSE.txt')),
    );
    expect(
      missing,
      'these packs ship no LICENSE.txt. Each art pack keeps its own license beside it; the repository being MIT says nothing about the art inside it.',
    ).toEqual([]);
  });

  it('records the license the pack actually ships, not the one it had at selection', () => {
    // The half that catches the real failure. A pack relicensed upstream between
    // selection and merge still has a LICENSE.txt, so the clause above passes
    // while the shortlist quietly asserts something untrue.
    const mismatched: string[] = [];
    for (const row of rows()) {
      const licenseFile = join(ASSET_ROOT, row.pack, 'LICENSE.txt');
      if (!existsSync(licenseFile) || statSync(licenseFile).size === 0) {
        mismatched.push(`${row.pack}: no LICENSE.txt to compare against`);
        continue;
      }
      const shipped = readFileSync(licenseFile, 'utf8');
      if (!sameLicense(row.license, shipped)) {
        mismatched.push(
          `${row.pack}: shortlist says ${row.license}, shipped file does not mention it`,
        );
      }
    }
    expect(
      mismatched,
      'a recorded license that does not match the file shipped beside the pack. Re-verify at MERGE time, not selection time.',
    ).toEqual([]);
  });

  it('has a shortlist row for every pack on disk, and a pack for every row', () => {
    // The two directions, because either one alone is satisfiable by a stale
    // file. A pack nobody recorded has no license on the record; a row for a
    // pack that was never copied is a claim about bytes that are not here.
    const listed = new Set(rows().map((row) => row.pack));
    const onDisk = new Set(packDirs());

    expect(
      [...onDisk].filter((pack) => !listed.has(pack)),
      'these packs are vendored but have no shortlist row, so no license is recorded for them',
    ).toEqual([]);
    expect(
      [...listed].filter((pack) => !onDisk.has(pack)),
      'the shortlist records these packs but they are not on disk',
    ).toEqual([]);
  });
});
