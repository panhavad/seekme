import * as THREE from 'three';
import type { Maze } from '../core/maze';
import { createGhost, type GhostRig } from '../render/ghost';
import { BODY_RADIUS, SPEED, TILE, type Role } from './config';

/** Yaw that looks straight at the fixed 3/4 camera. */
const CAMERA_YAW = Math.PI / 4;

/** A ghost in the maze: simulation state plus its visual rig. */
export class Ghost {
  readonly role: Role;
  readonly rig: GhostRig;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector2();

  facing = 0;
  speedScale = 1;
  frozen = false;
  /** Set while the ghost is actually travelling (used for trails and ponds). */
  moving = false;
  cellX = 0;
  cellY = 0;

  private readonly maze: Maze;
  private stepPhase = 0;

  constructor(role: Role, maze: Maze) {
    this.role = role;
    this.maze = maze;
    this.rig = createGhost(role, CAMERA_YAW);
  }

  get baseSpeed(): number {
    return this.role === 'seeker' ? SPEED.seeker : SPEED.hider;
  }

  placeAtCell(cellX: number, cellY: number): void {
    const [wx, wz] = this.maze.cellToWorld(cellX, cellY, TILE);
    this.position.set(wx, 0, wz);
    this.cellX = cellX;
    this.cellY = cellY;
    this.rig.group.position.copy(this.position);
  }

  /**
   * Moves by a desired direction (unit-ish vector in world XZ), sliding along
   * walls instead of sticking to them.
   */
  step(dirX: number, dirZ: number, dt: number): boolean {
    const length = Math.hypot(dirX, dirZ);
    const speed = this.baseSpeed * this.speedScale;

    if (this.frozen || length < 0.001) {
      this.velocity.set(0, 0);
      this.moving = false;
      return false;
    }

    const nx = (dirX / length) * speed * dt;
    const nz = (dirZ / length) * speed * dt;
    const before = { x: this.position.x, z: this.position.z };

    this.position.x += nx;
    this.resolveCollisions();
    this.position.z += nz;
    this.resolveCollisions();

    const travelled = Math.hypot(this.position.x - before.x, this.position.z - before.z);
    this.moving = travelled > speed * dt * 0.25;
    this.velocity.set((this.position.x - before.x) / dt, (this.position.z - before.z) / dt);
    if (this.moving) this.facing = Math.atan2(this.position.x - before.x, this.position.z - before.z);

    const [cx, cy] = this.maze.worldToCell(this.position.x, this.position.z, TILE);
    this.cellX = cx;
    this.cellY = cy;

    return this.moving;
  }

  /** Pushes the ghost out of any wall tile it overlaps. */
  private resolveCollisions(): void {
    const [cx, cy] = this.maze.worldToCell(this.position.x, this.position.z, TILE);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!this.maze.isWall(x, y)) continue;

        const [wx, wz] = this.maze.cellToWorld(x, y, TILE);
        const half = TILE / 2;
        const closestX = clamp(this.position.x, wx - half, wx + half);
        const closestZ = clamp(this.position.z, wz - half, wz + half);
        const deltaX = this.position.x - closestX;
        const deltaZ = this.position.z - closestZ;
        const distSq = deltaX * deltaX + deltaZ * deltaZ;
        if (distSq >= BODY_RADIUS * BODY_RADIUS) continue;

        const dist = Math.sqrt(distSq);
        if (dist < 1e-5) {
          // Dead centre in a wall: shove out along the dominant axis.
          const pushX = this.position.x - wx;
          const pushZ = this.position.z - wz;
          if (Math.abs(pushX) > Math.abs(pushZ)) {
            this.position.x = wx + Math.sign(pushX || 1) * (half + BODY_RADIUS);
          } else {
            this.position.z = wz + Math.sign(pushZ || 1) * (half + BODY_RADIUS);
          }
          continue;
        }

        const push = (BODY_RADIUS - dist) / dist;
        this.position.x += deltaX * push;
        this.position.z += deltaZ * push;
      }
    }
  }

  /** Adopts a transform received from the network (no local collision). */
  applyRemote(x: number, z: number, facing: number, moving: boolean, dt: number): void {
    const prevX = this.position.x;
    const prevZ = this.position.z;
    this.position.x = x;
    this.position.z = z;
    const [cx, cy] = this.maze.worldToCell(x, z, TILE);
    this.cellX = cx;
    this.cellY = cy;
    this.facing = facing;
    this.moving = moving;
    if (dt > 0) this.velocity.set((x - prevX) / dt, (z - prevZ) / dt);
  }

  /** Advances animation; returns true on each footfall. */
  animate(time: number, dt: number): boolean {
    this.rig.group.position.set(this.position.x, 0, this.position.z);
    const speed01 = Math.min(1, this.velocity.length() / this.baseSpeed);
    this.rig.update(time, dt, speed01, this.facing);

    if (!this.moving) {
      this.stepPhase = 0.42;
      return false;
    }
    this.stepPhase += dt * (0.9 + speed01 * 0.9);
    if (this.stepPhase >= 0.5) {
      this.stepPhase = 0;
      return true;
    }
    return false;
  }

  dispose(): void {
    this.rig.dispose();
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
