import { describe, expect, it } from "vitest";
import {
  DefaultCapabilityService,
  parseOmpVersion,
  parseTmuxVersion,
} from "../../packages/omp-adapter/src/capabilities.js";

describe("capabilities", () => {
  it("parses real omp --version outputs", () => {
    expect(parseOmpVersion("omp v18.12.2\n")).toBe("18.12.2");
    expect(parseOmpVersion("omp/18.12.2\n")).toBe("18.12.2");
    expect(parseOmpVersion("omp 18.12.2")).toBe("18.12.2");
    expect(parseOmpVersion("random non-version string")).toBeNull();
  });

  it("parses real tmux -V outputs", () => {
    expect(parseTmuxVersion("tmux 3.6\n")).toBe("3.6");
    expect(parseTmuxVersion("tmux 3.6a\n")).toBe("3.6a");
    expect(parseTmuxVersion("tmux next-3.4")).toBe("next-3.4");
    expect(parseTmuxVersion("bad output")).toBeNull();
  });

  it("handles missing binaries without throwing", async () => {
    const service = new DefaultCapabilityService({
      ompBinaryPath: "/nonexistent/omp-binary-path",
      tmuxBinaryPath: "/nonexistent/tmux-binary-path",
      extraSearchDirs: ["/empty-dir"],
    });

    // Probe should never throw, but return available: false with notes
    const probe = await service.probe();
    expect(probe.omp.available).toBe(false);
    expect(probe.omp.path).toBeNull();
    expect(probe.omp.version).toBeNull();

    expect(probe.tmux.available).toBe(false);
    expect(probe.tmux.path).toBeNull();
    expect(probe.tmux.version).toBeNull();

    expect(probe.notes.length).toBeGreaterThan(0);

    const caps = await service.capabilities();
    expect(caps.omp.available).toBe(false);
    expect(caps.tmux.available).toBe(false);
  });

  it("caches the probe result unless refresh is requested", async () => {
    const service = new DefaultCapabilityService({
      ompBinaryPath: "/nonexistent/omp",
      tmuxBinaryPath: "/nonexistent/tmux",
    });

    const p1 = await service.probe();
    const p2 = await service.probe();
    expect(p1).toBe(p2);

    const p3 = await service.probe(true);
    expect(p3).not.toBe(p1);
    expect(p3).toEqual(p1);
  });
});
