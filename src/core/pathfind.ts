import type { Maze } from './maze';

/**
 * Breadth-first flow field over the maze floor. Recomputing is cheap for our
 * grid sizes, and the resulting distance field gives both steering and
 * "how far away is that noise" answers for free.
 */
export class FlowField {
  private readonly maze: Maze;
  readonly dist: Int32Array;
  private readonly queue: Int32Array;

  constructor(maze: Maze) {
    this.maze = maze;
    this.dist = new Int32Array(maze.width * maze.height).fill(-1);
    this.queue = new Int32Array(maze.width * maze.height);
  }

  compute(targetX: number, targetY: number): void {
    const { maze, dist, queue } = this;
    dist.fill(-1);
    if (maze.isWall(targetX, targetY)) {
      const fallback = nearestFloor(maze, targetX, targetY);
      if (!fallback) return;
      targetX = fallback[0];
      targetY = fallback[1];
    }

    let head = 0;
    let tail = 0;
    const start = maze.index(targetX, targetY);
    dist[start] = 0;
    queue[tail++] = start;

    while (head < tail) {
      const current = queue[head++];
      const cx = current % maze.width;
      const cy = (current / maze.width) | 0;
      const nd = dist[current] + 1;

      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d];
        const ny = cy + DY[d];
        if (maze.isWall(nx, ny)) continue;
        const ni = maze.index(nx, ny);
        if (dist[ni] !== -1) continue;
        dist[ni] = nd;
        queue[tail++] = ni;
      }
    }
  }

  distanceAt(x: number, y: number): number {
    if (!this.maze.inBounds(x, y)) return -1;
    return this.dist[this.maze.index(x, y)];
  }

  /** Next cell to walk toward the target, or null when already there / unreachable. */
  nextStep(x: number, y: number): [number, number] | null {
    const here = this.distanceAt(x, y);
    if (here <= 0) return null;

    let best: [number, number] | null = null;
    let bestDist = here;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      const nd = this.distanceAt(nx, ny);
      if (nd === -1) continue;
      if (nd < bestDist) {
        bestDist = nd;
        best = [nx, ny];
      }
    }
    return best;
  }
}

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

export function nearestFloor(maze: Maze, x: number, y: number): [number, number] | null {
  if (maze.isFloor(x, y)) return [x, y];
  for (let r = 1; r < Math.max(maze.width, maze.height); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (maze.isFloor(nx, ny)) return [nx, ny];
      }
    }
  }
  return null;
}

/** Straight-line visibility test on the grid (Bresenham through floor cells). */
export function hasLineOfSight(
  maze: Maze,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): boolean {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  for (let guard = 0; guard < 4096; guard++) {
    if (x === x1 && y === y1) return true;
    if (!(x === x0 && y === y0) && maze.isWall(x, y)) return false;

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return false;
}
