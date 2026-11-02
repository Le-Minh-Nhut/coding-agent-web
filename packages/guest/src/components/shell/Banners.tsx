import type { ReactNode } from "react";
import type { ConnectionPhase, GuestSnapshot } from "../../lib/client";

export interface BannersProps {
  phase: ConnectionPhase;
  endedReason: string | null;
  loading: GuestSnapshot["loading"];
  onRejoin(): void;
  onNewLink(): void;
  client: GuestClient;
  readOnly: boolean;
  connectError?: string | null;
}
import type { GuestClient } from "../../lib/client";
import { Composer } from "./Composer";

export function Banners({
  phase,
  endedReason,
  loading,
  onRejoin,
  onNewLink,
  client,
  readOnly,
  connectError,
}: BannersProps): ReactNode {
  const progress =
    loading && loading.total > 0
      ? ` ${Math.floor((loading.received / loading.total) * 100)}%`
      : "";
  if (phase === "connecting" || phase === "waiting") {
    return (
      <div className="sh-banner" role="status">
        <span className="sh-banner-dot" />
        {phase === "connecting"
          ? "Connecting to relay…"
          : `Joining session…${progress}`}
      </div>
    );
  }
  if (phase === "reconnecting") {
    return (
      <div className="sh-banner" role="status">
        <span className="sh-banner-dot" />
        {`Reconnecting…${progress}`}
      </div>
    );
  }
  if (phase === "ended") {
    return (
      <div className="sh-ended" role="alertdialog" aria-label="session ended">
        <div className="sh-ended-card">
          <div className="sh-ended-title">Session ended</div>
          {connectError && <div className="sh-banner" role="alert">{connectError}</div>}
          {endedReason && <div className="sh-ended-reason">{endedReason}</div>}
          <Composer client={client} phase="ended" readOnly={readOnly} uiRequest={null} working={false} queuedMessageCount={0} />
          <div className="sh-ended-actions">
            <button
              type="button"
              className="sh-btn sh-btn-primary"
              onClick={onRejoin}
            >
              Rejoin
            </button>
            <button type="button" className="sh-btn" onClick={onNewLink}>
              New link
            </button>
          </div>
        </div>
      </div>
    );
  }
  return null;
}
