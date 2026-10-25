import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(__dirname, "../..");
const distDir = path.join(rootDir, "packages/guest/dist");
const buildScript = path.join(rootDir, "scripts/build-guest.mjs");

describe("Guest client build smoke test", () => {
  it("executes build-guest.mjs and verifies dist artifacts exist", async () => {
    // Run build script
    execFileSync("node", [buildScript], { cwd: rootDir, stdio: "pipe" });

    // Check index.html
    const indexHtml = await fs.readFile(
      path.join(distDir, "index.html"),
      "utf-8",
    );
    expect(indexHtml).toContain("<!doctype html>");
    expect(indexHtml).toContain('<div id="root"></div>');

    // Check assets directory
    const assets = await fs.readdir(path.join(distDir, "assets"));
    const jsBundle = assets.find(
      (file) => file.startsWith("app.") && file.endsWith(".js"),
    );
    const cssBundle = assets.find(
      (file) => file.startsWith("app.") && file.endsWith(".css"),
    );

    expect(jsBundle).toBeDefined();
    expect(cssBundle).toBeDefined();

    // Check index.html points to the generated bundles
    expect(indexHtml).toContain(jsBundle!);
    expect(indexHtml).toContain(cssBundle!);

    // Check manifest and favicons
    const manifestExists = await fs.stat(
      path.join(distDir, "manifest.webmanifest"),
    );
    expect(manifestExists.isFile()).toBe(true);

    const faviconSvgExists = await fs.stat(path.join(distDir, "favicon.svg"));
    expect(faviconSvgExists.isFile()).toBe(true);

    const appleIconExists = await fs.stat(
      path.join(distDir, "favicon-180x180.png"),
    );
    expect(appleIconExists.isFile()).toBe(true);
  });
});
