import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { assertInsideHarnessTemp, assertNoUnexpectedAppErrors, declareInjectedFault, harnessFixture, login, requireAppServer } from "./fixture.js";

/**
 * K1 end-to-end proof: no real agent can be started by this harness.
 *
 * The harness sets `CAW_OMP_BINARY_PATH`, which now pins the binary *every* `omp`
 * call the server makes — the Collab registry read, the model catalog, the
 * capability probe and the command tmux is asked to launch. Before that pin, a
 * create-chat resolved a bare `omp` from PATH and started a real agent on any
 * machine with OMP installed: the owner's config, the owner's sessions, their
 * credits.
 *
 * Two independent recorders turn that into evidence rather than a claim:
 *
 *  - the pinned stub `omp` appends `{exe, argv}` for every invocation that is not
 *    the registry read, so the executed path itself is checkable;
 *  - a PATH canary directory holds a competing executable named `omp` and is
 *    prepended to PATH, so a regression back to bare-name resolution writes to the
 *    canary log instead of starting an agent.
 *
 * Neither recorder runs a model: the stub exits 1 immediately, which is why a
 * created conversation settles as a failure rather than as a running agent.
 */

interface StubRecord {
  exe: string;
  argv: string[];
}

/** Every invocation the stub recorded; an absent log means only the registry read ran. */
function stubRecords(path: string): StubRecord[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (text === "") return [];
  return text.split("\n").map((line) => JSON.parse(line) as StubRecord);
}

function canaryLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
}

/** The launch path needs a tmux to spawn into; without one the stub is never reached. */
function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Every recorded invocation ran the pinned stub, never a bare `omp` from PATH. */
function assertEveryInvocationWasTheStub(fixture: ReturnType<typeof harnessFixture>, records: readonly StubRecord[]): void {
  expect(existsSync(fixture.stubOmpPath), "the pinned stub binary exists").toBe(true);
  assertInsideHarnessTemp(fixture.stubOmpPath);
  for (const record of records) {
    expect(record.exe, "the executed binary is the pinned stub").toBe(fixture.stubOmpPath);
  }
  // The canary is the proof no code path resolved a bare `omp` from PATH.
  expect(canaryLines(fixture.canaryLogPath), "no bare `omp` was executed").toEqual([]);
}

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("registry and model catalog calls all run the pinned stub; the PATH canary stays empty", async ({ page }) => {
  const fixture = harnessFixture();
  await login(page);

  // The registry route is the one omp call a plain page load makes. The launcher
  // creates the registry directory, so this exercises the "directory exists, ask
  // the binary" branch rather than the ENOENT short-circuit.
  const sessions = await page.request.get(`/api/projects/${fixture.seededProjectId}/sessions`);
  expect(sessions.status()).toBe(200);
  expect(((await sessions.json()) as { data?: unknown }).data, "a stubbed registry answers 200 with zero hosts").toEqual([]);
  expect(existsSync(fixture.registryDir), "the harness registry directory exists").toBe(true);
  expect(statSync(fixture.registryDir).isDirectory(), "the harness registry path is a directory").toBe(true);

  // The model catalog is a second omp exec site; the pin must cover it too.
  const models = await page.request.get("/api/models");
  expect(models.status()).toBe(200);

  const records = stubRecords(fixture.stubLogPath);
  console.log("K1 e2e recorder (registry/models)", JSON.stringify({ records, canary: canaryLines(fixture.canaryLogPath) }));
  assertEveryInvocationWasTheStub(fixture, records);
  expect(records.some((record) => record.argv[0] === "models"), "the model catalog ran the pinned stub").toBe(true);

  await assertNoUnexpectedAppErrors(page);
});

test("a chat created through the UI launches only the pinned stub and settles as an honest failure", async ({ page }) => {
  // The launch path spawns into a tmux session, so without a tmux binary the pin
  // cannot be exercised here at all. That is reported as a skip, not a pass.
  test.skip(!tmuxAvailable(), "no tmux on this machine: the launch path cannot be reached, so the pin is covered by tests/server/round19-harness-record-auditor.test.ts instead");

  const fixture = harnessFixture();
  await login(page);

  // The created conversation is opened by the app as soon as it exists. It has no
  // native session and no live writer, so its history answers 404 and its link 409
  // — the states the screen is built to render, declared here rather than
  // forgiven by a blanket rule.
  declareInjectedFault(page, { urlPattern: /\/api\/conversations\/[^/]+\/history/, status: 404 });
  declareInjectedFault(page, { urlPattern: /\/api\/conversations\/[^/]+\/link/, status: 409 });

  await page.getByRole("heading", { name: "Seeded Fixture", exact: true }).click();
  const newChat = page.getByRole("button", { name: "+ New chat" });
  const startFirst = page.getByRole("button", { name: "Start first chat" });
  await expect(newChat.or(startFirst)).toBeVisible({ timeout: 15_000 });
  const countNewChats = async () => {
    const response = await page.request.get(`/api/projects/${fixture.seededProjectId}/conversations`);
    const rows = ((await response.json()) as { data?: Array<{ title: string }> }).data ?? [];
    return rows.filter((row) => row.title === "New chat").length;
  };
  const newChatRowsBefore = await countNewChats();
  await (newChat.or(startFirst)).first().click();

  // The stub is handed `--config=<overlay>` as the launched agent; wait for that
  // record rather than for the UI, which reports the failure asynchronously.
  await expect.poll(() => stubRecords(fixture.stubLogPath).some((record) => record.argv.some((arg) => arg.startsWith("--config="))), {
    message: "the created chat must have started the pinned stub",
    timeout: 20_000,
  }).toBe(true);

  const records = stubRecords(fixture.stubLogPath);
  console.log("K1 e2e recorder (launch)", JSON.stringify({ records, canary: canaryLines(fixture.canaryLogPath) }));
  assertEveryInvocationWasTheStub(fixture, records);

  // The created row must not claim to be running an agent. A freshly created row
  // is `starting` while the supervisor waits for the (immediately dying) stub, so
  // wait for the *newly created* row to settle rather than sampling mid-launch.
  // The count taken before the click identifies which rows this test created: the
  // app hardcodes the title "New chat", and a reused server may already hold one.
  //
  // Both settled outcomes are honest: `error` with the status detail from the
  // supervisor. `running` — or staying `starting` — would mean a real agent.
  const readNewChatRows = async () => {
    const response = await page.request.get(`/api/projects/${fixture.seededProjectId}/conversations`);
    const rows = ((await response.json()) as { data?: Array<{ title: string; state: string; statusDetail: string | null }> }).data ?? [];
    return rows.filter((row) => row.title === "New chat");
  };

  await expect.poll(async () => {
    const rows = await readNewChatRows();
    return rows.length > newChatRowsBefore && rows.every((row) => row.state !== "starting");
  }, { message: "the row created by this test must settle out of `starting`", timeout: 20_000 }).toBe(true);

  const createdRows = await readNewChatRows();
  expect(createdRows.length, "a conversation was created through the UI").toBeGreaterThan(newChatRowsBefore);
  for (const row of createdRows) {
    // `running` or `idle` would mean a live host published for this row — i.e. a real
    // agent. A stub launch can only ever settle as a dead process (`error`, or
    // `stopped` when the supervisor undoes an unrecordable launch, `unknown` when the
    // outcome could not be classified), and always with a reason attached.
    expect(["running", "idle"], `row ${row.state} must not be live`).not.toContain(row.state);
    expect(["error", "stopped", "unknown"]).toContain(row.state);
    expect(row.statusDetail, "the failure is explained, not silent").toBeTruthy();
  }

  await assertNoUnexpectedAppErrors(page);
});
