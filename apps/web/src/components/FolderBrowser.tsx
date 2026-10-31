import { useState, useEffect, useRef } from "react";
import { api } from "../api.js";
import { ModalOverlay } from "./ModalOverlay.js";
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
  /**
   * Draft revision of the new-folder input, bumped on every keystroke. A create
   * response may clear/close the form only when the revision is the one captured at
   * that submit; an edit made while the request was pending keeps the name and the
   * form on screen (V20-05).
   */
  const folderNameRevisionRef = useRef(0);
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loadingMoreFor, setLoadingMoreFor] = useState<number | null>(null);
  const createdPathRef = useRef<{ directory: string; path: string } | null>(null);
  const navigationGenerationRef = useRef(0);
  /**
   * Owns the new-folder dialog's create request. The listing/navigation generation
   * guards a stale create against selecting a path outside the directory now shown,
   * but it cannot tell that the dialog was cancelled and reopened: the token minted
   * at submit does. Cancel replaces it, so a cancelled request's completion returns
   * without touching — or blaming — the form on screen now.
   */
  const createFolderOpRef = useRef<object | null>(null);
  useEffect(() => {
    // A same-path reload (refreshVersion) is a new generation too, so a stray
    // load-more or a late list response from the previous load cannot write into
    // this one. The generation ref is the single guard: the cleanup bumps it, so
    // a post-unmount or post-navigation response is dropped uniformly.
    //
    // Only this effect — and its cleanup — may bump the generation, because a bump
    // is only correct when a replacement load actually starts. Re-asserting the
    // current path (Roots / breadcrumb / the folder already shown) and closing the
    // new-folder form without reloading do NOT bump: they start no replacement, so
    // a bump would strand the only in-flight loader with nothing to clear
    // `loading` and leave the listing stuck empty with every button disabled.
    navigationGenerationRef.current++;
    const generation = navigationGenerationRef.current;
    setLoading(true);
    setErrorText(null);
    setListing(null);
    setLoadingMoreFor(null);

    const load = async () => {
      let result = await api.browse(currentPath, { limit: 100 });
      if (generation !== navigationGenerationRef.current) return;
      if (!result.ok) {
        const message = result.error.code === "path_forbidden"
          ? "Access forbidden: path is outside allowed workspace directories"
          : result.error.code === "not_a_directory"
            ? "Selected path is not a directory"
            : result.error.code === "path_not_found"
              ? "Folder not found"
              : result.error.message || "Failed to list directory";
        setErrorText(message);
        setLoading(false);
        return;
      }
      let page = result.data;
      setListing(page);
      const created = createdPathRef.current;
      while (created && page.path === created.directory && !page.entries.some((entry) => entry.path === created.path) && page.nextCursor) {
        result = await api.browse(page.path, { limit: 100, cursor: page.nextCursor });
        if (generation !== navigationGenerationRef.current) return;
        if (!result.ok) {
          setErrorText(result.error.message || "Failed to load more folders");
          break;
        }
        page = { ...page, entries: [...page.entries, ...result.data.entries], hasMore: result.data.hasMore, nextCursor: result.data.nextCursor };
        setListing(page);
      }
      if (created && page.entries.some((entry) => entry.path === created.path)) createdPathRef.current = null;
      setLoading(false);
    };

    void load();
    return () => { navigationGenerationRef.current++; };
  }, [currentPath, refreshVersion]);
  const loadMore = async () => {
    if (!listing?.nextCursor || loadingMoreFor !== null) return;
    // Pending load-more belongs to the navigation generation that started it. The
    // captured generation is stored on the button state, so only that generation's
    // settlement releases it: an old navigation completing while a newer one owns
    // the pending leaves it alone, and vice versa.
    const generation = navigationGenerationRef.current;
    const directory = listing.path;
    setLoadingMoreFor(generation);
    setErrorText(null);
    const result = await api.browse(directory, { limit: 100, cursor: listing.nextCursor });
    setLoadingMoreFor((owner) => (owner === generation ? null : owner));
    // The list/error writes below are dropped if the user has navigated since.
    if (generation !== navigationGenerationRef.current) return;
    if (!result.ok) {
      setErrorText(result.error.message || "Failed to load more folders");
      return;
    }
    setListing((current) => current && current.path === directory ? {
      ...current,
      entries: [...current.entries, ...result.data.entries],
      hasMore: result.data.hasMore,
      nextCursor: result.data.nextCursor,
    } : current);
  };



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
    const generation = navigationGenerationRef.current;
    const token = {};
    createFolderOpRef.current = token;
    const directory = listing.path;
    // The draft revision at this submit. A keystroke while the request is open makes
    // the name on screen a different, unsaved folder: its success must not clear or
    // unmount the form the user is still typing in (V20-05).
    const revision = folderNameRevisionRef.current;
    const result = await api.createDirectory(directory, newFolderName);
    // A completion acts only on the dialog that submitted it. Cancel (or a form
    // opened since) replaced the token, so this stale response is invisible to the
    // UI: it must not clear a pending flag, an error, a name, a selection, or reload
    // the listing — a reload would null `listing` and unmount the new form with its
    // unsaved draft. The folder exists on disk and appears on the next real
    // navigation.
    if (createFolderOpRef.current !== token) return;
    setCreatingFolder(false);
    if (generation !== navigationGenerationRef.current) return;
    if (!result.ok) {
      setNewFolderError(result.error.message);
      return;
    }
    // The user edited the name while the request was pending: keep their draft and
    // the form. Selecting the created folder and reloading the listing would drop
    // that draft (a reload nulls `listing`, which unmounts the form). The folder
    // exists and shows on the next navigation. The submitted name still won its
    // create, so the idempotence hint is remembered for when the user does come back.
    if (folderNameRevisionRef.current !== revision) {
      createdPathRef.current = { directory, path: result.data.path };
      return;
    }
    setSelectedPath(result.data.path);
    createdPathRef.current = { directory, path: result.data.path };
    setNewFolderName("");
    setShowNewFolder(false);
    setRefreshVersion((version) => version + 1);
  };

  return (
    <ModalOverlay
      onClose={onCancel}
      aria-labelledby="folder-browser-title"
      overlayProps={{ className: "modal-overlay" }}
    >
      <div className="modal-content">
        <h3 id="folder-browser-title" style={{ marginBottom: "12px" }}>Browse Folders</h3>

        {errorText && (
          <div style={{ marginBottom: "12px" }}>
            <div role="alert" style={{ color: "var(--danger-text)", fontSize: "0.9rem", padding: "8px", backgroundColor: "rgba(218,54,51,0.1)", borderRadius: "var(--radius)" }}>
              {errorText}
            </div>
            {/* A failed listing leaves nothing to pick from, so the retry reuses the
                same reload path the create-folder refresh already uses. Kept outside
                the alert so the alert text stays exactly the error message. */}
            <button type="button" className="ghost" style={{ color: "var(--danger-text)", marginTop: "4px" }} onClick={() => setRefreshVersion((version) => version + 1)}>
              Retry
            </button>
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

        {/* role="group": a bare div has no role for aria-label to attach to, so
            the name was exposed on nothing. */}
        {!currentPath && listing?.roots && listing.roots.length > 1 && (
          <div role="group" aria-label="Workspace roots" style={{ display: "flex", flexWrap: "wrap", gap: "6px", margin: "8px 0" }}>
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
                <label htmlFor="new-folder-name" className="path-text">New folder in {listing.path}</label>
                <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                  <input id="new-folder-name" value={newFolderName} maxLength={64} onChange={(event) => { folderNameRevisionRef.current++; setNewFolderName(event.target.value); }} autoFocus />
                  <button type="submit" className="primary" disabled={creatingFolder || !newFolderName.trim()}>
                    {creatingFolder ? "Creating…" : "Create folder"}
                  </button>
                  {/* Cancel invalidates only this dialog: it replaces the operation
                      token so the request already in flight can no longer touch — or
                      blame — the form that opens next, and it clears the pending flag so
                      the next form is immediately operable. The listing loader owns its
                      own request; bumping the navigation generation here would drop the
                      in-flight listing completion with no replacement to clear it. */}
                  <button type="button" onClick={() => { setShowNewFolder(false); setNewFolderError(null); setCreatingFolder(false); createFolderOpRef.current = {}; }}>Cancel</button>
                </div>
                {newFolderError && <div role="alert" style={{ color: "var(--danger-text)", marginTop: "6px" }}>{newFolderError}</div>}
              </form>
            )}
          </div>
        )}

        {loading ? (
          <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>
        ) : (
          <div className="folder-browser-list">
            {listing?.parent && (
              // A real <button>: focus, Enter/Space activation and the button role all
              // come from the browser. .folder-item carries the list styling.
              <button
                type="button"
                className="folder-item"
                style={{ cursor: "pointer" }}
                onClick={() => { setSelectedPath(null); setCurrentPath(listing.parent!); }}
              >
                <span>📁 .. (Up)</span>
              </button>
            )}

            {listing?.entries.filter((entry) => entry.isDirectory).map((entry) => {
              const disabled = !entry.allowed || !entry.isDirectory;
              const selected = selectedPath === entry.path;
              return (
                <button
                  key={entry.path}
                  type="button"
                  disabled={disabled}
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
                </button>
              );
            })}

            {listing?.entries.filter((e) => e.isDirectory).length === 0 && (
              <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.9rem" }}>
                No subdirectories
              </div>
            )}
            {!listing && !errorText && (
              <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.9rem" }}>
                Loading folders…
              </div>
            )}
            {!listing && errorText && (
              <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.9rem" }}>
                No folders to show until this directory loads.
              </div>
            )}
            {listing?.hasMore && (
              <button type="button" className="folder-browser-load-more" onClick={() => void loadMore()} disabled={loadingMoreFor !== null}>
                {loadingMoreFor !== null ? "Loading…" : "Load more"}
              </button>
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
    </ModalOverlay>
  );
}
