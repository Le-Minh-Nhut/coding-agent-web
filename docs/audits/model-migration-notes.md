# DeepSeek model migration → `wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017`

Date: 2026-11-06. Scope: migrate the DeepSeek route to the pinned
`-1017` snapshot. No commit, push or deploy performed. No OMP/tmux session was
restarted, killed or launched.

## Verdict

**MIGRATED.** The target id is present in the installed OMP catalog and every
active configuration that named the old `wdb/deepseek-ai/DeepSeek-V4.1-Flash`
as a live route now names `wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017`. The old
base id is still served by the gateway (both rows exist), so nothing was
silently substituted for a missing model.

## 1. Catalog evidence (verbatim)

Installed OMP:

```
$ omp --version
omp/18.15.0
$ which omp
/home/heheboiz/.local/bin/omp
```

Real flag is `omp models --json` (`omp models --help`: `ACTION ls (default) |
find | refresh | <provider>`, `--json`). Catalog returns `{ "models": [...] }`.

Exact row, from `omp models --json` (provider `9router`, id
`wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017`):

```json
{
  "provider": "9router",
  "kind": "chat",
  "id": "wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "selector": "9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "name": "wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "contextWindow": 1000000,
  "maxTokens": 128000,
  "reasoning": true,
  "thinking": [
    "low",
    "high",
    "max"
  ],
  "input": [
    "text",
    "image"
  ],
  "cost": {
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": 0
  },
  "pricingStatus": "unknown"
}
```

Human-readable row:

```
$ omp models find deepseek-ai/DeepSeek-V4.1-Flash-1017
9router (1)
│ wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017 │      1M │    128K │ low,high,max │ yes │
```

The retired base id is also present and unchanged:

```
$ omp models find DeepSeek-V4.1-Flash   # lists both rows
│ wdb/deepseek-ai/DeepSeek-V4.1-Flash            │ 1M │ 128K │ low,high,max │ yes │
│ wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017       │ 1M │ 128K │ low,high,max │ yes │
```

### Answers to the inspection questions

- **Present?** Yes, `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017` is in the
  live catalog (331 rows via `omp models --json`; 329 after the adapter's own
  dedupe/validation).
- **Provider prefix?** The id itself keeps the `wdb/` prefix (the gateway wire
  name). The full OMP **selector** is `provider/id` =
  `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017`. Config values use the full
  selector; `wdb/...` alone is the catalog `id`, not a selector.
- **Thinking levels:** `low, high, max` (`reasoning: true`). `medium`, `minimal`
  and `xhigh` are NOT supported.
- **Context window:** `1000000`. **Max output:** `128000`.
- **Tool calling:** the catalog row carries no `tools` field (no row in the
  331-row catalog does; keys are `contextWindow, cost, id, input, kind, maxTokens,
  name, pricingStatus, provider, reasoning, selector, thinking`), so the catalog
  neither confirms nor denies tool calling. `[INFERENCE]` The base
  `DeepSeek-V4.1-Flash` row has identical metadata and is used as a tool-running
  worker today, so the `-1017` snapshot is expected to support tools the same
  way; this was not proven by a live inference call in this workstream.

## 2. Effective selector syntax

- Config value: `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017`
- With thinking level: `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high`
  (default role: `:max`).
- The `:level` suffix is real: `omp models --json` rows stay un-suffixed and
  `formatModelSelectorValue` appends `:<level>`
  (`docs/research/model-catalog.md`). `omp models find` matches catalogue
  selectors, so it correctly reports no row for the suffixed string
  (`No models matching "DeepSeek-V4.1-Flash-1017:max"`); the suffix is applied
  by the runner, not the catalog.
- Levels used match the catalog exactly: `:high` for worker lanes (in
  `thinking`), `:max` for the interactive default (in `thinking`). The old
  config's GPT fallback key `9router/cx/gpt-6-luna:xhigh` is untouched — it is
  not a DeepSeek route.
- **Effort policy (AGENTS.md rule 10):** the default keeps its `:max` suffix and
  worker lanes keep `:high`; no coarse `effort` hint is used, and `:xhigh`/`:max`
  are not used for delegated workers. The new id accepts the same suffix
  dimension as the old one, so the owner's effort policy is preserved.

## 3. Files changed (before → after)

All four are the only files that named the old id as ACTIVE config. Historical
records were left alone (see §5).

### `~/.omp/agent/config.yml` (OMP user/global config)

Backup: `~/.omp/agent/config.yml.bak-model-migration-1017`.

```diff
@@ retry.fallbackChains
-      - 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high   (x4: keys gpt-6-luna:high,
-                                                          gpt-6-luna:xhigh, gemini-3.8-flash-high, GLM-5.3)
+      - 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high
-    9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high:      (chain key)
+    9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high:
@@ modelRoles
-  default: 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:max
+  default: 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:max
```

`modelRoles.default` and the fallback chains are the DeepSeek routes. GPT keys
(`9router/cx/gpt-6-luna:high`, `:xhigh`) and Gemini/GLM/Qwen routes are
unchanged.

### `~/data/coding-agent-web/.omp/config.yml` (project config for this repo)

Backup: `.omp/config.yml.bak-model-migration-1017`.

```diff
@@ modelRoles
-  deepseek_v41_hi: 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high
+  deepseek_v41_hi: 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high
@@ retry.fallbackChains
-      - 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high   (x3)
+      - 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high
-    9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high:
+    9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high:
```

`modelRoles.default` was already `…-1017:max` before this change (set by an
earlier session); only `deepseek_v41_hi` and the chains were stale.

### `~/data/cir/.omp/config.yml` (project config for the CIR workbench)

Backup: `.omp/config.yml.bak-model-migration-1017`.

```diff
@@ modelRoles
-  default: 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:max
+  default: 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:max
@@ retry.fallbackChains
-      - 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high   (x3)
+      - 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high
-    9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high:
+    9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high:
```

This is a different repo (`/home/heheboiz/data/cir`), not owned by another
worker, and the id appears there as live routing, so it was migrated too.

### `~/.omp/agent/agents/caw-deepseek.md` (agent definition)

Backup: `~/.omp/agent/agents/caw-deepseek.md.bak-model-migration-1017`.

```diff
-description: Project worker pinned to wdb/deepseek-ai/DeepSeek-V4.1-Flash at thinking high (Coding Agent Web).
-model: 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high
+description: Project worker pinned to wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017 at thinking high (Coding Agent Web).
+model: 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high
```

### Policy docs (live policy statements, not history)

- `docs/operations/subagent-model-policy.md`: headline policy, priority table,
  effort line, owner-ruling paragraph and history tail now name the `-1017` id.
- `docs/operations/deepseek-context-cap.md`: the current-state banner now names
  the `-1017` id. The historical body of that file (the 200k cap recipe dated
  2026-10-29 and its verification transcript) is untouched — it records what was
  actually done at the time.

### `apps/web/src` — NOT touched

No change was required. The only reference in that tree is a comment in
`apps/web/src/agent-model.ts:154` and the test at
`tests/web/round57-agent-scope-honesty.test.tsx:49`, both of which exercise
`modelDisplayName` by taking the **last path segment**. `modelDisplayName(
"9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017")` still returns
`"DeepSeek-V4.1-Flash-1017"`, so the function's behaviour is unchanged and the
test still passes. No model-list/label constant exists in `apps/web/src` that
enumerates providers; CAW lists models from the live `omp models --json`
catalog (`apps/server/src/app.ts:1189`).

## 4. Next-launch vs existing-session behaviour

Three distinct things, and they are not the same:

1. **Existing sessions keep the model they already loaded.** A running OMP
   process has its model resolved at launch; rewriting config does not re-point
   it. Journals of the three live sessions confirm which model each actually
   runs (read before and after the change, identical):
   - `$0` `caw-DOCKER--Qu-t-Docker-tr-n-m-y-c3dc09cb`, native session
     `01a19c13-…`: journal `model_change => 9router/ag/gemini-3.8-flash-high`,
     `thinking_level_change => high`.
   - `$1` `caw-CTX--Debug-1M-context-limit-400-01321407`, native session
     `01a17ac9-…`: journal `model_change => 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash`,
     `thinking_level_change => max`. **This session is still on the old id and
     stays there until it is next launched.** It was not restarted.
   - `$2` `caw-New-chat-b2dc0c99`, native session `01a1aa0b-…`: journal
     `model_change => 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash`,
     `thinking_level_change => high`. Its saved CAW preference
     (`metadata.jsonl`) was already `…-1017` before this change; the preference
     applies on next launch, the running process stays on the old id.

   No session was restarted, killed or relaunched to make the default take
   effect (AGENTS.md rule 7 / session safety).

2. **Saved next-launch model (per conversation).** CAW stores
   `modelPreference` per conversation and passes it as `--model=<selector>` on
   the next launch (`apps/server/src/app.ts:1179`,
   `packages/omp-adapter/src/tmux.ts:280`). A new chat created after this change
   inherits the migrated `modelRoles.default` from the project/user config layer,
   i.e. `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:max`, unless a saved
   preference overrides it. Preferences already saved as `…-1017` keep working;
   a preference saved as the old base id would still launch the old base id,
   which the catalog still serves (no dangling selector).

3. **New default for future sessions.** `modelRoles.default` =
   `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:max` in both the global and
   this project's config; the CIR project likewise.

## 5. Deliberately NOT rewritten (historical records)

These name the model that was actually used at the time and were left verbatim:

- `docs/audits/FINAL_HISTORY_UX_PLAYWRIGHT_REPORT.md`
- `docs/operations/acceptance-run-plan.md` (a recorded 2026 transcript)
- `docs/HUONG_DAN_SU_DUNG.md` (explains `modelDisplayName` with an example)
- `docs/research/model-catalog.md` (substring-within-id evidence)
- the historical body of `docs/operations/deepseek-context-cap.md`
- `tests/adapter/model-catalog.test.ts`, `tests/adapter/collab-registry.test.ts`
  (fixtures for the parser, using the old id as sample data)
- `tests/fixtures/omp-session/*.jsonl` (recorded session journals)
- `~/.omp/agent/sessions/**` and agents' old `.bak-*` files

## 6. Verification performed (real output)

Every command below was actually run in this workstream.

```
$ omp --version
omp/18.15.0

$ omp models find deepseek-ai/DeepSeek-V4.1-Flash-1017
9router (1)
│ wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017 │ 1M │ 128K │ low,high,max │ yes │

$ omp config list --scope global --json | (modelRoles.default)
global modelRoles.default = 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:max

$ omp config list --scope project --json | (from /home/heheboiz/data/coding-agent-web)
project modelRoles.default = 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:max
project modelRoles.deepseek_v41_hi = 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high
project retry.fallbackChains = { "9router/cx/gpt-6-luna:high": ["…-1017:high"],
  "9router/cx/gpt-6-luna:xhigh": ["…-1017:high"],
  "9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high": ["9router/cx/gpt-6-luna:high"],
  "9router/wdb/zai-org/GLM-5.3": ["9router/ag/gemini-3.8-flash-high","9router/cx/gpt-6-luna:high","…-1017:high"],
  "9router/ag/gemini-3.8-flash-high": [] }

$ cd /home/heheboiz/data/cir && omp config list --scope project --json | (modelRoles.default)
cir default = 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:max
```

`omp config list` parses the YAML through OMP's own config loader, so a
malformed file or an unknown key would fail here. It exited 0 and reported the
migrated values. There is no separate `omp config validate` subcommand
(`omp config --help`: `list|get|set|reset|path|init-xdg`).

CAW selectability, through the real adapter parser
(`packages/omp-adapter/src/model-catalog.ts`, the code behind `GET /api/models`):

```
total selectors: 329
target present: true    (9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017)
base present:   true    (9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash)
bogus present:  false   (9router/wdb/deepseek-ai/DeepSeek-Nonexistent)
```

That probe ran as a throwaway vitest file and was deleted afterwards; the
assertion it proves (`parseOmpModelsOutput` surfaces the new selector and drops
a bogus one) is already covered by the existing
`tests/adapter/model-catalog.test.ts` (6 passed), which was re-run and passes.
No behaviour changed in CAW code, so no new test was added. `omp models find
zz-no-such-model-zz` prints `No models matching "zz-no-such-model-zz"`, and the
CAW `/api/models` route already reports catalog failure honestly
(`source: "unavailable"` with a reason, `apps/server/src/app.ts:1189-1193`) —
unchanged by this migration.

`pnpm test` was NOT run for this change: it is a config + docs migration that
does not alter code paths, and the one touched behaviour (`modelDisplayName`) is
already covered.

## 7. Session safety — proof live sessions were untouched

The app's private tmux socket is
`$HOME/.local/state/coding-agent-web/tmux.sock`
(`apps/server/src/tmux-service.ts:24`, `join(config.stateDir, "tmux.sock")`,
`stateDir` default `~/.local/state/coding-agent-web`).

Read-only snapshot taken **before** the edits and again **after**:

```
$ tmux -S $HOME/.local/state/coding-agent-web/tmux.sock \
    list-panes -a -F '#{session_id}|#{session_name}|#{pane_pid}|#{pane_dead}|#{session_created}|#{socket_path}:#{start_time}:#{pid}' | sort
$0|caw-DOCKER--Qu-t-Docker-tr-n-m-y-c3dc09cb|1204278|0|1793822846|…/tmux.sock:1793822846:1204277
$1|caw-CTX--Debug-1M-context-limit-400-01321407|2080435|0|1793854106|…/tmux.sock:1793822846:1204277
$2|caw-New-chat-b2dc0c99|2082046|0|1793854275|…/tmux.sock:1793822846:1204277
--- server identity: /home/heheboiz/.local/state/coding-agent-web/tmux.sock:1793822846:1204277
```

`diff before after` → identical. SHA-256 of the before and after snapshots:

```
9f51ff2c3180a10f9b1abc88c1b368410caf59f6a1c023f1f693b97d39dc9d85  before
9f51ff2c3180a10f9b1abc88c1b368410caf59f6a1c023f1f693b97d39dc9d85  after
```

Pane pids still alive with unchanged start times: 1204278 (`start=15632444`),
2080435 (`start=18758494`), 2082046 (`start=18775317`). The tmux **server**
identity (`1793822846:1204277`) is unchanged, so no session was re-created.
The CAW server (pid 92072) was not restarted; it still holds ports 8791/8792.
No `omp` process was signalled, and no overlay config
(`~/.local/state/coding-agent-web/overlays/*.yml`) was modified.

## 8. BLOCKED / not verified

- **Tool calling** is not a field in the catalog row, so it could not be
  confirmed from the catalog (see §1). Confirming it would need a live inference
  call, which is out of scope here (and would spend provider credits).
- No live agent was launched to prove the `-1017` selector end-to-end at
  inference time; the evidence is catalog + config-loader + adapter-parser.
- An existing session (`$1`, and `$2` until relaunch) still runs the old base
  id. Making the change take effect for them would require restarting them,
  which this workstream explicitly must not do.
