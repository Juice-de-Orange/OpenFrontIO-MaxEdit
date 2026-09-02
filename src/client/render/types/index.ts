// Renderer types (units, players, tiles, names, config)
export {
  DEFAULT_NUKE_EXPLOSION_COLOR,
  MAX_NUKE_EXPLOSION_COLORS,
  PlayerTypeEnum,
  TrainType,
} from "./Renderer";
export type {
  AllianceData,
  AttackData,
  AttackRingInput,
  ConquestFx,
  DeadUnitFx,
  EmojiData,
  GhostPreviewData,
  NameEntry,
  NukeExplosionRenderParams,
  NukeTelegraphData,
  NukeTrajectoryData,
  PlayerState,
  PlayerStatic,
  PlayerStatusData,
  RenderRules,
  RenderUnitInfo,
  RendererConfig,
  TerrainRect,
  UnitState,
} from "./Renderer";

// Frame data — boundary contract between game integration and features
export type { FrameData } from "./FrameData";

// Frame events — per-frame ephemeral events (rendering FX)
export type { BonusEvent, FrameEvents } from "./FrameEvents";

// Unit type string constants and derived sets
export {
  ALL_UNIT_TYPES,
  FORCE_TYPES,
  NUKE_MAGNITUDES,
  NUKE_TYPES,
  SMOOTHED_NUKE_TYPES,
  STRUCTURE_ORDER,
  STRUCTURE_SHAPE,
  STRUCTURE_TYPES,
  UT_AIR_BASE,
  UT_ATOM_BOMB,
  UT_CITY,
  UT_CIVILIAN_FACTORY,
  UT_DEFENSE_POST,
  UT_DIVISION,
  UT_DOCKYARD,
  UT_FACTORY,
  UT_FLEET,
  UT_HYDROGEN_BOMB,
  UT_MILITARY_FACTORY,
  UT_MIRV,
  UT_MIRV_WARHEAD,
  UT_MISSILE_SILO,
  UT_NAVAL_BASE,
  UT_PORT,
  UT_REFINERY,
  UT_SAM_LAUNCHER,
  UT_SAM_MISSILE,
  UT_SHELL,
  UT_SUPPLY_HUB,
  UT_TRADE_SHIP,
  UT_TRAIN,
  UT_TRANSPORT,
  UT_WARSHIP,
  UT_WING,
} from "./UnitType";
