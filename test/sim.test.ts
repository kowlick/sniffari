import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CONFIG } from '../src/config.ts';
import { turnRight } from '../src/sim/directions.ts';
import { loadMap, parseMap } from '../src/sim/map.ts';
import { simulateWalk } from '../src/sim/simulate.ts';
import { DIR, TILE, key, type DogInit, type PlacedTile } from '../src/sim/types.ts';

const ROOT = join(import.meta.dirname, '..');
const tiles = (...entries: [number, number, PlacedTile['kind'], boolean?][]) =>
  new Map<string, PlacedTile>(
    entries.map(([x, y, kind, secret]) => [key(x, y), { kind, ownerId: 'p', secret: secret ?? false }]),
  );
const dog = (x: number, y: number, dir: DogInit['dir'], id = 'a'): DogInit => ({
  id,
  breed: 'test',
  x,
  y,
  dir,
});

// --- turning ----------------------------------------------------------------------------

test('a right turn is relative to the dog, not the screen', () => {
  // Walking down the screen and turning right puts the dog's nose to screen-left.
  assert.equal(turnRight(DIR.S), DIR.W);
  assert.equal(turnRight(DIR.N), DIR.E);
  assert.equal(turnRight(DIR.E), DIR.S);
  assert.equal(turnRight(DIR.W), DIR.N);
});

test('a dog blocked by a wall turns right and stays put for that tick', () => {
  const map = parseMap(['#####', '#1..#', '#####'].join('\n'));
  const result = simulateWalk(map, [dog(3, 1, DIR.E)], tiles());
  const t1 = result.ticks[1]!.dogs[0]!;
  assert.deepEqual([t1.x, t1.y], [3, 1], 'did not move');
  assert.equal(t1.dir, DIR.S, 'east into a wall becomes south');
});

// --- tiles -------------------------------------------------------------------------------

test('a direction tile changes heading on the tick after arrival', () => {
  const map = parseMap(['#####', '#1..#', '#...#', '#...#', '#####'].join('\n'));
  const result = simulateWalk(map, [dog(1, 1, DIR.E)], tiles([2, 1, TILE.S]));
  assert.deepEqual(pos(result, 1), [2, 1], 'steps onto the tile');
  assert.deepEqual(pos(result, 2), [2, 2], 'then turns south');
});

test('a jump clears the tile in between, including a wall', () => {
  const map = parseMap(['#######', '#1.#..#', '#######'].join('\n'));
  const result = simulateWalk(map, [dog(1, 1, DIR.E)], tiles([2, 1, TILE.JUMP]));
  assert.deepEqual(pos(result, 1), [2, 1], 'arms the jump');
  assert.deepEqual(pos(result, 2), [4, 1], 'lands two tiles on, over the wall');
  assert.equal(result.ticks[2]!.dogs[0]!.jumped, true);
});

test('a jump into a blocked landing tile fails and the dog turns right', () => {
  const map = parseMap(['#####', '#1.##', '#...#', '#####'].join('\n'));
  const result = simulateWalk(map, [dog(1, 1, DIR.E)], tiles([2, 1, TILE.JUMP]));
  assert.deepEqual(pos(result, 2), [2, 1], 'stayed put');
  assert.equal(result.ticks[2]!.dogs[0]!.dir, DIR.S, 'turned right instead');
});

test('a direction tile is consumed the first time it fires', () => {
  // A ring corridor: without consumption the dog would be turned by this tile on every lap.
  const map = parseMap(['#####', '#1..#', '#.#.#', '#...#', '#####'].join('\n'));
  const result = simulateWalk(map, [dog(1, 1, DIR.E)], tiles([2, 1, TILE.S]));
  const consumed = result.ticks.flatMap((t) => t.events).filter((e) => e.t === 'consume');
  assert.equal(consumed.length, 1, 'fires exactly once however many times it is stepped on');
  assert.deepEqual([consumed[0]!.x, consumed[0]!.y], [2, 1]);
  assert.equal(consumed[0]!.kind, TILE.S);
});

test('bookending a dog with opposing arrows only holds it for two turns', () => {
  // The exploit this rule exists to kill: two players trap a dog between facing arrows so
  // it ping-pongs forever and its round ends on the spot. With single-use tiles it is
  // redirected twice, spends both, and walks out the far side.
  //   x:      1 2 3 4 5 6 7 8 9 10 11
  //   arrows:       E     ^   W     sniff at 10
  const map = parseMap(['#############', '#.....1...S.#', '#############'].join('\n'));
  const result = simulateWalk(map, [dog(6, 1, DIR.E)], tiles([8, 1, TILE.W], [4, 1, TILE.E]));

  const consumed = result.ticks.flatMap((t) => t.events).filter((e) => e.t === 'consume');
  assert.equal(consumed.length, 2, 'both tiles spend themselves');

  const furthestEast = Math.max(...result.ticks.map((t) => t.dogs[0]!.x));
  assert.ok(furthestEast > 8, `escaped past the east arrow (reached ${furthestEast})`);
  assert.ok(result.scores[0]!.score > 0, 'and got on with scoring');
});

test('a jump tile is consumed too', () => {
  const map = parseMap(['#######', '#1.#..#', '#######'].join('\n'));
  const result = simulateWalk(map, [dog(1, 1, DIR.E)], tiles([2, 1, TILE.JUMP]));
  const consumed = result.ticks.flatMap((t) => t.events).filter((e) => e.t === 'consume');
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0]!.kind, TILE.JUMP);
});

test('a scuff mark is a wall, not a tile, and is never consumed', () => {
  const map = parseMap(['#####', '#1..#', '#...#', '#####'].join('\n'));
  const result = simulateWalk(map, [dog(1, 1, DIR.E)], tiles([2, 1, TILE.SCUFF]));
  assert.equal(
    result.ticks.flatMap((t) => t.events).filter((e) => e.t === 'consume').length,
    0,
    'scuffs are permanent obstacles',
  );
});

test('a scuff mark blocks like a wall', () => {
  const map = parseMap(['#####', '#1..#', '#####'].join('\n'));
  const result = simulateWalk(map, [dog(1, 1, DIR.E)], tiles([2, 1, TILE.SCUFF]));
  assert.deepEqual(pos(result, 1), [1, 1]);
  assert.equal(result.ticks[1]!.dogs[0]!.dir, DIR.S);
});

test('a secret tile is revealed at the tick a dog steps on it', () => {
  const map = parseMap(['#####', '#1..#', '#...#', '#####'].join('\n'));
  const result = simulateWalk(map, [dog(1, 1, DIR.E)], tiles([2, 1, TILE.S, true]));
  const reveals = result.ticks.flatMap((t) => t.events).filter((e) => e.t === 'reveal');
  assert.equal(reveals.length, 1);
  assert.deepEqual([reveals[0]!.x, reveals[0]!.y], [2, 1]);
  // Revealing happens once, not on every subsequent pass.
  assert.equal(result.ticks[1]!.events.some((e) => e.t === 'reveal'), true);
});

// --- scoring -----------------------------------------------------------------------------

test('sniffs diminish: 2 for the first visit, 1 for the second, 0 after', () => {
  // A ring corridor, so one dog laps the same sniff spot repeatedly.
  const map = parseMap(['#####', '#1S.#', '#.#.#', '#...#', '#####'].join('\n'));
  const result = simulateWalk(map, [dog(1, 1, DIR.E)], tiles());
  const sniffs = result.ticks.flatMap((t) => t.events).filter((e) => e.t === 'sniff');
  assert.deepEqual(
    sniffs.map((e) => e.points).slice(0, 3),
    [2, 1, 0],
    'diminishing values in visit order',
  );
  assert.equal(result.scores[0]!.score, 3, 'total from one sniff spot is 2 + 1 + 0');
});

test('a treat is consumed by the first dog to reach it', () => {
  const map = parseMap(['#####', '#1P.#', '#...#', '#####'].join('\n'));
  const result = simulateWalk(map, [dog(1, 1, DIR.E)], tiles());
  const treats = result.ticks.flatMap((t) => t.events).filter((e) => e.t === 'treat');
  assert.equal(treats.length, 1, 'only ever collected once');
  assert.equal(treats[0]!.points, CONFIG.scoring.treat);
});

test('a squirrel scores big and ends the run; a lake costs points', () => {
  const map = parseMap(['#####', '#1Q.#', '#...#', '#####'].join('\n'));
  const squirrel = simulateWalk(map, [dog(1, 1, DIR.E)], tiles());
  assert.equal(squirrel.scores[0]!.stopped, 'squirrel');
  assert.equal(squirrel.scores[0]!.score, CONFIG.scoring.squirrel);

  const wet = parseMap(['#####', '#1~.#', '#...#', '#####'].join('\n'));
  const lake = simulateWalk(wet, [dog(1, 1, DIR.E)], tiles());
  assert.equal(lake.scores[0]!.stopped, 'lake');
  assert.equal(lake.scores[0]!.score, CONFIG.scoring.lake);
});

test('two dogs meeting head-on greet each other once and both turn right', () => {
  const map = parseMap(['#######', '#1...2#', '#######'].join('\n'));
  const result = simulateWalk(map, [dog(1, 1, DIR.E, 'a'), dog(5, 1, DIR.W, 'b')], tiles());
  const greets = result.ticks.flatMap((t) => t.events).filter((e) => e.t === 'greet');
  assert.equal(greets.length, 1, 'a pair greets at most once per round');
  assert.equal(greets[0]!.points, CONFIG.scoring.greet);
  for (const d of result.scores) assert.ok(d.score >= CONFIG.scoring.greet);
});

// --- the properties the whole design rests on ---------------------------------------------

test('the simulation is deterministic', async () => {
  const map = await loadMap(join(ROOT, 'maps', 'large.txt'), 'large');
  const dogs = map.starts.map((s, i) => dog(s.x, s.y, s.dir, `dog${i}`));
  const placed = tiles([13, 5, TILE.W], [5, 13, TILE.S], [21, 13, TILE.N], [13, 21, TILE.E]);

  const a = simulateWalk(map, dogs, placed);
  const b = simulateWalk(map, dogs, placed);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test('every dog always stops, on every start configuration', async () => {
  const map = await loadMap(join(ROOT, 'maps', 'large.txt'), 'large');
  // From 1: a solo dog skips dog-vs-dog blocking entirely, so it is its own code path.
  for (let n = 1; n <= 8; n++) {
    const dogs = map.starts.slice(0, n).map((s, i) => dog(s.x, s.y, s.dir, `dog${i}`));
    const result = simulateWalk(map, dogs, tiles());
    for (const s of result.scores) {
      assert.ok(s.stopped, `${n} dogs: ${s.dogId} never stopped`);
    }
    assert.ok(
      result.ticks.length <= CONFIG.sim.stamina + 3,
      `${n} dogs: ran ${result.ticks.length} ticks, past the stamina bound`,
    );
  }
});

test('a dog boxed in on all four sides gives up rather than spinning forever', () => {
  const map = parseMap(['###', '#1#', '###'].join('\n'));
  const result = simulateWalk(map, [dog(1, 1, DIR.E)], tiles());
  assert.equal(result.scores[0]!.stopped, 'stuck');
  assert.ok(result.ticks.length <= CONFIG.sim.stuckTurnsBeforeGiveUp + 2);
});

test('a dog going in circles is caught by loop detection, not by stamina', () => {
  // An empty ring with nothing to score: the classic runaway case.
  const map = parseMap(['######', '#1...#', '#.##.#', '#....#', '######'].join('\n'));
  const result = simulateWalk(map, [dog(1, 1, DIR.E)], tiles());
  assert.equal(result.scores[0]!.stopped, 'tail');
  assert.ok(
    result.ticks.length < CONFIG.sim.stamina,
    'should be cut short well before running out of stamina',
  );
});

function pos(result: ReturnType<typeof simulateWalk>, tick: number) {
  const d = result.ticks[tick]!.dogs[0]!;
  return [d.x, d.y];
}
