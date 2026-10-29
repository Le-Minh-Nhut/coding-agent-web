# Subagent model policy

Which model to delegate to, and why. Recorded because the preference changed
several times during the project and an unrecorded reversal gets re-litigated.

## Current priority

**Temporary policy (2026-10-30): every lane routes to `cx-cap/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high`.**
Banned models may remain listed in the catalog/`models.yml` and as
`retry.fallbackChains` keys, but nothing routes to them — every fallback target
is `cx-cap/…` or `wdb/…` DeepSeek. Revert path: `~/.omp/agent/config.yml.bak-20261029-r17`
(previous state) or `-r14` (older).

| Priority | Agent definition | Model | Use for |
| --- | --- | --- | --- |
| 1 | all delegated agents | `cx-cap/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high` | Everything except image reading. |
| 2 | `caw-gemini`, `caw-luna` lanes | — | Prohibited this round; quota exhausted. |

### Why all lanes are DeepSeek (temporary)

The owner's Gemini quota is exhausted and GPT/Gemini lanes are banned this round.
Everything — including bulk reading — routes to the `cx-cap` DeepSeek lane.
Revert when the owner restores quota (see revert path above).

## Image reading: NOT RUN this round

Visual/image reading is **not run** this round (owner-deferred). No lane may read
images — no OCR, no vision calls — regardless of which model the lane resolves to.
DOM/geometry assertions in the specs are the substitute for screenshot inspection:
layout claims are verified from the live DOM, not from image bytes.


## Effort: never pass the coarse `effort` hint

A separate trap, documented in full in
`docs/operations/subagent-effort-policy.md`: the task tool's coarse `effort`
parameter **outranks** the `:level` suffix in an agent definition, and it maps onto
the model's *supported* list rather than the canonical order. For a model whose
range is `minimal,low,medium,high`, `effort: "med"` resolves to index
`(4-1)>>1 = 1` = **`low`**. So a "medium" hint silently downgrades a worker to its
lowest thinking level — observed in a session journal as `"thinkingLevel":"low"`.

State the level in the model id (`cx-cap/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high`) and do not pass `effort`.

Owner ruling (2026-10-30): all subagent/vision/delegated lanes route to
`cx-cap/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high` at `:high`; GPT (`gpt-6-luna`) and
Gemini lanes are prohibited this round (quota exhausted). Delegated workers
resolve to `modelRoles.task`; never `:xhigh`/`:max`.

## History

History: Gemini-first → Luna-first → Gemini-first again → Luna-first again →
Luna-default with DeepSeek on bulk review → owner ruling (2026-10-29): GPT subagents and vision at `:high`; Gemini prohibited; delegated workers resolve to `modelRoles.task` → **owner ruling (2026-10-30): temporary all-DeepSeek (`cx-cap`) policy; GPT and Gemini lanes banned; revert via `config.yml.bak-20261029-r17` / `-r14`.**
