import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AdapterError, RegistryUnreadableError, StaleGenerationError } from "./errors.js";
import type {
  CollabHost,
  CollabHostModel,
  CollabLink,
  CollabRegistryService,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface CollabRegistryOptions {
  ompBinary?: string;
  registryDir?: string;
}

/**
 * Numbers stay absent when the CLI did not report them: a default would be a
 * value the caller could compare against, and `NaN` would sort unpredictably.
 */
const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * One host row.
 *
 * Returns `null` (drop the row) only when a field whose absence makes the row
 * unusable is missing: `instanceId` is the name a room is addressed by and
 * `sessionId`/`cwd` are how a row is tied to a conversation and a project. Every
 * other field is genuinely optional in OMP's output and is preserved as `null`
 * rather than defaulted, so "we do not know" cannot satisfy a comparison.
 */
export function parseCollabHost(raw: unknown): CollabHost | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;

  if (
    typeof row.instanceId !== "string" ||
    typeof row.sessionId !== "string" ||
    typeof row.cwd !== "string"
  ) {
    return null;
  }

  let model: CollabHostModel | null = null;
  if (row.model && typeof row.model === "object") {
    const m = row.model as Record<string, unknown>;
    if (typeof m.provider === "string" && typeof m.id === "string") {
      model = { provider: m.provider, id: m.id };
    }
  }

  // Older or malformed listings cannot authorize either kind of link; callers fail closed.
  const access = row.access === "view" || row.access === "control" ? row.access : null;

  return {
    instanceId: row.instanceId,
    generation: numberOrNull(row.generation),
    pid: numberOrNull(row.pid),
    sessionId: row.sessionId,
    sessionName: typeof row.sessionName === "string" ? row.sessionName : null,
    cwd: row.cwd,
    model,
    startedAt: numberOrNull(row.startedAt),
    participants: numberOrNull(row.participants),
    relayConnected: typeof row.relayConnected === "boolean" ? row.relayConnected : null,
    inputRequired: typeof row.inputRequired === "boolean" ? row.inputRequired : null,
    // Absent or non-boolean stays null: an unknown flag must not read as `false`.
    busy: typeof row.busy === "boolean" ? row.busy : null,
    access,
  };
}

export function parseCollabListOutput(stdout: string): CollabHost[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new RegistryUnreadableError(
      `Failed to parse collab list output: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new RegistryUnreadableError("Invalid collab list output: expected object");
  }

  const payload = parsed as Record<string, unknown>;
  if (!Array.isArray(payload.hosts)) {
    throw new RegistryUnreadableError("Invalid collab list output: hosts is not an array");
  }

  const hosts: CollabHost[] = [];
  for (const item of payload.hosts) {
    const host = parseCollabHost(item);
    if (host) {
      hosts.push(host);
    }
  }

  return hosts;
}

export class DefaultCollabRegistryService implements CollabRegistryService {
  readonly #ompBinary: string;
  readonly #registryDir: string;

  constructor(options: CollabRegistryOptions = {}) {
    this.#ompBinary = options.ompBinary ?? "omp";
    this.#registryDir =
      options.registryDir ??
      (process.env.XDG_STATE_HOME
        ? path.join(process.env.XDG_STATE_HOME, "omp", "run", "collab-hosts")
        : path.join(homedir(), ".omp", "run", "collab-hosts"));
  }

  /**
   * Returns whether the registry directory exists. A missing directory is a
   * fact (`false`); a directory that exists but cannot be read throws, because
   * "I could not look" must never collapse into "there are no hosts".
   */
  async #checkRegistryReadable(): Promise<boolean> {
    try {
      await access(this.#registryDir, constants.R_OK);
      return true;
    } catch (err: unknown) {
      const code = err && typeof err === "object" && "code" in err ? err.code : null;
      // ENOENT is the only failure that is itself a fact: no registry directory
      // exists yet, so no host has ever published. Anything else — EACCES, EPERM,
      // ENOTDIR, ELOOP, EIO — means we could not look, and reporting "no hosts"
      // there is how a live room gets written off as absent.
      if (code === "ENOENT") return false;
      throw new RegistryUnreadableError(
        `Collab registry directory could not be read: ${this.#registryDir} (${code ?? (err instanceof Error ? err.message : String(err))})`,
      );
    }
  }

  async list(): Promise<CollabHost[]> {
    // No directory is itself the proof of zero hosts, so the empty list is a
    // confirmed answer and no shell-out is needed. It also keeps a machine with
    // no `omp` (CI runner, fresh install) answering honestly instead of 500.
    if (!(await this.#checkRegistryReadable())) return [];

    let stdout: string;
    try {
      const res = await execFileAsync(this.#ompBinary, ["collab", "list", "--json"], {
        shell: false,
      });
      stdout = res.stdout;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("EACCES") || message.includes("permission denied")) {
        throw new RegistryUnreadableError(message);
      }
      throw new AdapterError("internal", `Failed to run omp collab list: ${message}`);
    }

    return parseCollabListOutput(stdout);
  }

  async findBySessionId(sessionId: string): Promise<CollabHost | null> {
    const hosts = await this.list();
    return hosts.find((h) => h.sessionId === sessionId) ?? null;
  }

  async link(instanceId: string, accessType: "control" | "view"): Promise<CollabLink> {
    const args = ["collab", "link", instanceId];
    if (accessType === "view") {
      args.push("--view");
    }
    args.push("--json");

    let stdout: string;
    try {
      const res = await execFileAsync(this.#ompBinary, args, { shell: false });
      stdout = res.stdout;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes("stale") || message.toLowerCase().includes("generation")) {
        throw new StaleGenerationError(`Stale host generation for instance ${instanceId}`);
      }
      throw new AdapterError("link_unavailable", `Failed to retrieve collab link for ${instanceId}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw new AdapterError("link_unavailable", `Malformed json from collab link: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!parsed || typeof parsed !== "object") {
      throw new AdapterError("link_unavailable", "Invalid collab link response");
    }

    const payload = parsed as Record<string, unknown>;
    if (typeof payload.url !== "string" || !payload.url) {
      throw new AdapterError("link_unavailable", "Collab link response missing url");
    }

    if (payload.access !== "view" && payload.access !== "control") {
      throw new AdapterError("link_unavailable", "Collab link response missing access");
    }
    // Absence is preserved as `null`, never inferred. Echoing the requested
    // instance id or defaulting the generation would make the caller's
    // instance/generation comparison pass by construction, so a link minted for
    // a successor room after a session switch would look like a verified match.
    return {
      instanceId: typeof payload.instanceId === "string" ? payload.instanceId : null,
      generation: typeof payload.generation === "number" ? payload.generation : null,
      access: payload.access,
      url: payload.url,
      fetchedAt: Date.now(),
    };
  }
}
