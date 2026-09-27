# Where a throwing event handler is contained

Satisfies `ba-throwing-handler-starves-bus-xz6`. That bead asked for a decision
recorded rather than a patch, because the patch it wants is in `packages/core`
and AGENTS.md freezes core outright. This is the decision, and this is what
actually shipped against it.

The short version: **the boundary is applied at the composition root, one
`isolateHandlers` per feature, and a failure is logged and persisted as
`handler.failed`. `core` is untouched, and the cost of that is named below
rather than discovered later.**

## The bug, and the misdiagnosis that delayed it

`packages/core/src/runtime.ts` awaits handlers in order and does not catch:

```ts
for (const handler of registry.handlersFor(event.type)) {
  await handler.handle(event, context);
}
options.bus.publish(event);
```

One handler that throws therefore does three things at once: it stops every
consumer registered after it, it stops `bus.publish` from running, and it hands
the caller an exception that names no handler. Measured by
`ba-core-loop-integration-uk7`: a reputation handler that throws and every
consumer after it never runs.

The runtime's comment explains why catching was rejected — a feature quietly
missing state is worse than a loud failure, and the caller can still act. That
reasoning is sound and it is not a reason to leave this as it is. What it
defends against is a *quiet* feature. What actually happens is a quiet feature
**and** a dead bus **and** an unattributable exception. It is the same silence
with a much larger blast radius, and the comment reads as though it is not.

The plan already decided this area once. `COMPREHENSIVE_PLAN_FOR_BATTLE_AGENTS.md`
§"DECIDED 2026-09-25" item 3 records that `emit` publishes after handlers and
accepts that "a throwing handler is a bug the caller still gets to act on". That
accounts for the caller. It does not account for the other consumers, which is
the part that was broken.

## What was rejected, and why

**A `try`/`catch` inside `runtime.ts`.** The obvious fix, and the one the
architecture forbids. Not a preference: AGENTS.md says a change that has to edit
`core` is an architecture failure, and review rejects the PR. Worth recording
that the plan freezes these three deliberately.

**Wrapping `emit` from outside the runtime.** The first thing actually tried
here, and it does not work. A handler is called with a `RuntimeContext`, and the
only context the runtime ever constructs carries its own `emit` — so an outside
wrapper would have to build one, and a context whose `runtime` is a stand-in is
a lie a feature can observe. `isolateHandlers` wraps the *handler* instead, so
the runtime's own context is passed straight through and a feature cannot tell
it has been isolated. There is a test that asserts exactly that
(`seen?.runtime` is the runtime that dispatched).

**`Promise.allSettled` over the handlers.** Removes the starvation and the
ordering in one edit, and the ordering is load-bearing: it is why one feature
can consume what another emits, and the two halves of a pair depend on having
run in that order. Rejected for the same reason `allSettled` is wrong
everywhere it is tempting.

**A per-handler error boundary in the bus.** Narrower than the runtime, but it
puts policy in the transport, and the bus is the thing every surface shares.

**Leave it, and require every handler to be total.** Cheapest, and it is a rule
nothing enforces. The next feature's author will not know, and the failure looks
identical to a bug in their feature.

## What shipped

`packages/api/src/handler-isolation.ts` exports `isolateHandlers(feature,
onFailure)`, which returns the feature with each handler behind a `catch`. The
composition root applies it to the whole list:

```ts
]..map((feature) => isolateHandlers(feature, recordFailure)),
```

`onFailure` is **required, not optional**. An unreported catch is exactly the
failure mode this exists to remove, and an optional reporter would be a way to
opt back into it by omission.

Three things about the shape are deliberate:

- **The reporter is itself guarded.** A reporter that throws at the moment of
  failure reintroduces the original defect at the worst possible moment, and it
  is the likeliest mistake here because the reporter is the piece that touches
  the database and the log. `report()` catches around the reporter.
- **The feature is passed through by reference.** A boundary that rebuilt a
  feature at mount time would freeze whatever it closes over, and a feature's
  repositories are exactly the thing that has to stay live.
- **The failure does not know which of a feature's handlers threw.** The
  registry keys handlers by event type, so two handlers for one event are
  indistinguishable to anything not standing at the call site. The record names
  the feature and the event type, which is what the runtime knows too. A record
  that guessed would be worse than one that says what it knows.

## Why `store.append` and not `emit`

`handler.failed` is written straight to the store and published on the bus,
bypassing `emit` on purpose:

- `emit` runs the feature's handlers again, so a feature that throws on one
  event would throw on its own failure report. That is a loop which cannot
  terminate.
- `emit` persists only event types some feature declared in `persistedEvents`,
  and no feature owns runtime diagnostics. Inventing an owner for one event to
  get durability would be a feature whose entire purpose is to declare a string.

It is a **bus-only type as far as the protocol is concerned**: it is not in
`GAME_EVENT_NAMES`, so no feature may react to it. A host that wants one to reach
a client declares it the way any other event is declared.

## What this does not fix, stated plainly

- **`runtime.install()` bypasses the boundary.** Features are isolated at mount
  time, and `install()` registers one directly with the registry afterwards. No
  production code calls it — every caller in the tree is a test — so this is
  latent rather than live. It becomes real the moment a hot-reload or
  plugin-at-runtime feature lands, and the fix then is a core edit, which means
  the plan's answer to that is a decision this document does not pre-empt.
- **A surface that does not use the composition root is unprotected.** The web
  app is the only place features are mounted in this repository, so the boundary
  covers everything today. A third-party host composing its own runtime gets the
  raw behaviour unless it calls `isolateHandlers`, and nothing forces it to. This
  is the real price of not touching core, and it is why the helper lives in
  `packages/api` — the package every surface already depends on — rather than in
  `apps/web` where it would be unreachable.
- **The failing feature still misses its state.** Isolation stops the blast
  radius; it does not make a broken handler work. The failure is now recorded
  and the rest of the game continues, which is the improvement, and the feature
  that threw is still broken until someone reads the record.

## What proves it

- `packages/api/src/handler-isolation.test.ts` — nine tests against a **real**
  runtime, including a control that mounts the same three features *without* the
  boundary and asserts the starvation is still there. Without that control, every
  other test could pass because the runtime had become isolation-aware rather
  than because the boundary works.
- `tests/unit/handler-isolation-wiring.test.ts` — that the composition root
  **applies** it. `apps/web/src/auth/wiring.test.ts` records this repository
  getting exactly this wrong already: `bootstrapGameAccount` was correct,
  exported, and green in a test that called it three times, and no code on the
  login path called it at all. The `.map` was reverted and this test watched go
  red before it was believed.
