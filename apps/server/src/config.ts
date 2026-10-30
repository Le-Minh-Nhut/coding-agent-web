import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { z } from "zod";
const schema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.coerce.number().int().min(1).max(65535).default(8791),
  stateDir: z.string().min(1).default(resolve(homedir(), ".local/state/coding-agent-web")),
  allowedRoots: z.array(z.string().min(1)).default([]),
  // Private host WebSocket listener. Keep loopback-only; Tailscale Serve must proxy app port only.
  relayPort: z.coerce.number().int().min(1).max(65535).default(8792),
  webDistDir: z.string().min(1).optional(),
  guestDistDir: z.string().min(1).optional(),
  /**
   * Exact browser origins allowed to open a relay socket, e.g. your tailnet
   * origin. Empty means "loopback origins only", which is the safe default: a
   * browser on another host must be let in deliberately.
   */
  relayAllowedOrigins: z.array(z.string().min(1)).default([]),
  maxActiveAgents: z.coerce.number().int().min(1).max(100).default(3),
  authTokenTtlHours: z.coerce.number().finite().positive().default(720),
  trustTailscaleOrigin: z.boolean().default(false),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  insecureCookies: z.boolean().default(false),
  publicOrigin: z.string().optional(),
  /**
   * The ONE `omp` binary this server runs: the Collab registry read (`omp collab
   * list`), the model catalog (`omp models`), the capability probe and — the part
   * that matters — the agent command tmux is asked to launch.
   *
   * Unset means `omp` from PATH, which is what a real deployment wants. Pinning it
   * therefore also pins the launch, which is how the browser E2E harness
   * guarantees no real agent can start: set it to a recorder stub and a create-chat
   * spawns the stub, not a paid agent belonging to whoever owns the machine.
   */
  ompBinaryPath: z.string().min(1).optional(),
});

export type ServerConfig = z.infer<typeof schema> & { webDistDir?: string; guestDistDir?: string };
type RawConfig = Record<string, unknown>;

export function findRepoRoot(): string {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (existsSync(join(process.cwd(), "pnpm-workspace.yaml"))) return process.cwd();
  return process.cwd();
}

export function resolveDistDir(dir: string, repoRoot: string, name: string): string {
  if (isAbsolute(dir)) return resolve(dir);
  const normalized = normalize(dir);
  if (normalized.startsWith("..") || normalized.split(sep).includes("..")) {
    throw new Error(`${name} must be an absolute or repo-relative directory without '..' escapes: ${dir}`);
  }
  const resolved = resolve(repoRoot, dir);
  if (resolved !== repoRoot && !resolved.startsWith(repoRoot + sep)) {
    throw new Error(`${name} escapes repo root: ${dir}`);
  }
  return resolved;
}

function parseBoolean(value: string, name: string): boolean {
  if (["true", "1", "yes"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

function envConfig(env: NodeJS.ProcessEnv): RawConfig {
  const result: RawConfig = {};
  for (const key of ["host", "stateDir", "logLevel", "webDistDir", "guestDistDir", "publicOrigin", "ompBinaryPath"] as const) {
    const value = env[`CAW_${key.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase()}`];
    if (value !== undefined) result[key] = value;
  }
  for (const key of ["port", "relayPort", "maxActiveAgents", "authTokenTtlHours"] as const) {
    const value = env[`CAW_${key.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase()}`];
    if (value !== undefined) result[key] = value;
  }
  if (env.CAW_ALLOWED_ROOTS !== undefined) result.allowedRoots = env.CAW_ALLOWED_ROOTS.split(",").map((value) => value.trim()).filter(Boolean);
  if (env.CAW_RELAY_ALLOWED_ORIGINS !== undefined) result.relayAllowedOrigins = env.CAW_RELAY_ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean);
  for (const key of ["trustTailscaleOrigin", "insecureCookies"] as const) {
    const value = env[`CAW_${key.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase()}`];
    if (value !== undefined) result[key] = parseBoolean(value, `CAW_${key.toUpperCase()}`);
  }
  return result;
}

export function validatePublicOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`Invalid publicOrigin: must be an absolute http(s) URL: ${origin}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid publicOrigin: scheme must be http:// or https://: ${origin}`);
  }
  const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !isLocal) {
    throw new Error(`Invalid publicOrigin: must use https:// unless it targets localhost: ${origin}`);
  }
  if (url.search) {
    throw new Error(`Invalid publicOrigin: must not include a query string: ${origin}`);
  }
  if (url.hash) {
    throw new Error(`Invalid publicOrigin: must not include a fragment: ${origin}`);
  }
  if ((url.pathname !== "" && url.pathname !== "/") || (origin.endsWith("/") && !origin.endsWith("://"))) {
    throw new Error(`Invalid publicOrigin: must not include a path: ${origin}`);
  }
  return `${url.protocol}//${url.host}`;
}

export async function loadConfig(options: { env?: NodeJS.ProcessEnv; filePath?: string } = {}): Promise<ServerConfig> {
  const env = options.env ?? process.env;
  let file: RawConfig = {};
  const filePath = options.filePath ?? env.CAW_CONFIG;
  if (filePath) {
    try {
      const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
      const parsedFile = z.record(z.string(), z.unknown()).safeParse(value);
      if (!parsedFile.success) throw new Error("configuration JSON must be an object");
      file = parsedFile.data;
    } catch (error) {
      throw new Error(`Cannot read CAW_CONFIG file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const parsed = schema.safeParse({ ...file, ...envConfig(env) });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ");
    throw new Error(`Invalid server configuration: ${issues}. Check config file and CAW_* environment variables.`);
  }
  const config = parsed.data;
  if (config.port === config.relayPort) throw new Error("port and relayPort must differ; the host relay has a separate loopback listener");
  if (config.insecureCookies && !["localhost", "127.0.0.1", "::1"].includes(config.host)) throw new Error("insecureCookies is allowed only when host is localhost");
  if (!config.publicOrigin || config.publicOrigin.trim() === "") {
    config.publicOrigin = `http://127.0.0.1:${config.port}`;
  }
  config.publicOrigin = validatePublicOrigin(config.publicOrigin);
  config.stateDir = resolve(config.stateDir);
  config.allowedRoots = config.allowedRoots.map((root) => {
    const expanded = root === "~" ? homedir() : root.startsWith("~/") ? resolve(homedir(), root.slice(2)) : root;
    if (!isAbsolute(expanded)) throw new Error(`allowedRoots entry must be absolute: ${root}`);
    return resolve(expanded);
  });
  const repoRoot = findRepoRoot();
  config.webDistDir = resolveDistDir(config.webDistDir ?? "apps/web/dist", repoRoot, "webDistDir");
  config.guestDistDir = resolveDistDir(config.guestDistDir ?? "packages/guest/dist", repoRoot, "guestDistDir");
  return config;
}
