/**
 * Private Collab relay: the content-blind WebSocket hub for `GET /r/<roomId>?role=host|guest`.
 *
 * The wire contract is reverse-engineered from upstream and reproduced here verbatim:
 *
 * - Room path/role: `ROOM_PATH_RE` + `role ∈ {host,guest}`
 *   (`oh-my-pi/packages/collab-web/scripts/local-relay.ts:20,54-55`;
 *   `packages/coding-agent/src/collab/protocol.ts:179`, `relay-client.ts:506`).
 * - Envelope `[4B uint32 BE peerId][sealed payload]`; host peerId 0 = broadcast, N = guest N,
 *   forwarded byte-for-byte; guest frames get the prefix rewritten to their assigned peerId
 *   (`protocol.ts:152-173`, `local-relay.ts:88-99`).
 * - Relay TEXT control: `{"t":"peer-joined","peer":N}` / `{"t":"peer-left","peer":N}` to the host,
 *   `{"t":"room-closed"}` + close 4001 to guests on host loss (`local-relay.ts:81,108-119`; shapes in
 *   `packages/wire/src/index.ts:445-448`).
 * - Close codes: 4000 bad request, 4001 room closed, 4004 no such room, 4009 host conflict,
 *   4029 room full (`relay-client.ts:18-23`).
 * - Clients never send TEXT; upstream drops it (`local-relay.ts:84`), so do we.
 *
 * The relay is content-blind by construction: payloads stay AES-256-GCM sealed end to end. It sees
 * room ids, connection counts, ciphertext sizes, and the plaintext 4-byte routing prefix — nothing
 * else. See README.md for the trust model.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { createStaticHandler } from "./static";

/** `GET /r/<roomId>?role=host|guest` — id grammar from `protocol.ts:179`. */
const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

/** Hostnames that only the owner's own machine can reach; used by the dev default origin policy. */
const LOOPBACK_HOSTNAMES: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "::1": true,
  "[::1]": true,
};

/** WebSocket close codes, matching `packages/coding-agent/src/collab/relay-client.ts:18-23`. */
export const RELAY_CLOSE = {
  /** 4000 — malformed relay request (bad room id or role). */
  badRequest: 4000,
  /** 4001 — the host went away and the room was retired. */
  roomClosed: 4001,
  /** 4004 — a guest joined a room that no host holds. */
  noSuchRoom: 4004,
  /** 4009 — a live host already owns this room id. */
  hostConflict: 4009,
  /** 4029 — guest cap or peer-id space exhausted. */
  roomFull: 4029,
} as const;

/**
 * Hard cap on guests per room. Upstream's reference relay omits the limit entirely and accepts
 * guests until the process dies (`docs/research/collab-relay-selfhost.md` §3), while upstream's
 * client already knows how to handle 4029 (`relay-client.ts:22`). Eight is far more than this
 * product needs (owner's phone plus a spare device) and bounds relay memory per room.
 */
export const MAX_GUESTS_PER_ROOM = 8;
/**
 * Default maximum concurrent rooms the relay will host.
 */
export const DEFAULT_MAX_ROOMS = 32;

/**
 * Inbound frame cap. Passed to `ws` as `maxPayload`; `ws` answers an oversized frame with close
 * 1009. Upstream's host caps its own payloads at `MAX_REPLICATED_PAYLOAD_BYTES = 1 MiB`
 * (`collab/replication-shrink.ts:55`) and chunks snapshots at 512 KiB (`collab/host.ts:134`), and
 * upstream's regression test stands in for a relay with an 8 MB ceiling
 * (`packages/coding-agent/test/collab/replication-shrink.test.ts:310`). 8 MiB is 8x the largest
 * frame a correct host may send, and a quarter of Bun's 16 MB default.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Per-socket send buffer ceiling. A guest that stops reading must not grow the relay without
 * bound; past this the peer is closed with 1013 instead of buffering.
 * ponytail: drop-and-close, no per-peer queue; add a bounded queue if a slow phone must survive.
 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Idle probe interval. Both OMP and the browser client ping on their own
 * (`relay-client.ts:57-59`), but a dead guest that never notices would otherwise leave its room
 * entry (and its peer id) allocated forever.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Grace given to queued close frames during `stop()` before sockets are terminated. */
const SHUTDOWN_FLUSH_MS = 1_000;

const ENVELOPE_HEADER_LENGTH = 4;
const PEER_ID_LIMIT = 0xffff_ffff;

/** Default listener. Loopback only — remote access goes through `tailscale serve`. */
export const DEFAULT_RELAY_HOST = "127.0.0.1";
/** Default port, matching upstream's reference relay (`local-relay.ts` DEFAULT_PORT). */
export const DEFAULT_RELAY_PORT = 7466;

export interface RelayLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RelayOptions {
  /** Port to listen on; 0 picks an ephemeral one. Default {@link DEFAULT_RELAY_PORT}. */
  port?: number;
  /** Bind address. Default {@link DEFAULT_RELAY_HOST} (loopback). */
  host?: string;
  /**
   * An existing HTTP server to attach the room endpoint to, instead of listening
   * on a port of our own.
   *
   * This is the deployment shape the product actually uses: the browser client,
   * the app's API and the WebSocket endpoint must share one origin, or the phone
   * would need two HTTPS origins (one for cookies, one for the socket) and the
   * second one would have no session.
   */
  server?: Server;
  /**
   * Exact browser origins allowed to open the relay socket (`https://host[:port]`). Requests
   * without an `Origin` header — native OMP clients — are always allowed, since the control is
   * cross-site WebSocket hijacking. When omitted, loopback origins on any port are allowed, which
   * is the dev case only; production MUST set this to the `tailscale serve` origin.
   */
  allowedOrigin?: string | readonly string[];
  /** Directory holding the built browser guest client. Omit for a relay-only listener. */
  staticDir?: string;
  /**
   * Serve the room endpoint only: no static client, and `/healthz` is left to the
   * host server. Set automatically when `server` is supplied, because the host
   * already owns those routes.
   */
  attachOnly?: boolean;
  /** Sink for relay events. Defaults to `console`. Never receives payloads, keys, or links. */
  logger?: Partial<RelayLogger>;
  /** Reported by `/healthz`. Defaults to this package's version. */
  version?: string;
  /**
   * Maximum concurrent rooms. Past this, creating a new room is refused with 503
   * (or close code 4029). Default {@link DEFAULT_MAX_ROOMS} (32).
   */
  maxRooms?: number;
  /**
   * Runs only after the listener's `allowHost` policy permits host role. Failures refuse upgrade;
   * guests never invoke it. Standalone listeners allow hosts by default; attached servers deny hosts.
   */
  authorizeHost?: (req: IncomingMessage) => boolean | Promise<boolean>;
  /** Permit `role=host` on the initial server; defaults true standalone and false when attached. */
  allowHost?: boolean;
  /** Clock source for rate limiting and uptime, in ms. Defaults to `Date.now`. */
  now?: () => number;
}

export interface RelayStatus {
  /** `ws://host:port` — clients append `/r/<roomId>?role=…`. */
  url: string;
  host: string;
  port: number;
  rooms: number;
  guests: number;
  uptimeMs: number;
  /**
   * True when the room endpoint is served by the host application's server rather
   * than a listener this relay owns. `port` then reports the host's port and the
   * URL is informational, derived from configuration.
   */
  attached: boolean;
}

export interface Relay {
  /** Begin listening; on attached mode this starts relay heartbeat. */
  start(): Promise<RelayStatus>;
  /** Attach another HTTP server to these shared rooms with an explicit host policy. */
  attach(server: Server, options: { allowHost: boolean }): void;
  /** Close every room and owned listener. Idempotent. */
  stop(): Promise<void>;
  /** Current counters. */
  status(): RelayStatus;
}

interface Room {
  host: WebSocket;
  guests: Map<number, WebSocket>;
  nextPeerId: number;
}

const defaultLogger: RelayLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

function resolveLogger(logger: Partial<RelayLogger> | undefined): RelayLogger {
  if (!logger) return defaultLogger;
  return {
    info: logger.info ?? defaultLogger.info,
    warn: logger.warn ?? defaultLogger.warn,
    error: logger.error ?? defaultLogger.error,
  };
}

/** ws hands us `Buffer | ArrayBuffer | Buffer[]`; normalise to a single owned Buffer. */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

/** Complete an upgrade that the relay refuses to establish, without touching WebSocket framing. */
function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

export function createRelay(options: RelayOptions = {}): Relay {
  const host = options.host ?? DEFAULT_RELAY_HOST;
  const port = options.port ?? DEFAULT_RELAY_PORT;
  const logger = resolveLogger(options.logger);
  const now = options.now ?? Date.now;
  const maxRooms = options.maxRooms ?? DEFAULT_MAX_ROOMS;
  const rooms = new Map<string, Room>();
  const liveness = new Map<WebSocket, { alive: boolean }>();
  const upgradeRateLimits = new Map<string, { count: number; windowStart: number }>();

  // `null` = dev default (loopback origins, any port). Otherwise exact origin strings.
  const allowedOrigins: readonly string[] | null =
    options.allowedOrigin === undefined
      ? null
      : typeof options.allowedOrigin === "string"
        ? [options.allowedOrigin]
        : options.allowedOrigin;

  /** Cross-site WebSocket hijacking guard: a browser Origin must be on the allowlist. */
  const originAllowed = (origin: string): boolean => {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (allowedOrigins === null)
      return LOOPBACK_HOSTNAMES[url.hostname] === true;
    const normalized = url.origin.toLowerCase();
    return allowedOrigins.some((entry) => {
      try {
        return new URL(entry).origin.toLowerCase() === normalized;
      } catch {
        return entry.toLowerCase() === normalized;
      }
    });
  };

  /** Data frame to a peer, with a backpressure ceiling. */
  const deliver = (target: WebSocket, frame: Buffer): void => {
    if (target.readyState !== WebSocket.OPEN) return;
    if (target.bufferedAmount > MAX_BUFFERED_BYTES) {
      logger.warn("[relay] closing backed-up peer: send buffer over ceiling");
      target.close(1013, "peer too slow");
      return;
    }
    target.send(frame);
  };

  /** Tiny control frame; never subject to the data-path backpressure guard. */
  const sendControl = (target: WebSocket, text: string): void => {
    if (target.readyState === WebSocket.OPEN) target.send(text);
  };

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
  });

  wss.on("connection", (ws: WebSocket, req) => {
    // Parse the raw target: percent-encoded room ids are not valid ids, so a plain URL parse is
    // enough here (the static handler does the strict decoding for files).
    const url = new URL(req.url ?? "/", "http://relay.invalid");
    const match = ROOM_PATH_RE.exec(url.pathname);
    const role = url.searchParams.get("role");
    if (!match || (role !== "host" && role !== "guest")) {
      ws.close(RELAY_CLOSE.badRequest, "bad request");
      return;
    }
    const roomId = match[1]!;

    // Heartbeat bookkeeping for every accepted socket.
    const state = { alive: true };
    liveness.set(ws, state);
    ws.on("pong", () => {
      state.alive = true;
    });
    ws.on("close", () => {
      liveness.delete(ws);
    });
    // A receiver-level failure (oversized frame, malformed frame) is reported as a socket error;
    // `ws` closes those with 1009. Without this handler an unhandled 'error' event would take the
    // whole relay down. The message is structural (never payload bytes).
    ws.on("error", (error: Error) => {
      logger.warn(`[relay] socket error in room ${roomId}: ${error.message}`);
    });

    if (role === "host") {
      if (rooms.has(roomId)) {
        logger.warn(`[relay] refusing second host for room ${roomId}`);
        ws.close(
          RELAY_CLOSE.hostConflict,
          "a host is already connected for this room",
        );
        return;
      }
      if (rooms.size >= maxRooms) {
        logger.warn("[relay] refusing host: room cap reached");
        ws.close(RELAY_CLOSE.roomFull, "room cap reached");
        return;
      }
      const room: Room = { host: ws, guests: new Map(), nextPeerId: 1 };
      rooms.set(roomId, room);
      logger.info(`[relay] host connected to room ${roomId}`);

      ws.on("message", (data: RawData, isBinary: boolean) => {
        // Clients never send TEXT (upstream `local-relay.ts:84`); dropping it keeps the relay
        // from being usable as a plaintext fan-out for anything we do not understand.
        if (!isBinary) return;
        const live = rooms.get(roomId);
        if (!live || live.host !== ws) return;
        const frame = toBuffer(data);
        if (frame.length < ENVELOPE_HEADER_LENGTH) return;
        // peerId is read as uint32, so the full range is representable and no overflow is
        // possible on this direction; assignment guards the other direction.
        const peerId = frame.readUInt32BE(0);
        if (peerId === 0) {
          for (const guest of live.guests.values()) deliver(guest, frame);
          return;
        }
        const guest = live.guests.get(peerId);
        if (guest) deliver(guest, frame);
      });

      ws.on("close", () => {
        const live = rooms.get(roomId);
        // A rejected second host never owned this room; do not tear it down.
        if (!live || live.host !== ws) return;
        rooms.delete(roomId);
        const closure = JSON.stringify({ t: "room-closed" });
        for (const guest of live.guests.values()) {
          sendControl(guest, closure);
          guest.close(RELAY_CLOSE.roomClosed, "room closed");
        }
        live.guests.clear();
        logger.info(`[relay] room closed ${roomId} (host disconnect)`);
      });
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      ws.close(RELAY_CLOSE.noSuchRoom, "no such room");
      return;
    }
    if (
      room.guests.size >= MAX_GUESTS_PER_ROOM ||
      room.nextPeerId > PEER_ID_LIMIT
    ) {
      logger.warn(`[relay] refusing guest for room ${roomId}: at capacity`);
      ws.close(RELAY_CLOSE.roomFull, "room is full");
      return;
    }
    const peerId = room.nextPeerId++;
    room.guests.set(peerId, ws);
    sendControl(room.host, JSON.stringify({ t: "peer-joined", peer: peerId }));
    logger.info(
      `[relay] guest ${peerId} connected to room ${roomId} (${room.guests.size} guests)`,
    );

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      const live = rooms.get(roomId);
      if (!live || live.host.readyState !== WebSocket.OPEN) return;
      const frame = toBuffer(data);
      if (frame.length < ENVELOPE_HEADER_LENGTH) return;
      // Rewrite the prefix in place; the sealed payload bytes are never touched or copied.
      frame.writeUInt32BE(peerId, 0);
      deliver(live.host, frame);
    });

    ws.on("close", () => {
      if (!room.guests.delete(peerId)) return;
      sendControl(room.host, JSON.stringify({ t: "peer-left", peer: peerId }));
      logger.info(`[relay] guest ${peerId} left room ${roomId}`);
    });
  });

  const staticHandler = createStaticHandler({
    dir: options.staticDir ?? null,
    version: options.version ?? "0.0.0",
    status: () => ({ rooms: rooms.size, guests: countGuests() }),
  });

  // Two deployment shapes: a standalone listener (tests, dev), or attached to the
  // host application's HTTP server so the guest client, the API and this socket
  // share one origin.
  const attached = options.server !== undefined;
  const server: Server = options.server ?? createServer((req, res) => { void staticHandler(req, res); });
  if (!attached) {
    // Upgraded sockets are not HTTP requests; keep the server from holding them open forever.
    server.headersTimeout = 30_000;
    server.requestTimeout = 30_000;
  }

  const attachments = new Map<Server, (req: IncomingMessage, socket: Duplex, head: Buffer) => void>();
  const attachServer = (target: Server, allowHost: boolean): void => {
    if (attachments.has(target)) throw new Error("Relay is already attached to this HTTP server");
    const onUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
      if (req.method !== "GET") {
        rejectUpgrade(socket, 405, "Method Not Allowed");
        return;
      }

      // Rate-limit upgrades per remote address (20/s)
      const remoteIp = req.socket.remoteAddress ?? "unknown";
      const timestamp = now();
      let rateEntry = upgradeRateLimits.get(remoteIp);
      if (!rateEntry || timestamp - rateEntry.windowStart >= 1000) {
        rateEntry = { count: 1, windowStart: timestamp };
        upgradeRateLimits.set(remoteIp, rateEntry);
      } else {
        rateEntry.count++;
        if (rateEntry.count > 20) {
          logger.warn("[relay] rejected websocket upgrade: rate limit exceeded");
          rejectUpgrade(socket, 429, "Too Many Requests");
          return;
        }
      }
      if (upgradeRateLimits.size > 1000) {
        for (const [k, v] of upgradeRateLimits) {
          if (timestamp - v.windowStart > 5000) upgradeRateLimits.delete(k);
        }
      }

      // Origin allowlist (OWASP WebSocket cheat sheet: validate Origin on every handshake). Native
      // OMP clients send no Origin and are allowed; browsers cannot forge one.
      const origin = req.headers.origin;
      if (typeof origin === "string" && !originAllowed(origin)) {
        logger.warn("[relay] rejected websocket upgrade: origin not allowed");
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }
      const site = req.headers["sec-fetch-site"];
      if (typeof site === "string" && site !== "same-origin" && site !== "none") {
        logger.warn("[relay] rejected websocket upgrade: cross-site fetch metadata");
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }
      const target = req.url ?? "";
      const path = target.split("?", 1)[0] ?? "";
      if (!path.startsWith("/r/")) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }

      const url = new URL(target, "http://relay.invalid");
      const role = url.searchParams.get("role");
      if (role === "host") {
        // Forwarded headers are not trusted: no proxy identity is bound to them.
        // Serve-facing listener refuses hosts even when its peer appears loopback.
        if (!allowHost) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }
        const match = ROOM_PATH_RE.exec(url.pathname);
        const roomId = match ? match[1]! : "";
        if (options.authorizeHost) {
          let authorized = false;
          try {
            authorized = await options.authorizeHost(req);
          } catch {
            authorized = false;
          }
          if (!authorized) {
            logger.warn("[relay] rejected websocket upgrade: unauthorized host");
            rejectUpgrade(socket, 401, "Unauthorized");
            return;
          }
        }
        if (roomId && !rooms.has(roomId) && rooms.size >= maxRooms) {
          logger.warn("[relay] rejected websocket upgrade: maximum rooms reached");
          rejectUpgrade(socket, 503, "Service Unavailable");
          return;
        }
      }

      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    };
    target.on("upgrade", onUpgrade);
    attachments.set(target, onUpgrade);
  };
  attachServer(server, options.allowHost ?? !attached);

  function countGuests(): number {
    let total = 0;
    for (const room of rooms.values()) total += room.guests.size;
    return total;
  }

  function startHeartbeat(): void {
    heartbeat = setInterval(() => {
      for (const [socket, state] of liveness) {
        if (!state.alive) {
          socket.terminate();
          liveness.delete(socket);
          continue;
        }
        state.alive = false;
        socket.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
    // Do not keep a test process (or a supervised child) alive on this timer.
    heartbeat.unref?.();
  }

  let startedAt = 0;
  let listeningPort = 0;
  let heartbeat: NodeJS.Timeout | undefined;
  let startPromise: Promise<RelayStatus> | null = null;
  let stopPromise: Promise<void> | null = null;

  const status = (): RelayStatus => ({
    url: `ws://${host}:${listeningPort}`,
    host,
    port: listeningPort,
    rooms: rooms.size,
    guests: countGuests(),
    uptimeMs: startedAt === 0 ? 0 : Date.now() - startedAt,
    attached,
  });

  return {
    status,
    attach: (target: Server, policy: { allowHost: boolean }) => attachServer(target, policy.allowHost),
    async start(): Promise<RelayStatus> {
      if (startPromise) return startPromise;
      if (attached) {
        // The host server owns the socket. Nothing to bind; just begin the
        // heartbeat that reaps dead room members.
        startedAt = Date.now();
        startHeartbeat();
        logger.info("[relay] attached to the host server at /r/<roomId>?role=host|guest");
        startPromise = Promise.resolve(status());
        return startPromise;
      }
      startPromise = new Promise<RelayStatus>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          const address = server.address();
          listeningPort =
            typeof address === "object" && address !== null
              ? address.port
              : port;
          startedAt = Date.now();
          startHeartbeat();
          logger.info(
            `[relay] listening on ws://${host}:${listeningPort}/r/<roomId>?role=host|guest`,
          );
          resolve(status());
        });
      });
      return startPromise;
    },
    async stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        clearInterval(heartbeat);
        heartbeat = undefined;
        const sockets = [...wss.clients];
        const closure = JSON.stringify({ t: "room-closed" });
        for (const room of rooms.values()) {
          for (const guest of room.guests.values()) {
            sendControl(guest, closure);
            guest.close(RELAY_CLOSE.roomClosed, "room closed");
          }
          sendControl(room.host, JSON.stringify({ t: "relay-shutdown" }));
          room.host.close(1001, "relay shutting down");
        }
        rooms.clear();
        // Give the queued close frames a bounded chance to flush, then enforce.
        await Promise.all(
          sockets.map(
            (socket) =>
              new Promise<void>((resolve) => {
                if (socket.readyState === WebSocket.CLOSED) {
                  resolve();
                  return;
                }
                const timer = setTimeout(() => {
                  socket.terminate();
                  resolve();
                }, SHUTDOWN_FLUSH_MS);
                socket.once("close", () => {
                  clearTimeout(timer);
                  resolve();
                });
              }),
          ),
        );
        for (const [target, onUpgrade] of attachments) {
          target.off("upgrade", onUpgrade);
          if (target !== server && target.listening) {
            await new Promise<void>((resolve, reject) => {
              target.close((error) => (error ? reject(error) : resolve()));
            });
          }
        }
        wss.close();
        // The listener belongs to the host application in attach mode; closing it
        // here would take the API and the web client down with the relay.
        if (!attached && server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
        logger.info("[relay] stopped");
      })();
      return stopPromise;
    },
  };
}
