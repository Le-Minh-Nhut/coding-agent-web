import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  harnessFixture,
  installMockCollabHost,
  openSeededConversation,
  requireAppServer,
  welcomeFrame,
} from "./fixture.js";

/**
 * Guest diff colors on the REAL production conversation.
 *
 * `apps/web` mounts the guest `DiffBlock` inside its own shell (`.tool-row` →
 * `.tool-body` → `.tv-file-change-body` → `.tv-diff` for a change-bearing tool
 * with no dedicated viewer), never the guest `ToolView` whose `.tv-card` carried
 * the `--tv-*` token bridge. Until the bridge moved to `.tool-row` every `--tv-*`
 * consumer in the app resolved to the empty value, so added and deleted rows were
 * transparent and their text was the context color.
 *
 * `edit` rows were later flattened to a file list whose rows open the dedicated
 * viewer, so this spec drives the same colour rules through `write` — the
 * change-bearing tool that still keeps its per-file disclosure. The rules under
 * test are scoped to `.tool-row` and are the same either way.
 *
 * This spec drives the real screen (mock Collab host, seeded fixture, real
 * bundle) and asserts computed styles from the live DOM. Pre-fix it must fail:
 * `git stash push apps/web/src/styles.css` then run it.
 */

const SCREENS_DIR = join(process.env.HOME ?? "/tmp", ".cache", "caw-screens");
const SCREENSHOT = join(SCREENS_DIR, "diff-colors-fixed.png");

/** A tool result carrying a real per-file diff, the shape the UI must colour. */
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
        // `write`, not `edit`: an edit row's body was flattened to a file list
        // whose rows open the dedicated viewer, so it no longer mounts a diff in
        // the conversation. The colour rules under test are scoped to `.tool-row`
        // and every change-bearing tool still reaches them here — `write` keeps
        // the per-file disclosure and its `DiffBlock`.
        toolName: "write",
        content: [{ type: "text", text: "Wrote src/auth.ts" }],
        details: { path: "src/auth.ts", op: "write", diff, perFileResults: [{ path: "src/auth.ts", op: "write", diff }] },
        isError: false,
        timestamp,
      },
    },
  };
}

interface RowProbe {
  color: string;
  background: string;
  /** Ancestor backgrounds, nearest first: what the translucent row composites onto. */
  ancestorBackgrounds: string[];
}

interface DiffProbe {
  found: boolean;
  add: RowProbe | null;
  del: RowProbe | null;
  context: RowProbe | null;
  hunk: RowProbe | null;
  tvOk: string;
  tvErr: string;
}

/** Read the computed color/background of the diff rows and the token values. */
async function probe(page: Page): Promise<DiffProbe> {
  return page.evaluate(() => {
    const rowOf = (element: Element | null): RowProbe | null => {
      if (element === null) return null;
      const style = getComputedStyle(element);
      const ancestorBackgrounds: string[] = [];
      let node: Element | null = element.parentElement;
      while (node !== null && ancestorBackgrounds.length < 12) {
        ancestorBackgrounds.push(getComputedStyle(node).backgroundColor);
        node = node.parentElement;
      }
      return { color: style.color, background: style.backgroundColor, ancestorBackgrounds };
    };
    const diff = document.querySelector(".tv-diff");
    const rows = diff === null ? [] : [...diff.querySelectorAll(".tv-diff-row")];
    // A "context" row is a plain `.tv-diff-row` with no modifier: an unchanged line.
    const context = rows.find((row) => row.className.trim() === "tv-diff-row") ?? null;
    const token = diff === null ? "" : getComputedStyle(diff).getPropertyValue("--tv-ok").trim();
    const tokenErr = diff === null ? "" : getComputedStyle(diff).getPropertyValue("--tv-err").trim();
    return {
      found: diff !== null,
      add: rowOf(diff === null ? null : diff.querySelector(".tv-diff-row--add")),
      del: rowOf(diff === null ? null : diff.querySelector(".tv-diff-row--del")),
      context: rowOf(context),
      hunk: rowOf(diff === null ? null : diff.querySelector(".tv-diff-row--hunk")),
      tvOk: token,
      tvErr: tokenErr,
    };
  });
}

/** Open the seeded conversation, expand the edit row down to its mounted diff. */
async function openDiff(page: Page): Promise<void> {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await host.send(editEntry("diff-colors", 1));

  const group = page.locator(".activity-group").first();
  await expect(group).toBeVisible();
  await group.getByRole("button").first().click();
  const editRow = page.locator(".tool-row").first();
  await expect(editRow).toBeVisible();
  await editRow.locator(".tool-row-head").click();
  const fileRow = editRow.locator(".tv-file-change").first();
  await expect(fileRow).toBeVisible();
  await fileRow.locator(".tv-file-change-head").click();
  await expect(editRow.locator(".tv-diff-row--add").first()).toBeVisible();
  await expect(editRow.locator(".tv-diff-row--hunk").first()).toBeVisible();
}

// ── color math ──────────────────────────────────────────────────────────────
// The contrast check is computed, not claimed: the translucent row background is
// flattened over its real ancestors and compared with the resolved text color.

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function oklchToRgb(l: number, c: number, h: number): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const lCube = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCube = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCube = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube,
  ];
  const gamma = (value: number): number => {
    const v = Math.min(1, Math.max(0, value));
    return (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255;
  };
  return [gamma(linear[0]!), gamma(linear[1]!), gamma(linear[2]!)];
}

function parseColor(value: string): Rgba {
  const text = value.trim();
  const rgbMatch = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgbMatch !== null) {
    const parts = rgbMatch[1]!.split(/[,/\s]+/).filter((part) => part.length > 0);
    const channel = (part: string): number => (part.endsWith("%") ? (Number.parseFloat(part) / 100) * 255 : Number.parseFloat(part));
    return { r: channel(parts[0]!), g: channel(parts[1]!), b: channel(parts[2]!), a: parts[3] === undefined ? 1 : Number.parseFloat(parts[3]) };
  }
  const oklchMatch = /^oklch\(([^)]+)\)$/.exec(text);
  if (oklchMatch !== null) {
    const parts = oklchMatch[1]!.split(/[,/\s]+/).filter((part) => part.length > 0);
    const [r, g, b] = oklchToRgb(Number.parseFloat(parts[0]!), Number.parseFloat(parts[1]!), Number.parseFloat(parts[2]!));
    return { r, g, b, a: parts[3] === undefined ? 1 : Number.parseFloat(parts[3]) };
  }
  throw new Error(`unsupported computed color ${JSON.stringify(value)}`);
}

/** Flatten a translucent row over its real ancestors (nearest first). */
function effectiveBackground(row: RowProbe): Rgba {
  const layers = [parseColor(row.background), ...row.ancestorBackgrounds.map(parseColor)];
  let base: Rgba | null = null;
  let pending: Rgba[] = [];
  for (const layer of layers) {
    pending.push(layer);
    if (layer.a >= 1) {
      base = layer;
      break;
    }
  }
  if (base === null) base = { r: 0, g: 0, b: 0, a: 1 };
  // `pending` is nearest-first and ends at the opaque base; walk top-down.
  let [r, g, b] = [base.r, base.g, base.b];
  for (const layer of pending.slice(0, -1).reverse()) {
    r = layer.r * layer.a + r * (1 - layer.a);
    g = layer.g * layer.a + g * (1 - layer.a);
    b = layer.b * layer.a + b * (1 - layer.a);
  }
  return { r, g, b, a: 1 };
}

function relativeLuminance({ r, g, b }: Rgba): number {
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground: Rgba, background: Rgba): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("the guest diff themes through the production ancestor chain", async ({ page }) => {
  await openDiff(page);

  const styles = await probe(page);
  expect(styles.found, "a DiffBlock must be mounted inside the real conversation").toBe(true);
  for (const [name, row] of Object.entries({ add: styles.add, del: styles.del, context: styles.context, hunk: styles.hunk })) {
    expect(row, `${name} row must exist`).not.toBeNull();
  }
  const add = styles.add!;
  const del = styles.del!;
  const context = styles.context!;
  const hunk = styles.hunk!;

  // Measured, not claimed: printed before any assertion so a pre-fix run still
  // reports the values the assertions are about.
  const addBackground = effectiveBackground(add);
  const delBackground = effectiveBackground(del);
  const addContrast = contrastRatio(parseColor(add.color), addBackground);
  const delContrast = contrastRatio(parseColor(del.color), delBackground);
  const measured = `add ${add.color} on rgb(${Math.round(addBackground.r)}, ${Math.round(addBackground.g)}, ${Math.round(addBackground.b)}) = ${addContrast.toFixed(2)}:1, del ${del.color} on rgb(${Math.round(delBackground.r)}, ${Math.round(delBackground.g)}, ${Math.round(delBackground.b)}) = ${delContrast.toFixed(2)}:1`;
  console.log(
    "[diff-colors styles]",
    JSON.stringify({
      add: { color: add.color, background: add.background },
      del: { color: del.color, background: del.background },
      context: { color: context.color, background: context.background },
      hunk: { color: hunk.color, background: hunk.background },
      tvOk: styles.tvOk,
      tvErr: styles.tvErr,
    }),
  );
  console.log("[diff-colors contrast]", measured);

  // Tokens reach the row: the bridge is `.tool-row`, not the never-emitted
  // `.tv-card`.
  expect(styles.tvOk, "--tv-ok must resolve on the diff row").not.toBe("");
  expect(styles.tvErr, "--tv-err must resolve on the diff row").not.toBe("");

  // Backgrounds are tinted, and the tint differs per kind.
  for (const [name, row] of [["add", add], ["del", del]] as const) {
    expect(row.background, `${name} row must not be transparent`).not.toBe("rgba(0, 0, 0, 0)");
    expect(row.background, `${name} row must differ from the context row`).not.toBe(context.background);
  }
  expect(add.background, "add and del must be tinted differently").not.toBe(del.background);

  // Text is coloured per kind, and hunk headers stay distinct from code.
  expect(add.color, "add row text differs from context").not.toBe(context.color);
  expect(del.color, "del row text differs from context").not.toBe(context.color);
  expect(add.color, "add and del text differ").not.toBe(del.color);
  expect(hunk.color, "hunk header stays visually distinct from code").not.toBe(context.color);

  // AA for body text. Measured on this theme: add ≈ 6.65:1, del ≈ 6.19:1.
  expect(addContrast, `add row must reach AA (4.5:1); ${measured}`).toBeGreaterThanOrEqual(4.5);
  expect(delContrast, `del row must reach AA (4.5:1); ${measured}`).toBeGreaterThanOrEqual(4.5);

  mkdirSync(SCREENS_DIR, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".tv-diff").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: SCREENSHOT });
});
