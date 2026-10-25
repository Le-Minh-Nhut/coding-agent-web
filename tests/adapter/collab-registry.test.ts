import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DefaultCollabRegistryService,
  parseCollabHost,
  parseCollabListOutput,
} from "../../packages/omp-adapter/src/collab-registry.js";
import { RegistryUnreadableError } from "../../packages/omp-adapter/src/errors.js";

/** A complete row, as OMP reports a healthy host. */
const wellFormedRow = {
  instanceId: "1332c98c40495633",
  generation: 1,
  pid: 2945618,
  sessionId: "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e",
  sessionName: null,
  cwd: "/tmp/caw-poc/proj1",
  model: {
    provider: "9router",
    id: "wdb/deepseek-ai/DeepSeek-V4.1-Flash",
  },
  startedAt: 1792860897076,
  participants: 2,
  relayConnected: true,
  inputRequired: false,
  busy: false,
  access: "control",
};

/** The fields a row cannot do without: the room's name and what it serves. */
const requiredRowFields = { instanceId: wellFormedRow.instanceId, sessionId: wellFormedRow.sessionId, cwd: wellFormedRow.cwd };

describe("collab-registry", () => {
  it("parses captured real omp collab list fixture", () => {
    const fixture = JSON.stringify({
      version: 1,
      hosts: [
        wellFormedRow,
        {
          instanceId: "eaa4972851059e64",
          generation: 2,
          pid: 2953132,
          sessionId: "01a16ecf-4724-7119-adf7-b1cf8c1ecb24",
          sessionName: "Collab Session Two",
          cwd: "/home/heheboiz/data/coding-agent-web",
          model: null,
          startedAt: 1792861608792,
          participants: 1,
          relayConnected: true,
          inputRequired: true,
          busy: null, // tests busy: null
          access: "view",
        },
      ],
    });

    const hosts = parseCollabListOutput(fixture);
    expect(hosts.length).toBe(2);

    const first = hosts[0]!;
    expect(first.instanceId).toBe("1332c98c40495633");
    expect(first.generation).toBe(1);
    expect(first.pid).toBe(2945618);
    expect(first.sessionId).toBe("01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e");
    expect(first.sessionName).toBeNull();
    expect(first.model?.provider).toBe("9router");
    expect(first.busy).toBe(false);
    expect(first.access).toBe("control");

    const second = hosts[1]!;
    expect(second.instanceId).toBe("eaa4972851059e64");
    expect(second.generation).toBe(2);
    expect(second.sessionName).toBe("Collab Session Two");
    expect(second.inputRequired).toBe(true);
    expect(second.busy).toBeNull(); // mapped to null, not false
    expect(second.access).toBe("view");
  });

  it("keeps an omitted generation absent instead of inventing 1", () => {
    // The mint guard compares the link's generation against the listing's. A
    // fabricated 1 made that comparison pass by construction, so a rotated room
    // could be handed out as if it belonged to the conversation the user opened.
    const { generation: _omitted, ...row } = wellFormedRow;
    const hosts = parseCollabListOutput(JSON.stringify({ version: 1, hosts: [row] }));

    expect(hosts.length).toBe(1);
    expect(hosts[0]!.generation).toBeNull();
    expect(hosts[0]!.generation).not.toBe(1);

    // What the caller does with it: the comparison can no longer be satisfied by
    // a listing that did not report a generation.
    const linkGeneration = 1; // e.g. `omp collab link` echoed generation 1
    expect(hosts[0]!.generation === linkGeneration).toBe(false);
  });

  it("keeps every omitted optional field absent rather than defaulting it", () => {
    const { generation, pid, sessionName, model, startedAt, participants, relayConnected, inputRequired, busy, access, ...rest } =
      wellFormedRow;
    const hosts = parseCollabListOutput(JSON.stringify({ version: 1, hosts: [rest] }));

    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      generation: null,
      pid: null,
      sessionName: null,
      model: null,
      startedAt: null,
      participants: null,
      relayConnected: null,
      inputRequired: null,
      busy: null,
      access: "control", // the one documented fallback: a caller-chosen enum, never host evidence
    });
  });

  it("keeps an omitted relayConnected absent, because false is a positive fact", () => {
    const { relayConnected: _omitted, ...row } = wellFormedRow;
    const host = parseCollabHost(row)!;
    expect(host.relayConnected).toBeNull();
    expect(host.relayConnected).not.toBe(false);
  });

  it("keeps an omitted inputRequired absent, because true claims a question exists", () => {
    const { inputRequired: _omitted, ...row } = wellFormedRow;
    const host = parseCollabHost(row)!;
    expect(host.inputRequired).toBeNull();
    expect(host.inputRequired).not.toBe(true);
  });

  it("keeps an omitted participants absent, because 0 is a real empty room", () => {
    const { participants: _omitted, ...row } = wellFormedRow;
    const host = parseCollabHost(row)!;
    expect(host.participants).toBeNull();
    expect(host.participants).not.toBe(0);
  });

  it("drops a row that has no instance id, session id or cwd", () => {
    // Not a "field unknown" case: a row with no instance id cannot be linked and
    // a row with no session id or cwd cannot be tied to anything on disk, so
    // reporting it at all would be reporting a row we cannot act on.
    for (const field of ["instanceId", "sessionId", "cwd"] as const) {
      const row: Record<string, unknown> = { ...wellFormedRow };
      delete row[field];
      expect(parseCollabHost(row)).toBeNull();
      expect(parseCollabListOutput(JSON.stringify({ version: 1, hosts: [wellFormedRow, row] }))).toHaveLength(1);
    }
  });

  it("drops a row whose required fields are the wrong type, rather than coercing them", () => {
    expect(parseCollabHost({ ...requiredRowFields, instanceId: 1332 })).toBeNull();
    expect(parseCollabHost({ ...requiredRowFields, sessionId: null })).toBeNull();
    expect(parseCollabHost({ ...requiredRowFields, cwd: ["/tmp"] })).toBeNull();
  });

  it("keeps a non-numeric generation absent rather than coercing it", () => {
    expect(parseCollabHost({ ...requiredRowFields, generation: "1" })!.generation).toBeNull();
    expect(parseCollabHost({ ...requiredRowFields, generation: Number.NaN })!.generation).toBeNull();
    expect(parseCollabHost({ ...requiredRowFields, generation: Number.POSITIVE_INFINITY })!.generation).toBeNull();
  });

  it("parses empty host list", () => {
    const fixture = JSON.stringify({ version: 1, hosts: [] });
    const hosts = parseCollabListOutput(fixture);
    expect(hosts).toEqual([]);
  });

  it("throws RegistryUnreadableError on malformed json or unexpected shape", () => {
    expect(() => parseCollabListOutput("invalid-json{")).toThrow(RegistryUnreadableError);
    expect(() => parseCollabListOutput(JSON.stringify({ version: 1, hosts: "not-an-array" }))).toThrow(
      RegistryUnreadableError,
    );
  });

  it("parses individual row defensively", () => {
    expect(parseCollabHost(null)).toBeNull();
    expect(parseCollabHost({})).toBeNull();
    expect(parseCollabHost(requiredRowFields)).toEqual({
      instanceId: "1332c98c40495633",
      generation: null,
      pid: null,
      sessionId: "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e",
      sessionName: null,
      cwd: "/tmp/caw-poc/proj1",
      model: null,
      startedAt: null,
      participants: null,
      relayConnected: null,
      inputRequired: null,
      busy: null,
      access: "control",
    });
  });

  it("still accepts a well-formed row unchanged", () => {
    expect(parseCollabHost(wellFormedRow)).toEqual({
      instanceId: "1332c98c40495633",
      generation: 1,
      pid: 2945618,
      sessionId: "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e",
      sessionName: null,
      cwd: "/tmp/caw-poc/proj1",
      model: { provider: "9router", id: "wdb/deepseek-ai/DeepSeek-V4.1-Flash" },
      startedAt: 1792860897076,
      participants: 2,
      relayConnected: true,
      inputRequired: false,
      busy: false,
      access: "control",
    });
  });
});

/**
 * `omp collab list --json` through the real service, so the omission is proven
 * to survive the whole path and not just the parser.
 */
describe("omp collab list omissions through the service", () => {
  const root = path.join(homedir(), ".cache", `caw-list-stub-${Date.now()}`);
  const stub = path.join(root, "stub-omp.mjs");

  beforeAll(async () => {
    await mkdir(root, { recursive: true });
    // Stand-in for `omp`: prints whatever CAW_STUB_LIST holds, exits 0.
    await writeFile(
      stub,
      ["#!/usr/bin/env node", "process.stdout.write(process.env.CAW_STUB_LIST ?? '');", "process.exit(0);", ""].join("\n"),
      { mode: 0o755 },
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const list = async (payload: unknown) => {
    process.env.CAW_STUB_LIST = JSON.stringify(payload);
    try {
      return await new DefaultCollabRegistryService({ ompBinary: stub, registryDir: root }).list();
    } finally {
      delete process.env.CAW_STUB_LIST;
    }
  };

  it("reports a listing that omits generation as unknown, not as generation 1", async () => {
    const { generation: _omitted, ...row } = wellFormedRow;
    const hosts = await list({ version: 1, hosts: [{ ...row, instanceId: "no-generation-instance" }] });

    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.generation).toBeNull();
    expect(hosts[0]!.instanceId).toBe("no-generation-instance");
  });

  it("keeps a well-formed listing intact end to end", async () => {
    const hosts = await list({ version: 1, hosts: [wellFormedRow] });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ generation: 1, relayConnected: true, inputRequired: false, participants: 2 });
  });

  it("drops rows missing a required field end to end", async () => {
    const { sessionId: _omitted, ...row } = wellFormedRow;
    const hosts = await list({ version: 1, hosts: [wellFormedRow, row] });
    expect(hosts).toHaveLength(1);
  });
});

/**
 * Registry readability. The directory check must not collapse "I could not look"
 * into "there are no hosts": the caller reads a throw as `registryUnreadable`
 * and keeps the conversation `unknown`, while a returned empty list is taken as
 * proof that no room exists. Only ENOENT is itself a fact.
 */
describe("collab registry readability failures", () => {
  const root = path.join(homedir(), ".cache", `caw-readability-${Date.now()}`);
  const stub = path.join(root, "stub-omp.mjs");
  const okRow = JSON.stringify({ version: 1, hosts: [wellFormedRow] });

  beforeAll(async () => {
    await mkdir(root, { recursive: true });
    // Prints a host row and exits 0, so a returned list can only come from a
    // directory check that wrongly accepted the failure.
    await writeFile(
      stub,
      ["#!/usr/bin/env node", `process.stdout.write(${JSON.stringify(okRow)});`, "process.exit(0);", ""].join("\n"),
      { mode: 0o755 },
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts a genuinely absent registry directory as no hosts", async () => {
    // ENOENT is the one failure that means "nothing has ever run here".
    const service = new DefaultCollabRegistryService({ ompBinary: stub, registryDir: path.join(root, "never-existed") });
    const hosts = await service.list();
    expect(hosts).toHaveLength(1);
  });

  it("propagates a registry path that cannot be read (ENOTDIR)", async () => {
    // Injecting via ENOTDIR: the path runs through a regular file, so the
    // directory genuinely cannot be read. That is a defect in our knowledge, not
    // evidence that no host exists, and a returned empty list would say the
    // opposite.
    const service = new DefaultCollabRegistryService({
      ompBinary: stub,
      registryDir: path.join(root, "stub-omp.mjs", "not-a-directory"),
    });
    await expect(service.list()).rejects.toThrow(RegistryUnreadableError);
  });

  it("propagates a symlink loop instead of listing nothing", async () => {
    const loop = path.join(root, "loop");
    await rm(loop, { force: true });
    await symlink("loop", loop);
    const service = new DefaultCollabRegistryService({ ompBinary: stub, registryDir: loop });
    await expect(service.list()).rejects.toThrow(RegistryUnreadableError);
  });

  it("propagates a permission-denied real directory, as the audit scenario describes", async () => {
    // Root bypasses DAC, so chmod 000 cannot inject this failure; a child of a
    // mode-000 parent can. Skipped rather than faked when the injection is not
    // possible, because a fake would not exercise the syscall.
    if (process.getuid?.() === 0) return;
    const blockedParent = path.join(root, "blocked");
    const registryDir = path.join(blockedParent, "collab-hosts");
    await mkdir(registryDir, { recursive: true });
    await chmod(blockedParent, 0o000);
    try {
      const service = new DefaultCollabRegistryService({ ompBinary: stub, registryDir });
      await expect(service.list()).rejects.toThrow(RegistryUnreadableError);
    } finally {
      await chmod(blockedParent, 0o755);
    }
  });
});
