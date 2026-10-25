import { expect, test, type Page } from "@playwright/test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { assertInsideHarnessTemp, createProjectFromBrowser, login, projectByLabel, readProjects, requireAppServer } from "./fixture.js";

/**
 * Projects: the folder browser is the only way a project enters the system, and
 * AGENTS.md hard rule 8 ("deleting a project never deletes files") is the claim
 * this file exists to protect.
 *
 * Labels carry a per-run suffix: the harness server keeps its state dir for the
 * whole Playwright process, so a second run would otherwise find two projects
 * with the same label and every locator would become ambiguous.
 */
const RUN = Date.now().toString(36).slice(-5);
const label = (name: string) => `${name} ${RUN}`;

/**
 * A project's actions live in the same card as its label. The card is located by
 * walking up from the accessible heading to the nearest ancestor that also holds
 * the actions, which keeps the locator independent of class names and markup depth.
 */
function projectCard(page: Page, label: string) {
  return page
    .getByRole("heading", { name: label, exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space(.)='Rename']][1]");
}

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("creating a project from the folder browser stores the chosen directory", async ({ page }) => {
  await login(page);
  await createProjectFromBrowser(page, "p-alpha", label("Alpha Label"));

  const project = await projectByLabel(page, label("Alpha Label"));
  assertInsideHarnessTemp(project.path);
  expect(project.path.endsWith("/p-alpha")).toBe(true);
  expect(statSync(project.path).isDirectory()).toBe(true);
});

test("renaming a project changes only the label, never the directory on disk", async ({ page }) => {
  await login(page);
  await createProjectFromBrowser(page, "p-beta", label("Beta Original"));

  const before = await projectByLabel(page, label("Beta Original"));
  expect(before.path.endsWith("/p-beta")).toBe(true);

  await projectCard(page, label("Beta Original")).getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("heading", { name: "Rename Project Label" })).toBeVisible();
  await page.getByRole("textbox").fill(label("Beta Renamed"));
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("heading", { name: label("Beta Renamed"), exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: label("Beta Original"), exact: true })).toBeHidden();

  const after = await projectByLabel(page, label("Beta Renamed"));
  expect(after.id).toBe(before.id);
  // The label is metadata; the path is the contract.
  expect(after.path).toBe(before.path);
  expect(existsSync(before.path)).toBe(true);
  expect(readdirSync(before.path.replace(/\/p-beta$/, ""))).toContain("p-beta");
});

test("favouriting a project keeps the path and survives a reload", async ({ page }) => {
  await login(page);
  await createProjectFromBrowser(page, "p-gamma", label("Gamma Label"));

  const before = await projectByLabel(page, label("Gamma Label"));
  expect(before.favorite).toBe(false);

  // The star button has no text label: its accessible name is the glyph it
  // renders, and `title` only supplies it when the element has no content.
  const star = projectCard(page, label("Gamma Label")).getByRole("button", { name: "☆", exact: true });
  await expect(star).toBeVisible();
  await star.click();
  await expect(projectCard(page, label("Gamma Label")).getByRole("button", { name: "★", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(projectCard(page, label("Gamma Label")).getByRole("button", { name: "★", exact: true })).toBeVisible();

  const after = await projectByLabel(page, label("Gamma Label"));
  expect(after.favorite).toBe(true);
  expect(after.path).toBe(before.path);
  expect(existsSync(before.path)).toBe(true);
});

test("deleting a project removes the metadata and keeps the directory on disk", async ({ page }) => {
  await login(page);
  await createProjectFromBrowser(page, "p-delta", label("Delta Label"));

  const project = await projectByLabel(page, label("Delta Label"));
  assertInsideHarnessTemp(project.path);
  expect(statSync(project.path).isDirectory()).toBe(true);

  await projectCard(page, label("Delta Label")).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Delete Project" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm Delete" }).click();

  await expect(page.getByRole("heading", { name: label("Delta Label"), exact: true })).toBeHidden();

  // The single most important assertion in the product: metadata gone, files untouched.
  expect(existsSync(project.path), `deleting a project must never remove ${project.path}`).toBe(true);
  expect(statSync(project.path).isDirectory()).toBe(true);

  const remaining = await readProjects(page);
  expect(remaining.some((item) => item.label === label("Delta Label"))).toBe(false);
});
