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
 */

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

  constructor(
    private readonly canvas: HTMLCanvasElement,
    initial: CameraState,
    private readonly onChange: (x: number, y: number, zoom: number) => void,
  ) {
    // Taken from the renderer, not recomputed. Its own fitMap works in device
    // pixels (cssWidth * dpr) and leaves a 10% margin, so measuring
    // clientWidth here lands on a different zoom on any display with dpr != 1
    // -- which shows up as a map that is off-centre and clipped on one side.
    this.state = { ...initial };

    this.bind("pointerdown", (e) => {
      const ev = e as PointerEvent;
      this.dragging = true;
      this.lastX = ev.clientX;
      this.lastY = ev.clientY;
      canvas.setPointerCapture(ev.pointerId);
    });

    this.bind("pointermove", (e) => {
      if (!this.dragging) return;
      const ev = e as PointerEvent;
      // Divide by zoom: a pixel of drag is fewer world tiles the closer in we
      // are, which is what makes dragging feel like moving the map rather
      // than the camera.
      this.state.x -= (ev.clientX - this.lastX) / this.state.zoom;
      this.state.y -= (ev.clientY - this.lastY) / this.state.zoom;
      this.lastX = ev.clientX;
      this.lastY = ev.clientY;
      this.push();
    });

    const endDrag = (e: Event) => {
      const ev = e as PointerEvent;
      this.dragging = false;
      if (canvas.hasPointerCapture?.(ev.pointerId)) {
        canvas.releasePointerCapture(ev.pointerId);
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
