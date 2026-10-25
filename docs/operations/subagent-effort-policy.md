Configuration discipline note — thinking effort on subagent spawns.

**Rule for this project: never pass the `effort` parameter when spawning a `caw-gemini` subagent.**

Why: verified in upstream source. `packages/coding-agent/src/task/executor.ts:4504` states the precedence explicitly —

```
Precedence: caller `effort` > explicit `:level` suffix on the resolved
model pattern > agent-definition default (e.g. task's `auto`) >
pattern-derived level.
```

and `packages/coding-agent/src/task/executor.ts:442` confirms the coarse hint "maps onto the resolved model's supported thinking range and wins over `thinkingLevel`".

The mapping itself (`packages/tui/src/thinking.ts:295` `resolveTaskEffortLevel`) picks from the model's **supported list**, not from the canonical order:

| coarse hint | Gemini's range `minimal,low,medium,high` resolves to |
| --- | --- |
| `lo` | `minimal` |
| `med` | `supported[(4-1)>>1]` = `supported[1]` = **`low`** |
| `hi` | `high` |

So `effort: "med"` silently downgrades Gemini to **low** — the opposite of intent. Omitting `effort` leaves `effortLevel === undefined`, and the `:high` suffix in `packages/omp/agents/caw-gemini.md` (`model: 9router/ag/gemini-3.8-flash-high:high`) applies.

`task.maxEffort: xhigh` in the OMP config is a **ceiling**, not a target: it can only clamp downward, so it never lowers a requested `high`.

**Operational consequence:** the model identifier already encodes the level (`ag/gemini-3.8-flash-high:high`, `cx/gpt-6-luna:xhigh`, `wdb/deepseek-ai/DeepSeek-V4.1-Flash:high`). Pass `model` and let the suffix do the work; pass `effort` only when a deliberate downgrade is wanted, and state that intent in the task.
