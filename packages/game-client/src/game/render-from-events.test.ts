import { describe, expect, it } from 'vitest';

import type { GameEvent } from '@battle-agents/core';

import { WorldStore } from '../state/store.js';
import { GameClient } from '../client.js';
import { CountingView, PixiWorldView } from './view.js';
import { SpriteCache } from '../sprites/sprite-factory.js';
import { placementFor, zoneForTool, ZONE_PLACEMENT } from '../zones.js';
import { CITY } from '../scenes/scene-config.js';
import { TOOL_ZONE_MAP, getZoneForTool, type ZoneId } from '@battle-agents/protocol';

/**
 * The world renders, and is driven ONLY by normalized events.
 *
 * The failure this catches is a client that hardcodes an agent, a zone or a
 * position. It renders perfectly and violates the rule, because nothing in a
 * screenshot says where the pixel came from. So the fixture names agents the
 * client has never heard of, and the complementary assertion is that the store
 * is EMPTY before the first `full_state` — a client that quietly seeded state
 * from a fixture would pass the first test and fail the second.
 */

/** Names deliberately unlike anything in the repo, so nothing can match by luck. */
const UNKNOWN_AGENTS = [
  'agent-never-heard-of-01',
  'zzz-somebody-else',
  'a-brand-new-character',
  '完全未知',
] as const;

function sessionStarted(sessionId: string, agentId: string, harness: string): GameEvent {
  return {
    type: 'session.started',
    occurredAt: '2026-09-26T00:00:00.000Z',
    actorId: agentId,
    payload: { sessionId, agentId, harness, installationId: 'inst-1', projectId: 'proj-1' },
  };
}

function toolStarted(sessionId: string, tool: string): GameEvent {
  return {
    type: 'tool.started',
    occurredAt: '2026-09-26T00:00:01.000Z',
    actorId: sessionId,
    payload: { sessionId, tool },
  };
}

describe('the store is empty until the first full_state', () => {
  it('knows nothing before any snapshot', () => {
    const store = new WorldStore();
    // The assertion that catches a client seeding itself from a fixture. A
    // store that began with a demo agent would render a populated city on
    // first paint and every later test would pass.
    expect(store.size).toBe(0);
    expect(store.hydrated).toBe(false);
  });

  it('DROPS a delta that arrives before any snapshot', () => {
    const store = new WorldStore();
    // The hub cannot produce this ordering, so reaching it means a stream we
    // do not understand. Inventing an agent from it would be the client
    // deciding the world exists rather than the server saying so.
    const dirty = store.applyDelta(toolStarted('ghost-session', 'Bash'));
    expect(dirty).toEqual([]);
    expect(store.size).toBe(0);
  });

  it('knows only what the snapshot names', () => {
    const store = new WorldStore();
    store.hydrate({ protocolVersion: 'test', liveSessionIds: ['only-this-one'] });
    expect(store.size).toBe(1);
    expect(store.get('only-this-one')).toBeDefined();
    expect(store.get('someone-else')).toBeUndefined();
  });
});

describe('the world is driven only by the event stream', () => {
  it('renders agents it has never heard of, correctly', () => {
    // Built through the composition root, so the view is wired to the store.
    // A bare `new PixiWorldView({store})` renders an empty world here and the
    // assertion below fails for a reason that has nothing to do with events.
    const client = new GameClient({ cache: new SpriteCache() });
    const { store, view } = { store: client.store, view: client.view };

    // No live sessions named — these agents arrive purely as deltas, which is
    // the shape a client that hardcoded its cast would get wrong.
    store.hydrate({ protocolVersion: 'test', liveSessionIds: [] });
    const placed: string[] = [];
    for (const [index, agentId] of UNKNOWN_AGENTS.entries()) {
      const sessionId = `session-for-${index}`;
      placed.push(sessionId);
      store.applyDelta(sessionStarted(sessionId, agentId, 'codex'));
      store.applyDelta(toolStarted(sessionId, 'Bash'));
    }

    expect(store.size).toBe(UNKNOWN_AGENTS.length);
    // A frame, because deltas are buffered until one runs. Asserting before
    // the frame is the same class of mistake as a host that reads nodeCount
    // in the same tick it pushed an event: the store is updated, the view is
    // not, and it looks like the world is empty.
    client.frame();
    expect(view.nodeCount).toBe(UNKNOWN_AGENTS.length);
    // coordinates the placement table gives that zone. A hardcoded position or
    // a local zone copy would disagree with one of those.
    const bashZone = getZoneForTool('Bash');
    for (const [index, sessionId] of placed.entries()) {
      const agent = store.get(sessionId);
      expect(agent?.agentId).toBe(UNKNOWN_AGENTS[index]);
      expect(agent?.harness).toBe('codex');
      expect(agent?.zone).toBe(bashZone);
    }
  });

  it('puts an agent in the tool zone the shared table assigns', () => {
    const store = new WorldStore();
    store.hydrate({ protocolVersion: 'test', liveSessionIds: ['s1'] });

    for (const tool of Object.keys(TOOL_ZONE_MAP)) {
      store.applyDelta(toolStarted('s1', tool));
      // Cross-check against the one table, read from the protocol package
      // rather than from anything this client holds.
      expect(store.get('s1')?.zone).toBe(getZoneForTool(tool));
    }
  });

  it('routes an unmapped tool rather than dropping the event', () => {
    const store = new WorldStore();
    store.hydrate({ protocolVersion: 'test', liveSessionIds: ['s1'] });
    store.applyDelta(toolStarted('s1', 'a_tool_nobody_has_heard_of'));
    // The event still happened. Showing it in the wrong place beats a client
    // that silently loses activity it does not recognise.
    expect(store.get('s1')?.zone).toBe('thinking');
  });

  it('keeps an offline agent on the map rather than removing it', () => {
    const client = new GameClient({ cache: new SpriteCache() });
    const store = client.store;
    store.hydrate({ protocolVersion: 'test', liveSessionIds: ['s1'] });
    store.applyDelta(sessionStarted('s1', 'a1', 'claude'));
    client.frame();
    expect(client.view.nodeCount).toBe(1);

    store.applyDelta({
      type: 'session.ended',
      occurredAt: '2026-09-26T00:00:02.000Z',
      actorId: 'a1',
      payload: { sessionId: 's1', reason: 'completed' },
    });

    client.frame();
    // DESIGN.md section 4: a dead session must never make a character vanish.
    expect(client.view.nodeCount).toBe(1);
    expect(store.get('s1')?.online).toBe(false);
  });

  it('drops an agent the store no longer has on sweep', () => {
    const store = new WorldStore();
    const view = new CountingView(store);
    store.subscribe((change) => {
      if (change.kind === 'agents-dirty') view.applyAgentDelta(change.agentIds);
      else view.rebuild();
    });
    store.hydrate({ protocolVersion: 'test', liveSessionIds: ['s1', 's2'] });
    expect(view.nodeCount).toBe(2);

    // A resync snapshot that no longer lists s2. Then, and only then, is the
    // agent gone — the snapshot is authoritative, not a timeout.
    store.hydrate({ protocolVersion: 'test', liveSessionIds: ['s1'] });
    view.sweep();

    expect(view.nodeCount).toBe(1);
  });
});

describe('zone mapping is config-driven and consumes the one table', () => {
  it('routes a tool added to the SHARED config, with no change to any client file', () => {
    // The literal form of "config-driven". The tool is added to the protocol's
    // table — the table `ba-tool-map-port-89a` owns — and the client picks it
    // up. If any file in this package branched on a tool name, or held its own
    // tool->zone map, this would not route and the test would go red.
    const inventedTool = 'a_tool_added_to_the_shared_table';
    expect(TOOL_ZONE_MAP[inventedTool]).toBeUndefined();

    // The shared table is a plain frozen-shape object; writing to it here is
    // what a future contributor adding a harness tool will do, and it is
    // restored below so the mutation cannot leak into another test.
    const writable = TOOL_ZONE_MAP as Record<string, ZoneId>;
    writable[inventedTool] = 'guild-hall';
    try {
      const store = new WorldStore();
      store.hydrate({ protocolVersion: 'test', liveSessionIds: ['s1'] });
      store.applyDelta(toolStarted('s1', inventedTool));

      // Routed, with no file in packages/game-client touched.
      expect(store.get('s1')?.zone).toBe('guild-hall');
      // And it is placed there.
      expect(placementFor(store.get('s1')!.zone).scene).toBe('guild-hall');
    } finally {
      delete writable[inventedTool];
    }
    expect(TOOL_ZONE_MAP[inventedTool]).toBeUndefined();
  });

  it('agrees with getZoneForTool for every tool in the shared table', () => {
    // The cross-check the bead asks for, read from one table. `zoneForTool` is
    // a re-export, so this is a check that the re-export was not quietly
    // replaced with a local implementation that happens to agree today.
    for (const tool of Object.keys(TOOL_ZONE_MAP)) {
      expect(zoneForTool(tool)).toBe(getZoneForTool(tool));
    }
  });

  it('places every zone the protocol can produce', () => {
    // A zone with no placement is an agent standing at (0,0) forever. The
    // table is `Record<ZoneId, ...>` so the compiler catches a new zone at
    // build time; this catches the case where the type widened and the table
    // was widened with a wrong answer.
    const produced = new Set<ZoneId>([
      ...(Object.values(TOOL_ZONE_MAP) as ZoneId[]),
      'idle',
      'bounty-board',
      'battle-arena',
      'guild-hall',
    ]);
    for (const zone of produced) {
      const placement = ZONE_PLACEMENT[zone];
      expect(placement, `no placement for ${zone}`).toBeDefined();
      expect(['city', 'arena', 'guild-hall']).toContain(placement.scene);
    }
  });

  it('routes an event type added to the event zone config', () => {
    const store = new WorldStore();
    store.hydrate({ protocolVersion: 'test', liveSessionIds: ['s1'] });
    // `bounty.claimed` is in the CLIENT's event table, which is the correct
    // home for it: the protocol does not know what a map is. Adding it is a
    // client change, and this asserts the routing follows the config.
    store.applyDelta({
      type: 'bounty.claimed',
      occurredAt: '2026-09-26T00:00:00.000Z',
      actorId: 'a1',
      payload: { sessionId: 's1' },
    });
    expect(store.get('s1')?.zone).toBe('bounty-board');
  });

  it('draws a zone marker for every zone IN ITS SCENE, built once', () => {
    const store = new WorldStore();
    const view = new PixiWorldView({ store, scene: CITY, cache: new SpriteCache() });
    // One marker per zone, and the count does not grow with deltas — the layer
    // is static and a per-delta marker build would be an unbounded leak.
    //
    // Scoped to the city. The table covers all three scenes and this assertion
    // used to demand every row of it, which is what pinned the defect: a view
    // that drew the whole table on a 32x32 grid passed this test and rendered
    // the arena's marker on top of the Coding City.
    const markers = view.zoneLayer.children.length;
    const cityZones = (Object.keys(ZONE_PLACEMENT) as (keyof typeof ZONE_PLACEMENT)[]).filter(
      (zone) => ZONE_PLACEMENT[zone].scene === CITY.id,
    );
    expect(markers).toBe(cityZones.length);

    for (let i = 0; i < 50; i += 1) {
      store.applyDelta(toolStarted(`s${i}`, 'Read'));
    }
    expect(view.zoneLayer.children.length).toBe(markers);
  });
});
