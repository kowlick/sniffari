# Dog sprite atlas

> **Status: integrated.** The chibi set at `public/art/dogs-chibi.png` is what the game
> renders — see [chibi-dogs/HANDOFF.md](chibi-dogs/HANDOFF.md). The spec below is what the
> loader expects, kept for producing further sheets.
>
> Append `?art=drawn` to the URL to force the procedural sprites instead, for comparison.
> The procedural renderer is also the automatic fallback if the atlas fails to load.
>
> For everything that isn't a dog — props, terrain, player tiles, effects — see
> [ENTITIES.md](ENTITIES.md).

## The sheet

One PNG-32 with transparency, uniform cells in a fixed grid.

| | |
|---|---|
| Cell size | **128 × 128 px** |
| Columns | **16** — 4 directions × 4 walk frames |
| Rows | **8** — one per breed |
| Sheet size | **2048 × 1024 px** |

### Row order (must match `DOGS` in `src/server/protocol.ts`)

| Row | Breed | Coat |
|---|---|---|
| 0 | Cockapoo | all white, curly, floppy ears, small, curled tail |
| 1 | Labrador | **all black**, smooth, floppy ears, black nose |
| 2 | Irish Wolfhound | wiry grey, perky/rose ears, tall and lean, long legs |
| 3 | Aussie Shepherd (brindle) | brindle brown, perky ears, plumed tail |
| 4 | Aussie Shepherd (b&w) | black with white blaze, chest and paws, perky ears |
| 5 | Labradoodle (lab-leaning) | golden, curly, floppy ears |
| 6 | Labradoodle (poodle-leaning) | chocolate, curly, long ears |
| 7 | Beagle mix | tan and white, long ears, low and stocky |

### Column order

`column = direction * 4 + frame`, so columns 0–3 are direction 0, columns 4–7 direction 1,
and so on.

| Direction | Index | Pose |
|---|---|---|
| Up | 0 | Seen **from behind** — back of the head, tail toward the camera |
| Right | 1 | Side profile facing right |
| Down | 2 | Facing the camera, head-on |
| Left | 3 | Side profile facing left |

**You can omit the Left block (columns 12–15) if you prefer** — the renderer will mirror the
Right block instead, and the sheet becomes 12 × 8 (1536 × 1024). Hand-drawn Left art looks
better; mirroring is free.

Frames 0–3 are a walk cycle. **Frame 0 must be a neutral standing pose**, because it doubles
as the "stopped" sprite when a dog has finished its round.

## Rules that matter

- **Do not draw the collar.** Player identity is a coloured collar and a coloured ring, and
  those are still drawn procedurally on top — that is what lets eight people tell their dog
  apart. A baked-in collar would fight it.
- **Centre the dog in its cell**, with the feet at roughly 85% of the cell height, so the
  sprite plants on the tile rather than floating.
- **Leave ~6 px of transparent margin** inside each cell. Cells are sampled with smoothing,
  and art touching the edge will bleed into its neighbour.
- **No drop shadow.** The renderer draws a ground shadow that scales and lifts during jumps.
- Sprites are drawn at up to ~1.1× the tile size. At a 64 px tile that is ~70 px, so 128 px
  cells give you 2× headroom for high-DPI screens.

## Optional manifest

If you want to change the grid, add `public/art/dogs.json`:

```json
{ "cell": 128, "frames": 4, "mirrorLeft": false, "order": ["cockapoo", "labrador", "..."] }
```

Without it the defaults above are assumed.

## Trade-offs worth knowing

The procedural sprites scale cleanly to any tile size, and tile size varies a lot here —
three board sizes across phones and laptops. A raster atlas is fixed-resolution and will
soften when scaled. It will also be ~96–128 frames of art before anything is playable. If
what you want is *more recognisable breeds* rather than a different rendering style, adding
shape fields to `DOGS` (a saddle marking, a beard, a topknot) is much cheaper.
