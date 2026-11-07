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
 * The flattened tool-activity hierarchy, on the REAL production conversation.
 *
 * An `edit` used to expand into Group → Tool → Changes → File → Diff → Raw
 * details: six levels before a change was readable, with a full patch mounted
 * inside the transcript. Now an edit's body is one flat list of file rows; the
 * patch lives in the dedicated viewer the row opens, and the raw payload is one
 * `<details>` per row.
 *
 * Every number here is read from the live DOM. The nesting bound is printed with
 * the ancestor chain, so a regression that deepens the tree fails with the shape
 * it actually produced rather than a bare number.
 */

const SCREENS_DIR = join(process.env.HOME ?? "/tmp", ".cache", "caw-screens");
const SCREENSHOT = join(SCREENS_DIR, "tool-activity-flat.png");

/**
 * The deepest the file row may sit below `.messages-content`.
 *
 * Measured after the flatten: `messages-content` > `activity-group` >
 * `activity-group-body` > `tool-row` > `tool-body` > `tv-file-changes` >
 * `tv-file-change` > `tv-file-change-head` = 7 levels, asserted at 8 so one
 * wrapper can be added deliberately without the bound silently rotting. The
 * pre-flatten tree reached the diff two levels deeper (9) and only behind a
 * second disclosure.
 */
const MAX_FILE_ROW_DEPTH = 8;

/** A tool result carrying a real per-file diff, the shape the UI must summarize. */
function editEntry(id: string, timestamp: number) {
  const diff = [
    "--- a/src/advisor.ts",
    "+++ b/src/advisor.ts",
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
        content: [{ type: "text", text: "Edited src/advisor.ts" }],
        details: { path: "src/advisor.ts", op: "edit", diff, perFileResults: [{ path: "src/advisor.ts", op: "edit", diff }] },
        isError: false,
        timestamp,
      },
    },
  };
}

interface RowGeometry {
  /** Ancestor class chain from the file row up to `.messages-content`. */
  ancestors: string[];
  depth: number;
  diffRowsInConversation: number;
  fileRowCount: number;
  nestingInsideFileRow: number;
}

/** Expand the seeded edit down to its file rows. */
async function openEditRow(page: Page): Promise<void> {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await host.send(editEntry("flat-hierarchy", 1));

  const group = page.locator(".activity-group").first();
  await expect(group).toBeVisible();
  await group.getByRole("button").first().click();
  const editRow = page.locator(".tool-row").first();
  await expect(editRow).toBeVisible();
  await editRow.locator(".tool-row-head").click();
  await expect(editRow.locator(".tv-file-change").first()).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

/**
 * A realistic turn on the real screen: the same shape the owner's session has.
 *
 * An agent that runs four commands emits four `assistant` messages whose only
 * content is a `toolCall`, each followed by its result. Those echoes render as
 * nothing, and they used to split the run into four cards reading `Run 1 command`
 * — the reported complaint. This asserts the repair end to end: one card, a real
 * accessible name, an evidence metric, and every operation still one tap away.
 */
function assistantCall(id: string, callId: string, toolName: string, args: Record<string, unknown>, timestamp: number) {
  return {
    t: "entry",
    entry: {
      id,
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: toolName, arguments: args }],
        model: "provider/model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
        stopReason: "toolUse",
        timestamp,
      },
    },
  };
}

test("a multi-command turn is one card, with a state word and an evidence metric", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));

  // Four commands, each requested by its own assistant message — the shape that
  // produced four `Run 1 command` cards.
  for (let index = 0; index < 4; index++) {
    await host.send(assistantCall(`call-msg-${index}`, `tc-${index}`, "bash", { command: `pnpm step-${index}` }, 10 + index * 2) as never);
    await host.send({
      t: "entry",
      entry: {
        id: `tr-${index}`,
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: `tc-${index}`,
          toolName: "bash",
          // The last one carries a real runner summary: that is the only evidence
          // that may become a `passed` claim.
          content: index === 3
            ? [{ type: "text", text: " Test Files  1 failed (1)\n      Tests  3 failed | 15 passed (18)" }]
            : [{ type: "text", text: `step ${index} ok` }],
          isError: false,
          timestamp: 11 + index * 2,
        },
      },
    } as never);
  }

  const groups = page.locator(".activity-group");
  await expect(groups).toHaveCount(1);
  const head = groups.first().locator(".activity-group-head");
  await expect(head).toContainText("Run 4 commands");
  // The runner's own numbers, and the state escalated by them: the wire said the
  // call was clean, and a green card would have been a lie.
  await expect(head.locator(".activity-group-metric")).toHaveText("3 failed | 15 passed");
  await expect(groups.first()).toHaveClass(/activity-group--failed/);
  // Failure is announced in words, not only by the glyph's colour.
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(head).toHaveAttribute("aria-label", /^Failed: Run 4 commands,/);

  // Every operation is still reachable, in order, with its own identity.
  await head.click();
  await expect(groups.first().locator(".tool-row")).toHaveCount(4);
  await expect(groups.first().locator(".tool-row-name").first()).toHaveText("bash");
});

/**
 * The subagent roll-up's own wiring is the transcript worker's to make:
 * `SubagentActivityRow` takes the count and an `onOpenAgents` handler, but
 * `TranscriptList` (in `components/MessageRow.tsx`) does not yet read
 * `transcript.agents` or accept that prop, and this workstream does not own that
 * file. The component's behaviour is pinned in
 * `tests/web/tool-activity-card.test.tsx`; an E2E test here would assert a row
 * that nothing mounts yet.
 */

test("an edit expands to a flat file list, and the patch stays out of the conversation", async ({ page }) => {
  await openEditRow(page);

  const editRow = page.locator(".tool-row").first();
  // The summary line is the honest edit summary, not a path.
  await expect(editRow.locator(".tool-row-sum")).toContainText("Edited 1 file");
  await expect(editRow.locator(".tool-row-sum")).toContainText("+2");
  await expect(editRow.locator(".tool-row-sum")).toContainText("−1");

  // Level one: the file row, with its own verified counts and no nested body.
  const fileRow = editRow.locator(".tv-file-change").first();
  await expect(fileRow.locator(".tv-file-name")).toHaveText("advisor.ts");
  await expect(fileRow.locator(".tv-file-dir")).toHaveText("src");
  await expect(fileRow.locator(".tv-count-add")).toHaveText("+2");
  await expect(fileRow.locator(".tv-count-del")).toHaveText("−1");
  await expect(editRow.locator(".tv-file-change-body")).toHaveCount(0);
  // No patch anywhere in the transcript for this edit row.
  await expect(editRow.locator(".tv-diff")).toHaveCount(0);
  await expect(editRow.locator(".tv-diff-row")).toHaveCount(0);

  const geometry: RowGeometry = await page.evaluate(() => {
    const find = (selector: string): HTMLElement | null => document.querySelector(selector);
    const file = find(".tv-file-change-head");
    const content = find(".messages-content");
    const ancestors: string[] = [];
    if (file !== null && content !== null) {
      let node: Element | null = file;
      while (node !== null) {
        const cls = node.className === undefined || typeof node.className !== "string" ? "" : node.className.trim();
        ancestors.push(node.tagName.toLowerCase() + (cls === "" ? "" : `.${cls.split(/\s+/).join(".")}`));
        if (node === content) break;
        node = node.parentElement;
      }
    }
    const fileRowEl = find(".tv-file-change");
    return {
      ancestors,
      depth: ancestors.length - 1,
      diffRowsInConversation: document.querySelectorAll(".messages-content .tv-diff-row").length,
      fileRowCount: document.querySelectorAll(".tv-file-change").length,
      // Anything nested between the row and its own label would be a level of
      // disclosure the flatten removed; count the row's own descendants so a
      // regression is visible as a number.
      nestingInsideFileRow: fileRowEl === null ? -1 : fileRowEl.querySelectorAll(":scope > *").length,
    };
  });

  // Printed so the assertion below is falsifiable: a failure shows the real chain.
  console.log("[flat hierarchy] file row ancestors →", JSON.stringify(geometry.ancestors));
  console.log("[flat hierarchy] geometry →", JSON.stringify(geometry));

  expect(geometry.depth, `file row must sit within ${MAX_FILE_ROW_DEPTH} levels of .messages-content; chain: ${geometry.ancestors.join(" > ")}`).toBeLessThanOrEqual(MAX_FILE_ROW_DEPTH);
  expect(geometry.depth, "the chain must be rooted at .messages-content").toBeGreaterThan(0);
  expect(geometry.ancestors[0]).toContain("tv-file-change-head");
  expect(geometry.ancestors[geometry.ancestors.length - 1]).toContain("messages-content");
  // Exactly one file row, one direct child (its head button): a flat row.
  expect(geometry.fileRowCount).toBe(1);
  expect(geometry.nestingInsideFileRow).toBe(1);
  expect(geometry.diffRowsInConversation, "no diff row may be mounted in the transcript").toBe(0);

  mkdirSync(SCREENS_DIR, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await editRow.scrollIntoViewIfNeeded();
  await page.screenshot({ path: SCREENSHOT });
});

test("the raw payload is one disclosure behind the file list", async ({ page }) => {
  await openEditRow(page);
  const editRow = page.locator(".tool-row").first();

  // Closed by default, and nothing of the record is mounted while closed.
  const details = editRow.locator("details.tool-raw-details");
  await expect(details).toHaveCount(1);
  await expect(details.locator("summary")).toHaveText("View technical details");
  await expect(details).not.toHaveAttribute("open", /.*/);
  await expect(editRow.locator(".tool-raw-output")).toHaveCount(0);

  await details.locator("summary").click();
  await expect(editRow.locator(".tool-raw-output")).toBeVisible();
  await expect(editRow.locator(".tool-raw-output")).toContainText("Edited src/advisor.ts");
});

test("no horizontal page overflow with the flat list open at the two smallest viewports", async ({ page }) => {
  await openEditRow(page);
  for (const viewport of [{ name: "320x568", width: 320, height: 568 }, { name: "390x844", width: 390, height: 844 }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect.poll(() => page.evaluate(() => document.documentElement.clientWidth)).toBe(viewport.width);
    const overflow = await page.evaluate(() => Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth));
    expect(overflow, `${viewport.name}: the flat list must not widen the document`).toBeLessThanOrEqual(1);
  }
});

/**
 * The file row's whole purpose: tapping it opens the diff for THAT path.
 *
 * The row used to be a dead button. `ToolRow` had accepted `onOpenFile` since the
 * flatten, but `ActivityGroupRow` and `TranscriptList` never took or forwarded it,
 * and the handler never mounted the Files layer — so a tap in the real conversation
 * did nothing at all. This drives the real screen through the real components: expand
 * the group, expand the edit, tap the file row, and require the diff view with that
 * exact path. A no-op, a wrong path, or a layer that never mounts all fail here.
 */
test("tapping a file row in the conversation opens the diff for that path", async ({ page }) => {
  await openEditRow(page);

  // Nothing is open yet: the conversation is the screen.
  await expect(page.locator(".files-layer")).toHaveCount(0);

  await page.locator(".tool-row").first().locator(".tv-file-change").first().click();

  // The Files layer is mounted, and it is showing the DIFF for this path rather
  // than the list — asserted on the diff's own region and its directory line.
  const diff = page.locator(".files-diff");
  await expect(diff).toBeVisible();
  await expect(diff.getByRole("heading", { name: "advisor.ts", exact: true })).toBeVisible();
  await expect(diff.locator(".files-diff-dir")).toHaveText("src/");
  // And the patch itself is here, which is the reason the row exists.
  await expect(diff.locator(".tv-diff-row").first()).toBeVisible();

  // Back returns to the list of changed files, not out of the layer.
  await diff.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".files-center")).toBeVisible();
  await expect(page.locator(".files-row").first()).toBeVisible();
});
