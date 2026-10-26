#!/usr/bin/env node
/**
 * Server process: composition root for Coding Agent Web.
 *
 * Everything that touches the outside world is constructed here and injected
 * downward, so the HTTP layer, the supervisor and the adapters stay testable in
 * isolation. Two things in this file matter more than the rest:
 *
 *  1. The private relay is started before any agent is launched, and every agent
 *     launched by this process is given an overlay config pointing at it. Without
 *     both halves, an agent runs but cannot be watched.
 *  2. A room link is minted on demand and never stored: it is a bearer
 *     credential, bound to the room generation observed while listing, and handed
 *     to the browser exactly once.
 */
import { createServer } from "node:http";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  DefaultCapabilityService,
  DefaultCollabRegistryService,
  DefaultModelCatalogService,
  DefaultNativeSessionCatalog,
  DefaultSessionLeaseProbe,
  DefaultTmuxService,
  StaleGenerationError,
} from "@caw/omp-adapter";
import { createSupervisor, RuntimeError } from "@caw/runtime";
import { createRelay } from "@caw/relay";
import type { CollabLinkResponse, Conversation, NativeSessionSummary } from "@caw/contracts";
import type { NativeSessionHeader } from "@caw/omp-adapter";
import { loadConfig } from "./config.js";
import { createAuthenticationService } from "./auth.js";
import { buildApp } from "./app.js";
import { WorkspacePathPolicy } from "./path-policy.js";
import { redactLogValue } from "./logger.js";
import { createMetadataStore } from "./store.js";

export function renderOverlay(port: number, webUrl?: string): string {
  const lines = ["collab:", "  autoStart: control", `  relayUrl: ws://127.0.0.1:${port}`];
  if (webUrl) {
    lines.push(`  webUrl: ${webUrl}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeOverlay(overlayDir: string, conversationId: string, port: number, webUrl?: string): Promise<string> {
  const path = join(overlayDir, `${conversationId.replace(/[^a-zA-Z0-9-]/g, "")}.yml`);
  await writeFile(path, renderOverlay(port, webUrl), { mode: 0o600 });
  return path;
}

export async function launchWithOverlay<T>(
  input: { overlayDir: string; conversationId: string; configPath?: string; relayPort: number; webUrl?: string },
  launch: (configPath: string) => Promise<T>,
  write: typeof writeOverlay = writeOverlay,
): Promise<T> {
  let configPath = input.configPath;
  if (!configPath) {
    try {
      configPath = await write(input.overlayDir, input.conversationId, input.relayPort, input.webUrl);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "unknown";
      throw new RuntimeError("agent_launch_failed", `Could not write the agent overlay required for Collab hosting (${code}).`);
    }
  }
  return launch(configPath);
}

export function createRuntimeSpec(deps: {
  store: { listProjects: () => Promise<Array<{ id: string; path: string }>> };
  paths: { assertInsideRoots: (path: string, mustExist?: boolean) => Promise<string> };
  catalog: {
    findBySessionId: (sessionId: string) => Promise<string | null>;
    readHeader: (path: string) => Promise<NativeSessionHeader | null>;
  };
}) {
  return async (conversation: Conversation, input: { resumeSessionId?: string; model?: string }) => {
    const project = (await deps.store.listProjects()).find((item) => item.id === conversation.projectId);
    if (!project) throw new Error("Conversation project not found");
    const cwd = await deps.paths.assertInsideRoots(project.path, true);

    let resumeSessionPath: string | undefined;
    if (input.resumeSessionId) {
      resumeSessionPath = await deps.catalog.findBySessionId(input.resumeSessionId) ?? undefined;
      if (!resumeSessionPath) {
        throw Object.assign(new Error("Requested native session journal was not found"), { code: "not_found" });
      }
      let header: NativeSessionHeader | null;
      try {
        header = await deps.catalog.readHeader(resumeSessionPath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          throw Object.assign(new Error("Requested native session journal was not found"), { code: "not_found" });
        }
        throw error;
      }
      if (!header) {
        throw Object.assign(new Error("Requested native session journal was not found"), { code: "not_found" });
      }
      if (
        header.sessionId !== input.resumeSessionId ||
        (await deps.paths.assertInsideRoots(header.cwd, true)) !== cwd
      ) {
        throw Object.assign(new Error("Requested native session journal does not belong to this project"), { code: "path_forbidden" });
      }
    }

    const shortId = conversation.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "conv";
    const baseTitle = conversation.title?.trim();
    const name = baseTitle ? `${baseTitle}-${shortId}` : `conversation-${shortId}`;

    return {
      conversationId: conversation.id,
      name,
      cwd,
      model: input.model,
      resumeSessionPath,
    };
  };
}


/**
 * A room path: `/r/<roomId>.<base64url secret>`. The room id is 10–64 base64url
 * characters; the secret is the base64url of either a 32-byte view key or a
 * 48-byte key+write-token, which is 43 or 64 characters with no padding.
 */
const ROOM_LINK_PATH_RE = /^\/r\/[A-Za-z0-9_-]{10,64}\.[A-Za-z0-9_-]{43,64}$/;

/** Base64url text lengths that decode to a valid room secret. */
const VALID_SECRET_LENGTHS: Record<number, true> = { 43: true, 64: true };

/**
 * Validate that a string is a room link path we are willing to hand to a browser.
 *
 * Beyond matching the shape, this rejects anything that could have been silently
 * normalized: the URL parser folds dot segments (`/r/../x`), removes default
 * ports, and lowercases the scheme, so a value that does not survive a
 * parse-and-reprint unchanged is not something we can reason about. Rejecting is
 * cheap here; accepting a rewritten path is how a link ends up pointing somewhere
 * the caller did not intend.
 */
function assertRoomPath(pathname: string): void {
  // Check the shape and the secret length separately, so the error names the real
  // problem: a wrong-length key must not be reported as "not a room link".
  const parts = /^\/r\/([A-Za-z0-9_-]{10,64})\.([A-Za-z0-9_-]+)$/.exec(pathname);
  if (!parts) {
    throw new Error(`Collab link path does not match /r/<roomId>.<key>: ${pathname}`);
  }
  const secret = parts[2]!;
  if (VALID_SECRET_LENGTHS[secret.length] !== true) {
    throw new Error(`Collab link secret must be 43 (view) or 64 (full) base64url characters, got ${secret.length}`);
  }
}

/** Schemes OMP actually uses for a relay link. `http`/`https` deep links are handled by the caller. */
function assertRelayScheme(protocol: string): void {
  if (protocol !== "ws:" && protocol !== "wss:") {
    throw new Error(`Collab link must use ws:// or wss://, got ${protocol}`);
  }
}

export function rewriteCollabLink(rawUrl: string, publicOrigin: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Cannot parse collab link: ${rawUrl}`);
  }

  let rewritten: string;

  if (url.hash && url.hash.length > 1) {
    // Deep link format: <webUrl>/#<relayLink>.
    //
    // The outer URL is the page the phone opens, so it must be http or https. An
    // arbitrary scheme here means we were handed something that is not a web page
    // link at all, and rewriting it would produce a URL whose meaning we cannot
    // vouch for — so it is refused rather than normalized.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Deep link must point at an http(s) page, got ${url.protocol}`);
    }
    // An outer query string is refused rather than dropped: rewriting the origin
    // while silently discarding part of the input would hand back a link that
    // differs from the one we were given in ways the caller cannot see.
    if (url.search) {
      throw new Error(`Collab link must not carry a query string: ${url.search}`);
    }
    const fragmentContent = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    let innerUrl: URL;
    try {
      innerUrl = new URL(fragmentContent.includes("://") ? fragmentContent : `ws://${fragmentContent}`);
    } catch {
      throw new Error(`Cannot parse collab link fragment: ${fragmentContent}`);
    }

    // The inner value is the relay link, so it must be a websocket URL; a legacy
    // https form would be re-parsed differently and is not what OMP emits.
    assertRelayScheme(innerUrl.protocol);
    assertRoomPath(innerUrl.pathname);
    if (innerUrl.search) {
      throw new Error(`Collab link must not carry a query string: ${innerUrl.search}`);
    }

    const publicUrl = new URL(publicOrigin);
    const wsScheme = publicUrl.protocol === "https:" ? "wss:" : "ws:";
    const publicWsOrigin = `${wsScheme}//${publicUrl.host}`;
    const rewrittenFragment = `#${publicWsOrigin}${innerUrl.pathname}`;
    rewritten = `${publicOrigin}/${rewrittenFragment}`;

    const verifiedOuter = new URL(rewritten);
    const verifiedInner = new URL(verifiedOuter.hash.slice(1));
    if (verifiedInner.pathname !== innerUrl.pathname) {
      throw new Error(`Rewritten path ${verifiedInner.pathname} does not match original path ${innerUrl.pathname}`);
    }
  } else {
    // Direct link format: <relayOrigin>/r/<roomId>.<secret>
    assertRelayScheme(url.protocol);
    assertRoomPath(url.pathname);

    // Preserve the query deliberately: OMP's own direct form carries none, so a
    // present one means we are looking at something we do not understand.
    if (url.search) {
      throw new Error(`Collab link must not carry a query string: ${url.search}`);
    }

    // The phone reaches the app origin, not the relay's own listener, so a direct
    // relay link becomes a deep link: `<publicOrigin>/#<relayLink>`. Keeping the
    // room path in the *fragment* is what puts the credential in the one part of a
    // URL that is never sent to a server.
    const publicUrl = new URL(publicOrigin);
    const wsScheme = publicUrl.protocol === "https:" ? "wss:" : "ws:";
    const publicWsOrigin = `${wsScheme}//${publicUrl.host}`;
    rewritten = `${publicOrigin}/#${publicWsOrigin}${url.pathname}`;

    const verifiedOuter = new URL(rewritten);
    const verifiedInner = new URL(verifiedOuter.hash.slice(1));
    if (verifiedInner.pathname !== url.pathname) {
      throw new Error(`Rewritten path ${verifiedInner.pathname} does not match original path ${url.pathname}`);
    }
  }

  return rewritten;
}
export function createMintLink(
  registry: {
    /**
     * `relayConnected` is `null` when the host did not report it. Absence must not
     * read as "connected", so the mint below refuses an unreported value rather
     * than treating it as good news.
     */
    list: () => Promise<Array<{ sessionId: string; instanceId: string | null; generation: number | null; relayConnected: boolean | null; access?: "control" | "view" | null }>>;
    link: (instanceId: string, access: "control" | "view") => Promise<{ instanceId?: string | null; generation?: number | null; access: "control" | "view"; url: string }>;
  },
  publicOriginOrOptions?: string | { publicOrigin?: string },
) {
  const publicOrigin = typeof publicOriginOrOptions === "string"
    ? publicOriginOrOptions
    : publicOriginOrOptions?.publicOrigin;
  return async (conversation: Conversation, access: "control" | "view"): Promise<CollabLinkResponse> => {
    if (!conversation.nativeSessionId) {
      throw Object.assign(new Error("No native session for this conversation yet"), { code: "link_unavailable" });
    }
    const hosts = await registry.list();
    const host = hosts.find((row) => row.sessionId === conversation.nativeSessionId);
    // `relayConnected` is refused when it is not exactly `true`: an unreported value
    // means we cannot tell whether a room exists, and handing out a link to a room
    // that may not exist would strand the phone on a dead socket.
    if (!host || host.relayConnected !== true) {
      throw Object.assign(new Error("This session is not hosting a live room"), { code: "link_unavailable" });
    }
    // Never infer an omitted or invalid published capability: only explicit host policy can authorize a bearer link.
    if (host.access !== "control" && host.access !== "view") {
      throw Object.assign(new Error(`This host's access is unknown; ${access} access was requested.`), { code: "capability_missing" });
    }
    if (access === "control" && host.access !== "control") {
      throw Object.assign(new Error(`This host offers ${host.access} access; control access was requested.`), { code: "capability_missing" });
    }
    if (host.instanceId == null || host.generation == null) {
      throw new StaleGenerationError("Collab host identity or generation is unavailable");
    }
    const link = await registry.link(host.instanceId, access);
    if (link.access !== access) {
      throw Object.assign(new Error(`The host did not confirm the requested ${access} access; refusing to return an unverified link.`), { code: "capability_missing" });
    }
    // Missing CLI identity fields are evidence gaps, not matching defaults.
    if (link.instanceId == null || link.generation == null || link.instanceId !== host.instanceId || link.generation !== host.generation) {
      throw new StaleGenerationError(
        `Collab host generation or instance changed while minting link: expected instance ${host.instanceId} gen ${host.generation}, got ${link.instanceId} gen ${link.generation}`,
        {
          expectedInstanceId: host.instanceId,
          expectedGeneration: host.generation,
          actualInstanceId: link.instanceId,
          actualGeneration: link.generation,
        },
      );
    }
    const url = publicOrigin ? rewriteCollabLink(link.url, publicOrigin) : link.url;
    return {
      url,
      access: link.access === "view" ? "view" : "full",
      instanceId: link.instanceId,
      generation: link.generation,
    };
  };
}


export async function startServer() {
  const config = await loadConfig();

// ── Authentication and metadata ──────────────────────────────────────────────
const auth = createAuthenticationService({
  stateDir: config.stateDir,
  ttlHours: config.authTokenTtlHours,
  insecureCookies: config.insecureCookies,
});
await auth.initAuth();
const store = createMetadataStore(config.stateDir);
await store.listProjects();

// ── Adapters ────────────────────────────────────────────────────────────────
const lease = new DefaultSessionLeaseProbe();
const catalog = new DefaultNativeSessionCatalog({ leaseProbe: lease });
/**
 * tmux server this app owns, addressed by its own socket.
 *
 * Two reasons this is not the default server:
 *
 *  1. The owner's own tmux work stays untouched — we never list, adopt or kill a
 *     session we did not create, and our names cannot collide with theirs.
 *  2. A conversation's recorded tmux session id (`$N`) is only unique within one
 *     tmux server lifetime. Binding identity to a server we own, and recording
 *     that server's identity (`#{start_time}`) alongside the id, is what makes
 *     "is `$3` still my agent?" answerable after a restart. On the shared default
 *     server, `$3` could be anything.
 */
const tmuxSocketPath = join(config.stateDir, "tmux.sock");
const tmux = new DefaultTmuxService({ socketPath: tmuxSocketPath });
const registry = new DefaultCollabRegistryService();
const modelCatalog = new DefaultModelCatalogService();
const paths = new WorkspacePathPolicy(config.allowedRoots);

/**
 * Overlay directory for generated agent configs. Inside the state dir, which is
 * 0700: these files are per-conversation and contain no secrets, but they are
 * ours and nobody else's business.
 */
const overlayDir = join(config.stateDir, "overlays");
await mkdir(overlayDir, { recursive: true, mode: 0o700 });

// ── Private relay & capabilities ───────────────────────────────────────────

const capabilityService = new DefaultCapabilityService({
  relayConfig: {
    configured: true,
    origin: config.publicOrigin
      ? config.publicOrigin.replace(/^http:/, "ws:").replace(/^https:/, "wss:")
      : `ws://127.0.0.1:${config.port}`,
    reachable: true,
  },
});

// ── Supervisor ──────────────────────────────────────────────────────────────
const supervisor = createSupervisor({
  store,
  maxActive: config.maxActiveAgents,
  adapters: {
    listHosts: () =>
      registry.list().then((hosts) => hosts
        .filter((host) => typeof host.instanceId === "string" && typeof host.generation === "number")
        .map((host) => ({
          instanceId: host.instanceId,
          generation: host.generation,
          pid: host.pid,
          sessionId: host.sessionId,
          cwd: host.cwd,
          model: host.model ? `${host.model.provider}/${host.model.id}` : null,
          participants: host.participants,
          relayConnected: host.relayConnected,
          inputRequired: host.inputRequired,
          busy: host.busy,
          access: host.access,
        }))),
    listManagedTmux: () =>
      tmux.listManaged().then((sessions) =>
        sessions.map((session) => ({
          id: session.id,
          name: session.name,
          alive: session.alive,
          panePid: session.panePid,
          serverIdentity: session.serverIdentity,
        })),
      ),
    isProcessDescendant: (candidatePid, panePid) => tmux.isProcessDescendant(candidatePid, panePid),
    tmuxServerIdentity: () => tmux.serverIdentity(),
    getTmux: async (id) => {
      try {
        const session = await tmux.getById(id);
        return { ok: true as const, session: session ? { id: session.id, name: session.name, alive: session.alive, panePid: session.panePid, serverIdentity: session.serverIdentity } : null };
      } catch (error) {
        return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    launch: async (spec) => launchWithOverlay(
      { overlayDir, conversationId: spec.conversationId, configPath: spec.configPath, relayPort: config.relayPort, webUrl: config.publicOrigin },
      async (configPath) => {
        const session = await tmux.launch({
          name: spec.name,
          cwd: spec.cwd,
          configPath,
          model: spec.model,
          env: spec.env,
          args: spec.resumeSessionPath ? ["--resume", spec.resumeSessionPath] : [],
        });
        return {
          id: session.id,
          name: session.name,
          alive: session.alive,
          panePid: session.panePid,
          serverIdentity: session.serverIdentity,
        };
      },
    ),
    // The guard is mandatory here: a recorded `$N` is not actionable unless the
    // tmux server that owns it is still the one we recorded.
    killTmux: (id, expectedServerIdentity) => tmux.kill(id, { expectedIdentity: expectedServerIdentity }),
    isSessionLive: (id) => lease.isLive(id),
    newestSessionFor: async (cwd) => {
      const session = (await catalog.listForCwd(cwd))[0];
      return session ? { sessionId: session.sessionId, path: session.path } : null;
    },
    sessionPathExists: async (sessionPath) => {
      try {
        return (await stat(sessionPath)).isFile();
      } catch {
        return false;
      }
    },
    findBySessionId: (id) => catalog.findBySessionId(id),
  },
});

/**
 * Resolve the launch parameters for a conversation.
 *
 * The project's directory is re-validated against the path policy on every
 * launch, so a project whose path later left the allowlist cannot be used to
 * start an agent. A resume is only accepted when the requested native session
 * genuinely lives in this project's directory.
 */
const runtimeSpec = createRuntimeSpec({ store, paths, catalog });

/**
 * Mint a browser link for a conversation's live room.
 *
 * The instance id and generation come from a listing taken on every call, so the
 * link is always bound to the room that exists *now*. OMP rejects a stale
 * generation with `stale_generation`, which surfaces to the client as "list
 * again" rather than a link to a successor room.
 */
const mintLink = createMintLink(registry, config.publicOrigin);

/**
 * Native OMP sessions for a project directory, excluding the conversation that
 * already owns each one. The store is consulted so the UI can show "already
 * tracked" rather than offering to resume something we are already running.
 */
const listNativeSessions = async (input: { projectPath: string }): Promise<NativeSessionSummary[]> => {
  const canonical = await paths.assertInsideRoots(input.projectPath, true);
  const sessions = await catalog.listForCwd(canonical);
  const tracked = new Set(
    (await store.listAllConversations())
      .map((conversation) => conversation.nativeSessionId)
      .filter((id): id is string => Boolean(id)),
  );
  return sessions.map((session) => ({
    sessionId: session.sessionId,
    path: session.path,
    cwd: session.cwd,
    title: session.title,
    updatedAt: session.updatedAt,
    live: session.live,
    tracked: tracked.has(session.sessionId),
  }));
};

// ── Application ─────────────────────────────────────────────────────────────
const app = buildApp({
  config,
  auth,
  store,
  paths,
  capabilities: capabilityService,
  supervisor,
  runtimeSpec,
  mintLink,
  listNativeSessions,
  modelCatalog,
  readNativeHistory: (sessionId, expectedCwd) => catalog.readHistory(sessionId, expectedCwd),
  tmuxSocketPath,
  tmuxServerIdentity: () => tmux.serverIdentity(),
});
await app.ready();


// The host listener is separate from the app/Serve-facing listener and binds loopback only.
// The host role is reachable by any process on this machine that can reach 127.0.0.1:<relayPort>.
// This is a topology control, not authentication of the managed agent; distinguishing our agent
// from another local process would require a credential OMP cannot present (its socket URL is built
// internally and accepts no headers). Tailscale Serve must proxy only app port, never relayPort.
const hostRelayServer = createServer();
const relay = createRelay({
  server: app.server,
  attachOnly: true,
  allowHost: false,
  allowedOrigin: config.relayAllowedOrigins.length > 0 ? config.relayAllowedOrigins : undefined,
  authorizeHost: (req) => {
    // The listener is only reachable on loopback; app/Serve-facing listener denies host role.
    // See trust-model comment above: this does not authenticate one local process from another.
    return req.socket.localPort === config.relayPort &&
      (req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1" || req.socket.remoteAddress === "::ffff:127.0.0.1");
  },
});
relay.attach(hostRelayServer, { allowHost: true });

const hostRelayListening = new Promise<void>((resolve, reject) => {
  hostRelayServer.once("error", reject);
  hostRelayServer.listen(config.relayPort, "127.0.0.1", () => {
    hostRelayServer.removeListener("error", reject);
    resolve();
  });
});
await hostRelayListening;
try {
  await relay.start();
  app.log.info({ port: config.port }, "private collab relay attached at /r/<roomId>?role=host|guest");
} catch (error) {
  const message = error instanceof Error ? String(redactLogValue(error.message)) : "Unknown relay error";
  app.log.error({ message }, "relay failed to attach");
}

// Reconcile before listening: the UI's first paint should show what is really
// running, not what we remember from the last process.
const report = await supervisor.reconcile();
app.log.info(report, "runtime reconciled");

const shutdown = async (signal: string) => {
  await relay.stop().catch(() => undefined);
  await app.close().catch(() => undefined);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  const message = error instanceof Error ? String(redactLogValue(error.message)) : "Unknown listen error";
  app.log.error({ message }, "server failed to listen");
  process.exitCode = 1;
}
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
if (isMain) {
  await startServer();
}
