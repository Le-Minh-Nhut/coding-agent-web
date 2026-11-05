import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The web client reuses the vendored guest tool renderers directly — see
 * `src/guest-tools.ts` for why one seam owns that import. They are TypeScript
 * sources (the guest's published bundle is a self-contained HTML app, not a
 * library), so the aliases below are what let Vite and `tsc` resolve the guest
 * module ids inside `apps/web` without changing anything under `packages/guest`.
 *
 * The `pi-utils` aliases mirror `scripts/build-guest.mjs`; the guest's
 * `tsconfig.json` declares the same paths for its own typecheck.
 */
const root = resolve(__dirname, "../..");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@caw/guest-tool-render": resolve(root, "packages/guest/src/tool-render"),
      "@oh-my-pi/pi-wire": resolve(root, "packages/guest/src/vendor/wire/index.ts"),
      "@oh-my-pi/pi-utils/marked": resolve(root, "packages/guest/src/vendor/utils/marked.ts"),
      "@oh-my-pi/pi-utils/marked-list": resolve(root, "packages/guest/src/vendor/utils/marked-list.ts"),
      "@oh-my-pi/pi-utils/math-delimiters": resolve(root, "packages/guest/src/vendor/utils/math-delimiters.ts"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8791",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2022",
  },
});
