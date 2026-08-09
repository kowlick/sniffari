import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.ts';
import { generateMap } from '../src/sim/generate.mjs';
import { mapStats, parseMap } from '../src/sim/map.ts';
import { simulateWalk } from '../src/sim/simulate.ts';
import type { GameMap } from '../src/sim/types.ts';

/**
 * Every match generates its own map, so the invariants have to hold for *any* map the
 * generator can produce — not just the three checked into maps/. These run the same
 * assertions as map.test.ts across many seeds at every board size.
 */
const SEEDS = 40;
const BOARDS = CONFIG.boards.map((b) => ({ name: b.name, size: b.size }));

const forEachGenerated = (fn: (map: GameMap, label: string) => void) => {
  for (const { name, size } of BOARDS) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { text } = generateMap({ size, seed });
      fn(parseMap(text, `${name}#${seed}`), `${name} seed ${seed}`);
    }
  }
};

const solidAt = (map: GameMap) => (x: number, y: number) =>
  x < 0 || y < 0 || x >= map.width || y >= map.height || map.terrain[y * map.width + x] === '#';

test('generated maps are the right size with eight start slots', () => {
  forEachGenerated((map, label) => {
    assert.equal(map.starts.length, 8, `${label}: start slots`);
    assert.equal(map.width, map.height, `${label}: square`);
  });
});

test('generated maps are always one connected space', () => {
  forEachGenerated((map, label) => {
    const walkable = (x: number, y: number) => !solidAt(map)(x, y);
    const start = map.starts[0]!;
    const seen = new Set([`${start.x},${start.y}`]);
    const queue: [number, number][] = [[start.x, start.y]];
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
    assert.equal(seen.size, total, `${label}: ${total - seen.size} tiles walled off`);
    for (const s of map.starts) assert.ok(seen.has(`${s.x},${s.y}`), `${label}: start stranded`);
  });
});

test('generated maps never contain a long 1-wide corridor', () => {
  // In the playfield a run of pinched tiles is a corridor a dog is committed to, and two is
  // the limit. The lane hugging the fence is different: baffles pinch it deliberately, and
  // that pinch is the thing that turns a dog back inward. It gets a looser bound rather
  // than an exemption, so a genuinely long fence-hugging corridor would still fail.
  const INNER_MAX = 2;
  const EDGE_MAX = 4;
  forEachGenerated((map, label) => {
    const solid = solidAt(map);
    const onEdge = (x: number, y: number) =>
      x <= 1 || y <= 1 || x >= map.width - 2 || y >= map.height - 2;

    for (let y = 1; y < map.height - 1; y++) {
      let run = 0;
      for (let x = 1; x < map.width - 1; x++) {
        run = !solid(x, y) && solid(x, y - 1) && solid(x, y + 1) ? run + 1 : 0;
        const max = onEdge(x, y) ? EDGE_MAX : INNER_MAX;
        assert.ok(run <= max, `${label}: horizontal corridor ${run} long at ${x},${y}`);
      }
    }
    for (let x = 1; x < map.width - 1; x++) {
      let run = 0;
      for (let y = 1; y < map.height - 1; y++) {
        run = !solid(x, y) && solid(x - 1, y) && solid(x + 1, y) ? run + 1 : 0;
        const max = onEdge(x, y) ? EDGE_MAX : INNER_MAX;
        assert.ok(run <= max, `${label}: vertical corridor ${run} long at ${x},${y}`);
      }
    }
  });
});

test('generated maps always have border baffles and a solid fence', () => {
  forEachGenerated((map, label) => {
    for (let x = 0; x < map.width; x++) {
      assert.equal(map.terrain[x], '#', `${label}: top border`);
      assert.equal(map.terrain[(map.height - 1) * map.width + x], '#', `${label}: bottom border`);
    }
    let baffles = 0;
    for (let y = 1; y < map.height - 1; y++)
      for (let x = 1; x < map.width - 1; x++)
        if (
          map.terrain[y * map.width + x] === '#' &&
          (x === 1 || y === 1 || x === map.width - 2 || y === map.height - 2)
        )
          baffles++;
    // Scaled to the board: four stubs on an 8x8 perimeter is a denser ring than four on a
    // 16x16, and the point is to break the wall-hugging lane, not to hit a fixed count.
    const want = map.width <= 11 ? 3 : 4;
    assert.ok(baffles >= want, `${label}: only ${baffles} border-adjacent obstacles`);
  });
});

test('generated maps stay inside the density bounds from DESIGN.md §4.4', () => {
  forEachGenerated((map, label) => {
    const s = mapStats(map);
    // Against the interior, not the whole grid: see mapStats. The border ring makes the
    // whole-grid figure a measure of board size rather than of openness.
    assert.ok(
      s.interiorWalkableFraction > 0.8 && s.interiorWalkableFraction < 0.97,
      `${label}: ${(s.interiorWalkableFraction * 100).toFixed(0)}% of the interior walkable`,
    );
    assert.ok(s.stoppers >= 1, `${label}: ${s.stoppers} stopping points`);
    // A *ratio* stops meaning anything once the denominator is 33 tiles — one stopper is
    // already one per 33. Bound the count instead, and keep the ratio check for boards big
    // enough for it to say something.
    assert.ok(s.stoppers <= 3, `${label}: ${s.stoppers} stopping points is too many`);
    if (s.walkable >= 100) {
      assert.ok(
        s.walkablePerStopper > 20,
        `${label}: one stopper per ${s.walkablePerStopper.toFixed(0)} tiles is too dense`,
      );
    }
    const sniffRate = s.sniffs / s.walkable;
    assert.ok(sniffRate > 0.05 && sniffRate < 0.14, `${label}: sniff rate ${sniffRate.toFixed(3)}`);
  });
});

test('dogs always stop on a generated map, at every player count', () => {
  for (const { name, size } of BOARDS) {
    const cfg = {
      ...CONFIG,
      sim: { ...CONFIG.sim, stamina: CONFIG.boards.find((b) => b.size === size)!.stamina },
    };
    for (let seed = 1; seed <= 12; seed++) {
      const { text } = generateMap({ size, seed });
      const map = parseMap(text, `${name}#${seed}`);
      for (const n of [1, 4, 8]) {
        const dogs = map.starts
          .slice(0, n)
          .map((s, i) => ({ id: `d${i}`, breed: 'x', x: s.x, y: s.y, dir: s.dir }));
        const result = simulateWalk(map, dogs, new Map(), cfg);
        for (const r of result.scores)
          assert.ok(r.stopped, `${name} seed ${seed}, ${n} dogs: ${r.dogId} never stopped`);
      }
    }
  }
});
