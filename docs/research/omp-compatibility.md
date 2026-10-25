# OMP Compatibility Matrix

Compatibility baseline for Coding Agent Web. Every claim here was produced by
running the installed binary on this machine, not read from documentation.

## Tested baseline

| Item | Value | How observed |
| --- | --- | --- |
| OMP binary | `/home/heheboiz/.local/bin/omp` | `command -v omp` |
| OMP version | `omp/18.12.2` | `omp --version` |
| Upstream source read | `main` tarball, extracted at `/tmp/caw-poc/oh-my-pi` | `codeload.github.com/can1357/oh-my-pi/tar.gz/refs/heads/main` |
| Update available at test time | `18.12.6` | OMP TUI "Update Available" banner |
| Node | `v20.19.5` | `node -v` |
| pnpm | `10.32.1` | `pnpm -v` |
| Bun (used only to build the upstream browser client) | `1.4.4` | `~/.bun/bin/bun --version` |
| tmux | `3.6` | `tmux -V` |
| Tailscale | `1.104.1` | `tailscale version` |
| OS | Ubuntu 26.04.1 LTS, kernel 7.0.0-38 | `cat /etc/os-release`, `uname -a` |

Documentation cached while testing: `collab.md`, `session.md`, `rpc.md`,
`sdk.md`, `cli-reference.md`, `tools/task.md`, `advisor-watchdog.md` from
`raw.githubusercontent.com/can1357/oh-my-pi/main/docs/`.

## Verified capabilities

| Capability | Command / evidence | Result |
| --- | --- | --- |
| Host a session over Collab | tmux + `--config` overlay with `collab.autoStart: control` | Published to the local registry |
| Enumerate live local hosts | `omp collab list --json` | `{"version":1,"hosts":[…]}` with `instanceId,g eneration,pid,sessionId,sessionName,cwd,model,startedAt,participants,relayConnected,inputRequired,busy,access` |
| Retrieve a control link | `omp collab link <instanceId> --json` | `{version,instanceId,generation,access,url}`; control fragment 87 chars, view 66 chars |
| Retrieve a view-only link | `omp collab link <instanceId> --view --json` | `access: "view"` |
| Custom relay | `collab.relayUrl: ws://localhost:7466` in an overlay config | `relayConnected: true` against a private relay |
| Relay scheme policy | `packages/coding-agent/src/collab/protocol.ts:216` | Non-localhost `ws://` rejected: "relay link must be wss:// (plain ws:// is only allowed for localhost)" |
| Custom web UI origin | `collab.webUrl` + `formatCollabWebLink` (`protocol.ts:283`) | Browser deep link = `<webUrl>/#<relayLink>`; web UI may differ from the relay host |
| Guest drives the host agent | `omp join <link>` in tmux, then a typed prompt | Host executed the prompt; reply streamed back to the guest |
| Browser guest drives the host agent | Upstream client at a deep link, `Enter` in its composer | Prompt reached the host, reply rendered (screenshot: guest prompt + `BROWSER-OK`) |
| Terminal continuity | `tmux attach -t <session>` / `tmux capture-pane -pt <session>` while a guest is active | Same process, same turn; no second agent |
| Session identity | Session files under `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuidv7>.jsonl` | Header line carries `cwd`, `id`, `timestamp`, `version` |
| Liveness lease | `@omp-file-lock-<xxh64(lockPath,seed) hex×2>` bound on Linux abstract Unix sockets | Reproduced for a live session; present in `/proc/net/unix` |
| Concurrent writer behavior | Second process resuming a live session | **Forks**: "Session … is open for writing in another omp process, so this session now saves to … instead of mixing its entries into that file." (`packages/coding-agent/src/modes/persistence-failure.ts:38`) |

## Gaps and limits found

- `busy` is a turn-in-flight flag only. OMP's own docs state it reads `false`
  during scheduling pauses (queued follow-ups, async-job waits, compaction) and
  that unknown must not be read as idle. Our status model therefore keeps
  `unknown`/`disconnected` distinct from `idle`.
- The production Collab relay is closed-source and not distributed; supply is
  either the hosted `wss://my.omp.sh` or a private relay we run ourselves.
- A browser guest gets no terminal, no slash commands, and approvals degrade to
  simple select prompts (see `docs/research/collab-data-model.md`).
- `collab link` is bound to a room `generation`; a session switch invalidates it
  with `stale_generation`, so links are fetched per use and never cached long-term.

## Upgrade procedure

1. `omp update`, then re-run `omp --version` and record it here.
2. Re-run `pnpm test` and the compatibility script `scripts/compat-check.mjs`.
3. Re-check the registry JSON field set against
   `packages/coding-agent/src/collab/registry.ts` and the frame grammar against
   `packages/coding-agent/src/collab/protocol.ts` at the new revision.
4. Update this table with the new baseline before shipping.
