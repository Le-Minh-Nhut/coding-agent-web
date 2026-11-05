/**
 * CAW's control bridge, loaded INSIDE the live OMP TUI process.
 *
 * OMP loads this file as an extension (overlay `extensions:` or `--extension`),
 * so it runs in the same process as the session it reports on — the only place
 * `ctx.sessionModes` exists at all. CAW allocates the loopback port and mints the
 * token at launch and passes both through the environment; with either missing
 * this module does nothing, because binding a guessed port would be a listener
 * nobody asked for.
 *
 * Plain ESM JavaScript with no imports of the host's own modules: OMP imports
 * extension entry files with Bun's loader, whose `getLoader()` maps `.mjs` to
 * `js` (`extensibility/plugins/legacy-pi-compat.ts:2765`), so a file with no
 * build step cannot drift from what OMP actually executes.
 *
 * Loopback only. The token is the only thing separating this session's modes
 * from any other local process, so every request is authenticated before it is
 * routed — including the ones that only read.
 */
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN_HEADER = "x-caw-bridge-token";
const MAX_BODY_BYTES = 4096;

/** The one listener this process owns. A second session in the same process shares it. */
let listening = null;

/**
 * Bind failures and handler faults are reported here, never swallowed: a bridge
 * that did not come up looks exactly like a bridge that is not wanted, and only
 * this file knows the difference.
 */
function log(message) {
  try {
    appendFileSync(
      process.env.CAW_BRIDGE_LOG ?? join(tmpdir(), "caw-bridge.log"),
      `${new Date().toISOString()} [caw-bridge] ${message}\n`,
    );
  } catch {
    // A log we cannot write must never take the session down with it.
  }
}

function authorized(header, token) {
  if (typeof header !== "string") return false;
  const supplied = Buffer.from(header, "utf8");
  const expected = Buffer.from(token, "utf8");
  // Length first: `timingSafeEqual` throws on unequal buffers, and a throwing
  // auth check is a crash, not a refusal.
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function refuse(res, status, code, message) {
  send(res, status, { ok: false, code, message });
}

/**
 * One runtime fact, or its fallback. A missing surface is `null`, never a 500 —
 * and a *throwing* one (an uninitialized action stub) is the same thing.
 */
function read(fn, fallback) {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/**
 * Where a fact lives.
 *
 * `pi.runtime` is the shared action object the extension API delegates to, and
 * reading it avoids the API's own bound wrappers; `pi` itself is the documented
 * surface (`docs/extensions.md`, `ExtensionAPI.getActiveTools()`). Both are tried
 * because a rebuilt host may expose only one, and neither is a guess: an absent
 * surface reads as `null`, which the route reports as `available: true` with
 * `tools: null` rather than inventing a tool list.
 *
 * The model is *not* on either: `ExtensionActions` has `setModel` but no
 * `getModel` (`extensibility/extensions/types.ts:2345`), while the current model
 * is the context getter `ctx.model` (`types.ts:2356`). So it is read from `ctx`.
 */
function firstOf(candidates) {
  for (const candidate of candidates) {
    const value = read(candidate, undefined);
    if (value !== undefined) return value;
  }
  return undefined;
}

function runtimeSnapshot(pi, ctx) {
  const runtime = pi && typeof pi === "object" ? pi.runtime : undefined;
  const tools = firstOf([
    () => (typeof runtime?.getActiveTools === "function" ? runtime.getActiveTools() : undefined),
    () => (typeof pi?.getActiveTools === "function" ? pi.getActiveTools() : undefined),
  ]);
  const thinking = firstOf([
    () => (typeof runtime?.getThinkingLevel === "function" ? runtime.getThinkingLevel() : undefined),
    () => (typeof pi?.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined),
  ]);
  const model = firstOf([
    () => ctx?.model,
    () => (typeof runtime?.getModel === "function" ? runtime.getModel() : undefined),
  ]);
  return {
    tools: Array.isArray(tools) ? tools : null,
    // Same shape the runtime uses elsewhere (`provider/id`), because the picker's
    // selectors are provider-qualified.
    model: model && typeof model === "object" && typeof model.id === "string"
      ? (typeof model.provider === "string" ? `${model.provider}/${model.id}` : model.id)
      : typeof model === "string" ? model : null,
    thinkingLevel: thinking === undefined || thinking === null ? null : String(thinking),
  };
}

function sessionModesOf(ctx) {
  const modes = ctx && typeof ctx === "object" ? ctx.sessionModes : undefined;
  return modes && typeof modes.getState === "function" ? modes : null;
}

function createHandler({ pi, ctx, token }) {
  function onState(res) {
    const modes = sessionModesOf(ctx);
    send(res, 200, {
      ok: true,
      hasSessionModes: modes !== null,
      modes: modes ? read(() => modes.getState(), null) : null,
      ...runtimeSnapshot(pi, ctx),
    });
  }

  async function applyMode(res, raw) {
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return refuse(res, 400, "bad_request", "Body must be JSON.");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return refuse(res, 400, "bad_request", "Body must be a JSON object.");
    }
    // Only `vibe` is in scope for this bridge: plan/goal/loop carry operands and
    // side effects the CAW surface does not model yet, so they are refused by
    // name rather than silently coerced.
    if (body.mode !== "vibe" || (body.action !== "enter" && body.action !== "exit")) {
      return refuse(res, 400, "bad_request", 'Only { mode: "vibe", action: "enter" | "exit" } is supported.');
    }
    const modes = sessionModesOf(ctx);
    if (modes === null || typeof modes.set !== "function") {
      // The bridge answered; the runtime surface is what is missing. That is a
      // refusal in OMP's own vocabulary, not a transport failure.
      return send(res, 200, {
        ok: false,
        code: "invalid_request",
        message: "ctx.sessionModes is not available in this session.",
        state: null,
      });
    }
    let result;
    try {
      result = await modes.set({ mode: "vibe", action: body.action });
    } catch (error) {
      log(`mode transition threw: ${error?.stack ?? error}`);
      return refuse(res, 500, "internal", String(error?.message ?? error));
    }
    // Verbatim, including `{ ok: false, code }`: the refusal is OMP's answer, and
    // re-shaping it here would drop the state that makes it explainable.
    send(res, 200, result);
  }

  function onMode(req, res) {
    const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      return refuse(res, 415, "bad_request", "Content-Type must be application/json.");
    }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return refuse(res, 413, "bad_request", `Body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        refuse(res, 413, "bad_request", `Body exceeds ${MAX_BODY_BYTES} bytes.`);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      refuse(res, 400, "bad_request", `Body could not be read: ${error?.message ?? error}`);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      void applyMode(res, Buffer.concat(chunks)).catch((error) => {
        log(`mode handler failed: ${error?.stack ?? error}`);
        if (!res.headersSent) refuse(res, 500, "internal", "Bridge failed to answer.");
      });
    });
  }

  return (req, res) => {
    if (!authorized(req.headers[TOKEN_HEADER], token)) {
      return refuse(res, 401, "unauthorized", "Missing or invalid x-caw-bridge-token.");
    }
    const path = String(req.url ?? "").split("?", 1)[0];
    if (req.method === "GET" && path === "/state") return onState(res);
    if (req.method === "POST" && path === "/mode") return onMode(req, res);
    return refuse(res, 404, "not_found", "Unknown bridge endpoint.");
  };
}

/**
 * Where the port and token come from.
 *
 * Preferred: `CAW_BRIDGE_CONFIG` names a file containing `{ port, token }`, so
 * the token never sits in the process command line where `/proc` exposes it.
 * `CAW_BRIDGE_PORT`/`CAW_BRIDGE_TOKEN` are the direct form, kept for a harness
 * that drives the extension without CAW's launcher.
 */
function bridgeConfig() {
  const configPath = process.env.CAW_BRIDGE_CONFIG;
  if (typeof configPath === "string" && configPath.length > 0) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      const port = Number(parsed?.port);
      const token = parsed?.token;
      if (Number.isInteger(port) && port >= 1 && port <= 65535 && typeof token === "string" && token.length > 0) {
        return { port, token };
      }
      log(`config file ${configPath} does not describe a port and token`);
      return null;
    } catch (error) {
      log(`config file ${configPath} could not be read: ${error?.message ?? error}`);
      return null;
    }
  }
  const port = Number(process.env.CAW_BRIDGE_PORT);
  const token = process.env.CAW_BRIDGE_TOKEN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof token !== "string" || token.length === 0) return null;
  return { port, token };
}

export default function cawBridge(pi) {
  pi.on("session_start", async (_event, ctx) => {
    // No port, no token, no bridge. Never bind on a guess.
    const config = bridgeConfig();
    if (config === null) return;
    const { port, token } = config;
    if (listening) return;
    const server = createServer(createHandler({ pi, ctx, token }));
    server.on("error", (error) => {
      log(`listen failed on 127.0.0.1:${port}: ${error?.message ?? error}`);
      if (listening === server) listening = null;
    });
    listening = server;
    await new Promise((resolve) => {
      // Resolve on failure too: the session must not stall on a lost race for
      // the port, and the failure is already written to the log.
      server.once("error", () => resolve());
      server.listen(port, "127.0.0.1", () => resolve());
    });
  });

  pi.on("session_shutdown", async () => {
    const server = listening;
    listening = null;
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  });
}
