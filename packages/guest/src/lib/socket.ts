/**
 * Browser WebSocket wrapper for collab live-session sharing (vendored mirror
 * of `@oh-my-pi/pi-coding-agent/src/collab/relay-client.ts` semantics).
 *
 * Connects to a relay room, seals/opens AES-GCM frames, and reconnects with
 * exponential backoff. Guests survive host-drop teardown while the host recreates the room.
 */

import type { GuestFrame, HostFrame, RelayControlMessage } from "@oh-my-pi/pi-wire";
import { open, seal } from "./codec";
import { packEnvelope, unpackEnvelope } from "./link";

const RELAY_CLOSE_REASONS: Record<number, string> = {
	4001: "room closed",
	4004: "no such room",
	4009: "a host is already connected for this room",
	4029: "room is full",
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/**
 * Max enveloped frames buffered while a reconnect/`welcome` is pending. The cap
 * refuses the frame that would overflow it; it never kills the socket, because a
 * full queue says nothing about whether the connection is recoverable.
 */
const MAX_PENDING_SENDS = 256;

/** A frame held back until the host's `welcome`; `settle(true)` means it reached the wire. */
interface PendingSend {
	envelope: Uint8Array<ArrayBuffer>;
	settle: (delivered: boolean) => void;
}

/** The repo targets Node 20, which has no `Promise.withResolvers`. */
function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void } {
	let settle!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		settle = resolve;
	});
	return { promise, settle };
}

export interface CollabSocketOptions {
	/** wss://host[:port]/r/<roomId> — no query string. */
	wsUrl: string;
	role: "host" | "guest";
	/** Room key; a pending import promise is awaited inside the seal/open chains. */
	key: CryptoKey | PromiseLike<CryptoKey>;
}

export class CollabSocket {
	/** Fires after every successful (re)connect. */
	onOpen?: () => void;
	onFrame?: (frame: HostFrame, fromPeer: number) => void;
	onControl?: (msg: RelayControlMessage) => void;
	/** Fires on each close; `willReconnect` distinguishes retries from terminal shutdown. */
	onClose?: (reason: string, willReconnect: boolean) => void;

	readonly #opts: CollabSocketOptions;
	#ws: WebSocket | null = null;
	#retryTimer: Timer | undefined;
	#attempt = 0;
	/** Terminal state: intentional close or fatal failure. Cleared by connect(). */
	#closed = false;
	/** Allows a previously joined guest to outlive room recreation races. */
	#retryMissingRoom = false;
	/** Host answered `hello` with a `welcome`; no other frame may precede it. */
	#helloAcknowledged = false;
	/** Serializes seal() so frames hit the wire in send() order. */
	#sendChain: Promise<void> = Promise.resolve();
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	/** Frames sealed while disconnected/ungreeted, flushed on the next `welcome`. */
	#pendingSends: PendingSend[] = [];

	constructor(opts: CollabSocketOptions) {
		this.#opts = opts;
	}

	get isOpen(): boolean {
		return this.#ws?.readyState === WebSocket.OPEN;
	}

	connect(): void {
		if (this.#ws || this.#retryTimer) return;
		this.#closed = false;
		this.#retryMissingRoom = false;
		this.#helloAcknowledged = false;
		this.#attempt = 0;
		this.#openSocket();
	}

	send(frame: GuestFrame, targetPeer = 0): Promise<boolean> {
		// The caller's answer is per frame, not per seal: it resolves `true` when the
		// envelope actually reaches the wire (now, or later from the flush) and
		// `false` when it never will (refused, or discarded by a terminal path).
		// `true` therefore never means "queued and maybe dropped".
		const outcome = deferred<boolean>();
		const step = this.#sendChain.then(async (): Promise<void> => {
			try {
				if (this.#closed) return outcome.settle(false);
				const sealed = await seal(await this.#opts.key, frame);
				const envelope = packEnvelope(targetPeer, sealed);
				const ws = this.#ws;
				// Only `hello` may precede the host's `welcome`: anything sent first
				// would be dropped (or rejected) by the relay-side handshake.
				if (ws && ws.readyState === WebSocket.OPEN && (frame.t === "hello" || this.#helloAcknowledged)) {
					ws.send(envelope);
					return outcome.settle(true);
				}
				// The queue is full: refuse THIS frame and keep the socket alive. A full
				// buffer says nothing about whether the connection can still recover, so
				// killing it would turn one refused frame into a lost session.
				if (this.#pendingSends.length >= MAX_PENDING_SENDS) return outcome.settle(false);
				this.#pendingSends.push({ envelope, settle: outcome.settle });
			} catch {
				outcome.settle(false);
			}
		});
		this.#sendChain = step;
		return outcome.promise;
	}

	/** Intentional close: clears any retry timer, suppresses reconnect. A later connect() starts fresh. */
	close(): void {
		const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
		this.#clearRetry();
		const wasClosed = this.#closed;
		this.#closed = true;
		this.#retryMissingRoom = false;
		this.#helloAcknowledged = false;
		this.#discardPending();
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		if (hadActivity && !wasClosed) this.onClose?.("closed", false);
	}

	#openSocket(): void {
		const ws = new WebSocket(`${this.#opts.wsUrl}?role=${this.#opts.role}`);
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		this.#helloAcknowledged = false;
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			if (!this.#retryMissingRoom) this.#attempt = 0;
			// Queued frames stay queued until the host's `welcome`: `onOpen` runs
			// first so the handshake `hello` is enqueued ahead of them.
			this.onOpen?.();
		};
		ws.onmessage = (event: MessageEvent) => {
			if (this.#ws !== ws) return;
			this.#handleMessage(ws, event.data);
		};
		ws.onerror = () => {
			// The paired close event carries the actionable state; nothing to do here.
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
				console.warn("collab: ignoring malformed control message");
			}
			return;
		}
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
		if (!bytes) {
			console.warn("collab: ignoring binary message of unexpected shape");
			return;
		}
		const envelope = unpackEnvelope(bytes);
		if (!envelope) {
			console.warn("collab: ignoring truncated envelope");
			return;
		}
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
				if (frame.t === "welcome") {
					this.#helloAcknowledged = true;
					this.#flushPending();
				}
				this.#retryMissingRoom = false;
				this.#attempt = 0;
				this.onFrame?.(frame, envelope.peerId);
			})
			.catch(() => {
				// listener threw; keep the receive chain alive
			});
	}

	#handleClose(code: number, reason: string): void {
		if (this.#closed) return;
		const fatalReason = RELAY_CLOSE_REASONS[code];
		const closeReason = fatalReason ?? (reason || `connection lost (code ${code})`);
		// A 4004 after a 4001 retry means the recreated room never came back:
		// terminal, not another retry.
		if (this.#opts.role === "guest" && code === 4004 && this.#retryMissingRoom) {
			this.#closed = true;
			this.#retryMissingRoom = false;
			this.#discardPending();
			this.onClose?.(closeReason, false);
			return;
		}
		const retryRoom = this.#opts.role === "guest" && code === 4001;
		if (retryRoom) {
			this.#retryMissingRoom = true;
			this.onClose?.(closeReason, true);
			this.#scheduleRetry();
			return;
		}
		if (fatalReason !== undefined) {
			this.#closed = true;
			this.#discardPending();
			this.onClose?.(fatalReason, false);
			return;
		}
		this.onClose?.(closeReason, true);
		this.#scheduleRetry();
	}

	/**
	 * Drain frames queued while disconnected/ungreeted. Called only after the
	 * host's `welcome`, so the handshake can never be overtaken.
	 */
	#flushPending(): void {
		const ws = this.#ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		const queued = this.#pendingSends;
		this.#pendingSends = [];
		for (const pending of queued) {
			try {
				ws.send(pending.envelope);
				pending.settle(true);
			} catch {
				// The socket died mid-drain: every caller still learns which frames
				// reached the wire and which did not.
				pending.settle(false);
			}
		}
	}

	/**
	 * Drop every queued frame and tell each caller it was NOT delivered, so a
	 * draft parked behind a terminal path is restored rather than silently lost.
	 */
	#discardPending(): void {
		const dropped = this.#pendingSends;
		this.#pendingSends = [];
		for (const pending of dropped) pending.settle(false);
	}

	/** Decryption failure: wrong key or corrupted frame. Never reconnect. */
	#failFatal(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearRetry();
		this.#discardPending();
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		this.onClose?.(reason, false);
	}

	#scheduleRetry(): void {
		const base = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);
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
