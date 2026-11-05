import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type SavedConversationHistory } from "../api.js";
import { chainMutation, MUTATION_CANCELLED } from "../mutation-order.js";
import { MarkdownCodeBlock, parseInline, renderMarkdown } from "../sanitize.js";
import { ActivityPanel } from "./ActivityPanel.js";
import { AdvisorPanel } from "./AdvisorPanel.js";
import { ModalOverlay } from "./ModalOverlay.js";
import { SubagentPanel } from "./SubagentPanel.js";
import { VibePanel, vibeVerdictLabel } from "./VibePanel.js";
import { advisorNotesOf, summarizeAdvisorNotes } from "../advisor.js";
import {
  CollabSocket,
  parseCollabLink,
  importRoomKey,
  encodeBase64Url,
  type HostFrame,
  type SessionEntry,
} from "@caw/collab-protocol";
import { clearTranscriptRequests, createTranscriptState, forgetTranscriptRequest, reduceHostFrame, setConnectionStatus, textFromContent, trackTranscriptRequest, transcriptMessagesFromEntries, type TranscriptBlock, type TranscriptMessage, type TranscriptReply, type TranscriptState, type ToolResultLike } from "../transcript.js";
import { findSlashCommand, slashCommands, type SlashCommand } from "../commands.js";
import { ActivityGroupRow } from "./ToolActivity.js";
import { groupActivity, pairToolArguments } from "../tool-activity.js";
import type { AttachInstructions, Conversation, NativeModeResult, VibeStateResponse } from "@caw/contracts";
/** A settled prompt record kept until explicit dismissal. */
export interface RefusedRecovery {
  id: number;
  text: string;
  unconfirmed?: boolean;
  echoed?: boolean;
  recoveredText?: string;
}

interface ConversationViewProps {
  conversationId: string;
  draft?: string;
  onDraftChange?: (draft: string) => void;
  onBack: () => void;
  /** App-owned recovery list and dedupe state survive Back/reopen. */
  refusedRecoveries?: RefusedRecovery[];
  onRefusedRecoveriesChange?: (next: RefusedRecovery[]) => void;
}
interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "notice";
  text: string;
  blocks?: TranscriptBlock[];
  toolName?: string;
  toolCallId?: string;
  toolResult?: ToolResultLike;
  /** Wire arguments captured from the live start event; the guest body renders
      these directly, so dropping them here silently empties every live tool row. */
  toolArgs?: Record<string, unknown>;
  isError?: boolean;
  isRunning?: boolean;
  awaitingHost?: boolean;
  hostEchoCount?: number;
  /** Custom-message type, so an advisor card can render structurally. */
  customType?: string;
  /** That entry's `details` payload, verbatim. */
  customDetails?: unknown;
}
interface PendingPrompt {
  text: string;
  submitted: string;
  hostEchoCount: number;
  optimisticId: string | null;
  sent: boolean;
  refusalMessage?: string;
  echoed?: boolean;
  draftVersion: number;
  /** Physical connection the prompt was sent on; a refusal only matches prompts from the current one. */
  physicalConnection: number;
  /**
   * True when the send happened while the bootstrap snapshot was still in flight.
   * Snapshot rows are a historical baseline, never this prompt's receipt, so a
   * completing snapshot must not acknowledge it.
   */
  preSnapshot: boolean;
  token: object;
}


const TAIL_THRESHOLD_PX = 80;
const MAX_TRANSCRIPT_REQUESTS = 64;
const TRANSCRIPT_REQUEST_TIMEOUT_MS = 15_000;
const TRANSCRIPT_POLL_MS = 1200;
const STARTUP_PROMPT_REFUSAL = "prompting is unavailable until the host finishes starting up";

export type ConnectionStatus = "connecting" | "idle" | "running" | "reconnecting" | "disconnected" | "unknown";

/**
 * V20-09: the exact host messages that prove a prompt was NOT submitted. Each one
 * is lifted verbatim from the pinned OMP host (collab/host.ts); an unrelated error
 * ("agent control is disabled on a read-only link") must not consume the pending
 * prompt, so this is a closed list, never a wildcard over every error frame.
 */
const NON_SUBMISSION_REFUSALS: ReadonlySet<string> = new Set([
  STARTUP_PROMPT_REFUSAL,
  "prompting is unavailable until the session transition completes",
  "Prompt was not submitted. Please resend it when the host is ready.",
  "session changed before a guest prompt was submitted. Rejoin and resend any prompt not shown in the conversation",
  "session switched; prompts not shown in the conversation were not submitted. Rejoin and resend them",
]);


/** The user text a live frame echoes, or null when the frame is not a user prompt echo. */
function userEchoText(frame: HostFrame): string | null {
  if (frame.t === "entry" && frame.entry.type === "message" && frame.entry.message.role === "user") {
    return textFromContent(frame.entry.message.content);
  }
  // The real wire shape for a web prompt accepted by the host: OMP journals it as
  // custom_message/collab-prompt, and transcript.ts maps that to a user row. Without
  // this branch every genuine web echo is invisible to the ack paths (V20-02/V19-fix8).
  if (frame.t === "entry" && frame.entry.type === "custom_message" && frame.entry.customType === "collab-prompt") {
    return textFromContent(frame.entry.content);
  }
  if (frame.t === "event" && frame.event.type === "message_end" && frame.event.message.role === "user") {
    return textFromContent(frame.event.message.content);
  }
  return null;
}

export function autosizeComposer(element: HTMLTextAreaElement | null): void {
  if (!element) return;
  element.style.height = "0px";
  const height = element.scrollHeight;
  element.style.height = `${Math.min(140, Math.max(44, height))}px`;
  element.style.overflowY = height > 140 ? "auto" : "hidden";
}

export function shouldSubmitOnEnter(
  event: Pick<React.KeyboardEvent<HTMLTextAreaElement>, "key" | "shiftKey" | "nativeEvent">,
  composing: boolean,
  coarsePointer = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true,
): boolean {
  return !coarsePointer && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing;
}

/**
 * An advisor card, in the compact form the phone needs.
 *
 * OMP delivers advice as a batched `custom_message` (`customType: "advisor"`)
 * whose details carry one or more notes with a severity each. The row's shape is
 * a single line per note — `⚠ Advisor · Concern ›` — with the note text revealed
 * on tap, because a wall of advisor prose between two turns is exactly the kind
 * of chrome that pushes the conversation off a 390px screen.
 *
 * Severity is never levelled: a `blocker` keeps the error colour and its own
 * prominent line so it cannot be mistaken for a nit, and it is never hidden
 * behind the transcript's own collapsing (the row is a normal transcript row, so
 * replay and compaction keep it).
 */
function AdvisorMessageCard({ message }: { message: DisplayMessage }) {
  const [open, setOpen] = useState(false);
  const notes = advisorNotesOf({ customType: message.customType, details: message.customDetails });
  if (notes.length === 0) {
    return <div className="message-content"><p>{message.text}</p></div>;
  }
  const worst = notes.some((note) => note.severity === "blocker")
    ? "blocker"
    : notes.some((note) => note.severity === "concern") ? "concern" : "nit";
  return (
    <div className={`advisor-card advisor-card--${worst}`}>
      <button
        type="button"
        className="advisor-card-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="advisor-card-glyph" aria-hidden="true">{worst === "blocker" ? "⛔" : "⚠"}</span>
        <span className="advisor-card-label">
          Advisor{notes.length === 1 ? "" : ` · ${notes.length} notes`}
          {worst !== "nit" ? ` · ${worst === "blocker" ? "Blocker" : "Concern"}` : ""}
        </span>
        <span className="advisor-card-preview">{notes[0]!.note.split("\n", 1)[0]}</span>
        <span className="advisor-card-chevron" aria-hidden="true">{open ? "▾" : "›"}</span>
      </button>
      {worst === "blocker" && !open && (
        // A blocker is the one severity that must survive a collapsed row: the
        // user has to be able to read what it says without tapping anything.
        <p className="advisor-card-blocker-text">{notes.find((note) => note.severity === "blocker")!.note}</p>
      )}
      {open && (
        <ul className="advisor-card-notes">
          {notes.map((note, index) => (
            <li key={index}>
              <span className={`badge ${note.severity === "blocker" ? "error" : note.severity === "concern" ? "warning" : "idle"}`}>{note.severity}</span>
              {note.advisor !== null && <span className="advisor-note-owner">{note.advisor}</span>}
              <p>{note.note}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const MessageRow = memo(function MessageRow({ message }: { message: DisplayMessage | TranscriptMessage }) {
  const [expanded, setExpanded] = useState(false);
  const blocks = "blocks" in message ? message.blocks : undefined;
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); } catch { /* Clipboard permission is optional; content remains selectable. */ } };
  return (
    <div className={`message-card ${message.role}${message.isError ? " error" : ""}`}>
      <div style={{ fontSize: "0.75rem", color: message.isError ? "var(--danger-text)" : "var(--text-muted)", marginBottom: "4px", textTransform: "capitalize" }}>
        {message.role} {message.toolName ? `(${message.toolName})` : ""}{message.isError ? " · error" : ""}
        {"awaitingHost" in message && message.awaitingHost ? " · sent while active; awaiting host" : ""}
      </div>
      {/* An advisor card is a transcript row, so it survives replay and is never
          folded into a group: an advisor warning hidden inside a collapsed
          activity row is a warning the user will not see. */}
      {"customType" in message && message.customType === "advisor" ? (
        <AdvisorMessageCard message={message} />
      ) : message.role === "tool" ? <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>{message.toolName ?? "Tool Result"} {"isRunning" in message && message.isRunning ? "(Running…)" : message.isError ? "(Error)" : "(Completed)"}</summary>
        <p className="tool-output-preview">{message.text.slice(0, 240)}{message.text.length > 240 ? "…" : ""}</p>
        <div className="history-actions"><button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? "Collapse output" : "Expand output"}</button><button type="button" onClick={() => void copy(message.text)}>Copy output</button></div>
        {/* Mounted only while open: a 5000-line result otherwise builds every text
            node the collapsed card never shows, which is the expensive-render case
            on a phone. The full string stays in `message.text` — Copy reads it and
            expanding mounts all of it, so nothing is deleted, only deferred. */}
        {expanded && <pre className="message-content" style={{ overflowX: "auto", whiteSpace: "pre" }}><code>{message.text}</code></pre>}
      </details> : blocks && message.role !== "notice" ? <div className="message-content">{blocks.map((block, index) => renderTranscriptBlock(block, index))}</div> : (
        <div className="message-content">{message.role === "notice" ? <p>{message.text}</p> : renderMarkdown(message.text)}</div>
      )}
    </div>
  );
});

/**
 * The transcript list: tool results collapse into per-category activity groups,
 * every other row keeps its own card.
 *
 * Grouping is presentation only — the rows handed to a group are the same
 * objects the ungrouped list would render, and each group's card expands to
 * those rows unchanged. That is why a reconnect or replay cannot duplicate rows:
 * the group derives from `messages`, which the reducer already de-duplicates.
 */
export const TranscriptList = memo(function TranscriptList({ rows }: { rows: DisplayMessage[] }) {
  const entries = useMemo(() => groupActivity(rows), [rows]);
  const pairedArgs = useMemo(() => pairToolArguments(rows), [rows]);
  return (
    <>
      {entries.map((entry) => entry.kind === "row"
        ? <MessageRow key={entry.row.id} message={entry.row} />
        : <ActivityGroupRow key={`group:${entry.group.rows[0]?.id ?? ""}`} group={entry.group} pairedArgs={pairedArgs} />)}
    </>
  );
});

function renderTranscriptBlock(block: TranscriptBlock, index: number): React.ReactNode {
  if (block.type === "toolCall") return <details key={index}><summary>{`[Tool call: ${block.name}${block.intent ? ` — ${block.intent}` : ""}]`}</summary><pre style={{ overflowX: "auto" }}><code>{JSON.stringify(block.arguments, null, 2)}</code></pre></details>;
  if (block.type === "image") return block.dataUrl ? <img key={index} src={block.dataUrl} alt="Attachment" style={{ maxWidth: "100%" }} /> : <p key={index}>{block.label}</p>;
  if (block.type === "notice") return <p key={index}>{block.text}</p>;
  return <React.Fragment key={index}>{renderMarkdown(block.text)}</React.Fragment>;
}

/**
 * Render a handoff refusal in the user's terms.
 *
 * `terminal_attached` is the one refusal the user can act on locally, and the
 * reason matters: the keystrokes would land in their terminal's draft, not in
 * the agent's input. The other codes already carry a precise server message
 * (which process could not be verified), so they are shown verbatim rather than
 * replaced with a guess.
 */
export function handoffRefusalText(code: string, message: string): string {
  if (code === "terminal_attached") return "A terminal is attached to this session. Run /handoff there instead.";
  if (code === "handoff_in_flight") return message || "A handoff is already in progress for this conversation.";
  if (code === "draft_unconfirmed") {
    return message || "The terminal may still hold an unsent draft. Confirm the editor is empty before sending /handoff.";
  }
  return message;
}


export function ConversationView({ conversationId, draft = "", onDraftChange, onBack, refusedRecoveries: refusedRecoveriesProp, onRefusedRecoveriesChange }: ConversationViewProps) {


  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [transcript, setTranscript] = useState<TranscriptState>(createTranscriptState);
  const transcriptRef = useRef(transcript);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [sendError, setSendError] = useState<string | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<DisplayMessage[]>([]);
  const [inputText, setInputText] = useState(draft);
  const [isDetached, setIsDetached] = useState(false);
  const [attachInfo, setAttachInfo] = useState<AttachInstructions | null>(null);
  const [linkUnavailable, setLinkUnavailable] = useState(false);
  const [interceptedCommand, setInterceptedCommand] = useState<SlashCommand | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  // A refusal is positive evidence the agent declined, so it must not be painted
  // with the green "running" tone that means "we delivered it".
  const [handoffNoticeTone, setHandoffNoticeTone] = useState<"running" | "warning">("running");
  const [handoffRefusal, setHandoffRefusal] = useState<string | null>(null);
  // The code decides whether the refusal is confirmable (`draft_unconfirmed`, an
  // unprovable risk the user can accept) or hard (`terminal_attached`, where the
  // command must run in that terminal at all).
  const [handoffRefusalCode, setHandoffRefusalCode] = useState<string | null>(null);
  const [handoffConfirming, setHandoffConfirming] = useState(false);
  const [stopSessionConfirming, setStopSessionConfirming] = useState(false);
  const [stopSessionBusy, setStopSessionBusy] = useState(false);
  const [stopSessionNotice, setStopSessionNotice] = useState<string | null>(null);
  const [stopSessionRefusal, setStopSessionRefusal] = useState<string | null>(null);
  const [restartBusy, setRestartBusy] = useState(false);
  const [modelCatalogState, setModelCatalogState] = useState<{ status: "loading" } | { status: "loaded"; models: string[] } | { status: "empty" } | { status: "unavailable"; reason: string } | { status: "error"; message: string }>({ status: "loading" });
  const [modelDraft, setModelDraft] = useState("");
  const [modelMessage, setModelMessage] = useState("");
  const [effectiveModel, setEffectiveModel] = useState<{ conversationId: string; model: string | null } | null>(null);
  const [viewAccessOffer, setViewAccessOffer] = useState<string | null>(null);
  const [linkFailure, setLinkFailure] = useState<string | null>(null);
  const [roomRetired, setRoomRetired] = useState(false);
  const [linkAccess, setLinkAccess] = useState<"view" | "full" | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [showSubagents, setShowSubagents] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [showAdvisor, setShowAdvisor] = useState(false);
  const [showVibe, setShowVibe] = useState(false);
  /**
   * Native vibe state, as reported by the control bridge.
   *
   * `null` means "not asked yet"; the panel distinguishes that from an
   * `available: false` answer (asked, could not be told) and from a real state.
   * Nothing here guesses a mode.
   */
  const [vibeState, setVibeState] = useState<VibeStateResponse | null>(null);
  const [vibeBusy, setVibeBusy] = useState(false);
  const [vibeError, setVibeError] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [transcriptErrors, setTranscriptErrors] = useState<Record<string, string>>({});
  const [savedHistory, setSavedHistory] = useState<(SavedConversationHistory & { messages: TranscriptMessage[] }) | null>(null);
  /**
   * V22-01: what a fresh history read actually proves. `conflict_owner` means a
   * writer is live OR its status cannot be verified, so it is `live` (a live claim
   * the copy must hedge) and never a verified fact. `archived` = a readable journal.
   * `unverified` = not_found/internal/path_forbidden/network, none of which is proof
   * the host is stopped, but none of which sustains a stale live claim either: every
   * current-generation verdict replaces the previous one.
   */
  const [historyVerdict, setHistoryVerdict] = useState<"unverified" | "live" | "archived">("unverified");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [olderHistoryLoading, setOlderHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [olderHistoryError, setOlderHistoryError] = useState<string | null>(null);
  /** Bumped by Retry so the saved-history effect re-runs even though linkUnavailable stays true. */
  const [historyRetryEpoch, setHistoryRetryEpoch] = useState(0);
  const [uiEditorValue, setUiEditorValue] = useState("");
  /**
   * Refused prompts the composer did not take back. A refusal only restores
   * itself when the composer is untouched; otherwise the refused text lives here
   * behind an explicit Recover/Copy strip so neither draft is destroyed. The list
   * is per conversation and survives Back/reopen when the App owns it.
   */
  const [internalRefusedRecoveries, setInternalRefusedRecoveries] = useState<RefusedRecovery[]>([]);
  const [refusedCopyState, setRefusedCopyState] = useState<{ id: number; state: "copied" | "failed" } | null>(null);
  const refusedRecoveries = refusedRecoveriesProp ?? internalRefusedRecoveries;
  const setRefusedRecoveries = (next: RefusedRecovery[]): void => {
    if (onRefusedRecoveriesChange) onRefusedRecoveriesChange(next);
    else setInternalRefusedRecoveries(next);
  };
  const refusedRecoveriesRef = useRef(refusedRecoveries);
  refusedRecoveriesRef.current = refusedRecoveries;
  const refusedIdRef = useRef(0);
  const appendRefusedRecovery = (text: string, unconfirmed = false): void => {
    const list = refusedRecoveriesRef.current;
    // Seed from the list so a caller-supplied list keeps unique ids across remounts.
    if (refusedIdRef.current === 0) refusedIdRef.current = list.reduce((max, item) => Math.max(max, item.id), 0);
    const next = [...list, { id: ++refusedIdRef.current, text, ...(unconfirmed ? { unconfirmed: true } : {}) }];
    refusedRecoveriesRef.current = next;
    setRefusedRecoveries(next);
  };
  const removeRefusedRecovery = (id: number): void => {
    const next = refusedRecoveriesRef.current.filter((item) => item.id !== id);
    refusedRecoveriesRef.current = next;
    setRefusedRecoveries(next);
    setRefusedCopyState((previous) => (previous?.id === id ? null : previous));
  };
  /**
   * V20-02: the socket accepted these prompts but the host never acknowledged them,
   * and the view is going away. Without this they only exist in component state and
   * Back/reopen loses them. Promote them to the App-owned per-conversation list so the
   * refusal strip can still offer Copy/Recover. No auto-resend, ever.
   */
  const promoteUnconfirmedPending = (): void => {
    if (!onRefusedRecoveriesChange) return;
    // F3: promote EVERYTHING, including a refusal that arrived while the send
    // promise was still unresolved (sent=false but refusalMessage set): the late
    // resolution is generation-guarded and would drop it. Label by state.
    // recoverRefusedPrompt always removes the prompt after appending/restoring, so
    // a prompt cannot be appended twice.
    const pending = [...pendingPromptRef.current];
    for (const prompt of pending) appendRefusedRecovery(prompt.submitted, !prompt.refusalMessage);
    if (pending.length > 0) pendingPromptRef.current = [];
  };
  /** Live echoes have no sender identity; settle only one ordinal match and retain it for inspection. */
  const acknowledgeUnconfirmed = (text: string): void => {
    const item = refusedRecoveriesRef.current.find((entry) => entry.unconfirmed && entry.text === text);
    if (item) {
      const next = refusedRecoveriesRef.current.map((entry) => entry.id === item.id ? { ...entry, unconfirmed: false, echoed: true } : entry);
      refusedRecoveriesRef.current = next;
      setRefusedRecoveries(next);
      return;
    }
    const index = pendingPromptRef.current.findIndex((prompt) => prompt.submitted === text && !prompt.refusalMessage);
    if (index < 0) return;
    const prompt = pendingPromptRef.current[index]!;
    prompt.echoed = true;
    if (!prompt.sent) return;
    pendingPromptRef.current.splice(index, 1);
    if (prompt.optimisticId) setOptimisticMessages((previous) => previous.filter((message) => message.id !== prompt.optimisticId));
    appendRefusedRecovery(prompt.submitted);
    const next = refusedRecoveriesRef.current.map((entry) => entry.id === refusedIdRef.current ? { ...entry, echoed: true } : entry);
    refusedRecoveriesRef.current = next;
    setRefusedRecoveries(next);
  };
  const inputValueRef = useRef(draft);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const followTailRef = useRef(true);
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStreamFrameRef = useRef<Extract<HostFrame, { t: "event" }> | null>(null);
  const composingRef = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  /**
   * Model settings live in a sheet, not in the transcript.
   *
   * They used to be a collapsed `<details>` in the flow, which still cost a
   * permanent full-width row above the transcript on a phone — the single largest
   * piece of avoidable chrome after the duplicate status banner. The state is a
   * boolean now, opened from the overflow menu or the `/model` command, and the
   * sheet holds the same controls with the same draft semantics.
   */
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const socketRef = useRef<CollabSocket | null>(null);
  const pendingUiResponsesRef = useRef(new Map<number, object>());
  const [pendingUiResponseIds, setPendingUiResponseIds] = useState<Set<number>>(() => new Set());
  const sendingPromptTextsRef = useRef(new Map<string, object>());
  const pendingPromptRef = useRef<PendingPrompt[]>([]);
  const localIdRef = useRef(0);
  const sendGuardRef = useRef<{ id: number; text: string } | null>(null);
  /**
   * Handoff double-submit guard. `handoffBusy` state lags a tick behind the click,
   * so two clicks in the same tick would both issue a request; this ref is set
   * synchronously before the await.
   */
  const handoffInFlightRef = useRef(false);
  /** Same synchronous double-submit guard for "Stop OMP session". */
  const stopSessionInFlightRef = useRef(false);
  /** And for the restart offered beside a stopped session. */
  const restartInFlightRef = useRef(false);
  const sendVersionRef = useRef(0);
  const sendIdRef = useRef(0);
  const operationGenerationRef = useRef(0);
  const viewActiveRef = useRef(true);
  const connectionGenerationRef = useRef(0);
  /**
   * Physical connection identity, bumped on every socket open — including the
   * automatic reconnect of the same CollabSocket object. Minted-link generation
   * (connectionGenerationRef) is a separate concern: an unacked prompt from an
   * earlier physical connection must not consume a refusal meant for a newer one.
   */
  const physicalConnectionRef = useRef(0);
  /**
   * Saved-history mode generation (V21-03). Bumped on every transition out of or
   * into saved mode — leaving saved for live, a Retry that re-reads history, and a
   * conversation change. A paging or history response carries the generation it was
   * sent under and is dropped when it no longer matches, so a late page cannot
   * re-enter saved mode or repaint a stale snapshot over a live verdict. Separate
   * from `connectionGenerationRef`, which is minted-link identity: a restart that
   * fails to mint a link still leaves saved mode, and that must invalidate paging.
   */
  const historyModeGenerationRef = useRef(0);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const modelDraftRef = useRef(modelDraft);
  modelDraftRef.current = modelDraft;
  /**
   * True once the user has edited the model draft in this conversation. A late
   * initial/retry read may hydrate the server value only while the draft is still
   * untouched; a hydration must never clobber a value the user already chose
   * (V21-01). Reset per conversation, both as an edit flag and as the submitted
   * draft baseline for the restart completion.
   */
  const modelDraftTouchedRef = useRef(false);
  /**
   * V23-04: metadata generation. A conversation read captures this at request start
   * and applies its snapshot only while it still matches. A mutation that changes
   * conversation metadata (save model, restart) bumps it as it applies its
   * server-returned truth, so a read that began BEFORE that success cannot repaint
   * the pre-save value over it. Only successful mutations bump: a failed save lands
   * nothing, so a read in flight still applies. A read started after the mutation
   * completes takes the new generation and is applied normally.
   */
  const metadataGenerationRef = useRef(0);
  /**
   * V25-04: conversation-metadata read ordering, independent of the mutation
   * generation above. Every read of the conversation metadata takes the next number
   * and applies its snapshot only while it still holds the newest number, so two
   * overlapping reads (double Retry) cannot let the older response repaint the newer
   * one. The initial effect read and retryUnavailableConversation's read share it.
   */
  const metadataReadSeqRef = useRef(0);
  /**
   * V25-05: attach-instructions read ordering, same shape as the metadata read seq.
   * A successful restart re-reads the instructions (the tmux session changed); this
   * makes sure the pre-restart read — still in flight — cannot land after it and put
   * the dead session's command back on screen.
   */
  const attachReadSeqRef = useRef(0);
  const watchedTranscriptAgentRef = useRef<string | null>(null);
  const reqIdCounterRef = useRef(1);
  const transcriptRequestsRef = useRef(new Map<number, { agentId: string; fromByte: number; timer: ReturnType<typeof setTimeout> }>());
  const olderHistoryLoadingRef = useRef(false);
  /**
   * V24-01: mirrors `historyLoading` for the Load older guard, because the button's
   * click closure cannot see the state value set by the tail effect in the same tick.
   * A page requested during a tail read captured the pre-refresh cursor and merges
   * into the pre-refresh snapshot, so its completion would resurrect the tail the
   * fresh read just replaced. The tail read is this mode's authoritative snapshot,
   * so paging waits for it. Set alongside every `setHistoryLoading` — and only after
   * the generation check, so a superseded read never clears a newer read's flag.
   */
  const historyLoadingRef = useRef(false);
  const historyScrollAnchorRef = useRef<{ top: number; height: number } | null>(null);
  const fetchTranscriptRef = useRef<(agentId: string, fromByte: number) => void>(() => {});
  const rawUrlRef = useRef<string | null>(null);

  const streamingText = transcript.streamingMessage?.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("") ?? "";
  // V21-03: a positive "a writer is live" verdict from the history endpoint wins
  // over a saved snapshot. Belt-and-braces alongside the generation guards — a
  // stale page that somehow landed must not shadow the live fact and claim the
  // session is not running.
  //
  // F-B3: the transcript is only a claim when a CURRENT generation verifiably read
  // the journal (`archived`). A later fresh read that proves nothing (`unverified`,
  // e.g. not_found/internal) supersedes that claim — the rows may stay readable as
  // cached data, but they must not sit beside a hidden error or under a claim about
  // the session. So the unverified verdict keeps the rows and REPLACES the "not
  // running" banner with a hedge, surfacing the fresh error/Retry in the same view.
  // A `live` verdict proves nothing about a writer either; it keeps the card.
  const isShowingSavedHistory = linkUnavailable && savedHistory !== null && historyVerdict !== "live";
  const commandSuggestions = inputText.startsWith("/") && !/\s/.test(inputText)
    ? slashCommands.filter((command) => command.name.startsWith(inputText)).slice(0, 5)
    : [];
  const agents = transcript.agents;
  const transcripts = transcript.transcripts;
  const canManageConversation = conversation?.id === conversationId && conversation.ownership === "managed";
  const canWriteToHost = linkAccess === "full";
  useLayoutEffect(() => {
    viewActiveRef.current = true;
    operationGenerationRef.current++;
    // Handoff state belongs to one conversation: a notice or refusal from the
    // previous session must not appear beside a different transcript, and an
    // in-flight request must not block the new session's control.
    handoffInFlightRef.current = false;
    stopSessionInFlightRef.current = false;
    restartInFlightRef.current = false;
    setHandoffBusy(false);
    setHandoffNotice(null);
    setHandoffNoticeTone("running");
    setHandoffRefusal(null);
    // Without this the `draft_unconfirmed` override card outlives its
    // conversation: it renders on the code alone, and React reuses this instance
    // across a switch, so accepting A's risk would send `confirmDraftRisk: true`
    // to B.
    setHandoffRefusalCode(null);
    setHandoffConfirming(false);
    setStopSessionBusy(false);
    setStopSessionNotice(null);
    setStopSessionRefusal(null);
    setStopSessionConfirming(false);
    setRestartBusy(false);
    // Same class of leak: every other atom that is scoped to one conversation and
    // renders without a guard of its own.
    setInterceptedCommand(null);
    setIsDetached(false);
    setOptimisticMessages([]);
    setTranscriptErrors({});
    // The terminal pane being watched belongs to the conversation that requested
    // it; a late frame for the old agent must not be accepted for the new one.
    watchedTranscriptAgentRef.current = null;
    return () => {
      viewActiveRef.current = false;
      operationGenerationRef.current++;
    };
  }, [conversationId]);
  const loadingAgentIds = useMemo(() => [...new Set(Object.values(transcript.transcriptRequests).map((request) => request.agentId))], [transcript.transcriptRequests]);
  const activeUiRequest = transcript.uiRequests.current;
  const uiRequestQueue = transcript.uiRequests.queue;
  useEffect(() => {
    if (activeUiRequest?.kind === "editor") setUiEditorValue(activeUiRequest.prefill ?? "");
  }, [activeUiRequest?.reqId]);
  /**
   * Advisor notes for this conversation, read from the same rows the transcript
   * renders — so the panel and the chat card can never disagree about what was
   * said or how severe it was. Notes prove an advisor ran; nothing here infers
   * that one is enabled, because this transport does not report that.
   */
  const advisorSummary = useMemo(
    () => summarizeAdvisorNotes(transcript.messages.map((message) => ({ customType: message.customType, details: message.customDetails }))),
    [transcript.messages],
  );

  const messages: DisplayMessage[] = useMemo(() => {
    const hostCounts = new Map<string, number>();
    for (const message of transcript.messages) {
      if (message.role === "user") hostCounts.set(message.text, (hostCounts.get(message.text) ?? 0) + 1);
    }
    return [
      ...transcript.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        ...(message.blocks ? { blocks: message.blocks } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolResult ? { toolResult: message.toolResult } : {}),
        ...(message.toolArgs ? { toolArgs: message.toolArgs } : {}),
        // An advisor card needs its type + structured notes to render at all: the
        // flattened text alone loses the severity that decides how loudly the row
        // must appear.
        ...(message.customType ? { customType: message.customType } : {}),
        ...(message.customDetails === undefined ? {} : { customDetails: message.customDetails }),
        ...(message.isError ? { isError: true } : {}),
        ...(message.isRunning ? { isRunning: true } : {}),
      })),
      ...optimisticMessages.filter((pending) => (hostCounts.get(pending.text) ?? 0) <= (pending.hostEchoCount ?? 0)),
    ];
  }, [transcript.messages, optimisticMessages]);
  /**
   * Saved mode has exactly one transcript source (the journal). Prompts the host
   * never acknowledged would otherwise vanish, so they stay visible under the same
   * allowance rule, counted against the saved user rows instead of the live ones.
   */
  const savedModeOptimistic = useMemo(() => {
    if (!savedHistory) return [];
    const hostCounts = new Map<string, number>();
    for (const message of savedHistory.messages) {
      if (message.role === "user") hostCounts.set(message.text, (hostCounts.get(message.text) ?? 0) + 1);
    }
    return optimisticMessages.filter((pending) => (hostCounts.get(pending.text) ?? 0) <= (pending.hostEchoCount ?? 0));
  }, [savedHistory, optimisticMessages]);
  /**
   * Saved-mode rows in the shape `MessageRow` takes, built ONCE per journal read.
   *
   * The render used to build a fresh object literal per row on every parent
   * render, so `MessageRow`'s `memo` shallow-compare always missed and every
   * saved row re-rendered on any state change. Mapping here keeps the row objects
   * identical between renders (the live path already gets this from its useMemo).
   */
  const savedRows = useMemo<DisplayMessage[]>(() => savedHistory?.messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.blocks ? { blocks: message.blocks } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolResult ? { toolResult: message.toolResult } : {}),
    ...(message.toolArgs ? { toolArgs: message.toolArgs } : {}),
    // Saved history must render advisor cards exactly as the live view does.
    ...(message.customType ? { customType: message.customType } : {}),
    ...(message.customDetails === undefined ? {} : { customDetails: message.customDetails }),
    ...(message.isError ? { isError: true } : {}),
  })) ?? [], [savedHistory]);

  useEffect(() => {
    const hostCounts = new Map<string, number>();
    for (const message of transcript.messages) {
      if (message.role === "user") hostCounts.set(message.text, (hostCounts.get(message.text) ?? 0) + 1);
    }
    setOptimisticMessages((prev) => {
      const pending = prev.filter((message) => (hostCounts.get(message.text) ?? 0) <= (message.hostEchoCount ?? 0));
      return pending.length === prev.length ? prev : pending;
    });
  }, [transcript.messages]);

  const recoverRefusedPrompt = (prompt: PendingPrompt): void => {
    pendingPromptRef.current = pendingPromptRef.current.filter((pending) => pending !== prompt);
    if (prompt.optimisticId) setOptimisticMessages((previous) => previous.filter((message) => message.id !== prompt.optimisticId));
    if (sendVersionRef.current !== prompt.draftVersion) {
      // The user has typed newer content since sending: overwriting it would destroy
      // that work and dropping the refused prompt would lose it entirely. Append the
      // refused text behind an explicit affordance instead of the composer.
      appendRefusedRecovery(prompt.text);
      return;
    }
    inputValueRef.current = prompt.text;
    setInputText(prompt.text);
    onDraftChange?.(prompt.text);
  };
  /**
   * Bootstrap rows are historical baseline, never receipts for prompts sent while
   * the dump was in flight. Raise their echo allowance above the dump count; only
   * a genuine live echo can settle them. A prompt journaled before the dump cut and
   * present only in the dump stays uncertain until the user dismisses it. That is
   * the safe failure: false acknowledgment could silently lose an unsent prompt.
   */
  const rebasePendingAfterBootstrap = (liveFrames: readonly HostFrame[]): void => {
    const genuinelyEchoed = new Set<string>();
    for (const liveFrame of liveFrames) {
      const text = userEchoText(liveFrame);
      if (text !== null) genuinelyEchoed.add(text);
    }
    const hostCounts = new Map<string, number>();
    for (const message of transcriptRef.current.messages) {
      if (message.role === "user") hostCounts.set(message.text, (hostCounts.get(message.text) ?? 0) + 1);
    }
    const bumped = new Map<string, number>();
    const ordinalByText = new Map<string, number>();
    for (const prompt of pendingPromptRef.current) {
      if (!prompt.preSnapshot) continue;
      if (genuinelyEchoed.has(prompt.submitted)) continue;
      // V20-01: two same-text sends must not share one baseline. The dump raises the
      // baseline for every pending of that text, so a single echo would settle both.
      // Each pending keeps its own ordinal ABOVE the baseline — the same count of
      // same-text local sends sendPrompt already used — so one echo settles exactly one.
      const ordinal = ordinalByText.get(prompt.submitted) ?? 0;
      ordinalByText.set(prompt.submitted, ordinal + 1);
      prompt.hostEchoCount = Math.max(prompt.hostEchoCount, (hostCounts.get(prompt.submitted) ?? 0) + ordinal);
      if (prompt.optimisticId) bumped.set(prompt.optimisticId, prompt.hostEchoCount);
    }
    if (bumped.size === 0) return;
    setOptimisticMessages((previous) => previous.map((message) => bumped.has(message.id) ? { ...message, hostEchoCount: bumped.get(message.id)! } : message));
  };

  const updateTranscript = (frame: HostFrame): void => {
    const next = reduceHostFrame(transcriptRef.current, frame);
    transcriptRef.current = next;
    setTranscript(next);
    setStatus(next.connectionStatus === "live" ? next.turnStatus : next.connectionStatus);
    if (frame.t === "welcome") {
      sendGuardRef.current = null;
      setEffectiveModel({ conversationId, model: frame.state.model?.id ?? null });
    }
    if (frame.t === "state" && frame.state.model) setEffectiveModel({ conversationId, model: frame.state.model.id });
    if ((frame.t === "welcome" || frame.t === "state") && next.error === null) setSendError(null);
  };

  const flushPendingStream = (expectedConnection?: number): void => {
    if (expectedConnection !== undefined && physicalConnectionRef.current !== expectedConnection) return;
    if (renderTimerRef.current !== null) clearTimeout(renderTimerRef.current);
    renderTimerRef.current = null;
    const frame = pendingStreamFrameRef.current;
    pendingStreamFrameRef.current = null;
    if (frame) updateTranscript(frame);
  };

  const handleHostFrameRef = useRef<(frame: HostFrame) => void>(() => {});
  handleHostFrameRef.current = (frame) => {
    if (frame.t === "event" && frame.event.type === "message_update" && frame.event.message.role === "assistant") {
      pendingStreamFrameRef.current = frame;
      if (renderTimerRef.current === null) {
        const connection = physicalConnectionRef.current;
        renderTimerRef.current = setTimeout(() => flushPendingStream(connection), 100);
      }
      return;
    }
    flushPendingStream(physicalConnectionRef.current);
    if (frame.t === "ui-request-end") {
      const requests = transcriptRef.current.uiRequests;
      if (requests.current?.reqId !== frame.reqId && !requests.queue.some((request) => request.reqId === frame.reqId)) return;
      pendingUiResponsesRef.current.delete(frame.reqId);
      setPendingUiResponseIds((previous) => { const next = new Set(previous); next.delete(frame.reqId); return next; });
    }
    const hadPendingSnapshot = transcriptRef.current.pendingSnapshot !== null;
    // The queued live frames are gone once the completing snapshot is reduced, so
    // capture them first: a pre-snapshot prompt whose echo arrived live was already
    // applied by the replay below and must not be rebased into unacknowledgeable.
    const liveFrames = transcriptRef.current.pendingSnapshot?.live ?? [];
    updateTranscript(frame);
    if (hadPendingSnapshot && transcriptRef.current.pendingSnapshot === null) rebasePendingAfterBootstrap(liveFrames);
    // V20-02: only genuine live user echoes acknowledge an unconfirmed strip item —
    // never the snapshot rows above, which are history.
    for (const echo of hadPendingSnapshot ? liveFrames : [frame]) {
      const text = userEchoText(echo);
      if (text !== null) acknowledgeUnconfirmed(text);
    }
    if (frame.t === "error") {
      if (NON_SUBMISSION_REFUSALS.has(frame.message)) {
        const pendingOnConn = pendingPromptRef.current.filter((pending) => pending.physicalConnection === physicalConnectionRef.current && !pending.refusalMessage && !pending.echoed);
        if (pendingOnConn.length === 1) {
          const prompt = pendingOnConn[0]!;
          prompt.refusalMessage = frame.message;
          if (prompt.sent) recoverRefusedPrompt(prompt);
        }
      }
      setSendError(frame.message);
    }
    if (frame.t === "bye") {
      if (NON_SUBMISSION_REFUSALS.has(frame.reason)) {
        const pendingOnConn = pendingPromptRef.current.filter((pending) => pending.physicalConnection === physicalConnectionRef.current && !pending.refusalMessage && !pending.echoed);
        if (pendingOnConn.length === 1) {
          const prompt = pendingOnConn[0]!;
          prompt.refusalMessage = frame.reason;
          if (prompt.sent) recoverRefusedPrompt(prompt);
        }
      }
      setSendError(frame.reason);
    }
    if (frame.t === "transcript") {
      const request = transcriptRequestsRef.current.get(frame.reqId);
      if (request) {
        clearTimeout(request.timer);
        transcriptRequestsRef.current.delete(frame.reqId);
        if (request.agentId === watchedTranscriptAgentRef.current) {
          setTranscriptErrors((prev) => {
            const next = { ...prev };
            if (frame.error) next[request.agentId] = frame.error;
            else delete next[request.agentId];
            return next;
          });
          if (!frame.error && frame.text === "" && frame.newSize < request.fromByte) {
            fetchTranscriptRef.current(request.agentId, 0);
          }
        }
      }
    }
  };

  const updateTailLock = useCallback(() => {
    const element = messagesScrollRef.current;
    if (!element) return;
    const nearTail = element.scrollHeight - element.clientHeight - element.scrollTop <= TAIL_THRESHOLD_PX;
    followTailRef.current = nearTail;
    setIsDetached((previous) => previous === !nearTail ? previous : !nearTail);
  }, []);

  useLayoutEffect(() => {
    const element = messagesScrollRef.current;
    if (element && followTailRef.current) element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  }, [messages, streamingText]);
  useLayoutEffect(() => {
    const anchor = historyScrollAnchorRef.current;
    const element = messagesScrollRef.current;
    if (!anchor || !element) return;
    element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
    historyScrollAnchorRef.current = null;
  }, [savedHistory]);

  useEffect(() => {
    const element = messagesScrollRef.current;
    const content = messagesContentRef.current;
    if (!element || !content) return;
    element.addEventListener("scroll", updateTailLock, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (followTailRef.current) element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    });
    observer?.observe(element);
    observer?.observe(content);
    return () => {
      element.removeEventListener("scroll", updateTailLock);
      observer?.disconnect();
    };
  }, [updateTailLock]);

  useEffect(() => () => {
    if (renderTimerRef.current !== null) clearTimeout(renderTimerRef.current);
    for (const request of transcriptRequestsRef.current.values()) clearTimeout(request.timer);
    transcriptRequestsRef.current.clear();
    // V20-02: promote BEFORE the socket closes so an unacknowledged prompt survives
    // Back/reopen in the App-owned list instead of dying with this component.
    promoteUnconfirmedPending();
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  useLayoutEffect(() => autosizeComposer(composerRef.current), [inputText]);
  useEffect(() => {
    inputValueRef.current = draft;
    setInputText(draft);
  }, [draft]);

  const goToLatest = (): void => {
    const element = messagesScrollRef.current;
    if (!element) return;
    followTailRef.current = true;
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    setIsDetached(false);
  };


  useEffect(() => {
    transcriptRef.current = createTranscriptState();
    setTranscript(transcriptRef.current);
    setConversation(null);
    setEffectiveModel(null);
    setLinkUnavailable(false);
    setViewAccessOffer(null);
    setLinkFailure(null);
    setSavedHistory(null);
    setHistoryVerdict("unverified");
    setHistoryLoading(false);
    historyLoadingRef.current = false;
    setOlderHistoryLoading(false);
    olderHistoryLoadingRef.current = false;
    setHistoryError(null);
    setOlderHistoryError(null);
    // V21-03: a new conversation is a new saved-history mode. Any page or history
    // read still in flight for the previous one must not land here.
    historyModeGenerationRef.current += 1;
    historyScrollAnchorRef.current = null;

    sendVersionRef.current++;
    pendingPromptRef.current = [];
    setSendError(null);
    // An App-owned list belongs to the conversation key it was stored under, so it
    // survives Back/reopen. Only the per-mount fallback is dropped here.
    if (!refusedRecoveriesProp) {
      refusedRecoveriesRef.current = [];
      setInternalRefusedRecoveries([]);
    }
    setRefusedCopyState(null);
    sendingPromptTextsRef.current.clear();
    // This conversation's model draft starts untouched again: the initial read may
    // hydrate the server preference until the user edits the control (V21-01).
    modelDraftTouchedRef.current = false;
    // V23-04: a new conversation is a new metadata generation, so a read still in
    // flight for the previous one can never repaint this one's metadata.
    metadataGenerationRef.current += 1;
    // V25-04: read/read has no ordering. Two metadata reads can overlap (a Retry
    // started, then another — the first is slow), and both pass the generation guard
    // because nothing mutated in between, so the older response repaints the newer
    // result. A monotonic read sequence fixes that: each read takes the next number
    // and only the newest read may apply. Mutations still use metadataGenerationRef;
    // the two guards are independent (a mutation must invalidate an in-flight read,
    // a newer read must supersede an older one).
    const metadataRead = ++metadataReadSeqRef.current;
    const attachRead = ++attachReadSeqRef.current;
    const currentId = conversationId;
    const metadataGeneration = metadataGenerationRef.current;
    api.getConversation(conversationId).then((res) => {
      // An initial read that lands after the user picked a model must not overwrite
      // that choice with the stale saved preference. V23-04: it must also not repaint
      // metadata a successful mutation already replaced — the generation is captured
      // here and a mutation that lands mid-fetch invalidates this snapshot.
      if (conversationIdRef.current === currentId && metadataGenerationRef.current === metadataGeneration && metadataReadSeqRef.current === metadataRead && res.ok) {
        setConversation(res.data);
        if (!modelDraftTouchedRef.current) setModelDraft(res.data.modelPreference ?? res.data.model ?? "");
      }
    });
    api.getAttachInstructions(conversationId).then((res) => {
      // V25-05: only the newest attach read may publish, so the pre-restart fetch
      // (or a previous conversation's) cannot overwrite a post-restart command.
      if (conversationIdRef.current === currentId && attachReadSeqRef.current === attachRead && res.ok) setAttachInfo(res.data);
    });
  }, [conversationId]);
  useEffect(() => {
    if (!linkUnavailable) return;
    let active = true;
    // V21-03: this read belongs to the saved-history mode generation it started in.
    // A Retry re-runs the effect and takes a new generation, so an earlier read's
    // verdict can no longer re-enter saved mode or clear a newer live verdict.
    const generation = ++historyModeGenerationRef.current;
    setHistoryLoading(true);
    historyLoadingRef.current = true;
    setHistoryError(null);
    // A new mode read supersedes any page from the previous one: its completion is
    // dropped by the generation check, so this mode must not inherit its in-flight
    // flag and refuse Load older.
    setOlderHistoryLoading(false);
    setOlderHistoryError(null);
    olderHistoryLoadingRef.current = false;
    void api.getConversationHistory(conversationId).then((result) => {
      if (!active || historyModeGenerationRef.current !== generation) return;
      setHistoryLoading(false);
      historyLoadingRef.current = false;
      if (result.ok) {
        setHistoryError(null);
        // F1: ok and conflict_owner are mutually exclusive verdicts of the same read,
        // so a good read must clear a verdict a previous one left stuck. Only a
        // current generation reaches here, so a stale read cannot clear a newer one.
        setHistoryVerdict("archived");
        setSavedHistory({ ...result.data, messages: transcriptMessagesFromEntries(result.data.entries as unknown as SessionEntry[]) });
      } else if (result.error.code === "conflict_owner") {
        // V22-01: a writer is live OR its status cannot be verified. Record it as a
        // hedged `live` claim (the copy says so) rather than a stale `archived`.
        setHistoryVerdict("live");
      } else {
        // V22-01: not_found/internal/path_forbidden (and anything else) prove nothing
        // about the host, but they DO supersede the previous verdict — a fresh read
        // must clear a stale live claim instead of leaving it on screen.
        setHistoryVerdict("unverified");
        setHistoryError(result.error.code === "not_found" ? null : result.error.message || "Could not load saved transcript.");
      }
    }).catch((error: unknown) => {
      if (!active || historyModeGenerationRef.current !== generation) return;
      setHistoryLoading(false);
      historyLoadingRef.current = false;
      setHistoryVerdict("unverified");
      setHistoryError(error instanceof Error ? error.message : "Could not load saved transcript.");
    });
    return () => { active = false; };
  }, [conversationId, linkUnavailable, historyRetryEpoch]);
  const loadOlderHistory = async () => {
    const current = savedHistory;
    // V24-01: refuse while a tail read is pending (see historyLoadingRef).
    if (!current?.hasOlder || !current.nextCursor || olderHistoryLoadingRef.current || historyLoadingRef.current) return;
    olderHistoryLoadingRef.current = true;
    setOlderHistoryLoading(true);
    setOlderHistoryError(null);
    const conversationAtRequest = conversationIdRef.current;
    // V21-03: a page belongs to the mode it was requested in. Restart, reconnect or
    // a conversation change moves the generation, and the page is then dropped whole
    // rather than re-entering saved mode or writing loading/error/anchor state.
    const generationAtRequest = historyModeGenerationRef.current;
    const scroll = messagesScrollRef.current;
    if (scroll) historyScrollAnchorRef.current = { top: scroll.scrollTop, height: scroll.scrollHeight };
    const result = await api.getConversationHistory(conversationAtRequest, current.nextCursor);
    if (conversationIdRef.current !== conversationAtRequest || historyModeGenerationRef.current !== generationAtRequest) {
      // V21-03: the mode moved while this page was in flight — restart, reconnect or
      // a conversation change. Drop it whole: no savedHistory, no loading/error, no
      // scroll anchor. The transition itself cleared the loading flags, so a newer
      // page's own flag is never disturbed by this late completion.
      return;
    }
    olderHistoryLoadingRef.current = false;
    setOlderHistoryLoading(false);
    if (!result.ok) {
      historyScrollAnchorRef.current = null;
      setOlderHistoryError(result.error.message || "Could not load older history.");
      // V24-03: a page read that reports conflict_owner proves a live-or-unverifiable
      // writer for this generation, so it supersedes the archived "not running" claim
      // even though the tail read (the newer snapshot) never ran. `unverified`, not
      // `live`: the hedged banner is the same honest copy, and unlike `live` it keeps
      // the cached rows readable beside the page error (a `live` verdict hides them).
      // Other page errors (not_found/internal/network) prove nothing about the host,
      // so they must not touch the verdict.
      if (result.error.code === "conflict_owner") setHistoryVerdict("unverified");
      return;
    }
    const seenMessages = new Set<string>();
    const messages = [...transcriptMessagesFromEntries(result.data.entries as unknown as SessionEntry[]), ...current.messages].filter((message) => {
      if (seenMessages.has(message.id)) return false;
      seenMessages.add(message.id);
      return true;
    });
    const seenEntries = new Set<string>();
    const entries = [...result.data.entries, ...current.entries].filter((entry) => {
      const id = typeof entry.id === "string" ? entry.id : JSON.stringify(entry);
      if (seenEntries.has(id)) return false;
      seenEntries.add(id);
      return true;
    });
    setSavedHistory({
      ...current,
      entries,
      messages,
      truncated: current.truncated || result.data.truncated,
      truncatedByBytes: current.truncatedByBytes || result.data.truncatedByBytes,
      truncatedByEntries: current.truncatedByEntries || result.data.truncatedByEntries,
      skippedOversized: current.skippedOversized || result.data.skippedOversized,
      hasOlder: result.data.hasOlder,
      nextCursor: result.data.nextCursor,
    });
  };
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => api.getModels()).then((result) => {
      if (!active) return;
      if (!result.ok) setModelCatalogState({ status: "error", message: result.error.message });
      else if (result.data.source === "unavailable") setModelCatalogState({ status: "unavailable", reason: result.data.reason ?? "Model catalog unavailable." });
      else if (result.data.models.length === 0) setModelCatalogState({ status: "empty" });
      else setModelCatalogState({ status: "loaded", models: result.data.models });
    }).catch((error: unknown) => {
      if (active) setModelCatalogState({ status: "error", message: error instanceof Error ? error.message : "Could not load model catalog." });
    });
    return () => { active = false; };
  }, []);

  const connectToCollab = useCallback(async (retryStale = true, access: "control" | "view" = "control") => {
    if (!viewActiveRef.current) return;
    const generation = ++connectionGenerationRef.current;
    const isCurrent = () => viewActiveRef.current && connectionGenerationRef.current === generation && conversationIdRef.current === conversationId;
    setRoomRetired(false);
    setEffectiveModel(null);
    setLinkAccess(null);
    socketRef.current?.close();
    socketRef.current = null;
    const linkRes = await api.getConversationLink(conversationId, access);
    if (!isCurrent()) return;
    if (!linkRes.ok) {
      if (linkRes.error.code === "link_unavailable") {
        setLinkUnavailable(true);
        setStatus("unknown");
        transcriptRef.current = setConnectionStatus(transcriptRef.current, "unknown");
        setTranscript(transcriptRef.current);
        return;
      }
      if (linkRes.error.code === "capability_missing" && access === "control") {
        setLinkUnavailable(false);
        setViewAccessOffer(linkRes.error.message);
        setLinkFailure(null);
        setStatus("unknown");
        return;
      }
      if (linkRes.error.code === "capability_missing") setLinkFailure(`Host access refused: ${linkRes.error.message}`);
      if (linkRes.error.code === "stale_generation" && retryStale) {
        void connectToCollab(false, access);
        return;
      }
      setViewAccessOffer(null);
      setStatus("disconnected");
      return;
    }
    setViewAccessOffer(null);
    setLinkFailure(null);
    if (linkRes.data.access !== (access === "control" ? "full" : "view")) {
      setLinkFailure(`Host access refused: requested ${access}, host returned ${linkRes.data.access}.`);
      setStatus("disconnected");
      return;
    }
    setLinkAccess(linkRes.data.access);

    setLinkUnavailable(false);
    // V21-03: leaving saved mode invalidates any page still in flight. Without this
    // a late saved page would re-enter saved mode over the live session we just got.
    historyModeGenerationRef.current += 1;
    historyScrollAnchorRef.current = null;
    setSavedHistory(null);
    setHistoryVerdict("unverified");
    rawUrlRef.current = linkRes.data.url;
    const parsed = parseCollabLink(rawUrlRef.current);
    if ("error" in parsed) {
      setStatus("disconnected");
      return;
    }
    try {
      const { key } = await importRoomKey(parsed.key);
      const writeToken = parsed.writeToken;
      if (!isCurrent()) return;
      const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
      socket.onOpen = () => {
        clearTimeout(renderTimerRef.current ?? undefined);
        physicalConnectionRef.current++;
        // host.ts:836-841 replays unanswered requests after welcome; its IDs are never reused.
        pendingUiResponsesRef.current.clear();
        setPendingUiResponseIds(new Set());
        setStatus("connecting");
        void socket.send({ t: "hello", proto: 3, name: "Mobile Web Controller", ...(writeToken ? { writeToken: encodeBase64Url(writeToken) } : {}) });
      };
      socket.onFrame = (frame) => {
        if (isCurrent() && socketRef.current === socket) handleHostFrameRef.current(frame);
      };
      socket.onClose = (_reason, willReconnect, roomRetired) => {
        if (!isCurrent() || socketRef.current !== socket) return;
        const connection = willReconnect ? "reconnecting" : "disconnected";
        setRoomRetired(roomRetired === true);
        setStatus(connection);
        transcriptRef.current = setConnectionStatus(transcriptRef.current, connection);
        setTranscript(transcriptRef.current);
      };
      socketRef.current = socket;
      socket.connect();
    } catch {
      if (isCurrent()) setStatus("disconnected");
    }
  }, [conversationId]);

  useEffect(() => {
    void connectToCollab(true);
    return () => {
      connectionGenerationRef.current++;
      // V20-02: a pending prompt whose socket was accepted but never acknowledged
      // must not vanish when this conversation's live link is torn down.
      promoteUnconfirmedPending();
      socketRef.current?.close();
      socketRef.current = null;
      rawUrlRef.current = null;
    };
  }, [connectToCollab]);


  const retryUnavailableConversation = async (): Promise<void> => {
    const currentId = conversationIdRef.current;
    // V23-04: capture the metadata generation BEFORE the read. If a model save or
    // restart succeeds while this is in flight, that mutation bumps the generation
    // and this stale snapshot is dropped instead of rewinding the saved model.
    const metadataGeneration = metadataGenerationRef.current;
    // V25-04: this read is ordered against every other conversation-metadata read.
    // Two Retry clicks overlap; the second is newer and must win, so the first
    // captures a lower number and its late response is dropped by the check below.
    const metadataRead = ++metadataReadSeqRef.current;
    const result = await api.getConversation(currentId);
    if (conversationIdRef.current !== currentId) return;
    if (result.ok && metadataGenerationRef.current === metadataGeneration && metadataReadSeqRef.current === metadataRead) {
      setConversation(result.data);
      if (!modelDraftTouchedRef.current) setModelDraft(result.data.modelPreference ?? result.data.model ?? "");
    }
    // V25-04: a superseded Retry must not re-establish the connection either — the
    // newer Retry does that itself, and this call would race it with a link minted
    // from a stale read. Only the newest read proceeds to connect and to re-run the
    // saved-history read.
    if (metadataReadSeqRef.current !== metadataRead) return;
    await connectToCollab(true);
    // The live link may still be down; re-run the saved-history read so a
    // recovered endpoint is picked up without waiting for linkUnavailable to flip.
    if (conversationIdRef.current === currentId) setHistoryRetryEpoch((epoch) => epoch + 1);
  };
  const sendPrompt = (text: string, allowSlashCommand = false): void => {
    const trimmed = text.trim();
    const socket = socketRef.current;
    if (!trimmed || !socket || (status !== "idle" && status !== "running")) return;
    if (transcriptRef.current.readOnly) {
      setSendError("Read-only view — prompt was not sent.");
      return;
    }
    const command = findSlashCommand(trimmed);
    if (command && !allowSlashCommand) {
      setInterceptedCommand(command);
      return;
    }
    if (sendingPromptTextsRef.current.has(trimmed)) return;
    const sendId = ++sendIdRef.current;
    const draftVersion = sendVersionRef.current;
    const conversationAtSend = conversationIdRef.current;
    const operationGeneration = operationGenerationRef.current;
    const connectionGeneration = connectionGenerationRef.current;
    const physicalConnection = physicalConnectionRef.current;
    const sendToken = { id: sendId, text: trimmed };
    const hostEchoCount = transcript.messages.filter((message) => message.role === "user" && message.text === trimmed).length;
    const echoAllowance = hostEchoCount + optimisticMessages.filter((message) => message.text === trimmed && hostEchoCount <= (message.hostEchoCount ?? 0)).length;
    const submitted = allowSlashCommand ? text : trimmed;
    const pendingPrompt: PendingPrompt = {
      text,
      submitted,
      hostEchoCount: echoAllowance,
      optimisticId: null,
      sent: false,
      refusalMessage: undefined,
      draftVersion,
      physicalConnection,
      preSnapshot: transcriptRef.current.pendingSnapshot !== null,
      token: sendToken,
    };
    pendingPromptRef.current.push(pendingPrompt);
    sendingPromptTextsRef.current.set(trimmed, sendToken);
    sendGuardRef.current = sendToken;
    setSendError(null);
    const startedRunning = status === "running";
    void socket.send({ t: "prompt", text: submitted }).then((sent) => {
      if (sendingPromptTextsRef.current.get(trimmed) === sendToken) sendingPromptTextsRef.current.delete(trimmed);
      if (!sent) pendingPromptRef.current = pendingPromptRef.current.filter((prompt) => prompt.token !== sendToken);
      if (!viewActiveRef.current || operationGenerationRef.current !== operationGeneration || connectionGenerationRef.current !== connectionGeneration || conversationIdRef.current !== conversationAtSend) return;
      if (sendGuardRef.current === sendToken) sendGuardRef.current = null;
      if (sent) {
        pendingPrompt.sent = true;
        if (pendingPrompt.echoed) {
          pendingPromptRef.current = pendingPromptRef.current.filter((prompt) => prompt !== pendingPrompt);
          appendRefusedRecovery(pendingPrompt.submitted);
          pendingPrompt.optimisticId = null;
          return;
        }
        const optimisticId = `user-${++localIdRef.current}`;
        pendingPrompt.sent = true;
        pendingPrompt.optimisticId = optimisticId;
        setOptimisticMessages((prev) => [...prev, {
          id: optimisticId,
          role: "user",
          text: submitted,
          awaitingHost: startedRunning,
          hostEchoCount: echoAllowance,
        }]);
        setSendError("Sent to socket; host receipt is unconfirmed until conversation echo arrives.");
        if (sendVersionRef.current === draftVersion && inputValueRef.current === text) {
          inputValueRef.current = "";
          setInputText("");
          onDraftChange?.("");
        }
        if (pendingPrompt.refusalMessage) {
          setSendError(pendingPrompt.refusalMessage);
          recoverRefusedPrompt(pendingPrompt);
        }
        return;
      }
      setSendError("Socket did not accept prompt. Draft kept; retry when connected.");
    });
  };
  const handleSendPrompt = (event: React.FormEvent): void => {
    event.preventDefault();
    sendPrompt(inputValueRef.current);
  };

  const updateDraft = (value: string): void => {
    sendVersionRef.current++;
    inputValueRef.current = value;
    setInputText(value);
    sendGuardRef.current = null;
    setSendError(null);
    setInterceptedCommand(null);
    onDraftChange?.(value);
  };
  const sendSlashAsText = (): void => sendPrompt(inputValueRef.current, true);

  /**
   * Explicit recovery never overwrites a newer draft. Merge refused text into that
   * draft and keep its strip entry until a later send/explicit dismissal.
   */
  const recoverRefusedPromptText = (item: RefusedRecovery): void => {
    const currentDraft = inputValueRef.current;
    if (item.recoveredText === item.text) {
      if (("\n" + currentDraft + "\n").includes("\n" + item.text + "\n")) return;
      const updated = refusedRecoveriesRef.current.map((recovery) => recovery.id === item.id ? { ...recovery, recoveredText: undefined } : recovery);
      refusedRecoveriesRef.current = updated;
      setRefusedRecoveries(updated);
    }
    if (currentDraft.trim() && currentDraft !== item.text) {
      updateDraft(`${currentDraft}\n\n${item.text}`);
      const updated = refusedRecoveriesRef.current.map((recovery) => recovery.id === item.id ? { ...recovery, recoveredText: item.text } : recovery);
      refusedRecoveriesRef.current = updated;
      setRefusedRecoveries(updated);
      composerRef.current?.focus();
      return;
    }
    updateDraft(item.text);
    const updated = refusedRecoveriesRef.current.map((recovery) => recovery.id === item.id ? { ...recovery, recoveredText: item.text } : recovery);
    refusedRecoveriesRef.current = updated;
    setRefusedRecoveries(updated);
    removeRefusedRecovery(item.id);
    composerRef.current?.focus();
  };
  // Same clipboard contract as the code-block copy control: report failure rather
  // than silently doing nothing when the browser exposes no clipboard.
  const copyRefusedPromptText = async (item: RefusedRecovery): Promise<void> => {
    const copyConversationId = conversationIdRef.current;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(item.text);
      if (conversationIdRef.current === copyConversationId) setRefusedCopyState({ id: item.id, state: "copied" });
    } catch {
      if (conversationIdRef.current === copyConversationId) setRefusedCopyState({ id: item.id, state: "failed" });
    }
  };

  /**
   * A conversation that is not this app's managed pane has nothing to hand off, so
   * the control is rendered disabled (never hidden) with `handoffReason` beside it:
   * the user learns why, instead of finding a missing action.
   */
  const handoffOffered = conversation !== null && conversation.id === conversationId;
  const openCommandAction = (): void => {
    setInterceptedCommand(null);
    setModelSheetOpen(true);
    // The sheet's input is focused by its own effect once mounted; scrolling is
    // handled by the overlay, which is anchored to the viewport rather than to
    // the transcript the user may have scrolled far from.
  };

  /**
   * Why `/handoff` cannot be offered right now, or `null` when it can.
   *
   * The server refuses on its own preconditions (ownership, verified pane,
   * idleness); these are the ones the client already knows, so the affordance is
   * disabled with the reason instead of being offered and then failing.
   */
  const handoffReason = conversation === null || conversation.id !== conversationId
    ? "Conversation details are still loading."
    : conversation.ownership !== "managed"
      ? "Handoff requires a session this app manages."
      : linkUnavailable
        ? "No live host is sharing this conversation."
        : transcript.readOnly || linkAccess === "view"
          ? "Handoff needs a writable link; this connection is view-only."
          : !canWriteToHost
            ? "Waiting for write access to the live session."
            : null;

  /**
   * What a "Stop OMP session" would interrupt right now, or `null` when nothing is
   * in flight. The list is the confirmation's substance — the user must be told
   * exactly which work is being cut short, not merely asked "are you sure?".
   */
  const interruptedWork = [
    status === "running" ? "the turn that is generating now" : null,
    activeUiRequest !== undefined && activeUiRequest !== null ? "an approval request waiting on you" : null,
    agents.filter((agent) => agent.kind === "sub" && agent.status === "running").length > 0
      ? `running subagents (${agents.filter((agent) => agent.kind === "sub" && agent.status === "running").length})`
      : null,
  ].filter((entry): entry is string => entry !== null);

  /**
   * Why "Stop OMP session" cannot be offered, or `null` when it can.
   *
   * An external session is never stoppable: it is not this app's process to end,
   * so the action is disabled rather than offered and refused (the server refuses
   * too, but the UI must not pretend the choice exists).
   */
  const stopSessionReason = conversation === null || conversation.id !== conversationId
    ? "Conversation details are still loading."
    : conversation.ownership !== "managed"
      ? "This session is externally managed, so this app cannot stop it; stop it in its own terminal."
      : !conversation.tmuxSessionId || !conversation.tmuxServerIdentity
        ? "No verified managed tmux session is recorded for this conversation."
        : conversation.state === "stopping"
          ? "A stop is already in progress for this conversation."
          : conversation.state === "stopped"
            ? "This session's process is already stopped; restart it to bring it back."
            : null;

  /**
   * An externally managed session is not this app's process to end, so the control
   * is not offered at all: the server would refuse, and offering a dead choice is
   * worse than naming the absence.
   */
  const stopSessionOffered = conversation !== null && conversation.id === conversationId && conversation.ownership === "managed";
  const runStopSession = async (): Promise<void> => {
    if (stopSessionInFlightRef.current || stopSessionReason !== null) return;
    stopSessionInFlightRef.current = true;
    const operationGeneration = operationGenerationRef.current;
    const conversationAtStop = conversationIdRef.current;
    setStopSessionBusy(true);
    setStopSessionNotice(null);
    setStopSessionRefusal(null);
    const result = await api.stopConversation(conversationAtStop).finally(() => { stopSessionInFlightRef.current = false; });
    if (!viewActiveRef.current || operationGenerationRef.current !== operationGeneration || conversationIdRef.current !== conversationAtStop) return;
    setStopSessionBusy(false);
    if (result.ok) {
      metadataGenerationRef.current += 1;
      setConversation(result.data);
      setStopSessionConfirming(false);
      // The supervisor reports `stopping` while it waits for the process to exit;
      // claiming "stopped" there would be a promise the machine has not made yet.
      setStopSessionNotice(result.data.state === "stopping"
        ? "Stop requested. The process has not exited yet; history and the native session are preserved."
        : "Session stopped. History and the native session are preserved.");
      return;
    }
    // The server distinguishes an ownership refusal from a plain failure; both
    // carry a precise message, so it is shown as-is rather than summarized.
    setStopSessionRefusal(result.error.code === "agent_not_running"
      ? `Not safe to stop: ${result.error.message}`
      : result.error.message);
  };

  /**
   * Bring the stopped session back. Deliberately the same call the project's
   * session list makes, so the guards (ownership, verified identity, recorded
   * journal) are the server's, not a second set invented here.
   */
  const runRestartAfterStop = async (): Promise<void> => {
    if (restartInFlightRef.current) return;
    restartInFlightRef.current = true;
    const operationGeneration = operationGenerationRef.current;
    const conversationAtRestart = conversationIdRef.current;
    setRestartBusy(true);
    const result = await api.restartConversation(conversationAtRestart).finally(() => { restartInFlightRef.current = false; });
    if (!viewActiveRef.current || operationGenerationRef.current !== operationGeneration || conversationIdRef.current !== conversationAtRestart) return;
    setRestartBusy(false);
    if (result.ok) {
      metadataGenerationRef.current += 1;
      setConversation(result.data);
      setStopSessionNotice("Session restarted with its recorded history.");
      return;
    }
    setStopSessionRefusal(result.error.code === "conflict_owner"
      ? `Could not restart: ${result.error.message}`
      : result.error.message);
  };

  const runHandoff = async (confirmDraftRisk = false): Promise<void> => {
    // One request at a time, and never from a state the server would refuse. The
    // ref is the real guard: two clicks in the same tick both see `handoffBusy`
    // false, because the state update has not been committed yet.
    if (handoffInFlightRef.current || handoffReason !== null) return;
    handoffInFlightRef.current = true;
    const operationGeneration = operationGenerationRef.current;
    const conversationAtHandoff = conversationIdRef.current;
    setHandoffBusy(true);
    setHandoffNotice(null);
    setHandoffRefusal(null);
    setHandoffRefusalCode(null);
    // The unsent draft is deliberately untouched by this action: it is not a send.
    const result = await api.requestHandoff(conversationAtHandoff, confirmDraftRisk).finally(() => { handoffInFlightRef.current = false; });
    if (!viewActiveRef.current || operationGenerationRef.current !== operationGeneration || conversationIdRef.current !== conversationAtHandoff) return;
    setHandoffBusy(false);
    if (result.ok) {
      setInterceptedCommand(null);
      // Three outcomes, never collapsed into one. `delivered` only proves the
      // keystrokes reached the pane. `refused` is positive evidence the agent
      // itself declined, so a retry is meaningful immediately. `committed` is the
      // journal proof. Never claim a compaction the journal has not recorded.
      setHandoffNoticeTone(result.data.state === "delivered" && result.data.refused === true ? "warning" : "running");
      setHandoffNotice(result.data.state === "committed"
        ? `Handoff committed — the journal records the compaction${result.data.compactionEntryId ? ` (${result.data.compactionEntryId})` : ""}.`
        : result.data.refused === true
          ? "Handoff refused — the agent declined it (nothing to hand off). Nothing was compacted; you can run it again once there is context to compact."
          : "Handoff delivered — OMP may still be generating; the transcript will show the compression when it commits.");
      return;
    }
    setHandoffRefusalCode(result.error.code);
    setHandoffRefusal(handoffRefusalText(result.error.code, result.error.message));
  };

  const handleUiResponse = (value: string | undefined, reqId?: number): void => {
    const targetReqId = reqId ?? transcriptRef.current.uiRequests.current?.reqId;
    if (transcriptRef.current.readOnly || targetReqId === undefined || !socketRef.current || pendingUiResponsesRef.current.has(targetReqId)) return;
    const requests = transcriptRef.current.uiRequests;
    if (requests.current?.reqId !== targetReqId && !requests.queue.some((request) => request.reqId === targetReqId)) return;
    const responseToken = {};
    pendingUiResponsesRef.current.set(targetReqId, responseToken);
    const socket = socketRef.current;
    const operationGeneration = operationGenerationRef.current;
    const connectionGeneration = connectionGenerationRef.current;
    const physicalConnection = physicalConnectionRef.current;
    const conversationAtResponse = conversationIdRef.current;
    void socket.send({ t: "ui-response", reqId: targetReqId, value }).then((sent) => {
      if (pendingUiResponsesRef.current.get(targetReqId) !== responseToken) return;
      if (!viewActiveRef.current || operationGenerationRef.current !== operationGeneration || connectionGenerationRef.current !== connectionGeneration || physicalConnectionRef.current !== physicalConnection || conversationIdRef.current !== conversationAtResponse) {
        pendingUiResponsesRef.current.delete(targetReqId);
        return;
      }
      if (!sent) {
        pendingUiResponsesRef.current.delete(targetReqId);
        setSendError("Not connected — approval response not sent. Request remains open; retry when connected.");
      } else {
        setPendingUiResponseIds((previous) => new Set(previous).add(targetReqId));
        setSendError(null);
      }
    });
  };

  const handleStop = () => {
    if (transcriptRef.current.readOnly) return;
    // An abort that was never delivered is a real failure: the user pressed Stop and
    // the agent may still be running, so the send result must be surfaced, not dropped.
    const notSent = "Not connected — stop was not sent. The agent may still be running.";
    const socket = socketRef.current;
    if (!socket) {
      setSendError(notSent);
      return;
    }
    void socket.send({ t: "abort" }).then((sent) => {
      if (!sent) setSendError(notSent);
    }, () => setSendError(notSent));
  };

  const handleSaveModel = async () => {
    const operationGeneration = operationGenerationRef.current;
    const conversationAtSave = conversationIdRef.current;
    setModelBusy(true);
    setModelMessage("");
    // The save is chained on the conversation's lifecycle key: a save whose view
    // unmounted (Back, reopen) still outlives this mount, and the server applies
    // writes in arrival order — unchained, that older "MODEL_FIRST" would land
    // after the "MODEL_FINAL" the reopened view sent and rewind the stored
    // preference. Submission order becomes arrival order. (V25-02)
    const result = await chainMutation(`conversation-lifecycle:${conversationId}`, () => api.setConversationModel(conversationId, modelDraft));
    // Retired with the session: the request never left, so there is no failure to
    // report and no success to claim. Clear the busy flag — the mount is almost
    // certainly gone, but it is this callback's last touch on the instance.
    if (result === MUTATION_CANCELLED) { setModelBusy(false); return; }
    if (!viewActiveRef.current || operationGenerationRef.current !== operationGeneration || conversationIdRef.current !== conversationAtSave) return;
    setModelBusy(false);
    setModelMessage(result.ok ? "Model saved for next launch." : result.error.message);
    if (result.ok) {
      // V23-04: this success is the newest metadata truth. Bump so any read that
      // began before it cannot land afterwards and rewind the saved model.
      metadataGenerationRef.current += 1;
      setConversation(result.data);
    }
  };

  const handleRestart = async () => {
    if (!window.confirm("Save this model preference and restart the agent now? The running session may be interrupted.")) return;
    const operationGeneration = operationGenerationRef.current;
    const conversationAtRestart = conversationIdRef.current;
    const submittedDraft = modelDraft;
    setModelBusy(true);
    setModelMessage("");
    // Both the save and the restart are chained on the same key, in submission
    // order: an older save that arrives late cannot slip between (or after) this
    // pair, so the preference the restart launched with is the one that stays
    // stored. (V25-02)
    const saved = await chainMutation(`conversation-lifecycle:${conversationId}`, () => api.setConversationModel(conversationId, submittedDraft));
    const stillThisView = () => viewActiveRef.current && operationGenerationRef.current === operationGeneration && conversationIdRef.current === conversationAtRestart;
    if (saved === MUTATION_CANCELLED) { if (stillThisView()) setModelBusy(false); return; }
    if (!saved.ok) {
      if (stillThisView()) {
        setModelBusy(false);
        setModelMessage(saved.error.message);
      }
      return;
    }
    // The save landed and the user asked for a restart. Back does not retire this request;
    // only the auth-lifetime cancellation below stops the pair.
    if (stillThisView()) {
      metadataGenerationRef.current += 1;
      setConversation(saved.data);
    }
    const result = await chainMutation(`conversation-lifecycle:${conversationId}`, () => api.restartConversation(conversationId));
    // Auth retirement means restart never left; only clear state if this view still owns it.
    if (result === MUTATION_CANCELLED) { if (stillThisView()) setModelBusy(false); return; }
    if (!stillThisView()) return;
    setModelBusy(false);
    if (result.ok) {
      metadataGenerationRef.current += 1;
      setConversation(result.data);
      // Only adopt the server's value when the user has not edited the draft while
      // the restart was pending; a newer unsaved choice must not be clobbered.
      if (modelDraftRef.current === submittedDraft) setModelDraft(result.data.modelPreference ?? result.data.model ?? "");
      // V25-05: the restart replaced the tmux session, so the terminal attach
      // command on screen (from the pre-restart read) now points at a dead session.
      // Re-read the instructions and publish only while this is still the newest
      // attach read, so the pre-restart fetch cannot land after it. The server's
      // answer decides the render — `available:false` falls back to the "run
      // omp session list" hint. The bump above already retired the pre-restart
      // read, so a failed refetch must publish the unavailable shape too: leaving
      // the old value would keep the dead session's command on screen with
      // nothing scheduled to replace it.
      const attachRead = ++attachReadSeqRef.current;
      void api.getAttachInstructions(conversationAtRestart).then((attach) => {
        if (conversationIdRef.current !== conversationAtRestart || attachReadSeqRef.current !== attachRead) return;
        if (attach.ok) setAttachInfo(attach.data);
        else setAttachInfo({ conversationId: conversationAtRestart, available: false, command: null, tmuxSessionName: null, reason: attach.error?.message ?? "The attach command cannot be verified after the restart." });
      });
      socketRef.current?.close();
      socketRef.current = null;
      if (viewActiveRef.current && operationGenerationRef.current === operationGeneration && conversationIdRef.current === conversationAtRestart) await connectToCollab(true);
      if (!viewActiveRef.current || operationGenerationRef.current !== operationGeneration || conversationIdRef.current !== conversationAtRestart) return;
      // The restart response proves the request was accepted, not that the agent is
      // back: a publish timeout leaves the row at `starting`
      // (apps/server/src/app.ts:601, packages/runtime/src/supervisor.ts:793), and the
      // returned row is the machine's own observation of that. So the claim follows
      // what we can see — a live state, or a socket that actually joined the room —
      // and says so honestly when neither has happened yet (AGENTS.md rule 9).
      const joinedRoom = transcriptRef.current.connectionStatus === "live";
      const up = result.data.state === "running" || result.data.state === "idle" || result.data.state === "awaiting_input";
      if (joinedRoom || up) setModelMessage("Agent restarted.");
      else setModelMessage(`Restart requested, but the agent has not come up yet (reported state: ${result.data.state}). Retry once the machine settles.`);
    } else setModelMessage(result.error.message);
  };


  const handleFetchTranscript = (agentId: string, fromByte: number) => {
    if (!socketRef.current || watchedTranscriptAgentRef.current !== agentId || [...transcriptRequestsRef.current.values()].some((request) => request.agentId === agentId)) return;
    const reqId = reqIdCounterRef.current++;
    if (transcriptRequestsRef.current.size >= MAX_TRANSCRIPT_REQUESTS) {
      const oldestId = transcriptRequestsRef.current.keys().next().value;
      if (oldestId !== undefined) {
        const request = transcriptRequestsRef.current.get(oldestId)!;
        clearTimeout(request.timer);
        transcriptRequestsRef.current.delete(oldestId);
        transcriptRef.current = forgetTranscriptRequest(transcriptRef.current, oldestId);
      }
    }
    const cursor = transcriptRef.current.transcripts[agentId]?.newSize ?? fromByte;
    transcriptRef.current = trackTranscriptRequest(transcriptRef.current, reqId, agentId, cursor);
    setTranscript(transcriptRef.current);
    setTranscriptErrors((prev) => {
      if (!(agentId in prev)) return prev;
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
    const timer = setTimeout(() => {
      transcriptRequestsRef.current.delete(reqId);
      transcriptRef.current = forgetTranscriptRequest(transcriptRef.current, reqId);
      setTranscript(transcriptRef.current);
      setTranscriptErrors((prev) => ({ ...prev, [agentId]: "Transcript request timed out. Cursor was kept; retry to continue." }));
    }, TRANSCRIPT_REQUEST_TIMEOUT_MS);
    transcriptRequestsRef.current.set(reqId, { agentId, fromByte: cursor, timer });
    void socketRef.current.send({ t: "fetch-transcript", reqId, agentId, fromByte: cursor }).then((sent) => {
      if (sent) return;
      const request = transcriptRequestsRef.current.get(reqId);
      if (!request) return;
      clearTimeout(request.timer);
      transcriptRequestsRef.current.delete(reqId);
      transcriptRef.current = forgetTranscriptRequest(transcriptRef.current, reqId);
      setTranscript(transcriptRef.current);
      setTranscriptErrors((previous) => ({ ...previous, [agentId]: "Transcript request was not accepted. Cursor was kept; retry to continue." }));
    });
  };
  fetchTranscriptRef.current = handleFetchTranscript;

  const handleWatchTranscript = useCallback((agentId: string | null) => {
    const previousAgentId = watchedTranscriptAgentRef.current;
    watchedTranscriptAgentRef.current = agentId;
    if (previousAgentId === null || previousAgentId === agentId) return;
    for (const [reqId, request] of transcriptRequestsRef.current) {
      if (request.agentId !== previousAgentId) continue;
      clearTimeout(request.timer);
      transcriptRequestsRef.current.delete(reqId);
      transcriptRef.current = forgetTranscriptRequest(transcriptRef.current, reqId);
    }
    setTranscript(transcriptRef.current);
  }, []);

  /** Kept in a ref so `runVibeAction` can call the latest `sendPrompt` without re-creating. */
  const sendPromptRef = useRef<(text: string, allowSlashCommand?: boolean) => void>(() => {});

  /**
   * Read the native vibe state from the live process.
   *
   * A transport failure is surfaced as `available: false` with the reason — never
   * as a state — so the panel can say "could not be read" instead of showing a
   * confident "Off" it did not verify.
   */
  const refreshVibe = useCallback(async (): Promise<void> => {
    const target = conversationIdRef.current;
    const read = await api.getVibe(target);
    if (conversationIdRef.current !== target) return;
    if (read.ok) { setVibeState(read.data); setVibeError(null); return; }
    setVibeState({ available: false, reason: read.error?.message ?? "The control bridge could not be reached.", modes: null, tools: null, model: null, thinkingLevel: null });
  }, []);

  // Read once when the panel opens, and only then: this is a control surface, not
  // a polled readout, so it costs nothing while the user is reading the chat.
  useEffect(() => {
    if (!showVibe) return;
    void refreshVibe();
  }, [showVibe, refreshVibe]);

  /**
   * Ask for a native mode transition and adopt OMP's own verdict.
   *
   * A refusal (`busy`, `conflict`, `disabled`) is rendered as the explanation it
   * is; only `ok: true` updates the shown mode, so a refused request can never
   * leave the panel claiming a change that did not happen.
   */
  /**
   * Enter or leave vibe mode, then optionally send the first directive.
   *
   * The directive is threaded here rather than fired alongside the transition so
   * it can only be sent once OMP has CONFIRMED the mode is on. Firing it early
   * would contradict the panel's own promise: if the enter is refused (busy or
   * blocked by plan/goal mode), the directive would still have gone out as a
   * plain prompt into a session that never entered vibe — a silently wrong turn.
   */
  const runVibeAction = (action: "enter" | "exit", directive?: string): void => {
    const target = conversationIdRef.current;
    setVibeBusy(true);
    setVibeError(null);
    void api.setVibe(target, action).then((result) => {
      if (conversationIdRef.current !== target) return;
      setVibeBusy(false);
      if (!result.ok) { setVibeError(result.error?.message ?? "The control bridge did not answer."); return; }
      const verdict: NativeModeResult = result.data;
      if (verdict.state !== null) setVibeState({ available: true, reason: null, modes: verdict.state, tools: vibeState?.tools ?? null, model: vibeState?.model ?? null, thinkingLevel: vibeState?.thinkingLevel ?? null });
      if (!verdict.ok) { setVibeError(vibeVerdictLabel(verdict)); return; }
      void refreshVibe();
      // Only now — the mode is on, so the directive is a real director prompt.
      if (directive !== undefined && directive !== "") sendPromptRef.current(directive, true);
    });
  };

  /**
   * Kill one worker through the wire's own agent control.
   *
   * `agent-cmd` with `cmd: "kill"` is the host's documented control for a
   * subagent (`packages/wire/src/index.ts:343`) — the same frame the Agents panel
   * uses. Sending text like "/stop" as a chat message would not kill anything; it
   * would become a prompt to that worker.
   */
  const killWorker = useCallback((agentId: string): void => {
    socketRef.current?.send({ t: "agent-cmd", cmd: "kill", agentId });
  }, []);

  // Re-pointed every render so the vibe path always calls the current closure.
  sendPromptRef.current = sendPrompt;

  const handleCloseSubagents = () => {
    handleWatchTranscript(null);
    for (const request of transcriptRequestsRef.current.values()) clearTimeout(request.timer);
    transcriptRequestsRef.current.clear();
    transcriptRef.current = clearTranscriptRequests(transcriptRef.current);
    setTranscript(transcriptRef.current);
    setShowSubagents(false);
  };

  return (
    <div className="conversation-screen">
      {/* Header */}
      <div className="app-header">
        <div className="conversation-header-title">
          <button type="button" className="ghost header-icon-button" onClick={onBack} title="Back">
            ←
          </button>
          <div className="conversation-header-copy">
            <h3 style={{ fontSize: "1rem" }}>{conversation?.title ?? "Conversation"}</h3>
            {/* One status line, one fact: the live link's state.
                The record's `state` and the link disagree only while one is
                stale, and the link is the one that can be verified right now — a
                healthy link proves the host is answering, which supersedes a
                stored `starting`. Printing both produced `idle · idle`: the same
                fact twice, in the width a transcript row needs. The record's own
                state stays available in Session details, and a saved transcript
                states its own case in the transcript banner. */}
            <span
              className={`header-status header-status--${status}`}
              title={`Live link: ${status} · stored record: ${conversation?.state ?? "unknown"}`}
              // The status moved out of the banner area, so this element is now
              // the one that announces a change for a screen reader. Polite: the
              // state is information, not an interruption.
              role="status"
              aria-live="polite"
            >
              <span className="header-status-dot" aria-hidden="true" />
              {status}
            </span>
              {/* Mode chips, on the same line as the status (§5.5): one small
                  control each, with the full name in the accessible label. They
                  replace the rows these states used to occupy, and an advisor with
                  a recorded blocker is the only case that gets a loud colour —
                  everything else stays quiet until tapped. */}
              {advisorSummary.notes.length > 0 && (
                <button
                  type="button"
                  className={`mode-chip${advisorSummary.notes.some((note) => note.severity === "blocker") ? " mode-chip--alert" : ""}`}
                  aria-label={`Advisor: ${advisorSummary.notes.length} note${advisorSummary.notes.length === 1 ? "" : "s"} recorded. Open the advisor panel.`}
                  title={`Advisor notes: ${advisorSummary.notes.length}`}
                  onClick={() => setShowAdvisor(true)}
                >
                  Adv{advisorSummary.notes.some((note) => note.severity === "blocker") ? " ⛔" : " ●"}
                </button>
              )}
              {/* Rendered only when the mode is known ON, or when the bridge could
                  not be asked while the panel has been opened at least once. An
                  "off" mode is not worth a permanent chip — it is the default. */}
              {vibeState?.available === true && vibeState.modes?.vibe.status === "active" && (
                <button
                  type="button"
                  className="mode-chip mode-chip--on"
                  aria-label={`Vibe mode is on${agents.length > 0 ? `, ${agents.length} worker${agents.length === 1 ? "" : "s"}` : ""}. Open the vibe panel.`}
                  onClick={() => setShowVibe(true)}
                >
                  Vibe ●{agents.length > 0 ? ` ${agents.length}` : ""}
                </button>
              )}
          </div>
        </div>

        <div className="conversation-header-actions">
          {/* Stop generating stays OUT of the menu and stays one tap while
              generating: it is the control a user reaches for when a turn is
              going wrong, and a menu between them and it is a real cost. The
              same reasoning keeps an approval out of any menu (it renders in
              the transcript, never here). */}
          {status === "running" && canManageConversation && canWriteToHost && !transcript.readOnly && (
            <button
              type="button"
              className="danger header-stop"
              aria-label="Stop generating"
              title="Stop generating — ends the current turn; the OMP process stays alive"
              onClick={handleStop}
            >
              <span className="header-action-icon" aria-hidden="true">■</span>
              <span className="header-action-label">Stop generating</span>
            </button>
          )}
          <button
            type="button"
            className="ghost header-menu-button"
            aria-label="More actions"
            aria-expanded={showMenu}
            aria-controls="conversation-actions-menu"
            title="More actions"
            onClick={() => setShowMenu((value) => !value)}
          >
            <span aria-hidden="true">⋯</span>
          </button>
          {showMenu && (
            // A disclosure of plain buttons, deliberately not `role="menu"`:
            // menu semantics promise roving tabindex and arrow-key navigation,
            // which this does not implement (Tab is the only way through, as in
            // any disclosure). Claiming the role would be an accessibility lie.
            <div className="header-menu" id="conversation-actions-menu" aria-label="Conversation actions">
              <button type="button" onClick={() => { setShowMenu(false); setShowActivity(true); }}>
                Activity
              </button>
              {/* Advisor and Vibe are always reachable from the menu, not only
                  through a header chip: the chips appear only when there is
                  something to show (a recorded note, an active mode), so without
                  these entries a user with no notes yet would have no way to open
                  either panel and read where its controls live. */}
              <button type="button" onClick={() => { setShowMenu(false); setShowAdvisor(true); }}>
                Advisor
              </button>
              <button type="button" onClick={() => { setShowMenu(false); setShowVibe(true); }}>
                Vibe mode
              </button>
              {agents.length > 0 && (
                <button type="button" aria-label={`Agents (${agents.length})`} onClick={() => { setShowMenu(false); setShowSubagents(true); }}>
                  Agents ({agents.length})
                </button>
              )}
              {/* Handoff is offered only where it can actually run. A conversation
                  this app does not own gets the control disabled with the reason
                  printed below, never an enabled action that fails. */}
              {handoffOffered && (
                <button
                  type="button"
                  className="header-menu-item"
                  disabled={handoffBusy || handoffReason !== null}
                  title={handoffReason ?? "Compact this session's context in place"}
                  onClick={() => { setShowMenu(false); setHandoffConfirming((value) => !value); }}
                >
                  {handoffBusy ? "Generating handoff…" : "Handoff context"}
                </button>
              )}
              {/* Two different things, deliberately distinguishable. `Stop generating`
                  aborts the current turn and leaves the process alive; this one ends
                  the app-managed OMP process and releases its agent slot. Neither
                  touches the native journal, and neither is offered where it cannot
                  work. */}
              {stopSessionOffered && (
                <button
                  type="button"
                  className="header-menu-item header-menu-item--danger"
                  disabled={stopSessionBusy || stopSessionReason !== null}
                  title={stopSessionReason ?? "Terminate the app-managed OMP process; history and the native session are preserved"}
                  onClick={() => { setShowMenu(false); setStopSessionConfirming((value) => !value); }}
                >
                  {stopSessionBusy ? "Stopping session…" : "Stop OMP session"}
                </button>
              )}
              <button
                type="button"
                className="header-menu-item"
                onClick={() => { setShowMenu(false); setModelSheetOpen(true); }}
              >
                Model settings
              </button>
            </div>
          )}
        </div>
      </div>
      {conversation !== null && handoffReason && !handoffConfirming && <p className="handoff-reason">Handoff unavailable: {handoffReason}</p>}
      {/* The reason is printed even when the control is not rendered (an external
          session): a missing action with no explanation reads as a bug. */}
      {conversation !== null && stopSessionReason && !stopSessionConfirming && <p className="handoff-reason">Stop session unavailable: {stopSessionReason}</p>}
      {stopSessionConfirming && (
        <div className="card handoff-confirm" role="group" aria-label="Stop OMP session">
          <strong>Stop OMP session</strong>
          <p>
            Terminates the OMP process this app manages and releases its agent slot. The native
            session journal and this tracked conversation are preserved; nothing is deleted.
          </p>
          {interruptedWork.length > 0 ? (
            <p className="handoff-refusal">
              This will interrupt {interruptedWork.join(", ")}. The transcript so far stays on screen.
            </p>
          ) : (
            <p>No turn is in flight, so nothing is being interrupted.</p>
          )}
          {stopSessionReason && <p>{stopSessionReason}</p>}
          <div className="history-actions">
            <button
              type="button"
              className="danger"
              disabled={stopSessionBusy || stopSessionReason !== null}
              onClick={() => void runStopSession()}
            >
              {stopSessionBusy ? "Stopping session…" : interruptedWork.length > 0 ? "Stop session anyway" : "Confirm stop session"}
            </button>
            <button type="button" className="ghost" onClick={() => setStopSessionConfirming(false)}>Cancel</button>
          </div>
          {stopSessionNotice && <p role="status">{stopSessionNotice}</p>}
          {stopSessionRefusal && <p className="handoff-refusal" role="alert">{stopSessionRefusal}</p>}
        </div>
      )}
      {!stopSessionConfirming && stopSessionNotice && (
        <div className="banner running" role="status">
          <span>{stopSessionNotice}</span>
          {/* A stopped session is resumable: the same restart action the project's
              session list offers, so the user does not have to leave to get it back. */}
          {conversation?.state === "stopped" && (
            <button
              type="button"
              className="ghost"
              disabled={restartBusy}
              onClick={() => void runRestartAfterStop()}
              style={{ minHeight: "44px" }}
            >
              {restartBusy ? "Restarting…" : "Restart"}
            </button>
          )}
        </div>
      )}
      {!stopSessionConfirming && stopSessionRefusal && <div className="banner error" role="alert">{stopSessionRefusal}</div>}
      {handoffConfirming && (
        <div className="card handoff-confirm" role="group" aria-label="Handoff context">
          <strong>Handoff context</strong>
          <p>
            Runs OMP's native <code>/handoff</code> on this session. It compacts the context in
            place, keeps the same session id, does not start a new agent, and keeps the history.
          </p>
          <p>
            The command is pasted into the live terminal pane. If that terminal still holds an
            unsent draft, the paste consumes it — and can submit it to the model. Clear the pane
            before continuing.
          </p>
          {handoffReason && <p>{handoffReason}</p>}
          <div className="history-actions">
            <button type="button" className="primary" disabled={handoffBusy || handoffReason !== null} onClick={() => void runHandoff()}>
              {handoffBusy ? "Generating handoff…" : "Run handoff"}
            </button>
            <button type="button" className="ghost" onClick={() => setHandoffConfirming(false)}>Cancel</button>
          </div>
          {handoffNotice && <p role="status">{handoffNotice}</p>}
          {handoffRefusal && <p className="handoff-refusal" role="alert">{handoffRefusal}</p>}
        </div>
      )}
      {!handoffConfirming && handoffNotice && <div className={`banner ${handoffNoticeTone}`} role="status">{handoffNotice}</div>}
      {!handoffConfirming && handoffRefusal && <div className="banner error" role="alert">{handoffRefusal}</div>}
      {/* `draft_unconfirmed` is the one refusal the user can accept: the editor's
          emptiness is unprovable, so the risk is stated in full and re-sending
          with the flag is a separate, explicit tap. Keyed off the refusal code
          rather than the panel, because `/handoff` can also be run straight from
          the slash-command intercept, where no confirmation card is open.
          `terminal_attached` and the rest are hard: message only, no override. */}
      {handoffRefusalCode === "draft_unconfirmed" && (
        <div className="card handoff-draft-risk" role="group" aria-label="Confirm empty editor">
          <p>
            The terminal may still hold an unsent draft. If it does, this paste destroys that
            draft and can submit it to the model as a prompt together with <code>/handoff</code>.
          </p>
          <button
            type="button"
            className="primary"
            style={{ minHeight: "44px" }}
            disabled={handoffBusy}
            onClick={() => void runHandoff(true)}
          >
            I checked — the editor is empty
          </button>
        </div>
      )}
      {/* Model settings are a sheet, not an inline disclosure: they are touched
          rarely, and a permanent row above the transcript is exactly the chrome
          the phone cannot spare. Every control and note below is unchanged —
          only where it is mounted. A sheet is also reachable from the `/model`
          slash command, which opens the same state. */}
      {modelSheetOpen && (
        <ModalOverlay
          onClose={() => setModelSheetOpen(false)}
          aria-labelledby="model-sheet-title"
          overlayProps={{ className: "modal-overlay model-sheet-overlay" }}
        >
          <section className="modal-content model-sheet" aria-labelledby="model-sheet-title">
            <header className="model-sheet-head">
              <h3 id="model-sheet-title" style={{ fontSize: "1rem" }}>Model settings</h3>
              <button type="button" className="ghost" aria-label="Close model settings" onClick={() => setModelSheetOpen(false)}>✕</button>
            </header>
            <section className="model-controls" aria-label="Conversation model">
              <label htmlFor="conversation-model">Preferred model for next launch</label>
              <select id="conversation-model" value={modelCatalogState.status === "loaded" && modelCatalogState.models.includes(modelDraft) ? modelDraft : ""} onChange={(event) => { modelDraftTouchedRef.current = true; setModelDraft(event.target.value); }}>
                <option value="">Choose a catalog model</option>
                {modelCatalogState.status === "loaded" && modelCatalogState.models.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
              <label htmlFor="custom-model">Custom model ID</label>
              <input id="custom-model" ref={modelInputRef} value={modelDraft} maxLength={128} onChange={(event) => { modelDraftTouchedRef.current = true; setModelDraft(event.target.value); }} placeholder="Enter any OMP model ID" aria-describedby="model-launch-note" />
              {modelCatalogState.status === "loading" && <p role="status">Loading model catalog…</p>}
              {modelCatalogState.status === "empty" && <p role="status">No models reported by OMP. Saved preference is unchanged.</p>}
              {modelCatalogState.status === "unavailable" && <p role="status">Model catalog unavailable: {modelCatalogState.reason}. Saved preference is unchanged.</p>}
              {modelCatalogState.status === "error" && <p role="alert">Could not load models: {modelCatalogState.message}. Saved preference is unchanged.</p>}
              <p>{conversation?.ownership === "external" ? "Saved preference for app-launched chats:" : "Preferred for next launch:"} <strong>{conversation?.modelPreference || "not set"}</strong></p>
              <p>Effective model reported now: <strong>{effectiveModel?.conversationId === conversationId ? effectiveModel.model ?? "not reported" : "not reported"}</strong></p>
              {canManageConversation && <button type="button" onClick={handleSaveModel} disabled={modelBusy || !modelDraft.trim()}>Save model</button>}
              {canManageConversation && <button type="button" className="ghost" onClick={handleRestart} disabled={modelBusy || !modelDraft.trim()}>Save &amp; restart agent</button>}
              <span id="model-launch-note">{conversation?.ownership === "external" ? "This model preference applies only to conversations launched by the app." : "Model changes apply on the next launch of this conversation, not immediately."}</span>
              {modelMessage && <span role="status">{modelMessage}</span>}
            </section>
          </section>
        </ModalOverlay>
      )}
      {(transcript.readOnly || linkAccess === "view") && <div className="banner unknown" role="status">Read-only view — prompts, approvals and Stop are unavailable.</div>}
      {viewAccessOffer && status === "unknown" && (
        <div className="banner unknown" role="status">
          <span>Host offers read-only access: {viewAccessOffer}</span>
          <button type="button" className="ghost" onClick={() => void connectToCollab(true, "view")}>Open read-only</button>
        </div>
      )}

      {/* Accessible Status Banners */}
      {status === "disconnected" && !roomRetired && (
        <div className="banner disconnected" role="status">
          <span>Disconnected — Connection lost</span>
          <button type="button" className="ghost" style={{ padding: "2px 8px", fontSize: "0.8rem", color: "#ffffff" }} onClick={() => connectToCollab(true)}>
            Retry
          </button>
        </div>
      )}
      {roomRetired && (
        <div className="banner disconnected" role="status">
          <span>Room retired — reconnect with a fresh link.</span>
          <button type="button" className="ghost" style={{ padding: "2px 8px", fontSize: "0.8rem", color: "#ffffff" }} onClick={() => void connectToCollab(true)}>
            Get new link
          </button>
        </div>
      )}
      {status === "reconnecting" && (
        <div className="banner reconnecting" role="status">
          <span>Reconnecting… Attempting to re-establish live session</span>
        </div>
      )}
      {status === "unknown" && (
        <div className="banner unknown" role="status">
          <span>State: unknown — Agent status cannot be determined</span>
        </div>
      )}
      {/* Neither `idle` nor `running` paints a bar here: the header's status line
          is the single representation of both (§5.3). What stays is the state a
          user must ACT on — disconnected, reconnecting, unknown, a retired room,
          a failed link, an outstanding approval, a read-only link — because
          hiding those would hide the only signal that something needs doing. The
          header carries `role="status"`, so the change is still announced. */}
      {status === "connecting" && (
        <div className="banner connecting" role="status">
          <span>Connecting to the agent…</span>
        </div>
      )}
      {linkFailure && <div className="banner disconnected" role="alert">{linkFailure}</div>}
      {transcript.notice && (
        <div className={`banner ${transcript.notice.level}`} role={transcript.notice.level === "error" ? "alert" : "status"}>
          <span>{transcript.notice.message}</span>
        </div>
      )}
      {/* While the link is live (idle/running) the host is up, so the record's
          stale `starting` must not claim prompting may be refused. Only while the
          link is down/connecting does the startup warning stay honest. */}
      {conversation?.state === "starting" && status !== "idle" && status !== "running" && (
        <div className="banner connecting" role="status">Host is starting up; prompting may be refused.</div>
      )}
      <div className="messages-scroll" ref={messagesScrollRef} role="region" aria-label="Conversation transcript">
        <div className="messages-content" ref={messagesContentRef}>
        {isShowingSavedHistory && savedHistory ? (
          <>
            <div className="banner idle" role="status">
              {historyVerdict === "archived"
                ? `Saved transcript — this session is not running. ${savedHistory.header.title ?? savedHistory.header.sessionId}`
                : `Saved transcript — host presence not verified. ${savedHistory.header.title ?? savedHistory.header.sessionId}`}
            </div>
            {/* V22-01/F-B3: an unverified verdict keeps the cached rows readable but
                must not hide the fresh failure behind them. Surface the same error the
                fallback card offers; the button below retries under its verdict label. */}
            {historyVerdict !== "archived" && (
              <div className="banner unknown" role="alert">
                {historyLoading ? "Checking for a live host…" : historyError ?? "Host presence is not yet verified; this cached transcript may be stale."}
              </div>
            )}
            {/* V21-02: saved mode must not be a dead end. The host may resume the
                native session later (external ones especially, where the app cannot
                restart the process itself), so offer an on-screen check for a fresh
                link. One click, no polling and no auto launch: a successful mint
                switches to the live view, a failure keeps this transcript. */}
            <button type="button" className="primary" onClick={() => void retryUnavailableConversation()}>{historyVerdict === "archived" ? "Open live view" : "Retry"}</button>
            {savedHistory.skippedOversized && <div className="banner unknown" role="alert">History is incomplete: a record too large to display was skipped; journal intact on disk.</div>}
            {savedHistory.truncated && (savedHistory.hasOlder || savedHistory.skippedOversized) && <div className="banner unknown" role="status">Saved transcript truncated; some history is omitted.</div>}
            {savedHistory.hasOlder && savedHistory.nextCursor !== null && <button type="button" className="ghost" disabled={olderHistoryLoading || historyLoading} onClick={() => void loadOlderHistory()}>{olderHistoryLoading ? "Loading older…" : "Load older"}</button>}
            {olderHistoryLoading && <p role="status">Loading older history…</p>}
            {olderHistoryError && <p role="alert">{olderHistoryError}</p>}
            {!savedHistory.hasOlder && !savedHistory.skippedOversized && <p role="status">Beginning of history.</p>}
            <TranscriptList rows={savedRows} />
            {savedModeOptimistic.map((message) => <MessageRow key={message.id} message={message} />)}
          </>
        ) : linkUnavailable ? (
          <div className="card" style={{ borderColor: "var(--warning)", backgroundColor: "#1e180d" }}>
            <h4 style={{ color: "var(--warning)", marginBottom: "8px" }}>{historyVerdict === "live" ? "Writer status unverified" : "Live host unavailable"}</h4>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", marginBottom: "12px" }}>
              {/* V22-01: the history endpoint cannot tell a live writer from an
                  unverifiable one, so this copy hedges the claim rather than
                  asserting "This session is live". */}
              {historyVerdict === "live" ? "Writer status could not be verified — this session may be live. Open the live view to read it." : historyLoading ? "Checking for a saved transcript…" : historyError ?? "Host presence is not yet verified. No saved transcript is available; retry to check for a live host."}
            </p>
            {(historyVerdict === "live" || !historyLoading) && <button type="button" className="primary" onClick={() => void retryUnavailableConversation()}>{historyVerdict === "live" ? "Open live view" : "Retry"}</button>}
            {attachInfo?.available && attachInfo.command ? (
              <div>
                <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>How to attach in terminal:</span>
                <pre><code>{attachInfo.command}</code></pre>
              </div>
            ) : (
              <>
                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>{attachInfo?.reason ?? "Attach command unavailable: process identity could not be verified."}</p>
                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Run <code>omp session list</code> on the host machine to find the managed session, then <code>tmux attach -t &lt;name&gt;</code>.</p>
              </>
            )}
          </div>
        ) : null}

        {/* A brand-new conversation has nothing to show, which reads as a broken
            screen. Say what the session actually is instead of leaving a void.
            Deliberately NOT role="status": the status banners above are the single
            live region for connection state, and a second one advertising the same
            state makes assistive tech (and any test filtering by role) ambiguous. */}
        {messages.length === 0 && !streamingText && !linkUnavailable && (
          <div className="empty-transcript">
            {/* Same rule as the status row: a live idle link outranks the
                record's stale `starting`, so the connected copy is the true one. */}
            {status === "idle" && (
              <>
                <p>Connected to this conversation&apos;s agent.</p>
                <p>No prompts yet. Send one below to start the turn.</p>
              </>
            )}
            {conversation?.state === "starting" && status !== "idle" && status !== "running" && <p>The host is starting up. Prompting may be refused until it finishes.</p>}
            {status === "running" && <p>The agent is working. Output appears here as it streams.</p>}
            {status === "connecting" && <p>Contacting the agent…</p>}
            {(status === "reconnecting" || status === "disconnected") && (
              <p>The live transcript is unavailable while the connection is down.</p>
            )}
          </div>
        )}

        {!isShowingSavedHistory && <TranscriptList rows={messages} />}

        {/* Streaming assistant message. Never in saved mode: the saved transcript is
            the single source of truth there, and a live stream is not its content. */}
        {streamingText && !isShowingSavedHistory && (
          <div className="message-card assistant">
            <div style={{ fontSize: "0.75rem", color: "var(--primary)", marginBottom: "4px" }}>
              Assistant (streaming…)
            </div>
            <div className="message-content">{renderMarkdown(streamingText)}</div>
          </div>
        )}

        {/* UI Request / Host Approval */}
        {activeUiRequest && !linkUnavailable && (
          <div className="card" style={{ borderColor: "var(--primary)", backgroundColor: "rgba(47,129,247,0.1)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
              <h4 style={{ margin: 0, color: "var(--primary)" }}>Approval Requested</h4>
              {uiRequestQueue.length > 0 && (
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  +{uiRequestQueue.length} queued
                </span>
              )}
            </div>
            <p style={{ marginBottom: "12px", fontSize: "0.95rem" }}>{parseInline(activeUiRequest.title)}</p>
            {pendingUiResponseIds.has(activeUiRequest.reqId) && <p role="status">Response sent; awaiting host to settle this request.</p>}

            {(transcript.readOnly || linkAccess === "view") ? (
              <p role="note">Read-only link — this request cannot be answered here.</p>
            ) : activeUiRequest.kind === "select" ? (
              <>
                {activeUiRequest.helpText && <p style={{ marginBottom: "8px", color: "var(--text-muted)" }}>{activeUiRequest.helpText}</p>}
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "12px" }}>
                  {activeUiRequest.options.map((option, index) => {
                    const label = typeof option === "string" ? option : option.label;
                    const checked = activeUiRequest.checkedIndices?.includes(index) ?? false;
                    const selected = activeUiRequest.initialIndex === index || checked;
                    return (
                      <button key={`${activeUiRequest.reqId}-${index}-${label}`} type="button" className={/\b(deny|reject|decline|refuse|disallow|cancel|no)\b/i.test(label) ? "approval-deny" : "primary"} disabled={transcript.readOnly} onClick={() => handleUiResponse(label, activeUiRequest.reqId)}>
                        {activeUiRequest.selectionMarker === "checkbox" ? (checked ? "☑ " : "☐ ") : (selected ? "◉ " : "○ ")}
                        {label}
                        {typeof option !== "string" && option.description && <><br /><small>{option.description}</small></>}
                      </button>
                    );
                  })}
                </div>
                {activeUiRequest.markableCount !== undefined && <p style={{ color: "var(--text-muted)" }}>Choose up to {activeUiRequest.markableCount} options.</p>}
              </>
            ) : (
              <>
                <textarea value={uiEditorValue} onChange={(event) => setUiEditorValue(event.target.value)} rows={4} readOnly={transcript.readOnly} />
                <button type="button" className="primary" disabled={transcript.readOnly} onClick={() => handleUiResponse(uiEditorValue, activeUiRequest.reqId)}>Submit</button>
              </>
            )}
            {/* An approval that can only be accepted is a trap. Cancel is a response
                with no value — the same frame the host already reads as "declined"
                (`CollabUiResponseValue` is optional; the vendored guest sends it too). */}
            {!(transcript.readOnly || linkAccess === "view") && (
              <div style={{ marginTop: "12px" }}>
                <button type="button" className="ghost" disabled={transcript.readOnly} onClick={() => handleUiResponse(undefined, activeUiRequest.reqId)}>Cancel</button>
              </div>
            )}
          </div>
        )}


        </div>
      </div>
      {!linkUnavailable && !transcript.readOnly && isDetached && commandSuggestions.length === 0 && !interceptedCommand && (
        <div className="latest-row">
          <button type="button" className="latest-button" onClick={goToLatest}>↓ Latest</button>
        </div>
      )}
      {canWriteToHost && commandSuggestions.length > 0 && !interceptedCommand && !linkUnavailable && (
        <div className="composer-suggestions" aria-label="Slash command suggestions">
          {commandSuggestions.map((command) => (
            <button
              key={command.name}
              type="button"
              className="command-suggestion"
              onClick={() => { updateDraft(command.name); composerRef.current?.focus(); }}
            >
              <span><code>{command.name}</code> — {command.description}</span>
              {command.availability !== "app_action" && <small>{command.availability === "terminal_only" ? "Terminal only" : "Not a command"}</small>}
            </button>
          ))}
        </div>
      )}
      {canWriteToHost && interceptedCommand && !linkUnavailable && (
        <div className="slash-command-intercept">
          <strong>{interceptedCommand.name}</strong>
          <p>{interceptedCommand.explanation}</p>
          {interceptedCommand.availability === "terminal_only" && <p>Terminal only — not sent to the live session.</p>}
          {interceptedCommand.availability === "app_action" && interceptedCommand.action === "model" && (
            <button type="button" onClick={openCommandAction}>Open model controls</button>
          )}
          {interceptedCommand.availability === "app_action" && interceptedCommand.action === "handoff" && (
            <>
              <p>It runs OMP's native /handoff on this session, compacts the context in place, keeps the same session id, and does not start a new agent.</p>
              <button type="button" className="primary" onClick={() => void runHandoff()} disabled={handoffBusy || handoffReason !== null}>
                {handoffBusy ? "Generating handoff…" : "Run handoff"}
              </button>
              {handoffReason && <p>{handoffReason}</p>}
            </>
          )}
          {/* `/handoff` is delivered as keystrokes into the managed pane by the
              server. Sending it as a Collab prompt would be a second delivery path
              with different semantics, so the escape hatch is not offered here. */}
          {interceptedCommand.action !== "handoff" && (
            <button type="button" className="primary" disabled={transcript.readOnly} onClick={sendSlashAsText}>Send as plain text anyway</button>
          )}
          <button type="button" className="ghost" onClick={() => setInterceptedCommand(null)}>Cancel</button>
        </div>
      )}
      {/* V20-07: the strip is a LOCAL affordance. Copy writes the clipboard, so a lost
          link, a saved transcript or a read-only link never hides it. Recover writes the
          composer draft, so it is offered only while the composer is writable: staging
          it into a hidden composer would call updateDraft and silently overwrite the
          App-owned draft, the only copy of the user's newer text. Sending stays gated by
          the composer's own disabled state. */}
      {refusedRecoveries.map((item) => (
        <div key={item.id} className="banner warning refused-prompt" role="status" style={{ gap: "8px" }}>
          {/* The strip is the only way back to a refused prompt, so it cannot hide
              the text behind a one-line ellipsis (measured: 201px shown of 821px).
              Wrapping keeps the whole prompt readable; the row grows instead. */}
          <span style={{ minWidth: 0, wordBreak: "break-word", flex: 1 }}>
            {item.unconfirmed ? "Unconfirmed — host receipt unknown; may already have executed — " : item.echoed ? "Echoed — " : "Refused — "}{item.text}
          </span>
          <span style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
            {canWriteToHost && !linkUnavailable && (
              <button type="button" aria-label="Recover to draft" className="ghost" onClick={() => recoverRefusedPromptText(item)}>Recover to draft</button>
            )}
            <button type="button" className="ghost" onClick={() => void copyRefusedPromptText(item)}>
              {refusedCopyState?.id === item.id ? (refusedCopyState.state === "copied" ? "Copied" : "Copy failed") : "Copy"}
            </button>
            <button type="button" className="ghost" onClick={() => removeRefusedRecovery(item.id)}>Dismiss</button>
          </span>
        </div>
      ))}
      {canWriteToHost && !linkUnavailable && (
      <form onSubmit={handleSendPrompt} className="composer-container">
        <textarea
          className="composer-input"
          placeholder={transcript.readOnly ? "Read-only — not sent" : status === "running" ? "Turn in flight — send a follow-up…" : "Send instructions to agent…"}
          value={inputText}
          ref={composerRef}
          onChange={(event) => updateDraft(event.target.value)}
          disabled={transcript.readOnly || status === "disconnected" || status === "unknown" || status === "connecting" || status === "reconnecting"}
          rows={1}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { setTimeout(() => { composingRef.current = false; }, 0); }}
          onKeyDown={(event) => {
            if (shouldSubmitOnEnter(event, composingRef.current)) {
              event.preventDefault();
              handleSendPrompt(event);
            }
          }}
        />
        <button
          type="submit"
          className="primary"
          disabled={transcript.readOnly || !inputText.trim() || status === "disconnected" || status === "unknown" || status === "connecting" || status === "reconnecting"}
          style={{ minHeight: "44px", minWidth: "64px" }}
        >
          Send
        </button>
      {sendError && <div className="banner unknown" role="alert">{sendError}</div>}
      </form>
      )}

      {/* Subagent Panel Modal */}
      {showSubagents && (
        <SubagentPanel
          agents={agents}
          onFetchTranscript={handleFetchTranscript}
          onWatchAgent={handleWatchTranscript}
          transcripts={transcripts}
          transcriptErrors={transcriptErrors}
          loadingAgentIds={loadingAgentIds}
          onClose={handleCloseSubagents}
        />
      )}
      {/* Activity Timeline Modal */}
      {showActivity && (
        <ActivityPanel
          conversationId={conversationId}
          onClose={() => setShowActivity(false)}
        />
      )}
      {/* Advisor panel. Notes come from the session's own history; the enable
          switch is not on this transport, and the panel says so rather than
          offering a control that cannot move. */}
      {showAdvisor && (
        <AdvisorPanel
          summary={advisorSummary}
          onClose={() => setShowAdvisor(false)}
        />
      )}
      {/* Vibe panel. State and transitions come from the live process through the
          control bridge; a refused transition is shown as OMP's own reason. */}
      {showVibe && (
        <VibePanel
          state={vibeState}
          busy={vibeBusy}
          error={vibeError}
          readOnly={transcript.readOnly || linkAccess === "view" || !canManageConversation}
          workers={agents}
          onEnter={(directive) => runVibeAction("enter", directive)}
          onExit={() => runVibeAction("exit")}
          onKillWorker={killWorker}
          onOpenWorkers={() => { setShowVibe(false); setShowSubagents(true); }}
          onClose={() => setShowVibe(false)}
        />
      )}
    </div>
  );
}
