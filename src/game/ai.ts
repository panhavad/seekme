import type { Maze } from '../core/maze';
import type { TrailField } from '../core/trails';
import { FlowField, hasLineOfSight } from '../core/pathfind';
import type { Rng } from '../core/rng';
import { AI, TILE, type Difficulty, type Role } from './config';
import type { Ghost } from './entity';

export interface AiDebugState {
  state: 'patrol' | 'chase' | 'investigate' | 'sniff' | 'flee' | 'hide';
  target: [number, number] | null;
}

/**
 * The computer-controlled ghost. It plays by exactly the same rules as the
 * player: it can only see what has line of sight, and otherwise has to read
 * scorch marks, frost and splashes.
 */
export class GhostAi {
  readonly role: Role;
  readonly debug: AiDebugState = { state: 'patrol', target: null };

  private readonly maze: Maze;
  private readonly field: TrailField;
  private readonly tuning: (typeof AI)[Difficulty];
  private readonly rng: Rng;
  private readonly flow: FlowField;
  private readonly threatFlow: FlowField;

  private target: [number, number] | null = null;
  private planTimer = 0;
  private threatTimer = 0;
  private chaseMemory = 0;
  private heardMemory = 0;
  private heardCell: [number, number] | null = null;
  private lastSeenCell: [number, number] | null = null;
  private idleTimer = 0;
  private stuckTimer = 0;
  private lastPosition: [number, number] = [0, 0];
  /** When each tile was last swept, so patrols cover ground instead of looping. */
  private readonly visited: Float32Array;
  private clock = 0;
  private sniffTimer = 0;

  constructor(role: Role, maze: Maze, field: TrailField, difficulty: Difficulty, rng: Rng) {
    this.role = role;
    this.maze = maze;
    this.field = field;
    this.tuning = AI[difficulty];
    this.rng = rng;
    this.flow = new FlowField(maze);
    this.threatFlow = new FlowField(maze);
    this.visited = new Float32Array(maze.width * maze.height).fill(-120);
  }

  get speedScale(): number {
    return this.tuning.speedScale;
  }

  /** Called when a pond splashes somewhere in the maze. */
  hear(cellX: number, cellY: number, selfCellX: number, selfCellY: number): boolean {
    const distance = Math.hypot(cellX - selfCellX, cellY - selfCellY);
    if (distance > this.tuning.hearingTiles) return false;
    this.heardCell = [cellX, cellY];
    this.heardMemory = 6;
    return true;
  }

  update(dt: number, self: Ghost, opponent: Ghost): [number, number] {
    this.clock += dt;
    this.planTimer -= dt;
    this.chaseMemory = Math.max(0, this.chaseMemory - dt);
    this.heardMemory = Math.max(0, this.heardMemory - dt);
    this.threatTimer = Math.max(0, this.threatTimer - dt);
    this.idleTimer = Math.max(0, this.idleTimer - dt);
    this.sniffTimer = Math.max(0, this.sniffTimer - dt);
    this.markSwept(self);

    const sees = this.canSee(self, opponent);
    if (sees) {
      this.lastSeenCell = [opponent.cellX, opponent.cellY];
      this.chaseMemory = this.tuning.memorySeconds;
    }

    if (this.role === 'seeker') this.thinkAsSeeker(self, opponent, sees);
    else this.thinkAsHider(self, opponent, sees);

    return this.steer(dt, self);
  }

  private canSee(self: Ghost, opponent: Ghost): boolean {
    const distance = Math.hypot(opponent.cellX - self.cellX, opponent.cellY - self.cellY);
    if (distance > this.tuning.visionTiles) return false;
    return hasLineOfSight(this.maze, self.cellX, self.cellY, opponent.cellX, opponent.cellY);
  }

  // ------------------------------------------------------------------ seeker
  private thinkAsSeeker(self: Ghost, opponent: Ghost, sees: boolean): void {
    if (sees) {
      this.debug.state = 'chase';
      this.setTarget([opponent.cellX, opponent.cellY], true);
      return;
    }

    if (this.chaseMemory > 0 && this.lastSeenCell) {
      this.debug.state = 'investigate';
      this.setTarget(this.lastSeenCell);
      if (this.atTarget(self)) this.chaseMemory = 0;
      return;
    }

    if (this.heardMemory > 0 && this.heardCell) {
      this.debug.state = 'investigate';
      this.setTarget(this.heardCell);
      if (this.atTarget(self)) {
        this.heardMemory = 0;
        this.heardCell = null;
      }
      return;
    }

    // Sniff out frost: a glowing mark is a lead, and the brightest one is freshest.
    if (this.sniffTimer <= 0 && (this.planTimer <= 0 || !this.target || this.debug.state === 'patrol')) {
      this.sniffTimer = 0.25;
      const mark = this.spotFrost(self);
      if (mark && !(mark.x === self.cellX && mark.y === self.cellY)) {
        this.debug.state = 'sniff';
        this.setTarget([mark.x, mark.y], true);
        return;
      }
    }

    if (!this.target || this.atTarget(self)) {
      this.debug.state = 'patrol';
      this.setTarget(this.sweepCell(self), true);
    }
  }

  /**
   * Looks for frost the seeker could actually see: anything underfoot, the glow
   * bleeding around nearby corners, and any mark in line of sight further out.
   * Fresher (brighter) marks win.
   */
  private spotFrost(self: Ghost): { x: number; y: number; value: number } | null {
    const radius = Math.ceil(2 + this.tuning.visionTiles * this.tuning.trailSense);
    const minimum = 0.06 + (1 - this.tuning.trailSense) * 0.16;
    let best: { x: number; y: number; value: number } | null = null;

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const distSq = dx * dx + dy * dy;
        if (distSq > radius * radius) continue;
        const x = self.cellX + dx;
        const y = self.cellY + dy;
        if (!this.maze.inBounds(x, y) || this.maze.isWall(x, y)) continue;

        const value = this.field.coldAt(x, y);
        if (value < minimum) continue;
        if (distSq > 16 && !hasLineOfSight(this.maze, self.cellX, self.cellY, x, y)) continue;
        if (!best || value > best.value) best = { x, y, value };
      }
    }
    return best;
  }

  /** Sweeps the alleys it has not checked in a while rather than wandering blindly. */
  private sweepCell(self: Ghost): [number, number] {
    const cells = this.maze.floorCells;
    let best: [number, number] = [self.cellX, self.cellY];
    let bestScore = -Infinity;

    for (let i = 0; i < 90; i++) {
      const cellIndex = cells[Math.floor(this.rng() * cells.length)];
      const x = cellIndex % this.maze.width;
      const y = (cellIndex / this.maze.width) | 0;
      const distance = Math.hypot(x - self.cellX, y - self.cellY);
      if (distance < 3) continue;

      const staleness = Math.min(90, this.clock - this.visited[cellIndex]);
      // Prefer somewhere unchecked, but not all the way across the map.
      const score = staleness - Math.abs(distance - 9) * 1.6 + this.rng() * 4;
      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
    return best;
  }

  /** Remembers the tiles the seeker has already looked down. */
  private markSwept(self: Ghost): void {
    const radius = 3;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = self.cellX + dx;
        const y = self.cellY + dy;
        if (!this.maze.inBounds(x, y) || this.maze.isWall(x, y)) continue;
        if (dx * dx + dy * dy > radius * radius) continue;
        if (dx * dx + dy * dy > 2 && !hasLineOfSight(this.maze, self.cellX, self.cellY, x, y)) continue;
        this.visited[this.maze.index(x, y)] = this.clock;
      }
    }
  }

  // ------------------------------------------------------------------- hider
  private thinkAsHider(self: Ghost, opponent: Ghost, sees: boolean): void {
    const heatHere = this.field.heatAt(self.cellX, self.cellY);
    const distance = Math.hypot(opponent.cellX - self.cellX, opponent.cellY - self.cellY);
    const threatened = sees || heatHere > 0.28 || distance < 5.5;
    if (threatened) this.threatTimer = 3.2;

    if (this.threatTimer > 0) {
      this.debug.state = 'flee';
      if (this.planTimer <= 0 || !this.target || this.atTarget(self)) {
        const refuge = this.findRefuge(self, opponent);
        if (refuge) this.setTarget(refuge, true);
      }
      return;
    }

    // Calm: settle in a cold, quiet corner, but shuffle before melting a pond.
    // A careless (easy) ghost tolerates more dwell, so it leaves ponds behind.
    const pondTolerance = 0.7 + (1 - this.tuning.trailSense) * 0.28;
    if (this.field.dwellRatio(self.cellX, self.cellY) > pondTolerance) {
      this.debug.state = 'hide';
      this.setTarget(this.wanderCell(self, 3), true);
      return;
    }

    if (!this.target || this.atTarget(self)) {
      if (this.idleTimer > 0) {
        this.debug.state = 'hide';
        this.target = null;
        return;
      }
      this.idleTimer = 2.5 + this.rng() * 4;
      this.debug.state = 'hide';
      this.setTarget(this.findRefuge(self, opponent) ?? this.wanderCell(self, 6), true);
    }
  }

  /** Scores random tiles: far from the seeker, cold, and not too far to reach. */
  private findRefuge(self: Ghost, opponent: Ghost): [number, number] | null {
    this.threatFlow.compute(opponent.cellX, opponent.cellY);
    const cells = this.maze.floorCells;
    if (cells.length === 0) return null;

    let best: [number, number] | null = null;
    let bestScore = -Infinity;
    const samples = 70;

    for (let i = 0; i < samples; i++) {
      const cellIndex = cells[Math.floor(this.rng() * cells.length)];
      const x = cellIndex % this.maze.width;
      const y = (cellIndex / this.maze.width) | 0;
      const threatDistance = this.threatFlow.distanceAt(x, y);
      if (threatDistance < 0) continue;

      const selfDistance = Math.hypot(x - self.cellX, y - self.cellY);
      const heat = this.field.heatAt(x, y);
      const pondPenalty = this.field.isPond(x, y) ? 4 : 0;
      const score =
        Math.min(threatDistance, 26) * 1.35 - heat * 16 - selfDistance * 0.55 - pondPenalty;

      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
    return best;
  }

  private wanderCell(self: Ghost, minDistance: number): [number, number] {
    const cells = this.maze.floorCells;
    for (let i = 0; i < 40; i++) {
      const cellIndex = cells[Math.floor(this.rng() * cells.length)];
      const x = cellIndex % this.maze.width;
      const y = (cellIndex / this.maze.width) | 0;
      if (Math.hypot(x - self.cellX, y - self.cellY) >= minDistance) return [x, y];
    }
    return [self.cellX, self.cellY];
  }

  private setTarget(cell: [number, number], replan = false): void {
    const changed = !this.target || this.target[0] !== cell[0] || this.target[1] !== cell[1];
    this.target = cell;
    this.debug.target = cell;
    if (changed || replan || this.planTimer <= 0) {
      this.flow.compute(cell[0], cell[1]);
      this.planTimer = this.tuning.planInterval;
    }
  }

  private atTarget(self: Ghost): boolean {
    if (!this.target) return true;
    return Math.abs(self.cellX - this.target[0]) + Math.abs(self.cellY - this.target[1]) <= 0;
  }

  /** Converts the current plan into a world-space direction. */
  private steer(dt: number, self: Ghost): [number, number] {
    if (!this.target) return [0, 0];

    const next = this.flow.nextStep(self.cellX, self.cellY);
    const [tx, ty] = next ?? this.target;
    const [wx, wz] = this.maze.cellToWorld(tx, ty, TILE);
    let dx = wx - self.position.x;
    let dz = wz - self.position.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.08) return [0, 0];
    dx /= length;
    dz /= length;

    // Unstick: if the plan is not actually producing movement, repath.
    const moved = Math.hypot(self.position.x - this.lastPosition[0], self.position.z - this.lastPosition[1]);
    this.lastPosition = [self.position.x, self.position.z];
    if (moved < self.baseSpeed * dt * 0.2) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.7) {
        this.stuckTimer = 0;
        this.planTimer = 0;
        this.target = null;
        this.chaseMemory = 0;
      }
    } else {
      this.stuckTimer = 0;
    }

    return [dx, dz];
  }
}
