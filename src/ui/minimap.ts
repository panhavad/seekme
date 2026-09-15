import type { Maze } from '../core/maze';
import type { TrailField } from '../core/trails';
import { COLORS, TILE, type Role } from '../game/config';

/** Everything the minimap needs, read fresh from the round on every repaint. */
export interface MinimapView {
  maze: Maze;
  field: TrailField;
  role: Role;
  playerX: number;
  playerZ: number;
  playerFacing: number;
  rivalX: number;
  rivalZ: number;
  /** 0..1 - how clearly the rival can be made out right now. */
  rivalSeen: number;
  /** The theme's tint for remembered-but-unlit ground. */
  memoryTint: [number, number, number];
}

/** Anything that can hand the minimap a fresh view (the running Game). */
export interface MinimapSource {
  readonly minimapView: MinimapView;
}

/** Repaints roughly 18x a second: smooth enough, cheap enough for phones. */
const REFRESH_INTERVAL = 1 / 18;
/** How many maze tiles span the width of the dial. */
const VIEW_TILES = 23;
/** The fixed 3/4 camera turns the grid 45deg on screen; the map follows. */
const VIEW_ROTATION = Math.PI / 4;
/** Below this there is no light left, so the tile is off the map. */
const DARK = 0.02;

function rgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

const WARM = rgb(COLORS.warm);
const COLD = rgb(COLORS.cold);
const POND = rgb(COLORS.coldDeep);

function mix(value: number, target: number, amount: number): number {
  return value + (target - value) * amount;
}

/**
 * The top-left dial. It only draws ground the player has already been through
 * *and* that something is still lighting: their lantern/wisp right now, or a
 * heat/frost trail that has not faded yet. When a trail's glow dies the tile
 * drops off the map again, exactly like it does on the alley floor.
 */
export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly tileCanvas = document.createElement('canvas');
  private readonly tileCtx: CanvasRenderingContext2D | null;

  private source: MinimapSource | null = null;
  private image: ImageData | null = null;
  private reveal: Float32Array | null = null;
  private gridWidth = 0;
  private gridHeight = 0;
  private timer = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tileCtx = this.tileCanvas.getContext('2d', { willReadFrequently: false });
  }

  /** Points the dial at a round; pass `null` to blank it (menu/attract mode). */
  attach(source: MinimapSource | null): void {
    this.source = source;
    this.timer = 0;
    if (!source) this.clear();
  }

  render(dt: number): void {
    if (!this.ctx) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = REFRESH_INTERVAL;
    if (!this.source) return;

    const size = this.canvas.clientWidth;
    // Hidden (menu, or the HUD is off): nothing to paint.
    if (size <= 0) return;

    const view = this.source.minimapView;
    this.paintTiles(view);
    this.paintDial(view, size);
  }

  clear(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** One texel per maze tile, coloured by what is still lit there. */
  private paintTiles(view: MinimapView): void {
    const { maze, field } = view;
    const ctx = this.tileCtx;
    if (!ctx) return;

    if (!this.image || this.gridWidth !== maze.width || this.gridHeight !== maze.height) {
      this.gridWidth = maze.width;
      this.gridHeight = maze.height;
      this.tileCanvas.width = maze.width;
      this.tileCanvas.height = maze.height;
      this.image = ctx.createImageData(maze.width, maze.height);
      this.reveal = new Float32Array(maze.width * maze.height);
    }

    const image = this.image;
    const reveal = this.reveal;
    if (!image || !reveal) return;

    const { heat, cold, pond, explored, visible } = field;
    const cells = maze.cells;
    const tint = view.memoryTint;

    // Pass 1: floors keep whatever light is still on them.
    for (let i = 0; i < cells.length; i++) {
      if (explored[i] <= DARK) {
        reveal[i] = 0;
        continue;
      }
      const lit = visible[i];
      if (cells[i] === 1) {
        reveal[i] = lit;
        continue;
      }
      const glow = Math.max(heat[i], cold[i], pond[i] ? 0.8 : 0);
      reveal[i] = Math.max(lit, glow);
    }

    // Pass 2: walls borrow the glow of the corridor they line, so a fading
    // trail still reads as a passage instead of a floating smear.
    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        const i = y * maze.width + x;
        if (cells[i] !== 1 || explored[i] <= DARK) continue;
        let best = reveal[i];
        for (let k = 0; k < 4; k++) {
          const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
          const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= maze.width || ny >= maze.height) continue;
          const n = ny * maze.width + nx;
          if (cells[n] === 1) continue;
          best = Math.max(best, reveal[n] * 0.82);
        }
        reveal[i] = best;
      }
    }

    const data = image.data;
    for (let i = 0; i < cells.length; i++) {
      const offset = i * 4;
      const strength = reveal[i];
      if (strength <= DARK) {
        data[offset + 3] = 0;
        continue;
      }

      const wall = cells[i] === 1;
      let r = wall ? 24 : 128;
      let g = wall ? 26 : 132;
      let b = wall ? 38 : 146;

      // Ground under the ghost's own glow reads brighter than remembered ground.
      const lit = visible[i] * 0.6;
      r = mix(r, 228, lit);
      g = mix(g, 232, lit);
      b = mix(b, 242, lit);

      // Remembered ground drifts toward the theme's tint, exactly as the alley
      // floor does, so the dial belongs to whichever maze you are standing in.
      const memory = 1 - Math.min(1, visible[i] * 1.6);
      r *= mix(1, tint[0], memory);
      g *= mix(1, tint[1], memory);
      b *= mix(1, tint[2], memory);

      if (!wall) {
        const warmth = Math.min(1, heat[i] * 1.45);
        if (warmth > 0) {
          r = mix(r, WARM[0], warmth * 0.9);
          g = mix(g, WARM[1], warmth * 0.9);
          b = mix(b, WARM[2], warmth * 0.9);
        }
        const chill = Math.min(1, cold[i] * 1.45);
        if (chill > 0) {
          r = mix(r, COLD[0], chill * 0.9);
          g = mix(g, COLD[1], chill * 0.9);
          b = mix(b, COLD[2], chill * 0.9);
        }
        if (pond[i]) {
          r = mix(r, POND[0], 0.65);
          g = mix(g, POND[1], 0.65);
          b = mix(b, POND[2], 0.65);
        }
      }

      data[offset] = r | 0;
      data[offset + 1] = g | 0;
      data[offset + 2] = b | 0;
      // Walls sit back so the alleys themselves carry the shape.
      data[offset + 3] = Math.min(255, strength * 2.1 * (wall ? 165 : 245)) | 0;
    }

    ctx.putImageData(image, 0, 0);
  }

  /** Draws the tile texture, the frame and both ghosts. */
  private paintDial(view: MinimapView, size: number): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixels = Math.round(size * ratio);
    if (this.canvas.width !== pixels || this.canvas.height !== pixels) {
      this.canvas.width = pixels;
      this.canvas.height = pixels;
    }

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const centre = size / 2;
    const radius = centre - 1;
    const scale = size / VIEW_TILES;
    const { maze } = view;
    const px = view.playerX / TILE + (maze.width - 1) / 2 + 0.5;
    const py = view.playerZ / TILE + (maze.height - 1) / 2 + 0.5;

    ctx.save();
    ctx.beginPath();
    ctx.arc(centre, centre, radius, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = 'rgba(7, 8, 14, 0.72)';
    ctx.fillRect(0, 0, size, size);

    ctx.save();
    ctx.translate(centre, centre);
    ctx.rotate(VIEW_ROTATION);
    ctx.scale(scale, scale);
    ctx.translate(-px, -py);
    // Crisp tiles: the maze reads better blocky than blurred.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.tileCanvas, 0, 0, maze.width, maze.height);
    ctx.restore();

    const playerColour = view.role === 'seeker' ? COLORS.warm : COLORS.cold;
    const rivalColour = view.role === 'seeker' ? COLORS.cold : COLORS.warm;

    if (view.rivalSeen > 0.25) {
      const rx = view.rivalX / TILE + (maze.width - 1) / 2 + 0.5;
      const ry = view.rivalZ / TILE + (maze.height - 1) / 2 + 0.5;
      const spot = this.project(rx - px, ry - py, scale, centre);
      this.dot(spot[0], spot[1], 3.4, rivalColour, view.rivalSeen, true);
    }

    // A nose on the marker so the dial also says which way the ghost faces.
    const dir = this.project(Math.sin(view.playerFacing), Math.cos(view.playerFacing), 1, 0);
    ctx.beginPath();
    ctx.moveTo(centre, centre);
    ctx.lineTo(centre + dir[0] * 10, centre + dir[1] * 10);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(6, 7, 13, 0.85)';
    ctx.lineWidth = 4.5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 252, 240, 0.95)';
    ctx.lineWidth = 2;
    ctx.stroke();

    this.dot(centre, centre, 4.2, playerColour, 1, true);

    ctx.restore();

    ctx.beginPath();
    ctx.arc(centre, centre, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 233, 196, 0.22)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** Maze offset (in tiles) to a pixel on the rotated dial. */
  private project(dx: number, dy: number, scale: number, centre: number): [number, number] {
    const cos = Math.cos(VIEW_ROTATION);
    const sin = Math.sin(VIEW_ROTATION);
    return [centre + (dx * cos - dy * sin) * scale, centre + (dx * sin + dy * cos) * scale];
  }

  private dot(x: number, y: number, radius: number, colour: number, alpha: number, ring = false): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const [r, g, b] = rgb(colour);
    if (ring) {
      // A dark collar keeps the marker readable on brightly lit stone.
      ctx.beginPath();
      ctx.arc(x, y, radius + 1.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(6, 7, 13, 0.85)';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
    ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.9)`;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}
