import { expect, test, type APIRequestContext, type Page, type WebSocketRoute } from "@playwright/test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Shared helpers for the browser E2E specs.
 *
 * Two rules every spec follows:
 *  - drive the app through real roles and accessible names, never CSS classes,
 *    so a restyle cannot break the suite;
 *  - `test.skip(true, ...)` with a specific reason when a *prerequisite* is
 *    genuinely missing (app not built, API not wired), and fail loudly otherwise.
 *    A silently passing test is worse than a skipped one.
 *
 * These specs deliberately do not import @caw/contracts: E2E asserts the HTTP
 * wire and the rendered DOM, which a shared type cannot vouch for. Responses are
 * validated field by field, so a wrong shape fails with a readable message.
 */

/** Must stay identical to the value seeded by `scripts/e2e-server.mjs`. */
export const E2E_PASSWORD = "e2e-password-do-not-use-anywhere-else";

/** Narrow an unknown to an object or fail with a message that names the caller. */
function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context}: expected a JSON object, got ${JSON.stringify(value)?.slice(0, 200)}`);
  }
  return value as Record<string, unknown>;
}

function asString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${context}: expected string "${key}", got ${JSON.stringify(value)?.slice(0, 200)}`);
  return value;
}

export interface HarnessFixture {
  port: number;
  tempRoot: string;
  stateDir: string;
  rootsDir: string;
  password: string;
  pid: number;
  /** Pre-seeded so a conversation can be opened without launching an agent. */
  seededProjectId: string;
  seededConversationId: string;
}

/** Written by the launcher; the specs need exact fixture paths, not parsed JSON. */
export function harnessFixture(): HarnessFixture {
  const path = process.env.CAW_E2E_FIXTURE ?? join(tmpdir(), "caw-e2e-fixture.json");
  if (!existsSync(path)) {
    test.skip(true, `harness fixture not written at ${path}: scripts/e2e-server.mjs did not launch, so there is no app under test`);
    throw new Error("unreachable");
  }
  const raw = asRecord(JSON.parse(readFileSync(path, "utf8")), "harness fixture");
  return {
    port: Number(raw.port),
    tempRoot: asString(raw, "tempRoot", "harness fixture"),
    stateDir: asString(raw, "stateDir", "harness fixture"),
    rootsDir: asString(raw, "rootsDir", "harness fixture"),
    password: asString(raw, "password", "harness fixture"),
    pid: Number(raw.pid),
    seededProjectId: asString(raw, "seededProjectId", "harness fixture"),
    seededConversationId: asString(raw, "seededConversationId", "harness fixture"),
  };
}

export function assertInsideHarnessTemp(path: string): void {
  expect(path.startsWith(realpathSync(tmpdir())), `${path} must be inside ${tmpdir()}`).toBe(true);
}

/**
 * Skip with an explicit reason when the running server cannot serve this
 * harness: not started, or answering with something that is not the API at all
 * (e.g. a plain HTML file server). A 401 is expected and fine — the route is
 * protected, which still proves the server is the real one.
 */
export async function requireAppServer(request: APIRequestContext): Promise<void> {
  let status: number;
  try {
    status = (await request.get("/api/capabilities")).status();
  } catch (error) {
    test.skip(true, `apps/server is not reachable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (status === 200 || status === 401) return;
  test.skip(true, `apps/server answered GET /api/capabilities with ${status}; this build cannot be driven by the E2E harness yet`);
}

/**
 * Open the app and wait for the login screen.
 *
 * A non-200 root is a *missing prerequisite*, not a broken assertion: the server
 * is not serving the web build at all (today it answers 401 because the API's
 * auth hook guards every path). That must skip with the exact status, while a
 * 200 root that fails to render the login screen is app breakage and must fail.
 */
export async function gotoApp(page: Page): Promise<void> {
  const response = await page.goto("/");
  const status = response?.status();
  if (status !== 200) {
    test.skip(
      true,
      `apps/server does not serve the web app yet: GET / answered ${status}, expected 200 with the built SPA from apps/web/dist`,
    );
    return;
  }
  await expect(page.getByRole("heading", { name: "Coding Agent Web" })).toBeVisible();
}

export async function login(page: Page, password: string = E2E_PASSWORD): Promise<void> {
  await gotoApp(page);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
}

/** Create a project for one of the launcher's fixture directories, via the UI. */
export async function createProjectFromBrowser(page: Page, folderName: string, label: string): Promise<void> {
  await page.getByRole("button", { name: "+ New Project" }).click();
  await expect(page.getByRole("heading", { name: "Browse Folders" })).toBeVisible();
  await openFolderRow(page, folderName);
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect(page.getByRole("heading", { name: "Create Project" })).toBeVisible();
  await page.getByPlaceholder("Display label (e.g. My Backend)").fill(label);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
}

/**
 * Open the conversation seeded by the launcher, through the real UI path
 * (Seeded Fixture project → its conversation). No agent is launched: the
 * conversation already exists in the seeded metadata store.
 */
export async function openSeededConversation(page: Page): Promise<string> {
  const fixture = harnessFixture();
  await login(page);
  await page.getByRole("heading", { name: "Seeded Fixture", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Seeded conversation", exact: true })).toBeVisible();
  await page.getByRole("heading", { name: "Seeded conversation", exact: true }).click();
  return fixture.seededConversationId;
}

/** The link endpoint is the conversation screen's only source of host state. */
export async function mockConversationLink(page: Page, body: unknown, status = 200): Promise<void> {
  await page.route("**/api/conversations/*/link", async (route) => {
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
}

/**
 * Click a folder row in the browser list. The rows are plain `div`s labelled
 * `📁 <name>` (not links or buttons), so the row is matched on its visible text;
 * the leading glyph is ignored so a different icon does not break navigation.
 */
export async function openFolderRow(page: Page, name: string): Promise<void> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.getByText(new RegExp(`^\\S+\\s+${escaped}$`)).click();
}

export interface ProjectRecord {
  id: string;
  path: string;
  label: string;
  favorite: boolean;
}

/** GET /api/projects with the page's session, validated rather than trusted. */
export async function readProjects(page: Page): Promise<ProjectRecord[]> {
  const response = await page.request.get("/api/projects");
  expect(response.status(), "GET /api/projects needs the session cookie").toBe(200);
  const raw = asRecord(await response.json(), "GET /api/projects");
  if (raw.ok !== true) throw new Error(`GET /api/projects failed: ${JSON.stringify(raw).slice(0, 200)}`);
  if (!Array.isArray(raw.data)) throw new Error("GET /api/projects returned no data array");
  return raw.data.map((row) => {
    const record = asRecord(row, "project row");
    return {
      id: asString(record, "id", "project row"),
      path: asString(record, "path", "project row"),
      label: asString(record, "label", "project row"),
      favorite: record.favorite === true,
    };
  });
}

export async function projectByLabel(page: Page, label: string): Promise<ProjectRecord> {
  const projects = await readProjects(page);
  const project = projects.find((item) => item.label === label);
  expect(project, `project "${label}" should be stored`).toBeDefined();
  return project!;
}

export interface DirectoryEntryRecord {
  name: string;
  path: string;
  isDirectory: boolean;
  allowed: boolean;
}

export interface DirectoryListingRecord {
  path: string;
  parent: string | null;
  roots: string[];
  entries: DirectoryEntryRecord[];
}

/** GET /api/browse, validated rather than trusted. */
export async function readBrowse(page: Page, path?: string): Promise<DirectoryListingRecord> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const response = await page.request.get(`/api/browse${query}`);
  expect(response.status(), `GET /api/browse${query} should succeed inside the allowed roots`).toBe(200);
  const raw = asRecord(await response.json(), `GET /api/browse${query}`);
  if (raw.ok !== true) throw new Error(`GET /api/browse${query} failed: ${JSON.stringify(raw).slice(0, 200)}`);
  const data = asRecord(raw.data, "browse listing");
  if (!Array.isArray(data.entries)) throw new Error("browse listing has no entries array");
  return {
    path: asString(data, "path", "browse listing"),
    parent: typeof data.parent === "string" ? data.parent : null,
    roots: Array.isArray(data.roots) ? data.roots.filter((root): root is string => typeof root === "string") : [],
    entries: data.entries.map((entry) => {
      const record = asRecord(entry, "browse entry");
      return {
        name: asString(record, "name", "browse entry"),
        path: asString(record, "path", "browse entry"),
        isDirectory: record.isDirectory === true,
        allowed: record.allowed === true,
      };
    }),
  };
}

/** The status banner(s) the conversation screen renders for a connection state. */
export function statusBanner(page: Page) {
  return page.getByRole("status");
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Collab host
//
// Conversation-state assertions (banners, composer placement, reconnect) must
// not depend on a live agent: launching one costs the owner's credits, which
// this harness must never do. `page.routeWebSocket` lets us be the host without
// any server socket at all.
//
// The link is minted *here* and served in place of the real one, so the room key
// is known to the mock and its frames can be sealed exactly like the real host
// does: 4-byte big-endian peer prefix + AES-256-GCM `[12B IV][ciphertext+tag]`.
// ─────────────────────────────────────────────────────────────────────────────

const ENVELOPE_HEADER_LENGTH = 4;
const ROOM_KEY_BYTES = 32;
const WRITE_TOKEN_BYTES = 16;
const IV_BYTES = 12;
const LOCAL_RELAY_URL = "ws://127.0.0.1:7466";
const HOST_PEER_ID = 0;

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** A fresh byte array over its own ArrayBuffer, so WebCrypto accepts it. */
function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(length)));
}

export interface MockCollabHost {
  /** How many times the page opened the room socket; retries count. */
  connections: number;
  /** Prompt texts the page sent, in order — used to prove nothing was resubmitted. */
  prompts: string[];
  /** Other guest frames seen, for diagnostics and ordering assertions. */
  guestFrames: Array<Record<string, unknown>>;
  /** Push a host frame on the currently open socket, sealed with the room key. */
  send(frame: Record<string, unknown>): Promise<void>;
  /** Drop the socket the way a lost network does (code 1006 → the client retries). */
  drop(): Promise<void>;
  /** Stop the mock socket so the client can never reconnect (fatal close 4009). */
  closeFatal(): Promise<void>;
}

/**
 * Stand in for the server's link endpoint and for the Collab relay. Returns a
 * controller the spec drives to reach each connection state on demand.
 */
export async function installMockCollabHost(page: Page, options: { conversationId: string }): Promise<MockCollabHost> {
  const key = randomBytes(ROOM_KEY_BYTES);
  const writeToken = randomBytes(WRITE_TOKEN_BYTES);
  const secret = new Uint8Array(ROOM_KEY_BYTES + WRITE_TOKEN_BYTES);
  secret.set(key, 0);
  secret.set(writeToken, ROOM_KEY_BYTES);
  const roomId = encodeBase64Url(randomBytes(16)).slice(0, 22);
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);

  // Resolved the first time the page opens the room socket, so a spec can push a
  // frame as soon as the screen is mounted without racing the handshake.
  // (Hand-rolled because this repo targets Node 20, which lacks Promise.withResolvers.)
  let socketReadyResolveHolder: (socket: WebSocketRoute) => void = () => undefined;
  const socketReady = new Promise<WebSocketRoute>((resolve) => {
    socketReadyResolveHolder = resolve;
  });
  // React StrictMode mounts the screen twice, so the page opens more than one
  // socket and abandons the first. Frames must go to every open socket: sending
  // only to the newest can land on a connection the page already discarded.
  const sockets = new Set<WebSocketRoute>();
  let warmedUp = false;

  /**
   * Close the current room socket. Awaits the handshake first: the page opens the
   * socket while the screen mounts, so a spec that closes too early would close
   * nothing and then wait forever for a state change that cannot happen.
   */
  const closeSocket = async (options: { code: number; reason?: string }): Promise<void> => {
    await socketReady;
    for (const socket of [...sockets]) {
      try {
        socket.close(options);
      } catch {
        // Already closed by the page.
      }
      sockets.delete(socket);
    }
  };

  const host: MockCollabHost = {
    connections: 0,
    prompts: [],
    guestFrames: [],
    async send(frame) {
      await socketReady;
      const sealed = Buffer.from(await sealForTest(cryptoKey, frame));
      // `routeWebSocket` opens the socket before the page attaches `onmessage`,
      // and StrictMode's discarded first socket never gets one: a short warm-up
      // makes the mock's first frame observable instead of racing the handler.
      if (!warmedUp) {
        warmedUp = true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      for (const socket of sockets) {
        try {
          socket.send(sealed);
        } catch {
          // The spec dropped this one first; nothing to deliver to.
        }
      }
    },
    async drop() {
      await closeSocket({ code: 1006 });
    },
    async closeFatal() {
      await closeSocket({ code: 4009, reason: "a host is already connected for this room" });
    },
  };
  await page.route(`**/api/conversations/${options.conversationId}/link`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          // Bare form is what the protocol uses for the default loopback relay;
          // parseCollabLink expands it back to ws://127.0.0.1:7466/r/<roomId>.
          url: `${roomId}.${encodeBase64Url(secret)}`,
          access: "full",
          instanceId: "e2e-mock-host",
          generation: 1,
        },
      }),
    });
  });

  await page.routeWebSocket(/\/r\//, (ws) => {
    host.connections += 1;
    sockets.add(ws);
    warmedUp = false;
    socketReadyResolveHolder(ws);
    ws.onMessage((message) => {
      void (async () => {
        // Only binary frames are expected; Playwright hands them over as Buffers.
        if (typeof message === "string") return;
        const bytes = message as Buffer;
        if (bytes.byteLength <= ENVELOPE_HEADER_LENGTH) return;
        const payload = bytes.subarray(ENVELOPE_HEADER_LENGTH);
        const sealed = new Uint8Array(new ArrayBuffer(payload.byteLength));
        sealed.set(payload);
        const frame = await openForTest(cryptoKey, sealed);
        if (typeof frame !== "object" || frame === null) return;
        const record = frame as Record<string, unknown>;
        if (record.t === "prompt" && typeof record.text === "string") host.prompts.push(record.text);
        host.guestFrames.push(record);
      })();
    });
  });

  return host;
}

/** Seal a host frame the way `packages/collab-protocol`'s codec does. */
async function sealForTest(key: CryptoKey, frame: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const iv = randomBytes(IV_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(frame));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + IV_BYTES + ciphertext.byteLength);
  new DataView(out.buffer).setUint32(0, HOST_PEER_ID, false);
  out.set(iv, ENVELOPE_HEADER_LENGTH);
  out.set(ciphertext, ENVELOPE_HEADER_LENGTH + IV_BYTES);
  return out;
}

/** Inverse of sealForTest, for guest frames sent by the page. */
async function openForTest(key: CryptoKey, sealed: Uint8Array<ArrayBuffer>): Promise<unknown> {
  if (sealed.byteLength <= IV_BYTES) return null;
  const iv = sealed.subarray(0, IV_BYTES);
  const ciphertext = sealed.subarray(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  const text = new TextDecoder().decode(plaintext);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A `welcome` frame that puts the screen in the given busy state. */
export function welcomeFrame(busy: boolean) {
  return {
    t: "welcome",
    proto: 3,
    header: { sessionId: "e2e-session", cwd: "/tmp", timestamp: null, version: 1, title: "E2E" },
    state: { busy },
    agents: [],
    entryCount: 0,
  };
}

