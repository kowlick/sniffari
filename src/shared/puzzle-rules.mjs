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
  /** Something on the board caught her: the water, a drain, the squirrel up its tree. */
  LOST_HAZARD: 'lost-hazard',
  /** Stepped onto the same square as another dog. */
  LOST_DOG: 'lost-dog',
  /** Ran out of steps without reaching the parent. */
  LOST_TIRED: 'lost-tired',
  /** Walked clean off the edge of the park. */
  LOST_ESCAPED: 'lost-escaped',
  /** Jumped straight into a hedge. Walking into one is a turn; jumping into one is not. */
  LOST_CRASH: 'lost-crash',
};

/** Null means off the board entirely, which is a very different thing from a wall. */
const at = (level, x, y) =>
  x < 0 || y < 0 || x >= level.width || y >= level.height ? null : level.terrain[y][x];

const onBoard = (level, x, y) => at(level, x, y) !== null;
/** Blocked *within* the board. Walking off the edge is not blocked; it is an ending. */
const walkable = (level, x, y) => {
  const t = at(level, x, y);
  return t !== null && t !== WALL;
};

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

/**
 * The same square, and nothing looser.
 *
 * This was orthogonal adjacency, which made every patrol a moving five-tile exclusion zone
 * and turned most of the board into somewhere you could not be. Landing on the same square
 * is the rule you can see: two dogs, one tile.
 */
const meets = (ax, ay, bx, by) => ax === bx && ay === by;

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
 * The square a tap would drop a tile on: **the one she is about to step onto**.
 *
 * Normally that is the square directly ahead. With a jump armed it is two ahead, because
 * that is where she lands — a tile dropped on the square in between would be sailed over
 * and never fire, which looks like the game swallowing your tile.
 *
 * Returns null when the square cannot take a tile: a wall, off the board, or already
 * occupied. The tap is then refused and the queue does not advance, so a mistimed press
 * costs nothing but the moment.
 */
export function tapTarget(level, run) {
  if (run.outcome !== OUTCOME.RUNNING || run.used >= level.queue.length) return null;

  /*
   * An arrow pointing the way she is already going does nothing at all.
   *
   * She travels in a straight line to the square the tile lands on, so her heading when she
   * gets there is her heading now — and a tile that sets it to what it already is has been
   * spent on nothing. Refusing the placement is better than allowing it: it keeps a wasted
   * tile out of the queue, it keeps the solver from reporting solutions padded with
   * no-ops, and it stops levels being generated whose answer is "drop three up arrows in a
   * row". A jump is never a no-op; it always changes the next move.
   */
  const kind = level.queue[run.used];
  if (kind !== 'J' && 'NESW'.indexOf(kind) === run.dir) return null;

  const distance = run.jumpArmed ? 2 : 1;
  const { dx, dy } = DIRS[run.dir];
  const x = run.x + dx * distance;
  const y = run.y + dy * distance;
  if (!placeable(level, x, y)) return null;
  if (run.tiles.has(`${x},${y}`)) return null;
  return { x, y, kind };
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
  // Where she set off from this tick, so a head-on meeting can be spotted.
  const fromX = run.x;
  const fromY = run.y;

  const { dx, dy } = DIRS[run.dir];
  const tx = run.x + dx * distance;
  const ty = run.y + dy * distance;

  // Off the edge. There is no fence any more: the park simply stops, and a dog that keeps
  // walking keeps walking. Her position is recorded *outside* the board so the client can
  // animate her going, rather than her vanishing at the boundary.
  if (!onBoard(level, tx, ty)) {
    run.x = tx;
    run.y = ty;
    run.outcome = OUTCOME.LOST_ESCAPED;
    record(run);
    return run;
  }

  if (!walkable(level, tx, ty)) {
    if (distance > 1) {
      /*
       * A jump into a hedge ends the round.
       *
       * Walking into one is a turn — she is on her feet and can see it coming. A jump is a
       * commitment made a tile earlier, and the whole point of committing is that it can be
       * wrong. Without this a jump was strictly safe: mistimed, it quietly failed and she
       * turned round, so there was never a reason not to throw one.
       *
       * Her position is set to the square she hit, so she is seen landing in it rather than
       * stopping short of a wall for no visible reason.
       */
      run.x = tx;
      run.y = ty;
      run.outcome = OUTCOME.LOST_CRASH;
      record(run);
      return run;
    }
    // Walking into it: she turns, and the tick is spent.
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

  /*
   * Meeting another dog ends the walk.
   *
   * Two ways to meet, and the second one is easy to miss. Landing on the same square is the
   * obvious one. But two dogs on neighbouring squares walking *into* each other end the
   * tick having swapped places — never sharing a square, and so passing clean through one
   * another if you only compare final positions. They met in the middle.
   *
   * A jump is unaffected: a patrol moves one square a tick, so it can never swap with a dog
   * that moved two. Sailing over another dog stays safe, which is most of what jumps are for.
   */
  for (const patrol of level.patrols) {
    const now = patrolAt(patrol, run.tick);
    const before = patrolAt(patrol, run.tick - 1);
    const sameSquare = meets(run.x, run.y, now.x, now.y);
    const swapped =
      before.x === run.x && before.y === run.y && now.x === fromX && now.y === fromY;
    if (sameSquare || swapped) {
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
