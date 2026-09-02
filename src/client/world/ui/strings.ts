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
 * middle of a German sentence. The picker in the bar (`setLanguage`) switches
 * the catalogue and remembers the choice in `localStorage`; merging into
 * `resources/lang/` is a separate step for when there is a third language.
 *
 * English is the source language; German is maintained in the same commit.
 */

const en = {
  "hud.brand": "OpenFront",
  "hud.brandSub": "a world that keeps running",
  "hud.watching": "Watching. Choose a nation to play one.",
  "hud.chooseNation": "Choose a nation",
  "hud.spectator":
    "You are watching this world. Every panel here belongs to a nation, so " +
    "there is nothing in them until you have one.",
  "hud.notConnected": "Not connected to the world.",
  "hud.orderAccepted": "Order accepted.",
  "hud.info": "What is this?",
  "hud.language": "Language",
  "hud.orderRefused": "Order refused: {reason}",
  "hud.clock": "Day {day} \u00b7 {hour}:00",

  "economy.title": "Economy",
  "victory.holding": "{bloc} stand on the victory threshold",
  "victory.won": "The season is decided: {bloc} — {how}",
  "victory.domination": "by holding the map",
  "victory.score": "on points, at the season's end",
  "regent.title": "Regent",
  "regent.enabled": "Let the regent play while you are away",
  "regent.focus.economy": "Focus: economy",
  "regent.focus.military": "Focus: military",
  "regent.focus.defence": "Focus: defence",
  "regent.focus.expansion": "Focus: expansion",
  "regent.focus": "Focus",
  "regent.focusHint":
    "Where it puts your construction and production while it plays. It never " +
    "changes a production line that is already running — switching one throws " +
    "away the efficiency it has earned.",
  "regent.budget": "Market budget a day",
  "regent.budgetHint":
    "The most construction it may spend a day buying resources on the world " +
    "market, and only to replace an import that stopped. Zero means it never " +
    "buys.",
  "regent.what":
    "Plays your nation while you are away: keeps units supplied, pulls back " +
    "ones that are collapsing, keeps the build queue and the research slots " +
    "full. It never signs or breaks an agreement, never declares war and " +
    "never gives up your capital.",
  "regent.apply": "Set the regent",
  "economy.construction": "Construction",
  "economy.industry": "Industry",
  "economy.supplyRatio": "Resources covered",
  "economy.tradeShare": "of it from trade",
  "economy.howToBuild":
    "To build something, click one of your provinces on the map.",
  "economy.steel": "Steel",
  "economy.oil": "Oil",
  "economy.aluminium": "Aluminium",
  "economy.rubber": "Rubber",
  "economy.perDay": "{value}/day",
  "economy.stock": "{value}",
  "economy.resources": "Resources",
  "economy.civilianFactories": "from {count} civilian factories",
  "nation.withRuler": "{name} \u00b7 {ruler}",
  "battle.title": "The battle",
  "battle.strength": "Strength, attacker \u00b7 defender",
  "battle.divisions": "{attacker} \u00b7 {defender} divisions",
  "battle.modifiers": "Terrain \u00b7 air",
  "battle.advance": "The line moves",
  "battle.perDay": "{value} a day",
  "battle.losses": "Losses, attacker \u00b7 defender",

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
  "province.attack": "Attack this province",
  "province.callOff": "Call off the attack",
  "province.invade": "Invade from the sea",
  "province.attacking": "Your front is grinding here, every tick.",
  "province.underAttack": "Under attack by {attacker}",
  "province.frontOwn": "Your front is here",
  "province.frontTaken": "{share} of the province taken",
  "province.defenders": "Your divisions here",
  "province.divisionLine":
    "Division {id} \u00b7 strength {strength} \u00b7 supply {supply}",
  "province.invasionIncoming":
    "Invasion coming from {attacker} \u2014 lands in {days} days",
  "province.invasionOwn": "Your invasion lands here in {days} days",
  "province.buildings": "Buildings",
  "province.build": "Build",
  "build.occupied": "occupied territory \u2014 build in provinces you own",
  "build.noSlot": "no free building slot",
  "build.notCoastal": "needs a coast",
  "build.maxed": "at the limit of {max}",
  "build.needsManpower": "needs {cost} manpower, you have {have}",

  "terrain.plains": "Plains",
  "terrain.highland": "Highland",
  "terrain.mountain": "Mountain",

  "queue.title": "Construction queue",
  "queue.empty": "Nothing under construction.",
  "queue.remaining": "{days} days left",
  "queue.cancel": "Cancel",
  "queue.howToBuild": "To build, click one of your provinces on the map.",

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
  "production.fronts": "Fronts",
  "air.title": "Air and sea",
  "air.zone": "Zone {zone}",
  "air.seaZone": "Sea zone {zone}",
  "air.noZones": "No zone you can see anything over.",
  "air.superiority": "{value} of the sky",
  "air.uncontested": "unopposed",
  "air.formations": "Wings",
  "air.noFormations": "No wings raised.",
  "air.onTheGround": "on the ground at province {province}",
  "air.flying": "zone {zone} \u00b7 {mission}",
  "air.bringHome": "Bring it home",
  "air.assign": "Send a wing",
  "air.outOfReach": "out of reach",
  "air.reachHint":
    "A wing flies over its base's zone and the zones next to it.",
  "air.missionsHint": "Eight missions: four for the sky, four for the sea.",
  "air.send": "Send",
  "air.raise": "{what} \u2014 {cost} manpower",
  "formation.fighter_wing": "Fighter wing",
  "formation.bomber_wing": "Bomber wing",
  "formation.submarine_flotilla": "Submarine flotilla",
  "formation.escort_group": "Escort group",
  "formation.battle_fleet": "Battle fleet",
  "mission.air_superiority": "Fight for the sky",
  "mission.ground_support": "Support the ground",
  "mission.interdiction": "Cut their supply",
  "mission.strategic_bombing": "Bomb their industry",
  "mission.sea_control": "Control the sea",
  "mission.convoy_raiding": "Raid convoys",
  "mission.convoy_escort": "Escort convoys",
  "mission.invasion_support": "Support a landing",
  "production.noDivisions": "No divisions raised.",
  "production.divisionAt": "Division {id} \u00b7 province {province}",
  "production.raise": "Raise a division \u2014 {cost} manpower",
  "production.divisionState": "{strength} kit \u00b7 {supply} supply",
  "production.atSea": "Division {id} \u00b7 at sea, {days} days out",

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
  "research.available": "Available",
  "research.needs": "needs {techs}",
  "research.noSlot": "no free slot",
  "research.how":
    "Each slot researches one technology at a time. It costs nothing but the slot.",
  "effect.factoryOutput": "{value} factory output",
  "effect.efficiencyCap": "{value} efficiency cap",
  "effect.extraction": "{value} resource extraction",
  "effect.construction": "{value} construction speed",
  "effect.researchSlots": "{value} research slot",
  "effect.reinforceRate": "{value} reinforcement rate",
  "effect.defenderLoss": "{value} defender losses",

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

  "diplomacy.title": "Diplomacy",
  "diplomacy.trust": "Your trust",
  "diplomacy.trustShort": "trust {trust}",
  "diplomacy.tradeBalance": "Points in / out",
  "diplomacy.offers": "Offers to you",
  "diplomacy.noOffers": "Nobody has offered you anything.",
  "diplomacy.offered": "{type}, offered to",
  "diplomacy.accept": "Accept",
  "diplomacy.decline": "Decline",
  "diplomacy.withdraw": "Withdraw the offer",
  "diplomacy.standing": "Standing agreements",
  "diplomacy.noneStanding":
    "None. Every agreement here lasts until somebody ends it.",
  "diplomacy.terms": "{rate} {resource} for {points} construction",
  "diplomacy.youSend": "You send {terms}",
  "diplomacy.youReceive": "You receive {terms}",
  "diplomacy.cancel": "Give notice — costs {trust} trust",
  "diplomacy.noticeGiven": "You gave notice. It stops in a day.",
  "diplomacy.noticeReceived": "{nation} gave notice. It stops in a day.",
  "diplomacy.propose": "Offer an agreement",
  "diplomacy.send": "Send the offer",
  "diplomacy.market": "World market",
  "diplomacy.flows": "Standing flows",
  "diplomacy.marketRates": "buy {buy} / sell {sell}",
  "diplomacy.netFlow": "standing order: {rate}",
  "diplomacy.setOrder": "Set the standing order (per day, minus sells)",

  "agreement.non_aggression": "Non-aggression",
  "agreement.trade": "Trade",
  "agreement.alliance": "Alliance",
  "agreement.military_access": "Military access",
  "help.economy.construction":
    "Construction points a day, made by your civilian factories, after what trade takes or brings. They go into the front item of the construction queue, and they are the currency of every trade agreement.",
  "help.economy.tradeShare":
    "How much of that construction comes from standing trade agreements, or goes out to pay for imports. Negative means you are paying for resources with construction.",
  "help.economy.industry":
    "What your military factories and dockyards turn out a day across every production line, after efficiency and resource shortages.",
  "help.economy.supplyRatio":
    "How much of the resources your factories ask for they actually get. Below 100% every line runs slower in proportion. Nothing ever stops for want of steel; it only runs worse.",
  "help.economy.resources":
    "The stockpile, then its change a day: what your provinces extract, minus what your factories use, plus or minus trade. Refineries turn steel into oil or rubber; the world market sells anything, at bad rates.",
  "help.research.slots":
    "A slot works on one technology, an hour of progress a tick. It costs nothing but the slot. Two slots to begin with; the research bureau opens a third.",
  "help.research.techs":
    "Every technology is a flat modifier or a new equipment tier, shown under its name. A greyed one names the prerequisite it is missing.",
  "help.air.zones":
    "A zone is a group of provinces. You assign a wing or a fleet to a zone with a mission; the world resolves the fight there every tick. You never fly an aircraft yourself.",
  "help.air.base":
    "A wing is raised where an air base stands and a fleet where a naval base stands. The button appears in that province's panel and nowhere else. Build the base first.",
  "help.air.reach":
    "A wing flies over its base's own zone and the zones bordering it. Farther zones are listed greyed and cannot be chosen. A base nearer the front is the answer.",
  "help.air.missions":
    "Four missions for the sky: fight for it (air superiority, which every other mission depends on), support the ground (your fronts in the zone hit harder), cut their supply (their divisions in the zone get less), bomb their industry (their factories in the zone make less). Four for the sea: control it (a landing needs it, and it shields your own convoys), raid convoys (sinks the enemy's, cutting sea supply and seaborne trade), escort convoys (the counter), support a landing (a bonus to invasions next to the zone).",
  "help.queue":
    "Worked from the top: the front item gets the construction points, the rest wait their turn. A civilian factory is about ten in-game days of a young nation's whole output.",
  "help.production.lines":
    "A line ties military factories to one equipment type. Its efficiency climbs slowly while it runs unchanged, and falls back to the floor the moment you switch what it makes — the switch button names the price.",
  "help.production.stockpile":
    "Everything the lines make lands here. Divisions, wings and fleets draw from it to reach full strength, and every battle destroys some of it for good.",
  "help.production.divisions":
    "Strength is equipment held against a full division; supply is how much of what it needs gets through. A weak division needs the stockpile; an unsupplied one needs a hub or a shorter line.",
  "help.production.fronts":
    "A standing attack on a province. It grinds every tick and costs equipment while it stands. Calling it off loses its progress.",
  "help.diplomacy.trust":
    "Public, 0 to 100, and spent by breaking agreements: a little for a trade, a lot for an alliance, almost all of it for attacking a nation you promised not to. It never comes back.",
  "help.diplomacy.agreements":
    "Every agreement stands until one side gives notice — no durations, no renewals. Notice takes one in-game day and costs trust, and the other side is told at once.",
  "help.province.slots":
    "Every building but roads and mines takes a slot, and a queued order holds its slot too. When they are full, more land is the only way to more.",
  "help.province.control":
    "Held by is who stands on it; Owner is whose it is. A province taken in war is held first and owned later, and an occupied factory produces less for its occupier than it did for its owner.",
  "help.province.terrain":
    "Terrain multiplies the defence. Plains are level; highland and mountains favour whoever is already there, so the same army takes longer to grind a mountain province down.",
  "help.province.infrastructure":
    "0 to 10. Carries supply further along this province and speeds construction in it. Built as a level rather than in a slot — a road costs no factory its place.",
  "help.province.deposits":
    "What the province extracts each day into the national stock. An extraction upgrade raises it; nothing else here does, and a province without deposits extracts nothing however many factories it has.",
  "help.production.factories":
    "Military factories and dockyards in the provinces you hold, against those assigned to a production line. An idle factory still consumes resources and makes nothing; the regent puts idle ones to work.",
  "help.production.manpower":
    "A population-scaled cap that regrows slowly. Raising a division or a wing spends it and nothing gives it back faster — a fresh world takes a couple of in-game days to have any at all.",
  "help.diplomacy.offers":
    "Proposals made to you. Accepting a trade starts the flow on the next tick; the terms are seen only by the two of you, and everyone else sees only that you are talking.",
  "help.diplomacy.flows":
    "The standing trades as they actually move, per day: what arrives, what leaves, and the construction points paid or received. A route across water moves on convoys and can be raided.",

  "start.eyebrow": "A world that keeps running",
  "start.title": "Choose your nation",
  "start.ledeSeason":
    "This world does not wait for you. Pick a nation and it is yours for the " +
    "season — one nation, one account, no swapping. While you are away your " +
    "regent keeps it supplied and building.",
  "start.ledeOpen":
    "This is a workbench world: nothing is claimed and nothing is kept. Take " +
    "any nation, come back as another, break whatever you like.",
  "start.filter": "Search a nation",
  "start.taken": "taken",
  "start.yours": "yours",
  "start.yoursTitle": "{name} is yours — go back in",
  "start.noNations": "This world has no nations to choose from.",
  "start.lockedTitle": "This browser cannot keep an account",
  "start.noStorage":
    "This browser is not letting the page store anything, so an account " +
    "cannot be kept: the nation would be lost on the next reload and stay " +
    "claimed for the rest of the season. Allow site data for this page, or " +
    "watch instead.",
  "start.takenTitle": "{name} is already being played",
  "start.playTitle": "Play {name}",
  "start.noMatch": "No nation by that name.",
  "start.watch": "Just watch",
  "start.name": "Your name",
  "start.nameHint":
    "Shown to every other player in place of your regent's. Leave it empty to stay anonymous. 2 to 24 letters, digits, spaces, dots, apostrophes or hyphens.",
  "start.nameBad":
    "That name will be refused: 2 to 24 letters, digits, spaces, dots, apostrophes or hyphens.",
  "start.regentNote":
    "Watching needs no account, and you can choose a nation later.",
  "start.refused": "That nation could not be claimed: {reason}",
  "start.offline":
    "The world did not answer, so there is nothing to choose from yet.",
} as const;

export type StringKey = keyof typeof en;

const de: Record<StringKey, string> = {
  "hud.brand": "OpenFront",
  "hud.brandSub": "eine Welt, die weiterläuft",
  "hud.watching": "Nur Zuschauer. Wähle eine Nation, um zu spielen.",
  "hud.chooseNation": "Nation wählen",
  "hud.spectator":
    "Du schaust dieser Welt zu. Jedes Panel hier gehört einer Nation — " +
    "solange du keine hast, steht nichts darin.",
  "hud.notConnected": "Keine Verbindung zur Welt.",
  "hud.orderAccepted": "Befehl angenommen.",
  "hud.info": "Was ist das?",
  "hud.language": "Sprache",
  "hud.orderRefused": "Befehl abgelehnt: {reason}",
  "hud.clock": "Tag {day} \u00b7 {hour}:00",

  "economy.title": "Wirtschaft",
  "victory.holding": "{bloc} stehen an der Siegschwelle",
  "victory.won": "Die Season ist entschieden: {bloc} — {how}",
  "victory.domination": "durch Halten der Karte",
  "victory.score": "nach Punkten, am Ende der Season",
  "regent.title": "Regent",
  "regent.enabled": "Der Regent spielt, wenn du weg bist",
  "regent.focus.economy": "Fokus: Wirtschaft",
  "regent.focus.military": "Fokus: Militär",
  "regent.focus.defence": "Fokus: Verteidigung",
  "regent.focus.expansion": "Fokus: Expansion",
  "regent.focus": "Schwerpunkt",
  "regent.focusHint":
    "Wohin er deine Bauleistung und Produktion lenkt, während er spielt. Eine " +
    "laufende Produktionslinie stellt er nie um — ein Wechsel wirft die " +
    "Effizienz weg, die sie sich erarbeitet hat.",
  "regent.budget": "Marktbudget pro Tag",
  "regent.budgetHint":
    "Höchstens so viel Bauleistung darf er am Tag ausgeben, um Rohstoffe am " +
    "Weltmarkt zu kaufen — und nur, um einen weggebrochenen Import zu " +
    "ersetzen. Null heißt: er kauft nie.",
  "regent.what":
    "Spielt deine Nation, während du weg bist: hält Einheiten versorgt, zieht " +
    "zusammenbrechende zurück, hält Bauschlange und Forschungsplätze voll. Er " +
    "schließt und bricht nie ein Abkommen, erklärt keinen Krieg und gibt deine " +
    "Hauptstadt nicht auf.",
  "regent.apply": "Regent einstellen",
  "economy.construction": "Bau",
  "economy.industry": "Industrie",
  "economy.supplyRatio": "Rohstoffe gedeckt",
  "economy.tradeShare": "davon aus Handel",
  "economy.howToBuild":
    "Zum Bauen eine eigene Provinz auf der Karte anklicken.",
  "economy.steel": "Stahl",
  "economy.oil": "Öl",
  "economy.aluminium": "Aluminium",
  "economy.rubber": "Gummi",
  "economy.perDay": "{value}/Tag",
  "economy.stock": "{value}",
  "economy.resources": "Rohstoffe",
  "economy.civilianFactories": "aus {count} Zivilfabriken",
  "nation.withRuler": "{name} \u00b7 {ruler}",
  "battle.title": "Die Schlacht",
  "battle.strength": "St\u00e4rke, Angreifer \u00b7 Verteidiger",
  "battle.divisions": "{attacker} \u00b7 {defender} Divisionen",
  "battle.modifiers": "Gel\u00e4nde \u00b7 Luft",
  "battle.advance": "Die Linie bewegt sich",
  "battle.perDay": "{value} pro Tag",
  "battle.losses": "Verluste, Angreifer \u00b7 Verteidiger",

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
  "province.attack": "Diese Provinz angreifen",
  "province.callOff": "Angriff abbrechen",
  "province.invade": "Von See her anlanden",
  "province.attacking": "Hier mahlt deine Front, jeden Tick.",
  "province.underAttack": "Angegriffen von {attacker}",
  "province.frontOwn": "Deine Front steht hier",
  "province.frontTaken": "{share} der Provinz genommen",
  "province.defenders": "Deine Divisionen hier",
  "province.divisionLine":
    "Division {id} \u00b7 St\u00e4rke {strength} \u00b7 Versorgung {supply}",
  "province.invasionIncoming":
    "Invasion aus {attacker} \u2014 landet in {days} Tagen",
  "province.invasionOwn": "Deine Invasion landet hier in {days} Tagen",
  "province.buildings": "Gebäude",
  "province.build": "Bauen",
  "build.occupied": "besetztes Gebiet \u2014 gebaut wird in eigenen Provinzen",
  "build.noSlot": "kein freier Bauplatz",
  "build.notCoastal": "braucht eine K\u00fcste",
  "build.maxed": "am Limit von {max}",
  "build.needsManpower": "braucht {cost} Menschenreserve, vorhanden {have}",

  "terrain.plains": "Ebene",
  "terrain.highland": "Hügelland",
  "terrain.mountain": "Gebirge",

  "queue.title": "Bauschlange",
  "queue.empty": "Nichts im Bau.",
  "queue.remaining": "noch {days} Tage",
  "queue.cancel": "Abbrechen",
  "queue.howToBuild": "Zum Bauen eine eigene Provinz auf der Karte anklicken.",

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
  "production.fronts": "Fronten",
  "air.title": "Luft und See",
  "air.zone": "Zone {zone}",
  "air.seaZone": "Seezone {zone}",
  "air.noZones": "Keine Zone, über der du etwas siehst.",
  "air.superiority": "{value} des Himmels",
  "air.uncontested": "unbestritten",
  "air.formations": "Staffeln",
  "air.noFormations": "Keine Staffeln aufgestellt.",
  "air.onTheGround": "am Boden in Provinz {province}",
  "air.flying": "Zone {zone} \u00b7 {mission}",
  "air.bringHome": "Zurückholen",
  "air.assign": "Staffel entsenden",
  "air.outOfReach": "au\u00dfer Reichweite",
  "air.reachHint":
    "Eine Staffel fliegt \u00fcber die Zone ihrer Basis und die Nachbarzonen.",
  "air.missionsHint":
    "Acht Missionen: vier f\u00fcr den Himmel, vier f\u00fcr die See.",
  "air.send": "Entsenden",
  "air.raise": "{what} \u2014 {cost} Menschenreserve",
  "formation.fighter_wing": "Jagdstaffel",
  "formation.bomber_wing": "Bomberstaffel",
  "formation.submarine_flotilla": "U-Boot-Flottille",
  "formation.escort_group": "Geleitgruppe",
  "formation.battle_fleet": "Schlachtflotte",
  "mission.air_superiority": "Um den Himmel kämpfen",
  "mission.ground_support": "Den Boden unterstützen",
  "mission.interdiction": "Nachschub abschneiden",
  "mission.strategic_bombing": "Industrie bombardieren",
  "mission.sea_control": "See beherrschen",
  "mission.convoy_raiding": "Konvois jagen",
  "mission.convoy_escort": "Konvois sichern",
  "mission.invasion_support": "Landung unterstützen",
  "production.noDivisions": "Keine Divisionen aufgestellt.",
  "production.divisionAt": "Division {id} \u00b7 Provinz {province}",
  "production.raise": "Division aufstellen \u2014 {cost} Menschenreserve",
  "production.divisionState": "{strength} Ausrüstung \u00b7 {supply} Nachschub",
  "production.atSea": "Division {id} \u00b7 auf See, noch {days} Tage",

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
  "research.available": "Verf\u00fcgbar",
  "research.needs": "braucht {techs}",
  "research.noSlot": "kein freier Slot",
  "research.how":
    "Jeder Slot forscht an einer Technologie zugleich. Es kostet nichts au\u00dfer dem Slot.",
  "effect.factoryOutput": "{value} Fabrikaussto\u00df",
  "effect.efficiencyCap": "{value} Effizienzobergrenze",
  "effect.extraction": "{value} Rohstofff\u00f6rderung",
  "effect.construction": "{value} Baugeschwindigkeit",
  "effect.researchSlots": "{value} Forschungsslot",
  "effect.reinforceRate": "{value} Verst\u00e4rkungsrate",
  "effect.defenderLoss": "{value} Verteidigerverluste",

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

  "diplomacy.title": "Diplomatie",
  "diplomacy.trust": "Dein Vertrauen",
  "diplomacy.trustShort": "Vertrauen {trust}",
  "diplomacy.tradeBalance": "Punkte ein / aus",
  "diplomacy.offers": "Angebote an dich",
  "diplomacy.noOffers": "Dir hat niemand etwas angeboten.",
  "diplomacy.offered": "{type}, angeboten an",
  "diplomacy.accept": "Annehmen",
  "diplomacy.decline": "Ablehnen",
  "diplomacy.withdraw": "Angebot zurückziehen",
  "diplomacy.standing": "Laufende Abkommen",
  "diplomacy.noneStanding":
    "Keine. Jedes Abkommen hier läuft, bis es jemand beendet.",
  "diplomacy.terms": "{rate} {resource} für {points} Bau",
  "diplomacy.youSend": "Du lieferst {terms}",
  "diplomacy.youReceive": "Du erhältst {terms}",
  "diplomacy.cancel": "Kündigen — kostet {trust} Vertrauen",
  "diplomacy.noticeGiven": "Du hast gekündigt. In einem Tag endet es.",
  "diplomacy.noticeReceived": "{nation} hat gekündigt. In einem Tag endet es.",
  "diplomacy.propose": "Abkommen anbieten",
  "diplomacy.send": "Angebot senden",
  "diplomacy.market": "Weltmarkt",
  "diplomacy.flows": "Laufende Flüsse",
  "diplomacy.marketRates": "Kauf {buy} / Verkauf {sell}",
  "diplomacy.netFlow": "Dauerauftrag: {rate}",
  "diplomacy.setOrder": "Dauerauftrag setzen (pro Tag, negativ verkauft)",

  "agreement.non_aggression": "Nichtangriff",
  "agreement.trade": "Handel",
  "agreement.alliance": "Bündnis",
  "agreement.military_access": "Durchmarschrecht",
  "help.economy.construction":
    "Bauleistung pro Tag aus deinen Zivilfabriken, nach dem, was der Handel nimmt oder bringt. Sie fließt in das vorderste Vorhaben der Bauschlange und ist die Währung jedes Handelsabkommens.",
  "help.economy.tradeShare":
    "Wie viel dieser Bauleistung aus laufenden Handelsabkommen kommt oder als Bezahlung für Importe abgeht. Negativ heißt: du bezahlst Rohstoffe mit Bauleistung.",
  "help.economy.industry":
    "Was deine Militärfabriken und Werften pro Tag über alle Produktionslinien ausstoßen, nach Effizienz und Rohstoffmangel.",
  "help.economy.supplyRatio":
    "Wie viel der Rohstoffe, die deine Fabriken anfordern, sie tatsächlich bekommen. Unter 100 % läuft jede Linie anteilig langsamer. Nichts steht je still, weil Stahl fehlt; es läuft nur schlechter.",
  "help.economy.resources":
    "Der Vorrat, dann seine Änderung pro Tag: was deine Provinzen fördern, minus was deine Fabriken verbrauchen, plus oder minus Handel. Raffinerien machen aus Stahl Öl oder Gummi; der Weltmarkt verkauft alles, zu schlechten Kursen.",
  "help.research.slots":
    "Ein Slot arbeitet an einer Technologie, eine Stunde Fortschritt pro Tick. Er kostet nichts außer dem Slot. Zwei Slots zu Beginn; das Forschungsbüro öffnet einen dritten.",
  "help.research.techs":
    "Jede Technologie ist ein fester Modifikator oder eine neue Ausrüstungsstufe, unter ihrem Namen angezeigt. Eine ausgegraute nennt die Voraussetzung, die ihr fehlt.",
  "help.air.zones":
    "Eine Zone ist eine Gruppe von Provinzen. Du weist einer Zone eine Staffel oder Flotte mit einer Mission zu; die Welt entscheidet den Kampf dort jeden Tick. Du fliegst nie selbst ein Flugzeug.",
  "help.air.base":
    "Eine Staffel wird aufgestellt, wo eine Luftwaffenbasis steht, eine Flotte, wo eine Marinebasis steht. Der Knopf erscheint im Panel dieser Provinz und nirgends sonst. Erst die Basis bauen.",
  "help.air.reach":
    "Eine Staffel fliegt über die Zone ihrer Basis und die angrenzenden Zonen. Weiter entfernte Zonen stehen ausgegraut in der Liste und lassen sich nicht wählen. Eine Basis näher an der Front ist die Antwort.",
  "help.air.missions":
    "Vier Missionen für den Himmel: um ihn kämpfen (Luftüberlegenheit, von der jede andere Mission abhängt), den Boden unterstützen (deine Fronten in der Zone schlagen härter), Nachschub abschneiden (ihre Divisionen in der Zone bekommen weniger), Industrie bombardieren (ihre Fabriken in der Zone fertigen weniger). Vier für die See: sie kontrollieren (eine Landung braucht es, und es schützt eigene Konvois), Konvois jagen (versenkt gegnerische, kürzt Seeversorgung und Seehandel), Konvois eskortieren (das Gegenmittel), eine Landung unterstützen (Bonus für Invasionen neben der Zone).",
  "help.queue":
    "Von oben abgearbeitet: das vorderste Vorhaben bekommt die Bauleistung, der Rest wartet. Eine Zivilfabrik kostet etwa zehn Spieltage der gesamten Leistung einer jungen Nation.",
  "help.production.lines":
    "Eine Linie bindet Militärfabriken an einen Ausrüstungstyp. Ihre Effizienz steigt langsam, solange sie unverändert läuft, und fällt auf den Boden zurück, sobald du umstellst — der Umstellknopf nennt den Preis.",
  "help.production.stockpile":
    "Alles, was die Linien fertigen, landet hier. Divisionen, Staffeln und Flotten ziehen daraus, um auf volle Stärke zu kommen, und jede Schlacht zerstört einen Teil davon endgültig.",
  "help.production.divisions":
    "Stärke ist gehaltene Ausrüstung gegen eine volle Division; Versorgung ist, wie viel vom Bedarf ankommt. Eine schwache Division braucht das Lager, eine unversorgte ein Depot oder eine kürzere Linie.",
  "help.production.fronts":
    "Ein stehender Angriff auf eine Provinz. Er mahlt jeden Tick und kostet Ausrüstung, solange er steht. Abbrechen verliert den Fortschritt.",
  "help.diplomacy.trust":
    "Öffentlich, 0 bis 100, und verbraucht durch gebrochene Abkommen: wenig für einen Handel, viel für ein Bündnis, fast alles für den Angriff auf eine Nation, der du Nichtangriff versprochen hast. Es kommt nie zurück.",
  "help.diplomacy.agreements":
    "Jedes Abkommen gilt, bis eine Seite kündigt — keine Laufzeiten, keine Verlängerungen. Die Kündigung braucht einen Spieltag, kostet Vertrauen, und die andere Seite erfährt es sofort.",
  "help.province.slots":
    "Jedes Gebäude außer Straßen und Minen belegt einen Bauplatz, und ein eingereihter Auftrag hält seinen Platz ebenfalls. Sind sie voll, führt nur mehr Land zu mehr.",
  "help.province.control":
    "Gehalten von ist, wer darauf steht; Eigentümer, wem sie gehört. Eine im Krieg genommene Provinz wird erst gehalten und später besessen, und eine besetzte Fabrik liefert dem Besatzer weniger als dem Eigentümer.",
  "help.province.terrain":
    "Gelände multipliziert die Verteidigung. Ebene ist neutral; Hügelland und Gebirge begünstigen den, der schon da ist, also braucht dieselbe Armee länger, eine Gebirgsprovinz zu zermahlen.",
  "help.province.infrastructure":
    "0 bis 10. Trägt Versorgung weiter durch diese Provinz und beschleunigt den Bau hier. Wird als Stufe gebaut, nicht in einem Bauplatz — eine Straße kostet keiner Fabrik den Platz.",
  "help.province.deposits":
    "Was die Provinz pro Tag in den nationalen Vorrat fördert. Ein Förderausbau erhöht es; sonst nichts hier, und eine Provinz ohne Vorkommen fördert nichts, egal wie viele Fabriken sie hat.",
  "help.production.factories":
    "Militärfabriken und Werften in den Provinzen, die du hältst, gegen die einer Produktionslinie zugewiesenen. Eine untätige Fabrik verbraucht weiter Rohstoffe und fertigt nichts; der Regent setzt untätige ein.",
  "help.production.manpower":
    "Eine bevölkerungsabhängige Obergrenze, die langsam nachwächst. Eine Division oder Staffel aufzustellen verbraucht sie, und nichts gibt sie schneller zurück — eine frische Welt braucht ein paar Spieltage, bis überhaupt etwas da ist.",
  "help.diplomacy.offers":
    "An dich gerichtete Vorschläge. Einen Handel anzunehmen startet den Fluss im nächsten Tick; die Bedingungen sehen nur ihr beide, alle anderen sehen nur, dass ihr verhandelt.",
  "help.diplomacy.flows":
    "Die laufenden Handelsflüsse, wie sie sich tatsächlich bewegen, pro Tag: was ankommt, was abgeht, und die gezahlte oder erhaltene Bauleistung. Eine Route über Wasser läuft auf Konvois und kann gejagt werden.",

  "start.eyebrow": "Eine Welt, die weiterläuft",
  "start.title": "Wähle deine Nation",
  "start.ledeSeason":
    "Diese Welt wartet nicht auf dich. Nimm eine Nation, und sie gehört dir " +
    "für die Saison — eine Nation, ein Konto, kein Wechseln. Während du weg " +
    "bist, hält dein Regent sie versorgt und baut weiter.",
  "start.ledeOpen":
    "Das ist eine Werkbank-Welt: nichts ist vergeben und nichts wird " +
    "behalten. Nimm irgendeine Nation, komm als eine andere wieder, mach " +
    "kaputt was du willst.",
  "start.filter": "Nation suchen",
  "start.taken": "vergeben",
  "start.yours": "deine",
  "start.yoursTitle": "{name} gehört dir — zurück hinein",
  "start.noNations": "Diese Welt hat keine Nationen zur Auswahl.",
  "start.lockedTitle": "Dieser Browser kann kein Konto behalten",
  "start.noStorage":
    "Dieser Browser lässt die Seite nichts speichern, also lässt sich kein " +
    "Konto behalten: die Nation wäre nach dem Neuladen verloren und bliebe " +
    "für den Rest der Saison vergeben. Erlaube Website-Daten für diese " +
    "Seite, oder schau nur zu.",
  "start.takenTitle": "{name} wird schon gespielt",
  "start.playTitle": "{name} spielen",
  "start.noMatch": "Keine Nation dieses Namens.",
  "start.watch": "Nur zuschauen",
  "start.name": "Dein Name",
  "start.nameHint":
    "Wird jedem anderen Spieler anstelle deines Regenten gezeigt. Leer lassen, um anonym zu bleiben. 2 bis 24 Buchstaben, Ziffern, Leerzeichen, Punkte, Apostrophe oder Bindestriche.",
  "start.nameBad":
    "Dieser Name wird abgelehnt: 2 bis 24 Buchstaben, Ziffern, Leerzeichen, Punkte, Apostrophe oder Bindestriche.",
  "start.regentNote":
    "Zuschauen braucht kein Konto, und du kannst später eine Nation wählen.",
  "start.refused": "Diese Nation war nicht zu bekommen: {reason}",
  "start.offline":
    "Die Welt hat nicht geantwortet, es gibt also noch nichts zu wählen.",
};

const CATALOGUES: Record<string, Record<StringKey, string>> = { en, de };

export type Language = "en" | "de";
export const LANGUAGES: readonly Language[] = ["en", "de"];
const LANGUAGE_KEY = "world.language";

/**
 * The language: what the player chose last, else the browser's. Anything that
 * is not German gets English. Storage can be unavailable (a private window,
 * a locked-down browser); then the choice lasts for the page.
 */
function language(): Language {
  try {
    const chosen = localStorage.getItem(LANGUAGE_KEY);
    if (chosen === "en" || chosen === "de") return chosen;
  } catch {
    // no storage: fall through to the browser
  }
  const preferred =
    typeof navigator === "undefined" ? "en" : (navigator.language ?? "en");
  return preferred.toLowerCase().startsWith("de") ? "de" : "en";
}

let current: Language = language();
let catalogue = CATALOGUES[current];

export function currentLanguage(): Language {
  return current;
}

/**
 * Switch the catalogue and remember the choice. The panels built once
 * (diplomacy, air, regent) keep their old labels until the page reloads,
 * which is why the client reloads after calling this.
 */
export function setLanguage(next: Language): void {
  current = next;
  catalogue = CATALOGUES[next];
  try {
    localStorage.setItem(LANGUAGE_KEY, next);
  } catch {
    // no storage: the choice lasts for the page
  }
}

/** The keys behind the HUD's ⓘ buttons: prose, not labels. */
export type HelpKey = Extract<StringKey, `help.${string}`>;

const warned = new Set<string>();

/**
 * `{name}` placeholders, substituted positionally by name.
 *
 * **A missing key renders as the key**, once warned about, rather than
 * throwing. Thirty-odd keys reach this through `as StringKey`, and a typo in
 * one used to take the whole `update()` down with a TypeError — every panel
 * blank for one wrong string. The key on screen is ugly and honest.
 */
export function t(
  key: StringKey,
  params: Record<string, string | number> = {},
): string {
  const template: string | undefined = catalogue[key];
  if (template === undefined) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[hud] no string for "${key}"`);
    }
    return key;
  }
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
