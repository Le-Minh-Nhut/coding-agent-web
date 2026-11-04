import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeProfileName, resolveOmpDirs } from "../../packages/omp-adapter/src/omp-dirs.js";
import { DefaultSessionLeaseProbe } from "../../packages/omp-adapter/src/session-lease.js";
import { DefaultNativeSessionCatalog } from "../../packages/omp-adapter/src/session-catalog.js";

const envNames = ["XDG_STATE_HOME", "XDG_DATA_HOME", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR"] as const;
const savedEnv = new Map<string, string | undefined>();
let scratchDir: string;

beforeEach(async () => {
  for (const name of envNames) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  scratchDir = await mkdtemp(path.join(tmpdir(), "caw-omp-dirs-"));
});

afterEach(async () => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  await rm(scratchDir, { recursive: true, force: true });
});

describe("omp-dirs", () => {
  it("uses default paths with default environment", () => {
    expect(resolveOmpDirs()).toEqual({
      sessionsDir: path.join(homedir(), ".omp", "agent", "sessions"),
      sessionOwnersDir: path.join(homedir(), ".omp", "run", "session-owners"),
      collabHostsDir: path.join(homedir(), ".omp", "run", "collab-hosts"),
    });
  });

  it("does not adopt unset-up XDG state root", () => {
    process.env.XDG_STATE_HOME = path.join(scratchDir, "state");
    const dirs = resolveOmpDirs();
    expect(dirs.sessionOwnersDir).toBe(path.join(homedir(), ".omp", "run", "session-owners"));
    expect(dirs.collabHostsDir).toBe(path.join(homedir(), ".omp", "run", "collab-hosts"));
  });

  it("keeps session lease probe on base root when XDG state root is absent", () => {
    process.env.XDG_STATE_HOME = path.join(scratchDir, "state");
    const sessionId = "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e";
    const expected = new DefaultSessionLeaseProbe({
      ownersDir: path.join(homedir(), ".omp", "run", "session-owners"),
    }).leaseName(sessionId);
    expect(new DefaultSessionLeaseProbe().leaseName(sessionId)).toBe(expected);
  });

  it("adopts created XDG state root for leases, not collab registry", async () => {
    const stateHome = path.join(scratchDir, "state");
    await mkdir(path.join(stateHome, "omp"), { recursive: true });
    process.env.XDG_STATE_HOME = stateHome;
    const dirs = resolveOmpDirs();
    expect(dirs.sessionOwnersDir).toBe(path.join(stateHome, "omp", "run", "session-owners"));
    expect(dirs.collabHostsDir).toBe(path.join(homedir(), ".omp", "run", "collab-hosts"));
  });

  it("adopts created XDG data root for sessions", async () => {
    const dataHome = path.join(scratchDir, "data");
    await mkdir(path.join(dataHome, "omp"), { recursive: true });
    process.env.XDG_DATA_HOME = dataHome;
    expect(resolveOmpDirs().sessionsDir).toBe(path.join(dataHome, "omp", "sessions"));
  });

  it("honors PI_CONFIG_DIR", () => {
    process.env.PI_CONFIG_DIR = ".omp-test";
    expect(resolveOmpDirs().collabHostsDir).toBe(path.join(homedir(), ".omp-test", "run", "collab-hosts"));
  });

  it("honors PI_CODING_AGENT_DIR without a profile", () => {
    const agentDir = path.join(scratchDir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    expect(resolveOmpDirs({ agentDirOverride: process.env.PI_CODING_AGENT_DIR }).sessionsDir).toBe(path.join(agentDir, "sessions"));
  });
  it("prefers explicit agent dir over XDG data root", async () => {
    const dataHome = path.join(scratchDir, "override-data");
    const agentDir = path.join(scratchDir, "override-agent");
    await mkdir(path.join(dataHome, "omp"), { recursive: true });
    process.env.XDG_DATA_HOME = dataHome;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    expect(resolveOmpDirs({ agentDirOverride: process.env.PI_CODING_AGENT_DIR }).sessionsDir).toBe(path.join(agentDir, "sessions"));
  });

  it("uses PI_CODING_AGENT_DIR from env in session catalog constructor", async () => {
    const agentDir = path.join(scratchDir, "catalog-agent");
    const sessionsDir = path.join(agentDir, "sessions");
    const sessionId = "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e";
    await mkdir(path.join(sessionsDir, "bucket"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const sessionPath = path.join(sessionsDir, "bucket", `${sessionId}.jsonl`);
    await writeFile(sessionPath, "");
    expect(await new DefaultNativeSessionCatalog().findBySessionId(sessionId)).toBe(sessionPath);
  });

  it("keeps machine-global paths outside profile agent root", () => {
    process.env.OMP_PROFILE = "work";
    expect(resolveOmpDirs().sessionsDir).toBe(path.join(homedir(), ".omp", "profiles", "work", "agent", "sessions"));
    expect(resolveOmpDirs().sessionOwnersDir).toBe(path.join(homedir(), ".omp", "run", "session-owners"));
    expect(resolveOmpDirs().collabHostsDir).toBe(path.join(homedir(), ".omp", "run", "collab-hosts"));
  });

  it("normalizes default profile and rejects malformed names", () => {
    expect(normalizeProfileName("default")).toBeUndefined();
    expect(() => normalizeProfileName("Bad Name")).toThrow();
  });
});
