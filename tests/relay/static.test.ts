/**
 * Static handler tests: path vetting, headers, 404 behaviour and SPA-safe serving.
 */
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaticHandler } from "@caw/relay";

const INDEX = "<!doctype html><title>guest</title>";

let root: string;
let outside: string;
let server: Server;
let base: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "caw-static-"));
  outside = await mkdtemp(path.join(tmpdir(), "caw-outside-"));
  await writeFile(path.join(root, "index.html"), INDEX);
  await mkdir(path.join(root, "assets"));
  await writeFile(
    path.join(root, "assets", "app.abc123.js"),
    "export const x = 1;",
  );
  await writeFile(path.join(root, "manifest.webmanifest"), "{}");
  await writeFile(path.join(outside, "secret.txt"), "TOP-SECRET");
  await symlink(
    path.join(outside, "secret.txt"),
    path.join(root, "link-to-secret.txt"),
  );
  await symlink(outside, path.join(root, "escape"));

  let clock = Date.parse("2026-10-24T00:00:00Z");
  const handler = createStaticHandler({
    dir: root,
    version: "9.9.9",
    status: () => ({ rooms: 2, guests: 3 }),
    now: () => clock,
  });
  clock += 1_234;
  server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function get(target: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${target}`, { redirect: "manual", ...init });
}

function assertSecurityHeaders(response: Response): void {
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("static serving", () => {
  it("serves the index at / with the right headers", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(await response.text()).toBe(INDEX);
    assertSecurityHeaders(response);
  });

  it("serves a nested asset with its MIME type", async () => {
    const response = await get("/assets/app.abc123.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(response.headers.get("content-length")).toBe(
      String("export const x = 1;".length),
    );
    expect(await response.text()).toBe("export const x = 1;");
    assertSecurityHeaders(response);
  });

  it("serves the manifest MIME type and a HEAD without a body", async () => {
    const manifest = await get("/manifest.webmanifest");
    expect(manifest.headers.get("content-type")).toBe(
      "application/manifest+json; charset=utf-8",
    );
    const head = await get("/index.html", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("honours If-None-Match with a 304", async () => {
    const first = await get("/index.html");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await get("/index.html", {
      headers: { "if-none-match": etag! },
    });
    expect(second.status).toBe(304);
    assertSecurityHeaders(second);
  });

  it("rejects traversal attempts without leaking anything", async () => {
    // Two refusal paths, both safe: raw `..` segments are normalized away by our own joining
    // (404, the path simply is not inside the root), and percent-encoded `..` is caught by the
    // segment check (400). Neither one lists a directory or returns a byte of a file.
    const attempts = [
      "/../etc/passwd",
      "/assets/../../etc/passwd",
      "/%2e%2e%2fetc/passwd",
      "/%2e%2e/etc/passwd",
      "/..%2f..%2fetc%2fpasswd",
      "/etc/passwd%00.png",
      "/assets%5c..%5csecret.txt",
    ];
    const refusalBody: Record<number, string> = {
      400: "bad request",
      404: "not found",
    };
    for (const target of attempts) {
      const response = await get(target);
      const body = await response.text();
      expect([target, refusalBody[response.status]]).toEqual([target, body]);
      assertSecurityHeaders(response);
    }
  });

  it("never follows a symlink out of the root, at the leaf or in the middle", async () => {
    for (const target of ["/link-to-secret.txt", "/escape/secret.txt"]) {
      const response = await get(target);
      expect({ target, status: response.status }).toEqual({
        target,
        status: 404,
      });
      expect(await response.text()).toBe("not found");
    }
  });

  it("404s unknown paths and directories without listing them", async () => {
    for (const target of [
      "/missing.js",
      "/assets",
      "/assets/",
      "/missing/deep/file.js",
    ]) {
      const response = await get(target);
      expect({ target, status: response.status }).toEqual({
        target,
        status: 404,
      });
      expect(await response.text()).toBe("not found");
    }
  });

  it("releases the file descriptor for every response", async () => {
    // 64 KiB asset so the stream cannot complete synchronously inside the handler.
    const body = "x".repeat(64 * 1024);
    await writeFile(path.join(root, "big.txt"), body);
    const descriptorCount = async (): Promise<number> =>
      (await readdir("/proc/self/fd")).length;
    const before = await descriptorCount();
    for (let i = 0; i < 200; i += 1) {
      const response = await get("/big.txt");
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBe(body.length);
    }
    const after = await descriptorCount();
    // Sequential requests: any growth here is a leaked descriptor, not concurrency.
    expect(after).toBeLessThanOrEqual(before + 2);
  });

  it("rejects non-GET methods", async () => {
    const response = await get("/index.html", { method: "POST" });
    expect(response.status).toBe(405);
  });

  it("reports health as JSON with live room counters", async () => {
    const response = await get("/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await response.json()).toEqual({
      ok: true,
      version: "9.9.9",
      rooms: 2,
      guests: 3,
      uptimeMs: 1_234,
    });
    assertSecurityHeaders(response);
  });

  it("serves health but no files when no static directory is configured", async () => {
    const handler = createStaticHandler({
      dir: null,
      version: "0.0.0",
      status: () => ({ rooms: 0, guests: 0 }),
    });
    const relayOnly = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) =>
      relayOnly.listen(0, "127.0.0.1", resolve),
    );
    const address = relayOnly.address();
    if (typeof address !== "object" || address === null)
      throw new Error("no address");
    try {
      const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      expect(health.status).toBe(200);
      const root = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(root.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => relayOnly.close(() => resolve()));
    }
  });
});
