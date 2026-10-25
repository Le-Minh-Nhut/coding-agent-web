import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Capabilities } from "@caw/contracts";
import type { CapabilityProbe, CapabilityService, ResolvedBinary } from "./types.js";

const execFileAsync = promisify(execFile);

export interface CapabilityOptions {
  ompBinaryPath?: string;
  tmuxBinaryPath?: string;
  extraSearchDirs?: string[];
  relayConfig?: Capabilities["relay"];
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveBinaryPath(name: string, extraPaths: string[]): Promise<string | null> {
  for (const candidate of extraPaths) {
    if (candidate && (await isExecutable(candidate))) {
      return candidate;
    }
  }

  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function parseOmpVersion(stdout: string): string | null {
  const match = /(?:^|\s)omp[\s/v]+([0-9A-Za-z.-]+)/i.exec(stdout.trim());
  return match ? match[1] ?? null : null;
}

export function parseTmuxVersion(stdout: string): string | null {
  const match = /(?:^|\s)tmux\s+([0-9A-Za-z.-]+)/i.exec(stdout.trim());
  return match ? match[1] ?? null : null;
}

export class DefaultCapabilityService implements CapabilityService {
  #cachedProbe: CapabilityProbe | null = null;
  readonly #options: CapabilityOptions;

  constructor(options: CapabilityOptions = {}) {
    this.#options = options;
  }

  async probe(refresh = false): Promise<CapabilityProbe> {
    if (!refresh && this.#cachedProbe) {
      return this.#cachedProbe;
    }

    const notes: string[] = [];

    // 1. Resolve omp
    let ompPath: string | null;
    if (this.#options.ompBinaryPath !== undefined) {
      ompPath = (await isExecutable(this.#options.ompBinaryPath)) ? this.#options.ompBinaryPath : null;
    } else {
      const ompCandidates = [
        path.join(homedir(), ".local", "bin", "omp"),
        ...(this.#options.extraSearchDirs?.map((d) => path.join(d, "omp")) ?? []),
      ];
      ompPath = await resolveBinaryPath("omp", ompCandidates);
    }
    let omp: ResolvedBinary;
    if (!ompPath) {
      omp = { available: false, path: null, version: null };
      notes.push("omp not found on PATH or ~/.local/bin");
    } else {
      try {
        const { stdout } = await execFileAsync(ompPath, ["--version"], {
          timeout: 5000,
        });
        const version = parseOmpVersion(stdout);
        omp = { available: true, path: ompPath, version };
        if (!version) {
          notes.push(`omp reported unrecognised --version output: ${stdout.trim()}`);
        }
      } catch (err) {
        omp = { available: false, path: ompPath, version: null };
        notes.push(`omp execution failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2. Resolve tmux
    let tmuxPath: string | null;
    if (this.#options.tmuxBinaryPath !== undefined) {
      tmuxPath = (await isExecutable(this.#options.tmuxBinaryPath)) ? this.#options.tmuxBinaryPath : null;
    } else {
      const tmuxCandidates = [
        "/usr/bin/tmux",
        "/usr/local/bin/tmux",
        ...(this.#options.extraSearchDirs?.map((d) => path.join(d, "tmux")) ?? []),
      ];
      tmuxPath = await resolveBinaryPath("tmux", tmuxCandidates);
    }
    let tmux: ResolvedBinary;
    if (!tmuxPath) {
      tmux = { available: false, path: null, version: null };
      notes.push("tmux not found on PATH");
    } else {
      try {
        const { stdout } = await execFileAsync(tmuxPath, ["-V"], {
          timeout: 5000,
        });
        const version = parseTmuxVersion(stdout);
        tmux = { available: true, path: tmuxPath, version };
        if (!version) {
          notes.push(`tmux reported unrecognised -V output: ${stdout.trim()}`);
        }
      } catch (err) {
        tmux = { available: false, path: tmuxPath, version: null };
        notes.push(`tmux execution failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const result: CapabilityProbe = { omp, tmux, notes };
    this.#cachedProbe = result;
    return result;
  }

  async capabilities(refresh = false): Promise<Capabilities> {
    const p = await this.probe(refresh);
    return {
      omp: {
        available: p.omp.available,
        version: p.omp.version,
        path: p.omp.path,
      },
      tmux: {
        available: p.tmux.available,
        version: p.tmux.version,
      },
      relay: this.#options.relayConfig ?? {
        configured: false,
        origin: null,
        reachable: null,
      },
    };
  }
}
