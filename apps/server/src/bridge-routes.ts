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
  /** Worker ids proven from the conversation's journal, for the Kill gate. */
  readVibeWorkers?: (sessionId: string) => Promise<{ ids: string[]; timestamp: string | null }>;
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


/**
 * Does the bridge answer belong to the conversation that asked?
 *
 * The bridge is bound to a process; the process can switch sessions (`/resume`,
 * session switch), and a mode change aimed at conversation A would then mutate
 * whatever session B the TUI has moved on to. Process identity cannot answer
 * that question, so the bridge reports the session id it is attached to and this
 * is the comparison.
 *
 * Fails closed on every uncertain case: an unreadable id (`null`), or a
 * conversation that has no recorded native session, is a refusal — "I could not
 * check" is not "it matches".
 */
function sessionMismatch(conversation: { nativeSessionId: string | null }, bridgeSessionId: string | null): string | null {
  if (conversation.nativeSessionId === null || conversation.nativeSessionId === "") {
    return "This conversation has no recorded native session, so a bridge answer cannot be attributed to it.";
  }
  if (bridgeSessionId === null) {
    return "The bridge did not report which native session it serves, so it cannot be attributed to this conversation.";
  }
  if (bridgeSessionId !== conversation.nativeSessionId) {
    return "The bridge is serving a different native session than this conversation; the terminal may have switched sessions.";
  }
  return null;
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


/**
 * Worker ids for a conversation, or an empty list.
 *
 * Reads the journal directly rather than the wire: `vibe-session-lifecycle` is a
 * `custom` entry, and Collab's replication allowlist excludes those, so this
 * browser-facing route is the only place the evidence can enter the UI.
 *
 * Every failure path returns `[]`. An empty list disables the worker controls, so
 * a reader that is missing, slow, or unreadable degrades the UI to read-only —
 * never to "everything is a worker".
 */
async function workerIdsFor(deps: BridgeRouteDependencies, nativeSessionId: string | null): Promise<string[]> {
  if (!deps.readVibeWorkers || nativeSessionId === null || nativeSessionId === "") return [];
  try {
    return (await deps.readVibeWorkers(nativeSessionId)).ids;
  } catch {
    return [];
  }
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
      return ok<VibeStateResponse>({ available: false, reason: resolved.reason, modes: null, tools: null, model: null, thinkingLevel: null, workerIds: [] });
    }
    const state = await resolved.client.readState();
    if (!state.ok) {
      return ok<VibeStateResponse>({ available: false, reason: `The bridge did not answer (${state.reason}).`, modes: null, tools: null, model: null, thinkingLevel: null, workerIds: [] });
    }
    // A bridge that answers for a session this conversation does not own is not a
    // state we may show: rendering it would attribute another session's mode to
    // this row. Reported as unavailable with the reason, never as a state.
    const mismatch = sessionMismatch(verdict.conversation, state.state.sessionId);
    if (mismatch !== null) {
      return ok<VibeStateResponse>({ available: false, reason: mismatch, modes: null, tools: null, model: null, thinkingLevel: null, workerIds: [] });
    }
    return ok<VibeStateResponse>({
      available: true,
      reason: null,
      modes: normalizeState(state.state.modes),
      tools: state.state.tools,
      model: state.state.model,
      thinkingLevel: state.state.thinkingLevel,
      workerIds: await workerIdsFor(deps, verdict.conversation.nativeSessionId),
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
      // Verify identity BEFORE mutating anything: a mode change is a write, and a
      // write must never be attributed to a session that may not be this one.
      const identity = await resolved.client.readState();
      if (!identity.ok) return reply.code(503).send(fail("bridge_unavailable", `The bridge did not answer (${identity.reason}).`));
      const mismatch = sessionMismatch(verdict.conversation, identity.state.sessionId);
      if (mismatch !== null) return reply.code(409).send(fail("conflict_owner", mismatch));
      const outcome = await resolved.client.setMode({ mode: "vibe", action: body.data.action });
      if (!outcome.ok) {
        // B06: a timeout is not evidence that the transition failed. The request
        // may have reached OMP and still be running — a worker cancellation takes
        // as long as it takes. So the state is re-read once before answering:
        // if the mode reflects the requested change, that is the answer; if it
        // does not, the honest report is that the outcome is unknown, not that it
        // failed. Either way the caller is never told "no" on a guess.
        const after = await resolved.client.readState();
        if (after.ok) {
          const wanted = body.data.action === "enter" ? "active" : "inactive";
          if (after.state.modes?.vibe.status === wanted) {
            return ok(normalizeResult({ ok: true, changed: true, state: after.state.modes }));
          }
        }
        return reply.code(503).send(fail(
          "bridge_unavailable",
          `The bridge did not answer in time (${outcome.reason}), and the current mode does not yet show the change. The transition may still be running; re-read the state rather than assuming it failed.`,
        ));
      }
      // Re-verify AFTER the write. The check above happens before `setMode`, and a
      // `/resume` inside the same TUI between the two would mutate the session the
      // process moved to. Re-reading narrows that window to nothing observable and
      // reports the attribution problem rather than returning a success that
      // belongs to another session. It cannot make the window impossible — only a
      // session-scoped transport could — so it is reported as a refusal, not
      // hidden.
      const settled = await resolved.client.readState();
      if (settled.ok) {
        const drifted = sessionMismatch(verdict.conversation, settled.state.sessionId);
        if (drifted !== null) return reply.code(409).send(fail("conflict_owner", drifted));
      }
      // Verbatim: OMP's refusal is the answer, and the state it carries is what
      // makes it actionable. The route adds nothing and removes nothing.
      return ok(normalizeResult(outcome.result));
    } finally {
      inFlight.delete(id);
    }
  });
}
