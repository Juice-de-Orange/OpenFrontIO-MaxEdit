import GUI from "lil-gui";
import type { RenderSettings } from "../RenderSettings";
import { createRenderSettings } from "../RenderSettings";
import { buildTree } from "./Layout";
import { walkTree } from "./Tree";
import { makeDraggable, wireActions, wireModifiedIndicators } from "./Wiring";

/**
 * The in-game debug panel: a "Render Settings" folder that live-edits
 * `settings` in place.
 *
 * It also carried an "Effect Editor" folder, which authored catalog JSON for
 * upstream's cosmetics store. This fork has no store, and that editor was the
 * only place the renderer ran zod at runtime.
 */
export function createDebugGui(
  settings: RenderSettings,
  resolveDefaults: () => RenderSettings = createRenderSettings,
  onSettingsChanged?: () => void,
): { open(): void; destroy(): void } {
  const gui = new GUI({ title: "Render Debug GUI", width: 320 });
  gui.domElement.style.position = "fixed";
  gui.domElement.style.top = "8px";
  gui.domElement.style.right = "8px";
  gui.domElement.style.zIndex = "100";

  makeDraggable(gui);

  // Defaults include the user's graphics overrides so "Reset to Defaults"
  // (and the per-prop reset / modified indicators) restore the same settings
  // the renderer was built with — not bare defaults that drop the overrides.
  const render = gui.addFolder("Render Settings");
  const defaults = resolveDefaults();
  const props = walkTree(buildTree(settings, defaults), render);

  wireActions(render, settings, props, resolveDefaults, onSettingsChanged);
  wireModifiedIndicators(render, props, onSettingsChanged);
  render.close();

  gui.close();
  return {
    open: () => gui.open(),
    destroy: () => gui.destroy(),
  };
}
