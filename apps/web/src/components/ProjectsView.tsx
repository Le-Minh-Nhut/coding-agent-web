import { useState, useEffect } from "react";
import { api } from "../api.js";
import { FolderBrowser } from "./FolderBrowser.js";
import type { ProjectWithStats } from "@caw/contracts";

interface ProjectsViewProps {
  onSelectProject: (projectId: string) => void;
  onOpenSettings: () => void;
}

export function ProjectsView({ onSelectProject, onOpenSettings }: ProjectsViewProps) {
  const [projects, setProjects] = useState<ProjectWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [showBrowser, setShowBrowser] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit / Delete dialogs
  const [editingProject, setEditingProject] = useState<ProjectWithStats | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [deletingProject, setDeletingProject] = useState<ProjectWithStats | null>(null);

  const loadProjects = async () => {
    setLoading(true);
    const res = await api.listProjects();
    setLoading(false);
    if (res.ok) {
      setProjects(res.data);
    } else {
      setError(res.error.message);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  const handleToggleFavorite = async (e: React.MouseEvent, project: ProjectWithStats) => {
    e.stopPropagation();
    const res = await api.updateProject(project.id, { favorite: !project.favorite });
    if (res.ok) {
      setProjects((prev) =>
        prev.map((p) => (p.id === project.id ? { ...p, favorite: !p.favorite } : p))
      );
    }
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPath || !newLabel.trim() || creating) return;
    setCreating(true);
    setError(null);

    const res = await api.createProject(selectedPath, newLabel.trim());
    setCreating(false);
    if (res.ok) {
      setSelectedPath(null);
      setNewLabel("");
      loadProjects();
    } else {
      setError(res.error.message);
    }
  };

  const handleRenameProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProject || !editLabel.trim()) return;
    const res = await api.updateProject(editingProject.id, { label: editLabel.trim() });
    if (res.ok) {
      setEditingProject(null);
      loadProjects();
    } else {
      setError(res.error.message);
    }
  };

  const handleDeleteProject = async () => {
    if (!deletingProject) return;
    const res = await api.deleteProject(deletingProject.id);
    if (res.ok) {
      setDeletingProject(null);
      loadProjects();
    } else {
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
              onChange={(e) => setNewLabel(e.target.value)}
              autoFocus
              required
            />
            <button type="submit" className="primary" disabled={creating}>
              Create
            </button>
            <button type="button" onClick={() => setSelectedPath(null)}>
              Cancel
            </button>
          </form>
        </div>
      )}

      {loading ? (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)" }}>Loading projects…</div>
      ) : projects.length === 0 ? (
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
                      onClick={() => setDeletingProject(project)}
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
                onChange={(e) => setEditLabel(e.target.value)}
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
