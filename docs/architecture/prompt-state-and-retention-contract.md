# Guest prompt state and retention contract

## States and transitions

A local send attempt moves from `queued_local` (recorded before dispatch) to `unconfirmed` when the socket accepts the frame. A single attributable host refusal may move it to `refused`; explicit Recover moves it to `recovered`; explicit Dismiss removes it as `dismissed`. A genuine live `entry` or `event` echo settles at most one same-text attempt, in ordinal order. `snapshot-chunk` history is never a receipt.

Synchronous dispatch throws, explicit refusals, and full recovery capacity preserve the record and the user's draft. A successful socket write proves local transport acceptance only. Timeouts, reconnects, unrelated frames, client destruction, component remount, and ended state do not discard an attempt. Capacity is 256 retained, non-dismissed attempts; at capacity, refuse the next send before wire dispatch and surface an actionable message. Never evict an attempt that the user has neither dismissed nor recovered.

Errors and refusal-bearing `bye` frames have no command id. Attribute a refusal only when exactly one `unconfirmed` candidate belongs to the current physical connection. Otherwise surface the reason connection-scoped and leave candidates recoverable. Assistant/tool/history frames do not confirm prompts. Duplicate text identifies separate attempts; each live echo settles only the earliest eligible matching attempt.

Recover is an explicit, non-sending action. Preserve existing draft and insert recovered text once per record. Recovered text counts as present only when a whole draft line equals the record text; a longer line containing it as a substring does not suppress Recover. Repeated activation is a no-op while that line remains, and Recover becomes available again when editing removes it. Records retain originating room id and known session id; records from a different context show their origin and require explicit user action before entering the current draft. Copy failure leaves the record and permits manual selection/copy.

A prompt journaled before the host cuts its snapshot dump may appear only in that dump. Since dumps are not receipts, that attempt remains `unconfirmed` until the user dismisses it; this safe false-negative is preferable to false acknowledgment.

## Retention lifetime

In-memory retention survives in-page reconnect, Rejoin, ended state, and client replacement. The recovery store outlives one client; client-generation fencing rejects mutations from superseded clients. It does not survive iOS process eviction of the tab.

**Round 54: tab-scoped persistence is implemented for the web client.** Retained
recovery records are mirrored into `sessionStorage` under the namespaced key
`caw.promptRecovery.v1`, keyed by conversation id, by `apps/web/src/prompt-recovery.ts`
(hydrated and written by `App.tsx`, the owner of `refusedRecoveries`). What that
buys and what it does not:

- **Persisted: only the recovery records** — the text, its status flags, and the
  conversation id. A reload (or a tab restore) no longer destroys the only copy of
  a prompt the host never acknowledged.
- **Never persisted: the Collab link, the transcript, drafts.** The link is a
  bearer credential and stays memory-only, exactly as the security model requires;
  see `docs/architecture/security-model.md` §"Do not store a room link in
  localStorage, IndexedDB, or a service-worker cache".
- **sessionStorage, not localStorage**, so the records die with the tab and leave
  nothing behind on a shared device.
- **Threat delta:** the records are same-origin script-readable while the tab lives.
  A prompt the user typed is already readable by any script the page runs, and XSS
  on this origin already implies owner compromise (it can mint a fresh control link
  and act as the owner). The added exposure is therefore a *durable* copy of text
  the user themselves typed within that same compromised page — not a new class of
  secret. The bearer link's rules are unchanged.
- **Capacity:** the same ceilings the guest client enforces on retention — 256
  records / 1 MiB of retained UTF-8 text — applied to *retention*. A record that
  does not fit is refused with a visible, actionable message (in the composer's own
  status line) and the send is never blocked; nothing is evicted silently, because
  eviction would be the data loss this list exists to prevent.
- **Residual, accepted at exactly the ceiling (round 54 B1).** When the ceiling is
  already reached and a retention is refused *voluntarily* — because the refused
  prompt is still sitting in the composer, which is the only condition under which a
  refusal is allowed — that text exists only in the **non-persisted** draft: the
  ceiling plus Back plus a reload still loses it. This is a deliberate trade, not an
  oversight. The alternative is evicting a record the user has neither dismissed nor
  recovered, which converts a recoverable prompt into a destroyed one. A refusal is
  permitted only where the text remains on screen, and Dismiss/Recover make room.
- **Removal:** only explicit Dismiss, or an explicit Recover that leaves the text
  in the composer. No pruning, no expiry, no slicing.
- When the retained set becomes empty the key is removed outright, so nothing looks
  like retained state to the next boot. It does not survive the browser evicting the
  tab itself (iOS process eviction), which no tab-scoped store can outlive.

