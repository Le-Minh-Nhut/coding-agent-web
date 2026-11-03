#!/usr/bin/env bash
set -euo pipefail
unit=coding-agent-web.service
resolve_bin() { local name found; found=$(command -v "$1") || return 1; if [[ $found != /* ]]; then found=$(readlink -f "$found") || return 1; fi; [[ -x $found ]] || return 1; printf '%s\n' "$found"; }
node_path=$(resolve_bin node) || { echo 'Config reader unavailable: node executable not found/resolvable.' >&2; exit 1; }
systemctl_path=$(resolve_bin systemctl) || { echo 'systemctl executable not found/resolvable.' >&2; exit 1; }
tmux_path=$(resolve_bin tmux 2>/dev/null || true)
config=${CAW_CONFIG:-$(cd "$(dirname "$0")/.." && pwd)/caw.config.json}
"$systemctl_path" --user is-enabled "$unit" 2>/dev/null || echo 'enabled: unknown'
"$systemctl_path" --user is-active "$unit" 2>/dev/null || echo 'running: unknown'
"$systemctl_path" --user show "$unit" -p MainPID -p ActiveEnterTimestamp -p MemoryCurrent -p CPUUsageNSec 2>/dev/null || echo 'service metrics: unknown'
started=$("$systemctl_path" --user show "$unit" -p ActiveEnterTimestampMonotonic --value 2>/dev/null || echo unknown)
if [[ $started =~ ^[0-9]+$ ]] && now=$(awk '{printf "%.0f",$1*1000000}' /proc/uptime); then
  age=$(((now-started)/1000000)); ((age >= 0)) && echo "Service uptime: ${age}s" || echo 'Service uptime: unknown'
else echo 'Service uptime: unknown'; fi
if [[ -r $config ]]; then
  readarray -t values < <("$node_path" - "$config" <<'NODE'
const fs=require('node:fs'); try { const c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); console.log(c.port??8791); console.log(c.stateDir??`${process.env.HOME}/.local/state/coding-agent-web`); } catch { console.log('unknown\nunknown'); }
NODE
)
  port=${values[0]:-unknown}; state_dir=${values[1]:-unknown}
else echo 'config: unknown'; fi
if [[ $port != unknown ]] && code=$(curl --silent --output /dev/null --max-time 2 --write-out '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null); then echo "HTTP readiness: $code"; else echo 'HTTP readiness: unknown'; fi
if command -v tailscale >/dev/null 2>&1; then tailscale serve status || echo 'Tailscale Serve: unknown'; else echo 'Tailscale Serve: unknown (tailscale unavailable)'; fi
if [[ $state_dir != unknown && -n $tmux_path ]]; then
  if sessions=$("$tmux_path" -S "$state_dir/tmux.sock" list-sessions -F '#{session_id}' 2>/dev/null); then printf 'Managed main OMP agents: %s\n' "$(printf '%s\n' "$sessions" | awk 'NF {n++} END {print n+0}')"; else echo 'Managed main OMP agents: unknown'; fi
else echo 'Managed main OMP agents: unknown'; fi
journalctl --user -u "$unit" -p warning..alert -n 20 --no-pager 2>/dev/null || echo 'Recent journal errors: unknown'
