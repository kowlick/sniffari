# Animated board-entity sprite handoff

## Deliverables

The remaining highest-priority pickup and stopping-point art from `art/ENTITIES.md` is
packaged and wired into gameplay:

- Runtime atlas: `public/art/entities-chibi.png`
- Runtime QA preview: `art/chibi-entities/entities-preview.jpg`
- Reusable normalized sheets: `art/chibi-entities/entity-sheets/*.png`
- Deterministic normalization/assembly script: `art/chibi-entities/build_entity_atlas.py`

Runtime atlas SHA-256:

```text
77F1FAB3CE6B4ADCA955B94772EAE98748A78512983B775D8390797EBD5D1C7C
```

## Runtime atlas grammar

`entities-chibi.png` is a transparent **2048 × 1280 RGBA PNG**, arranged as **16 columns ×
5 rows** of **128 × 256 px** cells. Every cell uses `anchor: "foot"` and `footRatio: 0.85`.
Flat entities occupy the lower portion of the tall transparent cell; tall props can overhang
the tile above without a separate drawing path.

| Atlas row | Entity | Columns 0–3 | 4–7 | 8–11 | 12–15 |
|---:|---|---|---|---|---|
| 0 | Fire hydrant | fresh idle | sniffed once | spent | reaction |
| 1 | Lamppost | fresh flicker | sniffed once | spent/dim | reaction |
| 2 | Bush | fresh sway | sniffed once | spent | reaction |
| 3 | Squirrel tree | idle | chase 1–4 | chase 5–8 | gone/settling |
| 4 | Stops/effects | lake ripple | lake splash | drain idle | drain reaction |

Within every four-column block, `column = block * 4 + frame`. Sniff-spot row selection is
deterministic from the map coordinate, matching the old procedural hydrant/lamppost/bush
selection.

Recommended/runtime timing:

- Sniff idle: 5 fps loop
- Sniff reaction: four frames over 520 ms, once
- Squirrel idle: 6 fps loop
- Squirrel chase + gone: 1,500 ms total, once per squirrel stop event
- Lake ripple: 4 fps loop; splash is four frames over 520 ms
- Drain: 2 fps loop; reaction is four frames over 620 ms

The simulation's squirrel is not consumed, so the tree returns to its idle squirrel after
the reaction rather than remaining empty. This preserves the existing rules when multiple
dogs reach the same jackpot.

## Normalized sheet grammar

Each checked-in sheet is a transparent **1024 × 2048 RGBA PNG** with a **4 × 4** grid of
**256 × 512 px** logical cells. Source rows map directly to the four column blocks in the
runtime row. The builder flattens `(source_row, frame)` into `atlas_column` and downsamples
each cell by 50%.

The builder uses one uniform scale and crop alignment for all frames of a persistent prop.
The combined lake/drain sheet scales per source row. A median persistent-object ground line
keeps the prop still while detached leaves, droplets and motion marks pass around or below
it.

## Rebuilding

Running the builder without generated chroma sources rebuilds the runtime atlas from the
checked-in normalized sheets:

```text
python art/chibi-entities/build_entity_atlas.py
```

When all five ignored source files exist under `tmp/imagegen/chibi-entities`, the same
command first removes their chroma backgrounds and regenerates the normalized sheets. The
expected source names are declared in the script.

## Frame registration

`drawCell` in `public/atlas.js` centres the **cell** on the tile, never the art inside it.
So wherever a prop sits within its 128 px cell is exactly where it lands on the board, and
any difference between the frames of a loop is rendered as the prop sliding around its
tile. The first build of this atlas shipped with exactly that — a lamppost drifting 51 px
(about 21 px on screen) and a hydrant drifting 23 px, monotonically with the frame index
and identically across all four state blocks, which is a crop grid that does not line up
with the art rather than anything intentional in the drawing.

`build_atlas` now finishes by calling `align_group` from `art/align_frames.py`, which
shifts each frame horizontally so the object's *base* lands in the same place. The base
rather than the whole bounding box, because a leaf burst or a splash widens the bounding
box without the object having moved. Vertical position is deliberately untouched; it
measured 0–1 px throughout.

## QA contract

- Every normalized sheet is RGBA, 1024 × 2048.
- The runtime atlas is RGBA, 2048 × 1280.
- All 80 runtime cells are non-empty.
- Art remains within its logical cell with transparent corners.
- Persistent props do not jitter when particles detach.
- **Every object's base drifts ≤ 2 px across all sixteen of its frames.** `validate()`
  asserts this and prints the measured drift per object; it currently runs 0.5–0.9 px.
- No chroma-key fringe, baked floor, label, logo or watermark remains.
