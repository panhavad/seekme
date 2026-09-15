import * as THREE from 'three';
import type { EmoteDefinition } from '../game/config';

const SIZE = 256;

/**
 * A speech bubble that pops up over a ghost's head. Drawn into a canvas at
 * runtime (no image assets) and billboarded, so it always faces the camera.
 */
export class EmoteBubble {
  private readonly sprite: THREE.Sprite;
  private readonly material: THREE.SpriteMaterial;
  private readonly texture: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private life = 0;
  private duration = 0;
  private visibility = 1;

  constructor(scene: THREE.Scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      opacity: 0,
    });

    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.setScalar(2.2);
    this.sprite.visible = false;
    this.sprite.renderOrder = 6;
    scene.add(this.sprite);
  }

  play(emote: EmoteDefinition, duration = 2.8): void {
    this.draw(emote);
    this.texture.needsUpdate = true;
    this.life = duration;
    this.duration = duration;
    this.sprite.visible = true;
  }

  /** Hides the bubble when the emoting ghost is not visible to us. */
  setVisibility(value: number): void {
    this.visibility = value;
  }

  update(dt: number, x: number, z: number): void {
    if (this.life <= 0) {
      if (this.sprite.visible) this.sprite.visible = false;
      return;
    }

    this.life -= dt;
    const age = this.duration - this.life;

    // Springy pop-in: overshoot, settle, wobble, then float away.
    const pop =
      age < 0.4
        ? 1 + Math.sin(Math.min(1, age / 0.4) * Math.PI) * 0.55 * Math.cos(age * 26)
        : 1 + Math.sin(age * 5.5) * 0.05;
    const fade = Math.min(1, this.life / 0.6);
    const rise = Math.min(0.7, age * 0.62);
    const sway = Math.sin(age * 4.2) * 0.12;

    this.sprite.position.set(x + sway * 0.18, 2.6 + rise, z);
    this.sprite.scale.setScalar(2.5 * Math.max(0.25, pop));
    this.material.opacity = fade * this.visibility;
    this.material.rotation = sway * 0.35;
    this.sprite.visible = this.material.opacity > 0.02;
  }

  private draw(emote: EmoteDefinition): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, SIZE, SIZE);

    // bubble
    const radius = 46;
    const x = 24;
    const y = 18;
    const w = SIZE - 48;
    const h = 170;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = 22;
    ctx.fillStyle = 'rgba(20, 20, 28, 0.92)';
    roundedRect(ctx, x, y, w, h, radius);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = emote.colour;
    ctx.lineWidth = 5;
    roundedRect(ctx, x, y, w, h, radius);
    ctx.stroke();

    // little tail pointing down at the ghost
    ctx.beginPath();
    ctx.moveTo(SIZE / 2 - 22, y + h - 2);
    ctx.lineTo(SIZE / 2, y + h + 44);
    ctx.lineTo(SIZE / 2 + 22, y + h - 2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(20, 20, 28, 0.92)';
    ctx.fill();
    ctx.strokeStyle = emote.colour;
    ctx.lineWidth = 5;
    ctx.stroke();

    ctx.font = '104px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emote.glyph, SIZE / 2, y + h / 2 + 4);
  }

  dispose(): void {
    this.sprite.removeFromParent();
    this.texture.dispose();
    this.material.dispose();
  }
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
