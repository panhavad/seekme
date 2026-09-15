import { randInt, type Rng } from './rng';

export const WALL = 1;
export const FLOOR = 0;

/**
 * A maze of alleys: odd-sized grid carved with a recursive backtracker, then
 * "braided" (some dead ends opened) and dotted with small plazas so the player
 * has loops to run and corners to hide in.
 */
export class Maze {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint8Array;
  readonly floorCells: number[] = [];

  constructor(width: number, height: number) {
    this.width = width | 1;
    this.height = height | 1;
    this.cells = new Uint8Array(this.width * this.height).fill(WALL);
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  isWall(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return true;
    return this.cells[this.index(x, y)] === WALL;
  }

  isFloor(x: number, y: number): boolean {
    return !this.isWall(x, y);
  }

  cellToWorld(x: number, y: number, tile: number): [number, number] {
    return [(x - (this.width - 1) / 2) * tile, (y - (this.height - 1) / 2) * tile];
  }

  worldToCell(wx: number, wz: number, tile: number): [number, number] {
    return [
      Math.round(wx / tile + (this.width - 1) / 2),
      Math.round(wz / tile + (this.height - 1) / 2),
    ];
  }

  /** Recomputes the cached list of walkable cell indices. */
  refreshFloorCells(): void {
    this.floorCells.length = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === FLOOR) this.floorCells.push(i);
    }
  }
}

export interface MazeOptions {
  width: number;
  height: number;
  /** 0..1 - portion of dead ends that get opened into loops. */
  braid: number;
  /** Number of small open plazas carved into the maze. */
  plazas: number;
}

export function generateMaze(options: MazeOptions, rng: Rng): Maze {
  const maze = new Maze(options.width, options.height);
  carveBacktracker(maze, rng);
  braid(maze, options.braid, rng);
  carvePlazas(maze, options.plazas, rng);
  sealBorder(maze);
  maze.refreshFloorCells();
  return maze;
}

function carveBacktracker(maze: Maze, rng: Rng): void {
  const { width, height, cells } = maze;
  const startX = 1;
  const startY = 1;
  cells[maze.index(startX, startY)] = FLOOR;

  const stack: Array<[number, number]> = [[startX, startY]];
  const dirs: Array<[number, number]> = [
    [0, -2],
    [2, 0],
    [0, 2],
    [-2, 0],
  ];

  while (stack.length > 0) {
    const [cx, cy] = stack[stack.length - 1];
    const order = shuffle(dirs.slice(), rng);
    let advanced = false;

    for (const [dx, dy] of order) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx <= 0 || ny <= 0 || nx >= width - 1 || ny >= height - 1) continue;
      if (cells[maze.index(nx, ny)] === FLOOR) continue;

      cells[maze.index(cx + dx / 2, cy + dy / 2)] = FLOOR;
      cells[maze.index(nx, ny)] = FLOOR;
      stack.push([nx, ny]);
      advanced = true;
      break;
    }

    if (!advanced) stack.pop();
  }
}

/** Opens a share of dead ends so both ghosts can circle instead of getting trapped. */
function braid(maze: Maze, amount: number, rng: Rng): void {
  const { width, height, cells } = maze;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (cells[maze.index(x, y)] !== FLOOR) continue;
      const open: Array<[number, number]> = [];
      const closed: Array<[number, number]> = [];
      const neighbours: Array<[number, number]> = [
        [x, y - 1],
        [x + 1, y],
        [x, y + 1],
        [x - 1, y],
      ];
      for (const [nx, ny] of neighbours) {
        if (maze.isWall(nx, ny)) closed.push([nx, ny]);
        else open.push([nx, ny]);
      }
      if (open.length !== 1 || closed.length === 0) continue;
      if (rng() > amount) continue;

      const candidates = closed.filter(([nx, ny]) => nx > 0 && ny > 0 && nx < width - 1 && ny < height - 1);
      if (candidates.length === 0) continue;
      const [ox, oy] = candidates[Math.floor(rng() * candidates.length)];
      cells[maze.index(ox, oy)] = FLOOR;
    }
  }
}

function carvePlazas(maze: Maze, count: number, rng: Rng): void {
  for (let i = 0; i < count; i++) {
    const w = randInt(rng, 2, 4);
    const h = randInt(rng, 2, 4);
    const x0 = randInt(rng, 2, Math.max(2, maze.width - w - 3));
    const y0 = randInt(rng, 2, Math.max(2, maze.height - h - 3));
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (x <= 0 || y <= 0 || x >= maze.width - 1 || y >= maze.height - 1) continue;
        maze.cells[maze.index(x, y)] = FLOOR;
      }
    }
  }
}

function sealBorder(maze: Maze): void {
  for (let x = 0; x < maze.width; x++) {
    maze.cells[maze.index(x, 0)] = WALL;
    maze.cells[maze.index(x, maze.height - 1)] = WALL;
  }
  for (let y = 0; y < maze.height; y++) {
    maze.cells[maze.index(0, y)] = WALL;
    maze.cells[maze.index(maze.width - 1, y)] = WALL;
  }
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}
