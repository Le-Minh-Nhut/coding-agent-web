# Subagent model policy

Which model to delegate to, and why. Recorded because the preference changed
several times during the project and an unrecorded reversal gets re-litigated.

## Current priority

**Policy (2026-10-31): every lane routes to `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high`.**
The provider restored the full 1M context window, so the temporary 200k `cx-cap`
alias was removed from `models.yml`; `9router/wdb/…` reports
`contextWindow: 1000000, maxTokens: 128000` (verified via `omp models 9router` and the runtime
log). Every fallback target is `9router/…` DeepSeek. `modelRoles.default` is
`9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:max` (interactive default only).

| Priority | Agent definition | Model | Use for |
| --- | --- | --- | --- |
| 1 | all delegated agents | `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high` | Everything except image reading. |
| 2 | `caw-gemini`, `caw-luna` lanes | — | Prohibited this round; quota exhausted. |

### Why all lanes are DeepSeek (temporary)

The owner's Gemini quota is exhausted and GPT/Gemini lanes are banned this round.
Everything — including bulk reading — routes to the `cx` DeepSeek lane.
The `cx-cap` cap doc (`docs/operations/deepseek-context-cap.md`) records how the
200k alias was built and removed, if it ever needs restoring.

## Image reading

The main agent never puts image bytes in its own context: once image data enters
the main lane, every later turn in that session fails with a multimodal error.
Delegate the read to a subagent running a vision-capable DeepSeek lane; the
subagent reports what it sees as text.

Owner note (2026-10-31): reading an opened screenshot belongs on the free
`cbai/deepseek-v4.1-flash` lane (prefix `cbai/`), not on the paid `wdb` route.
Whether image reading runs at all is a per-round owner decision — this session's
r26 round was authorised for it; do not assume it for other rounds.


## Effort: never pass the coarse `effort` hint

A separate trap, documented in full in
`docs/operations/subagent-effort-policy.md`: the task tool's coarse `effort`
parameter **outranks** the `:level` suffix in an agent definition, and it maps onto
the model's *supported* list rather than the canonical order. For a model whose
range is `minimal,low,medium,high`, `effort: "med"` resolves to index
`(4-1)>>1 = 1` = **`low`**. So a "medium" hint silently downgrades a worker to its
lowest thinking level — observed in a session journal as `"thinkingLevel":"low"`.

State the level in the model id (`9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high`) and do not pass `effort`.

Owner ruling (2026-10-31): all subagent/delegated lanes route to
`9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high` at `:high`; GPT (`gpt-6-luna`) and
Gemini lanes are prohibited this round (quota exhausted). Delegated workers
resolve to `modelRoles.task`; never `:xhigh`/`:max`.

## History

History: Gemini-first → Luna-first → Gemini-first again → Luna-first again →
Luna-default with DeepSeek on bulk review → owner ruling (2026-10-29): GPT subagents and vision at `:high`; Gemini prohibited; delegated workers resolve to `modelRoles.task` → owner ruling (2026-10-30): temporary all-DeepSeek (`cx-cap`) policy; GPT and Gemini lanes banned; revert via `config.yml.bak-20261029-r17` / `-r14` → **owner ruling (2026-10-31): provider restored the 1M window; `cx-cap` provider removed from `models.yml`; every lane → `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high` (still DeepSeek-only, GPT/Gemini banned).**
