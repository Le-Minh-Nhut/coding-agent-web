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
    const config = await loadConfig({ env: {} });
    expect(config.host).toBe("127.0.0.1"); expect(config.port).toBe(8791); expect(config.allowedRoots).toEqual([]);
    expect(config.stateDir).toBe(join(homedir(), ".local/state/coding-agent-web"));
    const overridden = await loadConfig({ env: { CAW_PORT: "9000", CAW_ALLOWED_ROOTS: "/tmp,/var/tmp", CAW_INSECURE_COOKIES: "true" } });
    expect(overridden.port).toBe(9000); expect(overridden.allowedRoots).toEqual(["/tmp", "/var/tmp"]);
    await expect(loadConfig({ env: { CAW_INSECURE_COOKIES: "true", CAW_HOST: "0.0.0.0" } })).rejects.toThrow("localhost");
    // One binary knob for every omp call the server makes. Unset means `omp` from
    // PATH (real deployments); set, the E2E harness points it at a recorder stub so
    // the registry read *and* the agent launch both run the stub instead of OMP.
    expect(config.ompBinaryPath).toBeUndefined();
    expect((await loadConfig({ env: { CAW_OMP_BINARY_PATH: "/tmp/stub-omp" } })).ompBinaryPath).toBe("/tmp/stub-omp");
  });

  it("merges JSON file and env, reports invalid settings, redacts secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "caw-config-")); dirs.push(dir);
    const file = join(dir, "config.json"); await writeFile(file, JSON.stringify({ port: 8123, allowedRoots: [dir] }));
    const config = await loadConfig({ filePath: file, env: { CAW_PORT: "8124" } });
    expect(config.port).toBe(8124); expect(config.allowedRoots).toEqual([dir]);
    await expect(loadConfig({ env: { CAW_PORT: "nope" } })).rejects.toThrow("Invalid server configuration");
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
    const def = await loadConfig({ env: { CAW_PORT: "8800" } });
    expect(def.publicOrigin).toBe("http://127.0.0.1:8800");

    // Accepts valid http/https origin
    const valid = await loadConfig({ env: { CAW_PUBLIC_ORIGIN: "https://my-workstation.ts.net" } });
    expect(valid.publicOrigin).toBe("https://my-workstation.ts.net");

    // Rejects path
    await expect(loadConfig({ env: { CAW_PUBLIC_ORIGIN: "https://my-workstation.ts.net/subpath" } })).rejects.toThrow();
    await expect(loadConfig({ env: { CAW_PUBLIC_ORIGIN: "https://my-workstation.ts.net/" } })).rejects.toThrow();

    // Rejects query
    await expect(loadConfig({ env: { CAW_PUBLIC_ORIGIN: "https://my-workstation.ts.net?query=1" } })).rejects.toThrow();

    // Rejects fragment
    await expect(loadConfig({ env: { CAW_PUBLIC_ORIGIN: "https://my-workstation.ts.net#frag" } })).rejects.toThrow();

    // Rejects non-http scheme
    await expect(loadConfig({ env: { CAW_PUBLIC_ORIGIN: "ws://my-workstation.ts.net" } })).rejects.toThrow();
    await expect(loadConfig({ env: { CAW_PUBLIC_ORIGIN: "ftp://127.0.0.1:8791" } })).rejects.toThrow();

    // Direct validatePublicOrigin helper check
    expect(validatePublicOrigin("https://host.example.com")).toBe("https://host.example.com");
    expect(() => validatePublicOrigin("https://host.example.com/path")).toThrow();
    expect(() => validatePublicOrigin("https://host.example.com?q=1")).toThrow();
    expect(() => validatePublicOrigin("https://host.example.com#hash")).toThrow();
    expect(() => validatePublicOrigin("ws://host.example.com")).toThrow();
  });
});
