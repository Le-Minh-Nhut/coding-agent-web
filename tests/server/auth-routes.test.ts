import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthenticationService } from "../../apps/server/src/auth.js";
import { buildApp } from "../../apps/server/src/app.js";
import type { ServerConfig } from "../../apps/server/src/config.js";
import { createMetadataStore } from "../../apps/server/src/store.js";

const dirs: string[] = [];
const origin = "https://workspace.test";
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), "caw-auth-routes-"));
  dirs.push(stateDir);
  let now = 1_000_000;
  const auth = createAuthenticationService({ stateDir, ttlHours: 1, now: () => now, setupOutput: () => undefined });
  const init = await auth.initAuth();
  const config: ServerConfig = {
    host: "127.0.0.1", port: 8791, stateDir, allowedRoots: [stateDir], relayPort: 8792,
    relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 1,
    trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: false,
  };
  const app = buildApp({ config, auth, store: createMetadataStore(stateDir), originAllowlist: [origin] });
  return { app, auth, init, advance: (ms: number) => { now += ms; } };
}

function cookieOf(response: { headers: Record<string, string | string[] | undefined> }): string {
  const header = response.headers["set-cookie"];
  if (typeof header !== "string") throw new Error("Expected session cookie");
  return header.split(";", 1)[0]!;
}

describe("Authentication routes", () => {
  it("gates pending-token sessions to password setup and permits subsequent password login", async () => {
    const { app, init, advance } = await setup();
    app.get("/api/test/future-route", async () => ({ reachable: true }));
    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { password: init.setupToken } });
    expect(login.statusCode).toBe(200);
    expect(login.json().data).toMatchObject({ status: "password_setup_required" });
    const setupCookie = cookieOf(login);
    const csrfToken: string = login.json().data.csrfToken;

    const blocked = await app.inject({ method: "GET", url: "/api/capabilities", headers: { cookie: setupCookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toMatchObject({ code: "unauthorized" });
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: setupCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.csrfToken).toBe(csrfToken);
    const futureRoute = await app.inject({ method: "GET", url: "/api/test/future-route", headers: { cookie: setupCookie } });
    expect(futureRoute.statusCode).toBe(403);
    expect(futureRoute.json().error).toMatchObject({ code: "unauthorized" });

    const sameToken = await app.inject({
      method: "POST", url: "/api/auth/set-password", headers: { origin, cookie: setupCookie, "x-caw-csrf": csrfToken },
      payload: { password: init.setupToken },
    });
    expect(sameToken.statusCode).toBe(400);
    expect(sameToken.json().error.code).toBe("bad_request");
    const setPassword = await app.inject({
      method: "POST", url: "/api/auth/set-password", headers: { origin, cookie: setupCookie, "x-caw-csrf": csrfToken },
      payload: { password: "correct horse battery" },
    });
    expect(setPassword.statusCode).toBe(200);
    expect(setPassword.json().data).toMatchObject({ status: "authenticated", csrfToken });
    expect(setPassword.headers["set-cookie"]).toBeUndefined();

    const passwordLogin = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { password: "correct horse battery" } });
    expect(passwordLogin.statusCode).toBe(200);
    expect(passwordLogin.json().data.status).toBe("authenticated");
    advance(250);
    const oldToken = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { password: init.setupToken } });
    expect(oldToken.statusCode).toBe(401);
    expect(oldToken.json().error.code).toBe("unauthorized");
    await app.close();
  });

  it("requires authenticated password change and revokes every other session", async () => {
    const { app, auth, init, advance } = await setup();
    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { password: init.setupToken } });
    const currentCookie = cookieOf(login);
    const csrfToken: string = login.json().data.csrfToken;
    const setPassword = await app.inject({
      method: "POST", url: "/api/auth/set-password", headers: { origin, cookie: currentCookie, "x-caw-csrf": csrfToken },
      payload: { password: "correct horse battery" },
    });
    expect(setPassword.statusCode).toBe(200);
    const other = auth.createSession();
    const otherCookie = `${auth.cookieName}=${other.token}`;
    const noSession = await app.inject({ method: "POST", url: "/api/auth/change-password", headers: { origin }, payload: { currentPassword: "correct horse battery", newPassword: "new secure password" } });
    expect(noSession.statusCode).toBe(401);

    const changed = await app.inject({
      method: "POST", url: "/api/auth/change-password", headers: { origin, cookie: currentCookie, "x-caw-csrf": csrfToken },
      payload: { currentPassword: "correct horse battery", newPassword: "new secure password" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().data).toEqual({ changed: true });
    expect(changed.headers["set-cookie"]).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: currentCookie } })).statusCode).toBe(200);
    const revoked = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: otherCookie } });
    expect(revoked.statusCode).toBe(401);

    advance(250);
    const oldPassword = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { password: "correct horse battery" } });
    expect(oldPassword.statusCode).toBe(401);
    advance(250);
    const newPassword = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { password: "new secure password" } });
    expect(newPassword.statusCode).toBe(200);
    await app.close();
  });
});
