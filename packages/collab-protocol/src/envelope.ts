/**
 * Ported from https://github.com/can1357/oh-my-pi (MIT License)
 * Upstream files:
 * - packages/collab-web/src/lib/link.ts
 * - packages/wire/src/index.ts
 */

import { ENVELOPE_HEADER_LENGTH } from "./types.js";

export function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array {
  const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
  new DataView(out.buffer, out.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
  out.set(sealed, ENVELOPE_HEADER_LENGTH);
  return out;
}

export function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } | null {
  if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
  const peerId = new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
  return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}

export function rewriteEnvelopePeer(data: Uint8Array, peerId: number): void {
  if (data.byteLength < ENVELOPE_HEADER_LENGTH) return;
  new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
}
