import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ModelCatalogService } from "./types.js";

const execFileAsync = promisify(execFile);
const MODEL_LIST_ARGS = ["models", "--json"];
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
// Successful discovery stays cached for 60s; failures retry quickly.
const CACHE_TTL_MS = 60_000;
const FAILURE_CACHE_TTL_MS = 3_000;

export interface ModelCatalogOptions {
  ompBinary?: string;
}

const modelRowSchema = z.object({
  provider: z.string().min(1).refine((provider) => provider.trim() === provider && !/[\u0000-\u001f\u007f]/.test(provider)),
  id: z.string().min(1).refine((id) => id.trim() === id && !/[\u0000-\u001f\u007f]/.test(id)),
  selector: z.string().min(1).refine((selector) => selector.trim() === selector && !/[\u0000-\u001f\u007f]/.test(selector)),
}).passthrough();

function parseModelCatalog(stdout: string): { models: string[]; reason: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { models: [], reason: "OMP model catalog returned invalid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || !("models" in parsed) || !Array.isArray(parsed.models)) {
    return { models: [], reason: "OMP model catalog returned an unsupported format" };
  }

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
  selectors.sort((a, b) => {
    const [providerA, ...idA] = a.split("/");
    const [providerB, ...idB] = b.split("/");
    return providerA!.localeCompare(providerB!) || idA.join("/").localeCompare(idB.join("/"));
  });
  return { models: selectors, reason: null };
}

/** Parse and sort OMP's machine-readable model listing; malformed rows are dropped. */
export function parseOmpModelsOutput(stdout: string): string[] {
  return parseModelCatalog(stdout).models;
}

export class DefaultModelCatalogService implements ModelCatalogService {
  readonly #ompBinary: string;
  #cachedResult: { models: string[]; source: "omp" | "unavailable"; reason: string | null } | null = null;
  #cacheExpiresAt = 0;

  constructor(options: ModelCatalogOptions = {}) {
    this.#ompBinary = options.ompBinary ?? "omp";
  }

  async listModels(): Promise<string[]> {
    return (await this.listModelsDetailed()).models;
  }

  async listModelsDetailed(): Promise<{ models: string[]; source: "omp" | "unavailable"; reason: string | null }> {
    if (this.#cachedResult !== null && Date.now() < this.#cacheExpiresAt) {
      return { ...this.#cachedResult, models: [...this.#cachedResult.models] };
    }

    try {
      const { stdout } = await execFileAsync(this.#ompBinary, MODEL_LIST_ARGS, {
        shell: false,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
      });
      const parsed = parseModelCatalog(stdout);
      const result = parsed.reason === null
        ? { ...parsed, source: "omp" as const }
        : { ...parsed, source: "unavailable" as const };
      this.#cachedResult = result;
      this.#cacheExpiresAt = Date.now() + (result.source === "omp" ? CACHE_TTL_MS : FAILURE_CACHE_TTL_MS);
      return { ...result, models: [...result.models] };
    } catch (error) {
      const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
      const reason = [record.stderr, record.stdout, error instanceof Error ? error.message : String(error)]
        .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
        .join(" ");
      const result = { models: [], source: "unavailable" as const, reason: reason || "OMP model catalog command failed" };
      this.#cachedResult = result;
      this.#cacheExpiresAt = Date.now() + FAILURE_CACHE_TTL_MS;
      return { ...result, models: [] };
    }
  }
}
