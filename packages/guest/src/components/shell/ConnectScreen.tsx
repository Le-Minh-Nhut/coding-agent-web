import { ArrowRight, Lock } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import type { UnconfirmedPrompt } from "../../lib/client";
import { OmpMark } from "./OmpMark";
import { ThemeToggle } from "./ThemeToggle";

export interface ConnectScreenProps {
  defaultName: string;
  error: string | null;
  onConnect(link: string, name: string): void;
  recoveries: readonly UnconfirmedPrompt[];
  onDismissRecovery(id: number): void;
}

export function ConnectScreen({ defaultName, error, onConnect, recoveries, onDismissRecovery }: ConnectScreenProps): ReactNode {
  const [link, setLink] = useState("");
  const [name, setName] = useState(defaultName);
  const [localError, setLocalError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const trimmed = link.trim();
    if (!trimmed) { setLocalError("Paste a join link first."); return; }
    setLocalError(null);
    onConnect(trimmed, name.trim() || "guest");
  };
  const copy = async (record: UnconfirmedPrompt): Promise<void> => {
    try { await navigator.clipboard.writeText(record.text); setCopiedId(record.id); }
    catch { setLocalError("Clipboard unavailable; select and copy prompt text manually."); }
  };
  const shown = localError ?? error;
  return (
    <div className="sh-connect">
      <div className="sh-ambient" />
      <div className="sh-connect-top"><div className="sh-brand"><OmpMark /><span>omp</span><span className="sh-brand-slash">/</span><span className="sh-brand-app">collab</span></div><ThemeToggle /></div>
      <form className="sh-connect-card" onSubmit={submit}>
        <div className="sh-connect-head"><h1 className="sh-connect-title">Join a live session</h1><p className="sh-connect-sub">Watch an omp agent work in real time — transcript, tool calls and subagents — and prompt it from here.</p></div>
        <label className="sh-field"><span className="sh-field-label">Join link</span><input className="sh-input sh-input-mono" type="text" value={link} onChange={e => setLink(e.target.value)} placeholder="ws://host:port/r/room.key" spellCheck={false} autoComplete="off" autoFocus /><span className="sh-field-hint">Run <code>/collab</code> in any omp session to get one.</span></label>
        <label className="sh-field"><span className="sh-field-label">Display name</span><input className="sh-input" type="text" value={name} onChange={e => setName(e.target.value)} placeholder="guest" spellCheck={false} autoComplete="off" maxLength={32} /></label>
        {shown && <div className="sh-connect-error">{shown}</div>}
        <button className="sh-btn sh-btn-primary sh-connect-submit" type="submit">Connect <ArrowRight size={14} /></button>
        <div className="sh-connect-foot"><Lock size={12} />End-to-end encrypted. The room key stays in the link and never reaches the relay.</div>
      </form>
      {recoveries.length > 0 && <details className="sh-recoverable-prompts"><summary>Saved prompts ({recoveries.length})</summary>{recoveries.map(record => <article className="sh-recoverable-prompt" key={record.id}><small>room {record.roomId}{record.sessionId ? ` / session ${record.sessionId}` : ""}</small><pre className="sh-recoverable-text">{record.text}</pre><button type="button" className="sh-btn" onClick={() => void copy(record)}>{copiedId === record.id ? "Copied" : "Copy"}</button><button type="button" className="sh-btn" onClick={() => onDismissRecovery(record.id)}>Dismiss</button></article>)}</details>}
    </div>
  );
}
