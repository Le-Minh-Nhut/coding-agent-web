import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { SendHorizontal, Square } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ConnectionPhase, GuestClient } from "../../lib/client";

export interface ComposerProps {
  client: GuestClient;
  phase: ConnectionPhase;
  readOnly: boolean;
  /** Pending host-side UI request this guest can answer. */
  uiRequest: CollabUiRequest | null;
  /** Host agent turn in flight. */
  working: boolean;
  /** Prompts queued behind the running turn. */
  queuedMessageCount: number;
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
}: ComposerProps): ReactNode {
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  /** True from the first press until that send settles: see the re-entry guard in `send`. */
  const sendingRef = useRef(false);
  const { composingRef, onCompositionStart, onCompositionEnd } =
    useCompositionGuard();

  const live = phase === "live";
  const canPrompt = live && !readOnly;
  const busy = working;
  const queued = queuedMessageCount;
  const canSend = canPrompt && text.trim().length > 0;

  useLayoutEffect(() => {
    autosize(taRef.current);
  }, [text, uiRequest?.reqId]);

  const send = useCallback((): void => {
    const trimmed = text.trim();
    if (!trimmed || !live || readOnly) return;
    // One submission at a time: the draft now survives until delivery is known, so
    // `canSend` stays true for the whole round trip and a second Enter (or a click on
    // Send) would queue the same prompt twice. The guard, not a timer, makes the
    // second press a no-op, and is released when the send settles so a refusal can be
    // retried.
    if (sendingRef.current) return;
    sendingRef.current = true;
    // Clear only once delivery is known: `sendPrompt` resolves true only when the
    // frame actually reaches the wire (or the queue flushed to it), and false when
    // it was refused or dropped by a terminal close — so a draft is never destroyed
    // by a frame that will not be sent.
    const submitted = trimmed;
    void Promise.resolve(client.sendPrompt(submitted))
      .then(
        (accepted) => {
          if (accepted) {
            // The answer can arrive long after the send (a queued frame resolves when
            // the connection flushes), so never clear text typed since.
            setText((current) => (current.trim() === submitted ? "" : current));
            setSendError(null);
            return;
          }
          setSendError("prompt not sent — press send to retry");
        },
        () => setSendError("prompt not sent — press send to retry"),
      )
      .finally(() => {
        sendingRef.current = false;
      });
  }, [client, live, readOnly, text]);

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
                  onClick={() => client.sendUiResponse(uiRequest.reqId, label)}
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
            onSubmit={(value) => client.sendUiResponse(uiRequest.reqId, value)}
          />
        )}
        <div className="sh-composer-actions sh-ask-actions">
          <button
            type="button"
            className="sh-btn"
            onClick={() => client.sendUiResponse(uiRequest.reqId)}
          >
            Cancel
          </button>
          {busy && (
            <button
              type="button"
              className="sh-btn sh-btn-stop"
              onClick={() => client.sendAbort()}
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

  return (
    <div className="sh-composer">
      <div className="sh-composer-inner">
        <textarea
          ref={taRef}
          className="sh-composer-input"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
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
              onClick={() => client.sendAbort()}
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
