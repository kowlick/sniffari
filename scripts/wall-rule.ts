/**
 * Which wall rule actually makes a better round?
 *
 * "Turn right" was chosen back when placed tiles were permanent, to stop dogs being
 * trapped too easily. Tiles are single use now, so the constraint has relaxed and the
 * question is worth reopening — but with numbers, not with vibes. See DESIGN.md §4.5.
 *
 * What matters, in order:
 *   - **score**, because that is the game;
 *   - **ticks lived**, because a dog that ends early is a player who placed five tiles and
 *     watched none of them fire (the metric `npm run tune` is built around);
 *   - **distinct tiles visited**, because it separates a dog that is covering ground from
 *     one that is shuffling over the same squares;
 *   - **how rounds end**, because 'tail' means loop detection had to cull it.
 *
 *   node scripts/wall-rule.ts [seeds] [board]
 */

import { CONFIG } from '../src/config.ts';
import { generateMap } from '../src/sim/generate.mjs';
import { parseMap } from '../src/sim/map.ts';
import { simulateWalk, type WallRule } from '../src/sim/simulate.ts';
import { key, type DogInit, type PlacedTile, type StopReason } from '../src/sim/types.ts';

const seeds = Number(process.argv[2] ?? 120);
const boardName = process.argv[3] ?? 'large';
const board = CONFIG.boards.find((b) => b.name === boardName) ?? CONFIG.boards.at(-1)!;
const RULES: WallRule[] = ['right', 'around', 'open'];

/**
 * A plausible mid-round board. Tiles are scattered deterministically rather than played
 * out by bots: the question here is about the movement rule, and holding the tiles fixed
 * across the three rules is what makes the comparison fair.
 */
function tilesFor(map: ReturnType<typeof parseMap>, dogs: number, seed: number) {
  const tiles = new Map<string, PlacedTile>();
  const kinds = ['N', 'E', 'S', 'W', 'J'] as const;
  let placed = 0;
  const want = dogs * CONFIG.round.turns;
  for (let i = 0; placed < want && i < map.width * map.height; i++) {
    const x = (i * 7 + seed * 3) % map.width;
    const y = (i * 11 + seed * 5) % map.height;
    const t = map.terrain[y * map.width + x];
    if (t !== '.' && t !== ',') continue;
    const k = key(x, y);
    if (tiles.has(k)) continue;
    if (map.starts.some((s) => s.x === x && s.y === y)) continue;
    tiles.set(k, { kind: kinds[(i + seed) % kinds.length]!, ownerId: 'x', secret: false });
    placed++;
  }
  return tiles;
}

console.log(`\n  ${board.name} board, ${seeds} seeds, ${board.maxPlayers} dogs, stamina ${board.stamina}\n`);
console.log(
  `  ${'rule'.padEnd(8)} ${'score'.padStart(6)} ${'ticks'.padStart(6)} ${'tiles'.padStart(6)} ` +
    `${'short'.padStart(6)}   how rounds ended`,
);

for (const rule of RULES) {
  const cfg = {
    sim: {
      stamina: board.stamina,
      jumpDistance: CONFIG.sim.jumpDistance,
      stuckTurnsBeforeGiveUp: CONFIG.sim.stuckTurnsBeforeGiveUp,
      wallRule: rule,
    },
    scoring: CONFIG.scoring,
  };

  let score = 0;
  let ticks = 0;
  let visited = 0;
  let dogsTotal = 0;
  let short = 0;
  const ends = new Map<StopReason, number>();

  for (let seed = 1; seed <= seeds; seed++) {
    const { text } = generateMap({ size: board.size, seed });
    const map = parseMap(text, `seed ${seed}`);
    const n = Math.min(board.maxPlayers, map.starts.length);
    const dogs: DogInit[] = map.starts.slice(0, n).map((s, i) => ({
      id: `d${i}`,
      breed: `d${i}`,
      x: s.x,
      y: s.y,
      dir: s.dir,
    }));

    const result = simulateWalk(map, dogs, tilesFor(map, n, seed), cfg);

    // Where each dog went, tick by tick, so "covering ground" can be measured rather than
    // assumed.
    const seen = new Map<string, Set<string>>();
    const lastTick = new Map<string, number>();
    for (const t of result.ticks) {
      for (const d of t.dogs) {
        if (!seen.has(d.id)) seen.set(d.id, new Set());
        seen.get(d.id)!.add(key(d.x, d.y));
        if (d.stopped === null) lastTick.set(d.id, t.n);
      }
    }

    for (const s of result.scores) {
      dogsTotal++;
      score += s.score;
      const lived = lastTick.get(s.dogId) ?? 0;
      ticks += lived;
      visited += seen.get(s.dogId)?.size ?? 0;
      if (lived < board.stamina * 0.3) short++;
      ends.set(s.stopped, (ends.get(s.stopped) ?? 0) + 1);
    }
  }

  const breakdown = [...ends.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r} ${((n / dogsTotal) * 100).toFixed(0)}%`)
    .join('  ');

  console.log(
    `  ${rule.padEnd(8)} ${(score / dogsTotal).toFixed(2).padStart(6)} ` +
      `${(ticks / dogsTotal).toFixed(1).padStart(6)} ${(visited / dogsTotal).toFixed(1).padStart(6)} ` +
      `${((short / dogsTotal) * 100).toFixed(0).padStart(5)}%   ${breakdown}`,
  );
}
console.log('\n  score/ticks/tiles are per dog. "short" = finished inside 30% of stamina.\n');
