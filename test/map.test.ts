import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MapParseError, loadMap, mapStats, parseMap } from '../src/sim/map.ts';
import { DIR } from '../src/sim/types.ts';

const ROOT = join(import.meta.dirname, '..');

test('parses a map and strips start markers to street', () => {
  const map = parseMap(['#####', '#1.2#', '#####'].join('\n'), 'tiny');
  assert.equal(map.width, 5);
  assert.equal(map.height, 3);
  assert.deepEqual(map.starts[0], { x: 1, y: 1, dir: DIR.E });
  assert.deepEqual(map.starts[1], { x: 3, y: 1, dir: DIR.W });
  assert.equal(map.terrain[1 * 5 + 1], '.');
});

test('dogs start facing the middle of the board', () => {
  const map = parseMap(
    ['#####', '#.1.#', '#...#', '#.2.#', '#####'].join('\n'),
    'facing',
  );
  assert.equal(map.starts[0]!.dir, DIR.S, 'top start faces down');
  assert.equal(map.starts[1]!.dir, DIR.N, 'bottom start faces up');
});

test('rejects ragged rows and unknown characters', () => {
  assert.throws(() => parseMap(['####', '#1.#', '###'].join('\n')), MapParseError);
  assert.throws(() => parseMap(['####', '#1Z#', '####'].join('\n')), MapParseError);
});

test('ignores comments and blank lines', () => {
  const map = parseMap(['; a comment', '', '#####', '#1..#', '#####'].join('\n'));
  assert.equal(map.height, 3);
});

const BOARDS = [
  { file: 'small.txt', size: 10 },
  { file: 'medium.txt', size: 13 },
  { file: 'large.txt', size: 16 },
];

const loadBoards = () =>
  Promise.all(BOARDS.map(async (b) => ({ ...b, map: await loadMap(join(ROOT, 'maps', b.file), b.file) })));

test('all three shipped boards are the expected size with eight start slots', async () => {
  for (const { map, file, size } of await loadBoards()) {
    assert.equal(map.width, size, file);
    assert.equal(map.height, size, file);
    assert.equal(map.starts.length, 8, `${file}: eight start slots`);
  }
});

test('every walkable tile is reachable from every start', async () => {
  // Border baffles sit against the fence and can seal a pocket — including a corner storm
  // drain, which then cannot break perimeter loops. The generator repairs this; prove it.
  for (const { map, file } of await loadBoards()) {
    const idx = (x: number, y: number) => y * map.width + x;
    const walkable = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < map.width && y < map.height && map.terrain[idx(x, y)] !== '#';

    const start = map.starts[0]!;
    const seen = new Set([`${start.x},${start.y}`]);
    const queue = [[start.x, start.y] as const];
    while (queue.length) {
      const [x, y] = queue.pop()!;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (!walkable(nx, ny) || seen.has(`${nx},${ny}`)) continue;
        seen.add(`${nx},${ny}`);
        queue.push([nx, ny]);
      }
    }

    let total = 0;
    for (let y = 0; y < map.height; y++)
      for (let x = 0; x < map.width; x++) if (walkable(x, y)) total++;
    assert.equal(seen.size, total, `${file}: ${total - seen.size} walkable tiles are walled off`);
    for (const s of map.starts) assert.ok(seen.has(`${s.x},${s.y}`), `${file}: start ${s.x},${s.y} stranded`);
  }
});

test('the large board matches the densities in DESIGN.md §4.4', async () => {
  const map = await loadMap(join(ROOT, 'maps', 'large.txt'), 'large');
  const stats = mapStats(map);

  // Target ~75% walkable: the playfield is open, not a corridor maze.
  assert.ok(
    stats.walkableFraction > 0.65 && stats.walkableFraction < 0.85,
    `walkable fraction ${stats.walkableFraction.toFixed(2)} outside 0.65–0.85`,
  );
  // One stopper per ~67 walkable tiles. Far sparser than a maze wants: in the open, dogs
  // sweep fresh tiles every tick, so denser stoppers end half the field inside 4 seconds.
  assert.ok(
    stats.walkablePerStopper > 35 && stats.walkablePerStopper < 100,
    `one stopper per ${stats.walkablePerStopper.toFixed(1)} tiles, expected 35–100`,
  );
  // Expressed as fractions of walkable so these survive a change of map size.
  const sniffRate = stats.sniffs / stats.walkable;
  const peopleRate = stats.people / stats.walkable;
  assert.ok(sniffRate > 0.06 && sniffRate < 0.13, `sniffs are ${(sniffRate * 100).toFixed(1)}% of walkable`);
  assert.ok(peopleRate > 0.015 && peopleRate < 0.05, `people are ${(peopleRate * 100).toFixed(1)}% of walkable`);
});

test('obstacles are small clumps, never big blocks', async () => {
  const map = await loadMap(join(ROOT, 'maps', 'large.txt'), 'large');
  const solid = (x: number, y: number) => map.terrain[y * map.width + x] === '#';

  // Interior obstacles are 2x3 at most, so no interior wall tile may have solid
  // neighbours three deep in both axes — that would mean a 3x3 or larger mass.
  for (let y = 2; y < map.height - 2; y++) {
    for (let x = 2; x < map.width - 2; x++) {
      const wide = solid(x - 1, y) && solid(x, y) && solid(x + 1, y);
      const tall = solid(x, y - 1) && solid(x, y) && solid(x, y + 1);
      assert.ok(!(wide && tall), `obstacle at ${x},${y} is at least 3x3`);
    }
  }
});

// The generated-map suite (test/generate.test.ts) checks the same invariants across many
// seeds, which is what actually guards the game since every match generates its own map.
// These run against the three shipped files, which are the lobby preview.
test('no 1-wide corridors on any board', async () => {
  // What matters is a *run* of pinched tiles — a corridor a dog is committed to until the
  // next intersection. A single pinched square is fine and is exactly what a border baffle
  // is meant to create, so only runs of 3 or more count as a corridor.
  const MAX_RUN = 2;
  for (const { map, file } of await loadBoards()) {
    const solid = (x: number, y: number) =>
      x < 0 || y < 0 || x >= map.width || y >= map.height || map.terrain[y * map.width + x] === '#';
    const pinchedH = (x: number, y: number) => !solid(x, y) && solid(x, y - 1) && solid(x, y + 1);
    const pinchedV = (x: number, y: number) => !solid(x, y) && solid(x - 1, y) && solid(x + 1, y);

    for (let y = 1; y < map.height - 1; y++) {
      let run = 0;
      for (let x = 1; x < map.width - 1; x++) {
        run = pinchedH(x, y) ? run + 1 : 0;
        assert.ok(run <= MAX_RUN, `${file}: horizontal 1-wide corridor ${run} long ending at ${x},${y}`);
      }
    }
    for (let x = 1; x < map.width - 1; x++) {
      let run = 0;
      for (let y = 1; y < map.height - 1; y++) {
        run = pinchedV(x, y) ? run + 1 : 0;
        assert.ok(run <= MAX_RUN, `${file}: vertical 1-wide corridor ${run} long ending at ${x},${y}`);
      }
    }
  }
});

test('every board has obstacles touching the border to break perimeter loops', async () => {
  // Without these a dog that reaches the fence just circles it until its stamina runs out.
  for (const { map, file } of await loadBoards()) {
    let baffles = 0;
    for (let y = 1; y < map.height - 1; y++) {
      for (let x = 1; x < map.width - 1; x++) {
        if (map.terrain[y * map.width + x] !== '#') continue;
        if (x === 1 || y === 1 || x === map.width - 2 || y === map.height - 2) baffles++;
      }
    }
    assert.ok(baffles >= 4, `${file}: only ${baffles} border-adjacent obstacles`);
  }
});

test('the border is solid so dogs cannot leave the board', async () => {
  const map = await loadMap(join(ROOT, 'maps', 'large.txt'), 'large');
  for (let x = 0; x < map.width; x++) {
    assert.equal(map.terrain[x], '#', `top border at x=${x}`);
    assert.equal(map.terrain[(map.height - 1) * map.width + x], '#', `bottom border at x=${x}`);
  }
  for (let y = 0; y < map.height; y++) {
    assert.equal(map.terrain[y * map.width], '#', `left border at y=${y}`);
    assert.equal(map.terrain[y * map.width + map.width - 1], '#', `right border at y=${y}`);
  }
});
