# Subagent model policy

Which model to delegate to, and why. Recorded because the preference changed
several times during the project and an unrecorded reversal gets re-litigated.

## Current priority

| Priority | Agent definition | Model | Use for |
| --- | --- | --- | --- |
| 1 | `caw-luna`, `caw-luna-scout` | `cx/gpt-6-luna:xhigh` | Everything else, including reading images. Luna remains the image reader; never give images to DeepSeek. |
| 2 | `caw-deepseek` | `wdb/deepseek-ai/DeepSeek-V4.1-Flash:high` | Long-horizon or token-heavy reviews: whole-file audits, multi-file independent reviews, full test inventories, regression sweeps, bulk doc-consistency passes, and second-opinion passes. |
| 3 | `caw-gemini` | `ag/gemini-3.8-flash-high` | Do not use; quota exhausted. |

### Why Luna remains default, DeepSeek handles bulk review

The owner's Gemini quota is exhausted. Do not use Gemini until the owner
restores quota. Long-horizon review runs are dominated by reading volume rather
than hard reasoning, and Luna's quota/throughput is the scarce resource. Route
that bulk reading to DeepSeek, the cheap, high-capacity lane; keep Luna for all
other work and all image reading.

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

History: Gemini-first → Luna-first → Gemini-first again → Luna-first again →
Luna-default with DeepSeek on bulk review. The latest change refines usage
policy, not quota reversal: Gemini remains unused after quota exhaustion; Luna
remains the image reader and default for everything else, while DeepSeek takes
long/token-heavy reviews.
