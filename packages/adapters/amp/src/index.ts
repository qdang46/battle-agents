/**
 * The Amp adapter.
 *
 * Added as one subdirectory, from `adapters/_template` and the protocol
 * package's public surface. Nothing under `core/`, `cli/`, `mcp/` or `api/`
 * changed, and `packages/protocol/src/generated/action-ids.ts` did not either:
 * an adapter consumes the frozen event union and does not publish dispatchable
 * actions, so there is nothing for it to add to.
 *
 * `parser.ts`   Amp's records into `AgentEvent`
 * `watcher.ts`  the read, normalise, buffer, post loop
 * `install.ts`  consent gating for a configured harness
 */

export {
  AMP_PROVIDER_ID,
  canonicalToolName,
  parseRecord,
  REQUIRED_EVENT_TYPES,
  type AmpRecord,
  type ParsedLine,
  type RawThreadRef,
} from './parser.js';
export { AmpWatcher, type AmpWatcherOptions, type BatchSender } from './watcher.js';
export {
  AMP_CONSENT,
  applyConsentChoice,
  type ConsentChoice,
  type ConsentDisclosure,
  type InstallerEffects,
  type InstallTarget,
} from './install.js';
