import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.ts';
import { generateMap } from '../sim/generate.mjs';
import { at, isStopper, isWalkable, parseMap } from '../sim/map.ts';
import { simulateWalk } from '../sim/simulate.ts';
import { budgetFor, chooseMove } from './ai/bot.ts';
import { makeRng } from './ai/rng.ts';
import { buildView, type BotView } from './ai/view.ts';
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
import {
  DIFFICULTIES,
  DOGS,
  type Difficulty,
  type Phase,
  type PublicPlayer,
  type ServerMessage,
  type WireTile,
} from './protocol.ts';

export type Connection = { send(msg: ServerMessage): void };

export type Player = {
  id: string;
  token: string;
  name: string;
  dogId: string | null;
  /**
   * Whether there is a person behind this seat.
   *
   * This is not the same question as `ai`. `kind` decides everything to do with *presence*
   * — a bot has no socket, so it can never be disconnected, can never rejoin by token, and
   * must never hold the host seat. `ai` decides who chooses the placements, and a human
   * on autopilot is a human seat played by the computer.
   */
  kind: 'human' | 'bot';
  /** Set for every bot, and for a human watching the computer play their dog. */
  ai: Difficulty | null;
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
 * Names for computer opponents. Obviously dogs and obviously not your friends, so nobody
 * spends a lobby wondering which of these is Dave.
 */
const BOT_NAMES = [
  'Bitmap', 'Nybble', 'Pixel', 'Cache', 'Router', 'Sudo', 'Kernel', 'Daemon',
];

function botName(difficulty: Difficulty, players: ReadonlyMap<string, Player>): string {
  const taken = new Set([...players.values()].map((p) => p.name));
  const base = BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot ${players.size + 1}`;
  return base;
}

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
  /**
   * Epoch ms when the host's connection dropped, or null while they are here. Once this is
   * older than `hostGraceMs` anyone else may take the seat — see `claimHost`. Public so a
   * test can backdate it rather than sleeping out the grace period.
   */
  hostAwaySince: number | null = null;
  /** Fires once when the grace expires, purely so the claim button appears unprompted. */
  private hostTimer: NodeJS.Timeout | null = null;

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

  /**
   * Which turn `runBots` is currently working on, so overlapping triggers cannot
   * double-place. Scoped to the turn rather than a plain boolean: locking the last bot can
   * resolve the turn synchronously, and a flag that just said "busy" would make the *next*
   * turn skip its bots and sit out the full timer.
   */
  private botsRunningFor: string | null = null;
  /**
   * Seeded, so a match played against computer opponents can be replayed exactly. The sim
   * itself stays pure — this randomness only ever chooses between placements.
   */
  private readonly rng = makeRng(Math.floor(Math.random() * 2 ** 31));

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
    // A person always beats a machine for a seat. Done before the capacity check, or a
    // room the host filled with opponents would turn away the friend who just walked in.
    if (this.players.size >= CONFIG.lobby.maxPlayers && CONFIG.lobby.evictBotsForHumans) {
      this.evictWeakestBot();
    }
    if (this.players.size >= CONFIG.lobby.maxPlayers) return { error: 'That game is full (8 players).' };

    const player: Player = {
      id: randomUUID(),
      token: randomUUID(),
      name: name.trim().slice(0, 16) || `Player ${this.players.size + 1}`,
      dogId: null,
      kind: 'human',
      ai: null,
      conn,
      pending: null,
      locked: false,
      matchScore: 0,
      roundScore: 0,
      seat: this.players.size,
    };
    this.players.set(player.id, player);
    if (this.hostId === null) {
      this.hostId = player.id;
      this.hostAwaySince = null;
    }
    return player;
  }

  // --- computer opponents ------------------------------------------------------------

  /** Weakest first, so eviction gives up the least interesting opponent in the room. */
  private evictWeakestBot(): boolean {
    const bots = [...this.players.values()].filter((p) => p.kind === 'bot');
    if (bots.length === 0) return false;
    const rank = (p: Player) => DIFFICULTIES.indexOf(p.ai ?? DIFFICULTIES[0]!);
    bots.sort((a, b) => rank(a) - rank(b));
    this.players.delete(bots[0]!.id);
    return true;
  }

  addBot(playerId: string, difficulty: Difficulty): string | null {
    if (playerId !== this.hostId) return 'Only the host can add an opponent.';
    if (!this.isOpen) return 'The match has already started.';
    if (!DIFFICULTIES.includes(difficulty)) return 'No such difficulty.';
    if (this.players.size >= CONFIG.lobby.maxPlayers) return 'That game is full (8 players).';

    const taken = new Set([...this.players.values()].map((p) => p.dogId));
    const dog = DOGS.find((d) => !taken.has(d.id));
    if (!dog) return 'Every dog is taken.';

    const bot: Player = {
      id: randomUUID(),
      // A bot has no session to resume. The token exists only so the field is never null;
      // `rejoin` refuses to match a bot regardless.
      token: randomUUID(),
      name: botName(difficulty, this.players),
      dogId: dog.id,
      kind: 'bot',
      ai: difficulty,
      conn: null,
      pending: null,
      locked: false,
      matchScore: 0,
      roundScore: 0,
      seat: this.players.size,
    };
    this.players.set(bot.id, bot);
    this.broadcast();
    return null;
  }

  removeBot(playerId: string, botId: string): string | null {
    if (playerId !== this.hostId) return 'Only the host can remove an opponent.';
    if (!this.isOpen) return 'The match has already started.';
    const bot = this.players.get(botId);
    if (!bot || bot.kind !== 'bot') return 'That is not a computer opponent.';
    this.players.delete(botId);
    this.broadcast();
    return null;
  }

  /**
   * Hand your own dog to the computer, or take it back.
   *
   * Deliberately self-only and allowed mid-match: the point is to be able to sit back and
   * watch, and with every seat on autopilot the whole match plays itself. The takeover
   * happens at the next placement turn, because that is when placements are chosen.
   */
  setAutopilot(playerId: string, difficulty: Difficulty | null): string | null {
    const p = this.players.get(playerId);
    if (!p) return 'Unknown player.';
    if (p.kind === 'bot') return 'That seat is already a computer opponent.';
    if (difficulty !== null && !DIFFICULTIES.includes(difficulty)) return 'No such difficulty.';
    p.ai = difficulty;
    this.broadcast();
    // Taking over mid-turn means this turn still needs a placement from somebody.
    if (difficulty !== null && this.phase === 'place') void this.runBots();
    return null;
  }

  /** Reconnect by token. A phone that locked its screen mid-turn should not kill the game. */
  rejoin(token: string, conn: Connection): Player | { error: string } {
    // Humans only: a bot's token belongs to no session, and a socket that guessed one
    // would be handed a seat that is not a person's to take.
    const player = [...this.players.values()].find((p) => p.kind === 'human' && p.token === token);
    if (!player) return { error: 'We do not recognise that session.' };
    player.conn = conn;
    // Back inside the grace window, so the seat was never actually up for grabs. A host who
    // reloads the page keeps the room; one who was claimed while away does not get it back.
    if (player.id === this.hostId) this.markHostPresent();
    return player;
  }

  dropConnection(conn: Connection) {
    this.spectators.delete(conn);
    for (const p of this.players.values()) {
      if (p.kind === 'bot' || p.conn !== conn) continue;
      p.conn = null;
      if (p.id === this.hostId) this.markHostAway();
    }
    // A player who drops mid-placement forfeits that turn on the timer; nothing stalls.
    this.broadcast();
  }

  // --- the host seat -----------------------------------------------------------------

  /**
   * Is the host's seat currently open? True when nobody holds it, or when the holder's
   * socket has been gone longer than the grace period.
   *
   * This is the whole answer to "how do we know the host left": we do not, and cannot —
   * we only know their socket is shut. A closed tab reports that immediately; a phone that
   * walked out of range reports it once the heartbeat in index.ts gives up pinging. Either
   * way the room asks the people still in it rather than guessing.
   */
  get hostAway(): boolean {
    if (this.hostId === null || !this.players.has(this.hostId)) return true;
    // Defensive: nothing assigns the seat to a bot, and a room that somehow did would be
    // one no human could ever start.
    if (this.players.get(this.hostId)!.kind === 'bot') return true;
    return this.hostAwaySince !== null && Date.now() - this.hostAwaySince >= CONFIG.lobby.hostGraceMs;
  }

  /** Take the empty host seat. Anyone in the room may, which is the point. */
  claimHost(playerId: string): string | null {
    const player = this.players.get(playerId);
    if (!player) return 'Unknown player.';
    if (player.kind === 'bot') return 'A computer opponent cannot host.';
    if (playerId === this.hostId) return 'You are already the host.';
    if (!this.hostAway) return 'The host is still here.';
    this.hostId = playerId;
    this.markHostPresent();
    this.broadcast();
    return null;
  }

  private markHostAway() {
    this.hostAwaySince = Date.now();
    if (this.hostTimer) clearTimeout(this.hostTimer);
    // Nothing else would wake the room when the grace runs out, and a claim button that
    // only appears on the next unrelated state change is a button nobody finds.
    this.hostTimer = setTimeout(() => {
      this.hostTimer = null;
      this.broadcast();
    }, CONFIG.lobby.hostGraceMs).unref();
  }

  private markHostPresent() {
    this.hostAwaySince = null;
    if (this.hostTimer) clearTimeout(this.hostTimer);
    this.hostTimer = null;
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
    this.maybeResolve();
    return null;
  }

  /**
   * End the turn early once nobody has anything left to decide.
   *
   * Shared with the bot driver, which can also finish a seat's turn — a bot with no legal
   * square forfeits without a pending tile, so it cannot go through `lock()`, and without
   * this the room would wait out the full timer for a decision already made.
   */
  private maybeResolve(): void {
    const seated = [...this.players.values()].filter((x) => x.dogId);
    if (seated.length > 0 && seated.every((x) => x.locked)) {
      this.clearTimer();
      this.resolveTurn();
    }
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
    // Bots think on the placement turns and nowhere else. Started after the broadcast so
    // clients see the new turn immediately rather than after the search.
    if (phase === 'place') void this.runBots();
    // unref: the phase timer must not be what keeps the process alive. The HTTP server
    // holds the loop open in production, and without this a Room created in a test pins
    // the runner open until every phase has played out.
    if (ms !== null) this.timer = setTimeout(next, ms).unref();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // --- computer players ---------------------------------------------------------------

  /**
   * What a seat is allowed to know, built from the payload its client would receive.
   *
   * The narrowing is the point: `stateFor` returns a `ServerMessage`, and taking only the
   * `state` variant means a bot's view can contain nothing the browser would not also get.
   * Secret tiles are absent because `stateFor` never serialises them.
   */
  viewFor(playerId: string): BotView | null {
    const state = this.stateFor(playerId);
    if (state.t !== 'state') return null;
    return buildView(state);
  }

  /**
   * Let every computer-controlled seat take its turn.
   *
   * Bots go through `place()` and `lock()` — the same methods a human's socket message
   * reaches. There is no privileged path, so legality, the collision-into-scuff rule and
   * the turn timer apply to them by construction rather than by good intentions.
   *
   * Guarded against overlap because it is fired both by entering a placement turn and by
   * someone switching their dog to autopilot mid-turn.
   */
  private async runBots(): Promise<void> {
    const mine = `${this.round}:${this.turn}`;
    if (this.botsRunningFor === mine) return;
    /** Has the room moved on? Anything decided for a turn that is gone would land on the next. */
    const stale = () => this.phase !== 'place' || `${this.round}:${this.turn}` !== mine;
    if (stale()) return;

    this.botsRunningFor = mine;
    try {
      // Looped rather than a single pass over a captured list, so a seat switched to
      // autopilot while the others were thinking still gets played this turn.
      for (;;) {
        const seats = [...this.players.values()].filter((p) => p.dogId && p.ai && !p.locked);
        if (seats.length === 0 || stale()) return;

        const budgets = budgetFor(seats.map((p) => p.ai!));
        for (let i = 0; i < seats.length; i++) {
          const p = seats[i]!;
          if (stale()) return;
          if (p.locked || !p.ai) continue;

          const view = this.viewFor(p.id);
          if (!view) continue;
          const move = await chooseMove(view, p.ai, Date.now() + budgets[i]!, this.rng);

          if (stale()) return;
          // A bot with nothing legal to place forfeits the turn, exactly as a human who
          // never chose a square does — but it must still lock, or the room waits out the
          // whole timer for a decision that has already been made.
          if (move && !this.place(p.id, move.x, move.y, move.kind)) {
            this.lock(p.id);
          } else {
            p.locked = true;
            this.broadcast();
            this.maybeResolve();
          }
        }
      }
    } finally {
      this.botsRunningFor = null;
    }
  }

  stateFor(playerId: string | null): ServerMessage {
    const p = playerId ? this.players.get(playerId) : null;
    const players: PublicPlayer[] = [...this.players.values()].map((q) => ({
      id: q.id,
      name: q.name,
      dogId: q.dogId,
      // A bot has no socket and is never absent. Reporting it the way a null conn is
      // otherwise reported would grey every opponent out as though they had all left.
      connected: q.kind === 'bot' || q.conn !== null,
      isHost: q.id === this.hostId,
      isBot: q.kind === 'bot',
      ai: q.ai,
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
      hostAway: this.hostAway,
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
        difficulties: DIFFICULTIES.map((id) => ({ id, label: CONFIG.ai.levels[id].label })),
      },
    };
  }

  broadcast() {
    for (const p of this.players.values()) p.conn?.send(this.stateFor(p.id));
    for (const s of this.spectators) s.send(this.stateFor(null));
  }
}
