import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { GuestClient, Notice } from "../../lib/client";

const INFO_TTL_MS = 4000;
const WARNING_TTL_MS = 8000;
const MAX_VISIBLE = 4;

export function Toasts({ notices, client }: { notices: readonly Notice[]; client: GuestClient }): ReactNode {
  // Dynamic membership keyed by notice id — runtime collection.
  const [dismissed, setDismissed] = useState<{ client: GuestClient; ids: Set<number> }>(() => ({ client, ids: new Set() }));
  const dismissedIds = dismissed.client === client ? dismissed.ids : new Set<number>();
  useEffect(() => {
    if (dismissed.client !== client) setDismissed({ client, ids: new Set() });
  }, [client, dismissed.client]);

  useEffect(() => {
    const timers: number[] = [];
    for (const n of notices) {
      if (n.level === "error" || dismissedIds.has(n.id)) continue;
      const ttl = n.level === "info" ? INFO_TTL_MS : WARNING_TTL_MS;
      const remaining = n.at + ttl - Date.now();
      timers.push(
        window.setTimeout(
          () => {
            setDismissed((prev) => {
              if (prev.client !== client || prev.ids.has(n.id)) return prev;
              const next = new Set(prev.ids);
              next.add(n.id);
              return { client, ids: next };
            });
          },
          Math.max(0, remaining),
        ),
      );
    }
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [notices, dismissedIds, client]);

  const visible = notices
    .filter((n) => !dismissedIds.has(n.id))
    .slice(-MAX_VISIBLE);
  if (visible.length === 0) return null;

  const close = (id: number): void => {
    setDismissed((prev) => {
      if (prev.client !== client) return prev;
      const next = new Set(prev.ids);
      next.add(id);
      return { client, ids: next };
    });
  };

  return (
    <div className="sh-toasts">
      {visible.map((n) => (
        <div
          key={n.id}
          className={`sh-toast sh-toast-${n.level}`}
          role="status"
        >
          <span className="sh-toast-msg">{n.message}</span>
          {n.level === "error" && (
            <button
              type="button"
              className="sh-toast-close"
              onClick={() => close(n.id)}
              title="dismiss"
            >
              <X size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
