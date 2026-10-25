import net from "node:net";
import { describe, expect, it } from "vitest";
import { DefaultSessionLeaseProbe } from "../../packages/omp-adapter/src/session-lease.js";

describe("session-lease", () => {
  it("matches the known good leaseName vector", () => {
    // Known good vector independently reproduced:
    // With ownersDir = /home/heheboiz/.omp/run/session-owners,
    // lockPath = /home/heheboiz/.omp/run/session-owners/01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e.lock
    // Result: omp-file-lock-8d8c8d3727dacea282d09ee9f3d89461
    const probe = new DefaultSessionLeaseProbe({
      ownersDir: "/home/heheboiz/.omp/run/session-owners",
    });

    const name = probe.leaseName("01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e");
    expect(name).toBe("omp-file-lock-8d8c8d3727dacea282d09ee9f3d89461");
  });

  it("handles non-plain-token sessionId by returning unknown", async () => {
    const probe = new DefaultSessionLeaseProbe();
    expect(await probe.isLive("../../escape")).toBe("unknown");
    expect(await probe.isLive("bad session id with spaces")).toBe("unknown");
  });

  it("reports false for an absent lease", async () => {
    const probe = new DefaultSessionLeaseProbe({
      ownersDir: "/tmp/non-existent-session-owners-dir",
    });
    const status = await probe.isLive("01a16fff-ffff-7fff-afff-ffffffffffff");
    expect(status).toBe(false);
  });
  it("keeps failed procfs bulk observations unknown", async () => {
    const probe = new DefaultSessionLeaseProbe({ procNetUnixPath: "/tmp/no-such-caw-proc-net-unix" });
    const map = await probe.liveSet(["01a16ed6", "bad id"]);
    expect(map.get("01a16ed6")).toBe("unknown");
    expect(map.get("bad id")).toBe("unknown");
  });


  it("proves liveness against /proc/net/unix when an abstract lease socket is bound", async () => {
    if (process.platform !== "linux") return;

    const probe = new DefaultSessionLeaseProbe({
      ownersDir: "/tmp/caw-test-owners",
    });
    const testSessionId = "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e";
    const name = probe.leaseName(testSessionId);

    // 1. Before bind: not live
    expect(await probe.isLive(testSessionId)).toBe(false);

    // 2. Bind Linux abstract Unix domain socket (\0 prefix)
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(`\0${name}`, () => resolve());
      server.on("error", reject);
    });

    try {
      // 3. While bound: isLive returns true, and liveSet reports true
      expect(await probe.isLive(testSessionId)).toBe(true);

      const map = await probe.liveSet([testSessionId, "non-existent-id"]);
      expect(map.get(testSessionId)).toBe(true);
      expect(map.get("non-existent-id")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // 4. After close: not live
    expect(await probe.isLive(testSessionId)).toBe(false);
  });
});
