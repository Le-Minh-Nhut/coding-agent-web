import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DefaultModelCatalogService,
  parseOmpModelsOutput,
} from "../../packages/omp-adapter/src/model-catalog.js";

const testRoot = path.join(tmpdir(), `caw-model-catalog-${Date.now()}`);
const stubBinary = path.join(testRoot, "omp-stub.mjs");
const outputFile = path.join(testRoot, "models.json");
const argvFile = path.join(testRoot, "argv.json");

const modelListing = {
  models: [
    {
      provider: "cx",
      kind: "chat",
      id: "cx/gpt-6-luna",
      selector: "cx/cx/gpt-6-luna",
      name: "GPT-6 Luna",
      reasoning: true,
      thinking: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      provider: "cx",
      kind: "chat",
      id: "wdb/deepseek-ai/DeepSeek-V4.1-Flash",
      selector: "cx/wdb/deepseek-ai/DeepSeek-V4.1-Flash",
      name: "DeepSeek V4.1 Flash",
      reasoning: true,
      thinking: ["low", "high", "max"],
    },
  ],
};

describe("model-catalog", () => {
  beforeAll(async () => {
    await mkdir(testRoot, { recursive: true });
    await writeFile(
      stubBinary,
      [
        "#!/usr/bin/env node",
        'import { readFileSync, writeFileSync } from "node:fs";',
        'writeFileSync(process.env.CAW_TEST_OMP_ARGV_FILE, JSON.stringify({ binary: process.argv[1], args: process.argv.slice(2) }));',
        "try {",
        '  process.stdout.write(readFileSync(process.env.CAW_TEST_OMP_OUTPUT_FILE, "utf8"));',
        "} catch {",
        '  process.stderr.write("catalog source unavailable");',
        "  process.exitCode = 1;",
        "}",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  afterAll(async () => {
    delete process.env.CAW_TEST_OMP_ARGV_FILE;
    delete process.env.CAW_TEST_OMP_OUTPUT_FILE;
    await rm(testRoot, { recursive: true, force: true });
  });

  it("parses provider-qualified selectors in provider/id order without effort suffix variants", () => {
    expect(parseOmpModelsOutput(JSON.stringify({ models: [...modelListing.models].reverse() }))).toEqual([
      "cx/cx/gpt-6-luna",
      "cx/wdb/deepseek-ai/DeepSeek-V4.1-Flash",
    ]);
  });

  it("drops malformed and duplicate model rows rather than exposing guessed ids", () => {
    const valid = modelListing.models[0]!;
    const output = {
      models: [
        valid,
        valid,
        { ...valid, selector: "wrong/provider/id" },
        { ...valid, provider: "wdb/extra" },
        { ...valid, id: "bad\nmodel" },
        { provider: "wdb", id: "no-selector" },
        null,
        "not a model row",
      ],
    };
    expect(parseOmpModelsOutput(JSON.stringify(output))).toEqual([
      "cx/cx/gpt-6-luna",
    ]);
    expect(parseOmpModelsOutput("not json")).toEqual([]);
    expect(parseOmpModelsOutput(JSON.stringify({ models: "wrong shape" }))).toEqual([]);
  });

  it("runs only the model-listing subcommand via the stand-in and briefly caches confirmed results", async () => {
    await writeFile(outputFile, JSON.stringify(modelListing));
    process.env.CAW_TEST_OMP_ARGV_FILE = argvFile;
    process.env.CAW_TEST_OMP_OUTPUT_FILE = outputFile;

    const service = new DefaultModelCatalogService({ ompBinary: stubBinary });
    const first = await service.listModels();
    first.pop();
    const second = await service.listModels();

    expect(second).toEqual([
      "cx/cx/gpt-6-luna",
      "cx/wdb/deepseek-ai/DeepSeek-V4.1-Flash",
    ]);
    expect(second).not.toBe(first);
    expect(JSON.parse(await readFile(argvFile, "utf8"))).toEqual({
      binary: stubBinary,
      args: ["models", "--json"],
    });
  });

  it("returns an empty unknown result for missing binaries, unsupported output, and unreadable catalog sources", async () => {
    const missing = new DefaultModelCatalogService({ ompBinary: path.join(testRoot, "missing-omp") });
    await expect(missing.listModels()).resolves.toEqual([]);

    await writeFile(outputFile, "Unsupported OMP models output");
    process.env.CAW_TEST_OMP_ARGV_FILE = argvFile;
    process.env.CAW_TEST_OMP_OUTPUT_FILE = outputFile;
    const unsupported = new DefaultModelCatalogService({ ompBinary: stubBinary });
    await expect(unsupported.listModels()).resolves.toEqual([]);

    process.env.CAW_TEST_OMP_OUTPUT_FILE = path.join(testRoot, "unreadable.json");
    const unreadable = new DefaultModelCatalogService({ ompBinary: stubBinary });
    await expect(unreadable.listModels()).resolves.toEqual([]);
  });
});
