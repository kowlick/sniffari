/**
 * Writes the board sizes to maps/.
 *
 * Maps are meant to be hand-authored (see maps/README.md) — this exists to produce
 * correctly shaped ones at the densities in DESIGN.md §4.4. Deterministic for a given seed.
 * Generation itself lives in src/sim/generate.mjs, shared with tune.mjs and preview.mjs.
 *
 *   node scripts/make-map.mjs [--seed 1] [--only small|large]
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULTS, SIZES, generateMap } from '../src/sim/generate.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const seed = Number(args.get('--seed') ?? DEFAULTS.seed);
const only = args.get('--only');

await mkdir(resolve(process.cwd(), 'maps'), { recursive: true });

for (const [name, { size, players }] of Object.entries(SIZES)) {
  if (only && only !== name) continue;
  const { text, stats } = generateMap({ seed, size });
  const out = resolve(process.cwd(), `maps/${name}.txt`);
  const header = [
    `; ${name}.txt — ${size}x${size} for ${players} players, seed ${seed}`,
    '; # wall  . street  , park  S sniff  P person  Q squirrel  ~ lake  D drain  1-8 starts',
    '; Open playfield with border baffles. See maps/README.md.',
  ];
  await writeFile(out, [...header, text].join('\n'));
  console.log(
    `${name.padEnd(7)} ${size}x${size}  ${stats.walkable} walkable (${Math.round(stats.walkableFraction * 100)}%)  ` +
      `${stats.obstacles} obstacles (${stats.baffles} baffles, ${stats.fences} fences)  ` +
      `${stats.sniffs}S ${stats.people}P  ${stats.stoppers} stoppers = 1 per ${stats.walkablePerStopper.toFixed(0)}`,
  );
}
