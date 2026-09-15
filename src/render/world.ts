import * as THREE from 'three';
import type { Maze } from '../core/maze';
import type { TrailField } from '../core/trails';
import { TILE, WALL_HEIGHT } from '../game/config';
import { createFloorMaterial, createWallMaterial } from './materials';
import { createSharedUniforms, type SharedUniforms } from './uniforms';

/** Builds and maintains the visible maze: cobbles, walls and the trail texture. */
export class WorldView {
  readonly shared: SharedUniforms;
  readonly fieldTexture: THREE.DataTexture;

  private readonly scene: THREE.Scene;
  private readonly field: TrailField;
  private readonly meshes: THREE.Object3D[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(scene: THREE.Scene, maze: Maze, field: TrailField) {
    this.scene = scene;
    this.field = field;

    this.fieldTexture = new THREE.DataTexture(
      field.texels,
      maze.width,
      maze.height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    this.fieldTexture.minFilter = THREE.LinearFilter;
    this.fieldTexture.magFilter = THREE.LinearFilter;
    this.fieldTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.fieldTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.fieldTexture.needsUpdate = true;

    this.shared = createSharedUniforms(this.fieldTexture);
    this.shared.uGridOrigin.value.set((-maze.width * TILE) / 2, (-maze.height * TILE) / 2);
    this.shared.uGridSize.value.set(maze.width * TILE, maze.height * TILE);

    // ---- ground ---------------------------------------------------------
    const floorGeometry = new THREE.PlaneGeometry(maze.width * TILE, maze.height * TILE, 1, 1);
    const floorMaterial = createFloorMaterial(this.shared);
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    this.meshes.push(floor);
    this.disposables.push(floorGeometry, floorMaterial);

    // ---- walls ----------------------------------------------------------
    const wallCells: number[] = [];
    for (let i = 0; i < maze.cells.length; i++) {
      if (maze.cells[i] === 1) wallCells.push(i);
    }

    const wallGeometry = new THREE.BoxGeometry(TILE, WALL_HEIGHT, TILE);
    const wallMaterial = createWallMaterial(this.shared);
    const walls = new THREE.InstancedMesh(wallGeometry, wallMaterial, wallCells.length);
    walls.frustumCulled = false;

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    wallCells.forEach((cellIndex, instance) => {
      const cx = cellIndex % maze.width;
      const cy = (cellIndex / maze.width) | 0;
      const [wx, wz] = maze.cellToWorld(cx, cy, TILE);
      // Uniform height: a readable maze beats a picturesque skyline.
      position.set(wx, WALL_HEIGHT / 2, wz);
      scale.set(1, 1, 1);
      matrix.compose(position, quaternion, scale);
      walls.setMatrixAt(instance, matrix);
    });
    walls.instanceMatrix.needsUpdate = true;

    scene.add(walls);
    this.meshes.push(walls);
    this.disposables.push(wallGeometry, wallMaterial);
  }

  update(time: number, focus: THREE.Vector3, lamp: THREE.Vector3, wisp: THREE.Vector3): void {
    this.shared.uTime.value = time;
    // Aim the wall dissolve at the ghost's body, not its feet.
    this.shared.uFocus.value.set(focus.x, 1.0, focus.z);
    this.shared.uLampPos.value.copy(lamp);
    this.shared.uWispPos.value.copy(wisp);

    this.field.updateTexels();
    this.fieldTexture.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of this.meshes) this.scene.remove(mesh);
    for (const item of this.disposables) item.dispose();
    this.fieldTexture.dispose();
    this.meshes.length = 0;
  }
}
