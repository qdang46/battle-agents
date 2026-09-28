import type { Command } from './command.js';
import type {
  EventBus,
  GameFeature,
  Logger,
  Runtime,
  RuntimeContext,
  StateStore,
} from './contracts.js';
import type { GameEvent } from './event.js';
import { isPersistedEventType } from './persistence.js';
import { FeatureRegistry } from './registry.js';

export interface RuntimeOptions {
  readonly extensions: readonly GameFeature[];
  readonly store: StateStore;
  readonly bus: EventBus;
  readonly log?: Logger;
  /** Injectable so tests can assert on ordering without sleeping. */
  readonly now?: () => string;
}

const systemClock = (): string => new Date().toISOString();

/**
 * Builds a runtime from an explicit list of features.
 *
 * The list is the whole loading story. There is no plugin scan, no directory
 * walk and no remote loader, and that is the point: an extension set you can
 * read in one line is an extension set you can reason about, and the removal
 * test depends on there being no hidden source of features.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const registry = new FeatureRegistry();
  const now = options.now ?? systemClock;
  let degraded = new Map<string, readonly string[]>();

  // Assigned below, and read through a getter rather than captured by value:
  // an object literal would copy the current value (undefined) into the context
  // once and never see the assignment, so every feature that touched
  // ctx.runtime would get undefined. No handler can run before this function
  // returns, so by the time anything reads it the reference is live.
  let runtime: Runtime;
  const context: RuntimeContext = {
    get runtime() {
      return runtime;
    },
    store: options.store,
    bus: options.bus,
    now,
    // Conditional rather than `log: options.log`, because with
    // exactOptionalPropertyTypes an explicit undefined is not the same as
    // absent, and a feature can tell "no logger" from "a logger that throws".
    ...(options.log === undefined ? {} : { log: options.log }),
  };

  function revalidate(): void {
    const missing = registry.missingRequirements();
    // Frozen, and not just copied on the way out. `degraded()` hands back a
    // fresh Map, which reads as isolated; but a Map copy shares the arrays it
    // points at, so a caller that pushed into one would silently change what
    // the next reader sees. Freezing makes the read-only claim true.
    degraded = new Map(
      [...missing].map(([featureId, unmet]) => [featureId, Object.freeze([...unmet])] as const),
    );
    for (const [featureId, unmet] of degraded) {
      options.log?.warn(`[core] feature ${featureId} is degraded, missing: ${unmet.join(', ')}`);
    }
  }

  for (const feature of options.extensions) {
    registry.register(feature);
  }
  revalidate();

  /**
   * The one path every event takes, in a fixed order: decide whether it is
   * worth a row, let features react, then show it to whoever is watching.
   *
   * Persisting first means a handler that throws still leaves the event in the
   * log, so the activity trail records that something was emitted even when the
   * reaction to it failed. Fanning out last means a live viewer never sees an
   * event whose handlers have not run.
   *
   * A throwing handler is not caught. Swallowing it would leave the feature
   * that threw quietly missing state with only a log line to show for it, and
   * the caller is the one who can still act on the failure.
   */
  async function emit(event: GameEvent): Promise<void> {
    if (isPersistedEventType(event.type, registry.persistedEventTypes())) {
      await options.store.append(event);
    }
    for (const handler of registry.handlersFor(event.type)) {
      await handler.handle(event, context);
    }
    options.bus.publish(event);
  }

  runtime = {
    domains: () => registry.domains(),
    // Frozen AND copied, for the same reason degraded() is frozen. Freezing the
    // array alone is not enough: a shallow freeze leaves the feature's own
    // Capability objects reachable, so a caller writing through one — from
    // plain JS, a cast, or a structuredClone boundary — would permanently
    // rewrite the feature's declaration rather than a copy of it.
    describeDomain: (domain) => ({
      capabilities: Object.freeze(
        registry
          .capabilitiesIn(domain)
          .map((capability) =>
            Object.freeze({ name: capability.name, description: capability.description }),
          ),
      ),
      actions: Object.freeze(
        registry
          .actionsIn(domain)
          .map((action) =>
            Object.freeze({
              // Spread, not a re-listing. This named `id` and `permissions` and
              // dropped `description`, which the registry goes out of its way to
              // carry — so every action description a feature author wrote was
              // discarded on the way out, and `inspect` reported "undescribed"
              // for the entire game. Nineteen of them, in guild and social
              // alone, written to be read by whoever is discovering the API.
              //
              // The `permissions` clone stays explicit because it is a mutable
              // array and the copy is meant to be frozen; spreading alone would
              // leave the caller holding the registry's own array.
              ...action,
              permissions: Object.freeze([...action.permissions]),
            }),
          ),
      ),
    }),
    capabilities: () => registry.capabilityNames(),
    actions: () => registry.actionIds(),
    commands: () => registry.commandTypes(),

    degraded: () => new Map(degraded),

    install(feature: GameFeature): void {
      registry.register(feature);
      revalidate();
    },

    uninstall(id: string): void {
      registry.unregister(id);
      revalidate();
    },

    /**
     * A command handler returns a list of events, and emitting the second can
     * fail after the first has already been applied. The list is therefore
     * attached to the failure rather than discarded: a caller that retries on
     * a bare error re-applies everything that already happened, and only the
     * applied list lets it tell a safe retry from a duplicate write.
     */
    async dispatch(command: Command): Promise<GameEvent[]> {
      const handler = registry.commandHandler(command.type);
      if (handler === undefined) {
        throw new Error(`unknown command ${command.type}`);
      }
      const events = await handler.handle(command, context);
      const applied: GameEvent[] = [];
      for (const event of events) {
        try {
          await emit(event);
        } catch (cause) {
          throw new PartialDispatchError(command.type, applied, cause);
        }
        applied.push(event);
      }
      return events;
    },

    emit,

    async runAction<I, O>(id: string, input: I): Promise<O> {
      const action = registry.action(id) as ActionDefLike<I, O> | undefined;
      if (action === undefined) {
        throw new Error(`unknown action ${id}`);
      }
      return action.run(input, context);
    },
  };

  return runtime;
}

/**
 * What `runAction` casts a registry entry to.
 *
 * This cast is where the type safety the action registry is supposed to provide
 * stops, and the boundary is easy to overstate, so it is worth being exact.
 *
 * What survives: `defineAction` is typed where an action is WRITTEN, so a
 * feature's own action has a checked input and output.
 *
 * What does not: at this call site the caller supplies both I and O. With no
 * contextual type the result is `unknown`; with one it is whatever the caller
 * wrote, believed rather than checked. A misspelled action id, a wrong input
 * shape and a wrong expected output all compile clean and all fail at runtime.
 * Measured with a probe, and pinned as a compile-time fact in
 * tests/types/core-actions.ts so it cannot be quietly forgotten.
 *
 * Closing that gap needs a codegen step that emits a union of every registered
 * id with its input and output. It cannot be fixed with a cast or a generic,
 * because the set of registered actions is decided at runtime by independently
 * built packages, and no type the compiler can see is a function of it.
 */
type ActionDefLike<I, O> = {
  run(input: I, context: RuntimeContext): Promise<O>;
};

/**
 * Thrown when a command's events were only partly applied because one of them
 * failed to emit.
 *
 * `applied` is what makes this recoverable: it is the prefix that reached the
 * store and the handlers, so a caller can decide whether retrying the whole
 * command would duplicate work. The failing event is deliberately absent — it
 * may have been persisted before its handler threw, so whether to repeat it is
 * a question about that event, not something this error can answer.
 */
export class PartialDispatchError extends Error {
  readonly commandType: string;
  readonly applied: readonly GameEvent[];

  constructor(commandType: string, applied: readonly GameEvent[], cause: unknown) {
    super(
      `command ${commandType} applied ${applied.length} event(s) before failing; ` +
        'the rest were not applied',
      { cause },
    );
    this.name = 'PartialDispatchError';
    this.commandType = commandType;
    this.applied = Object.freeze([...applied]);
  }
}
