/**
 * D6 (round 28 post-fix audit): the guest copy of `link.ts` was hardened to return
 * static error text, but the copy the web client actually imports
 * (`@caw/collab-protocol`) still interpolated the submitted value. A collab link is
 * a bearer credential (AGENTS.md rule 3): its text must never reach a message the
 * user can copy, so every error from this module must be a static string.
 */
import { describe, expect, it } from "vitest";
import {
  parseCollabLink,
  formatCollabLink,
  encodeBase64Url,
} from "../../packages/collab-protocol/src/index.js";

const ROOM = "0123456789abcdef";
const KEY_B64 = encodeBase64Url(new Uint8Array(32).fill(7));

describe("D6 collab-protocol errors never echo the submitted link", () => {
  it("parseCollabLink returns static text for an unparsable link", () => {
    const link = `wss://exa mple.com/r/${ROOM}.${KEY_B64}`;
    const parsed = parseCollabLink(link);

    expect("error" in parsed).toBe(true);
    if (!("error" in parsed)) return;
    // No fragment of the credential: not the key, not the host, not the link.
    expect(parsed.error).not.toContain(KEY_B64);
    expect(parsed.error).not.toContain("exa mple.com");
    expect(parsed.error).not.toContain(link);
    expect(parsed.error).toBe("Invalid collab link");
  });

  it("normalizeRelayOrigin's invalid-URL error (via formatCollabLink) is static", () => {
    const attempt = (): string => formatCollabLink("ht tp://relay.example", ROOM, new Uint8Array(32));
    expect(attempt).toThrow();
    try {
      attempt();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("ht tp://relay.example");
      expect(message).toBe("Invalid relay URL");
    }
  });

  it("normalizeRelayOrigin's unsupported-scheme error (via formatCollabLink) is static", () => {
    const submitted = `ftp://relay.example/r/${ROOM}.${KEY_B64}`;
    const attempt = (): string => formatCollabLink(submitted, ROOM, new Uint8Array(32));
    expect(attempt).toThrow();
    try {
      attempt();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("ftp");
      expect(message).not.toContain("relay.example");
      expect(message).not.toContain(submitted);
      expect(message).toBe("Unsupported relay URL scheme");
    }
  });

  it("no error returned by parseCollabLink contains any part of the submitted link", () => {
    const secret = `${ROOM}.${KEY_B64}`;
    const candidates = [
      `${secret} extra`,                        // unparsable → the old `${link}` leak
      `wss://exa mple.com/r/${secret}`,         // unparsable host
      `not a link ${secret}`,                   // never a URL
    ];
    for (const candidate of candidates) {
      const parsed = parseCollabLink(candidate);
      expect("error" in parsed).toBe(true);
      if (!("error" in parsed)) continue;
      expect(parsed.error).not.toContain(KEY_B64);
      expect(parsed.error).not.toContain(ROOM);
      expect(parsed.error).not.toContain(candidate);
    }
  });
});
