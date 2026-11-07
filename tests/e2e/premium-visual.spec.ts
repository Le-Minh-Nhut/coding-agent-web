import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createAssistantMessageEntry,
  createToolResultEntry,
  createUserMessageEntry,
  harnessFixture,
  installMockCollabHost,
  openSeededConversation,
  requireAppServer,
  MOCK_APPROVAL_REQUEST,
  MOCK_SUBAGENTS,
  welcomeFrame,
  type MockCollabHost,
} from "./fixture.js";

/**
 * Round 58 — the premium chrome layer, measured.
 *
 * What this file is for
 * ---------------------
 * `docs/audits/PREMIUM_DESIGN_SPEC.md` states the geometry and the contrast the
 * redesign claims. This spec asserts the parts a test can hold: no horizontal
 * overflow, no overlapping controls, every control at least 44x44, the header
 * within its 56px budget at all four phone widths (asserted at 54, the design
 * being 53), and every text token above
 * 4.5:1 against the surface it is actually painted on (contrast is computed here
 * from the browser's own computed colours, not read off a screenshot).
 *
 * Scope, deliberately
 * -------------------
 * This lane may not read pixels (AGENTS.md rule 11 is about the main agent, but
 * the same discipline keeps a visual claim out of a numeric gate): the PNGs are
 * written to `docs/audits/assets/round58/` for human review, and every assertion
 * below is a DOM/computed-style number. The running-state matrix — which states
 * must stay legible — is enumerated as `STATES` and each one is captured.
 *
 * The tool-activity cards are NOT asserted here. They are another workstream's
 * surface; this spec only checks that the chrome does not overlap or clip them.
 */

const OUT = join(process.env.HOME ?? "/tmp", ".cache", "r58-web");

/**
 * Where the reviewed captures land. `CAW_SCREENS_DIR` lets the runner point this
 * at `docs/audits/assets/round58/` without the spec knowing the repo layout.
 */
const CAPTURE_DIR = process.env.CAW_SCREENS_DIR ?? OUT;
mkdirSync(CAPTURE_DIR, { recursive: true });

/** The four phone widths the brief names. */
const VIEWPORTS = [
  { name: "320x568", width: 320, height: 568 },
  { name: "375x667", width: 375, height: 667 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
] as const;

/**
 * Every text token the chrome paints, with the surface it is painted on.
 *
 * The pairs are the ones the spec's token table states, and the surface is the
 * *real* one: `--text-muted` on the composer field is checked against the field's
 * own `--field-bg`, not against the canvas, because that is where a reader meets
 * it. The floor is WCAG AA for normal text (4.5:1).
 */
const CONTRAST_PAIRS: Array<{ fg: string; bg: string; where: string }> = [
  { fg: "--text-primary", bg: "--chrome-bg", where: "title / assistant prose on the canvas" },
  { fg: "--text-secondary", bg: "--chrome-bg", where: "neutral banner text on the canvas" },
  { fg: "--text-muted", bg: "--chrome-bg", where: "status word, info notice on the canvas" },
  { fg: "--text-muted", bg: "--field-bg", where: "composer placeholder in the field" },
  { fg: "--text-primary", bg: "--field-bg", where: "composer value in the field" },
  { fg: "--text-primary", bg: "--surface-secondary", where: "user bubble / dashboard card" },
  { fg: "--text-muted", bg: "--surface-secondary", where: "dashboard sub-line" },
  { fg: "--text-secondary", bg: "--surface-elevated", where: "overflow sheet rows" },
  { fg: "--warning", bg: "--chrome-bg", where: "warning banner text" },
  { fg: "--danger-text", bg: "--chrome-bg", where: "danger banner text" },
  { fg: "--success", bg: "--chrome-bg", where: "success/running banner text" },
];

/** Resolve a token to rgb, through a scratch element so `color-mix`/oklab resolve. */
async function resolveToken(page: Page, name: string): Promise<string> {
  return page.evaluate((token) => {
    const probe = document.createElement("div");
    probe.style.color = `var(${token})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

/** WCAG 2.1 relative luminance of an `rgb()`/`rgba()` string. */
function luminance(rgb: string): number {
  const [r, g, b] = rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The chrome this spec owns, as one selector.
 *
 * Deliberately NOT `document.querySelectorAll("button")`: the transcript contains
 * the vendored guest renderer's own controls, which are another workstream's
 * surface and are being restyled in the same round. A gate that fails on a control
 * this change did not touch is a gate nobody can act on, and it would have to be
 * weakened later — which this spec must never do.
 */
const CHROME = ".app-header, .dashboard-row, .composer-container, .notice-row, .conversation-screen > .banner, .recovery-summary, .latest-row, .handoff-reason";

interface ChromeGeometry {
  viewport: string;
  headerHeight: number;
  headerOverflow: number;
  documentOverflow: number;
  dashboardRowHeight: number;
  cardHeights: number[];
  cardColumns: number;
  composerBottom: number;
  transcriptHeight: number;
  undersizedControls: Array<{ label: string; width: number; height: number }>;
  overlappingControls: Array<{ a: string; b: string }>;
  composerOverlapsTranscript: boolean;
}

/** Measure the chrome, with the overlays it must not collide with while open. */
async function readGeometry(page: Page, viewport: string): Promise<ChromeGeometry> {
  return page.evaluate(({ name, chrome }) => {
    const round = (value: number): number => Math.round(value * 10) / 10;
    const header = document.querySelector<HTMLElement>(".app-header");
    const dashboard = document.querySelector<HTMLElement>(".dashboard-row");
    const composer = document.querySelector<HTMLElement>(".composer-container");
    const transcript = document.querySelector<HTMLElement>(".messages-scroll");

    const nameOf = (element: Element): string =>
      element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40) ?? element.tagName;

    // Every control the user can act on inside the chrome this spec owns,
    // excluding the ones inside a closed disclosure (they are not laid out, so
    // they are not reachable either).
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(`${chrome} button, ${chrome} a[href], ${chrome} textarea, ${chrome} select, ${chrome} summary`),
    ).filter((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });

    const undersized = controls
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width < 43.9 || box.height < 43.9)
      .map(({ element, box }) => ({ label: nameOf(element), width: round(box.width), height: round(box.height) }));

    // Pairwise overlap among laid-out controls. O(n^2) deliberately: the count is
    // a few dozen and an interval tree would be the more complex thing to be wrong.
    const boxes = controls.map((element) => ({ element, box: element.getBoundingClientRect() }));
    const overlapping: Array<{ a: string; b: string }> = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
        const overlapX = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
        const overlapY = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
        if (overlapX > 1 && overlapY > 1) overlapping.push({ a: nameOf(a.element), b: nameOf(b.element) });
      }
    }

    const cards = Array.from(document.querySelectorAll<HTMLElement>(".dashboard-card"));
    const composerBox = composer?.getBoundingClientRect() ?? null;
    const transcriptBox = transcript?.getBoundingClientRect() ?? null;

    return {
      viewport: name,
      headerHeight: round(header?.getBoundingClientRect().height ?? 0),
      headerOverflow: (header?.scrollWidth ?? 0) - (header?.clientWidth ?? 0),
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dashboardRowHeight: round(dashboard?.getBoundingClientRect().height ?? 0),
      cardHeights: cards.map((card) => round(card.getBoundingClientRect().height)),
      cardColumns: dashboard === null ? 0 : getComputedStyle(dashboard).gridTemplateColumns.split(" ").length,
      composerBottom: round(composerBox === null ? 0 : composerBox.bottom),
      transcriptHeight: round(transcriptBox?.height ?? 0),
      undersizedControls: undersized,
      overlappingControls: overlapping,
      composerOverlapsTranscript:
        composerBox !== null && transcriptBox !== null && composerBox.top < transcriptBox.bottom - 1,
    };
  }, { name: viewport, chrome: CHROME });
}

/** The running-state matrix: each state is reached on a fresh page, then captured. */
const STATES = [
  "idle",
  "streaming",
  "tool-running",
  "approval",
  "connection-lost",
  // The two surfaces the windowing change added. Captured as states like any other
  // because "does it look designed" is only answerable from a picture, and neither
  // existed when the round-57 baseline was shot.
  "search",
  "subagents",
] as const;
type StateName = (typeof STATES)[number];

/** A transcript with real history, so density is judged against a real session. */
async function seedHistory(host: MockCollabHost, entries = 12): Promise<void> {
  const history: unknown[] = [];
  for (let index = 0; index < entries; index += 1) {
    const at = 1_700_000_000_000 + index;
    if (index % 3 === 0) history.push(createUserMessageEntry(`h-u-${index}`, `Follow-up ${index}: check the lease probe and the ownership path.`, at));
    else if (index % 3 === 1) history.push(createAssistantMessageEntry(`h-a-${index}`, `Reading the supervisor and the adapter for step ${index}. The probe reads the pane pid before deciding ownership, so an unreachable socket is not treated as an exit.`, at));
    else history.push(createToolResultEntry(`h-t-${index}`, `h-call-${index}`, "bash", `$ pnpm -r typecheck\nDone in ${index}.4s`, false, at));
  }
  await host.send({ t: "welcome", proto: 3, header: { sessionId: "e2e-session", cwd: "/tmp", timestamp: null, version: 1, title: "Refactor the auth layer" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/tmp", participants: [] }, agents: [], entryCount: entries + 4 });
  await host.send({ t: "snapshot-chunk", entries: history, final: true });
}

/** Drive one state of the matrix. Each returns the frame that makes it true. */
async function driveState(page: Page, host: MockCollabHost, state: StateName): Promise<void> {
  await openSeededConversation(page);
  await seedHistory(host);
  switch (state) {
    case "idle":
      // Nothing more: the welcome frame already says `isStreaming: false`.
      break;
    case "streaming":
      await host.send({ t: "event", event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "The lease probe reads the pane pid before deciding ownership, which is why an unreachable socket is not treated as an exit. Next I will verify the corroboration step." }], stopReason: null } } });
      // The header's own running state, so `Stop generating` is on screen.
      await host.send({ t: "state", state: { isStreaming: true, queuedMessageCount: 0, cwd: "/tmp", participants: [] } });
      break;
    case "tool-running":
      await host.send({ t: "event", event: { type: "tool_execution_start", toolCallId: "call-live-1", toolName: "bash", args: { command: "pnpm -r typecheck" } } });
      await host.send({ t: "event", event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Running the full typecheck across the workspace before I touch the probe." }], stopReason: null } } });
      await host.send({ t: "state", state: { isStreaming: true, queuedMessageCount: 0, cwd: "/tmp", participants: [] } });
      break;
    case "approval":
      await host.send({ t: "ui-request", request: MOCK_APPROVAL_REQUEST });
      // The card lives at the END of the transcript and the list follows the tail,
      // so this is also the assertion that the windowing change actually scrolled
      // it into view: without it the capture would silently be `streaming` again.
      const approval = page.getByRole("heading", { name: "Approval Requested" });
      await approval.waitFor({ state: "visible" });
      // "Visible" means it has a box, not that it is on screen: the transcript was
      // scrolled up, so the first pass captured the approval state while showing
      // rows above it. A capture that does not contain the state it is named for is
      // a misleading artefact, so the card is brought into view before the shutter.
      await approval.scrollIntoViewIfNeeded();
      await expect(approval).toBeInViewport();
      break;
    case "search":
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("button", { name: "Search transcript" }).click();
      await page.locator(".transcript-search input").fill("lease probe");
      await page.locator(".transcript-search-count").waitFor({ state: "visible" });
      break;
    case "subagents":
      await host.send({ t: "agents", agents: MOCK_SUBAGENTS });
      await page.locator(".subagent-row").waitFor({ state: "visible" });
      break;
    case "connection-lost":
      await host.send({ t: "ui-request", request: MOCK_APPROVAL_REQUEST });
      await host.send({ t: "ui-request-end", reqId: 101 });
      await host.drop();
      // Both facts this state is named for must be true before the shutter opens.
      await page.locator(".banner.reconnecting, .banner.disconnected").first().waitFor({ state: "visible" });
      break;
  }
}

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("the chrome holds its geometry at all four phone widths, in every running state", async ({ browser }) => {
  const fixture = harnessFixture();
  const results: Array<{ state: StateName; geometry: ChromeGeometry }> = [];

  for (const state of STATES) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
      await driveState(page, host, state);
      // Wait for the transcript to be laid out before measuring: every state above
      // produces at least one visible row, and a measurement taken before the
      // first paint reads zero-height boxes.
      await page.locator(".messages-scroll .message-card").first().waitFor({ state: "visible", timeout: 15_000 });

      const geometry = await readGeometry(page, viewport.name);
      results.push({ state, geometry });
      console.log(`R58_CHROME ${JSON.stringify({ state, ...geometry })}`);
      await page.screenshot({ path: join(CAPTURE_DIR, `${state}-${viewport.name}.png`) });
      await context.close();
    }
  }

  // The invariant, asserted on every state at every width.
  for (const { state, geometry } of results) {
    const at = `${state}/${geometry.viewport}`;
    expect(geometry.documentOverflow, `${at}: no horizontal document overflow`).toBeLessThanOrEqual(1);
    expect(geometry.headerOverflow, `${at}: the header must not overflow`).toBeLessThanOrEqual(1);
    expect(geometry.transcriptHeight, `${at}: the transcript keeps a real viewport`).toBeGreaterThan(100);
    expect(geometry.undersizedControls, `${at}: every control clears 44x44`).toEqual([]);
    expect(geometry.overlappingControls, `${at}: controls must not overlap`).toEqual([]);
    expect(geometry.composerOverlapsTranscript, `${at}: the composer must not cover the transcript`).toBe(false);
    expect(geometry.composerBottom, `${at}: the composer stays inside the viewport`).toBeLessThanOrEqual(
      VIEWPORTS.find((entry) => entry.name === geometry.viewport)!.height + 1,
    );

    // The header budget. The brief's ceiling is 56 css px; the built rule is
    // 44px controls + 2x4px padding + the 1px hairline = 53, so this asserts the
    // design at 54 rather than the ceiling - a regression fails here instead of
    // surviving up to the limit. A running state adds Stop to the same row and must
    // not grow it. (Playwright has no safe-area inset; a notched phone adds its own
    // inset on top by design.)
    expect(geometry.headerHeight, `${at}: header chrome <= 54px (design 53)`).toBeLessThanOrEqual(54);

    // The dashboard row: three bounded columns, each a 44px card, so the row is
    // 44 + its 8px gutter. It may not grow with a longer label or a second line.
    expect(geometry.cardColumns, `${at}: three bounded navigation columns`).toBe(3);
    for (const height of geometry.cardHeights) expect(height, `${at}: each card is one bounded row`).toBeLessThanOrEqual(46);
    expect(geometry.dashboardRowHeight, `${at}: the dashboard row stays compact`).toBeLessThanOrEqual(54);
  }
});

test("every chrome text token clears 4.5:1 on the surface it is painted on", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await seedHistory(host);

  const measured: Array<{ pair: string; ratio: number }> = [];
  for (const pair of CONTRAST_PAIRS) {
    const fg = await resolveToken(page, pair.fg);
    const bg = await resolveToken(page, pair.bg);
    const ratio = Math.round(contrast(fg, bg) * 100) / 100;
    measured.push({ pair: `${pair.fg} on ${pair.bg}`, ratio });
    console.log(`R58_CONTRAST ${pair.fg} on ${pair.bg} (${pair.where}) = ${ratio}:1`);
    expect(ratio, `${pair.fg} on ${pair.bg} — ${pair.where}`).toBeGreaterThanOrEqual(4.5);
  }
  // The table is non-empty and every entry was measured; a silent skip of the loop
  // would otherwise make this test pass with nothing to report.
  expect(measured).toHaveLength(CONTRAST_PAIRS.length);
});

/**
 * The same claim, but read off the elements themselves rather than a token table.
 *
 * `color-mix()` is opaque to a static table: what a banner actually paints is a
 * tint over the canvas, and only the browser knows the result. This walks the
 * laid-out text-bearing chrome (banners, notice text, cards, the composer field,
 * the status line) and checks each element's own computed foreground against its
 * own computed background, compositing any alpha over its nearest opaque ancestor.
 */
test("the laid-out chrome meets 4.5:1 against its own painted background", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await seedHistory(host);
  // One state per colour role, so every tint that ships is actually painted.
  await host.send({ t: "event", event: { type: "notice", level: "warning", message: "Host reports a starting worker." } });
  await host.send({ t: "ui-request", request: MOCK_APPROVAL_REQUEST });
  await expect(page.locator(".notice-row--warning")).toBeVisible();

  const rows = await page.evaluate(() => {
    /* `getComputedStyle` returns `color-mix()` results in `oklab(...)`, and every
       hand-written parser of that is a parser that will be wrong. Painting the value
       into a 1x1 canvas and reading the pixel back makes the *browser* resolve whatever
       colour syntax it just produced, in sRGB, with alpha. That is the only conversion
       this test needs to trust. */
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const parse = (value: string): { rgb: [number, number, number]; a: number } => {
      if (context === null) throw new Error("2d context unavailable");
      context.clearRect(0, 0, 1, 1);
      // Invalid syntax leaves fillStyle untouched, so black is the honest fallback:
      // an unparseable layer then paints as opaque black and the test fails loudly
      // rather than silently passing on a skipped layer.
      context.fillStyle = "#000";
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
      return { rgb: [r ?? 0, g ?? 0, b ?? 0], a: (alpha ?? 255) / 255 };
    };
    /** Composite an element's own background over every ancestor's, outermost first. */
    const flatten = (element: HTMLElement): [number, number, number] => {
      const layers: string[] = [];
      for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
        layers.push(getComputedStyle(node).backgroundColor);
      }
      let acc: [number, number, number] = [0, 0, 0];
      // Reverse order: each layer lands on what is actually behind it, so a
      // semi-transparent tint resolves against the canvas rather than against an
      // assumed black.
      for (const layer of layers.reverse()) {
        const { rgb, a } = parse(layer);
        if (a === 0) continue;
        acc = [rgb[0] * a + acc[0] * (1 - a), rgb[1] * a + acc[1] * (1 - a), rgb[2] * a + acc[2] * (1 - a)];
      }
      return acc;
    };
    const toCss = ([r, g, b]: [number, number, number]): string => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;

    const SELECTORS = [
      ".app-header .conversation-header-copy h3",
      ".header-status",
      "button.dashboard-card .dashboard-value",
      "button.dashboard-card .dashboard-sub",
      ".notice-row--warning .notice-text",
      ".notice-row--info .notice-text",
      ".conversation-screen .banner",
      ".message-card.user .message-content",
      ".message-card.assistant .message-content",
      "textarea.composer-input",
    ];
    const out: Array<{ selector: string; text: string; fg: string; bg: string }> = [];
    for (const selector of SELECTORS) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      // Resolve the ink through the same canvas: `color-mix()` produces `oklab(...)`,
      // which no string parser in this file should try to decode.
      const ink = parse(getComputedStyle(element).color).rgb;
      out.push({
        selector,
        text: (element.textContent ?? "").trim().slice(0, 30),
        fg: toCss(ink),
        bg: toCss(flatten(element)),
      });
    }
    return out;
  });

  // Non-vacuous: the list must cover the chrome this test claims to check.
  expect(rows.length, "the laid-out chrome was found").toBeGreaterThanOrEqual(8);
  for (const row of rows) {
    const ratio = Math.round(contrast(row.fg, row.bg) * 100) / 100;
    console.log(`R58_PAINTED ${row.selector} "${row.text}" ${row.fg} on ${row.bg} = ${ratio}:1`);
    expect(ratio, `${row.selector} ("${row.text}") must clear 4.5:1 on ${row.bg}`).toBeGreaterThanOrEqual(4.5);
  }
});

test("the notice rows keep their level roles and their full text after the restyle", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));

  /* `transcript.notice` is ONE slot (`ConversationView.tsx:3122`), not a list: a new
     notice replaces the previous one. So each level has to be measured while it is
     on screen, and the helper below is called immediately after the frame that
     paints it - batching the reads at the end would have measured the error row
     three times and reported "MISSING" for the others. */
  const readBanner = (level: "info" | "warning" | "error"): Promise<{ content: string; text: string; nodes: number }> =>
    page.evaluate((rowLevel) => {
      const el = document.querySelector<HTMLElement>(`.notice-row--${rowLevel} .notice-banner`);
      if (el === null) return { content: "MISSING", text: "", nodes: 0 };
      return {
        // Chromium resolves `"!" / ""` down to `"!"`, which is all this needs.
        content: getComputedStyle(el, "::before").content,
        text: el.textContent ?? "",
        nodes: el.childElementCount,
      };
    }, level);

  const long = `ROUND58_NOTICE_END joined the collab session ${"and said a great deal more ".repeat(40)}`;
  await host.send({ t: "event", event: { type: "notice", level: "info", message: long } });
  const info = page.locator(".notice-row--info");
  await expect(info).toBeVisible();
  // Clamped visually, never truncated from the DOM.
  await expect(info).toContainText("ROUND58_NOTICE_END");
  const infoMark = await readBanner("info");

  await host.send({ t: "event", event: { type: "notice", level: "warning", message: "Collab ended: host gone" } });
  await expect(page.locator(".notice-row--warning [role='status']")).toHaveCount(1);
  const warningMark = await readBanner("warning");

  await host.send({ t: "event", event: { type: "notice", level: "error", message: "link failed" } });
  await expect(page.locator(".notice-row--error [role='alert']")).toHaveCount(1);
  const errorMark = await readBanner("error");

  // A warning and an error carry a mark as well as a hue, so the two are
  // distinguishable without colour; `info` carries none. The mark is CSS generated
  // content, so this asserts the paint AND that the row's text is still the host's
  // message alone - a real glyph node here would change `textContent`, which is the
  // regression `tests/web/mobile-reading-ux.test.tsx` caught.
  expect(warningMark.content, "warning carries a generated mark").toContain("!");
  expect(warningMark.text, "the mark is not in the text").toBe("Collab ended: host gone");
  expect(warningMark.nodes, "the mark must not be a DOM node").toBe(1);
  expect(errorMark.content, "error carries its own generated mark").toContain("✕");
  expect(errorMark.text, "the mark is not in the text").toBe("link failed");
  expect(errorMark.nodes, "the mark must not be a DOM node").toBe(1);
  expect(["none", "normal"], "info carries no mark").toContain(infoMark.content);
  expect(infoMark.text).toContain("ROUND58_NOTICE_END");
});
