/**
 * Agents Center — the level-2 full-screen agent list.
 *
 * Classification is never decided here. Rows render `AgentView.class` verbatim,
 * because the defect those fields exist for (B01) was a surface deciding identity
 * from a list it happened to hold. The only shaping this file does is bounding the
 * task preview, which `taskPreview` already does from the full text.
 */
import { useMemo, useState } from "react";
import { taskPreview, type AgentView } from "../agent-model.js";
import type { AgentActivity } from "../transcript.js";
import "../agents.css";

export interface AgentsCenterProps {
  views: readonly AgentView[];
  /** Live activity per agent id, as reduced from the bus. Absent = none reported. */
  activity: Record<string, AgentActivity>;
  onSelect(id: string): void;
  onBack(): void;
}

type Filter = "all" | "running" | "finished";

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "finished", label: "Finished" },
];

/** "3m ago" for an epoch-ms timestamp; anything unusable is reported as unknown. */
function relativeTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "unknown";
  const seconds = Math.round((ms - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const unit = absolute < 60 ? "second" : absolute < 3600 ? "minute" : absolute < 86400 ? "hour" : absolute < 2592000 ? "day" : "month";
  const count = Math.max(1, Math.round(absolute / ({ second: 1, minute: 60, hour: 3600, day: 86400, month: 2592000 }[unit])));
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.sign(seconds) * count, unit as Intl.RelativeTimeFormatUnit);
}

export function AgentsCenter({ views, activity, onSelect, onBack }: AgentsCenterProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = useMemo(
    () =>
      views.filter((view) => {
        if (filter === "all") return true;
        // "Running" is the host's own status word; everything else — idle, parked,
        // aborted — is what the host is not calling running. Calling `idle`
        // "finished" is the honest reading of a status we did not author.
        const running = view.status === "running";
        return filter === "running" ? running : !running;
      }),
    [views, filter],
  );

  return (
    // A named region: this is a full screen of the app, and an unreachable-by-name
    // container is exactly the A11Y-02 defect this file's suite guards against.
    <section className="view-container agents-center" role="region" aria-labelledby="agents-center-title">
      <div className="agents-head">
        <button type="button" className="ghost header-icon-button" onClick={onBack} aria-label="Back to session">←</button>
        <h2 id="agents-center-title">Agents ({shown.length})</h2>
      </div>

      <div className="agents-chips" role="group" aria-label="Filter agents">
        {FILTERS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className="agents-chip"
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="agents-list">
        {views.length === 0 ? (
          <p className="agents-empty" role="status">No agents reported by the host.</p>
        ) : shown.length === 0 ? (
          <p className="agents-empty" role="status">No agents match this filter.</p>
        ) : (
          shown.map((view) => (
            <AgentRow key={view.id} view={view} activity={activity[view.id]} onSelect={onSelect} />
          ))
        )}
      </div>
    </section>
  );
}

function AgentRow({
  view,
  activity,
  onSelect,
}: {
  view: AgentView;
  activity: AgentActivity | undefined;
  onSelect(id: string): void;
}) {
  const task = activity?.task.trim() ?? "";
  const preview = task === "" ? "No live task reported" : taskPreview(task);
  const tool = activity?.currentTool ? `Tool: ${activity.currentTool}` : "No live tool reported";
  return (
    <button
      type="button"
      className="agent-row"
      onClick={() => onSelect(view.id)}
      /* The row's own text is already the label; the explicit one names the class
         so a screen reader never has to guess what kind of agent this is. */
      aria-label={`${view.displayName}, ${view.class}, ${view.status}, last activity ${relativeTime(view.lastActivity)}`}
    >
      <span className="agent-row-main">
        <span className="agent-row-name">{view.displayName}</span>
        <span className="agent-row-class">{view.class}</span>
        <span className={`badge ${view.status}`}>{view.status}</span>
        <span className="agent-row-arrow" aria-hidden="true">›</span>
      </span>
      <span className="agent-task-preview">{preview}</span>
      <span className="agent-row-meta">
        <span>{tool}</span>
        <span>Last activity {relativeTime(view.lastActivity)}</span>
      </span>
    </button>
  );
}
