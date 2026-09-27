import type { EventSourceLike } from '@battle-agents/game-client';

/**
 * The browser's `EventSource`, narrowed to what the game client asks for.
 *
 * ## The named-event subscription, which is the whole reason this exists
 *
 * `onmessage` receives ONLY messages sent without an `event:` line. The stream
 * sends `event: full_state` and `event: delta` — `apps/web/src/event-stream.ts`
 * names them on purpose, and says the body carries `kind` as well — and a named
 * event is delivered to `addEventListener(name, …)` and to nobody else.
 *
 * So an adapter that only assigns `onmessage` receives nothing: no error, no
 * close, silence. That is not a hypothetical. `/city` did exactly this, and the
 * city rendered a permanent, correct-looking, entirely empty world — the canvas
 * mounted, the status said `streaming`, the console was clean, the stream
 * answered 200 `text/event-stream`, and the browser received every frame.
 *
 * Found by running the game in a real browser and reading what the page
 * actually got. Reading the page would not have found it: the type was right,
 * the wiring was right, and the two disagreed about the transport.
 *
 * The names are subscribed HERE rather than pushed into the client, because the
 * client is deliberately transport-shaped — `EventSourceLike` has no
 * `addEventListener`, so it cannot know what the wire calls its frames. Deciding
 * which of them reach it is the host's job, and this is the host.
 */
export const STREAM_EVENT_NAMES = ['full_state', 'delta'] as const;

/**
 * What a browser's `EventSource` has and the client's contract does not.
 *
 * Named rather than widened into `EventSourceLike` on purpose: the client's
 * transport shape is frozen, and widening it here would be asking the transport
 * to know something about SSE that it is built not to know. This is the host's
 * extra reach, and the host is where it belongs.
 */
// It does NOT extend `EventSourceLike`, and that is forced rather than chosen.
// The client's `onmessage` takes `{ data: string }` and the DOM's takes a full
// `MessageEvent`; under `strictFunctionTypes` a property is checked
// contravariantly, so the browser's own EventSource does not satisfy the
// client's shape. The two are genuinely different types, the adapter exists to
// sit between them, and widening either to make the error go away would hide the
// one place where a frame's shape is decided.
interface BrowserEventSource {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  // `EventListener`, not `(event: MessageEvent) => void`: the DOM's
  // `addEventListener` is generic over an event map, and a narrow signature
  // here would make the real `EventSource` fail to satisfy its own adapter.
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  close(): void;
}

/**
 * Wraps a real `EventSource` in the client's transport shape.
 *
 * `onmessage` is declared as taking `{ data: string }` and a browser's
 * `EventSource` declares one taking a full `MessageEvent`. Assigning one to the
 * other fails, correctly, and a cast would hide the one place where a frame's
 * shape is decided — so the handlers are assigned in the direction that IS
 * assignable, and the events are handed on as-is.
 *
 * `url` is taken rather than a source injected, because the point of this
 * function is to be the seam that constructs a browser EventSource; a test
 * drives it with a stub through `createSource` below.
 */
export function browserEventSource(url: string): EventSourceLike {
  return adapt(() => new EventSource(url));
}

/**
 * The adapter over any EventSource-shaped object.
 *
 * Split from `browserEventSource` so the behaviour can be tested without a
 * browser: the subscription to named events is the part that was wrong, and it
 * is worth a test that does not need a running page to be meaningful.
 */
export function adapt(createSource: () => BrowserEventSource): EventSourceLike {
  const source = createSource();
  // Per-source, not module scope: two sources on one page would otherwise share
  // one handler, and the second would silently replace the first's.
  let handler: EventSourceLike['onmessage'] = null;

  const forward: EventListener = (event): void => {
    if (handler !== null) handler({ data: (event as MessageEvent).data });
  };

  return {
    set onmessage(next: EventSourceLike['onmessage']) {
      handler = next;
      // The unnamed channel is kept as well as the named ones. Every frame this
      // stream sends today is named, but `onmessage` is the channel a browser
      // uses by default, and a host that listened only for two hard-coded names
      // would silently drop anything else the stream ever grew.
      source.onmessage = next === null ? null : (event): void => {
        handler?.({ data: event.data });
      };
      // Re-registered on every assignment rather than once, because the client
      // assigns in `connect()` and reuses the source across reconnects;
      // registering once against a null handler would leave a reconnect with no
      // way to receive anything. `forward` reads `handler` at delivery time, so
      // the listener never has to be torn down and rebuilt to follow a new one.
      for (const name of STREAM_EVENT_NAMES) {
        source.removeEventListener(name, forward);
        if (next !== null) source.addEventListener(name, forward);
      }
    },
    set onerror(next: EventSourceLike['onerror']) {
      source.onerror = next === null ? null : (): void => {
        next(new Error('stream error'));
      };
    },
    close() {
      source.close();
    },
  };
}
