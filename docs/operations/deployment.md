# systemd user deployment

Run service as normal Ubuntu account. Installer never uses sudo and refuses root.

## Prerequisites and configuration

Install Node.js 20.19+, pnpm, OMP (`omp`), and tmux. Installer resolves their executable paths and sets service `PATH` to those four directories plus `/usr/bin:/bin`. This lets the service resolve `omp` and `tmux`; agents launched in tmux inherit the same PATH. To expose another tool, place or link it in one of those PATH directories; installer provides no separate PATH extension setting.

Create valid repo-root `caw.config.json` or set `CAW_CONFIG` to its absolute path. Keep `host` loopback (`127.0.0.1`), set `publicOrigin` to an absolute HTTP(S) origin without path/query/fragment, and list existing absolute `allowedRoots`. Installer backs up and changes only `maxActiveAgents` to `3` if necessary. Do not put secrets in config. Keep the state directory owner-private: it contains the first-run setup token file.

## Initial install and auto-start

From repository:

```bash
./deploy/install.sh
```

Installer checks config and dependencies, builds missing guest/web assets (or always with `./deploy/install.sh --build`), installs the user unit, and enables it. `INSTALLED: <unit>` means unit file installed; `ENABLED: yes` means enabled for user-manager startup. `STARTED: yes` means installer started service; `STARTED: no (already active)` means service was already active; `STARTED: no (existing service left running)` means existing active service was preserved after a unit change. `HEALTHY: yes` is printed only after `/api/auth/me` returns HTTP 401, confirming app identity rather than merely an HTTP responder. `PENDING_RESTART: yes` means changed unit could not take effect on the running service; apply it with `systemctl --user restart coding-agent-web`. An inactive unit with a server already answering on its port is refused: installer will not start a second server.
## First-run setup

On first boot the server prints the **path** of the one-time token (`Coding Agent Web first-run setup token written to <path>; read it with: cat <path>`), never the token itself. Read the file before setup:

```bash
cat "$HOME/.local/state/coding-agent-web/setup-token"
```

This is the default state directory; if `stateDir` is configured, run `cat <stateDir>/setup-token` instead. File mode is `0600` (owner-only). Token expires after 15 minutes and is single-use. A boot with a pending, unused, unexpired token does not mint or rewrite it. Successful password setup removes the token file. Keep state directory owner-private; reading token is first step of first-run setup.

## Service and agents

The unit runs the server entrypoint directly with `KillMode=process`. Agents survive `systemctl --user restart` and `systemctl --user stop`; backend re-adopts them by reconciliation on next start. A stop leaves agents running but unmanaged. Inspect private tmux socket at `<stateDir>/tmux.sock` (default: `$HOME/.local/state/coding-agent-web/tmux.sock`).

For startup without an interactive login, enable lingering:

```bash
loginctl enable-linger "$USER"
```

This is a privileged host policy change because systemd must keep your user manager alive after logout; ask administrator if command is denied. No service runs as root.

## Operations

```bash
systemctl --user start coding-agent-web
systemctl --user stop coding-agent-web
systemctl --user restart coding-agent-web
journalctl --user -u coding-agent-web -f
journalctl --user -u coding-agent-web -g 'configuration loaded' -n 1
./deploy/status.sh
./deploy/benchmark-idle.sh --interval 60
```

Benchmark validity: zero-agent state must be positively established; an unreachable private tmux socket is `unknown`, not zero agents. Cgroup `MemoryCurrent` and `CPUUsageNSec` cover whole service cgroup, including pnpm wrapper and descendants; RSS and threads describe systemd `MainPID` only. PID/cgroup changes or a CPU counter reset make sample unknown. See `./deploy/benchmark-idle.sh --help`; measurement also refuses missing metrics, incomplete `/proc` data, or agents appearing during interval.

## Updating

```bash
git pull
pnpm install
node scripts/build-guest.mjs
pnpm --filter @caw/web build
systemctl --user restart coding-agent-web
```

Do not update/restart while actively using app or agents. Only one server may bind port 8791.

## Uninstall

```bash
./deploy/uninstall.sh --dry-run
./deploy/uninstall.sh            # confirmation prompt
./deploy/uninstall.sh --yes      # non-interactive
```

Uninstall disables and stops the unit, then removes only the rendered unit file. It first enumerates agents on the private tmux socket; unreachable socket is reported as `unknown`, not “no agents.” Live agents trigger a loud warning before action and remain running unmanaged. Non-interactive use requires `--yes`; without it the command fails without changes. Failed `systemctl --user disable --now` is a hard failure and never prints `SUCCESS`. On success, `STILL PRESENT` names agents, state dir, config, and unchanged Tailscale Serve rules. Source, OMP journals/history, auth records, state directory, config, and Tailscale rules are not deleted.

## Tailscale connectivity

Keep app bound to loopback. Configure Serve separately to proxy **only** `127.0.0.1:8791`, and set `publicOrigin` to matching tailnet HTTPS origin. `relayPort` (8792) must never be proxied. Funnel must never be enabled. Check read-only Serve state with `tailscale serve status`.

## Recovery and rollback

After reboot, check `systemctl --user is-enabled coding-agent-web` and `./deploy/status.sh`. If it is enabled but not running, inspect journal before starting; verify private tmux socket and reconcile status rather than killing or recreating agents. Never manually start a second server while the service owns port 8791.

To roll back application code, check out the prior known-good revision, reinstall dependencies/build assets, then restart the service. Restore a config backup only after reviewing it; installer backup uses timestamped `.bak` suffix.

## Troubleshooting

- **Missing binary in PATH:** run `command -v node pnpm omp tmux`; make paths available to installer, then rerun. Unit captures discovered paths.
- **Port 8791 already in use:** inspect `./deploy/status.sh` and `ss -ltnp`; stop only the server you own. Installer refuses to start over an unrelated listener.
- **Config not found/invalid:** provide repo-root `caw.config.json` or absolute `CAW_CONFIG`; check JSON, loopback host, origin, and allowed roots.
- **Service crash-loop:** inspect `systemctl --user status coding-agent-web` and `journalctl --user -u coding-agent-web -n 100 --no-pager`; verify Node, pnpm, OMP, tmux paths and config. Unit rate limits repeated starts.
- **Manual server working directory:** start the server from the repository root. Deploy scripts resolve relative `stateDir`/`CAW_STATE_DIR` paths from that root, while the server resolves `stateDir` from its own working directory; if they differ, `status.sh`, `benchmark-idle.sh`, or `uninstall.sh` can miss the private tmux socket and report zero managed agents while agents are running.
- **Tailscale Serve not proxying:** `tailscale serve status`; confirm Serve targets port 8791, `publicOrigin` matches HTTPS origin, and Tailscale is connected. Never proxy 8792 or enable Funnel.
