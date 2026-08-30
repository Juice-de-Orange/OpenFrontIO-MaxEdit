/**
 * The client's end of the world connection.
 *
 * Three rules here are worth more than the code around them:
 *
 * **A version mismatch is terminal.** No reconnect, no backoff — a visible
 * message and a stop. Retrying turns a version disagreement into an infinite
 * loop that looks like a network problem, and the fix (reload for the new
 * bundle) is one the player has to make.
 *
 * **A gap in tick numbers closes the connection.** Reconnecting re-fetches
 * full state, which is cheap; carrying on with a missing delta leaves a
 * permanently wrong picture and no error. Five lines against the failure the
 * whole architecture is arranged to avoid.
 *
 * **Reconnect means full state, never a delta replay** (CLAUDE.md §4).
 */

import {
  CloseCode,
  decodeServerMessage,
  encodeClient,
  PROTOCOL_VERSION,
  type Delta,
  type FullState,
} from "src/shared/protocol/Wire";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export interface WorldSocketHandlers {
  onFullState(state: FullState): void;
  onDelta(delta: Delta): void;
  /** Terminal: the connection will not be retried. */
  onFatal(message: string): void;
}

export class WorldSocket {
  private socket: WebSocket | undefined;
  private lastTick: number | undefined;
  private retries = 0;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly worldId: string,
    private readonly handlers: WorldSocketHandlers,
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      socket.send(
        encodeClient({
          t: "hello",
          protocolVersion: PROTOCOL_VERSION,
          worldId: this.worldId,
        }),
      );
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = decodeServerMessage(String(event.data));
      } catch (e) {
        this.fatal(`The server sent something this client cannot read: ${e}`);
        socket.close();
        return;
      }

      switch (message.t) {
        case "welcome":
          // Checked again on this side: an older server might not read the
          // field we sent, and would welcome us regardless.
          if (message.protocolVersion !== PROTOCOL_VERSION) {
            this.fatal(
              `Protocol mismatch: this client speaks ${PROTOCOL_VERSION}, ` +
                `the world speaks ${message.protocolVersion}. Reload the page.`,
            );
            socket.close();
          }
          this.retries = 0;
          break;

        case "reject":
          this.fatal(`The world refused the connection: ${message.detail}`);
          socket.close();
          break;

        case "full":
          this.lastTick = message.tick;
          this.handlers.onFullState(message);
          break;

        case "delta":
          if (
            this.lastTick !== undefined &&
            message.tick !== this.lastTick + 1
          ) {
            // A missed delta leaves the map permanently wrong and silent.
            // Drop the connection; reconnecting re-fetches full state.
            console.warn(
              `[world] tick gap: expected ${this.lastTick + 1}, got ${message.tick}`,
            );
            socket.close();
            return;
          }
          this.lastTick = message.tick;
          this.handlers.onDelta(message);
          break;
      }
    });

    socket.addEventListener("close", (event) => {
      if (this.stopped) return;
      if (
        event.code === CloseCode.ProtocolVersion ||
        event.code === CloseCode.UnknownWorld ||
        event.code === CloseCode.Malformed
      ) {
        // The server already said why, and it will say the same thing next
        // time. Retrying only hides it.
        this.stopped = true;
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // "close" always follows, and carries the code; nothing to do here.
    });
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.retries,
    );
    this.retries++;
    // lastTick is cleared so the next connection's full state is accepted at
    // whatever tick the world has reached in the meantime.
    this.lastTick = undefined;
    setTimeout(() => this.connect(), delay);
  }

  private fatal(message: string): void {
    this.stopped = true;
    this.handlers.onFatal(message);
  }

  close(): void {
    this.stopped = true;
    this.socket?.close();
  }
}
