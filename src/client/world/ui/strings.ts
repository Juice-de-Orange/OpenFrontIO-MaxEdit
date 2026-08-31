/**
 * The world client's own strings, English and German side by side.
 *
 * **Not** through `client/i18n/Translate.ts`. That reads its catalogue from a
 * `<lang-selector>` element, which lives in `client/_legacy/` and is
 * quarantined; without one every lookup falls back to its key, so the HUD
 * would read "world.economy.steel" on screen. Wiring the legacy component back
 * in to get four dozen strings would drag the whole quarantined component tree
 * with it.
 *
 * So: one file, both languages, and `de` typed as `Record<Key, string>` so a
 * missing German string is a compile error rather than an English word in the
 * middle of a German sentence. When the HUD grows a language picker of its
 * own, this merges into `resources/lang/` and this file becomes the loader.
 *
 * English is the source language; German is maintained in the same commit.
 */

const en = {
  "hud.watching": "Watching. Add ?nation=<n> to the URL to play one.",
  "hud.notConnected": "Not connected to the world.",
  "hud.orderAccepted": "Order accepted for tick {tick}.",
  "hud.orderRefused": "Order refused: {reason}",

  "economy.title": "Economy",
  "economy.construction": "Construction",
  "economy.industry": "Industry",
  "economy.supplyRatio": "Resources covered",
  "economy.steel": "Steel",
  "economy.oil": "Oil",
  "economy.aluminium": "Aluminium",
  "economy.rubber": "Rubber",
  "economy.perDay": "{value}/day",
  "economy.stock": "{value}",

  "province.title": "Province {id}",
  "province.terrain": "Terrain",
  "province.infrastructure": "Infrastructure",
  "province.slots": "Building slots",
  "province.deposits": "Deposits",
  "province.none": "none",
  "province.owner": "Owner",
  "province.controller": "Held by",
  "province.occupied": "occupied",
  "province.unowned": "unowned",
  "province.capital": "capital",
  "province.coastal": "coastal",
  "province.claim": "Claim this province",
  "province.buildings": "Buildings",
  "province.build": "Build",

  "terrain.plains": "Plains",
  "terrain.highland": "Highland",
  "terrain.mountain": "Mountain",

  "queue.title": "Construction queue",
  "queue.empty": "Nothing under construction.",
  "queue.remaining": "{days} days left",
  "queue.cancel": "Cancel",

  "production.title": "Production",
  "production.factories": "Military factories",
  "production.dockyards": "Dockyards",
  "production.manpower": "Manpower",
  "production.lines": "Production lines",
  "production.noLines": "No production line yet. Nothing is being built.",
  "production.efficiency": "Efficiency",
  "production.output": "Output",
  "production.addFactory": "+ factory",
  "production.removeFactory": "\u2212 factory",
  "production.close": "Close this line",
  "production.open": "Open a line",
  "production.switchTo": "Switch \u2014 throws away {efficiency}",
  "production.stockpile": "Stockpile",
  "production.stockpileEmpty": "Nothing in store.",
  "production.divisions": "Divisions",
  "production.noDivisions": "No divisions raised.",
  "production.divisionAt": "Division {id} \u00b7 province {province}",
  "production.raise": "Raise a division \u2014 {cost} manpower",
  "production.divisionState": "{strength} kit \u00b7 {supply} supply",

  "building.civilian_factory": "Civilian factory",
  "building.military_factory": "Military factory",
  "building.dockyard": "Dockyard",
  "building.synthetic_oil": "Synthetic oil refinery",
  "building.synthetic_rubber": "Synthetic rubber refinery",
  "building.air_base": "Air base",
  "building.naval_base": "Naval base",
  "building.supply_hub": "Supply hub",
  "building.infrastructure": "Infrastructure level",
  "building.extraction_upgrade": "Extraction upgrade",

  "research.title": "Research",
  "research.idle": "Idle",
  "research.locked": "Locked \u2014 research a bureau to open it",
  "research.remaining": "{days} days left",
  "research.cancel": "Abandon",
  "research.start": "Research",
  "research.known": "Known",
  "research.none": "Nothing researched yet.",
  "research.needs": "needs {techs}",

  "tech.machine_tools": "Machine tools",
  "tech.precision_tooling": "Precision tooling",
  "tech.assembly_line": "Assembly line",
  "tech.excavation": "Excavation",
  "tech.deep_mining": "Deep mining",
  "tech.reinforced_concrete": "Reinforced concrete",
  "tech.research_bureau": "Research bureau",
  "tech.field_workshops": "Field workshops",
  "tech.entrenchment": "Entrenchment",

  "equipment.infantry_equipment": "Infantry equipment",
  "equipment.artillery": "Artillery",
  "equipment.armour": "Armour",
  "equipment.fighter": "Fighter",
  "equipment.bomber": "Bomber",
  "equipment.transport": "Transport",
  "equipment.convoy": "Convoy",
  "equipment.submarine": "Submarine",
  "equipment.escort": "Escort",
  "equipment.capital_ship": "Capital ship",
} as const;

export type StringKey = keyof typeof en;

const de: Record<StringKey, string> = {
  "hud.watching":
    "Nur Zuschauer. ?nation=<n> an die URL hängen, um zu spielen.",
  "hud.notConnected": "Keine Verbindung zur Welt.",
  "hud.orderAccepted": "Befehl angenommen für Tick {tick}.",
  "hud.orderRefused": "Befehl abgelehnt: {reason}",

  "economy.title": "Wirtschaft",
  "economy.construction": "Bau",
  "economy.industry": "Industrie",
  "economy.supplyRatio": "Rohstoffe gedeckt",
  "economy.steel": "Stahl",
  "economy.oil": "Öl",
  "economy.aluminium": "Aluminium",
  "economy.rubber": "Gummi",
  "economy.perDay": "{value}/Tag",
  "economy.stock": "{value}",

  "province.title": "Provinz {id}",
  "province.terrain": "Gelände",
  "province.infrastructure": "Infrastruktur",
  "province.slots": "Bauplätze",
  "province.deposits": "Vorkommen",
  "province.none": "keine",
  "province.owner": "Eigentümer",
  "province.controller": "Gehalten von",
  "province.occupied": "besetzt",
  "province.unowned": "herrenlos",
  "province.capital": "Hauptstadt",
  "province.coastal": "Küste",
  "province.claim": "Provinz beanspruchen",
  "province.buildings": "Gebäude",
  "province.build": "Bauen",

  "terrain.plains": "Ebene",
  "terrain.highland": "Hügelland",
  "terrain.mountain": "Gebirge",

  "queue.title": "Bauschlange",
  "queue.empty": "Nichts im Bau.",
  "queue.remaining": "noch {days} Tage",
  "queue.cancel": "Abbrechen",

  "production.title": "Produktion",
  "production.factories": "Militärfabriken",
  "production.dockyards": "Werften",
  "production.manpower": "Menschenreserve",
  "production.lines": "Produktionslinien",
  "production.noLines": "Noch keine Produktionslinie. Es wird nichts gebaut.",
  "production.efficiency": "Effizienz",
  "production.output": "Ausstoß",
  "production.addFactory": "+ Fabrik",
  "production.removeFactory": "\u2212 Fabrik",
  "production.close": "Linie schließen",
  "production.open": "Linie eröffnen",
  "production.switchTo": "Umstellen \u2014 wirft {efficiency} weg",
  "production.stockpile": "Lager",
  "production.stockpileEmpty": "Nichts auf Lager.",
  "production.divisions": "Divisionen",
  "production.noDivisions": "Keine Divisionen aufgestellt.",
  "production.divisionAt": "Division {id} \u00b7 Provinz {province}",
  "production.raise": "Division aufstellen \u2014 {cost} Menschenreserve",
  "production.divisionState": "{strength} Ausrüstung \u00b7 {supply} Nachschub",

  "building.civilian_factory": "Zivile Fabrik",
  "building.military_factory": "Militärfabrik",
  "building.dockyard": "Werft",
  "building.synthetic_oil": "Synthetische Ölraffinerie",
  "building.synthetic_rubber": "Synthetische Gummiraffinerie",
  "building.air_base": "Luftwaffenbasis",
  "building.naval_base": "Marinebasis",
  "building.supply_hub": "Nachschubdepot",
  "building.infrastructure": "Infrastrukturstufe",
  "building.extraction_upgrade": "Förderausbau",

  "research.title": "Forschung",
  "research.idle": "Untätig",
  "research.locked": "Gesperrt \u2014 ein Forschungsamt öffnet ihn",
  "research.remaining": "noch {days} Tage",
  "research.cancel": "Abbrechen",
  "research.start": "Erforschen",
  "research.known": "Bekannt",
  "research.none": "Noch nichts erforscht.",
  "research.needs": "braucht {techs}",

  "tech.machine_tools": "Werkzeugmaschinen",
  "tech.precision_tooling": "Präzisionswerkzeuge",
  "tech.assembly_line": "Fließband",
  "tech.excavation": "Abbautechnik",
  "tech.deep_mining": "Tiefbau",
  "tech.reinforced_concrete": "Stahlbeton",
  "tech.research_bureau": "Forschungsamt",
  "tech.field_workshops": "Feldwerkstätten",
  "tech.entrenchment": "Feldbefestigung",

  "equipment.infantry_equipment": "Infanterieausrüstung",
  "equipment.artillery": "Artillerie",
  "equipment.armour": "Panzer",
  "equipment.fighter": "Jäger",
  "equipment.bomber": "Bomber",
  "equipment.transport": "Transportflugzeug",
  "equipment.convoy": "Geleitzug",
  "equipment.submarine": "U-Boot",
  "equipment.escort": "Geleitschiff",
  "equipment.capital_ship": "Großkampfschiff",
};

const CATALOGUES: Record<string, Record<StringKey, string>> = { en, de };

/**
 * The language, from the browser, once.
 *
 * No picker yet — one belongs with the account screens rather than ahead of
 * them. Anything that is not German gets English.
 */
function language(): string {
  const preferred =
    typeof navigator === "undefined" ? "en" : (navigator.language ?? "en");
  return preferred.toLowerCase().startsWith("de") ? "de" : "en";
}

const catalogue = CATALOGUES[language()];

/** `{name}` placeholders, substituted positionally by name. */
export function t(
  key: StringKey,
  params: Record<string, string | number> = {},
): string {
  const template = catalogue[key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
