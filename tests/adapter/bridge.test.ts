import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { allocateLoopbackPort, BridgeClient } from "@caw/omp-adapter";
import bridgeExtension from "../../packages/omp-adapter/src/bridge/extension.mjs";

/**
 * The bridge as it actually runs: the real extension module, loaded the way OMP
 * loads it, driven by a stub of the surface a live TUI session exposes.
 *
 * The stub is not a convenience — the assertions are about what the extension
 * does with a *real* `node:http` request against a *real* loopback socket, which
 * is the only way an auth check, a body limit or a verbatim passthrough can be
 * proven rather than described.
 */
interface Handlers {
  session_start?: (event: unknown, ctx: unknown) => unknown;
  session_shutdown?: (event: unknown, ctx: unknown) => unknown;
}

const STATE = {
  plan: { status: "inactive" },
  vibe: { status: "inactive" },
  goal: { status: "inactive" },
  loop: { status: "inactive" },
};

interface Booted {
  port: number;
  token: string;
  handlers: Handlers;
  setCalls: Array<{ mode: string; action: string }>;
  stop: () => Promise<void>;
}

const running: Booted[] = [];
const tempDirs: string[] = [];
const envKeys = ["CAW_BRIDGE_PORT", "CAW_BRIDGE_TOKEN", "CAW_BRIDGE_CONFIG", "CAW_BRIDGE_LOG"] as const;
const savedEnv = new Map<string, string | undefined>();
for (const key of envKeys) savedEnv.set(key, process.env[key]);

afterEach(async () => {
  for (const booted of running.splice(0)) await booted.stop();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A log path in its own temp dir, so one test never reads another test's lines. */
async function logFileForTest(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "caw-bridge-log-"));
  tempDirs.push(dir);
  return join(dir, "bridge.log");
}

/** An occupied loopback port, so a bind attempt on it must fail. */
async function occupiedPort(): Promise<{ port: number; stop: () => Promise<void> }> {
  const holder = createServer(() => {});
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (holder.address() as AddressInfo).port,
    stop: async () => { await new Promise<void>((resolve) => holder.close(() => resolve())); },
  };
}

/**
 * Load the real extension against a stub `pi`/`ctx` and fire `session_start`,
 * which is when it binds. `withSessionModes` false omits the surface entirely,
 * because that absence is the case under test.
 */
async function boot(options: { sessionId?: string | null;
  withSessionModes?: boolean;
  withCtxModel?: boolean;
  withRuntimeModel?: boolean;
  setResult?: unknown;
  setImpl?: (request: { mode: string; action: string }) => Promise<unknown>;
  token?: string;
  port?: number;
  logPath?: string;
} = {}): Promise<Booted> {
  const handlers: Handlers = {};
  const setCalls: Array<{ mode: string; action: string }> = [];
  // The surface a live TUI session exposes: tools and thinking level on the
  // runtime actions object, the current model on the context (`ExtensionActions`
  // has `setModel` but no getter; `ctx.model` is the getter).
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      (handlers as Record<string, unknown>)[event] = handler;
    },
    runtime: {
      getActiveTools: () => ["read", "edit"],
      getAllTools: () => [],
      setActiveTools: async () => {},
      getThinkingLevel: () => "medium",
      ...(options.withRuntimeModel ? { getModel: () => ({ id: "runtime-model", provider: "rt" }) } : {}),
    },
  };
  const ctx = {
    ...((options.withSessionModes ?? true)
      ? {
          sessionModes: {
            getState: () => STATE,
            set: async (request: { mode: string; action: string }) => {
              setCalls.push(request);
              if (options.setImpl) return options.setImpl(request);
              return options.setResult ?? { ok: true, changed: true, state: { ...STATE, vibe: { status: "active" } } };
            },
          },
        }
      : {}),
    ...(options.withCtxModel ?? true ? { model: { id: "test-model", provider: "test" } } : {}),
    // The real context always carries this, and the bridge reports it so a caller
    // can tie an answer to the conversation that asked (B02).
    sessionManager: { getSessionId: () => (options.sessionId === undefined ? "sess-1" : options.sessionId) },
  };

  const port = options.port ?? (await allocateLoopbackPort());
  const token = options.token ?? "0123456789abcdef0123456789abcdef";
  process.env.CAW_BRIDGE_PORT = String(port);
  process.env.CAW_BRIDGE_TOKEN = token;
  delete process.env.CAW_BRIDGE_CONFIG;
  process.env.CAW_BRIDGE_LOG = options.logPath ?? "/dev/null";

  bridgeExtension(pi as never);
  await handlers.session_start!({}, ctx);

  const booted: Booted = {
    port,
    token,
    handlers,
    setCalls,
    stop: async () => {
      await handlers.session_shutdown?.({}, ctx);
    },
  };
  running.push(booted);
  return booted;
}

const url = (port: number, path: string) => `http://127.0.0.1:${port}${path}`;

describe("bridge extension (real module, real socket)", () => {
  it("refuses every request without the token, and never crashes on a wrong-length one", async () => {
    const { port, token } = await boot();

    const anonymous = await fetch(url(port, "/state"));
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).code).toBe("unauthorized");

    // A different-length token is the case that makes `timingSafeEqual` throw if
    // the length is not checked first: a throw here would be a crash, not a 401.
    const short = await fetch(url(port, "/state"), { headers: { "x-caw-bridge-token": "short" } });
    expect(short.status).toBe(401);
    const wrong = await fetch(url(port, "/state"), { headers: { "x-caw-bridge-token": "f".repeat(token.length) } });
    expect(wrong.status).toBe(401);

    // The server is still alive after all three: an auth failure is a refusal.
    const right = await fetch(url(port, "/state"), { headers: { "x-caw-bridge-token": token } });
    expect(right.status).toBe(200);
  });

  it("reports the native state, tools, model and thinking level", async () => {
    const { port, token } = await boot();
    const response = await fetch(url(port, "/state"), { headers: { "x-caw-bridge-token": token } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      hasSessionModes: true,
      // The serving session, so a caller can refuse an answer that belongs to a
      // session its conversation does not own (B02).
      sessionId: "sess-1",
      modes: STATE,
      tools: ["read", "edit"],
      model: "test/test-model",
      thinkingLevel: "medium",
    });
  });

  it("reports `hasSessionModes: false` with a null state when the session has no mode surface", async () => {
    // Not an error: a session that never had the surface (a headless mode, say)
    // is `unknown`, and inventing an all-inactive state would be a guess.
    const { port, token } = await boot({ withSessionModes: false });
    const response = await fetch(url(port, "/state"), { headers: { "x-caw-bridge-token": token } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, hasSessionModes: false, modes: null, tools: ["read", "edit"] });
  });

  it("reads the model from whichever surface has it, and reports `null` when neither does", async () => {
    // `ExtensionActions` has `setModel` but no getter, so the live model is the
    // context's `model`; a rebuilt host that exposes `runtime.getModel` instead is
    // read too. With neither, the honest answer is `null` — not a 500 and not a
    // guessed model id.
    const fromRuntime = await boot({ withCtxModel: false, withRuntimeModel: true });
    const runtimeState = await (await fetch(url(fromRuntime.port, "/state"), { headers: { "x-caw-bridge-token": fromRuntime.token } })).json();
    expect(runtimeState.model).toBe("rt/runtime-model");
    // One listener per process, so the next boot needs the previous one shut down
    // — the same fact `session_start` relies on when a session switch re-fires it.
    await fromRuntime.stop();

    const neither = await boot({ withCtxModel: false });
    const noneState = await (await fetch(url(neither.port, "/state"), { headers: { "x-caw-bridge-token": neither.token } })).json();
    expect(noneState).toMatchObject({ ok: true, model: null, tools: ["read", "edit"] });
  });

  it("ignores a second session_start while a listener is already up", async () => {
    // A session switch re-fires `session_start`. Rebinding would either fail on
    // the taken port or move the bridge to a port CAW was never told about.
    const booted = await boot();
    await booted.handlers.session_start!({}, { sessionModes: { getState: () => STATE, set: async () => ({ ok: true }) } });
    const response = await fetch(url(booted.port, "/state"), { headers: { "x-caw-bridge-token": booted.token } });
    expect(response.status).toBe(200);
  });

  it("binds nothing when there is no port or no token — never on a guess", async () => {
    // The rule that matters most here. A *free* port makes the failure
    // observable: if the extension had bound anything, the probe below would
    // succeed, and the log would carry a listen line.
    const freePort = await allocateLoopbackPort();
    const logPath = await logFileForTest();
    const handlers: Handlers = {};
    bridgeExtension({ on: (event, handler) => { handlers[event] = handler as never; } } as never);
    process.env.CAW_BRIDGE_LOG = logPath;
    process.env.CAW_BRIDGE_PORT = String(freePort);

    // Port but no token.
    delete process.env.CAW_BRIDGE_TOKEN;
    delete process.env.CAW_BRIDGE_CONFIG;
    await handlers.session_start!({}, {});
    // Token but no port.
    process.env.CAW_BRIDGE_TOKEN = "tok";
    delete process.env.CAW_BRIDGE_PORT;
    await handlers.session_start!({}, {});
    // Neither.
    delete process.env.CAW_BRIDGE_TOKEN;
    await handlers.session_start!({}, {});
    // A config path that does not exist, and one that describes no bridge.
    process.env.CAW_BRIDGE_CONFIG = join(dirname(logPath), "absent.json");
    await handlers.session_start!({}, {});
    const useless = join(dirname(logPath), "useless.json");
    await writeFile(useless, JSON.stringify({ port: 99999, token: "" }));
    process.env.CAW_BRIDGE_CONFIG = useless;
    await handlers.session_start!({}, {});

    delete process.env.CAW_BRIDGE_CONFIG;
    delete process.env.CAW_BRIDGE_PORT;
    delete process.env.CAW_BRIDGE_TOKEN;

    expect(await new BridgeClient({ port: freePort, token: "tok", timeoutMs: 500 }).probe()).toBe(false);
    const logged = await readFile(logPath, "utf8").catch(() => "");
    expect(logged).not.toContain("listen failed");
  });

  it("reports a bind failure to the log instead of swallowing it or stalling the session", async () => {
    // A port already held by someone else: the race is real (the port is probed,
    // then bound a moment later), and the honest outcome is a logged failure the
    // route turns into `bridge_unavailable` — not a silent no-bridge, and not a
    // session that never finishes starting.
    const holder = await occupiedPort();
    const logPath = await logFileForTest();
    try {
      // `boot` awaits `session_start`, so if a bind failure stalled the handler
      // this test would hang rather than fail: the timeout is the assertion.
      const booted = await boot({ port: holder.port, logPath });
      try {
        const logged = await readFile(logPath, "utf8");
        expect(logged).toContain("listen failed");
        expect(logged).toContain(`127.0.0.1:${holder.port}`);
      } finally {
        await booted.stop();
      }
    } finally {
      await holder.stop();
    }
  });

  it("passes a successful transition through verbatim", async () => {
    const active = { ...STATE, vibe: { status: "active" } };
    const { port, token, setCalls } = await boot({ setResult: { ok: true, changed: true, state: active } });
    const response = await fetch(url(port, "/mode"), {
      method: "POST",
      headers: { "x-caw-bridge-token": token, "content-type": "application/json" },
      body: JSON.stringify({ mode: "vibe", action: "enter" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, changed: true, state: active });
    expect(setCalls).toEqual([{ mode: "vibe", action: "enter" }]);
  });

  it("returns OMP's refusal verbatim, at HTTP 200 — it answered", async () => {
    const refusal = { ok: false, code: "conflict", message: "Plan mode is active", state: STATE };
    const { port, token } = await boot({ setResult: refusal });
    const response = await fetch(url(port, "/mode"), {
      method: "POST",
      headers: { "x-caw-bridge-token": token, "content-type": "application/json" },
      body: JSON.stringify({ mode: "vibe", action: "exit" }),
    });
    // 200, because the exchange succeeded; the *answer* is a refusal, and it must
    // reach the caller with its code and state intact.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(refusal);
  });

  it("rejects modes that are out of scope with 400", async () => {
    const { port, token, setCalls } = await boot();
    for (const body of [{ mode: "plan", action: "enter" }, { mode: "goal", action: "enter" }, { mode: "loop", action: "exit" }, { mode: "vibe", action: "toggle" }]) {
      const response = await fetch(url(port, "/mode"), {
        method: "POST",
        headers: { "x-caw-bridge-token": token, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    // Nothing was actuated: a rejected request must not reach the session.
    expect(setCalls).toEqual([]);
  });

  it("rejects an oversized body instead of buffering it", async () => {
    const { port, token } = await boot();
    const response = await fetch(url(port, "/mode"), {
      method: "POST",
      headers: { "x-caw-bridge-token": token, "content-type": "application/json" },
      body: JSON.stringify({ mode: "vibe", action: "enter", pad: "x".repeat(5000) }),
    });
    expect(response.status).toBe(413);

    const wrongType = await fetch(url(port, "/mode"), {
      method: "POST",
      headers: { "x-caw-bridge-token": token, "content-type": "text/plain" },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);
  });

  it("closes the listener on session_shutdown", async () => {
    const booted = await boot();
    expect(await new BridgeClient({ port: booted.port, token: booted.token }).probe()).toBe(true);
    await booted.stop();
    // Running-session teardown must not leave a socket behind: a later `omp -e`
    // in the same process would find the port taken and log a bind failure.
    expect(await new BridgeClient({ port: booted.port, token: booted.token, timeoutMs: 500 }).probe()).toBe(false);
  });
});

describe("BridgeClient outcomes", () => {
  it("names a timeout, a refused connection and a non-2xx as three different failures", async () => {
    // Nothing listens on this port: the kernel refuses the connection.
    const deadPort = await allocateLoopbackPort();
    const unreachable = await new BridgeClient({ port: deadPort, token: "t", timeoutMs: 500 }).readState();
    expect(unreachable).toMatchObject({ ok: false, reason: "unreachable" });

    // A listener that accepts and never answers: the timeout has to fire.
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
    const silentPort = (silent.address() as AddressInfo).port;
    try {
      const timedOut = await new BridgeClient({ port: silentPort, token: "t", timeoutMs: 150 }).readState();
      expect(timedOut).toMatchObject({ ok: false, reason: "timeout" });
    } finally {
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }

    // A listener that answers 401: an answer we cannot use, which is neither of
    // the two transport outcomes above.
    const refusing = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: "unauthorized" }));
    });
    await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", () => resolve()));
    const refusingPort = (refusing.address() as AddressInfo).port;
    try {
      const client = new BridgeClient({ port: refusingPort, token: "t", timeoutMs: 500 });
      const denied = await client.readState();
      expect(denied).toMatchObject({ ok: false, reason: "error" });
      expect(await client.probe()).toBe(false);
      // A refused *write* is the same three-way split, and never a mode change.
      expect(await client.setMode({ mode: "vibe", action: "enter" })).toMatchObject({ ok: false, reason: "error" });
    } finally {
      await new Promise<void>((resolve) => refusing.close(() => resolve()));
    }

    // Every non-success is distinct, and none of them is a mode change.
    expect(new Set([unreachable.ok ? "ok" : unreachable.reason, "timeout", "error"]).size).toBe(3);
  });

  it("surfaces a refusal from the bridge as its own verdict, not as a transport error", async () => {
    const { port, token, stop } = await boot({ setResult: { ok: false, code: "busy", message: "A turn is running", state: STATE } });
    try {
      const client = new BridgeClient({ port, token });
      const outcome = await client.setMode({ mode: "vibe", action: "enter" });
      expect(outcome).toEqual({ ok: true, result: { ok: false, code: "busy", message: "A turn is running", state: STATE } });
      expect((await client.readState()).ok).toBe(true);
      expect(await client.probe()).toBe(true);
    } finally {
      await stop();
    }
  });
});
