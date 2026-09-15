/**
 * Maze themes: the same alleys, dressed three different ways.
 *
 * A theme owns everything that is purely about looks - sky colour, fill light,
 * bloom, drifting motes and the two GLSL chunks that paint the ground and the
 * walls. Nothing here touches the rules, so switching theme can never change
 * how a round plays: trails stay red/blue and ponds stay where they are.
 */

export type ThemeKey = 'temple' | 'park' | 'city';

export interface Theme {
  key: ThemeKey;
  /** Shown on the picker button. */
  name: string;
  /** One-line flavour under the name. */
  blurb: string;
  /** Two CSS colours for the little preview swatch in the menu. */
  swatch: [string, string];
  /** Sky behind the maze. */
  background: number;
  /** Scene-wide fill light. */
  ambientLight: { color: number; intensity: number };
  /** The single directional light standing in for moon / street glare. */
  keyLight: { color: number; intensity: number; position: [number, number, number] };
  /** Ambient term inside the floor/wall shaders. */
  shaderAmbient: number;
  /** Tint that remembered-but-unseen surfaces drift toward. */
  memoryTint: [number, number, number];
  /** Multiplies the renderer exposure so every theme lands at the same brightness. */
  exposureScale: number;
  bloom: { strength: number; radius: number; threshold: number };
  motes: { color: number; size: number; opacity: number };
  /**
   * Must define `WATER_DEEP`, `WATER_SHINE` and
   * `vec3 themeFloor(vec2 world, out float crack, out vec3 emissive)`.
   */
  floorGlsl: string;
  /**
   * Must define
   * `vec3 themeWall(vec2 uv, vec3 worldPos, vec3 n, bool isTop, out float mask, out vec3 emissive)`.
   */
  wallGlsl: string;
}

// ------------------------------------------------------------------ temple
const TEMPLE_FLOOR = /* glsl */ `
  const vec3 WATER_DEEP = vec3(0.026, 0.055, 0.095);
  const vec3 WATER_SHINE = vec3(0.05, 0.11, 0.18);

  vec3 themeFloor(vec2 world, out float crack, out vec3 emissive) {
    emissive = vec3(0.0);

    vec2 p = world * 1.45;
    p.x += 0.5 * mod(floor(p.y), 2.0);
    vec2 cell = floor(p);
    vec2 f = fract(p) - 0.5;
    float d = max(abs(f.x) * 1.02, abs(f.y) * 1.22);
    crack = smoothstep(0.34, 0.5, d);

    float tone = 0.72 + 0.4 * hash21(cell);
    float grain = 0.9 + 0.1 * valueNoise(world * 5.0);
    return mix(vec3(0.135, 0.126, 0.114) * tone * grain, vec3(0.032, 0.032, 0.04), crack);
  }
`;

const TEMPLE_WALL = /* glsl */ `
  vec3 themeWall(vec2 uv, vec3 worldPos, vec3 n, bool isTop, out float mask, out vec3 emissive) {
    emissive = vec3(0.0);

    vec2 b = uv * vec2(1.7, 2.6);
    b.x += 0.5 * mod(floor(b.y), 2.0);
    vec2 bc = floor(b);
    vec2 bf = fract(b) - 0.5;
    float bd = max(abs(bf.x) * 1.0, abs(bf.y) * 1.35);
    mask = smoothstep(0.36, 0.49, bd);

    float tone = 0.68 + 0.42 * hash21(bc + 17.0);
    float grime = 0.8 + 0.2 * valueNoise(uv * 7.0);
    vec3 brick = mix(vec3(0.115, 0.102, 0.09) * tone * grime, vec3(0.034, 0.032, 0.038), mask);
    if (isTop) brick *= 0.62;
    return brick;
  }
`;

// -------------------------------------------------------------------- park
const PARK_FLOOR = /* glsl */ `
  const vec3 WATER_DEEP = vec3(0.015, 0.045, 0.04);
  const vec3 WATER_SHINE = vec3(0.04, 0.1, 0.09);

  vec3 themeFloor(vec2 world, out float crack, out vec3 emissive) {
    emissive = vec3(0.0);

    // Lawn built from tufts on a staggered grid - the same trick as the
    // cobbles. Per-cell hashes give fine detail without the moire that
    // high-frequency noise turns into at this camera distance.
    vec2 p = world * 3.4;
    p.x += 0.5 * mod(floor(p.y), 2.0);
    vec2 cell = floor(p);
    vec2 f = fract(p) - 0.5;
    float tuft = 1.0 - smoothstep(0.16, 0.5, max(abs(f.x) * 1.05, abs(f.y) * 1.3));
    float tone = 0.5 + 0.8 * hash21(cell);
    float mottle = 0.88 + 0.24 * valueNoise(world * 1.1);
    float blades = clamp(tuft * tone, 0.0, 1.0);
    vec3 grass = mix(vec3(0.016, 0.042, 0.018), vec3(0.05, 0.125, 0.044), blades) * mottle;

    // A gravel path meanders through the garden wherever the slow noise crosses
    // its midpoint, which keeps it winding instead of gridded.
    float wander = valueNoise(world * 0.13 + 3.7);
    float path = 1.0 - smoothstep(0.035, 0.11, abs(wander - 0.5));
    vec3 gravel = mix(vec3(0.062, 0.056, 0.046), vec3(0.1, 0.092, 0.075), hash21(floor(world * 2.6)));
    vec3 col = mix(grass, gravel, path);

    // Flower beds: sparse pale blooms that never land on the path.
    vec2 fp = world * 2.2;
    vec2 fc = floor(fp);
    float seeded = step(0.9, hash21(fc + 9.1));
    float petal = 1.0 - smoothstep(0.1, 0.24, length(fract(fp) - 0.5));
    vec3 bloom = mix(vec3(0.34, 0.22, 0.28), vec3(0.34, 0.3, 0.17), hash21(fc + 3.3));
    col = mix(col, bloom, seeded * petal * (1.0 - path) * 0.6);

    // Trail glow pools in the gaps between the tufts and across the gravel.
    crack = mix(1.0 - tuft, 0.7, path);
    return col;
  }
`;

const PARK_WALL = /* glsl */ `
  vec3 themeWall(vec2 uv, vec3 worldPos, vec3 n, bool isTop, out float mask, out vec3 emissive) {
    emissive = vec3(0.0);

    // Clipped foliage: leaf clusters on a grid, dark enough that a hedge never
    // gets mistaken for a stretch of open lawn.
    vec2 g = uv * 3.1;
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    float leaf = 1.0 - smoothstep(0.1, 0.48, max(abs(f.x) * 1.08, abs(f.y) * 1.08));
    float tone = 0.45 + 0.85 * hash21(cell + 3.0);
    float dapple = 0.86 + 0.28 * valueNoise(uv * 1.4);
    float foliage = clamp(leaf * tone, 0.0, 1.0);
    mask = 1.0 - leaf;

    vec3 hedge = mix(vec3(0.005, 0.015, 0.007), vec3(0.026, 0.068, 0.024), foliage) * dapple;

    // Night-blooming buds scattered through the foliage.
    float bud = step(0.94, hash21(cell + 21.0));
    hedge = mix(hedge, vec3(0.22, 0.21, 0.26), bud * leaf * 0.5);

    // The trimmed top catches a little moon, but stays under the lawn so the
    // corridors are always the brightest thing on screen.
    if (isTop) hedge = mix(hedge, vec3(0.019, 0.048, 0.017), 0.6);
    return hedge;
  }
`;

// -------------------------------------------------------------------- city
const CITY_FLOOR = /* glsl */ `
  const vec3 WATER_DEEP = vec3(0.03, 0.02, 0.06);
  const vec3 WATER_SHINE = vec3(0.16, 0.06, 0.2);

  vec3 themeFloor(vec2 world, out float crack, out vec3 emissive) {
    // Pavement slabs with a wet asphalt speckle.
    vec2 p = world * 1.15;
    vec2 cell = floor(p);
    vec2 f = fract(p) - 0.5;
    float seam = smoothstep(0.4, 0.5, max(abs(f.x), abs(f.y)));
    float speck = 0.82 + 0.34 * valueNoise(world * 5.0);
    float slab = 0.85 + 0.3 * hash21(cell);
    vec3 asphalt = mix(vec3(0.052, 0.054, 0.072) * speck * slab, vec3(0.016, 0.016, 0.026), seam);

    // Painted road markings: a dashed line every few slab rows.
    float laneRow = step(0.88, hash21(vec2(cell.y, 11.0)));
    float dash = step(0.35, fract(p.x * 0.55)) * (1.0 - step(0.72, fract(p.x * 0.55)));
    asphalt = mix(asphalt, vec3(0.3, 0.29, 0.21), laneRow * dash * 0.55 * (1.0 - seam));

    // Neon bleeding onto the wet street: slow-drifting magenta/cyan pools.
    float sheen = valueNoise(world * 0.42 + vec2(0.0, uTime * 0.04));
    float wet = smoothstep(0.35, 0.95, valueNoise(world * 0.9 - 1.7));
    vec3 neon = mix(vec3(0.85, 0.12, 0.62), vec3(0.1, 0.65, 0.95), sheen);
    emissive = neon * wet * 0.1;

    crack = seam;
    return asphalt;
  }
`;

const CITY_WALL = /* glsl */ `
  vec3 themeWall(vec2 uv, vec3 worldPos, vec3 n, bool isTop, out float mask, out vec3 emissive) {
    // Concrete facade.
    vec3 concrete = mix(vec3(0.042, 0.044, 0.062), vec3(0.075, 0.072, 0.092), valueNoise(uv * 5.0));

    // Window grid: about a third of the panes are lit, each with its own colour
    // and its own lazy flicker, so no two facades look alike. Keeping most of
    // them dark matters - a fully lit city would erase the fog of war.
    vec2 g = uv * vec2(2.4, 3.0);
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    float pane = (1.0 - smoothstep(0.26, 0.36, abs(f.x))) * (1.0 - smoothstep(0.2, 0.3, abs(f.y)));
    float seed = hash21(cell + 4.2);
    float lit = step(0.66, seed);
    float flicker = 0.78 + 0.22 * sin(uTime * (0.6 + seed * 2.4) + seed * 37.0);
    vec3 glow = mix(vec3(1.0, 0.62, 0.26), vec3(0.4, 0.85, 1.0), hash21(cell + 8.8));

    mask = 1.0 - pane;
    emissive = glow * pane * lit * flicker * 0.45;

    // A neon sign strip along the odd column, brighter than any window.
    float strip = step(0.93, hash21(vec2(cell.x, 31.0)));
    float bar = (1.0 - smoothstep(0.18, 0.28, abs(f.x))) * step(0.2, fract(uv.y * 0.55));
    vec3 signColor = mix(vec3(1.0, 0.15, 0.5), vec3(0.2, 0.95, 0.9), hash21(vec2(cell.x, 7.0)));
    emissive += signColor * strip * bar * 0.5;

    if (isTop) {
      // Rooftops: dark gravel, no windows to light them.
      mask = 1.0;
      emissive = vec3(0.0);
      return concrete * 0.5;
    }
    return concrete;
  }
`;

export const THEMES: Record<ThemeKey, Theme> = {
  temple: {
    key: 'temple',
    name: 'Old temple',
    blurb: 'Lantern-lit cobbles and brick alleys. The original haunt.',
    swatch: ['#2b2233', '#ffb257'],
    background: 0x121726,
    ambientLight: { color: 0x49567f, intensity: 0.55 },
    keyLight: { color: 0x6d8bc6, intensity: 0.28, position: [-8, 14, -6] },
    shaderAmbient: 0x707fb8,
    memoryTint: [0.68, 0.76, 1.0],
    exposureScale: 1,
    bloom: { strength: 0.26, radius: 0.75, threshold: 0.85 },
    motes: { color: 0xffd7a0, size: 0.06, opacity: 0.32 },
    floorGlsl: TEMPLE_FLOOR,
    wallGlsl: TEMPLE_WALL,
  },
  park: {
    key: 'park',
    name: 'Garden park',
    blurb: 'Hedge walls, flower beds and fireflies over the lawn.',
    swatch: ['#16301f', '#c8ff8a'],
    background: 0x101d19,
    ambientLight: { color: 0x4d6f5b, intensity: 0.6 },
    keyLight: { color: 0x9fd8b0, intensity: 0.32, position: [-7, 14, -7] },
    shaderAmbient: 0x5f7d6a,
    memoryTint: [0.6, 0.85, 0.78],
    exposureScale: 1.0,
    bloom: { strength: 0.3, radius: 0.8, threshold: 0.8 },
    motes: { color: 0xc8ff8a, size: 0.095, opacity: 0.45 },
    floorGlsl: PARK_FLOOR,
    wallGlsl: PARK_WALL,
  },
  city: {
    key: 'city',
    name: 'Neon city',
    blurb: 'Tokyo after midnight: wet asphalt, lit windows, neon signs.',
    swatch: ['#150b23', '#ff4fd8'],
    background: 0x0a0714,
    ambientLight: { color: 0x584374, intensity: 0.5 },
    keyLight: { color: 0x8f74e0, intensity: 0.26, position: [-9, 13, -5] },
    shaderAmbient: 0x6d6098,
    memoryTint: [0.74, 0.66, 1.0],
    exposureScale: 0.98,
    bloom: { strength: 0.44, radius: 0.85, threshold: 0.7 },
    motes: { color: 0xff9ad5, size: 0.07, opacity: 0.3 },
    floorGlsl: CITY_FLOOR,
    wallGlsl: CITY_WALL,
  },
};

export const THEME_KEYS = Object.keys(THEMES) as ThemeKey[];
export const THEME_DEFAULT: ThemeKey = 'temple';

export function isThemeKey(value: unknown): value is ThemeKey {
  return typeof value === 'string' && value in THEMES;
}

export function getTheme(key: ThemeKey | string | null | undefined): Theme {
  return isThemeKey(key) ? THEMES[key] : THEMES[THEME_DEFAULT];
}
