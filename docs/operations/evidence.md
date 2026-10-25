# Verified evidence log

Raw observations behind the status ledger. If a claim in
`docs/operations/implementation-status.md` is not traceable to something here,
treat it as unverified.

## Test suite state

Last full run of `npx vitest run` (default, no opt-in env):

```
Test Files  38 passed | 2 skipped (40)
     Tests  334 passed | 8 skipped (342)
```

The skipped files are `tests/compat/omp-lifecycle.test.ts` and
`tests/compat/reconciliation.test.ts`, which launch real agents and are
intentionally opt-in.

## Real-OMP compatibility (opt-in)

`CAW_COMPAT=1 npx vitest run tests/compat`:

```
✓ tests/compat/omp-lifecycle.test.ts (2 tests)
✓ tests/compat/reconciliation.test.ts (6 tests)
Test Files  2 passed (2)
     Tests  8 passed (8)
```

What that run actually exercised, against the real `omp` binary and a private tmux
server (`-L caw-compat-<pid>-<rand>`, so the owner's sessions are untouched):

1. The capability probe found `omp` and `tmux` on this machine.
2. `RuntimeAdapters.launch` started a managed agent through `DefaultTmuxService`,
   which used `new-session -d -P -F '#{session_id}'` and returned a real `$N`.
3. The launch succeeded with `collab.relayUrl: ws://localhost:39999` — a relay
   that is deliberately **not listening** — so the session published itself with
   `relayConnected: false`. The product's degraded path is therefore exercised,
   not assumed.
4. `tmux.getById($N).alive` was true, and `capture-pane` returned the agent's own
   TUI text: the same bytes `tmux attach` would show the owner.
5. A second `supervisor.start` for the same conversation rejected with
   `conflict_owner`, and `listManaged()` still returned exactly one session. This
   is the duplicate-writer invariant, tested against a real process.
6. `supervisor.stop` killed by recorded `$N`; the session was gone afterwards.

## Machine capability probe

`node scripts/compat-check.mjs` → `18 ok, 0 warn, 0 fail`, including:
OMP 18.12.2 parsed; `--resume`/`--restore`/`--config=`/`--session-dir=` present;
`omp collab list|link` present; `collab list --json` shape complete
(`instanceId, generation, pid, sessionId, cwd, relayConnected, inputRequired,
busy, access`); tmux 3.6 with `#{session_id}` format; session store present;
16 writer-lease sockets visible in `/proc/net/unix`; all three `collab.*` config
keys present.

## Architecture proof (M0, recorded in docs/research/proof-of-concept.md)

| Claim | Observation |
| --- | --- |
| tmux-hosted OMP hosts itself over Collab | registry row with `relayConnected: true` |
| A private relay is viable | OMP connected to a Node relay; `relayConnected: true` |
| A browser guest drives the agent | prompt from a 390×844 viewport → agent reply rendered in the transcript |
| A guest over the *private* relay drives the agent | `omp join` against it → `RELEAY-OK` from the host |
| A terminal attaches to the same process | `capture-pane` showed the same prompt/reply |
| Resume of an existing native session works under a managed launch | second registry row for the resumed session, `relayConnected: true` |
| Two conversations run independently | two registry rows alive simultaneously |
| **Closing the browser does not stop the agent** | page closed while `busy: true`; agent finished a 25-line response with no viewer |
| **A fresh browser session adopts the same agent** | new page showed output produced while no browser existed; nothing resubmitted |
| A second writer forks rather than corrupts | "…is open for writing in another omp process, so this session now saves to … instead" |
| Liveness is externally observable | lease socket name reproduced and matched `/proc/net/unix` |

## Deliberately not claimed

- iOS Safari behaviour: everything above used Chromium at a mobile viewport.
  The software keyboard, safe-area insets, and tab suspension need a real device.
- Approval (`ui-request`) handling against a host that actually asks a question.
- Behaviour when the app **server** restarts mid-turn (reconciliation is unit
  tested, not yet exercised against a live pair).
- Anything about the hosted relay: this deployment does not use it.
