/**
 * Map tuning harness.
 *
 * Generates maps across many seeds, simulates the walk phase on each, and reports the
 * distribution of round lengths, stop reasons and scores. Use it to set the densities in
 * src/sim/generate.mjs rather than eyeballing a single preview.
 *
 * Two scenarios are reported per config:
 *   bare   — no tiles placed at all. The worst case for termination.
 *   played — 40 random legal tiles, roughly what 8 players actually put down.
 *
 *   node scripts/tune.mjs [--seeds 40]
 */
import { CONFIG } from '../src/config.ts';
import { parseMap } from '../src/sim/map.ts';
import { simulateWalk } from '../src/sim/simulate.ts';
import { generateMap } from '../src/sim/generate.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const SEEDS = Number(args.get('--seeds') ?? 40);

// size, how many dogs actually play on it, and the stamina values under test.
// Does breaking the symmetry of the border baffles help dogs that get stuck on the edge?
const CONFIGS = [
  { label: 'small 2 dogs', size: 8, dogs: 2, staminas: [18, 22, 26], opts: { baffleJitter: true } },
  { label: 'medium 5 dogs', size: 10, dogs: 5, staminas: [22, 26, 30, 34], opts: { baffleJitter: true } },
  { label: 'large 8 dogs', size: 12, dogs: 8, staminas: [26, 30, 34, 40], opts: { baffleJitter: true } },
];

const mulberry32 = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const KINDS = ['N', 'E', 'S', 'W', 'J'];

/** Random legal tiles: a crude stand-in for each player's five placements. */
function randomTiles(map, rand, count) {
  const tiles = new Map();
  const legal = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const t = map.terrain[y * map.width + x];
      if (t === '#' || t === 'Q' || t === '~' || t === 'D') continue;
      if (map.starts.some((s) => s.x === x && s.y === y)) continue;
      legal.push([x, y]);
    }
  }
  for (let i = 0; i < count && legal.length; i++) {
    const j = Math.floor(rand() * legal.length);
    const [x, y] = legal.splice(j, 1)[0];
    tiles.set(`${x},${y}`, {
      kind: KINDS[Math.floor(rand() * KINDS.length)],
      ownerId: 'x',
      secret: false,
    });
  }
  return tiles;
}

/** Playback speed for the board of this size, defaulting to the slowest if it isn't one. */
const secondsPerTile = (size) =>
  (CONFIG.boards.find((b) => b.size === size) ?? CONFIG.boards.at(-1)).secondsPerTile;

const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)];
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

function run(size, dogCount, withTiles, stamina, opts = {}) {
  const cfg = { ...CONFIG, sim: { ...CONFIG.sim, stamina } };
  const lengths = [];
  const scores = [];
  const reasons = {};
  const perDogLen = [];
  /** Share of the board a dog actually gets to see. The real complaint behind "tuckers out
   *  too fast" is that most of the map, and most of your placed tiles, go unvisited. */
  const coverage = [];
  /** Share of its living ticks a dog spends in the lane next to the fence. */
  const edgeTime = [];

  for (let seed = 1; seed <= SEEDS; seed++) {
    const { text } = generateMap({ size, seed, ...opts });
    const map = parseMap(text, `s${seed}`);
    // Only as many dogs as the board is meant to hold.
    const dogs = map.starts
      .slice(0, dogCount)
      .map((s, i) => ({ id: `d${i}`, breed: 'x', x: s.x, y: s.y, dir: s.dir }));
    const rand = mulberry32(seed * 7919);
    // One tile per dog per placement turn, which is per board now — see CONFIG.boards.turns.
    const turns = (CONFIG.boards.find((b) => b.size === size) ?? CONFIG.boards.at(-1)).turns;
    const tiles = withTiles ? randomTiles(map, rand, dogCount * turns) : new Map();
    const result = simulateWalk(map, dogs, tiles, cfg);

    lengths.push(result.ticks.length);

    let walkable = 0;
    for (const t of map.terrain) if (t !== '#') walkable++;
    for (const d of dogs) {
      const seen = new Set();
      let onEdge = 0;
      let ticksAlive = 0;
      for (const tick of result.ticks) {
        const snap = tick.dogs.find((s) => s.id === d.id);
        if (!snap || snap.stopped) continue;
        seen.add(`${snap.x},${snap.y}`);
        ticksAlive++;
        // The symptom of "stuck on the border": riding the lane next to the fence.
        if (snap.x <= 1 || snap.y <= 1 || snap.x >= map.width - 2 || snap.y >= map.height - 2)
          onEdge++;
      }
      coverage.push(seen.size / walkable);
      if (ticksAlive) edgeTime.push(onEdge / ticksAlive);
    }

    for (const s of result.scores) {
      scores.push(s.score);
      reasons[s.stopped] = (reasons[s.stopped] ?? 0) + 1;
      // How long each individual dog lasted, which is what its player actually experiences.
      const last = result.ticks.findLast((t) => t.dogs.find((d) => d.id === s.dogId)?.stopped === null);
      perDogLen.push(last ? last.n + 1 : 0);
    }
  }

  const total = Object.values(reasons).reduce((a, b) => a + b, 0);
  const share = (k) => Math.round(((reasons[k] ?? 0) / total) * 100);
  // The metric that matters most for the player experience: how often somebody's dog is
  // out of the round before it has done anything worth watching. Measured as a fraction of
  // stamina, since stamina now differs per board size.
  const cutShort = Math.round(
    (perDogLen.filter((n) => n < stamina * 0.3).length / perDogLen.length) * 100,
  );
  return {
    round: pct(lengths, 0.5),
    // Playback speed is per board, so a round on the large map is longer in seconds than
    // its tick count alone suggests.
    roundSec: (pct(lengths, 0.5) * secondsPerTile(size)).toFixed(0),
    dog: `${pct(perDogLen, 0.5)} (${pct(perDogLen, 0.1)}-${pct(perDogLen, 0.9)})`,
    cover: `${Math.round(mean(coverage) * 100)}%`,
    edge: `${Math.round(mean(edgeTime) * 100)}%`,
    cutShort: `${cutShort}%`,
    score: mean(scores).toFixed(1),
    squirrel: `${share('squirrel')}%`,
    lake: `${share('lake')}%`,
    ran: `${share('tuckered') + share('tail')}%`,
  };
}

console.log(
  `\n${SEEDS} seeds per config, at ${CONFIG.boards.map((b) => `${b.name} ${b.secondsPerTile}s`).join(', ')} per tile.`,
);
console.log('cover = share of the walkable board one dog actually visits.');
console.log('edge  = share of its living ticks a dog spends in the lane next to the fence.');
console.log('cut = share of dogs done inside 30% of their stamina — their placements never fired.');
console.log('ran = share that ran the clock out (tuckered or looping) instead of finding something.\n');
console.log(
  `${''.padEnd(34)}${'dog life'.padEnd(16)}${'edge'.padEnd(7)}${'cover'.padEnd(8)}${'cut'.padEnd(6)}${'score'.padEnd(7)}${'ran'}`,
);

for (const { label, size, dogs, staminas, opts } of CONFIGS) {
  for (const stamina of staminas) {
    const r = run(size, dogs, true, stamina, opts);
    console.log(
      `${label.padEnd(34)}${r.dog.padEnd(16)}${r.edge.padEnd(7)}${r.cover.padEnd(8)}${r.cutShort.padEnd(6)}${r.score.padEnd(7)}${r.ran}`,
    );
  }
}
console.log();
