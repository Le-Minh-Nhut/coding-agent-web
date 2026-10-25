import { describe, it, expect } from "vitest";
import {
  importRoomKey,
  generateRoomKey,
  seal,
  open,
} from "../../packages/collab-protocol/src/index.js";

describe("WebCrypto AES-256-GCM codec", () => {
  it("imports 32-byte view secret", async () => {
    const raw = generateRoomKey();
    const result = await importRoomKey(raw);
    expect(result.key).toBeDefined();
    expect(result.key.algorithm.name).toBe("AES-GCM");
    expect(result.writeToken).toBeUndefined();
  });

  it("imports 48-byte full-control secret", async () => {
    const raw = new Uint8Array(48).fill(3);
    const result = await importRoomKey(raw);
    expect(result.key).toBeDefined();
    expect(result.writeToken).toBeDefined();
    expect(result.writeToken?.byteLength).toBe(16);
    expect(Array.from(result.writeToken!)).toEqual(Array.from(raw.subarray(32)));
  });

  it("refuses secrets that are not 32 or 48 bytes", async () => {
    await expect(importRoomKey(new Uint8Array(16))).rejects.toThrow("32 or 48 bytes");
    await expect(importRoomKey(new Uint8Array(33))).rejects.toThrow("32 or 48 bytes");
  });

  it("round-trips JSON object", async () => {
    const { key } = await importRoomKey(generateRoomKey());
    const original = { t: "prompt", text: "hello world", count: 123 };

    const sealed = await seal(key, original);
    expect(sealed.byteLength).toBeGreaterThan(12);

    const opened = await open<typeof original>(key, sealed);
    expect(opened).toEqual(original);
  });

  it("round-trips string", async () => {
    const { key } = await importRoomKey(generateRoomKey());
    const original = "raw string payload";

    const sealed = await seal(key, original);
    const opened = await open<string>(key, sealed);
    expect(opened).toBe(original);
  });

  it("fails decryption with wrong key", async () => {
    const { key: key1 } = await importRoomKey(generateRoomKey());
    const { key: key2 } = await importRoomKey(generateRoomKey());

    const sealed = await seal(key1, { message: "secret" });
    await expect(open(key2, sealed)).rejects.toThrow();
  });

  it("detects tampering in ciphertext", async () => {
    const { key } = await importRoomKey(generateRoomKey());
    const sealed = await seal(key, { sensitive: "data" });

    // Flip one byte in the ciphertext payload
    const tampered = new Uint8Array(sealed);
    tampered[tampered.length - 1]! ^= 0xff;

    await expect(open(key, tampered)).rejects.toThrow();
  });

  it("rejects truncated frames (<= 12 bytes)", async () => {
    const { key } = await importRoomKey(generateRoomKey());
    const short = new Uint8Array(12);
    await expect(open(key, short)).rejects.toThrow("Sealed frame too short");
  });
});
