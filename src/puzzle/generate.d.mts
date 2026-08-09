/**
 * Types for the level generator, so the server's `tsc --noEmit` stays honest about a
 * module that is deliberately plain JavaScript. Same arrangement as sim/generate.d.mts.
 */
export type PuzzleLevel = {
  level: number;
  seed: number;
  width: number;
  height: number;
  terrain: string[];
  start: { x: number; y: number; dir: number };
  goal: { x: number; y: number };
  queue: string[];
  patrols: { route: { x: number; y: number }[]; phase: number }[];
  stamina: number;
  solutions: number;
  par: number;
  /** The intended schedule of tap ticks. Served separately, never in the level payload. */
  solution: number[];
};

export function difficultyFor(level: number): {
  level: number;
  size: number;
  tiles: number;
  patrols: number;
  hazards: boolean;
  slack: number;
};

export function buildLevel(
  level: number,
  opts?: { attempts?: number; maxMs?: number },
): PuzzleLevel | null;
