import type { Server as HttpServer } from "node:http";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type RouteGenericInterface } from "fastify";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { browseQuerySchema, conversationActionSchema, conversationModelSchema, createConversationSchema, createDirectorySchema, createProjectSchema, epochOf, ERROR_CODES, fail, globalSessionsQuerySchema, listEventsQuerySchema, loginSchema, observationSeqOf, ok, updateProjectSchema } from "@caw/contracts";
import { z } from "zod";
import type { Capabilities, CollabLinkResponse, Conversation, ErrorCode, GlobalSessionPage, GlobalSessionSummary, HandoffResponse, NativeSessionSummary, ProjectWithStats } from "@caw/contracts";
import type { CapabilityService, CollabHost, HandoffResult, ModelCatalogService, NativeHandoffCompaction, NativeSessionHistory } from "@caw/omp-adapter";
import type { Supervisor, RuntimeLaunchSpec } from "@caw/runtime";
import { evaluateState } from "@caw/runtime";
import type { AuthenticationService } from "./auth.js";
import { resolve } from "node:path";
import { findRepoRoot, resolveDistDir, type ServerConfig } from "./config.js";
import { registerStaticWeb } from "./static-web.js";
import { createLogger, redactEventPayload, redactLogValue } from "./logger.js";
import { PathPolicyError, WorkspacePathPolicy } from "./path-policy.js";
import { DuplicateProjectPathError, type MetadataStore } from "./store.js";

export interface AppDependencies {
  config: ServerConfig;
  auth: AuthenticationService;
  store: MetadataStore;
  paths?: WorkspacePathPolicy;
  capabilities?: CapabilityService;
  supervisor?: Supervisor;
  originAllowlist?: string[];
  runtimeSpec?: (conversation: Conversation, input: { resumeSessionId?: string; model?: string }) => Promise<RuntimeLaunchSpec> | RuntimeLaunchSpec;
  /**
   * Mints a room link for a conversation's live host. Supplied by the
   * composition root because only it knows how to reach the registry. Never
   * cached by the route: a link is bound to the room generation observed when
   * it is minted, and a session switch retires that room.
   */
  mintLink?: (conversation: Conversation, access: "control" | "view") => Promise<CollabLinkResponse>;
  tmuxSocketPath?: string;
  tmuxServerIdentity?: () => Promise<string | null>;
  /** Discovers native OMP sessions for a project directory. */
  listNativeSessions?: (conversation: { projectPath: string }) => Promise<Array<Omit<NativeSessionSummary, "hasCollabHost">>>;
  listCollabHosts?: () => Promise<CollabHost[]>;
  modelCatalog?: ModelCatalogService;
  /** Bounded global native-session enumeration, composed without adapter knowledge. */
  listGlobalSessions?: () => Promise<{ sessions: Array<Omit<NativeSessionSummary, "hasCollabHost"> & { startedAt?: string | null }>; filesScanned: number; filesSkippedNonJournal: number; filesUnreadable: number; truncated: boolean }>;
  /** Reads saved transcript by journal identity; route supplies journal-derived cwd. */
  readGlobalHistory?: (sessionId: string, before?: string) => Promise<NativeSessionHistory>;
  /** Canonicalizes project and session working directories using composition-root reconciliation. */
  canonicalProjectPath: (projectPath: string) => Promise<string>;
  /** CWD stat seam for deterministic route tests. */
  statPath?: typeof stat;
  /** Reads a bounded native journal window by session ID after matching canonical project path. */
  readNativeHistory?: (sessionId: string, expectedCwd: string, options?: { before?: string }) => Promise<NativeSessionHistory>;
  findLiveHost?: (sessionId: string) => Promise<CollabHost | null>;
  /**
   * Types OMP's builtin `/handoff` into a live pane. Supplied by the composition
   * root because only it holds the private tmux service; the route owns the
   * preconditions (ownership, identity, idleness) and passes them down.
   */
  sendHandoff?: (input: { sessionId: string; expectedIdentity: string; expectedPanePid: number; assertIdle: () => Promise<boolean> }) => Promise<HandoffResult>;
  /**
   * Native proof reader for handoff: the newest `compaction` entry with
   * `method: "handoff"` newer than the given epoch ms, or null. The route uses
   * it both to decide whether a previous handoff is still generating and to
   * earn the right to say "committed".
   */
  readHandoffCompaction?: (sessionId: string, sinceMs: number) => Promise<NativeHandoffCompaction | null>;
  /** Bounded wait for that evidence before reporting `delivered`; 0 disables the wait. */
  handoffEvidenceBudgetMs?: number;
  /**
   * One bounded, read-only count of OMP's *explicit* refusal lines in the pane's
   * recent output. A count, not a verdict, because the same warning can sit on
   * screen from an earlier handoff: only a *rise* relative to a baseline taken
   * just before the paste is evidence, and the route owns that comparison. The
   * rise spans the reads, not the paste: it rules out a line left behind by an
   * earlier operation, and cannot tell a new refusal from an old one re-entering
   * the window. Throws (never resolves) when the pane cannot be read, so
   * "I could not look" can never be mistaken for "nothing was refused".
   */
  countHandoffRefusals?: (sessionId: string) => Promise<number>;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const BODY_LIMIT = 64 * 1024;
/**
 * How long a request will watch the journal for native handoff evidence before
 * reporting `delivered`. A real handoff generation was observed taking minutes
 * (owner journals: 197s–7216s between the last prompt and the compaction entry),
 * so this budget is deliberately far below that: it catches a handoff that
 * committed at once and otherwise returns immediately (`ponytail: 0 by default,
 * raise only if a fast-commit case is ever observed being missed`).
 */
const HANDOFF_EVIDENCE_POLL_MS = 250;
/**
 * Hard age backstop for a standing handoff marker.
 *
 * This is the *last* resort, for the one case with no positive evidence either
 * way: a paste landed, the journal shows no compaction entry, and the pane says
 * nothing decidable. Any observed outcome retires the marker long before this
 * (a compacted entry, or OMP's own refusal in the pane), so the common case —
 * including an empty session answering "Nothing to hand off" — resolves in one
 * round trip.
 *
 * The number is deliberately above the longest generation ever observed from
 * this machine's own journals (197 s – 7216 s, i.e. ~120 min), because expiring
 * *while* a handoff is still generating is the unsafe direction: it would admit
 * a second paste into a live compaction. A 2.5-hour wait is the wrong answer
 * only if it is reached, which now requires no evidence at all.
 */
const HANDOFF_MARKER_TTL_MS = 150 * 60_000;

/**
 * Take one bounded, read-only count of the pane's refusal lines, or `null` when
 * the pane cannot be read.
 *
 * The count alone means nothing — the same "Nothing to hand off" can sit on
 * screen from an earlier attempt. It is meaningful only against a baseline taken
 * immediately before the paste being judged, so a bare `count > 0` is never
 * treated as evidence here. `null` (unreadable, or no reader configured) must
 * fail closed: "I could not look" is not "nothing was refused".
 */
async function countRefusals(deps: AppDependencies, sessionId: string): Promise<number | null> {
  if (!deps.countHandoffRefusals) return null;
  try {
    return await deps.countHandoffRefusals(sessionId);
  } catch {
    return null;
  }
}

/**
 * Read a `code` off an unknown error without asserting a shape onto it.
 *
 * Adapter and runtime failures carry a machine-readable code; anything else that
 * reaches a handler must be treated as opaque rather than trusted for member
 * access.
 */
function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const value = error.code;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}
const globalCursorKey = randomBytes(32);
interface GlobalCursor { version: 1; query: string; updatedAt: string | null; sessionId: string }
function encodeGlobalCursor(cursor: GlobalCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${payload}.${createHmac("sha256", globalCursorKey).update(payload).digest("base64url")}`;
}
function decodeGlobalCursor(value: string, query: string): GlobalCursor {
  const [payload, signature, extra] = value.split(".");
  try {
    if (!payload || !signature || extra !== undefined || Buffer.from(payload, "base64url").toString("base64url") !== payload) throw new Error();
    const expected = createHmac("sha256", globalCursorKey).update(payload).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<GlobalCursor>;
    if (parsed.version !== 1 || parsed.query !== query || !(parsed.updatedAt === null || typeof parsed.updatedAt === "string") || typeof parsed.sessionId !== "string") throw new Error();
    return parsed as GlobalCursor;
  } catch { throw new PathPolicyError("path_forbidden", "Invalid global session cursor"); }
}
type HttpRequest = FastifyRequest<RouteGenericInterface, HttpServer>;
type HttpReply = FastifyReply<RouteGenericInterface, HttpServer>;
type RequestWithAuth = HttpRequest & { cawSession?: { csrfToken: string; expiresAt: number; passwordSetupRequired: boolean }; cawToken?: string };
const idParams = z.object({ id: z.string().min(1).max(128) });
const linkQuerySchema = z.object({ access: z.enum(["control", "view"]).default("control") });
const attachRequest = z.object({ action: z.literal("attach") });
const conversationRequest = createConversationSchema.omit({ projectId: true });
const historyQuerySchema = z.object({ before: z.string().min(1).max(2048).optional() });

function withAuth(request: HttpRequest): RequestWithAuth {
  return request as unknown as RequestWithAuth;
}

export function cookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of (header ?? "").split(";")) {
    const index = item.indexOf("=");
    if (index > 0) {
      try { result[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim()); }
      catch { /* Malformed cookies cannot authenticate. */ }
    }
  }
  return result;
}

const missingCapabilities: Capabilities = {
  omp: { available: false, version: null, path: null },
  tmux: { available: false, version: null },
  relay: { configured: false, origin: null, reachable: null },
};

export function buildApp(deps: AppDependencies): FastifyInstance<HttpServer> {
  const app = Fastify<HttpServer>({ logger: createLogger(deps.config.logLevel), bodyLimit: BODY_LIMIT, disableRequestLogging: true });
  const paths = deps.paths ?? new WorkspacePathPolicy(deps.config.allowedRoots, async (canonicalPath) => (await deps.store.listProjects()).some((project) => project.path === canonicalPath));
  const origins = new Set(deps.originAllowlist ?? [
    `http://localhost:${deps.config.port}`, `http://127.0.0.1:${deps.config.port}`, `http://[::1]:${deps.config.port}`,
    `https://localhost:${deps.config.port}`, `https://127.0.0.1:${deps.config.port}`, `https://[::1]:${deps.config.port}`,
    ...(deps.config.publicOrigin ? [deps.config.publicOrigin] : []),
  ]);
  const publicWsOrigin = deps.config.publicOrigin
    ? deps.config.publicOrigin.replace(/^http:/, "ws:").replace(/^https:/, "wss:")
    : "";
  const connectSrc = publicWsOrigin && !publicWsOrigin.includes(`127.0.0.1:${deps.config.port}`)
    ? `'self' ${publicWsOrigin}`
    : "'self'";

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${connectSrc}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`);
    const req = withAuth(request);
    req.cawToken = cookies(request.headers.cookie)[deps.auth.cookieName];
    req.cawSession = deps.auth.verifySession(req.cawToken) ?? undefined;
    const pathname = request.url.split("?", 1)[0] ?? "/";
    const isLogin = pathname === "/api/auth/login";
    const isApi = pathname === "/api" || pathname.startsWith("/api/");
    const setupAction = (request.method === "POST" && ["/api/auth/set-password", "/api/auth/logout"].includes(pathname))
      || (request.method === "GET" && pathname === "/api/auth/me");
    if (req.cawSession?.passwordSetupRequired && isApi && !setupAction) {
      return reply.code(403).send(fail("unauthorized", "Set the owner password before using this API"));
    }
    if (isApi && pathname !== "/api/auth/login" && !req.cawSession) {
      const match = app.findRoute({ method: request.method, url: pathname });
      if (match) return reply.code(401).send(fail("unauthorized", "Authentication required"));
    }
    const origin = request.headers.origin;
    const trustedTailscale = deps.config.trustTailscaleOrigin && typeof origin === "string" && /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/iu.test(origin);
    const safe = SAFE_METHODS.has(request.method);
    // A JSON content-type is only meaningful when there is a body to parse. A
    // POST that carries no payload at all (minting a link, for instance) must not
    // be forced to declare a type it does not use, and a JSON+empty-body request
    // is rejected by the parser anyway.
    const hasBody =
      request.headers["content-length"] !== undefined
        ? Number(request.headers["content-length"]) > 0
        : request.headers["transfer-encoding"] !== undefined;
    if (hasBody && !request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      return reply.code(415).send(fail("bad_request", "Content-Type must be application/json"));
    }
    if (origin ? !origins.has(origin) && !trustedTailscale : !safe) return reply.code(403).send(fail("bad_request", "Missing or disallowed Origin"));
    if (!safe && request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin") return reply.code(403).send(fail("bad_request", "Cross-site state-changing request rejected"));
    const csrfHeader = request.headers["x-caw-csrf"];
    if (!safe && !isLogin && !deps.auth.verifyCsrf(req.cawToken, Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader)) return reply.code(403).send(fail("csrf", "CSRF token missing or invalid"));
  });
  app.addHook("onResponse", async (request, reply) => {
    app.log.info({ method: request.method, route: request.routeOptions.url ?? "unknown", statusCode: reply.statusCode, origin: request.headers.origin ?? null }, "request");
  });
  app.setErrorHandler((error, _request, reply) => {
    // Fastify's JSON parser rejects an empty body outright. That is a malformed
    // request, not a server fault: a client that declares JSON must send some.
    if (error instanceof Error && /Body cannot be empty/i.test(error.message)) {
      return reply.code(400).send(fail("bad_request", "A JSON content-type requires a request body."));
    }
    if (error instanceof Error && "statusCode" in error && error.statusCode === 413) return reply.code(413).send(fail("bad_request", "Request body exceeds 64 KiB"));
    const message = error instanceof Error ? String(redactLogValue(error.message)) : "Unknown request error";
    app.log.error({ message }, "request failed");
    return reply.code(500).send(fail("internal", "Internal server error"));
  });
  const repoRoot = findRepoRoot();
  const webDistDir = deps.config.webDistDir
    ? resolveDistDir(deps.config.webDistDir, repoRoot, "webDistDir")
    : resolve(repoRoot, "apps/web/dist");
  const guestDistDir = deps.config.guestDistDir
    ? resolveDistDir(deps.config.guestDistDir, repoRoot, "guestDistDir")
    : resolve(repoRoot, "packages/guest/dist");
  registerStaticWeb(app, { webDistDir, guestDistDir });


  const protectedHook = async (request: HttpRequest, reply: HttpReply) => {
    if (!withAuth(request).cawSession) return reply.code(401).send(fail("unauthorized", "Authentication required"));
  };
  const capabilities = () => deps.capabilities ? deps.capabilities.capabilities() : Promise.resolve(missingCapabilities);

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail("bad_request", "Invalid login request"));
    const result = await deps.auth.authenticate(parsed.data.password, request.ip);
    if (!result) return reply.code(401).send(fail("unauthorized", "Invalid password"));
    const session = deps.auth.createSession(result === "setup");
    reply.header("Set-Cookie", deps.auth.cookie(session.token, Math.floor((session.expiresAt - Date.now()) / 1000)));
    return ok({ status: result === "setup" ? "password_setup_required" : "authenticated", csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
  });
  app.post("/api/auth/set-password", { preHandler: protectedHook }, async (request, reply) => {
    const body = z.object({ password: z.string().min(12).max(1024) }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send(fail("bad_request", "Password must be 12 to 1024 characters"));
    const session = withAuth(request).cawSession;
    if (!session?.passwordSetupRequired || !withAuth(request).cawToken) return reply.code(403).send(fail("unauthorized", "Password setup is not pending"));
    const result = await deps.auth.completePasswordSetup(body.data.password, withAuth(request).cawToken!);
    if (result === false) return reply.code(409).send(fail("conflict_owner", "Pending setup token is expired or already consumed"));
    if (result === "matches_pending_token") return reply.code(400).send(fail("bad_request", "Choose a password different from the setup token"));
    return ok({ status: "authenticated", csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
  });
  app.post("/api/auth/change-password", { preHandler: protectedHook }, async (request, reply) => {
    const body = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(12).max(1024) }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send(fail("bad_request", "Invalid password change request"));
    const token = withAuth(request).cawToken;
    if (!token) return reply.code(401).send(fail("unauthorized", "Authentication required"));
    if (!(await deps.auth.changePassword(body.data.currentPassword, body.data.newPassword, token, request.ip))) return reply.code(401).send(fail("unauthorized", "Current password is invalid"));
    return ok({ changed: true });
  });
  app.post("/api/auth/logout", { preHandler: protectedHook }, async (_request, reply) => {
    deps.auth.revokeAll();
    reply.header("Set-Cookie", deps.auth.clearCookie());
    return ok({ loggedOut: true });
  });
  app.get("/api/auth/me", { preHandler: protectedHook }, async (request) => ok({ csrfToken: withAuth(request).cawSession!.csrfToken }));
  app.get("/api/capabilities", { preHandler: protectedHook }, async () => ok(await capabilities()));
  app.get("/api/projects", { preHandler: protectedHook }, async () => {
    const [projects, conversations] = await Promise.all([deps.store.listProjects(), deps.store.listAllConversations()]);
    return ok(projects.map((project): ProjectWithStats => {
      const rows = conversations.filter((conversation) => conversation.projectId === project.id);
      return { ...project, conversationCount: rows.length, lastActivityAt: rows.map((conversation) => conversation.lastActivityAt).filter((value): value is string => value !== null).sort().at(-1) ?? null };
    }));
  });
  app.post("/api/projects", { preHandler: protectedHook }, async (request, reply) => {
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail("bad_request", "Invalid project request"));
    try {
      const canonicalPath = await paths.assertInsideRoots(parsed.data.path, true);
      return reply.code(201).send(ok(await deps.store.createProject({ path: canonicalPath, label: parsed.data.label })));
    } catch (error) { return pathError(reply, error); }
  });
  app.patch("/api/projects/:id", { preHandler: protectedHook }, async (request, reply) => {
    const parsed = updateProjectSchema.safeParse(request.body);
    const params = idParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send(fail("bad_request", "Invalid project update"));
    if (!params.success) return reply.code(400).send(fail("bad_request", "Invalid project ID"));
    const project = await deps.store.updateProject(params.data.id, parsed.data);
    return project ? ok(project) : reply.code(404).send(fail("not_found", "Project not found"));
  });
  app.delete("/api/projects/:id", { preHandler: protectedHook }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail("bad_request", "Invalid project ID"));
    const project = (await deps.store.listProjects()).find((item) => item.id === params.data.id);
    if (!project) return reply.code(404).send(fail("not_found", "Project not found"));
    const conversations = await deps.store.listConversations(project.id);
    // Observe each conversation rather than trusting its stored label: a row that
    // still says `running` may be long dead, and a row that says `stopped` may have
    // been restarted behind our back. A row that never had a process launched for it
    // is not blocking — deleting it only removes a list entry. Nothing is killed
    // here, ever: the user stops the agent first, then deletes.
    const blocking: Conversation[] = [];
    // Each verified conversation carries the lifecycle epoch its verdict was
    // observed at. The store re-checks it inside its queued delete: a launch that
    // took the row since then advances the epoch, so the delete refuses rather
    // than dropping the only pointer to a process that is now running.
    const verified = new Map<string, number>();
    for (const conversation of conversations) {
      // A launch in flight has not recorded its process yet, so every stored field
      // still says "nothing running". Deleting the row now would drop the only
      // pointer to a process that is being started this instant.
      if (deps.supervisor?.isLaunching?.(conversation.id)) { blocking.push(conversation); continue; }
      const observations = deps.supervisor ? await deps.supervisor.observe(conversation.id) : null;
      const state = observations ? evaluateState(observations).state : conversation.state;
      // The epoch the verdict speaks for. Without a supervisor there is no
      // observation, so the stored row is its own (unstamped) evidence: epoch 0,
      // which the store compares against the row it re-reads.
      const observedEpoch = observations ? observations.observedEpoch : epochOf(conversation);
      // `stopped`/`error` both mean observed as not running (error: the process is
      // gone and its journal is missing). This is the case the stored label blocks
      // today: a fresh observation that the process is dead is evidence, and the
      // epoch binds it to the row the store will re-read.
      if (state === "stopped" || state === "error") { verified.set(conversation.id, observedEpoch); continue; }
      // Anything else is only deletable when the observations positively show no
      // writer: no process we launched, no unverifiable pane, no held lease and no
      // registry host. An external session with a live writer reads as `unknown`
      // (or a host state) and must be refused like any other running agent.
      const mayHaveProcess = observations
        ? observations.everLaunched || observations.tmuxOwnershipUnknown || observations.leaseLive !== false || observations.host !== null
        : true;
      if (mayHaveProcess) blocking.push(conversation);
      else verified.set(conversation.id, observedEpoch);
    }
    if (blocking.length > 0) {
      return reply.code(409).send(fail("conflict_owner", `This project still has agents that are running or cannot be verified as stopped (${blocking.map((conversation) => conversation.title).join(", ")}). Stop them before deleting the project.`));
    }
    // Verified stopped: drop our rows for them too, in the same queued write as the
    // delete. Leaving the rows behind would point at a project that no longer
    // exists, and a re-added folder would then hide their native sessions as
    // "already tracked" with nothing that can open them.
    //
    // The reservation check travels into the store's queued delete rather than
    // staying in the loop above. The store owns the reservation, and `reserveLaunch`
    // and `deleteProject` are sections of its one queue: exactly one of them commits
    // first. A launch that reserved before the delete's section is visible and the
    // delete refuses; a launch that reserves after it finds the row gone and fails
    // `agent_not_running` before creating a process. There is no window in which the
    // delete drops the only pointer to a starting process.
    const deleted = await deps.store.deleteProject(project.id, verified);
    if (deleted !== "deleted") {
      const pending = conversations.some((conversation) => deps.store.isLaunchReserved(conversation.id));
      return reply.code(409).send(fail("conflict_owner", pending
        ? "An agent launch is still in flight for this project. Wait for it to settle (or stop the agent) before deleting."
        : "This project still has conversations. Stop them before deleting the project."));
    }
    return ok({ deleted: true, filesRemoved: false });
  });
  app.get("/api/projects/:id/sessions", { preHandler: protectedHook }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail("bad_request", "Invalid project ID"));
    const project = (await deps.store.listProjects()).find((item) => item.id === params.data.id);
    if (!project) return reply.code(404).send(fail("not_found", "Project not found"));
    if (!deps.listNativeSessions) return ok([] as NativeSessionSummary[]);
    if (!deps.listCollabHosts) return reply.code(501).send(fail("capability_missing", "Collab registry is not configured."));
    let sessions: Array<Omit<NativeSessionSummary, "hasCollabHost">>;
    try {
      sessions = await deps.listNativeSessions({ projectPath: project.path });
    } catch (error) {
      return pathError(reply, error);
    }
    let hosts: CollabHost[];
    try {
      hosts = await deps.listCollabHosts();
    } catch {
      return reply.code(500).send(fail("internal", "Unable to read Collab host registry."));
    }
    const hostsBySession = new Map<string, CollabHost>();
    for (const host of hosts) if (!hostsBySession.has(host.sessionId)) hostsBySession.set(host.sessionId, host);
    return ok(sessions.map((session) => {
      const host = hostsBySession.get(session.sessionId);
      return { ...session, hasCollabHost: host?.relayConnected === true, relayConnected: host?.relayConnected ?? null, collabHostReported: Boolean(host) };
    }));
  });
  app.post("/api/projects/:id/sessions/:sessionId/attach-live", { preHandler: protectedHook }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1).max(128), sessionId: z.string().min(1).max(128) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail("bad_request", "Invalid project or session ID"));
    if (!deps.listNativeSessions || !deps.findLiveHost) return reply.code(501).send(fail("capability_missing", "Live native session attachment is not configured."));
    const project = (await deps.store.listProjects()).find((item) => item.id === params.data.id);
    if (!project) return reply.code(404).send(fail("not_found", "Project not found"));
    try {
      const projectPath = await paths.assertInsideRoots(project.path, true);
      const sessions = await deps.listNativeSessions({ projectPath });
      const session = sessions.find((item) => item.sessionId === params.data.sessionId);
      if (!session) return reply.code(404).send(fail("not_found", "Native session journal was not found."));
      if ((await paths.assertInsideRoots(session.cwd, true)) !== projectPath) return reply.code(403).send(fail("path_forbidden", "Native session journal does not belong to this project."));
      if (session.live === "unknown") return reply.code(409).send(fail("conflict_owner", "Native session writer status cannot be verified."));
      if (session.live !== true) return reply.code(409).send(fail("link_unavailable", "Native session has no live writer to attach to."));
      const host = await deps.findLiveHost(params.data.sessionId);
      if (!host || host.sessionId !== params.data.sessionId || host.relayConnected !== true) return reply.code(409).send(fail("link_unavailable", "Native session has no connected Collab host."));
      const conversation = await deps.store.registerExternalConversation({
        projectId: project.id,
        nativeSessionId: params.data.sessionId,
        title: session.title ?? "Live session",
        hostInstanceId: host.instanceId,
        hostGeneration: host.generation,
      });
      if (conversation.ownership !== "external") return reply.code(409).send(fail("conflict_owner", "Native session is already tracked by a managed conversation."));
      return ok(conversation);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "path_forbidden" || code === "path_not_found") return reply.code(403).send(fail("path_forbidden", "Native session journal does not belong to this project."));
      if (code === "not_found") return reply.code(404).send(fail("not_found", "Native session journal was not found."));
      app.log.error({ projectId: params.data.id }, "failed to attach live native session");
      return reply.code(500).send(fail("internal", "Unable to attach live native session."));
    }
  });
  app.get("/api/browse", { preHandler: protectedHook }, async (request, reply) => {
    const parsed = browseQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(fail("bad_request", "Invalid browse query"));
    try { return ok(await paths.listDirectory(parsed.data.path, { limit: parsed.data.limit, cursor: parsed.data.cursor })); } catch (error) { return pathError(reply, error); }
  });
  app.post("/api/directories", { preHandler: protectedHook }, async (request, reply) => {
    const parsed = createDirectorySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail("bad_request", parsed.error.issues.map((issue) => issue.message).join("; ") || "Invalid directory request"));
    try {
      return reply.code(201).send(ok({ path: await paths.createDirectory(parsed.data.path, parsed.data.name) }));
    } catch (error) { return pathError(reply, error); }
  });
  app.get("/api/sessions", { preHandler: protectedHook }, async (request, reply) => {
    const query = globalSessionsQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send(fail("bad_request", "Invalid global session query"));
    if (!deps.listGlobalSessions) return reply.code(501).send(fail("capability_missing", "Global native session listing is not configured."));
    if (!deps.listCollabHosts) return reply.code(501).send(fail("capability_missing", "Collab registry is not configured."));
    try {
      const [scan, hosts, projects, conversations] = await Promise.all([deps.listGlobalSessions(), deps.listCollabHosts(), deps.store.listProjects(), deps.store.listAllConversations()]);
      // The listing must apply the SAME containment rule the reader applies. A
      // lexical check alone accepts a journal whose header `cwd` is a symlink
      // that *looks* inside a root but resolves outside it: the row would be
      // listed and then refused on read, which is a scope leak and a broken
      // affordance. `isInsideConfiguredRootsForRead` canonicalizes and keeps the
      // one supported exception — an ENOENT cwd (a working directory that has
      // since been deleted) stays readable as history-only.
      //
      // Degrade per row, never per request: a single cwd the filesystem refuses
      // to canonicalize (a symlink loop, a non-directory component) must hide its
      // own row and leave every other row — and the page cursor — intact.
      const contained: Array<{ include: boolean; unreadableCwd?: boolean }> = await Promise.all(scan.sessions.map(async (session) => {
        try {
          return { include: await paths.isInsideConfiguredRootsForRead(session.cwd) };
        } catch (error) {
          app.log.warn({ sessionId: session.sessionId, errno: (error as NodeJS.ErrnoException).code }, "excluding session whose cwd could not be canonicalized");
          // A row dropped here is *not* one that is merely outside the
          // workspace: its own cwd could not be examined at all. Folding it into
          // `excludedOutsideRoots` would make an unreadable working directory
          // indistinguishable from a legitimate out-of-scope one, so it is
          // counted separately and surfaced, the same way a dropped root is.
          return { include: false, unreadableCwd: true };
        }
      }));
      const allowed = scan.sessions.filter((_session, index) => contained[index]!.include);
      const hostMap = new Map(hosts.map((host) => [host.sessionId, host]));
      const unreadableCwds = contained.filter((verdict) => verdict.unreadableCwd).length;
      const excludedOutsideRoots = scan.sessions.length - allowed.length - unreadableCwds;
      const projectIds = new Set(projects.map((project) => project.id));
      const tracked = new Set(conversations.filter((conversation) => projectIds.has(conversation.projectId)).map((conversation) => conversation.nativeSessionId).filter((id): id is string => Boolean(id)));
      // Canonical project paths are computed once per request, not once per session.
      // Missing or unreadable registered projects cannot match and must not hide other rows.
      const projectByPath = new Map<string, string>();
      for (const project of projects) {
        try { projectByPath.set(await deps.canonicalProjectPath(project.path), project.id); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const q = (query.data.q ?? "").toLocaleLowerCase();
      const mapped: GlobalSessionSummary[] = await Promise.all(allowed.map(async (session) => {
        let cwdAvailable = true;
        try { await (deps.statPath ?? stat)(session.cwd); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") cwdAvailable = false; else throw error; }
        let projectId: string | null = null;
        // A session cwd may be gone: preserve its history-only row with no project match.
        try { projectId = projectByPath.get(await deps.canonicalProjectPath(session.cwd)) ?? null; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const host = hostMap.get(session.sessionId);
        return { sessionId: session.sessionId, journalPath: session.path, cwd: session.cwd, cwdAvailable, projectId, conversationId: session.conversationId ?? null, title: session.title, updatedAt: session.updatedAt, startedAt: session.startedAt ?? null, live: session.live, tracked: tracked.has(session.sessionId), hasCollabHost: host?.relayConnected === true, relayConnected: host?.relayConnected ?? null };
      }));
      const filtered = mapped.filter((session) => !q || [session.title, session.cwd, session.sessionId, projects.find((project) => project.id === session.projectId)?.label].some((value) => value?.toLocaleLowerCase().includes(q)));
      const order = (a: { updatedAt: string | null; sessionId: string }, b: { updatedAt: string | null; sessionId: string }) => (a.updatedAt === null || b.updatedAt === null ? a.updatedAt === b.updatedAt ? a.sessionId.localeCompare(b.sessionId) : a.updatedAt === null ? 1 : -1 : b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId));
      filtered.sort(order);
      const cursor = query.data.cursor ? decodeGlobalCursor(query.data.cursor, q) : null;
      const start = cursor ? filtered.findIndex((session) => order(session, cursor) > 0) : 0;
      if (cursor && start < 0) throw new PathPolicyError("path_forbidden", "Invalid global session cursor");
      const page = filtered.slice(cursor ? start : 0, (cursor ? start : 0) + query.data.limit);
      const last = page.at(-1);
      const nextCursor = last && filtered.some((session) => order(session, last) > 0) ? encodeGlobalCursor({ version: 1, query: q, updatedAt: last.updatedAt, sessionId: last.sessionId }) : null;
      const result: GlobalSessionPage = { sessions: page, nextCursor, filesScanned: scan.filesScanned, truncated: scan.truncated, excludedOutsideRoots, unreadableCwds, skippedNonJournal: scan.filesSkippedNonJournal, unreadableJournals: scan.filesUnreadable };
      // A dropped root makes legitimate sessions vanish from the page. Counted
      // rows alone would read as "these are all your sessions", so the roots are
      // named in the response and logged — an unreadable mount must not present
      // as an empty history.
      const { dropped } = await paths.verifiedRoots();
      if (dropped.length > 0) {
        for (const root of dropped) app.log.warn({ root }, "allowed root unavailable; sessions under it are missing from this listing");
        result.droppedRoots = dropped;
      }
      return ok(result);
    } catch (error) {
      if (errorCode(error) === "path_forbidden") return reply.code(403).send(fail("path_forbidden", "Invalid global session cursor or scope."));
      if (errorCode(error) === "path_not_found") return reply.code(403).send(fail("path_forbidden", "Project is outside configured roots."));
      app.log.error({ error: errorCode(error) }, "failed to list global native sessions");
      return reply.code(500).send(fail("internal", "Unable to list global native sessions."));
    }
  });
  app.get("/api/sessions/:sessionId/history", { preHandler: protectedHook }, async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1).max(128) }).safeParse(request.params);
    if (!params.success || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(params.data.sessionId)) return reply.code(400).send(fail("bad_request", "Invalid native session ID"));
    const query = historyQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send(fail("bad_request", "Invalid history cursor"));
    if (!deps.readGlobalHistory) return reply.code(501).send(fail("capability_missing", "Native session history is not configured."));
    try {
      const history = await deps.readGlobalHistory(params.data.sessionId, query.data.before);
      if (!paths.isInsideConfiguredRoots(history.header.cwd)) return reply.code(403).send(fail("path_forbidden", "Native session journal does not belong to configured roots."));
      return ok(history);
    } catch (error) {
      const code = runtimeErrorCode(error);
      if (code === "not_found") return reply.code(404).send(fail("not_found", "Native session journal was not found."));
      if (code === "conflict_owner") return reply.code(409).send(fail("conflict_owner", "Native session is live or its writer status cannot be verified."));
      if (code === "path_forbidden" || code === "path_not_found") return reply.code(403).send(fail("path_forbidden", "Native session journal does not belong to configured roots."));
      app.log.error({ sessionId: params.data.sessionId }, "failed to read global native session history");
      return reply.code(500).send(fail("internal", "Unable to read native session history."));
    }
  });
  app.get("/api/conversations/:id/history", { preHandler: protectedHook }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail("bad_request", "Invalid conversation ID"));
    const query = historyQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send(fail("bad_request", "Invalid history cursor"));
    const conversation = await deps.store.getConversation(params.data.id);
    if (!conversation) return reply.code(404).send(fail("not_found", "Conversation not found"));
    if (!conversation.nativeSessionId) return reply.code(404).send(fail("not_found", "Conversation has no native session history."));
    if (!deps.readNativeHistory) return reply.code(501).send(fail("capability_missing", "Native session history is not configured."));
    try {
      const project = (await deps.store.listProjects()).find((item) => item.id === conversation.projectId);
      if (!project) return reply.code(404).send(fail("not_found", "Conversation project not found."));
      const projectPath = await paths.assertInsideRoots(project.path, true);
      const history = await deps.readNativeHistory(conversation.nativeSessionId, projectPath, { before: query.data.before });
      if (history.header.sessionId !== conversation.nativeSessionId || (await paths.assertInsideRoots(history.header.cwd, true)) !== projectPath) return reply.code(403).send(fail("path_forbidden", "Native session journal does not belong to this project."));
      return ok(history);
    } catch (error) {
      const code = runtimeErrorCode(error);
      if (code === "not_found") return reply.code(404).send(fail("not_found", "Native session journal was not found."));
      if (code === "conflict_owner") return reply.code(409).send(fail("conflict_owner", "Native session is live or its writer status cannot be verified."));
      if (code === "path_forbidden" || code === "path_not_found") return reply.code(403).send(fail("path_forbidden", "Native session journal does not belong to this project."));
      app.log.error({ conversationId: conversation.id }, "failed to read native session history");
      return reply.code(500).send(fail("internal", "Unable to read native session history."));
    }
  });
  app.get("/api/projects/:id/conversations", { preHandler: protectedHook }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail("bad_request", "Invalid project ID"));
    return ok(await deps.store.listConversations(params.data.id));
  });
  app.post("/api/projects/:id/conversations", { preHandler: protectedHook }, async (request, reply) => {
    if (!deps.supervisor || !deps.runtimeSpec) return reply.code(501).send(fail("capability_missing", "Conversation lifecycle runtime is not configured"));
    const params = idParams.safeParse(request.params);
    // `request.body ?? {}` also maps an explicit JSON `null` onto the absent-body
    // value, so a body the strict schema rejects — a caller saying something we are
    // not listening to — was accepted and started a fresh conversation. An absent
    // body alone takes the documented default.
    const body = conversationRequest.safeParse(request.body === undefined ? {} : request.body);
    if (!params.success || !body.success) return reply.code(400).send(fail("bad_request", "Invalid conversation request"));
    const project = (await deps.store.listProjects()).find((item) => item.id === params.data.id);
    if (!project) return reply.code(404).send(fail("not_found", "Project not found"));
    const conversation = await deps.store.createConversation({ projectId: project.id, title: body.data.title, nativeSessionId: body.data.resumeSessionId });
    try {
      const spec = await deps.runtimeSpec(conversation, { resumeSessionId: body.data.resumeSessionId });
      return reply.code(201).send(ok(await deps.supervisor.start(conversation.id, spec)));
    } catch (error) {
      const code = runtimeErrorCode(error);
      const message = error instanceof Error ? String(redactLogValue(error.message)) : "Agent launch failed.";
      // A row left at `starting` with no process would sit in every listing as an
      // agent that is launching forever. Deleting it is the other wrong answer: the
      // row is the chat the user just created, and the only handle they have to
      // retry from, so a refused launch must not silently lose it. The row is kept
      // and marked for what happened instead — never left claiming to launch.
      //
      // Untouched: a launch that may have created a writer it could not record
      // (`agent.launch_unrecorded`) or one still reserving the session. Those rows
      // already carry the process identity, or the reservation, that makes them the
      // only pointer to something live.
      const started = await deps.store.getConversation(conversation.id);
      // The `isLaunching` check is a short-circuit, not the guarantee: it skips
      // composing the patch when a launch already holds the reservation, but the
      // reservation can be taken *after* it runs and *before* the write below
      // (another request's launch, in its post-spawn pre-record window). The
      // guarantee is the write's own shape.
      if (started && started.state === "starting" && started.tmuxSessionId === null && !deps.supervisor?.isLaunching?.(conversation.id)) {
        // This is an *observation*: the refusal is a verdict about the row `started`
        // describes, and carries that row's `observationSeq`. While a launch holds
        // the reservation the row is mid-replacement — a launch that began after this
        // read owns the row's truth in this window, and its record only compares the
        // epoch, which the pre-record row has not advanced, so an unflagged stamp
        // would land, bump the epoch, and make the launch refuse its own process and
        // kill it. The store drops an observation during the reservation, so the
        // stamp is refused and the launch keeps the row. Bound to the life `started`
        // describes: a restart (or another launch) that opens a newer life in the row
        // before this write advances the epoch, so the conditional write refuses and
        // the newer row keeps its own identity and state instead of being stamped
        // `error` by a refusal that was about the previous life. A row that vanished
        // (`null`) and a refused write are both no-ops: there is nothing of ours left
        // to mark.
        await deps.store.updateConversationIfCurrent(
          conversation.id,
          epochOf(started),
          {
            state: "error",
            statusDetail: `Agent launch was refused: ${message}`,
          },
          { observation: true, expectedObservationSeq: observationSeqOf(started) },
        ).catch(() => null);
      }
      return reply.code(code === "internal" ? 500 : code === "not_found" ? 404 : code === "path_forbidden" ? 403 : 409).send(fail(code, message));
    }
  });
  // SEC-7: A top-level cross-site navigation to GET /api/conversations/:id with an
  // authenticated session triggers supervisor.refresh. Because the response is
  // application/json with nosniff and no CORS allowance (no Access-Control-Allow-Origin),
  // cross-site callers cannot read the response body. The mutation in refresh is nil
  // (it only syncs cached conversation state to match ground truth observations) and
  // the compute cost is small (local tmux/registry query). We judge this safe to leave
  // without adding cross-site blocking on safe methods, preserving top-level and same-origin navigation.
  app.get("/api/conversations/:id", { preHandler: protectedHook }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail("bad_request", "Invalid conversation ID"));
    if (deps.supervisor) {
      const refreshed = await deps.supervisor.refresh(params.data.id);
      if (!refreshed) return reply.code(404).send(fail("not_found", "Conversation not found"));
      return ok(refreshed);
    }
    const conversation = await deps.store.getConversation(params.data.id);
    return conversation ? ok(conversation) : reply.code(404).send(fail("not_found", "Conversation not found"));
  });
  app.get("/api/conversations/:id/events", { preHandler: protectedHook }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail("bad_request", "Invalid conversation ID"));
    const query = listEventsQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send(fail("bad_request", "Invalid query parameters"));
    const conversation = await deps.store.getConversation(params.data.id);
    if (!conversation) return reply.code(404).send(fail("not_found", "Conversation not found"));
    const limit = query.data.limit;
    // V23-02: a timeline opens on the tail. With no cursor the newest page is
    // returned and `nextBefore` walks backwards; `after` keeps the forward contract
    // intact for consumers that page away from the oldest event.
    const backward = query.data.after === undefined;
    const rawEvents = backward
      ? await deps.store.listEventsTail(params.data.id, query.data.before ?? Number.POSITIVE_INFINITY, limit + 1)
      : await deps.store.listEvents(params.data.id, query.data.after ?? 0, limit + 1);
    const hasMore = rawEvents.length > limit;
    // Forward pages keep the oldest `limit` and page up; backward pages drop the
    // extra OLDEST row and keep the newest `limit`, since the extra row was read
    // from the past end of the window.
    const pageEvents = hasMore ? (backward ? rawEvents.slice(1) : rawEvents.slice(0, limit)) : rawEvents;
    const events = pageEvents.map((event) => ({
      seq: event.seq,
      type: event.type,
      ts: event.ts,
      payload: redactEventPayload(event.payload),
    }));
    if (backward) {
      const nextBefore = hasMore ? (events[0]?.seq ?? null) : null;
      return ok({ events, nextAfter: null, nextBefore });
    }
    const nextAfter = hasMore ? (events.at(-1)?.seq ?? null) : null;
    return ok({ events, nextAfter, nextBefore: null });
  });
  /**
   * Mint a room link for a conversation's live host.
   *
   * Server-to-server only in spirit: this response carries a bearer credential,
   * so it is `no-store`, never logged, and never cached. The link is bound to the
   * room generation observed while listing, so a session switch in that process
   * surfaces as `stale_generation` for the client to retry against a fresh list —
   * never as a link to a successor room the user did not ask for.
   */
  app.post("/api/conversations/:id/link", { preHandler: protectedHook }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail("bad_request", "Invalid conversation ID"));
    const query = linkQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send(fail("bad_request", "Invalid access query parameter: must be control or view"));
    const conversation = await deps.store.getConversation(params.data.id);
    if (!conversation) return reply.code(404).send(fail("not_found", "Conversation not found"));
    if (!deps.mintLink) return reply.code(501).send(fail("link_unavailable", "Live session linking is not configured."));
    try {
      reply.header("Cache-Control", "no-store");
      const link = await deps.mintLink(conversation, query.data.access);
      return ok(link);
    } catch (error) {
      const code = errorCode(error);
      if (code === "stale_generation") {
        return reply.code(409).send(fail("stale_generation", "The agent switched sessions; list the conversation again."));
      }
      if (code === "capability_missing") {
        return reply.code(409).send(fail("capability_missing", error instanceof Error ? String(redactLogValue(error.message)) : "Requested Collab access is unavailable."));
      }
      if (code === "link_unavailable" || code === "agent_not_running") {
        return reply.code(409).send(fail("link_unavailable", "No live agent is sharing this conversation right now."));
      }
      // Never surface an internal message here: it can contain a room URL.
      app.log.error({ conversationId: conversation.id }, "failed to mint a live session link");
      return reply.code(500).send(fail("internal", "Could not obtain a live session link."));
    }
  });
  /**
   * Deliver OMP's builtin `/handoff` to this conversation's live agent.
   *
   * The route owns every precondition; the adapter only proves the pane. Handoff
   * is a *keystroke* into a running TUI, so the two facts that make it safe are
   * checked here rather than assumed: the conversation must still own the tmux
   * server we recorded, and the registry must positively report the session idle.
   *
   * Absence of evidence is a refusal, never a pass: `null`/`unknown` for
   * `busy`/`inputRequired` refuses, because a paste into a session mid-turn is a
   * second writer by keystroke instead of by lease.
   *
   * The response is a *state*, not a success flag. Delivery is a paste landing
   * in a pane; recognition, generation, and the compaction append are three
   * further things OMP does afterwards, and only the journal can prove the last
   * one. So `delivered` never says "committed", and `committed` is returned only
   * with the native entry id that proves it (see `HandoffState`).
   */
  const handoffInFlight = new Set<string>();
  app.post("/api/conversations/:id/handoff", { preHandler: protectedHook }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail("bad_request", "Invalid conversation ID"));
    // `/handoff` takes no operand. A caller asking to focus something is asking
    // for keystrokes we deliberately cannot send, so it is refused by name rather
    // than silently dropped.
    const body = (request.body ?? {}) as { focus?: unknown; confirmDraftRisk?: unknown };
    if (body.focus !== undefined && body.focus !== null && body.focus !== "") {
      return reply.code(409).send(fail("capability_missing", "Only the bare /handoff command is supported; focus instructions are not."));
    }
    const conversation = await deps.store.getConversation(params.data.id);
    if (!conversation) return reply.code(404).send(fail("not_found", "Conversation not found"));
    if (conversation.ownership !== "managed") {
      return reply.code(409).send(fail("conflict_owner", "This session is externally managed; hand it off in its own terminal."));
    }
    if (!conversation.tmuxSessionId || !conversation.tmuxServerIdentity || conversation.tmuxPanePid === null) {
      return reply.code(409).send(fail("conflict_owner", "No verified managed tmux session is recorded for this conversation."));
    }
    if (!deps.sendHandoff) return reply.code(501).send(fail("capability_missing", "Handoff is not configured on this server."));
    if (!conversation.nativeSessionId) {
      return reply.code(409).send(fail("conflict_owner", "This conversation has no native session to hand off."));
    }

    const recordedIdentity = conversation.tmuxServerIdentity;
    const sessionId = conversation.tmuxSessionId;
    const panePid = conversation.tmuxPanePid;
    const nativeSessionId = conversation.nativeSessionId;
    const startedAt = Date.now();
    // Every cheap refusal returns *before* the durable marker is taken, so a
    // refusal can never create one: the client's designed draft flow answers
    // `draft_unconfirmed` and immediately re-asks with the acknowledgement, and a
    // marker taken on the first attempt would deny that retry for its whole
    // lifetime. Refusals must also not touch shared state, because clearing
    // another request's in-memory claim would admit a third paste.
    {
      if (!deps.tmuxServerIdentity) return reply.code(501).send(fail("capability_missing", "Handoff is not configured on this server."));
      let liveIdentity: string | null;
      try {
        liveIdentity = await deps.tmuxServerIdentity();
      } catch {
        return reply.code(409).send(fail("conflict_owner", "The live tmux server identity cannot be verified."));
      }
      if (liveIdentity !== recordedIdentity) {
        return reply.code(409).send(fail("conflict_owner", "The recorded tmux server identity is not the live one."));
      }
      // `session_attached === "0"` proves no terminal is attached *now*. It does
      // not prove the TUI's editor is empty: a human can attach, type an unsent
      // prompt and detach, and the draft stays in the pane. The paste splices at
      // the cursor, so without an explicit acknowledgement this is refused — the
      // operation must never silently overwrite a user's unsent words.
      //
      // OMP persists the editor's draft only on teardown (`saveDraft` is called
      // from `session-teardown.ts`), so there is no live on-disk draft to inspect
      // and no authoritative emptiness signal exists. Reading the rendered
      // composer would be exactly the guess AGENTS.md rule 6 forbids, so the
      // decision belongs to the user, taken with the risk stated. The check sits
      // here, after every precondition that can refuse on its own terms, so a
      // missing session or a foreign tmux server still answers `conflict_owner`.
      if (body.confirmDraftRisk !== true) {
        return reply.code(409).send(fail(
          "draft_unconfirmed",
          "Cannot verify the terminal editor is empty; a detached session may still hold an unsent draft. Re-send with confirmDraftRisk: true to paste anyway.",
        ));
      }
      // ── the operation window: from here on the marker is held ──────────────
      if (handoffInFlight.has(conversation.id)) {
        return reply.code(409).send(fail("handoff_in_flight", "A handoff is already in progress for this conversation."));
      }
      handoffInFlight.add(conversation.id);
      try {
        // A native handoff runs to completion inside OMP: the paste returns as
        // soon as the keystroke lands, but generation and the compaction append
        // happen after. The marker must outlive this request, so it is made
        // durable — an in-memory set would let a restart mid-handoff admit a
        // second paste onto a session OMP is still working in.
        //
        // Taking the marker can itself fail: the evidence read behind it touches
        // the sessions root, and a permission blip or transient I/O there is not
        // evidence that no handoff is generating. `recordHandoffStarted` reports
        // that as a refusal instead of throwing, so no exit from this route can
        // be ambiguous about whether the marker is held. Clearing on such a
        // failure would admit a second paste onto a session OMP may still be
        // compacting — the exact inversion this marker exists to prevent, and
        // strictly worse than having no marker at all.
        // ── the anchoring baseline ─────────────────────────────────────────
        // A refusal line is not self-dating: "Nothing to hand off" from an
        // earlier attempt can still be on screen, and reading it as *this*
        // paste's outcome would retire a marker on an operation that is still
        // generating — the exact inversion the marker exists to prevent. So one
        // read-only count is taken here, immediately before the paste, and only
        // a *rise* against it can ever mean `refused`. `null` (no reader, or an
        // unreadable pane) means no verdict may be drawn, ever.
        const baselineRefusals = await countRefusals(deps, sessionId);
        const marker = await recordHandoffStarted(conversation.id, nativeSessionId, sessionId, startedAt, baselineRefusals);
        if (marker !== "started") {
          app.log.warn({ conversationId: conversation.id, marker }, "handoff refused: the previous operation's marker is still standing");
          return reply.code(409).send(fail("handoff_in_flight", "A handoff is already generating for this conversation."));
        }
        // Past this point the marker is held and every exit either retires it
        // with evidence or leaves it standing for the next request to resolve.
        // Nothing in the failure paths clears it: the operation may already be
        // generating in the pane.
        const result = await deps.sendHandoff({
          sessionId,
          expectedIdentity: recordedIdentity,
          expectedPanePid: panePid,
          assertIdle: async () => {
            if (!deps.findLiveHost) return false;
            let host: CollabHost | null;
            try {
              host = await deps.findLiveHost(nativeSessionId);
            } catch {
              return false;
            }
            // Read-only rooms and unreported flags are not idle evidence.
            return host !== null && host.sessionId === nativeSessionId && host.access === "control" &&
              host.relayConnected === true && host.busy === false && host.inputRequired === false;
          },
        });
        if (result.delivered) {
          app.log.info({ conversationId: conversation.id }, "handoff delivered");
          // One bounded look for the native entry, so a handoff that really did
          // commit inside the budget is reported as committed — with its entry id
          // as the evidence. No compaction entry means `delivered`, never a
          // fabricated success, and never a re-typed paste.
          const evidence = await deps.readHandoffCompaction
            ? await awaitHandoffEvidence(nativeSessionId, startedAt, deps.handoffEvidenceBudgetMs ?? 0)
            : null;
          if (evidence) {
            // The operation is finished: retire the marker rather than leaving
            // the next reader to infer its end from the compaction it just saw.
            await clearHandoffMarker(conversation.id);
            app.log.info({ conversationId: conversation.id, entryId: evidence.entryId }, "handoff compaction observed");
            return ok({ state: "committed", paneId: result.paneId, compactionEntryId: evidence.entryId } satisfies HandoffResponse);
          }
          // No entry yet. That answer is the same whether OMP is still
          // generating or silently declined, so the pane's own refusal lines are
          // counted once more: strictly more than the baseline taken just before
          // *this* paste is evidence it never started, and retiring on it turns
          // "wait out the backstop for a retry" into "retry now". A stale warning
          // from an earlier attempt leaves the count unchanged, so it can never
          // earn the `refused` label; an unreadable pane or an absent baseline
          // leaves the marker, because neither is evidence of a refusal.
          if (await previousHandoffRefused({ refusalBaseline: baselineRefusals }, sessionId)) {
            await clearHandoffMarker(conversation.id);
            app.log.info({ conversationId: conversation.id }, "handoff refused by the agent; marker retired");
            return ok({ state: "delivered", paneId: result.paneId, refused: true } satisfies HandoffResponse);
          }
          return ok({ state: "delivered", paneId: result.paneId } satisfies HandoffResponse);
        }
        // The paste never landed, so nothing is generating and the marker goes.
        await clearHandoffMarker(conversation.id);
        if (result.refusal === "terminal_attached") {
          return reply.code(409).send(fail("terminal_attached", result.reason));
        }
        // Every other refusal says the recorded process is not the one we could
        // safely type into, so the client's move is to refresh, not to retry.
        return reply.code(409).send(fail("conflict_owner", result.reason));
      } catch (error) {
        // Deliberately no `clearHandoffMarker` here: a throw after the marker was
        // taken may mean the paste already reached a pane OMP is compacting now.
        // The marker stays; only evidence or the age backstop may retire it.
        const code = errorCode(error);
        if (code === "bad_request") return reply.code(400).send(fail("bad_request", String(redactLogValue(error instanceof Error ? error.message : "Invalid handoff request"))));
        app.log.error({ conversationId: conversation.id }, "handoff failed");
        return reply.code(500).send(fail("internal", "Could not deliver the handoff."));
      } finally {
        handoffInFlight.delete(conversation.id);
      }
    }
  });

  /**
   * The newest marker event for this conversation: the handoff operation is
   * "in progress" while the newest of `handoff-start` / `handoff-cancelled` is a
   * start, and "retired" when it is a cancellation. Scanning only for starts
   * would make `clearHandoffMarker` write-only dead code — the marker it retires
   * would still be found next time.
   *
   * The refusal baseline travels with the marker: it is the pane's refusal-line
   * count observed immediately before that operation's paste, and it is the only
   * thing that makes a later refusal line attributable to *that* paste. A marker
   * without one (written before this rule, or when the pane could not be read)
   * yields `null`, which callers must treat as "no verdict" rather than "zero".
   */
  async function latestHandoffMarker(conversationId: string): Promise<{ startedAt: number; refusalBaseline: number | null } | null> {
    // One uncapped lookup, not a fixed-size window over every event type: the
    // runtime writes many unrelated events into this same stream, and 50 of them
    // would hide a standing marker — which reads exactly like "no marker" and
    // admits a second paste. A read failure is NOT caught here: it must reach
    // `recordHandoffStarted`'s outer catch and become `unreadable`, because a
    // store we could not read is not evidence that no marker stands.
    const event = await deps.store.latestEventOfTypes<{ startedAt?: unknown; refusalBaseline?: unknown }>(conversationId, ["handoff-start", "handoff-cancelled"]);
    if (event === null || event.type === "handoff-cancelled") return null;
    const startedAt = event.payload?.startedAt;
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
    const baseline = event.payload?.refusalBaseline;
    return { startedAt, refusalBaseline: typeof baseline === "number" && Number.isFinite(baseline) ? baseline : null };
  }

  /**
   * Whether a fresh refusal count is evidence that the operation described by
   * `previous` refused.
   *
   * Fail-closed by construction: without the operation's own baseline, or without
   * a readable count now, nothing may be concluded — an absent baseline is never
   * read as "there were none before". Only a strict rise counts, so a refusal
   * line left on screen by an *earlier* handoff cannot retire this marker on its
   * own: the rise has to happen between the two reads. It cannot distinguish a
   * genuinely new refusal from a pre-existing line that scrolled into the
   * 40-line window in between, which is the documented ceiling on the counter
   * itself rather than a property of this comparison.
   */
  async function previousHandoffRefused(previous: { refusalBaseline: number | null }, sessionId: string): Promise<boolean> {
    if (previous.refusalBaseline === null) return false;
    const now = await countRefusals(deps, sessionId);
    return now !== null && now > previous.refusalBaseline;
  }

  /**
   * Take the durable, session-scoped handoff marker.
   *
   * Returns a three-way outcome rather than a boolean, because the route must
   * never confuse "a previous operation is still standing" with "I could not
   * find out". Both refuse; neither retires anything.
   *
   *  - `started` — no live marker was standing; a fresh one is recorded.
   *  - `in_flight` — a marker stands and its handoff has produced no matching
   *    native entry, so it may still be generating.
   *  - `unreadable` — the evidence read or the store write failed. Absence of
   *    evidence must never convert into permission to paste again, so this
   *    refuses too, and in particular never writes a `handoff-start` (which
   *    would replace the very marker we failed to evaluate).
   *
   * Three deliberate ceilings, each spelled out rather than hidden:
   *  - only *this* call takes a marker, and the route reaches it only after
   *    every cheap refusal returned, so a refusal can never create one.
   *  - it is only consulted when we can read native evidence. Without that
   *    reader a durable marker could never be cleared, so a restart would brick
   *    handoff forever; refusing on an unverifiable marker is worse than the
   *    concurrency it prevents, and the in-memory set still covers this process.
   *  - a marker older than `HANDOFF_MARKER_TTL_MS` is abandoned. It is the last
   *    resort for one genuinely ambiguous case — `delivered` with no compaction
   *    entry and no observable refusal in the pane — and it is a ceiling on a
   *    *guess*, so it is set above every observed generation, not below it. The
   *    common case does not wait it out: an explicit refusal retires the marker
   *    in one round trip.
   */
  async function recordHandoffStarted(conversationId: string, nativeSessionId: string, sessionId: string, startedAt: number, refusalBaseline: number | null): Promise<"started" | "in_flight" | "unreadable"> {
    if (!deps.readHandoffCompaction) return "started";
    let previous: { startedAt: number; refusalBaseline: number | null } | null;
    try {
      previous = await latestHandoffMarker(conversationId);
      if (previous !== null && startedAt - previous.startedAt < HANDOFF_MARKER_TTL_MS) {
        const evidence = await deps.readHandoffCompaction(nativeSessionId, previous.startedAt);
        if (evidence) {
          // The previous operation is provably over; its marker is retired
          // before the new one is taken.
          await clearHandoffMarker(conversationId);
        } else {
          // No entry yet, but the pane may state a refusal that is attributable
          // to *that* operation — strictly more refusal lines than its own
          // baseline recorded, measured now. A refusal also ends it; anything
          // else (a stale line, an absent baseline, or an unreadable pane) keeps
          // refusing, because none of those is evidence that it is over.
          if (!(await previousHandoffRefused(previous, sessionId))) return "in_flight";
          await clearHandoffMarker(conversationId);
        }
      }
      await deps.store.recordEvent(conversationId, "handoff-start", { sessionId: nativeSessionId, startedAt, refusalBaseline }, new Date(startedAt).toISOString());
      return "started";
    } catch {
      return "unreadable";
    }
  }

  /**
   * Retire the marker for a handoff that never reached the pane, or whose
   * operation finished. Written as its own event rather than a delete because the
   * store's journal is append-only.
   */
  async function clearHandoffMarker(conversationId: string): Promise<void> {
    if (!deps.readHandoffCompaction) return;
    await deps.store.recordEvent(conversationId, "handoff-cancelled", {}, new Date().toISOString());
  }

  /**
   * Look for the native compaction entry for at most `budgetMs`, then give up.
   *
   * Cancellable and bounded by construction, and it never *asserts* completion:
   * running out of budget is `delivered`. A real handoff generation was observed
   * taking minutes in the owner's journals, so the default budget is small on
   * purpose — it exists to catch a handoff that committed immediately, not to
   * hold the request open until one finishes.
   */
  async function awaitHandoffEvidence(sessionId: string, sinceMs: number, budgetMs: number): Promise<NativeHandoffCompaction | null> {
    const deadline = Date.now() + Math.max(0, budgetMs);
    for (;;) {
      const evidence = await deps.readHandoffCompaction!(sessionId, sinceMs);
      if (evidence) return evidence;
      if (Date.now() >= deadline) return null;
      await setTimeout(HANDOFF_EVIDENCE_POLL_MS);
    }
  }
  async function attachInstructions(conversation: Conversation) {
    const base = { conversationId: conversation.id, tmuxSessionName: conversation.tmuxSessionName };
    if (conversation.ownership !== "managed" || !conversation.tmuxSessionId) {
      return { ...base, available: false, command: null, reason: "No managed tmux session is available." };
    }
    if (!conversation.tmuxServerIdentity || !deps.tmuxServerIdentity || !deps.tmuxSocketPath) {
      return { ...base, available: false, command: null, reason: "The tmux server identity cannot be verified." };
    }
    let liveIdentity: string | null;
    try {
      liveIdentity = await deps.tmuxServerIdentity();
    } catch {
      return { ...base, available: false, command: null, reason: "The live tmux server identity cannot be verified." };
    }
    if (liveIdentity !== conversation.tmuxServerIdentity) {
      return { ...base, available: false, command: null, reason: "The recorded tmux server identity does not match the live server." };
    }
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return { ...base, available: true, command: `tmux -S ${quote(deps.tmuxSocketPath)} attach -t ${quote(conversation.tmuxSessionId)}`, reason: null };
  }
  app.get("/api/conversations/:id/attach", { preHandler: protectedHook }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail("bad_request", "Invalid conversation ID"));
    const conversation = await deps.store.getConversation(params.data.id);
    if (!conversation) return reply.code(404).send(fail("not_found", "Conversation not found"));
    return ok(await attachInstructions(conversation));
  });
  app.patch("/api/conversations/:id/model", { preHandler: protectedHook }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = conversationModelSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send(fail("bad_request", "Invalid conversation model"));
    const conversation = await deps.store.updateConversation(params.data.id, { modelPreference: body.data.model });
    return conversation ? ok(conversation) : reply.code(404).send(fail("not_found", "Conversation not found"));
  });
  app.post("/api/conversations/:id/actions", { preHandler: protectedHook }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const action = conversationActionSchema.safeParse(request.body);
    const attach = attachRequest.safeParse(request.body);
    if (!params.success || (!action.success && !attach.success)) return reply.code(400).send(fail("bad_request", "Invalid conversation action"));
    if (attach.success) {
      const conversation = await deps.store.getConversation(params.data.id);
      if (!conversation) return reply.code(404).send(fail("not_found", "Conversation not found"));
      return ok(await attachInstructions(conversation));
    }
    if (!action.success) return reply.code(400).send(fail("bad_request", "Invalid conversation action"));
    if (!deps.supervisor) return reply.code(501).send(fail("capability_missing", "Conversation lifecycle runtime is not configured"));
    try {
      let conversation: Conversation;
      if (action.data.action === "stop") conversation = await deps.supervisor.stop(params.data.id);
      else {
        const current = await deps.store.getConversation(params.data.id);
        if (!current) return reply.code(404).send(fail("not_found", "Conversation not found"));
        if (current.ownership !== "managed") return reply.code(409).send(fail("conflict_owner", "This session is externally managed and cannot be restarted here."));
        if (current.tmuxSessionId && !current.tmuxServerIdentity) return reply.code(409).send(fail("conflict_owner", "Managed tmux identity cannot be verified; refusing to restart this session."));
        if (current.nativeSessionPath && !current.nativeSessionId) return reply.code(409).send(fail("conflict_owner", "The recorded session journal has no native session ID; refusing to restart without its history."));
        const runtimeSpec = deps.runtimeSpec;
        if (!runtimeSpec) return reply.code(501).send(fail("capability_missing", "Conversation lifecycle runtime is not configured"));
        const spec = await runtimeSpec(current, { resumeSessionId: current.nativeSessionId ?? undefined, model: current.modelPreference ?? current.model ?? undefined });
        if (current.state !== "stopped" && current.tmuxSessionId && current.ownership === "managed") await deps.supervisor.stop(current.id);
        conversation = await deps.supervisor.start(current.id, spec);
      }
      return ok(conversation);
    } catch (error) {
      const code = runtimeErrorCode(error);
      return reply.code(code === "internal" ? 500 : code === "not_found" ? 404 : code === "path_forbidden" ? 403 : 409).send(fail(code, String(redactLogValue(error instanceof Error ? error.message : "Conversation action failed"))));
    }
  });
  app.get("/api/models", { preHandler: protectedHook }, async () => {
    const result = deps.modelCatalog
      ? await deps.modelCatalog.listModelsDetailed()
      : { models: [], source: "unavailable" as const, reason: "OMP model catalog is not configured." };
    return ok(result);
  });

  app.get("/api/runtime", { preHandler: protectedHook }, async () => {
    const result = deps.supervisor ? await deps.supervisor.activeCount() : { count: 0, known: false, reason: "Conversation lifecycle runtime is not configured." };
    return ok({ capabilities: await capabilities(), activeCount: result.known ? result.count : null, activeCountReason: result.known ? null : result.reason, maxActive: deps.config.maxActiveAgents, conversations: await deps.store.listAllConversations() });
  });
  return app;
}

function pathError(reply: HttpReply, error: unknown) {
  if (error instanceof DuplicateProjectPathError) return reply.code(409).send(fail("already_exists", error.message));
  if (error instanceof PathPolicyError) {
    const status = error.code === "path_forbidden" ? 403 : error.code === "path_not_found" ? 404 : error.code === "already_exists" ? 409 : 400;
    return reply.code(status).send(fail(error.code, error.message));
  }
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const message = code === "EACCES" || code === "EPERM"
    ? "Permission denied while accessing workspace path"
    : code === "EIO" ? "Filesystem I/O error while accessing workspace path" : "Unable to access workspace path";
  return reply.code(500).send(fail("internal", message));
}

function runtimeErrorCode(error: unknown): ErrorCode {
  const code = error && typeof error === "object" && "code" in error ? error.code : "internal";
  if (typeof code === "string" && ERROR_CODES.includes(code as ErrorCode)) return code as ErrorCode;
  return "internal";
}
