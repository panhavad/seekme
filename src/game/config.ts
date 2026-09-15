/** Central tuning table for the whole game. */

export type Role = 'hider' | 'seeker';
export type Difficulty = 'easy' | 'normal' | 'hard';

export const APP_VERSION = '1.0.0';

export const TILE = 2.4;
export const WALL_HEIGHT = 2.2;

export const MAZE = {
  width: 25,
  height: 25,
  braid: 0.2,
  plazas: 4,
  /** Ponds that already exist on the map when the round starts. */
  naturalPonds: 6,
};

export interface MazeLayout {
  width: number;
  height: number;
  braid: number;
  plazas: number;
  naturalPonds: number;
}

/**
 * Rolls a fresh layout for every round. Driven by the round's seeded RNG, so
 * two players in an online match still carve exactly the same maze.
 */
export function rollMazeLayout(rng: () => number): MazeLayout {
  const size = 23 + 2 * Math.floor(rng() * 4); // 23, 25, 27 or 29
  return {
    width: size,
    height: size,
    braid: 0.12 + rng() * 0.22,
    plazas: 2 + Math.floor(rng() * 5),
    naturalPonds: 4 + Math.floor(rng() * 6),
  };
}

export const ROUND_SECONDS = 120;

/** Radius (in tiles) each ghost can see, and how far their glow reaches. */
export const VISION = {
  seeker: 11.5,
  hider: 9,
};

/** Ghosts drift briskly - a slow chase is a boring chase. */
export const SPEED = {
  seeker: 6.6,
  hider: 5.8,
};

export const BODY_RADIUS = 0.42;
export const CATCH_DISTANCE = 1.35;

export const TRAIL = {
  /** Heat gained per second standing still on one tile. */
  heatGain: 0.85,
  /** Frost gained per second standing still on one tile. */
  coldGain: 0.62,
  /** Seconds for a trail to fade to ~37% of its value. */
  heatTau: 16,
  coldTau: 26,
  /** Frost level at which the hider's chill melts a permanent pond. */
  pondThreshold: 0.995,
  /** Seconds of standing in one spot before a pond forms. */
  pondDwellSeconds: 5.5,
  /** Trail strength below which a mark is invisible. */
  epsilon: 0.012,
};

export const AI: Record<Difficulty, {
  visionTiles: number;
  speedScale: number;
  /** How strongly the AI trusts faint trails (0..1). */
  trailSense: number;
  /** Seconds it keeps chasing a lost target. */
  memorySeconds: number;
  /** Seconds between re-plans. */
  planInterval: number;
  /** Tiles at which pond splashes are heard. */
  hearingTiles: number;
}> = {
  easy: {
    visionTiles: 6.5,
    speedScale: 0.84,
    trailSense: 0.45,
    memorySeconds: 3.5,
    planInterval: 0.9,
    hearingTiles: 9,
  },
  normal: {
    visionTiles: 8.5,
    speedScale: 0.97,
    trailSense: 0.7,
    memorySeconds: 6,
    planInterval: 0.6,
    hearingTiles: 13,
  },
  hard: {
    visionTiles: 10.5,
    speedScale: 1.08,
    trailSense: 0.92,
    memorySeconds: 9,
    planInterval: 0.35,
    hearingTiles: 18,
  },
};

export const COLORS = {
  warm: 0xffb257,
  warmDeep: 0xff5a2b,
  cold: 0x6fd8ff,
  coldDeep: 0x2f7dff,
  sheet: 0xf3f1ea,
};

export function formatClock(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const m = Math.floor(clamped / 60);
  const s = Math.floor(clamped % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function formatPreciseClock(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const cs = Math.floor((total * 100) % 100);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${cs
    .toString()
    .padStart(2, '0')}`;
}
