import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  createAssistantMessageEntry,
  createUserMessageEntry,
  harnessFixture,
  installMockCollabHost,
  openSeededConversation,
  requireAppServer,
  welcomeFrame,
  type MockCollabHost,
} from "./fixture.js";
import { revealRow } from "./perf-scroll-harness.js";

/**
 * HIST-01..15: conversation history synchronisation, driven through a real browser
 * against the mock Collab host.
 *
 * The reported defect is reproduced for real here: an existing conversation whose
 * history is still arriving (or was truncated) must NOT render as "No prompts yet".
 * `transport/history-loading.spec.ts` covers the relay-side half of the same bug;
 * these specs cover the client state machine and its rendering.
 *
 * Nothing in this file launches an agent: the mock host stands in for the relay, so
 * every scenario is free and deterministic.
 */

const COMPOSER = /Send a follow-up…|Turn in flight — send a follow-up…|Read-only/;
const EMPTY_COPY = "No prompts yet";
const LOADING_COPY = "Loading conversation";

test.beforeEach(async ({ request }: { request: APIRequestContext }) => {
  await requireAppServer(request);
});

/** Build a well-formed snapshot of `count` messages, in `chunks` chunks. */
function snapshot(count: number, chunks: number): Array<{ t: string; entries: unknown[]; final: boolean }> {
  const entries = Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? createUserMessageEntry(`u-${index}`, `prompt number ${index}`, 1_700_000_000_000 + index)
      : createAssistantMessageEntry(`a-${index}`, `answer number ${index}`, 1_700_000_000_000 + index),
  );
  const size = Math.ceil(count / chunks);
  const out: Array<{ t: string; entries: unknown[]; final: boolean }> = [];
  for (let start = 0; start < count; start += size) {
    const slice = entries.slice(start, start + size);
    out.push({ t: "snapshot-chunk", entries: slice, final: start + size >= count });
  }
  return out;
}

/** The rendered transcript rows, in order. */
async function transcriptTexts(page: Page): Promise<string[]> {
  const rows = page.locator(".messages-scroll .message-card");
  const count = await rows.count();
  const texts: string[] = [];
  for (let i = 0; i < count; i += 1) texts.push(((await rows.nth(i).textContent()) ?? "").trim());
  return texts;
}

async function openWithHost(page: Page): Promise<{ host: MockCollabHost; fixture: ReturnType<typeof harnessFixture> }> {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await expect(page.getByRole("textbox", { name: COMPOSER })).toBeVisible();
  return { host, fixture };
}

test("HIST-01: an existing 50-message conversation renders every row in order", async ({ page }) => {
  const { host } = await openWithHost(page);
  await host.send(welcomeFrame(false));
  // The welcome is metadata only; the entries follow as chunks.
  await host.send({ t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 50 });
  for (const chunk of snapshot(50, 3)) await host.send(chunk);

  await expect(page.getByText(EMPTY_COPY)).toBeHidden();
  const texts = await transcriptTexts(page);
  expect(texts.length).toBe(50);
  expect(texts[0]).toContain("prompt number 0");
  expect(texts[49]).toContain("answer number 49");
});

test("HIST-02: a welcome with a pending snapshot shows loading, never the empty copy", async ({ page }) => {
  const { host } = await openWithHost(page);
  await host.send({ t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 3238 });

  // This is the reported bug, exactly: thousands of entries promised, nothing
  // arrived yet, and the old build said "No prompts yet".
  await expect(page.getByText(LOADING_COPY)).toBeVisible();
  await expect(page.getByText(EMPTY_COPY)).toBeHidden();
  await expect(page.locator(".empty-state-sub")).toContainText("0 of 3238");
});

test("HIST-03: a stalled snapshot becomes visible and recoverable", async ({ page }) => {
  test.setTimeout(120_000);
  const { host } = await openWithHost(page);
  await host.send({ t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 10 });
  await host.send({ t: "snapshot-chunk", entries: [createUserMessageEntry("u-0", "first", 1)], final: false });

  // The progress window is 30s; wait for the verdict rather than guessing at it.
  await expect(page.getByText("History did not finish loading")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(EMPTY_COPY)).toBeHidden();

  // Retry rejoins the SAME conversation: a new socket, no new prompt, no launch.
  const before = host.connections;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => host.connections, "retry must rejoin the room").toBeGreaterThan(before);
  expect(host.prompts).toEqual([]);
});

test("HIST-04: multi-batch chunks arrive without duplicates and keep live updates", async ({ page }) => {
  const { host } = await openWithHost(page);
  await host.send({ t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 20 });
  const chunks = snapshot(20, 4);
  for (const chunk of chunks.slice(0, 2)) await host.send(chunk);
  // A live row lands mid-snapshot; it must appear AFTER the snapshot, not inline.
  await host.send({ t: "entry", entry: createUserMessageEntry("live-1", "live during snapshot", 9_999) });
  for (const chunk of chunks.slice(2)) await host.send(chunk);

  /**
   * Wait for the transcript to settle, then assert the exact set.
   *
   * The mock host delivers frames over the socket, so "I sent every chunk" is not the same
   * instant as "the app has rendered them": reading the DOM on the next round trip can
   * land while the window is still empty (measured: `Received: 0` for this exact flow,
   * against `21` when the same test was re-read one frame later). The claim is unchanged —
   * no duplicated and no lost rows — so it polls for the count a correct build reaches
   * rather than weakening the number.
   */
  await expect.poll(() => transcriptTexts(page).then((rows) => rows.length)).toBe(21);
  const texts = await transcriptTexts(page);
  expect(texts.length, "no row may be duplicated or lost").toBe(21);
  expect(texts[20], "the live row belongs at the tail").toContain("live during snapshot");
});

test("HIST-05: a disconnect mid-snapshot drops the partial history instead of showing a prefix", async ({ page }) => {
  const { host } = await openWithHost(page);
  await host.send({ t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 100 });
  await host.send({ t: "snapshot-chunk", entries: [createUserMessageEntry("u-0", "only one of a hundred", 1)], final: false });

  await host.drop();
  // One row of a promised hundred is not the conversation: showing it would be a
  // confident lie. The view must not present it as the transcript.
  await expect(page.getByText("only one of a hundred")).toBeHidden();
});

test("HIST-06: reopening a populated conversation restores its history with no new prompt", async ({ page }) => {
  const { host } = await openWithHost(page);
  const welcome: Record<string, unknown> = { t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 4 };
  await host.send(welcome);
  for (const chunk of snapshot(4, 1)) await host.send(chunk);
  await expect.poll(async () => (await transcriptTexts(page)).length).toBe(4);

  // Leave the conversation with the app's own Back control, then reopen it. A
  // fresh mock stands in for the rejoined room: the previous connection's socket
  // is gone with the screen, and its controller would be delivering into a dead
  // one (the frames would be dropped, which is not what this test is about).
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Seeded conversation", exact: true })).toBeVisible();
  const second = await installMockCollabHost(page, { conversationId: harnessFixture().seededConversationId });
  await page.getByRole("heading", { name: "Seeded conversation", exact: true }).click();
  await expect(page.getByRole("textbox", { name: COMPOSER })).toBeVisible();

  await second.send(welcome);
  for (const chunk of snapshot(4, 1)) await second.send(chunk);
  await expect.poll(async () => (await transcriptTexts(page)).length).toBe(4);
  expect(host.prompts, "reopening must not re-send anything").toEqual([]);
});

test("HIST-07: a browser refresh reloads history", async ({ page }) => {
  const { host } = await openWithHost(page);
  const welcome: Record<string, unknown> = { t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 4 };
  await host.send(welcome);
  for (const chunk of snapshot(4, 1)) await host.send(chunk);
  await expect.poll(async () => (await transcriptTexts(page)).length).toBe(4);

  // A refresh returns to the project list (the app keeps no URL for the open
  // conversation), so the conversation is reopened and re-synced. What matters is
  // that the history comes back rather than staying blank.
  await page.reload();
  const second = await installMockCollabHost(page, { conversationId: harnessFixture().seededConversationId });
  // The session cookie survives the reload, so this goes straight to the project
  // list: running `login` again would sit on a login screen that never appears.
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Seeded Fixture", exact: true }).click();
  await page.getByRole("heading", { name: "Seeded conversation", exact: true }).click();
  await expect(page.getByRole("textbox", { name: COMPOSER })).toBeVisible();
  await second.send(welcome);
  for (const chunk of snapshot(4, 1)) await second.send(chunk);
  await expect.poll(async () => (await transcriptTexts(page)).length).toBe(4);
});

test("HIST-08: switching conversations does not leak one transcript into another", async ({ page }) => {
  const { host } = await openWithHost(page);
  await host.send({ t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 4 });
  for (const chunk of snapshot(4, 1)) await host.send(chunk);
  // Same settle rule as HIST-04: the frames are asynchronous, so the four rows are
  // polled for rather than read on the next round trip (measured: an immediate read can
  // see the empty window).
  await expect.poll(() => transcriptTexts(page).then((rows) => rows.length)).toBe(4);
  expect((await transcriptTexts(page)).length).toBe(4);

  // Navigate away and back: the previous conversation's rows must not survive into
  // the new screen, and an un-synced conversation must not claim to be empty.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("heading", { name: "Seeded conversation", exact: true }).click();
  await expect(page.getByText(EMPTY_COPY)).toBeHidden();
  await expect.poll(async () => (await transcriptTexts(page)).length).toBe(0);
});

test("HIST-09: a genuinely empty session shows the empty state once sync completes", async ({ page }) => {
  const { host } = await openWithHost(page);
  // The host positively reports zero entries — the one authoritative empty signal.
  await host.send({ t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 0 });

  await expect(page.getByText("Start the conversation")).toBeVisible();
  await expect(page.getByText("This session has no prompts yet.")).toBeVisible();
  await expect(page.getByText(LOADING_COPY)).toBeHidden();
});

test("HIST-10: entries promised but never delivered is never reported as an empty native history", async ({ page }) => {
  const { host } = await openWithHost(page);
  await host.send({ t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 100 });
  await host.send({ t: "snapshot-chunk", entries: [], final: true });

  // The host promised a hundred rows and shipped none: the transcript is finished
  // but its content is unexplained. Claiming the session "has no prompts yet"
  // would assert the native journal is empty on evidence that does not exist, so
  // the view reports the gap and offers a retry instead.
  await expect(page.getByText(EMPTY_COPY)).toBeHidden();
  await expect(page.getByText("History did not finish loading")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("HIST-11: background/foreground reconnection recovers without a restart", async ({ page }) => {
  const { host } = await openWithHost(page);
  await host.send({ t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 4 });
  for (const chunk of snapshot(4, 1)) await host.send(chunk);
  await expect.poll(async () => (await transcriptTexts(page)).length).toBe(4);

  // Suspend the page the way iOS does when the tab is backgrounded.
  await page.evaluate(() => document.dispatchEvent(new Event("freeze")));
  await host.drop();
  await page.evaluate(() => document.dispatchEvent(new Event("resume")));

  const before = host.connections;
  await expect.poll(() => host.connections, "the client must rejoin by itself").toBeGreaterThan(before);
  expect(host.prompts).toEqual([]);
});

test("HIST-12: a host-side restart does not fabricate or lose history", async ({ page }) => {
  const { host } = await openWithHost(page);
  await host.send({ t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 4 });
  for (const chunk of snapshot(4, 1)) await host.send(chunk);
  await expect.poll(async () => (await transcriptTexts(page)).length).toBe(4);

  // The host goes away and comes back with the same session.
  await host.drop();
  await expect.poll(() => host.connections).toBeGreaterThan(1);
  await host.send({ t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 4 });
  for (const chunk of snapshot(4, 1)) await host.send(chunk);
  await expect.poll(async () => (await transcriptTexts(page)).length).toBe(4);
});

test("HIST-13: a compaction summary is preserved, not silently dropped", async ({ page }) => {
  const { host } = await openWithHost(page);
  const summary = {
    type: "compaction",
    id: "comp-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:01Z",
    summary: "Earlier context was compacted here.",
  };
  await host.send({ t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 2 });
  await host.send({ t: "snapshot-chunk", entries: [summary, createUserMessageEntry("u-1", "after compaction", 2)], final: true });

  // Compaction must not make the conversation look empty, and must not vanish.
  await expect(page.getByText(EMPTY_COPY)).toBeHidden();
  expect((await transcriptTexts(page)).length).toBeGreaterThan(0);
});

test("HIST-14: a large, slow snapshot progresses without being failed on total duration", async ({ page }) => {
  const { host } = await openWithHost(page);
  await host.send({ t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 300 });
  const chunks = snapshot(300, 12);
  for (const [index, chunk] of chunks.entries()) {
    await host.send(chunk);
    if (index === 0) await expect(page.getByText(LOADING_COPY)).toBeVisible();
  }
  await expect(page.getByText(LOADING_COPY)).toBeHidden();
  /**
   * The claim is "the whole 300-entry history is there and readable", not "300 cards are
   * in the document". A windowed transcript mounts the rows near the reader, so counting
   * `.message-card` measures the window size, not the history — the previous assertion
   * would have failed for a correct build and passed for one that mounted everything and
   * dropped the rest.
   *
   * Two honest halves instead: the transcript DECLARES the full size, and a specific
   * early row can actually be read once the reader goes to it.
   */
  const declared = await page.evaluate(() => {
    const box = document.querySelector(".messages-scroll [aria-setsize]");
    return box === null ? null : Number(box.getAttribute("aria-setsize"));
  });
  expect(declared, "the transcript must declare the complete 300-entry history").toBe(300);
  expect((await transcriptTexts(page)).length, "at least the mounted window must be readable").toBeGreaterThan(0);
  /**
   * Read an early row through the path a reader would use.
   *
   * Writing `scrollTop = 0` here does not work any more: the view is holding the tail, so
   * the pin immediately restores the bottom and the assertion was watching a scroll that
   * the app correctly overruled (measured: the transcript still showed rows 267-299).
   * `revealRow` walks the document the way a reader does, which is the behaviour this test
   * is actually about — the history is complete and every part of it is reachable.
   */
  await revealRow(page, "prompt number 0", 60_000);
});

test("HIST-15: malformed entries do not take valid rows down with them", async ({ page }) => {
  const { host } = await openWithHost(page);
  await host.send({ t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 3 });
  await host.send({
    t: "snapshot-chunk",
    entries: [
      createUserMessageEntry("u-good-1", "good row one", 1),
      // An entry type this client has no shape for.
      { type: "something-new-from-a-later-omp", id: "x-1", parentId: null, timestamp: "2026-01-01T00:00:02Z", payload: { nested: true } },
      createAssistantMessageEntry("a-good-2", "good row two", 3),
    ],
    final: true,
  });

  // Settle first, for the same reason as HIST-04: the chunk is delivered
  // asynchronously, so an immediate read can see the pre-render window.
  await expect.poll(() => transcriptTexts(page).then((rows) => rows.length)).toBeGreaterThan(1);
  const texts = await transcriptTexts(page);
  expect(texts.some((text) => text.includes("good row one")), "a valid row must survive").toBe(true);
  expect(texts.some((text) => text.includes("good row two")), "a valid row must survive").toBe(true);
  await expect(page.getByText(EMPTY_COPY)).toBeHidden();
});
