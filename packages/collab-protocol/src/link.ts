/**
 * Ported from https://github.com/can1357/oh-my-pi (MIT License)
 * Upstream files:
 * - packages/collab-web/src/lib/link.ts
 * - packages/coding-agent/src/collab/protocol.ts
 */

import {
  DEFAULT_RELAY_URL,
  ROOM_ID_BYTES,
  ROOM_KEY_BYTES,
  WRITE_TOKEN_BYTES,
  type ParsedCollabLink,
} from "./types.js";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:[#.]([A-Za-z0-9_-]+))?$/;
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const LOCAL_HOSTNAMES: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "::1": true,
  "[::1]": true,
};

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(text: string): Uint8Array | null {
  if (!B64URL_RE.test(text)) return null;
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.length % 4 === 0 ? base64 : base64 + "=".repeat(4 - (base64.length % 4));
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function generateRoomId(): string {
  const bytes = new Uint8Array(ROOM_ID_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function normalizeRelayOrigin(relayUrl: string): { origin: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return { error: `Invalid relay URL: ${relayUrl}` };
  }
  let scheme: string;
  switch (url.protocol) {
    case "wss:":
    case "https:":
      scheme = "wss:";
      break;
    case "ws:":
    case "http:":
      scheme = "ws:";
      break;
    default:
      return { error: `Unsupported relay URL scheme: ${url.protocol}` };
  }
  if (scheme === "ws:" && !LOCAL_HOSTNAMES[url.hostname]) {
    return { error: "relay link must be wss:// (plain ws:// is only allowed for localhost)" };
  }
  const port = url.port ? `:${url.port}` : "";
  return { origin: `${scheme}//${url.hostname}${port}` };
}

export function formatCollabLink(
  relayUrl: string,
  roomId: string,
  key: Uint8Array,
  writeToken?: Uint8Array
): string {
  const normalized = normalizeRelayOrigin(relayUrl);
  if ("error" in normalized) throw new Error(normalized.error);
  let secret = key;
  if (writeToken) {
    secret = new Uint8Array(key.byteLength + writeToken.byteLength);
    secret.set(key, 0);
    secret.set(writeToken, key.byteLength);
  }
  const keyText = encodeBase64Url(secret);
  if (normalized.origin === DEFAULT_RELAY_URL) return `${roomId}.${keyText}`;
  const compact = normalized.origin.startsWith("wss://")
    ? normalized.origin.slice("wss://".length)
    : normalized.origin;
  return `${compact}/r/${roomId}.${keyText}`;
}

export function parseCollabLink(
  link: string,
  defaultRelayUrl = DEFAULT_RELAY_URL
): ParsedCollabLink | { error: string } {
  let text = link.trim().replace(/%23/gi, "#");

  const bare = BARE_LINK_RE.exec(text);
  if (bare) {
    text = `${defaultRelayUrl}/r/${bare[1]}.${bare[2]}`;
  } else if (!text.includes("://")) {
    text = `wss://${text}`;
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: `Invalid collab link: ${link}` };
  }

  if ((url.protocol === "http:" || url.protocol === "https:") && url.hash) {
    const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    const parsed = parseCollabLink(inner, defaultRelayUrl);
    if (!("error" in parsed)) return parsed;
  }

  const normalized = normalizeRelayOrigin(url.origin);
  if ("error" in normalized) return normalized;

  const match = ROOM_PATH_RE.exec(url.pathname);
  if (!match) {
    const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    if (inner && url.protocol !== "http:" && url.protocol !== "https:") {
      return parseCollabLink(inner, defaultRelayUrl);
    }
    return { error: "Collab link must contain a /r/<roomId> path" };
  }

  const roomId = match[1]!;
  const fragment = match[2] ?? (url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  if (!fragment) {
    return { error: "Collab link is missing the <key> part" };
  }

  const secret = decodeBase64Url(fragment);
  if (!secret || (secret.byteLength !== ROOM_KEY_BYTES && secret.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES)) {
    return { error: "Collab link key must be 32 (view) or 48 (full) base64url bytes" };
  }

  const key = secret.subarray(0, ROOM_KEY_BYTES);
  const writeToken = secret.byteLength > ROOM_KEY_BYTES ? secret.subarray(ROOM_KEY_BYTES) : undefined;
  return { wsUrl: `${normalized.origin}/r/${roomId}`, roomId, key, writeToken };
}
