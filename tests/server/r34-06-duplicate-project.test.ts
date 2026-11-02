import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAuthenticationService } from "../../apps/server/src/auth.js";
import { buildApp } from "../../apps/server/src/app.js";
import { createMetadataStore } from "../../apps/server/src/store.js";
import { WorkspacePathPolicy } from "../../apps/server/src/path-policy.js";
import type { ServerConfig } from "../../apps/server/src/config.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture(paths?: WorkspacePathPolicy) {
  const dir = await mkdtemp(join(tmpdir(), "caw-r34-")); dirs.push(dir);
  const target = join(dir, "project"); await mkdir(target);
  const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => undefined }); await auth.initAuth();
  const config: ServerConfig = { host: "127.0.0.1", port: 8791, stateDir: dir, allowedRoots: [dir], relayPort: 8792, relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 720, trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: false };
  const app = buildApp({ config, auth, store: createMetadataStore(join(dir, "state")), originAllowlist: ["https://workspace.test"], ...(paths ? { paths } : {}) });
  const session = auth.createSession();
  return { app, dir, target, headers: { cookie: `__Host-caw_session=${session.token}`, origin: "https://workspace.test", "x-caw-csrf": session.csrfToken } };
}

it("R34-06: duplicate canonical paths and filesystem errors map correctly", async () => {
  const { app, dir, target, headers } = await fixture();
  const create = (path: string) => app.inject({ method: "POST", url: "/api/projects", headers, payload: { path, label: "project" } });
  try {
    expect((await create(target)).statusCode).toBe(201);
    const duplicate = await create(target);
    expect.soft(duplicate.statusCode).toBe(409);
    for (const alias of [`${target}/`, `${dir}//project`]) expect.soft((await create(alias)).statusCode).toBe(409);
    // WorkspacePathPolicy deliberately rejects dot segments rather than resolving them.
    expect((await create(`${dir}/./project`)).statusCode).not.toBe(201);
    expect((await create(`${dir}/x/../project`)).statusCode).not.toBe(201);
  } finally { await app.close(); }

  class IoFailurePolicy extends WorkspacePathPolicy {
    override async assertInsideRoots(path: string, requireDirectory = false): Promise<string> {
      if (path.endsWith("/io-failure")) throw Object.assign(new Error("simulated filesystem failure"), { code: "EIO" });
      return super.assertInsideRoots(path, requireDirectory);
    }
  }
  const io = await fixture(new IoFailurePolicy([dir]));
  try {
    const response = await io.app.inject({ method: "POST", url: "/api/projects", headers: io.headers, payload: { path: `${io.dir}/io-failure` } });
    expect(response.statusCode).not.toBe(409);
    expect(response.statusCode).toBe(500);
  } finally { await io.app.close(); }
});
