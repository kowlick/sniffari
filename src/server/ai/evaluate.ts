/**
 * Scoring a candidate placement by playing the round out.
 *
 * There is no heuristic evaluation function here and there does not need to be one.
 * `simulateWalk` is pure and costs 0.036-0.140 ms depending on board size, and a turn only
 * ever offers 250-785 legal placements, so a bot can afford to *ask the real rules* what
 * each of its options actually does. That is the whole reason even the weakest tier plays
 * a considered move rather than a plausible-looking one.
 *
 * Nothing in this file may read anything but a `BotView`. See view.ts.
 */

import { at, isPlaceable } from '../../sim/map.ts';
import { simulateWalk } from '../../sim/simulate.ts';
import { key, type DogInit, type PlacedTile, type TileKind } from '../../sim/types.ts';
import type { BotView } from './view.ts';

export type Placement = { x: number; y: number; kind: TileKind };

/**
 * Every square this seat could legally place on.
 *
 * Mirrors `Room.illegalSquare`, and has to keep mirroring it: a bot that proposes an
 * illegal square gets refused by `place()` and silently forfeits its turn. The duplication
 * is deliberate — the bot only knows what the payload told it, so it cannot call the
 * server's own check without reaching across the boundary.
 */
export function legalSquares(view: BotView): { x: number; y: number }[] {
  const occupied = new Set(view.dogs.map((d) => key(d.x, d.y)));
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < view.map.height; y++) {
    for (let x = 0; x < view.map.width; x++) {
      if (!isPlaceable(at(view.map, x, y))) continue;
      const k = key(x, y);
      if (view.tiles.has(k) || occupied.has(k)) continue;
      out.push({ x, y });
    }
  }
  return out;
}

/** Every legal (square, tile kind) pair. This is the branching factor: 250-785. */
export function candidates(view: BotView): Placement[] {
  const out: Placement[] = [];
  for (const { x, y } of legalSquares(view)) {
    for (const kind of view.palette) out.push({ x, y, kind });
  }
  return out;
}

function dogInits(view: BotView): DogInit[] {
  return view.dogs.map((d) => ({ id: d.id, breed: d.id, x: d.x, y: d.y, dir: d.dir }));
}

/**
 * Run the round with these tiles on the board and return each dog's score.
 *
 * Note what this is *not*: a prediction. Turns still to come will change the board, and
 * opponents will place tiles this bot cannot see. It is the score of the round as it
 * stands, which is the honest thing to compare two candidate placements by.
 */
export function scoresWith(view: BotView, tiles: ReadonlyMap<string, PlacedTile>): Map<string, number> {
  const result = simulateWalk(view.map, dogInits(view), tiles, view.cfg);
  const out = new Map<string, number>();
  for (const s of result.scores) out.set(s.dogId, s.score);
  return out;
}

/**
 * How good is this board for me?
 *
 * `lambda` is what makes the difficulty tiers feel like different opponents rather than
 * the same one with sharper eyesight. At 0 the bot is simply walking its own dog and does
 * not care what anyone else scores. Above 0 it starts to weigh the rest of the table, and
 * will give up points of its own to take more away from everybody else.
 *
 * Opponents are averaged rather than maxed: in a six-dog game, fixating on whoever is
 * currently ahead makes for a bot that ignores the board to chase one player.
 */
export function valueOf(view: BotView, scores: Map<string, number>, lambda: number): number {
  const mine = scores.get(view.playerId) ?? 0;
  if (lambda === 0 || view.opponents.length === 0) return mine;
  let total = 0;
  for (const id of view.opponents) total += scores.get(id) ?? 0;
  return mine - lambda * (total / view.opponents.length);
}

/** Value of the board if this bot placed exactly this tile and nothing else changed. */
export function valueOfPlacement(view: BotView, move: Placement, lambda: number): number {
  const tiles = new Map(view.tiles);
  tiles.set(key(move.x, move.y), { kind: move.kind, ownerId: view.playerId, secret: view.secretTurn });
  return valueOf(view, scoresWith(view, tiles), lambda);
}

/** The board as it stands, with nothing added. The baseline a placement has to beat. */
export function baselineValue(view: BotView, lambda: number): number {
  return valueOf(view, scoresWith(view, view.tiles), lambda);
}
