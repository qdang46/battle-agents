import { defineAction } from '@battle-agents/core';
import { isRegisteredActionId } from '@battle-agents/protocol';
import type { RegisteredActionId } from '@battle-agents/protocol';
import type { ActionSummary, Capability, EventBus, GameEvent, Runtime } from '@battle-agents/core';

/**
 * The application API: the single definition of what an agent can do.
 *
 * CLI, HTTP and MCP are three consumers of this and nothing else. They are
 * adapters over the same five primitives, so a feature is reachable from all
 * three because the three of them reach the same place — not because somebody
 * remembered to add it to each.
 *
 * The surface is frozen at five. The pressure to add a sixth, or to promote one
 * domain operation to a first-class tool because somebody asked for it, arrives
 * early and repeatedly; the answer is that the operation already exists in the
 * registry and promoting it means every later feature will ask the same. The
 * primitives grow the game's reach without growing what a client has to read.
 */

/** discover, search, inspect, act, observe. Adding a sixth is a breaking change. */
export const PRIMITIVES = ['discover', 'search', 'inspect', 'act', 'observe'] as const;

export type Primitive = (typeof PRIMITIVES)[number];

/** What `discover([domain?])` returns: domains, or one domain's contents. */
export interface Discovery {
  /** Present when no domain was named: the top-level names and nothing else. */
  readonly domains?: readonly string[];
  /** Present when a domain was named. */
  readonly detail?: DomainDetail;
}

export interface DomainDetail {
  readonly capabilities: readonly Capability[];
  readonly actions: readonly ActionSummary[];
}

export interface SearchQuery {
  /** Which kind of thing to look for. Domains are the only kind today. */
  readonly type: string;
  /** A substring of the name, case-insensitive. */
  readonly name?: string;
}

export interface SearchResult {
  readonly id: string;
  readonly name: string;
}

export interface InspectQuery {
  readonly type: string;
  readonly id: string;
}

export interface ObserveQuery {
  /** A domain to watch, or every domain when omitted. */
  readonly domain?: string;
}

export interface Observer {
  /** Stops the subscription. Idempotent, so a double close is not an error. */
  close(): void;
}

export interface ApplicationApi {
  /**
   * The four that do work are async, including the two that could be
   * synchronous. `observe` is the exception and says so on its own.
   *
   * discover and search were declared sync because the first implementation
   * held the object in the same heap. That made the interface un-implementable
   * by anything else: an HTTP client cannot answer without awaiting, and the
   * CLI had no client because of it. An interface named for a surface that
   * only one process can provide is not a surface.
   *
   * The in-process implementation is async for the same reason; TypeScript
   * does not let a function returning T stand in for one returning
   * Promise<T>, so leaving it synchronous would have been a second, subtler
   * version of the same problem.
   */
  discover(domain?: string): Promise<Discovery>;
  search(query: SearchQuery): Promise<readonly SearchResult[]>;
  inspect(query: InspectQuery): Promise<unknown>;
  /**
   * Run a registered action.
   *
   * The id is the generated union rather than `string`, so a misspelled one is
   * a compile error instead of a runtime surprise. A caller holding a string
   * that is only known at runtime narrows it FIRST with `isRegisteredActionId`
   * from the protocol package and calls this like any other — which is why
   * there is no second, string-taking overload. One accepting `string` would
   * resolve every bogus-id call through it, and the guarantee would stop
   * existing with nothing failing to build.
   *
   * The payload is still `unknown` in both directions: each feature has to
   * declare its own input and output shapes before those can be checked too,
   * and pretending otherwise would be a guarantee the code does not give.
   */
  act<I>(action: RegisteredActionId, input: I): Promise<unknown>;
  /**
   * The one method that is not async, and deliberately so.
   *
   * There is no work here to await: it registers a listener and hands back the
   * handle that stops it. Returning `Promise<Observer>` would mean every
   * surface awaited a value it already had synchronously, and the handle is
   * only useful if the caller can hold it and close it whenever it likes.
   */
  observe(query: ObserveQuery, listener: (event: unknown) => void): Observer;
}

/**
 * A caller could not be authenticated.
 *
 * Declared here rather than imported from whichever feature issues credentials,
 * because the HTTP surface has to recognise this failure and must not depend on
 * the agent feature to do it: an interface that imports a feature stops being
 * able to outlive one, and the removal test is right to fail. The agent
 * feature satisfies this shape structurally.
 */
export interface AuthenticationFailure extends Error {
  readonly reason: string;
}

export function isAuthenticationFailure(error: unknown): error is AuthenticationFailure {
  return error instanceof Error && typeof (error as { reason?: unknown }).reason === 'string';
}

/** Thrown when an action id names nothing in the registry. */
export class UnknownActionError extends Error {
  readonly action: string;
  readonly availableDomains: readonly string[];

  constructor(action: string, availableDomains: readonly string[]) {
    // Names the domains rather than dumping every id: an agent that guessed
    // "quest.submit" needs to know that "quest" exists, not that the registry
    // has ninety entries. `discover` is one call away for the full list.
    super(
      `unknown action "${action}"; known domains: ${availableDomains.join(', ') || 'none'}. ` +
        'Call discover() to see what is available.',
    );
    this.name = 'UnknownActionError';
    this.action = action;
    this.availableDomains = availableDomains;
  }
}

/** Thrown when a domain names nothing in the registry. */
export class UnknownDomainError extends Error {
  readonly domain: string;
  readonly availableDomains: readonly string[];

  constructor(domain: string, availableDomains: readonly string[]) {
    super(`unknown domain "${domain}"; known domains: ${availableDomains.join(', ') || 'none'}`);
    this.name = 'UnknownDomainError';
    this.domain = domain;
    this.availableDomains = availableDomains;
  }
}

/**
 * Builds the API over a runtime.
 *
 * Deliberately thin. Every method here either reads the registry or calls
 * through it; none of them decides anything about the game, because a decision
 * made here is a decision the CLI and the HTTP route and the MCP tool would all
 * have to make identically, and they would not.
 */
export function createApplicationApi(runtime: Runtime, bus?: EventBus): ApplicationApi {
  return {
    async discover(domain?: string): Promise<Discovery> {
      if (domain === undefined) {
        return { domains: runtime.domains() };
      }
      assertKnownDomain(runtime, domain);
      const detail = runtime.describeDomain(domain);
      return { detail: { capabilities: detail.capabilities, actions: detail.actions } };
    },

    async search(query: SearchQuery): Promise<readonly SearchResult[]> {
      // Search is a name lookup over the catalog, so it never reaches a store
      // and never depends on a feature existing yet.
      const detail = runtime.describeDomain(query.type);
      const needle = query.name?.toLowerCase();
      return detail.actions
        .filter((action) => needle === undefined || action.id.toLowerCase().includes(needle))
        .map((action) => ({ id: action.id, name: action.id.split('.')[1] ?? action.id }));
    },

    async inspect(query: InspectQuery): Promise<unknown> {
      // This describes. It does not run. The earlier implementation called
      // runAction, which meant a surface advertised as "describe one
      // operation" could mutate durable state: an audit drove a counter action
      // from 1 to 2 through two inspect calls, and inspecting quest.create
      // entered the create path and threw inside it. A read that writes is not
      // a read, whatever the tool description says.
      //
      // So the answer comes from the registry's own catalogue. An action that
      // declares no description is reported as undescribed, which is honest;
      // inventing prose here would be a description nobody wrote.
      const actionId = `${query.type}.${query.id}`;
      const summary = runtime
        .describeDomain(query.type)
        .actions.find((action) => action.id === actionId);
      if (summary === undefined) {
        return { action: actionId, found: false };
      }
      return {
        action: actionId,
        found: true,
        description: summary.description ?? null,
        permissions: summary.permissions,
      };
    },

    async act<I>(action: string, input: I): Promise<unknown> {
      // The registry, not the generated list, is the authority: the generated
      // union describes the BUILD, and a host can compose a different set of
      // features at runtime. Checking both would reject an action that is
      // genuinely installed.
      if (!isRegisteredActionId(action) || !runtime.actions().includes(action)) {
        throw new UnknownActionError(action, runtime.domains());
      }
      // Every registered action in this build takes an object, and `I` is
      // inferred from the CALL SITE rather than checked against the action, so
      // `act('progression.read')` and `act('progression.read', 'agent-1')` both
      // compile. Dispatching those reached a feature reading a field off a
      // string, and the resulting error named a field rather than the mistake.
      //
      // This is the shape of a command payload, which is the API's business,
      // not a game rule — it is why it belongs here rather than in each feature.
      // Which FIELDS an action needs is still each feature's to check, and
      // quest.create had to be taught to reject a draft rather than read
      // `title.trim()` off one. This guard is the floor under every action, not
      // a replacement for the per-feature one.
      if (typeof input !== 'object' || input === null) {
        throw Object.assign(
          new Error(
            `${action} takes an object; received ${input === null ? 'null' : typeof input}.`,
          ),
          { code: 'malformed-input' },
        );
      }
      return runtime.runAction<I, unknown>(action, input);
    },

    observe(query: ObserveQuery, listener: (event: unknown) => void): Observer {
      // A bus is optional because `Runtime` deliberately does not expose one:
      // features get it through `RuntimeContext`, and the composition root holds
      // the other end. Without it there is nothing to subscribe to, and
      // returning a closable no-op keeps a surface from having to special-case
      // "the bus is not wired yet" — the shape that grows into a different code
      // path per surface.
      //
      // This was a permanent no-op that ignored both arguments, and the test
      // suite did not notice because the only observe assertion was that a
      // subscription opens and closes. `observe` is one of the five frozen
      // primitives and was advertised to every agent as a working capability
      // while delivering nothing.
      if (bus === undefined) {
        return { close() {} };
      }
      const unsubscribe = bus.subscribe((event: GameEvent) => {
        if (query.domain === undefined || domainOf(event) === query.domain) {
          listener(event);
        }
      });
      return { close: unsubscribe };
    },
  };
}

/**
 * The domain an event belongs to, taken from the segment before the first dot.
 *
 * The event type is the only place a domain is recorded: `GameEvent` carries
 * `type`, `actorId` and a payload, and a payload is feature-owned, so reading a
 * domain out of it would mean this file knew what each feature puts there. An
 * undotted type (`waiting`) is its own domain, which is the same answer.
 */
function domainOf(event: GameEvent): string {
  const separator = event.type.indexOf('.');
  return separator === -1 ? event.type : event.type.slice(0, separator);
}

function assertKnownDomain(runtime: Runtime, domain: string): void {
  if (!runtime.domains().includes(domain)) {
    throw new UnknownDomainError(domain, runtime.domains());
  }
}

/**
 * Re-exported so a surface building its own typed facade does not have to reach
 * into core for the same constructor the registry uses.
 */
export { defineAction };
