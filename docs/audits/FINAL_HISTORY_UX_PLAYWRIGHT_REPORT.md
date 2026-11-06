# History recovery and mobile UX — Playwright report

Round 57. Commit `54ef6e0` on `main`; deployed to the live service and verified
against the owner's own running sessions.

## A — Reported symptom

The owner's screenshot showed a conversation titled "New chat" with the model
`DeepSeek-V4.1-Flash`, status **idle**, and the body reading:

> Connected to this conversation's agent.
> No prompts yet. Send one below to start the turn.

The same screen had previously shown history after a wait, so the user's own
expectation — and the correct one — was that the conversation had content.

The screenshot is **not** evidence that the native journal is empty. It is
evidence that the UI decided the conversation was empty. Those are different
claims, and the difference is the whole defect.

## B — Root cause

Two independent causes, both confirmed from live evidence before anything was
changed. Either one alone leaves the screen blank, which is why fixing one and
claiming victory would have been wrong.

### B1 — The relay closed the phone mid-snapshot (transport)

The guest's snapshot is the conversation's history, and it is large. The owner's
bound session `01a1aa0b-fec4-7629-8043-6993c82d793f` was **4907 lines / ~10.6 MB**
and growing during the audit.

`packages/relay/src/relay.ts` closed any peer whose socket buffer crossed 4 MiB:

```ts
if (target.bufferedAmount > MAX_BUFFERED_BYTES) {
  logger.warn("[relay] closing backed-up peer: send buffer over ceiling");
  target.close(1013, "peer too slow");
```

The live log shows it happening to every join, in a loop:

```
13:01:08 [relay] guest 34 connected to room 6sLsfp2dpaIeo9-lRohN8A (1 guests)
13:01:08 [relay] closing backed-up peer: send buffer over ceiling
13:01:10 [relay] guest 34 left room 6sLsfp2dpaIeo9-lRohN8A
13:01:12 [relay] guest 35 connected to room 6sLsfp2dpaIeo9-lRohN8A (1 guests)
13:01:12 [relay] closing backed-up peer: send buffer over ceiling
```

`6sLsfp2dpaIeo9-lRohN8A` is the room of conversation `b2dc0c99` — the one in the
screenshot — confirmed by asking the host for that conversation's link and
comparing room ids.

Both guests read that close as an interrupted snapshot. `packages/guest/src/lib/client.ts`
and the web reducer both keep entries private until the snapshot completes:

> Buffer fragments and publish the transcript once, when the snapshot completes

So the client reconnected, was closed again, and the transcript never published.
A fresh load could not help: the loop was deterministic, and only the loopback
probe in this round survived it (a local reader drains instantly, so it never
built the backlog).

### B2 — "Empty" was inferred from a zero message count (state machine)

`apps/web/src/components/ConversationView.tsx` authorised the empty state with:

```tsx
{messages.length === 0 && !streamingText && !linkUnavailable && (
  ...
  {status === "idle" && (<> ... No prompts yet ... </>)}
```

An in-flight snapshot also has zero messages. So **any** conversation whose
history had not yet arrived rendered as brand new — including a fast client on a
perfect connection, for as long as the snapshot took. Even with B1 fixed, the
user would have stared at "No prompts yet" for the duration of an 11 MB
download.

Nothing anywhere declared a snapshot dead. The reducer had no notion of a
stalled or failed sync, so a truncated snapshot left "Loading…" forever with no
exit — which is why the original version of this bug *eventually* resolved after
a wait but this one never did.

## C — Conversation identity

The chain the code actually uses:

```
CAW conversation row
  └─ nativeSessionId ──────────► the live host's session, matched in `omp collab list`
     nativeSessionPath ────────► the journal CAW would `--resume`
        └─ /api/conversations/:id/link
             └─ Collab room (ws url + key)  ← this is what the transcript comes from
```

The transcript is **not** read from the journal in live mode; the journal is only
used by the saved-history/archived path and by handoff evidence. So the values of
`nativeSessionId` / `nativeSessionPath` do not, on their own, decide whether the
screen shows anything — which is why B1 and B2 were the causes and the identity
oddities below are not.

Two real identity discrepancies were found and are recorded rather than papered
over (also in `HISTORY_AND_MOBILE_UX_BASELINE.md`):

- **`b2dc0c99` ("New chat") serves a session it never created.** Its pane process
  `2082046` was launched *without* `--resume` (argv: `omp --config=…/b2dc0c99-….yml`,
  and the four other arguments after `--config` are the config path split by NUL,
  not a resume operand). OMP then adopted the project's most recent session
  `01a1aa0b` — a 4907-line journal — while the row's `nativeSessionPath` stayed
  `null`, so the two roles of those columns have diverged.
- **`01321407` records `01a17ac9`, but its live host serves `01a1a258`.** A fork
  journal for `01a1a258` exists, consistent with OMP's documented
  fork-on-concurrent-writer behaviour rather than with data loss; the CAW row
  holds the pre-fork identity.

Both are worth a follow-up. Neither is displayed wrongly by this round's code,
because the live transcript's identity comes from the host the link points at.

## D — Snapshot synchronization

Measured against the live host, not inferred.

Welcome carries metadata only (`collab/host.ts:820-839`): header, state, agents,
and `entryCount`. The entries follow as `snapshot-chunk` frames of up to 512 KiB
(`collab/host.ts:134`), and the guest publishes only when `final` is set or the
promised count is reached.

| Measurement | Value |
| --- | --- |
| Host-side promise (`welcome.entryCount`) | 3915 |
| Chunks delivered | 24 |
| Entries delivered | 3915 / 3915 |
| Payload | 11,922,944 bytes (~11.4 MB) |
| `final` chunk seen | yes |
| Wall time | **187 ms** after the fix |

Before the relay fix the same read could not complete at all over a real client.

## E — Fixes

1. **Relay pauses a slow peer instead of closing it** (`packages/relay/src/relay.ts`).
   A new per-peer pump holds frames once a peer is `PAUSE_BYTES` (1 MiB) behind
   and releases the whole backlog in arrival order once it drains to
   `RESUME_BYTES` (256 KiB). A paused peer keeps its room membership and peer id,
   so a resync is a resume, not a rejoin. Only a peer that never drains is closed,
   past `MAX_QUEUED_BYTES` (16 MiB) — measured on the queued side, because a paused
   peer's `bufferedAmount` is not what is growing.
2. **A sync state machine replaces the length check** (`apps/web/src/transcript.ts`).
   `SyncStatus = loading | stalled | ready | empty`. `empty` requires positive
   evidence: a welcome declaring zero entries, or a completed snapshot that
   honoured a promise of nothing. A snapshot that promised entries and delivered
   none is `stalled`, not `empty` — the journal claim would be unsupported.
3. **A progress timeout, not a total-duration one.** 30 s without a chunk marks
   the snapshot stalled (`SNAPSHOT_PROGRESS_TIMEOUT_MS`), mirroring upstream's own
   guest. A slow but progressing 11 MB snapshot is never failed for taking long.
4. **`bye` mid-snapshot discards the partial prefix** rather than publishing an
   arbitrary slice of the history as the transcript. Verified history is kept.
5. **Retry rejoins the same conversation.** Same id, same link request, same
   socket construction — it cannot launch a process, submit a prompt, drop the
   draft, or clear verified rows, because it touches none of them.
6. **Distinct states are visibly distinct** (`ConversationView.tsx`, `styles.css`):
   a centred `Loading conversation…` with the host's own received/total count, a
   deliberate verified-empty state, a stalled state with Retry, and a
   disconnected state that keeps history and says so.
7. **Handoff completion is journal-gated** (`apps/server/src/app.ts`,
   `ConversationView.tsx`). `delivered` proves the keystrokes reached the pane and
   nothing more; the completion notification appears only when the session's own
   journal shows the `method: "handoff"` compaction, and is correlated to this
   operation by the store's event **sequence** (not timestamps — the phone's clock
   is not the server's). The server records `handoff-committed`, which is what
   makes the outcome survive a reload. The offer card now closes on a settled
   outcome, because the banner was previously hidden behind it.
8. **Presentation honesty**: the header shows a friendly model name with the
   authoritative id kept as `title`/`aria-label`; a historical agent total no
   longer reads as concurrent load.

## F — Playwright evidence

All runs: Chromium (`channel: "chrome"`), the project's own config, real built
assets, mock Collab host (no agent is launched, so a full run is free). Test
timeouts are the spec's own; `HIST-03` sets 120 s because the stall window is 30 s.

### `tests/e2e/history-loading.spec.ts` — 15/15 PASS

| Test | What it proves | Duration |
| --- | --- | --- |
| HIST-01 | 50-message conversation renders all 50 in order | 1.0 s |
| HIST-02 | welcome with entries pending shows loading, never "No prompts yet"; shows `0 of 3238` | 735 ms |
| HIST-03 | a stalled snapshot surfaces "History did not finish loading" + working Retry | 31.3 s |
| HIST-04 | multi-batch chunks: no duplicates, live row at the tail (21 rows) | 762 ms |
| HIST-05 | disconnect mid-snapshot drops the prefix instead of showing it | 738 ms |
| HIST-06 | reopening restores history, sends nothing (`prompts === []`) | 1.1 s |
| HIST-07 | refresh reloads history | 1.3 s |
| HIST-08 | switching conversations does not leak a transcript | 879 ms |
| HIST-09 | a genuinely empty session shows the empty state | 737 ms |
| HIST-10 | promised-but-undelivered is never called empty; offers Retry | 745 ms |
| HIST-11 | background/foreground reconnect recovers with no resubmit | 2.6 s |
| HIST-12 | host restart neither fabricates nor loses history | 2.8 s |
| HIST-13 | a compaction summary is preserved, not dropped | 724 ms |
| HIST-14 | 300-entry snapshot in 12 chunks never fails on total duration | 2.9 s |
| HIST-15 | malformed entries do not take valid rows down | 744 ms |

### `tests/e2e/handoff-completion.spec.ts` — 9/9 PASS

| Test | What it proves |
| --- | --- |
| delivered alone | reports "Handoff delivered", never `/Handoff completed/`, tone not success |
| journal evidence | the commit appearing *after* the paste turns it into `✓ Handoff completed … (journal entry comp-42)` |
| earlier commit | **an earlier handoff's commit cannot acknowledge a new one** (seq correlation) |
| committed | reported immediately, success tone |
| refusal | reported as a refusal, never success |
| delivery failure | error banner, no success banner |
| in flight | refused by name, claims nothing |
| navigate away | the notification survives leaving the panel |
| mobile viewport | the banner sits above the composer, transcript still scrollable |

### `tests/e2e/sync-states-visual.spec.ts` — 12/12 PASS

Five state screenshots plus the six required viewports
(320×568, 375×667, 390×844, 430×932, 768×1024, 1440×900), asserting no horizontal
document overflow, a reachable composer inside the viewport, a transcript with
usable height, and a header that does not overflow. Captured to
`~/.cache/caw-screens/`.

### Fail-before evidence

| Regression | On the pre-fix code |
| --- | --- |
| `tests/relay/flow-control.test.ts` (2 tests) | **both fail** — the stalled guest is dropped (1013) and its frames never arrive |
| `tests/web/round57-sync-state.test.ts` (14 tests) | **12 of 14 fail** — `welcome` produces no `sync` at all |
| handoff "earlier commit" | **fails** — the stale commit fabricates a completion |
| `HIST-02` / `HIST-10` | the old code shows "No prompts yet" for both |

### Not run

- **WebKit.** `~/.cache/ms-playwright` holds no WebKit build, so the project is
  omitted by the config's own rule. Not claimed as passing.
- **Physical iPhone Safari.** No device access. **BLOCKED.**

## G — Visual comparison

Screenshots were captured and reviewed. The empty/loading/failed/verified-empty/
disconnected states are now distinct compositions rather than one grey sentence,
the empty state is centred in the transcript's usable area (measured: top gap vs
bottom gap within 60 px) and clear of the composer, and the header no longer
carries the full `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash` path.

Remaining honest gaps against the owner's premium reference are recorded from the
screenshot review rather than asserted away — see section K.

## H — OMP compatibility

- **Mock evidence** (the whole Playwright suite): a stand-in Collab host in the
  page, driving the real reducer and the real components. Nothing here launches
  an agent.
- **Real native integration** (measured, not simulated): the relay fix was
  verified against the **live deployed relay and the live host** for session
  `01a1aa0b` — 3915/3915 entries, 24 chunks, `final: true`, 11.4 MB, 187 ms. The
  host was asked for a **view-only** link, so the probe could not send a prompt;
  it wrote nothing and closed after the read.
- Protocol and CLI facts are cited from the cached upstream source for the
  installed build (`~/.cache/r35-omp/src-v18.15.0`, OMP 18.15.0) and cross-checked
  against observed binary output.

## I — Regression

New: `tests/relay/flow-control.test.ts` (2), `tests/web/round57-sync-state.test.ts`
(14), `tests/web/round57-agent-scope-honesty.test.tsx` (6),
`tests/e2e/{history-loading,handoff-completion,sync-states-visual}.spec.ts` (36).

Updated where the redesign deliberately replaced copy, keeping each test's real
claim: `tests/web/round26-starting-link-banner.test.tsx` (re-pointed to the new
empty-state copy; still asserts a healthy idle link never shows the record's
startup warning), `tests/web/handoff.test.tsx` (completion text now cites the
journal entry id and the card closes), and the handoff/limit mocks that needed
`getConversationEvents`.

Previous behaviours re-checked by the full suites: native session ownership,
single-writer protection, the agent limit, advisor lifecycle, file diffs, browser
Back, draft preservation, and no duplicate WebSocket connections.

## J — Production

| Item | Value |
| --- | --- |
| Git SHA | `54ef6e0` (`main`), working tree clean |
| Deployed revision | `54ef6e0` — the service runs `node --import tsx apps/server/src/server.ts`, so the relay fix is live after a restart |
| Served JS | `assets/index-BXOo9qb1.js` sha256 `af77bcd36a9e36c6f570319be26e5219320ba830945ec546477ae61c55f51e5b` |
| Served CSS | `assets/index-CkGMPHlM.css` sha256 `0e7cc278e223f9ae8a3a05724d185b7f3806eeadacbf29ffcbb40aa1d20a92df` |
| Asset match | served `index.html` references exactly those two files; both byte-match `apps/web/dist` |
| systemd | `coding-agent-web.service` active, MainPID `4020587` |
| Reconcile | `{"adopted":3,"external":0,"stopped":2,"unknown":1,"registered":2}` |
| HTTPS | `GET /` → 200 over the Tailscale origin; `/api/agent-limit` → 401 unauthenticated (route mounted, not authenticated) |
| **Preserved OMP pids** | `1204278`, `2080435`, `2082046` — **all alive and unchanged** across the restart |
| tmux sessions | `$0`, `$1`, `$2` intact |
| Relay drops since deploy | 0 (`backed-up peer` count) |
| Rollback | previous revision `d00281a`-deployed tree; `apps/web/dist` is read from disk, so a web rollback is a rebuild |

### Live verification performed

1. HTTPS reachable over Tailscale — 200.
2. Authentication gate intact — `/api/agent-limit` 401.
3. Served JS/CSS hashes read and matched to the local build.
4. **The real 11.4 MB snapshot delivered end to end through the deployed relay**,
   3915/3915 entries, `final: true`, no reconnect.
5. All three live OMP processes and their tmux sessions intact.

### BLOCKED at production

- **Authenticated in-app read of the deployed UI.** Needs the owner's password.
  `GET /` returning 200 does **not** prove the authenticated conversation works.
- **A 4th launch being refused `conflict_limit`.** Would spend provider credits and
  race the three live sessions; deliberately not attempted.
- **WebKit / physical iPhone.**

## K — Remaining limitations

Verified-not-done:

- No WebKit run (no build present); no physical iPhone test. Mobile claims rest on
  Chromium at emulated viewports.
- No authenticated production UI read, so the deployed screen is proven by asset
  identity and a live protocol read, not by a logged-in screenshot.
- Performance was not benchmarked; the transcript still renders all rows (no
  virtualisation), which is unchanged from before and untested at pathological
  sizes.
- The two conversation-identity discrepancies in section C are **not** fixed —
  they are recorded, and a follow-up is needed to decide whether
  `nativeSessionPath` should be populated when OMP adopts a session.
- Browser notifications (the optional half of the handoff requirement) were
  **not** implemented: the in-app notification is the mandatory half and is done.
  No Service Worker was added.
