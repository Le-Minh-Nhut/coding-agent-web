#!/usr/bin/env bash
# Removes the systemd unit only. Never an agent, never application data.
#
# Two rules this script exists to keep:
#   * It must not report success after a critical step failed. The old shape ran
#     `systemctl --user disable --now "$unit" || true` and then printed SUCCESS
#     unconditionally, so a failed disable looked like a clean uninstall.
#   * It must say what it is about to disturb *before* disturbing it. The unit's
#     cgroup holds the tmux server and every OMP agent the app launched; if live
#     agents exist the operator hears about it first, and without --yes nothing
#     destructive happens until they confirm.
set -euo pipefail
unit=coding-agent-web.service
unit_file=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit
repo_root=$(cd "$(dirname "$0")/.." && pwd)
config_file=${CAW_CONFIG:-$repo_root/caw.config.json}
dry=0; yes=0
for arg in "$@"; do case $arg in --dry-run) dry=1;; --yes) yes=1;; *) echo 'Usage: uninstall.sh [--dry-run] [--yes]' >&2; exit 2;; esac; done
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# State resolution status is explicit: an unreadable/invalid config is not the
# same as an absent config, and neither may be mistaken for zero agents.
state_status=unknown; state_dir=''; socket=''; state_reason=''
if node_path=$(command -v node 2>/dev/null); then
  resolved=$("$node_path" - "$config_file" "$repo_root" "$HOME/.local/state/coding-agent-web" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const [configFile, root, fallback] = process.argv.slice(2);
if (process.env.CAW_STATE_DIR !== undefined) {
  console.log('ok\n' + path.resolve(root, process.env.CAW_STATE_DIR));
  process.exit(0);
}
if (!fs.existsSync(configFile)) {
  console.log('default\n' + path.resolve(root, fallback));
  process.exit(0);
}
try {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('not an object');
  if (config.stateDir !== undefined && typeof config.stateDir !== 'string') throw new Error('stateDir is not a string');
  console.log('ok\n' + path.resolve(root, config.stateDir ?? fallback));
} catch {
  console.log('unknown');
}
NODE
  ) || resolved=unknown
  state_status=${resolved%%$'\n'*}
  if [[ $state_status == ok || $state_status == default ]]; then
    state_dir=${resolved#*$'\n'}
    socket=$state_dir/tmux.sock
  else
    state_reason='config unreadable, invalid JSON, or not a JSON object'
  fi
else
  state_reason='node unavailable; cannot resolve state directory'
fi
live=unknown
if [[ $state_status != unknown ]] && command -v tmux >/dev/null 2>&1; then
  if sessions=$(tmux -S "$socket" list-sessions -F '#{session_id}' 2>/dev/null); then
    live=$(printf '%s\n' "$sessions" | awk 'NF {n++} END {print n+0}')
  fi
fi
if [[ $live == unknown ]]; then live_text='unknown (private tmux socket or state directory unavailable)'; else live_text=$live; fi

if ((dry)); then
  printf 'Would stop and disable %s and remove only %s\n' "$unit" "$unit_file"
  if [[ $state_status == unknown ]]; then
    printf 'Managed agents: unknown (state directory %s: %s).\n' "$state_reason" "$config_file"
    printf 'Would leave untouched: state directory unknown, %s, agent journals/history, and Tailscale Serve rules.\n' "$config_file"
  else
    printf 'Managed agents on %s: %s\n' "$socket" "$live_text"
    printf 'Would leave untouched: %s, %s, agent journals/history, and Tailscale Serve rules.\n' "$state_dir" "$config_file"
  fi
  exit 0
fi

# Live agents and unknown state both require explicit consent before disable.
if [[ $state_status == unknown ]]; then
  printf 'LOUD: managed agent count is UNKNOWN (%s). Cannot prove there are no live agents.\n' "$state_reason"
elif [[ $live =~ ^[0-9]+$ ]] && ((live > 0)); then
  printf 'LOUD: %s managed OMP agent(s) are running on %s.\n' "$live" "$socket"
  printf 'Disabling the unit stops the backend. The agents keep running (the unit stops with KillMode=process), but they are left unmanaged until the service starts again.\n'
fi

if ((!yes)); then
  if [[ $state_status == unknown || ( $live =~ ^[0-9]+$ && $live -gt 0 ) ]]; then
    [[ -t 0 ]] || fail 'Agent state is live or unknown. Non-interactive use requires --yes. Nothing was changed.'
  fi
  [[ -t 0 ]] || fail 'Non-interactive use requires --yes. Nothing was changed.'
  read -r -p "Remove $unit and its rendered unit file? Application and agent data will remain. [y/N] " answer
  [[ $answer == [yY] || $answer == [yY][eE][sS] ]] || { echo 'Cancelled.'; exit 0; }
fi

# A failed disable is a failed uninstall; it must not be swallowed.
if ! systemctl --user disable --now "$unit"; then
  fail "systemctl --user disable --now $unit failed. The unit is still installed and may still be running; inspect: systemctl --user status $unit"
fi
if [[ -f $unit_file ]]; then
  rm -- "$unit_file" || fail "Could not remove $unit_file; it is still present."
fi
systemctl --user daemon-reload || fail 'systemctl --user daemon-reload failed; the unit file is removed but systemd has not reloaded it.'

# State plainly what the machine still has, so "removed the unit" is not read as "removed everything".
remaining=$live_text
if [[ $state_status != unknown ]] && command -v tmux >/dev/null 2>&1; then
  if sessions=$(tmux -S "$socket" list-sessions -F '#{session_id}' 2>/dev/null); then
    n=$(printf '%s\n' "$sessions" | awk 'NF {n++} END {print n+0}')
    remaining="$n"
    ((n > 0)) && printf 'LOUD: %s managed OMP agent(s) are STILL RUNNING on %s; they are no longer managed by any service.\n' "$n" "$socket"
  fi
fi
printf 'SUCCESS: removed unit; the backend service is disabled and %s is gone.\n' "$unit_file"
if [[ $state_status == unknown ]]; then
  printf 'STILL PRESENT: managed agents: unknown (%s); state dir: unknown; config: %s; Tailscale Serve rules: unchanged.\n' "$state_reason" "$config_file"
else
  printf 'STILL PRESENT: managed agents: %s; state dir: %s; config: %s; Tailscale Serve rules: unchanged.\n' "$remaining" "$state_dir" "$config_file"
fi
