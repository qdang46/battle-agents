import { createInMemoryEventBus, createRuntime, InMemoryStateStore } from '@battle-agents/core';
import type { EventHandler, GameEvent, GameFeature, RuntimeContext } from '@battle-agents/core';
import { describe, expect, it } from 'vitest';

import { isolateHandlers } from './handler-isolation.js';
import type { HandlerFailure } from './handler-isolation.js';

/**
 * A handler that throws must not take the handlers after it with it.
 *
 * The bug this closes was measured, not imagined: a reputation handler that
 * throws unwinds the whole loop and every consumer registered after it never
 * runs. `core` is frozen, so the boundary lives here and the composition root
 * applies it — which means this file has to answer a question `core`'s own
 * tests cannot: does the boundary actually hold when a real runtime, with a
 * real registry and the real handler order, is driving it?
 *
 * Every test below builds a REAL runtime. A test that called the wrapper
 * directly would prove the wrapper catches, and not that the runtime routes
 * handlers through it — which is the same wiring mistake
 * `apps/web/src/auth/wiring.test.ts` records having made with
 * `bootstrapGameAccount`.
 */

const AT = '2026-09-27T00:00:00.000Z';

function anEvent(type: string): GameEvent {
  return { type, occurredAt: AT, actorId: 'test', payload: {} };
}

/** A handler that records that it ran, and can be told to throw instead. */
function spy(name: string, calls: string[], throws = false): EventHandler {
  return {
    on: 'test.ping',
    async handle() {
      if (throws) throw new Error(`${name} is broken`);
      calls.push(name);
    },
  };
}

function feature(id: string, handlers: readonly EventHandler[]): GameFeature {
  return { id, eventHandlers: handlers };
}

function runtimeWith(extensions: readonly GameFeature[]) {
  const bus = createInMemoryEventBus();
  const store = new InMemoryStateStore();
  const runtime = createRuntime({ extensions, store, bus, now: () => AT });
  return { runtime, bus, store };
}

describe('a throwing handler', () => {
  it('does not stop the handlers registered after it', async () => {
    const calls: string[] = [];
    const failures: HandlerFailure[] = [];
    const healthy = feature('healthy', [spy('healthy', calls)]);
    const broken = feature('broken', [spy('broken', calls, true)]);
    // Registered AFTER the broken one, which is the whole point: the runtime
    // hands handlers out in registration order, so this is the consumer the
    // bug starves.
    const downstream = feature('downstream', [spy('downstream', calls)]);

    const { runtime } = runtimeWith(
      [healthy, broken, downstream].map((f) => isolateHandlers(f, (failure) => failures.push(failure))),
    );

    await runtime.emit(anEvent('test.ping'));

    expect(calls).toEqual(['healthy', 'downstream']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.featureId).toBe('broken');
    expect(failures[0]?.eventType).toBe('test.ping');
  });

  it('lets the event reach the bus, which a throw currently prevents', async () => {
    // runtime.ts publishes LAST, after the handlers, so a throw means the event
    // never reaches the bus at all — the operator stream, the SSE gateway and
    // every future subscriber see nothing, and the failure is invisible to
    // exactly the people watching for it.
    const seen: string[] = [];
    const { runtime, bus } = runtimeWith([
      isolateHandlers(feature('broken', [spy('broken', [], true)]), () => {}),
    ]);
    bus.subscribe((event) => seen.push(event.type));

    await runtime.emit(anEvent('test.ping'));

    expect(seen).toEqual(['test.ping']);
  });

  it('does not run the remaining handlers twice, and keeps the order', async () => {
    // The alternative fix was `Promise.allSettled` over the handlers, which
    // removes the starvation and the ordering together. Ordering is the
    // contract — one feature's event is another's input — so this pins the
    // order rather than only the membership.
    const calls: string[] = [];
    const extensions = ['one', 'two', 'three'].map((name) =>
      isolateHandlers(feature(name, [spy(name, calls)]), () => {}),
    );
    const { runtime } = runtimeWith(extensions);

    await runtime.emit(anEvent('test.ping'));

    expect(calls).toEqual(['one', 'two', 'three']);
  });

  it('passes the runtime its OWN context, so a feature cannot tell', async () => {
    // The reason this is a wrapper and not a rewritten `emit`: a handler is
    // called with a `RuntimeContext` the runtime builds, and an outside wrapper
    // could only fabricate one whose `runtime` was a different object. If the
    // handler can reach the real runtime through its context, the boundary did
    // not substitute anything.
    const calls: string[] = [];
    let seen: RuntimeContext | undefined;
    const handler: EventHandler = {
      on: 'test.ping',
      async handle(_event, context) {
        seen = context;
        calls.push('ran');
      },
    };
    const { runtime } = runtimeWith([isolateHandlers(feature('f', [handler]), () => {})]);

    await runtime.emit(anEvent('test.ping'));

    expect(calls).toEqual(['ran']);
    expect(seen?.runtime).toBe(runtime);
    expect(seen?.store).toBeDefined();
    expect(seen?.bus).toBeDefined();
    expect(typeof seen?.now).toBe('function');
  });

  it('reports a handler that rejects rather than throws', async () => {
    // A handler that returns a rejected promise is a different failure with a
    // different trace, and one that escapes as an unhandled rejection if only
    // the synchronous throw is caught.
    const calls: string[] = [];
    const failures: HandlerFailure[] = [];
    const rejecting: EventHandler = {
      on: 'test.ping',
      handle: () => Promise.reject(new Error('rejected')),
    };
    const { runtime } = runtimeWith([
      isolateHandlers(feature('broken', [rejecting]), (failure) => failures.push(failure)),
      isolateHandlers(feature('downstream', [spy('downstream', calls)]), (failure) =>
        failures.push(failure),
      ),
    ]);

    await runtime.emit(anEvent('test.ping'));

    expect(calls).toEqual(['downstream']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.cause).toBeInstanceOf(Error);
  });

  it('survives a reporter that throws, because that is the same bug', async () => {
    // The reporter is the last thing between a throw and the handlers after
    // it. A reporter that itself throws reintroduces the original defect at
    // the moment of failure, and it is the likeliest mistake here because a
    // reporter is the piece that touches the database or the log.
    const calls: string[] = [];
    const { runtime } = runtimeWith([
      isolateHandlers(feature('broken', [spy('broken', [], true)]), () => {
        throw new Error('the reporter is broken too');
      }),
      isolateHandlers(feature('downstream', [spy('downstream', calls)]), () => {
        throw new Error('the reporter is broken too');
      }),
    ]);

    await expect(runtime.emit(anEvent('test.ping'))).resolves.toBeUndefined();
    expect(calls).toEqual(['downstream']);
  });

  it('leaves a feature with no handlers exactly as it was', async () => {
    // Returning the same object rather than a copy: a feature's repositories
    // are closed over, and a boundary that rebuilt the feature at mount time
    // would be a second thing to keep in step with the first.
    const bare: GameFeature = { id: 'no-handlers' };
    expect(isolateHandlers(bare, () => {})).toBe(bare);
  });

  it('keeps the rest of the feature by reference', async () => {
    const featureWithEverything: GameFeature = {
      id: 'full',
      eventHandlers: [spy('full', [])],
      persistedEvents: ['a.b'],
      capabilities: [{ name: 'a.capability', description: 'x' }],
      requires: ['another.capability'],
    };
    const isolated = isolateHandlers(featureWithEverything, () => {});

    expect(isolated.id).toBe('full');
    expect(isolated.persistedEvents).toBe(featureWithEverything.persistedEvents);
    expect(isolated.capabilities).toBe(featureWithEverything.capabilities);
    expect(isolated.requires).toBe(featureWithEverything.requires);
    expect(isolated.eventHandlers).not.toBe(featureWithEverything.eventHandlers);
  });
});

describe('without the boundary', () => {
  it('starves the handlers after a throw, which is the bug being closed', async () => {
    // The control. Without this, every test above could pass because the
    // runtime had become isolation-aware, or because the handlers were never
    // registered in the first place — and neither would be the bug being fixed.
    const calls: string[] = [];
    const { runtime } = runtimeWith([
      feature('healthy', [spy('healthy', calls)]),
      feature('broken', [spy('broken', calls, true)]),
      feature('downstream', [spy('downstream', calls)]),
    ]);

    await expect(runtime.emit(anEvent('test.ping'))).rejects.toThrow('broken is broken');
    expect(calls).toEqual(['healthy']);
  });
});
