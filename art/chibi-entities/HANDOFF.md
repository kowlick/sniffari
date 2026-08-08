# Chibi people/entity sprite handoff

## Status and deliverables

The first priority in `art/ENTITIES.md` is packaged: eight distinct people who can idle with a treat, give it to the player dog, and remain in a friendly post-give state.

- Runtime atlas: `public/art/people-chibi.png`
- Runtime QA preview: `art/chibi-entities/people-preview.jpg`
- Reusable character sheets: `art/chibi-entities/people-sheets/*.png`
- Deterministic normalization/assembly script: `art/chibi-entities/build_people_atlas.py`
- Historical generation record: `art/chibi-entities/PEOPLE_WORKLOG.md`

Runtime atlas SHA-256:

```text
2C70B29F133A5165CA58DC5EC0ADB27B4441A917C6DCFA3289FCBD1A0CE29C21
```

The packaged PNGs are final transparent RGBA assets. A future model can assemble the runtime atlas from the character sheets without the original generated images.

## Character-sheet grammar

Every file in `people-sheets` is a transparent **1024 x 1536 RGBA PNG** with **4 columns x 3 rows**. Each logical cell is **256 x 512 px**. A cell is deliberately twice as tall as it is wide so a standing person can render one tile wide and two tiles high.

Rows are gameplay states; columns are animation frames:

| Sheet row | State | Frame behavior |
|---:|---|---|
| 0 | `idle` / has treat | Four-frame subtle bob, blink, or look loop |
| 1 | `giving` | Sequential action: notice, lean/crouch, extend treat, complete handoff |
| 2 | `given` / empty | Friendly post-give loop; two poses arranged A-B-A-B |

| Sheet column | Frame | Use |
|---:|---|---|
| 0 | 0 | Loop start or action start |
| 1 | 1 | Second pose/action phase |
| 2 | 2 | Third pose/action phase; A repeat in the `given` row |
| 3 | 3 | Fourth pose/action finish; B repeat in the `given` row |

Crop a source cell with:

```text
x = frame * 256
y = state * 512
crop = (x, y, x + 256, y + 512)
```

Each cell contains exactly one character and that character's persistent role prop. A bicycle, pram, skateboard, walking stick, picnic blanket, or basket is part of the character silhouette, not a separate atlas object.

The visible group is centered horizontally, fits within approximately **232 x 424 px**, and uses a common foot/contact line at **y = 436** in the 512 px cell. This is 85% of cell height. Do not trim each cell to a different canvas or the characters will jitter in game.

## Runtime-atlas grammar

`public/art/people-chibi.png` is a transparent **1536 x 2048 RGBA PNG**, arranged as **12 columns x 8 rows** of **128 x 256 px** cells.

```text
atlas_row = character_index
atlas_column = state_index * 4 + frame
atlas_x = atlas_column * 128
atlas_y = atlas_row * 256
```

Column blocks:

- 0-3: `idle`
- 4-7: `giving`
- 8-11: `given`

The `giving` block is an action and normally plays once. `idle` and `given` are loops. The `given` block intentionally repeats two unique images as A-B-A-B so all states retain four frame slots.

Recommended timing:

- `idle`: 5-8 frames per second
- `giving`: 8-10 frames per second, play once, then switch to `given`
- `given`: 4-6 frames per second

## Character row order

| Atlas row | Character sheet | Identity and persistent prop | Personality read |
|---:|---|---|---|
| 0 | `00-kid.png` | Kid with yellow treat pouch | Enthusiastic junior dog expert |
| 1 | `01-jogger.png` | Jogger with belt pouch | Upbeat mid-run pause |
| 2 | `02-older-neighbor.png` | Older neighbor with walking stick and biscuit pocket/tin | Patient and kind |
| 3 | `03-barista.png` | Barista with plain puppuccino cup | Cozy café energy |
| 4 | `04-skateboarder.png` | Skateboarder with teal board and jacket pocket | Relaxed and cool |
| 5 | `05-parent-pram.png` | Parent with navy pram and coral treat pouch | Cheerful multitasker |
| 6 | `06-cyclist.png` | Cyclist with turquoise bicycle and helmet | Energetic adventurer |
| 7 | `07-picnicker.png` | Picnicker on yellow blanket with wicker basket | Serene animal lover |

The row order is the public contract. Add new characters as new rows or deliberately migrate all row references; do not alphabetize these files in place.

## Rendering contract

These sprites use a foot anchor rather than a tile-center anchor:

```text
anchor = "foot"
footRatio = 0.85
source cell = 128 x 256
```

With the repository's `drawCell()` helper, preserve the cell aspect ratio and plant the foot
point on the normal entity ground line. The atlas cell itself is one tile wide and two tiles
high. At runtime `drawPerson()` scales ordinary people to **0.72** so dogs remain the visual
focus; atlas row 5, the parent-and-pram silhouette, stays at **1.0** because its overall
footprint was already correct. A representative lookup is:

```js
const stateIndex = { idle: 0, giving: 1, given: 2 }[state];
const column = stateIndex * 4 + frame;
const row = characterIndex;
```

Do not draw these as 128 x 128 squares. That would vertically squash the characters and their role props.

## Deterministic assembly recipe

The reusable normalized sheets are already transparent. Atlas assembly is a direct crop and 50% downscale:

```python
from PIL import Image

names = [
    "00-kid.png",
    "01-jogger.png",
    "02-older-neighbor.png",
    "03-barista.png",
    "04-skateboarder.png",
    "05-parent-pram.png",
    "06-cyclist.png",
    "07-picnicker.png",
]

atlas = Image.new("RGBA", (1536, 2048))
for character_row, name in enumerate(names):
    sheet = Image.open(name).convert("RGBA")
    assert sheet.size == (1024, 1536)
    for state in range(3):
        for frame in range(4):
            cell = sheet.crop((
                frame * 256,
                state * 512,
                (frame + 1) * 256,
                (state + 1) * 512,
            ))
            cell = cell.resize((128, 256), Image.Resampling.LANCZOS)
            column = state * 4 + frame
            atlas.alpha_composite(cell, (column * 128, character_row * 256))

atlas.save("people-chibi.png", "PNG", optimize=True)
```

Before LANCZOS resizing, clear RGB values in pixels whose alpha is zero. This avoids colored halos from hidden RGB data.

## How the normalized sheets were made

The accepted ImageGen sources were 1254 x 1254 sheets on flat green, each with a 4 x 3 logical grid. `build_people_atlas.py` performs these steps:

1. Soft-matte chroma removal with border key sampling and despill.
2. Balanced integer splitting of the source into four columns and three rows.
3. Alpha-bounds extraction per logical cell.
4. One uniform scale per state row so movement changes pose, not character size.
5. Horizontal centering and planting on `y = 436` in a 256 x 512 cell.
6. Residual green removal and hidden-RGB cleanup.
7. Direct assembly into the runtime atlas and opaque QA preview.

The original selected generated filenames remain documented in `PEOPLE_WORKLOG.md`. The final character sheets are the portable source of truth.

## Art direction for extensions

Match the chibi dog set:

- oversized rounded head, compact bean-like torso, tiny limbs
- thick smooth dark-chocolate outline
- clean flat colors, minimal shading, readable expression
- white-and-dark eyes with small catchlights, clear gaze, and friendly eyebrows when useful
- personality expressed through pose, face, silhouette, and one role prop
- no text, logos, scenery, baked shadow, floor, watermark, or unrelated second character

A generation prompt for a new person should explicitly request an exact 4 x 3 sheet with the row/state and column/frame grammar above. Generate one character per sheet. Use a flat chroma background or true transparency, then normalize it to the same cell size and foot line before appending a runtime row.

## QA checklist

- Every character sheet is RGBA, 1024 x 1536.
- The runtime atlas is RGBA, 1536 x 2048.
- All 96 runtime cells are non-empty.
- No cell crosses its 128 x 256 rectangle.
- Horizontal transparent margin is at least about 6 px in runtime cells.
- Feet/contact props sit at approximately y=218 in runtime cells.
- No visible green-screen residue or baked background remains.
- White and cream regions are inspected over a dark opaque preview.
- `giving` reads as a four-step action; `idle` and `given` loop cleanly.

## Runtime and next work

The atlas is packaged but not wired into NPC gameplay by this art task. A future implementation model should connect character row/state/frame selection to the world entity state machine and use the rendering contract above.

Per `art/ENTITIES.md`, the next art priorities after people are:

1. Squirrel-in-tree idle/chased/gone animation.
2. Tuckered-out four-frame dog loop.
3. Sniff-spot state and animation variants.
