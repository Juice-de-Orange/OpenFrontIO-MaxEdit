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
 *
 * **Every command gets an answer, including the ones the connection ate.** A
 * command still waiting when the socket drops is failed locally with a reason,
 * because the alternative is a click that produces nothing and explains
 * nothing.
 */

import {
  CloseCode,
  decodeServerMessage,
  encodeClient,
  PROTOCOL_VERSION,
  type CommandBody,
  type Delta,
  type FullState,
  type ServerAck,
} from "src/shared/protocol/Wire";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export interface WorldSocketHandlers {
  onFullState(state: FullState): void;
  onDelta(delta: Delta): void;
  /** The world's answer to one command, matched by the id sendCommand returned. */
  onAck(ack: ServerAck): void;
  /**
   * Terminal: the connection will not be retried.
   *
   * `refused` separates "this nation is not yours" from everything else. It
   * is the only fatal a player can act on — by choosing another nation — and
   * the only one where the client should forget what it remembered.
   */
  onFatal(message: string, refused?: boolean): void;
  /** The held account token names nothing: drop it before trying again. */
  onStaleToken?(): void;
}

export class WorldSocket {
  private socket: WebSocket | undefined;
  private lastTick: number | undefined;
  private retries = 0;
  private stopped = false;
  private nextCommandId = 1;
  /** Commands sent and not yet answered. */
  private outstanding = new Set<string>();

  constructor(
    private readonly url: string,
    private readonly worldId: string,
    private readonly nation: number | null,
    private readonly handlers: WorldSocketHandlers,
    /** The account token, or null. A season world requires one to play. */
    private readonly token: string | null = null,
  ) {
    this.connect();
  }

  /**
   * Send a command. Returns its id, or null if there is no open connection —
   * the caller has to say so rather than pretend the order was given.
   */
  sendCommand(command: CommandBody): string | null {
    if (
      this.socket === undefined ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      return null;
    }
    const id = `c${this.nextCommandId++}`;
    this.outstanding.add(id);
    this.socket.send(encodeClient({ t: "command", id, command }));
    return id;
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
          nation: this.nation,
          token: this.token,
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
          // Only an *unauthorised* reject is something the player can act on.
          // The reason is on the wire for exactly this, and treating all four
          // alike turned a protocol mismatch into "that nation could not be
          // claimed" with a button that cleared the nation and reloaded
          // straight back into the same mismatch.
          // A stale token is the one refusal this client can put right by
          // itself: the account it holds no longer exists — a browser carried
          // across a world reset — so it forgets the token and the next claim
          // registers a new account. Without this the player is told "that
          // nation could not be claimed" for *every* nation, for ever.
          if (message.reason === "stale-token") this.handlers.onStaleToken?.();
          this.fatal(
            message.detail,
            message.reason === "unauthorised" ||
              message.reason === "stale-token",
          );
          socket.close();
          break;

        case "ack":
          this.outstanding.delete(message.id);
          this.handlers.onAck(message);
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
      this.failOutstanding("the connection dropped before the world answered");
      if (
        event.code === CloseCode.ProtocolVersion ||
        event.code === CloseCode.UnknownWorld ||
        event.code === CloseCode.Malformed ||
        event.code === CloseCode.Unauthorised ||
        // Another connection from this account took over. Terminal, or two
        // browsers would kick each other in a reconnect loop for ever.
        event.code === CloseCode.Superseded
      ) {
        // The server already said why, and it will say the same thing next
        // time. Retrying only hides it.
        //
        // **Saying nothing hides it too.** This used to stop here, so a
        // session refused its nation, or superseded by another browser, went
        // quiet with a map on screen and no explanation anywhere — which is
        // indistinguishable from the world having died.
        this.stopped = true;
        const why =
          event.code === CloseCode.Unauthorised
            ? "The world will not let this session play that nation."
            : event.code === CloseCode.Superseded
              ? "Another browser signed in with this account and took the " +
                "nation over. Only one session at a time."
              : event.code === CloseCode.ProtocolVersion
                ? "This page is older than the world. Reload it."
                : `The world closed the connection (${event.code}).`;
        this.handlers.onFatal(why, event.code === CloseCode.Unauthorised);
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

  private failOutstanding(reason: string): void {
    for (const id of this.outstanding) {
      this.handlers.onAck({ t: "ack", id, accepted: false, reason });
    }
    this.outstanding.clear();
  }

  private fatal(message: string, refused = false): void {
    this.stopped = true;
    this.handlers.onFatal(message, refused);
  }

  close(): void {
    this.stopped = true;
    this.socket?.close();
  }
}
