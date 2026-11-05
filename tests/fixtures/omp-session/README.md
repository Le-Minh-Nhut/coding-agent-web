# `omp-session` fixtures

Native OMP session-journal JSONL, used by `tests/web/agent-transcript.test.ts` to
prove the agent-detail parse layer (`apps/web/src/agent-transcript.ts`) reads real
journals without inventing anything.

Every file begins with the fixed-width 255-byte `title` slot record
(`physically line 0`, upstream `packages/coding-agent/src/session/session-title-slot.ts`),
which is **not** a `SessionEntry` and therefore produces no row.

## Provenance

| File | Kind | OMP version | Bytes | Bytes on line 0 | Records |
| --- | --- | --- | --- | --- | --- |
| `real-subagent-LaneLockCheck.jsonl` | **real**, copied byte-for-byte | 18.13.0 | 23,399 | 255 | 16 |
| `native-edge-cases.jsonl` | synthesized | — | 4,601 | 255 | 15 + 1 malformed + 1 blank |
| `native-no-session-init.jsonl` | synthesized | — | 1,191 | 255 | 5 |
| `native-partial-tail.jsonl` | synthesized | — | 4,824 | 255 | `native-edge-cases` + 1 truncated tail, no trailing newline |
| `native-partial-tail-complete.jsonl` | synthesized | — | 5,048 | 255 | the same, with that tail record written whole |

### `real-subagent-LaneLockCheck.jsonl`

Captured on this machine from

```
~/.omp/agent/sessions/-data-coding-agent-web/2026-10-25T11-32-49-762Z_01a172d5-b1e2-7043-9bbf-b9901a8a705a/LaneLockCheck.jsonl
```

A `task`-tool subagent run in `/home/heheboiz/data/coding-agent-web`, written by
**OMP 18.13.0**. Copied with no edits, structure redacted from nothing (there was
nothing to redact — see *Secret scan*). Record inventory, in file order:

```
0  title                      8  custom  tool_execution_start
1  session                    9  message toolResult (bash, isError: true)
2  model_change              10  message assistant (toolCall: bash)
3  thinking_level_change     11  custom  tool_execution_start
4  session_init              12  message toolResult (bash)
5  message user              13  custom_message launch-completion (display: true)
6  custom  system-prompt-digest  14  message assistant (text)
7  message assistant (toolCall: bash)  15  custom session_exit
```

It is the smallest journal on this machine that carries a user turn, two assistant
tool-call turns, one **failing** and one succeeding tool result, a visible status
message, a model change and a clean exit. `session_init` carries
`task` / `agent: "caw-deepseek"` / `resolvedModel: "9router/cx/gpt-6-luna:high"`.

What it deliberately does **not** carry: `compaction`, `branch_summary` (see
`native-edge-cases` coverage note below), and a second `model_change`.

### `native-edge-cases.jsonl`

Synthesized to cover what the real sample cannot: **two** `model_change` records
(to prove last-wins), a user → assistant(`toolCall`) → `toolResult` chain with
matching `toolCallId`s, one `isError: true` tool result, one malformed line,
one blank line, and the `display: false`-style bookkeeping records
(`custom: tool_execution_start`, `custom: session_exit`) that must produce no
duplicate rows.

It does **not** contain a `compaction` or `branch_summary` record; both are already
covered end-to-end by `tests/web/transcript.test.ts` against the wire shape, which
is byte-identical to the native one for these two types.

### `native-no-session-init.jsonl`

A journal with a `model_change` but no `session_init` — proves `task`/`agentName`
report `null` while `model` is still derived rather than dropped.

### `native-partial-tail.jsonl` and `native-partial-tail-complete.jsonl`

The same journal at two moments. `…-partial-tail` is `native-edge-cases.jsonl`
followed by a `message` record cut mid-write, with **no trailing newline**;
`…-partial-tail-complete` is that record written whole afterwards. `applyTranscript`
(`apps/web/src/transcript.ts:609-613`) splits the former into `text` (complete lines)
+ `carry` (the tail), which is what the `complete === false` path and the "carry is
never parsed" rule are tested against — and the pair is what proves the completed
record arrives as exactly one appended row, without renumbering the earlier ones.

## Secret scan and path content

All five files were scanned for `sk-…`, `ghp_…`, `gho_…`, `xox[baprs]-…`,
`AKIA…`, PEM private-key headers, and long base64 runs: **no matches**. The real
file's only `password`/`token`-looking hits are the prose words "Tokens" and
"tool budgets" inside an assistant reply.

The real file does contain this machine's absolute paths —
`/home/heheboiz/data/coding-agent-web` (the repo's own checkout) and the source
journal's own path under `~/.omp/agent/sessions/`. They were **kept**, because
rewriting them would make the fixture no longer what it claims to be, and because
this repo already ships exactly these strings in its tests
(`tests/adapter/collab-registry.test.ts:47`, `tests/e2e/fixture.ts:704`) and docs.
None of them is a credential or a secret location.
