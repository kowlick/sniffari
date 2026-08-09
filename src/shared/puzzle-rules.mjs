/**
 * Heel — the rules of the solo puzzle.
 *
 * Plain JavaScript, not TypeScript, and that is deliberate. `public/` is served as-is with
 * no build step, so it cannot import from `src/` — but it *can* import a `.mjs` file the
 * server chooses to serve. This module is loaded by the browser, by the level generator and
 * by the tests, so all three run the identical bytes. The alternative was a second copy of
 * the movement rules living in `public/`, drifting quietly away from this one.
 *
 * The same discipline as `src/sim/simulate.ts` applies and matters more here, because the
 * whole game rests on it: **no clock, no random source, no network**. A level is a pure
 * function of its number, and a solution is a pure function of the taps. That is what lets
 * two people on opposite sides of the world compare notes on level 47.
 */

/** 0=N, 1=E, 2=S, 3=W — clockwise, so a right turn is (d + 1) % 4. Same as the party game. */
export const DIRS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

export const WALL = '#';
export const GOAL = 'P';
/** Terrain that ends the run the moment the dog arrives on it. */
export const HAZARD_TERRAIN = new Set(['~', 'D', 'Q']);

export const OUTCOME = {
  RUNNING: 'running',
  WON: 'won',
  /** Walked into water, a drain, or the squirrel tree. */
  LOST_HAZARD: 'lost-hazard',
  /** Came within a tile of another dog. */
  LOST_DOG: 'lost-dog',
  /** Ran out of steps without reaching the parent. */
  LOST_TIRED: 'lost-tired',
};

const at = (level, x, y) =>
  x < 0 || y < 0 || x >= level.width || y >= level.height ? WALL : level.terrain[y][x];

const walkable = (level, x, y) => at(level, x, y) !== WALL;

/** Tiles may only be placed on open ground — same rule as the party game. */
export const placeable = (level, x, y) => {
  const t = at(level, x, y);
  return t === '.' || t === ',';
};

/**
 * Where a patrolling dog stands on a given tick.
 *
 * A route is a closed loop of tiles walked one per tick, so a patrol's whole future is
 * `route[(tick + phase) % route.length]`. Deliberately this simple: the player has to be
 * able to look at the board and know where everything will be in six ticks, or the puzzle
 * is guesswork rather than planning. It also means the renderer can draw the whole route.
 */
export const patrolAt = (patrol, tick) =>
  patrol.route[(tick + patrol.phase) % patrol.route.length];

/** Same tile or orthogonally touching. Diagonals do not count — too hard to read on a grid. */
const meets = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by) <= 1;

/**
 * Note the dog's position for the renderer.
 *
 * A null trail means nobody is watching — the solver explores millions of nodes and copying
 * a growing array into each one was most of the cost of a branch.
 */
const record = (run) => {
  if (run.trail) run.trail.push({ x: run.x, y: run.y, dir: run.dir, tick: run.tick });
};

export function createRun(level) {
  return {
    x: level.start.x,
    y: level.start.y,
    dir: level.start.dir,
    jumpArmed: false,
    tick: 0,
    /** Steps left. A puzzle's stamina is a move budget, not a pacing device. */
    steps: level.stamina,
    /** Placed and not yet fired. Keyed "x,y". Single use, exactly as in the party game. */
    tiles: new Map(),
    /** How far down the queue we are. */
    used: 0,
    taps: [],
    outcome: OUTCOME.RUNNING,
    trail: [{ x: level.start.x, y: level.start.y, dir: level.start.dir, tick: 0 }],
  };
}

/**
 * The square a tap would drop a tile on: the one directly ahead of the dog.
 *
 * Returns null when that square cannot take a tile — a wall, off the board, already
 * occupied. The tap is then refused and the queue does not advance, so a mistimed tap costs
 * you nothing but the tick you were hoping to use.
 */
export function tapTarget(level, run) {
  if (run.outcome !== OUTCOME.RUNNING || run.used >= level.queue.length) return null;
  const { dx, dy } = DIRS[run.dir];
  const x = run.x + dx;
  const y = run.y + dy;
  if (!placeable(level, x, y)) return null;
  if (run.tiles.has(`${x},${y}`)) return null;
  return { x, y, kind: level.queue[run.used] };
}

/** Drop the next queued tile in front of the dog. Returns the square, or null if refused. */
export function tap(level, run) {
  const target = tapTarget(level, run);
  if (!target) return null;
  run.tiles.set(`${target.x},${target.y}`, target.kind);
  run.used += 1;
  run.taps.push(run.tick);
  return target;
}

/**
 * Which way a blocked dog turns: straight back the way she came.
 *
 * The party game looks both ways and picks the roomier side, and Heel deliberately does
 * not. Reversing is the rule a player can apply without thinking, and in a puzzle that is
 * the whole point — every tick has to be predictable several moves ahead or you are
 * guessing rather than planning.
 *
 * It is also the rule that would be *wrong* on the party board, for a reason that inverts
 * here. There, reversing collapses a dog's path to a single row and loop detection culls
 * it (DESIGN.md §4.6). Here the oscillation is a feature: a dog bouncing between two walls
 * is a dog holding still and waiting, and the player is the thing that breaks the loop, at
 * the moment of their choosing, with a tile.
 */
const turnAtWall = (run) => (run.dir + 2) % 4;

/**
 * Advance one tick. Mutates `run` and returns it.
 *
 * Order matters and mirrors the party sim: intent, blocking, movement, arrival, then the
 * budget. Patrols are resolved to their new positions *before* the meeting check, so what
 * you see at the end of a tick is exactly what the rules judged.
 */
export function step(level, run) {
  if (run.outcome !== OUTCOME.RUNNING) return run;

  run.tick += 1;
  const distance = run.jumpArmed ? 2 : 1;
  run.jumpArmed = false;

  const { dx, dy } = DIRS[run.dir];
  const tx = run.x + dx * distance;
  const ty = run.y + dy * distance;

  if (!walkable(level, tx, ty)) {
    // Blocked: the dog turns and the tick is spent. A jump into a wall simply fails.
    run.dir = turnAtWall(run);
  } else {
    run.x = tx;
    run.y = ty;

    const terrain = at(level, run.x, run.y);
    if (terrain === GOAL) {
      run.outcome = OUTCOME.WON;
      record(run);
      return run;
    }
    if (HAZARD_TERRAIN.has(terrain)) {
      run.outcome = OUTCOME.LOST_HAZARD;
      record(run);
      return run;
    }

    // A tile fires once and is spent.
    const k = `${run.x},${run.y}`;
    const tile = run.tiles.get(k);
    if (tile !== undefined) {
      run.tiles.delete(k);
      if (tile === 'J') run.jumpArmed = true;
      else run.dir = 'NESW'.indexOf(tile);
    }
  }

  // Meeting another dog ends the walk. Checked after everything has moved, so the board on
  // screen at the end of the tick is the board the rule was applied to.
  for (const patrol of level.patrols) {
    const p = patrolAt(patrol, run.tick);
    if (meets(run.x, run.y, p.x, p.y)) {
      run.outcome = OUTCOME.LOST_DOG;
      record(run);
      return run;
    }
  }

  run.steps -= 1;
  if (run.steps <= 0) run.outcome = OUTCOME.LOST_TIRED;
  record(run);
  return run;
}

/**
 * Replay a whole attempt from a list of tap ticks.
 *
 * `taps` are the tick numbers *at which the button was pressed* — a tap before tick n
 * places the tile the dog then walks onto during tick n+1. This is the canonical form of a
 * solution: it is what gets shared, and it is what the solver searches over.
 */
export function replay(level, taps) {
  const run = createRun(level);
  const pending = [...taps].sort((a, b) => a - b);
  let i = 0;
  while (run.outcome === OUTCOME.RUNNING) {
    while (i < pending.length && pending[i] === run.tick) {
      tap(level, run);
      i++;
    }
    step(level, run);
    if (run.tick > level.stamina + 4) break; // belt and braces; steps should end it first
  }
  return run;
}

/** A win that used every tile in the queue. Leftovers mean it was not the intended route. */
export const solved = (level, run) => run.outcome === OUTCOME.WON && run.used === level.queue.length;
