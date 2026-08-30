/// <reference types="vite/client" />

declare module "*.bin" {
  const binContent: string;
  export default binContent;
}

declare module "*.md" {
  const mdContent: string;
  export default mdContent;
}

declare module "*.html" {
  const htmlContent: string;
  export default htmlContent;
}

declare module "*.xml" {
  const xmlContent: string;
  export default xmlContent;
}

declare module "*.txt" {
  const txtContent: string;
  export default txtContent;
}

declare module "*.txt?raw" {
  const txtRawContent: string;
  export default txtRawContent;
}

declare module "*.webp" {
  const webpContent: string;
  export default webpContent;
}

// Injected by the server (or the desktop shell) as an inline <script> in
// index.html, before any module runs. Declared here rather than in
// core/configuration/Config.ts, where it used to live: `declare global` is
// program-wide, so AssetUrls only compiled because Config.ts happened to be in
// the program. When Config.ts goes, that breaks with an error pointing at the
// wrong file.
//
// Note the inline `import(...)` type. A top-level import would turn this file
// into a module and silently switch off the `declare module "*.bin"` blocks
// above it.
// No `declare global` wrapper: this file is a global script (the `declare
// module "*.bin"` blocks above make it one), and `declare global` only takes
// effect inside a module. Written that way the interface silently fails to
// merge and every window.BOOTSTRAP_CONFIG access errors.
interface Window {
  BOOTSTRAP_CONFIG?: {
    gitCommit?: string;
    assetManifest?: import("../shared/util/AssetPath").AssetManifest;
    cdnBase?: string;
    gameEnv?: string;
    numWorkers?: number;
    turnstileSiteKey?: string;
    jwtAudience?: string;
    instanceId?: string;
    // Desktop-only: explicit game-server host for the WebSocket origin.
    // Absent on the web build (client falls back to same-origin location).
    serverHost?: string;
  };
}
