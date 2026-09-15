import * as THREE from 'three';

interface Ring {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  grow: number;
}

interface Spark {
  points: THREE.Points;
  material: THREE.PointsMaterial;
  velocities: Float32Array;
  life: number;
  maxLife: number;
}

/**
 * Transient world feedback: pond splashes, "I heard that" pings that punch
 * through walls, and drifting dust so the alleys feel alive.
 */
export class Effects {
  private readonly group = new THREE.Group();
  private readonly rings: Ring[] = [];
  private readonly sparks: Spark[] = [];
  private readonly motes: THREE.Points;
  private readonly moteVelocity: Float32Array;
  private readonly moteBounds = 26;
  private time = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);

    const count = 220;
    const positions = new Float32Array(count * 3);
    this.moteVelocity = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * this.moteBounds;
      positions[i * 3 + 1] = Math.random() * 5;
      positions[i * 3 + 2] = (Math.random() - 0.5) * this.moteBounds;
      this.moteVelocity[i * 3] = (Math.random() - 0.5) * 0.12;
      this.moteVelocity[i * 3 + 1] = 0.05 + Math.random() * 0.12;
      this.moteVelocity[i * 3 + 2] = (Math.random() - 0.5) * 0.12;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.motes = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 0.06,
        map: softDotTexture(),
        color: 0xffd7a0,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      })
    );
    this.motes.frustumCulled = false;
    this.group.add(this.motes);
  }

  /** A pond splash: a bright expanding ripple at ground level. */
  splash(x: number, z: number, color: number): void {
    this.spawnRing(x, z, color, 0.9, 5.2, 0.75, true);
    this.spawnRing(x, z, 0xffffff, 0.45, 2.4, 0.45, true);
  }

  /** A located sound: a wide, slow ring that is visible through walls. */
  ping(x: number, z: number, color: number): void {
    this.spawnRing(x, z, color, 1.4, 1.35, 6.5, false);
  }

  /** Victory! Rings, sparks and a shower of confetti motes. */
  fireworks(x: number, z: number, color: number): void {
    this.spawnRing(x, z, color, 1.3, 7.5, 0.6, false);
    this.spawnRing(x, z, 0xffffff, 0.9, 4.5, 0.4, false);
    window.setTimeout(() => this.spawnRing(x, z, color, 1.1, 6, 0.5, false), 220);
    window.setTimeout(() => this.spawnRing(x, z, 0xfff0c0, 1.1, 5, 0.4, false), 430);
    this.burst(x, z, color);
  }

  /** A puff of glowing sparks that arc up and fall back down. */
  private burst(x: number, z: number, color: number): void {
    const count = 90;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.6 + Math.random() * 3.4;
      const lift = 3.4 + Math.random() * 3.6;
      positions[i * 3] = x;
      positions[i * 3 + 1] = 0.7 + Math.random() * 0.4;
      positions[i * 3 + 2] = z;
      velocities[i * 3] = Math.cos(angle) * speed;
      velocities[i * 3 + 1] = lift;
      velocities[i * 3 + 2] = Math.sin(angle) * speed;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      size: 0.22,
      map: softDotTexture(),
      color,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 5;
    this.group.add(points);
    this.sparks.push({ points, material, velocities, life: 2.4, maxLife: 2.4 });
  }

  private spawnRing(
    x: number,
    z: number,
    color: number,
    life: number,
    grow: number,
    startScale: number,
    depthTest: boolean
  ): void {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(RING_GEOMETRY, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.06, z);
    mesh.scale.setScalar(startScale);
    mesh.renderOrder = depthTest ? 2 : 4;
    this.group.add(mesh);
    this.rings.push({ mesh, material, life, maxLife: life, grow });
  }

  update(dt: number, focusX: number, focusZ: number): void {
    this.time += dt;

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.life -= dt;
      if (ring.life <= 0) {
        this.group.remove(ring.mesh);
        ring.material.dispose();
        this.rings.splice(i, 1);
        continue;
      }
      const t = 1 - ring.life / ring.maxLife;
      ring.mesh.scale.setScalar(ring.mesh.scale.x + ring.grow * dt);
      ring.material.opacity = (1 - t) * (1 - t) * 0.85;
    }

    // Victory sparks: simple ballistics with a fade-out.
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const spark = this.sparks[i];
      spark.life -= dt;
      if (spark.life <= 0) {
        this.group.remove(spark.points);
        spark.points.geometry.dispose();
        spark.material.map?.dispose();
        spark.material.dispose();
        this.sparks.splice(i, 1);
        continue;
      }
      const attribute = spark.points.geometry.attributes.position as THREE.BufferAttribute;
      const array = attribute.array as Float32Array;
      for (let p = 0; p < array.length; p += 3) {
        spark.velocities[p + 1] -= 9.2 * dt;
        array[p] += spark.velocities[p] * dt;
        array[p + 1] += spark.velocities[p + 1] * dt;
        array[p + 2] += spark.velocities[p + 2] * dt;
        if (array[p + 1] < 0.08) {
          array[p + 1] = 0.08;
          spark.velocities[p + 1] *= -0.32;
          spark.velocities[p] *= 0.7;
          spark.velocities[p + 2] *= 0.7;
        }
      }
      attribute.needsUpdate = true;
      spark.material.opacity = Math.min(1, spark.life / spark.maxLife) ** 0.7;
    }

    // Dust drifts up and wraps around the player so it is always on screen.
    const positions = this.motes.geometry.attributes.position as THREE.BufferAttribute;
    const array = positions.array as Float32Array;
    const half = this.moteBounds / 2;
    for (let i = 0; i < array.length; i += 3) {
      array[i] += this.moteVelocity[i] * dt + Math.sin(this.time * 0.6 + i) * 0.004;
      array[i + 1] += this.moteVelocity[i + 1] * dt;
      array[i + 2] += this.moteVelocity[i + 2] * dt;
      if (array[i + 1] > 5.5) array[i + 1] = 0.2;
      if (array[i] < focusX - half) array[i] += this.moteBounds;
      if (array[i] > focusX + half) array[i] -= this.moteBounds;
      if (array[i + 2] < focusZ - half) array[i + 2] += this.moteBounds;
      if (array[i + 2] > focusZ + half) array[i + 2] -= this.moteBounds;
    }
    positions.needsUpdate = true;
  }

  clear(): void {
    for (const ring of this.rings) {
      this.group.remove(ring.mesh);
      ring.material.dispose();
    }
    this.rings.length = 0;
    for (const spark of this.sparks) {
      this.group.remove(spark.points);
      spark.points.geometry.dispose();
      spark.material.map?.dispose();
      spark.material.dispose();
    }
    this.sparks.length = 0;
  }

  /** Removes everything this effects layer added to the scene. */
  dispose(): void {
    this.clear();
    this.group.removeFromParent();
    this.motes.geometry.dispose();
    const material = this.motes.material as THREE.PointsMaterial;
    material.map?.dispose();
    material.dispose();
  }
}

const RING_GEOMETRY = new THREE.RingGeometry(0.42, 0.52, 36);

function softDotTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
