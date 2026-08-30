/**
 * Resolving an asset URL in the browser.
 *
 * The path arithmetic is in shared/util/AssetPath.ts; what is here is the part
 * that reads the environment — the manifest and CDN base the page was served
 * with. That environment coupling is why it is not in shared/.
 */

import { buildAssetUrl, type AssetManifest } from "src/shared/util/AssetPath";

declare global {
  var __ASSET_MANIFEST__: AssetManifest | undefined;
  var __CDN_BASE__: string | undefined;
}

export function getAssetManifest(): AssetManifest {
  if (
    typeof window !== "undefined" &&
    window.BOOTSTRAP_CONFIG?.assetManifest !== undefined
  ) {
    return window.BOOTSTRAP_CONFIG.assetManifest;
  }
  return globalThis.__ASSET_MANIFEST__ ?? {};
}

// Web workers have no `window`, so they read `__CDN_BASE__` off globalThis,
// which Worker.worker.ts sets from the init message before any asset fetches.
// Without this fallback, asset fetches inside workers (e.g. map binaries)
// would silently bypass the CDN.
export function getCdnBase(): string {
  if (
    typeof window !== "undefined" &&
    window.BOOTSTRAP_CONFIG?.cdnBase !== undefined
  ) {
    return window.BOOTSTRAP_CONFIG.cdnBase;
  }
  return globalThis.__CDN_BASE__ ?? "";
}

export function assetUrl(path: string): string {
  return buildAssetUrl(path, getAssetManifest(), getCdnBase());
}
