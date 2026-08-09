/**
 * Does the difficulty ladder actually order?
 *
 * Until this says so, "Scout is stronger than Pup" is a claim about code rather than a
 * fact about play. Same spirit as `npm run tune`: a single game is noise, so this plays
 * many seeded rounds and reports the spread.
 *
 * Deliberately headless — it drives the round directly rather than a Room, so there are no
 * timers and no sockets. Every tier sees the same maps and the same start positions, so
 * the only difference between them is how they choose.
 *
 *   node scripts/ai-tourney.ts [rounds] [board]
 */

import { CONFIG } from '../src/config.ts';
import { generateMap } from '../src/sim/generate.mjs';
import { parseMap } from '../src/sim/map.ts';
import { simulateWalk } from '../src/sim/simulate.ts';
import { TILE_PALETTE, key, type DogSnapshot, type PlacedTile } from '../src/sim/types.ts';
import { DIFFICULTIES, type Difficulty } from '../src/server/protocol.ts';
import { chooseMove } from '../src/server/ai/bot.ts';
import { makeRng } from '../src/server/ai/rng.ts';
import type { BotView } from '../src/server/ai/view.ts';

const rounds = Number(process.argv[2] ?? 60);
const boardName = process.argv[3] ?? 'small';
const board = CONFIG.boards.find((b) => b.name === boardName) ?? CONFIG.boards[0]!;

/** One round of simultaneous placement turns — as many as this board runs — by tier. */
async function playRound(tiers: Difficulty[], seed: number) {
  const { text } = generateMap({ size: board.size, seed });
  const map = parseMap(text, `seed ${seed}`);

  const dogs: DogSnapshot[] = tiers.map((_, i) => {
    const s = map.starts[i % map.starts.length]!;
    return { id: `p${i}`, x: s.x, y: s.y, dir: s.dir, stamina: board.stamina, score: 0, stopped: null, jumped: false };
  });

  const cfg = {
    sim: {
      stamina: board.stamina,
      jumpDistance: CONFIG.sim.jumpDistance,
      stuckTurnsBeforeGiveUp: CONFIG.sim.stuckTurnsBeforeGiveUp,
    },
    scoring: CONFIG.scoring,
  };

  const tiles = new Map<string, PlacedTile>();
  const rng = makeRng(seed * 7919 + 13);

  for (let turn = 1; turn <= board.turns; turn++) {
    const secret = turn === board.turns;
    // Simultaneous: every seat chooses against the same board, then all are committed.
    const chosen = await Promise.all(
      tiers.map(async (tier, i) => {
        const view: BotView = {
          playerId: `p${i}`,
          dogId: `p${i}`,
          turn,
          turnsPerRound: board.turns,
          secretTurn: secret,
          map,
          dogs,
          tiles: new Map(tiles),
          palette: [...TILE_PALETTE],
          opponents: tiers.map((_, j) => `p${j}`).filter((id) => id !== `p${i}`),
          cfg,
        };
        return chooseMove(view, tier, Date.now() + 400, rng);
      }),
    );

    // Two seats on one square build a wall there, exactly as the room does.
    const bySquare = new Map<string, number[]>();
    chosen.forEach((m, i) => {
      if (!m) return;
      const k = key(m.x, m.y);
      bySquare.set(k, [...(bySquare.get(k) ?? []), i]);
    });
    for (const [k, group] of bySquare) {
      const m = chosen[group[0]!]!;
      if (group.length > 1) tiles.set(k, { kind: 'X', ownerId: null, secret });
      else tiles.set(k, { kind: m.kind, ownerId: `p${group[0]}`, secret });
    }
  }

  const result = simulateWalk(
    map,
    dogs.map((d) => ({ id: d.id, breed: d.id, x: d.x, y: d.y, dir: d.dir })),
    tiles,
    cfg,
  );
  return tiers.map((_, i) => result.scores.find((s) => s.dogId === `p${i}`)?.score ?? 0);
}

console.log(`\n  ${board.name} board, ${rounds} rounds per pairing, ${board.stamina} stamina\n`);

for (let a = 0; a < DIFFICULTIES.length; a++) {
  for (let b = a + 1; b < DIFFICULTIES.length; b++) {
    const tierA = DIFFICULTIES[a]!;
    const tierB = DIFFICULTIES[b]!;
    let winsA = 0;
    let winsB = 0;
    let draws = 0;
    let totalA = 0;
    let totalB = 0;

    for (let seed = 1; seed <= rounds; seed++) {
      // Swap seats halfway, so a lucky start slot cannot flatter one tier.
      const flip = seed % 2 === 0;
      const tiers: Difficulty[] = flip ? [tierB, tierA] : [tierA, tierB];
      const scores = await playRound(tiers, seed);
      const sa = flip ? scores[1]! : scores[0]!;
      const sb = flip ? scores[0]! : scores[1]!;
      totalA += sa;
      totalB += sb;
      if (sa > sb) winsA++;
      else if (sb > sa) winsB++;
      else draws++;
    }

    const pct = ((winsB / (winsA + winsB || 1)) * 100).toFixed(0);
    console.log(
      `  ${tierB.padEnd(7)} vs ${tierA.padEnd(7)}  ` +
        `${winsB}W ${winsA}L ${draws}D   ` +
        `decisive win rate ${pct}%   ` +
        `mean ${(totalB / rounds).toFixed(2)} vs ${(totalA / rounds).toFixed(2)}`,
    );
  }
}
console.log();
