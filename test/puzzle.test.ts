import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLevel, difficultyFor } from '../src/puzzle/generate.mjs';
import { findShortcut, grade, solutions } from '../src/puzzle/solve.mjs';
import {
  OUTCOME,
  createRun,
  patrolAt,
  replay,
  solved,
  step,
  tap,
  tapTarget,
} from '../src/shared/puzzle-rules.mjs';

/**
 * Levels are a pure function of their number, and everything else rests on it. An endless
 * supply of levels only works if level 4,912 is the same board for everybody, and a shared
 * solution means nothing the moment that stops being true.
 */
test('level N is the same board every time it is built', () => {
  for (const n of [1, 7, 23]) {
    const a = buildLevel(n);
    const b = buildLevel(n);
    assert.ok(a && b, `level ${n} should build`);
    assert.deepEqual(a, b, `level ${n} differed between builds`);
  }
});

test('the recorded solution gets the dog home, using every tile', () => {
  for (let n = 1; n <= 14; n++) {
    const level = buildLevel(n);
    assert.ok(level, `level ${n} should build`);
    const g = grade(level, 2);
    assert.ok(g.solvable, `level ${n} has no solution`);
    const run = replay(level, g.first!);
    assert.ok(solved(level, run), `level ${n}: the solution does not win`);
    assert.equal(run.used, level.queue.length, `level ${n}: tiles left over`);
  }
});

/** A level solvable by doing nothing teaches the player that the button is optional. */
test('no level can be solved by never tapping', () => {
  for (let n = 1; n <= 14; n++) {
    const level = buildLevel(n)!;
    assert.equal(solved(level, replay(level, [])), false, `level ${n} solves itself`);
  }
});

test('the first levels are short enough to learn from', () => {
  for (let n = 1; n <= 3; n++) {
    const level = buildLevel(n)!;
    const run = replay(level, grade(level, 1).first!);
    assert.ok(run.tick <= 10, `level ${n} takes ${run.tick} ticks, too long to read`);
    assert.equal(level.queue.length, 1, `level ${n} should be a single tile`);
  }
});

test('the difficulty ramp only ever climbs', () => {
  let prev = difficultyFor(1);
  for (let n = 2; n <= 200; n++) {
    const d = difficultyFor(n);
    assert.ok(d.size >= prev.size, `board shrank at ${n}`);
    assert.ok(d.tiles >= prev.tiles, `tiles dropped at ${n}`);
    assert.ok(d.patrols >= prev.patrols, `patrols dropped at ${n}`);
    assert.ok(d.slack <= prev.slack, `slack grew at ${n}`);
    prev = d;
  }
});

/**
 * The step budget is what stops a level being solvable by blundering. Generated loose and
 * then cut down to the length of the actual route — see `shaped` in generate.mjs.
 */
test('the step budget is tight enough that wandering loses', () => {
  for (let n = 1; n <= 12; n++) {
    const level = buildLevel(n)!;
    const run = replay(level, grade(level, 1).first!);
    assert.ok(
      level.stamina <= run.tick + 8,
      `level ${n}: ${level.stamina} steps for a ${run.tick}-tick route`,
    );
  }
});

// --- the rules themselves ---------------------------------------------------------------

const flat = (rows: string[], queue: string[], start: { x: number; y: number; dir: number }) => ({
  level: 0,
  seed: 0,
  width: rows[0]!.length,
  height: rows.length,
  terrain: rows,
  start,
  goal: { x: 0, y: 0 },
  queue,
  patrols: [] as { route: { x: number; y: number }[]; phase: number }[],
  stamina: 20,
  solutions: 1,
  par: queue.length,
});

test('a tap drops the tile directly ahead, and it fires exactly once', () => {
  const level = flat(['#####', '#...#', '#.P.#', '#####'], ['S'], { x: 1, y: 1, dir: 1 });
  const run = createRun(level);
  const target = tapTarget(level, run);
  assert.deepEqual({ x: target!.x, y: target!.y }, { x: 2, y: 1 }, 'the square ahead');
  tap(level, run);
  assert.equal(run.used, 1);
  step(level, run);
  assert.equal(run.tiles.size, 0, 'a tile fires once and is spent');
  assert.equal(run.dir, 2, 'and it turned the dog south');
});

test('a tap with nowhere to put the tile is refused and costs nothing', () => {
  const level = flat(['####', '#.P#', '####'], ['N'], { x: 1, y: 1, dir: 3 });
  const run = createRun(level);
  assert.equal(tapTarget(level, run), null, 'a wall ahead');
  assert.equal(tap(level, run), null);
  assert.equal(run.used, 0, 'the queue did not advance');
});

/**
 * The same square, and nothing looser. Adjacency made every patrol a moving five-tile
 * exclusion zone and put most of the board out of bounds.
 */
test('landing on another dog ends the walk; passing beside it does not', () => {
  const shared = (route: { x: number; y: number }[], phase: number) => ({
    ...flat(['#####', '#...#', '#...#', '#####'], [], { x: 1, y: 1, dir: 1 }),
    patrols: [{ route, phase }],
  });

  // Phase 1 puts the patrol on (2,1) at the end of tick 1 — the square the dog steps onto.
  const onto = createRun(shared([{ x: 2, y: 1 }, { x: 3, y: 1 }], 1));
  step(shared([{ x: 2, y: 1 }, { x: 3, y: 1 }], 1), onto);
  assert.equal(onto.outcome, OUTCOME.LOST_DOG);

  // Directly below her, touching, and entirely safe.
  const beside = shared([{ x: 2, y: 2 }, { x: 3, y: 2 }], 1);
  const run = createRun(beside);
  step(beside, run);
  assert.equal(run.outcome, OUTCOME.RUNNING, 'brushing past is allowed');
});

/**
 * There is no fence. The park just stops, and a dog that keeps walking keeps walking —
 * which is what makes the boundary something to steer away from rather than a free turn.
 */
test('walking off the edge ends the round, and she is last seen outside', () => {
  const level = flat([',,,', ',,,', ',,,'], [], { x: 1, y: 1, dir: 3 });
  const run = createRun(level);
  step(level, run); // to (0,1)
  assert.equal(run.outcome, OUTCOME.RUNNING);
  step(level, run); // out of the park
  assert.equal(run.outcome, OUTCOME.LOST_ESCAPED);
  assert.equal(run.x, -1, 'her position is recorded outside, so she can be drawn leaving');
});

/** A patrol's whole future is on the board. The puzzle is planning, not memory. */
test('a patrol is where it says it will be, forever', () => {
  const patrol = {
    route: [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 2, y: 1 },
    ],
    phase: 0,
  };
  for (const t of [0, 4, 8, 400]) assert.deepEqual(patrolAt(patrol, t), { x: 1, y: 1 });
  assert.deepEqual(patrolAt(patrol, 402), { x: 3, y: 1 });
});

test('running out of steps loses', () => {
  const level = { ...flat(['#####', '#...#', '#####'], [], { x: 1, y: 1, dir: 1 }), stamina: 3 };
  assert.equal(replay(level, []).outcome, OUTCOME.LOST_TIRED);
});

test('every schedule the solver reports is a distinct, winning one', () => {
  const level = flat(['######', '#....#', '#....#', '#...P#', '######'], ['S'], {
    x: 1,
    y: 1,
    dir: 1,
  });
  level.goal = { x: 4, y: 3 };
  const found = solutions(level, 9);
  assert.ok(found.length > 0, 'this board should be solvable');
  for (const taps of found) {
    assert.ok(solved(level, replay(level, taps)), `reported schedule ${taps} does not win`);
  }
  assert.equal(
    new Set(found.map((f: number[]) => f.join(','))).size,
    found.length,
    'the same schedule was reported twice',
  );
});

/**
 * The tile count is the level's claim about how hard it is. A board finishable on four of
 * its six tiles is a four-tile level wearing a six-tile badge — and you find out by
 * arriving at the parent with arrows still in hand, wondering what they were for.
 *
 * Checking that the *intended* route needs all six is not enough: that says one route needs
 * six, not that no route needs four. So the question is asked the other way round.
 */
test('no level can be finished with tiles left in the queue', () => {
  for (let n = 1; n <= 16; n++) {
    const level = buildLevel(n)!;
    const shortcut = findShortcut(level);
    assert.equal(
      shortcut,
      null,
      `level ${n} can be solved with tiles left over, by tapping on ${shortcut?.join(', ')}`,
    );
  }
});

/**
 * An arrow pointing the way she is already going does nothing. The rules refuse the
 * placement outright, which is what stops a level being generated whose answer is "drop
 * three up arrows in a row".
 */
test('a tile that would change nothing cannot be placed', () => {
  const level = flat([',,,,', ',,,,'], ['E'], { x: 0, y: 0, dir: 1 });
  const run = createRun(level);
  assert.equal(tapTarget(level, run), null, 'east, while already heading east');

  // Facing north, the same east arrow is a real turn and goes down fine.
  const turning = flat([',,,,', ',,,,'], ['E'], { x: 1, y: 1, dir: 0 });
  const other = createRun(turning);
  assert.ok(tapTarget(turning, other), 'east, while heading north');

  // A jump is never a no-op: it changes the next move whatever she is doing.
  const jump = flat([',,,,', ',,,,'], ['J'], { x: 0, y: 0, dir: 1 });
  assert.ok(tapTarget(jump, createRun(jump)), 'a jump always does something');
});

test('no level asks for a tile that would change nothing', () => {
  for (let n = 1; n <= 16; n++) {
    const level = buildLevel(n)!;
    const run = createRun(level);
    const wanted = [...(level.solution ?? [])].sort((a: number, b: number) => a - b);
    let i = 0;
    while (run.outcome === OUTCOME.RUNNING && run.tick <= level.stamina + 2) {
      while (i < wanted.length && wanted[i] === run.tick) {
        assert.ok(
          tapTarget(level, run),
          `level ${n}: the intended solution taps on tick ${run.tick}, which the rules refuse`,
        );
        tap(level, run);
        i++;
      }
      step(level, run);
    }
    assert.equal(i, wanted.length, `level ${n}: not every intended tap was taken`);
  }
});

/**
 * Uniqueness is the ideal and is not always reachable, so this asserts the *rate* rather
 * than each level. The generator walls off alternative routes rather than discarding boards
 * that have them; if that stops working this is what notices.
 */
test('most levels have exactly one solution', () => {
  let unique = 0;
  const total = 16;
  for (let n = 1; n <= total; n++) if (buildLevel(n)!.solutions === 1) unique++;
  assert.ok(unique >= total * 0.7, `only ${unique}/${total} levels have a single solution`);
});
