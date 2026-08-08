/** Wire format. Every message is JSON with a `t` discriminator. */

import type { DogSnapshot, StopReason, Tick, TileKind } from '../sim/types.ts';

/**
 * The pack.
 *
 * `color` is the **player's identity colour** — it drives their tiles, their row in the
 * scoreboard, and the dog's collar. `fur` is the actual coat, which is free to be
 * realistic (the Labrador is a black lab) because identity no longer rides on it. Tying
 * the two together forced every dog to be a different implausible hue.
 *
 * Breed character comes from the shape fields: ear, fur texture, tail, overall scale, and
 * the body/leg proportions `bw` / `bh` / `leg`.
 */
export const DOGS = [
  // `muzzle` and `paws` default to cream when omitted. A solid-coloured breed sets them to
  // its own coat — a black lab has a black muzzle and a black nose, not a white snout.
  { id: 'cockapoo', name: 'Cockapoo', color: '#e8503a', fur: '#f4efe6', muzzle: '#f4efe6', paws: '#f4efe6', ear: 'floppy', furStyle: 'curly', tail: 'curl', scale: 0.84, bw: 1.05, bh: 0.95, leg: 0.85 },
  { id: 'labrador', name: 'Labrador', color: '#f0a63d', fur: '#23262b', muzzle: '#23262b', paws: '#23262b', ear: 'floppy', furStyle: 'smooth', tail: 'thin', scale: 1.05, bw: 1.02, bh: 1, leg: 1 },
  { id: 'wolfhound', name: 'Irish Wolfhound', color: '#ffd94a', fur: '#9a958a', muzzle: '#c8c2b6', paws: '#c8c2b6', ear: 'perky', furStyle: 'wire', tail: 'plume', scale: 1.16, bw: 0.85, bh: 1.1, leg: 1.35 },
  { id: 'aussie-brindle', name: 'Aussie Shepherd (brindle)', color: '#5cc26a', fur: '#a1673c', ear: 'perky', furStyle: 'smooth', tail: 'plume', scale: 1, bw: 1, bh: 1, leg: 1.05, patch: '#5c3320', patchStyle: 'brindle' },
  { id: 'aussie-bw', name: 'Aussie Shepherd (black & white)', color: '#2fb8a6', fur: '#33383f', muzzle: '#eef1f4', paws: '#eef1f4', ear: 'perky', furStyle: 'smooth', tail: 'plume', scale: 1, bw: 1, bh: 1, leg: 1.05, patch: '#eef1f4' },
  { id: 'doodle-lab', name: 'Labradoodle (cream)', color: '#4a8fe0', fur: '#f2e4c8', muzzle: '#f2e4c8', paws: '#f2e4c8', ear: 'floppy', furStyle: 'curly', tail: 'thin', scale: 1.06, bw: 1.05, bh: 1, leg: 1.1 },
  { id: 'doodle-poodle', name: 'Labradoodle (white)', color: '#9a6bd6', fur: '#f7f4ef', muzzle: '#f7f4ef', paws: '#f7f4ef', ear: 'long', furStyle: 'curly', tail: 'plume', scale: 0.98, bw: 0.92, bh: 1, leg: 1.2 },
  { id: 'beagle', name: 'Beagle mix', color: '#e8629a', fur: '#8a5a34', muzzle: '#8a5a34', paws: '#8a5a34', ear: 'long', furStyle: 'smooth', tail: 'thin', scale: 0.88, bw: 1.1, bh: 0.92, leg: 0.8 },
] as const;

export type Phase = 'lobby' | 'setup' | 'place' | 'reveal' | 'walk' | 'score' | 'match-end';

export type PublicPlayer = {
  id: string;
  name: string;
  dogId: string | null;
  connected: boolean;
  isHost: boolean;
  /** Has committed this turn's placement. The placement itself stays private until reveal. */
  locked: boolean;
  matchScore: number;
  roundScore: number;
};

export type WireTile = { x: number; y: number; kind: TileKind; ownerId: string | null };

/** Server -> client. */
export type ServerMessage =
  | { t: 'joined'; playerId: string; token: string }
  | { t: 'error'; message: string }
  | {
      t: 'state';
      phase: Phase;
      round: number;
      turn: number;
      /** Epoch ms when the current phase auto-advances, or null if it does not. */
      deadline: number | null;
      players: PublicPlayer[];
      /**
       * The host's seat is empty — nobody holds it, or the holder's socket has been gone
       * longer than the grace period. Any player may then send `claimHost`.
       */
      hostAway: boolean;
      /** Only tiles every player is allowed to see. Secret placements are omitted. */
      tiles: WireTile[];
      dogs: DogSnapshot[];
      /** Present only for the receiving player; nobody else sees a pending placement. */
      pending: { x: number; y: number; kind: TileKind } | null;
      you: string | null;
      map: { name: string; width: number; height: number; rows: string[] };
      config: {
        ticksPerSecond: number;
        stamina: number;
        turns: number;
        /** Chosen by the host in the lobby, not fixed. */
        roundsPerMatch: number;
        maxRounds: number;
        /** Dogs needed to start. 1 — solo play is allowed. */
        minPlayers: number;
        scorePerPlacingMs: number;
        /** Tile kinds available every turn. Unlimited supply — placements are the scarcity. */
        palette: TileKind[];
      };
    }
  | {
      t: 'reveal';
      placed: WireTile[];
      /** Squares where two or more players collided; each becomes a scuff. */
      cancelled: { x: number; y: number; playerIds: string[] }[];
      /** Players who ran out of time without choosing a square. They forfeit the turn. */
      skipped: string[];
    }
  | {
      t: 'walk';
      ticks: Tick[];
      tickMs: number;
      scores: { dogId: string; playerId: string; score: number; stopped: StopReason }[];
    };

/** Client -> server. One room per server on a LAN, so joining needs nothing but a name. */
export type ClientMessage =
  | { t: 'join'; name: string }
  | { t: 'rejoin'; token: string }
  | { t: 'spectate' }
  | { t: 'pickDog'; dogId: string }
  | { t: 'start' }
  /** Take the host seat when it is empty. Any player, not host only — that is the point. */
  | { t: 'claimHost' }
  /** Host only, between matches. */
  | { t: 'setRounds'; rounds: number }
  /** Host only, mid-match. Jumps to the final standings, keeping scores. */
  | { t: 'endMatch' }
  | { t: 'place'; x: number; y: number; kind: TileKind }
  | { t: 'unplace' }
  | { t: 'lock' };
