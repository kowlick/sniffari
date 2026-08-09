/**
 * Building Heel levels.
 *
 * Level N is a pure function of N. Not "generated once and shipped in a manifest" — an
 * actual function, so the supply is endless and level 4,912 is the same board in Auckland
 * as it is in Lisbon. That property is what makes a shared solution mean anything.
 *
 * The method is generate-and-test, which is only viable because the solver is cheap (see
 * solve.mjs). A candidate is rolled, graded, and kept if it has the shape this level slot
 * wants; otherwise the seed advances and we try again. The retry loop is itself
 * deterministic, so "the 23rd candidate for level 12" is a well-defined board.
 */

import { GOAL, WALL, replay, solved } from '../shared/puzzle-rules.mjs';
import { grade } from './solve.mjs';

/** mulberry32, the same PRNG the bots use. Seeded, never Math.random. */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What level N should feel like.
 *
 * Every mechanic arrives on its own, on a level with nothing else going on, and only gets
 * combined with the others a couple of levels later. The ramp is slow on purpose: the first
 * dozen levels are a tutorial that never says the word tutorial.
 */
export function difficultyFor(level) {
  const n = Math.max(1, Math.floor(level));

  // Board grows in steps and then stops. Past 13x13 a phone screen makes the dog too small
  // to read at a glance, and difficulty has better places to come from anyway.
  const size = n < 6 ? 7 : n < 16 ? 9 : n < 30 ? 11 : 13;

  /*
   * Tiles are capped at six, and the cap is a real constraint rather than a taste.
   *
   * The solver searches which ticks you tapped, so its cost is C(ticks, tiles). Every extra
   * tile multiplies generation time, and by eight the search stops being something we can
   * run while somebody waits. Difficulty past that point has to come from somewhere else.
   */
  const tiles = Math.min(6, 1 + Math.floor((n - 1) / 3));

  /*
   * Which is what patrols and a tight step budget are for. Both make a level harder *and*
   * make it faster to generate, because they kill failing branches early — the opposite of
   * how another tile behaves. So the endless part of the ramp is built from these two.
   */
  const patrols = n < 3 ? 0 : Math.min(5, 1 + Math.floor((n - 3) / 5));

  // Slack shrinks with the tier: the same route, with less and less room to be wrong.
  const slack = Math.max(2, (n < 6 ? 6 : 5) - Math.floor(n / 15));

  /*
   * How long the intended route may be.
   *
   * The real quality control on the early levels. A one-tile level whose answer is twenty
   * ticks of wandering teaches nothing — level 1 has to be short enough that the player can
   * see the whole thing happen and understand why it worked.
   */
  const maxTicks = n < 4 ? 10 : n < 10 ? 16 : n < 20 ? 24 : 34;

  return {
    level: n,
    size,
    tiles,
    patrols,
    hazards: n >= 8,
    slack,
    maxTicks,
  };
}

const inBounds = (g, x, y) => y >= 0 && y < g.length && x >= 0 && x < g[0].length;

/** An open room with a handful of blocks in it. Same philosophy as the party board. */
function layout(rng, size, hazards) {
  const g = Array.from({ length: size }, () => new Array(size).fill('.'));
  for (let i = 0; i < size; i++) {
    g[0][i] = WALL;
    g[size - 1][i] = WALL;
    g[i][0] = WALL;
    g[i][size - 1] = WALL;
  }
  const blocks = 1 + Math.floor(rng() * Math.max(1, Math.floor((size - 4) / 2)));
  for (let b = 0; b < blocks; b++) {
    const w = 1 + Math.floor(rng() * 2);
    const h = 1 + Math.floor(rng() * 2);
    const x = 2 + Math.floor(rng() * Math.max(1, size - 4 - w));
    const y = 2 + Math.floor(rng() * Math.max(1, size - 4 - h));
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) if (inBounds(g, x + dx, y + dy)) g[y + dy][x + dx] = WALL;
  }
  // A little grass, purely so the board is not a grey slab.
  for (let y = 1; y < size - 1; y++)
    for (let x = 1; x < size - 1; x++) if (g[y][x] === '.' && rng() < 0.22) g[y][x] = ',';
  if (hazards) {
    for (let i = 0; i < 2; i++) {
      const x = 1 + Math.floor(rng() * (size - 2));
      const y = 1 + Math.floor(rng() * (size - 2));
      if (g[y][x] === '.' || g[y][x] === ',') g[y][x] = rng() < 0.5 ? '~' : 'D';
    }
  }
  return g;
}

const openCells = (g) => {
  const out = [];
  for (let y = 1; y < g.length - 1; y++)
    for (let x = 1; x < g[0].length - 1; x++) if (g[y][x] === '.' || g[y][x] === ',') out.push({ x, y });
  return out;
};

/** A closed loop for a patrolling dog: out along a line and back again. */
function patrolRoute(rng, g) {
  const cells = openCells(g);
  if (!cells.length) return null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const startCell = cells[Math.floor(rng() * cells.length)];
    const horiz = rng() < 0.5;
    const len = 2 + Math.floor(rng() * 3);
    const line = [];
    for (let i = 0; i < len; i++) {
      const x = startCell.x + (horiz ? i : 0);
      const y = startCell.y + (horiz ? 0 : i);
      if (!inBounds(g, x, y) || (g[y][x] !== '.' && g[y][x] !== ',')) break;
      line.push({ x, y });
    }
    if (line.length < 2) continue;
    // Out and back, so the loop is even and the dog is where you expect it.
    const back = line.slice(1, -1).reverse();
    return { route: [...line, ...back], phase: Math.floor(rng() * (line.length + back.length)) };
  }
  return null;
}

function candidate(seed, spec) {
  const rng = makeRng(seed);
  const g = layout(rng, spec.size, spec.hazards);
  const cells = openCells(g);
  if (cells.length < 8) return null;

  const start = cells[Math.floor(rng() * cells.length)];
  const goalCell = cells[Math.floor(rng() * cells.length)];
  if (start.x === goalCell.x && start.y === goalCell.y) return null;
  // Far enough apart that the answer is not "walk forwards".
  if (Math.abs(start.x - goalCell.x) + Math.abs(start.y - goalCell.y) < 3) return null;
  g[goalCell.y][goalCell.x] = GOAL;

  const patrols = [];
  for (let i = 0; i < spec.patrols; i++) {
    const p = patrolRoute(rng, g);
    // A patrol that starts on top of the dog, or camped on the parent, is not a puzzle.
    if (!p) continue;
    if (p.route.some((c) => Math.abs(c.x - start.x) + Math.abs(c.y - start.y) <= 1)) continue;
    if (p.route.some((c) => c.x === goalCell.x && c.y === goalCell.y)) continue;
    patrols.push(p);
  }
  if (patrols.length < spec.patrols) return null;

  const kinds = ['N', 'E', 'S', 'W', 'J'];
  const queue = Array.from({ length: spec.tiles }, () => kinds[Math.floor(rng() * kinds.length)]);

  return {
    level: spec.level,
    seed,
    width: spec.size,
    height: spec.size,
    terrain: g.map((row) => row.join('')),
    start: { x: start.x, y: start.y, dir: Math.floor(rng() * 4) },
    goal: goalCell,
    queue,
    patrols,
    // A working budget only. `shaped` replaces it with the length of the actual solution
    // plus a little slack, which is what makes running out of steps mean something.
    stamina: spec.size * 4,
  };
}

/**
 * Is this candidate the level we wanted?
 *
 * Two conditions beyond "has a solution". It must need **every** tile — a level solvable
 * while leaving a tile in the queue is a level whose difficulty is a lie. And it must be
 * unsolvable by doing nothing, or the player learns that the button is optional.
 */
function shaped(level, spec) {
  if (solved(level, replay(level, []))) return null;

  // Only ever needs *a* solution, so it stops at the first one. Asking this pass for a
  // count as well was most of the generator's running time, and the count it produced was
  // about to be thrown away by the retightening below anyway.
  const loose = grade(level, 1);
  if (!loose.solvable) return null;
  if (loose.first.length !== spec.tiles) return null;

  /*
   * Tighten the step budget to the route the level is actually about.
   *
   * Generated with a generous budget a level will happily accept a dog that wanders for
   * twenty ticks and blunders home, which is not a puzzle — and on level 1, where the
   * lesson is "the button turns her", it is actively misleading. So: solve with room to
   * spare, measure the shortest winning run, then hand the player that plus a few steps.
   *
   * Cutting stamina can only ever remove solutions, never add one, so the level stays
   * solvable and often becomes *more* unique. That is why the grade is taken again
   * afterwards rather than reused.
   */
  const ticks = replay(level, loose.first).tick;
  if (ticks > spec.maxTicks) return null;
  level.stamina = ticks + spec.slack;

  const tight = grade(level, 3);
  if (!tight.solvable) return null;
  if (tight.first.length !== spec.tiles) return null;
  return tight;
}

/**
 * Build level N.
 *
 * Prefers a unique solution and will spend most of its attempt budget looking for one, but
 * takes a two- or three-solution level over failing: past the early levels, boards that
 * admit exactly one answer get genuinely scarce, and a level with two answers is still a
 * good level — it just has two things worth sharing.
 */
export function buildLevel(level, { attempts = 400, maxMs = 2500 } = {}) {
  const spec = difficultyFor(level);
  const deadline = Date.now() + maxMs;
  // Seeds are derived from the level number, so every player gets the same board and the
  // same 23rd attempt at it.
  const base = Math.imul(spec.level, 0x9e3779b1) >>> 0;
  let fallback = null;

  for (let i = 0; i < attempts; i++) {
    // Time-bounded, but only once something shippable is in hand: returning null because
    // the clock ran out would leave a hole in an endless sequence of levels.
    if (fallback && Date.now() > deadline) break;
    const lv = candidate((base + i * 0x85ebca6b) >>> 0, spec);
    if (!lv) continue;
    const g = shaped(lv, spec);
    if (!g) continue;
    lv.solutions = g.count;
    lv.par = g.first.length;
    if (g.unique) return lv;
    // Keep the tidiest near-miss in case nothing unique turns up.
    if (!fallback || g.count < fallback.solutions) fallback = lv;
  }
  return fallback;
}
