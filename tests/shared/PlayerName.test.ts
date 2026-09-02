import { describe, expect, test } from "vitest";
import {
  hasPlayerName,
  MAX_PLAYER_NAME,
  NO_PLAYER_NAME,
  normalisePlayerName,
} from "../../src/shared/protocol/PlayerName";

/**
 * The one rule about a player's name (decision 0024), pinned so the client
 * and the server cannot drift apart on it: both call this function.
 */
describe("a player's name", () => {
  test("is trimmed and its whitespace collapsed", () => {
    expect(normalisePlayerName("  Max   Oberrauch ")).toBe("Max Oberrauch");
    // A tab is whitespace too, and becomes one space rather than a refusal.
    expect(normalisePlayerName("tab\tname")).toBe("tab name");
  });

  test("empty is not refused — it is no name", () => {
    expect(normalisePlayerName("")).toBe("");
    expect(normalisePlayerName("   ")).toBe("");
    expect(hasPlayerName("")).toBe(false);
    expect(hasPlayerName(NO_PLAYER_NAME)).toBe(false);
    expect(hasPlayerName("Max")).toBe(true);
  });

  test("letters of any script, digits, spaces, dots, apostrophes and hyphens pass", () => {
    for (const name of [
      "Max",
      "Erzsébet Horváth",
      "Jean-Luc",
      "O'Brien",
      "J. R. 7",
      "Зоран",
      "Åke",
    ]) {
      expect(normalisePlayerName(name)).toBe(name);
    }
  });

  test("anything else is refused, and so is too short or too long", () => {
    for (const name of [
      "M",
      "<script>",
      "max@home",
      "a".repeat(MAX_PLAYER_NAME + 1),
      "emoji 🙂",
    ]) {
      expect(normalisePlayerName(name)).toBeNull();
    }
    expect(normalisePlayerName("a".repeat(MAX_PLAYER_NAME))).toHaveLength(
      MAX_PLAYER_NAME,
    );
  });
});
