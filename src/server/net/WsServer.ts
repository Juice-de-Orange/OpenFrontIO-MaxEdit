/**
 * The world's WebSocket endpoint.
 *
 * Every failure closes the connection with a code that says why. Nothing is
 * ignored and nothing is logged-and-continued: CLAUDE.md §7 asks for exactly
 * that, because a client that silently half-works is the hardest thing to
 * debug in a world that runs for weeks.
 */

import {
  CloseCode,
  decodeClientMessage,
  encodeServer,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "src/shared/protocol/Wire";
import { WebSocketServer, type WebSocket } from "ws";
import type { StubWorld } from "../world/StubWorld";

/** How long a connection may stay silent before sending `hello`. */
const HELLO_TIMEOUT_MS = 5000;

/**
 * How often to ping an idle connection.
 *
 * A world connection is open for hours and quiet for most of them. The
 * reverse proxy this will sit behind closes idle streams after an hour, so
 * the server has to keep them warm itself — otherwise the socket dies quietly
 * and the client only finds out when it next expects a tick.
 */
const PING_INTERVAL_MS = 25_000;

interface Session {
  socket: WebSocket;
  ready: boolean;
}

export class WorldSocketServer {
  private readonly wss: WebSocketServer;
  private readonly sessions = new Set<Session>();
  private pingTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly world: StubWorld,
    private readonly worldId: string,
    port: number,
    path = "/ws",
  ) {
    this.wss = new WebSocketServer({ port, path });
    this.wss.on("connection", (socket) => this.onConnection(socket));
    this.pingTimer = setInterval(() => {
      for (const s of this.sessions) s.socket.ping();
    }, PING_INTERVAL_MS);
  }

  private onConnection(socket: WebSocket): void {
    const session: Session = { socket, ready: false };
    this.sessions.add(session);

    const helloTimer = setTimeout(() => {
      if (!session.ready) socket.close(CloseCode.NoHelloTimeout, "no hello");
    }, HELLO_TIMEOUT_MS);

    socket.on("message", (raw) => {
      if (session.ready) {
        // Phase 0 has no commands, so anything after `hello` is a protocol
        // violation. Disconnect rather than ignore — silent failure makes
        // debugging impossible (CLAUDE.md §7).
        this.reject(
          socket,
          "malformed",
          "no messages are expected after hello",
        );
        socket.close(CloseCode.Malformed, "unexpected message");
        return;
      }

      let hello;
      try {
        hello = decodeClientMessage(raw.toString());
      } catch (e) {
        this.reject(socket, "malformed", String(e));
        socket.close(CloseCode.Malformed, "malformed hello");
        return;
      }

      if (hello.protocolVersion !== PROTOCOL_VERSION) {
        this.reject(
          socket,
          "protocol-version",
          `client speaks ${hello.protocolVersion}, server speaks ${PROTOCOL_VERSION}`,
        );
        socket.close(CloseCode.ProtocolVersion, "protocol version");
        return;
      }

      if (hello.worldId !== this.worldId) {
        this.reject(socket, "unknown-world", `no world named ${hello.worldId}`);
        socket.close(CloseCode.UnknownWorld, "unknown world");
        return;
      }

      clearTimeout(helloTimer);
      session.ready = true;
      this.send(socket, {
        t: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        worldId: this.worldId,
      });
      this.send(socket, {
        t: "full",
        tick: this.world.currentTick(),
        map: this.world.descriptor,
        nations: this.world.nations,
        owners: this.world.ownerSnapshot(),
      });
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      this.sessions.delete(session);
    });
    socket.on("error", () => {
      clearTimeout(helloTimer);
      this.sessions.delete(session);
    });
  }

  /** Push this tick's changes to every client past the handshake. */
  broadcastDelta(tick: number, changes: [number, number][]): void {
    const payload = encodeServer({ t: "delta", tick, changes });
    for (const s of this.sessions) {
      if (s.ready) s.socket.send(payload);
    }
  }

  get connectionCount(): number {
    return this.sessions.size;
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    socket.send(encodeServer(message));
  }

  private reject(
    socket: WebSocket,
    reason: "protocol-version" | "unknown-world" | "malformed",
    detail: string,
  ): void {
    this.send(socket, {
      t: "reject",
      reason,
      detail,
      serverProtocolVersion: PROTOCOL_VERSION,
    });
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
