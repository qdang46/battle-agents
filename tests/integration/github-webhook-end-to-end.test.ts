import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inArray } from 'drizzle-orm';
import { githubDeliveryClaims } from '@battle-agents/db';
import type { Database } from '@battle-agents/db';
import { PULL_REQUEST_MERGED, signPayload, WEBHOOK_SECRET_VARIABLE } from '@battle-agents/github';
import { PULL_REQUEST_MERGED_OUTCOME } from '@battle-agents/bounty';

import { sharedGithubWebhook } from '../../apps/web/src/webhook-routes.js';
import type { WebhookHttpRequest } from '../../apps/web/src/webhook-routes.js';
import { closeSharedRuntime, sharedRuntime } from '../../apps/web/src/shared-runtime.js';

/**
 * A signed delivery, all the way through, on the bus the app already uses.
 *
 * The unit suite proves the handler's ordering against fakes and the delivery
 * suite proves the ledger against real Postgres. Neither can catch the failure
 * this file exists for, because the thing that would break is a WIRING decision
 * neither of them sees: that the webhook publishes onto `await sharedRuntime().bus`
 * rather than onto a runtime it built for itself.
 *
 * That wiring is not hypothetical. `shared-runtime.ts` exists because there used
 * to be two runtimes with two `createInMemoryEventBus()` instances, each
 * complete from the inside, publishing into different rooms. A merge published
 * onto a private bus would leave the operator stream, the SSE gateway and every
 * future subscriber empty while the webhook test suite stayed green.
 *
 * So the assertion here is deliberately indirect and behavioural: subscribe to
 * the shared bus the way the gateway does, post a delivery, and require the
 * event to arrive. It is written so that a second runtime fails it rather than
 * passing quietly.
 */

const SECRET = 'end-to-end-secret-not-real';
const DATABASE_URL_VARIABLE = 'DATABASE_URL';
const AT_REPOSITORY = 'acme/widgets';

function requireDatabase(): void {
  if (process.env[DATABASE_URL_VARIABLE] === undefined) {
    throw new Error(
      `${DATABASE_URL_VARIABLE} is not set. Run through scripts/test-m0.sh so the compose Postgres is up, or export it before running this suite.`,
    );
  }
}

/**
 * A body GitHub would actually send: pretty-printed, with the fields the
 * normalizer reads. Pretty rather than compact on purpose — a compact body is
 * its own canonical form, so a handler that re-serialised the parsed object
 * before hashing would pass against a compact fixture and reject every real
 * delivery.
 */
function mergeBody(pullRequest: number): string {
  return JSON.stringify(
    {
      action: 'closed',
      repository: { full_name: AT_REPOSITORY },
      pull_request: {
        number: pullRequest,
        merged: true,
        merged_at: '2026-09-25T12:00:00Z',
        user: { login: 'octocat' },
      },
    },
    null,
    2,
  );
}

function delivery(options: {
  readonly body: string;
  readonly deliveryId: string;
  readonly signature?: string | null;
}): WebhookHttpRequest {
  return {
    method: 'POST',
    url: 'https://game.example/api/webhooks/github',
    headers: {
      get: (name: string): string | null => {
        switch (name.toLowerCase()) {
          case 'x-hub-signature-256':
            return options.signature === undefined
              ? signPayload(SECRET, options.body)
              : options.signature;
          case 'x-github-delivery':
            return options.deliveryId;
          case 'x-github-event':
            return 'pull_request';
          default:
            return null;
        }
      },
    },
    rawBody: options.body,
  };
}

/** Collects everything the shared bus publishes for the life of the subscription. */
/**
 * Every delivery id this file dispatches, in one place so the cleanup in
 * `beforeAll` and the calls below cannot drift apart. A cleanup that lists its
 * own ids twice is a cleanup that will eventually clean up one set and dispatch
 * another.
 */
const E2E_DELIVERY_IDS = ['e2e-1', 'e2e-2', 'e2e-forged'] as const;

async function watchSharedBus(): Promise<{ events: unknown[]; stop: () => void }> {
  const events: unknown[] = [];
  const stop = (await sharedRuntime()).bus.subscribe((event) => events.push(event));
  return { events, stop };
}

/**
 * What this file caused, and nothing else.
 *
 * `watchSharedBus` subscribes to a bus that is process-wide, and every count
 * below is scoped to the ONE delivery under test — by the pull request number
 * the fixture used, which is unique to its test. Counting `pr.merged` by type
 * alone is the assertion the brief calls out, and the brief is right about the
 * shape even though the failure it was written from turned out to be elsewhere:
 * a count that includes whatever else the process published is a claim about
 * the process, not about the webhook.
 *
 * The same rule on the table. `expect(rows).toHaveLength(1)` over
 * `github_delivery_claims` is a claim about every row in a table two suites
 * share, and it held for as long as it did only because this file's blanket
 * delete happened to win a race against every other file's blanket delete. It
 * is `ownRows()` below instead.
 */
function eventsFor(
  events: readonly unknown[],
  type: string,
  pullRequest: number,
): readonly unknown[] {
  return events.filter((entry) => {
    const candidate = entry as { type?: unknown; payload?: { pullRequest?: unknown } };
    return candidate.type === type && candidate.payload?.pullRequest === pullRequest;
  });
}

let database: Database;

beforeAll(async () => {
  requireDatabase();
  process.env[WEBHOOK_SECRET_VARIABLE] = SECRET;
  const { database: shared } = await sharedRuntime();
  database = shared;
  // The ledger is durable, so a second run of this file would collide with the
  // first on the fact key and be refused as a duplicate — which is the ledger
  // working, not a test that can be re-run.
  //
  // SCOPED TO THIS FILE'S OWN DELIVERY IDS, and that is the whole fix. This used
  // to be `delete(githubDeliveryClaims)` — the entire table — which is the
  // correct-looking way to start clean and is wrong here: vitest runs test
  // FILES in parallel workers against ONE database, and
  // `github-delivery-store.test.ts` claims rows in this same table. A blanket
  // delete lands in the middle of that file's run and takes its rows with it,
  // which is how a test in one file intermittently fails in another that shares
  // no state with it by design.
  //
  // The symptom was read as a bus problem, because the two failures that showed
  // up together were both about the ledger and the file's own name says
  // "shared bus". The bus was never involved.
  await database
    .delete(githubDeliveryClaims)
    .where(
      inArray(
        githubDeliveryClaims.deliveryId,
        // Every id this file dispatches with, so a stale row from a previous run
        // of THIS file cannot collide, and no other file's row is touched.
        E2E_DELIVERY_IDS,
      ),
    );
});

afterAll(async () => {
  delete process.env[WEBHOOK_SECRET_VARIABLE];
  // Closes the pool the shared runtime opened; nothing else to release, because
  // the webhook handler holds no resource of its own.
  await closeSharedRuntime();
});

/**
 * The rows THIS file wrote, read back from the real table.
 *
 * Not `select().from(githubDeliveryClaims)`. That reads every row in a table
 * that `github-delivery-store.test.ts` also writes, and the suite ran green for
 * as long as the two files' blanket deletes kept happening to clear each other
 * out. The moment both cleanups were scoped, the whole-table read started
 * counting the other suite's residue and reported 17 where it meant 1.
 */
function ownRows(): Promise<readonly { deliveryId: string; publishedAt: Date | null }[]> {
  return database
    .select({
      deliveryId: githubDeliveryClaims.deliveryId,
      publishedAt: githubDeliveryClaims.publishedAt,
    })
    .from(githubDeliveryClaims)
    .where(inArray(githubDeliveryClaims.deliveryId, [...E2E_DELIVERY_IDS]));
}

describe('a signed merge, end to end', () => {
  it('lands on the shared bus, the ledger, and neither twice', async () => {
    const { events, stop } = await watchSharedBus();
    try {
      const body = mergeBody(4242);
      const first = await (await sharedGithubWebhook())(delivery({ body, deliveryId: E2E_DELIVERY_IDS[0] }));

      expect(first.status).toBe(200);
      expect(first.body.outcome).toBe('accepted');

      // The wiring claim. Identity of the bus is what makes this meaningful: an
      // event published onto a runtime the webhook built for itself would be
      // indistinguishable from this one by shape alone, and invisible to every
      // real subscriber.
      //
      // ONE delivery now produces TWO events, because ba-feature-bounty-xhk
      // mounted the bounty feature and it subscribes to this one. The edge
      // reports what it observed; the bounty feature decides what it means, and
      // for a merge that matched no bounty its answer is a `pr.merged` carrying
      // no agent — a fact on the bus that pays nothing and persists nothing.
      // This fixture's repository is not a bounty's, so it is the unclaimed
      // case, and the test now says which event is which rather than counting.
      //
      // Scoped to PR 4242, which only this test dispatches.
      const observed = eventsFor(events, PULL_REQUEST_MERGED, 4242);
      expect(observed).toHaveLength(1);
      const emitted = observed[0] as { type: string; actorId: string; payload: unknown };
      expect(emitted.type).toBe(PULL_REQUEST_MERGED);
      expect(emitted.actorId).toBe('github');
      expect(emitted.payload).toMatchObject({
        repository: AT_REPOSITORY,
        pullRequest: 4242,
        merged: true,
      });

      // The game's reading of it, and the flag that keeps it from being priced
      // twice. Asserted here because this is the only suite that sees both
      // halves of the pair: an event the edge named and an event the game priced.
      const read = eventsFor(events, PULL_REQUEST_MERGED_OUTCOME, 4242);
      expect(read).toHaveLength(1);
      expect((read[0] as { payload: unknown }).payload).toMatchObject({
        completedBounty: false,
        pullRequest: 4242,
      });
      // No agent: there is no claim, so there is nobody to attribute the work
      // to, and a merge that completed nothing must not manufacture one.
      expect((read[0] as { payload: { agentId?: unknown } }).payload.agentId).toBeUndefined();

      // Durable, not just in this process: the row exists in the real table.
      const rows = await ownRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.deliveryId).toBe('e2e-1');
      expect(rows[0]?.publishedAt).not.toBeNull();

      // A retry under a NEW delivery id is the case a delivery-id cache cannot
      // catch, and it is the one that double-completes a bounty.
      const retry = await (await sharedGithubWebhook())(delivery({ body, deliveryId: E2E_DELIVERY_IDS[1] }));
      expect(retry.status).toBe(200);
      expect(retry.body.outcome).toBe('duplicate');
      // Still exactly one of each, and the count is asserted per event name
      // rather than over the whole array: a re-delivery is refused by the
      // ledger before any feature sees it, so a second `pr.merged` OR a second
      // `pr.merged` outcome would both mean the duplicate was not refused.
      expect(eventsFor(events, PULL_REQUEST_MERGED, 4242)).toHaveLength(1);
      expect(eventsFor(events, PULL_REQUEST_MERGED_OUTCOME, 4242)).toHaveLength(1);
      expect(await ownRows()).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('is refused before the bus or the ledger, and leaves neither', async () => {
    const { events, stop } = await watchSharedBus();
    try {
      const body = mergeBody(5555);
      const forged = await (
        await sharedGithubWebhook()
      )(delivery({ body, deliveryId: E2E_DELIVERY_IDS[2], signature: `sha256=${'0'.repeat(64)}` }));

      expect(forged.status).toBe(401);
      // Absolute emptiness, not a scoped count, and that is deliberate: what is
      // under test is that a rejected signature produces NO event of any kind,
      // and a filter narrow enough to survive a busy process would be narrow
      // enough to miss a wrong-typed one. This is the one assertion in the file
      // that is allowed to depend on the process being quiet, which the stage's
      // per-file isolation (vitest `forks` + `isolate`) guarantees.
      expect(events).toEqual([]);
      // "Leaves no trace" against the real table, not against a fake: a claim
      // row written for an unsigned request is an attacker spending a real
      // merge's one chance to be seen. Scoped to this file's ids, so the other
      // suite's rows are not read as though they were evidence either way.
      expect(await ownRows()).toHaveLength(1);
    } finally {
      stop();
    }
  });
});
