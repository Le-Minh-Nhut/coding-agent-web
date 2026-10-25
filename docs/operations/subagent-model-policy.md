# Subagent model policy

Which model to delegate to, and why. Recorded because the preference changed
several times during the project and an unrecorded reversal gets re-litigated.

## Current priority

| Priority | Agent definition | Model | Use for |
| --- | --- | --- | --- |
| 1 | `caw-luna`, `caw-luna-scout` | `cx/gpt-6-luna:xhigh` | **Default for everything**, including reading images |
| 2 | `caw-deepseek` | `wdb/deepseek-ai/DeepSeek-V4.1-Flash:high` | Parallel volume work, tests, documentation, second-opinion review |
| — | `caw-gemini` | `ag/gemini-3.8-flash-high:high` | **Do not use** — quota is exhausted |

### Why Gemini is out

Gemini 3.8 Flash was first choice for throughput for most of the project. Its
quota is now spent, so delegation moved to `cx/gpt-6-luna:xhigh`, which is also the
stronger reasoning model here. Do not reach for Gemini; if a task seems to need it,
use Luna.

The advisor role was also moved off Gemini's lane earlier, so nothing else depends
on that quota.

## Image reading

The main agent cannot put image bytes into its own context: once multimodal data
entered that session, every later turn in that model lane failed with
`Received multimodal data but multimodal processing is not enabled`. Screenshot
inspection is therefore always delegated — **now to `caw-luna`, not Gemini**.

If Luna ever refuses the image payload, stop and say so rather than burning the
turn; do not silently fall back to Gemini.

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

The policy was Gemini-first, then Gemini-last, then Gemini-first again, and is now
Luna-first because Gemini's quota is spent. If Gemini's quota is restored and Luna
becomes the scarce resource, revise this file rather than relying on memory.
