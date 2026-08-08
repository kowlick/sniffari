/** Shared vocabulary for the simulation. Deliberately free of any server/network concerns. */

/**
 * Directions are indexed clockwise starting at north, which makes a right turn `(d + 1) % 4`.
 *
 * "Right" is relative to the dog, not the screen: a dog walking down the screen turns to
 * its own right, which is screen-left. Clockwise indexing gives that for free.
 */
export const DIR = { N: 0, E: 1, S: 2, W: 3 } as const;
export type Dir = 0 | 1 | 2 | 3;

/** Terrain characters, matching the ASCII map format exactly. See maps/README.md. */
export const T = {
  WALL: '#',
  STREET: '.',
  PARK: ',',
  SNIFF: 'S',
  PERSON: 'P',
  SQUIRREL: 'Q',
  LAKE: '~',
  DRAIN: 'D',
} as const;
export type Terrain = (typeof T)[keyof typeof T];

/** What a player can put on the board. SCUFF is created by the game, never placed. */
export const TILE = {
  N: 'N',
  E: 'E',
  S: 'S',
  W: 'W',
  JUMP: 'J',
  /** Left behind when two players place on the same square. Behaves as a wall. */
  SCUFF: 'X',
} as const;
export type TileKind = (typeof TILE)[keyof typeof TILE];

/**
 * What a player can choose from on any turn. Tiles are **not** consumed — the same kind can
 * be placed every turn if you want. The scarce resource is the number of placements in a
 * round (one per turn), and where they go; not which kinds you have left.
 */
export const TILE_PALETTE: TileKind[] = [TILE.N, TILE.E, TILE.S, TILE.W, TILE.JUMP];

export type PlacedTile = {
  kind: TileKind;
  /** Player who placed it, or null for scuffs. Ownership is cosmetic: any dog obeys any tile. */
  ownerId: string | null;
  /** Placed on the secret turn, or a scuff created by colliding secret placements. */
  secret: boolean;
};

export type GameMap = {
  name: string;
  width: number;
  height: number;
  /** Row-major, length width*height. */
  terrain: Terrain[];
  /** Start positions in slot order, each already facing the center of the map. */
  starts: { x: number; y: number; dir: Dir }[];
};

export type DogInit = {
  id: string;
  breed: string;
  x: number;
  y: number;
  dir: Dir;
};

export type StopReason =
  | 'squirrel'
  | 'lake'
  | 'drain'
  | 'tuckered'
  | 'stuck'
  /** Provably repeating itself; see simulate.ts. */
  | 'tail';

/** One dog's visible state at one tick. Kept small: this array is what goes over the wire. */
export type DogSnapshot = {
  id: string;
  x: number;
  y: number;
  dir: Dir;
  stamina: number;
  score: number;
  stopped: StopReason | null;
  /** Set on the tick a dog moved two tiles, so the client can animate an arc. */
  jumped: boolean;
};

export type SimEvent =
  | { t: 'sniff'; dogId: string; x: number; y: number; points: number; order: number }
  | { t: 'treat'; dogId: string; x: number; y: number; points: number }
  | { t: 'greet'; dogIds: [string, string]; x: number; y: number; points: number }
  | { t: 'bump'; dogId: string; x: number; y: number }
  /** A placed tile fired and is now spent. Tiles are single use; see simulate.ts. */
  | { t: 'consume'; dogId: string; x: number; y: number; kind: TileKind }
  | { t: 'stop'; dogId: string; x: number; y: number; reason: StopReason; points: number }
  /** A secret tile (or secret scuff) has just been discovered by a dog. */
  | { t: 'reveal'; x: number; y: number; kind: TileKind };

export type Tick = {
  n: number;
  dogs: DogSnapshot[];
  events: SimEvent[];
};

export type WalkResult = {
  ticks: Tick[];
  /** Final per-dog scores for this round, in the order dogs were passed in. */
  scores: { dogId: string; score: number; stopped: StopReason; sniffs: number; treats: number }[];
};

export const key = (x: number, y: number): string => `${x},${y}`;
