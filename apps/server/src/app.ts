import type { Server as HttpServer } from "node:http";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type RouteGenericInterface } from "fastify";
import { browseQuerySchema, conversationActionSchema, conversationModelSchema, createConversationSchema, createProjectSchema, ERROR_CODES, fail, listEventsQuerySchema, loginSchema, ok, updateProjectSchema } from "@caw/contracts";
import { z } from "zod";
import type { Capabilities, CollabLinkResponse, Conversation, ErrorCode, NativeSessionSummary } from "@caw/contracts";
import type { CapabilityService } from "@caw/omp-adapter";
import type { Supervisor, RuntimeLaunchSpec } from "@caw/runtime";
import type { AuthenticationService } from "./auth.js";
import { resolve } from "node:path";
import { findRepoRoot, resolveDistDir, type ServerConfig } from "./config.js";
import { registerStaticWeb } from "./static-web.js";
import { createLogger, redactEventPayload, redactLogValue } from "./logger.js";
import { PathPolicyError, WorkspacePathPolicy } from "./path-policy.js";
import type { MetadataStore } from "./store.js";

export interface AppDependencies {
  config: ServerConfig;
  auth: AuthenticationService;
  store: MetadataStore;
  paths?: WorkspacePathPolicy;
  capabilities?: CapabilityService;
  supervisor?: Supervisor;
  originAllowlist?: string[];
  runtimeSpec?: (conversation: Conversation, input: { resumeSessionId?: string; model?: string; allowMissingResumeSession?: boolean }) => Promise<RuntimeLaunchSpec> | RuntimeLaunchSpec;
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
  listNativeSessions?: (conversation: { projectPath: string }) => Promise<NativeSessionSummary[]>;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const BODY_LIMIT = 64 * 1024;

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
type HttpRequest = FastifyRequest<RouteGenericInterface, HttpServer>;
type HttpReply = FastifyReply<RouteGenericInterface, HttpServer>;
type RequestWithAuth = HttpRequest & { cawSession?: { csrfToken: string; expiresAt: number }; cawToken?: string };
const idParams = z.object({ id: z.string().min(1).max(128) });
const conversationRequest = createConversationSchema.omit({ projectId: true });
const attachRequest = z.object({ action: z.literal("attach") });
const linkQuerySchema = z.object({ access: z.enum(["control", "view"]).default("control") });

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
  const paths = deps.paths ?? new WorkspacePathPolicy(deps.config.allowedRoots);
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
    const isApi = pathname === "/api" || pathname.startsWith("/api/");
    const isLogin = pathname === "/api/auth/login";
    if (isApi && !isLogin && !req.cawSession) {
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
    if (!(await deps.auth.verifyPassword(parsed.data.password, request.ip))) return reply.code(401).send(fail("unauthorized", "Invalid password"));
    const session = deps.auth.createSession();
    reply.header("Set-Cookie", deps.auth.cookie(session.token, Math.floor((session.expiresAt - Date.now()) / 1000)));
    return ok({ csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
  });
  app.post("/api/auth/logout", { preHandler: protectedHook }, async (_request, reply) => {
    deps.auth.revokeAll();
    reply.header("Set-Cookie", deps.auth.clearCookie());
    return ok({ loggedOut: true });
  });
  app.get("/api/auth/me", { preHandler: protectedHook }, async (request) => ok({ csrfToken: withAuth(request).cawSession!.csrfToken }));
  app.get("/api/capabilities", { preHandler: protectedHook }, async () => ok(await capabilities()));
  app.get("/api/projects", { preHandler: protectedHook }, async () => ok(await deps.store.listProjects()));
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
    const deleted = await deps.store.deleteProject(params.data.id);
    return deleted ? ok({ deleted: true, filesRemoved: false }) : reply.code(404).send(fail("not_found", "Project not found"));
  });
  app.get("/api/projects/:id/sessions", { preHandler: protectedHook }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail("bad_request", "Invalid project ID"));
    const project = (await deps.store.listProjects()).find((item) => item.id === params.data.id);
    if (!project) return reply.code(404).send(fail("not_found", "Project not found"));
    if (!deps.listNativeSessions) return ok([] as NativeSessionSummary[]);
    try {
      return ok(await deps.listNativeSessions({ projectPath: project.path }));
    } catch (error) {
      return pathError(reply, error);
    }
  });
  app.get("/api/browse", { preHandler: protectedHook }, async (request, reply) => {
    const parsed = browseQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(fail("bad_request", "Invalid browse query"));
    try { return ok(await paths.listDirectory(parsed.data.path)); } catch (error) { return pathError(reply, error); }
  });
  app.get("/api/projects/:id/conversations", { preHandler: protectedHook }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail("bad_request", "Invalid project ID"));
    return ok(await deps.store.listConversations(params.data.id));
  });
  app.post("/api/projects/:id/conversations", { preHandler: protectedHook }, async (request, reply) => {
    if (!deps.supervisor || !deps.runtimeSpec) return reply.code(501).send(fail("capability_missing", "Conversation lifecycle runtime is not configured"));
    const params = idParams.safeParse(request.params);
    const body = conversationRequest.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send(fail("bad_request", "Invalid conversation request"));
    const project = (await deps.store.listProjects()).find((item) => item.id === params.data.id);
    if (!project) return reply.code(404).send(fail("not_found", "Project not found"));
    const conversation = await deps.store.createConversation({ projectId: project.id, title: body.data.title, nativeSessionId: body.data.resumeSessionId });
    try {
      const spec = await deps.runtimeSpec(conversation, { resumeSessionId: body.data.resumeSessionId });
      return reply.code(201).send(ok(await deps.supervisor.start(conversation.id, spec)));
    } catch (error) {
      const code = runtimeErrorCode(error);
      await deps.store.updateConversation(conversation.id, { state: "error", statusDetail: error instanceof Error ? String(redactLogValue(error.message)) : "Agent launch failed." });
      return reply.code(code === "internal" ? 500 : code === "not_found" ? 404 : 409).send(fail(code, "Agent launch failed"));
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
    const afterSeq = query.data.after ?? 0;
    const limit = query.data.limit;
    const rawEvents = await deps.store.listEvents(params.data.id, afterSeq, limit + 1);
    const hasMore = rawEvents.length > limit;
    const pageEvents = hasMore ? rawEvents.slice(0, limit) : rawEvents;
    const events = pageEvents.map((event) => ({
      seq: event.seq,
      type: event.type,
      ts: event.ts,
      payload: redactEventPayload(event.payload),
    }));
    const nextAfter = hasMore ? (events.at(-1)?.seq ?? null) : null;
    return ok({ events, nextAfter });
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
      if (code === "link_unavailable" || code === "agent_not_running") {
        return reply.code(409).send(fail("link_unavailable", "No live agent is sharing this conversation right now."));
      }
      // Never surface an internal message here: it can contain a room URL.
      app.log.error({ conversationId: conversation.id }, "failed to mint a live session link");
      return reply.code(500).send(fail("internal", "Could not obtain a live session link."));
    }
  });
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
        if (!deps.runtimeSpec) return reply.code(501).send(fail("capability_missing", "Conversation launch configuration is not available"));
        const spec = await deps.runtimeSpec(current, { resumeSessionId: current.nativeSessionId ?? undefined, model: current.modelPreference ?? current.model ?? undefined, allowMissingResumeSession: true });
        if (current.state !== "stopped" && current.tmuxSessionId && current.ownership === "managed") await deps.supervisor.stop(current.id);
        conversation = await deps.supervisor.start(current.id, spec);
      }
      return ok(conversation);
    } catch (error) {
      const code = runtimeErrorCode(error);
      return reply.code(code === "internal" ? 500 : code === "not_found" ? 404 : 409).send(fail(code, String(redactLogValue(error instanceof Error ? error.message : "Conversation action failed"))));
    }
  });
  app.get("/api/runtime", { preHandler: protectedHook }, async () => {
    const result = deps.supervisor ? await deps.supervisor.activeCount() : { count: 0, known: false, reason: "Conversation lifecycle runtime is not configured." };
    return ok({ capabilities: await capabilities(), activeCount: result.known ? result.count : null, activeCountReason: result.known ? null : result.reason, maxActive: deps.config.maxActiveAgents, conversations: await deps.store.listAllConversations() });
  });
  return app;
}

function pathError(reply: HttpReply, error: unknown) {
  if (error instanceof PathPolicyError) {
    const status = error.code === "path_forbidden" ? 403 : error.code === "path_not_found" ? 404 : 400;
    return reply.code(status).send(fail(error.code, error.message));
  }
  return reply.code(400).send(fail("path_not_found", "Unable to resolve workspace path"));
}

function runtimeErrorCode(error: unknown): ErrorCode {
  const code = error && typeof error === "object" && "code" in error ? error.code : "internal";
  if (typeof code === "string" && ERROR_CODES.includes(code as ErrorCode)) return code as ErrorCode;
  return "internal";
}
