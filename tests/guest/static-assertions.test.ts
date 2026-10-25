import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

const rootDir = path.resolve(__dirname, "../..");
const distDir = path.join(rootDir, "packages/guest/dist");
const buildScript = path.join(rootDir, "scripts/build-guest.mjs");

describe("Guest client static security and PWA assertions", () => {
  beforeAll(async () => {
    try {
      await fs.stat(path.join(distDir, "index.html"));
    } catch {
      execFileSync("node", [buildScript], { cwd: rootDir, stdio: "pipe" });
    }
  });

  it("asserts index.html and JS bundles contain no third-party analytics or off-origin secrets", async () => {
    const indexHtml = await fs.readFile(
      path.join(distDir, "index.html"),
      "utf-8",
    );

    // Find JS bundle
    const assets = await fs.readdir(path.join(distDir, "assets"));
    const jsFile = assets.find(
      (f) => f.startsWith("app.") && f.endsWith(".js"),
    );
    expect(jsFile).toBeDefined();

    const jsContent = await fs.readFile(
      path.join(distDir, "assets", jsFile!),
      "utf-8",
    );

    // 1. No reference to um.can.ac (analytics)
    expect(indexHtml).not.toContain("um.can.ac");
    expect(jsContent).not.toContain("um.can.ac");

    // 2. No reference to my.omp.sh
    expect(indexHtml).not.toContain("my.omp.sh");
    expect(jsContent).not.toContain("my.omp.sh");

    // 3. No unencrypted http:// asset URLs (only https://, ws:, wss: or relative)
    expect(indexHtml).not.toMatch(/(?:src|href)=["']http:\/\//i);

    // 4. Content-Security-Policy meta tag present
    expect(indexHtml).toContain('http-equiv="Content-Security-Policy"');
    expect(indexHtml).toContain("default-src 'none'");

    // 5. Viewport with viewport-fit=cover
    expect(indexHtml).toContain("viewport-fit=cover");

    // 6. Origin-relative manifest and favicon links
    expect(indexHtml).toMatch(
      /<link\s+rel=["']manifest["']\s+href=["']\.\/manifest\.webmanifest["']/,
    );
    expect(indexHtml).toMatch(
      /<link\s+rel=["']apple-touch-icon["'][^>]*href=["']\.\/favicon-180x180\.png["']/,
    );

    // 7. SEC-1: Never write bearer link to location.hash
    expect(jsContent).not.toMatch(/location\.hash\s*=/);
  });


  it("asserts web manifest is origin-relative and standalone", async () => {
    const manifestRaw = await fs.readFile(
      path.join(distDir, "manifest.webmanifest"),
      "utf-8",
    );
    const manifest = JSON.parse(manifestRaw);

    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toMatch(/^\.?\//);
    expect(manifest.icons).toBeInstanceOf(Array);
    expect(manifest.icons.length).toBeGreaterThan(0);

    for (const icon of manifest.icons) {
      expect(icon.src).not.toMatch(/^https?:\/\//i);
      expect(icon.src).not.toContain("my.omp.sh");
    }
  });

  it("SEC-1: client never writes room link to window.location.hash and uses replaceState", async () => {
    const assets = await fs.readdir(path.join(distDir, "assets"));
    const jsFile = assets.find((f) => f.startsWith("app.") && f.endsWith(".js"));
    const jsContent = await fs.readFile(path.join(distDir, "assets", jsFile!), "utf-8");

    // Must not write to location.hash
    expect(jsContent).not.toMatch(/location\.hash\s*=/);
    expect(jsContent).not.toContain("window.location.hash=");

    // Must use replaceState to strip the fragment
    expect(jsContent).toContain("replaceState");
  });
});
