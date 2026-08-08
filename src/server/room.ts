import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.ts';
import { generateMap } from '../sim/generate.mjs';
import { at, isStopper, isWalkable, parseMap } from '../sim/map.ts';
import { simulateWalk } from '../sim/simulate.ts';
import {
  TILE,
  TILE_PALETTE,
  key,
  type DogInit,
  type DogSnapshot,
  type GameMap,
  type PlacedTile,
  type TileKind,
} from '../sim/types.ts';
import { DOGS, type Phase, type PublicPlayer, type ServerMessage, type WireTile } from './protocol.ts';

export type Connection = { send(msg: ServerMessage): void };

type Player = {
  id: string;
  token: string;
  name: string;
  dogId: string | null;
  conn: Connection | null;
  pending: { x: number; y: number; kind: TileKind } | null;
  locked: boolean;
  matchScore: number;
  roundScore: number;
  /** Index into map.starts for the current round. Reshuffled each round. */
  seat: number;
};

export type Board = {
  name: string;
  /** Steps a dog gets on this board. Bigger boards need more; see CONFIG.boards. */
  stamina: number;
  maxPlayers: number;
  /** Edge length, used to generate a fresh map of the same shape for a new match. */
  size: number;
  map: GameMap;
  /** Terrain as strings, precomputed once for the wire format. */
  rows: string[];
};

/** Terrain as one string per row — the shape the client wants. */
export const boardRows = (map: GameMap): string[] =>
  Array.from({ length: map.height }, (_, y) =>
    map.terrain.slice(y * map.width, (y + 1) * map.width).join(''),
  );

/**
 * A board of the same size and stamina but a freshly generated map. Called once per match,
 * so every match is a new place to learn rather than the same board three times.
 */
export function freshBoard(base: Board, seed = Math.floor(Math.random() * 1e9)): Board {
  const { text } = generateMap({ size: base.size, seed });
  const map = parseMap(text, `${base.name} #${seed}`);
  return { ...base, map, rows: boardRows(map) };
}

/**
 * The single game in progress. Everyone is on the same LAN, so there is one room per
 * server and no join codes — open the URL and you are in it.
 */
export class Room {
  private readonly boards: Board[];
  /** Fixed when the match starts, so the board cannot change mid-match if someone drops. */
  private chosen: Board | null = null;

  players = new Map<string, Player>();
  spectators = new Set<Connection>();
  hostId: string | null = null;

  phase: Phase = 'lobby';
  round = 0;
  turn = 0;
  deadline: number | null = null;
  /** Set by the host before starting. Defaults to CONFIG, but it is their call. */
  roundsPerMatch: number = CONFIG.round.roundsPerMatch;

  /** Committed tiles visible to everyone. */
  private tiles = new Map<string, PlacedTile>();
  /** Committed on the secret turn. Merged into the sim, never sent to clients. */
  private secretTiles = new Map<string, PlacedTile>();

  private dogs: DogSnapshot[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(boards: Board[]) {
    this.boards = [...boards].sort((a, b) => a.maxPlayers - b.maxPlayers);
  }

  /** Smallest board that fits the group. In the lobby this tracks the player count live. */
  get board(): Board {
    if (this.chosen) return this.chosen;
    const n = [...this.players.values()].filter((p) => p.dogId).length || this.players.size || 2;
    return this.boards.find((b) => n <= b.maxPlayers) ?? this.boards.at(-1)!;
  }

  get map(): GameMap {
    return this.board.map;
  }

  // --- membership -------------------------------------------------------------------

  /** Between matches the room is open again: people can join, leave and re-pick dogs. */
  private get isOpen() {
    return this.phase === 'lobby' || this.phase === 'match-end';
  }

  addPlayer(name: string, conn: Connection): Player | { error: string } {
    if (!this.isOpen) return { error: 'That game is already in progress.' };
    if (this.players.size >= CONFIG.lobby.maxPlayers) return { error: 'That game is full (8 players).' };

    const player: Player = {
      id: randomUUID(),
      token: randomUUID(),
      name: name.trim().slice(0, 16) || `Player ${this.players.size + 1}`,
      dogId: null,
      conn,
      pending: null,
      locked: false,
      matchScore: 0,
      roundScore: 0,
      seat: this.players.size,
    };
    this.players.set(player.id, player);
    this.hostId ??= player.id;
    return player;
  }

  /** Reconnect by token. A phone that locked its screen mid-turn should not kill the game. */
  rejoin(token: string, conn: Connection): Player | { error: string } {
    const player = [...this.players.values()].find((p) => p.token === token);
    if (!player) return { error: 'We do not recognise that session.' };
    player.conn = conn;
    return player;
  }

  dropConnection(conn: Connection) {
    this.spectators.delete(conn);
    for (const p of this.players.values()) if (p.conn === conn) p.conn = null;
    // A player who drops mid-placement forfeits that turn on the timer; nothing stalls.
    this.broadcast();
  }

  pickDog(playerId: string, dogId: string): string | null {
    const player = this.players.get(playerId);
    if (!player) return 'Unknown player.';
    if (!this.isOpen) return 'The game is already in progress.';
    if (!DOGS.some((d) => d.id === dogId)) return 'No such dog.';
    if ([...this.players.values()].some((p) => p !== player && p.dogId === dogId))
      return 'Somebody already has that dog.';
    player.dogId = dogId;
    this.broadcast();
    return null;
  }

  /** How many rounds the next match runs. Only meaningful between matches. */
  setRounds(playerId: string, rounds: number): string | null {
    if (playerId !== this.hostId) return 'Only the host can change the match length.';
    if (!this.isOpen) return 'The match has already started.';
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > CONFIG.round.maxRounds)
      return `Pick between 1 and ${CONFIG.round.maxRounds} rounds.`;
    this.roundsPerMatch = rounds;
    this.broadcast();
    return null;
  }

  /**
   * Stop the match where it stands and jump to the final standings. Scores earned so far
   * stand — this is "we're done", not "throw it away".
   */
  endMatch(playerId: string): string | null {
    if (playerId !== this.hostId) return 'Only the host can end the match.';
    if (this.phase === 'lobby' || this.phase === 'match-end') return 'No match is running.';
    this.enter('match-end', null, () => {});
    return null;
  }

  // --- match / round flow ------------------------------------------------------------

  start(playerId: string): string | null {
    if (playerId !== this.hostId) return 'Only the host can start.';
    // 'match-end' is allowed so the host can run a rematch without restarting the server.
    if (!this.isOpen) return 'Already started.';
    const seated = [...this.players.values()].filter((p) => p.dogId);
    const min = CONFIG.lobby.minPlayers;
    if (seated.length < min)
      return `Need at least ${min} player${min > 1 ? 's' : ''} with a dog.`;
    // Clear the previous match's board *before* re-resolving, or `board` just returns the
    // frozen one and a rematch with more players would keep playing the smaller board.
    this.chosen = null;
    const base = this.board;
    this.chosen = CONFIG.freshMapEachMatch ? freshBoard(base) : base;
    for (const p of this.players.values()) p.matchScore = 0;
    this.round = 0;
    this.beginRound();
    return null;
  }

  private beginRound() {
    this.round += 1;
    this.turn = 0;
    this.tiles.clear();
    this.secretTiles.clear();

    // Seats are reshuffled every round so nobody keeps a favourable start position.
    const seated = [...this.players.values()].filter((p) => p.dogId);
    const order = seated.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    seated.forEach((p, i) => {
      p.seat = order[i]!;
      p.pending = null;
      p.locked = false;
      p.roundScore = 0;
    });

    this.dogs = this.dogInits().map((d) => ({
      id: d.id,
      x: d.x,
      y: d.y,
      dir: d.dir,
      stamina: this.board.stamina,
      score: 0,
      stopped: null,
      jumped: false,
    }));

    this.enter('setup', CONFIG.timers.setupMs, () => this.beginTurn());
  }

  private beginTurn() {
    this.turn += 1;
    for (const p of this.players.values()) {
      p.pending = null;
      p.locked = false;
    }
    const ms = this.turn === 1 ? CONFIG.timers.firstTurnMs : CONFIG.timers.turnMs;
    this.enter('place', ms, () => this.resolveTurn());
  }

  /** Called when every player has locked, or when the turn timer runs out. */
  private resolveTurn() {
    const seated = [...this.players.values()].filter((p) => p.dogId);
    const secret = this.turn === CONFIG.round.secretTurn;

    // A tile sitting on the board unlocked when the timer runs out counts as placed — the
    // player chose a square, they just didn't press the button. Anyone who chose nothing
    // simply forfeits this turn's placement; there is no auto-placement.
    const skipped = seated.filter((p) => !p.pending).map((p) => p.id);

    const bySquare = new Map<string, Player[]>();
    for (const p of seated) {
      if (!p.pending) continue;
      const k = key(p.pending.x, p.pending.y);
      bySquare.set(k, [...(bySquare.get(k) ?? []), p]);
    }

    const target = secret ? this.secretTiles : this.tiles;
    const placed: WireTile[] = [];
    const cancelled: { x: number; y: number; playerIds: string[] }[] = [];

    for (const [k, group] of bySquare) {
      const { x, y, kind } = group[0]!.pending!;
      if (group.length > 1) {
        // Two players fighting over a square jointly build a wall there. Both tiles are
        // spent; the square becomes an obstacle for everyone, including them.
        target.set(k, { kind: TILE.SCUFF, ownerId: null, secret });
        cancelled.push({ x, y, playerIds: group.map((p) => p.id) });
      } else {
        target.set(k, { kind, ownerId: group[0]!.id, secret });
        placed.push({ x, y, kind, ownerId: group[0]!.id });
      }
      // Tiles are not consumed: nothing is removed from anyone's supply here.
      for (const p of group) {
        p.pending = null;
        p.locked = false;
      }
    }

    if (secret) {
      this.beginWalk();
      return;
    }

    const reveal: ServerMessage = { t: 'reveal', placed, cancelled, skipped };
    for (const p of this.players.values()) p.conn?.send(reveal);
    for (const s of this.spectators) s.send(reveal);

    this.enter('reveal', CONFIG.timers.revealMs, () =>
      this.turn >= CONFIG.round.turns ? this.beginWalk() : this.beginTurn(),
    );
  }

  private beginWalk() {
    const inits = this.dogInits();
    const all = new Map<string, PlacedTile>([...this.tiles, ...this.secretTiles]);
    const cfg = { ...CONFIG, sim: { ...CONFIG.sim, stamina: this.board.stamina } };
    const result = simulateWalk(this.map, inits, all, cfg);

    const byDog = new Map(result.scores.map((s) => [s.dogId, s]));
    for (const p of this.players.values()) {
      if (!p.dogId) continue;
      p.roundScore = byDog.get(p.id)?.score ?? 0;
      p.matchScore += p.roundScore;
    }
    this.dogs = result.ticks.at(-1)!.dogs;

    const msg: ServerMessage = {
      t: 'walk',
      ticks: result.ticks,
      tickMs: 1000 / CONFIG.sim.ticksPerSecond,
      scores: result.scores.map((s) => ({
        dogId: this.players.get(s.dogId)?.dogId ?? '',
        playerId: s.dogId,
        score: s.score,
        stopped: s.stopped,
      })),
    };
    for (const p of this.players.values()) p.conn?.send(msg);
    for (const s of this.spectators) s.send(msg);

    // Hold the phase for as long as playback takes, plus a beat.
    const playbackMs = result.ticks.length * (1000 / CONFIG.sim.ticksPerSecond) + 1500;
    // Long enough for every dog to take its turn on the podium.
    const placings = [...this.players.values()].filter((p) => p.dogId).length;
    const scoreMs = placings * CONFIG.timers.scorePerPlacingMs + CONFIG.timers.scorePadMs;

    this.enter('walk', playbackMs, () =>
      this.enter('score', scoreMs, () =>
        this.round >= this.roundsPerMatch
          ? this.enter('match-end', null, () => {})
          : this.beginRound(),
      ),
    );
  }

  private dogInits(): DogInit[] {
    return [...this.players.values()]
      .filter((p) => p.dogId)
      .map((p) => {
        const s = this.map.starts[p.seat % this.map.starts.length]!;
        return { id: p.id, breed: p.dogId!, x: s.x, y: s.y, dir: s.dir };
      });
  }

  // --- placement --------------------------------------------------------------------

  place(playerId: string, x: number, y: number, kind: TileKind): string | null {
    const p = this.players.get(playerId);
    if (!p || !p.dogId) return 'You are not playing this round.';
    if (this.phase !== 'place') return 'Not a placement turn.';
    if (p.locked) return 'You have already locked in.';
    if (!TILE_PALETTE.includes(kind)) return 'No such tile.';
    const why = this.illegalSquare(x, y);
    if (why) return why;
    p.pending = { x, y, kind };
    this.broadcast();
    return null;
  }

  unplace(playerId: string): void {
    const p = this.players.get(playerId);
    if (p && !p.locked) p.pending = null;
    this.broadcast();
  }

  lock(playerId: string): string | null {
    const p = this.players.get(playerId);
    if (!p || !p.dogId) return 'You are not playing this round.';
    if (this.phase !== 'place') return 'Not a placement turn.';
    if (!p.pending) return 'Place a tile first.';
    p.locked = true;
    this.broadcast();

    const seated = [...this.players.values()].filter((x) => x.dogId);
    if (seated.every((x) => x.locked)) {
      this.clearTimer();
      this.resolveTurn();
    }
    return null;
  }

  /**
   * Start squares that actually have a dog on them this round. Every board has eight slots
   * but a smaller game only uses the first few, and an empty slot is just ordinary ground —
   * there is no reason to fence it off.
   */
  private occupiedStarts(): Set<string> {
    const out = new Set<string>();
    for (const p of this.players.values()) {
      if (!p.dogId) continue;
      const s = this.map.starts[p.seat % this.map.starts.length]!;
      out.add(key(s.x, s.y));
    }
    return out;
  }

  private illegalSquare(x: number, y: number): string | null {
    const terrain = at(this.map, x, y);
    if (!isWalkable(terrain)) return 'Dogs cannot walk there.';
    if (isStopper(terrain)) return 'You cannot place on a stopping point.';
    if (this.tiles.has(key(x, y)) || this.secretTiles.has(key(x, y))) return 'There is already a tile there.';
    if (this.occupiedStarts().has(key(x, y))) return 'A dog is standing there.';
    return null;
  }

  // --- plumbing ---------------------------------------------------------------------

  private enter(phase: Phase, ms: number | null, next: () => void) {
    this.clearTimer();
    this.phase = phase;
    this.deadline = ms === null ? null : Date.now() + ms;
    this.broadcast();
    // unref: the phase timer must not be what keeps the process alive. The HTTP server
    // holds the loop open in production, and without this a Room created in a test pins
    // the runner open until every phase has played out.
    if (ms !== null) this.timer = setTimeout(next, ms).unref();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  stateFor(playerId: string | null): ServerMessage {
    const p = playerId ? this.players.get(playerId) : null;
    const players: PublicPlayer[] = [...this.players.values()].map((q) => ({
      id: q.id,
      name: q.name,
      dogId: q.dogId,
      connected: q.conn !== null,
      isHost: q.id === this.hostId,
      locked: q.locked,
      matchScore: q.matchScore,
      roundScore: q.roundScore,
    }));

    // Secret tiles are deliberately absent: clients learn about them from reveal events
    // inside the walk payload, at the tick a dog actually steps on one.
    const tiles: WireTile[] = [...this.tiles].map(([k, tile]) => {
      const [x, y] = k.split(',').map(Number) as [number, number];
      return { x, y, kind: tile.kind, ownerId: tile.ownerId };
    });

    return {
      t: 'state',
      phase: this.phase,
      round: this.round,
      turn: this.turn,
      deadline: this.deadline,
      players,
      tiles,
      dogs: this.dogs,
      pending: p?.pending ?? null,
      you: p?.id ?? null,
      map: {
        name: this.board.name,
        width: this.map.width,
        height: this.map.height,
        rows: this.board.rows,
      },
      config: {
        ticksPerSecond: CONFIG.sim.ticksPerSecond,
        stamina: this.board.stamina,
        turns: CONFIG.round.turns,
        roundsPerMatch: this.roundsPerMatch,
        maxRounds: CONFIG.round.maxRounds,
        minPlayers: CONFIG.lobby.minPlayers,
        /** How long each dog holds the podium, so the client can pace its read-out. */
        scorePerPlacingMs: CONFIG.timers.scorePerPlacingMs,
        // Always the full set: tiles are a palette, not a hand.
        palette: [...TILE_PALETTE],
      },
    };
  }

  broadcast() {
    for (const p of this.players.values()) p.conn?.send(this.stateFor(p.id));
    for (const s of this.spectators) s.send(this.stateFor(null));
  }
}
