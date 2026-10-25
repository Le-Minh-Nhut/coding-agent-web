#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const guestDir = path.join(root, "packages", "guest");
const distDir = path.join(guestDir, "dist");
const publicDir = path.join(guestDir, "public");
const stageDir = path.join(guestDir, `dist.tmp-${process.pid}`);
const stageAssetsDir = path.join(stageDir, "assets");
const oldDir = path.join(guestDir, `dist.old-${process.pid}`);

async function build() {
  const startTime = Date.now();
  // 1. Clean staging directory
  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageAssetsDir, { recursive: true });

  // 2. Run esbuild bundle into staging
  const result = await esbuild.build({
    entryPoints: [path.join(guestDir, "src", "main.tsx")],
    bundle: true,
    minify: true,
    format: "esm",
    target: ["es2022", "safari16"],
    outdir: stageAssetsDir,
    entryNames: "app.[hash]",
    assetNames: "[name].[hash]",
    sourcemap: true,
    metafile: true,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    alias: {
      "@oh-my-pi/pi-wire": path.join(
        guestDir,
        "src",
        "vendor",
        "wire",
        "index.ts",
      ),
      "@oh-my-pi/pi-utils/marked": path.join(
        guestDir,
        "src",
        "vendor",
        "utils",
        "marked.ts",
      ),
      "@oh-my-pi/pi-utils/marked-list": path.join(
        guestDir,
        "src",
        "vendor",
        "utils",
        "marked-list.ts",
      ),
      "@oh-my-pi/pi-utils/math-delimiters": path.join(
        guestDir,
        "src",
        "vendor",
        "utils",
        "math-delimiters.ts",
      ),
    },
    loader: {
      ".png": "file",
      ".svg": "file",
      ".ico": "file",
      ".woff2": "file",
      ".woff": "file",
      ".ttf": "file",
    },
  });

  // Find the emitted JS and CSS bundles
  const outputs = Object.keys(result.metafile.outputs);
  const jsOutput = outputs.find(
    (p) => p.endsWith(".js") && !p.endsWith(".map.js"),
  );
  const cssOutput = outputs.find((p) => p.endsWith(".css"));

  if (!jsOutput) {
    throw new Error("esbuild produced no JS output");
  }

  const jsFilename = path.basename(jsOutput);
  const cssFilename = cssOutput ? path.basename(cssOutput) : null;

  // 3. Copy public assets into staging dist
  try {
    await fs.cp(publicDir, stageDir, { recursive: true });
  } catch (err) {
    // Ignore if public directory is empty or missing
  }

  // 4. Transform index.html to reference bundled JS/CSS in staging
  const indexHtmlPath = path.join(guestDir, "index.html");
  let html = await fs.readFile(indexHtmlPath, "utf-8");

  const cssLink = cssFilename
    ? `<link rel="stylesheet" href="./assets/${cssFilename}" />\n\t\t`
    : "";
  const jsScript = `<script type="module" src="./assets/${jsFilename}"></script>`;

  html = html.replace(
    /<script type="module" src="\.\/src\/main\.tsx"><\/script>/,
    `${cssLink}${jsScript}`,
  );

  await fs.writeFile(path.join(stageDir, "index.html"), html, "utf-8");

  // 5. Atomic swap: stageDir -> distDir
  try {
    await fs.rename(distDir, oldDir);
  } catch {}
  await fs.rename(stageDir, distDir);
  try {
    await fs.rm(oldDir, { recursive: true, force: true });
  } catch {}

  const duration = Date.now() - startTime;
  console.log(
    `[build-guest] built guest client in ${duration}ms -> packages/guest/dist/`,
  );
  console.log(`  JS: assets/${jsFilename}`);
  if (cssFilename) {
    console.log(`  CSS: assets/${cssFilename}`);
  }
}

build().catch(async (err) => {
  try {
    await fs.rm(stageDir, { recursive: true, force: true });
  } catch {}
  console.error("[build-guest] build failed:", err);
  process.exit(1);
});
