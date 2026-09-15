import * as THREE from 'three';
import { FontLoader, type Font } from 'three/examples/jsm/loaders/FontLoader.js';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';
import fontData from 'three/examples/fonts/helvetiker_bold.typeface.json';
import { createGhost } from './ghost';

/** World-space box the title + ghost occupy, used to frame the camera. */
const LOGO_EXTENT = { width: 20, height: 5.8 };

/**
 * The title card is a real 3D object, not a picture of one: extruded, bevelled
 * letters lit by a flickering lantern, with the game's own ghost model hovering
 * beside them. It renders into its own small canvas above the menu.
 */
export class TitleLogo {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly group = new THREE.Group();
  private readonly lantern: THREE.PointLight;
  private readonly ghost = createGhost('seeker');
  private readonly disposables: Array<{ dispose(): void }> = [];

  private frame = 0;
  private clock = new THREE.Clock();
  private pointer = { x: 0, y: 0 };
  private target = { x: 0, y: 0 };
  private running = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.camera = new THREE.PerspectiveCamera(34, 3, 0.1, 60);
    this.camera.position.set(0, 0.4, 13.5);
    this.camera.lookAt(0, -0.2, 0);

    this.scene.add(this.group);
    this.scene.add(new THREE.AmbientLight(0x2b3861, 1.1));

    // Warm key light: the same lantern colour that lights the maze.
    this.lantern = new THREE.PointLight(0xffb257, 46, 26, 1.6);
    this.lantern.position.set(-4.4, -1.6, 4.2);
    this.scene.add(this.lantern);

    // Cold rim from behind, so the letters read against a dark page.
    const rim = new THREE.DirectionalLight(0x6fd8ff, 1.5);
    rim.position.set(4, 2.5, -3);
    this.scene.add(rim);

    const top = new THREE.DirectionalLight(0xfff0dc, 0.7);
    top.position.set(0, 6, 4);
    this.scene.add(top);

    this.buildTitle();
    this.buildGhost();

    canvas.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  private buildTitle(): void {
    const font = new FontLoader().parse(fontData as unknown as Parameters<FontLoader['parse']>[0]) as Font;

    const geometry = new TextGeometry('SEEKME', {
      font,
      size: 1.62,
      depth: 0.52,
      curveSegments: 6,
      bevelEnabled: true,
      bevelThickness: 0.1,
      bevelSize: 0.075,
      bevelOffset: 0,
      bevelSegments: 4,
    });
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    geometry.translate(
      -(box.max.x + box.min.x) / 2,
      -(box.max.y + box.min.y) / 2,
      -(box.max.z + box.min.z) / 2
    );

    const faceMaterial = new THREE.MeshStandardMaterial({
      color: 0xf6f2e8,
      roughness: 0.32,
      metalness: 0.45,
      emissive: new THREE.Color(0xff9a3c).multiplyScalar(0.1),
    });
    const sideMaterial = new THREE.MeshStandardMaterial({
      color: 0xffa646,
      roughness: 0.42,
      metalness: 0.6,
      emissive: new THREE.Color(0xff5a2b).multiplyScalar(0.22),
    });

    const text = new THREE.Mesh(geometry, [faceMaterial, sideMaterial]);
    text.position.set(1.35, 0.15, 0);
    this.group.add(text);

    this.disposables.push(geometry, faceMaterial, sideMaterial);
  }

  private buildGhost(): void {
    // The rig rewrites its own scale/rotation each frame, so hang it on a holder.
    // The holder also cancels the in-game forward lean: the logo camera looks
    // straight ahead, so the little ghost should stand upright and face us.
    const holder = new THREE.Group();
    holder.scale.setScalar(1.9);
    holder.position.set(-5.5, -1.05, 1.4);
    holder.rotation.x = 0.5;
    holder.add(this.ghost.group);
    this.group.add(holder);
  }

  private onPointerMove = (event: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.target.x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    this.target.y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
  };

  private resize = (): void => {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;

    // Frame the title + ghost to whatever canvas we were given, so the logo is
    // the same size on a phone as it is on a desktop.
    const halfFov = Math.tan((this.camera.fov * Math.PI) / 360);
    const forWidth = LOGO_EXTENT.width / (2 * halfFov * this.camera.aspect);
    const forHeight = LOGO_EXTENT.height / (2 * halfFov);
    this.camera.position.z = Math.max(forWidth, forHeight);
    this.camera.updateProjectionMatrix();
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const tick = (): void => {
      if (!this.running) return;
      this.frame = requestAnimationFrame(tick);
      this.update();
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  private update(): void {
    const dt = Math.min(0.05, this.clock.getDelta());
    const time = this.clock.elapsedTime;

    // Ease toward the pointer for a parallax tilt, and idle-sway when untouched.
    this.pointer.x += (this.target.x - this.pointer.x) * Math.min(1, dt * 4);
    this.pointer.y += (this.target.y - this.pointer.y) * Math.min(1, dt * 4);

    this.group.rotation.y = this.pointer.x * 0.34 + Math.sin(time * 0.5) * 0.07;
    this.group.rotation.x = this.pointer.y * 0.2 + Math.sin(time * 0.72) * 0.035;
    this.group.position.y = Math.sin(time * 0.9) * 0.1;

    // Lantern flicker, matching the in-game lamp.
    this.lantern.intensity = 46 * (0.88 + 0.12 * Math.sin(time * 9.1) * Math.sin(time * 3.3));

    this.ghost.update(time, dt, 0, Math.sin(time * 0.55) * 0.12);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.stop();
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('resize', this.resize);
    for (const item of this.disposables) item.dispose();
    this.ghost.dispose();
    this.renderer.dispose();
  }
}
