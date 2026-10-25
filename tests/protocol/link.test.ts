import { describe, it, expect } from "vitest";
import {
  parseCollabLink,
  formatCollabLink,
  encodeBase64Url,
  decodeBase64Url,
  generateRoomId,
  DEFAULT_RELAY_URL,
} from "../../packages/collab-protocol/src/index.js";

const VALID_ROOM_ID = "0123456789abcdef"; // 16 chars (valid 10-64 chars)
const KEY_32 = new Uint8Array(32).fill(1);
const KEY_32_B64 = encodeBase64Url(KEY_32);
const TOKEN_16 = new Uint8Array(16).fill(2);
const FULL_48 = new Uint8Array(48);
FULL_48.set(KEY_32, 0);
FULL_48.set(TOKEN_16, 32);
const FULL_48_B64 = encodeBase64Url(FULL_48);

describe("parseCollabLink", () => {
  const table = [
    {
      name: "bare roomId.key (32 bytes view)",
      input: `${VALID_ROOM_ID}.${KEY_32_B64}`,
      expected: {
        wsUrl: `${DEFAULT_RELAY_URL}/r/${VALID_ROOM_ID}`,
        roomId: VALID_ROOM_ID,
        keyLength: 32,
        hasWriteToken: false,
      },
    },
    {
      name: "bare roomId.key (48 bytes full control)",
      input: `${VALID_ROOM_ID}.${FULL_48_B64}`,
      expected: {
        wsUrl: `${DEFAULT_RELAY_URL}/r/${VALID_ROOM_ID}`,
        roomId: VALID_ROOM_ID,
        keyLength: 32,
        hasWriteToken: true,
      },
    },
    {
      name: "bare roomId.key with custom default relay",
      input: `${VALID_ROOM_ID}.${KEY_32_B64}`,
      defaultRelay: "wss://custom.relay.net",
      expected: {
        wsUrl: `wss://custom.relay.net/r/${VALID_ROOM_ID}`,
        roomId: VALID_ROOM_ID,
        keyLength: 32,
        hasWriteToken: false,
      },
    },
    {
      name: "scheme-less host/r/roomId.key",
      input: `relay.local:8443/r/${VALID_ROOM_ID}.${KEY_32_B64}`,
      expected: {
        wsUrl: `wss://relay.local:8443/r/${VALID_ROOM_ID}`,
        roomId: VALID_ROOM_ID,
        keyLength: 32,
        hasWriteToken: false,
      },
    },
    {
      name: "wss:// host/r/roomId.key",
      input: `wss://secure.relay.io/r/${VALID_ROOM_ID}.${FULL_48_B64}`,
      expected: {
        wsUrl: `wss://secure.relay.io/r/${VALID_ROOM_ID}`,
        roomId: VALID_ROOM_ID,
        keyLength: 32,
        hasWriteToken: true,
      },
    },
    {
      name: "legacy #key form in path",
      input: `wss://relay.io/r/${VALID_ROOM_ID}#${KEY_32_B64}`,
      expected: {
        wsUrl: `wss://relay.io/r/${VALID_ROOM_ID}`,
        roomId: VALID_ROOM_ID,
        keyLength: 32,
        hasWriteToken: false,
      },
    },
    {
      name: "legacy bare roomId#key",
      input: `${VALID_ROOM_ID}#${FULL_48_B64}`,
      expected: {
        wsUrl: `${DEFAULT_RELAY_URL}/r/${VALID_ROOM_ID}`,
        roomId: VALID_ROOM_ID,
        keyLength: 32,
        hasWriteToken: true,
      },
    },
    {
      name: "%23-mangled form (/r/roomId%23key)",
      input: `wss://relay.io/r/${VALID_ROOM_ID}%23${KEY_32_B64}`,
      expected: {
        wsUrl: `wss://relay.io/r/${VALID_ROOM_ID}`,
        roomId: VALID_ROOM_ID,
        keyLength: 32,
        hasWriteToken: false,
      },
    },
    {
      name: "browser deep link https://<webUrl>/#<relayLink>",
      input: `https://phone.tailnet.ts.net/#wss://relay.tailnet.ts.net/r/${VALID_ROOM_ID}.${FULL_48_B64}`,
      expected: {
        wsUrl: `wss://relay.tailnet.ts.net/r/${VALID_ROOM_ID}`,
        roomId: VALID_ROOM_ID,
        keyLength: 32,
        hasWriteToken: true,
      },
    },
    {
      name: "browser deep link with bare inner link",
      input: `http://localhost:8791/#${VALID_ROOM_ID}.${KEY_32_B64}`,
      expected: {
        wsUrl: `${DEFAULT_RELAY_URL}/r/${VALID_ROOM_ID}`,
        roomId: VALID_ROOM_ID,
        keyLength: 32,
        hasWriteToken: false,
      },
    },
    {
      name: "local plain ws:// for 127.0.0.1",
      input: `ws://127.0.0.1:7466/r/${VALID_ROOM_ID}.${KEY_32_B64}`,
      expected: {
        wsUrl: `ws://127.0.0.1:7466/r/${VALID_ROOM_ID}`,
        roomId: VALID_ROOM_ID,
        keyLength: 32,
        hasWriteToken: false,
      },
    },
  ];

  for (const tc of table) {
    it(`parses ${tc.name}`, () => {
      const result = parseCollabLink(tc.input, tc.defaultRelay);
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.wsUrl).toBe(tc.expected.wsUrl);
      expect(result.roomId).toBe(tc.expected.roomId);
      expect(result.key.byteLength).toBe(tc.expected.keyLength);
      if (tc.expected.hasWriteToken) {
        expect(result.writeToken).toBeDefined();
        expect(result.writeToken?.byteLength).toBe(16);
      } else {
        expect(result.writeToken).toBeUndefined();
      }
    });
  }

  const rejectionCases = [
    {
      name: "bad secret length (20 bytes)",
      input: `wss://relay.io/r/${VALID_ROOM_ID}.${encodeBase64Url(new Uint8Array(20))}`,
      errSubstr: "32 (view) or 48 (full)",
    },
    {
      name: "bad secret length (31 bytes)",
      input: `wss://relay.io/r/${VALID_ROOM_ID}.${encodeBase64Url(new Uint8Array(31))}`,
      errSubstr: "32 (view) or 48 (full)",
    },
    {
      name: "bad secret length (40 bytes)",
      input: `wss://relay.io/r/${VALID_ROOM_ID}.${encodeBase64Url(new Uint8Array(40))}`,
      errSubstr: "32 (view) or 48 (full)",
    },
    {
      name: "missing room path",
      input: `wss://relay.io/other/path.${KEY_32_B64}`,
      errSubstr: "must contain a /r/<roomId> path",
    },
    {
      name: "missing key part",
      input: `wss://relay.io/r/${VALID_ROOM_ID}`,
      errSubstr: "missing the <key> part",
    },
    {
      name: "unsupported scheme ftp://",
      input: `ftp://relay.io/r/${VALID_ROOM_ID}.${KEY_32_B64}`,
      errSubstr: "Unsupported relay URL scheme",
    },
    {
      name: "plain ws:// on remote host",
      input: `ws://example.com/r/${VALID_ROOM_ID}.${KEY_32_B64}`,
      errSubstr: "plain ws:// is only allowed for localhost",
    },
  ];

  for (const rc of rejectionCases) {
    it(`rejects ${rc.name}`, () => {
      const result = parseCollabLink(rc.input);
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain(rc.errSubstr);
      }
    });
  }
});

describe("formatCollabLink", () => {
  it("formats bare link when matching default relay", () => {
    const formatted = formatCollabLink(DEFAULT_RELAY_URL, VALID_ROOM_ID, KEY_32);
    expect(formatted).toBe(`${VALID_ROOM_ID}.${KEY_32_B64}`);
  });

  it("formats compact link for wss:// relay", () => {
    const formatted = formatCollabLink("wss://relay.example.com", VALID_ROOM_ID, KEY_32, TOKEN_16);
    expect(formatted).toBe(`relay.example.com/r/${VALID_ROOM_ID}.${FULL_48_B64}`);
  });
});
