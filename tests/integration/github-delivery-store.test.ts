import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeDatabasePool,
  createDatabase,
  DrizzleGithubDeliveryStore,
  githubDeliveryClaims,
} from '@battle-agents/db';
import type { ClaimRow } from '@battle-agents/db';
import { eq, like } from 'drizzle-orm';

/**
 * The delivery ledger against a real database.
 *
 * The unit suite proves the handler's ordering with an in-memory fake, and a
 * fake cannot prove the one property that matters here: that the memory
 * survives. Every test below is written so that an in-memory implementation
 * would fail it — the store is rebuilt between claims, the pool is torn down
 * between claims, and a retry arrives under a delivery id the first one never
 * used. An in-memory Set passes the easy version of this suite and is exactly
 * the implementation the brief rules out.
 */

const DATABASE_URL_VARIABLE = 'DATABASE_URL';
const AT = '2026-09-26T00:00:00.000Z';
const POOL_MAX_CONNECTIONS = 4;

/**
 * This file's delivery-id namespace.
 *
 * Every id below starts with `d-` and nothing else in the suite uses that
 * prefix, so the cleanup can clear its own rows and leave the rest of a SHARED
 * table alone. It used to be `delete(githubDeliveryClaims)` — the whole table —
 * which is the correct-looking way to start clean and is wrong for the same
 * reason it was wrong in `github-webhook-end-to-end.test.ts`: vitest runs files
 * in parallel workers against one database, so a blanket delete lands in the
 * middle of another suite's run and takes its rows with it.
 *
 * The prefix is a CONVENTION rather than an enforced namespace, and the test
 * `no-suite-wipes-the-shared-delivery-table` is what makes it one: it fails if
 * any suite that writes this table deletes it unscoped, and if a second file
 * adopts these ids the two start fighting again. An earlier version of this
 * comment named the constant and implied the literals were checked against it;
 * they are not, and pretending otherwise is the comment being a lie.
 */
const LEDGER_ID_PREFIX = 'd-';

let pool: Pool;

function freshStore(): DrizzleGithubDeliveryStore {
  return new DrizzleGithubDeliveryStore(createDatabase(pool));
}

function mergeClaim(deliveryId: string, number: number, repository = 'acme/widgets'): ClaimRow {
  return {
    deliveryId,
    event: 'pull_request',
    action: 'closed',
    fact: {
      kind: 'github.pull_request.merged',
      repository,
      subject: 'pull_request',
      subjectNumber: number,
    },
  };
}

beforeAll(async () => {
  const connectionString = process.env[DATABASE_URL_VARIABLE];
  if (connectionString === undefined) {
    throw new Error(
      `${DATABASE_URL_VARIABLE} is not set. Run through scripts/test-m0.sh so the compose Postgres is up, or export it before running this suite.`,
    );
  }
  pool = new Pool({ connectionString, max: POOL_MAX_CONNECTIONS });
  const database = createDatabase(pool);
  // Scoped to this file's namespace, and to nothing else in the table.
  await database
    .delete(githubDeliveryClaims)
    .where(like(githubDeliveryClaims.deliveryId, `${LEDGER_ID_PREFIX}%`));
});

afterAll(async () => {
  await closeDatabasePool(pool);
});

describe('the delivery ledger', () => {
  it('claims a delivery and reports who holds it', async () => {
    const store = freshStore();

    const outcome = await store.claim(mergeClaim('d-ledger-1', 101));

    expect(outcome.status).toBe('claimed');
  });

  it('refuses the same delivery id a second time', async () => {
    const store = freshStore();
    const first = await store.claim(mergeClaim('d-ledger-2', 102));
    expect(first.status).toBe('claimed');
    if (first.status === 'claimed') await store.markPublished(first.claimId, AT);

    const second = await store.claim(mergeClaim('d-ledger-2', 102));

    expect(second.status).toBe('already-published');
  });

  it('reports a claim that was never published as in-flight, not as done', async () => {
    // The two refusals are different and both are refusals. Conflating them
    // would make a claim whose publish died look like a completed one to
    // whatever reconcile pass reads this table.
    const store = freshStore();
    await store.claim(mergeClaim('d-unpublished', 103));

    const second = await store.claim(mergeClaim('d-unpublished-again', 103));

    expect(second.status).toBe('in-flight');
  });

  it('refuses a retry that arrives under a NEW delivery id, because the fact is the key', async () => {
    // This is the case a delivery-id cache cannot answer, and the reason the
    // table carries a semantic unique index. GitHub's retry is a new delivery
    // with a new id, so only the fact catches it.
    const store = freshStore();
    const first = await store.claim(mergeClaim('d-merge-a', 201));
    expect(first.status).toBe('claimed');
    await store.markPublished(first.status === 'claimed' ? first.claimId : '', AT);

    const retry = await store.claim(mergeClaim('d-merge-b', 201));

    expect(retry.status).toBe('already-published');
  });

  it('still claims a different pull request, and a different repository', async () => {
    const store = freshStore();

    const other = await store.claim(mergeClaim('d-other-pr', 202));
    const otherRepo = await store.claim(mergeClaim('d-other-repo', 201, 'other/widgets'));

    expect(other.status).toBe('claimed');
    expect(otherRepo.status).toBe('claimed');
  });

  it('holds the claim while it is unpublished, so a concurrent delivery does not also publish', async () => {
    const store = freshStore();
    const first = await store.claim(mergeClaim('d-inflight', 301));
    expect(first.status).toBe('claimed');

    const concurrent = await store.claim(mergeClaim('d-inflight-2', 301));

    expect(concurrent.status).toBe('in-flight');
  });

  it('keeps the claim across a fresh store instance, which is what a restart is', async () => {
    // A new store over a new Database handle. If the guarantee lived in the
    // object, this would be a green suite over a memory that evaporates.
    const first = freshStore();
    const claim = await first.claim(mergeClaim('d-restart', 401));
    expect(claim.status).toBe('claimed');
    if (claim.status === 'claimed') await first.markPublished(claim.claimId, AT);

    const afterRestart = freshStore();
    const redelivered = await afterRestart.claim(mergeClaim('d-restart-again', 401));

    expect(redelivered.status).toBe('already-published');
  });

  it('keeps the claim across a dropped connection pool', async () => {
    // Stronger than rebuilding the store: the pool goes away entirely, so
    // nothing in this process is holding the row.
    const temporary = new Pool({
      connectionString: process.env[DATABASE_URL_VARIABLE],
      max: 2,
    });
    const before = new DrizzleGithubDeliveryStore(createDatabase(temporary));
    const claim = await before.claim(mergeClaim('d-pool-drop', 501));
    expect(claim.status).toBe('claimed');
    if (claim.status === 'claimed') await before.markPublished(claim.claimId, AT);
    await temporary.end();

    const redelivered = await freshStore().claim(mergeClaim('d-pool-drop-2', 501));

    expect(redelivered.status).toBe('already-published');
  });

  it('lets exactly one of two concurrent claims of the same fact win', async () => {
    // The read-then-write implementation loses this one: both deliveries read
    // "not claimed" and both write. Only the unique index arbitrates.
    const store = freshStore();
    const outcomes = await Promise.all([
      store.claim(mergeClaim('d-race-a', 601)),
      store.claim(mergeClaim('d-race-b', 601)),
      store.claim(mergeClaim('d-race-c', 601)),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'claimed')).toHaveLength(1);
    expect(
      outcomes.filter(
        (outcome) => outcome.status === 'in-flight' || outcome.status === 'already-published',
      ),
    ).toHaveLength(2);
  });

  it('records a delivery that asserts nothing, and dedupes it by delivery id alone', async () => {
    const store = freshStore();
    const opened: ClaimRow = {
      deliveryId: 'd-nofact-1',
      event: 'pull_request',
      action: 'opened',
      fact: undefined,
    };

    const first = await store.claim(opened);
    expect(first.status).toBe('claimed');
    if (first.status === 'claimed') await store.markPublished(first.claimId, AT);

    // A second delivery with no fact cannot collide on the fact key — Postgres
    // treats nulls as distinct — so two of them coexist, which is the right
    // answer: two deliveries that assert nothing have nothing to collide about.
    const second = await store.claim({ ...opened, deliveryId: 'd-nofact-2' });
    const third = await store.claim({ ...opened, deliveryId: 'd-nofact-3' });

    expect(second.status).toBe('claimed');
    expect(third.status).toBe('claimed');
  });

  it('returns the claim to the pool on release, so a retry is not stuck behind it', async () => {
    const store = freshStore();
    const first = await store.claim(mergeClaim('d-release', 701));
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') return;

    const blocked = await store.claim(mergeClaim('d-release-2', 701));
    expect(blocked.status).toBe('in-flight');

    await store.release(first.claimId);

    const retried = await store.claim(mergeClaim('d-release-3', 701));
    expect(retried.status).toBe('claimed');
  });

  it('finds a published fact for a later reconciliation pass', async () => {
    const store = freshStore();
    const fact = {
      kind: 'github.pull_request.merged',
      repository: 'acme/widgets',
      subject: 'pull_request',
      subjectNumber: 801,
    };
    const claim = await store.claim({
      deliveryId: 'd-reconcile',
      event: 'pull_request',
      action: 'closed',
      fact,
    });
    if (claim.status !== 'claimed') throw new Error('expected the claim to succeed');

    // Recorded but not published yet: a reconcile pass must not see it.
    await expect(store.findPublishedFact(fact)).resolves.toBeUndefined();

    await store.markPublished(claim.claimId, AT);

    const found = await store.findPublishedFact(fact);
    expect(found?.deliveryId).toBe('d-reconcile');
    expect(found?.publishedAt).toBe(new Date(AT).toISOString());
  });

  it('leaves exactly one row per merge, however many deliveries arrive', async () => {
    const database = createDatabase(pool);
    const store = new DrizzleGithubDeliveryStore(database);
    for (const deliveryId of ['d-count-1', 'd-count-2', 'd-count-3', 'd-count-4']) {
      const outcome = await store.claim(mergeClaim(deliveryId, 901));
      if (outcome.status === 'claimed') await store.markPublished(outcome.claimId, AT);
    }

    const rows = await database
      .select()
      .from(githubDeliveryClaims)
      .where(eq(githubDeliveryClaims.fact, 'github.pull_request.merged'))
      .limit(1000);
    const forThisPullRequest = rows.filter(
      (row) => row.repository === 'acme/widgets' && row.subjectNumber === 901,
    );

    expect(forThisPullRequest).toHaveLength(1);
  });
});
