# Maps

Plain text, one character per tile. Rows must all be the same length. Lines starting with
`;` are comments and blank lines are ignored.

| Char | Tile | Notes |
|---|---|---|
| `#` | building / wall | Dogs turn right here. The border must be solid. |
| `.` | street | Walkable |
| `,` | park | Walkable. Open ground where dogs cross paths. |
| `S` | sniff spot | 2 points to the first dog, 1 to the second, 0 after |
| `P` | person with treats | 3 points, consumed by the first dog only |
| `Q` | squirrel in a tree | **Stops the dog.** +5 |
| `~` | lake | **Stops the dog.** −2 |
| `D` | storm drain | **Stops the dog.** 0 |
| `1`–`8` | start slots | Must be contiguous from `1`. The tile underneath is street. |

Dogs are placed on the start slots facing the middle of the board; you do not specify
facing. Slots are assigned to players randomly each round, so make them symmetric.

## Authoring

Edit the `.txt` directly, then look at what you made:

```bash
node scripts/preview.mjs --map maps/mission.txt --walk
```

That writes `preview.svg` showing the map with the paths eight dogs actually take when
nobody has placed a single tile. It is the fastest way to find a map that strands dogs in
a corner or ends every round in four seconds.

To measure a density change properly rather than eyeballing one map:

```bash
node scripts/tune.mjs --seeds 60
```

That generates maps across many seeds, simulates every one, and reports how long dogs
survive and how they end.

## Targets

Reasoning in DESIGN.md §4.2 and §4.4; all checked by `npm test`.

- **Three boards** — `small.txt` 10×10 (2–3 players), `medium.txt` 13×13 (4–5),
  `large.txt` 16×16 (6–8). The server picks by player count. ~60–70% walkable; the
  playfield is open, closer to ChuChu Rocket than to a street map.
- **Border baffles.** Every board needs short wall stubs growing inward from the fence,
  or dogs that reach the boundary just circle it. A one-tile stub is enough — a
  perimeter-running dog travels in the lane next to the wall. Keep them 4+ apart along an
  edge so two never pinch the lane between them to a single tile.
- **One connected space.** Baffles near a corner can seal a pocket, including a corner
  drain. Every walkable tile must be reachable from every start; a test asserts it.
- **Every lane at least 3 tiles wide.** This is the important one. A dog in a 1-wide
  corridor is committed until the next intersection: it cannot be crossed, cut off, or
  bumped, and a tile placed beside its path is wasted. Narrow streets look like San
  Francisco but they delete the cross-traffic the whole reveal phase depends on.
- **Obstacles are small clumps**, 2×3 at most down to 1×2, at least 3 tiles apart. Nothing
  3×3 or larger — a test enforces this.
- **Long fences** of 4–7 tiles, one tile thick, redirect dogs across real distance for
  almost no floor area. Render as railings, not buildings.
- **~9% of walkable tiles** are sniff spots, **~2.8%** are people.
- **One stopping point per ~60 walkable tiles** — roughly 5 on a 20×20. This is far sparser
  than a corridor map wants, and it is the single easiest number to get wrong. In the open,
  dogs travel long straight lines that sweep fresh tiles every tick, so a stopper is much
  more likely to be hit than the same density in a maze. At one per 22, *half of all dogs
  are out of the round within four seconds* and their placements never fire. Shrinking the
  board makes this worse again, not better.
- **A solid border**, so dogs turn right at the fence rather than leaving.
- **A storm drain in at least one corner.** A dog circling the fence travels clockwise and
  passes every corner, so one drain kills the loop the map guarantees exists. On an open
  map that loop is the most likely failure mode, so this is load-bearing.

Parks (`,`) are cosmetic — mechanically identical to street. Use them so a mostly-open
board doesn't read as an undifferentiated plain.
