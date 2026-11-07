import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  gotoApp,
  harnessFixture,
  installMockCollabHost,
  openSeededConversation,
  requireAppServer,
  welcomeFrame,
} from "./fixture.js";

/**
 * Round-50 redesign measurements: the numbers behind `report.md`.
 *
 * Six viewports, the geometry that the redesign claims to fix (header, composer,
 * status chrome, transcript viewport, horizontal padding, visible rows, overflow)
 * and the render cost of a long transcript. Every number is read from the live
 * DOM via `getBoundingClientRect`/`scrollHeight`/computed styles — never from an
 * image, because this lane must not read pixels.
 *
 * `ROUND50_OUT` decides where the JSON lands: `baseline` measuring the pre-change
 * bundle is done by checking out the parent commit, so the harness itself only
 * writes to whichever directory it is pointed at.
 */

const OUT = process.env.ROUND50_OUT ?? "measure";
const DIR = join(process.env.HOME ?? "/tmp", ".cache", "r50-web", OUT);

/** The six viewports the brief requires, smallest first. */
const VIEWPORTS = [
  { name: "320x568", width: 320, height: 568 },
  { name: "375x667", width: 375, height: 667 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1440x900", width: 1440, height: 900 },
] as const;

interface Geometry {
  headerHeight: number;
  headerStatusVisible: boolean;
  composerHeight: number;
  composerTop: number;
  persistentStatusHeight: number;
  transcriptViewportHeight: number;
  transcriptScrollHeight: number;
  horizontalPadding: number;
  visibleMessageRows: number;
  visibleActivityGroups: number;
  documentScrollWidth: number;
  clientWidth: number;
  largestOverflow: number;
  minTouchTarget: number;
  domCharacterCount: number;
}

/** Measure the conversation screen's real geometry. */
async function measure(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const rect = (selector: string): DOMRect | null => {
      const element = document.querySelector(selector);
      return element === null ? null : element.getBoundingClientRect();
    };
    const scroller = document.querySelector(".messages-scroll") as HTMLElement | null;
    const content = document.querySelector(".messages-content") as HTMLElement | null;
    const header = rect(".app-header");
    const composer = rect(".composer-container");
    const banner = rect(".banner");
    const transcript = rect(".messages-scroll");

    // "Useful rows visible" counts rows with real content in the viewport, not
    // merely mounted ones (a virtualized or scrolled-away row does not count).
    const viewport = { top: 0, bottom: window.innerHeight };
    const visible = (element: Element): boolean => {
      const box = element.getBoundingClientRect();
      return box.height > 0 && box.bottom > viewport.top && box.top < viewport.bottom;
    };
    const messageRows = [...document.querySelectorAll(".message-card")].filter(visible).length;
    const activityGroups = [...document.querySelectorAll(".activity-group, .tool-row")].filter(visible).length;

    // Largest content overflow: the widest child minus the scroller's own width.
    let largestOverflow = 0;
    if (content !== null) {
      const scrollerWidth = scroller === null ? window.innerWidth : scroller.clientWidth;
      for (const child of Array.from(content.children)) {
        const box = child.getBoundingClientRect();
        largestOverflow = Math.max(largestOverflow, Math.round(box.width - scrollerWidth));
      }
    }

    // Smallest interactive target height, the touch-target claim.
    let minTouchTarget = Number.POSITIVE_INFINITY;
    for (const element of Array.from(document.querySelectorAll("button, a[href], textarea, select, summary"))) {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (box.width === 0 && box.height === 0) continue;
      if (style.visibility === "hidden" || style.display === "none") continue;
      minTouchTarget = Math.min(minTouchTarget, Math.round(box.height * 10) / 10);
    }

    const messagesContent = document.querySelector(".messages-content");
    const paddingProbe = scroller === null ? null : getComputedStyle(scroller);
    return {
      headerHeight: header === null ? 0 : Math.round(header.height * 10) / 10,
      headerStatusVisible: rect(".header-status") !== null,
      composerHeight: composer === null ? 0 : Math.round(composer.height * 10) / 10,
      composerTop: composer === null ? 0 : Math.round(composer.top * 10) / 10,
      persistentStatusHeight: banner === null ? 0 : Math.round(banner.height * 10) / 10,
      transcriptViewportHeight: transcript === null ? 0 : Math.round(transcript.height * 10) / 10,
      transcriptScrollHeight: scroller === null ? 0 : scroller.scrollHeight,
      horizontalPadding: paddingProbe === null ? 0 : Number.parseFloat(paddingProbe.paddingLeft) + Number.parseFloat(paddingProbe.paddingRight),
      visibleMessageRows: messageRows,
      visibleActivityGroups: activityGroups,
      documentScrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      largestOverflow,
      minTouchTarget: Number.isFinite(minTouchTarget) ? minTouchTarget : 0,
      domCharacterCount: messagesContent === null ? 0 : messagesContent.textContent!.length,
    };
  });
}

/** A tool result carrying a real per-file diff, the shape the UI must summarize. */
function editEntry(id: string, timestamp: number) {
  const diff = [
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1,4 +1,6 @@",
    " export function login(user: string) {",
    "-  return check(user);",
    "+  const token = check(user);",
    "+  return token;",
    " }",
  ].join("\n");
  return {
    t: "entry",
    entry: {
      id,
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `call-${id}`,
        toolName: "edit",
        content: [{ type: "text", text: "Edited src/auth.ts" }],
        details: { path: "src/auth.ts", op: "edit", diff, perFileResults: [{ path: "src/auth.ts", op: "edit", diff }] },
        isError: false,
        timestamp,
      },
    },
  };
}

function readEntry(id: string, timestamp: number, path: string) {
  return {
    t: "entry",
    entry: {
      id,
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `call-${id}`,
        toolName: "read",
        content: [{ type: "text", text: `${path}\n\nconst x = 1;` }],
        details: { resolvedPath: path },
        isError: false,
        timestamp,
      },
    },
  };
}

function userEntry(id: string, timestamp: number, content: string) {
  return { t: "entry", entry: { id, type: "message", message: { role: "user", content, timestamp } } };
}

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("geometry at the six required viewports", async ({ page }) => {
  mkdirSync(DIR, { recursive: true });
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(true));
  await host.send(userEntry("m1", 1, "Please add a token check to login."));
  await host.send({ t: "entry", entry: { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "I will read the auth module first." }], model: "provider/model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }, stopReason: "stop", timestamp: 2 } } });
  for (let index = 0; index < 8; index++) await host.send(readEntry(`r${index}`, 10 + index, `src/module-${index}.ts`));
  await host.send(editEntry("e1", 30));

  const results: Record<string, Geometry> = {};
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect.poll(() => page.evaluate(() => document.documentElement.clientWidth)).toBe(viewport.width);
    results[viewport.name] = await measure(page);
    await page.screenshot({ path: join(DIR, `conversation-${viewport.name}.png`), fullPage: false });
  }

  // The claims the redesign makes, asserted rather than eyeballed. Baseline runs
  // measure the PRE-change bundle, where the redesigned header/status do not
  // exist yet, so the claims are expected to fail there: `ROUND50_RECORD_ONLY=1`
  // records the numbers and skips the claim loop instead of aborting before the
  // JSON is written.
  for (const [name, geometry] of process.env.ROUND50_RECORD_ONLY === "1" ? [] : Object.entries(results)) {
    expect(geometry.documentScrollWidth, `${name}: no horizontal page scroll`).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.largestOverflow, `${name}: content must not overflow the transcript`).toBeLessThanOrEqual(0);
    expect(geometry.composerTop + geometry.composerHeight, `${name}: composer inside the viewport`).toBeLessThanOrEqual(VIEWPORTS.find((v) => v.name === name)!.height);
    expect(geometry.headerHeight, `${name}: header stays compact`).toBeLessThan(90);
    expect(geometry.headerStatusVisible, `${name}: the status indicator is on screen`).toBe(true);
  }

  writeFileSync(join(DIR, "geometry.json"), JSON.stringify({ out: OUT, results }, null, 2));
  console.log(`[round50 ${OUT} geometry]`, JSON.stringify(results));
});

test("render cost of a 2000-row transcript with 50 tool calls", async ({ page }) => {
  mkdirSync(DIR, { recursive: true });
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send({ ...welcomeFrame(false), entryCount: 2000 });

  // 2000 history rows: 50 tool calls (each with a real diff) among plain rows.
  const entries: unknown[] = [];
  for (let index = 0; index < 2000; index++) {
    // `.entry`, not the whole frame: `snapshot-chunk` carries bare entries, and a
    // frame object there renders as nothing at all.
    if (index % 40 === 39) entries.push((index % 80 === 39 ? editEntry(`perf-edit-${index}`, index) : readEntry(`perf-read-${index}`, index, `src/perf-${index}.ts`)).entry);
    else entries.push(userEntry(`perf-${index}`, index, `Transcript row ${index}: ${"older content ".repeat(12)}`).entry);
  }
  // Chunked in 50s with each frame awaited in order: the mock seals and sends
  // synchronously, and the reducer replaces its snapshot at the welcome, so
  // firing all chunks at once races the reset (observed: zero rows mounted).
  for (let index = 0; index < entries.length; index += 50) {
    await host.send({ t: "snapshot-chunk", entries: entries.slice(index, index + 50), final: index + 50 >= entries.length });
  }
  // The transcript is windowed, so this asserts the WINDOW contract rather than the
  // old "every row is in the document" one. It is strictly stronger than the count
  // it replaces: a bounded mount alone would pass with an empty document, and a
  // complete document alone would pass without windowing. All three are required.
  //
  // It used to read `expect.poll(() => count()).toBeGreaterThan(100)` on
  // `.message-card, .activity-group`, which encoded the unwindowed list and started
  // failing at 16 mounted cards once the list began mounting a window.
  const ROWS = 2000;
  await expect.poll(() => page.locator(".message-card, .activity-group").count(), {
    message: "the tail window must mount the newest rows",
  }).toBeGreaterThan(2);

  const windowed = await page.evaluate(() => {
    const scroller = document.querySelector(".messages-scroll");
    const entries = Array.from(document.querySelectorAll(".transcript-entry"));
    const spacers = Array.from(document.querySelectorAll(".transcript-spacer"));
    // `aria-setsize` lives on the entry's real box, not the `display: contents` wrapper
    // (measured: ARIA on the unboxed wrapper never reached Chromium's AX tree).
    const setsizes = new Set(entries.map((entry) => (entry.firstElementChild ?? entry).getAttribute("aria-setsize")));
    // The role and the position are on the entry's real box, not the display:contents
    // wrapper (see `PERF-A11Y-01`).
    const positions = entries.map((entry) => Number((entry.firstElementChild ?? entry).getAttribute("aria-posinset")));
    const mountedHeight = entries.reduce((sum, entry) => {
      const box = (entry.firstElementChild ?? entry).getBoundingClientRect();
      return sum + box.height;
    }, 0);
    return {
      mountedEntries: entries.length,
      cards: document.querySelectorAll(".message-card, .activity-group").length,
      setsizes: Array.from(setsizes),
      spacerHeight: spacers.reduce((sum, spacer) => sum + spacer.getBoundingClientRect().height, 0),
      spacerCount: spacers.length,
      mountedHeight,
      scrollHeight: scroller?.scrollHeight ?? 0,
      childCount: document.querySelectorAll(".transcript-entries > *").length,
      minPosition: positions.length === 0 ? null : Math.min(...positions),
      maxPosition: positions.length === 0 ? null : Math.max(...positions),
    };
  });

  console.log(`[round50 ${OUT} windowed]`, JSON.stringify(windowed));
  // 1. Bounded: the DOM holds a window, not the history. 100 is the ceiling the
  //    overscan sweep picked (measured 214-315 ELEMENTS for 8,000 entries, of which
  //    the mounted rows are a fraction); 2000/10 catches a window that grew with
  //    the conversation without tripping on an expansion.
  expect(windowed.cards, `mounted cards (${String(windowed.cards)}) must be bounded`).toBeLessThan(100);
  expect(windowed.mountedEntries * 10, "the window must stay small against the history").toBeLessThan(ROWS);
  // 2. Declares the whole history: every mounted row's aria-setsize is the real total.
  expect(windowed.setsizes, "mounted rows must declare the full history size").toEqual([String(ROWS)]);
  // 3. The spacers cover the unmounted span, so the scroll range is the history's:
  //    spacers + mounted rows must account for the scroller's height, allowing for
  //    the 10px gap the entries wrapper puts between its children.
  const slack = windowed.childCount * 12 + 40;
  expect(windowed.spacerCount, "an unmounted span must be represented by a spacer").toBeGreaterThan(0);
  expect(
    Math.abs(windowed.spacerHeight + windowed.mountedHeight - windowed.scrollHeight),
    `spacers (${String(Math.round(windowed.spacerHeight))}) + mounted (${String(Math.round(windowed.mountedHeight))}) must cover the scroll height (${String(windowed.scrollHeight)})`,
  ).toBeLessThanOrEqual(slack);
  // The window is a contiguous run of the history, not a sample of it: a gap in the
  // middle would be a hole the reader could scroll into and see nothing.
  expect(windowed.maxPosition! - windowed.minPosition! + 1, "the mounted window must be contiguous").toBe(windowed.mountedEntries);

  const first = await measure(page);
  // Repeatable: settle, then measure three times and keep the spread.
  const samples: number[] = [];
  for (let index = 0; index < 3; index++) {
    await page.waitForTimeout(150);
    samples.push((await measure(page)).domCharacterCount);
  }
  // A windowed list mounts ~15 of 2,000 rows, and the 50 tool calls are one row in
  // every 40, so whether a group happens to be inside the window is luck. Scroll
  // until one is: the claim below is about how a group is rendered, not about where
  // the window landed.
  for (let attempt = 0; attempt < 80; attempt++) {
    const found = await page.locator(".activity-group").count();
    if (found > 0) break;
    await page.evaluate((fraction) => {
      const scroller = document.querySelector(".messages-scroll");
      if (scroller !== null) scroller.scrollTop = Math.round(scroller.scrollHeight * fraction);
    }, (attempt + 1) / 80);
    await page.waitForTimeout(60);
  }
  await expect(page.locator(".activity-group"), "a tool group must be reachable in the history").not.toHaveCount(0);
  // The claim, measured directly instead of via a character budget that the plain
  // rows alone would blow: no collapsed tool body is mounted at all.
  const mounted = await page.evaluate(() => ({
    rawOutputs: document.querySelectorAll(".tool-raw-output").length,
    cards: document.querySelectorAll(".tv-card").length,
    diffs: document.querySelectorAll(".tv-diff").length,
    toolRows: document.querySelectorAll(".tool-row").length,
    activityGroups: document.querySelectorAll(".activity-group").length,
    messageCards: document.querySelectorAll(".message-card").length,
  }));
  const payload = { out: OUT, rows: 2000, toolCalls: 50, first, mounted, domCharacterSamples: samples };
  writeFileSync(join(DIR, "performance.json"), JSON.stringify(payload, null, 2));
  await page.screenshot({ path: join(DIR, "performance-2000.png") });
  console.log(`[round50 ${OUT} performance]`, JSON.stringify(payload));

  // 50 collapsed tool groups: not one body, diff, or raw output may be mounted.
  // Record-only mode (baseline) still captures `mounted` above; the claim that
  // grouping exists is redesign-specific and is skipped there.
  if (process.env.ROUND50_RECORD_ONLY !== "1") {
    expect(mounted.rawOutputs, "collapsed tool bodies must not be mounted").toBe(0);
    expect(mounted.cards, "guest card bodies must not be mounted").toBe(0);
    expect(mounted.diffs, "diffs must not be mounted while collapsed").toBe(0);
    expect(mounted.activityGroups, "the 50 tool calls form collapsed groups").toBeGreaterThan(0);
  }

  // 4. Reachability: the window is a rendering choice, never an information one. The
  //    whole history stays reachable by scrolling, which is the half of the old
  //    assertion that flipping `>` to `<` would have deleted.
  const reach = async (where: "top" | "middle" | "end"): Promise<{ visible: number[]; scrollTop: number }> => {
    /**
     * Scroll to a FRACTION OF THE RANGE and settle, rather than to `scrollHeight / 2`.
     *
     * With a windowed list, `scrollHeight / 2` is halfway through a document whose
     * unmounted span is made of ESTIMATES that are corrected as rows are measured. The
     * raw half-way pixel can therefore sit thousands of entries from the half-way
     * ENTRY — measured here as "the middle landed near entry 8" of 2,000 — while the
     * entries are perfectly reachable. Repeating the scroll as the document settles is
     * what asks the honest question: can the reader get to a middle entry.
     */
    await page.evaluate((target) => {
      const scroller = document.querySelector(".messages-scroll");
      if (scroller === null) return;
      const range = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = target === "top" ? 0 : target === "end" ? range : Math.round(range / 2);
    }, where);
    // One settle: the window re-renders from the new offset during the next frame, and a
    // jump to the end must be able to move once more after rows are measured.
    // Arrive, then WAIT for the window to actually show rows there before reading: a
    // single 250ms sleep raced the render, and the read then reported the previous
    // position's rows (measured: "middle landed near entry 5" while a direct probe of
    // the same fixture landed on 798-801 of 2,000).
    await expect.poll(() => page.evaluate(() => {
      const scroller = document.querySelector(".messages-scroll");
      const band = scroller?.getBoundingClientRect();
      if (scroller === null || band === undefined) return 0;
      let visible = 0;
      for (const entry of Array.from(document.querySelectorAll(".transcript-entry"))) {
        const box = (entry.firstElementChild ?? entry).getBoundingClientRect();
        if (box.bottom > band.top + 1 && box.top < band.bottom - 1) visible += 1;
      }
      return visible;
    }), { message: `rows must be painted after scrolling to the ${where}`, timeout: 10_000, intervals: [50, 100, 200] }).toBeGreaterThan(0);
    // The window is derived from the live offset during render, so one frame per
    // attempt is enough; poll anyway because the row measurement that follows a jump
    // can move the offsets under the reader once.
    //
    // Poll for STABILITY, not merely for "some rows are painted". A jump to the end
    // reports the previous window for one frame before the anchor correction lands:
    // measured at 100ms intervals after `scrollTop = scrollHeight`, the read was
    // `max 1999 of 2,000` on the first sample and `max 2000` from the second sample on,
    // stable for the following 11 samples. Reading on the first sample therefore
    // reported a one-frame-old window as a lost last entry. Two identical consecutive
    // samples mean the window has stopped moving, which is the state this reaches for.
    await expect.poll(async () => {
      const sample = (): Promise<{ max: number; min: number; count: number; top: number }> => page.evaluate(() => {
        const scroller = document.querySelector(".messages-scroll");
        const band = scroller?.getBoundingClientRect();
        const positions: number[] = [];
        for (const entry of Array.from(document.querySelectorAll(".transcript-entry"))) {
          const box = (entry.firstElementChild ?? entry).getBoundingClientRect();
          if (box.bottom > (band?.top ?? 0) + 1 && box.top < (band?.bottom ?? 0) - 1) positions.push(Number((entry.firstElementChild ?? entry).getAttribute("aria-posinset")));
        }
        return {
          max: positions.length === 0 ? 0 : Math.max(...positions),
          min: positions.length === 0 ? 0 : Math.min(...positions),
          count: positions.length,
          top: Math.round(scroller?.scrollTop ?? 0),
        };
      });
      const first = await sample();
      await page.waitForTimeout(100);
      const second = await sample();
      return first.max === second.max && first.min === second.min && first.count === second.count && first.top === second.top;
    }, { message: `the window at the ${where} must stop moving before it is read`, timeout: 15_000, intervals: [50, 100, 200] }).toBe(true);
    const seen = await page.evaluate(() => {
      const scroller = document.querySelector(".messages-scroll");
      const band = scroller?.getBoundingClientRect();
      const visible: number[] = [];
      for (const entry of Array.from(document.querySelectorAll(".transcript-entry"))) {
        const box = (entry.firstElementChild ?? entry).getBoundingClientRect();
        if (box.bottom > (band?.top ?? 0) + 1 && box.top < (band?.bottom ?? 0) - 1) visible.push(Number((entry.firstElementChild ?? entry).getAttribute("aria-posinset")));
      }
      return { visible, scrollTop: Math.round(scroller?.scrollTop ?? 0) };
    });
    return seen;
  };

  const top = await reach("top");
  expect(top.scrollTop, "the top of the history must be scrollable to").toBeLessThan(2);
  expect(Math.min(...top.visible), "the FIRST entry must be reachable and painted").toBe(1);
  const middle = await reach("middle");
  console.log(`[round50 middle] ` + JSON.stringify(await page.evaluate(() => {
    const scroller = document.querySelector(".messages-scroll");
    return { top: scroller === null ? null : Math.round(scroller.scrollTop), entriesReported: document.querySelectorAll("[aria-setsize]").length, setsize: document.querySelector("[aria-setsize]")?.getAttribute("aria-setsize"), h: scroller?.scrollHeight, c: scroller?.clientHeight, spacers: Array.from(document.querySelectorAll(".transcript-spacer")).map((n) => Math.round(n.getBoundingClientRect().height)), mounted: document.querySelectorAll(".transcript-entry").length };
  })), JSON.stringify(await page.evaluate(() => {
    const el = document.querySelector(".transcript-entries");
    return { gap: el === null ? null : getComputedStyle(el).rowGap, kids: el?.children.length };
  })));
  const middleRank = middle.visible.length === 0 ? 0 : middle.visible[Math.floor(middle.visible.length / 2)]!;
  expect(middleRank, `scrolling to the middle must land near entry ${String(ROWS / 2)}, saw ${String(middleRank)}`).toBeGreaterThan(ROWS * 0.3);
  expect(middleRank, `scrolling to the middle must land near entry ${String(ROWS / 2)}, saw ${String(middleRank)}`).toBeLessThan(ROWS * 0.7);
  const end = await reach("end");
  expect(Math.max(...end.visible), "the LAST entry must be reachable and painted").toBe(ROWS);
  console.log(`[round50 ${OUT} reach]`, JSON.stringify({ windowed, top: top.visible.slice(0, 3), middle: middle.visible.slice(0, 3), end: end.visible.slice(-3) }));
});

test("a group expands, a diff opens, and the draft survives the round trip", async ({ page }) => {
  mkdirSync(DIR, { recursive: true });
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await host.send(userEntry("g1", 1, "Edit the auth module."));
  for (let index = 0; index < 3; index++) await host.send(readEntry(`g-read-${index}`, 2 + index, `src/read-${index}.ts`));
  await host.send(editEntry("g-edit", 9));

  const composer = page.getByRole("textbox", { name: /Send a follow-up…|Turn in flight — send a follow-up…|Read-only/ });
  await composer.fill("unsent draft that must survive");

  const groups = page.locator(".activity-group");
  await expect(groups.first()).toBeVisible();
  const labels = await groups.evaluateAll((elements) => elements.map((element) => element.textContent));
  console.log("[round50 groups]", JSON.stringify(labels));

  await page.screenshot({ path: join(DIR, "grouped-collapsed.png") });
  await groups.first().getByRole("button").click();
  await expect(page.locator(".tool-row").first()).toBeVisible();
  await page.screenshot({ path: join(DIR, "grouped-expanded.png") });

  // Open the edit group, then the edit row. The edit body is a FLAT list of file
  // rows whose patch lives in the dedicated viewer, so no diff is mounted in the
  // conversation at all — the file row itself is the level-one control.
  const editGroup = page.locator(".activity-group").filter({ hasText: "Edit" });
  await editGroup.getByRole("button").first().click();
  const editRow = editGroup.locator(".tool-row").first();
  await expect(editRow).toBeVisible();
  await editRow.locator(".tool-row-head").click();
  // Level one: filename, directory, counts. No nested disclosure, no patch.
  const fileRow = editRow.locator(".tv-file-change").first();
  await expect(fileRow).toBeVisible();
  await expect(fileRow.locator(".tv-file-name")).toHaveText("auth.ts");
  await expect(editRow.locator(".tv-diff")).toHaveCount(0);
  await expect(editRow.locator(".tv-diff-row")).toHaveCount(0);
  await page.screenshot({ path: join(DIR, "diff-open.png") });

  const counts = await editRow.locator(".tv-file-counts").first().textContent();
  console.log("[round50 diff counts]", counts);
  expect(counts).toContain("+2");
  expect(counts).toContain("−1");

  // The collapsed group head carries the same verified counts, so the +/− is
  // readable without opening anything, and it matches the per-file row exactly.
  const groupCounts = await editGroup.locator(".activity-group-counts").textContent();
  console.log("[round50 group counts]", groupCounts);
  expect(groupCounts!.replace(/\s+/g, "")).toBe(counts!.replace(/\s+/g, ""));

  // Draft preserved across the whole interaction.
  await expect(composer).toHaveValue("unsent draft that must survive");
  writeFileSync(join(DIR, "diff-counts.json"), JSON.stringify({ labels, counts }));
});

test("all six viewports reject horizontal overflow with a long diff open", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await host.send(editEntry("wide-edit", 1));
  const group = page.locator(".activity-group").first();
  await group.getByRole("button").click();
  const editRow = page.locator(".tool-row").first();
  await editRow.locator(".tool-row-head").click();

  const results: Record<string, { overflow: number; clientWidth: number; scrollWidth: number }> = {};
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    results[viewport.name] = await page.evaluate(() => ({
      overflow: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(results[viewport.name]!.overflow, `${viewport.name}: page must not scroll sideways`).toBeLessThanOrEqual(1);
  }
  writeFileSync(join(DIR, "diff-overflow.json"), JSON.stringify(results, null, 2));
  console.log("[round50 diff overflow]", JSON.stringify(results));
});

test("login screen is reachable (harness sanity, keeps the fixture honest)", async ({ page }) => {
  await gotoApp(page);
  await expect(page.getByRole("textbox", { name: /password/i })).toBeVisible();
});
