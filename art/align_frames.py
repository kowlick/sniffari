"""
Frame registration for the sprite atlases.

The bug this exists to prevent
------------------------------
`drawCell` in public/atlas.js centres the *whole cell* on the tile. It never looks at
where the art sits inside that cell. So wherever a prop is drawn within its 128px cell is
exactly where it lands on screen, and any difference between the frames of an animation
loop is rendered faithfully as the prop sliding around the tile.

The generated sheets had exactly that. Measured on the first entity atlas:

    lamppost   frame centre-x  89.5 -> 72.5 -> 57.5 -> 38.5   (51px, ~21px on screen)
    hydrant    frame centre-x  76.0 -> 70.0 -> 64.0 -> 53.0   (23px)
    bush, squirrel tree, lake, drain                          (1-3px)

The drift was identical at a given frame index across all four state blocks of a row,
which is the signature of a crop grid that does not line up with the art rather than of
anything intentional in the drawing.

How it is fixed
---------------
Every frame of one object is shifted horizontally so that the object's *base* sits in the
same place. The base, not the whole bounding box: a leaf burst, a splash or a swinging arm
widens the bounding box without the object having moved, and centring on that would make
the prop lurch to counterbalance its own particles. The base band is measured in absolute
cell coordinates from the group's median ground line, so a frame that happens to be
shorter (a spent hydrant, a settling tree) is still measured across the same strip.

Vertical position is left alone deliberately. It measured 0-1px of drift everywhere, and
the few cells that differ do so because the art differs - correcting those would flatten
real animation.
"""

from __future__ import annotations

from statistics import median

from PIL import Image

# Opacity below this is antialiasing fringe, not art. Matches measureCells in atlas.js.
ALPHA_FLOOR = 12

# Which horizontal strip of the object is treated as "the part that must not move", as a
# fraction of the object's height measured up from its ground line.
#
# The base, for everything on the board. It is the contact patch, and it is the one part a
# leaf burst, a splash or a swinging arm cannot drag sideways. This works for the people
# too: nobody on this board walks anywhere - they stand on their tile and their four frames
# are an idle bob - so their feet are planted and are a valid anchor.
BASE_BAND = (0.0, 0.18)


def _cell_box(px, ox, oy, cw, ch):
    """Bounding box of the opaque pixels of one cell, in cell-local coordinates."""
    min_x, max_x, min_y, max_y = cw, -1, ch, -1
    for y in range(ch):
        for x in range(cw):
            if px[ox + x, oy + y][3] < ALPHA_FLOOR:
                continue
            if x < min_x:
                min_x = x
            if x > max_x:
                max_x = x
            if y < min_y:
                min_y = y
            if y > max_y:
                max_y = y
    if max_x < 0:
        return None
    return min_x, min_y, max_x + 1, max_y + 1


def _base_centre(px, ox, oy, cw, band_top, band_bottom, box):
    """
    Alpha-weighted mean x of the object's base band.

    Falls back to the plain bounding-box centre for a frame with nothing in the band, which
    is the best available guess and only happens for cells that are almost empty anyway.
    """
    total = 0.0
    weighted = 0.0
    for y in range(max(0, band_top), band_bottom):
        for x in range(cw):
            a = px[ox + x, oy + y][3]
            if a < ALPHA_FLOOR:
                continue
            total += a
            weighted += a * x
    if total == 0:
        return (box[0] + box[2]) / 2
    return weighted / total


def align_group(img, columns, row, cw, ch, band=BASE_BAND, label="", verbose=True, apply=True):
    """
    Register one animated object in place.

    `columns` is every column of the atlas that shows the same object - all four state
    blocks of a row, not just one block, because a hydrant must not jump when it becomes
    spent either.

    Pass `apply=False` to measure without touching the image.
    """
    px = img.load()
    oy = row * ch

    boxes = {}
    for c in columns:
        box = _cell_box(px, c * cw, oy, cw, ch)
        if box is not None:
            boxes[c] = box
    if len(boxes) < 2:
        return 0

    ground = median([b[3] for b in boxes.values()])
    height = median([b[3] - b[1] for b in boxes.values()])
    band_top = int(round(ground - band[1] * height))
    band_bottom = int(round(ground - band[0] * height))

    centres = {}
    for c, box in boxes.items():
        centres[c] = _base_centre(px, c * cw, oy, cw, band_top, band_bottom, box)

    target = median(centres.values())

    moved = 0
    for c, centre in centres.items():
        shift = int(round(target - centre))
        if shift == 0:
            continue
        # Never push art out of its own cell; a clipped prop is worse than a misplaced one.
        box = boxes[c]
        shift = max(-box[0], min(cw - box[2], shift))
        if shift == 0 or not apply:
            continue
        region = img.crop((c * cw, oy, (c + 1) * cw, oy + ch))
        blank = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        blank.paste(region, (shift, 0))
        img.paste(blank, (c * cw, oy))
        px = img.load()
        moved += 1
        if verbose:
            print(f"    col {c:2d}: shifted {shift:+3d}px")

    if verbose:
        spread = max(centres.values()) - min(centres.values())
        print(f"  {label or f'row {row}'}: base-centre spread was {spread:5.1f}px, {moved} cell(s) moved")
    return moved


def group_spread(img, columns, row, cw, ch, band=BASE_BAND):
    """
    How far the object's base wanders across its frames, in atlas pixels.

    This is the number to assert on in a build's QA pass: anything more than a pixel or two
    is visible on the board as the prop sliding around its tile.
    """
    px = img.load()
    oy = row * ch
    boxes = {}
    for c in columns:
        box = _cell_box(px, c * cw, oy, cw, ch)
        if box is not None:
            boxes[c] = box
    if len(boxes) < 2:
        return 0.0
    ground = median([b[3] for b in boxes.values()])
    height = median([b[3] - b[1] for b in boxes.values()])
    band_top = int(round(ground - band[1] * height))
    band_bottom = int(round(ground - band[0] * height))
    centres = [
        _base_centre(px, c * cw, oy, cw, band_top, band_bottom, box) for c, box in boxes.items()
    ]
    return max(centres) - min(centres)


def whole_row(row, cols, label):
    return (row, list(range(cols)), label)


def align_atlas(path, groups, cw, ch, band=BASE_BAND, verbose=True, apply=True):
    """`groups` is a list of (row, columns, label)."""
    img = Image.open(path).convert("RGBA")
    if verbose:
        print(f"\n{path}  ({img.width}x{img.height}){'' if apply else '   [measure only]'}")
    total = 0
    for row, columns, label in groups:
        total += align_group(img, columns, row, cw, ch, band=band, label=label, verbose=verbose, apply=apply)
    if apply:
        img.save(path)
    if verbose:
        print(f"  -> {total} cell(s) {'moved, saved' if apply else 'would move'}")
    return total


# --- the shipped atlases -------------------------------------------------------------

CELL_W = 128
CELL_H = 256

# entities-chibi.png: 16 columns x 5 rows. One object per row, except the last, which
# carries the lake in its first two blocks and the storm drain in its last two.
ENTITY_GROUPS = [
    whole_row(0, 16, "hydrant"),
    whole_row(1, 16, "lamppost"),
    whole_row(2, 16, "bush"),
    whole_row(3, 16, "squirrel tree"),
    (4, list(range(0, 8)), "lake"),
    (4, list(range(8, 16)), "storm drain"),
]

# people-chibi.png: 12 columns x 8 rows - three state blocks (idle, giving, given), one
# person per row.
PEOPLE_GROUPS = [whole_row(r, 12, f"person {r}") for r in range(8)]


if __name__ == "__main__":
    import os

    here = os.path.dirname(os.path.abspath(__file__))
    art = os.path.join(here, "..", "public", "art")
    align_atlas(os.path.join(art, "entities-chibi.png"), ENTITY_GROUPS, CELL_W, CELL_H)
    align_atlas(os.path.join(art, "people-chibi.png"), PEOPLE_GROUPS, CELL_W, CELL_H)
