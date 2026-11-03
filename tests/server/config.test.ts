import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, validatePublicOrigin } from "../../apps/server/src/config.js";
import { redactLogValue } from "../../apps/server/src/logger.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("server configuration", () => {
  it("applies secure defaults and env overrides", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "caw-root-")); dirs.push(repoRoot);
    const config = await loadConfig({ env: {}, repoRoot });
    expect(config.host).toBe("127.0.0.1"); expect(config.port).toBe(8791); expect(config.allowedRoots).toEqual([]);
    expect(config.stateDir).toBe(join(homedir(), ".local/state/coding-agent-web"));
    expect(config.configFile).toBeUndefined();
    const overridden = await loadConfig({ env: { CAW_PORT: "9000", CAW_ALLOWED_ROOTS: "/tmp,/var/tmp", CAW_INSECURE_COOKIES: "true" }, repoRoot });
    expect(overridden.port).toBe(9000); expect(overridden.allowedRoots).toEqual(["/tmp", "/var/tmp"]);
    await expect(loadConfig({ env: { CAW_INSECURE_COOKIES: "true", CAW_HOST: "0.0.0.0" }, repoRoot })).rejects.toThrow("localhost");
    expect(config.ompBinaryPath).toBeUndefined();
    expect((await loadConfig({ env: { CAW_OMP_BINARY_PATH: "/tmp/stub-omp" }, repoRoot })).ompBinaryPath).toBe("/tmp/stub-omp");
  });

  it("discovers repo config and honors explicit path precedence", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "caw-root-")); dirs.push(repoRoot);
    const repoFile = join(repoRoot, "caw.config.json");
    await writeFile(repoFile, JSON.stringify({ allowedRoots: ["/repo-root"], publicOrigin: "https://repo.example.ts.net" }));
    const envFile = join(repoRoot, "env.json");
    await writeFile(envFile, JSON.stringify({ allowedRoots: ["/env-file"] }));
    const explicitFile = join(repoRoot, "explicit.json");
    await writeFile(explicitFile, JSON.stringify({ allowedRoots: ["/explicit"] }));
    const discovered = await loadConfig({ env: {}, repoRoot });
    expect(discovered.allowedRoots).toEqual(["/repo-root"]);
    expect(discovered.configFile).toBe(repoFile);
    expect((await loadConfig({ env: { CAW_CONFIG: envFile }, repoRoot })).allowedRoots).toEqual(["/env-file"]);
    const explicit = await loadConfig({ filePath: explicitFile, env: { CAW_CONFIG: envFile }, repoRoot });
    expect(explicit.allowedRoots).toEqual(["/explicit"]);
    expect(explicit.configFile).toBe(explicitFile);
  });

  it("uses defaults when autodiscovery finds no file and names malformed files", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "caw-root-")); dirs.push(repoRoot);
    const defaults = await loadConfig({ env: {}, repoRoot });
    expect(defaults.configFile).toBeUndefined();
    const configFile = join(repoRoot, "caw.config.json");
    await writeFile(configFile, "{");
    await expect(loadConfig({ env: {}, repoRoot })).rejects.toThrow(configFile);
  });

  it("merges JSON file and env, reports invalid settings, redacts secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "caw-config-")); dirs.push(dir);
    const file = join(dir, "config.json"); await writeFile(file, JSON.stringify({ port: 8123, allowedRoots: [dir] }));
    const config = await loadConfig({ filePath: file, env: { CAW_PORT: "8124" }, repoRoot: dir });
    expect(config.port).toBe(8124); expect(config.allowedRoots).toEqual([dir]);
    expect(config.configFile).toBe(file);
    await expect(loadConfig({ env: { CAW_PORT: "nope" }, repoRoot: dir })).rejects.toThrow("Invalid server configuration");
    expect(redactLogValue({ cookie: "session-secret", message: "authorization: Bearer secret" })).toEqual({ cookie: "[REDACTED]", message: "authorization=[REDACTED]" });
    expect(redactLogValue("https://example.test/path#credential")).toBe("https://example.test/path#[REDACTED]");
  });


  it("SEC-8: redactLogValue redacts room links when passed an Error instance", () => {
    const rawLink = "ws://127.0.0.1:8792/r/testroom123456789.supersecretkeyvalue123456789012345";
    const err = new Error(`Connection failed for ${rawLink}`);
    const redacted = redactLogValue(err);
    expect(typeof redacted).toBe("string");
    expect(String(redacted)).not.toContain("supersecretkeyvalue");
    expect(String(redacted)).toContain("[COLLAB_LINK]");

    // Object wrapping an Error
    const wrapped = redactLogValue({ err: new Error(`Failed to mint ${rawLink}`) });
    expect(JSON.stringify(wrapped)).not.toContain("supersecretkeyvalue");
  });

  it("publicOrigin validation rejects a value with a path, a query, a fragment, or a non-http scheme", async () => {
    // Derives default
    const repoRoot = await mkdtemp(join(tmpdir(), "caw-root-")); dirs.push(repoRoot);
    const def = await loadConfig({ env: { CAW_PORT: "8800" }, repoRoot });
    expect(def.publicOrigin).toBe("http://127.0.0.1:8800");
    expect(def.configFile).toBeUndefined();

    // Accepts valid http/https origin
    const valid = await loadConfig({ env: { CAW_PUBLIC_ORIGIN: "https://my-workstation.ts.net" }, repoRoot });
    expect(valid.publicOrigin).toBe("https://my-workstation.ts.net");

    // Rejects path
    await expect(loadConfig({ env: { CAW_PUBLIC_ORIGIN: "https://my-workstation.ts.net/subpath" }, repoRoot })).rejects.toThrow();
    await expect(loadConfig({ env: { CAW_PUBLIC_ORIGIN: "https://my-workstation.ts.net/" }, repoRoot })).rejects.toThrow();

    // Rejects query
    await expect(loadConfig({ env: { CAW_PUBLIC_ORIGIN: "https://my-workstation.ts.net?query=1" }, repoRoot })).rejects.toThrow();

    // Rejects fragment
    await expect(loadConfig({ env: { CAW_PUBLIC_ORIGIN: "https://my-workstation.ts.net#frag" }, repoRoot })).rejects.toThrow();

    // Rejects non-http scheme
    await expect(loadConfig({ env: { CAW_PUBLIC_ORIGIN: "ws://my-workstation.ts.net" }, repoRoot })).rejects.toThrow();
    await expect(loadConfig({ env: { CAW_PUBLIC_ORIGIN: "ftp://127.0.0.1:8791" }, repoRoot })).rejects.toThrow();

    // Direct validatePublicOrigin helper check
    expect(validatePublicOrigin("https://host.example.com")).toBe("https://host.example.com");
    expect(() => validatePublicOrigin("https://host.example.com/path")).toThrow();
    expect(() => validatePublicOrigin("https://host.example.com?q=1")).toThrow();
    expect(() => validatePublicOrigin("https://host.example.com#hash")).toThrow();
    expect(() => validatePublicOrigin("ws://host.example.com")).toThrow();
  });
});
