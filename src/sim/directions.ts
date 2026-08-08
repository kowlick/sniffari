import { DIR, type Dir } from './types.ts';

/** Unit vectors, indexed by Dir. Screen coordinates: y grows downward, so north is -1. */
export const VEC: readonly { dx: number; dy: number }[] = [
  { dx: 0, dy: -1 }, // N
  { dx: 1, dy: 0 }, // E
  { dx: 0, dy: 1 }, // S
  { dx: -1, dy: 0 }, // W
];

/**
 * Turn right, relative to the dog. Facing south (walking down the screen) this yields
 * west (screen-left) — a dog turns to its own right, not the screen's.
 */
export const turnRight = (d: Dir): Dir => ((d + 1) % 4) as Dir;

export const opposite = (d: Dir): Dir => ((d + 2) % 4) as Dir;

export const step = (x: number, y: number, d: Dir, distance = 1) => {
  const v = VEC[d]!;
  return { x: x + v.dx * distance, y: y + v.dy * distance };
};

/**
 * The cardinal direction that most reduces the distance to (tx, ty), used to point dogs
 * at the middle of the map at the start of a round. Ties resolve to the vertical axis.
 */
export const facing = (x: number, y: number, tx: number, ty: number): Dir => {
  const dx = tx - x;
  const dy = ty - y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? DIR.E : DIR.W;
  return dy > 0 ? DIR.S : DIR.N;
};
