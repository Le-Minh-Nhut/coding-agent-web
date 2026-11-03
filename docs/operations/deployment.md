# systemd user deployment

Run service as normal Ubuntu account. Installer never uses sudo and refuses root.

## Prerequisites and configuration

Install Node.js 20.19+, pnpm, OMP (`omp`), and tmux. All four executable paths must be discoverable at install time; installer records absolute paths and supplies an explicit service `PATH`.

Create valid repo-root `caw.config.json` or set `CAW_CONFIG` to its absolute path. Keep `host` loopback (`127.0.0.1`), set `publicOrigin` to an absolute HTTP(S) origin without path/query/fragment, and list existing absolute `allowedRoots`. Installer backs up and changes only `maxActiveAgents` to `3` if necessary. Do not put secrets in config.

## Initial install and auto-start

From repository:

```bash
./deploy/install.sh
```

Installer checks config and dependencies, builds missing guest/web assets (or always with `./deploy/install.sh --build`), installs user unit, enables it, starts only if port is not already occupied, then checks activity and HTTP readiness.

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

Benchmark requires no managed OMP agents and refuses to call result idle when private-socket status cannot be verified. `MemoryCurrent` is cgroup-wide charged memory; process RSS is resident memory of main PID, so values differ. Optional output: `./deploy/benchmark-idle.sh --out idle.txt`.

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

Uninstall removes only the rendered unit file. It leaves source, config, state directory, OMP journals, auth records, and Tailscale rules untouched; it does not kill running agents.

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
- **Tailscale Serve not proxying:** `tailscale serve status`; confirm Serve targets port 8791, `publicOrigin` matches HTTPS origin, and Tailscale is connected. Never proxy 8792 or enable Funnel.
