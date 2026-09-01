import { describe, expect, test } from "vitest";
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeClient,
  encodeServer,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from "../../src/shared/protocol/Wire";

const hello: ClientMessage = {
  t: "hello",
  protocolVersion: PROTOCOL_VERSION,
  worldId: "world-0",
  nation: 3,
};

describe("the wire protocol", () => {
  test("round-trips every client message", () => {
    const command: ClientMessage = {
      t: "command",
      id: "c1",
      command: { kind: "claim_province", provinceId: 42 },
    };
    for (const message of [hello, command]) {
      expect(decodeClientMessage(encodeClient(message))).toEqual(message);
    }
  });

  test("round-trips every server message", () => {
    const messages: ServerMessage[] = [
      { t: "welcome", protocolVersion: PROTOCOL_VERSION, worldId: "world-0" },
      {
        t: "reject",
        reason: "unauthorised",
        detail: "this session is watching only",
        serverProtocolVersion: PROTOCOL_VERSION,
      },
      { t: "ack", id: "c1", accepted: true, tick: 12 },
      { t: "ack", id: "c2", accepted: false, reason: "not yours to claim" },
      {
        t: "full",
        tick: 7,
        map: {
          id: "europe",
          width: 4,
          height: 4,
          provinceCount: 2,
          terrainHash: 99,
          partitionHash: 1234,
        },
        nations: [{ smallID: 1, name: "One" }],
        nation: 1,
        owners: [1, 0],
        controllers: [1, 2],
        buildings: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        trust: [0, 100, 45],
        agreements: [
          {
            id: 1,
            type: "trade",
            parties: [1, 2],
            terms: {
              resource: "steel",
              resourcePerTick: 0.5,
              pointsPerTick: 0.25,
            },
            accepted: true,
            noticeAt: null,
            noticeBy: null,
          },
          {
            id: 2,
            type: "non_aggression",
            parties: [2, 1],
            terms: null,
            accepted: false,
            noticeAt: null,
            noticeBy: null,
          },
        ],
        fronts: [{ province: 11, attacker: 1, progress: 0.25 }],
        invasions: [{ attacker: 1, to: 9, ticksLeft: 12 }],
        economy: {
          nation: 1,
          resources: { steel: 200, oil: 100, aluminium: 100, rubber: 50 },
          extractionPerTick: { steel: 0.25, oil: 0, aluminium: 0, rubber: 0 },
          demandPerTick: { steel: 0.2, oil: 0, aluminium: 0.04, rubber: 0 },
          sufficiency: 1,
          constructionPerTick: 1.5,
          industryPerTick: 0.4,
          tradePointsIn: 0.5,
          tradePointsOut: 0.25,
          tradeResourcePerTick: {
            steel: 0.1,
            oil: 0,
            aluminium: -0.05,
            rubber: 0,
          },
          queue: [
            {
              id: 7,
              provinceId: 3,
              building: "civilian_factory",
              progress: 12.5,
            },
          ],
          stockpile: [120, 4, 0, 0, 0, 0, 0, 0, 0, 0],
          manpower: 4200,
          manpowerCap: 9000,
          productionLines: [
            {
              id: 1,
              equipment: "infantry_equipment",
              factories: 2,
              efficiency: 0.1,
              outputPerTick: 0.08,
            },
          ],
          divisions: [{ id: 1, provinceId: 3, strength: 0.5, supply: 0.75 }],
          militaryFactoriesAssigned: 2,
          militaryFactoriesTotal: 3,
          dockyardsAssigned: 0,
          dockyardsTotal: 0,
          researchSlots: [
            { tech: "machine_tools", progress: 40, unlocked: true },
            { tech: null, progress: 0, unlocked: true },
            { tech: null, progress: 0, unlocked: false },
            { tech: null, progress: 0, unlocked: false },
          ],
          unlockedTechs: ["excavation"],
          attacks: [
            { province: 11, progress: 0.25 },
            { province: 12, progress: 0 },
          ],
          seaTransits: [
            { id: 1, divisionId: 2, from: 3, to: 9, ticksLeft: 12 },
          ],
          formations: [
            {
              id: 1,
              template: "fighter_wing",
              baseProvinceId: 3,
              zone: 4,
              mission: "air_superiority",
              strength: 0.75,
            },
          ],
          zones: [
            {
              zone: 4,
              kind: "air",
              superiority: 0.6,
              contested: true,
              ownStrength: 0.75,
            },
          ],
        },
      },
      {
        t: "delta",
        tick: 8,
        control: [[0, 1]],
        owner: [],
        buildings: [],
        trust: [0, 100, 45],
        agreements: [],
        fronts: [],
        invasions: [],
        economy: null,
      },
      {
        t: "delta",
        tick: 9,
        control: [],
        owner: [[0, 1]],
        buildings: [[3, 0, 4]],
        trust: [0, 100, 45],
        agreements: [],
        fronts: [],
        invasions: [],
        economy: null,
      },
    ];
    for (const message of messages) {
      expect(decodeServerMessage(encodeServer(message))).toEqual(message);
    }
  });

  test("watching is a nation of null, not a missing field", () => {
    expect(
      decodeClientMessage(JSON.stringify({ ...hello, nation: null })).t,
    ).toBe("hello");
    // Absent is not the same as null. A client that forgets the field is a
    // client whose author has not decided, and guessing on its behalf is how
    // an unauthenticated session ends up holding a nation.
    expect(() =>
      decodeClientMessage(
        JSON.stringify({ t: "hello", protocolVersion: 2, worldId: "w" }),
      ),
    ).toThrow();
  });

  test("refuses anything it cannot read, rather than filling in a default", () => {
    const bad = [
      "not json",
      JSON.stringify({ t: "nonsense" }),
      JSON.stringify({ t: "command", id: "c1", command: { kind: "invade" } }),
      JSON.stringify({
        t: "command",
        id: "c1",
        command: { kind: "claim_province", provinceId: -1 },
      }),
      JSON.stringify({
        t: "command",
        id: "",
        command: { kind: "claim_province", provinceId: 0 },
      }),
      JSON.stringify({ ...hello, nation: 0 }),
      JSON.stringify({ ...hello, worldId: "" }),
    ];
    for (const raw of bad) {
      expect(() => decodeClientMessage(raw), raw).toThrow();
    }
  });

  test("the version is an integer both sides compare, not a range", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    // 1 -> 2 when commands, acks and nation identity arrived. 2 -> 3 when a
    // province gained a controller distinct from its owner: a v2 client would
    // find no `changes` in a delta and draw a map that never moves again.
    // 3 -> 4 for buildings and the private economy view. 4 -> 5 when a
    // construction order gained an id and cancellation stopped naming a
    // position: a v4 client would send `index` and be disconnected as
    // malformed, which is the right answer but only if the version says so
    // first. 5 -> 6 for production lines, the stockpile and divisions. 6 -> 7
    // for research: a v6 client sends no `start_research` and would be
    // disconnected for it, and a v6 server would refuse one it cannot parse.
    // 7 -> 8 when a division gained a supply figure: a v7 client would show a
    // starving army as merely under-equipped, which is the wrong diagnosis and
    // the wrong fix. 8 -> 9 for diplomacy: trust and agreements ride on every
    // full state and every delta, and a v8 client would show a player no offer
    // and no notice of cancellation — the one message in the game that has a
    // deadline attached to it. 9 -> 10 when an attack became a standing order
    // (decision 0014): a v9 client shows no front and offers no way to call one
    // off, so a player would spend equipment on a war they cannot see.
    //
    // 11 adds `formations` and `zones` to the economy view and three
    // formation commands to the union (§6.7). A v10 client would render an
    // air force it cannot see and could not stand a wing down.
    //
    // 12 makes the front a rate (invariant 1): `attacks` carries progress,
    // and `fronts` rides on every full state and delta so defenders and
    // spectators can watch a province being ground into. An v11 client would
    // read an attack list of objects as numbers and paint no front at all.
    //
    // 13 is the sea (§6.8): `naval_invade` joins the commands, the economy
    // view carries the nation's own transits, and `invasions` rides on every
    // full state and delta — the crossing being visible to everyone is what
    // makes garrisoning the beach a real answer to it.
    expect(PROTOCOL_VERSION).toBe(13);
  });
});
