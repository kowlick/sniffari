# Chibi dog sprite atlas handoff

## Status and deliverables

This set is complete and includes the 2026-08-07 character/detail revision. It was generated with the built-in image-generation workflow, cleaned to transparent RGBA, normalized into exact breed sheets, and assembled into a runtime-sized atlas.

- Runtime atlas: `public/art/dogs-chibi.png`
- Opaque visual QA preview: `art/chibi-dogs/atlas-preview.jpg`
- Style reference supplied by the user: `art/chibi-dogs/reference-style.png`
- Beagle color/marking reference supplied by the user: `art/chibi-dogs/beagle-color-reference.png`
- Reusable breed sheets: `art/chibi-dogs/breed-sheets/*.png`
- Rebuild/normalization script: `art/chibi-dogs/build_dog_atlas.py`
- Original `public/art/dogs.png`: preserved unchanged

Final atlas SHA-256: `F3D0756627F4B98BCF9448CB400EE8F209081AE69B4F03E67F44AFD26E403482`

Revision summary:

- Every face-visible dog frame now uses compact white-and-dark directional eyes/catchlights for a cuter, more readable gaze.
- The Cockapoo has a petite pink tongue in every face-visible frame; in the front row it leans toward the dog's left, which is the viewer's right. The back row correctly shows no tongue.
- The Beagle mix now uses the attached warm caramel-and-white coat pattern instead of a solid-brown coat.
- Every cell is replanted on one measured foot baseline. This explicitly fixes the brindle Aussie's previously floating front row.

The source reference is a style reference, not an edit target. Its relevant design language is: rounded kawaii proportions, oversized head, compact bean-like body, tiny legs, thick smooth dark-chocolate outlines, flat colors, minimal facial features, and a simple graphic tail.

## Breed-sheet layout

Every breed sheet is a transparent **1024 x 1024 RGBA PNG** containing an exact **4 x 4** grid of **256 x 256 px** cells.

Rows are directions and columns are animation frames:

| Sheet row | Direction | View |
|---:|---|---|
| 0 | Up | Seen from behind; tail toward camera |
| 1 | Right | Side profile facing right |
| 2 | Down | Facing camera head-on |
| 3 | Left | Side profile facing left |

| Sheet column | Frame | Purpose |
|---:|---|---|
| 0 | Neutral | Required stopped/standing pose |
| 1 | Step A | First alternating-foot walk pose |
| 2 | Passing | Bouncy middle walk pose |
| 3 | Step B | Opposite alternating-foot walk pose |

To crop one breed-sheet frame:

```text
x = frame * 256
y = direction * 256
crop = (x, y, x + 256, y + 256)
```

The normalized sheets place the lowest visible paw pixel at `y = 218` (85% of 256), within one antialiased pixel, and preserve at least about 12 px of transparent horizontal margin. They can be downscaled directly to 128 x 128 cells. Do not trim or independently recenter cells after this point.

## Runtime atlas layout

`public/art/dogs-chibi.png` is a transparent **2048 x 1024 RGBA PNG** with **16 columns x 8 rows** of **128 x 128 px** cells.

```text
atlas_column = direction * 4 + frame
atlas_x = atlas_column * 128
atlas_y = breed_row * 128
```

Column blocks:

- 0-3: Up
- 4-7: Right
- 8-11: Down
- 12-15: Left

Left-facing art is hand-generated; it is not a mirrored runtime fallback.

## Breed order, appearance, and character

| Atlas row | Breed-sheet file | Appearance | Character direction |
|---:|---|---|---|
| 0 | `00-cockapoo.png` | All white, rounded curly scallops, floppy ears, small body, curled tail; pink tongue in all face-visible frames | Bubbly optimist; bright eyes, tongue-out smile, extra-bouncy walk |
| 1 | `01-labrador-black.png` | All black, smooth short coat, broad muzzle, floppy ears, straight tail | Lovable confident goofball; eager eyes and enthusiastic gait |
| 2 | `02-irish-wolfhound.png` | Wiry medium grey, subtle beard/brows, rose ears, long legs, lean body | Bashful gentle giant; kind eyes and careful high steps |
| 3 | `03-aussie-brindle.png` | Brindle brown, sharp perky ears, fluffy chest, plumed tail | Clever mischief-maker; alert ears and springy trot |
| 4 | `04-aussie-black-white.png` | Black with stable white blaze, chest, paws, and tail tip; perky ears | Bright overachiever; focused happy expression and purposeful trot |
| 5 | `05-labradoodle-cream.png` | **Cream**, loose curls, floppy ears, broad Lab-like muzzle, sturdy build | Sunny easygoing sweetheart; relaxed grin and rolling happy walk |
| 6 | `06-labradoodle-white.png` | **Pure white**, tight curls, topknot silhouette, long ears, dainty legs, curled tail | Poised playful star; knowing smile and prancing gait |
| 7 | `07-beagle-mix-brown.png` | Warm **caramel/tan and white**: broad centered white blaze, white muzzle/jowls, chest, paws, and tail tip; smooth short coat, long hound ears, low stocky body | Curious nose-first detective; inquisitive brow and determined trot |

The two Labradoodles must remain visually distinct: row 5 is warm cream and sturdy/lab-leaning; row 6 is pure white and elegant/poodle-leaning. The Beagle mix must retain its new caramel-and-white markings; do not revert it to solid brown or add a black tricolor saddle.

All face-visible directions use the same eye grammar: compact dark iris/pupil, a controlled white sclera/catchlight, and clear directional gaze. Keep the eye size breed-appropriate; the goal is the beagle/people expressiveness, not oversized anime eyes.

## Assembly recipe

The breed sheets are already transparent and normalized. A deterministic assembly can use this pseudocode:

```python
from PIL import Image

names = [
    "00-cockapoo.png",
    "01-labrador-black.png",
    "02-irish-wolfhound.png",
    "03-aussie-brindle.png",
    "04-aussie-black-white.png",
    "05-labradoodle-cream.png",
    "06-labradoodle-white.png",
    "07-beagle-mix-brown.png",
]

atlas = Image.new("RGBA", (2048, 1024))
for breed_row, name in enumerate(names):
    sheet = Image.open(name).convert("RGBA")
    assert sheet.size == (1024, 1024)
    for direction in range(4):
        for frame in range(4):
            cell = sheet.crop((
                frame * 256,
                direction * 256,
                (frame + 1) * 256,
                (direction + 1) * 256,
            ))
            cell = cell.resize((128, 128), Image.Resampling.LANCZOS)
            atlas_column = direction * 4 + frame
            atlas.alpha_composite(cell, (atlas_column * 128, breed_row * 128))

atlas.save("dogs-chibi.png", "PNG", optimize=True)
```

When resizing alpha artwork, clear hidden RGB values in fully transparent pixels first if the image library does not use premultiplied-alpha resampling. This prevents chroma colors from bleeding into antialiased edges.

## Non-negotiable game constraints

- Exactly one dog per cell.
- Frame 0 of every direction is neutral standing.
- No collar, tag, harness, leash, clothing, or accessories. Player collars are drawn procedurally.
- No baked-in drop shadow, contact shadow, floor, or reflection. The renderer owns the ground shadow.
- Keep feet near 85% of cell height: about y=109 in a 128 px atlas cell.
- Preserve at least about 6 px transparent margin in every 128 px cell.
- No text, labels, borders, or grid lines.
- Keep breed identity, markings, proportions, outline weight, palette, and face stable across all 16 frames.
- Keep the compact white-and-dark eye construction in Right, Down/front, and Left rows; the Up/back row remains eyeless.
- Keep the Cockapoo tongue in all 12 face-visible cells. In the four Down/front cells it points dog-left/viewer-right.
- Keep the Beagle's broad facial blaze centered and rotate markings anatomically for side and back views.

## Generation prompt pattern

All sheets used `stylized-concept` prompts. The supplied image was labeled as a style reference, and the accepted Cockapoo sheet was then used as the 4 x 4 layout/scale anchor for later breeds.

The shared prompt pattern was:

```text
Create an exact 4 columns by 4 rows sprite sheet (16 sprites total) of one consistent <breed description> for a cute videogame.
Match the reference's rounded chibi/kawaii design language: oversized rounded head, compact bean-like body, stubby legs, bold smooth dark-chocolate outline, clean flat fills, minimal expressive face, readable at 64-70 px.
Rows: Up/back, Right/profile, Down/front, Left/profile.
Columns: neutral standing, step A, bouncy passing step, step B.
Express <personality> through posture, ears, eyes/brows, smile, tail, and gait while keeping the animation usable.
Center one complete dog per cell; paws at about 85% height; generous padding.
No collar, tag, harness, accessories, text, grid, shadow, floor, reflection, watermark, realism, painterly fur, pixel art, or 3D.
```

The original generation used a flat green chroma background. The later eye/tongue/coat edits were returned over a baked near-white checkerboard. `build_dog_atlas.py` removes only neutral border-connected checkerboard pixels, filters disconnected matte fragments per logical cell, preserves enclosed white/cream coat fills, and then plants the actual alpha silhouette on the shared baseline. The delivered breed sheets and atlas already contain final transparency; no background-removal step is needed for normal assembly.

For a portable rebuild from the packaged breed sheets only:

```text
python art/chibi-dogs/build_dog_atlas.py --assemble-only --promote
```

Without `--assemble-only`, the script is a historical normalization path and expects the accepted raw ImageGen edit files in the local Codex generated-images directory. The normalized `breed-sheets` folder is the portable source of truth.

## QA performed

- Atlas mode and size checked: RGBA, 2048 x 1024.
- Every breed sheet checked: RGBA, 1024 x 1024.
- All 128 atlas cells checked as non-empty.
- Cell horizontal margins checked at approximately 6 px or greater.
- Paw baseline checked at approximately y=109 in each 128 px cell.
- Brindle Aussie Down/front frames explicitly checked for a shared baseline with a maximum one-pixel antialias variance.
- Transparent atlas corners checked.
- Visible chroma-green, checkerboard, and disconnected matte residue removed.
- Final atlas reviewed over a dark opaque background to verify white, cream, black, grey, brindle, and brown silhouettes.
- Cockapoo tongue visibility/direction and Beagle caramel-and-white marking consistency visually reviewed at sheet and atlas scale.

## Integration

`public/sprites.js` loads `/art/dogs-chibi.png` by default and retains the procedural dog renderer behind the `?art=drawn` fallback. The atlas row order and direction/frame column mapping in this document are therefore runtime contracts. `public/art/dogs.png` remains untouched.
