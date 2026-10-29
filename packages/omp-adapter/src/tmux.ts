import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { AdapterError } from "./errors.js";
import type { LaunchRequest, TmuxService, TmuxSession } from "./types.js";

const execFileAsync = promisify(execFile);

/** Tmux diagnostics for an absent server or unreachable socket; permission failures stay errors. */
const NO_SERVER_PATTERNS = [/no server running/i, /error connecting to .*?(?:no such file or directory|enoent)/i];
const MISSING_SESSION_PATTERNS = [/can't find session/i, /no such session/i];
const PERMISSION_PATTERNS = [/permission denied/i, /\beacces\b/i, /\beperm\b/i];

/** The child's own output. A spawn failure (missing binary) produces none. */
function execErrorOutput(err: unknown): string {
  const record = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  return `${stderr}${stdout}`.trim();
}

function execErrorText(err: unknown): string {
  const output = execErrorOutput(err);
  if (output) return output;
  const message = err && typeof err === "object" && "message" in err && typeof err.message === "string" ? err.message : "";
  return message || String(err);
}

/**
 * A socket diagnostic can mean either no server or an unreachable path; callers
 * must corroborate absence against the recorded server process before settling.
 */
function isNoServer(err: unknown): boolean {
  const output = execErrorOutput(err);
  return output.length > 0 && !PERMISSION_PATTERNS.some((pattern) => pattern.test(output)) &&
    NO_SERVER_PATTERNS.some((pattern) => pattern.test(output));
}

function parentPidFromProcStat(stat: string, expectedPid: number): number | null {
  const separator = stat.indexOf(" ");
  const close = stat.lastIndexOf(") ");
  if (separator <= 0 || close < separator || !/^\d+$/.test(stat.slice(0, separator))) return null;
  const pid = Number(stat.slice(0, separator));
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const parentPid = Number(fields[1]);
  return pid === expectedPid && fields[0]?.length === 1 && Number.isSafeInteger(parentPid) && parentPid >= 0 ? parentPid : null;
}

export interface TmuxServiceOptions {
  tmuxBinary?: string;
  socketName?: string;
  socketPath?: string;
  ompBinary?: string;
  /** Called when a guarded kill cannot be verified; the operation also throws. */
  onDiagnostic?: (event: string, detail: Record<string, unknown>) => void;
}


const SESSION_PREFIX = "caw-";

export function sanitizeSessionName(rawName: string): string {
  const base = rawName.startsWith(SESSION_PREFIX)
    ? rawName.slice(SESSION_PREFIX.length)
    : rawName;
  const sanitized = base.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  return `${SESSION_PREFIX}${sanitized || "session"}`;
}

export class DefaultTmuxService implements TmuxService {
  readonly #tmuxBinary: string;
  readonly #ompBinary: string;
  readonly #socketArgs: readonly string[];
  readonly #onDiagnostic: TmuxServiceOptions["onDiagnostic"];

  constructor(options: TmuxServiceOptions = {}) {
    this.#tmuxBinary = options.tmuxBinary ?? "tmux";
    this.#ompBinary = options.ompBinary ?? "omp";
    this.#onDiagnostic = options.onDiagnostic;

    if (options.socketPath) {
      this.#socketArgs = ["-S", options.socketPath];
    } else if (options.socketName) {
      this.#socketArgs = ["-L", options.socketName];
    } else {
      this.#socketArgs = [];
    }
  }

  /** Best-effort, never throws: reporting a problem must not create one. */
  #diagnostic(event: string, detail: Record<string, unknown>): void {
    try {
      this.#onDiagnostic?.(event, detail);
    } catch {
      // A diagnostic sink that fails must not change the outcome of the probe.
    }
  }

  async isProcessDescendant(candidatePid: number, panePid: number): Promise<boolean | "unknown"> {
    if (!Number.isSafeInteger(candidatePid) || candidatePid <= 0 || !Number.isSafeInteger(panePid) || panePid <= 0) return "unknown";
    let pid = candidatePid;
    const seen = new Set<number>();
    for (let depth = 0; depth < 4096 && !seen.has(pid); depth++) {
      if (pid === panePid) return true;
      seen.add(pid);
      let stat: string;
      try {
        stat = await readFile(`/proc/${pid}/stat`, "utf8");
      } catch {
        return "unknown";
      }
      const parentPid = parentPidFromProcStat(stat, pid);
      if (parentPid === null) return "unknown";
      if (parentPid === 0 || parentPid === pid) return false;
      pid = parentPid;
    }
    return "unknown";
  }

  async #execTmux(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(this.#tmuxBinary, [...this.#socketArgs, ...args], {
      shell: false,
      // tmux expands the \t separator in -F output through the active locale:
      // under C/POSIX (unset LANG on CI, systemd, docker) the tab comes back as
      // "_", making tab-delimited output unparseable. Pin a UTF-8 locale so the
      // separator survives; glibc>=2.35 ships C.UTF-8 everywhere we target.
      env: { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" },
    });
  }
  /**
   * tmux `display-message -p '#{socket_path}:#{start_time}:#{pid}'` gives actual
   * socket plus start time and process id. `$N` restarts at `$0`; pid avoids
   * start-time's one-second resolution colliding on a rapid restart.
   */
  async serverIdentity(): Promise<string | null> {
    let stdout: string;
    try {
      ({ stdout } = await this.#execTmux(["display-message", "-p", "#{socket_path}:#{start_time}:#{pid}"]));
    } catch (err) {
      // `null` means tmux could not reach a server through this socket path.
      // A missing pathname can leave the process alive, so lifecycle callers
      // must corroborate against the recorded process identity before settling.
      if (isNoServer(err)) return null;
      throw new AdapterError("internal", `Could not read the tmux server identity: ${execErrorText(err)}`);
    }
    const identity = stdout.trim();
    if (!identity) {
      throw new AdapterError("internal", "Tmux returned an empty server identity.");
    }
    if (!/^.+:\d+:\d+$/.test(identity)) {
      throw new AdapterError("internal", `The tmux server identity was not in the expected form: ${identity}`);
    }
    return identity;
  }


  async serverUp(): Promise<boolean> {
    return (await this.serverIdentity()) !== null;
  }

  /**
   * Every session on this server. An empty list means the server answered and had
   * nothing to report; a throw means we could not enumerate, so a caller must not
   * read it as "nothing is running".
   */
  async #listAllSessions(): Promise<TmuxSession[]> {
    let stdout: string;
    try {
      ({ stdout } = await this.#execTmux([
        "list-sessions",
        "-F",
        "#{session_id}\t#{session_name}\t#{session_created}\t#{pane_pid}\t#{pane_dead}\t#{socket_path}:#{start_time}:#{pid}",
      ]));
    } catch (err) {
      const text = execErrorText(err);
      if (isNoServer(err)) return [];
      throw new AdapterError("internal", `Could not list tmux sessions: ${text}`);
    }
    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
    const sessions: TmuxSession[] = [];
    for (const line of lines) {
      const parts = line.split("\t");
      const id = parts[0]?.trim();
      const name = parts[1]?.trim();
      const createdRaw = parts[2]?.trim();
      const panePidRaw = parts[3]?.trim();
      const paneDeadRaw = parts[4]?.trim();
      const serverIdentity = parts[5]?.trim();
      if (!id || !name || !serverIdentity) continue;
      const createdAt = createdRaw && !Number.isNaN(Number(createdRaw)) ? Number(createdRaw) : null;
      const panePid = panePidRaw && !Number.isNaN(Number(panePidRaw)) ? Number(panePidRaw) : null;
      sessions.push({ id, name, createdAt, panePid, alive: paneDeadRaw !== "1", serverIdentity });
    }
    return sessions;
  }

  /**
   * Enumerate every session on this service's socket. The app binds this service
   * to its private socket, so that socket—not a mutable display name—is the owner boundary.
   */
  async listManaged(): Promise<TmuxSession[]> {
    if (this.#socketArgs.length === 0) {
      throw new AdapterError("internal", "Cannot enumerate owned sessions without an explicitly configured private tmux socket.");
    }
    return this.#listAllSessions();
  }

  async getById(sessionId: string): Promise<TmuxSession | null> {
    const all = await this.#listAllSessions();
    return all.find((s) => s.id === sessionId) ?? null;
  }

  async getByName(name: string): Promise<TmuxSession | null> {
    const all = await this.#listAllSessions();
    return all.find((s) => s.name === name) ?? null;
  }

  async launch(request: LaunchRequest): Promise<TmuxSession> {
    const sessionName = sanitizeSessionName(request.name);

    const tmuxArgs: string[] = [
      "new-session", "-d", "-P", "-F", "#{session_id}\t#{socket_path}:#{start_time}:#{pid}",
      "-s", sessionName, "-c", request.cwd,
    ];
    if (request.env) for (const [key, value] of Object.entries(request.env)) tmuxArgs.push("-e", `${key}=${value}`);

    const commandArgs = [this.#ompBinary];
    if (request.configPath) commandArgs.push(`--config=${request.configPath}`);
    if (request.model) commandArgs.push(`--model=${request.model}`);
    if (request.args?.length) commandArgs.push(...request.args);
    tmuxArgs.push(...commandArgs);

    let stdout: string;
    try {
      ({ stdout } = await this.#execTmux(tmuxArgs));
    } catch (err) {
      throw new AdapterError(
        "agent_launch_failed",
        `Failed to launch agent in tmux session ${sessionName}: ${err instanceof Error ? err.message : String(err)}`,
        { name: sessionName, cwd: request.cwd },
      );
    }

    const [assignedId, serverIdentity] = stdout.trim().split("\t");
    if (!assignedId?.startsWith("$") || !serverIdentity?.includes(":")) {
      throw new AdapterError("agent_launch_failed", `Tmux did not return a valid session id and server identity for ${sessionName}: ${stdout}`, { stdout });
    }
    // new-session returned authoritative ID and server identity; listing only enriches this success.
    let session: TmuxSession | null = null;
    try {
      session = await this.getById(assignedId);
    } catch {
      // A failed follow-up list cannot turn a completed process creation into a false launch failure.
    }
    if (session?.serverIdentity === serverIdentity) return session;
    return { id: assignedId, name: sessionName, createdAt: Math.floor(Date.now() / 1000), panePid: null, alive: true, serverIdentity };
  }
  async capture(sessionId: string, lines?: number): Promise<string> {
    if (!sessionId.startsWith("$")) {
      throw new AdapterError("bad_request", `Invalid tmux session id: ${sessionId}`);
    }

    const args = ["capture-pane", "-p"];
    if (lines !== undefined && lines > 0) {
      args.push("-S", `-${lines}`);
    }
    args.push("-t", sessionId);

    try {
      const { stdout } = await this.#execTmux(args);
      return stdout;
    } catch (err) {
      throw new AdapterError(
        "agent_not_running",
        `Failed to capture output from session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        { sessionId },
      );
    }
  }

  async sendKeys(sessionId: string, keys: string): Promise<void> {
    if (!sessionId.startsWith("$")) {
      throw new AdapterError("bad_request", `Invalid tmux session id: ${sessionId}`);
    }

    try {
      await this.#execTmux(["send-keys", "-t", sessionId, keys]);
    } catch (err) {
      throw new AdapterError(
        "agent_not_running",
        `Failed to send keys to session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        { sessionId },
      );
    }
  }

  async kill(sessionId: string, options?: { expectedIdentity?: string }): Promise<void> {
    if (!/^\$\d+$/.test(sessionId)) {
      throw new AdapterError("bad_request", `Invalid tmux session id: ${sessionId}`);
    }
    if (options?.expectedIdentity) {
      const match = /^(.*):(\d+):(\d+)$/.exec(options.expectedIdentity);
      if (!match) {
        throw new AdapterError("bad_request", `Invalid expected tmux server identity: ${options.expectedIdentity}`);
      }
      const [, , startTime, pid] = match;
      const blocked = (blockedBy: string): never => {
        this.#diagnostic("tmux.kill_blocked", { sessionId, blockedBy });
        throw new AdapterError("internal", `Could not verify tmux kill for ${sessionId}: ${blockedBy}`, { sessionId, blockedBy });
      };

      try {
        if ((await this.serverIdentity()) !== options.expectedIdentity) blocked("identity_changed");
      } catch (err) {
        if (err instanceof AdapterError && err.detail?.blockedBy) throw err;
        blocked(`identity_probe_failed: ${execErrorText(err)}`);
      }
      try {
        await this.#execTmux([
          "if-shell",
          "-F",
          `#{&&:#{==:#{start_time},${startTime}},#{==:#{pid},${pid}}}`,
          `kill-session -t '${sessionId}'`,
        ]);
      } catch (err) {
        if (!MISSING_SESSION_PATTERNS.some((pattern) => pattern.test(execErrorOutput(err)))) blocked(`kill_failed: ${execErrorText(err)}`);
      }

      let afterIdentity: string | null = null;
      try {
        afterIdentity = await this.serverIdentity();
      } catch (err) {
        blocked(`verification_probe_failed: ${execErrorText(err)}`);
      }
      // A changed server cannot identify whether its pane process survived.
      if (afterIdentity !== options.expectedIdentity) return;

      let sessions: TmuxSession[] = [];
      try {
        sessions = await this.#listAllSessions();
        afterIdentity = await this.serverIdentity();
      } catch (err) {
        blocked(`verification_probe_failed: ${execErrorText(err)}`);
      }
      if (afterIdentity !== options.expectedIdentity) return;
      if (sessions.some((session) => session.id === sessionId && session.serverIdentity === options.expectedIdentity && session.alive)) {
        blocked("session_still_present");
      }
      return;
    }
    try {
      await this.#execTmux(["kill-session", "-t", sessionId]);
    } catch {
      // Idempotent kill: ignore error if session already died or server exited.
    }
  }
}
