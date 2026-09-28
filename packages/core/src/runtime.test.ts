import { describe, expect, it } from 'vitest';

import { defineAction } from './actions.js';
import type { Command } from './command.js';
import type {
  EventBus,
  EventHandler,
  GameFeature,
  Logger,
  Runtime,
  RuntimeContext,
} from './contracts.js';
import type { GameEvent } from './event.js';
import { InMemoryStateStore } from './persistence.js';
import { createRuntime, PartialDispatchError } from './runtime.js';
import { createInMemoryEventBus } from './state.js';

const AT = '2026-09-24T00:00:00.000Z';

function event(type: string, payload: unknown = {}): GameEvent {
  return { type, occurredAt: AT, actorId: 'tester', payload };
}

function command(type: string, payload: unknown = {}): Command {
  return { type, issuedAt: AT, issuerId: 'tester', payload };
}

function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return { logger: { warn: (message) => warnings.push(message) }, warnings };
}

interface Harness {
  readonly runtime: Runtime;
  readonly store: InMemoryStateStore;
  readonly seen: GameEvent[];
}

function harness(extensions: readonly GameFeature[], log?: Logger): Harness {
  const store = new InMemoryStateStore();
  const bus = createInMemoryEventBus();
  const seen: GameEvent[] = [];
  bus.subscribe((published) => seen.push(published));
  return {
    runtime: createRuntime({
      extensions,
      store,
      bus,
      now: () => AT,
      ...(log === undefined ? {} : { log }),
    }),
    store,
    seen,
  };
}

/** A feature that does nothing but carry the declarations a test needs. */
function feature({ id, ...declarations }: Partial<GameFeature> & { id: string }): GameFeature {
  return { id, ...declarations };
}

describe('install and uninstall', () => {
  it('gives back every declaration a feature made', () => {
    const target = feature({
      id: 'target',
      commands: [{ type: 'demo.run', handle: async () => [] }],
      eventHandlers: [{ on: 'other.happened', handle: async () => {} }],
      actionDefs: [
        defineAction({
          id: 'demo.run',
          permissions: ['demo'],
          run: async () => 'done',
        }),
      ],
      capabilities: [{ name: 'demo.read', description: 'reads things' }],
      persistedEvents: ['demo.kept'],
    });
    const { runtime } = harness([]);

    runtime.install(target);
    expect(runtime.commands()).toEqual(['demo.run']);
    expect(runtime.actions()).toEqual(['demo.run']);
    expect(runtime.capabilities()).toEqual(['demo.read']);

    runtime.uninstall('target');
    expect(runtime.commands()).toEqual([]);
    expect(runtime.actions()).toEqual([]);
    expect(runtime.capabilities()).toEqual([]);
  });

  it('is a no-op for a feature that was never installed', () => {
    const { runtime } = harness([]);
    expect(() => {
      runtime.uninstall('never-there');
    }).not.toThrow();
  });

  it('leaves the other feature running when two handle the same event', async () => {
    const calls: string[] = [];
    const listener = (name: string) => ({
      on: 'shared.event',
      handle: async () => void calls.push(name),
    });
    const { runtime } = harness([
      feature({ id: 'first', eventHandlers: [listener('first')] }),
      feature({ id: 'second', eventHandlers: [listener('second')] }),
    ]);

    runtime.uninstall('first');
    await runtime.emit(event('shared.event'));
    expect(calls).toEqual(['second']);
  });

  it('leaves the other feature running when two share one handler object', async () => {
    // The failure this guards: removal matched handlers by reference, so a
    // shared handler sat in the list twice and filtering it out removed both
    // registrations, silently switching off a feature nobody uninstalled.
    const calls: string[] = [];
    const shared: EventHandler = {
      on: 'shared.event',
      handle: async () => void calls.push('shared'),
    };
    const { runtime } = harness([
      feature({ id: 'first', eventHandlers: [shared] }),
      feature({ id: 'second', eventHandlers: [shared] }),
    ]);

    runtime.uninstall('first');
    await runtime.emit(event('shared.event'));
    await runtime.emit(event('shared.event'));

    expect(calls).toEqual(['shared', 'shared']);
  });

  it('applies a feature installed mid-dispatch to the next event, not this one', async () => {
    const calls: string[] = [];
    let installed = false;
    const { runtime } = harness([
      feature({
        id: 'installer',
        eventHandlers: [
          {
            on: 'trigger',
            handle: async () => {
              calls.push('installer');
              if (installed) {
                return;
              }
              installed = true;
              runtime.install(
                feature({
                  id: 'late',
                  eventHandlers: [{ on: 'trigger', handle: async () => void calls.push('late') }],
                }),
              );
            },
          },
        ],
      }),
    ]);

    await runtime.emit(event('trigger'));
    expect(calls).toEqual(['installer']);

    await runtime.emit(event('trigger'));
    expect(calls).toEqual(['installer', 'installer', 'late']);
  });

  it('refuses a second registration of the same id', () => {
    const { runtime } = harness([feature({ id: 'only' })]);
    expect(() => {
      runtime.install(feature({ id: 'only' }));
    }).toThrow(/already installed/);
  });

  it('refuses two features claiming the same command type', () => {
    const claim = (type: string) => [{ type, handle: async () => [] }];
    const { runtime } = harness([feature({ id: 'first', commands: claim('shared.run') })]);

    expect(() => {
      runtime.install(feature({ id: 'second', commands: claim('shared.run') }));
    }).toThrow(/duplicate command shared\.run/);
  });

  it('refuses two features claiming the same action id', () => {
    const claim = (id: string) => [defineAction({ id, permissions: ['p'], run: async () => null })];
    const { runtime } = harness([feature({ id: 'first', actionDefs: claim('demo.shared') })]);

    expect(() => {
      runtime.install(feature({ id: 'second', actionDefs: claim('demo.shared') }));
    }).toThrow(/duplicate action demo\.shared/);
  });

  it('registers nothing when a declaration collides half way through', () => {
    const { runtime } = harness([
      feature({ id: 'first', capabilities: [{ name: 'shared.cap', description: 'a' }] }),
    ]);
    expect(() => {
      runtime.install(
        feature({
          id: 'second',
          capabilities: [
            { name: 'second.only', description: 'b' },
            { name: 'shared.cap', description: 'c' },
          ],
        }),
      );
    }).toThrow(/duplicate capability/);
    // 'second.only' was declared before the collision and must not survive it.
    expect(runtime.capabilities()).toEqual(['shared.cap']);
  });
});

describe('capability requirements', () => {
  it('installs a feature whose requirement is absent, and says so', () => {
    const { logger, warnings } = recordingLogger();
    const { runtime } = harness(
      [feature({ id: 'needy', requires: ['nobody.provides.this'] })],
      logger,
    );

    expect(runtime.degraded().get('needy')).toEqual(['nobody.provides.this']);
    expect(warnings.join('\n')).toContain('nobody.provides.this');
  });

  it('does not call a feature degraded just because it was listed first', () => {
    // The failure this guards: resolution that ran per-feature at registration
    // time reported a false degradation whenever a feature preceded its
    // provider in the array, which is a warning about array order wearing the
    // same signal as "something is genuinely missing".
    const { logger, warnings } = recordingLogger();
    const { runtime } = harness(
      [
        feature({ id: 'consumer', requires: ['provider.offers'] }),
        feature({ id: 'provider', capabilities: [{ name: 'provider.offers', description: 'a' }] }),
      ],
      logger,
    );

    expect(runtime.degraded().size).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('recovers when the provider is installed later', () => {
    const { runtime } = harness([feature({ id: 'consumer', requires: ['late.offers'] })]);
    expect(runtime.degraded().size).toBe(1);

    runtime.install(
      feature({ id: 'provider', capabilities: [{ name: 'late.offers', description: 'a' }] }),
    );
    expect(runtime.degraded().size).toBe(0);

    runtime.uninstall('provider');
    expect(runtime.degraded().get('consumer')).toEqual(['late.offers']);
  });

  it('checks features installed at runtime, not just the ones passed in', () => {
    const { runtime } = harness([]);
    runtime.install(feature({ id: 'latecomer', requires: ['absent.cap'] }));
    expect(runtime.degraded().get('latecomer')).toEqual(['absent.cap']);
  });

  it('does not let one feature observe the other runtime', () => {
    const first = harness([feature({ id: 'shared', requires: ['gone.cap'] })]);
    const second = harness([]);
    expect(first.runtime.degraded().size).toBe(1);
    expect(second.runtime.degraded().size).toBe(0);
  });

  it('does not let a caller edit what the next reader sees', () => {
    const { runtime } = harness([feature({ id: 'needy', requires: ['absent.cap'] })]);

    const first = runtime.degraded();
    expect(() => (first.get('needy') as string[]).push('injected')).toThrow();

    expect(runtime.degraded().get('needy')).toEqual(['absent.cap']);
  });

  it('still lets a degraded feature handle its own events', async () => {
    // Degraded means reduced, not switched off. A feature whose optional
    // provider is missing must keep doing everything that does not depend on
    // it, or removing one feature silently removes the others with it.
    const heard: string[] = [];
    const { runtime } = harness([
      feature({
        id: 'partial',
        requires: ['absent.cap'],
        eventHandlers: [{ on: 'own.event', handle: async () => void heard.push('heard') }],
      }),
    ]);

    expect(runtime.degraded().get('partial')).toEqual(['absent.cap']);

    await runtime.emit(event('own.event'));
    expect(heard).toEqual(['heard']);
  });
});

describe('dispatch and emit', () => {
  it('publishes to the bus only after handlers have run', async () => {
    // The order is a contract, not an implementation detail. It was stated in
    // the comment above emit() while nothing enforced it, and an uncommitted
    // edit later moved the publish ahead of the handlers.
    //
    // Publishing first is the wrong way round: a live subscriber receives
    // deltas over SSE, so it could take a delta and then read a full_state that
    // does not yet include it. The reverse cost is smaller — a handler that
    // throws means the bus never sees the event — and a throwing handler is a
    // bug the caller still gets to act on.
    const order: string[] = [];
    const bus = createInMemoryEventBus();
    bus.subscribe(() => order.push('published'));

    const runtime = createRuntime({
      extensions: [
        feature({
          id: 'observer',
          eventHandlers: [
            {
              on: 'demo.order',
              handle: async () => {
                order.push('handler');
              },
            },
          ],
        }),
      ],
      store: new InMemoryStateStore(),
      bus,
      now: () => AT,
    });

    await runtime.emit(event('demo.order'));

    expect(order).toEqual(['handler', 'published']);
  });

  it('emits what a command returns, in order, and returns it', async () => {
    const { runtime, seen } = harness([
      feature({
        id: 'emitter',
        commands: [
          {
            type: 'demo.emit',
            handle: async () => [event('demo.first'), event('demo.second')],
          },
        ],
      }),
    ]);

    const returned = await runtime.dispatch(command('demo.emit'));

    expect(returned.map((each) => each.type)).toEqual(['demo.first', 'demo.second']);
    expect(seen.map((each) => each.type)).toEqual(['demo.first', 'demo.second']);
  });

  it('lets handlers react to what dispatch emitted', async () => {
    const heard: string[] = [];
    const { runtime } = harness([
      feature({
        id: 'emitter',
        commands: [{ type: 'demo.emit', handle: async () => [event('demo.made')] }],
      }),
      feature({
        id: 'listener',
        eventHandlers: [{ on: 'demo.made', handle: async () => void heard.push('heard') }],
      }),
    ]);

    await runtime.dispatch(command('demo.emit'));
    expect(heard).toEqual(['heard']);
  });

  it('rejects a command nobody handles', async () => {
    const { runtime } = harness([]);
    await expect(runtime.dispatch(command('nobody.listens'))).rejects.toThrow(/unknown command/);
  });

  it('rejects an action nobody registered', async () => {
    const { runtime } = harness([]);
    await expect(runtime.runAction('nobody.runs', null)).rejects.toThrow(/unknown action/);
  });

  it('reports which events it applied when a later one fails', async () => {
    // Without this the caller sees a bare failure and cannot tell a safe retry
    // from one that would re-apply the first event.
    const { runtime } = harness([
      feature({
        id: 'halfer',
        commands: [
          {
            type: 'demo.half',
            handle: async () => [event('demo.one'), event('demo.two'), event('demo.three')],
          },
        ],
      }),
      feature({
        id: 'broken',
        eventHandlers: [
          {
            on: 'demo.two',
            handle: async () => {
              throw new Error('second event fails');
            },
          },
        ],
      }),
    ]);

    const failure = await runtime.dispatch(command('demo.half')).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(PartialDispatchError);
    const partial = failure as PartialDispatchError;
    expect(partial.commandType).toBe('demo.half');
    expect(partial.applied.map((each) => each.type)).toEqual(['demo.one']);
  });
});

describe('persistence policy', () => {
  it('keeps a key event and drops a transient one', async () => {
    const { runtime, store } = harness([]);

    await runtime.emit(event('session.started'));
    await runtime.emit(event('tool.started'));

    expect(store.recorded().map((each) => each.type)).toEqual(['session.started']);
  });

  it('shows a dropped event to live listeners anyway', async () => {
    const { runtime, seen } = harness([]);

    await runtime.emit(event('tool.started'));

    expect(seen.map((each) => each.type)).toEqual(['tool.started']);
  });

  it('keeps a feature-declared key event', async () => {
    const { runtime, store } = harness([
      feature({ id: 'keeper', persistedEvents: ['keeper.important'] }),
    ]);

    await runtime.emit(event('keeper.important'));

    expect(store.recorded().map((each) => each.type)).toEqual(['keeper.important']);
  });

  it('stops keeping it once the feature that declared it is gone', async () => {
    const { runtime, store } = harness([
      feature({ id: 'keeper', persistedEvents: ['keeper.important'] }),
    ]);

    runtime.uninstall('keeper');
    await runtime.emit(event('keeper.important'));

    expect(store.recorded()).toEqual([]);
  });

  it('persists before handlers run, so a throwing handler still leaves a record', async () => {
    const { runtime, store } = harness([
      feature({
        id: 'broken',
        eventHandlers: [
          {
            on: 'session.started',
            handle: async () => {
              throw new Error('handler is broken');
            },
          },
        ],
      }),
    ]);

    await expect(runtime.emit(event('session.started'))).rejects.toThrow('handler is broken');
    expect(store.recorded().map((each) => each.type)).toEqual(['session.started']);
  });
});

describe('runtime context', () => {
  it('hands a feature a live back-reference, not the undefined it started as', async () => {
    let seenFromHandler: Runtime | undefined;
    const { runtime } = harness([
      feature({
        id: 'observer',
        eventHandlers: [
          {
            on: 'probe',
            handle: async (_event, context) => {
              seenFromHandler = context.runtime;
            },
          },
        ],
      }),
    ]);

    await runtime.emit(event('probe'));

    expect(seenFromHandler).toBe(runtime);
  });

  it('uses the injected clock rather than the wall clock', async () => {
    const store = new InMemoryStateStore();
    const runtime = createRuntime({
      extensions: [
        feature({
          id: 'stamper',
          commands: [
            {
              type: 'demo.stamp',
              handle: async (_cmd, context) => [
                { type: 'demo.stamped', occurredAt: context.now(), actorId: 'x', payload: {} },
              ],
            },
          ],
        }),
      ],
      store,
      bus: createInMemoryEventBus(),
      now: () => '1999-12-31T23:59:59.000Z',
    });

    const [stamped] = await runtime.dispatch(command('demo.stamp'));
    expect(stamped?.occurredAt).toBe('1999-12-31T23:59:59.000Z');
  });

  it('runs the bus it was given', async () => {
    const bus = createInMemoryEventBus();
    const store = new InMemoryStateStore();
    const delivered: GameEvent[] = [];
    bus.subscribe((each) => delivered.push(each));
    const runtime = createRuntime({ extensions: [], store, bus, now: () => AT });

    await runtime.emit(event('anything'));

    expect(delivered.map((each) => each.type)).toEqual(['anything']);
  });
});

describe('defineAction', () => {
  it('rejects a bare id, which two features would collide on', () => {
    expect(() =>
      defineAction({
        id: 'claim',
        permissions: ['a'],
        run: async () => null,
      }),
    ).toThrow(/dotted/);
  });

  it('rejects an id that is not lowercase', () => {
    expect(() =>
      defineAction({
        id: 'Quest.Claim',
        permissions: ['a'],
        run: async () => null,
      }),
    ).toThrow(/dotted/);
  });

  it('rejects an action nobody can be authorised to call', () => {
    expect(() =>
      defineAction({
        id: 'quest.claim',
        permissions: [],
        run: async () => null,
      }),
    ).toThrow(/no permissions/);
  });

  it('returns what run produces, with the context it was given', async () => {
    let seen: RuntimeContext | undefined;
    const { runtime } = harness([
      feature({
        id: 'doer',
        actionDefs: [
          defineAction({
            id: 'quest.claim',
            permissions: ['quest.claim'],
            run: async (input: { id: string }, context) => {
              seen = context;
              return { claimed: input.id === 'q1' };
            },
          }),
        ],
      }),
    ]);

    await expect(runtime.runAction('quest.claim', { id: 'q1' })).resolves.toEqual({
      claimed: true,
    });
    expect(seen?.runtime).toBe(runtime);
  });
});

describe('lazy discovery', () => {
  const catalog = () =>
    harness([
      feature({
        id: 'quest',
        capabilities: [
          { name: 'quest.read', description: 'read a quest' },
          { name: 'quest.write', description: 'change a quest' },
        ],
        actionDefs: [
          defineAction({
            id: 'quest.claim',
            permissions: ['quest.claim'],
            // The fixture had no description on its action while the capabilities
            // beside it had one, so "the description survives" was untestable: the
            // test could not tell a preserved field from an absent one.
            description: 'claim a quest for this agent',
            run: async () => ({ claimed: true }),
          }),
        ],
      }),
      feature({
        id: 'battle',
        capabilities: [{ name: 'battle.join', description: 'join a battle' }],
        actionDefs: [
          defineAction({
            id: 'battle.accept',
            permissions: ['battle.accept', 'battle.join'],
            run: async () => ({ accepted: true }),
          }),
        ],
      }),
    ]);

  it('hands a connecting client the domains, not the whole catalog', () => {
    // The lazy shape: five names exist and none of them are in the first answer.
    const { runtime } = catalog();
    expect(runtime.domains()).toEqual(['battle', 'quest']);
  });

  it('returns one domain at a time, on request', () => {
    const { runtime } = catalog();

    const detail = runtime.describeDomain('quest');

    expect(detail.capabilities.map((each) => each.name)).toEqual(['quest.read', 'quest.write']);
    expect(detail.actions.map((each) => each.id)).toEqual(['quest.claim']);
    expect(detail.capabilities[0]?.description).toBe('read a quest');
  });

  it('carries each action description through describeDomain', () => {
    // The drop this guards: describeDomain re-projected every action into
    // {id, permissions} and threw the description away, so 'inspect' reported
    // 'undescribed' for the whole game. Nineteen authored descriptions in guild
    // and social alone, written for whoever is discovering the API, all lost —
    // and the test beside this one asserted the id and the permissions, so it
    // stayed green.
    const { runtime } = catalog();
    const detail = runtime.describeDomain('quest');
    const action = detail.actions[0];
    expect(action?.description).toBeDefined();
    expect(typeof action?.description).toBe('string');
  });

  it('carries permissions with an action so a surface can authorize it', () => {
    const { runtime } = catalog();
    expect(runtime.describeDomain('battle').actions[0]?.permissions).toEqual([
      'battle.accept',
      'battle.join',
    ]);
  });

  it('returns nothing for a domain that has none', () => {
    const { runtime } = catalog();
    expect(runtime.describeDomain('guild')).toEqual({ capabilities: [], actions: [] });
  });

  it('drops a domain again when its feature is uninstalled', () => {
    const { runtime } = catalog();
    expect(runtime.domains()).toEqual(['battle', 'quest']);

    runtime.uninstall('battle');

    expect(runtime.domains()).toEqual(['quest']);
    expect(runtime.describeDomain('battle')).toEqual({ capabilities: [], actions: [] });
  });

  it('does not let a caller edit the catalog it was handed', () => {
    const { runtime } = catalog();
    const detail = runtime.describeDomain('quest');
    expect(() => (detail.capabilities as unknown[]).push({ name: 'injected' })).toThrow();
    expect(() => (detail.actions as unknown[]).push({ id: 'quest.injected' })).toThrow();
    expect(() => (detail.actions[0]?.permissions as string[]).push('injected')).toThrow();
  });

  it("does not hand out the feature's own capability objects", () => {
    // Freezing the array is not the same as copying what is in it. With only a
    // shallow freeze, `declared` stayed reachable through the catalog, so this
    // write succeeded and permanently rewrote the feature's declaration. The
    // throw is the point: what the catalog hands out is a frozen copy.
    const declared = { name: 'quest.read', description: 'read a quest' };
    const { runtime } = harness([feature({ id: 'quest', capabilities: [declared] })]);

    const detail = runtime.describeDomain('quest');
    expect(() => {
      (detail.capabilities[0] as { description: string }).description = 'hijacked';
    }).toThrow();

    expect(declared.description).toBe('read a quest');
    expect(detail.capabilities[0]).not.toBe(declared);
  });

  it('rejects a capability name that is not namespaced', () => {
    // A bare "read" from two features merges into one catalog domain, and the
    // collision only shows up later as a capability that is mysteriously gone.
    const { runtime } = harness([]);

    expect(() => {
      runtime.install(feature({ id: 'loose', capabilities: [{ name: 'read', description: 'a' }] }));
    }).toThrow(/dotted/);
    expect(runtime.domains()).toEqual([]);
  });

  it('rejects an action id that is not namespaced', () => {
    // Deliberately NOT built with defineAction. defineAction validates, so a
    // test written against it passes whatever the registry does, and the gap
    // this covers is the plain object literal a feature can write instead —
    // actionDefs is typed as ActionDef[], not as "whatever defineAction
    // returned", so the literal type-checks and reaches the registry unchecked.
    const { runtime } = harness([]);

    expect(() => {
      runtime.install(
        feature({
          id: 'loose-action',
          actionDefs: [{ id: 'read', permissions: ['a:b'], run: async () => 1 }],
        }),
      );
    }).toThrow(/dotted/);
    expect(runtime.domains()).toEqual([]);
  });

  it('rejects an action that no surface could authorise', () => {
    // Same reasoning: a literal, not defineAction, so this asserts the registry
    // rather than the helper. ActionDef documents permissions as "never empty",
    // and an action nobody may run looks like a working feature that is simply
    // never called.
    const { runtime } = harness([]);

    expect(() => {
      runtime.install(
        feature({
          id: 'unauthorised',
          actionDefs: [{ id: 'quest.claim', permissions: [], run: async () => 1 }],
        }),
      );
    }).toThrow(/no permissions/);
  });

  it('registers a well-formed action', () => {
    // The two negative cases would also pass if the registry rejected every
    // action, so the accepting case belongs to the same assertion set.
    const { runtime } = harness([]);

    expect(() => {
      runtime.install(
        feature({
          id: 'well-formed',
          actionDefs: [
            { id: 'quest.claim', permissions: ['agent:quest:claim'], run: async () => 1 },
          ],
        }),
      );
    }).not.toThrow();
    expect(runtime.domains()).toContain('quest');
  });
});

describe('feature state', () => {
  it('round-trips a slice under the feature id', async () => {
    const store = new InMemoryStateStore();
    await store.save('demo', { count: 1 });
    expect(store.load<{ count: number }>('demo')).toEqual({ count: 1 });
    expect(store.load('never-written')).toBeUndefined();
  });
});

describe('bus subscription', () => {
  it('stops delivering after unsubscribe, even from inside a dispatch', () => {
    const bus: EventBus = createInMemoryEventBus();
    const delivered: string[] = [];
    const unsubscribe = bus.subscribe((each) => {
      delivered.push(`first:${each.type}`);
      unsubscribe();
    });
    bus.subscribe((each) => delivered.push(`second:${each.type}`));

    bus.publish(event('one'));
    bus.publish(event('two'));

    expect(delivered).toEqual(['first:one', 'second:one', 'second:two']);
  });
});
