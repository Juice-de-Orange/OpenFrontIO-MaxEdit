/**
 * Pan and zoom over the map canvas.
 *
 * Deliberately small. The inherited TransformHandler does this and a great
 * deal more — tile picking, unit selection, alt-view toggles, all of it
 * programmed against GameView — and its screen-to-world maths has to be
 * rewritten anyway once clicks select provinces rather than tiles. Phase 0
 * needs a camera, not an input system.
 *
 * Camera state is pushed to the renderer rather than pulled: the renderer owns
 * a Camera but never reads the DOM.
 *
 * One subtlety worth stating, because it is invisible on a display with
 * dpr = 1: `zoom` is device pixels per world tile, which is how the renderer's
 * own Camera defines it. Pointer events are in CSS pixels. Every conversion
 * here therefore goes through dpr, and the same conversion serves the drag and
 * the click — a click that lands on a different province than the one under
 * the cursor is not a bug anyone enjoys chasing.
 */

import { renderDpr } from "src/client/render/gl/utils/Dpr";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 12;
const ZOOM_PER_WHEEL_NOTCH = 1.2;

export interface CameraState {
  /** World-space point at the centre of the viewport. */
  x: number;
  y: number;
  /** Scale factor: screen pixels per world tile. */
  zoom: number;
}

export class CameraController {
  private state: CameraState;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private readonly disposers: (() => void)[] = [];

  /** Set while a pointer is down and has moved far enough to be a drag. */
  private moved = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    initial: CameraState,
    private readonly onChange: (x: number, y: number, zoom: number) => void,
    /** A click that was not a drag, in world coordinates. */
    private readonly onPick?: (worldX: number, worldY: number) => void,
  ) {
    // Taken from the renderer, not recomputed. Its own fitMap works in device
    // pixels (cssWidth * dpr) and leaves a 10% margin, so measuring
    // clientWidth here lands on a different zoom on any display with dpr != 1
    // -- which shows up as a map that is off-centre and clipped on one side.
    this.state = { ...initial };

    this.bind("pointerdown", (e) => {
      const ev = e as PointerEvent;
      this.dragging = true;
      this.moved = false;
      this.lastX = ev.clientX;
      this.lastY = ev.clientY;
      canvas.setPointerCapture(ev.pointerId);
    });

    this.bind("pointermove", (e) => {
      if (!this.dragging) return;
      const ev = e as PointerEvent;
      const dx = ev.clientX - this.lastX;
      const dy = ev.clientY - this.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 0) this.moved = true;
      // Scaled by zoom: a pixel of drag is fewer world tiles the closer in we
      // are, which is what makes dragging feel like moving the map rather
      // than the camera.
      this.state.x -= this.toWorldDistance(dx);
      this.state.y -= this.toWorldDistance(dy);
      this.lastX = ev.clientX;
      this.lastY = ev.clientY;
      this.push();
    });

    const endDrag = (e: Event) => {
      const ev = e as PointerEvent;
      const wasDragging = this.dragging;
      this.dragging = false;
      if (canvas.hasPointerCapture?.(ev.pointerId)) {
        canvas.releasePointerCapture(ev.pointerId);
      }
      if (wasDragging && !this.moved && e.type === "pointerup") {
        const point = this.screenToWorld(ev.clientX, ev.clientY);
        this.onPick?.(point.x, point.y);
      }
    };
    this.bind("pointerup", endDrag);
    this.bind("pointercancel", endDrag);

    this.bind(
      "wheel",
      (e) => {
        const ev = e as WheelEvent;
        ev.preventDefault();
        const factor =
          ev.deltaY < 0 ? ZOOM_PER_WHEEL_NOTCH : 1 / ZOOM_PER_WHEEL_NOTCH;
        this.state.zoom = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, this.state.zoom * factor),
        );
        this.push();
      },
      { passive: false },
    );
  }

  /** CSS pixels of pointer movement, in world tiles. */
  private toWorldDistance(cssPixels: number): number {
    return (cssPixels * renderDpr()) / this.state.zoom;
  }

  /**
   * A CSS-pixel point on the canvas, in world coordinates.
   *
   * The same arithmetic as the renderer's Camera.screenToWorld, expressed
   * against the controller's own state rather than reaching into the
   * renderer's camera, which is not exposed.
   */
  screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x:
        this.state.x +
        this.toWorldDistance(clientX - rect.left - rect.width / 2),
      y:
        this.state.y +
        this.toWorldDistance(clientY - rect.top - rect.height / 2),
    };
  }

  private bind(
    type: string,
    handler: (e: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    this.canvas.addEventListener(type, handler, options);
    this.disposers.push(() =>
      this.canvas.removeEventListener(type, handler, options),
    );
  }

  private push(): void {
    this.onChange(this.state.x, this.state.y, this.state.zoom);
  }

  get current(): Readonly<CameraState> {
    return this.state;
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers.length = 0;
  }
}
