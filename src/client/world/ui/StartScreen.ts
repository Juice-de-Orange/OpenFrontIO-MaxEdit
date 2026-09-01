import { nationCss } from "../Palette";
import { t } from "./strings";

/**
 * The way into the world.
 *
 * Until this existed there was none. The nation came from `?nation=` in the
 * URL and nowhere else, so a visitor who did not already know a number landed
 * as a spectator with no hint that anything else was possible — and every HUD
 * panel hides itself without a nation, so the six menu buttons looked broken
 * rather than empty. "I go to the page and there is no sign-in" was exactly
 * right, and the answer is not a sign-in: it is a choice of nation, which is
 * what an account here actually is.
 *
 * What it asks the server for is `GET /register` — the same path the
 * registration POSTs to, because a reverse proxy has to be told about every
 * path it forwards and a chooser that works locally and 404s in production is
 * worse than none.
 *
 * On a workbench world (`season: false`) nothing is claimed and nothing can
 * be: the screen says so rather than implying a commitment the world will not
 * keep.
 */

export interface NationChoice {
  id: number;
  name: string;
  claimed: boolean;
}

export interface WorldOffer {
  season: boolean;
  /**
   * The nation the asking account already holds, if it sent a token.
   *
   * Only ever the asker's own. Without it a browser holding a token but no
   * remembered nation sees its own country greyed out as taken and every other
   * one refused as "you already hold a different nation" — locked out of a
   * world by its own account.
   */
  yours: number | null;
  nations: NationChoice[];
}

/** What the player decided: a nation to play, or watching. */
export type StartChoice = { kind: "play"; nation: number } | { kind: "watch" };

const STYLE = `
#world-start {
  position: fixed; inset: 0; z-index: 40;
  display: flex; align-items: center; justify-content: center;
  padding: 2rem 1rem;
  background: radial-gradient(120% 90% at 50% 0%, #1d2433 0%, #0e1116 70%);
  font: 15px/1.5 system-ui, sans-serif; color: #e8ecf3;
  overflow-y: auto;
}
#world-start * { box-sizing: border-box; }
#world-start .card {
  width: min(58rem, 100%); margin: auto;
  background: rgba(20,23,30,.82);
  border: 1px solid rgba(255,255,255,.10); border-radius: 14px;
  box-shadow: 0 24px 60px rgba(0,0,0,.45);
  backdrop-filter: blur(8px);
  padding: 1.75rem 1.75rem 1.4rem;
}
#world-start .eyebrow {
  font-size: 12px; letter-spacing: .16em; text-transform: uppercase;
  color: #7f8ca0; margin: 0 0 .35rem;
}
#world-start h1 { margin: 0 0 .5rem; font-size: 26px; font-weight: 650; }
#world-start .lede { margin: 0 0 1.1rem; color: #aab4c4; max-width: 46rem; }
#world-start .filter {
  width: 100%; padding: .55rem .7rem; margin-bottom: .9rem;
  background: rgba(255,255,255,.06); color: inherit; font: inherit;
  border: 1px solid rgba(255,255,255,.14); border-radius: 8px;
}
#world-start .filter:focus {
  outline: none; border-color: rgba(110,168,254,.7);
  background: rgba(255,255,255,.09);
}
#world-start .grid {
  display: grid; gap: .4rem; max-height: 46vh; overflow-y: auto;
  grid-template-columns: repeat(auto-fill, minmax(11.5rem, 1fr));
  padding-right: .25rem;
}
#world-start .nation {
  display: flex; align-items: center; gap: .55rem;
  padding: .5rem .6rem; text-align: left; font: inherit; color: inherit;
  background: rgba(255,255,255,.05);
  border: 1px solid rgba(255,255,255,.10); border-radius: 8px;
  cursor: pointer;
}
#world-start .nation:hover:enabled {
  background: rgba(255,255,255,.11); border-color: rgba(255,255,255,.22);
}
#world-start .nation:disabled { opacity: .34; cursor: not-allowed; }
#world-start .swatch {
  width: .95rem; height: .95rem; flex: 0 0 auto; border-radius: 3px;
  border: 1px solid rgba(0,0,0,.45);
}
#world-start .nation .who {
  flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap;
}
#world-start .yours {
  flex: 0 0 auto; font-size: 11px; color: #8fd0a0;
  text-transform: uppercase; letter-spacing: .06em;
}
#world-start .taken {
  flex: 0 0 auto; font-size: 11px; color: #7f8ca0;
  text-transform: uppercase; letter-spacing: .06em;
}
#world-start .foot {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; margin-top: 1.1rem; padding-top: .9rem;
  border-top: 1px solid rgba(255,255,255,.10);
}
#world-start .note { margin: 0; font-size: 13px; color: #8d97a8; }
#world-start .watch {
  flex: 0 0 auto; padding: .5rem .9rem; font: inherit; color: inherit;
  background: rgba(255,255,255,.06);
  border: 1px solid rgba(255,255,255,.16); border-radius: 8px;
  cursor: pointer;
}
#world-start .watch:hover { background: rgba(255,255,255,.13); }
#world-start .problem {
  margin: 0 0 1rem; padding: .55rem .7rem; border-radius: 8px;
  background: rgba(240,80,120,.14); border: 1px solid rgba(240,80,120,.35);
  color: #ffc7d6;
}
#world-start .empty { color: #8d97a8; padding: 1rem 0; }
`;

function ensureStyle(): void {
  if (document.getElementById("world-start-style") !== null) return;
  const style = document.createElement("style");
  style.id = "world-start-style";
  style.textContent = STYLE;
  document.head.append(style);
}

/**
 * What the world will hand out, or null if it could not be asked.
 *
 * The token goes with the question when there is one, so the answer can say
 * which nation is already this account's.
 */
export async function fetchOffer(
  token: string | null,
): Promise<WorldOffer | null> {
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const response = await fetch("/register", { headers });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<WorldOffer>;
    if (!Array.isArray(body.nations)) return null;
    return {
      season: body.season === true,
      yours: typeof body.yours === "number" ? body.yours : null,
      nations: body.nations,
    };
  } catch {
    return null;
  }
}

/**
 * Show the chooser and resolve with what the player picked.
 *
 * `problem` is for the second time round: a claim can be refused between
 * asking for the list and acting on it, and the honest thing is to say so and
 * let them pick again rather than drop them into a spectator seat they did not
 * ask for.
 */
export function showStartScreen(
  offer: WorldOffer,
  options: { problem?: string; locked?: boolean } = {},
): Promise<StartChoice> {
  const { problem, locked = false } = options;
  ensureStyle();
  document.getElementById("world-start")?.remove();

  const root = document.createElement("div");
  root.id = "world-start";

  const card = document.createElement("div");
  card.className = "card";
  root.append(card);

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = t("start.eyebrow");
  const title = document.createElement("h1");
  title.textContent = t("start.title");
  const lede = document.createElement("p");
  lede.className = "lede";
  lede.textContent = offer.season ? t("start.ledeSeason") : t("start.ledeOpen");
  card.append(eyebrow, title, lede);

  if (problem !== undefined) {
    const box = document.createElement("p");
    box.className = "problem";
    box.textContent = problem;
    card.append(box);
  }

  const filter = document.createElement("input");
  filter.className = "filter";
  filter.type = "search";
  filter.placeholder = t("start.filter");
  filter.autocomplete = "off";
  card.append(filter);

  const grid = document.createElement("div");
  grid.className = "grid";
  card.append(grid);

  return new Promise<StartChoice>((resolve) => {
    const finish = (choice: StartChoice): void => {
      root.remove();
      resolve(choice);
    };

    const draw = (): void => {
      const needle = filter.value.trim().toLowerCase();
      const shown = offer.nations.filter(
        (nation) => needle === "" || nation.name.toLowerCase().includes(needle),
      );
      grid.replaceChildren(
        ...shown.map((nation) => {
          const button = document.createElement("button");
          button.className = "nation";
          button.type = "button";
          // Your own nation is claimed and still yours to walk back into.
          // Disabling it is what locks a player out of their own country.
          const mine = offer.yours === nation.id;
          // `locked` is for a browser that cannot keep the credential. Taking
          // a nation there would claim it for an account the next reload can
          // never sign in as — one nation of the season destroyed per visit.
          button.disabled = locked || (nation.claimed && !mine);
          button.title = locked
            ? t("start.lockedTitle")
            : mine
              ? t("start.yoursTitle", { name: nation.name })
              : nation.claimed
                ? t("start.takenTitle", { name: nation.name })
                : t("start.playTitle", { name: nation.name });

          const swatch = document.createElement("span");
          swatch.className = "swatch";
          swatch.style.background = nationCss(nation.id);

          const who = document.createElement("span");
          who.className = "who";
          who.textContent = nation.name;

          button.append(swatch, who);
          if (mine || nation.claimed) {
            const tag = document.createElement("span");
            tag.className = mine ? "yours" : "taken";
            tag.textContent = mine ? t("start.yours") : t("start.taken");
            button.append(tag);
          }
          button.addEventListener("click", () =>
            finish({ kind: "play", nation: nation.id }),
          );
          return button;
        }),
      );
      if (shown.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty";
        // "No nation by that name" is a lie when there were never any names.
        empty.textContent =
          offer.nations.length === 0
            ? t("start.noNations")
            : t("start.noMatch");
        grid.replaceChildren(empty);
      }
    };

    filter.addEventListener("input", draw);
    draw();

    const foot = document.createElement("div");
    foot.className = "foot";
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = t("start.regentNote");
    const watch = document.createElement("button");
    watch.className = "watch";
    watch.type = "button";
    watch.textContent = t("start.watch");
    watch.addEventListener("click", () => finish({ kind: "watch" }));
    foot.append(note, watch);
    card.append(foot);

    document.body.append(root);
    filter.focus();
  });
}
