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
  }, [currentPath]);

  const pathParts = listing?.path ? listing.path.split("/").filter(Boolean) : [];

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
            onClick={() => setCurrentPath(undefined)}
          >
            Roots
          </button>
          {pathParts.map((part, index) => {
            const reconstructed = "/" + pathParts.slice(0, index + 1).join("/");
            return (
              <span key={reconstructed} style={{ display: "inline-flex", alignItems: "center" }}>
                <span>/</span>
                <button
                  type="button"
                  className="ghost"
                  style={{ padding: "4px 6px", fontSize: "0.85rem" }}
                  onClick={() => setCurrentPath(reconstructed)}
                >
                  {part}
                </button>
              </span>
            );
          })}
        </div>

        {loading ? (
          <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>
        ) : (
          <div className="folder-browser-list">
            {listing?.parent && (
              <div
                className="folder-item"
                style={{ cursor: "pointer" }}
                onClick={() => setCurrentPath(listing.parent!)}
              >
                <span>📁 .. (Up)</span>
              </div>
            )}

            {listing?.entries.filter((entry) => entry.isDirectory).map((entry) => {
              const disabled = !entry.allowed || !entry.isDirectory;
              return (
                <div
                  key={entry.path}
                  className={`folder-item ${disabled ? "disabled" : ""}`}
                  style={{ cursor: disabled ? "not-allowed" : "pointer" }}
                  onClick={() => {
                    if (!disabled) {
                      setCurrentPath(entry.path);
                    }
                  }}
                >
                  <span>📁 {entry.name}</span>
                  {entry.hasProject && <span className="badge" style={{ fontSize: "0.7rem" }}>Project</span>}
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
              if (listing?.path) {
                onSelect(listing.path);
              }
            }}
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}
