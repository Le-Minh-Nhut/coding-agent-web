import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { expect, test, type Page } from "@playwright/test";
import {
  harnessFixture,
  installMockCollabHost,
  openSeededConversation,
  requireAppServer,
  welcomeFrame,
  MOCK_SUBAGENTS,
  type MockCollabHost,
} from "./fixture.js";

/**
 * The agent-detail chat surface, in a real Chromium.
 *
 * The jsdom suite (`tests/web/agent-chat.test.tsx`) proves the component's rules
 * against the real captured journal. What only a browser can prove is the wiring
 * the owner asked about: that the *default* view of a live agent's transcript is
 * conversation rows and not the raw session bytes, that Diagnostics reveals those
 * bytes, and that moving between the tabs does not blank the chat. That is the
 * difference between "the component renders" and "the screen the owner opens
 * shows a conversation".
 *
 * The transcript itself arrives over the room socket: the host replies to the
 * page's own `fetch-transcript` frame with a `transcript` frame carrying `text`.
 * The mock host records every guest frame, so this spec answers the page's real
 * request — it does not inject a reply into a socket nobody asked on.
 */

const SCREENS_DIR = process.env.CAW_SCREENS_DIR ?? join(homedir(), ".cache", "caw-screens");
const MOBILE = { width: 390, height: 844 };

/**
 * A transcript reply in the shape the wire uses.
 *
 * MOCK_SUBAGENTS reports `hasSessionFile: true` for `scout-codebase`, which is
 * what makes Agent Detail poll at all, so this text is what that poll returns.
 * It is native OMP JSONL in the real record order — the fixed-width `title` slot,
 * the `session` header, `session_init`, then a user record, an assistant reply,
 * and one tool call with its result — because the claim under test is precisely
 * that the default view does NOT start with those first two records.
 *
 * `VITEST`-free and runtime-generated: the launcher's temp tree is hermetic, so
 * the text is built here rather than read from the repo's fixture directory.
 */
const TITLE_PAD = " ".repeat(230);
const NATIVE_JOURNAL = [
  `{"type":"title","v":1,"title":"","updatedAt":"2026-11-06T00:00:00.000Z","pad":"${TITLE_PAD}"}`,
  `{"type":"session","version":3,"id":"e2e-native-session","timestamp":"2026-11-06T00:00:00.000Z","cwd":"/tmp"}`,
  `{"type":"session_init","id":"init-1","parentId":null,"timestamp":"2026-11-06T00:00:00.010Z","task":"CHAT_E2E_TASK Review the lane-lock helper.","agent":"scout-codebase","resolvedModel":"9router/cx/gpt-6-luna"}`,
  `{"type":"message","id":"u1","parentId":"init-1","timestamp":"2026-11-06T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"CHAT_E2E_USER please look at the lock"}]}}`,
  `{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-11-06T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"CHAT_E2E_ASSISTANT I will read it now."},{"type":"toolCall","id":"call_e2e_1","name":"bash","arguments":{"command":"rg laneLock"}}]}}`,
  `{"type":"message","id":"t1","parentId":"a1","timestamp":"2026-11-06T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_e2e_1","toolName":"bash","content":[{"type":"text","text":"CHAT_E2E_TOOL_OUTPUT 12 matches"}],"details":{"exitCode":0},"isError":false}}`,
].join("\n") + "\n";

/** A reply whose first byte is the document start, so the offset is 0 to start. */
const REPLY_TEXT = NATIVE_JOURNAL;
const REPLY_NEW_SIZE = Buffer.byteLength(REPLY_TEXT, "utf8");

test.beforeAll(async ({ request }) => {
  await requireAppServer(request);
});

/**
 * Assert the running bundle really wires the chat surface.
 *
 * This used to be a skip: while `AgentDetail.tsx` still printed the raw session
 * bytes there was no `.agent-chat` in the DOM, and a failing chat assertion would
 * have pointed at the wrong file. The wiring has landed, so the same probe is now a
 * hard assertion — a bundle without the chat surface must fail here, naming the
 * cause, rather than silently skipping the screen the owner asked about.
 */
async function expectAgentChatWired(page: Page): Promise<void> {
  const state = await page.evaluate(() => {
    if (document.querySelector(".agent-chat") !== null) return "wired";
    const raw = document.querySelector(".agent-transcript");
    return (raw?.textContent ?? "").includes('{"type":"session"') ? "raw-only" : "no-transcript";
  });
  expect(
    state,
    "the detail must render the chat surface; `raw-only` means the bundle predates the AgentDetail rewiring, `no-transcript` means the transcript never arrived",
  ).toBe("wired");
}

/** Answer the page's own transcript request, whatever `reqId` it chose. */
async function answerNextTranscriptRequest(host: MockCollabHost, seen: { count: number }): Promise<void> {
  await expect.poll(() => host.guestFrames.filter((frame) => frame.t === "fetch-transcript").length, {
    message: "Agent Detail should ask the host for the agent's transcript",
    timeout: 20_000,
  }).toBeGreaterThan(seen.count);

  const request = host.guestFrames
    .filter((frame) => frame.t === "fetch-transcript")
    .at(-1) as { reqId: number; agentId: string; fromByte: number } | undefined;
  if (request === undefined) throw new Error("no fetch-transcript frame was captured");
  seen.count += 1;
  await host.send({
    t: "transcript",
    reqId: request.reqId,
    text: request.fromByte === 0 ? REPLY_TEXT : "",
    newSize: REPLY_NEW_SIZE,
  });
}

/** Open the agents layer, pick `scout-codebase`, and serve its transcript. */
async function openAgentWithTranscript(page: Page, host: MockCollabHost, seen: { count: number }): Promise<void> {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: /^Agents \(/ }).click();
  await page.locator(".agent-row").filter({ hasText: "scout-codebase" }).click();
  await expect(page.getByRole("heading", { name: "scout-codebase", exact: true })).toBeVisible();
  await answerNextTranscriptRequest(host, seen);
  // Keep answering for the register: the detail polls while the agent is running,
  // and an unanswered request would leave the next assertion racing the poll.
  for (let poll = 0; poll < 3; poll += 1) {
    await expect.poll(() => host.guestFrames.filter((frame) => frame.t === "fetch-transcript").length, { timeout: 15_000 })
      .toBeGreaterThan(seen.count);
    const request = host.guestFrames.filter((frame) => frame.t === "fetch-transcript").at(-1) as
      | { reqId: number; fromByte: number }
      | undefined;
    if (request === undefined) break;
    seen.count += 1;
    await host.send({ t: "transcript", reqId: request.reqId, text: "", newSize: REPLY_NEW_SIZE });
  }
}

test("the agent detail shows a conversation, keeps the raw bytes behind Diagnostics, and survives the tabs", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await page.setViewportSize(MOBILE);
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await host.send({ t: "agents", agents: MOCK_SUBAGENTS });

  const seen = { count: 0 };
  await openAgentWithTranscript(page, host, seen);
  await expectAgentChatWired(page);

  const chatPanel = page.locator('[role="tabpanel"]').first();
  /**
   * The user's row as a CARD, not as a text node.
   *
   * `getByText` matches every element whose content contains the string, and a
   * message row nests it (`.message-card` → `.collapsible` → `.message-content` →
   * `<p>`), so a text query is not a unique locator. Selecting the card is both
   * stable and a stronger claim: the row exists and it is the user's.
   */
  const chatUserRow = chatPanel.locator(".message-card.user").filter({ hasText: "CHAT_E2E_USER please look at the lock" });

  // 1. The default view is the conversation: the user's own text and the
  //    assistant's reply are rendered, as rows, without opening anything.
  await expect(chatUserRow).toHaveCount(1);
  await expect(chatUserRow).toBeVisible();
  await expect(chatUserRow).toContainText("CHAT_E2E_USER please look at the lock");
  await expect(chatPanel.locator(".message-card.assistant").filter({ hasText: "CHAT_E2E_ASSISTANT" }).first()).toBeVisible();

  // 2. The raw session bytes are NOT in the default view.
  const defaultText = (await chatPanel.innerText()).replace(/\s+/gu, " ");
  expect(defaultText, "the session header must not be in the default view").not.toContain('{"type":"session"');
  expect(defaultText, "the title slot must not be in the default view").not.toContain('{"type":"title"');
  expect(defaultText, "the task field is read as a field, not dumped as a record").not.toContain('{"type":"session_init"');

  // 3. Diagnostics reveals them, and the disclosure says what they are.
  //    The screenshot is taken HERE, closing the loop the owner asked about:
  //    it must show the default view (conversation rows, Diagnostics closed), and
  //    it is captured before the disclosure is opened so it cannot misrepresent it.
  mkdirSync(SCREENS_DIR, { recursive: true });
  await page.screenshot({ path: join(SCREENS_DIR, "agent-detail-chat.png"), fullPage: false });

  const diagnostics = page.locator("details.agent-chat-raw").first();
  await diagnostics.locator("summary").click();
  const raw = diagnostics.locator("pre.agent-transcript");
  await expect(raw).toBeVisible();
  await expect(raw).toContainText('{"type":"session"');
  await expect(diagnostics.locator("summary")).toContainText("not a transcript");
  // The opened bytes must stay inside the transcript section, not paint over the
  // sections below it — the defect the first screenshot caught. The DISCLOSURE is
  // what defines the paint boundary, so that is what is measured: the `<pre>` is its
  // overflowing child and reports an unclipped layout box by design.
  const actionsHeading = page.getByRole("heading", { name: "Actions", exact: true });
  const rawBox = await diagnostics.boundingBox();
  const actionsBox = await actionsHeading.boundingBox();
  expect(rawBox, "the diagnostics disclosure must be measurable").not.toBeNull();
  expect(actionsBox, "the Actions heading must be measurable").not.toBeNull();
  expect(rawBox!.y + rawBox!.height, "the raw bytes must not overlay the Actions section").toBeLessThanOrEqual(actionsBox!.y + 1);
  // And the whole journal stays reachable by scrolling inside the disclosure.
  const rawScrollable = await diagnostics.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(rawScrollable, "the disclosure must scroll its own overflow rather than clip content away").toBe(true);

  // 4. Activity and Results do not blank the chat.
  //    An inactive tabpanel is `hidden`, so the chat's rows are attached but not
  //    visible while another tab is selected — the claim is that they are still
  //    there, unbuilt-vs-rebuilt, and that returning shows them again.
  await expect(chatUserRow).toBeAttached();

  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(/this timeline is the session's own records/i)).toBeVisible();
  await expect(chatUserRow, "the chat rows are not torn down by a tab switch").toBeAttached();

  await page.getByRole("tab", { name: "Results" }).click();
  await expect(page.getByText("This session recorded no completion payload.")).toBeVisible();
  await expect(chatUserRow, "Results must not blank the chat either").toBeAttached();

  await page.getByRole("tab", { name: "Chat" }).click();
  await expect(chatUserRow, "returning to Chat shows the conversation again").toBeVisible();
});

test("the Activity tab lists the session's own tool result for a native journal", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await page.setViewportSize(MOBILE);
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await host.send({ t: "agents", agents: MOCK_SUBAGENTS });

  const seen = { count: 0 };
  await openAgentWithTranscript(page, host, seen);
  await expectAgentChatWired(page);

  await page.getByRole("tab", { name: "Activity" }).click();
  const lines = page.locator(".agent-chat-activity-line");
  await expect(lines).toHaveCount(1);
  await expect(lines.first()).toContainText("bash");
  // The row's own boolean is the whole claim; the wording must not upgrade it.
  await expect(lines.first()).toContainText("not reported as failed");
  await expect(lines.first()).toContainText("CHAT_E2E_TOOL_OUTPUT");
});
