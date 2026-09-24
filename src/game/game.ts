import * as THREE from 'three';
import { generateMaze, type Maze } from '../core/maze';
import { TrailField } from '../core/trails';
import { FlowField, hasLineOfSight } from '../core/pathfind';
import { computeVisibility } from '../core/visibility';
import { makeRng, type Rng } from '../core/rng';
import { WorldView } from '../render/world';
import { Effects } from '../render/effects';
import type { Stage } from '../render/stage';
import { getTheme, type ThemeKey } from '../render/themes';
import type { GameAudio } from '../audio/audio';
import { InputController, screenToWorld } from './input';
import { Ghost } from './entity';
import { GhostAi } from './ai';
import type { PeerEvent, PeerState } from '../net/online';
import {
  CATCH_DISTANCE,
  COLORS,
  COUPLE_ROUND_SECONDS,
  LOVE_PING,
  REUNION_DISTANCE,
  ROUND_SECONDS,
  SPEED,
  TILE,
  TRAIL,
  VISION,
  WALL_SKIP,
  findEmote,
  rollMazeLayout,
  type Difficulty,
  type EmoteKey,
  type GameMode,
  type MazeLayout,
  type Role,
} from './config';
import { EmoteBubble } from '../render/emote';
import type { MinimapView } from '../ui/minimap';

export interface RoundResult {
  role: Role;
  difficulty: Difficulty;
  /** Which set of rules this round was played under. */
  mode: GameMode;
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
  mode: GameMode;
  remainingSeconds: number;
  meter: number;
  meterLabel: string;
  phase: RoundPhase;
  countdown: number;
  /** Wall-skip / love-ping charge: 0..1, plus the seconds still to wait. */
  skillCharge: number;
  skillReady: boolean;
  skillSecondsLeft: number;
  /** True while walking is speeding the recharge up (classic only). */
  skillCharging: boolean;
}

export type RoundPhase = 'countdown' | 'running' | 'over';
export type AlertKind = 'splash' | 'heat' | 'danger' | 'info';

export interface GameCallbacks {
  onHud(state: HudState): void;
  onAlert(text: string, kind: AlertKind): void;
  onEnd(result: RoundResult): void;
  /** Fired when the leader pauses or resumes an online match. */
  onRemotePause?(paused: boolean): void;
  /** Fired whenever a ghost plays an emote, for the on-screen reaction. */
  onEmote?(glyph: string, who: string, colour: string, mine: boolean): void;
}

export interface GameOptions {
  role: Role;
  difficulty: Difficulty;
  seed: number;
  /** Which rules to play by. Defaults to the original chase. */
  mode?: GameMode;
  /** Attract mode: both ghosts are driven by the AI and input is ignored. */
  autoPlay?: boolean;
  /** Online match: the rival is another player instead of the AI. */
  online?: OnlineLink | null;
  /** Name shown for the other player. */
  peerName?: string;
  /** The leader owns pausing and the authoritative round clock. */
  isLeader?: boolean;
  /** Our own display name, used in emote call-outs. */
  playerName?: string;
  /** Which dressing the maze wears. Defaults to the original temple. */
  theme?: ThemeKey;
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
  /** Which rulebook this round follows. */
  readonly mode: GameMode;

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
  private readonly isLeader: boolean;
  private readonly peerName: string;
  private readonly playerBubble: EmoteBubble;
  private readonly rivalBubble: EmoteBubble;
  private emoteCooldown = 0;
  private clockTimer = 0;
  private remotePause = false;
  /** Seconds left before the wall skip can be used again. */
  private skillCooldown = 0;
  /** Seconds of unbroken walking, which speeds the recharge up. */
  private walkStreak = 0;
  private skillRecharging = false;
  /** Couple mode: seconds left before the love ping can be called again. */
  private pingCooldown = 0;
  /** Couple mode: the last call we heard, fading off the compass and dial. */
  private partnerPing: { x: number; z: number; life: number } | null = null;
  /** Couple mode, offline: seconds until the AI sweetheart calls back. */
  private aiPingTimer = 0;
  /** Latest rival visibility (0..1), shared with the HUD minimap. */
  private lastRivalSeen = 0;
  /** The theme's tint for remembered ground, mirrored on the minimap. */
  private readonly memoryTint: [number, number, number];

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
    this.mode = options.mode ?? 'classic';
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
    // The theme only dresses the maze: same layout, same rules, new scenery.
    const theme = getTheme(options.theme);
    this.memoryTint = theme.memoryTint;
    stage.setTheme(theme);
    this.world = new WorldView(stage.scene, this.maze, this.field, theme);
    this.effects = new Effects(stage.scene, theme);

    const hider = new Ghost('hider', this.maze);
    const seeker = new Ghost('seeker', this.maze);
    stage.scene.add(hider.rig.group, seeker.rig.group);

    this.player = options.role === 'hider' ? hider : seeker;
    this.rival = options.role === 'hider' ? seeker : hider;
    if (this.mode === 'couple') {
      // Sweethearts are evenly matched: neither can simply out-run the other.
      hider.speedOverride = SPEED.couple;
      seeker.speedOverride = SPEED.couple;
    }
    // In couple mode the rival is searching for us too, so it wears the
    // searching brain whichever ghost it happens to be.
    const rivalBrain: Role = this.mode === 'couple' ? 'seeker' : this.rival.role;
    this.ai = new GhostAi(
      this.rival.role,
      this.maze,
      this.field,
      options.difficulty,
      this.rng,
      rivalBrain
    );
    this.rival.speedScale = this.ai.speedScale;
    this.demoAi = options.autoPlay
      ? new GhostAi(
          this.player.role,
          this.maze,
          this.field,
          options.difficulty,
          this.rng,
          this.mode === 'couple' ? 'seeker' : this.player.role
        )
      : null;

    this.online = options.online ?? null;
    this.isLeader = options.isLeader ?? true;
    this.peerName = options.peerName ?? (this.mode === 'couple' ? 'Your sweetheart' : 'Your rival');
    this.playerBubble = new EmoteBubble(stage.scene);
    this.rivalBubble = new EmoteBubble(stage.scene);
    if (this.online) {
      // Online rivals move at full speed - no AI handicap.
      this.rival.speedScale = 1;
      this.online.onPeerState = (state) => this.receivePeerState(state);
      this.online.onPeerEvent = (event) => this.receivePeerEvent(event);
    }

    this.spawnGhosts(hider, seeker);
    this.scatterPonds(hider, seeker);

    if (this.mode === 'couple') {
      // Nobody hunts anybody: both halves wait out the countdown together.
      hider.frozen = true;
      seeker.frozen = true;
      this.aiPingTimer = LOVE_PING.aiCallSeconds * 0.5;
    } else {
      // The seeker counts to three before the hunt begins.
      seeker.frozen = true;
    }

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

  /**
   * Pausing is leader-authoritative online: the leader pauses both sides, and a
   * guest's request is forwarded so the leader can honour it.
   */
  setPaused(value: boolean): void {
    if (this.online && !this.isLeader) {
      // Guests never change the pause state themselves: they ask, then mirror
      // whatever the leader broadcasts. That keeps both clocks identical.
      if (value) this.online.sendEvent({ e: 'pauseRequest' });
      return;
    }
    this.applyPaused(value);
    if (this.online && this.isLeader) {
      this.online.sendEvent({ e: 'pause', paused: value, t: Math.round(this.elapsed * 1000) });
    }
  }

  private applyPaused(value: boolean): void {
    this.paused = value;
    this.input.setEnabled(!value && !this.options.autoPlay && this.phase !== 'over');
  }

  /** True while the round is paused by the other player. */
  get pausedByPeer(): boolean {
    return this.remotePause;
  }

  get isOver(): boolean {
    return this.phase === 'over';
  }

  /** How long this round lasts - couple mode gets a little longer. */
  get roundSeconds(): number {
    return this.mode === 'couple' ? COUPLE_ROUND_SECONDS : ROUND_SECONDS;
  }

  /** Snapshot used by the `?debug=1` harness and for troubleshooting. */
  get debugInfo(): Record<string, unknown> {
    let ponds = 0;
    for (let i = 0; i < this.field.pond.length; i++) ponds += this.field.pond[i];
    return {
      phase: this.phase,
      mode: this.mode,
      elapsed: this.elapsed,
      remaining: Math.max(0, this.roundSeconds - this.elapsed),
      role: this.player.role,
      playerCell: [this.player.cellX, this.player.cellY],
      rivalCell: [this.rival.cellX, this.rival.cellY],
      tilesApart: Math.hypot(this.rival.cellX - this.player.cellX, this.rival.cellY - this.player.cellY),
      heatHere: this.field.heatAt(this.player.cellX, this.player.cellY),
      coldHere: this.field.coldAt(this.player.cellX, this.player.cellY),
      ponds,
      pondsMelted: this.pondsMelted,
      skillCooldown: this.mode === 'couple' ? this.pingCooldown : this.skillCooldown,
      walkStreak: this.walkStreak,
      skipTarget: this.findSkipTarget(),
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
    this.playerBubble.update(step, this.player.position.x, this.player.position.z);
    this.rivalBubble.update(step, this.rival.position.x, this.rival.position.z);
    this.world.update(this.time, this.focus, this.lampPos, this.wispPos);
    this.stage.render();
  }

  private advance(dt: number): void {
    // ---- phase ----------------------------------------------------------
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'running';
        if (this.mode === 'couple') {
          this.player.frozen = false;
          this.rival.frozen = false;
          this.callbacks.onAlert('💗 Go find each other!', 'info');
        } else {
          const seeker = this.player.role === 'seeker' ? this.player : this.rival;
          seeker.frozen = false;
          this.callbacks.onAlert('The hunt begins!', 'info');
        }
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

    // ---- skill ----------------------------------------------------------
    if (this.mode === 'couple') this.updatePing(dt);
    else this.rechargeSkill(dt, playerMoved);

    // ---- ponds ----------------------------------------------------------
    this.updatePonds(this.player, dt, playerMoved, true);
    this.updatePonds(this.rival, dt, rivalMoved, false);

    // ---- senses ---------------------------------------------------------
    this.refreshVisibility();
    const rivalSeen = this.rivalVisibility();
    this.lastRivalSeen = rivalSeen;
    this.rival.rig.setOpacity(rivalSeen);
    // A bubble over the rival only shows when we can actually see them.
    this.rivalBubble.setVisibility(Math.max(rivalSeen, 0.15));
    this.emoteCooldown = Math.max(0, this.emoteCooldown - dt);

    // The leader keeps both clocks honest.
    if (this.online && this.isLeader && this.phase === 'running') {
      this.clockTimer -= dt;
      if (this.clockTimer <= 0) {
        this.clockTimer = 2;
        this.online.sendEvent({ e: 'clock', t: Math.round(this.elapsed * 1000) });
      }
    }

    const distance = this.player.position.distanceTo(this.rival.position);
    const tiles = distance / TILE;
    this.updateAmbientCues(dt, tiles, rivalSeen);

    // ---- camera ---------------------------------------------------------
    this.focus.lerp(this.player.position, Math.min(1, dt * 9));
    this.stage.setFocus(this.focus.x, this.focus.z);

    // ---- end conditions -------------------------------------------------
    if (this.phase === 'running') {
      if (this.mode === 'couple') {
        // A reunion is good news for both sides, so either client may call it;
        // whoever hears the event second is already over and ignores it.
        if (distance <= REUNION_DISTANCE) {
          if (this.online) this.online.sendEvent({ e: 'reunion', t: Math.round(this.elapsed * 1000) });
          this.finish(true);
          return;
        }
        if (this.elapsed >= this.roundSeconds) {
          if (this.online) this.online.sendEvent({ e: 'timeup', t: Math.round(this.elapsed * 1000) });
          this.finish(false);
          return;
        }
        this.publishHud(dt);
        return;
      }

      // Online, only the seeker's client is allowed to call a catch.
      const canCallCatch = !this.online || this.player.role === 'seeker';
      if (distance <= CATCH_DISTANCE && canCallCatch) {
        if (this.online) this.online.sendEvent({ e: 'caught', t: Math.round(this.elapsed * 1000) });
        this.finish(this.player.role === 'seeker');
        return;
      }
      if (this.elapsed >= this.roundSeconds) {
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
    if (event.e === 'pause') {
      // The leader is in charge of the clock as well as the pause state.
      this.remotePause = event.paused;
      this.elapsed = event.t / 1000;
      this.applyPaused(event.paused);
      this.callbacks.onRemotePause?.(event.paused);
      this.callbacks.onAlert(
        event.paused ? `${this.peerName} paused the game.` : `${this.peerName} resumed the game.`,
        'info'
      );
      return;
    }

    if (event.e === 'pauseRequest') {
      // Only the leader acts on this: it pauses both sides and tells its own UI,
      // which would otherwise never learn about a pause it did not initiate.
      if (this.isLeader && !this.paused) {
        this.setPaused(true);
        this.callbacks.onRemotePause?.(true);
        this.callbacks.onAlert(`${this.peerName} asked to pause.`, 'info');
      }
      return;
    }

    if (event.e === 'clock') {
      this.syncClock(event.t / 1000);
      return;
    }

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
      case 'emote':
        this.showEmote(event.k, false);
        break;
      case 'skip':
        this.receivePeerSkip(event.x, event.z, event.fx, event.fz);
        break;
      case 'lovePing':
        this.receiveLovePing(event.x, event.z);
        break;
      case 'reunion':
        this.finish(true);
        break;
      case 'caught':
        // The seeker called it: whoever is hiding has just lost.
        this.finish(this.player.role === 'seeker');
        break;
      case 'timeup':
        // Couple mode has no winner when the clock beats them.
        this.finish(this.mode === 'couple' ? false : this.player.role === 'hider');
        break;
      default:
        break;
    }
  }

  /** Nudges our round clock toward the leader's without visible jumps. */  private syncClock(leaderElapsed: number): void {
    const drift = leaderElapsed - this.elapsed;
    if (Math.abs(drift) > 1.5) this.elapsed = leaderElapsed;
    else this.elapsed += drift * 0.25;
  }

  /** The other player skipped a wall: snap them over instead of sliding. */
  private receivePeerSkip(x: number, z: number, fromX: number, fromZ: number): void {
    this.remoteSamples.length = 0;
    this.rival.applyRemote(x, z, this.rival.facing, false, 0);

    const colour = this.rival.role === 'seeker' ? COLORS.warm : COLORS.cold;
    this.effects.ping(fromX, fromZ, colour);
    this.effects.splash(x, z, colour);

    const tiles = Math.hypot(x - this.player.position.x, z - this.player.position.z) / TILE;
    if (tiles < 14) {
      this.audio.melt(x, z);
      this.callbacks.onAlert(`${this.peerName} slipped through a wall nearby!`, 'danger');
    }
  }

  /** Plays an emote for one of the ghosts and tells the HUD about it. */
  showEmote(key: string, mine: boolean): void {
    const emote = findEmote(key);
    if (!emote) return;

    const ghost = mine ? this.player : this.rival;
    const bubble = mine ? this.playerBubble : this.rivalBubble;
    bubble.play(emote);
    this.audio.emote(emote.key, ghost.position.x, ghost.position.z);
    this.effects.emoteBurst(ghost.position.x, ghost.position.z, hexOf(emote.colour));
    // A little kick of camera punch on the loud ones.
    if (emote.key === 'scream' || emote.key === 'angry') this.stage.shake(0.18);

    const who = mine ? 'You' : this.peerName;
    const line = mine ? emote.selfShout : emote.shout;
    this.callbacks.onEmote?.(emote.glyph, mine ? 'You' : this.peerName, emote.colour, mine);
    this.callbacks.onAlert(`${emote.glyph}  ${who} ${line}`, 'info');
  }

  /** Called by the HUD / hotkeys: play an emote and share it. */
  sendEmote(key: EmoteKey): void {
    if (this.emoteCooldown > 0 || this.phase === 'over') return;
    this.emoteCooldown = 0.75;
    this.showEmote(key, true);
    this.online?.sendEvent({ e: 'emote', k: key });
  }

  // ------------------------------------------------------------- love ping
  /**
   * Couple mode's one skill. Calling out tells your sweetheart exactly where
   * you are - a ring through the walls, a sound they can place, and a mark on
   * their dial - then leaves you hoarse for a while.
   */
  useLovePing(): boolean {
    if (this.phase !== 'running' || this.paused || this.options.autoPlay) return false;

    if (this.pingCooldown > 0) {
      this.alertOnce(
        'ping-cooling',
        `Catch your breath — you can call again in ${Math.ceil(this.pingCooldown)}s.`,
        'info',
        1.5
      );
      this.audio.blip(false);
      return false;
    }

    this.pingCooldown = LOVE_PING.cooldownSeconds;
    const { x, z } = this.player.position;
    this.effects.lovePing(x, z, COLORS.love);
    this.audio.lovePing(x, z, true);
    this.stage.shake(0.1);
    this.callbacks.onAlert('💗 You call out — listen for an answer…', 'splash');

    if (this.online) {
      this.online.sendEvent({ e: 'lovePing', x, z });
    } else {
      // A deliberate shout carries: the AI sweetheart always hears it.
      this.ai.hearPing(this.player.cellX, this.player.cellY);
    }
    return true;
  }

  /** A call from the other half of the couple: place it and remember it. */
  private receiveLovePing(x: number, z: number): void {
    this.partnerPing = { x, z, life: LOVE_PING.revealSeconds };
    this.effects.lovePing(x, z, COLORS.loveDeep);
    this.audio.lovePing(x, z, false);

    const dx = x - this.player.position.x;
    const dz = z - this.player.position.z;
    const tiles = Math.hypot(dx, dz) / TILE;
    const how = tiles < LOVE_PING.closeTiles ? 'close by' : 'far off';
    this.callbacks.onAlert(
      `💗 ${this.peerName} calls from the ${compassLabel(dx, dz)} — ${how}.`,
      'splash'
    );
    this.callbacks.onEmote?.('💗', this.peerName, '#ff6fae', false);
  }

  /** Ticks the ping cooldown, the fading mark, and the AI's own call-outs. */
  private updatePing(dt: number): void {
    if (this.pingCooldown > 0) {
      this.pingCooldown = Math.max(0, this.pingCooldown - dt);
      if (this.pingCooldown === 0) {
        this.audio.blip(true);
        this.alertOnce('ping-ready', '💗 Your voice is back — call again.', 'info', 2);
      }
    }

    if (this.partnerPing) {
      this.partnerPing.life -= dt;
      if (this.partnerPing.life <= 0) this.partnerPing = null;
    }

    // Offline, the AI sweetheart is searching too - and calls back now and then.
    if (this.online || this.options.autoPlay || this.phase !== 'running') return;
    this.aiPingTimer -= dt;
    if (this.aiPingTimer > 0) return;
    this.aiPingTimer = LOVE_PING.aiCallSeconds * (0.8 + this.rng() * 0.6);
    this.receiveLovePing(this.rival.position.x, this.rival.position.z);
  }

  // ------------------------------------------------------------- wall skip
  /** Charge (0..1), whether it is usable, and the wait still to go. */
  get skillStatus(): { charge: number; ready: boolean; secondsLeft: number; charging: boolean } {
    if (this.mode === 'couple') {
      const secondsLeft = this.pingCooldown;
      return {
        charge: 1 - Math.min(1, secondsLeft / LOVE_PING.cooldownSeconds),
        ready: secondsLeft <= 0,
        secondsLeft,
        charging: false,
      };
    }
    const secondsLeft = this.skillCooldown;
    return {
      charge: 1 - Math.min(1, secondsLeft / WALL_SKIP.cooldownSeconds),
      ready: secondsLeft <= 0,
      secondsLeft,
      charging: this.skillRecharging,
    };
  }

  /** The skill button: a wall skip in the classic chase, a call in couple mode. */
  useSkill(): boolean {
    return this.mode === 'couple' ? this.useLovePing() : this.useWallSkip();
  }

  /**
   * Walking winds the skill back up; loitering barely does. The bonus is
   * capped so even a full-speed lap never makes it feel spammable.
   */
  private rechargeSkill(dt: number, moved: boolean): void {
    if (moved) {
      this.walkStreak = Math.min(WALL_SKIP.streakCap, this.walkStreak + dt);
    } else {
      this.walkStreak = Math.max(0, this.walkStreak - dt * WALL_SKIP.streakDecay);
    }
    if (this.skillCooldown <= 0) {
      this.skillRecharging = false;
      return;
    }

    const bonus = Math.min(WALL_SKIP.maxWalkBonus, this.walkStreak * WALL_SKIP.walkRamp);
    const rate = moved ? WALL_SKIP.walkRate + bonus : WALL_SKIP.idleRate;
    this.skillCooldown = Math.max(0, this.skillCooldown - dt * rate);
    this.skillRecharging = moved;

    if (this.skillCooldown <= 0) {
      this.audio.blip(true);
      this.callbacks.onAlert('Wall skip is ready again.', 'info');
    }
  }

  /**
   * Slips the player through the single wall they are facing. Returns false
   * (with a nudge in the HUD) when it is still charging or there is nothing
   * but solid rock on the other side.
   */
  useWallSkip(): boolean {
    if (this.phase !== 'running' || this.paused || this.options.autoPlay) return false;

    if (this.skillCooldown > 0) {
      this.alertOnce(
        'skip-cooling',
        `Wall skip needs ${Math.ceil(this.skillCooldown)}s more — keep walking to charge it.`,
        'info',
        1.5
      );
      this.audio.blip(false);
      return false;
    }

    const target = this.findSkipTarget();
    if (!target) {
      this.alertOnce('skip-blocked', 'Solid rock all around — walk on and try again.', 'info', 1.5);
      this.audio.blip(false);
      return false;
    }

    const fromX = this.player.position.x;
    const fromZ = this.player.position.z;
    this.player.placeAtCell(target.cx, target.cy);
    this.skillCooldown = WALL_SKIP.cooldownSeconds;
    this.walkStreak = 0;
    this.skillRecharging = false;

    const colour = this.player.role === 'seeker' ? COLORS.warm : COLORS.cold;
    this.effects.ping(fromX, fromZ, colour);
    this.effects.splash(this.player.position.x, this.player.position.z, colour);
    this.audio.melt(this.player.position.x, this.player.position.z);
    this.stage.shake(0.18);
    this.callbacks.onAlert('You slipped straight through the wall!', 'splash');

    this.online?.sendEvent({
      e: 'skip',
      x: this.player.position.x,
      z: this.player.position.z,
      fx: fromX,
      fz: fromZ,
    });
    return true;
  }

  /**
   * Looks for a wall the player can cross, preferring the direction they are
   * steering and falling back to the way they are facing. Only ever one wall
   * tile thick: if the far side is solid too, the skip is refused.
   */
  private findSkipTarget(): { cx: number; cy: number } | null {
    for (const [dx, dy] of this.skipDirections()) {
      const wallX = this.player.cellX + dx;
      const wallY = this.player.cellY + dy;
      if (!this.maze.isWall(wallX, wallY)) continue;

      // Straight through first, then squeezing out beside the wall block.
      const exits: Array<[number, number]> = [
        [wallX + dx, wallY + dy],
        [wallX + dx + dy, wallY + dy + dx],
        [wallX + dx - dy, wallY + dy - dx],
      ];
      for (const [cx, cy] of exits) {
        // The outer shell of the maze is never passable.
        if (cx <= 0 || cy <= 0 || cx >= this.maze.width - 1 || cy >= this.maze.height - 1) continue;
        if (this.maze.isWall(cx, cy)) continue;
        return { cx, cy };
      }
    }
    return null;
  }

  /** Candidate grid steps, most-intended first. */
  private skipDirections(): Array<[number, number]> {
    const [ax, az] = screenToWorld(this.input.axis.x, this.input.axis.y);
    let dirX = ax;
    let dirZ = az;
    if (Math.hypot(dirX, dirZ) < 0.15) {
      dirX = Math.sin(this.player.facing);
      dirZ = Math.cos(this.player.facing);
    }

    const horizontal: [number, number] = [Math.sign(dirX) || 1, 0];
    const vertical: [number, number] = [0, Math.sign(dirZ) || 1];
    const backHorizontal: [number, number] = [-horizontal[0], 0];
    const backVertical: [number, number] = [0, -vertical[1]];
    // The way they are heading first, then the sides, then back where they came from.
    return Math.abs(dirX) >= Math.abs(dirZ)
      ? [horizontal, vertical, backVertical, backHorizontal]
      : [vertical, horizontal, backHorizontal, backVertical];
  }

  /** The other player quit: award the round to whoever is still here. */
  handlePeerLeft(): void {
    if (this.phase === 'over' || !this.online) return;
    this.peerGone = true;
    this.callbacks.onAlert('Your friend left the maze.', 'info');
    // There is no winning a reunion on your own, so couple mode just stops.
    this.finish(this.mode !== 'couple');
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
    const radius =
      this.mode === 'couple'
        ? VISION.couple
        : this.player.role === 'seeker'
          ? VISION.seeker
          : VISION.hider;
    computeVisibility(this.maze, this.player.cellX, this.player.cellY, radius, this.visibility);
  }

  /** How clearly the player can make out the rival right now (0..1). */
  private rivalVisibility(): number {
    const index = this.maze.index(this.rival.cellX, this.rival.cellY);
    const lit = this.maze.inBounds(this.rival.cellX, this.rival.cellY) ? this.visibility[index] : 0;
    const tiles = Math.hypot(this.rival.cellX - this.player.cellX, this.rival.cellY - this.player.cellY);

    let value = lit > 0.02 ? Math.min(1, 0.35 + lit * 1.4) : 0;

    if (this.mode === 'couple') {
      // Sweethearts spot each other from the same distance, both ways: the
      // moment there is a clear line down the alley, you have found them.
      if (tiles < 15 && hasLineOfSight(this.maze, this.player.cellX, this.player.cellY, this.rival.cellX, this.rival.cellY)) {
        value = Math.max(value, 1 - tiles / 18);
      }
      return Math.max(0, Math.min(1, value));
    }

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
    if (this.mode === 'couple') {
      this.updateCoupleCues(dt, tiles, rivalSeen);
      return;
    }

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

  /**
   * Couple mode's cues are all encouragement: the other half's trail, their
   * whisper a few tiles away, and a heartbeat that quickens as you close in.
   */
  private updateCoupleCues(dt: number, tiles: number, rivalSeen: number): void {
    const trailHere =
      this.rival.role === 'seeker'
        ? this.field.heatAt(this.player.cellX, this.player.cellY)
        : this.field.coldAt(this.player.cellX, this.player.cellY);

    if (trailHere > 0.4) {
      this.alertOnce('their-trail', 'Their trail is still warm here — you just missed them.', 'heat', 6);
    }
    if (rivalSeen > 0.3 && tiles < 9) {
      this.alertOnce('sweetheart-seen', '💗 There they are!', 'danger', 3);
    } else if (tiles < LOVE_PING.whisperTiles) {
      this.alertOnce('sweetheart-near', 'You can hear them breathing — very close now.', 'splash', 4);
    }

    // A happy, rising heartbeat rather than a fearful one.
    const closeness = Math.max(0, 1 - tiles / 12);
    this.audio.setTension(closeness * 0.5);
    this.audio.updateHeartbeat(dt, closeness * 0.9, this.player.position.x, this.player.position.z);
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
    if (this.mode === 'couple') {
      // A hot-and-cold dial: the whole bar fills as your sweetheart nears.
      const tiles = this.player.position.distanceTo(this.rival.position) / TILE;
      meter = Math.max(0, Math.min(1, 1 - tiles / 18));
      meterLabel =
        meter > 0.82
          ? 'Burning hot — they are right here!'
          : meter > 0.6
            ? 'Getting warm…'
            : meter > 0.35
              ? 'Lukewarm'
              : 'Cold — try calling out';
    } else if (this.player.role === 'hider') {
      meter = this.field.dwellRatio(this.player.cellX, this.player.cellY);
      meterLabel = meter > 0.6 ? 'Melting a pond!' : 'Chill building';
    } else {
      const mark = this.field.strongestWithin('cold', this.player.cellX, this.player.cellY, 4.5, 0.02);
      meter = mark ? Math.min(1, mark.value / TRAIL.pondThreshold) : 0;
      meterLabel = meter > 0.5 ? 'Frost scent — strong' : 'Frost scent';
    }

    const skill = this.skillStatus;
    this.callbacks.onHud({
      role: this.player.role,
      mode: this.mode,
      remainingSeconds: Math.max(0, this.roundSeconds - this.elapsed),
      meter,
      meterLabel,
      phase: this.phase,
      countdown: Math.max(0, Math.ceil(this.countdown)),
      skillCharge: skill.charge,
      skillReady: skill.ready,
      skillSecondsLeft: skill.secondsLeft,
      skillCharging: skill.charging,
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

    if (win && this.mode === 'couple') {
      // Both halves celebrate, and the party happens between them.
      this.player.rig.setCelebrating(true);
      this.rival.rig.setCelebrating(true);
      const midX = (this.player.position.x + this.rival.position.x) / 2;
      const midZ = (this.player.position.z + this.rival.position.z) / 2;
      this.effects.fireworks(midX, midZ, COLORS.love);
      this.effects.emoteBurst(midX, midZ, COLORS.loveDeep);
      this.stage.setFocus(midX, midZ);
      this.showEmote('heart', true);
    } else if (win) {
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
      mode: this.mode,
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

  /** Live snapshot for the HUD minimap. */
  get minimapView(): MinimapView {
    return {
      maze: this.maze,
      field: this.field,
      role: this.player.role,
      playerX: this.player.position.x,
      playerZ: this.player.position.z,
      playerFacing: this.player.facing,
      rivalX: this.rival.position.x,
      rivalZ: this.rival.position.z,
      rivalSeen: this.lastRivalSeen,
      memoryTint: this.memoryTint,
      ping: this.partnerPing
        ? {
            x: this.partnerPing.x,
            z: this.partnerPing.z,
            strength: Math.max(0, Math.min(1, this.partnerPing.life / LOVE_PING.revealSeconds)),
          }
        : null,
    };
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
    this.playerBubble.dispose();
    this.rivalBubble.dispose();
    this.stage.scene.remove(this.player.rig.group, this.rival.rig.group);
    this.player.dispose();
    this.rival.dispose();
    this.world.dispose();
  }
}

/** CSS hex string (#rrggbb) to the numeric colour three.js wants. */
function hexOf(css: string): number {
  return Number.parseInt(css.replace('#', ''), 16) || 0xffffff;
}

/** Shortest signed angular distance, so remote ghosts never spin the long way. */function shortestTurn(from: number, to: number): number {
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
