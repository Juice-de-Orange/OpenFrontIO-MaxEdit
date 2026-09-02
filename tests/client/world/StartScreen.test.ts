import { beforeEach, describe, expect, test } from "vitest";
import {
  showStartScreen,
  type WorldOffer,
} from "../../../src/client/world/ui/StartScreen";

/**
 * The nation chooser asks for a name (decision 0024): optional, validated by
 * the shared rule before anything is sent, and carried out with the choice.
 */
function offer(): WorldOffer {
  return {
    season: true,
    yours: null,
    nations: [
      { id: 1, name: "Testland", claimed: false },
      { id: 2, name: "Otherland", claimed: true },
    ],
  };
}

const input = (): HTMLInputElement =>
  document.querySelector("#world-start .name input") as HTMLInputElement;
const nationButton = (label: string): HTMLButtonElement => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>(
      "#world-start button.nation",
    ),
  ].find((b) => b.textContent?.includes(label));
  if (found === undefined) throw new Error(`no nation button ${label}`);
  return found;
};

beforeEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe("the chooser's name field", () => {
  test("a name typed goes out with the nation, normalised", async () => {
    const choice = showStartScreen(offer());
    input().value = "  Max   O'Brien ";
    input().dispatchEvent(new Event("input"));
    nationButton("Testland").click();
    await expect(choice).resolves.toEqual({
      kind: "play",
      nation: 1,
      name: "Max O'Brien",
    });
    expect(document.getElementById("world-start")).toBeNull();
  });

  test("an empty field is a choice to stay anonymous", async () => {
    const choice = showStartScreen(offer());
    nationButton("Testland").click();
    await expect(choice).resolves.toEqual({
      kind: "play",
      nation: 1,
      name: "",
    });
  });

  test("a name the server would refuse locks the nations and says why", () => {
    void showStartScreen(offer());
    input().value = "<script>";
    input().dispatchEvent(new Event("input"));
    expect(nationButton("Testland").disabled).toBe(true);
    expect(input().getAttribute("aria-invalid")).toBe("true");
    const bad = document.querySelector<HTMLElement>("#world-start .name .bad");
    expect(bad?.hidden).toBe(false);
    expect(bad?.textContent).toContain("2 to 24");
    // Fixing it unlocks them again.
    input().value = "Max";
    input().dispatchEvent(new Event("input"));
    expect(nationButton("Testland").disabled).toBe(false);
    expect(nationButton("Otherland").disabled).toBe(true); // taken, not the name
  });

  test("a browser that already has an account is not asked again", () => {
    void showStartScreen(offer(), { named: false });
    expect(document.querySelector("#world-start .name")).toBeNull();
    expect(nationButton("Testland").disabled).toBe(false);
  });

  test("watching needs no name", async () => {
    const choice = showStartScreen(offer());
    input().value = "<script>";
    input().dispatchEvent(new Event("input"));
    (
      document.querySelector("#world-start .watch") as HTMLButtonElement
    ).click();
    await expect(choice).resolves.toEqual({ kind: "watch" });
  });
});
