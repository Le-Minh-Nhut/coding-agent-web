/**
 * The three compact navigation cards under the header.
 *
 * These are *navigation summaries*, not dashboards: each is one tap away from the
 * place the number comes from, and none of them invents a figure.
 *
 * Where the numbers come from (and what is deliberately absent):
 *  - **agents** — the caller passes `agentCounts(agentViews(...))` from
 *    `agent-model.ts`. Classification never happens here; this component only
 *    prints the two counts it is handed.
 *  - **files** — `summarizeFileChanges` over real tool rows. `null` means no
 *    verified change data exists, and the card then says `View changes` instead of
 *    printing a zero it did not prove. `+`/`−` appear only when both totals are
 *    known, because a partial sum printed as a total is a lie.
 *  - **activity** — no count at all. The number of server-recorded events is not
 *    available without fetching the Activity page, and fetching it to decorate a
 *    card would be a request the user did not ask for.
 *
 * Bounded height is a requirement, not a style: 56-64px, and every card is a real
 * ≥44px touch target. Three columns when the width allows; two below 360px, where
 * three would wrap a label to two lines and become unreadable.
 */
export interface DashboardCounts {
  /** Total agents the host reported, and how many it calls running. */
  agents: { total: number; running: number };
  /** Verified file-change totals, or `null` when none were proven. */
  files: { uniqueFiles: number; additions: number | null; deletions: number | null } | null;
}

export interface DashboardCardsProps {
  counts: DashboardCounts;
  onOpenAgents(): void;
  onOpenFiles(): void;
  onOpenActivity(): void;
}

export function DashboardCards({ counts, onOpenAgents, onOpenFiles, onOpenActivity }: DashboardCardsProps) {
  const { agents, files } = counts;
  const fileCounts =
    files !== null && files.additions !== null && files.deletions !== null
      ? `+${files.additions} −${files.deletions}`
      : null;
  return (
    <div className="dashboard-row" role="group" aria-label="Conversation summary">
      <button
        type="button"
        className="dashboard-card"
        onClick={onOpenAgents}
        aria-label={`Agents: ${agents.total} total, ${agents.running} running. Open agents.`}
      >
        <span className="dashboard-value">{agents.total} Agents</span>
        {/* "N Agents" beside "0 running" reads as N concurrent agents, which is
            not what this number is: it is every agent this conversation ever
            spawned — subagents and workers, most of them finished. The sub-line
            says which, so a big total with nothing running is not mistaken for a
            dozen live processes. */}
        {/* Short enough to survive the card's ellipsis at 320px: the earlier
            wording ("past and present") was itself the part that got clipped, so
            the disclaimer never reached the phone it was written for. */}
        <span className="dashboard-sub">
          {agents.running === 0 ? "0 running · all-time" : `${agents.running} running`}
        </span>
      </button>
      <button
        type="button"
        className="dashboard-card"
        onClick={onOpenFiles}
        // The card is a summary of what the transcript already holds, so its name
        // says which of the two states it is in rather than asserting a count.
        aria-label={files === null ? "Files: no verified changes. View changes." : `Files: ${files.uniqueFiles} changed. View changes.`}
      >
        <span className="dashboard-value">{files === null ? "Files" : `${files.uniqueFiles} Files`}</span>
        <span className="dashboard-sub">{fileCounts ?? "View changes"}</span>
      </button>
      <button
        type="button"
        className="dashboard-card"
        onClick={onOpenActivity}
        aria-label="Activity: view recorded events."
      >
        <span className="dashboard-value">Activity</span>
        <span className="dashboard-sub">View events</span>
      </button>
    </div>
  );
}
