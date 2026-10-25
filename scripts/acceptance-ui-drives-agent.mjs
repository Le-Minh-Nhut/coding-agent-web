// M3 acceptance: OUR web UI drives a real OMP agent.
//
// Uses Playwright (already a repo dependency) rather than a new install. Boots no
// server of its own: it expects one already running at BASE with the real web
// build, so the operator sees exactly the deployment shape.
//
//   node scripts/acceptance-ui-drives-agent.mjs --base http://127.0.0.1:8801 --token-file /tmp/caw-final/token.txt
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const BASE = argValue("--base", "http://127.0.0.1:8801");
const TOKEN = readFileSync(argValue("--token-file", "/tmp/caw-final/token.txt"), "utf8").trim();
const ROOT = argValue("--root", "/tmp/caw-final/roots/proj");

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();

const logs = [];
page.on("console", (m) => logs.push(`[console:${m.type()}] ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message.slice(0, 300)}`));
const sockets = [];
page.on("websocket", (ws) => {
  const entry = { url: ws.url().split("?")[0], role: ws.url().includes("role=guest") ? "guest" : "other", closed: false };
  sockets.push(entry);
  ws.on("close", () => {
    entry.closed = true;
  });
});

let failed = false;
const step = (ok, label, detail = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// 1. Log in through the UI.
await page.goto(BASE, { waitUntil: "networkidle" });
await page.locator("input[type=password]").fill(TOKEN);
await page.keyboard.press("Enter");
await page.waitForTimeout(2500);
const projectsVisible = await page.locator("text=Projects").first().isVisible().catch(() => false);
step(projectsVisible, "login through the UI lands on the projects screen", page.url());

// 2. Discover or create the project, then create a conversation (which launches a real agent).
const workflow = await page.evaluate(async (root) => {
  const csrfRes = await fetch("/api/auth/me", { credentials: "include" });
  const csrf = (await csrfRes.json()).data?.csrfToken;
  if (!csrf) return { error: "no csrf token" };
  const H = { "content-type": "application/json", "x-caw-csrf": csrf };

  const projects = (await (await fetch("/api/projects", { credentials: "include" })).json()).data ?? [];
  let project = projects.find((p) => p.path === root);
  if (!project) {
    const created = await (await fetch("/api/projects", { method: "POST", credentials: "include", headers: H, body: JSON.stringify({ path: root, label: "Acceptance" }) })).json();
    if (!created.ok) return { error: `project: ${JSON.stringify(created.error)}` };
    project = created.data;
  }
  const conv = await (await fetch(`/api/projects/${project.id}/conversations`, { method: "POST", credentials: "include", headers: H, body: JSON.stringify({ title: "Acceptance run" }) })).json();
  return { projectId: project.id, conversation: conv };
}, ROOT);

if (workflow.error) {
  step(false, "create a project and conversation", workflow.error);
  await browser.close();
  process.exit(1);
}
const conversation = workflow.conversation;
step(conversation.ok, "conversation created (launches a real agent)", conversation.ok ? `tmux ${conversation.data.tmuxSessionId}` : JSON.stringify(conversation.error));
if (!conversation.ok) {
  await browser.close();
  process.exit(1);
}
const cid = conversation.data.id;
step(Boolean(conversation.data.nativeSessionId), "the agent published its native session", conversation.data.nativeSessionId ?? "none");
step(conversation.data.state === "idle" || conversation.data.state === "running", "state reflects a live agent", conversation.data.state);

// 3. Ask for a live link the way the UI does.
const link = await page.evaluate(async (id) => {
  const csrf = (await (await fetch("/api/auth/me", { credentials: "include" })).json()).data?.csrfToken;
  const r = await fetch(`/api/conversations/${id}/link`, { method: "POST", credentials: "include", headers: { "x-caw-csrf": csrf } });
  const body = await r.json();
  return { status: r.status, ok: body.ok, code: body.ok ? null : body.error.code, urlPrefix: body.ok ? body.data.url.split("#")[0] : null, secretBytes: body.ok ? body.data.url.split("#")[1].length : null, access: body.ok ? body.data.access : null };
}, cid);
step(link.ok, "a live session link is minted", JSON.stringify(link));

// 4. Open it in the UI the way a user does, and watch for a guest socket.
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.locator(".card").filter({ hasText: ROOT }).first().click();
await page.waitForTimeout(2500);
const running = page.locator(".card").filter({ hasText: "Acceptance run" });
await running.first().click();
await page.waitForTimeout(9000);

const guestSockets = sockets.filter((s) => s.role === "guest");
step(guestSockets.length > 0, "our UI opened a guest socket to the relay", guestSockets.map((s) => s.url).join(", ") || "none");

const body = await page.locator("body").innerText();
const connected = /Connected — no turn in flight|Agent is working on a turn/i.test(body) && !/No live agent to attach to/i.test(body);
step(connected, "the conversation screen reports a live session", body.split("\n").filter(Boolean).slice(0, 6).join(" | "));

console.log("\n--- console/errors seen ---");
for (const line of logs.slice(-12)) console.log("   " + line);
console.log("\n--- websockets ---");
for (const s of sockets) console.log(`   ${s.role} ${s.url} ${s.closed ? "(closed)" : "(open)"}`);

await page.screenshot({ path: "/tmp/caw-final/our-ui.png" });
console.log("\nscreenshot: /tmp/caw-final/our-ui.png");
await browser.close();
process.exit(failed ? 1 : 0);
