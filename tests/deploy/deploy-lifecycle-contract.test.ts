import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { hermeticEnv } from "../test-env.js";

/**
 * The deploy artifacts' lifecycle contract.
 *
 * The invariant these guard: a backend stop or restart must never end a managed
 * agent's life. systemd's default `KillMode=control-group` SIGTERMs every process
 * in the service cgroup, and the app launches tmux servers (and the OMP children
 * inside them) in exactly that cgroup — so the default silently kills live agents
 * the app is built to adopt after a restart. Two properties make that impossible:
 *
 *   1. `KillMode=process`, so stop signals the main process only.
 *   2. the main process IS the server (its own SIGTERM handler), not a `pnpm`
 *      shell shim that forks and exits — otherwise "stop" leaves the HTTP server
 *      holding its port while the unit reports `inactive`.
 *
 * UNSINSTALL_* env overrides exist so the same assertions can be pointed at the
 * pre-fix artifacts to prove they fail there; they default to the repo files.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const installPath = process.env.R40_INSTALL_SCRIPT ?? join(repoRoot, "deploy/install.sh");
const unitTemplatePath = process.env.R40_UNIT_TEMPLATE ?? join(repoRoot, "deploy/systemd/coding-agent-web.service");
const uninstallPath = process.env.R40_UNINSTALL_SCRIPT ?? join(repoRoot, "deploy/uninstall.sh");

const dirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
/** Render the unit template the way deploy/install.sh does. */
function renderUnit(): string {
  const values: Record<string, string> = {
    "@REPO_ROOT@": repoRoot,
    "@CONFIG_PATH@": join(repoRoot, "caw.config.json"),
    "@PATH_VALUE@": "/usr/bin:/bin",
    "@PNPM_PATH@": "/home/example/.local/share/pnpm/pnpm",
    "@STATE_DIR@": "/home/example/.local/state/coding-agent-web",
  };
  return readFileSync(unitTemplatePath, "utf8").replace(/@(?:REPO_ROOT|CONFIG_PATH|PATH_VALUE|PNPM_PATH|STATE_DIR)@/g, (key) => values[key] ?? key);
}

describe("systemd environment contract", () => {
  it("pins installer-validated state directory and unsets only ambient overrides", () => {
    const directives = renderUnit().split("\n").map((line) => line.trim());
    expect(directives).toContain("Environment=CAW_STATE_DIR=/home/example/.local/state/coding-agent-web");
    const unset = directives.find((line) => line.startsWith("UnsetEnvironment="));
    expect(unset).toContain("CAW_MAX_ACTIVE_AGENTS");
    expect(unset).not.toMatch(/\bCAW_CONFIG\b|\bCAW_STATE_DIR\b/);
    expect(readFileSync(unitTemplatePath, "utf8")).toContain("UnsetEnvironment runs after Environment; never list CAW_CONFIG or CAW_STATE_DIR here.");
  });

  it("rejects percent and newline in substituted installer values", () => {
    expect(readFileSync(installPath, "utf8")).toMatch(/value != \*%\* && \$value != \*\$'\\n'\*/);
  });
});

describe("systemd unit lifecycle contract", () => {
  it("stops the unit with KillMode=process so the cgroup kill cannot reach managed agents", () => {
    const directives = renderUnit()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("["));
    expect(directives).toContain("KillMode=process");
  });

  it("lets WantedBy=default.target provide target ordering without an explicit reverse edge", () => {
    const directives = renderUnit()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("["));
    expect(directives).toContain("WantedBy=default.target");
    expect(directives).not.toContain("After=default.target");
  });

  it("makes the server itself the main process, not a pnpm shim that outlives SIGTERM", () => {
    const execStart = /^ExecStart=(.*)$/m.exec(renderUnit());
    expect(execStart).not.toBeNull();
    const command = execStart![1]!.trim();
    // The server entrypoint must be the thing systemd execs, so the app's own
    // SIGTERM handler runs and holds the port only while the backend is up.
    expect(command).toMatch(/apps\/server\/src\/server\.ts/);
    // `pnpm start` forks a shell tree and does not forward the signal: the shim
    // dies, the server lives on, and the unit lies about being stopped.
    expect(command).not.toMatch(/\bpnpm\b/);
  });

  it("has no ordering cycle with default.target when the unit is enabled", () => {
    let systemdAnalyze = true;
    try {
      execFileSync("systemd-analyze", ["--version"], { stdio: "ignore" });
    } catch {
      systemdAnalyze = false;
    }
    if (!systemdAnalyze) return; // environment without systemd-analyze: structural checks above still hold

    const dir = scratch("caw-unit-");
    const unitPath = join(dir, "coding-agent-web.service");
    writeFileSync(unitPath, renderUnit());
    mkdirSync(join(dir, "default.target.wants"));
    symlinkSync("../coding-agent-web.service", join(dir, "default.target.wants/coding-agent-web.service"));
    // [Install] WantedBy= creates this Wants edge; systemd.target's default
    // dependencies complement it with After=service. Model that effective edge
    // here, so the old service's After=default.target is a real detectable cycle.
    writeFileSync(join(dir, "default.target"), "[Unit]\nDescription=Scratch default target\nWants=coding-agent-web.service\nAfter=coding-agent-web.service\n");
    const verify = (paths: string[]) => {
      try {
        return execFileSync("systemd-analyze", ["--user", "verify", ...paths], {
          encoding: "utf8",
          env: { ...process.env, SYSTEMD_UNIT_PATH: `${dir}:/usr/lib/systemd/user:/etc/systemd/user` },
        });
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
      }
    };
    const paths = [join(dir, "default.target"), unitPath];
    expect(verify(paths)).not.toMatch(/ordering cycle|cyclic/i);

    // Positive control: same verifier must reject an actual pairwise ordering cycle.
    writeFileSync(join(dir, "cycle-a.service"), "[Unit]\nDescription=A\nRequires=cycle-b.service\nAfter=cycle-b.service\n[Service]\nType=simple\nExecStart=/bin/sleep 1\n");
    writeFileSync(join(dir, "cycle-b.service"), "[Unit]\nDescription=B\nRequires=cycle-a.service\nAfter=cycle-a.service\n[Service]\nType=simple\nExecStart=/bin/sleep 1\n");
    expect(verify([join(dir, "cycle-a.service"), join(dir, "cycle-b.service")])).toMatch(/ordering cycle|cyclic/i);
  });
});

describe("uninstall.sh fail-safe behaviour", () => {
  interface Harness {
    dir: string;
    calls: string;
    tmuxCalls: string;
    stateOverride?: string;
    nodeMissing?: boolean;
    tmuxLog: () => string;
  }
  

  /** A scratch HOME/XDG_CONFIG_HOME with a fake systemctl and fake tmux on PATH. */
  function harness(options: { liveSessions: number; disableFails?: boolean; stateDir?: string; stateOverride?: string; configText?: string; nodeMissing?: boolean }): Harness {
    const dir = scratch("caw-uninstall-");
    const bin = join(dir, "bin");
    const calls = join(dir, "systemctl.calls");
    const tmuxCalls = join(dir, "tmux.calls");
    const utils = join(dir, "utils");
    mkdirSync(utils);
    for (const tool of ["awk", "bash", "cat", "dirname"]) symlinkSync(`/usr/bin/${tool}`, join(utils, tool));
    mkdirSync(bin, { recursive: true });
    writeFileSync(calls, "");
    writeFileSync(tmuxCalls, "");
    writeFileSync(join(dir, "sessions.count"), `${options.liveSessions}\n`);
    writeFileSync(join(dir, "caw.config.json"), options.configText ?? JSON.stringify({ stateDir: options.stateDir ?? join(dir, "state") }));

    const shim = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
if [ "$1" = "--user" ] && [ "$2" = "disable" ] && [ "$3" = "--now" ]; then
  exit ${options.disableFails ? 1 : 0}
fi
exit 0
`;
    writeFileSync(join(bin, "systemctl"), shim);
    chmodSync(join(bin, "systemctl"), 0o755);

    writeFileSync(
      join(bin, "tmux"),
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(tmuxCalls)}
n=$(cat ${JSON.stringify(join(dir, "sessions.count"))})
i=0
while [ "$i" -lt "$n" ]; do
  printf '$%s\\n' "$i"
  i=$((i + 1))
done
exit 0
`,
    );
    chmodSync(join(bin, "tmux"), 0o755);
    mkdirSync(join(dir, "config/systemd/user"), { recursive: true });
    writeFileSync(join(dir, "config/systemd/user/coding-agent-web.service"), "[Unit]\\nDescription=x\\n");
    return { dir, calls, tmuxCalls, stateOverride: options.stateOverride, nodeMissing: options.nodeMissing, log: () => readFileSync(calls, "utf8"), tmuxLog: () => readFileSync(tmuxCalls, "utf8") };

  }

  function run(harnessState: Harness, args: string[]): { status: number; stdout: string; stderr: string } {
    const nodeBin = dirname(process.execPath);
    try {
      const result = execFileSync("bash", [uninstallPath, ...args], {
        cwd: harnessState.dir,
        encoding: "utf8",
        env: hermeticEnv({
          HOME: harnessState.dir,
          ...(harnessState.stateOverride ? { CAW_STATE_DIR: harnessState.stateOverride } : {}),
          CAW_CONFIG: join(harnessState.dir, "caw.config.json"),
          PATH: harnessState.nodeMissing ? `${join(harnessState.dir, "bin")}:${join(harnessState.dir, "utils")}` : `${join(harnessState.dir, "bin")}:${nodeBin}:/usr/bin:/bin`,
        }),
      });
      return { status: 0, stdout: result, stderr: "" };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { status: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  it("with live agents and no --yes on a non-tty, refuses and never disables the unit", () => {
    const state = harness({ liveSessions: 2 });
    const result = run(state, []);
    expect(result.status).not.toBe(0);
    expect(state.log()).not.toMatch(/disable/);
    expect(`${result.stdout}${result.stderr}`).toMatch(/--yes/);
    // The refusal must be because it SAW the agents, not because it looked away.
    expect(`${result.stdout}${result.stderr}`).toMatch(/2 managed OMP agent/);
  });

  it("with live agents and --yes, disables the unit and states plainly what remains running", () => {
    const state = harness({ liveSessions: 2 });
    const result = run(state, ["--yes"]);
    expect(result.status).toBe(0);
    expect(state.log()).toMatch(/disable --now/);
    expect(result.stdout).toMatch(/STILL PRESENT/);
    expect(result.stdout).toMatch(/agents: 2/);
    expect(result.stdout).toMatch(/state dir/);
    expect(result.stdout).toMatch(/Tailscale/);
  });

  it("never prints SUCCESS when the disable fails", () => {
    const state = harness({ liveSessions: 0, disableFails: true });
    const result = run(state, ["--yes"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toMatch(/SUCCESS/);
    expect(result.stderr).toMatch(/FAIL/);
  });

  it("--dry-run changes nothing and names what would be left untouched", () => {
    const state = harness({ liveSessions: 1 });
    const result = run(state, ["--dry-run"]);
    expect(result.status).toBe(0);
    expect(state.log()).toBe("");
    expect(result.stdout).toMatch(/Managed agents/);
    expect(result.stdout).toMatch(/untouched/);
  });
  it("resolves relative config stateDir against repo root from another cwd", () => {
    const state = harness({ liveSessions: 1, stateDir: "relative-state" });
    const result = run(state, ["--dry-run"]);
    expect(result.status).toBe(0);
    expect(state.tmuxLog()).toContain(`-S ${join(repoRoot, "relative-state", "tmux.sock")}`);
    expect(state.tmuxLog()).not.toContain(`-S ${join(state.dir, "relative-state", "tmux.sock")}`);
  });

  it("uses CAW_STATE_DIR before config stateDir", () => {
    const state = harness({ liveSessions: 1, stateDir: "config-state", stateOverride: "override-state" });
    const result = run(state, ["--dry-run"]);
    expect(result.status).toBe(0);
    expect(state.tmuxLog()).toContain(`-S ${join(repoRoot, "override-state", "tmux.sock")}`);
    expect(state.tmuxLog()).not.toContain("config-state/tmux.sock");
  });
  it("invalid JSON reports unknown state and refuses disable without --yes", () => {
    const state = harness({ liveSessions: 1, configText: "{invalid json" });
    const result = run(state, []);
    expect(result.status).not.toBe(0);
    expect(state.log()).not.toMatch(/disable/);
    expect(`${result.stdout}${result.stderr}`).toMatch(/UNKNOWN/);
    expect(`${result.stdout}${result.stderr}`).toMatch(/requires --yes/);
  });

  it("dry-run works without Node and reports state directory unknown", () => {
    const state = harness({ liveSessions: 1, nodeMissing: true });
    const result = run(state, ["--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Would stop and disable/);
    expect(result.stdout).toMatch(/state directory unknown/);
    expect(result.stdout).toMatch(/Would leave untouched/);
  });
});
describe("status.sh service state reporting", () => {
  it.each([
    ["disabled", "disabled", "enabled: disabled", "running: inactive"],
    ["enabled but inactive", "enabled", "enabled: enabled", "running: inactive"],
    ["missing unit", "not-found", "enabled: unknown", "running: unknown"],
  ])("reports %s without conflating enabled and running", (_label, enabled, expectedEnabled, expectedRunning) => {
    const dir = scratch("caw-status-");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const script = join(repoRoot, "deploy/status.sh");
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh
case "$*" in
  *" is-enabled "*) printf '%s\\n' ${JSON.stringify(enabled)}; [ ${JSON.stringify(enabled)} = enabled ];;
  *" is-active "*) if [ ${JSON.stringify(enabled)} = not-found ]; then printf '%s\\n' unknown; exit 4; else printf '%s\\n' inactive; exit 3; fi;;
  *" show "*) exit 0;;
esac
exit 0
`);
    chmodSync(join(bin, "systemctl"), 0o755);
    const result = execFileSync("bash", [script], {
      cwd: dir,
      encoding: "utf8",
      env: hermeticEnv({ PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, CAW_CONFIG: join(dir, "missing-config") }),
    });
    expect(result).toContain(expectedEnabled);
    expect(result).toContain(expectedRunning);
  });
});
