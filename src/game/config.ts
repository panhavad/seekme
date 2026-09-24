/** Central tuning table for the whole game. */

export type Role = 'hider' | 'seeker';
export type Difficulty = 'easy' | 'normal' | 'hard';
/**
 * `classic` is the original chase. `couple` turns the round on its head: the
 * two ghosts are sweethearts who lost each other in the maze and have to meet
 * before the clock runs out, calling to each other with a love ping.
 */
export type GameMode = 'classic' | 'couple';

export const APP_VERSION = '1.1.0';

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
/** Couple mode is a little longer: two searchers need room to miss each other. */
export const COUPLE_ROUND_SECONDS = 150;

/** Radius (in tiles) each ghost can see, and how far their glow reaches. */
export const VISION = {
  seeker: 11.5,
  hider: 9,
  /** Couple mode is symmetric, so both sweethearts see exactly as far. */
  couple: 10.5,
};

/** Ghosts drift briskly - a slow chase is a boring chase. */
export const SPEED = {
  seeker: 6.6,
  hider: 5.8,
  /** Same legs for both halves of a couple: neither can out-run the other. */
  couple: 6.2,
};

export const BODY_RADIUS = 0.42;
export const CATCH_DISTANCE = 1.35;
/** A hug is a little more forgiving than a catch. */
export const REUNION_DISTANCE = 1.7;

/**
 * Couple mode's one skill: a love ping. It is a shout, not a teleport - it
 * tells your sweetheart exactly where you are, and tells everyone else too.
 */
export const LOVE_PING = {
  /** Seconds between call-outs. */
  cooldownSeconds: 12,
  /** Seconds a received ping stays lit on the minimap and the compass. */
  revealSeconds: 8,
  /** A ping closer than this reads as "close by" rather than "far away". */
  closeTiles: 9,
  /** Seconds between the AI sweetheart's own call-outs. */
  aiCallSeconds: 15,
  /** Tiles at which the two ghosts can simply hear each other breathing. */
  whisperTiles: 4.5,
};

/**
 * "Wall skip": a ghost may slip through a single wall once its charge is full.
 * The charge is deliberately slow, and it only builds at full speed while the
 * ghost keeps walking - camping in a corner barely recharges it, and even a
 * marathon runner never gets it back in much under half the base cooldown.
 */
export const WALL_SKIP = {
  /** Seconds of recharge at the base (walking, no streak) rate. */
  cooldownSeconds: 22,
  /** Recharge multiplier while standing still. */
  idleRate: 0.6,
  /** Recharge multiplier the moment a ghost starts walking. */
  walkRate: 1,
  /** Extra multiplier earned per second of unbroken walking. */
  walkRamp: 0.16,
  /** Ceiling on that bonus, so a runner tops out at 1.8x - never instant. */
  maxWalkBonus: 0.8,
  /** Seconds of walking that still count toward the bonus. */
  streakCap: 6,
  /** Walking streak lost per second once the ghost stops. */
  streakDecay: 0.8,
};

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
  /** Couple mode's own palette: the colour of a call across the maze. */
  love: 0xff6fae,
  loveDeep: 0xff2d78,
};

export type EmoteKey =
  | 'surprise'
  | 'angry'
  | 'sad'
  | 'scared'
  | 'scream'
  | 'annoyed'
  | 'love'
  | 'tease'
  | 'heart'
  | 'kiss'
  | 'blush'
  | 'wink';

export interface EmoteDefinition {
  key: EmoteKey;
  glyph: string;
  label: string;
  /** Third-person line, used for the other player. */
  shout: string;
  /** Second-person line, used for yourself. */
  selfShout: string;
  colour: string;
}

/** The little feelings players can throw at each other mid-chase. */
export const EMOTES: readonly EmoteDefinition[] = [
  { key: 'surprise', glyph: '😲', label: 'Surprised', shout: 'is surprised!', selfShout: 'are surprised!', colour: '#ffd98a' },
  { key: 'angry', glyph: '😠', label: 'Angry', shout: 'is angry!', selfShout: 'are angry!', colour: '#ff7a5a' },
  { key: 'sad', glyph: '😢', label: 'Sad', shout: 'is sad…', selfShout: 'are sad…', colour: '#8fc4ff' },
  { key: 'scared', glyph: '😨', label: 'Scared', shout: 'is scared!', selfShout: 'are scared!', colour: '#a5d8ff' },
  { key: 'scream', glyph: '😱', label: 'Scream', shout: 'screams!', selfShout: 'scream!', colour: '#ffffff' },
  { key: 'annoyed', glyph: '😤', label: 'Annoyed', shout: 'is fed up!', selfShout: 'are fed up!', colour: '#ffb257' },
  { key: 'love', glyph: '😍', label: 'Love', shout: 'sends love!', selfShout: 'send love!', colour: '#ff9ec7' },
  { key: 'tease', glyph: '😝', label: 'Teasing', shout: 'is teasing you!', selfShout: 'are teasing!', colour: '#b6f28a' },
  { key: 'heart', glyph: '💖', label: 'Heart', shout: 'sends a heart!', selfShout: 'send a heart!', colour: '#ff6fae' },
  { key: 'kiss', glyph: '😘', label: 'Kiss', shout: 'blows a kiss!', selfShout: 'blow a kiss!', colour: '#ff87bd' },
  { key: 'blush', glyph: '🥰', label: 'Blushing', shout: 'is blushing!', selfShout: 'are blushing!', colour: '#ffc2dd' },
  { key: 'wink', glyph: '😉', label: 'Wink', shout: 'winks at you!', selfShout: 'wink!', colour: '#ffd98a' },
];

/** The eight emotes on the pad in the classic chase, in hotkey order. */
export const CLASSIC_EMOTES: readonly EmoteKey[] = [
  'surprise',
  'angry',
  'sad',
  'scared',
  'scream',
  'annoyed',
  'love',
  'tease',
];

/** Couple mode swaps the angrier half of the pad for softer feelings. */
export const COUPLE_EMOTES: readonly EmoteKey[] = [
  'love',
  'heart',
  'kiss',
  'blush',
  'wink',
  'sad',
  'scared',
  'tease',
];

/** The emote pad for a mode, in hotkey (1-8) order. */
export function emotePad(mode: GameMode): EmoteDefinition[] {
  const keys = mode === 'couple' ? COUPLE_EMOTES : CLASSIC_EMOTES;
  return keys.map((key) => EMOTES.find((emote) => emote.key === key)!).filter(Boolean);
}

export function findEmote(key: string): EmoteDefinition | null {
  return EMOTES.find((emote) => emote.key === key) ?? null;
}

/** Playful default names so nobody is ever "Anonymous ghost" online. */
export function randomGhostName(): string {
  const first = ['Shy', 'Cozy', 'Wispy', 'Tiny', 'Jolly', 'Sleepy', 'Spooky', 'Fuzzy', 'Silly', 'Misty'];
  const second = ['Boo', 'Mochi', 'Pebble', 'Muffin', 'Casper', 'Pip', 'Bean', 'Sprout', 'Nibble', 'Puff'];
  const a = first[Math.floor(Math.random() * first.length)];
  const b = second[Math.floor(Math.random() * second.length)];
  return `${a}${b}`.slice(0, 16);
}

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
