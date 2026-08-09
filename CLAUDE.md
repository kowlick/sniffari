# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                                    # server on :9663
npm run dev                                  # same, with --watch
npm test                                     # all tests
npm test -- --test-name-pattern "jump"       # one test by name
npm run typecheck                            # tsc --noEmit
npm run map                                  # regenerate maps/mission.txt
node scripts/preview.mjs --walk              # render map + simulated walk to preview.svg
```

Node 22.6+ runs the `.ts` files directly via type stripping. **There is no build step and
no bundler.** Consequences worth remembering:

- Server imports must carry the `.ts` extension (`import { Room } from './room.ts'`).
- `erasableSyntaxOnly` is on: no `enum`, no `namespace`, no constructor parameter
  properties. Use `as const` objects plus a union type instead of an enum.
- `public/` is plain ES-module JavaScript served as-is. It is never compiled, so it cannot
  import anything from `src/`.

## Architecture

Three layers, and the boundaries between them are the important part.

**Two boards, picked by player count** — small 8×8 (1–4), large 10×10 (5–8), each with its
own stamina (`CONFIG.boards`). `Room.board` resolves live in the lobby and is frozen at match
start. These are deliberately *tight*: density sits near 8 walkable tiles per dog rather than
the 20–25 §4.4 recommends, so dogs are constantly in each other's way. Two things follow that
are easy to trip over — 8 players × 5 turns is 40 placements onto ~50 free squares, and the
8×8 wants far *less* stamina than intuition says (median dog life there is 15 ticks whatever
you give it, so extra stamina only inflates the share of dogs whose tiles never fired).

**A fresh map is generated per match**, not per round — knowing the ground is most of the
skill, so it must stay put across the three rounds inside a match. `src/sim/generate.mjs` is
shared by the server and the map scripts (`.mjs` with a `.d.mts` so the server's typecheck
stays honest). Since any generated map can reach a real game, `test/generate.test.ts` asserts
the map invariants across 40 seeds per board size; the `maps/*.txt` files are only the lobby
preview and a hand-authoring starting point.

**The playfield is open, not a street grid.** ~90% of the *interior* walkable — measure
against the interior, never the whole grid, because the solid border ring is a fixed cost
that makes the same settings read as 51% on an 8×8 and 69% on a 16×16. a handful of 1×2-to-2×3
obstacles, a long thin fence or two, and border baffles. Tests enforce: no 1-wide corridor
runs, nothing 3×3 or bigger, every walkable tile reachable, and border-adjacent obstacles
present. It was a reversal: a dog in a 1-wide corridor is committed until the next
intersection, so it cannot be crossed or cut off and tiles beside its path are wasted.

Two consequences that are easy to break by accident: stopping points must be **much**
sparser than intuition says (~1 per 60 walkable tiles), and **stamina, not stopping points,
is what paces a round** — most dogs are meant to tucker out. Shrinking the board makes the
stopper problem worse, not better, because dogs reach everything sooner. DESIGN.md §4.1,
§4.2 and §4.4 have the measurements.

**`src/sim/` — the rules.** A deterministic finite automaton: a dog's entire state is
`(position, facing)`, so the same map plus the same tiles always produces the same round,
tick for tick. This file must never consult a clock, a random source, or the network.
Determinism is what lets the server send an entire walk phase as one payload, what lets
players reason about placements, and what makes the tests possible without mocks.

The corollary is the thing that bites: because the state space is finite and the sim is
deterministic, **every dog must eventually enter an infinite loop unless something stops
it.** Stamina (`CONFIG.sim.stamina`) is the hard guarantee. Loop detection in
`simulate.ts` is only a nicety that ends doomed rounds early. Never remove stamina.

`simulateWalk()` resolves each tick in a fixed order — intent, terrain blocking, dog-vs-dog
blocking iterated to a fixpoint, movement, arrival effects, stamina, loop check. The
fixpoint matters: a dog blocked by a wall becomes an obstacle for the dog behind it, and
iterating keeps the outcome independent of the order dogs happen to sit in the array.

**`src/server/` — the game and its turns.** `Room` is the phase state machine
(`lobby → setup → place ×5 → walk → score`), driven by `setTimeout` and by every player
locking in. There is exactly **one Room per server** — this is a LAN game, so there are no
room codes and no registry. It holds two tile maps: `tiles` (public) and `secretTiles`
(turn 5). The split is a security boundary, not a convenience — `stateFor()` must never
serialize `secretTiles`. Clients learn about secret tiles only from `reveal` events inside
the walk payload, at the tick a dog steps on one.

**The host seat is claimable, because there is no admin to fix a room.** Starting a match,
setting its length and ending it early are host-only, so a host who closes their tab leaves
a lobby nobody can start. The server cannot know that someone *left* — only that their
socket shut — so `Room` publishes `hostAway` once the host's connection has been gone for
`CONFIG.lobby.hostGraceMs`, and any player may then send `claimHost`. Two things make that
work and are easy to break: the WebSocket **ping/pong heartbeat** in `index.ts`, without
which a phone that leaves the Wi-Fi looks connected for minutes of TCP timeout; and the
timer in `markHostAway`, which broadcasts when the grace expires — nothing else would wake
an idle lobby, and a claim button that only appears on the next unrelated state change is a
button nobody finds. Mid-match needs no button: the phase timers run the match out to
`match-end` on their own, and the lobby overlay comes back with the claim button on it.

**`src/server/ai/` — computer opponents, and the boundary that stops them cheating.**
The whole design rests on `simulateWalk` being pure and costing 0.036–0.140 ms against only
250–785 legal placements a turn: scoring *every* option by simulating the round it produces
costs about a tenth of a second, so a bot needs no heuristic evaluation function at all. The
danger is the opposite one — a bot runs inside the server with `secretTiles` and everyone's
`pending` in scope, and one that read them would be cheating undetectably. So the search
never takes a `Room`; it takes a `BotView` built from nothing but the `state` message that
seat's browser was already going to receive (`view.ts`). If a human cannot see it, it is not
in the payload. Bots also place through `place()`/`lock()` like any socket message, so
legality and the collision rule apply by construction. Both properties have tests that fail
if they stop holding. Difficulty is one engine plus a config block, never a second
algorithm; `npm run ai-tourney` is what decides whether the ladder actually orders.

**`src/shared/` + `src/puzzle/` — Heel, the solo puzzle.** A different game sharing the
vocabulary but not the loop: the dog walks on its own, one button drops the next queued tile
in front of it, and the goal is to reach the parent. Three things carry the design.
**Levels are a pure function of their number** (`buildLevel`), so the supply is endless and
level 4,912 is the same board everywhere — which is what makes a shared solution mean
anything. **A solution is a list of tick numbers**, so `solve.mjs` searches C(ticks, tiles)
rather than board positions; that is the whole reason this variant can verify uniqueness on
demand where the placement variant could not. And **`src/shared/puzzle-rules.mjs` is plain
JavaScript served to the browser** at `/shared/puzzle-rules.mjs`, so the client, the
generator and the tests run identical bytes — the one sanctioned way around "public/ cannot
import from src/". Keep that route to named files; mounting `src/` would publish the server.

Two generator invariants worth not breaking: a level must be **unsolvable by never tapping**,
and its step budget is **cut down to the length of the real route** after solving, or the
puzzle can be blundered through. Tiles are capped at six because solver cost is combinatorial
in them — difficulty past that comes from patrols and a tighter budget, which make levels
harder *and* faster to generate.

**`public/` — rendering only.** The client sends one message per turn and otherwise just
draws what it is told. It never simulates. `client.js` owns the socket, the DOM and
playback; `render.js` lays out the board; `sprites.js` holds every piece of artwork;
`audio.js` synthesises all music and sound effects (no audio files anywhere).

Sound and visuals are both driven off the sim's event stream in `addPopup`, so they cannot
drift apart. `sfx()` ignores unknown names on purpose — adding a sim event must never throw
in the audio layer. The two music themes are written out note by note in `audio.js`; they
are deliberately not one tune at two tempos, which is what they used to be and what it
sounded like.

The wordmark is drawn on canvas (`drawWordmark`), not set in a font — the game ships no font
files, and drawing it keeps the title in the same chunky-outline style as the board.

**Dogs render from a sprite atlas** (`public/art/dogs-chibi.png`, 16×8 cells of 128px;
column = `direction * 4 + frame`, row = breed in `DOGS` order). `public/atlas.js` owns sheet
loading and anchored cell drawing — `foot` for characters, `bottom` for tall props that
overhang the tile behind, `tile` for flat decals. See `art/` for the specs.

**Animated board entities share a second atlas** (`public/art/entities-chibi.png`, 16×5
cells of 128×256). Rows are hydrant, lamppost, bush, squirrel tree and lake/drain effects;
columns are four-frame state blocks. `art/chibi-entities/ENTITY_HANDOFF.md` is the row and
state contract. All cells use the same 0.85 foot line, including flat props whose art lives
near the bottom of the tall transparent cell.

The procedural sprites in `sprites.js` are still the fallback if a sheet fails to load, and
`?art=drawn` forces them. Terrain, player tiles and remaining effects are drawn procedurally
in a normalised [-0.5, 0.5] tile space, so they scale to any board size.

Dog metadata comes from `DOGS` in `protocol.ts`, served via `/dogs.json` so it cannot drift
from the server's list. **The atlas row is the array index**, so reordering `DOGS` silently
reassigns every breed's art.

**`color` is the player's identity, `fur` is the coat — keep them separate.** Identity rides
on the collar and the stamina ring; the coat is free to be realistic (the Labrador is a
black lab). When identity was the coat colour, every dog had to be an implausible hue.
Shape fields `ear` / `furStyle` / `tail` / `scale` / `bw` / `bh` / `leg` carry breed
character. Anything drawn *before* the head gets painted over by it — that bug hid the tail
in the back view and then the collar in all three.

## Conventions that carry meaning

- **Tiles are a palette, not a hand.** `TILE_PALETTE` is available in full every turn; the
  scarcity is the five placements per round and where they go. Do not reintroduce per-player
  tile inventories.
- **A placed tile is single use** — it fires once and is spent (scuffs are walls and are
  never consumed). This kills the bookend trap, and it means **loop detection's premise no
  longer holds on its own**: spending a tile changes the world, so every dog's visited-state
  history is cleared on any `consume` event. Removing that clear silently resurrects the
  bug where a dog escaping a trap is culled as though it were looping.
- Direction indices double as poses in `drawDog` (`0` back, `1` right profile, `2` front,
  `3` left profile).
- **Directions are indexed clockwise** `0=N, 1=E, 2=S, 3=W`, which makes a right turn
  `(d + 1) % 4`. "Right" is relative to the dog, so a dog walking down the screen turns to
  screen-left. Wall turns are *relative*; direction tiles are *absolute* headings. These
  are not interchangeable.
- **Every game number lives in `src/config.ts`** (map densities in
  `scripts/lib/generate.mjs`). Nothing else should hard-code a score, a timer, or a
  density. DESIGN.md explains why each value is what it is; if you change one, update the
  reasoning there too.
- **Tune with data, not vibes.** `npm run tune` sweeps map densities and stamina across
  many seeds and reports how long dogs actually survive. A single `preview.svg` is one
  sample and will mislead you. The metric that matters is the share of dogs finished inside
  20 ticks — those players placed five tiles and watched none of them fire.
- **DESIGN.md is the source of truth for rules**, and the tests assert against it (map
  density tests cite §4.4 directly). A rules change means editing the doc, the config, and
  the tests together.
- Tests use `node:test` and live in `test/`. The sim tests build tiny ASCII maps inline
  with `parseMap` — follow that pattern rather than adding fixtures.

## Deployment

LAN only, by design. One server, one game, no join codes, no remote play, `PORT` as the
sole environment variable. Do not reintroduce room codes or public-URL handling.

The walk phase is still sent as a single payload rather than streamed tick by tick — that
is simpler than streaming, survives a flaky phone connection, and guarantees every client
animates an identical round.
