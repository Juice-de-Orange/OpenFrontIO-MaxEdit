import { assetUrl } from "src/client/util/AssetUrl";
import { FetchGameMapLoader } from "../core/game/FetchGameMapLoader";

export const terrainMapFileLoader = new FetchGameMapLoader((path) =>
  assetUrl(`maps/${path}`),
);
