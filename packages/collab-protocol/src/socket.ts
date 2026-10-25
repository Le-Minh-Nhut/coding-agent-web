/**
 * Ported from https://github.com/can1357/oh-my-pi (MIT License)
 * Upstream files:
 * - packages/collab-web/src/lib/socket.ts
 * - packages/coding-agent/src/collab/relay-client.ts
 */

import { open, seal } from "./codec.js";
import { packEnvelope, unpackEnvelope } from "./envelope.js";
import type { GuestFrame, HostFrame, RelayControlMessage } from "./types.js";

const RELAY_CLOSE_REASONS: Record<number, string> = {
  4001: "room closed",
  4004: "no such room",
  4009: "a host is already connected for this room",
  4029: "room is full",
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export interface CollabSocketOptions {
  wsUrl: string;
  role: "host" | "guest";
  key: CryptoKey | PromiseLike<CryptoKey>;
  WebSocketClass?: typeof WebSocket;
}

export class CollabSocket {
  onOpen?: () => void;
  onFrame?: (frame: HostFrame, fromPeer: number) => void;
  onControl?: (msg: RelayControlMessage) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;

  readonly #opts: CollabSocketOptions;
  #role: "host" | "guest";
  #ws: WebSocket | null = null;
  #retryTimer: number | NodeJS.Timeout | undefined;
  #attempt = 0;
  #closed = false;
  #retryMissingRoom = false;
  #sendChain: Promise<void> = Promise.resolve();
  #helloAcknowledged = false;
  #recvChain: Promise<void> = Promise.resolve();

  constructor(opts: CollabSocketOptions) {
    this.#opts = opts;
    this.#role = opts.role;
  }

  get isOpen(): boolean {
    return this.#ws !== null && this.#ws.readyState === 1;
  }

  connect(role?: "host" | "guest"): void {
    if (role) this.#role = role;
    if (this.#ws || this.#retryTimer) return;
    this.#closed = false;
    this.#retryMissingRoom = false;
    this.#attempt = 0;
    this.#openSocket();
  }

  send(frame: GuestFrame, targetPeer = 0): Promise<boolean> {
    const send = this.#sendChain.then(async () => {
      const ws = this.#ws;
      if (this.#closed || !ws || ws.readyState !== 1) return false;
      if (frame.t !== "hello" && !this.#helloAcknowledged) return false;
      const envelope = packEnvelope(targetPeer, await seal(await this.#opts.key, frame));
      if (ws !== this.#ws || ws.readyState !== 1) return false;
      ws.send(envelope);
      return true;
    });
    this.#sendChain = send.then(() => undefined, () => undefined);
    return send.catch(() => false);
  }

  close(): void {
    const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
    this.#clearRetry();
    const wasClosed = this.#closed;
    this.#closed = true;
    this.#retryMissingRoom = false;
    this.#helloAcknowledged = false;
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      try {
        ws.close(1000);
      } catch {
        // Already closing/closed
      }
    }
    if (hadActivity && !wasClosed) this.onClose?.("closed", false);
  }

  #openSocket(): void {
    const WS = this.#opts.WebSocketClass ?? globalThis.WebSocket;
    if (!WS) {
      this.onClose?.("WebSocket unavailable in runtime", false);
      return;
    }
    const ws = new WS(`${this.#opts.wsUrl}?role=${this.#role}`);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    this.#helloAcknowledged = false;

    ws.onopen = () => {
      if (this.#ws !== ws) return;
      if (!this.#retryMissingRoom) this.#attempt = 0;
      this.onOpen?.();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.#ws !== ws) return;
      this.#handleMessage(ws, event.data);
    };

    ws.onerror = () => {
      // Paired close event carries actionable state
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#handleClose(event.code, event.reason);
    };
  }

  #handleMessage(ws: WebSocket, data: unknown): void {
    if (typeof data === "string") {
      try {
        this.onControl?.(JSON.parse(data) as RelayControlMessage);
      } catch {
        // Malformed control text frame ignored
      }
      return;
    }

    let bytes: Uint8Array | null = null;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    if (!bytes) return;

    const envelope = unpackEnvelope(bytes);
    if (!envelope) return;

    this.#recvChain = this.#recvChain
      .then(async () => {
        if (this.#ws !== ws) return;
        let frame: HostFrame;
        try {
          frame = (await open(await this.#opts.key, envelope.payload)) as HostFrame;
        } catch {
          this.#failFatal("bad key or corrupted frame");
          return;
        }
        if (this.#ws !== ws) return;
        if (frame.t === "welcome") this.#helloAcknowledged = true;
        this.#retryMissingRoom = false;
        this.#attempt = 0;
        this.onFrame?.(frame, envelope.peerId);
      })
      .catch(() => {
        // Listener threw; keep receive chain alive
      });
  }

  #handleClose(code: number, reason: string): void {
    if (this.#closed) return;
    const fatalReason = RELAY_CLOSE_REASONS[code];
    const closeReason = fatalReason ?? (reason || `connection lost (code ${code})`);
    const retryRoom =
      this.#role === "guest" && (code === 4001 || (code === 4004 && this.#retryMissingRoom));

    if (retryRoom) {
      this.#retryMissingRoom = true;
      this.onClose?.(closeReason, true);
      this.#scheduleRetry();
      return;
    }

    if (fatalReason !== undefined) {
      this.#closed = true;
      this.onClose?.(fatalReason, false);
      return;
    }

    this.onClose?.(closeReason, true);
    this.#scheduleRetry();
  }

  #failFatal(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearRetry();
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      try {
        ws.close(1000);
      } catch {
        // Already closing/closed
      }
    }
    this.onClose?.(reason, false);
  }

  #scheduleRetry(): void {
    const base = Math.min(BACKOFF_BASE_MS * Math.pow(2, this.#attempt), BACKOFF_MAX_MS);
    this.#attempt++;
    const delay = base * (0.75 + Math.random() * 0.5);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (this.#closed) return;
      this.#openSocket();
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
  }
}
