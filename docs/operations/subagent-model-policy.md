# Subagent model policy

Which model to delegate to, and why. Recorded because the preference changed
several times during the project and an unrecorded reversal gets re-litigated.

## Current priority

| Priority | Agent definition | Model | Use for |
| --- | --- | --- | --- |
| 1 | `caw-gemini` | `ag/gemini-3.8-flash-high:high` | Everything, including reading images |
| 2 | `caw-luna`, `caw-luna-scout` | `cx/gpt-6-luna:xhigh` | Parallel volume work and any task Gemini refuses |
| 3 | `caw-deepseek` | `wdb/deepseek-ai/DeepSeek-V4.1-Flash:high` | Tests, documentation, second-opinion review |

### Why Gemini is first again

The owner restored Gemini quota and asked for Gemini-first. If Gemini refuses an
image payload, say so plainly instead of silently falling back; use Luna for that
specific read.

## Image reading

The main agent must never put image bytes in its own context. Screenshot
inspection is always delegated; use `caw-gemini` first, and if it refuses the
image payload, say so plainly and use `caw-luna` for that specific read.

## Effort: never pass the coarse `effort` hint

A separate trap, documented in full in
`docs/operations/subagent-effort-policy.md`: the task tool's coarse `effort`
parameter **outranks** the `:level` suffix in an agent definition, and it maps onto
the model's *supported* list rather than the canonical order. For a model whose
range is `minimal,low,medium,high`, `effort: "med"` resolves to index
`(4-1)>>1 = 1` = **`low`**. So a "medium" hint silently downgrades a worker to its
lowest thinking level — observed in a session journal as `"thinkingLevel":"low"`.

State the level in the model id (`cx/gpt-6-luna:xhigh`) and do not pass `effort`.

## History

History: Gemini-first → Luna-first → Gemini-first again. The last reversal records
the quota restoration and the owner's renewed Gemini-first instruction.
