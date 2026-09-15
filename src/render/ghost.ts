import * as THREE from 'three';
import { COLORS, type Role } from '../game/config';

/** Chunky on purpose: the little ghost should read clearly from the 3/4 camera. */
const BODY_SCALE = 1.45;

/** How far the ghost may turn away from the camera (~115 degrees). */
const FACING_LIMIT = 2.0;

function wrapAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export interface GhostRig {  readonly group: THREE.Group;
  readonly light: THREE.PointLight;
  /** World position of the lamp/wisp, used by the terrain shaders. */
  lightWorldPosition(target: THREE.Vector3): THREE.Vector3;
  update(time: number, dt: number, speed01: number, facing: number): void;
  setOpacity(value: number): void;
  /** Kick off (or stop) the little victory dance. */
  setCelebrating(value: boolean): void;
  dispose(): void;
}

/**
 * A cute sheet ghost: rounded dome, wavy hem, two dot eyes, a little smile and
 * either a warm lantern (seeker) or a cold wisp (hider) held at its side.
 *
 * `cameraYaw` (the fixed yaw that points at the camera) keeps the ghost from
 * ever turning its back fully on the player - it stays angled enough that the
 * face is always readable, the way classic isometric games cheat it.
 */
export function createGhost(role: Role, cameraYaw: number | null = null): GhostRig {
  const group = new THREE.Group();
  // Everything hangs off a pivot that leans back toward the 3/4 camera, so the
  // face stays visible no matter which way the ghost is drifting.
  const pivot = new THREE.Group();
  pivot.rotation.x = -0.5;
  group.add(pivot);

  const isSeeker = role === 'seeker';
  const tint = isSeeker ? COLORS.warm : COLORS.cold;

  const bodyGeometry = buildSheetGeometry();
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.sheet,
    roughness: 0.62,
    metalness: 0.0,
    emissive: new THREE.Color(isSeeker ? 0xfff0dc : 0xcfeeff).multiplyScalar(0.42),
    emissiveIntensity: 1,
    transparent: true,
    opacity: 0.96,
    side: THREE.DoubleSide,
  });
  const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
  body.castShadow = false;
  pivot.add(body);

  // A soft fill above and in front of the sheet so the little ghost never
  // silhouettes into a black blob against its own lamp.
  const fill = new THREE.PointLight(isSeeker ? 0xffe6c2 : 0xd6f2ff, 4.5, 3.4, 2);
  fill.position.set(0, 1.5, 1.1);
  pivot.add(fill);

  // ---- face -------------------------------------------------------------
  const faceMaterial = new THREE.MeshBasicMaterial({ color: 0x16161c });
  const eyeGeometry = new THREE.SphereGeometry(0.088, 16, 14);
  const leftEye = new THREE.Mesh(eyeGeometry, faceMaterial);
  leftEye.position.set(-0.175, 0.63, 0.5);
  leftEye.scale.set(1, 1.08, 0.62);
  const rightEye = leftEye.clone();
  rightEye.position.x = 0.175;
  pivot.add(leftEye, rightEye);

  const smile = new THREE.Mesh(
    new THREE.TorusGeometry(0.075, 0.016, 8, 20, Math.PI),
    faceMaterial
  );
  smile.position.set(0, 0.5, 0.53);
  smile.rotation.set(0, 0, Math.PI);
  pivot.add(smile);

  // ---- little arms ------------------------------------------------------
  // Soft sleeve nubs: the lamp-side one is lifted as if holding the handle.
  const armGeometry = new THREE.SphereGeometry(0.15, 14, 12);
  const leftArm = new THREE.Mesh(armGeometry, bodyMaterial);
  leftArm.position.set(-0.55, 0.42, 0.16);
  leftArm.scale.set(1.05, 1.25, 0.95);
  const rightArm = new THREE.Mesh(armGeometry, bodyMaterial);
  rightArm.position.set(0.56, 0.3, 0.12);
  rightArm.scale.set(1.0, 1.1, 0.95);
  pivot.add(leftArm, rightArm);

  // ---- held light -------------------------------------------------------
  const hand = new THREE.Group();
  hand.position.set(-0.52, 0.5, 0.42);
  pivot.add(hand);

  // The flame sits below the hand, where the lantern actually hangs.
  const lightAnchor = new THREE.Object3D();
  lightAnchor.position.set(0, isSeeker ? -0.36 : 0, 0);
  hand.add(lightAnchor);

  const light = new THREE.PointLight(tint, isSeeker ? 6.5 : 4.5, isSeeker ? 15 : 11, 1.8);
  lightAnchor.add(light);

  if (isSeeker) {
    hand.add(buildLantern());
  } else {
    hand.add(buildWisp());
  }

  const dispose: Array<{ dispose(): void }> = [bodyGeometry, bodyMaterial, eyeGeometry, faceMaterial];
  const lightWorld = new THREE.Vector3();
  let currentFacing = 0;
  let celebrating = false;
  let partyTime = 0;

  return {
    group,
    light,
    lightWorldPosition(target) {
      lightAnchor.getWorldPosition(lightWorld);
      return target.copy(lightWorld);
    },
    update(time, dt, speed01, facing) {
      if (celebrating) {
        // Victory dance: happy hops, a spin and a wiggling lantern.
        partyTime += dt;
        const hop = Math.abs(Math.sin(partyTime * 5.2)) * 0.42;
        const squish = 1 + Math.sin(partyTime * 10.4) * 0.09;
        group.position.y = hop;
        group.scale.set(BODY_SCALE * (2 - squish), BODY_SCALE * squish, BODY_SCALE * (2 - squish));
        group.rotation.y = currentFacing + partyTime * 3.4;
        body.rotation.z = Math.sin(partyTime * 6.3) * 0.16;
        hand.position.y = 0.5 + Math.sin(partyTime * 7.1) * 0.12;
        leftArm.position.y = 0.42 + Math.abs(Math.sin(partyTime * 5.2)) * 0.12;
        rightArm.position.y = 0.3 + Math.abs(Math.cos(partyTime * 5.2)) * 0.12;
        light.intensity = (isSeeker ? 6.5 : 4.5) * (1.1 + 0.35 * Math.sin(partyTime * 12));
        return;
      }

      // hover bob + squash, livelier while drifting along
      const bob = Math.sin(time * (2.1 + speed01 * 2.2)) * (0.045 + speed01 * 0.035);
      body.position.y = bob;
      leftEye.position.y = 0.63 + bob;
      rightEye.position.y = 0.63 + bob;
      smile.position.y = 0.5 + bob;
      leftArm.position.y = 0.42 + bob * 0.8;
      rightArm.position.y = 0.3 + bob * 0.8;
      hand.position.y = 0.5 + bob * 0.5 + Math.sin(time * 1.7) * 0.02;

      body.rotation.z = Math.sin(time * 1.6) * 0.035 + speed01 * 0.06;
      const squash = 1 + Math.sin(time * 2.4) * 0.018;
      group.scale.set(BODY_SCALE, BODY_SCALE * squash, BODY_SCALE);

      // smooth turn toward the travel direction, never fully turning away
      let wanted = facing;
      if (cameraYaw !== null) {
        let offset = wrapAngle(facing - cameraYaw);
        offset = Math.max(-FACING_LIMIT, Math.min(FACING_LIMIT, offset));
        wanted = cameraYaw + offset;
      }
      const delta = wrapAngle(wanted - currentFacing);
      currentFacing += delta * Math.min(1, dt * 11);
      group.rotation.y = currentFacing;

      light.intensity =
        (isSeeker ? 6.5 : 4.5) * (0.9 + 0.1 * Math.sin(time * 9.3) * Math.sin(time * 3.1));
    },
    setCelebrating(value) {
      celebrating = value;
      partyTime = 0;
      if (!value) group.position.y = 0;
    },
    setOpacity(value) {
      bodyMaterial.opacity = 0.95 * value;
      faceMaterial.opacity = value;
      faceMaterial.transparent = value < 1;
      group.visible = value > 0.02;
    },
    dispose() {
      for (const item of dispose) item.dispose();
    },
  };
}

/**
 * The bedsheet silhouette: a nearly spherical head that swells into a soft
 * draped skirt, with a scalloped hem that curls under like real cloth.
 */
function buildSheetGeometry(): THREE.BufferGeometry {
  const HEAD_CENTER = 0.54;
  const HEAD_RADIUS = 0.58;
  const HEM_RADIUS = 0.74;
  const TOP = HEAD_CENTER + HEAD_RADIUS;

  const profile: THREE.Vector2[] = [];
  const steps = 42;
  for (let i = 0; i <= steps; i++) {
    const y = TOP - (i / steps) * TOP;
    let radius: number;
    if (y >= HEAD_CENTER) {
      // upper half: a true dome, so the head reads as a ball
      const d = (y - HEAD_CENTER) / HEAD_RADIUS;
      radius = HEAD_RADIUS * Math.sqrt(Math.max(0, 1 - d * d));
    } else {
      // lower half: the sheet swells gently outward into the hem
      const k = (HEAD_CENTER - y) / HEAD_CENTER;
      radius = HEAD_RADIUS + (HEM_RADIUS - HEAD_RADIUS) * Math.pow(k, 1.7);
    }
    profile.push(new THREE.Vector2(Math.max(0.002, radius), y));
  }

  // Curl the hem under so the ghost looks like a plump blob, not an open cone.
  profile.push(new THREE.Vector2(HEM_RADIUS * 0.93, -0.035));
  profile.push(new THREE.Vector2(HEM_RADIUS * 0.7, -0.075));
  profile.push(new THREE.Vector2(HEM_RADIUS * 0.36, -0.09));
  profile.push(new THREE.Vector2(0.002, -0.095));

  const geometry = new THREE.LatheGeometry(profile, 56);
  const position = geometry.attributes.position as THREE.BufferAttribute;

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const angle = Math.atan2(z, x);

    // Soft vertical folds in the cloth, strongest low on the drape.
    const drape = Math.max(0, 1 - Math.max(0, y) / 0.75);
    if (drape > 0) {
      const fold = 1 + Math.sin(angle * 8 + 1.3) * 0.022 * drape;
      position.setX(i, x * fold);
      position.setZ(i, z * fold);
    }

    // Rounded scallops that only affect the lower hem.
    const hem = Math.max(0, 1 - Math.max(0, y) / 0.42);
    if (hem <= 0) continue;

    const lobe = Math.sin(angle * 6 + 0.5) * 0.5 + 0.5;
    const falloff = hem * hem;
    position.setY(i, y + (lobe * 0.12 - 0.02) * falloff);
    const spread = 1 + 0.085 * falloff * (0.45 + (1 - lobe) * 0.8);
    position.setX(i, position.getX(i) * spread);
    position.setZ(i, position.getZ(i) * spread);
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** A little oil lantern that hangs from the ghost's raised hand. */
function buildLantern(): THREE.Group {
  const lantern = new THREE.Group();
  // Hangs below the wrist, the way a real lantern swings from a handle.
  lantern.position.y = -0.36;

  const metal = new THREE.MeshStandardMaterial({
    color: 0x3a2a18,
    metalness: 0.8,
    roughness: 0.38,
  });

  // rounded glass belly
  const glass = new THREE.Mesh(
    new THREE.SphereGeometry(0.115, 16, 14),
    new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.8 })
  );
  glass.scale.set(1, 1.12, 1);
  lantern.add(glass);

  const cage = new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.125, 0.235, 12, 1, true), metal);
  lantern.add(cage);

  const capTop = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.135, 0.08, 12), metal);
  capTop.position.y = 0.155;
  const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.055, 0.05, 10), metal);
  chimney.position.y = 0.215;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.115, 0.07, 12), metal);
  base.position.y = -0.155;
  lantern.add(capTop, chimney, base);

  // wire handle reaching up to the hand
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.012, 6, 18, Math.PI), metal);
  handle.position.y = 0.24;
  handle.rotation.y = Math.PI / 2;
  lantern.add(handle);

  const flame = new THREE.Mesh(
    new THREE.SphereGeometry(0.052, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xfff1cf })
  );
  flame.scale.y = 1.5;
  lantern.add(flame);

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 14, 12),
    new THREE.MeshBasicMaterial({
      color: 0xffa646,
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  lantern.add(halo);

  return lantern;
}

function buildWisp(): THREE.Group {
  const wisp = new THREE.Group();

  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.075, 1),
    new THREE.MeshBasicMaterial({ color: 0xd8f6ff })
  );
  wisp.add(core);

  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 12, 10),
    new THREE.MeshBasicMaterial({
      color: 0x59c9ff,
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  wisp.add(shell);

  const stick = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.016, 0.16, 6),
    new THREE.MeshStandardMaterial({ color: 0x1f2b38, roughness: 0.6 })
  );
  stick.position.y = -0.11;
  wisp.add(stick);

  return wisp;
}
