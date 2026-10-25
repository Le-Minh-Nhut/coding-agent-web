# Subagent model policy

Which model to delegate to, and why. Recorded because the preference changed
several times during the project and an unrecorded reversal gets re-litigated.

## Current priority

| Priority | Agent definition | Model | Use for |
| --- | --- | --- | --- |
| 1 | `caw-luna`, `caw-luna-scout` | `cx/gpt-6-luna:xhigh` | Everything, including reading images |
| 2 | `caw-deepseek` | `wdb/deepseek-ai/DeepSeek-V4.1-Flash:high` | Parallel volume work, tests, docs, second-opinion review |
| 3 | `caw-gemini` | `ag/gemini-3.8-flash-high` | Do not use; quota exhausted |

### Why Luna is first again

The owner's Gemini quota is exhausted again. Do not use Gemini until the owner
restores quota.

## Image reading

The main agent must never put image bytes in its own context. Screenshot
inspection is always delegated to `caw-luna` / `caw-luna-scout`. If Luna refuses
an image payload, say so plainly rather than silently falling back to Gemini;
Gemini cannot run while its quota is exhausted.


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

History: Gemini-first → Luna-first → Gemini-first again → Luna-first again. The
third reversal follows renewed `ag/gemini-3.8-flash-high` quota exhaustion; the
owner directed Luna-first, DeepSeek second, and Gemini unused.
