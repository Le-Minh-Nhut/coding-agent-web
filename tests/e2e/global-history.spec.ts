import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodeSessionDirName } from "../../packages/omp-adapter/src/session-catalog.js";
import { createProjectFromBrowser, harnessFixture, login, assertNoUnexpectedAppErrors } from "./fixture.js";

const manifest = harnessFixture();
const sessionRoot = path.join(manifest.tempRoot, "home", ".omp", "agent", "sessions");
const bucketPath = (cwd: string) => path.join(sessionRoot, encodeSessionDirName(cwd, { homeDir: path.join(manifest.tempRoot, "home") }));
let journalSequence = 0;
async function writeJournal(id: string, cwd: string, title?: string): Promise<void> {
  const bucket = bucketPath(cwd);
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, journalSequence++)).toISOString();
  await mkdir(bucket, { recursive: true });
  await writeFile(path.join(bucket, `2026-01-01_${id}.jsonl`), [
    ...(title ? [JSON.stringify({ type: "title", v: 1, title, updatedAt: timestamp, pad: " ".repeat(170) })] : []),
    JSON.stringify({ type: "session", version: 3, id, cwd, timestamp }),
    JSON.stringify({ type: "message", id: `${id}-m`, message: { role: "user", content: [{ type: "text", text: `hello-${id}` }] } }),
  ].join("\n") + "\n");
}

test("global session history browses journals without CAW conversations", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const firstCwd = path.join(manifest.rootsDir, "gh-alpha");
  const secondCwd = path.join(manifest.rootsDir, "gh-beta");
  const unregistered = path.join(manifest.rootsDir, "unregistered");
  const missing = path.join(manifest.rootsDir, "deleted-cwd");
  await mkdir(unregistered, { recursive: true });
  for (let index = 0; index < 47; index++) await writeJournal(`z${index.toString(36).padStart(7, "0")}`, secondCwd);
  await writeJournal("alpha001", firstCwd, "Alpha titled");
  await writeJournal("beta0002", secondCwd);
  await writeJournal("orphan01", unregistered);
  await writeJournal("gone0001", missing, "Gone folder");
  await writeFile(path.join(bucketPath(firstCwd), "plain.txt"), "not a journal");

  await login(page);
  await createProjectFromBrowser(page, "gh-alpha", "Alpha project");
  await createProjectFromBrowser(page, "gh-beta", "Beta project");
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("searchbox").fill("Alpha");
  await expect(page.locator("article.history-row h4").filter({ hasText: /^Alpha titled$/ })).toBeVisible();
  await page.getByRole("searchbox").fill("beta0002");
  await expect(page.locator("article.history-row h4").filter({ hasText: /^beta0002$/ })).toBeVisible();
  await page.getByRole("searchbox").fill("orphan01");
  await expect(page.getByText("this folder is not a project; add it to resume here")).toBeVisible();
  await expect(page.locator("article.history-row").filter({ hasText: "history only" })).toHaveCount(0);
  await page.getByRole("searchbox").fill("deleted-cwd");
  await expect(page.locator("article.history-row").filter({ hasText: "history only" })).toBeVisible();
  await page.getByRole("searchbox").fill("");
  await expect(page.locator("article.history-row h4").filter({ hasText: /^Alpha titled$/ })).toBeVisible();
  await expect(page.getByText("searching…", { exact: true })).toHaveCount(0);
  const output = path.join(process.env.HOME ?? "/tmp", ".cache/r42-web");
  const listBeforeMore = await page.locator("body").innerText();
  await page.screenshot({ path: path.join(output, "history-smoke.png"), fullPage: true });

  const orphan = page.locator("article.history-row").filter({ hasText: "orphan01" });
  await expect(orphan.getByRole("button", { name: "Resume" })).toBeDisabled();
  await orphan.getByRole("button", { name: "View history" }).click();
  await expect(page.getByRole("dialog", { name: "Saved session history" })).toContainText("hello-orphan01");
  await expect(page.getByText("Saved transcript — read-only journal history.")).toBeVisible();
  const readerDom = await page.locator("body").innerText();
  await page.screenshot({ path: path.join(output, "history-reader-smoke.png"), fullPage: true });
  await writeFile(path.join(output, "dom.txt"), `HISTORY LIST\n${listBeforeMore}\n\nHISTORY READER\n${readerDom}`);
  await page.getByRole("button", { name: "Close" }).click();
  const before = await page.locator("article.history-row h4").allTextContents();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.locator("article.history-row")).toHaveCount(51);
  const after = await page.locator("article.history-row h4").allTextContents();
  expect(new Set(after).size).toBe(after.length);
  expect(after.slice(0, 10)).toEqual(before.slice(0, 10));
  await assertNoUnexpectedAppErrors(page);
});
