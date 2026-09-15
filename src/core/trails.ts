import type { Maze } from './maze';
import { TRAIL } from '../game/config';

/**
 * The shared "memory of the stones": every floor tile remembers how much the
 * seeker's lantern scorched it, how much frost the hider left, whether a
 * permanent melt pond formed, and how brightly the local player can see it.
 */
export class TrailField {
  readonly maze: Maze;
  readonly heat: Float32Array;
  readonly cold: Float32Array;
  readonly pond: Uint8Array;
  readonly explored: Float32Array;
  readonly visible: Float32Array;
  /** RGBA bytes uploaded to the GPU: heat, cold, pond, light. */
  readonly texels: Uint8Array<ArrayBuffer>;

  private readonly dwell: Float32Array;

  constructor(maze: Maze) {
    const size = maze.width * maze.height;
    this.maze = maze;
    this.heat = new Float32Array(size);
    this.cold = new Float32Array(size);
    this.pond = new Uint8Array(size);
    this.explored = new Float32Array(size);
    this.visible = new Float32Array(size);
    this.dwell = new Float32Array(size);
    this.texels = new Uint8Array(new ArrayBuffer(size * 4));
  }

  decay(dt: number): void {
    const heatFactor = Math.exp(-dt / TRAIL.heatTau);
    const coldFactor = Math.exp(-dt / TRAIL.coldTau);
    const { heat, cold, dwell } = this;
    for (let i = 0; i < heat.length; i++) {
      if (heat[i] > 0) {
        heat[i] *= heatFactor;
        if (heat[i] < TRAIL.epsilon) heat[i] = 0;
      }
      if (cold[i] > 0) {
        cold[i] *= coldFactor;
        if (cold[i] < TRAIL.epsilon) cold[i] = 0;
      }
      if (dwell[i] > 0) dwell[i] = Math.max(0, dwell[i] - dt * 0.35);
    }
  }

  /**
   * Smears a trail around a world-space position. `amount` is already scaled by
   * dt, so a ghost that sprints through leaves a faint streak while one that
   * loiters burns/freezes a bright blob.
   */
  deposit(kind: 'heat' | 'cold', cellX: number, cellY: number, fx: number, fy: number, amount: number): void {
    const target = kind === 'heat' ? this.heat : this.cold;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cellX + dx;
        const y = cellY + dy;
        if (this.maze.isWall(x, y)) continue;
        // Distance from the ghost's exact position to this tile's centre.
        const d = Math.hypot(dx - fx, dy - fy);
        const weight = Math.max(0, 1 - d * 1.15);
        if (weight <= 0) continue;
        const i = this.maze.index(x, y);
        target[i] = Math.min(1, target[i] + amount * weight);
      }
    }
  }

  /**
   * Tracks how long the hider has been frozen in place. Returns true exactly
   * once, on the frame a new permanent melt pond appears.
   */
  accumulateDwell(cellX: number, cellY: number, dt: number, moving: boolean): boolean {
    if (this.maze.isWall(cellX, cellY)) return false;
    const i = this.maze.index(cellX, cellY);
    if (moving) {
      this.dwell[i] = Math.max(0, this.dwell[i] - dt);
      return false;
    }
    if (this.pond[i]) return false;

    this.dwell[i] += dt;
    if (this.dwell[i] >= TRAIL.pondDwellSeconds && this.cold[i] > 0.55) {
      this.pond[i] = 1;
      this.cold[i] = 1;
      return true;
    }
    return false;
  }

  dwellRatio(cellX: number, cellY: number): number {
    if (this.maze.isWall(cellX, cellY)) return 0;
    return Math.min(1, this.dwell[this.maze.index(cellX, cellY)] / TRAIL.pondDwellSeconds);
  }

  addPond(cellX: number, cellY: number): void {
    if (this.maze.isWall(cellX, cellY)) return;
    this.pond[this.maze.index(cellX, cellY)] = 1;
  }

  isPond(cellX: number, cellY: number): boolean {
    if (!this.maze.inBounds(cellX, cellY)) return false;
    return this.pond[this.maze.index(cellX, cellY)] === 1;
  }

  heatAt(cellX: number, cellY: number): number {
    if (!this.maze.inBounds(cellX, cellY)) return 0;
    return this.heat[this.maze.index(cellX, cellY)];
  }

  coldAt(cellX: number, cellY: number): number {
    if (!this.maze.inBounds(cellX, cellY)) return 0;
    return this.cold[this.maze.index(cellX, cellY)];
  }

  /** Strongest trail value within `radius` tiles, with its location. */
  strongestWithin(
    kind: 'heat' | 'cold',
    cellX: number,
    cellY: number,
    radius: number,
    minimum: number
  ): { x: number; y: number; value: number } | null {
    const source = kind === 'heat' ? this.heat : this.cold;
    let best: { x: number; y: number; value: number } | null = null;
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cellX + dx;
        const y = cellY + dy;
        if (!this.maze.inBounds(x, y) || this.maze.isWall(x, y)) continue;
        if (dx * dx + dy * dy > radius * radius) continue;
        const value = source[this.maze.index(x, y)];
        if (value < minimum) continue;
        if (!best || value > best.value) best = { x, y, value };
      }
    }
    return best;
  }

  /** Merges this frame's visibility into the explored memory and repacks texels. */
  updateTexels(): void {
    const { heat, cold, pond, explored, visible, texels } = this;
    for (let i = 0; i < heat.length; i++) {
      const v = visible[i];
      if (v > explored[i]) explored[i] = v;
      const light = Math.max(v, explored[i] * 0.5);
      const offset = i * 4;
      texels[offset] = Math.min(255, heat[i] * 255) | 0;
      texels[offset + 1] = Math.min(255, cold[i] * 255) | 0;
      texels[offset + 2] = pond[i] ? 255 : 0;
      texels[offset + 3] = Math.min(255, light * 255) | 0;
    }
  }
}
