/**
 * Every tuning knob in the game, in one place.
 *
 * The values marked TUNE in DESIGN.md live here. Change them, run `npm test`, and the
 * sim tests will tell you if you broke termination. Nothing else in the codebase should
 * hard-code a game number.
 */

export const CONFIG = {
  /** 9663 = WOOF on a phone keypad. */
  port: Number(process.env.PORT ?? 9663),

  sim: {
    /**
     * The termination guarantee. A dog's state is (position, facing), so the sim is a
     * deterministic finite automaton and every dog MUST eventually loop forever unless
     * something stops it. Stamina is that something; loop detection below is only there
     * to end doomed rounds early rather than to guarantee they end.
     *
     * On the open playfield this is also the primary *pacing* mechanism, not just a safety
     * net: stopping points are sparse, so most dogs walk until they are tired. 70 ticks is
     * a 14-second walk phase at 5 ticks/second. Measured with scripts/tune.mjs.
     */
    stamina: 30,
    /**
     * Playback speed on the client. Does not affect the simulation itself.
     * 1.5 seconds per tile — slow enough to follow every dog, brisk enough to keep moving.
     */
    ticksPerSecond: 1 / 1.5,
    /** A dog boxed in on all four sides gives up after turning in place this many times. */
    stuckTurnsBeforeGiveUp: 4,
    /** Jump distance in tiles. The tile passed over is not collected. */
    jumpDistance: 2,
  },

  scoring: {
    /** Indexed by how many dogs got here first: 1st dog 2pts, 2nd 1pt, everyone after 0. */
    sniffByVisitOrder: [2, 1],
    /** Consumed on first visit. */
    treat: 3,
    /** Two dogs bumping into each other. Once per pair per round. */
    greet: 1,
    /** Chased it up the tree. Big points, but the run ends here. */
    squirrel: 5,
    /** Wet dog. */
    lake: -2,
    /** Neutral. Exists to break perimeter loops. */
    drain: 0,
  },

  round: {
    /** Placements per round. Turn 5 is the secret turn. */
    turns: 5,
    /** The last turn is not revealed until a dog steps on the tile mid-walk. */
    secretTurn: 5,
    /** Default match length. The host can change it in the lobby, up to maxRounds. */
    roundsPerMatch: 3,
    /** Three rounds is already ~10 minutes; more is a slog, not a longer game. */
    maxRounds: 3,
  },

  timers: {
    setupMs: 10_000,
    firstTurnMs: 40_000,
    turnMs: 30_000,
    revealMs: 4_000,
    /**
     * Scoring is not on a clock — it lasts exactly as long as the podium takes to read out
     * the placings, one dog at a time, plus a beat at each end. A fixed timer either cut a
     * big game off mid-countdown or left a small one staring at nothing.
     */
    scorePerPlacingMs: 2_600,
    scorePadMs: 1_800,
  },

  /**
   * Board sizes, picked by how many players are in the match. A 16x16 board with three
   * dogs on it is a lonely game; a 10x10 with eight is a scrum. Stamina is per board and
   * measured with scripts/tune.mjs. Roughly a 48/70/82-second walk phase at 0.5 ticks/sec.
   *
   * Worth knowing before you turn these up further: past about this point stamina stops
   * being the binding constraint. Median dog life plateaus because dogs start ending on a
   * stopping point or in a detected loop instead, so extra stamina only lengthens the tail
   * and the round. If dogs still feel short-lived, thin the stopping points on that board
   * rather than adding stamina.
   */
  boards: [
    { name: 'small', file: 'small.txt', size: 10, maxPlayers: 3, stamina: 36 },
    { name: 'medium', file: 'medium.txt', size: 13, maxPlayers: 5, stamina: 34 },
    { name: 'large', file: 'large.txt', size: 16, maxPlayers: 8, stamina: 40 },
  ],

  /**
   * Generate a fresh map for every match rather than replaying the shipped ones.
   *
   * Per *match*, not per round: a match is three rounds on one board, and knowing the
   * ground is most of the skill — where the squirrel is, which lane the fence blocks.
   * Re-rolling between rounds would throw that away every 90 seconds. The `maps/*.txt`
   * files stay as the lobby preview, a hand-authoring starting point, and the fixture the
   * map tests read.
   */
  freshMapEachMatch: true,

  lobby: {
    maxPlayers: 8,
    /**
     * One is allowed. Solo is useful for testing the whole loop without rounding up seven
     * friends, and it is a legitimate way to play — with no opponents it becomes a pure
     * route-optimisation puzzle against the board.
     */
    minPlayers: 1,
  },
} as const;

export type Config = typeof CONFIG;
