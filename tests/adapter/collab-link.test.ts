import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DefaultCollabRegistryService } from "../../packages/omp-adapter/src/collab-registry.js";

/**
 * `omp collab link --json` output, as the adapter must interpret it.
 *
 * The point under test is what happens when the CLI does *not* say which host or
 * generation the link belongs to. Filling those in from the request made the
 * caller's identity comparison pass by construction, so a link minted for a
 * successor room after a session switch was handed out as a match — a bearer
 * credential pointing at a conversation the user did not ask for. Absence must
 * survive as `null` so the caller can refuse.
 */
describe("collab link identity evidence", () => {
  const root = path.join(homedir(), ".cache", `caw-link-stub-${Date.now()}`);
  const stub = path.join(root, "stub-omp.mjs");

  beforeAll(async () => {
    await mkdir(root, { recursive: true });
    // Stand-in for `omp`: prints whatever CAW_STUB_LINK holds, exits 0.
    await writeFile(
      stub,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(process.env.CAW_STUB_LINK ?? '');",
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function service(): DefaultCollabRegistryService {
    return new DefaultCollabRegistryService({ ompBinary: stub, registryDir: root });
  }

  it("keeps a well-formed response exactly as the CLI reported it", async () => {
    process.env.CAW_STUB_LINK = JSON.stringify({
      url: "wss://relay.example/room/abc",
      instanceId: "real-instance",
      generation: 7,
      access: "view",
    });
    const link = await service().link("real-instance", "view");
    expect(link).toMatchObject({ instanceId: "real-instance", generation: 7, access: "view", url: "wss://relay.example/room/abc" });
    delete process.env.CAW_STUB_LINK;
  });

  it("does not fabricate identity when the CLI returns only a url", async () => {
    process.env.CAW_STUB_LINK = JSON.stringify({ url: "wss://relay.example/room/def" });
    const link = await service().link("requested-instance", "control");
    // Never the requested id, never a defaulted generation: the caller must be
    // able to tell that this result is not a verified match.
    expect(link.instanceId).toBeNull();
    expect(link.generation).toBeNull();
    expect(link.instanceId).not.toBe("requested-instance");
    expect(link.url).toBe("wss://relay.example/room/def");
    delete process.env.CAW_STUB_LINK;
  });

  it("does not fabricate identity from malformed fields", async () => {
    process.env.CAW_STUB_LINK = JSON.stringify({ url: "wss://relay.example/room/ghi", instanceId: 42, generation: "7" });
    const link = await service().link("requested-instance", "control");
    expect(link.instanceId).toBeNull();
    expect(link.generation).toBeNull();
    delete process.env.CAW_STUB_LINK;
  });

  it("still refuses a response with no url at all", async () => {
    process.env.CAW_STUB_LINK = JSON.stringify({ instanceId: "real-instance", generation: 3 });
    await expect(service().link("real-instance", "control")).rejects.toMatchObject({ code: "link_unavailable" });
    delete process.env.CAW_STUB_LINK;
  });
});
