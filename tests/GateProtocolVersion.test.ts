import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";
import { PROTOCOL_VERSION } from "../src/shared/protocol/Wire";

/**
 * The gate scripts are .mjs and cannot import the protocol module, so each
 * restates the version it speaks. A restated constant drifts, and when this
 * one drifted the gate stopped at "the world refused the connection" — the
 * gate failing rather than the world, which is the failure that wastes the
 * most time because it looks like a real one.
 */
/**
 * Found rather than listed. The hand-kept version of this list silently missed
 * `phase7-gate.mjs` for a whole phase — the drift this test exists to catch,
 * happening to the test itself. A directory read cannot forget a file.
 */
const GATES = fs
  .readdirSync(path.resolve(__dirname, "../scripts"))
  .filter((name) => /^phase\d+-gate\.mjs$/.test(name))
  .sort();

describe("gate scripts speak the current protocol", () => {
  test("there are gates to check", () => {
    expect(GATES.length).toBeGreaterThan(0);
  });

  for (const gate of GATES) {
    test(gate, () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, "../scripts", gate),
        "utf-8",
      );
      const match = /^const PROTOCOL_VERSION = (\d+);$/m.exec(source);
      expect(match, `${gate} declares no PROTOCOL_VERSION`).not.toBeNull();
      expect(Number(match?.[1])).toBe(PROTOCOL_VERSION);
    });
  }
});
