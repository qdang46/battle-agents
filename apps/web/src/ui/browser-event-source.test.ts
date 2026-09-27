import { describe, expect, it } from 'vitest';

import type { EventSourceLike } from '@battle-agents/game-client';

import { adapt, STREAM_EVENT_NAMES } from './browser-event-source.js';

/**
 * The host's half of the stream contract.
 *
 * The client's `decodeFrame` half is tested in
 * `packages/game-client/src/net/browser-source.test.ts`. This is the other half,
 * and the two were broken independently:
 *
 *   - the client refused a bare payload, which is what a browser's
 *     `MessageEvent.data` actually is
 *   - the host subscribed only to `onmessage`, which never receives a NAMED
 *     event, and the stream names every frame it sends
 *
 * Either one alone is enough for `/city` to render a permanent, healthy-looking,
 * entirely empty world: the canvas mounts, the status says `streaming`, the
 * console is clean, the stream answers 200 `text/event-stream`, and no frame
 * ever reaches the store. Nothing red anywhere, which is what made this worth a
 * test on both sides rather than one.
 */

/** An EventSource as the DOM defines it: named listeners AND onmessage. */
class FakeBrowserSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  /** Exactly what a browser does with a frame carrying an `event:` line. */
  deliver(name: string, data: string): void {
    const event = { data } as MessageEvent;
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    if (name === 'message') this.onmessage?.(event);
  }
}

function wired() {
  const source = new FakeBrowserSource();
  const adapter = adapt(() => source);
  return { source, adapter };
}

describe('the browser EventSource adapter', () => {
  it('delivers a NAMED frame to the client, which onmessage alone never would', () => {
    const { source, adapter } = wired();
    const seen: string[] = [];
    adapter.onmessage = (event) => seen.push(event.data);

    source.deliver('full_state', '{"kind":"full_state"}');
    source.deliver('delta', '{"kind":"delta"}');

    // The bug: with `onmessage` alone both of these are dropped on the floor,
    // with no error and no close.
    expect(seen).toEqual(['{"kind":"full_state"}', '{"kind":"delta"}']);
  });

  it('subscribes to every name the stream uses, and no others', () => {
    const { source, adapter } = wired();
    adapter.onmessage = () => undefined;

    expect([...source.listeners.keys()].sort()).toEqual([...STREAM_EVENT_NAMES].sort());
    expect(STREAM_EVENT_NAMES).toEqual(['full_state', 'delta']);
  });

  it('stops delivering once the handler is removed, rather than holding a stale one', () => {
    // The client nulls its handler on teardown. An adapter that captured the
    // handler in the listener closure would keep calling a dead client.
    const { source, adapter } = wired();
    const seen: string[] = [];
    adapter.onmessage = (event) => seen.push(event.data);
    adapter.onmessage = null;

    source.deliver('delta', '{"kind":"delta"}');

    expect(seen).toEqual([]);
  });

  it('follows a REPLACED handler, because the client reassigns across reconnects', () => {
    // The first handler is what a previous connection installed. If the
    // listener were registered once against it, every frame after a reconnect
    // would go to the old client.
    const { source, adapter } = wired();
    const first: string[] = [];
    const second: string[] = [];
    adapter.onmessage = (event) => first.push(event.data);
    adapter.onmessage = (event) => second.push(event.data);

    source.deliver('delta', 'after-reconnect');

    expect(first).toEqual([]);
    expect(second).toEqual(['after-reconnect']);
  });

  it('delivers exactly one copy, not one per registration', () => {
    // A re-assignment must not leave the old listener attached. Two listeners
    // would apply every delta twice, which the store coalesces and a reader
    // would never see.
    const { source, adapter } = wired();
    const seen: string[] = [];
    const handler: EventSourceLike['onmessage'] = (event) => seen.push(event.data);
    adapter.onmessage = handler;
    adapter.onmessage = handler;

    source.deliver('delta', 'once');

    expect(seen).toEqual(['once']);
  });

  it('still honours onmessage for an UNNAMED frame, which is the browser default', () => {
    const { source, adapter } = wired();
    const seen: string[] = [];
    adapter.onmessage = (event) => seen.push(event.data);

    source.deliver('message', 'unnamed');

    expect(seen).toEqual(['unnamed']);
  });
});
