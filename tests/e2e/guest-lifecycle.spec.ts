import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { installMockCollabHost, welcomeFrame } from "./fixture.js";

const guestDist = resolve("packages/guest/dist");
const guestRoute = "**/guest/**";
const promptText = Array.from({ length: 24 }, (_, i) => `Recovery line ${String(i + 1).padStart(2, "0")}: ${"synthetic prompt text ".repeat(4).trimEnd()}`).join("\n");
const dismissText = "Synthetic prompt retained only for dismissal";

test("built Guest connects, ends, and recovers a long unconfirmed prompt", async ({ page, context, baseURL }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new DOMException("denied", "NotAllowedError"); } } });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Browser.setPermission", { permission: { name: "clipboard-read" }, setting: "denied", origin: baseURL });
  await cdp.send("Browser.setPermission", { permission: { name: "clipboard-write" }, setting: "denied", origin: baseURL });

  await page.route(guestRoute, async route => {
    const url = new URL(route.request().url());
    const relative = decodeURIComponent(url.pathname.slice("/guest/".length));
    const path = resolve(guestDist, relative || "index.html");
    if (path !== guestDist && !path.startsWith(`${guestDist}${sep}`)) {
      await route.fulfill({ status: 404, body: "Not found" });
      return;
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: ({ ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" } as Record<string, string>)[extname(path)] ?? "application/octet-stream",
        body: await readFile(path),
      });
    } catch {
      await route.fulfill({ status: 404, body: "Not found" });
    }
  });

  const host = await installMockCollabHost(page, { conversationId: "synthetic-guest-browser-test" });
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto(`/guest/#${host.link}`);
  await host.send(welcomeFrame(false));

  const composer = page.getByPlaceholder("Prompt the host agent…");
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();
  await composer.click();
  await composer.fill(promptText);
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => host.prompts.join("\n")).toContain(promptText);
  const pending = page.locator(".sh-recoverable-prompt");
  await expect(pending).toContainText("Unconfirmed");
  await expect(pending).toContainText(promptText);
  await composer.fill(dismissText);
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => host.prompts.join("\n")).toContain(dismissText);
  await expect(page.locator(".sh-recoverable-prompt")).toHaveCount(2);

  await host.send({ t: "bye", reason: "Synthetic host ended session" });
  const ended = page.getByRole("alertdialog", { name: "session ended" });
  await expect(ended).toBeVisible();
  await expect(ended).toContainText("Session ended");
  await expect(ended).toContainText("Synthetic host ended session");

  const recovery = ended.locator(".sh-recoverable-prompt").filter({ hasText: promptText }).locator(".sh-recoverable-text");
  await expect(recovery).toContainText(promptText);
  const recoveryBox = await recovery.boundingBox();
  expect(recoveryBox).not.toBeNull();
  expect(recoveryBox!.height).toBeGreaterThan(24);
  expect(await recovery.evaluate(el => getComputedStyle(el).whiteSpace)).toBe("pre-wrap");
  expect(await recovery.evaluate(el => el.scrollHeight)).toBeGreaterThan(await recovery.evaluate(el => el.clientHeight));
  await recovery.selectText();
  expect(await page.evaluate(() => getSelection()?.toString())).toContain(promptText);

  const longRecovery = ended.locator(".sh-recoverable-prompt").filter({ hasText: promptText });
  for (const name of ["Recover", "Copy", "Dismiss"]) {
    const button = longRecovery.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box, `${name} target is laid out`).not.toBeNull();
    expect(box!.width, `${name} target width`).toBeGreaterThanOrEqual(24);
    expect(box!.height, `${name} target height`).toBeGreaterThanOrEqual(24);
  }
  const rejoin = ended.getByRole("button", { name: "Rejoin", exact: true });
  await expect(rejoin).toBeVisible();
  const rejoinBox = await rejoin.boundingBox();
  expect(rejoinBox, "Rejoin target is laid out").not.toBeNull();
  expect(rejoinBox!.width).toBeGreaterThanOrEqual(24);
  expect(rejoinBox!.height).toBeGreaterThanOrEqual(24);
  await mkdir(join(homedir(), ".cache/r32-e2e/shots"), { recursive: true });
  await page.screenshot({ path: join(homedir(), ".cache/r32-e2e/shots/guest-ended-375x667.png") });

  const rejoinPoint = { x: rejoinBox!.x + rejoinBox!.width / 2, y: rejoinBox!.y + rejoinBox!.height / 2 };
  expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest(".sh-ended") !== null, rejoinPoint), "ended overlay must not intercept its own Rejoin action").toBe(true);
  await longRecovery.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(ended).toContainText("Clipboard unavailable; select and copy prompt text manually.");
  await longRecovery.getByRole("button", { name: "Recover", exact: true }).click();
  const dismissedRecovery = ended.locator(".sh-recoverable-prompt").filter({ hasText: dismissText });
  await dismissedRecovery.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(dismissedRecovery).toHaveCount(0);
  await ended.getByRole("button", { name: "Rejoin", exact: true }).click();
  await host.send(welcomeFrame(false));
  await expect(page.getByRole("alertdialog", { name: "session ended" })).toHaveCount(0);
  await expect(page.getByPlaceholder("Prompt the host agent…")).toBeEnabled();
  expect(host.connections).toBeGreaterThan(1);
  expect(pageErrors).toEqual([]);
});
