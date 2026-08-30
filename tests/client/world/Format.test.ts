import { describe, expect, test } from "vitest";
import {
  daysRemaining,
  fraction,
  percent,
  perDay,
  share,
} from "../../../src/client/world/ui/Format";
import { TICKS_PER_DAY } from "../../../src/shared/config/time";

/**
 * Invariant 9 is a UI rule, so this is where it can actually be checked: the
 * simulation thinks in ticks and the player is never shown one.
 */
describe("the number vocabulary", () => {
  test("a rate is multiplied into in-game days", () => {
    expect(perDay(0.5)).toContain(String(0.5 * TICKS_PER_DAY));
    expect(perDay(0)).toContain("0");
  });

  test("a capacity is a filled fraction, not a remainder", () => {
    expect(fraction(4, 6)).toBe("4 / 6");
  });

  test("a modifier carries its sign; a share does not", () => {
    expect(percent(0.25)).toBe("+25%");
    expect(percent(-0.25)).toBe("-25%");
    expect(share(0.84)).toBe("84%");
    expect(share(1)).toBe("100%");
  });

  test("days remaining round up, so nothing finishes earlier than promised", () => {
    // Half a day's worth left at one point per tick.
    expect(daysRemaining(TICKS_PER_DAY / 2, 1)).toBe(1);
    expect(daysRemaining(TICKS_PER_DAY * 2, 1)).toBe(2);
    expect(daysRemaining(TICKS_PER_DAY * 2 + 1, 1)).toBe(3);
  });

  test("nothing being built never reports a finish date", () => {
    expect(daysRemaining(100, 0)).toBe(Infinity);
  });
});
