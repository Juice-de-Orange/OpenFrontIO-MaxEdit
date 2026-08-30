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
      },
      { t: "delta", tick: 8, control: [[0, 1]], owner: [] },
      { t: "delta", tick: 9, control: [], owner: [[0, 1]] },
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
    // Bumped from 1 when commands, acks and nation identity arrived, and from
    // 2 when a province gained a controller distinct from its owner: a v2
    // client would find no `changes` in a delta and draw a map that never
    // moves again.
    expect(PROTOCOL_VERSION).toBe(3);
  });
});
