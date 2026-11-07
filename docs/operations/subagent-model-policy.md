# Subagent model policy

Which model to delegate to, and why. Recorded because the preference changed
several times during the project and an unrecorded reversal gets re-litigated.

## Current policy — owner ruling, 2026-11-07

> "gemini gọi được rồi đó sau này gọi gemini đi"
> — *"Gemini is callable now; from now on use Gemini."*

Delegated lanes route to **`9router/ag/gemini-3.8-flash-high`**. This lifts the
2026-10-30/11-06 ban on Gemini, which was recorded as "quota exhausted" and is
now stale.

### Routing table (after this change)

"Effective" = what `omp config list --json` resolves once every layer is merged,
in the repo root. "Thinking" = the level a spawn actually gets from that
selector: an explicit `:<level>` suffix wins, otherwise the agent definition's
`thinkingLevel`, otherwise the session default (`defaultThinkingLevel: high`).

| Lane | Configured model | Effective model | Thinking | Fallback | Source |
| --- | --- | --- | --- | --- | --- |
| `default` (interactive) | `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:max` | same | `max` (suffix) | **none** — the `:max` selector does not match the suffixless/`:high` keys and no `default` chain is configured | project `.omp/config.yml` |
| `task` | `9router/ag/gemini-3.8-flash-high` | same | `auto` for the `task` agent (`agents.ts:57`), else session `high` | `…-1017:high` | project |
| `smol` | `9router/ag/gemini-3.8-flash-high` | same | `medium` for `sonic`/`scout` (`agents.ts:71`), else session `high` | `…-1017:high` | project |
| `vision` | `9router/ag/gemini-3.8-flash-high` | same | session `high` (no suffix, no agent default) | `…-1017:high` | project |
| `advisor` | `9router/wdb/zai-org/GLM-5.3:max` | same | `max` (suffix) | Gemini → `…-1017:high` (suffixless key matches any effort) | project; user file's Gemini advisor is shadowed |
| `deepseek_v41_hi` | `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high` | same | `high` (suffix) | Gemini | project; user file's Gemini value is shadowed |
| `task.agentModelOverrides` ×16 (`sonic`, `task`, `scout`, `caw-deepseek`, `caw-gemini`, `caw-luna`, `caw-luna-scout`, `gemini`, `gemini-scout`, `gemini-audit`, `glm-audit`, `qwen-audit`, `reviewer`, `v41audit`, `v41review`, `security-reviewer`) | `9router/ag/gemini-3.8-flash-high` (all 16 byte-identical) | same | agent definition (`auto`/`medium`), else session `high` | `…-1017:high` | project; identical to the user file |
| chain key `9router/ag/gemini-3.8-flash-high` | `[9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high]` | applies to every Gemini lane above | — | — | project (was `[]`: a failure had nowhere to go) |
| chain key `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high` | `[9router/ag/gemini-3.8-flash-high]` | applies to `deepseek_v41_hi` and to fallback hops onto DeepSeek | — | — | project |
| chain key `9router/wdb/zai-org/GLM-5.3` | `[gemini, …-1017:high]` | applies to the advisor (suffixless key) | — | — | project |
| chain key `9router/cx/gpt-6-luna:high` | `[gemini, …-1017:high]` | inert: no lane selects Luna | — | — | user `~/.omp/agent/config.yml` only (dropped from the repo file) |
| chain key `9router/cx/gpt-6-luna:xhigh` | `[gemini, …-1017:high]` | inert: the Luna-pinned `caw-luna*` agents are overridden to Gemini | — | — | user file only |

`9router/ag/gemini-3.8-flash-high` is a catalog model whose *id* ends in
`-high`; it is not a thinking suffix. It reports
`contextWindow: 1048576, maxTokens: 65536, thinking: [minimal, low, medium, high],
input: [text, image]` (`omp models find gemini-3.8-flash-high --json`).

### Advisor stays on GLM-5.3

The ruling names delegated lanes, not the advisor. The repo config sets
`modelRoles.advisor: 9router/wdb/zai-org/GLM-5.3:max`; the user config sets
`advisor: 9router/ag/gemini-3.8-flash-high`, but `modelRoleStorage: project`
makes the repo value win, so the advisor runs GLM-5.3 at `:max`. Nothing
indicates it is broken, so it was left alone rather than "fixed" to match the
shadowed user value.

## Precedence: why the repo file wins

`modelRoleStorage: project` is set in `~/.omp/agent/config.yml` (the repo file
never sets it). With that value the model hub reads and writes roles in the
project layer, and the project layer outranks the global one:
`packages/coding-agent/src/config/settings.ts:3955` merges
`global → project → --config overlay → runtime`, and
`getModelRoleProvenance` (`settings.ts:1878`) reports the first layer that owns
the key by *presence*, so a project value always shadows the global one.

Records are deep-merged per key, not replaced (`settings.ts:3977`, which also
notes `retry.fallbackChains` is order-sensitive). So a key the repo file omits —
e.g. a user-config `retry.fallbackChains` entry — stays live.

Consequence, observed before this change: spawned workers resolved to
`9router/cx/gpt-6-luna:high`, i.e. `modelRoles.task` from the repo file, not the
Gemini values in the user file. The user file was never wrong; it was shadowed.

### Shadowed user values (`~/.omp/agent/config.yml`)

All of these are in the owner's global file and are **overridden** in this repo:

| Key | User (global) value | Effective in this repo |
| --- | --- | --- |
| `modelRoles.task` | `9router/ag/gemini-3.8-flash-high` | now the same value in the repo file |
| `modelRoles.smol` | `9router/ag/gemini-3.8-flash-high` | now the same value in the repo file |
| `modelRoles.vision` | `9router/ag/gemini-3.8-flash-high` | now the same value in the repo file |
| `modelRoles.deepseek_v41_hi` | `9router/ag/gemini-3.8-flash-high` | **shadowed** — repo keeps `…-1017:high` |
| `modelRoles.advisor` | `9router/ag/gemini-3.8-flash-high` | **shadowed** — repo keeps `GLM-5.3:max` |
| `modelRoles.default` | `…-1017:max` | same value in both |
| `task.agentModelOverrides.*` (16) | `9router/ag/gemini-3.8-flash-high` | now the same value in the repo file |
| `retry.fallbackChains` | 5 chains (Gemini↔Luna↔DeepSeek, GLM→3) | deep-merged with the repo's 3 chains; the two `cx/gpt-6-luna` chains survive from the user file |

`task.enableEffort: true`, `task.maxEffort: high` and `advisor.enabled: true`
come from the user file and are **not** shadowed.

## Fallbacks

`retry.fallbackChains` in the repo file (after this change):

| Primary | Falls back to |
| --- | --- |
| `9router/ag/gemini-3.8-flash-high` | `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high` |
| `…-1017:high` | `9router/ag/gemini-3.8-flash-high` |
| `9router/wdb/zai-org/GLM-5.3` | Gemini, then `…-1017:high` |

Previously the Gemini entry was `9router/ag/gemini-3.8-flash-high: []` — an
explicitly empty chain, which "explicitly disables fallbacks"
(`packages/coding-agent/src/session/retry-fallback-chains.ts:188`). A Gemini
failure had nowhere to go. It now chains to DeepSeek, and DeepSeek chains back.

`retry.fallbackOn: any` (default) and `retry.modelFallback: true` (default), so
any failure walks the chain, not just usage limits.

The `9router/cx/gpt-6-luna` chains were dropped from the repo file because no
*effective* selector reaches Luna: `retry.fallbackChains` is keyed by the
selector actually in use, and that is Gemini or DeepSeek everywhere. The
`caw-luna` / `caw-luna-scout` agent files still pin `cx/gpt-6-luna:xhigh` in
their frontmatter, but `task.agentModelOverrides` outranks the agent definition
(`packages/coding-agent/src/config/model-resolver.ts:1357-1363`), so both now run
Gemini — remove an override key and that agent falls back to its Luna pin. The
same two chain keys still arrive from the user config through the
record merge; they are inert for the reason above, and deleting them there would
mean editing the owner's global file.

Chain lookup order for a live selector is exact model key → model-normalized
key → suffixless model key → provider wildcard → role hint → role keys →
`default` (`retry-fallback-chains.ts:434-529`). A model-selector key whose
explicit effort stays distinct after normalization does **not** match — so the
interactive `…-1017:max` default finds no `…-1017:high` chain and, with no
`default` key configured, runs with **no** fallback. That is a known gap in the
interactive lane, outside this ruling, and left unchanged.

## Mismatches found and how each was classified

| Observation | Classification | Action |
| --- | --- | --- |
| Repo `task`/`smol`/`vision` + 16 overrides → Luna; owner ruling says Gemini | actual functional defect (wrong routing) | fixed |
| Old doc said "every lane DeepSeek; GPT and Gemini banned" | documentation mismatch | fixed by this rewrite |
| Gemini chain was `[]` while Gemini is the primary lane | actual functional defect (no fallback) | fixed |
| Repo `advisor` = GLM-5.3:max, user `advisor` = Gemini | ambiguous preference, shadowed value | left alone (reported above) |
| Repo `deepseek_v41_hi` = `:high`, user = Gemini | saved-session/shadowed preference; owner created the DeepSeek lane deliberately | left alone |
| `default` (`:max`) has no matching chain key and no `default` chain | intentional gap in the interactive lane, not delegated | left alone |
| User-config `cx/gpt-6-luna` chains survive the merge | intentional fallback config, currently unreferenced | left alone (cannot edit global file) |
| `caw-luna` / `caw-luna-scout` agent files pin `cx/gpt-6-luna:xhigh` while their overrides name Gemini | ambiguous preference, resolved by documented precedence: the override wins, so no action needed | left alone; the frontmatter pin only re-applies if its override key is removed |
| `cbai-vision` (`~/.omp/agent/agents/cbai-vision.md`) is not in the 16 overrides and pins `9router/cbai/deepseek-v4.1-flash` in its own frontmatter | intentional agent-level pin on the free `cbai/` vision lane | left alone |
| `seance` (bundled) is not in the 16 overrides and has no `model:` frontmatter | intentional: it inherits the spawning session's active model (`model-resolver.ts:1376-1378`), so it does not land on Gemini | left alone; add an override key only if the owner wants consults on Gemini too |

## Image reading

The main agent never puts image bytes in its own context: once image data enters
the main lane, every later turn in that session fails with a multimodal error.
Delegate the read to a subagent.

Gemini (`9router/ag/gemini-3.8-flash-high`) declares `"input": ["text", "image"]`,
so a Gemini subagent can read images. The dedicated `cbai-vision` agent file
still pins the free `9router/cbai/deepseek-v4.1-flash` lane (owner note
2026-10-31: reading an opened screenshot belongs on the free `cbai/` lane, not a
paid route). Whether image reading runs at all is a per-round owner decision —
do not assume it for other rounds.

## Effort: never pass the coarse `effort` hint

A separate trap, documented in full in
`docs/operations/subagent-effort-policy.md`: the task tool's coarse `effort`
parameter **outranks** the `:level` suffix in an agent definition, and it maps onto
the model's *supported* list rather than the canonical order. For a model whose
range is `minimal,low,medium,high`, `effort: "med"` resolves to index
`(4-1)>>1 = 1` = **`low`**. So a "medium" hint silently downgrades a worker to its
lowest thinking level — observed in a session journal as `"thinkingLevel":"low"`.

State the level in the model id (e.g. `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high`)
and do not pass `effort`. AGENTS.md hard rule 10 makes this binding.

Note the interaction with this policy: the delegated selector carries no
`:level` suffix, so a spawn with no `effort` argument takes its thinking level
from the agent definition (`task` → `auto`, `sonic`/`scout` → `medium`;
`packages/coding-agent/src/task/agents.ts:57,71`) and, failing that, the
session's configured default (`defaultThinkingLevel: high`). `task.maxEffort:
high` only clamps when a spawn passes `effort` or a per-call model
(`packages/coding-agent/src/task/executor.ts:4626`). Never `:xhigh`/`:max` on
the delegated lane.

## How to verify

Run from the repo root; the project layer is only read from the current
working directory.

```bash
# Resolved model roles after every layer is merged (the project file wins).
omp config list --json | jq '.["modelRoles"].value'
# -> task/smol/vision = 9router/ag/gemini-3.8-flash-high,
#    default = 9router/wdb/…-1017:max, advisor = GLM-5.3:max,
#    deepseek_v41_hi = …-1017:high

# Resolved per-agent overrides and fallback chains.
omp config list --json | jq '.["task.agentModelOverrides"].value'
omp config list --json | jq '.["retry.fallbackChains"].value'

# Which layer supplies each role's model (project layer, as written).
omp config list --scope=project --json | jq 'keys'
# -> ["modelRoles","retry.fallbackChains","task.agentModelOverrides"]
#    (proves the repo file, not ~/.omp/agent/config.yml, owns these keys)

# Does the selector exist, with which thinking levels?
omp models find gemini-3.8-flash-high --json | jq '.models[] | select(.selector=="9router/ag/gemini-3.8-flash-high")'
```

`omp config list` fails loudly on a malformed file; it also prints warnings for
a fallback selector that names an unknown model
(`packages/coding-agent/src/session/retry-fallback-chains.ts:256`). No CLI
subcommand prints per-role *provenance*; `--scope=project` plus the merge order
above (`settings.ts:3955`) is the way to see which layer wins.

Live-call availability is **not** verified here: the owner stated Gemini is
callable, and proving it would spend real inference. Any change that needs that
proof needs its own authorisation.

## History

History: Gemini-first → Luna-first → Gemini-first again → Luna-first again →
Luna-default with DeepSeek on bulk review → owner ruling (2026-10-29): GPT subagents and vision at `:high`; Gemini prohibited; delegated workers resolve to `modelRoles.task` → owner ruling (2026-10-30): temporary all-DeepSeek (`cx-cap`) policy; GPT and Gemini lanes banned; revert via `config.yml.bak-20261029-r17` / `-r14` → **owner ruling (2026-10-31): provider restored the 1M window; `cx-cap` provider removed from `models.yml`; every lane → `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high` (still DeepSeek-only, GPT/Gemini banned).** → **owner ruling (2026-11-06): DeepSeek id migrated to the pinned `wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017`; every lane → `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high` (`default` → `:max`).** → **owner ruling (2026-11-07): Gemini callable again; delegated lanes (`task`, `smol`, `vision`, all 16 agent overrides) → `9router/ag/gemini-3.8-flash-high`; interactive `default` and `deepseek_v41_hi` stay DeepSeek; advisor stays GLM-5.3:max.**
