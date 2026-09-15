import * as THREE from 'three';
import { generateMaze, type Maze } from '../core/maze';
import { TrailField } from '../core/trails';
import { FlowField, hasLineOfSight } from '../core/pathfind';
import { computeVisibility } from '../core/visibility';
import { makeRng, type Rng } from '../core/rng';
import { WorldView } from '../render/world';
import { Effects } from '../render/effects';
import type { Stage } from '../render/stage';
import type { GameAudio } from '../audio/audio';
import { InputController, screenToWorld } from './input';
import { Ghost } from './entity';
import { GhostAi } from './ai';
import type { PeerEvent, PeerState } from '../net/online';
import {
  CATCH_DISTANCE,
  COLORS,
  ROUND_SECONDS,
  TILE,
  TRAIL,
  VISION,
  rollMazeLayout,
  type Difficulty,
  type MazeLayout,
  type Role,
} from './config';

export interface RoundResult {
  role: Role;
  difficulty: Difficulty;
  win: boolean;
  /** Time the round lasted: survival time for hiders, catch time for seekers. */
  timeMs: number;
  seed: number;
  pondsMelted: number;
  /** True when this was a private online match. */
  online: boolean;
  /** True when the round ended because the other player disconnected. */
  peerLeft: boolean;
}

export interface HudState {
  role: Role;
  remainingSeconds: number;
  meter: number;
  meterLabel: string;
  phase: RoundPhase;
  countdown: number;
}

export type RoundPhase = 'countdown' | 'running' | 'over';
export type AlertKind = 'splash' | 'heat' | 'danger' | 'info';

export interface GameCallbacks {
  onHud(state: HudState): void;
  onAlert(text: string, kind: AlertKind): void;
  onEnd(result: RoundResult): void;
}

export interface GameOptions {
  role: Role;
  difficulty: Difficulty;
  seed: number;
  /** Attract mode: both ghosts are driven by the AI and input is ignored. */
  autoPlay?: boolean;
  /** Online match: the rival is another player instead of the AI. */
  online?: OnlineLink | null;
  /** Name shown for the other player. */
  peerName?: string;
}

/** The slice of the online session the game itself needs. */
export interface OnlineLink {
  sendState(x: number, z: number, facing: number, moving: boolean): void;
  sendEvent(event: PeerEvent): void;
  onPeerState: ((state: PeerState) => void) | null;
  onPeerEvent: ((event: PeerEvent) => void) | null;
}

interface RemoteSample {
  t: number;
  x: number;
  z: number;
  f: number;
  m: boolean;
}

const COUNTDOWN_SECONDS = 3;
const SPLASH_COOLDOWN = 0.55;
/** How far behind live we render the other player, to smooth out jitter. */
const INTERPOLATION_DELAY = 110;
/** Network send rate for our own transform. */
const STATE_INTERVAL = 1 / 15;

/** One round of hide & seek: simulation, presentation and rules. */
export class Game {
  readonly options: GameOptions;

  private readonly stage: Stage;
  private readonly audio: GameAudio;
  private readonly input: InputController;
  private readonly callbacks: GameCallbacks;

  private readonly rng: Rng;
  private readonly layout: MazeLayout;
  private readonly maze: Maze;
  private readonly field: TrailField;
  private readonly world: WorldView;
  private readonly effects: Effects;

  private readonly player: Ghost;
  private readonly rival: Ghost;
  private readonly ai: GhostAi;
  private readonly demoAi: GhostAi | null;
  private readonly visibility: Float32Array;

  private readonly lampPos = new THREE.Vector3();
  private readonly wispPos = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3();

  private phase: RoundPhase = 'countdown';
  private countdown = COUNTDOWN_SECONDS;
  private elapsed = 0;
  private time = 0;
  private paused = false;
  private disposed = false;
  private pondsMelted = 0;
  private lastAlertAt = new Map<string, number>();
  private splashCooldown = new Map<Ghost, number>();
  private hudAccumulator = 0;
  private readonly online: OnlineLink | null;
  private readonly remoteSamples: RemoteSample[] = [];
  private stateTimer = 0;
  private peerGone = false;

  constructor(
    stage: Stage,
    audio: GameAudio,
    input: InputController,
    options: GameOptions,
    callbacks: GameCallbacks
  ) {
    this.stage = stage;
    this.audio = audio;
    this.input = input;
    this.options = options;
    this.callbacks = callbacks;

    this.rng = makeRng(options.seed);
    this.layout = rollMazeLayout(this.rng);
    this.maze = generateMaze(
      {
        width: this.layout.width,
        height: this.layout.height,
        braid: this.layout.braid,
        plazas: this.layout.plazas,
      },
      this.rng
    );
    this.field = new TrailField(this.maze);
    this.visibility = this.field.visible;
    this.world = new WorldView(stage.scene, this.maze, this.field);
    this.effects = new Effects(stage.scene);

    const hider = new Ghost('hider', this.maze);
    const seeker = new Ghost('seeker', this.maze);
    stage.scene.add(hider.rig.group, seeker.rig.group);

    this.player = options.role === 'hider' ? hider : seeker;
    this.rival = options.role === 'hider' ? seeker : hider;
    this.ai = new GhostAi(this.rival.role, this.maze, this.field, options.difficulty, this.rng);
    this.rival.speedScale = this.ai.speedScale;
    this.demoAi = options.autoPlay
      ? new GhostAi(this.player.role, this.maze, this.field, options.difficulty, this.rng)
      : null;

    this.online = options.online ?? null;
    if (this.online) {
      // Online rivals move at full speed - no AI handicap.
      this.rival.speedScale = 1;
      this.online.onPeerState = (state) => this.receivePeerState(state);
      this.online.onPeerEvent = (event) => this.receivePeerEvent(event);
    }

    this.spawnGhosts(hider, seeker);
    this.scatterPonds(hider, seeker);

    // The seeker counts to three before the hunt begins.
    seeker.frozen = true;

    this.focus.copy(this.player.position);
    this.rival.rig.setOpacity(0);
    stage.setFocus(this.focus.x, this.focus.z, true);
    this.refreshVisibility();
    this.field.updateTexels();
    this.world.update(0, this.focus, this.lampPos, this.wispPos);
    input.setEnabled(!options.autoPlay);
    if (this.demoAi) this.player.speedScale = this.demoAi.speedScale;
  }

  private spawnGhosts(hider: Ghost, seeker: Ghost): void {
    const cells = this.maze.floorCells;
    const hiderIndex = cells[Math.floor(this.rng() * cells.length)];
    const hx = hiderIndex % this.maze.width;
    const hy = (hiderIndex / this.maze.width) | 0;
    hider.placeAtCell(hx, hy);

    // Seeker starts as far away as the maze allows.
    const flow = new FlowField(this.maze);
    flow.compute(hx, hy);
    let bestCell = hiderIndex;
    let bestDistance = -1;
    for (const cellIndex of cells) {
      const x = cellIndex % this.maze.width;
      const y = (cellIndex / this.maze.width) | 0;
      const distance = flow.distanceAt(x, y);
      if (distance > bestDistance) {
        bestDistance = distance;
        bestCell = cellIndex;
      }
    }
    seeker.placeAtCell(bestCell % this.maze.width, (bestCell / this.maze.width) | 0);
  }

  private scatterPonds(hider: Ghost, seeker: Ghost): void {
    const cells = this.maze.floorCells;
    let placed = 0;
    let guard = 0;
    while (placed < this.layout.naturalPonds && guard++ < 500) {
      const cellIndex = cells[Math.floor(this.rng() * cells.length)];
      const x = cellIndex % this.maze.width;
      const y = (cellIndex / this.maze.width) | 0;
      const nearHider = Math.hypot(x - hider.cellX, y - hider.cellY) < 3;
      const nearSeeker = Math.hypot(x - seeker.cellX, y - seeker.cellY) < 3;
      if (nearHider || nearSeeker) continue;
      this.field.addPond(x, y);
      placed++;
    }
  }

  setPaused(value: boolean): void {
    this.paused = value;
    this.input.setEnabled(!value && !this.options.autoPlay && this.phase !== 'over');
  }

  get isOver(): boolean {
    return this.phase === 'over';
  }

  /** Snapshot used by the `?debug=1` harness and for troubleshooting. */
  get debugInfo(): Record<string, unknown> {
    let ponds = 0;
    for (let i = 0; i < this.field.pond.length; i++) ponds += this.field.pond[i];
    return {
      phase: this.phase,
      elapsed: this.elapsed,
      remaining: Math.max(0, ROUND_SECONDS - this.elapsed),
      role: this.player.role,
      playerCell: [this.player.cellX, this.player.cellY],
      rivalCell: [this.rival.cellX, this.rival.cellY],
      tilesApart: Math.hypot(this.rival.cellX - this.player.cellX, this.rival.cellY - this.player.cellY),
      heatHere: this.field.heatAt(this.player.cellX, this.player.cellY),
      coldHere: this.field.coldAt(this.player.cellX, this.player.cellY),
      ponds,
      pondsMelted: this.pondsMelted,
      aiState: this.ai.debug.state,
    };
  }

  update(dt: number): void {
    if (this.disposed) return;
    const step = Math.min(dt, 0.05);
    this.time += step;

    if (!this.paused && this.phase !== 'over') {
      this.advance(step);
    }

    const playerFootfall = this.player.animate(this.time, step);
    const rivalFootfall = this.rival.animate(this.time, step);
    if (!this.paused && this.phase !== 'over') {
      if (playerFootfall) this.onFootstep(this.player);
      if (rivalFootfall) this.onFootstep(this.rival);
    }

    this.updateLights();
    this.stage.update(step);
    this.effects.update(step, this.focus.x, this.focus.z);
    this.world.update(this.time, this.focus, this.lampPos, this.wispPos);
    this.stage.render();
  }

  private advance(dt: number): void {
    // ---- phase ----------------------------------------------------------
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'running';
        const seeker = this.player.role === 'seeker' ? this.player : this.rival;
        seeker.frozen = false;
        this.callbacks.onAlert('The hunt begins!', 'info');
        this.audio.blip(true);
      }
    } else {
      this.elapsed += dt;
    }

    // ---- movement -------------------------------------------------------
    const [pdx, pdz] = this.demoAi
      ? this.demoAi.update(dt, this.player, this.rival)
      : screenToWorld(this.input.axis.x, this.input.axis.y);
    const playerMoved = this.player.step(pdx, pdz, dt);

    let rivalMoved: boolean;
    if (this.online) {
      // The other player owns their ghost; we just replay their packets.
      rivalMoved = this.applyRemoteRival(dt);
      this.publishState(dt, playerMoved);
    } else {
      const [adx, adz] = this.ai.update(dt, this.rival, this.player);
      rivalMoved = this.rival.step(adx, adz, dt);
    }

    // ---- trails ---------------------------------------------------------
    this.depositTrail(this.player, dt);
    this.depositTrail(this.rival, dt);
    this.field.decay(dt);

    // ---- ponds ----------------------------------------------------------
    this.updatePonds(this.player, dt, playerMoved, true);
    this.updatePonds(this.rival, dt, rivalMoved, false);

    // ---- senses ---------------------------------------------------------
    this.refreshVisibility();
    const rivalSeen = this.rivalVisibility();
    this.rival.rig.setOpacity(rivalSeen);

    const distance = this.player.position.distanceTo(this.rival.position);
    const tiles = distance / TILE;
    this.updateAmbientCues(dt, tiles, rivalSeen);

    // ---- camera ---------------------------------------------------------
    this.focus.lerp(this.player.position, Math.min(1, dt * 9));
    this.stage.setFocus(this.focus.x, this.focus.z);

    // ---- end conditions -------------------------------------------------
    if (this.phase === 'running') {
      // Online, only the seeker's client is allowed to call a catch.
      const canCallCatch = !this.online || this.player.role === 'seeker';
      if (distance <= CATCH_DISTANCE && canCallCatch) {
        if (this.online) this.online.sendEvent({ e: 'caught', t: Math.round(this.elapsed * 1000) });
        this.finish(this.player.role === 'seeker');
        return;
      }
      if (this.elapsed >= ROUND_SECONDS) {
        if (this.online) this.online.sendEvent({ e: 'timeup', t: Math.round(this.elapsed * 1000) });
        this.finish(this.player.role === 'hider');
        return;
      }
    }

    this.publishHud(dt);
  }

  /** A footfall stamps a brighter mark, so trails read as a line of steps. */
  private onFootstep(ghost: Ghost): void {
    const [wx, wz] = this.maze.cellToWorld(ghost.cellX, ghost.cellY, TILE);
    const fx = (ghost.position.x - wx) / TILE;
    const fy = (ghost.position.z - wz) / TILE;
    const kind = ghost.role === 'seeker' ? 'heat' : 'cold';
    this.field.deposit(kind, ghost.cellX, ghost.cellY, fx, fy, kind === 'heat' ? 0.2 : 0.16);
    this.audio.step(ghost.position.x, ghost.position.z, ghost.role === 'seeker');
  }

  // ------------------------------------------------------------- networking
  private receivePeerState(state: PeerState): void {
    // Timestamped on arrival: no cross-machine clock sync needed.
    this.remoteSamples.push({ t: performance.now(), x: state.x, z: state.z, f: state.f, m: state.m });
    if (this.remoteSamples.length > 8) this.remoteSamples.shift();
  }

  private receivePeerEvent(event: PeerEvent): void {
    if (this.phase === 'over') return;

    switch (event.e) {
      case 'splash':
        this.audio.splash(event.x, event.z, 1);
        this.effects.splash(event.x, event.z, this.rival.role === 'seeker' ? COLORS.warm : COLORS.cold);
        this.announceRemoteSplash(event.x, event.z);
        break;
      case 'pond':
        this.field.addPond(event.cx, event.cy);
        break;
      case 'caught':
        // The seeker called it: whoever is hiding has just lost.
        this.finish(this.player.role === 'seeker');
        break;
      case 'timeup':
        this.finish(this.player.role === 'hider');
        break;
      default:
        break;
    }
  }

  /** The other player quit: award the round to whoever is still here. */
  handlePeerLeft(): void {
    if (this.phase === 'over' || !this.online) return;
    this.peerGone = true;
    this.callbacks.onAlert('Your friend left the maze.', 'info');
    this.finish(true);
  }

  /** Plays the rival back from the packet buffer, slightly behind live. */
  private applyRemoteRival(dt: number): boolean {
    const samples = this.remoteSamples;
    if (samples.length === 0) return false;

    const renderAt = performance.now() - INTERPOLATION_DELAY;
    const newest = samples[samples.length - 1];

    let x = newest.x;
    let z = newest.z;
    let f = newest.f;
    let moving = newest.m;

    if (renderAt <= newest.t) {
      for (let i = samples.length - 1; i > 0; i--) {
        const after = samples[i];
        const before = samples[i - 1];
        if (renderAt >= before.t && renderAt <= after.t) {
          const span = Math.max(1, after.t - before.t);
          const k = (renderAt - before.t) / span;
          x = before.x + (after.x - before.x) * k;
          z = before.z + (after.z - before.z) * k;
          f = before.f + shortestTurn(before.f, after.f) * k;
          moving = after.m || before.m;
          break;
        }
      }
    } else if (performance.now() - newest.t > 800) {
      // Nothing for a while: park them rather than sliding off.
      moving = false;
    }

    this.rival.applyRemote(x, z, f, moving, dt);
    return moving;
  }

  private publishState(dt: number, moving: boolean): void {
    if (!this.online) return;
    this.stateTimer -= dt;
    if (this.stateTimer > 0) return;
    this.stateTimer = STATE_INTERVAL;
    this.online.sendState(this.player.position.x, this.player.position.z, this.player.facing, moving);
  }

  private announceRemoteSplash(x: number, z: number): void {
    const dx = x - this.player.position.x;
    const dz = z - this.player.position.z;
    const tiles = Math.hypot(dx, dz) / TILE;
    if (tiles > 22) return;
    this.effects.ping(x, z, this.rival.role === 'seeker' ? COLORS.warm : COLORS.cold);
    const how = tiles < 7 ? 'Close splash' : 'Distant splash';
    this.callbacks.onAlert(`${how} to the ${compassLabel(dx, dz)}`, 'splash');
  }

  private depositTrail(ghost: Ghost, dt: number): void {    const [wx, wz] = this.maze.cellToWorld(ghost.cellX, ghost.cellY, TILE);
    const fx = (ghost.position.x - wx) / TILE;
    const fy = (ghost.position.z - wz) / TILE;
    const kind = ghost.role === 'seeker' ? 'heat' : 'cold';
    const gain = ghost.role === 'seeker' ? TRAIL.heatGain : TRAIL.coldGain;
    // Standing still concentrates the mark; running smears it thin.
    const intensity = ghost.moving ? 1 : 1.5;
    this.field.deposit(kind, ghost.cellX, ghost.cellY, fx, fy, gain * intensity * dt);
  }

  private updatePonds(ghost: Ghost, dt: number, moved: boolean, isPlayer: boolean): void {
    // Online, each client owns its own splashes and melt ponds; the rival's
    // arrive as events so the two sides never double-trigger them.
    const ownsGhost = isPlayer || !this.online;

    // Splash when crossing water.
    const cooldown = (this.splashCooldown.get(ghost) ?? 0) - dt;
    if (ownsGhost && moved && this.field.isPond(ghost.cellX, ghost.cellY) && cooldown <= 0) {
      this.splashCooldown.set(ghost, SPLASH_COOLDOWN);
      this.onSplash(ghost, isPlayer);
    } else {
      this.splashCooldown.set(ghost, Math.max(0, cooldown));
    }

    // Only the cold ghost melts new ponds.
    if (ghost.role !== 'hider' || !ownsGhost) return;
    const melted = this.field.accumulateDwell(ghost.cellX, ghost.cellY, dt, moved);
    if (!melted) return;

    this.pondsMelted++;
    this.audio.melt(ghost.position.x, ghost.position.z);
    this.effects.splash(ghost.position.x, ghost.position.z, COLORS.cold);
    this.online?.sendEvent({ e: 'pond', cx: ghost.cellX, cy: ghost.cellY });
    if (isPlayer) {
      this.callbacks.onAlert('Your chill melted a permanent pond here.', 'splash');
    }
  }

  private onSplash(ghost: Ghost, isPlayer: boolean): void {
    const color = ghost.role === 'seeker' ? COLORS.warm : COLORS.cold;
    this.audio.splash(ghost.position.x, ghost.position.z, 1);
    this.effects.splash(ghost.position.x, ghost.position.z, color);

    if (isPlayer) {
      if (this.online) {
        this.online.sendEvent({ e: 'splash', x: ghost.position.x, z: ghost.position.z });
        this.alertOnce('own-splash', 'Splash! That noise carried…', 'splash', 4);
        return;
      }
      // The rival may hear it and come running.
      const heard = this.ai.hear(ghost.cellX, ghost.cellY, this.rival.cellX, this.rival.cellY);
      if (heard) this.alertOnce('own-splash', 'Splash! That noise carried…', 'splash', 4);
      return;
    }

    this.announceRemoteSplash(ghost.position.x, ghost.position.z);
  }

  private refreshVisibility(): void {
    const radius = this.player.role === 'seeker' ? VISION.seeker : VISION.hider;
    computeVisibility(this.maze, this.player.cellX, this.player.cellY, radius, this.visibility);
  }

  /** How clearly the player can make out the rival right now (0..1). */
  private rivalVisibility(): number {
    const index = this.maze.index(this.rival.cellX, this.rival.cellY);
    const lit = this.maze.inBounds(this.rival.cellX, this.rival.cellY) ? this.visibility[index] : 0;
    const tiles = Math.hypot(this.rival.cellX - this.player.cellX, this.rival.cellY - this.player.cellY);

    let value = lit > 0.02 ? Math.min(1, 0.35 + lit * 1.4) : 0;

    // A lantern is hard to miss, even down a long alley.
    if (this.rival.role === 'seeker' && tiles < 17) {
      if (hasLineOfSight(this.maze, this.player.cellX, this.player.cellY, this.rival.cellX, this.rival.cellY)) {
        value = Math.max(value, 1 - tiles / 20);
      }
    } else if (this.rival.role === 'hider' && tiles < 8) {
      if (hasLineOfSight(this.maze, this.player.cellX, this.player.cellY, this.rival.cellX, this.rival.cellY)) {
        value = Math.max(value, 0.75 - tiles / 12);
      }
    }

    return Math.max(0, Math.min(1, value));
  }

  private updateAmbientCues(dt: number, tiles: number, rivalSeen: number): void {
    const heatHere = this.field.heatAt(this.player.cellX, this.player.cellY);
    const coldHere = this.field.coldAt(this.player.cellX, this.player.cellY);

    if (this.player.role === 'hider') {
      if (heatHere > 0.42) {
        this.alertOnce('hot-ground', 'These stones are still hot — the lantern came through.', 'heat', 6);
      }
      if (rivalSeen > 0.25 && tiles < 7) {
        this.alertOnce('lantern-close', 'The lantern is closing in!', 'danger', 3);
      }
      const danger = rivalSeen > 0.2 ? Math.max(0, 1 - tiles / 9) : Math.max(0, 1 - tiles / 5) * 0.6;
      this.audio.setTension(danger);
      this.audio.updateHeartbeat(dt, danger, this.player.position.x, this.player.position.z);
    } else {
      if (coldHere > 0.45) {
        this.alertOnce('frost-fresh', 'Fresh frost! They passed here moments ago.', 'heat', 5);
      }
      if (rivalSeen > 0.3 && tiles < 8) {
        this.alertOnce('spotted', 'There they are — chase!', 'danger', 3);
      }
      this.audio.setTension(Math.max(0, 1 - tiles / 12) * 0.7);
    }
  }

  private alertOnce(key: string, text: string, kind: AlertKind, cooldown: number): void {
    const last = this.lastAlertAt.get(key) ?? -999;
    if (this.time - last < cooldown) return;
    this.lastAlertAt.set(key, this.time);
    this.callbacks.onAlert(text, kind);
  }

  private updateLights(): void {
    const hider = this.player.role === 'hider' ? this.player : this.rival;
    const seeker = this.player.role === 'seeker' ? this.player : this.rival;
    seeker.rig.lightWorldPosition(this.lampPos);
    hider.rig.lightWorldPosition(this.wispPos);

    this.stage.camera.getWorldDirection(this.cameraForward);
    this.audio.setListener(
      [this.player.position.x, 1, this.player.position.z],
      [this.cameraForward.x, 0, this.cameraForward.z]
    );
  }

  private publishHud(dt: number): void {
    this.hudAccumulator += dt;
    if (this.hudAccumulator < 0.08) return;
    this.hudAccumulator = 0;

    let meter = 0;
    let meterLabel = '';
    if (this.player.role === 'hider') {
      meter = this.field.dwellRatio(this.player.cellX, this.player.cellY);
      meterLabel = meter > 0.6 ? 'Melting a pond!' : 'Chill building';
    } else {
      const mark = this.field.strongestWithin('cold', this.player.cellX, this.player.cellY, 4.5, 0.02);
      meter = mark ? Math.min(1, mark.value / TRAIL.pondThreshold) : 0;
      meterLabel = meter > 0.5 ? 'Frost scent — strong' : 'Frost scent';
    }

    this.callbacks.onHud({
      role: this.player.role,
      remainingSeconds: Math.max(0, ROUND_SECONDS - this.elapsed),
      meter,
      meterLabel,
      phase: this.phase,
      countdown: Math.max(0, Math.ceil(this.countdown)),
    });
  }

  private finish(win: boolean): void {
    this.phase = 'over';
    this.player.frozen = true;
    this.rival.frozen = true;
    this.input.setEnabled(false);
    this.audio.setTension(0);
    this.audio.stinger(win);
    this.stage.shake(win ? 0.25 : 0.6);
    this.rival.rig.setOpacity(1);

    if (win) {
      // Confetti in the alley plus a little victory dance.
      const colour = this.player.role === 'seeker' ? COLORS.warm : COLORS.cold;
      this.player.rig.setCelebrating(true);
      this.effects.fireworks(this.player.position.x, this.player.position.z, colour);
      this.stage.setFocus(this.player.position.x, this.player.position.z);
    } else {
      this.effects.splash(this.rival.position.x, this.rival.position.z, COLORS.coldDeep);
    }

    this.callbacks.onEnd({
      role: this.player.role,
      difficulty: this.options.difficulty,
      win,
      timeMs: Math.round(this.elapsed * 1000),
      seed: this.options.seed,
      pondsMelted: this.pondsMelted,
      online: this.online !== null,
      peerLeft: this.peerGone,
    });
  }

  /** Test hook for the `?debug=1` harness: ends the round immediately. */
  forceFinish(win: boolean): void {
    if (this.phase !== 'over') this.finish(win);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.online) {
      this.online.onPeerState = null;
      this.online.onPeerEvent = null;
    }
    this.input.setEnabled(false);
    this.effects.dispose();
    this.stage.scene.remove(this.player.rig.group, this.rival.rig.group);
    this.player.dispose();
    this.rival.dispose();
    this.world.dispose();
  }
}

/** Shortest signed angular distance, so remote ghosts never spin the long way. */
function shortestTurn(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

/** Screen-relative compass so "north" always means "up the screen". */
function compassLabel(dx: number, dz: number): string {  const sx = Math.SQRT1_2 * (dx - dz);
  const sy = -Math.SQRT1_2 * (dx + dz);
  const angle = (Math.atan2(sx, sy) * 180) / Math.PI;
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const index = Math.round(((angle + 360) % 360) / 45) % 8;
  return names[index];
}
