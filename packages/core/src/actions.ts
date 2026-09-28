import type { ActionDef, RuntimeContext } from './contracts.js';

/**
 * Dotted, lowercase, at least two segments: "quest.claim", "battle.accept".
 *
 * The dotted minimum is not decoration. A bare "claim" collides the moment two
 * features each have one, and the collision surfaces at dispatch time as one
 * feature silently answering for another. Requiring the namespace here means
 * the mistake is a rejected declaration instead.
 */
export const ACTION_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

/**
 * The one rule for every namespaced identifier in this package.
 *
 * An action id, a capability name and a hook provider id are all
 * `namespace.thing`, lower-case, and all exist for the same reason: a bare `claim`
 * or a bare `claude` collides the day two things have one, and the collision
 * surfaces as one thing silently answering for another.
 *
 * These were three regexes that had drifted — the provider one allowed a hyphen
 * in a later segment and the other two did not — so `vendor.some-cli` was a valid
 * provider and an invalid action, and a comment in each file insisted they were
 * the same rule. One pattern, so they cannot disagree again.
 */
export const NAMESPACED_ID_PATTERN = ACTION_ID_PATTERN;

/**
 * Declares one typed action and rejects the two ways the action registry goes
 * wrong in practice.
 *
 * Every action a CLI verb or an MCP tool calls is built here, so this is the
 * single point where a malformed action is caught: at authoring time, by the
 * feature author, with a message naming the offending id.
 */
export function defineAction<I, O>(definition: {
  readonly id: string;
  readonly permissions: readonly string[];
  /**
   * What this action does, in a sentence a caller can act on.
   *
   * It was missing here while `ActionDef` has it, so TypeScript REJECTED it at
   * every call site and the descriptions feature authors wrote could not be
   * written at all. The registry goes out of its way to carry the field; the one
   * function every action is declared through threw it away at the door.
   */
  readonly description?: string | undefined;
  run(input: I, context: RuntimeContext): Promise<O>;
}): ActionDef<I, O> {
  if (!ACTION_ID_PATTERN.test(definition.id)) {
    throw new Error(
      `action id must be dotted, lowercase and have at least two segments, got "${definition.id}"`,
    );
  }
  if (definition.permissions.length === 0) {
    // An action nobody can be granted is an action nobody can authorise, which
    // would otherwise look like a working feature that is simply never called.
    throw new Error(`action ${definition.id} declares no permissions`);
  }
  return definition;
}
