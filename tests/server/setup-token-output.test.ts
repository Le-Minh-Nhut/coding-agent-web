import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";

const failureControl = vi.hoisted(() => ({ failRename: false, failUnlink: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (failureControl.failRename) {
        failureControl.failRename = false;
        throw new Error("simulated auth record commit failure");
      }
      return actual.rename(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (failureControl.failUnlink) {
        failureControl.failUnlink = false;
        throw Object.assign(new Error("simulated unlink permission failure"), { code: "EACCES" });
      }
      return actual.unlink(...args);
    },
  };
});
import { createAuthenticationService } from "../../apps/server/src/auth.js";
import { buildApp } from "../../apps/server/src/app.js";
import type { ServerConfig } from "../../apps/server/src/config.js";
import { createMetadataStore } from "../../apps/server/src/store.js";

const dirs: string[] = [];
const origin = "https://workspace.test";
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("first-run setup token output", () => {
  it("prints only the token-file path and accepts file contents for password setup", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "caw-setup-output-"));
    dirs.push(stateDir);
    const auth = createAuthenticationService({ stateDir });
    let output = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = function (chunk: string | Uint8Array, ...args: unknown[]) {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    } as typeof process.stdout.write;
    try {
      await auth.initAuth();
    } finally {
      process.stdout.write = originalWrite;
    }

    const tokenPath = join(stateDir, "setup-token");
    const token = await readFile(tokenPath, "utf8");
    expect(output).not.toContain(token);
    expect(output).toContain(`written to ${tokenPath}; read it with: cat ${tokenPath}`);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);

    const config: ServerConfig = {
      host: "127.0.0.1", port: 18791, stateDir, allowedRoots: [stateDir], relayPort: 18792,
      relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 1,
      trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: true,
    };
    const app = buildApp({ config, auth, store: createMetadataStore(stateDir), originAllowlist: [origin] });
    try {
      const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { password: token } });
      expect(login.statusCode).toBe(200);
      const cookie = login.headers["set-cookie"];
      if (typeof cookie !== "string") throw new Error("Expected setup session cookie");
      const result = await app.inject({
        method: "POST", url: "/api/auth/set-password", headers: { origin, cookie: cookie.split(";", 1)[0]!, "x-caw-csrf": login.json().data.csrfToken },
        payload: { password: "correct horse battery" },
      });
      expect(result.statusCode).toBe(200);
      await expect(stat(tokenPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app.close();
    }
  });
  it("recovers a pending record stranded without its token file", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "caw-setup-recovery-"));
    dirs.push(stateDir);
    const first = createAuthenticationService({ stateDir });
    await first.initAuth();
    await rm(join(stateDir, "setup-token"));

    const recovered = createAuthenticationService({ stateDir });
    const init = await recovered.initAuth();
    const path = join(stateDir, "setup-token");
    const token = await readFile(path, "utf8");
    expect(init.setupRequired).toBe(true);
    expect(init.setupToken).toBe(token);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await recovered.authenticate(token, "recovery-ip")).toBe("setup");
  });

  it("leaves no pending record when committing the record fails after token-file write", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "caw-setup-commit-failure-"));
    dirs.push(stateDir);
    const auth = createAuthenticationService({ stateDir, setupOutput: () => undefined });
    failureControl.failRename = true;
    await expect(auth.initAuth()).rejects.toThrow("simulated auth record commit failure");
    await expect(stat(join(stateDir, "auth-password.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(stateDir, "setup-token"))).rejects.toMatchObject({ code: "ENOENT" });

    const retried = createAuthenticationService({ stateDir, setupOutput: () => undefined });
    const init = await retried.initAuth();
    expect(init.setupRequired).toBe(true);
    expect(await retried.authenticate(init.setupToken!, "retry-ip")).toBe("setup");
  });
  it("does not rotate an expired pending token file on restart", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "caw-setup-expired-"));
    dirs.push(stateDir);
    let now = 1_000_000;
    const first = createAuthenticationService({ stateDir, now: () => now, setupOutput: () => undefined });
    const initial = await first.initAuth();
    const path = join(stateDir, "setup-token");
    const token = await readFile(path, "utf8");
    now += 15 * 60_000;
    let output = "";
    const restarted = createAuthenticationService({ stateDir, now: () => now, setupOutput: (filePath) => { output = filePath; } });
    expect((await restarted.initAuth()).setupRequired).toBe(true);
    expect(output).toBe("");
    expect(await readFile(path, "utf8")).toBe(token);
    expect(await restarted.authenticate(initial.setupToken!, "expired-ip")).toBe(false);
  });
  it("rolls back a failed repair and allows the next boot to mint a usable token", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "caw-setup-repair-failure-"));
    dirs.push(stateDir);
    const first = createAuthenticationService({ stateDir, setupOutput: () => undefined });
    await first.initAuth();
    await rm(join(stateDir, "setup-token"));
    failureControl.failRename = true;
    const repair = createAuthenticationService({ stateDir, setupOutput: () => undefined });
    await expect(repair.initAuth()).rejects.toThrow("simulated auth record commit failure");
    await expect(stat(join(stateDir, "setup-token"))).rejects.toMatchObject({ code: "ENOENT" });

    const retry = createAuthenticationService({ stateDir, setupOutput: () => undefined });
    const init = await retry.initAuth();
    const token = await readFile(join(stateDir, "setup-token"), "utf8");
    expect(init.setupToken).toBe(token);
    expect(await retry.authenticate(token, "repair-retry-ip")).toBe("setup");
  });

  it("replaces corrupt pending token files with a usable 0600 token", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "caw-setup-corrupt-"));
    dirs.push(stateDir);
    const first = createAuthenticationService({ stateDir, setupOutput: () => undefined });
    await first.initAuth();
    const path = join(stateDir, "setup-token");
    await writeFile(path, "");

    const repaired = createAuthenticationService({ stateDir, setupOutput: () => undefined });
    const init = await repaired.initAuth();
    const token = await readFile(path, "utf8");
    expect(init.setupToken).toBe(token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await repaired.authenticate(token, "corrupt-repair-ip")).toBe("setup");
  });

  it("removes consumed token file and remints a usable token through restart", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "caw-setup-consumed-"));
    dirs.push(stateDir);
    const first = createAuthenticationService({ stateDir, setupOutput: () => undefined });
    const initial = await first.initAuth();
    const path = join(stateDir, "setup-token");
    expect(await first.authenticate(initial.setupToken!, "consumed-ip")).toBe("setup");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });

    const restarted = createAuthenticationService({ stateDir, setupOutput: () => undefined });
    const next = await restarted.initAuth();
    const token = await readFile(path, "utf8");
    expect(next.setupToken).toBe(token);
    expect(token).not.toBe(initial.setupToken);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await restarted.authenticate(initial.setupToken!, "old-token-ip")).toBe(false);

    const config: ServerConfig = {
      host: "127.0.0.1", port: 18791, stateDir, allowedRoots: [stateDir], relayPort: 18792,
      relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 1,
      trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: true,
    };
    const app = buildApp({ config, auth: restarted, store: createMetadataStore(stateDir), originAllowlist: [origin] });
    try {
      const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { password: token } });
      expect(login.statusCode).toBe(200);
      const cookie = login.headers["set-cookie"];
      if (typeof cookie !== "string") throw new Error("Expected setup session cookie");
      const setPassword = await app.inject({
        method: "POST", url: "/api/auth/set-password", headers: { origin, cookie: cookie.split(";", 1)[0]!, "x-caw-csrf": login.json().data.csrfToken },
        payload: { password: "correct horse battery" },
      });
      expect(setPassword.statusCode).toBe(200);
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app.close();
    }
  });
  it("rejects login if token-file unlink fails after persisting used state", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "caw-setup-unlink-failure-"));
    dirs.push(stateDir);
    const auth = createAuthenticationService({ stateDir, setupOutput: () => undefined });
    const init = await auth.initAuth();
    const path = join(stateDir, "setup-token");
    failureControl.failUnlink = true;

    expect(await auth.authenticate(init.setupToken!, "unlink-failure-ip")).toBe(false);
    const record = JSON.parse(await readFile(join(stateDir, "auth-password.json"), "utf8"));
    expect(record).toMatchObject({ kind: "pending", used: true });
    expect(await readFile(path, "utf8")).toBe(init.setupToken);
  });
});
