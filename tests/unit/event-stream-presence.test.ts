import { describe, expect, it } from 'vitest';

import type { EventBus, GameEvent } from '@battle-agents/core';
import { createInMemoryEventBus } from '@battle-agents/core';
import { EventStreamHub } from '../../apps/web/src/event-stream.js';

/**
 * Who is in the world when somebody arrives.
 *
 * ## What was actually broken
 *
 * `event-gateway.ts` built its hub with
 *
 *     snapshot: () => ({ protocolVersion, liveSessionIds: [] })
 *
 * A literal empty list, with a comment saying there was no presence registry.
 * `full_state` is what a page is BUILT from, so every visitor was told nobody
 * existed, and the only agents a world could ever show were the ones that
 * happened to emit a delta during the seconds after it connected. Load the page
 * twice and the second load is empty. That is a game nobody can look at twice,
 * and it is why the Coding City was empty for everyone who was not already
 * watching when an agent happened to start.
 *
 * ## The constraint this had to satisfy
 *
 * `subscribe` takes its snapshot SYNCHRONOUSLY and joins the broadcast set in
 * the same non-yielding step, so no event can slip between "here is the world"
 * and "this client is watching". Presence therefore cannot be a query inside
 * `subscribe`; it is a set in the hub, folded from lifecycle events on the bus
 * and primed once from durable state at composition time.
 *
 * ## What these tests would have caught
 *
 * The first version of the fix kept `snapshot` required, so a hub that wanted
 * presence had to be told to look at the hub's own set — and a test that
 * supplied a `snapshot` returning `[]` would have seen an empty world and
 * passed. The default is what makes the presence path the one that runs.
 */
function aBus(): EventBus {
  return createInMemoryEventBus();
}

function lifecycle(type: string, sessionId: string): GameEvent {
  return {
    type,
    occurredAt: '2026-09-28T04:00:00.000Z',
    actorId: 'agent-1',
    payload: { type, sessionId },
  } as unknown as GameEvent;
}

function snapshotOf(hub: EventStreamHub): Promise<string[]> {
  const subscriber = hub.subscribe('public');
  return subscriber.pull().then((frame) => {
    subscriber.close();
    if (frame === undefined || frame.kind !== 'full_state') {
      throw new Error('expected a full_state frame');
    }
    return [...frame.state.liveSessionIds];
  });
}

describe('presence in the opening frame', () => {
  it('is empty in a world nobody has entered', async () => {
    const hub = new EventStreamHub({ bus: aBus() });
    expect(await snapshotOf(hub)).toEqual([]);
  });

  it('names a session that started BEFORE the subscriber arrived', async () => {
    // The defect in one assertion. The event is published first, the subscriber
    // second — which is exactly the order a restart, a slow page load, or a
    // second browser tab produces. Before the fix this returned [].
    const bus = aBus();
    const hub = new EventStreamHub({ bus });

    await bus.publish(lifecycle('session.started', 's-1'));
    await bus.publish(lifecycle('session.started', 's-2'));

    expect(await snapshotOf(hub)).toEqual(['s-1', 's-2']);
  });

  it('keeps a session that resumed, because a resume is still being here', async () => {
    const bus = aBus();
    const hub = new EventStreamHub({ bus });

    await bus.publish(lifecycle('session.started', 's-1'));
    await bus.publish(lifecycle('session.ended', 's-1'));
    await bus.publish(lifecycle('session.resumed', 's-1'));

    expect(await snapshotOf(hub)).toEqual(['s-1']);
  });

  it('drops a session that ended, so the character does not haunt the map', async () => {
    // The failure mode this exists to prevent is the mirror of the empty world:
    // a dead session whose character stands in the city forever. §10.2 — HP 0
    // never kills the character, but a session that has ENDED is not a presence.
    const bus = aBus();
    const hub = new EventStreamHub({ bus });

    await bus.publish(lifecycle('session.started', 's-1'));
    await bus.publish(lifecycle('session.started', 's-2'));
    await bus.publish(lifecycle('session.ended', 's-1'));

    expect(await snapshotOf(hub)).toEqual(['s-2']);
  });

  it('ignores an event that names no session, rather than inventing one', async () => {
    const bus = aBus();
    const hub = new EventStreamHub({ bus });

    await bus.publish({ type: 'test.passed', occurredAt: 'x', actorId: 'a', payload: {} } as unknown as GameEvent);
    await bus.publish(lifecycle('session.started', 's-1'));
    await bus.publish({ type: 'session.started', occurredAt: 'x', actorId: 'a', payload: { sessionId: 42 } } as unknown as GameEvent);

    expect(await snapshotOf(hub)).toEqual(['s-1']);
  });

  it('is primed from durable state, so a restart does not empty the world', async () => {
    // The composition root passes what the database already knows. Without it a
    // hub is empty until the next agent happens to connect, which is the same
    // defect arriving by a different route.
    const hub = new EventStreamHub({ bus: aBus(), initialLiveSessionIds: ['s-before-restart'] });

    expect(await snapshotOf(hub)).toEqual(['s-before-restart']);
  });

  it('lets a primed session leave when it ends, rather than pinning it forever', async () => {
    // Priming is a starting point, not an override. A session that is in the
    // table when the process starts is normally one that is still running, but
    // the sweeper is what decides that, and a hub that only ever added would
    // keep showing a session the sweeper has already marked disconnected.
    const bus = aBus();
    const hub = new EventStreamHub({ bus, initialLiveSessionIds: ['s-1'] });

    await bus.publish(lifecycle('session.ended', 's-1'));

    expect(await snapshotOf(hub)).toEqual([]);
  });

  it('still honours an explicit snapshot, for a test that pins the world', async () => {
    // The option survives because a test asserting against a fixed world is a
    // legitimate thing to want. It is the DEFAULT that has to be the presence
    // path, or every hub built without this option is empty again.
    const hub = new EventStreamHub({
      bus: aBus(),
      snapshot: () => ({ protocolVersion: 'test', liveSessionIds: ['pinned'] }),
    });

    expect(await snapshotOf(hub)).toEqual(['pinned']);
  });
});
