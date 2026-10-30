import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type SavedConversationHistory } from "../api.js";
import { chainMutation, MUTATION_CANCELLED } from "../mutation-order.js";
import { MarkdownCodeBlock, renderMarkdown } from "../sanitize.js";
import { ActivityPanel } from "./ActivityPanel.js";
import { SubagentPanel } from "./SubagentPanel.js";
import {
  CollabSocket,
  parseCollabLink,
  importRoomKey,
  encodeBase64Url,
  type HostFrame,
  type SessionEntry,
} from "@caw/collab-protocol";
import { clearTranscriptRequests, createTranscriptState, forgetTranscriptRequest, reduceHostFrame, setConnectionStatus, textFromContent, trackTranscriptRequest, transcriptMessagesFromEntries, type TranscriptMessage, type TranscriptReply, type TranscriptState } from "../transcript.js";
import { findSlashCommand, slashCommands, type SlashCommand } from "../commands.js";
import type { AttachInstructions, Conversation } from "@caw/contracts";
/** A prompt the host refused, kept per conversation so Back/reopen cannot lose it. */
export interface RefusedRecovery {
  id: number;
  text: string;
  /**
   * V20-02: the socket accepted this prompt but the host never acknowledged it when
   * the view went away. Same strip, distinct label — it is not a refusal, and it is
   * never auto-resent.
   */
  unconfirmed?: boolean;
}

interface ConversationViewProps {
  conversationId: string;
  draft?: string;
  onDraftChange?: (draft: string) => void;
  onBack: () => void;
  /** App-owned recovery list for this conversation; omit to use per-mount internal state. */
  refusedRecoveries?: RefusedRecovery[];
  onRefusedRecoveriesChange?: (next: RefusedRecovery[]) => void;
}

interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "notice";
  text: string;
  toolName?: string;
  isError?: boolean;
  isRunning?: boolean;
  awaitingHost?: boolean;
  hostEchoCount?: number;
}
interface PendingPrompt {
  text: string;
  submitted: string;
  hostEchoCount: number;
  optimisticId: string | null;
  sent: boolean;
  refusalMessage?: string;
  draftVersion: number;
  /** Physical connection the prompt was sent on; a refusal only matches prompts from the current one. */
  physicalConnection: number;
  /**
   * True when the send happened while the bootstrap snapshot was still in flight.
   * Snapshot rows are a historical baseline, never this prompt's receipt, so a
   * completing snapshot must not acknowledge it.
   */
  preSnapshot: boolean;
  /** Wall clock at send; a dump row for this text newer than this is its own echo. */
  sentAtMs: number;
  token: object;
}


const TAIL_THRESHOLD_PX = 80;
const MAX_TRANSCRIPT_REQUESTS = 64;
const TRANSCRIPT_REQUEST_TIMEOUT_MS = 15_000;
const TRANSCRIPT_POLL_MS = 1200;
const STARTUP_PROMPT_REFUSAL = "prompting is unavailable until the host finishes starting up";
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

const MessageRow = memo(function MessageRow({ message }: { message: DisplayMessage }) {
  return (
    <div className={`message-card ${message.role}${message.isError ? " error" : ""}`}>
      <div style={{ fontSize: "0.75rem", color: message.isError ? "var(--danger-text)" : "var(--text-muted)", marginBottom: "4px", textTransform: "capitalize" }}>
        {message.role} {message.toolName ? `(${message.toolName})` : ""}{message.isError ? " · error" : ""}
        {message.awaitingHost ? " · sent while active; awaiting host" : ""}
      </div>
      {message.role === "tool" ? (
        <details open={message.isRunning}>
          <summary>{message.toolName ?? "Tool Result"} {message.isRunning ? "(Running…)" : message.isError ? "(Error)" : ""}</summary>
          <div className="message-content"><MarkdownCodeBlock code={message.text} language="" /></div>
        </details>
      ) : (
        <div className="message-content">{message.role === "notice" ? <p>{message.text}</p> : renderMarkdown(message.text)}</div>
      )}
    </div>
  );
});

export type ConnectionStatus = "connecting" | "idle" | "running" | "reconnecting" | "disconnected" | "unknown";

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
  /**
   * A live echo for an unconfirmed prompt is a real host acknowledgement, so the
   * strip item can go. The caller passes only genuine live frames: a snapshot row is
   * history, and matching it by text would delete a strip item for a prompt the host
   * may never have submitted (V20-02 forbids that guess).
   */
  const acknowledgeUnconfirmed = (text: string): void => {
    const item = refusedRecoveriesRef.current.find((entry) => entry.unconfirmed && entry.text === text);
    if (item) removeRefusedRecovery(item.id);
  };

  const inputValueRef = useRef(draft);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const followTailRef = useRef(true);
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStreamFrameRef = useRef<Extract<HostFrame, { t: "event" }> | null>(null);
  const composingRef = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const modelControlsRef = useRef<HTMLDetailsElement | null>(null);
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const socketRef = useRef<CollabSocket | null>(null);
  const pendingUiResponsesRef = useRef(new Map<number, object>());
  const sendingPromptTextsRef = useRef(new Map<string, object>());
  const pendingPromptRef = useRef<PendingPrompt[]>([]);
  const localIdRef = useRef(0);
  const sendGuardRef = useRef<{ id: number; text: string } | null>(null);
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
  const messages: DisplayMessage[] = useMemo(() => {
    const hostCounts = new Map<string, number>();
    for (const message of transcript.messages) {
      if (message.role === "user") hostCounts.set(message.text, (hostCounts.get(message.text) ?? 0) + 1);
    }
    return [
      ...transcript.messages,
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
  const removeAcknowledgedPrompts = (): void => {
    const hostCounts = new Map<string, number>();
    for (const message of transcriptRef.current.messages) {
      if (message.role === "user") hostCounts.set(message.text, (hostCounts.get(message.text) ?? 0) + 1);
    }
    pendingPromptRef.current = pendingPromptRef.current.filter((prompt) => (hostCounts.get(prompt.submitted) ?? 0) <= prompt.hostEchoCount);
  };
  /**
   * A snapshot that completes the bootstrap is historical baseline, not a receipt
   * for a prompt sent while it was in flight. Raise those prompts' echo allowance
   * to the count the snapshot published so its rows cannot acknowledge them; their
   * real echo can only arrive in later frames, which then exceed the allowance.
   *
   * Two exceptions, both cases where the dump DOES carry this prompt's own echo:
   * - the echo arrived as a *live* frame during the snapshot, so the replay already
   *   published it. Skipped; the ack pass right after reads the post-reduce rows
   *   and settles it by count.
   * - the host journaled the prompt before cutting the dump and delivered it only
   *   inside the dump, so no live frame exists. A same-text user row whose timestamp
   *   is at or after this prompt's send time is that echo, not baseline. `message`
   *   rows carry ms directly; `custom_message`/`collab-prompt` rows (the real wire
   *   shape for a web prompt) carry an ISO outer timestamp parsed to ms, and an
   *   unparseable one is never treated as an echo. Skipped too, so the same ack pass
   *   acknowledges it and the later refusal lands on the next prompt instead of being
   *   misattributed to a prompt that was accepted.
   *   Older same-text rows still bump the allowance: V19-01 protection.
   *
   * ponytail: the discriminator is wall-clock, so a host clock AHEAD of the browser
   * can classify a historical same-text row as an echo (false ack) and a host clock
   * BEHIND leaves today's stuck-prompt behaviour. Chosen because a stuck prompt plus
   * a stranded refusal is the worse failure, and hosts are NTP-synced.
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
    const dumpedEchoes = new Map<string, number>();
    for (const entry of transcriptRef.current.entries) {
      if (entry.type === "message" && entry.message.role === "user") {
        const text = textFromContent(entry.message.content);
        dumpedEchoes.set(text, Math.max(dumpedEchoes.get(text) ?? 0, entry.message.timestamp));
        continue;
      }
      // A web prompt the host journaled before cutting the dump appears as
      // custom_message/collab-prompt. CustomMessageEntry only carries an ISO outer
      // timestamp, so convert it; an unparseable one is treated as unknown (never an
      // echo) rather than guessed — that keeps the V19-01 baseline protection.
      if (entry.type === "custom_message" && entry.customType === "collab-prompt") {
        const ms = Date.parse(entry.timestamp);
        if (Number.isNaN(ms)) continue;
        const text = textFromContent(entry.content);
        dumpedEchoes.set(text, Math.max(dumpedEchoes.get(text) ?? 0, ms));
      }
    }
    const bumped = new Map<string, number>();
    const ordinalByText = new Map<string, number>();
    for (const prompt of pendingPromptRef.current) {
      if (!prompt.preSnapshot) continue;
      if (genuinelyEchoed.has(prompt.submitted)) continue;
      if ((dumpedEchoes.get(prompt.submitted) ?? 0) >= prompt.sentAtMs) continue;
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

  const flushPendingStream = (): void => {
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
      if (renderTimerRef.current === null) renderTimerRef.current = setTimeout(flushPendingStream, 100);
      return;
    }
    flushPendingStream();
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
    if (frame.t === "entry" || frame.t === "snapshot-chunk" || (frame.t === "event" && frame.event.type === "message_end" && frame.event.message.role === "user")) removeAcknowledgedPrompts();
    if (frame.t === "error") {
      if (NON_SUBMISSION_REFUSALS.has(frame.message)) {
        const prompt = pendingPromptRef.current.find((pending) => pending.physicalConnection === physicalConnectionRef.current && !pending.refusalMessage);
        if (prompt) {
          prompt.refusalMessage = frame.message;
          if (prompt.sent) recoverRefusedPrompt(prompt);
        }
      }
      setSendError(frame.message);
    }
    if (frame.t === "bye") setSendError(frame.reason);
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
        if (!isCurrent() || socketRef.current !== socket) return;
        physicalConnectionRef.current++;
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
    const sentAtMs = Date.now();
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
      sentAtMs,
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
   * An explicit Recover click puts the refused prompt back in the composer, even if
   * the user has typed newer content: they asked for it, and the refused text was
   * otherwise unreachable. The draft they had is left in place until this replaces
   * it — the strip is the only path back to the refused prompt, so it stays until use.
   */
  const recoverRefusedPromptText = (item: RefusedRecovery): void => {
    updateDraft(item.text);
    removeRefusedRecovery(item.id);
    composerRef.current?.focus();
  };

  // Same clipboard contract as the code-block copy control: report failure rather
  // than silently doing nothing when the browser exposes no clipboard.
  const copyRefusedPromptText = async (item: RefusedRecovery): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(item.text);
      setRefusedCopyState({ id: item.id, state: "copied" });
    } catch {
      setRefusedCopyState({ id: item.id, state: "failed" });
    }
  };

  const openCommandAction = (): void => {
    setInterceptedCommand(null);
    if (modelControlsRef.current) modelControlsRef.current.open = true;
    modelInputRef.current?.focus();
    modelInputRef.current?.scrollIntoView?.({ block: "nearest" });
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
    const conversationAtResponse = conversationIdRef.current;
    void socket.send({ t: "ui-response", reqId: targetReqId, value }).then((sent) => {
      if (pendingUiResponsesRef.current.get(targetReqId) === responseToken) pendingUiResponsesRef.current.delete(targetReqId);
      if (!viewActiveRef.current || operationGenerationRef.current !== operationGeneration || connectionGenerationRef.current !== connectionGeneration || conversationIdRef.current !== conversationAtResponse) return;
      if (sent) updateTranscript({ t: "ui-request-end", reqId: targetReqId });
      else setSendError("Not connected — approval response not sent. Request remains open; retry when connected.");
    });
  };

  const handleStop = () => {
    if (transcriptRef.current.readOnly) return;
    void socketRef.current?.send({ t: "abort" });
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
    // Retired with the session: the save never left, so the pair stops here — we must
    // not restart a session under credentials the user has left, and we must not claim
    // a restart that did not happen.
    if (saved === MUTATION_CANCELLED) { setModelBusy(false); return; }
    if (!viewActiveRef.current || operationGenerationRef.current !== operationGeneration || conversationIdRef.current !== conversationAtRestart) return;
    if (!saved.ok) {
      setModelBusy(false);
      setModelMessage(saved.error.message);
      return;
    }
    metadataGenerationRef.current += 1;
    setConversation(saved.data);
    const result = await chainMutation(`conversation-lifecycle:${conversationId}`, () => api.restartConversation(conversationId));
    // Same retirement: the restart was never sent, so the pending spinner is cleared
    // and no outcome is claimed.
    if (result === MUTATION_CANCELLED) { setModelBusy(false); return; }
    if (!viewActiveRef.current || operationGenerationRef.current !== operationGeneration || conversationIdRef.current !== conversationAtRestart) return;
    setModelBusy(false);
    if (result.ok) {
      metadataGenerationRef.current += 1;
      setConversation(result.data);
      // Only adopt the server's value when the user has not edited the draft while
      // the restart was pending; a newer unsaved choice must not be clobbered.
      if (modelDraftRef.current === submittedDraft) setModelDraft(result.data.modelPreference ?? result.data.model ?? "");
      setModelMessage("Agent restarted.");
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
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{conversation?.state ?? "status unknown"}</span>
          </div>
        </div>

        <div className="conversation-header-actions">
          <button
            type="button"
            className="ghost"
            style={{ fontSize: "0.85rem" }}
            onClick={() => setShowActivity(true)}
            aria-label="Activity"
            title="Activity"
          >
            <span className="header-action-icon" aria-hidden="true">◷</span>
            <span className="header-action-label">Activity</span>
          </button>
          {agents.length > 0 && (
            <button
              type="button"
              className="ghost"
              style={{ fontSize: "0.85rem" }}
              aria-label={`Agents (${agents.length})`}
              title={`Agents (${agents.length})`}
              onClick={() => setShowSubagents(true)}
            >
              <span className="header-action-icon" aria-hidden="true">◉</span>
              <span className="header-action-label">Agents ({agents.length})</span>
            </button>
          )}
          {status === "running" && canManageConversation && canWriteToHost && !transcript.readOnly && (
            <button type="button" className="danger" aria-label="Stop" title="Stop" onClick={handleStop} style={{ padding: "4px 10px", fontSize: "0.85rem" }}>
              <span className="header-action-icon" aria-hidden="true">■</span>
              <span className="header-action-label">Stop</span>
            </button>
          )}
        </div>
      </div>
      <details className="model-controls-disclosure" ref={modelControlsRef}>
        <summary>Conversation model settings</summary>
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
      </details>
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
      {/* Two live regions must not claim opposite things here. The record's
          `starting` is the app-side process verdict for a conversation that has
          never launched (no native session, no tmux); `status` describes the live
          collab link. When the link is established the host is demonstrably
          responsive — prompts are accepted — so the idle row is the true one and
          the startup warning yields to it (see the gate below). */}
      {status === "idle" && (
        <div className="banner idle" role="status">
          <span>Connected — no turn in flight</span>
        </div>
      )}
      {status === "running" && (
        <div className="banner running" role="status">
          <span>Agent is working on a turn</span>
        </div>
      )}
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
            {savedHistory.messages.map((message) => (
              <MessageRow key={message.id} message={{ id: message.id, role: message.role, text: message.text, ...(message.toolName ? { toolName: message.toolName } : {}), ...(message.isError ? { isError: true } : {}) }} />
            ))}
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
            {attachInfo?.command ? (
              <div>
                <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>How to attach in terminal:</span>
                <pre><code>{attachInfo.command}</code></pre>
              </div>
            ) : (
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                Run <code>omp session list</code> on host machine to view active sessions.
              </p>
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

        {!isShowingSavedHistory && messages.map((message) => <MessageRow key={message.id} message={message} />)}

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
            <p style={{ marginBottom: "12px", fontSize: "0.95rem" }}>{activeUiRequest.title}</p>

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
          {interceptedCommand.availability === "app_action" && (
            <button type="button" onClick={openCommandAction}>Open model controls</button>
          )}
          <button type="button" className="primary" disabled={transcript.readOnly} onClick={sendSlashAsText}>Send as plain text anyway</button>
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
            {item.unconfirmed ? "Unconfirmed — not yet received by the host — " : "Refused — "}{item.text}
          </span>
          <span style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
            {canWriteToHost && !linkUnavailable && (
              <button type="button" className="ghost" onClick={() => recoverRefusedPromptText(item)}>Recover</button>
            )}
            <button type="button" className="ghost" onClick={() => void copyRefusedPromptText(item)}>
              {refusedCopyState?.id === item.id ? (refusedCopyState.state === "copied" ? "Copied" : "Copy failed") : "Copy"}
            </button>
            {item.unconfirmed && <button type="button" className="ghost" onClick={() => removeRefusedRecovery(item.id)}>Dismiss</button>}
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
    </div>
  );
}
