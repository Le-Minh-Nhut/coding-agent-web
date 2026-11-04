#!/usr/bin/env bash
set -euo pipefail
unit=coding-agent-web.service
resolve_bin() { local found; found=$(command -v "$1") || return 1; readlink -f "$found"; }
node_path=$(resolve_bin node 2>/dev/null || true)
systemctl_path=$(resolve_bin systemctl 2>/dev/null || true)
tmux_path=$(resolve_bin tmux 2>/dev/null || true)
config=${CAW_CONFIG:-$(cd "$(dirname "$0")/.." && pwd)/caw.config.json}
port=unknown; state_dir=unknown; started=unknown
if [[ -n $systemctl_path ]]; then
  enabled_state=$("$systemctl_path" --user is-enabled "$unit" 2>/dev/null || true)
  case $enabled_state in enabled|enabled-runtime|disabled|disabled-runtime|static|indirect|masked|masked-runtime|generated|transient|linked|linked-runtime|alias) echo "enabled: $enabled_state";; *) echo 'enabled: unknown';; esac
  if state=$("$systemctl_path" --user is-active "$unit" 2>/dev/null); then echo "running: $state"; else case ${state:-unknown} in inactive) echo 'running: inactive';; failed) echo 'running: failed';; *) echo 'running: unknown';; esac; fi
  "$systemctl_path" --user show "$unit" -p MainPID -p ActiveEnterTimestamp -p MemoryCurrent -p CPUUsageNSec 2>/dev/null || echo 'service metrics: unknown'
  started=$("$systemctl_path" --user show "$unit" -p ActiveEnterTimestampMonotonic --value 2>/dev/null || echo unknown)
else
  echo 'enabled: unknown'; echo 'running: unknown'; echo 'service metrics: unknown'; started=unknown
fi
if [[ $started =~ ^[0-9]+$ ]] && now=$(awk '{printf "%.0f",$1*1000000}' /proc/uptime); then age=$(((now-started)/1000000)); ((age >= 0)) && echo "Service uptime: ${age}s" || echo 'Service uptime: unknown'; else echo 'Service uptime: unknown'; fi
if [[ -n $node_path ]]; then
  readarray -t values < <("$node_path" - "$config" "$(cd "$(dirname "$0")/.." && pwd)" <<'NODE'
const fs=require('node:fs'), path=require('node:path'), os=require('node:os');
try { const root=process.argv[3]; const c=fs.existsSync(process.argv[2])?JSON.parse(fs.readFileSync(process.argv[2],'utf8')):{}; console.log(c.port??8791); console.log(path.resolve(root,process.env.CAW_STATE_DIR??c.stateDir??path.join(os.homedir(),'.local/state/coding-agent-web'))); } catch { console.log('unknown\nunknown'); }
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
