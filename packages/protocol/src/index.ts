/**
 * The whole public surface of `@battle-agents/protocol`, named.
 *
 * WHY THIS FILE LISTS ITS EXPORTS INSTEAD OF RE-EXPORTING THEM. This used to be
 * five `export *` lines, which works and is the thing that made the package
 * undiscoverable: a third party reading the published package — or its
 * `.d.ts`, which said the same five star-exports — could not learn what the SDK
 * offers without opening the modules behind it. For a package whose whole
 * purpose is to be consumed by strangers, "what can I import from here" is the
 * first question, and the barrel is where the answer belongs.
 *
 * The second reason is a gate. `tests/unit/out-of-tree-extension.test.ts` has to
 * decide whether an out-of-tree package's imports name something the barrels
 * actually export, and against a star-export barrel the only way to answer that
 * is to resolve `export *` transitively. That resolver had already failed
 * silently once: it tested the specifier as written, so `export * from
 * './agent-event.js'` was looked for as a file that does not exist on disk
 * (`agent-event.ts` does, and a build is what turns one into the other), every
 * branch was skipped, and the suite was green the whole time. It then missed
 * declaration-form exports as well, so it would have reported a correct import
 * as a name that does not exist. Two assertions had to be added to keep that
 * resolver honest. A flat barrel deletes the whole class of problem instead of
 * paying to supervise it.
 *
 * WHAT THIS FILE THEREFORE COSTS. A name added to a module and forgotten here
 * is invisible to every consumer, which is the failure `export *` cannot have.
 * So the omission is asserted rather than trusted: `tests/unit/protocol-barrel.test.ts`
 * enumerates each module and fails on an export that is not re-exported, and
 * fails on a star-export creeping back in.
 */

/* ── the event vocabulary ── */

export {
  AGENT_EVENT_JSON_SCHEMA_FILE_NAME,
  AGENT_EVENT_JSON_SCHEMA_ID,
  AGENT_EVENT_TYPES,
  agentEventJsonSchema,
  agentEventSchemas,
  AgentEventSchema,
  commandRunEventSchema,
  fileChangedEventSchema,
  fileReadEventSchema,
  fileWriteEventSchema,
  harnessSchema,
  messageReceivedEventSchema,
  messageSentEventSchema,
  permissionRequestedEventSchema,
  promptSubmittedEventSchema,
  serializeAgentEventJsonSchema,
  sessionEndReasonSchema,
  sessionEndedEventSchema,
  sessionHeartbeatEventSchema,
  sessionStartedEventSchema,
  subagentCompletedEventSchema,
  subagentSpawnedEventSchema,
  taskCreatedEventSchema,
  testFailedEventSchema,
  testPassedEventSchema,
  thinkingEventSchema,
  toolCompletedEventSchema,
  toolFailedEventSchema,
  toolStartedEventSchema,
  waitingEventSchema,
} from './agent-event.js';
export type {
  AgentEvent,
  AgentEventType,
  CommandRunEvent,
  FileChangedEvent,
  FileReadEvent,
  FileWriteEvent,
  Harness,
  MessageReceivedEvent,
  MessageSentEvent,
  PermissionRequestedEvent,
  PromptSubmittedEvent,
  SessionEndReason,
  SessionEndedEvent,
  SessionHeartbeatEvent,
  SessionStartedEvent,
  SubagentCompletedEvent,
  SubagentSpawnedEvent,
  TaskCreatedEvent,
  TestFailedEvent,
  TestPassedEvent,
  ThinkingEvent,
  ToolCompletedEvent,
  ToolFailedEvent,
  ToolStartedEvent,
  WaitingEvent,
} from './agent-event.js';

/* ── batching ── */

export { DEFAULT_BATCH_LIMITS, EventBuffer } from './event-buffer.js';
export type { BatchLimits, EventBufferOptions } from './event-buffer.js';

/* ── the way out ── */

export {
  createIngestSender,
  createSessionOpeningSender,
  sayHello,
  HelloRefusedError,
  IngestRefusedError,
  type HelloOptions,
  type HelloResult,
  type SessionOpeningOptions,
  type SessionOpeningSender,
} from './ingest.js';
export type {
  FetchLike,
  HttpRequestInit,
  HttpResponseLike,
  IngestOptions,
  IngestSender,
} from './ingest.js';

/* ── tool names ── */

export {
  FILE_READ_TOOLS,
  FILE_WRITE_TOOLS,
  getZoneForTool,
  normalizeToolInput,
  normalizeToolName,
  TOOL_NAME_MAP,
  TOOL_ZONE_MAP,
} from './tool-map.js';
export type { ZoneId } from './tool-map.js';

export { DEFAULT_SESSION_RESUME_GRACE_MS } from './session-limits.js';

// The GAME event names, in one place a removable feature cannot take with it.
// Listed rather than star-exported, and the listing is the load-bearing part:
// `GAME_EVENT_NAMES` is what a check compares a feature's spelling against, so
// a name added to event-names.ts and forgotten here is invisible to the check
// that exists to catch exactly that.
export {
  ACHIEVEMENT_EVENTS,
  AGENT_EVENTS,
  BATTLE_EVENTS,
  BOUNTY_EVENTS,
  GUILD_EVENTS,
  GAME_EVENT_NAMES,
  PULL_REQUEST_MERGED,
  PULL_REQUEST_MERGED_OUTCOME,
  QUEST_EVENTS,
  SESSION_EVENTS,
  SOCIAL_EVENTS,
  WORLD_EVENTS,
} from './event-names.js';

export { PROTOCOL_VERSION, protocolVersionSchema } from './version.js';

// The extension contract version, which is not the protocol version. Listed
// apart from the event vocabulary above because importing it without the
// distinction in mind is how a reader ends up treating an AgentEvent batch and a
// GameFeature package as one versioned thing. The comment in the file says so;
// this is here so the intent survives someone reading only the barrel.
export {
  assertExtensionContract,
  assertExtensionContracts,
  EXTENSION_CONTRACT_VERSION,
  ExtensionContractMismatch,
  isExtensionContractCompatible,
} from './extension-contract.js';
export type { ExtensionContract } from './extension-contract.js';

// The per-feature action id unions, each of which `RegisteredActionId` is
// built from. `BattleActionId`, `SocialActionId` and `AchievementsActionId`
// were missing from here when this barrel was flattened, because the previous
// one listed these names by hand and three features landed after it was
// written. A third party dispatching a battle action had the union to check
// against and no way to name the subset it belonged to, which is the whole
// reason the per-feature unions exist.
export type {
  AchievementsActionId,
  AgentActionId,
  AnimationActionId,
  BattleActionId,
  BountyActionId,
  GuildActionId,
  ProgressionActionId,
  QuestActionId,
  RegisteredActionId,
  ReputationActionId,
  SocialActionId,
  WorldActionId,
} from './generated/action-ids.js';
export { isRegisteredActionId, REGISTERED_ACTION_IDS } from './generated/action-ids.js';
