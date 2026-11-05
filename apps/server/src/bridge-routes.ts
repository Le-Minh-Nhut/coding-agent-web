/**
 * The CAW→OMP vibe bridge, over HTTP.
 *
 * `GET` reports what a live session's own `ctx.sessionModes` says; `POST`
 * forwards actuation. Both go through the same preconditions the handoff route
 * uses, because both are asking a *running* session about itself: a conversation
 * we do not own, whose tmux identity we cannot verify, or whose recorded process
 * is gone has no bridge worth talking to whatever a leftover config file says.
 *
 * The two failure kinds are kept rigorously apart:
 *   - "I could not ask" → `bridge_unavailable` (503) or `conflict_owner` (409).
 *     Never `off`; a listener that never came up looks exactly like a mode that
 *     is inactive, and reporting the second when the first is true is the guess
 *     AGENTS.md rule 6 forbids.
 *   - "it answered, and the answer was a refusal" → HTTP 200 carrying OMP's own
 *     `{ ok: false, code: "conflict" }`. That is a successful exchange, and
 *     re-encoding it as an HTTP error would lose the state that explains it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteGenericInterface } from "fastify";
import type { Server as HttpServer } from "node:http";
import { z } from "zod";
import { fail, ok } from "@caw/contracts";
import type { NativeModeResult, NativeModeState, VibeStateResponse } from "@caw/contracts";
import { BridgeClient, readBridgeConfig } from "@caw/omp-adapter";
import type { BridgeModeResult } from "@caw/omp-adapter";
import type { Conversation } from "@caw/contracts";
import type { MetadataStore } from "./store.js";

type HttpRequest = FastifyRequest<RouteGenericInterface, HttpServer>;

export interface BridgeRouteDependencies {
  store: MetadataStore;
  /** Live private tmux server identity; `null`/throw means it cannot be verified. */
  tmuxServerIdentity?: () => Promise<string | null>;
  /** Directory holding per-conversation bridge configs (the overlay dir). Unset → no bridge. */
  bridgeConfigDir?: string;
  /** The app's session guard; every route here is owner-only, like the conversation routes. */
  preHandler?: (request: HttpRequest, reply: FastifyReply) => Promise<unknown>;
}

const idParams = z.object({ id: z.string().min(1).max(128) });
const modeBody = z.object({ action: z.enum(["enter", "exit"]) }).strict();

/** OMP's own snake_case codes onto the contract's union; anything else is "the answer carried nothing we can act on". */
function normalizeCode(code: string | null | undefined): NativeModeResult["code"] {
  return code === "busy" || code === "conflict" || code === "disabled" || code === "invalid_request" ? code : null;
}

function normalizeState(state: BridgeModeResult["state"]): NativeModeState | null {
  if (!state || typeof state !== "object") return null;
  const status = (slot: unknown): string | null => {
    const value = (slot as { status?: unknown } | null)?.status;
    return typeof value === "string" ? value : null;
  };
  const plan = status(state.plan);
  const vibe = status(state.vibe);
  const goal = status(state.goal);
  const loop = status(state.loop);
  // All four slots or nothing: a half-read state is a different claim from a
  // fully-read one, and the only fully-read claim this route makes is `NativeModeState`.
  if (plan === null || vibe === null || goal === null || loop === null) return null;
  const planStatus = plan as NativeModeState["plan"]["status"];
  const vibeStatus = vibe as NativeModeState["vibe"]["status"];
  const goalStatus = goal as NativeModeState["goal"]["status"];
  const loopStatus = loop as NativeModeState["loop"]["status"];
  return { plan: { status: planStatus }, vibe: { status: vibeStatus }, goal: { status: goalStatus }, loop: { status: loopStatus } };
}

function normalizeResult(result: BridgeModeResult): NativeModeResult {
  return {
    ok: result.ok === true,
    code: normalizeCode(result.code),
    message: typeof result.message === "string" ? result.message : null,
    state: normalizeState(result.state),
  };
}

/**
 * The refusal vocabulary for "no conversation to talk to", in the handoff
 * route's order: nothing found, not ours, no verified identity, identity not
 * live. Each is its own answer because the client's next move differs.
 */
type PreconditionResult =
  | { ok: true; conversation: Conversation }
  | { ok: false; status: 404 | 409; message: string };

async function precondition(deps: BridgeRouteDependencies, conversation: Conversation | null): Promise<PreconditionResult> {
  if (!conversation) return { ok: false, status: 404, message: "Conversation not found" };
  if (conversation.ownership !== "managed") {
    return { ok: false, status: 409, message: "This session is externally managed; its modes are driven in its own terminal." };
  }
  if (!conversation.tmuxSessionId || !conversation.tmuxServerIdentity || conversation.tmuxPanePid === null) {
    return { ok: false, status: 409, message: "No verified managed tmux session is recorded for this conversation." };
  }
  if (!deps.tmuxServerIdentity) return { ok: false, status: 409, message: "The live tmux server identity cannot be verified." };
  let liveIdentity: string | null;
  try {
    liveIdentity = await deps.tmuxServerIdentity();
  } catch {
    return { ok: false, status: 409, message: "The live tmux server identity cannot be verified." };
  }
  // A recorded `$N` is only meaningful against the server that minted it — the same
  // rule the handoff route applies before it types into a pane.
  if (liveIdentity !== conversation.tmuxServerIdentity) {
    return { ok: false, status: 409, message: "The recorded tmux server identity is not the live one." };
  }
  return { ok: true, conversation };
}

type ClientResult = { client: BridgeClient } | { reason: string };

async function clientFor(deps: BridgeRouteDependencies, conversationId: string): Promise<ClientResult> {
  if (!deps.bridgeConfigDir) {
    return { reason: "This server has no bridge config directory configured." };
  }
  const config = await readBridgeConfig(deps.bridgeConfigDir, conversationId);
  if (!config) {
    // The honest pre-bridge answer: no listener was ever configured for this
    // conversation, which is what a session started before the bridge exists
    // looks like. It becomes available when the session restarts.
    return { reason: "No control bridge is configured for this session. Restart the agent to attach one." };
  }
  return { client: new BridgeClient({ port: config.port, token: config.token }) };
}

export function registerBridgeRoutes(app: FastifyInstance<HttpServer>, deps: BridgeRouteDependencies): void {
  const inFlight = new Set<string>();
  const options = deps.preHandler ? { preHandler: deps.preHandler } : {};

  app.get("/api/conversations/:id/vibe", options, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail("bad_request", "Invalid conversation ID"));
    const verdict = await precondition(deps, await deps.store.getConversation(params.data.id));
    if (!verdict.ok) return reply.code(verdict.status).send(verdict.status === 404 ? fail("not_found", verdict.message) : fail("conflict_owner", verdict.message));
    const resolved = await clientFor(deps, verdict.conversation.id);
    if ("reason" in resolved) {
      // HTTP 200 with `available: false`: "I could not ask" is an answer the panel
      // renders, and an error status would push the caller into inventing copy for
      // a state the server already knows.
      return ok<VibeStateResponse>({ available: false, reason: resolved.reason, modes: null, tools: null, model: null, thinkingLevel: null });
    }
    const state = await resolved.client.readState();
    if (!state.ok) {
      return ok<VibeStateResponse>({ available: false, reason: `The bridge did not answer (${state.reason}).`, modes: null, tools: null, model: null, thinkingLevel: null });
    }
    return ok<VibeStateResponse>({
      available: true,
      reason: null,
      modes: normalizeState(state.state.modes),
      tools: state.state.tools,
      model: state.state.model,
      thinkingLevel: state.state.thinkingLevel,
    });
  });

  app.post("/api/conversations/:id/vibe", options, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail("bad_request", "Invalid conversation ID"));
    const body = modeBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send(fail("bad_request", 'Body must be { action: "enter" | "exit" }.'));
    const verdict = await precondition(deps, await deps.store.getConversation(params.data.id));
    if (!verdict.ok) return reply.code(verdict.status).send(verdict.status === 404 ? fail("not_found", verdict.message) : fail("conflict_owner", verdict.message));
    const id = verdict.conversation.id;
    // Claimed before the first await that can yield, so two requests racing here
    // cannot both pass the check: a duplicate is refused, never queued behind the
    // first one's transition.
    if (inFlight.has(id)) {
      return reply.code(409).send(fail("conflict_owner", "A mode change is already in progress for this conversation."));
    }
    inFlight.add(id);
    try {
      const resolved = await clientFor(deps, id);
      if ("reason" in resolved) return reply.code(503).send(fail("bridge_unavailable", resolved.reason));
      const outcome = await resolved.client.setMode({ mode: "vibe", action: body.data.action });
      if (!outcome.ok) return reply.code(503).send(fail("bridge_unavailable", `The bridge did not answer (${outcome.reason}).`));
      // Verbatim: OMP's refusal is the answer, and the state it carries is what
      // makes it actionable. The route adds nothing and removes nothing.
      return ok(normalizeResult(outcome.result));
    } finally {
      inFlight.delete(id);
    }
  });
}
