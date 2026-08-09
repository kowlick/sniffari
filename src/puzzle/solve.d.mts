/** Types for the Heel solver. See solve.mjs. */
import type { PuzzleLevel } from '../shared/puzzle-rules.d.mts';

export function solutions(level: PuzzleLevel, limit?: number): number[][];
export function findShortcut(level: PuzzleLevel): number[] | null;
export function grade(
  level: PuzzleLevel,
  limit?: number,
): { count: number; unique: boolean; solvable: boolean; first: number[] | null };
