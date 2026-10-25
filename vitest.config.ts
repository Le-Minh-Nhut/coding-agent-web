import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@caw/contracts": pkg("contracts"),
      "@caw/runtime": pkg("runtime"),
      "@caw/omp-adapter": pkg("omp-adapter"),
      "@caw/collab-protocol": pkg("collab-protocol"),
      "@caw/relay": pkg("relay"),
    },
  },
  test: {
    include: [
      "tests/**/*.test.{ts,tsx}",
      "packages/*/test/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "packages/guest/**", "tests/e2e/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
