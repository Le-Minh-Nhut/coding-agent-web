#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/.." && pwd)
unit_name=coding-agent-web.service
unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
unit_file=$unit_dir/$unit_name
config_file=${CAW_CONFIG:-$repo_root/caw.config.json}
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Linux ]] || fail 'Linux required.'
[[ -r /etc/os-release ]] || fail '/etc/os-release unavailable.'
. /etc/os-release
[[ ${ID:-} == ubuntu ]] || fail 'Ubuntu required.'
[[ -n ${HOME:-} && $(id -un) != root ]] || fail 'Run as the normal owner account, never root.'
resolve_bin() {
  local name=$1 found
  found=$(command -v "$name") || fail "Missing prerequisite: $name. Install it and retry."
  found=$(readlink -f "$found") || fail "Cannot resolve absolute path for $name ($found)."
  [[ $found == /* && -x $found ]] || fail "Resolved $name is not an executable absolute path: $found"
  printf '%s\n' "$found"
}
systemctl_path=$(resolve_bin systemctl)
"$systemctl_path" --user show-environment >/dev/null 2>&1 || fail 'systemctl --user unavailable; start user session or enable lingering.'
missing=()
for bin in node pnpm omp tmux; do command -v "$bin" >/dev/null 2>&1 || missing+=("$bin"); done
((${#missing[@]} == 0)) || fail "Missing prerequisites: ${missing[*]}. Install them, then retry."
node_path=$(resolve_bin node)
pnpm_path=$(resolve_bin pnpm)
omp_path=$(resolve_bin omp)
tmux_path=$(resolve_bin tmux)
node_version=$("$node_path" -p 'process.versions.node')
"$node_path" -e 'const [a,b,c]=process.argv[1].split(".").map(Number); if(a<20||(a===20&&(b<19))) process.exit(1)' "$node_version" || fail "Node $node_version found; Node >=20.19 required."
[[ -f $config_file ]] || fail "Config not found: $config_file. Create a valid caw.config.json first."
config_error=$(mktemp)
rendered=''
ready_body=''
cleanup() { rm -f "${config_error:-}" "${rendered:-}" "${ready_body:-}"; }
trap cleanup EXIT
config_info=$(cd "$repo_root" && "$node_path" --import tsx --input-type=module -e '
import { loadConfig } from "./apps/server/src/config.ts";
try {
  const config = await loadConfig({ filePath: process.argv.at(-1), env: {} });
  if (config.host !== "127.0.0.1") throw new Error("host must be exactly 127.0.0.1 because Tailscale Serve proxies only 127.0.0.1:<port>.");
  console.log(JSON.stringify({ port: config.port, stateDir: config.stateDir }));
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
' "$config_file" 2>"$config_error") || fail "Invalid server config: $(cat "$config_error")"
readarray -t validated < <(printf '%s' "$config_info" | "$node_path" -e 'const c=JSON.parse(require("node:fs").readFileSync(0,"utf8")); console.log(c.port); console.log(c.stateDir)')
port=${validated[0]}; state_dir=${validated[1]}
config_changed=0
if [[ -n ${CAW_MAX_ACTIVE_AGENTS:-} && $CAW_MAX_ACTIVE_AGENTS != 3 ]]; then fail 'CAW_MAX_ACTIVE_AGENTS must be exactly 3; it is ignored by the service and does not reach it.'; fi
max_state=$("$node_path" - "$config_file" <<'NODE'
const fs=require('node:fs'); const c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if (Object.hasOwn(c,'maxActiveAgents') && !Number.isInteger(c.maxActiveAgents)) { console.error(`maxActiveAgents must be an integer; found ${JSON.stringify(c.maxActiveAgents)}.`); process.exit(1); }
console.log(Object.hasOwn(c,'maxActiveAgents')?String(c.maxActiveAgents):'missing');
NODE
) || fail 'Cannot validate maxActiveAgents.'
if [[ $max_state != 3 ]]; then
  backup=$config_file.$(date +%Y%m%d%H%M%S).bak
  [[ ! -e $backup ]] || fail "Backup already exists: $backup; refusing to overwrite."
  cp -p "$config_file" "$backup"
  "$node_path" - "$config_file" <<'NODE'
const fs=require('node:fs'); const path=require('node:path'); const f=process.argv[2]; const c=JSON.parse(fs.readFileSync(f,'utf8')); c.maxActiveAgents=3;
const tmp=path.join(path.dirname(f),`.${path.basename(f)}.${process.pid}.tmp`); const mode=fs.statSync(f).mode;
try { fs.writeFileSync(tmp,JSON.stringify(c,null,2)+'\n',{mode}); fs.chmodSync(tmp,mode); fs.renameSync(tmp,f); } finally { try { fs.unlinkSync(tmp); } catch (e) { if (e.code!=='ENOENT') throw e; } }
NODE
  config_changed=1
  printf 'LOUD: set maxActiveAgents from %s to 3; timestamped backup: %s\n' "$max_state" "$backup"
fi
pending_restart=0
service_active=0
if "$systemctl_path" --user is-active --quiet "$unit_name"; then
  service_active=1
  printf 'Service already active; preserving running process.\n'
elif port_status=$(curl --silent --output /dev/null --max-time 2 --write-out '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null) && [[ $port_status =~ ^[23][0-9][0-9]$ ]]; then
  fail "Port $port is already serving while unit is inactive; refusing to start a second server. Stop the existing server yourself, then rerun."
fi
mkdir -p "$unit_dir"
extra_path=''
for dir in "$HOME/.local/bin" "$HOME/.bun/bin" "$HOME/.local/share/uv" "$HOME/.local/share/pnpm" "$HOME/.nvm/versions/node"/*/bin "$HOME/miniconda3/bin" /opt/jdk-25/bin; do
  [[ -d $dir ]] || continue
  owner=$(stat -c %U "$dir") || continue
  mode=$(stat -c %a "$dir") || continue
  (( (8#$mode & 0002) == 0 )) && [[ $owner == "$USER" || $owner == root ]] || continue
  case ":$extra_path:" in *":$dir:"*) continue;; esac
  extra_path+="${extra_path:+:}$dir"
done
path_value="$(dirname "$node_path"):$(dirname "$pnpm_path"):$(dirname "$omp_path"):$(dirname "$tmux_path")${extra_path:+:$extra_path}:/usr/bin:/bin"
rendered=$(mktemp)
"$node_path" - "$repo_root/deploy/systemd/coding-agent-web.service" "$rendered" "$repo_root" "$config_file" "$path_value" "$pnpm_path" <<'NODE'
const fs = require('node:fs');
const [template, output, ...values] = process.argv.slice(2);
const keys = ['@REPO_ROOT@', '@CONFIG_PATH@', '@PATH_VALUE@', '@PNPM_PATH@'];
const substitutions = new Map(keys.map((key, i) => [key, values[i]]));
fs.writeFileSync(output, fs.readFileSync(template, 'utf8').replace(/@(?:REPO_ROOT|CONFIG_PATH|PATH_VALUE|PNPM_PATH)@/g, (key) => substitutions.get(key)));
NODE
if [[ -f $unit_file ]] && ! cmp -s "$rendered" "$unit_file"; then
  backup=$unit_file.$(date +%Y%m%d%H%M%S).bak
  [[ ! -e $backup ]] || fail "Unit backup already exists: $backup; refusing to overwrite."
  printf 'LOUD: replacing different existing unit at %s; backup: %s\n' "$unit_file" "$backup" >&2
  cp -p "$unit_file" "$backup"
  ((service_active)) && pending_restart=1
fi
if ((service_active && config_changed)); then pending_restart=1; fi
install -m 0644 "$rendered" "$unit_file"
"$systemctl_path" --user daemon-reload
"$systemctl_path" --user enable "$unit_name"
if ((pending_restart)); then
  printf 'INSTALLED: %s\nENABLED: yes\nSTARTED: no (existing service left running)\nPENDING_RESTART: yes — run: systemctl --user restart %s\n' "$unit_name" "$unit_name"
else
  if ! "$systemctl_path" --user is-active --quiet "$unit_name"; then
    "$systemctl_path" --user start "$unit_name"
    printf 'STARTED: yes\n'
  else
    printf 'STARTED: no (already active)\n'
  fi
  printf 'INSTALLED: %s\nENABLED: yes\n' "$unit_name"
fi
if ((pending_restart)); then exit 0; fi
ready_status=000
ready_body=$(mktemp)
for _ in {1..30}; do
  ready_status=$(curl --silent --show-error --max-time 2 --output "$ready_body" --write-out '%{http_code}' "http://127.0.0.1:$port/api/auth/me" 2>/dev/null || true)
  [[ $ready_status == 401 ]] && break
  sleep 1
done
if [[ $ready_status != 401 ]]; then
  hint=$(tr '\n' ' ' < "$ready_body" | cut -c1-200)
  fail "HEALTHY: no — expected HTTP 401 from /api/auth/me, got $ready_status${hint:+; body: $hint}. Inspect: journalctl --user -u $unit_name -n 100 --no-pager"
fi
"$systemctl_path" --user status "$unit_name" --no-pager >/dev/null
journalctl --user -u "$unit_name" -g 'configuration loaded' -n 1 --no-pager || true
printf 'HEALTHY: yes — app identity confirmed by /api/auth/me (HTTP 401).\n'
