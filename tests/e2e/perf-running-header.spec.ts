import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createAssistantMessageEntry,
  createToolResultEntry,
  createUserMessageEntry,
  harnessFixture,
  installMockCollabHost,
  openSeededConversation,
  requireAppServer,
  type MockCollabHost,
} from "./fixture.js";

/**
 * The running-state visual capture for the performance round.
 *
 * Deliberately a *running* turn, not an idle screen: every earlier redesign in this
 * project was judged on idle layouts, and the owner's complaint is about the app
 * while an agent is working. A screenshot of an idle conversation would not show
 * the header under generation, which is exactly the surface the brief calls out.
 *
 * The geometry assertions are read from the live DOM, never from the pixels — the
 * main agent must not read images (AGENTS.md rule 11), so this file records numbers
 * and leaves the images for a subagent to interpret.
 */

const OUT = join(process.env.HOME ?? "/tmp", ".cache", "r57-web");
mkdirSync(OUT, { recursive: true });

/** The four phone widths the brief names. */
const VIEWPORTS = [
  { name: "320x568", width: 320, height: 568 },
  { name: "375x667", width: 375, height: 667 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
] as const;

interface HeaderGeometry {
  viewport: string;
  headerHeight: number;
  stopVisible: boolean;
  stopBox: { width: number; height: number; x: number; y: number } | null;
  stopBackground: string | null;
  /** Alpha of the Stop control's background: 0 = invisible, 1 = solid fill. */
  stopAlpha: number;
  /** The composer's send control, measured rather than read off a screenshot. */
  sendBox: { width: number; height: number } | null;
  stopAccessibleName: string | null;
  menuBox: { width: number; height: number; x: number; y: number } | null;
  titleText: string;
  titleClipped: boolean;
  modelText: string | null;
  modelClipped: boolean;
  chipBox: { width: number; x: number } | null;
  /** The Stop control must not be reachable only under something else. */
  controlsOverlap: boolean;
  horizontalOverflow: boolean;
  /** Every interactive control in the header must clear the 44px target. */
  undersizedControls: Array<{ label: string; width: number; height: number }>;
}

/**
 * A live turn with a full viewport of history.
 *
 * The first version of this fixture seeded four entries, so every capture showed a
 * mostly-empty screen with 300-670 css px of dead space between the transcript and
 * the composer — a property of the fixture, not of the product, but it made the
 * captures useless for judging density. A real session has history behind the
 * current turn, so this seeds one.
 */
async function seedRunningTurn(host: MockCollabHost, entries = 30): Promise<void> {
  await host.send({
    t: "welcome",
    proto: 3,
    header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z", title: "Refactor the auth layer" },
    state: { isStreaming: true, queuedMessageCount: 0, cwd: "/workspace", participants: [] },
    agents: [],
    entryCount: entries + 4,
  });
  const history: unknown[] = [];
  for (let index = 0; index < entries; index += 1) {
    const at = 1_700_000_000_000 + index;
    switch (index % 3) {
      case 0:
        history.push(createUserMessageEntry(`h-u-${index}`, `Follow-up ${index}: check the lease probe and the ownership path.`, at));
        break;
      case 1:
        history.push(createAssistantMessageEntry(`h-a-${index}`, `Reading the supervisor and the adapter for step ${index}. The probe reads the pane pid before deciding ownership, so an unreachable socket is not treated as an exit.`, at));
        break;
      default:
        history.push(createToolResultEntry(`h-t-${index}`, `h-call-${index}`, "bash", `$ pnpm -r typecheck\nDone in ${index}.4s`, false, at));
    }
  }
  await host.send({
    t: "snapshot-chunk",
    entries: [
      ...history,
      createUserMessageEntry("u-1", "Audit the session lifecycle and fix the lease probe.", 1_700_000_999_000),
      createAssistantMessageEntry("a-1", "I'll start by reading the supervisor and the adapter.\n\n- `packages/runtime/src/supervisor.ts`\n- `packages/omp-adapter/src/tmux.ts`", 1_700_000_999_001),
      createToolResultEntry("t-1", "call-1", "read", "$ sed -n '470,520p' packages/runtime/src/supervisor.ts\n… 50 lines …", false, 1_700_000_999_002),
      createToolResultEntry("t-2", "call-2", "bash", "$ pnpm -r typecheck\nDone in 12.4s", false, 1_700_000_999_003),
    ],
    final: true,
  });
  // A streaming assistant message, so the header is in its generating state.
  await host.send({
    t: "event",
    event: {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The lease probe reads the pane pid before deciding ownership, which is why an unreachable socket is not treated as an exit. Next I'll verify the corroboration step against a live session and confirm the conflict path returns `conflict_owner` rather than launching a second writer." }],
        stopReason: null,
      },
    },
  });
}

async function readHeaderGeometry(page: Page, viewport: string): Promise<HeaderGeometry> {
  return page.evaluate((label) => {
    const box = (element: Element | null) => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) };
    };
    const header = document.querySelector("header") ?? document.querySelector(".conversation-header");
    const stop = document.querySelector<HTMLButtonElement>('button[aria-label="Stop generating"]');
    const menu = document.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
    const title = document.querySelector(".conversation-header-copy h3") ?? header?.querySelector("h3");
    const model = document.querySelector(".header-status-model");
    const chip = document.querySelector(".header-chips");
    const stopBox = box(stop);
    const menuBox = box(menu);
    const controlsOverlap = stopBox !== null && menuBox !== null
      ? stopBox.x + stopBox.width > menuBox.x && stopBox.y < menuBox.y + menuBox.height && menuBox.y < stopBox.y + stopBox.height
      : false;
    const undersized: Array<{ label: string; width: number; height: number }> = [];
    for (const control of Array.from(header?.querySelectorAll<HTMLElement>("button") ?? [])) {
      const rect = control.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44)) {
        undersized.push({ label: control.getAttribute("aria-label") ?? control.textContent?.trim().slice(0, 30) ?? "?", width: Math.round(rect.width), height: Math.round(rect.height) });
      }
    }
    return {
      viewport: label,
      headerHeight: Math.round(header?.getBoundingClientRect().height ?? 0),
      stopVisible: stop !== null && stop.getBoundingClientRect().width > 0,
      stopBox,
      stopBackground: stop === null ? null : getComputedStyle(stop).backgroundColor,
      stopAlpha: (() => {
        if (stop === null) return 1;
        const probe = document.createElement("div");
        probe.style.backgroundColor = getComputedStyle(stop).backgroundColor;
        document.body.appendChild(probe);
        const resolved = getComputedStyle(probe).backgroundColor;
        probe.remove();
        // Chromium keeps an oklab()/color-mix() value verbatim, so resolve it by
        // painting onto a scratch element is unreliable; parse whatever form we get.
        const slash = resolved.match(/\/\s*([\d.]+)\s*\)/);
        if (slash !== null) return Number(slash[1]);
        const rgba = resolved.match(/rgba?\([^)]*?,\s*([\d.]+)\s*\)$/);
        if (rgba !== null) return Number(rgba[1]);
        return resolved === "rgba(0, 0, 0, 0)" || resolved === "transparent" ? 0 : 1;
      })(),
      sendBox: (() => {
        const send = document.querySelector<HTMLElement>(".composer-send");
        if (send === null) return null;
        const rect = send.getBoundingClientRect();
        return { width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 };
      })(),
      stopAccessibleName: stop?.getAttribute("aria-label") ?? null,
      menuBox,
      titleText: title?.textContent?.trim() ?? "",
      titleClipped: title === null ? false : title.scrollWidth > title.clientWidth + 1,
      modelText: model?.textContent?.trim() ?? null,
      modelClipped: model === null ? false : (model as HTMLElement).scrollWidth > (model as HTMLElement).clientWidth + 1,
      chipBox: box(chip),
      controlsOverlap,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      undersizedControls: undersized,
    };
  }, viewport);
}

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("the running header at the four phone widths", async ({ browser }) => {
  const fixture = harnessFixture();
  const results: HeaderGeometry[] = [];
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
    await openSeededConversation(page);
    await seedRunningTurn(host);
    await page.locator('button[aria-label="Stop generating"]').waitFor({ state: "visible", timeout: 15_000 });
    const geometry = await readHeaderGeometry(page, viewport.name);
    results.push(geometry);
    console.log(`R57_HEADER ${JSON.stringify(geometry)}`);
    await page.screenshot({ path: join(OUT, `running-${viewport.name}.png`), fullPage: false });
    await context.close();
  }

  // The brief's responsive requirements, asserted on the numbers.
  for (const geometry of results) {
    expect(geometry.horizontalOverflow, `${geometry.viewport}: no horizontal overflow`).toBe(false);
    expect(geometry.stopVisible, `${geometry.viewport}: Stop must be visible during a turn`).toBe(true);
    expect(geometry.stopAccessibleName, `${geometry.viewport}: Stop must have its accessible name`).toBe("Stop generating");
    expect(geometry.controlsOverlap, `${geometry.viewport}: header controls must not overlap`).toBe(false);
    expect(geometry.undersizedControls, `${geometry.viewport}: every header control clears 44px`).toEqual([]);
    expect(geometry.titleText.length, `${geometry.viewport}: the title must remain readable`).toBeGreaterThan(0);
  }
  // And the "compact control, not a solid red block" requirement, at EVERY phone
  // width including 430 (iPhone Pro Max).
  //
  // The first version of this assertion demanded a fully transparent background and
  // then failed against the fix: a bare transparent box around a floating glyph read
  // as "a red chip" in the visual review, so the control gained a deliberate 18% tint.
  // Pinning the colour string would re-break on any intentional restyle; what must
  // hold is that the control is translucent and far from the solid fill the owner
  // photographed. Checked numerally, not by string.
  for (const geometry of results) {
    expect(geometry.stopBox?.width, `${geometry.viewport}: Stop must be the compact square, not the labelled pill`).toBe(44);
    expect(geometry.stopAlpha, `${geometry.viewport}: Stop must be tinted rather than invisible (alpha ${geometry.stopAlpha})`).toBeGreaterThan(0);
    expect(geometry.stopAlpha, `${geometry.viewport}: Stop must stay far below a solid fill (alpha ${geometry.stopAlpha})`).toBeLessThan(0.35);
  }
  // The composer's send control must clear the same minimum the header honours.
  // Measured exactly, because a visual review reported 43.5px — the 2x-DPR subpixel
  // of a genuine 44, which is not a defect and must not be "fixed".
  for (const geometry of results) {
    expect(geometry.sendBox, `${geometry.viewport}: the composer must expose a send control`).not.toBeNull();
    expect(Math.min(geometry.sendBox!.width, geometry.sendBox!.height), `${geometry.viewport}: send must be at least 44x44 (${JSON.stringify(geometry.sendBox)})`).toBeGreaterThanOrEqual(43.9);
  }
});

test("the idle conversation at the four phone widths", async ({ browser }) => {
  const fixture = harnessFixture();
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
    await openSeededConversation(page);
    await host.send({
      t: "welcome",
      proto: 3,
      header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" },
      state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] },
      agents: [],
      entryCount: 23,
    });
    await host.send({
      t: "snapshot-chunk",
      entries: [
        createUserMessageEntry("u-1", "Audit the session lifecycle and fix the lease probe.", 1_700_000_000_000),
        ...Array.from({ length: 20 }, (_, index) => index % 2 === 0
          ? createUserMessageEntry(`i-u-${index}`, `Follow-up ${index}: check the lease probe and the ownership path.`, 1_700_000_000_100 + index)
          : createAssistantMessageEntry(`i-a-${index}`, `Reading the supervisor and the adapter for step ${index}. The probe reads the pane pid before deciding ownership, so an unreachable socket is not treated as an exit.`, 1_700_000_000_100 + index)),
        createAssistantMessageEntry("a-1", "Reading the supervisor now.", 1_700_000_000_001),
      ],
      final: true,
    });
    await page.locator(".messages-scroll .message-card").first().waitFor({ state: "visible", timeout: 15_000 });
    await page.screenshot({ path: join(OUT, `idle-${viewport.name}.png`), fullPage: false });
    await context.close();
  }
});
