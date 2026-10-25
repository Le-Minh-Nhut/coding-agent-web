import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const maxWorkers = Math.max(2, Math.floor(availableParallelism() / 2));
// Per-file temp dirs and isolated fixtures make file-level parallelism safe.
// Owner deliberately halves the machine because a sibling project shares it; do not optimize this back up.

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
    maxWorkers: process.env.CAW_COMPAT === "1" ? 1 : maxWorkers,
    minWorkers: 1,
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
