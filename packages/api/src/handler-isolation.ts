import type { EventHandler, GameFeature } from '@battle-agents/core';

/**
 * A per-handler error boundary, applied where features are mounted.
 *
 * ## Why this is not in core
 *
 * `core` is frozen and AGENTS.md is blunt about it: a change that has to edit
 * core is an architecture failure, not a preference. The bug
 * (ba-throwing-handler-starves-bus-xz6) is that `emit` awaits handlers in order
 * and does not catch, so one handler that throws unwinds the loop, every
 * consumer registered after it never runs, and the bus never sees the event.
 *
 * The comment in runtime.ts gives a real reason not to catch — a feature
 * quietly missing state is worse than a loud failure — and it is right. What it
 * describes is not a safe version of catching. It is the same silence with a
 * much larger blast radius: the feature that threw is quiet AND so is every
 * other feature downstream of it, and the caller gets an exception that names
 * no handler.
 *
 * The first attempt at this wrapped `emit` from the outside. That does not work
 * and the reason is worth recording: a handler is called with a
 * `RuntimeContext`, and the only context the runtime ever builds carries its
 * own `emit` — so an outside wrapper would have to fabricate one, and a
 * fabricated context is a context whose `runtime` is a lie. Wrapping the
 * handler passes the runtime's OWN context straight through, so a feature
 * cannot tell it has been isolated.
 *
 * ## What this deliberately does not do
 *
 * It does not run handlers concurrently. The registry hands them out in
 * registration order and that order is the contract — it is why one feature can
 * consume what another emits — so `Promise.allSettled` would remove the
 * starvation and the ordering in one edit, and the second is load-bearing.
 *
 * It does not rethrow. Rethrowing is the bug. A reporter that is told what
 * failed is the loud version; a reporter that is ignored is the quiet one, so
 * `onFailure` is required rather than optional — an unreported catch is exactly
 * the failure mode this exists to remove.
 *
 * It does not know which FEATURE threw beyond the id it was mounted under,
 * which is all the runtime knows either. See `HandlerFailure`.
 */

/**
 * One handler that threw, named as precisely as the runtime allows.
 *
 * The feature id is known because the boundary is applied per feature at mount
 * time. The event type is known because the handler declares it. What is NOT
 * known — and is not invented here — is which of a feature's several handlers
 * for the same event threw: the registry keys handlers by event type, so two
 * handlers for one event are indistinguishable to anything that is not
 * standing at the call site. A failure record that guessed would be worse than
 * one that says what it knows.
 */
export interface HandlerFailure {
  /** The `id` of the feature the handler was mounted under. */
  readonly featureId: string;
  /** The event type the handler was registered for. */
  readonly eventType: string;
  /** The thrown value, unflattened. A logger decides how to render it. */
  readonly cause: unknown;
}

/** Told about a failure, and trusted to be the reason it is not silent. */
export type HandlerFailureReporter = (failure: HandlerFailure) => void;

/**
 * The event type a host records a failure under.
 *
 * Exported rather than left to a string literal at each call site, because a
 * fault that is logged under one name and queried under another is a fault
 * nobody finds. It is NOT in `GAME_EVENT_NAMES`: no feature declares it, so no
 * feature may react to it, and a host that wants one to reach a client has to
 * say so by declaring it the way any other event is declared.
 */
export const HANDLER_FAILED = 'handler.failed';

/**
 * The feature with each of its handlers behind a boundary.
 *
 * Returns the feature unchanged when it has no handlers, and otherwise a copy
 * whose `eventHandlers` are the originals wrapped. The rest of the feature —
 * its id, commands, actions, capabilities, `requires`, `persistedEvents` — is
 * passed through by reference on purpose: a copy that deep-cloned a feature
 * would freeze whatever the feature closes over at mount time, and a feature's
 * repositories are exactly the thing that must stay live.
 */
export function isolateHandlers(
  feature: GameFeature,
  onFailure: HandlerFailureReporter,
): GameFeature {
  if (feature.eventHandlers === undefined) {
    return feature;
  }
  return {
    ...feature,
    eventHandlers: feature.eventHandlers.map((handler) => boundary(feature.id, handler, onFailure)),
  };
}

function boundary(
  featureId: string,
  handler: EventHandler,
  onFailure: HandlerFailureReporter,
): EventHandler {
  return {
    on: handler.on,
    async handle(event, context) {
      try {
        // Awaited, so a handler that returns a rejected promise is caught here
        // rather than escaping as an unhandled rejection — which is a different
        // failure with a different trace and none of the context below.
        await handler.handle(event, context);
      } catch (cause) {
        report(onFailure, { featureId, eventType: handler.on, cause });
      }
    },
  };
}

/**
 * Calls the reporter, and survives it.
 *
 * The reporter is the last thing standing between a throw and the handlers
 * after it, so a reporter that itself throws reintroduces the exact bug this
 * file removes — one bad call at the moment of failure stops every consumer
 * after it, and the failure being reported is the cause. It is also the shape
 * a mistake is most likely to take here, because a reporter is the one piece
 * of this that touches the database or the log.
 *
 * A swallowed reporter failure is not silent in the way the original was: the
 * runtime continues, which is the part that matters, and the reporter's own
 * throw is a bug in the operator's code rather than in a feature's handler.
 */
function report(onFailure: HandlerFailureReporter, failure: HandlerFailure): void {
  try {
    onFailure(failure);
  } catch {
    // Deliberate, and the comment above is the reason. There is nowhere left to
    // report this to.
  }
}
