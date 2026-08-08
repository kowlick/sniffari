/**
 * Types for generate.mjs. The generator is plain JS because the map scripts and the server
 * both use it and it predates the server needing it; this keeps the server's typecheck
 * honest without converting the file.
 */

export type GenerateOptions = {
  size?: number;
  seed?: number;
  minGap?: number | null;
  blockFraction?: number;
  fences?: number | null;
  fenceLength?: [number, number] | null;
  baffles?: boolean;
  sniff?: number;
  person?: number;
  squirrel?: number;
  lake?: number;
  startBuffer?: number | null;
};

export type GenerateStats = {
  size: number;
  total: number;
  walkable: number;
  walkableFraction: number;
  obstacles: number;
  baffles: number;
  fences: number;
  blockedInterior: number;
  sniffs: number;
  people: number;
  stoppers: number;
  walkablePerStopper: number;
};

export declare const SIZES: Record<string, { size: number; players: string }>;
export declare const DEFAULTS: Required<GenerateOptions>;

/** Deterministic for a given seed. `text` is the ASCII map, ready for parseMap(). */
export declare function generateMap(options?: GenerateOptions): {
  grid: string[][];
  text: string;
  stats: GenerateStats;
};
