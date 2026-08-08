/**
 * A small seeded PRNG for the bots.
 *
 * Deliberately not `Math.random`. A bot that samples part of the board or picks softmax-
 * weighted among good moves is making random choices, and a match you cannot replay is a
 * match you cannot debug — "it placed something strange on turn 3" is only actionable if
 * turn 3 can be run again. The seed lives on the Room, so a whole match is reproducible.
 *
 * This is emphatically *not* for the simulation, which must never consult a random source
 * at all. See CLAUDE.md: determinism there is what lets the server send a whole walk phase
 * as one payload.
 */

/** mulberry32 — tiny, fast, and good enough for choosing between tile placements. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, in place. */
export function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}
