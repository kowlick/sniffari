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
import { findShortcut, grade, solutions } from './solve.mjs';

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

  // A notch smaller than before, because losing the fence gave every board two more rows
  // and two more columns of actual park. Past 12x12 a phone makes the dog too small to read
  // at a glance, and difficulty has better places to come from anyway.
  const size = n < 6 ? 6 : n < 16 ? 8 : n < 30 ? 10 : 12;

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

/**
 * A park with streets cut through it, and no fence around it.
 *
 * The whole grid is playable now. A dog that keeps walking at the edge walks out of the
 * park and the round is over, which makes the boundary a hazard you have to steer away
 * from rather than a wall that helpfully turns you round. It also means the board shows
 * more park for the same number of squares — the old ring was a third of an 8x8.
 *
 * Grass by default so the board reads as a park, with streets as the structure. Streets are
 * two squares wide: one-wide asphalt read as a path or a wall depending on the tile beside
 * it, and two is unmistakably a road.
 */
function layout(rng, size, hazards) {
  const g = Array.from({ length: size }, () => new Array(size).fill(','));

  const streets = 1 + (rng() < 0.55 ? 1 : 0);
  for (let i = 0; i < streets; i++) {
    const horiz = rng() < 0.5;
    // Kept one square clear of each edge, so a street never runs along the boundary and
    // invites the dog to skate off the side of the board.
    const at = 1 + Math.floor(rng() * Math.max(1, size - 3));
    for (let j = 0; j < size; j++) {
      for (const lane of [at, at + 1]) {
        if (lane < 0 || lane >= size) continue;
        if (horiz) g[lane][j] = '.';
        else g[j][lane] = '.';
      }
    }
  }

  const blocks = 1 + Math.floor(rng() * Math.max(1, Math.floor((size - 2) / 2)));
  for (let b = 0; b < blocks; b++) {
    const w = 1 + Math.floor(rng() * 2);
    const h = 1 + Math.floor(rng() * 2);
    const x = 1 + Math.floor(rng() * Math.max(1, size - 2 - w));
    const y = 1 + Math.floor(rng() * Math.max(1, size - 2 - h));
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) if (inBounds(g, x + dx, y + dy)) g[y + dy][x + dx] = WALL;
  }

  if (hazards) {
    for (let i = 0; i < 2; i++) {
      const x = Math.floor(rng() * size);
      const y = Math.floor(rng() * size);
      if (g[y][x] === '.' || g[y][x] === ',') g[y][x] = rng() < 0.5 ? '~' : 'D';
    }
  }
  return g;
}

const openCells = (g) => {
  const out = [];
  for (let y = 0; y < g.length; y++)
    for (let x = 0; x < g[0].length; x++) if (g[y][x] === '.' || g[y][x] === ',') out.push({ x, y });
  return out;
};

/**
 * A patrolling dog: walk forwards until a wall, turn around, repeat. Forever.
 *
 * Stored as the resulting cycle of squares rather than as a position and a heading, so the
 * renderer can draw the whole route and `patrolAt` stays a lookup. But the *rule* is the
 * simple one, and it is the same rule the player's own dog follows — one behaviour to learn,
 * applied to every dog on the board.
 */
function bouncePatrol(rng, g) {
  const cells = openCells(g);
  if (!cells.length) return null;
  const step = [
    { dx: 0, dy: -1 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
  ];
  // Off the board counts as blocked *for a patrol*. The edge is the player's problem, not
  // theirs — a patrol that strolled out of the park would just be a puzzle piece leaving.
  const open = (x, y) => inBounds(g, x, y) && (g[y][x] === '.' || g[y][x] === ',');

  for (let attempt = 0; attempt < 40; attempt++) {
    const from = cells[Math.floor(rng() * cells.length)];
    let x = from.x;
    let y = from.y;
    let dir = Math.floor(rng() * 4);

    const route = [];
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const key = `${x},${y},${dir}`;
      if (seen.has(key)) break;
      seen.add(key);
      route.push({ x, y });
      const nx = x + step[dir].dx;
      const ny = y + step[dir].dy;
      if (open(nx, ny)) {
        x = nx;
        y = ny;
      } else {
        dir = (dir + 2) % 4;
        // Nowhere to go in either direction: this dog is in a cupboard, not on patrol.
        if (!open(x + step[dir].dx, y + step[dir].dy)) {
          route.length = 0;
          break;
        }
      }
    }
    // A route of one or two squares is a dog jiggling on the spot, which reads as a bug.
    if (route.length >= 4) return { route, phase: Math.floor(rng() * route.length) };
  }
  return null;
}

function candidate(seed, spec) {
  const rng = makeRng(seed);
  const g = layout(rng, spec.size, spec.hazards);
  const cells = openCells(g);
  if (cells.length < 8) return null;

  // Not on the boundary: a dog that starts facing out of the park has no puzzle to solve,
  // only a tile to spend cancelling the situation she was handed.
  const inner = cells.filter(
    (c) => c.x > 0 && c.y > 0 && c.x < spec.size - 1 && c.y < spec.size - 1,
  );
  if (inner.length < 4) return null;
  const start = inner[Math.floor(rng() * inner.length)];
  const goalCell = cells[Math.floor(rng() * cells.length)];
  if (start.x === goalCell.x && start.y === goalCell.y) return null;
  // Far enough apart that the answer is not "walk forwards".
  if (Math.abs(start.x - goalCell.x) + Math.abs(start.y - goalCell.y) < 3) return null;
  g[goalCell.y][goalCell.x] = GOAL;

  const patrols = [];
  for (let i = 0; i < spec.patrols; i++) {
    const p = bouncePatrol(rng, g);
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

/** Every square a run actually stands on. Jumped-over squares are not visited. */
function pathOf(level, taps) {
  const run = replay(level, taps);
  return new Set((run.trail ?? []).map((t) => `${t.x},${t.y}`));
}

/**
 * Close off the other ways round.
 *
 * Accepting or rejecting whole boards leaves uniqueness to luck, and past the early levels
 * luck runs out — most generated boards have two or three answers. This does what a person
 * would do instead: look at where the *other* solutions go, and put a hedge in the way.
 *
 * A hedge on a square the intended route never stands on cannot disturb that route. She
 * only ever interacts with a square by moving into it, and if she had moved into it, it
 * would be on her path. (A jump is checked at the landing square only, so walling the
 * square she sails over is safe too.) Everything is re-graded afterwards regardless — the
 * argument is why this usually works, not why it is allowed.
 *
 * Squares under a patrol are off limits: patrol routes are precomputed, and a wall dropped
 * on one would leave a dog walking through a hedge.
 */
function carve(level, spec) {
  const forbidden = new Set([`${level.start.x},${level.start.y}`, `${level.goal.x},${level.goal.y}`]);
  for (const patrol of level.patrols) for (const c of patrol.route) forbidden.add(`${c.x},${c.y}`);

  const setCell = (x, y, ch) => {
    const row = level.terrain[y];
    level.terrain[y] = row.slice(0, x) + ch + row.slice(x + 1);
  };

  let best = grade(level, 3);
  for (let pass = 0; pass < 14 && best.count > 1; pass++) {
    const found = solutions(level, 4);
    if (found.length <= 1) break;
    const intended = pathOf(level, found[0]);

    let carved = false;
    for (const alt of found.slice(1)) {
      for (const square of pathOf(level, alt)) {
        if (intended.has(square) || forbidden.has(square)) continue;
        const [x, y] = square.split(',').map(Number);
        if (level.terrain[y][x] !== '.' && level.terrain[y][x] !== ',') continue;

        const was = level.terrain[y][x];
        setCell(x, y, WALL);
        const after = grade(level, 3);
        // Keep it only if the level is still the level: same solvable shape, fewer answers.
        if (after.solvable && after.first.length === spec.tiles && after.count < best.count) {
          best = after;
          carved = true;
          break;
        }
        setCell(x, y, was);
      }
      if (carved) break;
    }
    if (!carved) break;
  }
  return best;
}

/**
 * Is this candidate the level we wanted?
 *
 * The load-bearing condition is that it must need **every** tile, and checking that the
 * *intended* solution uses them all is not enough — that only says one route needs six, not
 * that no route needs four. A board where the dog can stroll home on four of her six tiles
 * is a four-tile level wearing a six-tile badge, and it is exactly what you notice when you
 * arrive at the parent with arrows still in hand wondering what they were for.
 *
 * So the check is the other way round: is there *any* way to get home with tiles left? One
 * is enough to throw the board away.
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

  // Wall off the other routes rather than throwing the board away for having them.
  const carved = carve(level, spec);
  if (!carved.solvable || carved.first.length !== spec.tiles) return null;

  // Done last: it is the most expensive question, and carving can introduce a shortcut by
  // shortening a route it did not mean to touch.
  if (findShortcut(level)) return null;
  return carved;
}

/**
 * Build level N.
 *
 * Prefers a unique solution and will spend most of its attempt budget looking for one, but
 * takes a two- or three-solution level over failing: past the early levels, boards that
 * admit exactly one answer get genuinely scarce, and a level with two answers is still a
 * good level — it just has two things worth sharing.
 */
export function buildLevel(level, { attempts = 1200, maxMs = 2500 } = {}) {
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
    lv.solution = g.first;
    if (g.unique) return lv;
    // Keep the tidiest near-miss in case nothing unique turns up.
    if (!fallback || g.count < fallback.solutions) fallback = lv;
  }
  return fallback;
}
