/**
 * Package surface: version file sync, env wiring, and the documented frame cap.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  MAX_FRAME_BYTES,
  MAX_GUESTS_PER_ROOM,
  RELAY_ENV,
  RELAY_VERSION,
  relayOptionsFromEnv,
  startRelayFromEnv,
} from "@caw/relay";

const packageJsonPath = fileURLToPath(
  new URL("../../packages/relay/package.json", import.meta.url),
);

describe("package surface", () => {
  it("keeps RELAY_VERSION in step with package.json", async () => {
    const manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      version: string;
    };
    expect(manifest.version).toBe(RELAY_VERSION);
  });

  it("documents the documented caps as constants", () => {
    expect(MAX_GUESTS_PER_ROOM).toBe(8);
    // 8 MiB: 8x the 1 MiB host payload ceiling, a quarter of Bun's 16 MB WebSocket default.
    expect(MAX_FRAME_BYTES).toBe(8 * 1024 * 1024);
  });

  it("defaults to loopback and validates env overrides", () => {
    expect(relayOptionsFromEnv({})).toEqual({
      host: DEFAULT_RELAY_HOST,
      port: DEFAULT_RELAY_PORT,
      version: RELAY_VERSION,
    });
    expect(
      relayOptionsFromEnv({
        [RELAY_ENV.port]: "0",
        [RELAY_ENV.staticDir]: "/srv/guest",
      }),
    ).toMatchObject({
      port: 0,
      staticDir: "/srv/guest",
    });
    expect(
      relayOptionsFromEnv({
        [RELAY_ENV.allowedOrigins]: "https://a.ts.net, https://b.ts.net",
      }),
    ).toMatchObject({
      allowedOrigin: ["https://a.ts.net", "https://b.ts.net"],
    });
    expect(() =>
      relayOptionsFromEnv({ [RELAY_ENV.port]: "not-a-port" }),
    ).toThrow(/CAW_RELAY_PORT/);
    expect(() => relayOptionsFromEnv({ [RELAY_ENV.port]: "70000" })).toThrow(
      /CAW_RELAY_PORT/,
    );
    expect(() =>
      relayOptionsFromEnv({ [RELAY_ENV.allowedOrigins]: " , " }),
    ).toThrow(/CAW_RELAY_ALLOWED_ORIGINS/);
  });

  it("starts from env and stops cleanly", async () => {
    const relay = await startRelayFromEnv({ [RELAY_ENV.port]: "0" });
    try {
      const status = relay.status();
      expect(status.port).toBeGreaterThan(0);
      expect(status.url).toBe(`ws://${DEFAULT_RELAY_HOST}:${status.port}`);
      expect(status.rooms).toBe(0);
    } finally {
      await relay.stop();
    }
  });
});
