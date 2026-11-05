/**
 * CAW's side of the bridge: a loopback HTTP client for the extension running
 * inside a live OMP session.
 *
 * Every outcome is named, because three of them look alike from a call site and
 * mean opposite things: a refused connection (no bridge), a timeout (asked, no
 * answer), and a non-2xx (an answer we cannot read) must never collapse into
 * "the mode changed". `setMode` therefore returns OMP's own verdict object
 * verbatim — including `{ ok: false, code: "conflict" }`, which is a *successful
 * exchange carrying a refusal*.
 *
 * Types here are structural on purpose: this package owns the wire shape it
 * speaks, and `@caw/contracts` owns the API shape the server serves.
 */

/** OMP's `ctx.sessionModes.getState()`, as observed. */
export interface BridgeModeState {
  plan: { status: string };
  vibe: { status: string };
  goal: { status: string };
  loop: { status: string };
}

/** OMP's own transition outcome. `ok: false` is a first-class answer. */
export interface BridgeModeResult {
  ok: boolean;
  changed?: boolean;
  code?: string | null;
  message?: string | null;
  state?: BridgeModeState | null;
}

export interface BridgeState {
  hasSessionModes: boolean;
  modes: BridgeModeState | null;
  tools: string[] | null;
  model: string | null;
  thinkingLevel: string | null;
}

/**
 * The outcome of one call. `reason` distinguishes "nothing was listening" from
 * "it did not answer in time" from "it answered something unusable" — the three
 * cases a bare `catch` would flatten.
 */
export type BridgeReadResult =
  | { ok: true; state: BridgeState }
  | { ok: false; reason: "unreachable" | "timeout" | "error"; message: string };

export type BridgeModeOutcome =
  | { ok: true; result: BridgeModeResult }
  | { ok: false; reason: "unreachable" | "timeout" | "error"; message: string };

export interface BridgeClientOptions {
  port: number;
  token: string;
  /** Bounded by design: a hung bridge must not hold a request open indefinitely. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

export class BridgeClient {
  readonly #port: number;
  readonly #token: string;
  readonly #timeoutMs: number;

  constructor(options: BridgeClientOptions) {
    this.#port = options.port;
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get #origin(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  /**
   * One request. A transport failure never throws and never becomes a value
   * that reads like an answer: `AbortSignal.timeout` surfaces as `"timeout"`,
   * a refused socket as `"unreachable"`, anything else as `"error"`.
   */
  async #request(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<
    { ok: true; status: number; body: unknown } | { ok: false; reason: "unreachable" | "timeout" | "error"; message: string }
  > {
    let response: Response;
    try {
      response = await fetch(`${this.#origin}${path}`, {
        method: init.method,
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          "x-caw-bridge-token": this.#token,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const message = error instanceof Error ? error.message : String(error);
      if (name === "TimeoutError" || name === "AbortError") return { ok: false, reason: "timeout", message };
      // `TypeError: fetch failed` is what an ECONNREFUSED looks like here; the
      // cause is nested, so unwrap it for the log rather than printing "fetch failed".
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
      return { ok: false, reason: cause ? "unreachable" : "error", message: cause ?? message };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // A non-JSON body is reported by status, not guessed at.
      return { ok: true, status: response.status, body: null };
    }
    return { ok: true, status: response.status, body };
  }

  async readState(): Promise<BridgeReadResult> {
    const response = await this.#request("/state", { method: "GET" });
    if (!response.ok) return response;
    const body = response.body as (BridgeState & { ok?: boolean }) | null;
    if (response.status !== 200 || body === null || typeof body !== "object" || body.ok !== true) {
      return { ok: false, reason: "error", message: `Bridge answered HTTP ${response.status}` };
    }
    return {
      ok: true,
      state: {
        hasSessionModes: body.hasSessionModes === true,
        modes: body.modes ?? null,
        tools: body.tools ?? null,
        model: body.model ?? null,
        thinkingLevel: body.thinkingLevel ?? null,
      },
    };
  }

  async setMode(input: { mode: "vibe"; action: "enter" | "exit" }): Promise<BridgeModeOutcome> {
    const response = await this.#request("/mode", { method: "POST", body: input });
    if (!response.ok) return response;
    const body = response.body as BridgeModeResult | null;
    if (response.status !== 200 || body === null || typeof body !== "object" || typeof body.ok !== "boolean") {
      return { ok: false, reason: "error", message: `Bridge answered HTTP ${response.status}` };
    }
    return { ok: true, result: body };
  }

  /**
   * Whether a bridge is listening, for the honest "not available until the
   * session restarts" path: a session launched before the bridge existed has no
   * listener, and this is how that is *observed* rather than assumed.
   */
  async probe(): Promise<boolean> {
    return (await this.readState()).ok;
  }
}
