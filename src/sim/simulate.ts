import { CONFIG } from '../config.ts';
import { step, turnRight } from './directions.ts';
import { at, isStopper, isWalkable } from './map.ts';
import {
  T,
  TILE,
  key,
  type Dir,
  type DogInit,
  type DogSnapshot,
  type GameMap,
  type PlacedTile,
  type SimEvent,
  type StopReason,
  type Tick,
  type WalkResult,
} from './types.ts';

/**
 * The walk phase.
 *
 * This is a deterministic grid automaton: same map + same dogs + same tiles always
 * produces the same round, byte for byte. That is load-bearing. It is what lets players
 * reason about their placements, what lets the server send a whole round as one payload
 * for clients to replay, and what makes the sim testable without mocking anything.
 *
 * Nothing in this file may consult a clock, a random source, or the network.
 */

/**
 * Structural view of the bits of CONFIG the sim reads. Deliberately not `typeof CONFIG`:
 * that carries literal types, so a caller overriding stamina per board (which the server
 * does) would not typecheck.
 */
export type SimConfig = {
  sim: { stamina: number; jumpDistance: number; stuckTurnsBeforeGiveUp: number };
  scoring: {
    sniffByVisitOrder: readonly number[];
    treat: number;
    greet: number;
    squirrel: number;
    lake: number;
    drain: number;
  };
};

type Runtime = {
  id: string;
  x: number;
  y: number;
  dir: Dir;
  stamina: number;
  score: number;
  stopped: StopReason | null;
  jumpArmed: boolean;
  jumpedThisTick: boolean;
  stuckTurns: number;
  sniffs: number;
  treats: number;
  /** state key -> this dog's score when it was last in that state. See loop detection below. */
  visited: Map<string, number>;
};

const stateKey = (d: Runtime) => `${d.x},${d.y},${d.dir},${d.jumpArmed ? 1 : 0}`;
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function simulateWalk(
  map: GameMap,
  dogInits: DogInit[],
  tiles: ReadonlyMap<string, PlacedTile>,
  cfg: SimConfig = CONFIG,
): WalkResult {
  const dogs: Runtime[] = dogInits.map((d) => ({
    id: d.id,
    x: d.x,
    y: d.y,
    dir: d.dir,
    stamina: cfg.sim.stamina,
    score: 0,
    stopped: null,
    jumpArmed: false,
    jumpedThisTick: false,
    stuckTurns: 0,
    sniffs: 0,
    treats: 0,
    visited: new Map(),
  }));

  /**
   * Tiles are **single use**: a dog that steps on one consumes it. Without this, two players
   * can bookend a dog with opposing arrows and pin it between them, and loop detection ends
   * its round almost immediately — a cheap way to delete somebody from the game. Made
   * single-use, that trap redirects a dog twice and then it is free.
   *
   * Scuff marks are not tiles and are never consumed; they are walls.
   */
  const live = new Map(tiles);

  // World state that changes during the walk.
  const sniffCounts = new Map<string, number>();
  const treatsTaken = new Set<string>();
  const revealed = new Set<string>();
  const greetedPairs = new Set<string>();

  const ticks: Tick[] = [{ n: 0, dogs: dogs.map(snapshot), events: [] }];

  // Every dog loses stamina every tick it is active, so this bound is reached only if
  // something has gone wrong. It exists so a bug can never hang the server.
  const maxTicks = cfg.sim.stamina + 2;

  for (let n = 1; n <= maxTicks; n++) {
    const active = dogs.filter((d) => d.stopped === null);
    if (active.length === 0) break;

    const events: SimEvent[] = [];
    for (const d of dogs) d.jumpedThisTick = false;

    // --- 1. Intent -------------------------------------------------------------------
    const target = new Map<string, { x: number; y: number }>();
    for (const d of active) {
      const distance = d.jumpArmed ? cfg.sim.jumpDistance : 1;
      target.set(d.id, step(d.x, d.y, d.dir, distance));
    }

    // --- 2. Terrain blocking ---------------------------------------------------------
    // Only the landing tile matters: a jump passes over whatever is in between, including
    // walls and other dogs. That is the entire point of the jump tile.
    const blocked = new Set<string>();
    const blockedBy = new Map<string, Runtime>();
    for (const d of active) {
      const t = target.get(d.id)!;
      const terrain = at(map, t.x, t.y);
      const tile = live.get(key(t.x, t.y));
      if (!isWalkable(terrain) || tile?.kind === TILE.SCUFF) {
        blocked.add(d.id);
        // Bumping into a hidden scuff is how you find out it is there.
        if (tile?.kind === TILE.SCUFF && tile.secret && !revealed.has(key(t.x, t.y))) {
          revealed.add(key(t.x, t.y));
          events.push({ t: 'reveal', x: t.x, y: t.y, kind: TILE.SCUFF });
        }
      }
    }

    // --- 3. Dog-vs-dog blocking, to a fixpoint ---------------------------------------
    // A dog blocked by a wall becomes an obstacle itself, which can block a dog behind it,
    // and so on. Iterating to a fixpoint keeps the result independent of dog order, which
    // determinism requires.
    for (;;) {
      const movers = active.filter((d) => !blocked.has(d.id));
      const stayers = new Map<string, Runtime>();
      for (const d of dogs) {
        if (d.stopped !== null || blocked.has(d.id)) stayers.set(key(d.x, d.y), d);
      }

      let changed = false;
      const block = (d: Runtime, by: Runtime | null) => {
        if (blocked.has(d.id)) return;
        blocked.add(d.id);
        if (by) blockedBy.set(d.id, by);
        changed = true;
      };

      // Two dogs wanting the same tile: neither gets it.
      const byTarget = new Map<string, Runtime[]>();
      for (const d of movers) {
        const t = target.get(d.id)!;
        const k = key(t.x, t.y);
        byTarget.set(k, [...(byTarget.get(k) ?? []), d]);
      }
      for (const group of byTarget.values()) {
        if (group.length > 1) for (const d of group) block(d, group.find((o) => o !== d) ?? null);
      }

      // Walking into a dog that is not going anywhere.
      for (const d of movers) {
        const t = target.get(d.id)!;
        const occupant = stayers.get(key(t.x, t.y));
        if (occupant && occupant !== d) block(d, occupant);
      }

      // Head-on swap: two dogs trying to trade places pass through each other otherwise.
      for (const a of movers) {
        for (const b of movers) {
          if (a === b) continue;
          const ta = target.get(a.id)!;
          const tb = target.get(b.id)!;
          if (ta.x === b.x && ta.y === b.y && tb.x === a.x && tb.y === a.y) {
            block(a, b);
            block(b, a);
          }
        }
      }

      if (!changed) break;
    }

    // --- 4. Blocked dogs turn right --------------------------------------------------
    for (const d of active) {
      if (!blocked.has(d.id)) continue;

      const by = blockedBy.get(d.id);
      if (by) {
        const pk = pairKey(d.id, by.id);
        if (!greetedPairs.has(pk)) {
          greetedPairs.add(pk);
          d.score += cfg.scoring.greet;
          by.score += cfg.scoring.greet;
          events.push({
            t: 'greet',
            dogIds: [d.id, by.id],
            x: d.x,
            y: d.y,
            points: cfg.scoring.greet,
          });
        }
      } else {
        events.push({ t: 'bump', dogId: d.id, x: d.x, y: d.y });
      }

      // A jump into a blocked landing tile simply fails; the dog does not stay airborne.
      d.jumpArmed = false;
      d.dir = turnRight(d.dir);
      d.stuckTurns += 1;
      if (d.stuckTurns >= cfg.sim.stuckTurnsBeforeGiveUp) stop(d, 'stuck', events, cfg);
    }

    // --- 5. Movers move, then resolve what they landed on -----------------------------
    for (const d of active) {
      if (blocked.has(d.id) || d.stopped !== null) continue;
      const t = target.get(d.id)!;
      d.jumpedThisTick = d.jumpArmed;
      d.jumpArmed = false;
      d.stuckTurns = 0;
      d.x = t.x;
      d.y = t.y;
      arrive(d, map, live, sniffCounts, treatsTaken, revealed, events, cfg);
    }

    // --- 5b. A consumed tile changes the world ----------------------------------------
    // Loop detection below rests on "same (position, facing) means same future". Spending a
    // tile breaks that: a dog can legitimately revisit a state it has been in before and go
    // somewhere new, because the arrow that redirected it last time is gone. Forget the
    // history whenever the layout changes, or escaping a bookend trap reads as a loop and
    // the dog is stopped on the spot.
    if (events.some((e) => e.t === 'consume')) {
      for (const d of dogs) d.visited.clear();
    }

    // --- 6. Stamina ------------------------------------------------------------------
    for (const d of active) {
      if (d.stopped !== null) continue;
      d.stamina -= 1;
      if (d.stamina <= 0) stop(d, 'tuckered', events, cfg);
    }

    // --- 7. Loop detection ------------------------------------------------------------
    // Revisiting a (position, facing, jump) state having scored nothing since the last
    // visit means this dog is going in circles. This is a heuristic, not the termination
    // guarantee — stamina is that. It exists so nobody watches a dog do laps for 30s.
    for (const d of active) {
      if (d.stopped !== null) continue;
      const sk = stateKey(d);
      const previousScore = d.visited.get(sk);
      if (previousScore !== undefined && previousScore === d.score) {
        stop(d, 'tail', events, cfg);
      } else {
        d.visited.set(sk, d.score);
      }
    }

    ticks.push({ n, dogs: dogs.map(snapshot), events });
    if (dogs.every((d) => d.stopped !== null)) break;
  }

  // Any dog still standing when the loop bound is hit is treated as tuckered out, so the
  // round always has a definite end state.
  for (const d of dogs) if (d.stopped === null) d.stopped = 'tuckered';

  return {
    ticks,
    scores: dogs.map((d) => ({
      dogId: d.id,
      score: d.score,
      stopped: d.stopped!,
      sniffs: d.sniffs,
      treats: d.treats,
    })),
  };
}

function arrive(
  d: Runtime,
  map: GameMap,
  tiles: Map<string, PlacedTile>,
  sniffCounts: Map<string, number>,
  treatsTaken: Set<string>,
  revealed: Set<string>,
  events: SimEvent[],
  cfg: SimConfig,
) {
  const k = key(d.x, d.y);
  const terrain = at(map, d.x, d.y);

  // a. Pickups.
  if (terrain === T.SNIFF) {
    const order = sniffCounts.get(k) ?? 0;
    sniffCounts.set(k, order + 1);
    const points = cfg.scoring.sniffByVisitOrder[order] ?? 0;
    d.score += points;
    if (points > 0) d.sniffs += 1;
    events.push({ t: 'sniff', dogId: d.id, x: d.x, y: d.y, points, order });
  } else if (terrain === T.PERSON && !treatsTaken.has(k)) {
    treatsTaken.add(k);
    d.score += cfg.scoring.treat;
    d.treats += 1;
    events.push({ t: 'treat', dogId: d.id, x: d.x, y: d.y, points: cfg.scoring.treat });
  }

  // b. Stopping points end the run here; tiles underneath never get a chance to fire.
  if (isStopper(terrain)) {
    const reason: StopReason = terrain === T.SQUIRREL ? 'squirrel' : terrain === T.LAKE ? 'lake' : 'drain';
    stop(d, reason, events, cfg);
    return;
  }

  // c/d. Tiles. A secret tile is discovered by the first dog to step on it.
  const tile = tiles.get(k);
  if (!tile || tile.kind === TILE.SCUFF) return;
  if (tile.secret && !revealed.has(k)) {
    revealed.add(k);
    events.push({ t: 'reveal', x: d.x, y: d.y, kind: tile.kind });
  }
  if (tile.kind === TILE.JUMP) {
    d.jumpArmed = true;
  } else {
    // Direction tiles are absolute headings and take effect on the next tick.
    d.dir = ({ [TILE.N]: 0, [TILE.E]: 1, [TILE.S]: 2, [TILE.W]: 3 } as const)[tile.kind];
  }
  // Spent. `tiles` here is the mutable working copy, not the caller's map.
  tiles.delete(k);
  events.push({ t: 'consume', dogId: d.id, x: d.x, y: d.y, kind: tile.kind });
}

function stop(d: Runtime, reason: StopReason, events: SimEvent[], cfg: SimConfig) {
  if (d.stopped !== null) return;
  const points =
    reason === 'squirrel' ? cfg.scoring.squirrel : reason === 'lake' ? cfg.scoring.lake : 0;
  d.score += points;
  d.stopped = reason;
  d.jumpArmed = false;
  events.push({ t: 'stop', dogId: d.id, x: d.x, y: d.y, reason, points });
}

const snapshot = (d: Runtime): DogSnapshot => ({
  id: d.id,
  x: d.x,
  y: d.y,
  dir: d.dir,
  stamina: d.stamina,
  score: d.score,
  stopped: d.stopped,
  jumped: d.jumpedThisTick,
});
