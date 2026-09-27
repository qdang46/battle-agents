import { createInMemoryEventBus } from '@battle-agents/core';
import type { EventBus, Runtime } from '@battle-agents/core';
import {
  closeDatabasePool,
  createDatabase,
  createDatabasePool,
  DrizzleAgentRepository,
  DrizzleBattleRepository,
  DrizzleAchievementsRepository,
  DrizzleBountyRepository,
  DrizzlePayoutIntentStore,
  DrizzleWorldRepository,
  DrizzleProgressionRepository,
  DrizzleQuestRepository,
  DrizzleReputationRepository,
  DrizzleSessionRepository,
  DrizzleSocialRepository,
  DrizzleStateStore,
} from '@battle-agents/db';
import type { Database } from '@battle-agents/db';

import { createGameRuntime } from './composition.js';

/**
 * The one runtime, the one bus, the one pool.
 *
 * This file exists because there used to be two of each. `routes.ts` built a
 * runtime for the Application API and `event-gateway.ts` built another for the
 * telemetry plane, each with its own `createInMemoryEventBus()`. The two never
 * met, so an event emitted by a game action — a quest claimed, an agent levelled,
 * a reputation changed — was published to a bus nobody was listening to, and the
 * public stream carried telemetry and nothing else.
 *
 * The gateway's own doc comment had already recorded this as a deliberate
 * deferral, and named the condition: folding the runtimes together "belongs
 * with the work that makes the act path a first-class publisher." MCP is the
 * third surface that acts, so the condition is met.
 *
 * The bus is the part that has to be shared. Two runtimes over one database is
 * a real inefficiency; two BUSES is a correctness bug, because the realtime
 * path and the action path were publishing into different rooms and each looked
 * complete from the inside.
 *
 * Composition stays in `composition.ts`. This file wires repositories to it and
 * deliberately holds no feature name, so `scripts/removal-test.sh` still has
 * exactly one place to strip a feature from.
 */

export interface SharedRuntime {
  readonly database: Database;
  readonly runtime: Runtime;
  readonly bus: EventBus;
}

/**
 * The singleton lives on `globalThis`, and that is load-bearing rather than a
 * style choice.
 *
 * Next.js bundles each App Router route as its OWN module graph, so a
 * module-scoped `let` is evaluated once PER ROUTE. `api/events/route.ts` and
 * `api/events/stream/route.ts` therefore each got their own copy of this file,
 * each built its own `Pool`, its own runtime and its own bus — and the whole
 * realtime layer was silently dead. Measured, not argued: a counter on the
 * module scope printed `#1 ... #2 ...` for one process, and a subscriber to
 * `/api/events/stream` received `full_state` and then nothing at all, forever,
 * while `POST /api/events` answered `200 {"accepted":1}` for events nobody
 * downstream could ever see.
 *
 * That is the failure this file was written to end — its own header calls "two
 * BUSES ... a correctness bug" — and folding the two runtimes into one file did
 * not end it, because the duplication is in the bundler and not in the imports.
 * A `globalThis` key is the one place that survives a duplicated module graph.
 *
 * The key is a Symbol rather than a string so nothing can collide with it by
 * accident, and the close handle is left on the same object so `closeSharedRuntime`
 * still releases the pool it opened.
 */
const CACHE_KEY = Symbol.for('battle-agents.shared-runtime');

/**
 * The PENDING build, not the built runtime.
 *
 * This is the second half of the bug and the half that actually bit. Caching the
 * resolved runtime is a check-then-set across an `await`: the first caller sees
 * an empty cache, starts building, and suspends at `await store.prime()` with
 * the cache still empty. The second caller arrives in that window, sees an empty
 * cache too, and builds a SECOND runtime with its own bus. Both finish, the
 * last assignment wins, and the loser keeps publishing to a bus nobody reads.
 *
 * Measured: one process, one PID, three distinct buses, `cached=false` on every
 * call. Caching the PROMISE closes it because the assignment happens
 * synchronously, before the first suspension point, so the second caller awaits
 * the build already in flight rather than starting a second one.
 */
interface RuntimeCache {
  pending?: Promise<SharedRuntime>;
  close?: () => Promise<void>;
}

const globalCache = globalThis as unknown as { [CACHE_KEY]?: RuntimeCache };
const holder: RuntimeCache = (globalCache[CACHE_KEY] ??= {});

/**
 * Built on first use, never at module scope.
 *
 * The Next.js route adapters import their gateway at module scope, and a
 * module-scope pool would be opened while `next build` is still walking the
 * tree rather than when a request arrives.
 */
export async function sharedRuntime(): Promise<SharedRuntime> {
  // The `??=` is the whole fix. It assigns synchronously, so a second caller
  // arriving while the first is suspended at `await store.prime()` gets this
  // promise rather than an empty cache.
  holder.pending ??= buildSharedRuntime();
  return holder.pending;
}

async function buildSharedRuntime(): Promise<SharedRuntime> {
  const pool = createDatabasePool();
  const database = createDatabase(pool);
  const bus = createInMemoryEventBus();
  const sessionRepository = new DrizzleSessionRepository(database);

  const store = new DrizzleStateStore(database);
  // Awaited, never fired and forgotten. StateStore.load is synchronous in the
  // frozen contract, so the cache can only be filled where awaiting is allowed,
  // and a prime that races the first request answers `undefined` for a feature
  // with durable state. For battle that is not a degraded read: the arena gate
  // stops gating and no win since the restart emits a reward, because the agent
  // a session belongs to is looked up rather than trusted from a caller.
  await store.prime();

  const runtime = createGameRuntime({
    store,
    bus,
    agentRepository: new DrizzleAgentRepository(database),
    questRepository: new DrizzleQuestRepository(database),
    sessionRepository,
    progressionRepository: new DrizzleProgressionRepository(database),
    reputationRepository: new DrizzleReputationRepository(database),
    socialRepository: new DrizzleSocialRepository(database),
    bountyRepository: new DrizzleBountyRepository(database),
    payoutIntentStore: new DrizzlePayoutIntentStore(database),
    worldStore: new DrizzleWorldRepository(database),
    battleStore: new DrizzleBattleRepository(database),
    achievementsRepository: new DrizzleAchievementsRepository(database),
  });

  holder.close = () => closeDatabasePool(pool);
  return { database, runtime, bus };
}

/** Releases the pool. For a graceful shutdown, not for per-request cleanup. */
export async function closeSharedRuntime(): Promise<void> {
  await holder.close?.();
  // `delete` rather than an assignment to undefined: the property is optional,
  // and exactOptionalPropertyTypes treats those as different types, so
  // assigning undefined is a compile error and deleting is the same intent.
  delete holder.pending;
  delete holder.close;
}
