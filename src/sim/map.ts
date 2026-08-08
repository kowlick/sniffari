import { readFile } from 'node:fs/promises';
import { facing } from './directions.ts';
import { T, type Dir, type GameMap, type Terrain } from './types.ts';

const TERRAIN_CHARS = new Set<string>(Object.values(T));
/** '1'..'8' mark start slots. The tile underneath is always plain street. */
const START_CHARS = '12345678';

export class MapParseError extends Error {}

/**
 * Parse an ASCII map. Every row must be the same width. Blank lines and lines beginning
 * with `;` are ignored, so maps can carry comments.
 */
export function parseMap(source: string, name = 'unnamed'): GameMap {
  const rows = source
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0 && !line.startsWith(';'));

  if (rows.length === 0) throw new MapParseError(`${name}: map is empty`);

  const width = rows[0]!.length;
  const height = rows.length;
  const terrain: Terrain[] = new Array(width * height);
  const startSlots: ({ x: number; y: number } | undefined)[] = new Array(8);

  for (let y = 0; y < height; y++) {
    const row = rows[y]!;
    if (row.length !== width) {
      throw new MapParseError(
        `${name}: row ${y + 1} is ${row.length} chars, expected ${width} (rows must be rectangular)`,
      );
    }
    for (let x = 0; x < width; x++) {
      const ch = row[x]!;
      const slot = START_CHARS.indexOf(ch);
      if (slot >= 0) {
        if (startSlots[slot]) throw new MapParseError(`${name}: duplicate start marker '${ch}'`);
        startSlots[slot] = { x, y };
        terrain[y * width + x] = T.STREET;
      } else if (TERRAIN_CHARS.has(ch)) {
        terrain[y * width + x] = ch as Terrain;
      } else {
        throw new MapParseError(`${name}: unknown character '${ch}' at column ${x + 1}, row ${y + 1}`);
      }
    }
  }

  const filled = startSlots.filter((s): s is { x: number; y: number } => Boolean(s));
  if (filled.length !== startSlots.filter(Boolean).length || filled.length === 0) {
    throw new MapParseError(`${name}: no start markers found`);
  }
  const firstGap = startSlots.findIndex((s) => !s);
  if (firstGap >= 0 && firstGap < filled.length) {
    throw new MapParseError(`${name}: start markers must be contiguous from '1'; '${firstGap + 1}' is missing`);
  }

  // Dogs start pointing at the middle of the play area.
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const starts = filled.map((s) => ({ x: s.x, y: s.y, dir: facing(s.x, s.y, cx, cy) as Dir }));

  return { name, width, height, terrain, starts };
}

export async function loadMap(path: string, name?: string): Promise<GameMap> {
  const source = await readFile(path, 'utf8');
  return parseMap(source, name ?? path.split(/[\\/]/).pop() ?? 'map');
}

export const at = (map: GameMap, x: number, y: number): Terrain | null =>
  x < 0 || y < 0 || x >= map.width || y >= map.height ? null : map.terrain[y * map.width + x]!;

/** Terrain a dog can occupy. Walls are the only impassable terrain; scuffs are tiles, not terrain. */
export const isWalkable = (t: Terrain | null): boolean => t !== null && t !== T.WALL;

/** Terrain that ends a dog's run on arrival. */
export const isStopper = (t: Terrain | null): boolean =>
  t === T.SQUIRREL || t === T.LAKE || t === T.DRAIN;

/**
 * Terrain a tile may be placed on: open ground and nothing else.
 *
 * Everything that is not street or park is *something* — a hydrant to sniff, a person with
 * a treat, a squirrel, water, a drain — and a tile dropped on top of it both reads as a
 * mistake and hides the art underneath. "Tiles go on open ground" is also a rule a player
 * can apply at a glance, which "anywhere walkable that is not a stopping point" was not.
 */
export const isPlaceable = (t: Terrain | null): boolean => t === T.STREET || t === T.PARK;

/** Counts used by tests and by the density checks in DESIGN.md §4.4. */
export function mapStats(map: GameMap) {
  const counts = new Map<Terrain, number>();
  for (const t of map.terrain) counts.set(t, (counts.get(t) ?? 0) + 1);
  const total = map.width * map.height;
  const walkable = map.terrain.filter(isWalkable).length;
  return {
    total,
    walkable,
    walkableFraction: walkable / total,
    sniffs: counts.get(T.SNIFF) ?? 0,
    people: counts.get(T.PERSON) ?? 0,
    stoppers: (counts.get(T.SQUIRREL) ?? 0) + (counts.get(T.LAKE) ?? 0) + (counts.get(T.DRAIN) ?? 0),
    walkablePerStopper:
      walkable / Math.max(1, (counts.get(T.SQUIRREL) ?? 0) + (counts.get(T.LAKE) ?? 0) + (counts.get(T.DRAIN) ?? 0)),
  };
}
