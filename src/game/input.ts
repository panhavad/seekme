/** Keyboard + drag-anywhere virtual stick, reported in screen space. */
export class InputController {
  /** -1..1 screen-space movement, y positive = up the screen. */
  readonly axis = { x: 0, y: 0 };

  private readonly keys = new Set<string>();
  private pointerId: number | null = null;
  private originX = 0;
  private originY = 0;
  private touchX = 0;
  private touchY = 0;
  private enabled = false;

  constructor(
    private readonly surface: HTMLElement,
    private readonly joystick: HTMLElement,
    private readonly knob: HTMLElement
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.reset);
    surface.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    if (!value) this.reset();
  }

  /** Extra key handlers (pause, mute, wall skip, emotes…). */
  onAction: ((action: 'pause' | 'mute' | 'skill') => void) | null = null;
  onEmoteKey: ((index: number) => void) | null = null;

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    // Keys aimed at a field or a slider belong to that control, not the ghost.
    if ((event.target as HTMLElement | null)?.closest('input, textarea, select')) return;
    const key = event.key.toLowerCase();
    if (key === 'escape') {
      this.onAction?.('pause');
      return;
    }
    if (key === 'm') {
      this.onAction?.('mute');
      return;
    }
    if (SKILL_KEYS.has(key)) {
      event.preventDefault();
      this.onAction?.('skill');
      return;
    }
    if (key >= '1' && key <= '8') {
      this.onEmoteKey?.(Number(key) - 1);
      return;
    }
    if (MOVE_KEYS.has(key)) {
      event.preventDefault();
      this.keys.add(key);
      this.updateAxis();
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();
    if (this.keys.delete(key)) this.updateAxis();
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled || this.pointerId !== null) return;
    if ((event.target as HTMLElement)?.closest('button, input, .panel')) return;
    this.pointerId = event.pointerId;
    this.originX = event.clientX;
    this.originY = event.clientY;
    this.touchX = 0;
    this.touchY = 0;
    this.joystick.style.left = `${event.clientX - 58}px`;
    this.joystick.style.top = `${event.clientY - 58}px`;
    this.joystick.classList.add('active');
    this.knob.style.transform = 'translate(0px, 0px)';
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    const dx = event.clientX - this.originX;
    const dy = event.clientY - this.originY;
    const maxRadius = 52;
    const length = Math.hypot(dx, dy);
    const scale = length > maxRadius ? maxRadius / length : 1;
    const kx = dx * scale;
    const ky = dy * scale;
    this.knob.style.transform = `translate(${kx}px, ${ky}px)`;

    const dead = 6;
    if (length < dead) {
      this.touchX = 0;
      this.touchY = 0;
    } else {
      const strength = Math.min(1, (length - dead) / (maxRadius - dead));
      this.touchX = (dx / length) * strength;
      this.touchY = (-dy / length) * strength;
    }
    this.updateAxis();
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.touchX = 0;
    this.touchY = 0;
    this.joystick.classList.remove('active');
    this.updateAxis();
  };

  private reset = (): void => {
    this.keys.clear();
    this.touchX = 0;
    this.touchY = 0;
    this.pointerId = null;
    this.joystick.classList.remove('active');
    this.updateAxis();
  };

  private updateAxis(): void {
    let x = this.touchX;
    let y = this.touchY;

    if (this.keys.has('arrowleft') || this.keys.has('a')) x -= 1;
    if (this.keys.has('arrowright') || this.keys.has('d')) x += 1;
    if (this.keys.has('arrowup') || this.keys.has('w')) y += 1;
    if (this.keys.has('arrowdown') || this.keys.has('s')) y -= 1;

    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    this.axis.x = x;
    this.axis.y = y;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.reset);
    this.surface.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }
}

const MOVE_KEYS = new Set([
  'w',
  'a',
  's',
  'd',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
]);

/** Keys that fire the wall skip. Space is the primary, F the alternative. */
const SKILL_KEYS = new Set([' ', 'spacebar', 'f']);

const SIN45 = Math.SQRT1_2;

/** Converts screen-space input into world XZ for the fixed isometric camera. */
export function screenToWorld(x: number, y: number): [number, number] {
  return [SIN45 * (x - y), -SIN45 * (x + y)];
}
