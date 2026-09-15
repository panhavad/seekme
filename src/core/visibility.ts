import type { Maze } from './maze';

/**
 * Recursive shadowcasting: fills `out` with 0..1 visibility (1 at the ghost,
 * fading to 0 at the lantern's reach) and lets walls cast real shadows, which
 * is what makes peeking around a corner feel good.
 */
export function computeVisibility(
  maze: Maze,
  originX: number,
  originY: number,
  radius: number,
  out: Float32Array
): void {
  out.fill(0);
  if (!maze.inBounds(originX, originY)) return;
  out[maze.index(originX, originY)] = 1;

  for (let octant = 0; octant < 8; octant++) {
    castLight(maze, originX, originY, radius, out, 1, 1, 0, OCTANTS[octant]);
  }
}

type Octant = [number, number, number, number];

const OCTANTS: Octant[] = [
  [1, 0, 0, 1],
  [0, 1, 1, 0],
  [0, -1, 1, 0],
  [-1, 0, 0, 1],
  [-1, 0, 0, -1],
  [0, -1, -1, 0],
  [0, 1, -1, 0],
  [1, 0, 0, -1],
];

function castLight(
  maze: Maze,
  cx: number,
  cy: number,
  radius: number,
  out: Float32Array,
  row: number,
  startSlope: number,
  endSlope: number,
  octant: Octant
): void {
  if (startSlope < endSlope) return;
  const [xx, xy, yx, yy] = octant;
  const radiusSq = radius * radius;
  let nextStart = startSlope;

  for (let distance = row; distance <= radius; distance++) {
    let blocked = false;

    for (let delta = -distance; delta <= 0; delta++) {
      const leftSlope = (delta - 0.5) / (-distance - 0.5);
      const rightSlope = (delta + 0.5) / (-distance + 0.5);

      if (rightSlope > nextStart) continue;
      if (leftSlope < endSlope) break;

      const mapX = cx + delta * xx + -distance * xy;
      const mapY = cy + delta * yx + -distance * yy;
      if (!maze.inBounds(mapX, mapY)) continue;

      const distSq = delta * delta + distance * distance;
      if (distSq <= radiusSq) {
        const falloff = 1 - Math.sqrt(distSq) / radius;
        const index = maze.index(mapX, mapY);
        const value = falloff * falloff * (3 - 2 * falloff);
        if (value > out[index]) out[index] = value;
      }

      const isWall = maze.isWall(mapX, mapY);
      if (blocked) {
        if (isWall) {
          nextStart = rightSlope;
          continue;
        }
        blocked = false;
        startSlope = nextStart;
      } else if (isWall && distance < radius) {
        blocked = true;
        castLight(maze, cx, cy, radius, out, distance + 1, startSlope, leftSlope, octant);
        nextStart = rightSlope;
      }
    }

    if (blocked) break;
  }
}
