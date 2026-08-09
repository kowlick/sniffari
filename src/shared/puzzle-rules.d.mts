/**
 * Types for the solo puzzle rules. The module itself is deliberately plain JavaScript so
 * the browser can load the identical file; this keeps the server's `tsc --noEmit` honest.
 * Same arrangement as sim/generate.d.mts.
 */
export type Dir = 0 | 1 | 2 | 3;

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
  solution?: number[];
};

export type Run = {
  x: number;
  y: number;
  dir: number;
  jumpArmed: boolean;
  tick: number;
  steps: number;
  tiles: Map<string, string>;
  used: number;
  taps: number[];
  outcome: string;
  trail: { x: number; y: number; dir: number; tick: number }[] | null;
};

export const DIRS: { dx: number; dy: number }[];
export const WALL: string;
export const GOAL: string;
export const HAZARD_TERRAIN: Set<string>;
export const OUTCOME: {
  RUNNING: string;
  WON: string;
  LOST_HAZARD: string;
  LOST_DOG: string;
  LOST_TIRED: string;
  LOST_ESCAPED: string;
  LOST_CRASH: string;
};

export function placeable(level: PuzzleLevel, x: number, y: number): boolean;
export function patrolAt(
  patrol: { route: { x: number; y: number }[]; phase: number },
  tick: number,
): { x: number; y: number };
export function createRun(level: PuzzleLevel): Run;
export function tapTarget(level: PuzzleLevel, run: Run): { x: number; y: number; kind: string } | null;
export function tap(level: PuzzleLevel, run: Run): { x: number; y: number; kind: string } | null;
export function step(level: PuzzleLevel, run: Run): Run;
export function replay(level: PuzzleLevel, taps: number[]): Run;
export function solved(level: PuzzleLevel, run: Run): boolean;
