import { useEffect, useMemo, useRef, useState } from "react";
import { api, type SavedConversationHistory } from "../api.js";
import { transcriptMessagesFromEntries, type TranscriptMessage } from "../transcript.js";
import type { GlobalSessionSummary } from "@caw/contracts";
import { MessageRow } from "./ConversationView.js";

interface Props {
  onBack: () => void;
  onSelectConversation: (id: string) => void;
}

function activity(value: string | null): string {
  if (!value) return "Activity time unavailable";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const unit = absolute < 60 ? "second" : absolute < 3600 ? "minute" : absolute < 86400 ? "hour" : absolute < 2592000 ? "day" : "month";
  const count = Math.max(1, Math.round(absolute / ({ second: 1, minute: 60, hour: 3600, day: 86400, month: 2592000 }[unit])));
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.sign(seconds) * count, unit as Intl.RelativeTimeFormatUnit);
}

export function HistoryView({ onBack, onSelectConversation }: Props) {
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sessions, setSessions] = useState<GlobalSessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [page, setPage] = useState<{ filesScanned: number; truncated: boolean; excludedOutsideRoots: number; skippedNonJournal: number; unreadableJournals: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const historyRequest = useRef(0);
  const pageRequest = useRef(0);
  const [selected, setSelected] = useState<GlobalSessionSummary | null>(null);
  const [history, setHistory] = useState<(SavedConversationHistory & { messages: TranscriptMessage[] }) | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const groups = useMemo(() => {
    const result = new Map<string, GlobalSessionSummary[]>();
    for (const session of sessions) {
      const key = session.projectId ? `Project · ${session.projectId}` : session.cwd;
      const group = result.get(key) ?? [];
      group.push(session);
      result.set(key, group);
    }
    return [...result.entries()];
  }, [sessions]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const id = ++generation.current;
    setSessions([]);
    setNextCursor(null);
    setPage(null);
    setError(null);
    setLoading(true);
    setLoadingMore(false);
    void api.listGlobalSessions({ q: debounced || undefined }).then((result) => {
      if (generation.current !== id) return;
      if (!result.ok) { setError(result.error.message || "Could not load sessions."); return; }
      setSessions(result.data.sessions);
      setNextCursor(result.data.nextCursor);
      setPage(result.data);
    }).catch((reason: unknown) => {
      if (generation.current === id) setError(reason instanceof Error ? reason.message : "Could not load sessions.");
    }).finally(() => { if (generation.current === id) setLoading(false); });
    return () => { if (generation.current === id) generation.current++; };
  }, [debounced, retryEpoch]);

  useEffect(() => () => {
    generation.current++;
    pageRequest.current++;
    historyRequest.current++;
  }, []);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const id = generation.current;
    const request = ++pageRequest.current;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await api.listGlobalSessions({ cursor: nextCursor, q: debounced || undefined });
      if (generation.current !== id || pageRequest.current !== request) return;
      if (!result.ok) { setError(result.error.message || "Could not load more sessions."); return; }
      setSessions((current) => {
        const seen = new Set(current.map((session) => session.sessionId));
        return [...current, ...result.data.sessions.filter((session) => !seen.has(session.sessionId))];
      });
      setNextCursor(result.data.nextCursor);
      setPage((previous) => previous ? { ...result.data, filesScanned: previous.filesScanned + result.data.filesScanned, truncated: previous.truncated || result.data.truncated, excludedOutsideRoots: Math.max(previous.excludedOutsideRoots, result.data.excludedOutsideRoots), skippedNonJournal: Math.max(previous.skippedNonJournal, result.data.skippedNonJournal), unreadableJournals: Math.max(previous.unreadableJournals, result.data.unreadableJournals) } : result.data);
    } catch (reason) { if (generation.current === id && pageRequest.current === request) setError(reason instanceof Error ? reason.message : "Could not load more sessions."); }
    finally { if (pageRequest.current === request) setLoadingMore(false); }
  };

  const closeHistory = () => {
    historyRequest.current++;
    setSelected(null);
    setHistory(null);
    setHistoryError(null);
    setHistoryLoading(false);
    setOlderLoading(false);
  };

  const openHistory = async (session: GlobalSessionSummary) => {
    const request = ++historyRequest.current;
    setSelected(session);
    setHistory(null);
    setHistoryError(null);
    setHistoryLoading(true);
    setOlderLoading(false);
    try {
      const result = await api.getSavedSessionHistory(session.sessionId);
      if (historyRequest.current !== request) return;
      if (!result.ok) { setHistoryError(result.error.code === "conflict_owner" ? result.error.message : result.error.message || "Could not load saved history."); return; }
      setHistory({ ...result.data, messages: transcriptMessagesFromEntries(result.data.entries as never[]) });
    } catch (reason) { if (historyRequest.current === request) setHistoryError(reason instanceof Error ? reason.message : "Could not load saved history."); }
    finally { if (historyRequest.current === request) setHistoryLoading(false); }
  };

  const loadOlder = async () => {
    const cursor = history?.nextCursor;
    if (!selected || !history?.hasOlder || !cursor || olderLoading) return;
    const request = historyRequest.current;
    const sessionId = selected.sessionId;
    const currentHistory = history;
    setOlderLoading(true);
    setHistoryError(null);
    try {
      const result = await api.getSavedSessionHistory(sessionId, cursor);
      if (historyRequest.current !== request) return;
      if (!result.ok) { setHistoryError(result.error.message || "Could not load older history."); return; }
      const more = transcriptMessagesFromEntries(result.data.entries as never[]);
      const seen = new Set(currentHistory.messages.map((message) => message.id));
      setHistory({ ...currentHistory, ...result.data, entries: [...result.data.entries, ...currentHistory.entries], messages: [...more.filter((message) => !seen.has(message.id)), ...currentHistory.messages], truncated: currentHistory.truncated || result.data.truncated, truncatedByBytes: currentHistory.truncatedByBytes || result.data.truncatedByBytes, truncatedByEntries: currentHistory.truncatedByEntries || result.data.truncatedByEntries, skippedOversized: currentHistory.skippedOversized || result.data.skippedOversized });
    } catch (reason) { if (historyRequest.current === request) setHistoryError(reason instanceof Error ? reason.message : "Could not load older history."); }
    finally { if (historyRequest.current === request) setOlderLoading(false); }
  };

  const resume = async (session: GlobalSessionSummary) => {
    if (session.live !== false || session.tracked || !session.cwdAvailable || !session.projectId) return;
    const result = await api.createConversation(session.projectId, session.title ?? "Resumed session", session.sessionId);
    if (result.ok) onSelectConversation(result.data.id);
    else setError(result.error.message || "Could not resume session.");
  };

  return <div className="view-container">
    <div className="history-heading"><button type="button" onClick={onBack}>← Back</button><h2>Session history</h2></div>
    <label className="history-search">Search sessions<input type="search" value={query} onChange={(event) => { generation.current++; pageRequest.current++; setLoadingMore(false); setLoading(true); setQuery(event.target.value); }} placeholder="Search title, path, or session ID" /></label>
    {loading && <p role="status">{query !== debounced ? "searching…" : "Loading sessions…"}</p>}
    {error && <div className="banner unknown" role="alert">{error}<button type="button" onClick={() => setRetryEpoch((value) => value + 1)}>Retry</button></div>}
    {page?.truncated && <div className="banner unknown history-truncated" role="alert"><strong>Session list is incomplete.</strong> This is a truthful prefix, not the whole store. Files scanned: {page.filesScanned}; excluded outside allowed roots: {page.excludedOutsideRoots}; skipped non-journal files: {page.skippedNonJournal}.</div>}
    {/* A different fact from a capped enumeration: the scan reached these
        journals and could not read them (permission/I-O), so the page is missing
        sessions it should have listed even though `truncated` is false. */}
    {page !== null && page.unreadableJournals > 0 && <div className="banner warning history-unreadable" role="alert"><strong>Some journals could not be read.</strong> {page.unreadableJournals} {page.unreadableJournals === 1 ? "journal was" : "journals were"} skipped after a read error, so this list may be incomplete.</div>}
    {!loading && !error && sessions.length === 0 && <p role="status">No sessions match.</p>}
    {groups.map(([group, rows]) => <section className="history-group" key={group}><h3>{group}</h3>{rows.map((session) => <article className="card history-row" key={session.sessionId}>
      <h4>{session.title || session.sessionId.slice(0, 8)}</h4><p className="history-path" title={session.cwd}>{session.cwd}</p><p className="history-activity">{activity(session.updatedAt)}</p>
      <div className="history-badges">{session.live === true && <span className="badge">live</span>}{session.live === "unknown" && <span className="badge">unknown</span>}{session.tracked && <span className="badge">tracked</span>}{!session.cwdAvailable && <span className="badge">history only</span>}</div>
      <div className="history-actions">{session.live !== false ? <button type="button" disabled title={session.live === "unknown" ? "Writer status could not be verified." : "Session writer is live."}>View history</button> : <button type="button" onClick={() => void openHistory(session)}>View history</button>}{session.tracked && session.conversationId && <button type="button" onClick={() => onSelectConversation(session.conversationId!)}>Open conversation</button>}{!session.tracked && session.live === false && session.cwdAvailable && session.projectId !== null && <button type="button" onClick={() => void resume(session)}>Resume</button>}{!session.tracked && session.live !== false && <button type="button" disabled title={session.live === "unknown" ? "Writer status could not be verified." : "Session writer is live."}>Resume</button>}{!session.tracked && session.live === false && !session.cwdAvailable && <button type="button" disabled title="Working directory no longer exists.">Resume</button>}{!session.tracked && session.live === false && session.cwdAvailable && session.projectId === null && <button type="button" disabled title="This folder is not a project; add it to resume here.">Resume</button>}{session.live === true && session.hasCollabHost && session.relayConnected === true && session.projectId !== null && <button type="button" onClick={() => void api.attachLiveSession(session.projectId!, session.sessionId).then((result) => result.ok ? onSelectConversation(result.data.id) : setError(result.error.message))}>Open live</button>}</div>
      {session.projectId === null && session.live === false && !session.tracked && session.cwdAvailable && <p className="history-safety">This folder is not a project; add it to resume here.</p>}
      {session.live === true && <p className="history-safety">Writer is live; saved history is unavailable.</p>}
      {session.live === false && !session.cwdAvailable && <p className="history-safety">Resume unavailable: working directory no longer exists.</p>}
      {session.tracked && !session.conversationId && <p className="history-safety">Tracked conversation ID is unavailable.</p>}
      {session.live === true && (!session.hasCollabHost || session.relayConnected !== true) && <p className="history-safety">Open live unavailable: live host or relay connection not verified.</p>}
    </article>)}</section>)}
    {nextCursor && <button type="button" className="ghost" disabled={loadingMore || loading} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</button>}
    {selected && <div className="history-reader" role="dialog" aria-modal="true" aria-label="Saved session history"><div className="history-reader-head"><h3>{selected.title || selected.sessionId.slice(0, 8)}</h3><button type="button" onClick={closeHistory}>Close</button></div><p className="history-path" title={selected.cwd}>{selected.cwd}</p>
      {historyLoading && <p role="status">Loading saved history…</p>}{historyError && <p role="alert">{historyError}<button type="button" onClick={() => void openHistory(selected)}>Retry</button></p>}
      {history && <><p className="banner idle" role="status">Saved transcript — read-only journal history.</p>{history.skippedOversized && <div className="banner unknown" role="alert">History is incomplete: a record too large to display was skipped; journal intact on disk.</div>}{history.truncated && (history.hasOlder || history.skippedOversized) && <div className="banner unknown" role="status">Saved transcript truncated; some history is omitted.</div>}{history.hasOlder && history.nextCursor && <button type="button" className="ghost" disabled={olderLoading} onClick={() => void loadOlder()}>{olderLoading ? "Loading older…" : "Load older"}</button>}{!history.hasOlder && !history.skippedOversized && <p role="status">Beginning of history.</p>}{history.messages.map((message) => <MessageRow key={message.id} message={message} />)}</>}
    </div>}
  </div>;
}
