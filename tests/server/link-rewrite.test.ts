import { describe, expect, it } from "vitest";
import { rewriteCollabLink } from "../../apps/server/src/server";

/**
 * The room link handed to the browser is rewritten so its origin is reachable by
 * the phone while the agent keeps talking to a private loopback relay.
 *
 * Two properties matter:
 *  1. the credential — room id and secret — must survive byte for byte, because it
 *     is what grants access;
 *  2. the result must be a **deep link** (`<publicOrigin>/#<relayLink>`), so the
 *     room path lives in the fragment. A fragment is never sent to a server, which
 *     is the whole reason OMP encodes links that way.
 *
 * Secret lengths are real: 43 base64url characters decode to a 32-byte view key,
 * 64 to the 48-byte key+write-token of a full-control link.
 */
const ROOM = "F_dMfilQOchWSOuTwQ9LQQ";
const VIEW_SECRET = "A".repeat(43);
const FULL_SECRET = "A".repeat(64);
const PUBLIC = "https://workstation.tail8d8eff.ts.net";

describe("rewriteCollabLink", () => {
  it("turns a direct relay link into a deep link on the public origin, keeping room and secret", () => {
    const original = `ws://127.0.0.1:8792/r/${ROOM}.${FULL_SECRET}`;
    const rewritten = rewriteCollabLink(original, PUBLIC);

    expect(rewritten).toBe(`${PUBLIC}/#wss://workstation.tail8d8eff.ts.net/r/${ROOM}.${FULL_SECRET}`);
    // The credential is what grants access; assert it is bit-identical, not merely present.
    expect(rewritten.split("/r/")[1]).toBe(original.split("/r/")[1]);
    // The path must be in the fragment, never in a path or query the network sees.
    expect(new URL(rewritten).pathname).toBe("/");
  });

  it("rewrites the inner relay link of a deep link and keeps the secret intact", () => {
    const original = `${PUBLIC}/#ws://127.0.0.1:8792/r/${ROOM}.${VIEW_SECRET}`;
    const rewritten = rewriteCollabLink(original, PUBLIC);

    expect(rewritten).toBe(`${PUBLIC}/#wss://workstation.tail8d8eff.ts.net/r/${ROOM}.${VIEW_SECRET}`);
    expect(rewritten.split("/r/")[1]).toBe(original.split("/r/")[1]);
  });

  it("carries the public origin's scheme into the fragment", () => {
    const secured = rewriteCollabLink(`ws://127.0.0.1:8792/r/${ROOM}.${VIEW_SECRET}`, "https://host.ts.net");
    const plain = rewriteCollabLink(`ws://127.0.0.1:8792/r/${ROOM}.${VIEW_SECRET}`, "http://127.0.0.1:8791");
    // A fragment on an https page must use wss, or the browser refuses the socket.
    expect(secured).toContain("#wss://");
    expect(secured).not.toContain("#ws://");
    expect(plain).toContain("#ws://127.0.0.1:8791/r/");
  });

  it("preserves the full secret verbatim, including base64url padding-free characters", () => {
    // `-` and `_` are base64url; a naive re-encode or decode would corrupt them.
    const tricky = "-_".repeat(32);
    const rewritten = rewriteCollabLink(`ws://127.0.0.1:8792/r/${ROOM}.${tricky}`, PUBLIC);
    expect(rewritten.split("/r/")[1]).toBe(`${ROOM}.${tricky}`);
  });

  it("refuses a secret that cannot be a real room key", () => {
    for (const bad of ["A".repeat(20), "A".repeat(42), "A".repeat(65)]) {
      expect(() => rewriteCollabLink(`ws://127.0.0.1:8792/r/${ROOM}.${bad}`, PUBLIC)).toThrow(/secret/i);
    }
  });

  it("refuses a path that is not a room link", () => {
    for (const path of ["/healthz", "/r/", `/r/${ROOM}`, `/api/x.${FULL_SECRET}`]) {
      expect(() => rewriteCollabLink(`ws://127.0.0.1:8792${path}`, PUBLIC)).toThrow();
    }
  });

  it("refuses a scheme that is not a websocket link", () => {
    // A file: or ftp: URL is not a relay link, and re-parsing one would produce a
    // URL whose meaning we cannot vouch for.
    expect(() => rewriteCollabLink(`file:///r/${ROOM}.${FULL_SECRET}`, PUBLIC)).toThrow(/ws:\/\/ or wss:\/\//i);
    expect(() => rewriteCollabLink(`ftp://host/r/${ROOM}.${FULL_SECRET}`, PUBLIC)).toThrow(/ws:\/\/ or wss:\/\//i);
  });

  it("refuses a query string rather than silently keeping or dropping it", () => {
    expect(() => rewriteCollabLink(`ws://127.0.0.1:8792/r/${ROOM}.${FULL_SECRET}?x=1`, PUBLIC)).toThrow(/query/i);
  });

  it("refuses a value that is not a URL at all", () => {
    expect(() => rewriteCollabLink("not a url", PUBLIC)).toThrow(/Cannot parse/i);
  });

  it("does not accept a path the URL parser silently normalized", () => {
    // `/r/./x` and `/r/../x` fold during parsing. If the parse folded it, the path
    // we validated is not the path in the input, so we refuse instead of guessing.
    for (const raw of [`ws://127.0.0.1:8792/r/./${ROOM}.${FULL_SECRET}`, `ws://127.0.0.1:8792/r/../${ROOM}.${FULL_SECRET}`]) {
      const parsed = new URL(raw).pathname;
      if (parsed !== `/r/${ROOM}.${FULL_SECRET}`) {
        expect(() => rewriteCollabLink(raw, PUBLIC)).toThrow();
      }
    }
  });

  it("refuses an outer query string on a deep link instead of dropping it", () => {
    // Rewriting the origin while silently discarding part of the input would hand
    // back a link that differs from the one we were given in ways nobody can see.
    expect(() => rewriteCollabLink(`${PUBLIC}/?ref=x#ws://127.0.0.1:8792/r/${ROOM}.${FULL_SECRET}`, PUBLIC)).toThrow(/query/i);
  });

  it("refuses a deep link whose outer URL is not a web page", () => {
    // The outer URL is what the phone opens; anything but http(s) is not a page.
    for (const scheme of ["ftp", "file", "javascript", "data"]) {
      const raw = `${scheme}:${{ ftp: "//host/", file: "///", javascript: "alert(1)//", data: "text/html," }[scheme]}#ws://127.0.0.1:8792/r/${ROOM}.${FULL_SECRET}`;
      expect(() => rewriteCollabLink(raw, PUBLIC)).toThrow();
    }
  });

  it("refuses a query string on a deep link's inner relay link", () => {
    expect(() => rewriteCollabLink(`${PUBLIC}/#ws://127.0.0.1:8792/r/${ROOM}.${FULL_SECRET}?x=1`, PUBLIC)).toThrow(/query/i);
  });

  it("keeps the deep link usable when the public origin has a port", () => {
    const rewritten = rewriteCollabLink(`ws://127.0.0.1:8792/r/${ROOM}.${FULL_SECRET}`, "https://host.ts.net:8443");
    expect(rewritten.startsWith("https://host.ts.net:8443/#wss://host.ts.net:8443/r/")).toBe(true);
    expect(rewritten.split("/r/")[1]).toBe(`${ROOM}.${FULL_SECRET}`);
  });
});
