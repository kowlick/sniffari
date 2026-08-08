/**
 * Choosing a placement.
 *
 * Steps 1-3 of the plan: an exhaustive one-ply search. Every legal placement is scored by
 * simulating the round with that tile on the board, and the bot takes the best. On the
 * large board that is 785 simulations, about 0.11 s, which is why the weakest tier is
 * still strategic — it is not guessing at all, it is short-sighted.
 *
 * What one-ply cannot do is *chain*: turn right here so that the jump over there lands on
 * the treat. Five tiles are a route, not five independent nudges, and expressing that
 * needs the beam search from step 4. The two tiers here are honest about their ceiling.
 */

import { CONFIG } from '../../config.ts';
import type { Difficulty } from '../protocol.ts';
import { candidates, valueOfPlacement, type Placement } from './evaluate.ts';
import { shuffle } from './rng.ts';
import type { BotView } from './view.ts';

export type Level = {
  label: string;
  lambda: number;
  sampleFraction: number;
  temperature: number;
  weight: number;
};

export const LEVELS: Record<Difficulty, Level> = CONFIG.ai.levels;

/**
 * Yield to the event loop.
 *
 * The server has one thread. A lobby of seven opponents each sweeping the board would hold
 * it for the better part of a second, and every human's tile placement, lock and countdown
 * would stall while they thought. Handing control back between chunks costs almost nothing
 * and keeps the room responsive while the bots work.
 */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Candidates evaluated between yields. Big enough to amortise, small enough to be smooth. */
const CHUNK = 64;

/**
 * Pick a placement.
 *
 * Returns null only when there is genuinely nothing legal to place, which the caller must
 * treat as a forfeited turn rather than an error.
 */
export async function chooseMove(
  view: BotView,
  difficulty: Difficulty,
  deadline: number,
  rng: () => number,
): Promise<Placement | null> {
  const level = LEVELS[difficulty];
  let pool = candidates(view);
  if (pool.length === 0) return null;

  // A weaker bot looks at part of the board rather than all of it. It still evaluates
  // every option it looks at properly — it just does not see the whole table.
  if (level.sampleFraction < 1) {
    const keep = Math.max(1, Math.round(pool.length * level.sampleFraction));
    pool = shuffle([...pool], rng).slice(0, keep);
  } else {
    // Shuffled anyway so that ties do not always resolve to the top-left of the board,
    // which reads as a machine pacing the same corner every game.
    pool = shuffle([...pool], rng);
  }

  const scored: { move: Placement; value: number }[] = [];
  for (let i = 0; i < pool.length; i++) {
    scored.push({ move: pool[i]!, value: valueOfPlacement(view, pool[i]!, level.lambda) });
    if (i % CHUNK === CHUNK - 1) {
      // Out of time: go with the best of what has actually been looked at. Every tier
      // degrades to a shallower search rather than to a random move.
      if (Date.now() > deadline) break;
      await breathe();
    }
  }
  if (scored.length === 0) return null;

  if (level.temperature <= 0) {
    let best = scored[0]!;
    for (const s of scored) if (s.value > best.value) best = s;
    return best.move;
  }
  return softmaxPick(scored, level.temperature, rng);
}

/**
 * Pick among the good moves rather than always the best one.
 *
 * This is how the lower tiers are beatable without ever being silly: the distribution is
 * over moves the bot has actually evaluated and rated, so a "mistake" is preferring the
 * third-best placement, not placing somewhere pointless.
 */
function softmaxPick(
  scored: { move: Placement; value: number }[],
  temperature: number,
  rng: () => number,
): Placement {
  let max = -Infinity;
  for (const s of scored) if (s.value > max) max = s.value;

  const weights = scored.map((s) => Math.exp((s.value - max) / temperature));
  let total = 0;
  for (const w of weights) total += w;

  let roll = rng() * total;
  for (let i = 0; i < scored.length; i++) {
    roll -= weights[i]!;
    if (roll <= 0) return scored[i]!.move;
  }
  return scored[scored.length - 1]!.move;
}

/**
 * Split the shared turn budget between the seats that need to think.
 *
 * Shared rather than per bot, so that adding opponents makes the team think faster rather
 * than making the server slower. Stronger tiers get a bigger slice, and everyone gets at
 * least `minBudgetMs` so a full lobby of eight still plays properly.
 */
export function budgetFor(difficulties: Difficulty[]): number[] {
  const weights = difficulties.map((d) => LEVELS[d].weight);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) =>
    Math.max(CONFIG.ai.minBudgetMs, (CONFIG.ai.turnBudgetMs * w) / total),
  );
}
