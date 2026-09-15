import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const VIEW_HEIGHT = 34;

/** Renderer, angled orthographic camera and optional bloom. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;

  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  /** Classic 3/4 view: high enough to read the maze, angled enough to stay 3D. */
  private readonly offset = new THREE.Vector3(1, 1.75, 1).normalize().multiplyScalar(80);
  private readonly focus = new THREE.Vector3();
  private readonly desiredFocus = new THREE.Vector3();
  private shakeTime = 0;
  private shakeStrength = 0;

  constructor(canvas: HTMLCanvasElement, useBloom: boolean) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene.background = new THREE.Color(0x030306);
    // No scene fog: the orthographic camera sits far outside the maze, and the
    // fog-of-war in the terrain shader already handles distance falloff.

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 220);
    this.camera.position.copy(this.offset);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(this.camera);

    this.scene.add(new THREE.AmbientLight(0x2a3350, 0.35));
    const moon = new THREE.DirectionalLight(0x4f6ea8, 0.16);
    moon.position.set(-8, 14, -6);
    this.scene.add(moon);

    if (useBloom) this.setupComposer();
    this.resize();
  }

  private setupComposer(): void {
    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(size, 0.26, 0.75, 0.85);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  setFocus(x: number, z: number, instant = false): void {
    this.desiredFocus.set(x, 0, z);
    if (instant) {
      this.focus.copy(this.desiredFocus);
      this.applyCamera();
    }
  }

  shake(strength: number): void {
    this.shakeStrength = Math.max(this.shakeStrength, strength);
    this.shakeTime = 0;
  }

  private applyCamera(): void {
    this.camera.position.copy(this.focus).add(this.offset);
    this.camera.lookAt(this.focus);
  }

  update(dt: number): void {
    this.focus.lerp(this.desiredFocus, Math.min(1, dt * 6.5));
    this.applyCamera();

    if (this.shakeStrength > 0.001) {
      this.shakeTime += dt;
      const decay = Math.exp(-this.shakeTime * 6);
      const amount = this.shakeStrength * decay;
      this.camera.position.x += Math.sin(this.shakeTime * 47) * amount;
      this.camera.position.y += Math.cos(this.shakeTime * 39) * amount;
      if (decay < 0.02) this.shakeStrength = 0;
    }
  }

  resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const aspect = width / Math.max(1, height);
    const halfH = VIEW_HEIGHT / 2;
    const halfW = halfH * aspect;

    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(width, height, false);
    this.composer?.setSize(width, height);
  }

  render(): void {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /** Screen-space radius (in world units) used by the wall dissolve. */
  get viewHeight(): number {
    return VIEW_HEIGHT;
  }

  dispose(): void {
    this.composer?.dispose();
    this.renderer.dispose();
  }
}

export function shouldUseBloom(): boolean {
  const lowPower =
    (navigator.hardwareConcurrency ?? 4) <= 4 ||
    window.matchMedia('(pointer: coarse)').matches;
  return !lowPower;
}
