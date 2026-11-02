# Guest prompt state and retention contract

## States and transitions

A local send attempt moves from `queued_local` (recorded before dispatch) to `unconfirmed` when the socket accepts the frame. A single attributable host refusal may move it to `refused`; explicit Recover moves it to `recovered`; explicit Dismiss removes it as `dismissed`. A genuine live `entry` or `event` echo settles at most one same-text attempt, in ordinal order. `snapshot-chunk` history is never a receipt.

Synchronous dispatch throws, explicit refusals, and full recovery capacity preserve the record and the user's draft. A successful socket write proves local transport acceptance only. Timeouts, reconnects, unrelated frames, client destruction, component remount, and ended state do not discard an attempt. Capacity is 256 retained, non-dismissed attempts; at capacity, refuse the next send before wire dispatch and surface an actionable message. Never evict an attempt that the user has neither dismissed nor recovered.

Errors and refusal-bearing `bye` frames have no command id. Attribute a refusal only when exactly one `unconfirmed` candidate belongs to the current physical connection. Otherwise surface the reason connection-scoped and leave candidates recoverable. Assistant/tool/history frames do not confirm prompts. Duplicate text identifies separate attempts; each live echo settles only the earliest eligible matching attempt.

Recover is an explicit, non-sending action. Preserve existing draft and insert recovered text once per record. Repeated activation is a no-op while the restored text remains in the draft. If user edits or removes that restored text, Recover may be offered again. Records retain originating room id and known session id; records from a different context show their origin and require explicit user action before entering the current draft. Copy failure leaves the record and permits manual selection/copy.

A prompt journaled before the host cuts its snapshot dump may appear only in that dump. Since dumps are not receipts, that attempt remains `unconfirmed` until the user dismisses it; this safe false-negative is preferable to false acknowledgment.

## Retention lifetime

In-memory retention survives in-page reconnect, Rejoin, ended state, and client replacement. The recovery store outlives one client; client-generation fencing rejects mutations from superseded clients. It does not survive full page reload or iOS process eviction. Tab-scoped persistence is a separate later deliverable; no bearer link is persisted.
