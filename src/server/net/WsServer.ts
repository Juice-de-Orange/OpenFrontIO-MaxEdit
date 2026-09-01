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
 *
 * The socket shares its port with one HTTP route, `/health`. A world with
 * nobody online still has to be ticking, and "the process accepts
 * connections" is the wrong question — the failure worth catching is a world
 * that is up and *stuck*. So the endpoint reports the tick, how far behind
 * schedule it is and how old the last snapshot is, and fails on the content
 * rather than only on being reachable.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { PRESENCE_REFRESH_TICKS } from "src/shared/config/diplomacy";
import { SNAPSHOT_INTERVAL_TICKS, TICK_MS } from "src/shared/config/time";
import {
  CloseCode,
  decodeClientMessage,
  encodeServer,
  PROTOCOL_VERSION,
  type ClientCommand,
  type CommandBody,
  type NationEconomyView,
  type ServerMessage,
} from "src/shared/protocol/Wire";
import { WebSocketServer, type WebSocket } from "ws";
import type { World, WorldChanges } from "../world/World";
import type { IdentityService } from "./Identity";

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

/** What the world tells the health endpoint about itself. */
export interface WorldStatus {
  tick: number;
  /** The interval this world is actually ticking at. Usually TICK_MS. */
  tickMs: number;
  lagMs: number;
  lastSnapshotTick: number;
  snapshotFailures: number;
  stateHash: number;
}

/** And how stale the newest snapshot may be. Three intervals, same reasoning. */
const MAX_SNAPSHOT_AGE_TICKS = 3 * SNAPSHOT_INTERVAL_TICKS;

interface Session {
  socket: WebSocket;
  ready: boolean;
  nation: number | null;
  /** The account this session authenticated as, on a season world. */
  accountId: string | null;
  /**
   * Commands are handled asynchronously (the log write is awaited), and the
   * ws "message" event is not. Without a chain, two commands sent back to back
   * could be logged in the opposite order to the one they arrived in, and the
   * replay would then differ from the run.
   */
  work: Promise<void>;
  /**
   * The tick this session last told the world it was here.
   *
   * §6.5's dead-partner rule dissolves the agreements of a nation nobody has
   * played for a fortnight, and §4 requires that to be reconstructible from
   * the command log. A connection is not in the log, so a connected session
   * writes a `nation_present` command when it arrives and every so often
   * while it stays — otherwise a player who sits and watches their world for
   * an afternoon would be declared dead in the middle of it.
   */
  seenAt: number;
}

export class WorldSocketServer {
  private readonly wss: WebSocketServer;
  private readonly sessions = new Set<Session>();
  private pingTimer: NodeJS.Timeout | undefined;

  private readonly http: ReturnType<typeof createServer>;

  constructor(
    private readonly world: World,
    private readonly submit: SubmitCommand,
    private readonly worldId: string,
    port: number,
    private readonly status: () => WorldStatus = () => ({
      tick: 0,
      tickMs: TICK_MS,
      lagMs: 0,
      lastSnapshotTick: 0,
      snapshotFailures: 0,
      stateHash: 0,
    }),
    /**
     * Phase 11. `service` answers /register on any world; `season` is what
     * arms the checks — on a season world playing a nation needs a token
     * and holds a claim, on a workbench world the hello works as it always
     * has (decision 0019).
     */
    private readonly identity: {
      service: IdentityService;
      season: boolean;
    } | null = null,
    path = "/ws",
  ) {
    this.http = createServer((request, response) =>
      this.onRequest(request, response),
    );
    this.wss = new WebSocketServer({ server: this.http, path });
    this.http.listen(port);
    this.wss.on("connection", (socket) => this.onConnection(socket));
    this.pingTimer = setInterval(() => {
      for (const s of this.sessions) s.socket.ping();
    }, PING_INTERVAL_MS);
  }

  private onRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.url === "/register" && request.method === "POST") {
      void this.onRegister(request, response);
      return;
    }
    if (request.url !== "/health") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found\n");
      return;
    }

    const status = this.status();
    const snapshotAge = status.tick - status.lastSnapshotTick;
    // Measured against the interval this world is actually running at, not
    // against TICK_MS: a world under WORLD_TICK_MS would otherwise report
    // itself healthy while twenty ticks behind.
    const maxLag = 3 * status.tickMs;
    const healthy =
      status.lagMs <= maxLag &&
      status.snapshotFailures === 0 &&
      snapshotAge <= MAX_SNAPSHOT_AGE_TICKS;

    const body = JSON.stringify(
      {
        worldId: this.worldId,
        healthy,
        tick: status.tick,
        tickMs: status.tickMs,
        lagMs: status.lagMs,
        lastSnapshotTick: status.lastSnapshotTick,
        snapshotAgeTicks: snapshotAge,
        snapshotFailures: status.snapshotFailures,
        connections: this.connectionCount,
        stateHash: status.stateHash.toString(16),
        provinces: this.world.descriptor.provinceCount,
      },
      null,
      2,
    );
    response.writeHead(healthy ? 200 : 503, {
      "content-type": "application/json",
    });
    response.end(body + "\n");
  }

  /**
   * Make an account: a name in, the one copy of a token out (phase 11).
   *
   * Answered on every world, season or not, so a client can hold a
   * credential before the world starts caring about one. The body is
   * bounded — this is a registration, not an upload.
   */
  private async onRegister(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (this.identity === null) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("this world has no account store\n");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > 4096) {
        response.writeHead(413, { "content-type": "text/plain" });
        response.end("too large\n");
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let name = "Anonymous";
    try {
      const body: unknown = JSON.parse(
        Buffer.concat(chunks).toString("utf-8") || "{}",
      );
      if (
        typeof body === "object" &&
        body !== null &&
        "name" in body &&
        typeof (body as { name: unknown }).name === "string" &&
        (body as { name: string }).name.length > 0
      ) {
        name = (body as { name: string }).name.slice(0, 64);
      }
    } catch {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("the body has to be JSON\n");
      return;
    }
    try {
      const made = await this.identity.service.register(name);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          accountId: made.account.id,
          name: made.account.name,
          token: made.token,
        }) + "\n",
      );
    } catch (error) {
      console.error("[world] register failed", error);
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("registration failed\n");
    }
  }

  /**
   * Phase 11's whole question, answered before anything is sent: may this
   * session be this nation? Null means yes; a string is the refusal, and the
   * refusal is all the impostor ever learns (decision 0019).
   */
  private async authorise(
    session: Session,
    nation: number,
    token: string | null,
  ): Promise<string | null> {
    if (this.identity === null || !this.identity.season) return null;
    if (token === null) {
      return "playing a nation on this world needs an account: POST /register";
    }
    const account = await this.identity.service.authenticate(token);
    if (account === null) return "that token belongs to no account";
    const claim = await this.identity.service.claim(nation, account.id);
    if (claim === "taken") {
      return `nation ${nation} is held by another account`;
    }
    if (claim === "elsewhere") {
      return "your account already holds a different nation this season";
    }
    session.accountId = account.id;
    return null;
  }

  private onConnection(socket: WebSocket): void {
    const session: Session = {
      socket,
      ready: false,
      nation: null,
      accountId: null,
      work: Promise.resolve(),
      seenAt: 0,
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

        // Identity, before anything is sent (phase 11). Async, so the rest
        // of the handshake moves into the continuation — and the hello
        // timer keeps running until it lands, which is right: a hello that
        // cannot be authorised is a hello that has not happened.
        void (async () => {
          if (message.nation !== null) {
            const refusal = await this.authorise(
              session,
              message.nation,
              message.token,
            );
            if (refusal !== null) {
              this.reject(socket, "unauthorised", refusal);
              socket.close(CloseCode.Unauthorised, "not yours");
              return;
            }
            // One session per account: a newer connection takes the older
            // one over rather than sitting beside it — reconnecting resumes
            // the session instead of opening a second (§8, phase 11).
            if (session.accountId !== null) {
              for (const other of this.sessions) {
                if (other === session) continue;
                if (other.accountId !== session.accountId) continue;
                other.socket.close(
                  CloseCode.Superseded,
                  "a newer connection from this account took over",
                );
              }
            }
          }
          clearTimeout(helloTimer);
          session.ready = true;
          session.nation = message.nation;
          if (message.nation !== null) this.announcePresence(session);
          this.send(socket, {
            t: "welcome",
            protocolVersion: PROTOCOL_VERSION,
            worldId: this.worldId,
          });
          this.sendFullState(session);
        })();
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
      controllers: this.world.controllerSnapshot(),
      buildings: this.world.buildingSnapshot(),
      trust: this.world.trustSnapshot(),
      agreements: this.world.agreementsFor(session.nation),
      fronts: this.world.frontsView(),
      invasions: this.world.invasionsView(),
      economy: this.economyView(session.nation),
    });
  }

  /**
   * Tell the world somebody is playing this nation.
   *
   * Through `submit` like any other command, so it is written to the log and
   * a replay reaches the same conclusion about who was here. Chained on the
   * session's own work queue for the same reason player commands are: the log
   * has to record the order they actually arrived in.
   *
   * A failure is swallowed. Presence is a courtesy to the dead-partner rule,
   * and closing a player's connection because the world could not record that
   * they were looking at it would be a worse outcome than the rule firing late.
   */
  private announcePresence(session: Session): void {
    const nation = session.nation;
    if (nation === null) return;
    session.seenAt = this.world.currentTick();
    session.work = session.work.then(async () => {
      await this.submit(nation, { kind: "nation_present" }).catch(() => {});
    });
  }

  /**
   * Push this tick's changes to every client past the handshake.
   *
   * The map half is identical for everybody and is encoded once. The economy
   * half is not: a nation's stockpile and construction queue are its own, so
   * that part is built per session. Encoding the whole message per session
   * instead would serialise the province lists once for every connection.
   */
  broadcastDelta(tick: number, changes: WorldChanges): void {
    const shared = {
      t: "delta" as const,
      tick,
      control: changes.control,
      owner: changes.owner,
      buildings: changes.buildings,
    };
    const trust = this.world.trustSnapshot();
    const fronts = this.world.frontsView();
    const invasions = this.world.invasionsView();
    const spectatorPayload = encodeServer({
      ...shared,
      trust,
      fronts,
      invasions,
      agreements: this.world.agreementsFor(null),
      economy: null,
    });
    for (const s of this.sessions) {
      if (!s.ready) continue;
      if (s.nation === null) {
        s.socket.send(spectatorPayload);
        continue;
      }
      // Still here. Cheap, rare, and the only thing standing between a player
      // who is watching rather than clicking and the dead-partner rule.
      if (tick - s.seenAt >= PRESENCE_REFRESH_TICKS) this.announcePresence(s);
      s.socket.send(
        encodeServer({
          ...shared,
          trust,
          fronts,
          invasions,
          agreements: this.world.agreementsFor(s.nation),
          economy: this.economyView(s.nation),
        }),
      );
    }
  }

  /**
   * One nation's economy, as the wire carries it.
   *
   * Recomputed rather than stored: it is a pure function of the world, and a
   * stored copy would have to be in the snapshot and in the state hash to be
   * trustworthy — which would make the restore test guard a number that has no
   * bearing on whether the world came back.
   */
  private economyView(nation: number | null): NationEconomyView | null {
    if (nation === null) return null;
    const economy = this.world.economyOf(nation);
    return {
      nation,
      resources: { ...this.world.view().nations[nation].resources },
      extractionPerTick: economy.extraction,
      demandPerTick: economy.demand,
      sufficiency: economy.sufficiency,
      constructionPerTick: economy.construction,
      industryPerTick: economy.industry,
      queue: this.world.constructionQueueOf(nation).map((order) => ({
        id: order.id,
        provinceId: order.provinceId,
        building: order.building,
        progress: order.progress,
      })),
      ...this.world.tradeView(nation),
      ...this.world.militaryView(nation, economy.sufficiency),
    };
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
    for (const session of this.sessions) session.socket.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}
