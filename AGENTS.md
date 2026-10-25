# AGENTS.md — working rules for this repository

Coding Agent Web is a single-owner, self-hosted control plane for OMP coding
agents running on the owner's Ubuntu machine, driven from an iPhone.

## The invariant everything serves

> **One native OMP session has at most one writer, and the app never creates a
> second one by accident.**

Read `docs/architecture/session-lifecycle.md` before touching lifecycle,
launch, or reconciliation code. Read `docs/adr/0001-runtime-architecture.md`
before proposing an architectural change.

## Repository layout

```
apps/server            Fastify HTTP API, auth, path policy, metadata store, runtime wiring
apps/web               mobile-first React client
packages/contracts     shared types + zod request schemas (the API boundary)
packages/omp-adapter   the ONLY place that shells out to omp/tmux/registry
packages/relay         private Collab relay (content-blind, loopback-bound)
packages/guest         vendored + patched upstream browser guest client
tests/{server,adapter,runtime,protocol,relay,guest,web,e2e,compat}
docs/{adr,architecture,research,operations,audits}
scripts/               compat probe, guest build
```

## Hard rules

1. **No shell strings.** Every child process is array-argv with `shell: false`.
   `swarm`/`pkill`/name globs are forbidden.
2. **tmux sessions are addressed by `#{session_id}` (`$N`)**, never by name.
   `new-session` must use `-P -F '#{session_id}'`. Names are display labels.
   Ownership is the app's **private socket**, not a name prefix: enumerate every
   session on it, because renaming a session must never hide a process we own.
   Dispose of a process only after corroborating its **pane pid** — an unreachable
   socket path is not evidence that a process exited.
3. **A Collab link is a bearer credential.** Never log it, never store it in
   persistent browser storage, never expose the room path or secret in an HTTP
   request URL (it travels only in the URL fragment of generated deep links),
   and never send it in a notification. `Referrer-Policy: no-referrer` on
   everything we serve.
4. **Loopback by default.** Any non-loopback bind must be an explicit,
   documented configuration choice.
5. **Paths come from `WorkspacePathPolicy`.** No route reads the filesystem
   directly. Canonicalize, then check containment by path segment.
6. **`unknown` is an acceptable state; a guess is not.** `busy === false` does
   not mean "finished". A dropped socket does not mean "stopped". A backend
   restart does not mean "completed".
7. **Never launch a second writer.** Probe the session lease first; if it is
   held (or unknowable), refuse with `conflict_owner`.
8. **Deleting a project never deletes files.** Metadata only, and the response
   says so.
9. **No unverified success claims.** If you did not run it, say you did not.
10. **Never pass `effort` when spawning a subagent.** A coarse hint
   (`lo`/`med`/`hi`) **outranks** the `:level` suffix in the agent definition and
   maps onto the model's supported range rather than the canonical order, so
   `med` silently resolves to `low` on a model whose range starts at `minimal`.
   Verified in `packages/coding-agent/src/task/executor.ts:4504` (precedence) and
   `packages/tui/src/thinking.ts:295` (mapping), and observed in a session
   journal as `"thinkingLevel":"low"`. Let the `:level` suffix in the model id do
   the work — see `docs/operations/subagent-effort-policy.md`.
11. **Never read an image yourself. Delegate every screenshot or image read to a
   subagent.** The main agent's model lane rejects multimodal payloads: once
   image bytes entered its context, every later turn in that session failed with
   `Received multimodal data but multimodal processing is not enabled`. Ask a
   `caw-luna` subagent to read the file and report what it shows. This is a hard
   constraint on the main agent, not a preference; the model used is whatever
   `docs/operations/subagent-model-policy.md` currently names.

## Conventions

- TypeScript strict, ESM, Node 20. Prefer `node:` builtins over new dependencies.
- Shared types live in `packages/contracts`; adapters implement the interfaces in
  `packages/omp-adapter/src/types.ts`.
- Every non-trivial module leaves one runnable check. No frameworks beyond vitest.
- Never test wiring, mock echoes, or that a function was called. Test behaviour:
  boundaries, state transitions, error paths, ordering.
- Comments explain *why* (a constraint, an upstream quirk) — never *what*.

## Test entry points

```bash
pnpm typecheck                        # all packages
pnpm test                             # unit + integration + web (free; spawns no agent)
pnpm test:watch
pnpm compat                           # machine capability probe (spawns nothing)

# browser E2E at a phone viewport. /tmp can hit a write quota on some machines,
# so point TMPDIR somewhere with room (see docs/operations/environment-quirks.md).
TMPDIR=$HOME/.cache pnpm test:e2e

# real OMP: launches agents, opt-in, may spend provider credits
CAW_COMPAT=1 pnpm vitest run tests/compat

# the acceptance check that proves the product end to end against a running server
node scripts/acceptance-ui-drives-agent.mjs --base <origin> --token-file <file> --root <dir>
```

## Verified environment baseline

OMP 18.12.2, tmux 3.6, Node 20.19.5, Ubuntu 26.04, Tailscale 1.104.1.
Details and the upgrade procedure: `docs/research/omp-compatibility.md`.

## Upstream references

Upstream source is the authority for protocol and CLI behaviour. Cite
`file:line` from `github.com/can1357/oh-my-pi` when a behaviour matters; do not
guess at wire formats.
