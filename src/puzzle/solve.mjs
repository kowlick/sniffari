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
 * Can the dog get home with tiles still in the queue?
 *
 * If she can, the level is broken, however pretty it looks. The tile count is the level's
 * statement about how hard it is, and a board that can be finished on four of its six tiles
 * is a four-tile level wearing a six-tile badge — you reach the parent with a fistful of
 * arrows and no idea what they were for.
 *
 * Cheap, because it only ever needs the first one: a single shortcut is enough to reject
 * the candidate, and most broken boards give one up almost immediately.
 */
export function findShortcut(level) {
  const maxTick = level.stamina + 2;
  let shortcut = null;

  const walk = (run) => {
    if (shortcut) return;
    if (run.outcome !== OUTCOME.RUNNING) {
      if (run.outcome === OUTCOME.WON && run.used < level.queue.length) shortcut = [...run.taps];
      return;
    }
    if (run.tick > maxTick) return;

    if (run.used < level.queue.length && tapTarget(level, run)) {
      const withTap = clone(run);
      tap(level, withTap);
      step(level, withTap);
      walk(withTap);
      if (shortcut) return;
    }
    const held = clone(run);
    step(level, held);
    walk(held);
  };

  walk(clone(createRun(level)));
  return shortcut;
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
