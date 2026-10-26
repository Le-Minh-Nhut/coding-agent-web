import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthenticationService, sessionCookieName, type AuthenticationService } from "../../apps/server/src/auth.js";

const dirs: string[] = [];
async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), "caw-auth-"));
  dirs.push(stateDir);
  let now = 1_000_000;
  const output: string[] = [];
  const auth = createAuthenticationService({ stateDir, ttlHours: 1, now: () => now, setupOutput: (token) => output.push(token) });
  const init = await auth.initAuth();
  return { stateDir, auth, init, output, now: () => now, advance: (ms: number) => { now += ms; } };
}

async function setPassword(auth: AuthenticationService, token: string, password = "correct horse battery") {
  expect(await auth.authenticate(token, "owner-ip")).toBe("setup");
  const setupSession = auth.createSession(true);
  expect(await auth.completePasswordSetup(password, setupSession.token)).toBe("changed");
  return setupSession;
}

afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("AuthenticationService", () => {
  it("consumes bootstrap token once, sets password, and keeps token invalid across reloads", async () => {
    const { stateDir, auth, init, output } = await setup();
    expect(init.setupRequired).toBe(true);
    expect(output).toEqual([init.setupToken]);
    const setupLogin = await auth.authenticate(init.setupToken!, "owner-ip");
    expect(setupLogin).toBe("setup");
    expect(await auth.verifyPassword(init.setupToken!, "another-ip")).toBe(false);

    const setupSession = auth.createSession(true);
    const afterTokenUse = createAuthenticationService({ stateDir, now: () => 1_000_000, setupOutput: () => undefined });
    expect((await afterTokenUse.initAuth()).setupRequired).toBe(true);
    expect(await afterTokenUse.authenticate(init.setupToken!, "reload-ip")).toBe(false);

    expect(await auth.completePasswordSetup(init.setupToken!, setupSession.token)).toBe("matches_pending_token");
    expect(await auth.completePasswordSetup("correct horse battery", setupSession.token)).toBe("changed");
    expect(await auth.authenticate("correct horse battery", "owner-ip")).toBe("password");
    expect(await auth.authenticate("wrong password", "wrong-ip")).toBe(false);
    expect(await auth.authenticate(init.setupToken!, "reuse-ip")).toBe(false);
    const reloaded = createAuthenticationService({ stateDir, setupOutput: () => undefined });
    expect((await reloaded.initAuth()).setupRequired).toBe(false);
    expect(await reloaded.authenticate(init.setupToken!, "restart-ip")).toBe(false);
    expect(await reloaded.authenticate("correct horse battery", "fresh-restart-ip")).toBe("password");

    const record = JSON.parse(await readFile(join(stateDir, "auth-password.json"), "utf8"));
    expect(record.kind).toBe("password");
    expect(record.hash).not.toBe(init.setupToken);
    expect((await stat(join(stateDir, "auth-password.json"))).mode & 0o777).toBe(0o600);
  });

  it("requires an authenticated session to change password and keeps only that session", async () => {
    const { auth, init } = await setup();
    const current = await setPassword(auth, init.setupToken!);
    const other = auth.createSession();
    expect(await auth.changePassword("correct horse battery", "new secure password", "missing-session", "ip-a")).toBe(false);
    expect(await auth.changePassword("correct horse battery", "new secure password", current.token, "ip-a")).toBe(true);
    expect(await auth.authenticate("correct horse battery", "old-ip")).toBe(false);
    expect(await auth.authenticate("new secure password", "new-ip")).toBe("password");
    expect(auth.verifySession(current.token)).not.toBeNull();
    expect(auth.verifySession(other.token)).toBeNull();
  });

  it("migrates old on-disk password records and allows their credential to be rotated", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "caw-auth-"));
    dirs.push(stateDir);
    const salt = "1234567890abcdef1234567890abcdef";
    const legacyToken = "legacy-bootstrap-token";
    await writeFile(join(stateDir, "auth-password.json"), JSON.stringify({
      salt,
      hash: scryptSync(legacyToken, Buffer.from(salt, "hex"), 64).toString("hex"),
    }), { mode: 0o600 });

    const auth = createAuthenticationService({ stateDir, setupOutput: () => undefined });
    expect((await auth.initAuth()).setupRequired).toBe(false);
    const migrated = JSON.parse(await readFile(join(stateDir, "auth-password.json"), "utf8"));
    expect(migrated.legacy).toBe(true);
    expect(await auth.authenticate(legacyToken, "legacy-ip")).toBe("password");
    const session = auth.createSession();
    expect(await auth.changePassword(legacyToken, "rotated secure password", session.token, "legacy-ip")).toBe(true);
    expect(await auth.authenticate(legacyToken, "legacy-ip")).toBe(false);
    expect(await auth.authenticate("rotated secure password", "fresh-legacy-ip")).toBe("password");
    expect(JSON.parse(await readFile(join(stateDir, "auth-password.json"), "utf8")).legacy).toBeUndefined();
  });
  it("resets only the auth record and mints a fresh pending token", async () => {
    const { stateDir, auth, init } = await setup();
    const markerPath = join(stateDir, "projects.jsonl");
    await writeFile(markerPath, "preserve this metadata\n");
    const existingSession = auth.createSession();
    const output: string[] = [];
    const resetter = createAuthenticationService({ stateDir, setupOutput: (token) => output.push(token) });
    const newToken = await resetter.resetAuth();
    expect(output).toEqual([newToken]);
    expect(newToken).not.toBe(init.setupToken);
    expect(await readFile(markerPath, "utf8")).toBe("preserve this metadata\n");
    expect(auth.verifySession(existingSession.token)).not.toBeNull();
    const reloaded = createAuthenticationService({ stateDir, setupOutput: () => undefined });
    expect((await reloaded.initAuth()).setupRequired).toBe(true);
    expect(await reloaded.authenticate(init.setupToken!, "old-token-ip")).toBe(false);
    expect(await reloaded.authenticate(newToken, "new-token-ip")).toBe("setup");
  });

  it("refuses expired pending tokens", async () => {
    const { auth, init, advance } = await setup();
    advance(15 * 60 * 1000);
    expect(await auth.authenticate(init.setupToken!, "expired-ip")).toBe(false);
  });

  it("issues hashed sessions, validates expiry and CSRF, supports revoke-all, and preserves cookie flags", async () => {
    const { auth, init, advance } = await setup();
    await setPassword(auth, init.setupToken!);
    const session = auth.createSession();
    expect(session.token).toHaveLength(43);
    expect(auth.verifySession(session.token)?.csrfToken).toBe(session.csrfToken);
    expect(auth.verifyCsrf(session.token, "wrong")).toBe(false);
    expect(auth.verifyCsrf(session.token, session.csrfToken)).toBe(true);
    const second = auth.createSession();
    auth.revokeAll();
    expect(auth.verifySession(session.token)).toBeNull();
    expect(auth.verifySession(second.token)).toBeNull();
    const expiring = auth.createSession();
    advance(60 * 60 * 1000);
    expect(auth.verifySession(expiring.token)).toBeNull();
    const cookie = auth.cookie("token", 60);
    expect(cookie).toContain(`${sessionCookieName}=token`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(auth.clearCookie()).toContain("Max-Age=0");
    const dev = createAuthenticationService({ stateDir: "/tmp/dev-cookie-test", insecureCookies: true });
    expect(dev.cookieName).toBe("caw_session");
    expect(dev.cookie("token", 60)).not.toContain("Secure");
  });

  it("retains per-IP backoff and only engages global lockout after 50 distributed failures", async () => {
    const { auth, init, advance } = await setup();
    await setPassword(auth, init.setupToken!);
    expect(await auth.authenticate("wrong", "ip-a")).toBe(false);
    expect(await auth.authenticate("correct horse battery", "ip-b")).toBe("password");
    expect(await auth.authenticate("correct horse battery", "ip-a")).toBe(false);
    advance(250);
    expect(await auth.authenticate("correct horse battery", "ip-a")).toBe("password");
    for (let i = 1; i <= 50; i++) expect(await auth.authenticate(`wrong-${i}`, `dist-ip-${i}`)).toBe(false);
    expect(await auth.authenticate("correct horse battery", "fresh-ip")).toBe(false);
    advance(250);
    expect(await auth.authenticate("correct horse battery", "fresh-ip")).toBe("password");
  });
});
