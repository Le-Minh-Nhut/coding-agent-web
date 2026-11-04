#!/usr/bin/env bash
set -euo pipefail
interval=60; out=''
while (($#)); do case $1 in --interval) interval=${2:?missing seconds}; shift 2;; --out) out=${2:?missing path}; shift 2;; --help) echo 'Usage: benchmark-idle.sh [--interval seconds] [--out file]; valid only with stable service cgroup and positively enumerable private tmux socket; metrics cover whole cgroup, MainPID is systemd main process.'; exit 0;; *) echo 'Usage: benchmark-idle.sh [--interval seconds] [--out file]' >&2; exit 2;; esac; done
[[ $interval =~ ^[1-9][0-9]*$ ]] || { echo 'Interval must be positive integer seconds.' >&2; exit 2; }
unit=coding-agent-web.service
config=${CAW_CONFIG:-$(cd "$(dirname "$0")/.." && pwd)/caw.config.json}
repo_root=$(cd "$(dirname "$0")/.." && pwd)
state_dir=${CAW_STATE_DIR:-$HOME/.local/state/coding-agent-web}
resolve_bin() { local found; found=$(command -v "$1") || return 1; readlink -f "$found"; }
node_path=$(resolve_bin node) || { echo 'Refusing idle label: node unavailable.'; exit 1; }
tmux_path=$(resolve_bin tmux) || { echo 'Refusing idle label: tmux unavailable.'; exit 1; }
systemctl_path=$(resolve_bin systemctl) || { echo 'systemctl unavailable.'; exit 1; }
[[ -r $config ]] || { echo 'Refusing idle label: config unavailable.'; exit 1; }
state_dir=$("$node_path" - "$config" "$repo_root" "$state_dir" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
try { const c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); console.log(path.resolve(process.argv[3],process.env.CAW_STATE_DIR??c.stateDir??process.argv[4])); } catch { process.exit(1); }
NODE
) || { echo 'Refusing idle label: invalid config.'; exit 1; }
socket=$state_dir/tmux.sock
sessions() {
  if [[ ! -e $socket ]]; then
    pgrep -af -- "$socket" >/dev/null 2>&1 && return 2
    return 0
  fi
  "$tmux_path" -S "$socket" list-sessions -F '#{session_id}' 2>/dev/null
}
sessions >/dev/null || { echo 'Refusing idle label: private tmux state unknown.'; exit 1; }
get() { "$systemctl_path" --user show "$unit" -p "$1" --value 2>/dev/null | head -n1; }
mem1=$(get MemoryCurrent); cpu1=$(get CPUUsageNSec); pid1=$(get MainPID); tasks1=$(get TasksCurrent); cgroup1=$(get ControlGroup)
[[ $mem1 =~ ^[0-9]+$ && $cpu1 =~ ^[0-9]+$ && $pid1 =~ ^[1-9][0-9]*$ && -n $cgroup1 ]] || { echo 'Required service cgroup metrics missing; measurement unknown.'; exit 1; }
sleep "$interval"
sessions >/dev/null || { echo 'Measurement unknown: private tmux state lost or a process may exist.'; exit 1; }
active=$(sessions) || { echo 'Measurement unknown: private tmux state unavailable.'; exit 1; }
[[ -z $active ]] || { echo 'Measurement no longer idle: managed agents started during interval.'; exit 1; }
mem2=$(get MemoryCurrent); cpu2=$(get CPUUsageNSec); pid2=$(get MainPID); tasks2=$(get TasksCurrent); cgroup2=$(get ControlGroup)
[[ $pid2 == "$pid1" && $cgroup2 == "$cgroup1" ]] || { echo 'Service PID or cgroup changed; measurement unknown.'; exit 1; }
[[ $mem2 =~ ^[0-9]+$ && $cpu2 =~ ^[0-9]+$ && $cpu2 -ge $cpu1 ]] || { echo 'Required memory/CPU metric missing or CPU counter reset; measurement unknown.'; exit 1; }
[[ -r /proc/$pid1/status && -r /proc/$pid1/cgroup ]] || { echo 'Incomplete /proc reads; measurement unknown.'; exit 1; }
rss=$(awk '/^VmRSS:/ {print $2 " kB"}' "/proc/$pid1/status"); threads=$(awk '/^Threads:/ {print $2}' "/proc/$pid1/status"); cgroup=$(awk -F: '$1=="0" {print $3}' "/proc/$pid1/cgroup")
[[ $rss && $threads && $cgroup == "$cgroup1" ]] || { echo 'Incomplete /proc data or cgroup mismatch; measurement unknown.'; exit 1; }
procs=/sys/fs/cgroup$cgroup/cgroup.procs
[[ -r $procs ]] || { echo 'Cgroup process list unavailable; measurement unknown.'; exit 1; }
processes=$(wc -l < "$procs")
cpu=$(awk -v d="$((cpu2-cpu1))" -v w="$interval" 'BEGIN {printf "%.3f",d/1000000000/w*100}')
report=$(printf 'Measurement: idle at sampled endpoints (zero agents confirmed by absent socket/process or live socket enumerated empty); transient activity between samples is not detected\nInterval: %s s\nAverage service CPU: %s%%\nCgroup MemoryCurrent: %s\nMain process: %s\nProcess count: %s\nThreads (process): %s; cgroup TasksCurrent: %s -> %s\nProcess RSS: %s\nCgroup MemoryCurrent and CPUUsageNSec cover whole service cgroup, including pnpm and descendants; RSS/threads count MainPID only.\n' "$interval" "$cpu" "$mem2" "$pid1" "$processes" "$threads" "${tasks1:-unknown}" "${tasks2:-unknown}" "$rss")
printf '%s\n' "$report"
[[ -z $out ]] || printf '%s\n' "$report" > "$out"
