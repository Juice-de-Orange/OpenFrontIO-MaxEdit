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
const GATES = [
  "phase1-gate.mjs",
  "phase2-gate.mjs",
  "phase3-gate.mjs",
  "phase4-gate.mjs",
  "phase5-gate.mjs",
  "phase6-gate.mjs",
];

describe("gate scripts speak the current protocol", () => {
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
