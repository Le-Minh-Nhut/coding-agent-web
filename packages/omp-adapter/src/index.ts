export * from "./types.js";
export * from "./errors.js";
export * from "./capabilities.js";
export * from "./session-catalog.js";
export * from "./session-lease.js";
export * from "./tmux.js";
export * from "./collab-registry.js";
export * from "./model-catalog.js";

export { DefaultCapabilityService, parseOmpVersion, parseTmuxVersion } from "./capabilities.js";
export type { CapabilityOptions } from "./capabilities.js";

export {
  DefaultNativeSessionCatalog,
  encodeSessionDirName,
  SESSION_HEADER_PREFIX_BYTES,
  SESSION_HISTORY_MAX_BYTES,
  HANDOFF_EVIDENCE_MAX_BYTES,
  SESSION_HISTORY_MAX_ENTRIES,
} from "./session-catalog.js";
export type { SessionCatalogOptions } from "./session-catalog.js";

export {
  DefaultSessionLeaseProbe,
  xxh64,
  xxh64hex16,
  HIGH_SEED,
  LOW_SEED,
} from "./session-lease.js";
export type { SessionLeaseOptions } from "./session-lease.js";

export { DefaultTmuxService, sanitizeSessionName } from "./tmux.js";
export type { TmuxServiceOptions } from "./tmux.js";

export {
  DefaultCollabRegistryService,
  parseCollabHost,
  parseCollabListOutput,
} from "./collab-registry.js";
export type { CollabRegistryOptions } from "./collab-registry.js";

export { DefaultModelCatalogService, parseOmpModelsOutput } from "./model-catalog.js";
export type { ModelCatalogOptions } from "./model-catalog.js";

export { BridgeClient } from "./bridge/client.js";
export type {
  BridgeClientOptions,
  BridgeModeOutcome,
  BridgeModeResult,
  BridgeModeState,
  BridgeReadResult,
  BridgeState,
} from "./bridge/client.js";
export {
  allocateLoopbackPort,
  BRIDGE_CONFIG_ENV,
  bridgeExtensionPath,
  bridgeConfigPath,
  prepareBridge,
  readBridgeConfig,
} from "./bridge/config.js";
export type { BridgeConfig, PrepareBridgeResult } from "./bridge/config.js";
export {
  AdapterError,
  RegistryUnreadableError,
  StaleGenerationError,
  ToolMissingError,
} from "./errors.js";
