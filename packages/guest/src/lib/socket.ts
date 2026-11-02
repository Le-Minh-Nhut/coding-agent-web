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

/** Node 20 has no Promise.withResolvers. */
export function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void } {
	let settle!: (value: T) => void;
	const promise = new Promise<T>(resolve => { settle = resolve; });
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
	onOpen?: () => void;
	onFrame?: (frame: HostFrame, fromPeer: number) => void;
	onControl?: (msg: RelayControlMessage) => void;
	onClose?: (reason: string, willReconnect: boolean) => void;
	readonly #opts: CollabSocketOptions;
	#ws: WebSocket | null = null;
	#retryTimer: Timer | undefined;
	#attempt = 0;
	#closed = false;
	#retryMissingRoom = false;
	/** Welcome validates this physical connection. */
	#helloAcknowledged = false;
	#sendChain: Promise<void> = Promise.resolve();
	#recvChain: Promise<void> = Promise.resolve();
	#connGen = 0;
	#closeGen = 0;

	constructor(opts: CollabSocketOptions) { this.#opts = opts; }
	get isOpen(): boolean { return this.#ws?.readyState === WebSocket.OPEN; }
	get isGreeted(): boolean { return this.#helloAcknowledged; }

	connect(): void {
		if (this.#ws || this.#retryTimer) return;
		this.#closed = false;
		this.#retryMissingRoom = false;
		this.#helloAcknowledged = false;
		this.#attempt = 0;
		this.#openSocket();
	}

	send(frame: GuestFrame, targetPeer = 0): Promise<boolean> {
		// false is a known local refusal before dispatch; true means bytes reached the wire.
		const outcome = deferred<boolean>();
		if (this.#closed || (frame.t !== "hello" && !this.#helloAcknowledged)) {
			outcome.settle(false);
			return outcome.promise;
		}
		const connGenAtCall = this.#connGen;
		const closeGenAtCall = this.#closeGen;
		const step = this.#sendChain.then(async (): Promise<void> => {
			try {
				if (this.#closed || this.#closeGen !== closeGenAtCall) return outcome.settle(false);
				if (frame.t !== "hello" && (!this.#helloAcknowledged || this.#connGen !== connGenAtCall)) return outcome.settle(false);
				const ws = this.#ws;
				const sealed = await seal(await this.#opts.key, frame);
				if (this.#closed || this.#closeGen !== closeGenAtCall || this.#connGen !== connGenAtCall || this.#ws !== ws || (frame.t !== "hello" && !this.#helloAcknowledged)) return outcome.settle(false);
				const envelope = packEnvelope(targetPeer, sealed);
				if (!ws || ws.readyState !== WebSocket.OPEN) return outcome.settle(false);
				ws.send(envelope);
				outcome.settle(true);
			} catch {
				outcome.settle(false);
			}
		});
		this.#sendChain = step;
		return outcome.promise;
	}

	close(): void {
		const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
		this.#clearRetry();
		const wasClosed = this.#closed;
		this.#closed = true;
		this.#connGen++;
		this.#closeGen++;
		this.#retryMissingRoom = false;
		this.#helloAcknowledged = false;
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try { ws.close(1000); } catch { /* already closing/closed */ }
		}
		if (hadActivity && !wasClosed) this.onClose?.("closed", false);
	}

	#openSocket(): void {
		this.#connGen++;
		let ws: WebSocket;
		try {
			ws = new WebSocket(`${this.#opts.wsUrl}?role=${this.#opts.role}`);
		} catch (err) {
			this.onClose?.(err instanceof Error ? err.message : "failed to create WebSocket", false);
			throw err;
		}
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		this.#helloAcknowledged = false;
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			if (!this.#retryMissingRoom) this.#attempt = 0;
			// onOpen sends hello; non-hello frames are locally refused until welcome.
			this.onOpen?.();
		};
		ws.onmessage = (event: MessageEvent) => {
			if (this.#ws !== ws) return;
			this.#handleMessage(ws, event.data);
		};
		ws.onerror = () => { /* The paired close event carries actionable state. */ };
		ws.onclose = (event: CloseEvent) => {
			if (this.#ws !== ws) return;
			this.#ws = null;
			this.#handleClose(event.code, event.reason);
		};
	}

	#handleMessage(ws: WebSocket, data: unknown): void {
		if (typeof data === "string") {
			try { this.onControl?.(JSON.parse(data) as RelayControlMessage); }
			catch { console.warn("collab: ignoring malformed control message"); }
			return;
		}
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
		if (!bytes) { console.warn("collab: ignoring binary message of unexpected shape"); return; }
		const envelope = unpackEnvelope(bytes);
		if (!envelope) { console.warn("collab: ignoring truncated envelope"); return; }
		this.#recvChain = this.#recvChain.then(async () => {
			if (this.#ws !== ws) return;
			let frame: HostFrame;
			try { frame = (await open(await this.#opts.key, envelope.payload)) as HostFrame; }
			catch { this.#failFatal("bad key or corrupted frame"); return; }
			if (this.#ws !== ws) return;
			if (frame.t === "welcome") this.#helloAcknowledged = true;
			this.#retryMissingRoom = false;
			this.#attempt = 0;
			this.onFrame?.(frame, envelope.peerId);
		}).catch(() => { /* listener threw; keep receive chain alive */ });
	}

	#handleClose(code: number, reason: string): void {
		this.#connGen++;
		this.#helloAcknowledged = false;
		if (this.#closed) return;
		const fatalReason = RELAY_CLOSE_REASONS[code];
		const closeReason = fatalReason ?? (reason || `connection lost (code ${code})`);
		// A 4004 after a 4001 retry means the recreated room never came back.
		if (this.#opts.role === "guest" && code === 4004 && this.#retryMissingRoom) {
			this.#closed = true;
			this.#retryMissingRoom = false;
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
			this.onClose?.(fatalReason, false);
			return;
		}
		this.onClose?.(closeReason, true);
		this.#scheduleRetry();
	}

	#failFatal(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#connGen++;
		this.#closeGen++;
		this.#clearRetry();
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try { ws.close(1000); } catch { /* already closing/closed */ }
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
