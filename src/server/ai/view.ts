/**
 * What a computer opponent is allowed to know.
 *
 * This is the security boundary of the whole AI, and it is the one thing here that is easy
 * to get catastrophically wrong by accident. A bot runs *inside* the server, where
 * `room.secretTiles` and every other player's `pending` placement are sitting in scope. A
 * bot that read either would be cheating, it would be undetectable from the outside, and
 * every game against it would be quietly rigged.
 *
 * So the bot does not get a `Room`. It gets a `BotView`, and a `BotView` is built from
 * nothing but the `state` message the server was already going to send to that player's
 * browser. If a human cannot see it, it is not in the payload, so it cannot reach the
 * search. The boundary is structural rather than a rule someone has to remember.
 *
 * The one thing taken from `CONFIG` rather than the payload is the scoring table, which is
 * the rulebook: what a squirrel is worth is printed in DESIGN.md and known to every player
 * at the table. Nothing here reads board state from the server.
 */

import { CONFIG } from '../../config.ts';
import type { SimConfig } from '../../sim/simulate.ts';
import {
  key,
  type DogSnapshot,
  type GameMap,
  type PlacedTile,
  type Terrain,
  type TileKind,
} from '../../sim/types.ts';
import type { ServerMessage } from '../protocol.ts';

/** The `state` variant of ServerMessage — the exact payload a player's client receives. */
export type StateMessage = Extract<ServerMessage, { t: 'state' }>;

export type BotView = {
  /** The seat this view belongs to. Sim dog ids are player ids; see Room.dogInits. */
  playerId: string;
  dogId: string;
  turn: number;
  turnsPerRound: number;
  /** Whether this turn's placements stay hidden until a dog treads on them. */
  secretTurn: boolean;
  /**
   * Terrain only. The real map carries start markers, but `boardRows` strips them before
   * they ever go over the wire, so `starts` is empty here exactly as it is in the browser.
   * Dog positions come from `dogs`, which is how a client knows them too.
   */
  map: GameMap;
  /** Every dog's position and facing right now — at placement time, its start square. */
  dogs: DogSnapshot[];
  /** Public tiles only. Secret placements are absent from the payload by construction. */
  tiles: Map<string, PlacedTile>;
  palette: TileKind[];
  /** Player ids of everyone else with a dog in this round. */
  opponents: string[];
  cfg: SimConfig;
};

/**
 * Rebuild a `GameMap` from the terrain rows in the payload.
 *
 * `starts` is deliberately left empty: the wire format does not carry start markers, and
 * `simulateWalk` never reads them — it takes dog positions from the `DogInit`s it is
 * given. Inventing starts here would be inventing information the client does not have.
 */
export function mapFromRows(rows: readonly string[], name: string): GameMap {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const terrain: Terrain[] = new Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = rows[y]!;
    for (let x = 0; x < width; x++) terrain[y * width + x] = row[x] as Terrain;
  }
  return { name, width, height, terrain, starts: [] };
}

/**
 * Build a bot's view from the payload its seat would receive.
 *
 * Takes the message rather than the Room on purpose. There is no argument here through
 * which private state could arrive.
 */
export function buildView(state: StateMessage): BotView | null {
  const playerId = state.you;
  if (playerId === null) return null;
  const me = state.players.find((p) => p.id === playerId);
  if (!me?.dogId) return null;

  const tiles = new Map<string, PlacedTile>();
  for (const t of state.tiles) {
    // Everything in the payload is public by definition; `secret` is what the *server*
    // withheld, so anything that arrived here is not secret.
    tiles.set(key(t.x, t.y), { kind: t.kind, ownerId: t.ownerId, secret: false });
  }

  return {
    playerId,
    dogId: me.dogId,
    turn: state.turn,
    turnsPerRound: state.config.turns,
    // The last turn of however many this board runs. Both numbers are in the payload, so a
    // bot works this out from exactly what the browser is told.
    secretTurn: state.turn === state.config.turns,
    map: mapFromRows(state.map.rows, state.map.name),
    dogs: state.dogs,
    tiles,
    palette: [...state.config.palette],
    opponents: state.players.filter((p) => p.dogId && p.id !== playerId).map((p) => p.id),
    cfg: {
      // Stamina is per board and is in the payload; the client draws the stamina ring from it.
      sim: {
        stamina: state.config.stamina,
        jumpDistance: CONFIG.sim.jumpDistance,
        stuckTurnsBeforeGiveUp: CONFIG.sim.stuckTurnsBeforeGiveUp,
      },
      // The rulebook, not board state. Every player at the table knows the scoring table.
      scoring: CONFIG.scoring,
    },
  };
}
