# Everything else that needs drawing

Companion to [README.md](README.md), which specs the dog atlas. This is the rest of the
board: props, terrain, player tiles and effects.

Same conventions as the dog sheet — **PNG-32, 128 × 128 px cells, transparent, ~6 px inner
margin, no baked drop shadows**. One cell = one map tile. Art may fill the cell but must not
assume it can spill outside it; if you want a tree that towers over its tile, see
[Tall props](#tall-props).

Everything below is drawn today as procedural canvas art, so nothing here is blocking — this
is a list of what would be *replaced or extended*, ordered by how much each would improve the
board.

---

## 1. Pickups and stopping points — the highest-value work

These are what players are steering toward. They carry the most meaning per pixel.

### Sniff spots (`S`) — 3 variants, 3 states each

The most common thing on the board (~9% of walkable tiles). Currently a hydrant, a lamppost
and a bush, chosen deterministically per tile.

| Variant | Idle frames | Notes |
|---|---|---|
| Fire hydrant | 2 (subtle) | The classic. Red, chunky. |
| Lamppost | 3–4 flicker | Warm pool of light on the ground |
| Bush | 3–4 sway | |

**Three states each**, because sniffs diminish (2 pts → 1 pt → 0):

- **fresh** — full colour, faint sparkle
- **sniffed once** — slightly desaturated, one wavy "used" line
- **spent** — clearly drab, no sparkle

Plus a **reaction**: 3–4 frames of a wobble/squash the moment a dog sniffs it.

> Worth adding more variants: a rubbish bin, a bike rack, a tree pit, a lost glove on a
> railing, a scooter. Sniff spots are the wallpaper of the board and three repeats show.

### People with treats (`P`) — needs real variety

Currently one figure in three shirt colours, which reads as one person cloned. This is the
single most obvious repeat on the board. Suggested cast of **6–8**:

1. Kid with a treat bag
2. Jogger with a belt pouch
3. Older person with a stick and a pocket of biscuits
4. Barista holding a puppuccino
5. Skateboarder, one foot down, treat held low
6. Parent with a pram
7. Cyclist stopped with a foot on the kerb
8. Picnicker sitting on a blanket

| State | Frames | Notes |
|---|---|---|
| idle (has treat) | 3–4 | gentle bob, occasional look-around |
| **giving** | 4–6 | crouch, hand out, dog takes it — fires on the `treat` event |
| given (empty) | 2 | still there, hands empty, waves |

Treats are consumed by the **first** dog only, so the "given" state matters — it tells
everyone else not to bother.

### Squirrel in a tree (`Q`) — the jackpot, deserves the best animation

Worth 5 points **and ends the dog's run**. The most dramatic moment available.

| State | Frames | Notes |
|---|---|---|
| idle | 4 | tail flick, head twitch, occasionally peeks round the trunk |
| **chased** | 6–8 | squirrel scrambles up the trunk and out of frame, leaves burst |
| gone | 1–2 | empty tree, leaves settling |

### Lake / water (`~`) — 4-frame ripple loop

A hazard: −2 points and the run ends. Wants a **splash**: 5–6 frames of the dog going in,
water crowning up, ripples spreading.

Also needs **edge pieces** if lakes ever grow past one tile — see autotiling below.

### Storm drain (`D`) — 2 frames

Neutral, ends the run. A slow drip or a faint shimmer is plenty. Its job is to look like
somewhere a dog would stick its nose and get bored.

---

## 2. Terrain — where autotiling would pay off most

Right now every tile is drawn independently, so a clump of buildings has no continuous
outline and a park has no defined edge. This is the biggest *structural* art improvement
available.

| Entity | Cells | Notes |
|---|---|---|
| Street / asphalt | 4–6 variants | Kerb markings, drain grates, cracks, a manhole |
| Park grass | 4–6 variants | Plus **16-tile autotile edge set** for park/street boundaries |
| Building (interior) | 3 shades × lit/unlit windows | Plus a **16- or 47-tile blob set** so clumps get proper corners and a roofline |
| Building (border ring) | 2–3 | Deliberately plainer — it is scenery and must not compete with the playfield |
| Fence — horizontal | 3 (run, left cap, right cap) | Used for interior fences |
| Fence — vertical | 3 (run, top cap, bottom cap) | |
| Border baffle | 2–4 | Stubs poking inward from the fence. Could be a gate, a bollard line, a skip |

A **16-tile autotile set** (edges + corners, no inner corners) is the cheap version and gets
most of the benefit. The 47-tile blob set is the thorough one.

---

## 3. Player tiles — must stay tintable

These are drawn in each player's identity colour, so they **cannot be flat-coloured art**.
Either supply them greyscale/white for tinting, or as a shape mask plus a separate outline
layer.

| Entity | Cells | Notes |
|---|---|---|
| Direction arrow ↑ → ↓ ← | 4 | Chalk-pad look. One sheet, tinted 8 ways |
| Jump tile | 1 + 3-frame pulse | Arc plus a paw print |
| Scuff mark | 1 + 4-frame appear | Created when two players pick the same square |
| Tile "fires" flash | 3–4 | When a dog actually triggers a tile — currently nothing marks this, and it is the moment a player most wants to see |
| Pending placement marker | 2-frame dashed | Only the placing player sees it |

---

## 4. Effects — driven by real sim events

The simulation already emits every one of these, so each has an exact trigger. They are
currently all text popups.

| Effect | Trigger | Frames |
|---|---|---|
| Sniff burst | `sniff` event | 4–5 — little swirl/stink lines, sparkle if it was worth 2 |
| Treat pop | `treat` event | 4–5 — biscuit or heart rising |
| Greeting | `greet` event (two dogs bump) | 5–6 — nose-to-nose, hearts, tail blur |
| Bump / dust | `bump` event (dog hits a wall) | 3–4 — dust puff, maybe stars |
| Jump takeoff + landing | dog's `jumped` flag | 3 + 3 — dust at both ends of the arc |
| Splash | `stop` reason `lake` | 5–6 |
| Squirrel chase | `stop` reason `squirrel` | shares the squirrel's chased animation |
| **Tuckered out** | `stop` reason `tuckered` | 4-frame loop — Zzz, lying down. **The most common ending in the game**, so it deserves a proper animation |
| Dizzy / chasing tail | `stop` reason `tail` | 4-frame loop — spiral eyes, circling stars |
| Stuck | `stop` reason `stuck` | 3 — question mark, confused ears |
| Secret tile reveal | `reveal` event | 4–5 — the tile unfolds or flashes into being |
| Score numerals | any scoring event | 0–9, `+`, `−` as sprites if you want them to match the art |

---

## 5. UI and chrome

| Entity | Cells | Notes |
|---|---|---|
| Palette icons | 5 | ↑ → ↓ ← and jump, for the tile picker |
| Dog portraits | 8 | Can reuse dog-atlas frame 0, direction 2 (facing camera) |
| Winner rosette / trophy | 1–2 | Match-end screen |
| Stamina ring | — | Stays procedural: it is a live gauge, not art |

---

## Anchors — supported now

`public/atlas.js` handles three anchors, so a sheet can declare how its art meets the ground.

| Anchor | Meaning | Use for |
|---|---|---|
| `foot` | The cell's foot line (`footRatio`, default 0.85) lands on the tile's ground line at 80% of tile height. The sprite may be larger than its tile and appears to stand on it. | Dogs, people, any character |
| `bottom` | The cell's bottom edge meets the tile's bottom edge, aspect ratio preserved. A **128 × 256** cell therefore covers its own tile and overhangs exactly one tile upward. | Trees, lampposts, anything that towers |
| `tile` | The cell fills the tile square. | Flat ground decals |

**Tall props are ready to drop in**: use 128 wide × 256 tall cells, bottom-anchored, and
they will compose correctly over the tile behind with no further work.

`measureCells()` in the same module reports the opaque bounding box of every cell as
fractions of cell size — that is how the dog sheet's foot line was checked before wiring it
up (0.844–0.859 across all 128 cells, against a claimed 0.85).

---

## Rough total

| Group | Cells (approx) |
|---|---|
| Pickups and stopping points | 140–190 |
| Terrain (with 16-tile autotiling) | 70–90 |
| Player tiles | 20–25 |
| Effects | 50–65 |
| UI | 15 |
| **Total** | **~300–385** |

Plus the ~96–128 for the dogs.

If that is more than you want to take on, the ranking by impact per cell is:

1. **People variety** — one cloned figure is the most visible repeat on the board
2. **Squirrel chase animation** — the biggest moment in the game currently has no payoff
3. **Tuckered-out animation** — the most common ending, currently just text
4. **Building/park autotiling** — makes the whole board look designed rather than assembled
5. Everything else
