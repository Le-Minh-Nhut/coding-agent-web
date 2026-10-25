import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthenticationService, sessionCookieName } from "../../apps/server/src/auth.js";

const dirs: string[] = [];
async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), "caw-auth-"));
  dirs.push(stateDir);
  let now = 1_000_000;
  const output: string[] = [];
  const auth = createAuthenticationService({ stateDir, ttlHours: 1, now: () => now, setupOutput: (token) => output.push(token) });
  const init = await auth.initAuth();
  return { stateDir, auth, init, output, advance: (ms: number) => { now += ms; } };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("AuthenticationService", () => {
  it("creates protected setup password record and verifies password", async () => {
    const { stateDir, auth, init, output } = await setup();
    expect(init.setupRequired).toBe(true);
    expect(output).toEqual([init.setupToken]);
    expect(await auth.verifyPassword(init.setupToken!, "ip-a")).toBe(true);
    expect(await auth.verifyPassword("wrong", "ip-b")).toBe(false);
    const record = JSON.parse(await readFile(join(stateDir, "auth-password.json"), "utf8"));
    expect(record.hash).not.toBe(init.setupToken);
    expect((await stat(join(stateDir, "auth-password.json"))).mode & 0o777).toBe(0o600);
    expect((await auth.initAuth()).setupRequired).toBe(false);
  });

  it("issues hashed sessions, validates expiry and CSRF, supports revoke-all", async () => {
    const { auth, advance } = await setup();
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
  });

  it("applies per-IP backoff and global distributed threshold backoff", async () => {
    const { auth, init, advance } = await setup();
    expect(await auth.verifyPassword("wrong", "ip-a")).toBe(false);
    // ip-b is from a different address and is not locked out by ip-a
    expect(await auth.verifyPassword(init.setupToken!, "ip-b")).toBe(true);
    // ip-a is still in its 250ms backoff window
    expect(await auth.verifyPassword(init.setupToken!, "ip-a")).toBe(false);
    advance(250);
    expect(await auth.verifyPassword(init.setupToken!, "ip-a")).toBe(true);
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

  it("SEC-5: wrong passwords from several different addresses do not lock out the owner from a fresh address", async () => {
    const { auth, init } = await setup();
    // Multiple different attacker addresses attempt wrong passwords
    for (let i = 1; i <= 5; i++) {
      expect(await auth.verifyPassword(`wrong-${i}`, `attacker-ip-${i}`)).toBe(false);
    }
    // Owner logs in from a fresh address with the correct password — must succeed immediately
    expect(await auth.verifyPassword(init.setupToken!, "owner-ip-fresh")).toBe(true);
  });

  it("SEC-5: global lockout only engages after 50 distributed failures", async () => {
    const { auth, init, advance } = await setup();
    for (let i = 1; i <= 50; i++) {
      expect(await auth.verifyPassword(`wrong-${i}`, `dist-ip-${i}`)).toBe(false);
    }
    // 50 failures reached: global lockout engages even for fresh addresses
    expect(await auth.verifyPassword(init.setupToken!, "fresh-ip")).toBe(false);
    advance(250);
    expect(await auth.verifyPassword(init.setupToken!, "fresh-ip")).toBe(true);
  });
});
