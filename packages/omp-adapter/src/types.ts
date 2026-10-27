/**
 * Integration boundary between the workspace and the OMP runtime.
 *
 * Everything here is expressed in facts we can observe on the machine: native
 * session journals, tmux processes, the local Collab host registry, and the
 * session ownership lease. No type in this file implies a capability we have
 * not verified against a real OMP process.
 */
import type { AttachInstructions, Capabilities, NativeSessionSummary, RuntimeState } from "@caw/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Capability detection
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedBinary {
  available: boolean;
  path: string | null;
  version: string | null;
}

export interface CapabilityProbe {
  omp: ResolvedBinary;
  tmux: ResolvedBinary;
  /** Reason a dependency is unusable, e.g. "omp not found on PATH". */
  notes: string[];
}

export interface CapabilityService {
  /** Cached probe; `refresh` re-reads the machine. */
  probe(refresh?: boolean): Promise<CapabilityProbe>;
  /** Shape handed to the web app. */
  capabilities(refresh?: boolean): Promise<Capabilities>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Available OMP models
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelCatalogService {
  /** Provider-qualified OMP selectors; empty when catalog is empty or unavailable. */
  listModels(): Promise<string[]>;
  /** Distinguishes a confirmed empty catalog from a failed/unsupported discovery. */
  listModelsDetailed(): Promise<{ models: string[]; source: "omp" | "unavailable"; reason: string | null }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Native session catalog
// ─────────────────────────────────────────────────────────────────────────────

/** One line of a native journal's header, as far as we need to understand it. */
export interface NativeSessionHeader {
  sessionId: string;
  cwd: string;
  timestamp: string | null;
  version: number | null;
  /** Title slot text when the journal carries one. */
  title: string | null;
}

export interface NativeSessionHistory {
  header: NativeSessionHeader;
  entries: Array<Record<string, unknown>>;
  truncated: boolean;
  truncatedByBytes: boolean;
  truncatedByEntries: boolean;
  /** True when this page's bounded scan encountered and skipped an oversized journal record. */
  skippedOversized: boolean;
  hasOlder: boolean;
  nextCursor: string | null;
}

export interface NativeSessionCatalog {
  /** Journalled sessions for a working directory, newest first. */
  listForCwd(cwd: string): Promise<Array<Omit<NativeSessionSummary, "hasCollabHost">>>;
  /** Journalled sessions across the whole store, newest first. */
  listAll(limit?: number): Promise<Array<Omit<NativeSessionSummary, "hasCollabHost">>>;
  /** Read one journal's header, or null when it is unreadable or not a session. */
  readHeader(sessionPath: string): Promise<NativeSessionHeader | null>;
  /** Candidate journal paths for a session id (used only inside the adapter). */
  findBySessionId(sessionId: string): Promise<string | null>;
  /** Read one bounded journal page; before is an opaque cursor issued for this session and project. */
  readHistory(sessionId: string, expectedCwd: string, options?: number | { before?: string }): Promise<NativeSessionHistory>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session ownership (the duplicate-writer guard)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Writer-lease probe. A live OMP process binds a Linux abstract Unix socket
 * named `omp-file-lock-<xxh64(lockPath,seed) hex pair>`; a session whose lease
 * name is bound is being written by some process right now.
 */
export interface SessionLeaseProbe {
  /** True when held, false when confirmed free, unknown when the probe failed. */
  isLive(sessionId: string): Promise<boolean | "unknown">;
  /** Bulk form; failures and unsafe ids remain unknown. */
  liveSet(sessionIds: readonly string[]): Promise<Map<string, boolean | "unknown">>;
  /** Lease name for a session id, exposed for tests and diagnostics. */
  leaseName(sessionId: string): string;
}

// ─────────────────────────────────────────────────────────────────────────────
// tmux process ownership
// ─────────────────────────────────────────────────────────────────────────────

export interface TmuxSession {
  /** Stable tmux session id (`$0`, `$12`, …) — only within this server lifetime. */
  id: string;
  name: string;
  createdAt: number | null;
  /** Process id of the pane's shell, when reported. */
  panePid: number | null;
  /** True when the tmux server says the pane's process is still alive. */
  alive: boolean;
  /** Resolved socket path and server start time for this tmux server lifetime. */
  serverIdentity: string;
}

export interface LaunchRequest {
  /** tmux session display name; must be unique and is not an identifier. */
  name: string;
  /** Working directory for the agent. */
  cwd: string;
  /** Environment overlay applied to the launched process (never logged). */
  env?: Record<string, string>;
  /** Overlay config file passed via --config. */
  configPath?: string;
  /** Model override, when the user picked one. */
  model?: string;
  /** Extra args, already validated. */
  args?: string[];
}

export interface TmuxService {
  /** List every session on this service's socket; app ownership comes from its private socket, not session names. */
  listManaged(): Promise<TmuxSession[]>;
  /** Look up one session by id. */
  getById(sessionId: string): Promise<TmuxSession | null>;
  getByName(name: string): Promise<TmuxSession | null>;
  /** True only when candidatePid is the pane process or its descendant. */
  isProcessDescendant(candidatePid: number, panePid: number): Promise<boolean | "unknown">;
  /** Current socket path plus start time and PID; null means socket unreachable, not proof of process exit. */
  serverIdentity(): Promise<string | null>;
  /** Launch a detached session; returns id and owning server identity. */
  launch(request: LaunchRequest): Promise<TmuxSession>;
  /** Last N lines of pane output, for diagnostics only (never parsed for events). */
  capture(sessionId: string, lines?: number): Promise<string>;
  /** Send keys to a session; used only for explicit user-driven actions. */
  sendKeys(sessionId: string, keys: string): Promise<void>;
  /** Rejects unless the expected server was checked and the session is absent/dead afterward. */
  kill(sessionId: string, options?: { expectedIdentity?: string }): Promise<void>;
  /** True when the tmux server itself is reachable. */
  serverUp(): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Collab host registry
// ─────────────────────────────────────────────────────────────────────────────

export interface CollabHostModel {
  provider: string;
  id: string;
}

/**
 * One row of `omp collab list --json`.
 *
 * Missing-field rule for every member below: a missing field means "we do not
 * know", and an unknown must never become a value that can satisfy a caller's
 * comparison. So nothing is filled in with `0`, `1` or `false`; a field is
 * either required in the sense that its absence makes the row unusable, or
 * nullable, in which case absence survives as `null`.
 */
export interface CollabHost {
  /**
   * The host's instance id. Required: it is the name a room is addressed by, so
   * a row without one cannot be matched to a conversation or linked, and is
   * dropped rather than reported under a made-up id.
   */
  instanceId: string;
  /**
   * Room generation as the CLI reported it, or `null` when it did not say.
   *
   * Never defaulted. The mint guard compares the link's generation against this
   * one, so a fabricated `1` made that comparison pass by construction: a link
   * minted for a rotated successor room was handed to the client as if it
   * belonged to the conversation the user opened.
   */
  generation: number | null;
  /** Process id, or `null` when the row did not carry one. Used for ordering only. */
  pid: number | null;
  /**
   * The native session this room serves. Required: it is the only link between a
   * row and a conversation, so a row without one says nothing we can act on.
   */
  sessionId: string;
  /** Display-only name; absent means the room has none, which is already `null`. */
  sessionName: string | null;
  /** Working directory. Required: it is how a row is tied to a project on disk. */
  cwd: string;
  /** Model label, or `null` when the row did not report one. Display only. */
  model: CollabHostModel | null;
  /** Start time, or `null` when the row did not report one. Display only. */
  startedAt: number | null;
  /**
   * Participant count, or `null` when the row did not say. `0` is a real value
   * (an empty room), so absence must stay distinguishable from it.
   */
  participants: number | null;
  /**
   * Whether the host is connected to the relay, or `null` when the row did not
   * say. Web viewing depends on this, and `false` is a positive fact about a
   * live room, so the two must not collapse into one another.
   */
  relayConnected: boolean | null;
  /**
   * Whether the host is waiting for an answer, or `null` when the row did not
   * say. Read as awaiting-input evidence only when explicitly `true`; treating
   * an absent field as `true` would claim a question that may not exist.
   */
  inputRequired: boolean | null;
  /**
   * A turn is in flight. `null` when the host is older than the field, and
   * `false` does NOT mean the session's work is finished — OMP reads false
   * during scheduling pauses too.
   */
  busy: boolean | null;
  /** Host-published capability ceiling; absent or invalid stays unknown. */
  access: "view" | "control" | null;
}

export interface CollabLink {
  /**
   * The host the room actually belongs to, or `null` when the CLI response did
   * not say. Never inferred: an invented id makes an identity comparison pass by
   * construction, so a link minted for a successor room after a session switch
   * would be handed out as if it belonged to the observed one.
   */
  instanceId: string | null;
  /** The room generation the CLI reported, or `null` when it did not say. */
  generation: number | null;
  access: "view" | "control";
  url: string;
  /** Epoch ms when the server received it; links are short-lived. */
  fetchedAt: number;
}

export interface CollabRegistryService {
  /** Live hosts on this machine. Throws when the registry is unreadable. */
  list(): Promise<CollabHost[]>;
  /** The host serving a given native session, if any. */
  findBySessionId(sessionId: string): Promise<CollabHost | null>;
  /** Mint a browser link for a host at the generation observed while listing. */
  link(instanceId: string, access: "control" | "view"): Promise<CollabLink>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Relay
// ─────────────────────────────────────────────────────────────────────────────

export interface RelayConfig {
  /** Port to listen on; bound to loopback unless an explicit override is set. */
  port: number;
  host?: string;
  /** Origin allowed to open guest sockets; omitted means "no browser clients". */
  allowedOrigin?: string;
}

export interface RelayStatus {
  listening: boolean;
  port: number;
  host: string;
  rooms: number;
  guests: number;
}

/** Private Collab relay: serves the browser client and the room endpoint. */
export interface RelayService {
  start(): Promise<RelayStatus>;
  stop(): Promise<void>;
  status(): RelayStatus;
}
