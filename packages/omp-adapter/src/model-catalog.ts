import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ModelCatalogService } from "./types.js";

const execFileAsync = promisify(execFile);
const MODEL_LIST_ARGS = ["models", "--json"];
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
// OMP's catalog has its own 24-hour discovery cache; 60s avoids repeated CLI
// startup without making a model/config change stay hidden for long.
const CACHE_TTL_MS = 60_000;

export interface ModelCatalogOptions {
  ompBinary?: string;
}

const modelRowSchema = z.object({
  provider: z.string().min(1).refine((provider) => provider.trim() === provider && !/[\u0000-\u001f\u007f]/.test(provider)),
  id: z.string().min(1).refine((id) => id.trim() === id && !/[\u0000-\u001f\u007f]/.test(id)),
  selector: z.string().min(1).refine((selector) => selector.trim() === selector && !/[\u0000-\u001f\u007f]/.test(selector)),
}).passthrough();

/** Parse and sort OMP's machine-readable model listing; malformed rows are dropped. */
export function parseOmpModelsOutput(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || !("models" in parsed) || !Array.isArray(parsed.models)) return [];

  const selectors: string[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.models) {
    const row = modelRowSchema.safeParse(raw);
    if (!row.success) continue;
    const selector = `${row.data.provider}/${row.data.id}`;
    if (row.data.selector !== selector || seen.has(selector)) continue;
    seen.add(selector);
    selectors.push(selector);
  }
  return selectors.sort((a, b) => {
    const [providerA, ...idA] = a.split("/");
    const [providerB, ...idB] = b.split("/");
    return providerA!.localeCompare(providerB!) || idA.join("/").localeCompare(idB.join("/"));
  });
}

export class DefaultModelCatalogService implements ModelCatalogService {
  readonly #ompBinary: string;
  #cachedModels: string[] | null = null;
  #cacheExpiresAt = 0;

  constructor(options: ModelCatalogOptions = {}) {
    this.#ompBinary = options.ompBinary ?? "omp";
  }

  async listModels(): Promise<string[]> {
    if (this.#cachedModels !== null && Date.now() < this.#cacheExpiresAt) {
      return [...this.#cachedModels];
    }

    try {
      const { stdout } = await execFileAsync(this.#ompBinary, MODEL_LIST_ARGS, {
        shell: false,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
      });
      this.#cachedModels = parseOmpModelsOutput(stdout);
      this.#cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      return [...this.#cachedModels];
    } catch {
      // Missing binary, timeout, unreadable config/cache, or unsupported CLI all
      // mean that the catalog is unknown, not that a guessed list is acceptable.
      return [];
    }
  }
}
