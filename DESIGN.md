# Sniffari — Design Document

A local-network multiplayer game for up to 8 players. Everyone picks a dog, everyone
secretly places direction tiles on a tiled map of San Francisco, and then all the dogs
are let off leash at once and chaos is scored.

Status: **design draft**. Nothing is built yet. Numbers marked ⚖️ are tuning knobs with a
recommended starting value and the reasoning behind it.

---

## 1. Core Loop

A **match** is 3 **rounds**. A round is:

| Phase | What happens | Time ⚖️ |
|---|---|---|
| Setup | Dogs placed on the map, facing the center. Pickups placed. Everyone sees this. | 10s |
| | *The host picks the match length (1–7 rounds) before starting, and can end a match early.* | |
| Turn 1 | Each player secretly places 1 tile, chosen freely from ↑ ↓ ← → jump. Reveal at end of turn. | 40s |
| Middle turns | Same, one tile per turn, revealed at end of each turn. How many there are depends on the board — see §4.1. | 30s each |
| Last turn (Secret) | Each player places their last tile. **Not revealed.** | 30s |
| Walk | All dogs walk simultaneously until every dog has stopped. | ~30s |
| Scoring | Each dog takes the podium in turn — placing, name and score — last place first. | see below |

≈3.5 minutes per round, ≈11 minutes per match. Scores are cumulative across the 3
rounds; highest total wins.

---

## 2. The Dogs

Eight dogs, one per player, picked from a shared pack (first come, first served in the
lobby):

1. **Cockapoo**
2. **Labrador**
3. **Irish Wolfhound**
4. **Australian Shepherd (brindle)**
5. **Australian Shepherd (black & white)**
6. **Labradoodle (lab-leaning)**
7. **Labradoodle (poodle-leaning)**
8. **Beagle mix**

For v1 all dogs are mechanically identical — same speed, same stamina, same rules. Breed
traits are a strong v2 feature; see §10.1.

### Starting positions

Dogs start spread evenly around the outer ring of the map, each **facing the center**.
With 8 dogs that's roughly the 8 compass points. Positions are symmetric and identical
every round so no one starts advantaged, but which player gets which slot is randomized
per round.

---

## 3. Movement Rules

The simulation is a **deterministic grid automaton**. Dogs move in cardinal directions
only, one tile per tick, all at the same speed. There is no randomness in the walk phase —
given the same board and the same tiles, the same thing always happens. This matters: it
means players can actually *reason* about outcomes, and it means the server can replay a
round exactly.

### Per-tick resolution order

Every tick, for all dogs simultaneously:

1. **Intent** — each dog computes its target tile: 1 tile ahead, or 2 tiles ahead if it is
   carrying a jump.
2. **Terrain block** — if the target is a wall/building/obstacle, the dog does **not**
   move; it turns by the wall rule (§4.6) and the tick is spent. Turning costs a tick.
3. **Dog collision** — if two or more dogs want the same tile, or two dogs want to swap
   tiles, none of them move; each turns by the same rule. This is a **greeting** (see
   scoring). Blocked is blocked, whatever is doing the blocking — two rules would be two
   things to learn.
4. **Move** — all remaining dogs advance.
5. **Arrival effects**, in this order:
   a. Collect any sniff or treat on the tile.
   b. If it is a **stopping point**, the dog stops permanently.
   c. If it is a **direction tile**, set facing to that direction (takes effect next tick).
   d. If it is a **jump tile**, set the jump flag for next tick.
6. **Stamina** — decrement. At zero the dog stops ("tuckered out").
7. **Loop check** — see §3.3.

### 3.1 Turning at a block

Which way a blocked dog turns is `CONFIG.sim.wallRule`, and the measurements behind the
choice are in §4.6. It currently ships as **`open`**: the dog looks left and right and goes
whichever way it can see further, preferring its right when the two are equal.

The table below describes the `right` rule, which is what the tie-break falls back to and
what the geometry note after it is about.

"Right" is **relative to the dog's own heading**, not to the screen. A dog walking down the
screen that hits a wall turns to *its* right, which is screen-left.

| Facing | Turns to |
|---|---|
| Up (north) | Right (east) |
| Right (east) | Down (south) |
| Down (south) | Left (west) |
| Left (west) | Up (north) |

In code this is a clockwise rotation of the heading: with directions indexed
`0=N, 1=E, 2=S, 3=W`, a right turn is `(dir + 1) % 4`.

Note that wall-turns are **relative** while direction tiles are **absolute** (the ↑ tile
means north regardless of where the dog was heading). The two are not interchangeable, and
no direction tile is redundant with walls: a wall produces each absolute heading from
exactly one incoming heading (→ from a north-facing dog, ↓ from an east-facing dog, ← from
a south-facing dog, ↑ from a west-facing dog). The four direction tiles are symmetric in
value.

A dog blocked on all four sides turns in place for 4 ticks and then stops (it's stuck).

### 3.2 Jumping

Entering a jump tile arms a jump. On the next tick the dog moves **two tiles** in its
current direction, passing over whatever is in between.

- The jumped-over tile is **not** collected and its effects do **not** trigger.
- If the **landing** tile is blocked, the jump fails: the dog stays put and turns right.
- If the landing tile has a direction tile or another jump tile, it applies normally.
- If a dog is on the landing tile, it's a collision — resolved as in step 3.

### 3.3 Guaranteeing the round ends

**This is the central technical problem of the design.** A dog's state is
`(position, facing)`, so there are only `4 × tiles` possible states. The simulation is
deterministic. Therefore every dog *must* eventually either hit a stopping point or enter
an infinite cycle. Left alone, a dog in an open walled map will simply circle the perimeter
clockwise forever.

Three overlapping guards:

1. **Stamina (hard cap).** Every dog has ⚖️ **90 steps**. This alone guarantees the round
   terminates. It's also thematically perfect — dogs get tired — and it's a visible
   resource, so it makes efficient routing a real skill. Show it as a bar under each dog.
   On the open playfield it is additionally the *pacing* mechanism, since most dogs now end
   this way rather than by finding a stopping point — see §4.4.
2. **Cycle detection (cheap and fun).** Track visited `(position, facing)` states per dog
   in a hash set. On a repeat, the dog is provably in a loop: stop it immediately with a
   "chasing its tail" animation. This ends dead rounds fast instead of making everyone
   watch a dog do laps.
3. **Corner storm drains.** A dog looping the perimeter travels **clockwise** and therefore
   passes every corner. Placing a stopping point in even one corner kills all perimeter
   loops. Put them in two opposite corners.

Guard 1 is the guarantee. Guards 2 and 3 are what keep it from ever being *boring*.

---

## 4. The Map

### 4.1 Size — **three boards, chosen by player count**

| Board | Size | Tiles | Walkable | Players | Stamina | Turns | Sec/tile |
|---|---|---|---|---|---|---|---|
| small | 8 × 8 | 64 | ~33 | 1–2 | 20 | 5 (4 + secret) | 1.5 |
| medium | 10 × 10 | 100 | ~58 | 3–5 | 30 | 4 (3 + secret) | 1.8 |
| large | 12 × 12 | 144 | ~90 | 6–8 | 30 | 3 (2 + secret) | 2.0 |

**Turns come down as players go up, and playback slows down.** The load a round puts on a
player is not the board, it is *everyone else's tiles*: turns × dogs. Five turns of eight
dogs is 40 arrows to keep track of, and past somewhere around 25 the round stops being
planned and starts being merely watched. Two open turns plus the secret one at eight dogs
is 24. The same argument runs the other way for the walk phase — more dogs to follow means
each tick needs longer to take in — and the turns saved pay for it: the large board gives
up two 30-second placement turns and spends about 15 seconds of that on a slower walk.
Stamina is the ceiling on that: 30 ticks at 2.0s is a 60-second walk, the top of the band
in §7, so slowing playback further means lowering stamina in the same breath.

**These are deliberately tight, and the change is worth being explicit about.** The earlier
spread (10/13/16) held player density near the 20–25 walkable tiles per dog recommended in
§4.4. These sit nearer **8**: four dogs share 33 tiles, eight dogs share 58. Dogs are
constantly in each other's way, which is where greetings, blocked paths and stolen sniff
spots come from — but it is a different game from the one §4.4 was written about.

Two consequences to watch:

- **Tiles cover a large share of the board.** Eight players × 3 turns is 24 placements, and
  the per-board turn counts above are largely what keeps that number sane — at five turns
  it was 40 onto roughly 50 free squares. At the default of one round that is the whole
  match, and it still means a late-turn board is dense with arrows, with collisions into
  scuff marks common rather than occasional.
- **Stamina had to come down a long way**, and the small board wants far less than intuition
  suggests — see below.

#### Stamina has a ceiling, and on the 8x8 it is very low

Measured with `npm run tune` across 40 seeds: on the small board a dog's median life is
**15 ticks whatever stamina it is given**, from 18 up to 36. It finds a stopping point or
starts repeating itself long before it tires. So raising stamina does not lengthen a single
run — it only raises the share of dogs finished inside 30% of their stamina from **18% to
33%**, and that share is the metric that counts players who placed five tiles and watched
none of them fire. Hence 18.

The 10×10 behaves normally: dogs use what they are given, the cut share stays near 9–13%
across 22–40, and score rises with stamina. 30 is the balance point.

#### The older finding, on the bigger boards

Raising stamina buys less than it looks like it should. Measured solo on the small board,
median dog life went 18 → 23 as stamina went 18 → 26, and then **stopped moving** all the
way out to 54; board coverage sat at 21% throughout. Past that point dogs simply end on a
stopping point or in a detected loop instead of running out of puff.

What actually lengthened runs was **removing stoppers**. The small board had one per 15
walkable tiles, and half of them were zero-point corner storm drains — roughly half of all
solo runs ended on a square worth nothing. Dropping to one drain and no forced lake (one
per 29) raised the squirrel rate from 15% to 20% and the score from 3.2 to 3.6 on its own.

So: if dogs feel short-lived, thin the stopping points on that board before touching
stamina.

The server picks the smallest board that fits the group when the match starts, and locks it
for the match so a dropped phone can't resize the board mid-game.

**A fresh map is generated for every match**, at the size the group needs. Per *match*, not
per round: a match is three rounds on one board, and knowing the ground — where the squirrel
is, which lane the fence blocks, which corner has the drain — is most of the skill. Re-rolling
between rounds would throw that away every ninety seconds; re-rolling between matches means
nobody can memorise one board. The maps in `maps/` remain the lobby preview and the
hand-authoring starting point. Turn it off with `CONFIG.freshMapEachMatch`.

Because any generated map can now reach a real game, the invariants in §4.2 and §4.4 are
asserted across 40 seeds at each board size rather than against the three checked-in files.

**One player is allowed**, on the small board. Solo exercises the entire loop without
needing seven other people, and it stands on its own as a route-optimisation puzzle: with
no opponents there are no collisions, no cancelled tiles and no diminished sniffs, so the
board is a fixed problem and the only question is the best five placements.

Reasoning:

- **Player density is what matters, not absolute size.** A 16 × 16 with three dogs on it is
  a lonely game — they may never meet. A 10 × 10 with eight is a scrum. Each board is sized
  to give roughly 20–25 walkable tiles per dog, which keeps paths crossing at every count.
- **The small board is deliberately ChuChu-Rocket-tiny.** 100 tiles total. At two or three
  players you need the walls close by for anything to happen.
- **Everything must be on one screen at once**, so boards are bounded above by readability.
  At 40–60 px/tile all three fit a laptop with UI around them, and tiles stay big enough for
  the dog sprites to read across a room.
- **Stamina is per board**, measured with `npm run tune`: enough steps to cross each board
  about four times.

### 4.2 Layout — an open field with scattered obstacles

**The playfield is open, closer to ChuChu Rocket than to a street map.** A handful of small
obstacles sit in a mostly-walkable field, and every lane between them is at least
**3 tiles wide**.

- **Obstacles are small clumps** — 2×3 at most, down to 1×2 — never closer than 3 tiles to
  each other or to the fence. Big blocks turn an open field back into a maze; a test
  asserts nothing on the map is 3×3 or larger.
- **Long fences**: one-tile-thick runs, scaled to the board (2–3 tiles on the small one,
  4–6 on the large). They redirect dogs across a real distance while costing almost no floor
  area. Drawn as railings rather than buildings so the two read differently.
- **Border baffles**: short stubs of wall growing inward from the fence. Without them the
  ring road round the edge is unbroken, and a dog that drifts to the boundary simply circles
  it until its stamina runs out — the single most common way to waste a round. A dog running
  the perimeter travels in the lane *next to* the wall, so even a one-tile stub blocks it,
  turns it right, and sends it back inward. They're spaced at least 4 apart along an edge so
  two stubs never pinch the lane between them down to a single tile.

  **Each edge gets its own phase and spacing.** Placing all four edges by the same rule from
  the same offset produced mirrored baffles, and a dog deflected off one met the matching
  baffle opposite and settled into a lap of the board anyway. Measured over 80 seeds on the
  small board solo, breaking the symmetry cut the share of a dog's life spent in the lane
  beside the fence from **70% to 45%**, and raised the mean score from 3.9 to 5.5.

  It is not free: more dogs now finish early (18% → 26% inside a third of their stamina),
  because they reach the interior sooner and find a stopping point there. That is the better
  trade — a dog that finds a squirrel has done something, a dog grinding round the perimeter
  has not. The effect fades as the board grows; on the large board it is within noise, since
  the border is a much smaller fraction of the map.
- **Lanes** are whatever is left, which is most of the board. Nothing is 1 tile wide.
- **Parks** are large green regions. They are **cosmetic only** — park and street behave
  identically — and exist so an open field doesn't read as an undifferentiated plain.

This replaced an earlier design of 1-tile streets in a dense SF block grid. The reason is
interaction: **a dog in a 1-wide corridor is committed until the next intersection.** It
cannot be crossed, cut off, or bumped, and a tile placed beside its path is wasted. Narrow
streets look like San Francisco but they quietly delete the cross-traffic that the
simultaneous reveal is built around. Open ground means dogs travel long straight lines that
constantly intersect each other's, so placements interfere and collisions actually happen.

The trade is that free right-turns become scarce — there simply aren't many walls to bounce
off. That makes direction tiles *more* valuable, not less, and it makes the fence and the
handful of blocks the main terrain features worth planning around.

Note that the minimum-gap rule caps how many obstacles physically fit. Asking the generator
for a higher block fraction does nothing past that ceiling; widen the map or narrow the gap
instead.

### 4.3 Edges: fences, not stoppers

**Recommendation: the map border is a wall (a fence), and dogs turn right at it.**

The alternative — edges as stopping points — is tempting because it solves termination for
free, but it makes the game worse: one badly-aimed tile in turn 1 sends your dog off the
board in 6 seconds and you have nothing to watch for the rest of the round. Walls keep dogs
in play, keep them collecting, and reinforce the turn-right rule that everything else
depends on.

Termination is already handled by stamina and cycle detection, so the border doesn't need
to do that job. Add the two corner storm drains from §3.3 and perimeter loops die anyway.

On the open field the fence does more work than it did on the corridor map — it is the
terrain feature dogs meet most often, and circling it is the single most likely way for a
dog to waste a round. The border baffles in §4.2 break most perimeter runs directly; the
corner drains catch the rest.

Because baffles sit hard against the border, two near a corner can seal off a pocket —
including a corner drain, which then can't do its job. The generator flood-fills from a
start square and opens walls until the whole board is one connected space, and a test
asserts it.

### 4.4 Density — recommendation

Percentages are of the 27×27 board unless noted. These are measured, not guessed: run
`node scripts/tune.mjs` to reproduce.

| Element | Density ⚖️ | Count on the large board | Notes |
|---|---|---|---|
| Blocked (obstacles + border) | ~32% of all tiles | ~83 | 60 border, 23 in 14 obstacles (12 baffles, 1 fence) |
| Walkable | ~68% | ~173 | |
| Sniff spots | 9% of walkable | ~16 | Hydrants, lampposts, bushes |
| Friendly people with treats | 2.8% of walkable | ~5 | Higher value, consumed on first visit |
| Stopping points | **2.3% of walkable** | **~4** | 1–2 squirrels, 1 lake, 2 corner drains |

#### Stopping points must be far sparser than intuition suggests

This is the number that sets the pace, and the open field changed it by a factor of three.
The old corridor map used one stopper per 22 walkable tiles. On the open map that same
density is **far** more lethal, for a geometric reason: in a maze dogs are funneled and
re-tread ground they have already cleared, while in the open they travel long straight
lines that sweep fresh tiles every single tick. Every stopper gets many more chances to be
hit.

Measured over 60 seeds × 8 dogs, at one stopper per 22 walkable tiles:

> **half of all dogs were out of the round inside 20 ticks — four seconds.**

Those players placed five tiles across five turns and watched none of them fire. Dropping
to **one stopper per ~60 walkable tiles** cuts that to 28%.

Shrinking the board made this *worse*, not better, and the same fix applied again: on a
smaller map a dog reaches everything sooner, so the same per-tile density is more lethal.
Going 27×27 → 20×20 pushed the cut rate back up to 37% until stoppers were thinned a
second time.

#### Stamina is the pacing mechanism now, not stopping points

The consequence is an inversion worth stating plainly. With stoppers this sparse, **most
dogs end by tuckering out**, and that is the intended normal ending rather than a failure
state. It gives every player a full-length run, and it makes the round a predictable ~14
seconds instead of a lottery.

Stopping points become **rare, high-stakes events**: about 11% of dogs find a squirrel and
5% end up in a lake. That is a much better shape for them than the original design, where
hitting one was simply what happened to everybody. The squirrel is now genuinely a
jackpot, and the lake genuinely a disaster.

| | Original (27×27 maze, 1 per 22) | Now (20×20 open, 1 per 60) |
|---|---|---|
| Dogs finished within 4s | 50% | 28% |
| Median dog life | 20 ticks | 37 ticks |
| Round length | 94 ticks (19s) | 71 ticks (14s) |
| Ended by squirrel / lake | 41% / 25% | 11% / 5% |
| Ended by tuckering out | 22% | 63% |

### 4.5 Map format

Author maps as plain ASCII text files with a legend. Hand-authored SF neighbourhoods (the
Mission, North Beach, the Sunset, Golden Gate Park) will be far more characterful than
anything generated, they're trivially editable, and they diff cleanly. `scripts/make-map.mjs`
produces a correctly shaped starting point; `scripts/preview.mjs --walk` shows you where
dogs actually go on it; `scripts/tune.mjs` measures a density change across many seeds
before you commit to it.

```
#  building / wall        .  street (walkable)
,  park (walkable)        S  sniff spot
P  person with treats     Q  squirrel in a tree (stopper)
~  lake / water (stopper) D  storm drain (stopper)
1-8 dog start positions
```

---

### 4.6 What a dog does at a wall

The rule is **turn right** — 90° to the dog's own right, so a dog walking down the screen
turns to screen-left. Repeating it gives the order right, back, left, which means a dead end
costs two turns and the dog walks back out.

It was chosen when placed tiles were **permanent**, and its job was to stop dogs being
trapped too cheaply. Tiles are single use now (§5.3), so that constraint has relaxed, and
the obvious alternative — **turn around** — deserved a look. Measured with
`node scripts/wall-rule.ts` over 120–150 seeds per board, all three rules on identical maps
and identical tiles:

| board | rule | score | ticks lived | distinct tiles | culled by loop detection |
|---|---|---:|---:|---:|---:|
| small | right | 4.88 | 22.0 | 13.5 | 22% |
| | around | 2.51 | 14.5 | **5.4** | **91%** |
| | open | **6.18** | **24.1** | **17.4** | **0%** |
| medium | right | 5.39 | 24.6 | 16.9 | 7% |
| | around | 2.22 | 15.5 | **5.7** | **81%** |
| | open | **6.00** | 23.4 | **18.4** | 1% |
| large | right | 6.35 | **32.7** | 23.9 | 3% |
| | around | 2.56 | 18.5 | **6.6** | **84%** |
| | open | **7.86** | 31.7 | **24.7** | 2% |

**Turning around does not work, and the reason is worse than ping-pong between two walls.**
The ping-pong worry assumed a corridor, and §4.2 already forbids 1-wide corridors. The real
failure is that reversing makes a dog's path *one-dimensional*: it runs east until something
stops it, reverses, runs west until something stops it, and never leaves that row. It covers
about **six tiles for the whole round** against 13–24, and loop detection then culls 80–90%
of rounds as repeats. Halved scores are the symptom; the cause is that the dog stops
exploring in two dimensions the moment it meets its first wall.

Worth noting that players cannot build walls anyway. The palette is four arrows and a jump —
the only permanent obstacle a player can create is a **scuff**, and that needs two people to
choose the same square in the same turn (§5.4). Deliberate trapping is already hard, which is
what freed the rule up in the first place.

**`open` — look both ways, go where you can see further, ties to the right** — beats turn
right on every board, most clearly on the small one where walls are closest together. It
also changes *how rounds end*: on the small board it takes loop-detection culls from 22% to
zero and turns them into dogs that tucker out, which §4.4 says is how a round is supposed to
finish. It is arguably easier to learn too — "it heads for open ground, and prefers its
right" is a reason, where "it always turns right" is a fact to memorise — and it makes dogs
harder to corner rather than easier.

`CONFIG.sim.wallRule` selects between the three. It ships as **`open`**.

The same rule governs a dog blocked by *another dog*, not just by terrain — blocked is
blocked, and two rules would be two things to learn. The sightline scan deliberately ignores
other dogs, which move, and reads only terrain and scuff marks.

## 5. Direction Tiles

### 5.1 A palette, not a hand — **unlimited supply, three to five placements**

Every player can choose from **↑ ↓ ← → jump** on every turn, and **tiles are never used
up**. Place a → on turn 1 and you can place another → on turn 2. One placement per turn,
and **how many turns is a property of the board** (§4.1): five at two players, four at
three to five, three at six to eight.

The scarce resource is **placements and positions**, not tile kinds. What sets the number is
the same two things at every player count:

- **Board density.** 8 players × 3 placements = 24 tiles; 2 players × 5 is 10. Dense enough
  that routes cross and collide constantly, without the board becoming noise — past roughly
  25 tiles nobody can predict anything, which paradoxically makes planning pointless. This
  is why the count falls as players rise rather than staying fixed.
- **Round length.** Three to five turns of ~30 seconds is 1.5–2.5 minutes of planning per
  round. Five turns at eight players pushed a match past 15 minutes, which is long for a
  living-room game, *and* asked everyone to track 40 arrows.

**If rounds feel too short, add a round — don't add placements.** More rounds increases
play time while keeping each round legible; more placements just makes each round muddier.

### 5.2 Why the supply is unlimited

This replaced a fixed hand of one of each direction plus one jump. That version had a
genuine texture to it — you couldn't turn the same way twice, so a route needing two norths
had to borrow one from a wall — but it was the wrong trade for this game:

- **It doubled what a new player has to track.** Working out where your dog will be in
  twelve seconds is already the hard part. Also budgeting which arrows you have left is a
  second, unrelated planning problem competing for the same 30-second timer.
- **It punished the interesting play.** Spending your only ← to cut off an opponent meant
  your own route was permanently short an arrow. The rule quietly discouraged exactly the
  cross-player interference the simultaneous reveal exists to create.
- **The kinds were symmetric anyway** (see §3.1), so "one of each" wasn't balancing
  anything — it was just a cap.

With an unlimited supply the game is purely about **where** and **when**, which is the part
worth thinking about. It also makes the design robust to a player who simply picks the
obvious arrow every turn: they still have to choose a square.

### 5.3 Placement rules

- **Open ground only** — street or park, not occupied by an existing tile and not a square
  a dog is currently standing on. Everything else on the board is *something*: a hydrant to
  sniff, a person with a treat, a squirrel, water, a drain. A tile dropped on top of one
  covered the art and read as a bug, and it is a rule you can apply by looking, where
  "walkable and not a stopping point" needed you to remember which things stop a dog.

  This replaced an earlier rule that allowed placing on sniff spots and people.
- **Unused start slots are ordinary ground.** Every board carries eight start squares but a
  smaller game only uses the first few, and an empty slot is just a tile like any other. It
  is only the *occupied* ones that are off limits.
- **Range is unlimited.** Placing tiles far from your own dog — in front of somebody
  *else's* dog — is a legitimate and encouraged play.
- Tiles are **not owned during the walk.** Any dog that steps on any tile obeys it. Your
  carefully built route will be ridden by the Beagle mix, and that's the best part of the
  game.
- **Tiles are single use.** A tile fires for the first dog that steps on it and is then
  spent, vanishing with a burst in its owner's colour. Scuff marks are *not* tiles and are
  never consumed — they are walls.

  This replaced permanent tiles, and it closed a hole that could end somebody's round in
  seconds: two players **bookending a dog with opposing arrows** pinned it between them, it
  ping-ponged, and loop detection stopped it on the spot. Single use turns that trap into
  two redirects and then the dog walks out the far side.

  It also measurably improved the game everywhere else. Across 50 seeds on the large board,
  the share of dogs finished inside 30% of their stamina fell from **22% to 9%**, median dog
  life rose from 27 ticks to 40, and mean score from 5.0 to 6.1 — permanent tiles were
  quietly herding dogs into loops that loop detection then culled.

  One consequence in the sim: loop detection assumes "same position and facing means the
  same future", which spending a tile breaks. Every dog's visited-state history is cleared
  whenever a tile is consumed. See `simulate.ts`.
- **The timer forfeits, it does not auto-place.** When it expires:
  - a tile you have put on the board but not locked in **counts as placed** — you chose a
    square, you just didn't press the button;
  - if you chose nothing, you **lose that turn's placement** and the round moves on.

  Auto-placing on a player's behalf was worse than doing nothing. It put a tile on the board
  that its owner didn't choose and might not have noticed, which pollutes everyone else's
  reads of the position for the rest of the round. A missing tile is honest and legible; a
  guessed one is noise. It also removes the "sensible default" question entirely — there
  isn't one, because a tile's value is almost entirely in *where* it is.

  Nobody can stall the table either way: the round advances on the timer regardless.

### 5.4 Collisions and the scuff mark

If two or more players place tiles on the **same square** in the same turn, the tiles
**cancel**. Play the animation on reveal.

Instead of the square simply going empty, a cancelled placement leaves a **scuff mark**:
a permanent obstacle that dogs turn right at, exactly like a wall.

This is a better rule than plain cancellation. Two players fighting over one square don't
just waste two tiles into the void — they jointly *build a wall* there, which changes the
map for everyone and often ruins both their plans in a way that's funny rather than flat.

Secret-turn collisions cancel silently. The scuff mark is only revealed when the first dog
reaches it.

### 5.5 The secret turn

**The last turn of a round is always the secret one**, whether that is turn 5 on the small
board or turn 3 on the large one. Its tile stays hidden through the whole placement phase
and is revealed the moment a dog steps on it, mid-walk. Two consequences worth designing
around:

- **Timing matters.** A secret tile placed where a dog has already passed does nothing. The
  secret turn rewards players who can predict where dogs will be *late* in the walk.
- **It's the bluff turn.** The open turns leak information progressively; by the last one
  everyone has a good model of everyone else's plan, which is exactly the moment to hide
  something. On the large board that model is built from two turns rather than four, so the
  bluff is cheaper to pull off and the read is worth more.

---

## 6. Scoring

| Event | Points ⚖️ | Notes |
|---|---|---|
| Sniff spot | 2 | Diminishing — see below |
| Person with treats | 3 | Consumed. First dog only. The dog stands **on** the person's tile, so during the hand-over the pair step apart — person left and leaning in, dog right — putting the treat between them instead of drawing one on top of the other. |
| Dog greeting (two dogs bump) | 1 each | Max once per pair of dogs per round |
| Squirrel in a tree | 5, then **stop** | High risk/reward: great points, ends your run |
| Lake | −2, then **stop** | Wet dog. Pure hazard. |
| Storm drain | 0, then **stop** | Neutral. Exists to kill perimeter loops. |
| Tuckered out (stamina 0) | 0 | |
| Chasing its tail (cycle detected) | 0 | |

**Diminishing sniffs:** the first dog to a sniff spot gets **2**, the second gets **1**, and
every dog after that gets **0** — someone already got there. This keeps early routes
valuable and competitive without hard-deleting content from the board the way consumed
treats do.

**The squirrel is the design's best tension.** It's the biggest single prize *and* it ends
your run. Going for it early means banking 5 points and forfeiting the rest of the round;
threading past it is a flex. Make squirrels visible and make players want them.

---

## 7. Networking & Serving

**LAN only.** One machine hosts, everyone in the room joins from a phone or laptop over
Wi-Fi. No accounts, no install, no internet dependency.

Scoping to a LAN removes work rather than adding it:

- **No room codes and no room registry.** One game per server. Open the URL, type a name,
  you're in — nothing to read off a screen and type into a phone.
- **No public URL handling.** The server prints its detected LAN address and that's the
  whole story.

Two things that were originally there for remote play are worth keeping anyway:

- **The walk phase ships as one payload, not a live stream.** The server simulates the
  entire walk, then sends the complete tick history in a single message and lets each
  client animate it locally. This is simpler than streaming ticks, immune to a flaky
  phone Wi-Fi connection, and guarantees every player sees an identical round.
- **Reconnection.** Players get a session token in `localStorage` and can rejoin a game in
  progress. A phone locking its screen mid-turn shouldn't kill the game, and on a LAN
  full of phones that happens constantly.

- **Port** ⚖️ **9663** — that's `WOOF` on a phone keypad. Memorable, well above 1024,
  unlikely to collide with anything. Configurable via `PORT`.
- **Joining:** the server prints its LAN address on startup and the board screen shows it.
  A QR code on the board screen would save everyone typing an IP — worth adding.
- **Server-authoritative.** The server owns the entire game state and runs the simulation.
  Clients render and send one message per turn ("place tile at x,y"). This is the only sane
  choice given hidden information — a client must never hold data it isn't allowed to show.
- **Hidden placement** works naturally: a pending placement lives only on that player's
  device and is sent to the server on lock-in. The server broadcasts placements only at
  reveal time.
- **The walk phase** is simulated to completion server-side and sent as one tick history;
  clients animate it locally (see above). 8 dogs × ~90 ticks × position/facing/score is a
  few KB. Never run the sim client-side and try to sync it.
- **Tick rate** ⚖️ **1.5–2.0 seconds per tile, set by the board** (§4.1), with smooth
  interpolation between ticks. This is deliberately slow. The whole payoff of the game is
  watching a route you built play out against seven other people's, and at 5 ticks/second
  the walk phase was over before anyone could follow what had happened. The bigger boards
  are slower because there are more dogs on them to follow at once, not because they are
  bigger. Stamina is sized per board so the walk lands at 44–62 seconds.
- **Jumping dogs scale up** as they rise, so the hop reads as coming toward the camera
  rather than sliding upward. The ground shadow stays put and shrinks.

### 7.1 Two views

Every client renders the full board, and there's also a dedicated **board view** (`/board`)
with no hand UI, for a TV in the room. It attaches to the running game automatically.

Board view on the TV, private hands on everyone's phone: shared spectacle on the big
screen, hidden information in each palm. The hidden-information rules make this work with
no extra design — a pending placement never leaves the placing player's device until
lock-in.

---

## 7.1a Scoring has no clock

The scoring phase lasts exactly as long as the read-out: **one dog at a time on a podium
that fills the board**, rushing toward the camera with its placing and score, then blowing
past as the next arrives. Last place first, so it builds to the winner. The server sizes the
phase from the number of players rather than a fixed timer, and the client hides the
countdown — a countdown implies you can act, and here there is nothing to do but watch.

A fixed 15 seconds either cut an eight-player read-out off mid-countdown or left a solo
player staring at a finished board.

## 7.2 Host controls

The player who starts the game runs it:

- **Match length** — 1, 2, 3, 5 or 7 rounds, chosen in the lobby before starting and
  changeable between matches. Three is the default. Anyone can watch it change; only the
  host can change it.
- **End the match** — available mid-match, behind an inline confirmation. Scores earned so
  far stand and the room drops to the final standings, so it means "we're done", not "throw
  it away". A new match can start immediately afterwards.

The confirmation is inline rather than a browser `confirm()`, which phones handle poorly and
some block outright.

- **Add a computer opponent** — in the lobby, at a chosen difficulty. See §7.2a.
- **Claim host** — not a host control at all, but its counterpart: available to *any*
  player once the host's connection has been gone longer than `CONFIG.lobby.hostGraceMs`.
  Everything above is host-only, so a host who closes their tab leaves a room nobody can
  start. The server cannot tell that someone has left, only that their socket shut, which
  is why there is a grace period and a heartbeat rather than an instant handover.

## 7.2a Computer opponents

Opponents take a seat and a dog like anyone else. Eight is still the limit, and the board
size still follows the number of dogs, so a match against five bots is played on the same
board five friends would get — player density is held constant whoever is holding the leads.

**The design rests on one measurement.** `simulateWalk` is pure and costs 0.036 ms on the
small board, 0.140 ms on the large one, and a turn only ever offers 250–785 legal
placements. Scoring *every* legal placement by simulating the round it produces therefore
costs about a tenth of a second. A bot needs no heuristic evaluation function, because it
can afford to ask the real rules what each option actually does.

That is why even the weakest tier is strategic. It is not guessing and then dressing the
guess up — it is choosing between outcomes it has watched play out. The ladder is about how
much of the *rest* of the game each tier models, not about whether it understands the board.

| tier | search | λ | character |
|---|---|---|---|
| Pup | samples 45% of the board, picks softmax-weighted | 0 | every move considered, but short-sighted and unaware of you |
| Scout | every legal placement, takes the best | 0.25 | solid, and starts to weigh what it costs everyone else |

λ weighs opponents' mean score against the bot's own, and is what makes the tiers feel like
different players rather than the same player with sharper eyesight: at 0 the bot does not
know you exist; above 0 it will give up points of its own to take more away from the table.
Opponents are averaged rather than maxed, because fixating on whoever leads makes a bot that
ignores the board to chase one player.

Both tiers are one-ply. What that cannot do is **chain** — turn right here so the jump over
there lands on the treat. Five tiles are a route, not five independent nudges, and expressing
that needs a beam search over the remaining turns.

Two constraints that are easy to break by accident:

- **Bots must not be able to cheat, and the risk is real.** A bot runs inside the server
  where `secretTiles` and every player's `pending` sit in scope, and a bot that read either
  would be undetectable from outside. So the search never receives a `Room`. It receives a
  `BotView`, built from nothing but the `state` message that seat's browser was already
  going to get. If a human cannot see it, it is not in the payload, so it cannot reach the
  search — structural rather than a rule to remember. `test/ai.test.ts` fails if that stops
  being true.
- **Bots go through `place()` and `lock()`**, the same methods a human's socket message
  reaches. No privileged path, so legality, the collision-into-scuff rule and the turn timer
  apply to them by construction.

The whole bot team shares `CONFIG.ai.turnBudgetMs` (3 s of a 30 s turn), split by difficulty
and yielded to the event loop throughout. Shared rather than per bot: the server has one
thread, and seven opponents each taking a second would freeze every human's board while they
thought.

**Autopilot.** Any player can hand their own dog to the computer and take it back, mid-match
included. It is self-only — nobody else decides who plays your dog. With every seat on
autopilot nobody has anything left to place and the match plays itself, which is the way to
just watch: put the board view on a TV and let the dogs get on with it.

`npm run ai-tourney` plays the tiers against each other over many seeded rounds, swapping
start slots halfway so a lucky seat cannot flatter one of them. Until it says the ladder
orders, "Scout is stronger than Pup" is a claim about code rather than a fact about play.
It currently reports Scout winning 80% of decisive rounds on the small board, averaging
11.4 points to 5.25.

## 7.3 Sound

Everything is synthesised with Web Audio; there are no audio files. That keeps the game
asset-free and instant to serve on a LAN, and it lets the music respond to the game.

- **Two themes, written out note by note.** They started as one tune at two tempos, and that
  is exactly what it sounded like — the walk theme was audibly just the placing theme sped
  up. They now differ in key, mode, progression, rhythm and instrumentation:
  - **Placing** — A minor, 76 BPM, sine lead, long held notes with space between them, no
    drums. Sits under people thinking without demanding attention.
  - **Walking** — C major pentatonic over I–V–vi–IV, 138 BPM, square lead with a hook that
    rises, answers itself and falls back, a counter-melody entering in the second half, a
    walking bass on every eighth, and kick/snare/hat underneath.

  Measured over the same 2.6 seconds: the placing theme plays 5 notes across 5 pitches, the
  walk theme 33 notes across 16, sharing only two pitches between them.
- **Scoring is silent** so the standings read-out and the timer chimes have room.
- **Every sim event has a sound**, driven off the same event stream as the visuals so the
  two can never drift apart: barks when dogs greet, snuffling on a sniff, a rising phrase
  for a treat, a thud on a bump, a jackpot arpeggio for the squirrel, a splash for the lake,
  a sighing fall for tuckering out.
- **A mute toggle** in the header, remembered in `localStorage`. Browsers block audio until
  a gesture, so nothing plays until someone clicks Join.

## 8. Round Flow, Precisely

```
LOBBY      → players join, pick dogs, host starts
SETUP      → map revealed, dogs placed facing center, pickups shown
TURN 1..4  → [place: 30-40s] → [lock] → [reveal all] → [resolve cancellations → scuffs]
TURN 5     → [place: 30s] → [lock] → (no reveal)
WALK       → tick loop until all dogs stopped or all stamina exhausted
SCORE      → per-dog breakdown, running match total
             → next round, or MATCH END after round 3
```

---

## 9. Open Questions

- Should a dog that stops on a stopping point still block other dogs, or become passable?
  (Leaning: it blocks — a stopped dog is an obstacle, and late-round pileups are funny.)
- Does turning right cost a tick? (Leaning: **yes** — it makes walls a real cost and it
  reads clearly on screen.)
- ~~Should the map be re-randomized between rounds?~~ **Resolved**: fresh map per *match*,
  stable across the rounds inside it. See §4.1.
- Is 3 rounds enough, or does the game want 4?
- ~~Do tiles fade after repeated uses?~~ **Resolved**: single use. See §5.3.

---

## 10. Brainstorm — Ideas Worth Trying

### 10.1 Breed traits — **explicitly deferred, not in v1**

Right now the eight dogs are skins, and that is the decision for v1: eight asymmetric
passives is a balance problem that would need far more playtesting than the base rules,
and it would confound that playtesting — you'd never know whether a tuning number was wrong
or a trait was. Get the map density, stamina, and tile count right with identical dogs
first. Parked sketches, for later:

| Dog | Trait |
|---|---|
| Beagle mix | **Nose.** Also collects sniffs from tiles directly adjacent to its path. |
| Irish Wolfhound | **Long stride.** Jumps travel 3 tiles instead of 2. |
| Cockapoo | **Squeezer.** Once per round, passes straight through a fence instead of turning. |
| Labrador | **Food motivated.** Treats are worth 5 instead of 3. |
| Aussie Shepherd (brindle) | **Herder.** Dogs it bumps turn *left* instead of right. |
| Aussie Shepherd (b&w) | **Focused.** Ignores the first stopping point it hits. |
| Labradoodle (lab) | **Endurance.** +30 stamina. |
| Labradoodle (poodle) | **Clever.** Starts with a second jump tile instead of the → tile. |

Keep traits to one line each. The moment a trait needs a paragraph it's too complicated for
a game where the whole appeal is watching dogs do something dumb.

### 10.2 San Francisco hills — needs a rework before it's viable

The original sketch was: climbing costs 2 stamina, and running downhill moves 2 tiles with
the dog unable to turn. **That last part doesn't survive contact with the tile economy.** If
direction tiles are ignored on downhill squares, nobody would ever place one there, which
turns every downhill tile into dead board space — you've spent map area to *remove* player
options. A rule that makes a region unplaceable is strictly worse than not having the
region.

If hills come back, downhill should be **speed without loss of control**: a downhill dog
moves 2 tiles per tick and still obeys every tile it lands on. It covers ground faster,
burns the map quicker, and is harder to intercept — which is interesting — without ever
making a placement meaningless. The uphill stamina cost can stay as-is.

### 10.3 Moving hazards

- **Cable car** on a fixed track, advancing one tile per tick. Dogs bounce off it. It's
  the single most San Francisco thing available and it makes routes time-sensitive.
- **Mail carrier** patrolling a fixed loop. Dogs that reach one stop and bark (0 points).
- **Skateboarder** down a hill street.

All should be deterministic and on visible fixed paths — the game's whole promise is that
a smart player can predict what happens.

### 10.4 Off-leash zones

Parks are off-leash: sniff spots inside a park are worth double. This gives players a reason
to route toward open areas, where dogs interact most and where the game looks best.

### 10.5 Modes

- **Team mode** (4v4, combined score) — makes tile cancellation into deliberate teamwork.
- **Fog rounds** — the middle of the board is hidden during placement, revealed at walk.
- **Sudden death** — on a tie, one round with two tiles each on a small map.

### 10.6 Presentation

- **End-of-round replay** with a highlight: longest run, most sniffs, most collisions,
  "Best Boy" award. The walk phase is fully deterministic and recorded, so replay is nearly
  free to implement.
- **Bark emotes** between turns. Eight people in a room mashing bark buttons at each other
  during a 30-second timer is a real feature.
- **Per-dog trail** in the player's color during the walk, fading behind them, so you can
  see the shape of what you built.
- **Name your dog** in the lobby. Costs nothing, and people get attached.

### 10.7 Things deliberately not doing

- **Randomness in the walk phase.** The determinism is what makes planning meaningful.
- **Tiles that only affect your own dog.** It would remove all cross-player interaction —
  which is the entire game.
- **Real-time control of dogs.** The commitment-then-watch structure is the point.
