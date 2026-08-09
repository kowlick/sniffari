/**
 * Map generation, as a pure function so make-map.mjs, preview.mjs and tune.mjs share it.
 *
 * The playfield is open and small — a handful of little obstacles in a mostly-walkable
 * field, with a guaranteed minimum gap so every lane is at least MIN_GAP tiles wide.
 * Narrow corridors commit a dog to one path until the next intersection, which kills the
 * cross-traffic the reveal phase is built on. See DESIGN.md §4.2.
 */

/** The three board sizes, chosen by how many players are in the match. */
export const SIZES = {
  small: { size: 8, players: '1–4' },
  large: { size: 10, players: '5–8' },
};

export const DEFAULTS = {
  size: 16,
  seed: 1,
  /**
   * Minimum walkable tiles between any two obstacles, and between an obstacle and the
   * fence. Relaxed on the small boards — at gap 3 almost nothing fits inside a 10x10.
   */
  minGap: null, // null = pick from size
  /** Target fraction of the interior taken up by obstacles. Small: this is an open field. */
  blockFraction: 0.1,
  /**
   * Long, one-tile-thick interior fences. They redirect dogs without eating much space.
   * null = scale with the board; a 6-long fence on a 10x10 is a wall across the map.
   */
  fences: null,
  fenceLength: null,
  /**
   * Stubs of wall growing inward from the border. Without them the ring road round the
   * edge is unbroken and a dog that reaches the fence simply circles it forever; a stub
   * blocks the wall-hugging lane so the dog turns right and heads back inward.
   */
  baffles: true,
  /**
   * Give each edge its own phase and spacing. With every edge placed by the same rule from
   * the same offset the baffles come out mirrored, and a dog deflected off one can meet the
   * matching baffle opposite and settle into a lap of the board.
   */
  baffleJitter: true,
  /** Densities as fractions of walkable tiles. */
  sniff: 0.09,
  person: 0.028,
  squirrel: 0.008,
  lake: 0.004,
  /**
   * Manhattan radius around each start kept clear of pickups and stopping points.
   * null = scale with the board. At radius 3 on a 10x10 the eight buffers cover nearly
   * every square and the map ends up with almost no pickups on it at all.
   */
  startBuffer: null,
};

/** Small clumps only — 2x3 at most, down to 1x2. Big blocks make the field feel like a maze. */
const BLOCK_SIZES = [
  [2, 3],
  [3, 2],
  [2, 2],
  [1, 2],
  [2, 1],
  [1, 3],
  [3, 1],
];

const STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Every walkable tile reachable from `from`, as a Set of "x,y". */
function reachable(grid, SIZE, from) {
  const seen = new Set([`${from[0]},${from[1]}`]);
  const queue = [from];
  while (queue.length) {
    const [x, y] = queue.pop();
    for (const [dx, dy] of STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
      const k = `${nx},${ny}`;
      if (seen.has(k) || grid[ny][nx] === '#') continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return seen;
}

/** Open walls until every walkable tile is reachable from `start`. Never touches the border. */
function ensureConnected(grid, SIZE, start) {
  for (let guard = 0; guard < 400; guard++) {
    const seen = reachable(grid, SIZE, start);
    const stranded = [];
    for (let y = 1; y < SIZE - 1; y++)
      for (let x = 1; x < SIZE - 1; x++)
        if (grid[y][x] !== '#' && !seen.has(`${x},${y}`)) stranded.push([x, y]);
    if (!stranded.length) return;

    let opened = false;
    outer: for (const [ux, uy] of stranded) {
      for (const [dx, dy] of STEPS) {
        const wx = ux + dx;
        const wy = uy + dy;
        if (wx < 1 || wy < 1 || wx >= SIZE - 1 || wy >= SIZE - 1) continue;
        if (grid[wy][wx] !== '#') continue;
        const touchesMainland = STEPS.some(([ax, ay]) => seen.has(`${wx + ax},${wy + ay}`));
        if (!touchesMainland) continue;
        grid[wy][wx] = '.';
        opened = true;
        break outer;
      }
    }
    // Nothing could be opened (pocket walled in by the border): fill it so it is not dead space.
    if (!opened) {
      for (const [ux, uy] of stranded) grid[uy][ux] = '#';
      return;
    }
  }
}

const mulberry32 = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export function generateMap(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const SIZE = o.size;
  const GAP = o.minGap ?? (SIZE >= 14 ? 3 : 2);
  // Everything below scales with the board unless explicitly overridden.
  const startBuffer = o.startBuffer ?? (SIZE <= 11 ? 1 : SIZE <= 14 ? 2 : 3);
  const fenceCount = o.fences ?? (SIZE <= 11 ? 1 : 2);
  const fenceLen = o.fenceLength ?? (SIZE <= 11 ? [2, 3] : SIZE <= 14 ? [3, 4] : [4, 6]);
  const rand = mulberry32(o.seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

  const grid = Array.from({ length: SIZE }, (_, y) =>
    Array.from({ length: SIZE }, (_, x) =>
      x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1 ? '#' : '.',
    ),
  );
  const set = (x, y, ch) => {
    grid[y][x] = ch;
  };

  // Start slots are fixed up front so obstacles can avoid them.
  const e = SIZE - 2;
  const a = Math.max(2, Math.round(SIZE * 0.3));
  const b = SIZE - 1 - a;
  const starts = [
    [a, 1],
    [b, 1],
    [e, a],
    [e, b],
    [a, e],
    [b, e],
    [1, a],
    [1, b],
  ];
  const isStart = (x, y) => starts.some(([sx, sy]) => sx === x && sy === y);

  // --- Obstacles ---------------------------------------------------------------------
  const obstacles = [];
  const interior = (SIZE - 2) ** 2;

  // --- Border baffles -------------------------------------------------------------------
  // Short stubs growing inward from the fence. A dog running the perimeter travels in the
  // lane next to the wall, so even a 1-tile stub blocks it and turns it inward. Spacing of
  // 4 along an edge keeps them from pinching the lane between two stubs down to 1 tile.
  if (o.baffles) {
    const edges = [
      { horiz: true, base: 1, inward: 1 },
      { horiz: true, base: SIZE - 2, inward: -1 },
      { horiz: false, base: 1, inward: 1 },
      { horiz: false, base: SIZE - 2, inward: -1 },
    ];
    for (const edge of edges) {
      // Build the list of usable offsets first and then take them greedily with a minimum
      // spacing. Stepping blindly along the edge lands on the start squares — which sit in
      // exactly this lane — and silently produces no baffles at all on a small board.
      const usable = [];
      for (let i = 2; i <= SIZE - 3; i++) {
        const [x, y] = edge.horiz ? [i, edge.base] : [edge.base, i];
        // Park counts as well as street. Restricting this to street quietly starved the
        // small boards: an 8x8 edge offers four candidate offsets in total, and any of
        // them that happened to be grass took an edge's only chance of a baffle with it.
        if ((grid[y][x] === '.' || grid[y][x] === ',') && !isStart(x, y)) usable.push(i);
      }
      // Spacing stays >= 4 either way: closer than that and two stubs pinch the lane
      // between them down to a single tile.
      //
      // The jittered start offset is for boards with room for more than one stub an edge.
      // On a small board it only ever skips past the handful of offsets that exist, so the
      // edge ends up bare and the perimeter lane runs unbroken.
      let nextAt = o.baffleJitter && SIZE >= 12 ? 2 + Math.floor(rand() * 4) : 2;
      for (const i of usable) {
        if (i < nextAt) continue;
        const len = SIZE < 13 ? 1 : randInt(1, 2);
        const cells = [];
        let ok = true;
        for (let d = 0; d < len; d++) {
          const off = edge.base + edge.inward * d;
          const [x, y] = edge.horiz ? [i, off] : [off, i];
          if (x < 1 || y < 1 || x > SIZE - 2 || y > SIZE - 2 || grid[y][x] !== '.' || isStart(x, y)) {
            ok = false;
            break;
          }
          cells.push([x, y]);
        }
        if (!ok || !cells.length) continue;
        nextAt = i + (o.baffleJitter ? randInt(4, 6) : 4);
        for (const [x, y] of cells) set(x, y, '#');
        const xs = cells.map((c) => c[0]);
        const ys = cells.map((c) => c[1]);
        obstacles.push({
          x: Math.min(...xs),
          y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs) + 1,
          h: Math.max(...ys) - Math.min(...ys) + 1,
        });
      }
    }
  }
  const baffleCount = obstacles.length;

  const fits = (bx, by, w, h) =>
    bx >= 1 + GAP &&
    by >= 1 + GAP &&
    bx + w - 1 <= SIZE - 2 - GAP &&
    by + h - 1 <= SIZE - 2 - GAP &&
    !obstacles.some(
      (b) =>
        bx - GAP <= b.x + b.w - 1 &&
        bx + w - 1 + GAP >= b.x &&
        by - GAP <= b.y + b.h - 1 &&
        by + h - 1 + GAP >= b.y,
    );

  const tryPlace = (w, h) => {
    const bx = 1 + Math.floor(rand() * (SIZE - 2));
    const by = 1 + Math.floor(rand() * (SIZE - 2));
    if (!fits(bx, by, w, h)) return 0;
    for (let y = by; y < by + h; y++) for (let x = bx; x < bx + w; x++) if (isStart(x, y)) return 0;
    obstacles.push({ x: bx, y: by, w, h });
    for (let y = by; y < by + h; y++) for (let x = bx; x < bx + w; x++) set(x, y, '#');
    return w * h;
  };

  // Long fences go first so they get the room they need.
  let blocked = 0;
  let fencesPlaced = 0;
  for (let attempt = 0; attempt < 2000 && fencesPlaced < fenceCount; attempt++) {
    const len = randInt(fenceLen[0], fenceLen[1]);
    const [w, h] = rand() < 0.5 ? [len, 1] : [1, len];
    const area = tryPlace(w, h);
    if (area) {
      blocked += area;
      fencesPlaced++;
    }
  }

  const targetBlocked = Math.round(interior * o.blockFraction);
  for (let attempt = 0; attempt < 4000 && blocked < targetBlocked; attempt++) {
    const [w, h] = pick(BLOCK_SIZES);
    blocked += tryPlace(w, h);
  }

  // --- Connectivity ----------------------------------------------------------------------
  // Baffles sit right against the border, so two of them near a corner can seal a pocket —
  // including the corner storm drains, which then cannot do their job. Rather than tiptoe
  // around every case, prove the board is one connected space and knock out a wall wherever
  // it is not.
  ensureConnected(grid, SIZE, starts[0]);

  // --- Parks ---------------------------------------------------------------------------
  // Cosmetic only: park and street behave identically. Green areas give the open field
  // some shape so it does not read as an undifferentiated plain.
  const f = (n) => Math.round((n * SIZE) / 20);
  const park = (x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (grid[y]?.[x] === '.') set(x, y, ',');
  };
  park(1, f(6), f(7), f(13));
  park(f(12), f(2), SIZE - 2, f(7));
  park(f(10), f(15), f(16), SIZE - 2);

  // --- Fixed features -------------------------------------------------------------------
  // Storm drains in opposite corners. A dog circling the fence travels clockwise and so
  // passes every corner; the baffles above break most perimeter runs, and these catch the
  // rest. Only one on the small board: two of them on 58 walkable tiles ended roughly half
  // of all runs on a zero-point square, which no amount of stamina can compensate for.
  set(1, 1, 'D');
  if (SIZE > 11) set(SIZE - 2, SIZE - 2, 'D');

  starts.forEach(([x, y], i) => {
    if (grid[y][x] === '#') throw new Error(`start ${i + 1} at ${x},${y} landed on an obstacle`);
    set(x, y, String(i + 1));
  });

  // --- Scattered features ----------------------------------------------------------------
  const free = [];
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      if (grid[y][x] !== '.' && grid[y][x] !== ',') continue;
      // Keep the squares around a start clear so nobody is handed points, or a stopping
      // point, before they have placed a single tile.
      if (starts.some(([sx, sy]) => Math.abs(sx - x) + Math.abs(sy - y) <= startBuffer)) continue;
      free.push([x, y]);
    }
  }
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [free[i], free[j]] = [free[j], free[i]];
  }

  const walkable = grid.flat().filter((c) => c !== '#').length;
  let cursor = 0;
  const scatter = (ch, count) => {
    for (let i = 0; i < count && cursor < free.length; i++, cursor++) {
      const [x, y] = free[cursor];
      set(x, y, ch);
    }
  };
  scatter('S', Math.round(walkable * o.sniff));
  scatter('P', Math.round(walkable * o.person));
  scatter('Q', Math.max(1, Math.round(walkable * o.squirrel)));
  // No forced lake on the small board — a hazard plus a drain plus a squirrel on 58 tiles
  // is a minefield, and the lake is the one that pays nothing and costs points.
  scatter('~', Math.max(SIZE > 11 ? 1 : 0, Math.round(walkable * o.lake)));

  const count = (ch) => grid.flat().filter((c) => c === ch).length;
  const stoppers = count('Q') + count('~') + count('D');

  return {
    grid,
    text: grid.map((r) => r.join('')).join('\n') + '\n',
    stats: {
      size: SIZE,
      total: SIZE * SIZE,
      walkable,
      walkableFraction: walkable / SIZE ** 2,
      obstacles: obstacles.length,
      baffles: baffleCount,
      fences: fencesPlaced,
      blockedInterior: blocked,
      sniffs: count('S'),
      people: count('P'),
      stoppers,
      walkablePerStopper: walkable / stoppers,
    },
  };
}
