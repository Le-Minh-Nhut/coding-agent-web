import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SessionLeaseProbe } from "./types.js";

export const HIGH_SEED = 0x4f4d502d4c4f434bn;
export const LOW_SEED = 0x50492d46494c454cn;

const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;
const MASK64 = 0xffffffffffffffffn;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function rotl(x: bigint, r: bigint): bigint {
  return ((x << r) | (x >> (64n - r))) & MASK64;
}

function round(acc: bigint, input: bigint): bigint {
  acc = (acc + ((input * PRIME64_2) & MASK64)) & MASK64;
  acc = rotl(acc, 31n);
  return (acc * PRIME64_1) & MASK64;
}

function mergeRound(acc: bigint, val: bigint): bigint {
  val = round(0n, val);
  acc = (acc ^ val) & MASK64;
  return ((acc * PRIME64_1) + PRIME64_4) & MASK64;
}

export function xxh64(input: string | Uint8Array, seed = 0n): bigint {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const len = BigInt(buffer.length);
  let h64 = 0n;
  let offset = 0;

  if (buffer.length >= 32) {
    let v1 = (seed + PRIME64_1 + PRIME64_2) & MASK64;
    let v2 = (seed + PRIME64_2) & MASK64;
    let v3 = seed & MASK64;
    let v4 = (seed - PRIME64_1) & MASK64;

    const limit = buffer.length - 32;
    while (offset <= limit) {
      v1 = round(v1, buffer.readBigUInt64LE(offset));
      v2 = round(v2, buffer.readBigUInt64LE(offset + 8));
      v3 = round(v3, buffer.readBigUInt64LE(offset + 16));
      v4 = round(v4, buffer.readBigUInt64LE(offset + 24));
      offset += 32;
    }

    h64 = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK64;
    h64 = mergeRound(h64, v1);
    h64 = mergeRound(h64, v2);
    h64 = mergeRound(h64, v3);
    h64 = mergeRound(h64, v4);
  } else {
    h64 = (seed + PRIME64_5) & MASK64;
  }

  h64 = (h64 + len) & MASK64;

  while (offset <= buffer.length - 8) {
    const k1 = round(0n, buffer.readBigUInt64LE(offset));
    h64 = (h64 ^ k1) & MASK64;
    h64 = ((rotl(h64, 27n) * PRIME64_1) + PRIME64_4) & MASK64;
    offset += 8;
  }

  if (offset <= buffer.length - 4) {
    const k1 = (BigInt(buffer.readUInt32LE(offset)) * PRIME64_1) & MASK64;
    h64 = (h64 ^ k1) & MASK64;
    h64 = ((rotl(h64, 23n) * PRIME64_2) + PRIME64_3) & MASK64;
    offset += 4;
  }

  while (offset < buffer.length) {
    const k1 = (BigInt(buffer[offset]!) * PRIME64_5) & MASK64;
    h64 = (h64 ^ k1) & MASK64;
    h64 = (rotl(h64, 11n) * PRIME64_1) & MASK64;
    offset += 1;
  }

  h64 = (h64 ^ (h64 >> 33n)) & MASK64;
  h64 = (h64 * PRIME64_2) & MASK64;
  h64 = (h64 ^ (h64 >> 29n)) & MASK64;
  h64 = (h64 * PRIME64_3) & MASK64;
  h64 = (h64 ^ (h64 >> 32n)) & MASK64;

  return h64;
}

export function xxh64hex16(input: string | Uint8Array, seed: bigint): string {
  return xxh64(input, seed).toString(16).padStart(16, "0");
}

export interface SessionLeaseOptions {
  ownersDir?: string;
  procNetUnixPath?: string;
}

export class DefaultSessionLeaseProbe implements SessionLeaseProbe {
  readonly #ownersDir: string;
  readonly #procNetUnixPath: string;

  constructor(options: SessionLeaseOptions = {}) {
    this.#ownersDir =
      options.ownersDir ??
      process.env.OMP_SESSION_OWNERS_DIR ??
      (process.env.XDG_STATE_HOME
        ? path.join(process.env.XDG_STATE_HOME, "omp", "run", "session-owners")
        : path.join(homedir(), ".omp", "run", "session-owners"));
    this.#procNetUnixPath = options.procNetUnixPath ?? "/proc/net/unix";
  }

  leaseName(sessionId: string): string {
    const lockPath = `${path.resolve(path.join(this.#ownersDir, sessionId))}.lock`;
    const high = xxh64hex16(lockPath, HIGH_SEED);
    const low = xxh64hex16(lockPath, LOW_SEED);
    return `omp-file-lock-${high}${low}`;
  }

  async isLive(sessionId: string): Promise<boolean | "unknown"> {
    if (!TOKEN_PATTERN.test(sessionId)) {
      return "unknown";
    }

    try {
      const unix = await readFile(this.#procNetUnixPath, "utf8");
      const target = `@${this.leaseName(sessionId)}`;
      return unix.includes(target);
    } catch {
      return "unknown";
    }
  }

  async liveSet(sessionIds: readonly string[]): Promise<Map<string, boolean | "unknown">> {
    const result = new Map<string, boolean | "unknown">();
    let boundSockets: Set<string>;

    try {
      const unix = await readFile(this.#procNetUnixPath, "utf8");
      boundSockets = new Set<string>();
      const matches = unix.match(/@omp-file-lock-[0-9a-f]{32}/g);
      if (matches) {
        for (const item of matches) boundSockets.add(item.slice(1));
      }
    } catch {
      for (const id of sessionIds) result.set(id, "unknown");
      return result;
    }

    for (const id of sessionIds) {
      if (!TOKEN_PATTERN.test(id)) result.set(id, "unknown");
      else result.set(id, boundSockets.has(this.leaseName(id)));
    }

    return result;
  }
}
