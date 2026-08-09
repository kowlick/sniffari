/**
 * Finding every way to solve a Heel level.
 *
 * A solution is a list of tick numbers — the moments the button was pressed. The queue is
 * fixed and ordered, so *when* you tap fully determines *what* goes *where*, which is why
 * this search is cheap enough to run on every generated candidate: it is a choice of n
 * ticks out of a run of T, not a choice of n squares out of a board.
 *
 *     ticks T=25, taps n=5   ->  C(25,5) = 53,130 leaf schedules
 *
 * and the depth-first walk shares every prefix, so the real node count is far lower. The
 * placement variant of this game would have to multiply that by 5^n for the tile kinds;
 * this one gets them for free from the queue order. That asymmetry is the reason Heel is
 * the variant that can afford to generate infinite levels on demand.
 */

import { OUTCOME, createRun, solved, step, tap, tapTarget } from '../shared/puzzle-rules.mjs';

/** Deep-copy a run. Small enough that structured cloning by hand beats being clever. */
function clone(run) {
  return {
    ...run,
    tiles: new Map(run.tiles),
    taps: [...run.taps],
    // The trail is only for drawing; the search does not need it and copying it is most of
    // the cost of a node.
    trail: null,
  };
}

/**
 * Every distinct tap schedule that solves the level, up to `limit`.
 *
 * Stops early once `limit` solutions are found — the generator only ever needs to know
 * "exactly one?", so there is no point enumerating a level that already has three.
 *
 * The branch is binary at each tick: tap, or don't. A tap that the rules would refuse (a
 * wall ahead, a tile already there) is not a branch at all, which prunes hard in exactly
 * the corridors where a naive search would blow up.
 */
export function solutions(level, limit = 2) {
  const found = [];
  const maxTick = level.stamina + 2;

  const walk = (run) => {
    if (found.length >= limit) return;
    if (run.outcome !== OUTCOME.RUNNING) {
      if (solved(level, run)) found.push([...run.taps]);
      return;
    }
    if (run.tick > maxTick) return;
    // Out of tiles and not home yet: nothing left to decide, so run it out rather than
    // branching pointlessly for the rest of the level.
    if (run.used >= level.queue.length) {
      const tail = run;
      while (tail.outcome === OUTCOME.RUNNING && tail.tick <= maxTick) step(level, tail);
      if (solved(level, tail)) found.push([...tail.taps]);
      return;
    }

    // Branch 1: tap now, if the rules allow it.
    if (tapTarget(level, run)) {
      const withTap = clone(run);
      tap(level, withTap);
      step(level, withTap);
      walk(withTap);
      if (found.length >= limit) return;
    }

    // Branch 2: hold.
    const held = clone(run);
    step(level, held);
    walk(held);
  };

  const root = clone(createRun(level));
  walk(root);
  return found;
}

/**
 * Is this level worth shipping?
 *
 * `unique` is the ideal and not always reachable — a level with two solutions is still a
 * good level, it just has two answers worth sharing. The generator prefers unique ones and
 * settles for few.
 */
export function grade(level, limit = 3) {
  const found = solutions(level, limit);
  return {
    count: found.length,
    unique: found.length === 1,
    solvable: found.length > 0,
    first: found[0] ?? null,
  };
}
