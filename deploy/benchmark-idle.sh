#!/usr/bin/env bash
set -euo pipefail
interval=60; out=''
while (($#)); do case $1 in --interval) interval=${2:?missing seconds}; shift 2;; --out) out=${2:?missing path}; shift 2;; *) echo 'Usage: benchmark-idle.sh [--interval seconds] [--out file]' >&2; exit 2;; esac; done
[[ $interval =~ ^[1-9][0-9]*$ ]] || { echo 'Interval must be positive integer seconds.' >&2; exit 2; }
unit=coding-agent-web.service
config=${CAW_CONFIG:-$(cd "$(dirname "$0")/.." && pwd)/caw.config.json}
state_dir=${CAW_STATE_DIR:-$HOME/.local/state/coding-agent-web}
resolve_bin() { local name found; found=$(command -v "$1") || return 1; if [[ $found != /* ]]; then found=$(readlink -f "$found") || return 1; fi; [[ -x $found ]] || return 1; printf '%s\n' "$found"; }
node_path=$(resolve_bin node) || { echo 'Refusing idle label: node executable not found/resolvable.'; exit 1; }
tmux_path=$(resolve_bin tmux) || { echo 'Refusing idle label: agent status unknown (tmux unavailable).'; exit 1; }
systemctl_path=$(resolve_bin systemctl) || { echo 'systemctl executable not found/resolvable.'; exit 1; }
if [[ ! -r $config ]]; then echo 'Refusing idle label: agent status unknown (config unavailable).'; exit 1; fi
state_dir=$("$node_path" - "$config" "$state_dir" <<'NODE'
const fs=require('node:fs'); try { console.log(JSON.parse(fs.readFileSync(process.argv[2],'utf8')).stateDir??process.argv[3]); } catch { process.exit(1); }
NODE
) || { echo 'Refusing idle label: agent status unknown (invalid config).'; exit 1; }
sessions=$("$tmux_path" -S "$state_dir/tmux.sock" list-sessions -F '#{session_id}' 2>/dev/null) || { echo 'Refusing idle label: agent status unknown (private tmux socket unavailable).'; exit 1; }
[[ -z $sessions ]] || { echo 'Refusing idle label: managed OMP agents are running.'; exit 1; }
get() { "$systemctl_path" --user show "$unit" -p "$1" --value 2>/dev/null | head -n1; }
mem1=$(get MemoryCurrent); cpu1=$(get CPUUsageNSec); pid=$(get MainPID); tasks1=$(get TasksCurrent)
[[ $cpu1 =~ ^[0-9]+$ ]] || { echo 'Cannot read CPUUsageNSec; measurement unknown.'; exit 1; }
sleep "$interval"
sessions=$("$tmux_path" -S "$state_dir/tmux.sock" list-sessions -F '#{session_id}' 2>/dev/null) || { echo 'Measurement unknown: private tmux socket status lost during interval.'; exit 1; }
[[ -z $sessions ]] || { echo 'Measurement no longer idle: managed OMP agents started during interval.'; exit 1; }
mem2=$(get MemoryCurrent); cpu2=$(get CPUUsageNSec); tasks2=$(get TasksCurrent)
[[ $cpu2 =~ ^[0-9]+$ && $cpu2 -ge $cpu1 ]] || { echo 'CPU counter missing or reset; measurement unknown.'; exit 1; }
wall=$(awk -v s="$interval" 'BEGIN {printf "%.9f",s}')
cpu=$(awk -v d="$((cpu2-cpu1))" -v w="$wall" 'BEGIN {printf "%.3f", d/1000000000/w*100}')
if [[ $pid =~ ^[1-9][0-9]*$ && -r /proc/$pid/status ]]; then
  rss=$(awk '/^VmRSS:/ {print $2 " kB"}' "/proc/$pid/status")
  threads=$(awk '/^Threads:/ {print $2}' "/proc/$pid/status")
  cgroup=$(awk -F: '$1=="0" {print $3}' "/proc/$pid/cgroup")
  procs="/sys/fs/cgroup$cgroup/cgroup.procs"
  if [[ -r $procs ]]; then processes=$(wc -l < "$procs"); else processes=unknown; fi
else rss=unknown; threads=unknown; processes=unknown; fi
report=$(printf 'Measurement: idle (no managed sessions on private tmux socket)\nInterval: %s s\nAverage service CPU: %s%%\nCgroup MemoryCurrent: %s\nMain process: %s\nProcess count: %s\nThreads (process): %s; cgroup TasksCurrent: %s -> %s\nProcess RSS: %s\nCgroup MemoryCurrent includes all charged cgroup memory; RSS counts resident pages of MainPID only. They are different measures.\n' "$interval" "$cpu" "${mem2:-unknown}" "${pid:-unknown}" "$processes" "$threads" "${tasks1:-unknown}" "${tasks2:-unknown}")
if command -v tailscale >/dev/null 2>&1; then report+=$'\nTailscale usage: unknown (not attributable from service cgroup)'; else report+=$'\nTailscale usage: unknown (tailscale unavailable)'; fi
printf '%s\n' "$report"
[[ -z $out ]] || printf '%s\n' "$report" > "$out"
