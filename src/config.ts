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
    /**
     * What a dog does when the tile ahead is blocked. Measured with
     * `node scripts/wall-rule.ts`; the numbers and the reasoning are in DESIGN.md §4.6.
     *
     * `right` was chosen when placed tiles were permanent, to stop dogs being trapped too
     * easily. Tiles are single use now, so the constraint has relaxed — but `around` is not
     * the answer: reversing collapses a dog's path to a single row, it shuttles back and
     * forth over about six tiles, and loop detection culls 80-90% of rounds.
     *
     * `open` — look both ways, go where you can see further, ties to the right — beats
     * `right` on every board, and turns loop-culled rounds into dogs that tucker out, which
     * is how §4.4 says a round is meant to end.
     */
    wallRule: 'right' as 'right' | 'around' | 'open',
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
    /**
     * How long the host's seat stays theirs after their socket drops, before anyone else
     * may claim it. Only the *host* is gated this way — a lobby whose host closed the tab
     * is unstartable, and there is nobody with authority to fix it, so the fix has to be
     * available to whoever is still in the room.
     *
     * Long enough to cover a page reload or a phone unlocking (both reconnect in about a
     * second), short enough that a room whose host actually walked away is not stuck for a
     * whole round. See heartbeatMs — a host who leaves the Wi-Fi is not detected until the
     * heartbeat gives up on them, and that wait comes *before* this one.
     */
    hostGraceMs: 15_000,
    /**
     * A person always beats a machine for a seat. When someone opens the URL and the room
     * is full of opponents, the weakest one stands up rather than turning the human away.
     * Only between matches — a bot that is mid-match is holding a dog with a score.
     */
    evictBotsForHumans: true,
    /**
     * WebSocket ping interval. A closed tab sends a TCP FIN and we hear about it at once,
     * but a phone that leaves Wi-Fi or goes flat says nothing at all — without a heartbeat
     * that socket stays "open" until the OS TCP timeout, which is minutes. Two missed
     * pings (2 x this) and the connection is terminated, which is what makes
     * `connected: false` mean something.
     */
    heartbeatMs: 8_000,
  },

  /**
   * Computer opponents.
   *
   * The whole design rests on one measurement: `simulateWalk` is a pure function costing
   * 0.036 ms on the small board and 0.140 ms on the large one, and there are only 250-785
   * legal placements in a turn. Scoring *every* legal placement by simulating the actual
   * round therefore costs about a tenth of a second. A bot never needs a heuristic
   * evaluation function, because it can afford to ask the real rules what happens.
   *
   * That is why even the weakest opponent is strategic: it is not guessing, it is picking
   * a move it has watched play out. The difficulty ladder is about how much of the *rest*
   * of the game each tier models, not about whether it understands the board.
   */
  ai: {
    /**
     * Total thinking time for the whole bot team per placement turn, shared out by
     * difficulty. Not per bot: seven opponents each taking a second would freeze the one
     * thread the server has, and every human's board would stop responding while they
     * thought. The search yields to the event loop throughout, so this is a budget, not a
     * stall.
     *
     * 3s of a 30s turn buys ~21,000 simulations on the large board and ~85,000 on the
     * small one. That is far more than the current search can spend.
     */
    turnBudgetMs: 3_000,
    /** Floor per bot, so a full lobby of eight still leaves each one able to think. */
    minBudgetMs: 60,
    /**
     * The ladder. `lambda` weighs opponents' scores against the bot's own, and is what
     * makes the tiers feel like different players rather than the same player with better
     * eyesight: at 0 the bot does not know you exist, and at 0.75 it will spend a
     * placement to spoil your route.
     *
     * `sampleFraction` below 1 means the bot only looks at part of the board, and
     * `temperature` above 0 means it picks softmax-weighted among the moves it liked
     * rather than always the best one. Both are ways of being beatable that still leave
     * every individual move a considered one.
     */
    levels: {
      pup: { label: 'Pup', lambda: 0, sampleFraction: 0.45, temperature: 1.6, weight: 1 },
      scout: { label: 'Scout', lambda: 0.25, sampleFraction: 1, temperature: 0, weight: 2 },
    },
  },
} as const;

export type Config = typeof CONFIG;
