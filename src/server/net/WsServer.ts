/**
 * The world's WebSocket endpoint.
 *
 * Every failure closes the connection with a code that says why. Nothing is
 * ignored and nothing is logged-and-continued: CLAUDE.md §7 asks for exactly
 * that, because a client that silently half-works is the hardest thing to
 * debug in a world that runs for weeks.
 *
 * The one thing that is answered rather than closed is a command the world
 * refuses on its merits — an ack with a reason. "You cannot claim that
 * province" is a game rule, not a protocol violation, and hanging up on a
 * player for playing badly would be absurd.
 */

import {
  CloseCode,
  decodeClientMessage,
  encodeServer,
  PROTOCOL_VERSION,
  type ClientCommand,
  type CommandBody,
  type ServerMessage,
} from "src/shared/protocol/Wire";
import { WebSocketServer, type WebSocket } from "ws";
import type { World } from "../world/World";

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

export type CommandResult =
  | { accepted: true; tick: number }
  | { accepted: false; reason: string };

/**
 * What the socket layer does with a command it has decoded.
 *
 * Deliberately a function rather than a method on the world: accepting a
 * command means writing it to the log *before* queueing it, and the socket
 * has no business knowing about a database. The runner supplies this.
 */
export type SubmitCommand = (
  nation: number,
  body: CommandBody,
) => Promise<CommandResult>;

interface Session {
  socket: WebSocket;
  ready: boolean;
  nation: number | null;
  /**
   * Commands are handled asynchronously (the log write is awaited), and the
   * ws "message" event is not. Without a chain, two commands sent back to back
   * could be logged in the opposite order to the one they arrived in, and the
   * replay would then differ from the run.
   */
  work: Promise<void>;
}

export class WorldSocketServer {
  private readonly wss: WebSocketServer;
  private readonly sessions = new Set<Session>();
  private pingTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly world: World,
    private readonly submit: SubmitCommand,
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
    const session: Session = {
      socket,
      ready: false,
      nation: null,
      work: Promise.resolve(),
    };
    this.sessions.add(session);

    const helloTimer = setTimeout(() => {
      if (!session.ready) socket.close(CloseCode.NoHelloTimeout, "no hello");
    }, HELLO_TIMEOUT_MS);

    socket.on("message", (raw) => {
      let message;
      try {
        message = decodeClientMessage(raw.toString());
      } catch (e) {
        this.reject(socket, "malformed", String(e));
        socket.close(CloseCode.Malformed, "malformed message");
        return;
      }

      if (message.t === "hello") {
        if (session.ready) {
          this.reject(socket, "malformed", "hello sent twice");
          socket.close(CloseCode.Malformed, "hello sent twice");
          return;
        }

        if (message.protocolVersion !== PROTOCOL_VERSION) {
          this.reject(
            socket,
            "protocol-version",
            `client speaks ${message.protocolVersion}, server speaks ${PROTOCOL_VERSION}`,
          );
          socket.close(CloseCode.ProtocolVersion, "protocol version");
          return;
        }

        if (message.worldId !== this.worldId) {
          this.reject(
            socket,
            "unknown-world",
            `no world named ${message.worldId}`,
          );
          socket.close(CloseCode.UnknownWorld, "unknown world");
          return;
        }

        if (
          message.nation !== null &&
          message.nation > this.world.nations.length
        ) {
          this.reject(
            socket,
            "unauthorised",
            `no nation ${message.nation} in this world`,
          );
          socket.close(CloseCode.Unauthorised, "unknown nation");
          return;
        }

        clearTimeout(helloTimer);
        session.ready = true;
        session.nation = message.nation;
        this.send(socket, {
          t: "welcome",
          protocolVersion: PROTOCOL_VERSION,
          worldId: this.worldId,
        });
        this.sendFullState(session);
        return;
      }

      if (!session.ready) {
        this.reject(socket, "malformed", "a command before hello");
        socket.close(CloseCode.Malformed, "command before hello");
        return;
      }

      const nation = session.nation;
      if (nation === null) {
        // A watching session sending orders is not a game-rule failure, it is
        // a client that thinks it is someone. Close rather than answer.
        this.reject(socket, "unauthorised", "this session is watching only");
        socket.close(CloseCode.Unauthorised, "not playing");
        return;
      }

      this.handleCommand(session, nation, message);
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

  private handleCommand(
    session: Session,
    nation: number,
    message: ClientCommand,
  ): void {
    session.work = session.work.then(async () => {
      let result: CommandResult;
      try {
        result = await this.submit(nation, message.command);
      } catch (e) {
        // A command the world accepted but could not record is a command that
        // would vanish on the next restart. Refuse it instead.
        result = {
          accepted: false,
          reason: `the world could not record it: ${String(e)}`,
        };
      }
      this.send(session.socket, {
        t: "ack",
        id: message.id,
        accepted: result.accepted,
        ...(result.accepted
          ? { tick: result.tick }
          : { reason: result.reason }),
      });
    });
  }

  private sendFullState(session: Session): void {
    this.send(session.socket, {
      t: "full",
      tick: this.world.currentTick(),
      map: this.world.descriptor,
      nations: this.world.nations,
      nation: session.nation,
      owners: this.world.ownerSnapshot(),
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
    reason: "protocol-version" | "unknown-world" | "malformed" | "unauthorised",
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
