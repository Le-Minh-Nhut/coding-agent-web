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
"$node_path" - "$config_file" <<'NODE'
const fs=require('node:fs');
const file=process.argv[2]; let c;
try { c=JSON.parse(fs.readFileSync(file,'utf8')); } catch(e) { console.error(`Invalid config ${file}: ${e.message}`); process.exit(1); }
if (!c || Array.isArray(c) || typeof c!=='object') { console.error('Config must be a JSON object.'); process.exit(1); }
if (!['127.0.0.1','::1','localhost'].includes(c.host ?? process.env.CAW_HOST ?? '127.0.0.1')) { console.error('host must be loopback.'); process.exit(1); }
const port=c.port ?? process.env.CAW_PORT ?? 8791;
const relayPort=c.relayPort ?? process.env.CAW_RELAY_PORT ?? 8792;
for (const [key,value] of [['port',port],['relayPort',relayPort]]) if (!Number.isInteger(Number(value)) || Number(value)<1 || Number(value)>65535) { console.error(`${key} must be an integer in 1..65535: ${value}.`); process.exit(1); }
if (Number(port)===Number(relayPort)) { console.error(`port and relayPort must differ; both are ${Number(port)}.`); process.exit(1); }
const origin=c.publicOrigin ?? process.env.CAW_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
let u; try { u=new URL(origin); } catch { console.error('publicOrigin must be an absolute HTTP(S) origin.'); process.exit(1); }
if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.pathname!=='/' || u.search || u.hash || origin !== u.origin) { console.error('publicOrigin must be an absolute http(s) origin without path/query/fragment.'); process.exit(1); }
const stateDir=require('node:path').resolve(c.stateDir ?? process.env.CAW_STATE_DIR ?? require('node:path').join(require('node:os').homedir(),'.local/state/coding-agent-web'));
const isDirectory=p=>{ try { return fs.statSync(p).isDirectory(); } catch { return false; } };
if (!isDirectory(stateDir) && !isDirectory(require('node:path').dirname(stateDir))) { console.error(`stateDir must exist or have an existing parent directory: ${stateDir}.`); process.exit(1); }
const roots=process.env.CAW_ALLOWED_ROOTS === undefined ? (c.allowedRoots ?? []) : process.env.CAW_ALLOWED_ROOTS.split(',');
if (!Array.isArray(roots) || roots.some(p=>typeof p!=='string' || !require('node:path').isAbsolute(p) || !fs.existsSync(p))) { console.error('Every allowedRoots entry must be absolute and exist.'); process.exit(1); }
NODE
if [[ ${CAW_MAX_ACTIVE_AGENTS:-3} != 3 ]]; then fail 'CAW_MAX_ACTIVE_AGENTS must be exactly 3 for this deployment.'; fi
if ! "$node_path" - "$config_file" <<'NODE'
const fs=require('node:fs'); const c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); process.exit(c.maxActiveAgents===3?0:1);
NODE
then
  backup=$config_file.$(date +%Y%m%d%H%M%S).bak
  [[ ! -e $backup ]] || fail "Backup already exists: $backup; refusing to overwrite."
  cp -p "$config_file" "$backup"
  "$node_path" - "$config_file" <<'NODE'
const fs=require('node:fs'); const f=process.argv[2]; let s=fs.readFileSync(f,'utf8');
if (/"maxActiveAgents"\s*:/.test(s)) s=s.replace(/("maxActiveAgents"\s*:\s*)[^,}\n]+/, (_m, key)=>`${key}3`);
else {
  const close=/\}\s*$/.exec(s); if (!close) throw new Error('Cannot safely add maxActiveAgents.');
  const before=s.slice(0,close.index).replace(/\s+$/,'');
  s=before+(before.endsWith('{')?'':',')+'\n  "maxActiveAgents": 3\n'+s.slice(close.index);
}
JSON.parse(s); fs.writeFileSync(f,s);
NODE
  printf 'LOUD: set maxActiveAgents to 3; timestamped backup: %s\n' "$backup"
fi
if [[ ${1:-} == --build || ! -d $repo_root/packages/guest/dist || ! -d $repo_root/apps/web/dist ]]; then
  (cd "$repo_root" && "$node_path" scripts/build-guest.mjs && "$pnpm_path" --filter @caw/web build)
fi
port=$("$node_path" -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1])).port || 8791' "$config_file")
if "$systemctl_path" --user is-active --quiet "$unit_name"; then
  printf 'Service already active; preserving running process.\n'
elif curl --silent --output /dev/null --max-time 2 "http://127.0.0.1:$port/"; then
  fail "Port $port is already serving while unit is inactive; refusing to start a second server. Stop the existing server yourself, then rerun."
fi
mkdir -p "$unit_dir"
path_value="$(dirname "$node_path"):$(dirname "$pnpm_path"):$(dirname "$omp_path"):$(dirname "$tmux_path"):/usr/bin:/bin"
rendered=$(mktemp)
trap 'rm -f "$rendered"' EXIT
sed -e "s|@REPO_ROOT@|$repo_root|g" -e "s|@CONFIG_PATH@|$config_file|g" -e "s|@PATH_VALUE@|$path_value|g" -e "s|@PNPM_PATH@|$pnpm_path|g" "$repo_root/deploy/systemd/coding-agent-web.service" > "$rendered"
if [[ -f $unit_file ]] && ! cmp -s "$rendered" "$unit_file"; then
  backup=$unit_file.$(date +%Y%m%d%H%M%S).bak
  [[ ! -e $backup ]] || fail "Unit backup already exists: $backup; refusing to overwrite."
  printf 'LOUD: replacing different existing unit at %s; backup: %s\n' "$unit_file" "$backup" >&2
  cp -p "$unit_file" "$backup"
fi
install -m 0644 "$rendered" "$unit_file"
"$systemctl_path" --user daemon-reload
"$systemctl_path" --user enable "$unit_name"
if ! "$systemctl_path" --user is-active --quiet "$unit_name"; then "$systemctl_path" --user start "$unit_name"; fi
if ! "$systemctl_path" --user is-active --quiet "$unit_name"; then fail "Service not active. Inspect: journalctl --user -u $unit_name -n 100 --no-pager"; fi
for _ in {1..30}; do curl --silent --output /dev/null --max-time 2 "http://127.0.0.1:$port/" && break; sleep 1; done
curl --silent --output /dev/null --max-time 2 "http://127.0.0.1:$port/" || fail "HTTP readiness failed on port $port. Inspect journal."
"$systemctl_path" --user status "$unit_name" --no-pager >/dev/null
journalctl --user -u "$unit_name" -g 'configuration loaded' -n 1 --no-pager || true
printf 'SUCCESS: installed and enabled %s; active and HTTP-ready on 127.0.0.1:%s.\n' "$unit_name" "$port"
