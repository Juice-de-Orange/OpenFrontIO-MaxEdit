/**
 * Tile references are plain numbers here.
 *
 * `TileRef` in core/game/GameMap is `type TileRef = number`, and this file
 * already spells the rest of them out bare — `pos`, `lastPos`, `targetTile`,
 * `spawnTile`, `upgradeTargetTile`. Importing the alias for two of the
 * fields bought no type safety and made the renderer's type graph reach into
 * the simulation. The renderer owns its own vocabulary and will not notice
 * if core's alias ever changes; if this fork wants a branded tile index, it
 * belongs next to GameMap in shared/map/ and the renderer imports it there.
 *
 * See docs/decisions/0001-break-core-client-import-cycle.md, which rejected
 * this for a different question: back then the cycle was still standing and
 * a local alias would have fixed one call site while leaving it intact.
 */

/** TrainType enum — numeric values matching UnitState.trainType. */
export enum TrainType {
  Engine = 0,
  TailEngine = 1,
  Carriage = 2,
}

/** Numeric player type — matching PlayerStatic.playerType. */
export enum PlayerTypeEnum {
  Human = 0,
  Bot = 1,
  Nation = 2,
}

/** Static player data from the header dictionary */
export interface PlayerStatic {
  smallID: number;
  id: string;
  name: string;
  displayName: string;
  clanTag: string | null;
  clientID: string | null;
  playerType: PlayerTypeEnum;
  team: string | null;
  isLobbyCreator: boolean;
  /** Resolved flag image URL, or undefined for no flag. */
  flag?: string;
  /** Resolved crown-cosmetic image URL, or undefined for no crown. */
  crown?: string;
  /** Plays under the verified account username — blue check next to the name. */
  verified?: boolean;
  /** Hex color (e.g. "#ff0000"). Populated from territoryColor (live) or palette (replay). */
  color?: string;
}

export interface AttackData {
  attackerID: number;
  targetID: number;
  troops: number;
  id: string;
  retreating: boolean;
}

export interface AllianceData {
  id: number;
  other: string;
  createdAt: number;
  expiresAt: number;
  hasExtensionRequest: boolean;
}

export interface EmojiData {
  message: string;
  senderID: number;
  recipientID: number | "AllPlayers";
  createdAt: number;
}

export interface PlayerState {
  smallID: number;
  isAlive: boolean;
  isDisconnected: boolean;
  killedBy: string | null;
  deathPosition: number | null;
  tilesOwned: number;
  gold: number;
  /** Cumulative ship-trade revenue (live, from PlayerUpdate). */
  tradeGold: number;
  /** Cumulative train revenue: own trains + external stops (live). */
  trainGold: number;
  /** Cumulative piracy revenue: captured-ship payouts (live). */
  piracyGold: number;
  /** Cumulative gold received from all sources (live). */
  goldEarned: number;
  troops: number;
  isTraitor: boolean;
  traitorRemainingTicks: number;
  inDoomsdayClock: boolean;
  isDecaying: boolean;
  markedDoomsdayClockTick: number;
  betrayals: number;
  hasSpawned: boolean;
  /** TileRef the player picked as their spawn (undefined if not yet spawned). */
  spawnTile?: number;
  lastDeleteUnitTick: number;
  allies: number[];
  embargoes: number[];
  targets: number[];
  outgoingAttacks: AttackData[];
  incomingAttacks: AttackData[];
  outgoingAllianceRequests: string[];
  alliances: AllianceData[];
  outgoingEmojis: EmojiData[];
}

export interface UnitState {
  id: number;
  unitType: string;
  ownerID: number;
  lastOwnerID: number | null;
  pos: number;
  lastPos: number;
  isActive: boolean;
  reachedTarget: boolean;
  retreating: boolean;
  targetable: boolean;
  waitTicks: number;
  markedForDeletion: number | false; // -1 -> false, else tick
  health: number | null;
  underConstruction: boolean;
  targetUnitId: number | null;
  targetTile: number | null;
  troops: number;
  missileTimerQueue: number[];
  level: number;
  veterancy: number;
  hasTrainStation: boolean;
  trainType: number | null; // 0=Engine, 1=TailEngine, 2=Carriage
  loaded: boolean | null;
  constructionStartTick: number | null;
  samUpgradeStartTick: number | null;
  samUpgradeStartRange: number | null;
  samUpgradeTargetLevel: number | null;
  samUpgradeDuration: number | null;
}

/** Minimal dead-unit data needed by the FX pass. */
export interface DeadUnitFx {
  unitType: string;
  pos: number;
  reachedTarget: boolean;
  /** Firing player's smallID — resolves their nuke-explosion cosmetic. */
  ownerSmallID: number;
  /**
   * Resolved nuke-explosion render params (the firing player's cosmetic).
   * Attached by WebGLFrameBuilder before the FX pass consumes the event;
   * undefined when the owner has no nuke-explosion cosmetic (default FX).
   */
  explosion?: NukeExplosionRenderParams;
  /** Ticks since the event occurred (0 = this frame, >0 = seeked past it). */
  tickAge?: number;
}

/**
 * Max palette colors a shockwave instance can carry (vertex-attribute budget);
 * a longer cosmetic palette is truncated.
 */
export const MAX_NUKE_EXPLOSION_COLORS = 4;

/**
 * A firing player's nuke-explosion cosmetic, resolved from catalog attributes
 * into renderer-ready values. `type` picks the visual — an expanding
 * "shockwave" ring, or a firework burst of twinkling "sparkles" that ride
 * outward from the center with the expanding front.
 * `colors` is the palette the effect cycles through
 * (1..MAX_NUKE_EXPLOSION_COLORS rgb in 0..1, never empty);
 * maxRadius is the effect's final radius in world tiles when it fades out
 * (absolute — it does NOT scale with the bomb's blast radius); speed is the
 * rate the effect's width grows in world tiles/s (the effect lasts
 * 2·maxRadius / speed seconds); thickness is the ring band's thickness — or
 * the average sparkle size, glints hash-vary ±50% around it — in world tiles
 * (constant while the effect expands);
 * transitionSpeed is the palette step rate in colors/s (0 = static, negative
 * = reverse cycle) — same semantics as the trail shader's transition
 * frequency (sparkles hash a per-sparkle palette offset on top).
 * Sparkles additionally carry density — roughly the total number of glints
 * in the burst (the renderer derives its grid pitch from it, clamped sane).
 */
interface NukeExplosionRenderParamsBase {
  colors: readonly (readonly [number, number, number])[];
  maxRadius: number;
  speed: number;
  thickness?: number;
  transitionSpeed: number;
}

export type NukeExplosionRenderParams =
  | (NukeExplosionRenderParamsBase & { type: "shockwave" })
  | (NukeExplosionRenderParamsBase & { type: "sparkles"; density?: number })
  | (NukeExplosionRenderParamsBase & { type: "embers"; density?: number });

/** Default nuke-explosion color (purple) when a cosmetic has no usable color. */
export const DEFAULT_NUKE_EXPLOSION_COLOR: readonly [number, number, number] = [
  0.6, 0.1, 1,
];

/** Conquest event data for the gold popup + sword sprite FX. */
export interface ConquestFx {
  x: number; // world tile X (conquered player's name location)
  y: number; // world tile Y
  gold: number; // gold amount awarded
  /** Ticks since the event occurred (0 = this frame, >0 = seeked past it). */
  tickAge?: number;
}

export interface NameEntry {
  playerID: string;
  x: number;
  y: number;
  size: number;
}

/** Per-player status data for the GPU name/status-icon passes. */
export interface PlayerStatusData {
  crown: boolean;
  traitor: boolean;
  disconnected: boolean;
  alliance: boolean;
  allianceReq: boolean;
  target: boolean;
  embargo: boolean;
  nukeActive: boolean;
  nukeTargetsMe: boolean;
  inDoomsdayClock: boolean;
  doomsdayClockDraining: boolean;
  doomsdayClockDecaying: boolean;
  doomsdayClockWarnProgress: number;
  traitorRemainingTicks: number;
  allianceFraction: number;
  allianceRemainingTicks: number;
}

/** Ghost structure preview data for build-mode visualization. */
export interface GhostPreviewData {
  ghostType: string; // UnitType string ("City", "Port", etc.)
  tileX: number; // Hover tile X
  tileY: number; // Hover tile Y
  radiusTileX: number;
  radiusTileY: number;
  canBuild: boolean; // Valid placement?
  canUpgrade: boolean; // Upgrading existing structure?
  cost: number; // Gold cost
  multiplier?: number; // Upgrade multiplier (e.g., 5 for x5)
  /** Whether to render the cost label under the ghost (user setting). */
  showCost: boolean;
  /** True if the player has enough gold to afford this build (drives label color). */
  canAfford: boolean;
  ghostRailPaths: number[][]; // TileRef paths (City/Port only)
  overlappingRailroads: number[]; // TileRefs containing rails in snap zone
  ownerID: number; // Player's smallID (for color)
  /** Tile position of existing structure being upgraded (null if fresh build). */
  upgradeTargetTile: number | null;
  /** Range radius in tiles for the placement circle (0 = no circle). */
  rangeRadius: number;
  /** True if placing here would carry a penalty (e.g. nuking an ally → traitor). */
  rangeWarning: boolean;
}

/** Nuke trajectory preview data — Bezier control points + color thresholds. */
export interface NukeTrajectoryData {
  /** Bezier control points (world-space tile coordinates). */
  p0x: number;
  p0y: number;
  p1x: number;
  p1y: number;
  p2x: number;
  p2y: number;
  p3x: number;
  p3y: number;
  /** t-value (0..1) where bomb leaves source's targetable range. -1 if ranges overlap. */
  tUntargetableStart: number;
  /** t-value (0..1) where bomb enters target's targetable range. -1 if ranges overlap. */
  tUntargetableEnd: number;
  /** t-value (0..1) of first SAM intercept point. 1.0 = no intercept. */
  tSamIntercept: number;
}

/**
 * A rectangular region of terrain texels to re-upload, with its bytes stored
 * row-major in a shared buffer (rects are concatenated in array order).
 * Water-nuke deltas use one-row rects (h = 1); a full re-upload (context
 * restore) is a single map-sized rect.
 */
export interface TerrainRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Input data for attack ring visualization. */
export interface AttackRingInput {
  x: number;
  y: number;
  unitId: number;
}

/** In-flight nuke target circle data. */
export interface NukeTelegraphData {
  x: number;
  y: number;
  innerRadius: number;
  outerRadius: number;
  /** Launcher vs local player: 0 = self, 1 = ally/teammate, 2 = enemy. */
  relation: number;
}

/** Lean config for constructing the GPU renderer — no replay-specific fields. */
export interface RendererConfig {
  mapWidth: number;
  mapHeight: number;
  unitTypes: string[];
  players: PlayerStatic[];
  /**
   * Pre-allocated player capacity for GPU textures.
   * Defaults to `players.length` when omitted. Set higher when players
   * arrive after construction (e.g. bots are created on tick 1).
   */
  maxPlayers?: number;
}

/**
 * The subset of `unitInfo` the renderer reads.
 *
 * Deliberately narrower than upstream's `UnitInfo`, whose `cost` field is
 * `(game: Game, player: Player) => Gold` and would drag the entire simulation
 * — plus bigint gold — back into the renderer's type graph. Only these two
 * fields are ever read: maxHealth for the warship health bar, and
 * constructionDuration for the build-progress bar.
 */
export interface RenderUnitInfo {
  maxHealth?: number;
  constructionDuration?: number;
}

/**
 * What the renderer needs to know about the world's rules in order to draw,
 * and nothing beyond it. Seven methods out of the 106 on upstream's `Config`
 * class, which satisfies this structurally with no change to it.
 *
 * Named RenderRules, not RenderConfig: `RendererConfig` above is the
 * construction header (map dimensions, unit types, player list), and two
 * types a letter apart would need explaining in every review. These seven all
 * answer the same question — over what span does this bar or animation run.
 *
 * `unitInfo` keeps the shape it has on `Config` rather than being flattened
 * into `maxHealth(type)` / `constructionDuration(type)`. The flatter form
 * reads better but `Config` would no longer satisfy it, and phase 0 would
 * need an adapter object living exactly until `Config` dies.
 */
export interface RenderRules {
  /** Simulation tick length in ms. Drives every interpolation. */
  msPerTick(): number;

  /**
   * Display constants per unit type. `type` is the raw string from
   * `UnitState.unitType` — see types/UnitType.ts.
   */
  unitInfo(type: string): RenderUnitInfo;

  /** Max-health bonus per veterancy level, in whole percent. */
  warshipVeterancyHealthBonus(): number;

  /** Divisor. Must be > 0, or the deletion bar goes NaN. */
  deletionMarkDuration(): number;
  /** Divisor. Must be > 0. */
  SAMCooldown(): number;
  /** Divisor. Must be > 0. */
  SiloCooldown(): number;

  /** Ticks before an alliance expires at which the renewal icon appears. */
  allianceExtensionPromptOffset(): number;
}
