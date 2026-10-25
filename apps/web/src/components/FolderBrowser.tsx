import { useState, useEffect } from "react";
import { api } from "../api.js";
import type { DirectoryListing } from "@caw/contracts";

interface FolderBrowserProps {
  onSelect: (selectedPath: string) => void;
  onCancel: () => void;
}

export function FolderBrowser({ onSelect, onCancel }: FolderBrowserProps) {
  const [currentPath, setCurrentPath] = useState<string | undefined>(undefined);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setErrorText(null);

    api.browse(currentPath).then((res) => {
      if (!active) return;
      setLoading(false);
      if (res.ok) {
        setListing(res.data);
      } else {
        if (res.error.code === "path_forbidden") {
          setErrorText("Access forbidden: path is outside allowed workspace directories");
        } else if (res.error.code === "not_a_directory") {
          setErrorText("Selected path is not a directory");
        } else if (res.error.code === "path_not_found") {
          setErrorText("Folder not found");
        } else {
          setErrorText(res.error.message || "Failed to list directory");
        }
      }
    });

    return () => {
      active = false;
    };
  }, [currentPath, refreshVersion]);

  const pathParts = listing?.path ? listing.path.split("/").filter(Boolean) : [];
  const activeRoot = listing && listing.roots.find((root) => listing.path === root || listing.path.startsWith(`${root.replace(/\/$/u, "")}/`));
  const rootParts = activeRoot?.split("/").filter(Boolean) ?? [];
  const breadcrumbs = activeRoot
    ? [
        { part: rootParts.at(-1) ?? activeRoot, path: activeRoot },
        ...pathParts.slice(rootParts.length).map((part, index) => ({
          part,
          path: `/${pathParts.slice(0, rootParts.length + index + 1).join("/")}`,
        })),
      ]
    : [];
  const handleCreateFolder = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!listing?.path || creatingFolder) return;
    setCreatingFolder(true);
    setNewFolderError(null);
    const result = await api.createDirectory(listing.path, newFolderName);
    setCreatingFolder(false);
    if (!result.ok) {
      setNewFolderError(result.error.message);
      return;
    }
    setSelectedPath(result.data.path);
    setNewFolderName("");
    setShowNewFolder(false);
    setRefreshVersion((version) => version + 1);
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h3 style={{ marginBottom: "12px" }}>Browse Folders</h3>

        {errorText && (
          <div role="alert" style={{ color: "var(--danger)", fontSize: "0.9rem", padding: "8px", backgroundColor: "rgba(218,54,51,0.1)", borderRadius: "var(--radius)", marginBottom: "12px" }}>
            {errorText}
          </div>
        )}

        {/* Roots and breadcrumbs */}
        <div className="breadcrumbs">
          <button
            type="button"
            className="ghost"
            style={{ padding: "4px 6px", fontSize: "0.85rem" }}
          onClick={() => { setSelectedPath(null); setCurrentPath(undefined); }}
          >
            Roots
          </button>
          {breadcrumbs.map(({ part, path }) => (
            <span key={path} style={{ display: "inline-flex", alignItems: "center" }}>
              <span>/</span>
              <button
                type="button"
                className="ghost"
                style={{ padding: "4px 6px", fontSize: "0.85rem" }}
                onClick={() => { setSelectedPath(null); setCurrentPath(path); }}
              >
                {part}
              </button>
            </span>
          ))}
        </div>

        {!currentPath && listing?.roots && listing.roots.length > 1 && (
          <div aria-label="Workspace roots" style={{ display: "flex", flexWrap: "wrap", gap: "6px", margin: "8px 0" }}>
            {listing.roots.map((root) => (
              <button type="button" key={root} className="ghost" onClick={() => { setSelectedPath(null); setCurrentPath(root); }}>
                {root}
              </button>
            ))}
          </div>
        )}

        {listing?.path && (
          <div style={{ margin: "10px 0" }}>
            {!showNewFolder ? (
              <button type="button" className="ghost" onClick={() => { setShowNewFolder(true); setNewFolderError(null); }}>
                + New Folder
              </button>
            ) : (
              <form onSubmit={handleCreateFolder}>
                <label htmlFor="new-folder-name">New folder in {listing.path}</label>
                <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                  <input id="new-folder-name" value={newFolderName} maxLength={64} onChange={(event) => setNewFolderName(event.target.value)} autoFocus />
                  <button type="submit" className="primary" disabled={creatingFolder || !newFolderName.trim()}>
                    {creatingFolder ? "Creating…" : "Create folder"}
                  </button>
                  <button type="button" onClick={() => { setShowNewFolder(false); setNewFolderError(null); }}>Cancel</button>
                </div>
                {newFolderError && <div role="alert" style={{ color: "var(--danger)", marginTop: "6px" }}>{newFolderError}</div>}
              </form>
            )}
          </div>
        )}

        {loading ? (
          <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>
        ) : (
          <div className="folder-browser-list">
            {listing?.parent && (
              <div
                className="folder-item"
                style={{ cursor: "pointer" }}
                onClick={() => { setSelectedPath(null); setCurrentPath(listing.parent!); }}
              >
                <span>📁 .. (Up)</span>
              </div>
            )}

            {listing?.entries.filter((entry) => entry.isDirectory).map((entry) => {
              const disabled = !entry.allowed || !entry.isDirectory;
              const selected = selectedPath === entry.path;
              return (
                <div
                  key={entry.path}
                  className={`folder-item ${disabled ? "disabled" : ""} ${selected ? "selected" : ""}`}
                  style={{ cursor: disabled ? "not-allowed" : "pointer", borderColor: selected ? "var(--primary)" : undefined }}
                  onClick={() => {
                    if (!disabled) {
                      setSelectedPath(null);
                      setCurrentPath(entry.path);
                    }
                  }}
                >
                  <span>📁 {entry.name}</span>
                  {entry.hasProject && <span className="badge" style={{ fontSize: "0.7rem" }}>Project</span>}
                  {selected && <span className="badge">Selected</span>}
                </div>
              );
            })}

            {listing?.entries.filter((e) => e.isDirectory).length === 0 && (
              <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.9rem" }}>
                No subdirectories
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" }}>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="primary"
            disabled={!listing?.path || loading}
            onClick={() => {
              if (selectedPath) onSelect(selectedPath);
              else if (listing?.path) onSelect(listing.path);
            }}
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}
