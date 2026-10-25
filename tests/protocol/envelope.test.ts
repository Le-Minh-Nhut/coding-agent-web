import { describe, it, expect } from "vitest";
import {
  packEnvelope,
  unpackEnvelope,
  rewriteEnvelopePeer,
} from "../../packages/collab-protocol/src/index.js";

describe("wire envelope", () => {
  it("packs and unpacks envelope round-trip", () => {
    const payload = new Uint8Array([10, 20, 30, 40, 50]);
    const peerId = 42;
    const packed = packEnvelope(peerId, payload);

    expect(packed.byteLength).toBe(4 + payload.byteLength);

    const unpacked = unpackEnvelope(packed);
    expect(unpacked).not.toBeNull();
    expect(unpacked?.peerId).toBe(peerId);
    expect(Array.from(unpacked!.payload)).toEqual(Array.from(payload));
  });

  it("rewrites envelope peerId in place", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const packed = packEnvelope(100, payload);

    rewriteEnvelopePeer(packed, 9999);

    const unpacked = unpackEnvelope(packed);
    expect(unpacked?.peerId).toBe(9999);
    expect(Array.from(unpacked!.payload)).toEqual([1, 2, 3]);
  });

  it("handles 3-byte input safely without throwing (bounds check)", () => {
    const threeBytes = new Uint8Array([1, 2, 3]);
    expect(() => {
      const res = unpackEnvelope(threeBytes);
      expect(res).toBeNull();
    }).not.toThrow();

    expect(() => {
      rewriteEnvelopePeer(threeBytes, 1234);
    }).not.toThrow();
  });

  it("handles 5-byte input safely without throwing (bounds check)", () => {
    const fiveBytes = new Uint8Array([0, 0, 0, 7, 99]);
    expect(() => {
      const res = unpackEnvelope(fiveBytes);
      expect(res).not.toBeNull();
      expect(res?.peerId).toBe(7);
      expect(res?.payload.byteLength).toBe(1);
      expect(res?.payload[0]).toBe(99);
    }).not.toThrow();

    expect(() => {
      rewriteEnvelopePeer(fiveBytes, 88);
    }).not.toThrow();

    const updated = unpackEnvelope(fiveBytes);
    expect(updated?.peerId).toBe(88);
    expect(updated?.payload[0]).toBe(99);
  });
});
