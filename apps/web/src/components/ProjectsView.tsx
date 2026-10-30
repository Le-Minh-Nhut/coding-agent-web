import { useState, useEffect, useRef } from "react";
import { api } from "../api.js";
import { chainMutation, currentAuthGeneration, MUTATION_CANCELLED } from "../mutation-order.js";
import { FolderBrowser } from "./FolderBrowser.js";
import type { ProjectWithStats } from "@caw/contracts";

interface ProjectsViewProps {
  onSelectProject: (projectId: string) => void;
  onOpenSettings: () => void;
}

/**
 * One rename flight per project, keyed by project id.
 *
 * Deliberately at module scope rather than in a component ref: a pending "First"
 * PATCH outlives this view when the user leaves for Settings and back, and the
 * server applies writes in arrival order — it would land after the "Final" the
 * reopened dialog sent. Sharing the flight across mounts keeps the follow-up (the
 * write that makes the last intent win) attached to the write still in flight,
 * instead of a new mount firing a competing PATCH. Component-local dialog state
 * (token, revision) stays with the view; only the wire writes live here. (V25-01)
 */
const renameFlights = new Map<string, { desired: string; pending: { label: string; token: object | null; revision: number } | null }>();

/**
 * One favorite flight per project, keyed by project id.
 *
 * Module scope for the same reason as renameFlights (V25-01): a star PATCH that
 * outlived this view — the user starred, left for Settings, came back and starred
 * again — would otherwise be raced by a second PATCH from the new mount, and the
 * server applies writes in arrival order, so the older star could land last and
 * rewind the value the user asked for. Sharing the flight keeps the follow-up
 * (the write that makes the last click win) attached to the write in flight
 * instead of a new mount firing a competing PATCH. Only wire bookkeeping lives
 * here: the star column on screen belongs to whichever view is mounted when the
 * response lands, and the write applies it through that view's bridge
 * (liveProjectsFeedback) rather than through the closure that submitted it.
 */
const favoriteFlights = new Map<string, { desired: boolean; base: boolean; pending: boolean | null }>();

/**
 * Drops every module-scope flight recorded for projects: called at the auth
 * boundary (logout, or the probe finding no session) so intents submitted under
 * one session are never replayed under the next one, and so a flight left hung
 * by a dead session cannot block the same project's key for the new session.
 * View-scoped state (the displayed star column, feedback registration) is owned
 * by the mounted view's lifecycle and is deliberately not touched here.
 */
export function resetProjectMutationState(): void {
  renameFlights.clear();
  favoriteFlights.clear();
}

/**
 * The feedback surface of the ProjectsView that is mounted right now.
 *
 * A rename write — and the coalesced follow-up it chains — can be issued from the
 * closure of a view that has since unmounted (Back, Settings round-trip). Applying
 * its result to that closure does nothing the user can see: the dialog the *live*
 * view has open stays open and the live list keeps the stale label. So the mounted
 * view registers here and the write asks it for feedback instead. Each accessor
 * dereferences the live view's refs rather than captured values, so a registration
 * made once on mount always reads the dialog token and draft revision of the
 * moment the response lands. (V25-01 feedback path)
 */
interface LiveProjectsFeedback {
  /** The rename dialog this view has open now, or null when it has none. */
  openDialogToken: () => object | null;
  /** Current draft revision of its rename input. */
  draftRevision: () => number;
  /** Close its rename dialog. */
  closeDialog: () => void;
  /** Re-read and repaint its project list. */
  refresh: () => void;
  /** Report a failed write on its alert region. */
  reportError: (message: string) => void;
  /**
   * Apply an accepted star value to its list: bump the epoch a list request in
   * flight compares against, record the value so a stale snapshot keeps the fresh
   * star column, and repaint the card. Same setters the submitting mount used, so
   * a write that settles while its own view is still mounted behaves identically.
   */
  applyFavorite: (projectId: string, favorite: boolean) => void;
}

const liveProjectsFeedback: { current: LiveProjectsFeedback | null } = { current: null };

export function ProjectsView({ onSelectProject, onOpenSettings }: ProjectsViewProps) {
  const [projects, setProjects] = useState<ProjectWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [showBrowser, setShowBrowser] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  /**
   * Star bookkeeping, keyed per project so one project's write never blocks
   * another's: at most one favorite PATCH is in flight per project. Ordering
   * responses on the client cannot order the writes the server applies, so a
   * click while a write is open only records the newest desired value (`pending`)
   * instead of racing a second PATCH that could arrive late and win. When the
   * write settles, a recorded value that still differs from what the server
   * applied is sent once — last intent wins regardless of arrival order.
   *
   * The map lives at module scope (favoriteFlights) so a remount inherits the
   * flight still in flight rather than racing a second PATCH at it (V25-01).
   */
  const favoriteFlightRef = { current: favoriteFlights };
  /** Bumped whenever a favorite response is applied; a list request started before that carries a stale star column. */
  const favoriteEpochRef = useRef(0);
  /** Star values actually applied per project, so a stale list snapshot keeps the fresh star column. */
  const favoriteValueRef = useRef<Map<string, boolean>>(new Map());
  /** Orders list requests so an older snapshot cannot replace a newer one. */
  const listSeqRef = useRef(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * N25-01: whether the current list state came from a read that actually
   * succeeded. "No projects added yet." is a factual claim about the workspace, so
   * it may only be made after an ok read — a failed read says nothing about the
   * list and must show its error instead of an empty-workspace claim.
   */
  const [listReadOk, setListReadOk] = useState(false);

  // Edit / Delete dialogs. Each dialog records the operation token that opened it;
  // a late response may refresh the list, but only closes the dialog it belongs to.
  const [editingProject, setEditingProject] = useState<ProjectWithStats | null>(null);
  const [editLabel, setEditLabel] = useState("");
  /**
   * Draft revision of the rename input, bumped on every keystroke. A response may
   * close the editor only when the revision is the one captured at that Save:
   * comparing the current text against what was sent cannot tell an untouched draft
   * from a First→Final→First edit chain (V20-03).
   */
  const editRevisionRef = useRef(0);
  const renameOperationRef = useRef<object | null>(null);
  /**
   * One rename write per project, coalescing like the favorite flight: two Saves in
   * the same dialog would otherwise send two PATCHes whose arrival order the server
   * decides, so a late "First" could overwrite the "Final" the user asked for last.
   * A Save while a write is open records the newest label; the write chains exactly
   * one follow-up so the server converges on the last intent regardless of order.
   * A recorded intent carries the dialog token that submitted it, so a coalesced
   * Save from a reopened dialog owns its own success/failure feedback instead of
   * inheriting the token of the write it is queued behind.
   *
   * The map lives at module scope (renameFlights) so a remount inherits the flight
   * still in flight rather than racing a second PATCH at it (V25-01).
   */
  const renameFlightRef = { current: renameFlights };
  const createOperationRef = useRef<object | null>(null);
  /**
   * Draft revision of the new-project label, bumped on every keystroke. A create
   * response may close/clear the form only when the revision is the one captured at
   * that submit: a label typed while the request was pending belongs to a different
   * project and must survive the older success (V20-06).
   */
  const labelRevisionRef = useRef(0);
  const [deletingProject, setDeletingProject] = useState<ProjectWithStats | null>(null);
  const deleteOperationRef = useRef<object | null>(null);

  const loadProjects = async () => {
    setLoading(true);
    const seq = ++listSeqRef.current;
    const epoch = favoriteEpochRef.current;
    const res = await api.listProjects();
    setLoading(false);
    // Drop a superseded snapshot. A snapshot taken before a favorite settled still
    // carries the rest of the list (create/rename/delete results), so keep it and
    // overlay the star column with the values the favorite path last applied.
    if (seq !== listSeqRef.current) return;
    if (res.ok) {
      setListReadOk(true);
      setProjects(epoch === favoriteEpochRef.current
        ? res.data
        : res.data.map((p) => ({ ...p, favorite: favoriteValueRef.current.get(p.id) ?? p.favorite })));
    } else {
      // A failed list read proves nothing about the workspace, so it must retract
      // any earlier empty claim (N25-01) and surface its own error.
      setListReadOk(false);
      setError(res.error.message);
    }
  };
  /**
   * Register this mount as the surface a rename response reports to. Every
   * accessor reads through a ref or a state setter, so the registration made once
   * on mount still sees the dialog token and draft revision of the moment the
   * response lands (and `loadProjects` closes over refs and setters only, so the
   * mount-time instance it captures is equivalent to a fresh one).
   *
   * Cleared on unmount: a response that lands while no ProjectsView is mounted has
   * nowhere to report, and must not touch an unmounted instance's state.
   */
  useEffect(() => {
    const bridge: LiveProjectsFeedback = {
      openDialogToken: () => renameOperationRef.current,
      draftRevision: () => editRevisionRef.current,
      closeDialog: () => setEditingProject(null),
      refresh: () => void loadProjects(),
      reportError: (message: string) => setError(message),
      applyFavorite: (projectId: string, favorite: boolean) => {
        favoriteEpochRef.current++;
        favoriteValueRef.current.set(projectId, favorite);
        setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, favorite } : p)));
      },
    };
    liveProjectsFeedback.current = bridge;
    // Only clear our own registration: a newer mount may already have replaced it.
    return () => {
      if (liveProjectsFeedback.current === bridge) liveProjectsFeedback.current = null;
    };
  }, []);

  useEffect(() => {
    loadProjects();
  }, []);

  /**
   * Sends one favorite write, applies its result, then chains the newest intent
   * recorded while it was open. The chain is what makes the last click win on the
   * server: a value the user asked for after this write started cannot be left
   * unsent just because this one settled first.
   *
   * The star column is applied through `liveProjectsFeedback` — the ProjectsView
   * mounted now — for the same reason the rename path is: a write issued before
   * Back/Settings can settle after the view that submitted it is gone, and the
   * list on screen then belongs to the reopened view, whose own read may predate
   * this write. With no view mounted there is no star column to correct and no
   * epoch overlay to extend: the next mount reads the list fresh from the server,
   * which already carries the accepted value. (V25-01 feedback path)
   */
  const writeFavorite = async (projectId: string, record: { desired: boolean; base: boolean; pending: boolean | null }): Promise<void> => {
    // The auth lifetime this write was submitted in. A star PATCH that had already
    // reached the network before the sign-out cannot be unsent — the queue gate only
    // stops intents that had not started — so a result returning after re-login must
    // be recognized as retired and dropped: `liveProjectsFeedback.current` by then is
    // the NEW view's bridge, and applying the old response would repaint a session
    // that never asked for that write.
    const lifetime = currentAuthGeneration();
    // Chained on the project key like the rename path (V25-01): submission order
    // becomes arrival order, so a star PATCH that outlived its view cannot land
    // after a newer one from the reopened view and rewind the stored flag.
    const res = await chainMutation(`project-favorite:${projectId}`, () => api.updateProject(projectId, { favorite: record.desired }));
    if (res === MUTATION_CANCELLED || lifetime !== currentAuthGeneration()) {
      // The flight this record belonged to died with the session. Drop the record
      // only if it is still ours: a re-login may have recorded a fresh intent under
      // the same key, and that one owns the map now.
      if (favoriteFlightRef.current.get(projectId) === record) favoriteFlightRef.current.delete(projectId);
      return; // never recurses ⇒ no follow-up is sent under the new credentials
    }
    const live = liveProjectsFeedback.current;
    if (res.ok) {
      if (live) live.applyFavorite(projectId, res.data.favorite);
    } else if (live) {
      live.reportError(res.error.message);
    }
    // The newest intent differs from what this write asked for: send exactly one
    // follow-up so the server converges on the user's last click. A double-tap
    // records the value already requested, so it coalesces instead of re-sending.
    // The follow-up is chained even after a failure, so a rejected write never
    // swallows the intent the user expressed while it was open.
    if (record.pending !== null && record.pending !== record.desired) {
      const next = { desired: record.pending, base: record.desired, pending: null as boolean | null };
      favoriteFlightRef.current.set(projectId, next);
      await writeFavorite(projectId, next);
      return;
    }
    if (favoriteFlightRef.current.get(projectId) === record) favoriteFlightRef.current.delete(projectId);
  };

  const handleToggleFavorite = (e: React.MouseEvent, project: ProjectWithStats) => {
    e.stopPropagation();
    const flight = favoriteFlightRef.current.get(project.id);
    if (flight) {
      // One write per project: never race a second PATCH whose arrival order the
      // server decides. A click while a write is open records the newest intent,
      // re-asserting the intent already in flight for a double-tap on the same
      // displayed value instead of toggling a prop a stale snapshot may have rewound.
      flight.pending = flight.base === project.favorite ? flight.desired : !project.favorite;
      return;
    }
    const record = { desired: !project.favorite, base: project.favorite, pending: null as boolean | null };
    favoriteFlightRef.current.set(project.id, record);
    void writeFavorite(project.id, record);
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPath || !newLabel.trim() || creating) return;
    setCreating(true);
    setError(null);

    // Pending belongs to this form: a fresh token is minted by every way a form
    // opens (Cancel, folder pick), so a response from an abandoned form cannot
    // clear — or fail to clear — the pending of the form on screen now.
    const token = createOperationRef.current;
    // The label revision at this submit. A keystroke while the request was open makes
    // the text on screen an unsaved label for a different project; the success of the
    // submitted create must neither close the form nor clear that draft (V20-06).
    const revision = labelRevisionRef.current;
    const res = await api.createProject(selectedPath, newLabel.trim());
    if (createOperationRef.current === token) setCreating(false);
    if (res.ok) {
      if (createOperationRef.current === token && labelRevisionRef.current === revision) {
        setSelectedPath(null);
        setNewLabel("");
      }
      loadProjects();
    } else if (createOperationRef.current === token) {
      // The form stays open on failure either way, so the error is visible whether or
      // not the user has typed on: a duplicate path (e.g. re-submitting the project
      // just created) must be reported, never silently swallowed.
      setError(res.error.message);
    }
  };

  /**
   * Sends one rename write, applies its result, then chains the newest label
   * intent — the same shape as writeFavorite. Serializing per project means the
   * server cannot apply a late "First" over the "Final" the user asked for last:
   * the follow-up is what makes the last Save win regardless of arrival order.
   * The dialog token is captured at Save, so both this write and its follow-up can
   * only close the dialog they belong to, never a newer one opened meanwhile.
   *
   * Feedback is resolved through `liveProjectsFeedback` — the ProjectsView mounted
   * now — not through this closure: a write issued before Back/Settings can settle
   * after the view that submitted it is gone, and only the mounted view has state
   * the user can see. (V25-01 feedback path)
   */
  const writeRename = async (projectId: string, record: { desired: string; pending: { label: string; token: object | null; revision: number } | null }, token: object | null, revision: number): Promise<void> => {
    // The auth lifetime this write was submitted in. A write that had already
    // reached the network before the sign-out cannot be unsent, so its result
    // returning after re-login must neither report to the new view (its bridge is
    // the live one now) nor close/acknowledge anything in it.
    const lifetime = currentAuthGeneration();
    const res = await chainMutation(`project-rename:${projectId}`, () => api.updateProject(projectId, { label: record.desired }));
    if (res === MUTATION_CANCELLED || lifetime !== currentAuthGeneration()) {
      // Retired with the session: drop the record only if it is still ours — the new
      // session may already own this key with its own flight.
      if (renameFlightRef.current.get(projectId) === record) renameFlightRef.current.delete(projectId);
      return; // no feedback, no acknowledgment, no follow-up under the new credentials
    }
    // A response acts only on the dialog that submitted it: the token captured at
    // that Save must still be the open dialog's token. Success additionally needs the
    // draft revision captured at that same Save to still be current — the text
    // comparison alone cannot tell an untouched draft from a First→Final→First edit
    // chain (V20-03). A stale response must never blame a dialog that submitted
    // nothing (V18-04).
    const live = liveProjectsFeedback.current;
    const owned = live !== null && live.openDialogToken() === token;
    if (res.ok) {
      // The draft revision check is the live dialog's: an untouched draft is
      // indistinguishable from a First→Final→First edit chain by text alone. Both
      // the ownership test and the close go through the mounted view: with no view
      // mounted there is no dialog on screen to close, and this closure's setters
      // belong to an instance React has already discarded.
      if (owned && live.draftRevision() === revision) live.closeDialog();
      // The list on screen belongs to the live view; a write that landed for a view
      // that is gone would refresh a component nobody sees.
      if (live) live.refresh();
    } else if (owned) {
      if (live) live.reportError(res.error.message);
      // With no bridge mounted there is no alert to write to and no list to repaint:
      // the next mount reads the server's stored label fresh, so touching this dead
      // closure's state (setError/loadProjects) would only report to nobody.
    }
    // Send exactly one follow-up when this write left the user's newest intent
    // unserved: a newer label (both outcomes), or — after a failure — a pending Save
    // whose label happens to equal this write's, which a success would already have
    // satisfied (V20-04). The follow-up reuses the token and revision recorded with
    // that intent — never this write's — so both feedback and the close decision land
    // on the dialog that actually submitted the label.
    //
    // Only the current flight record may chain: a record already superseded by an
    // earlier settlement must not resurrect its own old intent.
    const stillCurrent = renameFlightRef.current.get(projectId) === record;
    if (stillCurrent) {
      const pending = record.pending;
      if (pending !== null) {
        // V26-03: a success whose accepted label equals the recorded intent has
        // served that intent, but the intent's OWN dialog was never acknowledged —
        // the record that carried it is not this write's, so none of the feedback
        // above touched it. Acknowledge it here, through the same ownership test the
        // direct-success path uses, and send no PATCH: the server already holds the
        // label the user typed. A failure still owes the pending intent a request
        // (V20-04), so only a delivered success takes this branch.
        if (res.ok && pending.label === record.desired) {
          // The feedback goes to the live bridge only when one exists. With no view
          // mounted there is no dialog to close and no list to repaint; the token and
          // revision recorded at that Save are the submitter's, so a dialog opened
          // since (different token) or a draft edited since (different revision) is
          // left alone — exactly as the direct-success path decides it.
          if (live && live.openDialogToken() === pending.token && live.draftRevision() === pending.revision) live.closeDialog();
          if (live) live.refresh();
        } else {
          const next = { desired: pending.label, pending: null as { label: string; token: object | null; revision: number } | null };
          renameFlightRef.current.set(projectId, next);
          await writeRename(projectId, next, pending.token, pending.revision);
          return;
        }
      }
      if (renameFlightRef.current.get(projectId) === record) renameFlightRef.current.delete(projectId);
    }
  };

  const handleRenameProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProject || !editLabel.trim()) return;
    // The dialog belongs to one operation. A late response may refresh the list,
    // but must not close a dialog opened by a different (newer) rename.
    const token = renameOperationRef.current;
    const projectId = editingProject.id;
    const label = editLabel.trim();
    // The draft revision at this submission: a later keystroke invalidates the
    // right of this write — and of the coalesced intent it records — to close the
    // editor.
    const revision = editRevisionRef.current;
    const flight = renameFlightRef.current.get(projectId);
    if (flight) {
      // A write is already open for this project: record the newest label instead
      // of racing a second PATCH whose arrival order the server decides. The token of
      // the dialog that submitted this Save is recorded with it, so a reopened
      // dialog owns its own feedback rather than inheriting the open write's.
      flight.pending = { label, token, revision };
      return;
    }
    const record: { desired: string; pending: { label: string; token: object | null; revision: number } | null } = { desired: label, pending: null };
    renameFlightRef.current.set(projectId, record);
    // The token is captured at Save: this write can only close the dialog it belongs
    // to — never a newer one opened meanwhile.
    void writeRename(projectId, record, token, revision);
  };

  const handleDeleteProject = async () => {
    if (!deletingProject) return;
    const token = deleteOperationRef.current;
    const res = await api.deleteProject(deletingProject.id);
    if (res.ok) {
      if (deleteOperationRef.current === token) setDeletingProject(null);
      loadProjects();
    } else if (deleteOperationRef.current === token) {
      setError(res.error.message);
    }
  };

  return (
    <div className="view-container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <h2>Projects</h2>
        <div style={{ display: "flex", gap: "8px" }}>
          <button type="button" onClick={() => setShowBrowser(true)} className="primary">
            + New Project
          </button>
          <button type="button" onClick={onOpenSettings} title="Settings">
            ⚙️
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" style={{ color: "var(--danger)", padding: "10px", backgroundColor: "rgba(218,54,51,0.1)", borderRadius: "var(--radius)", marginBottom: "12px" }}>
          {error}
        </div>
      )}

      {/* Selected path prompt to choose a label */}
      {selectedPath && (
        <div className="card" style={{ borderColor: "var(--primary)" }}>
          <h4 style={{ marginBottom: "8px" }}>Create Project</h4>
          <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "10px", wordBreak: "break-all" }}>
            Folder: {selectedPath}
          </p>
          <form onSubmit={handleCreateProject} style={{ display: "flex", gap: "8px" }}>
            <input
              type="text"
              placeholder="Display label (e.g. My Backend)"
              value={newLabel}
              onChange={(e) => { labelRevisionRef.current++; setNewLabel(e.target.value); }}
              autoFocus
              required
            />
            <button type="submit" className="primary" disabled={creating}>
              Create
            </button>
            <button
              type="button"
              onClick={() => {
                // Closing the form ends its operation: the next form gets a fresh
                // token and a clean pending flag instead of inheriting this one's.
                createOperationRef.current = {};
                setCreating(false);
                setSelectedPath(null);
              }}
            >
              Cancel
            </button>
          </form>
        </div>
      )}

      {loading ? (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)" }}>Loading projects…</div>
      ) : projects.length === 0 && listReadOk ? (
        <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
          <p style={{ color: "var(--text-muted)", marginBottom: "16px" }}>No projects added yet.</p>
          <button type="button" className="primary" onClick={() => setShowBrowser(true)}>
            Browse Folders
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {projects
            .sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0))
            .map((project) => (
              <div
                key={project.id}
                className="card"
                style={{ cursor: "pointer", transition: "border-color 0.15s" }}
                onClick={() => onSelectProject(project.id)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <button
                      type="button"
                      className="ghost"
                      style={{ padding: "2px 4px", fontSize: "1.1rem" }}
                      onClick={(e) => handleToggleFavorite(e, project)}
                      title={project.favorite ? "Unstar" : "Star"}
                    >
                      {project.favorite ? "★" : "☆"}
                    </button>
                    <h3 style={{ fontSize: "1.05rem" }}>{project.label}</h3>
                  </div>
                  <div style={{ display: "flex", gap: "4px" }} onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="ghost"
                      style={{ padding: "4px 8px", fontSize: "0.85rem" }}
                      onClick={() => {
                        renameOperationRef.current = {};
                        setEditingProject(project);
                        setEditLabel(project.label);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      style={{ padding: "4px 8px", fontSize: "0.85rem", color: "var(--danger)" }}
                      onClick={() => { deleteOperationRef.current = {}; setDeletingProject(project); }}
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", wordBreak: "break-all", marginBottom: "8px" }}>
                  {project.path}
                </p>

                <div style={{ display: "flex", gap: "12px", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  <span>{project.conversationCount} conversation{project.conversationCount === 1 ? "" : "s"}</span>
                  {project.lastActivityAt && (
                    <span>Last active: {new Date(project.lastActivityAt).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Folder Browser Modal */}
      {showBrowser && (
        <FolderBrowser
          onCancel={() => setShowBrowser(false)}
          onSelect={(path) => {
            setShowBrowser(false);
            // Opening a form for a new folder starts its own operation: it must
            // not inherit the pending of a create form left in flight.
            createOperationRef.current = {};
            setCreating(false);
            setSelectedPath(path);
            const defaultName = path.split("/").filter(Boolean).pop() ?? "New Project";
            setNewLabel(defaultName);
          }}
        />
      )}

      {/* Rename Modal */}
      {editingProject && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ marginBottom: "12px" }}>Rename Project Label</h3>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "12px" }}>
              Display label only. Renaming never touches the filesystem.
            </p>
            <form onSubmit={handleRenameProject}>
              <input
                type="text"
                value={editLabel}
                onChange={(e) => { editRevisionRef.current++; setEditLabel(e.target.value); }}
                autoFocus
                required
                style={{ marginBottom: "16px" }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <button type="button" onClick={() => setEditingProject(null)}>Cancel</button>
                <button type="submit" className="primary">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingProject && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ marginBottom: "12px", color: "var(--danger)" }}>Delete Project</h3>
            <p style={{ marginBottom: "16px", fontSize: "0.95rem" }}>
              Are you sure you want to delete <strong>{deletingProject.label}</strong>?
            </p>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "20px" }}>
              Metadata only, files are untouched.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button type="button" onClick={() => setDeletingProject(null)}>Cancel</button>
              <button type="button" className="danger" onClick={handleDeleteProject}>
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
