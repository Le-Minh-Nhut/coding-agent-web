import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { SendHorizontal, Square } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ConnectionPhase, GuestClient, UnconfirmedPrompt } from "../../lib/client";
import { isPromptRejection } from "../../lib/client";

export interface ComposerProps {
  client: GuestClient;
  phase: ConnectionPhase;
  readOnly: boolean;
  /** Pending host-side UI request this guest can answer. */
  uiRequest: CollabUiRequest | null;
  /** Host agent turn in flight. */
  working: boolean;
  /** App-owned draft, retained across client replacement. */
  queuedMessageCount: number;
  draft: string;
  onDraftChange(text: string): void;
}

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with shell.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;

function autosize(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "0px";
  const max = MAX_ROWS * LINE_PX + PAD_Y;
  el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
  el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

/**
 * Decides whether an Enter keydown should commit the composer. Returns `false` while an IME
 * composition is active so the keystroke confirms the composition instead of submitting.
 * `nativeEvent.isComposing` covers most browsers; `composing` bridges WebKit, which fires the
 * confirming Enter keydown *after* `compositionend`.
 */
export function shouldSubmitOnEnter(
  e: KeyboardEvent<HTMLTextAreaElement>,
  composing: boolean,
): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  return !(e.nativeEvent.isComposing || composing);
}

/**
 * Tracks IME composition state via a ref the keydown handler reads synchronously. The
 * `compositionend` reset is deferred a tick because WebKit dispatches the confirming Enter
 * keydown after `compositionend`, when `nativeEvent.isComposing` is already `false`.
 */
function useCompositionGuard(): {
  composingRef: RefObject<boolean>;
  onCompositionStart(): void;
  onCompositionEnd(): void;
} {
  const composingRef = useRef(false);
  const onCompositionStart = useCallback((): void => {
    composingRef.current = true;
  }, []);
  const onCompositionEnd = useCallback((): void => {
    setTimeout(() => {
      composingRef.current = false;
    }, 0);
  }, []);
  return { composingRef, onCompositionStart, onCompositionEnd };
}

interface AskEditorProps {
  prefill: string | undefined;
  onSubmit(value: string): void;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ prefill, onSubmit }: AskEditorProps): ReactNode {
  const [draft, setDraft] = useState(prefill ?? "");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const { composingRef, onCompositionStart, onCompositionEnd } =
    useCompositionGuard();

  useLayoutEffect(() => {
    autosize(taRef.current);
  }, [draft]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (shouldSubmitOnEnter(e, composingRef.current)) {
      e.preventDefault();
      onSubmit(draft);
    }
  };

  return (
    <div className="sh-composer-inner">
      <textarea
        ref={taRef}
        className="sh-composer-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        placeholder="type your response…"
        rows={1}
        spellCheck={false}
      />
      <div className="sh-composer-actions">
        <button
          type="button"
          className="sh-btn sh-btn-primary"
          onClick={() => onSubmit(draft)}
          title="submit response"
        >
          <SendHorizontal size={12} />{" "}
          <span className="sh-btn-label">Submit</span>
        </button>
      </div>
    </div>
  );
}

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
export const Composer = memo(function Composer({
  client,
  phase,
  readOnly,
  uiRequest,
  working,
  queuedMessageCount,
  draft: text,
  onDraftChange,
}: ComposerProps): ReactNode {
  const setText = onDraftChange;
	const [sendError, setSendError] = useState<string | null>(null);
	const [uiResponseError, setUiResponseError] = useState<string | null>(null);
	const [unconfirmedPrompts, setUnconfirmedPrompts] = useState<readonly UnconfirmedPrompt[]>(() => client.getSnapshot?.().unconfirmedPrompts ?? []);
  const [localUnconfirmed, setLocalUnconfirmed] = useState<UnconfirmedPrompt[]>([]);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const localUnconfirmedRef = useRef<UnconfirmedPrompt[]>([]);
  localUnconfirmedRef.current = localUnconfirmed;
	const currentClientRef = useRef(client);
	currentClientRef.current = client;
  const recoveredDraftsRef = useRef(new Map<number, string>());
  const recoveringRef = useRef(new Set<number>());
  const taRef = useRef<HTMLTextAreaElement | null>(null);
	const textRef = useRef(text);
	textRef.current = text;
  const sendingClientRef = useRef<GuestClient | null>(null);
  const answeringClientRef = useRef<GuestClient | null>(null);
  const { composingRef, onCompositionStart, onCompositionEnd } =
    useCompositionGuard();
  useEffect(() => {
    if (!client?.getSnapshot || !client?.subscribe) return;
    let lastNoticeId = client.getSnapshot().notices.at(-1)?.id ?? 0;
    return client.subscribe(() => {
      const snap = client.getSnapshot();
      if (snap.unconfirmedPrompts) {
        setUnconfirmedPrompts(snap.unconfirmedPrompts);
      }
      const currentMaxId = snap.notices.at(-1)?.id ?? 0;
      if (currentMaxId < lastNoticeId) {
        lastNoticeId = currentMaxId;
      }
      const newNotices = snap.notices.filter((n) => n.id > lastNoticeId);
      if (newNotices.length > 0) {
        lastNoticeId = newNotices[newNotices.length - 1].id;
        const promptError = newNotices.find((n) => n.level === "error" && isPromptRejection(n.message));
        if (promptError) setSendError(promptError.message);
      }
    });
  }, [client]);
  useEffect(() => () => {
    client.releaseRecoveredPrompts?.([...recoveredDraftsRef.current.keys()]);
  }, [client]);

  const live = phase === "live";
  const canPrompt = live && !readOnly;
  const busy = working;
  const queued = queuedMessageCount;
  const canSend = canPrompt && text.trim().length > 0;

  useLayoutEffect(() => {
    autosize(taRef.current);
  }, [text, uiRequest?.reqId]);

  const send = useCallback((): void => {
    const submitted = text.trim();
    if (!submitted || !live || readOnly || sendingClientRef.current === client) return;
    sendingClientRef.current = client;
    const sendingClient = client;
    const recovered = activeUnconfirmed;
    void Promise.resolve(sendingClient.sendPrompt(submitted)).then(accepted => {
      if (currentClientRef.current !== sendingClient) return;
      if (!accepted) { setSendError("prompt not sent — press send to retry"); return; }
      // Dispatch means draft is no longer only copy of recovered prompts it carried.
      for (const id of recoveredDraftsRef.current.keys()) {
        const prompt = recovered.find(item => item.id === id);
        if (prompt && ("\n" + submitted + "\n").includes("\n" + prompt.text + "\n")) {
          sendingClient.dismissPrompt(id);
          recoveredDraftsRef.current.delete(id);
          recoveringRef.current.delete(id);
        }
      }
      if (textRef.current === submitted) setText("");
      setSendError(null);
    }, () => { if (currentClientRef.current === sendingClient) setSendError("prompt not sent — press send to retry"); })
      .finally(() => { if (currentClientRef.current === sendingClient && sendingClientRef.current === sendingClient) sendingClientRef.current = null; });
  }, [client, live, readOnly, text]);

  const submitUiResponse = useCallback((reqId: number, value?: string): void => {
    if (answeringClientRef.current === client) return;
    answeringClientRef.current = client;
    setUiResponseError(null);
    const answeringClient = client;
    void Promise.resolve(answeringClient.sendUiResponse(reqId, value)).then(accepted => {
      if (currentClientRef.current === answeringClient && !accepted) setUiResponseError("response not sent — retry or check connection");
    }, () => { if (currentClientRef.current === answeringClient) setUiResponseError("response not sent — retry or check connection"); })
      .finally(() => { if (currentClientRef.current === answeringClient && answeringClientRef.current === answeringClient) answeringClientRef.current = null; });
  }, [client]);

	const handleRecover = (prompt: UnconfirmedPrompt): void => {
    if (prompt.status === "recovered" || recoveringRef.current.has(prompt.id)) return;
		const currentDraft = text;
		const recoveredDraft = currentDraft.trim() === "" ? prompt.text : `${currentDraft}\n${prompt.text}`;
		recoveringRef.current.add(prompt.id);
		recoveredDraftsRef.current.set(prompt.id, recoveredDraft);
		setText(recoveredDraft);
		client.markPromptRecovered?.(prompt.id);
	};


  const handleCopy = async (prompt: UnconfirmedPrompt): Promise<void> => {
    try {
      await navigator.clipboard.writeText(prompt.text);
      setCopiedId(prompt.id);
      setTimeout(() => setCopiedId((id) => (id === prompt.id ? null : id)), 1500);
    } catch {
      setSendError("Clipboard unavailable; select and copy prompt text manually.");
    }
  };

  const handleDismiss = (id: number): void => {
    recoveringRef.current.delete(id);
    if (client.dismissPrompt) client.dismissPrompt(id);
    else setLocalUnconfirmed((prev) => prev.filter((p) => p.id !== id));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (shouldSubmitOnEnter(e, composingRef.current)) {
      e.preventDefault();
      send();
    }
  };

  if (uiRequest && canPrompt) {
    return (
      <div className="sh-composer sh-composer-ask">
        <div className="sh-ask-title">{uiRequest.title}</div>
        {uiRequest.kind === "select" ? (
          <div className="sh-ask-options">
            {uiRequest.options.map((option, index) => {
              const label = typeof option === "string" ? option : option.label;
              const checked =
                uiRequest.checkedIndices?.includes(index) ?? false;
              return (
                <button
                  key={`${uiRequest.reqId}-${index}-${label}`}
                  type="button"
                  className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
                  onClick={() => submitUiResponse(uiRequest.reqId, label)}
                >
                  <span className="sh-ask-option-marker">
                    {uiRequest.selectionMarker === "checkbox"
                      ? checked
                        ? "☑"
                        : "☐"
                      : checked
                        ? "◉"
                        : "○"}
                  </span>
                  <span className="sh-ask-option-copy">
                    <span className="sh-ask-option-label">{label}</span>
                    {typeof option !== "string" && option.description && (
                      <span className="sh-ask-option-description">
                        {option.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <AskEditor
            key={uiRequest.reqId}
            prefill={uiRequest.prefill}
            onSubmit={(value) => submitUiResponse(uiRequest.reqId, value)}
          />
        )}
        <div className="sh-composer-actions sh-ask-actions">
          <button
            type="button"
            className="sh-btn"
            onClick={() => submitUiResponse(uiRequest.reqId)}
          >
            Cancel
          </button>
          {uiResponseError && (
            <span className="sh-send-error" role="status">
              {uiResponseError}
            </span>
          )}
          {busy && (
            <button
              type="button"
              className="sh-btn sh-btn-stop"
              onClick={() => {
                void Promise.resolve(client.sendAbort()).then(
                  (sent) => {
                    if (!sent) setUiResponseError("stop request not sent — connection lost or offline");
                  },
                  () => setUiResponseError("stop request not sent — connection lost or offline"),
                );
              }}
              disabled={!live}
              title="stop the current turn"
            >
              <Square size={11} /> <span className="sh-btn-label">Stop</span>
            </button>
          )}
        </div>
      </div>
    );
  }

	const activeUnconfirmed = client.getSnapshot?.().unconfirmedPrompts ?? localUnconfirmed;
	// Present means exact contiguous whole-line block; edits elsewhere preserve it, deletion re-enables Recover, and substrings do not count.
	const blockPresent = (draft: string, text: string): boolean => ("\n" + draft + "\n").includes("\n" + text + "\n");
	const visibleRecoveries = activeUnconfirmed.filter(p => p.status !== "recovered" && !blockPresent(text, p.text));

  return (
    <div className="sh-composer">
      {visibleRecoveries.length > 0 && (
        <div className="sh-recoverable-prompts">
          {visibleRecoveries.map((sub) => (
            <div
              key={sub.id}
              className={`sh-recoverable-prompt${sub.status === "refused" ? " sh-recoverable-prompt-refused" : ""}`}
              role="status"
            >
				<span className="sh-recoverable-text" title={sub.text}>
					{sub.status === "echoed" ? "Echoed by host — may be yours or another guest's; receipt not confirmed. " : sub.status === "refused" ? "Refused — " : sub.status === "recovered" ? "Recovered — " : "Unconfirmed — "}
					{sub.text}
					{sub.roomId && <small> · room {sub.roomId}{sub.sessionId ? ` / session ${sub.sessionId}` : ""}</small>}
				</span>
				<span className="sh-recoverable-actions">
                {sub.status !== "recovered" && <button type="button" className="sh-btn" onClick={() => handleRecover(sub)}>Recover</button>}
					<button type="button" className="sh-btn" onClick={() => void handleCopy(sub)}>{copiedId === sub.id ? "Copied" : "Copy"}</button>
					<button type="button" className="sh-btn" onClick={() => handleDismiss(sub.id)}>Dismiss</button>
				</span>
            </div>
          ))}
        </div>
      )}
      <div className="sh-composer-inner">
        <textarea
          ref={taRef}
          className="sh-composer-input"
          value={text}
          onChange={(e) => {
            const nextText = e.target.value;
            for (const prompt of activeUnconfirmed) {
              if (prompt.status === "recovered" && !blockPresent(nextText, prompt.text)) {
                recoveringRef.current.delete(prompt.id);
                recoveredDraftsRef.current.delete(prompt.id);
                client.markPromptUnrecovered?.(prompt.id);
              }
            }
            setText(nextText);
            if (sendError !== null) setSendError(null);
          }}
          onKeyDown={onKeyDown}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          placeholder={
            readOnly
              ? "Read-only session — watching only"
              : live
                ? "Prompt the host agent…"
                : "Waiting for the session…"
          }
          disabled={!canPrompt}
          rows={1}
          spellCheck={false}
        />
        <div className="sh-composer-actions">
          {sendError && (
            <span className="sh-send-error" role="status">
              {sendError}
            </span>
          )}
          {busy && queued > 0 && (
            <span className="sh-queued">
              <span className="sh-queued-label">queued </span>×{queued}
            </span>
          )}
          {busy && !readOnly && (
            <button
              type="button"
              className="sh-btn sh-btn-stop"
              onClick={() => {
                void Promise.resolve(client.sendAbort()).then(
                  (sent) => {
                    if (!sent) setSendError("stop request not sent — connection lost or offline");
                  },
                  () => setSendError("stop request not sent — connection lost or offline"),
                );
              }}
              disabled={!live}
              title="stop the current turn"
            >
              <Square size={11} /> <span className="sh-btn-label">Stop</span>
            </button>
          )}
          <button
            type="button"
            className="sh-btn sh-btn-primary"
            onClick={send}
            disabled={!canSend}
            title="send (Enter)"
          >
            <SendHorizontal size={12} />{" "}
            <span className="sh-btn-label">Send</span>
          </button>
        </div>
      </div>
    </div>
  );
});
