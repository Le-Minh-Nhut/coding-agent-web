import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type SavedConversationHistory } from "../api.js";
import { chainMutation, MUTATION_CANCELLED } from "../mutation-order.js";
import { parseInline, renderMarkdown } from "../sanitize.js";
import { ActivityPanel } from "./ActivityPanel.js";
import { AdvisorPanel } from "./AdvisorPanel.js";
import { ModalOverlay } from "./ModalOverlay.js";
import { RecoverySheet } from "./RecoverySheet.js";
import { NoticeRow } from "./NoticeRow.js";
import { DashboardCards } from "./DashboardCards.js";
import { AgentsCenter } from "./AgentsCenter.js";
import { AgentDetail } from "./AgentDetail.js";
import { FilesCenter } from "./FilesCenter.js";
import { VibePanel, vibeVerdictLabel } from "./VibePanel.js";
import { advisorEvidence, advisorIssues, advisorIssueViews, advisorNotesOf, standingBlockerCount, summarizeAdvisorNotes } from "../advisor.js";
import { agentCounts, agentViews, vibeWorkerIds } from "../agent-model.js";
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
import { summarizeFileChanges, pairToolArguments } from "../tool-activity.js";
import { collectChangedFiles, summarizeChangedFiles } from "../files.js";
import { canRetain, type RecoveryRecord } from "../prompt-recovery.js";
import type { AttachInstructions, Conversation, NativeModeResult, VibeStateResponse } from "@caw/contracts";

/**
 * A settled prompt record kept until explicit dismissal.
 *
 * Defined in `prompt-recovery.ts` because that module also persists it, so the
 * stored shape and the rendered shape cannot drift apart.
 */
export type RefusedRecovery = RecoveryRecord;

interface ConversationViewProps {
  conversationId: string;
  draft?: string;
  onDraftChange?: (draft: string) => void;
  onBack: () => void;
  /** App-owned recovery list and dedupe state survive Back/reopen. */
  refusedRecoveries?: RefusedRecovery[];
  onRefusedRecoveriesChange?: (next: RefusedRecovery[]) => void;
}
/**
 * The transcript row, its advisor variant and the grouping list now live in
 * `MessageRow.tsx` so level-2/level-3 screens can render rows without pulling in
 * this whole view. Re-exported here because `HistoryView` and three test files
 * import them from this path, and that import must keep working.
 */
export { MessageRow, TranscriptList } from "./MessageRow.js";
export type { DisplayMessage } from "./MessageRow.js";
import { MessageRow, TranscriptList, type DisplayMessage } from "./MessageRow.js";
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
  /**
   * Agents Center navigation (B11): `null` = closed, `undefined` = list shown,
   * an id = that agent's detail. Identity is the host's agent id, never a list
   * index, so a roster change cannot silently re-point the view at another agent.
   */
  const [agentNav, setAgentNav] = useState<{ open: boolean; selectedId: string | null }>({ open: false, selectedId: null });
  /**
   * The recovery sheet is a modal, not an inline strip.
   *
   * A record about a refused prompt used to render its COMPLETE text in the
   * conversation column, where a long prompt displaced the transcript (P1-A) in a
   * screen that is `height: 100dvh; overflow: hidden`. The records are still kept
   * whole — the sheet shows every one of them verbatim — but they no longer
   * compete with the surface the user opened the app for.
   */
  const [recoverySheetOpen, setRecoverySheetOpen] = useState(false);
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
  /** Worker ids the server proved from the journal; empty ⇒ no worker controls. */
  /**
   * Worker ids the server proved from the journal; empty ⇒ no worker controls.
   *
   * Typed `string[]` because that is what `GET /vibe` returns. The earlier
   * `readonly unknown[]` is exactly why a shape mismatch here compiled clean
   * while leaving the Kill gate permanently closed.
   */
  const [vibeWorkerIdsFromServer, setVibeWorkerIdsFromServer] = useState<readonly string[]>([]);
  const [vibeBusy, setVibeBusy] = useState(false);
  const [vibeError, setVibeError] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  /** The Files Center layer, and the path whose diff is open inside it. */
  const [showFiles, setShowFiles] = useState(false);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
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
  /**
   * Capacity, in the user's terms.
   *
   * The same ceiling the guest client enforces on retention (256 records / 1 MiB
   * of text) applies here. Hitting it refuses to RETAIN a new record — it never
   * blocks the send, and it never evicts a record the user has neither dismissed
   * nor recovered, because that eviction is the data loss this list exists to
   * prevent. The refusal is reported the same way a refusal already is: in the
   * composer's own status line, which is where the user is looking.
   */
  const [recoveryCapacityNote, setRecoveryCapacityNote] = useState<string | null>(null);
  /**
   * Retain a prompt, or refuse the retention.
   *
   * @param mustRetain the text being passed in is the ONLY remaining copy — the
   * caller is about to clear `pendingPromptRef` for it. The ceiling must not
   * evict a record the user has neither dismissed nor recovered, and refusing
   * here would destroy exactly that: at the ceiling, a late refusal would drop a
   * prompt that lives nowhere else. So this path retains past the ceiling. The
   * ceiling still refuses an ordinary voluntary retention (the send path), where
   * the text is still in the composer and nothing is lost.
   *
   * @returns whether the record is now retained.
   */
  const appendRefusedRecovery = (text: string, unconfirmed = false, mustRetain = false): boolean => {
    const list = refusedRecoveriesRef.current;
    const verdict = canRetain(list, text);
    if (!verdict.ok && !mustRetain) {
      setRecoveryCapacityNote(`Not retained: ${verdict.reason}. Copy or dismiss a prompt in Review to make room — the prompt stays in the composer.`);
      return false;
    }
    // Seed from the list so a caller-supplied list keeps unique ids across remounts.
    if (refusedIdRef.current === 0) refusedIdRef.current = list.reduce((max, item) => Math.max(max, item.id), 0);
    const next = [...list, { id: ++refusedIdRef.current, text, ...(unconfirmed ? { unconfirmed: true } : {}) }];
    refusedRecoveriesRef.current = next;
    setRefusedRecoveries(next);
    return true;
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
    const retained: typeof pending = [];
    for (const prompt of pending) {
      // B1: these prompts are about to leave the queue, so the ceiling may only
      // refuse the retention when the text still has another home — and the one
      // such home is the composer. If the box still holds exactly this text, the
      // user has not lost it and the capacity note tells them why it was not kept;
      // otherwise this is the last copy and it is retained past the ceiling.
      const stillInComposer = inputValueRef.current.trim() === prompt.submitted.trim();
      if (appendRefusedRecovery(prompt.submitted, !prompt.refusalMessage, !stillInComposer)) retained.push(prompt);
    }
    if (retained.length > 0) pendingPromptRef.current = pendingPromptRef.current.filter((prompt) => !retained.includes(prompt));
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
    // Spliced out of the pending queue just above: this is now the only copy (B1).
    appendRefusedRecovery(prompt.submitted, false, true);
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
  /**
   * Per-conversation UI state must not survive a switch (B11).
   *
   * A selected agent id, a mode, or a worker-id list from conversation A would
   * otherwise be resolved against conversation B's roster — showing, or worse
   * gating on, the wrong conversation's data. Keyed on `conversationId` so the
   * reset happens exactly when the switch is observed.
   */
  useEffect(() => {
    setAgentNav({ open: false, selectedId: null });
    // M2: the layer's pushed history entry is retired here, in the same effect that
    // closes it. Closing without retiring left a `cawAgents` entry in the session
    // history that a later Back would consume — re-opening conversation B's agents
    // layer with conversation A's `selectedId`.
    const state = typeof window !== "undefined" && window.history?.state !== null && typeof window.history?.state === "object" ? window.history.state as object : null;
    if (state !== null && ("cawAgents" in state || "cawFiles" in state || "cawMenu" in state)) {
      window.history.replaceState(null, "");
    }
    // Same for this layer and the header menu: neither belongs to the new conversation.
    setShowFiles(false);
    setOpenFilePath(null);
    setShowMenu(false);
    setRecoverySheetOpen(false);
    // M1: a capacity warning belongs to the conversation it was raised in; leaving it
    // set would show conversation A's refusal over conversation B's composer.
    setRecoveryCapacityNote(null);
    setVibeState(null);
    setVibeWorkerIdsFromServer([]);
    setVibeError(null);
    setVibeBusy(false);
  }, [conversationId]);
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
  /**
   * The one agent view model (B01/B11). Classification and the destructive-control
   * gate come from `agent-model.ts`, driven by the journal's Vibe lifecycle
   * records — never from `kind` alone and never from a display name.
   */
  /**
   * Worker ids proven by the session journal, as reported by the server.
   *
   * They cannot come from the transcript: OMP's Collab replication allowlist
   * excludes `custom` entries (`packages/coding-agent/src/collab/host.ts:103-110`),
   * and `vibe-session-lifecycle` is a `custom` entry — so this browser never sees
   * a worker record no matter how long it listens. Until the server reports them
   * this is empty, and empty means **no agent is a worker**: no Kill control is
   * offered at all, which is the honest blank rather than a guess (B01).
   */
  const agentVibes = useMemo(() => agentViews(agents, vibeWorkerIds(vibeWorkerIdsFromServer)), [agents, vibeWorkerIdsFromServer]);
  const workerCounts = useMemo(() => agentCounts(agentVibes), [agentVibes]);
  /**
   * The model the host authoritatively reported for THIS conversation, or `null`.
   *
   * `effectiveModel` is only ever set from a `welcome`/`state` frame's own
   * `state.model` (`updateTranscript`), and it is stamped with the conversation it
   * was read for — so a frame from conversation A can never print its model
   * beside conversation B's title. The record's `model`/`modelPreference` is a
   * saved launch preference, NOT a report of what is running, so it is
   * deliberately not consulted here.
   */
  const reportedModel = effectiveModel !== null && effectiveModel.conversationId === conversationId ? effectiveModel.model : null;
  const transcripts = transcript.transcripts;
  const canManageConversation = conversation?.id === conversationId && conversation.ownership === "managed";
  /**
   * Whether a native mode could be read or changed for this conversation at all.
   *
   * The bridge only exists for a session this app launched — which means a
   * recorded native session AND a verified tmux identity. Anything less has no
   * listener, so asking would only produce a refusal in the browser console that
   * looks like a failure. This is the same set of facts the server checks, read
   * from the record; the server still has the final say.
   */
  const canControlNativeModes = canManageConversation
    && conversation?.nativeSessionId !== null && conversation?.nativeSessionId !== undefined
    && conversation?.tmuxSessionId !== null && conversation?.tmuxSessionId !== undefined;
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
  /**
   * Advisor notes from the transcript **currently on screen** (B04).
   *
   * This used to read `transcript.messages` unconditionally, so saved-history mode
   * displayed live notes — two different sessions' advice in one panel. `rows` is
   * whichever source the view is rendering, so the panel and the chat can never
   * disagree about what was said.
   */
  const advisorRows = useMemo(
    () => (isShowingSavedHistory ? savedHistory?.messages ?? [] : transcript.messages),
    [isShowingSavedHistory, savedHistory, transcript.messages],
  );
  const advisorSummary = useMemo(
    () => summarizeAdvisorNotes(advisorRows.map((message) => ({ customType: message.customType, details: message.customDetails }))),
    [advisorRows],
  );
  /**
   * The same notes, tracked as issues. The lifecycle is derived from the rows that
   * follow each note: a claim of a fix reaches "verifying" and stops there, a later
   * failing run reopens it, and nothing here can manufacture a "resolved".
   */
  const advisorIssueView = useMemo(() => {
    const rows = advisorRows.map((message) => ({
      customType: message.customType,
      details: message.customDetails,
      role: message.role as string | undefined,
      text: message.text,
      isError: (message as { isError?: boolean }).isError,
    }));
    return advisorIssueViews(advisorIssues(rows), advisorEvidence(rows));
  }, [advisorRows]);
  /** Blockers still standing. A resolved or unverifiable one is not a warning. */
  const standingBlockers = useMemo(() => standingBlockerCount(advisorIssueView), [advisorIssueView]);

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

  /**
   * File-change totals for the dashboard card, and only from real tool rows.
   *
   * `TranscriptList` reads the same rows through `groupActivity`, but the card
   * needs the summary without rendering them, so the same pure module is called
   * directly over the rows currently on screen (live or saved). `summarizeFileChanges`
   * returns `null` when no row carries verified diff data — shown as `View changes`
   * rather than a zero nothing proved. Assistant prose is never consulted: a
   * sentence saying "I changed three files" is not a change record.
   */
  const dashboardFileChanges = useMemo(
    () => summarizeFileChanges(isShowingSavedHistory ? savedRows : messages),
    [isShowingSavedHistory, savedRows, messages],
  );
  /**
   * The Files Center's own data, from the SAME rows the dashboard card counts.
   * The two numbers agree BY CONSTRUCTION, not by wish: the header prints
   * `appliedFiles` (applied edits only, what `summarizeFileChanges(rows).uniqueFiles`
   * computes) while the row list ALSO shows failed edits that named a file, each
   * labelled "not counted" — so the header must keep using `appliedFiles`; switching
   * it to `summary.total` would silently make the two disagree.
   * `pairToolArguments` is required: a failed edit's `details` carries no path (OMP
   * sends `{diff:"", errorKind}`), and the path exists only in the call's arguments.
   */
  const filesRows = useMemo(() => (isShowingSavedHistory ? savedRows : messages), [isShowingSavedHistory, savedRows, messages]);
  const changedFiles = useMemo(() => collectChangedFiles(filesRows, pairToolArguments(filesRows)), [filesRows]);
  const changedFilesSummary = useMemo(() => summarizeChangedFiles(changedFiles), [changedFiles]);
  const dashboardCounts = useMemo(
    () => ({
      agents: { total: workerCounts.total, running: workerCounts.runningWorkers + workerCounts.runningSubagents },
      files: dashboardFileChanges === null
        ? null
        : { uniqueFiles: dashboardFileChanges.uniqueFiles, additions: dashboardFileChanges.additions, deletions: dashboardFileChanges.deletions },
    }),
    [workerCounts, dashboardFileChanges],
  );

  const recoverRefusedPrompt = (prompt: PendingPrompt): void => {
    pendingPromptRef.current = pendingPromptRef.current.filter((pending) => pending !== prompt);
    if (prompt.optimisticId) setOptimisticMessages((previous) => previous.filter((message) => message.id !== prompt.optimisticId));
    if (sendVersionRef.current !== prompt.draftVersion) {
      // The user has typed newer content since sending: overwriting it would destroy
      // that work and dropping the refused prompt would lose it entirely. Append the
      // refused text behind an explicit affordance instead of the composer. This
      // prompt is being removed from the pending queue just below, so this retention
      // must not be refused at the ceiling (B1).
      appendRefusedRecovery(prompt.text, false, true);
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
      // B05: the mode can be changed from the session's own terminal, so whatever
      // this view last showed may be stale the moment a fresh link is established.
      // Re-reading on (re)connect is the only way the phone reflects a change it
      // never made.
      //
      // Gated on the conversation being ours to control: an unmanaged or external
      // conversation has no bridge, and asking anyway would put a 409 in the
      // browser console on every reconnect — noise that looks like a failure and
      // is not one. One read per connection, never a poll.
      if (canControlNativeModesRef.current) void refreshVibeRef.current();
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
  /**
   * Submit a prompt, reporting whether it was actually accepted for delivery.
   *
   * The return value matters to callers that perform a second operation after a
   * prompt (the Vibe first-directive, B03): "the link was not accepting prompts"
   * must not be mistaken for "sent". Every early return therefore reports `false`
   * rather than falling off the end of a `void`.
   */
  const sendPrompt = (text: string, allowSlashCommand = false): boolean => {
    const trimmed = text.trim();
    const socket = socketRef.current;
    if (!trimmed || !socket || (status !== "idle" && status !== "running")) return false;
    if (transcriptRef.current.readOnly) {
      setSendError("Read-only view — prompt was not sent.");
      return false;
    }
    const command = findSlashCommand(trimmed);
    if (command && !allowSlashCommand) {
      setInterceptedCommand(command);
      return false;
    }
    if (sendingPromptTextsRef.current.has(trimmed)) return false;
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
          // The prompt is leaving the pending queue here, so this copy is the only
          // one left: retain past the ceiling rather than lose it (B1).
          appendRefusedRecovery(pendingPrompt.submitted, false, true);
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
        // M1: this path clears the draft directly (it cannot go through `updateDraft`,
        // which would also bump the draft version and cancel the send in flight), so it
        // must clear the capacity note itself — the note described the previous refusal
        // and the send is exactly what makes it stale.
        setRecoveryCapacityNote(null);
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
    return true;
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
    setRecoveryCapacityNote(null);
    setInterceptedCommand(null);
    onDraftChange?.(value);
  };
  const sendSlashAsText = (): void => { sendPrompt(inputValueRef.current, true); };

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

  /** Mirrors `canControlNativeModes` for the frame handler, which runs outside render. */
  const canControlNativeModesRef = useRef(false);

  /** Latest `refreshVibe`, so a reconnect can reconcile without a dependency cycle. */
  const refreshVibeRef = useRef<() => Promise<void>>(async () => {});

  /** Kept in a ref so `runVibeAction` can call the latest `sendPrompt` without re-creating. */
  const sendPromptRef = useRef<(text: string, allowSlashCommand?: boolean) => boolean>(() => false);

  /**
   * Read the native vibe state from the live process.
   *
   * A transport failure is surfaced as `available: false` with the reason — never
   * as a state — so the panel can say "could not be read" instead of showing a
   * confident "Off" it did not verify.
   */
  const refreshVibe = useCallback(async (): Promise<void> => {
    const target = conversationIdRef.current;
    // A throw here must never surface as an unhandled rejection from a frame
    // handler (this runs on every welcome). It is caught and reported as the
    // failure it is — NOT as "unavailable in this build": a transient network
    // fault and a build without the endpoint are different facts, and saying the
    // second when the first happened is the kind of mislabel this app avoids.
    let read: Awaited<ReturnType<typeof api.getVibe>> | null = null;
    if (typeof api.getVibe === "function") {
      read = await api.getVibe(target).catch((error: unknown) => ({
        ok: false as const,
        error: { code: "internal" as const, message: error instanceof Error ? error.message : String(error) },
      }));
    }
    if (read === null) {
      if (conversationIdRef.current === target) {
        setVibeWorkerIdsFromServer([]);
        setVibeState((previous) => previous ?? { available: false, reason: "This build has no vibe control endpoint.", modes: null, tools: null, model: null, thinkingLevel: null, workerIds: [] });
      }
      return;
    }
    if (conversationIdRef.current !== target) return;
    if (read.ok) {
      setVibeState(read.data);
      // The Kill gate's evidence, straight from the server's journal read. An
      // empty list is the honest blank: no agent is treated as a worker.
      setVibeWorkerIdsFromServer(read.data.workerIds);
      setVibeError(null);
      return;
    }
    // A transport failure is reported, and the worker list degrades to empty with
    // it — no Kill control survives a read we could not make.
    setVibeWorkerIdsFromServer([]);
    setVibeState({ available: false, reason: read.error?.message ?? "The control bridge could not be reached.", modes: null, tools: null, model: null, thinkingLevel: null, workerIds: [] });
  }, []);

  // Read once when the panel opens, and only then: this is a control surface, not
  // a polled readout, so it costs nothing while the user is reading the chat.
  useEffect(() => {
    if (!showVibe) return;
    // An uncontrollable conversation has no bridge to ask. Saying so locally is
    // both faster and quieter than a request whose only possible answer is a
    // refusal — and the panel renders this as unknown-with-reason, not as "off".
    if (!canControlNativeModes) {
      setVibeState({ available: false, reason: "This conversation has no app-managed OMP session, so it has no control bridge.", modes: null, tools: null, model: null, thinkingLevel: null, workerIds: [] });
      setVibeWorkerIdsFromServer([]);
      return;
    }
    void refreshVibe();
  }, [showVibe, refreshVibe, canControlNativeModes]);

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
      // B03 (the loss half): if the user switched conversations while this was in
      // flight, the UI state below belongs to a conversation nobody is looking at
      // — but a directive the user typed must never simply vanish. It is recorded
      // in the recovery list, which `App` keeps **per conversation**, so it is
      // waiting for them when they return. This is the one thing that must survive
      // the early return; everything else is correctly dropped.
      if (conversationIdRef.current !== target) {
        if (directive !== undefined && directive !== "") {
          // m1: routed through the retention helper, which allocates the id from the
          // monotonic source and applies the ceiling. A `Date.now()` id collided for
          // two same-millisecond insertions, and a colliding id deletes BOTH records
          // (`key={record.id}` and `removeRefusedRecovery` both filter by id).
          // The directive is not in the composer — the UI state below belongs to a
          // conversation nobody is looking at — so it must not be refused (B1).
          appendRefusedRecovery(directive, true, true);
        }
        return;
      }
      setVibeBusy(false);
      if (!result.ok) { setVibeError(result.error?.message ?? "The control bridge did not answer."); return; }
      const verdict: NativeModeResult = result.data;
      // The worker list comes from the server's journal read, so a transition reuses
      // what is already held rather than inventing ids from the roster.
      if (verdict.state !== null) setVibeState({ available: true, reason: null, modes: verdict.state, tools: vibeState?.tools ?? null, model: vibeState?.model ?? null, thinkingLevel: vibeState?.thinkingLevel ?? null, workerIds: vibeState?.workerIds ?? [] });
      if (!verdict.ok) { setVibeError(vibeVerdictLabel(verdict)); return; }
      void refreshVibe();
      // Only now — the mode is on, so the directive is a real director prompt.
      //
      // B03: the mode transition and the prompt delivery are two separate
      // operations, and `sendPrompt` refuses silently when the link is not
      // idle/live (or when the socket is gone). Treating its return as success is
      // how a directive could disappear while the UI said "entered". So the
      // outcome is checked and reported, and the text is handed back to the
      // composer on failure rather than dropped.
      if (directive !== undefined && directive !== "") {
        const delivered = sendPromptRef.current(directive, true);
        if (delivered !== true) {
          // B03: the mode changed but the prompt did not go out. The text is
          // recorded in the recovery list — the app's existing home for a prompt
          // the host never acknowledged — so it is visible, copyable and one tap
          // from a resend, rather than silently lost or silently resent.
          setVibeError("Vibe mode is on, but the first directive was not sent — the link was not accepting prompts. It is kept below to resend.");
          // m1: same helper, same monotonic ids, same ceiling. The composer no longer
          // holds this text, so it is retained even at the ceiling (B1).
          appendRefusedRecovery(directive, true, true);
        }
      }
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
  refreshVibeRef.current = refreshVibe;
  canControlNativeModesRef.current = canControlNativeModes;

  const handleCloseSubagents = () => {
    handleWatchTranscript(null);
    for (const request of transcriptRequestsRef.current.values()) clearTimeout(request.timer);
    transcriptRequestsRef.current.clear();
    transcriptRef.current = clearTranscriptRequests(transcriptRef.current);
    setTranscript(transcriptRef.current);
    leaveAgentsLayer({ open: false, selectedId: null });
  };

  /**
   * Push a layer entry, or REPLACE the header menu's own entry with it.
   *
   * The menu pushes an entry so browser Back closes it. When a row then opens a
   * layer that pushes its own entry, popping first would race that push — the
   * traversal completes after the new entry exists and consumes it, so the layer
   * opens and instantly vanishes (observed: the Files layer never appeared).
   * Replacing the menu's entry with the layer's keeps the stack at its original
   * depth and leaves the layer standing.
   */
  const pushLayerEntry = useCallback((state: Record<string, unknown>): void => {
    const ours = typeof window !== "undefined" && window.history?.state !== null && typeof window.history.state === "object" && "cawMenu" in window.history.state;
    if (ours) window.history.replaceState(state, "");
    else window.history.pushState(state, "");
  }, []);

  /**
   * Open the Files Center layer.
   *
   * This used to scroll the transcript to its last verified file-change row, which
   * never showed the *list* the dashboard card counts (`32 Files · +1301 −313`);
   * the card's destination is now a real screen over the conversation. The
   * conversation stays mounted underneath (`inert`), exactly like the agents
   * layer, so the draft and the scroll position survive.
   */
  const filesOpenerRef = useRef<Element | null>(null);
  const openFiles = useCallback((): void => {
    filesOpenerRef.current = document.activeElement;
    setOpenFilePath(null);
    setShowFiles(true);
    // The entry names the conversation it belongs to, so a stale one surviving a
    // conversation switch can be refused by the popstate listener.
    pushLayerEntry({ cawFiles: "list", conversationId: conversationIdRef.current });
  }, [pushLayerEntry]);

  const openFileDiff = useCallback((path: string): void => {
    // `""` is the component's "back to the list" signal, not a path.
    if (path === "") {
      const state = typeof window !== "undefined" && window.history?.state !== null && typeof window.history.state === "object"
        ? window.history.state as object
        : null;
      setOpenFilePath(null);
      // The detail entry is ours and still current: retire it. Leaving it meant the
      // next Back landed on the "list" entry, whose popstate re-opened the layer
      // instead of closing it — so the layer could never be left by Back.
      if (state !== null && "cawFiles" in state) window.history.back();
      return;
    }
    // Opened from a transcript file row, the layer is not on screen yet. Push the
    // SAME two entries the Files Center list pushes before its own rows do
    // (`openFiles` then this), so the walk is identical: Back from the diff lands on
    // the list, and Back again leaves the layer. Mounting without the "list" entry
    // put "detail" directly on the conversation, so Back skipped the list and closed
    // the layer — caught by the hierarchy spec's file-row case.
    if (!showFiles) {
      filesOpenerRef.current = document.activeElement;
      setShowFiles(true);
      setOpenFilePath(null);
      window.history.pushState({ cawFiles: "list", conversationId: conversationIdRef.current }, "");
    }
    setOpenFilePath(path);
    window.history.pushState({ cawFiles: "detail", path, conversationId: conversationIdRef.current }, "");
  }, [showFiles]);

  /**
   * Leave the files layer, retiring our own history entry when one is current.
   *
   * Same rule as the agents layer: `history.state` is read before popping, so a
   * layer this view never pushed cannot make `back()` navigate off the app.
   */
  const leaveFilesLayer = useCallback((): void => {
    const ours = typeof window !== "undefined" && window.history?.state !== null && typeof window.history?.state === "object" && "cawFiles" in (window.history.state as object);
    setShowFiles(false);
    setOpenFilePath(null);
    if (ours) window.history.back();
  }, []);

  /**
   * M3 for this layer: return focus to the opener when it closes.
   *
   * An effect on the layer's own state, so the Back button, a browser Back (which
   * goes through `onPopState`) and unmount all land in the same place. The opener
   * is a menu item that the menu has already removed, so the persistent header
   * trigger is the fallback — focus must never land on `document.body`.
   */
  useEffect(() => {
    if (showFiles) return;
    const opener = filesOpenerRef.current;
    if (opener === null) return;
    filesOpenerRef.current = null;
    const target = opener instanceof HTMLElement && opener.isConnected
      ? opener
      : document.querySelector<HTMLElement>(".header-menu-button");
    target?.focus();
  }, [showFiles]);

  /**
   * Close the header menu, retiring the history entry it pushed.
   *
   * `back()` — not `replaceState` — for the same reason `leaveFilesLayer` uses it:
   * blanking the marker leaves an entry the user can never reach, so every
   * open/dismiss cycle pushes the conversation one further Back away from the
   * user. Guarded on `history.state` being ours, because an unguarded `back()`
   * would navigate off the app once the entry is already consumed.
   *
   * `retireEntry: false` for a row that is about to push its OWN entry
   * (`pushLayerEntry`) — there, retiring by `back()` would race that push.
   */
  const closeMenu = useCallback((restoreFocus = false, retireEntry = true): void => {
    const ours = typeof window !== "undefined" && window.history?.state !== null && typeof window.history.state === "object" && "cawMenu" in window.history.state;
    setShowMenu(false);
    if (retireEntry && ours) window.history.back();
    if (restoreFocus) document.querySelector<HTMLElement>(".header-menu-button")?.focus();
  }, []);

  /**
   * Open/close the menu from the trigger, pushing the entry that makes browser
   * Back close it.
   *
   * Read through a ref rather than inside a state updater: React may invoke an
   * updater twice, and `pushState` inside one would push twice.
   */
  const menuOpenRef = useRef(false);
  menuOpenRef.current = showMenu;
  const toggleMenu = useCallback((): void => {
    if (menuOpenRef.current) {
      closeMenu();
      return;
    }
    setShowMenu(true);
    window.history.pushState({ cawMenu: true, conversationId: conversationIdRef.current }, "");
  }, [closeMenu]);

  /**
   * The menu's two real dismissal paths, neither of which existed before: a tap
   * outside it, and Escape. Both are pointer/keyboard events on `document`
   * because the menu is a disclosure, not a modal — it must not block the rest of
   * the header, it just must not outlive a tap that clearly meant to leave it.
   *
   * `closest` on the event target, never `contains` against a captured node: a
   * re-render replaces the menu element, and a stale reference would answer from a
   * node no longer on screen.
   */
  useEffect(() => {
    if (!showMenu) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".header-menu") !== null || target.closest(".header-menu-button") !== null) return;
      closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      closeMenu(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showMenu, closeMenu]);

  /**
   * The agents layer sits ON TOP of the conversation, and it participates in the
   * browser's Back stack.
   *
   * Three things are deliberate here:
   *
   *  - the state is applied SYNCHRONOUSLY before any `history.back()`, so an
   *    in-app Back control behaves exactly as it did when this was plain state
   *    (tests and users both get the transition in the same tick), and the
   *    history entry is then retired in the background;
   *  - the `popstate` listener is installed once and removed on unmount, so
   *    repeated navigation cannot accumulate listeners;
   *  - nothing here touches the socket, the transcript, or the draft. The
   *    conversation stays mounted underneath (`inert`, never unmounted), so
   *    coming back is instant and its scroll position is where it was.
   */
  /**
   * The control that opened the agents layer.
   *
   * M3: `ModalOverlay` already returns focus to its opener on close; the agents
   * layer must do the same, or a Back gesture/Press drops a keyboard user at
   * `document.body` with no way back into the header.
   */
  const agentsOpenerRef = useRef<Element | null>(null);

  const openAgents = useCallback((): void => {
    agentsOpenerRef.current = document.activeElement;
    setAgentNav({ open: true, selectedId: null });
    // M2: the pushed entry names the conversation it belongs to, so `onPopState`
    // can refuse a stale entry that survived a conversation switch.
    pushLayerEntry({ cawAgents: "list", conversationId: conversationIdRef.current });
  }, [pushLayerEntry]);

  const openAgentDetail = useCallback((id: string): void => {
    agentsOpenerRef.current = document.activeElement;
    setAgentNav({ open: true, selectedId: id });
    pushLayerEntry({ cawAgents: "detail", id, conversationId: conversationIdRef.current });
  }, [pushLayerEntry]);

  /**
   * Leave the agents layer, retiring our own history entry when one is current.
   *
   * `history.state` is read before popping: if this view never pushed an entry
   * (a Back that already consumed ours, or a host that refused `pushState`), there
   * is nothing of ours to retire and calling `back()` would navigate the user away
   * from the app entirely.
   */
  const leaveAgentsLayer = useCallback((next: { open: boolean; selectedId: string | null }): void => {
    const ours = typeof window !== "undefined" && window.history?.state !== null && typeof window.history?.state === "object" && "cawAgents" in (window.history.state as object);
    setAgentNav(next);
    if (ours) window.history.back();
  }, []);

  /**
   * M3: return focus to the opener when the layer closes.
   *
   * An effect on the layer's own state rather than a line in `leaveAgentsLayer`,
   * because closing has three paths — the Back button, a browser Back (which goes
   * through `onPopState` and never touches `leaveAgentsLayer`), and unmount. Only
   * the effect sees all of them, and `ModalOverlay` behaves the same way for the
   * recovery sheet.
   */
  useEffect(() => {
    if (agentNav.open) return;
    const opener = agentsOpenerRef.current;
    if (opener === null) return;
    agentsOpenerRef.current = null;
    // The captured opener is often a menu item, and the menu closes when the layer
    // opens — so the element is genuinely gone by now. Fall back to the header menu
    // trigger, which is persistent: focus must land somewhere real, never on body.
    const target = opener instanceof HTMLElement && opener.isConnected
      ? opener
      : document.querySelector<HTMLElement>(".header-menu-button");
    target?.focus();
  }, [agentNav.open]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent): void => {
      const state = event.state as { cawAgents?: string; id?: string; cawFiles?: string; path?: string; cawMenu?: true; conversationId?: string } | null;
      if (state !== null && typeof state === "object" && "cawAgents" in state) {
        // M2: an entry pushed by a different conversation is not ours to honour —
        // acting on it would show conversation A's selected agent against B's roster.
        if (typeof state.conversationId === "string" && state.conversationId !== conversationIdRef.current) return;
        setAgentNav({ open: true, selectedId: state.cawAgents === "detail" && typeof state.id === "string" ? state.id : null });
        return;
      }
      if (state !== null && typeof state === "object" && "cawFiles" in state) {
        // Same stale-entry rule: opening conversation B must not answer a Back to
        // conversation A's files layer.
        if (typeof state.conversationId === "string" && state.conversationId !== conversationIdRef.current) return;
        setShowFiles(true);
        setOpenFilePath(state.cawFiles === "detail" && typeof state.path === "string" ? state.path : null);
        return;
      }
      // A menu entry is answered by CLOSING the menu, never by changing what the
      // conversation shows — Back out of the menu must leave the screen as it was.
      if (state !== null && typeof state === "object" && "cawMenu" in state) {
        if (typeof state.conversationId === "string" && state.conversationId !== conversationIdRef.current) return;
        setShowMenu(true);
        return;
      }
      // Back past our own entries: the conversation is the screen underneath.
      setAgentNav({ open: false, selectedId: null });
      setShowFiles(false);
      setOpenFilePath(null);
      setShowMenu(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  /**
   * M2 (unmount): retire a layer entry this view pushed before it goes away.
   *
   * Without this, closing the conversation with the layer open leaves a `cawAgents`
   * entry in the session history; the next Back anyone performs consumes it and
   * re-opens an agents layer for a conversation that is no longer mounted.
   */
  useEffect(() => () => {
    const state = typeof window !== "undefined" && window.history?.state !== null && typeof window.history?.state === "object" ? window.history.state as object : null;
    if (state !== null && ("cawAgents" in state || "cawFiles" in state || "cawMenu" in state)) {
      window.history.replaceState(null, "");
    }
  }, []);

  return (
    <div className="conversation-screen">
      {/* The conversation column is made `inert` while the agents layer is open:
          one viewport, one interactive screen. `inert` (not `aria-hidden`) removes
          the covered subtree from the accessibility tree AND from tab order, which
          is what a full-viewport overlay actually means. */}
      <div className="conversation-column" inert={agentNav.open || showFiles}>
      {/* Header: one row. Back, title, one status line, Stop while running, and
          the overflow menu. Everything secondary lives in the menu. */}
      <div className="app-header">
        <div className="conversation-header-title">
          <button type="button" className="ghost header-icon-button" onClick={onBack} title="Back" aria-label="Back">
            ←
          </button>
          <div className="conversation-header-copy">
            <h3>{conversation?.title ?? "Conversation"}</h3>
            {/* One status line, one fact: the live link's state.
                The record's `state` and the link disagree only while one is
                stale, and the link is the one that can be verified right now — a
                healthy link proves the host is answering, which supersedes a
                stored `starting`. Printing both produced `idle · idle`: the same
                fact twice, in the width a transcript row needs. The record's own
                state stays available in the overflow menu, and a saved transcript
                states its own case in the transcript banner.
                The model is appended ONLY when the host authoritatively reported
                one for THIS conversation (`effectiveModel`, set from the welcome
                frame's own `state.model`). A model name is never assumed from the
                record's saved preference, and when it is unknown nothing is
                printed — an invented model is worse than a missing one. */}
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
              {reportedModel !== null && <span className="header-status-model"> · {reportedModel}</span>}
            </span>
          </div>
        </div>

        <div className="conversation-header-actions">
          {/* Chips sit in the fixed action cluster, not inside the title block: the
              title ellipsises against a fixed-width cluster instead of competing
              with the chips for the same width. They cost no vertical space — the
              row is already 44px tall from the buttons beside them. */}
          <div className="header-chips">
            {/* The Adv chip is rendered ONLY for a recorded blocker.
                A count of historical notes is not a warning: nothing on this
                transport knows whether the advisor is enabled or running
                (`apps/web/src/advisor.ts:39-47`), so a standing `Adv 3` reads as
                "the advisor is alarming right now" — a claim this data cannot
                support. The count stays reachable in the menu's Advisor entry, so
                no information is lost by hiding the chip. */}
            {standingBlockers > 0 && (
              <button
                type="button"
                className="mode-chip mode-chip--alert"
                aria-label={`${standingBlockers} advisor blocker${standingBlockers === 1 ? "" : "s"} still open among ${advisorSummary.notes.length} note${advisorSummary.notes.length === 1 ? "" : "s"}. Open the advisor panel.`}
                title={`${standingBlockers} open advisor blocker${standingBlockers === 1 ? "" : "s"}; ${advisorSummary.notes.length} note${advisorSummary.notes.length === 1 ? "" : "s"} recorded`}
                onClick={() => setShowAdvisor(true)}
              >
                Adv ⚠{standingBlockers > 1 ? ` ${standingBlockers}` : ""}
              </button>
            )}
            {/* Rendered only when the mode is known ON. An "off" mode is not worth
                a permanent chip — it is the default. */}
            {vibeState?.available === true && vibeState.modes?.vibe.status === "active" && (
              <button
                type="button"
                className="mode-chip mode-chip--on"
                // B11: counts **verified workers**, not the whole agent roster.
                // The old label called every agent a worker, which is how a
                // single subagent came to read as "1 worker".
                aria-label={`Vibe mode is on${workerCounts.workers > 0 ? `, ${workerCounts.workers} verified worker${workerCounts.workers === 1 ? "" : "s"}` : ""}. Open the vibe panel.`}
                onClick={() => setShowVibe(true)}
              >
                Vibe ●{workerCounts.workers > 0 ? ` ${workerCounts.workers}` : ""}
              </button>
            )}
          </div>
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
            onClick={toggleMenu}
          >
            <span aria-hidden="true">⋯</span>
          </button>
          {showMenu && (
            // A disclosure of plain buttons, deliberately not `role="menu"`:
            // menu semantics promise roving tabindex and arrow-key navigation,
            // which this does not implement (Tab is the only way through, as in
            // any disclosure). Claiming the role would be an accessibility lie.
            <div className="header-menu" id="conversation-actions-menu" aria-label="Conversation actions">
              <div className="header-menu-group">
                <span className="header-menu-heading">Go to</span>
                <button type="button" onClick={() => { closeMenu(); setShowActivity(true); }}>
                  Activity
                </button>
                {/* The three dashboard cards are the primary way to these places, but
                    they scroll away with the transcript and collapse to two columns on
                    the narrowest phones — so each destination also lives here, where it
                    is reachable at any scroll position and any width. */}
                <button type="button" onClick={() => { closeMenu(false, false); openFiles(); }}>
                  Files
                </button>
                <button type="button" aria-label={`Agents (${agents.length})`} onClick={() => { closeMenu(false, false); openAgents(); }}>
                  Agents ({agents.length})
                </button>
                {refusedRecoveries.length > 0 && (
                  <button type="button" aria-label={`Review ${refusedRecoveries.length} unacknowledged prompts`} onClick={() => { closeMenu(); setRecoverySheetOpen(true); }}>
                    Review prompts ({refusedRecoveries.length})
                  </button>
                )}
              </div>
              <div className="header-menu-group">
                <span className="header-menu-heading">Panels</span>
                {/* Advisor and Vibe are always reachable from the menu, not only
                    through a header chip: the Adv chip appears only when a blocker
                    was recorded (the count moved here so nothing is lost), so
                    without these entries a user with no blocker yet would have no
                    way to open either panel and read where its controls live. */}
                <button
                  type="button"
                  aria-label={`Advisor${advisorSummary.notes.length > 0 ? ` (${advisorSummary.notes.length} recorded note${advisorSummary.notes.length === 1 ? "" : "s"})` : ""}`}
                  onClick={() => { closeMenu(); setShowAdvisor(true); }}
                >
                  Advisor{advisorSummary.notes.length > 0 ? ` (${advisorSummary.notes.length})` : ""}
                </button>
                <button type="button" onClick={() => { closeMenu(); setShowVibe(true); }}>
                  Vibe mode
                </button>
                <button
                  type="button"
                  className="header-menu-item"
                  onClick={() => { closeMenu(); setModelSheetOpen(true); }}
                >
                  Model settings
                </button>
              </div>
              {/* Session is last and visually separated: both of its entries end
                  something, and neither belongs next to a navigation row. */}
              <div className="header-menu-group header-menu-group--session">
                <span className="header-menu-heading">Session</span>
                {/* Handoff is offered only where it can actually run. A conversation
                    this app does not own gets the control disabled with the reason
                    printed below, never an enabled action that fails. */}
                {handoffOffered && (
                  <button
                    type="button"
                    className="header-menu-item"
                    disabled={handoffBusy || handoffReason !== null}
                    title={handoffReason ?? "Compact this session's context in place"}
                    onClick={() => { closeMenu(); setHandoffConfirming((value) => !value); }}
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
                    onClick={() => { closeMenu(); setStopSessionConfirming((value) => !value); }}
                  >
                    {stopSessionBusy ? "Stopping session…" : "Stop OMP session"}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Dashboard: three compact navigation summaries, bounded and scrolling away
          with the transcript. They are the *only* new permanent row on this screen. */}
      <DashboardCards
        counts={dashboardCounts}
        onOpenAgents={openAgents}
        onOpenFiles={openFiles}
        onOpenActivity={() => setShowActivity(true)}
      />
      {/* ONE compact summary row for refused prompts, never their text (P1-A). A
          long unconfirmed prompt used to render in full here, inside a screen that
          is `height: 100dvh; overflow: hidden` — so the transcript became
          unreachable until a reload. The count is the number of records; each
          full prompt lives in the sheet, one tap away. */}
      {refusedRecoveries.length > 0 && (
        <button type="button" className="recovery-summary" onClick={() => setRecoverySheetOpen(true)}>
          <span className="recovery-summary-glyph" aria-hidden="true">⚠</span>
          <span className="recovery-summary-text">
            {refusedRecoveries.length} prompt{refusedRecoveries.length === 1 ? "" : "s"} need{refusedRecoveries.length === 1 ? "s" : ""} review
          </span>
          <span className="recovery-summary-action" aria-hidden="true">Review ›</span>
        </button>
      )}
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
      {/* One live protocol notice, rendered by its level (never by its text):
          a routine `info` join is a quiet muted line, `warning` keeps its row, and
          `error` keeps `role="alert"`. Each clamps to one/two rendered lines with a
          `Show more` control, so the full host message stays reachable without a
          5,000-character notice occupying the screen. The row is keyed by the
          message, so a new notice starts collapsed rather than inheriting the
          previous one's expansion. */}
      {transcript.notice && <NoticeRow key={transcript.notice.message} notice={transcript.notice} />}
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
            <TranscriptList rows={savedRows} onOpenFile={openFileDiff} />
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

        {!isShowingSavedHistory && <TranscriptList rows={messages} onOpenFile={openFileDiff} />}

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
      {/* The recovery records themselves live in the bounded sheet, opened from the
          summary row above (or the overflow menu). They are NO LONGER rendered here:
          rendering their complete text in this column is exactly what made a long
          prompt displace the transcript (P1-A). Every record, and every one of its
          controls, is one tap away and nothing was dropped — the sheet shows each
          prompt verbatim, with the same honest status wording and the same
          Recover/Copy/Dismiss actions, offered under the same gates: Copy is local,
          so it is always available; Recover writes the composer draft, so it is
          offered only while the composer is writable. */}
      {recoverySheetOpen && refusedRecoveries.length > 0 && (
        <RecoverySheet
          records={refusedRecoveries}
          copyState={refusedCopyState}
          canRecover={canWriteToHost && !linkUnavailable && !transcript.readOnly}
          onCopy={(record) => void copyRefusedPromptText(record)}
          onRecover={(record) => recoverRefusedPromptText(record)}
          onDismiss={(record) => removeRefusedRecovery(record.id)}
          onClose={() => setRecoverySheetOpen(false)}
        />
      )}
      {canWriteToHost && !linkUnavailable && (
      <form onSubmit={handleSendPrompt} className="composer-container">
        <textarea
          className="composer-input"
          placeholder={transcript.readOnly ? "Read-only — not sent" : status === "running" ? "Turn in flight — send a follow-up…" : "Send a follow-up…"}
          value={inputText}
          ref={composerRef}
          onChange={(event) => updateDraft(event.target.value)}
          disabled={transcript.readOnly || status === "disconnected" || status === "unknown" || status === "connecting" || status === "reconnecting"}
          rows={1}
          /* Nits: the visible hint and the accessible name are the SAME string in
             every state. They previously disagreed ("Send a follow-up…" shown,
             "Send instructions to agent" announced) — two names for one control. */
          aria-label={transcript.readOnly ? "Read-only — not sent" : status === "running" ? "Turn in flight — send a follow-up…" : "Send a follow-up…"}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { setTimeout(() => { composingRef.current = false; }, 0); }}
          onKeyDown={(event) => {
            if (shouldSubmitOnEnter(event, composingRef.current)) {
              event.preventDefault();
              handleSendPrompt(event);
            }
          }}
        />
        {/* An icon control with an accessible name, not a wider "Send" label: the
            composer is single-line on a phone and the button must not steal width
            from the text. `aria-label` is what assistive tech announces, and the
            `title` gives the same name to a pointer user. */}
        <button
          type="submit"
          className="primary composer-send"
          aria-label="Send"
          title="Send"
          disabled={transcript.readOnly || !inputText.trim() || status === "disconnected" || status === "unknown" || status === "connecting" || status === "reconnecting"}
        >
          <span aria-hidden="true">↑</span>
        </button>
      {sendError && <div className="banner unknown" role="alert">{sendError}</div>}
      </form>
      )}
      {/* M1: a sibling of the form, not a child. Inside the form it rendered only
          while `canWriteToHost && !linkUnavailable`, so a refusal raised in
          read-only or saved mode was announced to nobody; and it was never cleared,
          so it outlived the condition it described. It is now cleared by the same
          three events that make it stale: a new draft (`updateDraft`), a send that
          emptied the draft, and a conversation switch.
          Known residual, measured rather than assumed: every retention refusal
          currently originates in `promoteUnconfirmedPending`, which runs from effect
          cleanups — so on a switch this state is cleared in the same commit and on
          unmount there is no commit, and the banner does not reach a paint today.
          The clears are kept because each is correct for any future caller that
          refuses while mounted; see the retention contract for the user-visible
          consequence. */}
      {recoveryCapacityNote && !agentNav.open && (
        <div className="banner warning" role="status">{recoveryCapacityNote}</div>
      )}

      </div>
      {/* end .conversation-column — the header, dashboard, transcript and composer
          above are its children; the agents layer below is its SIBLING, not a flex
          child under the composer (that was P1-B). */}
      {/* Agents — a genuine level-2/level-3 screen, not a sibling of the composer.
          It is a fixed, own-scrolling, full-viewport layer painted on the app
          background, so only the ACTIVE screen occupies the content viewport. The
          conversation stays mounted underneath (marked `inert` above), which is why
          returning is instant and the socket, transcript, draft and scroll position
          all survive. The destructive/read-only gates below are the ones that were
          already in force; nothing about them changed. */}
      {agentNav.open && (
        <div className="agents-layer">
          {(() => {
            const selected = agentNav.selectedId === null ? null : agentVibes.find((view) => view.id === agentNav.selectedId) ?? null;
            // An agent that left the roster while its detail was open: say so rather
            // than silently dropping back to the list, which would look like a bug.
            const vanished = agentNav.selectedId !== null && selected === null;
            if (vanished) {
              return (
                <div className="agents-screen" role="region" aria-label="Agent detail unavailable">
                  <header className="agents-header">
                    <button type="button" className="ghost header-icon-button" aria-label="Back to Agents" onClick={() => leaveAgentsLayer({ open: true, selectedId: null })}>←</button>
                    <h3>Agent unavailable</h3>
                  </header>
                  <p className="agents-empty">This agent is no longer in the host's roster, so its detail cannot be shown.</p>
                </div>
              );
            }
            return selected === null ? (
              <AgentsCenter
                views={agentVibes}
                activity={transcript.agentActivity}
                onSelect={openAgentDetail}
                onBack={handleCloseSubagents}
              />
            ) : (
              <AgentDetail
                view={selected}
                activity={transcript.agentActivity[selected.id]}
                transcript={transcripts[selected.id]}
                transcriptError={transcriptErrors[selected.id]}
                loading={loadingAgentIds.includes(selected.id)}
                onFetchTranscript={handleFetchTranscript}
                onWatchAgent={handleWatchTranscript}
                // Same gate the Vibe panel applies: a destructive control is not
                // offered where the host would refuse it.
                readOnly={transcript.readOnly || linkAccess === "view" || !canManageConversation}
                onBack={() => leaveAgentsLayer({ open: true, selectedId: null })}
                onKillWorker={killWorker}
              />
            );
          })()}
        </div>
      )}
      {/* The Files Center, a sibling level-2 layer exactly like the agents layer:
          fixed, own-scrolling, painted on the app background, with the conversation
          kept mounted and `inert` underneath. `FilesCenter` owns its own
          `.files-layer` wrapper, so none is added here. */}
      {showFiles && (
        <FilesCenter
          files={changedFiles}
          summary={changedFilesSummary}
          windowNote="Edits observed in this conversation's transcript — not the git working tree. Only the loaded history window is covered (paged at 500 entries), so older edits may be outside it."
          onOpenFile={openFileDiff}
          onBack={leaveFilesLayer}
          openPath={openFilePath}
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
          issues={advisorIssueView}
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
          // B01: the panel receives the classified views, never the raw roster.
          workers={agentVibes}
          onEnter={(directive) => runVibeAction("enter", directive)}
          onExit={() => runVibeAction("exit")}
          onKillWorker={killWorker}
          onOpenWorkers={() => { setShowVibe(false); openAgents(); }}
          onClose={() => setShowVibe(false)}
        />
      )}
    </div>
  );
}
