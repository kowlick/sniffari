"""Normalize generated entity grids and assemble the runtime entity atlas.

The reusable transparent sheets in ``entity-sheets`` are the source of truth. When all
five ignored chroma sources are present under ``tmp/imagegen/chibi-entities`` this script
also rebuilds those normalized sheets; otherwise it assembles and validates the runtime
atlas directly from the checked-in sheets.
"""

from __future__ import annotations

import hashlib
import statistics
import subprocess
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from align_frames import ENTITY_GROUPS, align_group, group_spread  # noqa: E402


ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = ROOT / "tmp" / "imagegen" / "chibi-entities"
SHEET_DIR = ROOT / "art" / "chibi-entities" / "entity-sheets"
ATLAS_PATH = ROOT / "public" / "art" / "entities-chibi.png"
PREVIEW_PATH = ROOT / "art" / "chibi-entities" / "entities-preview.jpg"
CHROMA_HELPER = (
    Path.home()
    / ".codex"
    / "skills"
    / ".system"
    / "imagegen"
    / "scripts"
    / "remove_chroma_key.py"
)

# Atlas row order is a runtime contract; append rather than reorder.
SOURCES = [
    ("00-hydrant.png", "hydrant-source.png", True),
    ("01-lamppost.png", "lamppost-source.png", True),
    ("02-bush.png", "bush-source.png", True),
    ("03-squirrel-tree.png", "squirrel-source.png", True),
    # This sheet deliberately contains two different subjects, so each source row scales
    # independently: lake idle, lake splash, drain idle, drain reaction.
    ("04-stops.png", "stops-source.png", False),
]

SOURCE_COLUMNS = 4
SOURCE_ROWS = 4
SHEET_CELL = (256, 512)
ATLAS_CELL = (128, 256)
MAX_VISIBLE = (232, 424)
SHEET_FOOT_Y = 436
ALPHA_THRESHOLD = 24


def split_bounds(size: int, parts: int) -> list[int]:
    """Return balanced integer grid boundaries with half-up rounding."""
    return [(index * size + parts // 2) // parts for index in range(parts + 1)]


def sanitize_alpha(image: Image.Image) -> Image.Image:
    """Clear hidden RGB so downsampling cannot pull chroma into transparent edges."""
    image = image.convert("RGBA")
    pixels = bytearray(image.tobytes())
    for offset in range(0, len(pixels), 4):
        if pixels[offset + 3] == 0:
            pixels[offset : offset + 4] = b"\x00\x00\x00\x00"
    return Image.frombytes("RGBA", image.size, bytes(pixels))


def visible_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    alpha = image.getchannel("A").point(
        lambda value: 255 if value >= ALPHA_THRESHOLD else 0
    )
    return alpha.getbbox()


def expanded_bbox(
    bbox: tuple[int, int, int, int], size: tuple[int, int], padding: int = 3
) -> tuple[int, int, int, int]:
    left, top, right, bottom = bbox
    return (
        max(0, left - padding),
        max(0, top - padding),
        min(size[0], right + padding),
        min(size[1], bottom + padding),
    )


def remove_chroma(source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        str(CHROMA_HELPER),
        "--input",
        str(source),
        "--out",
        str(output),
        "--auto-key",
        "border",
        "--soft-matte",
        "--transparent-threshold",
        "12",
        "--opaque-threshold",
        "220",
        "--despill",
        "--force",
    ]
    subprocess.run(command, check=True)


def normalize_sheet(source: Path, output: Path, uniform_sheet_scale: bool) -> None:
    chroma_path = SOURCE_DIR / "alpha" / source.name
    remove_chroma(source, chroma_path)
    image = sanitize_alpha(Image.open(chroma_path))
    x_bounds = split_bounds(image.width, SOURCE_COLUMNS)
    y_bounds = split_bounds(image.height, SOURCE_ROWS)

    rows: list[list[tuple[Image.Image, tuple[int, int, int, int]]]] = []
    for state in range(SOURCE_ROWS):
        row: list[tuple[Image.Image, tuple[int, int, int, int]]] = []
        for frame in range(SOURCE_COLUMNS):
            cell = image.crop(
                (
                    x_bounds[frame],
                    y_bounds[state],
                    x_bounds[frame + 1],
                    y_bounds[state + 1],
                )
            )
            bbox = visible_bbox(cell)
            if bbox is None:
                raise ValueError(
                    f"Empty source cell: {source.name} state={state} frame={frame}"
                )
            row.append((cell, expanded_bbox(bbox, cell.size)))
        rows.append(row)

    def group_metrics(
        cells: list[tuple[Image.Image, tuple[int, int, int, int]]],
    ) -> tuple[tuple[int, int, int, int], float, float]:
        # Every frame in a group is cropped through the same local rectangle. This retains
        # alignment when a falling leaf or drip extends below the prop; cropping each frame
        # to its own alpha bounds made the solid object jump upward as particles fell.
        boxes = [bbox for _, bbox in cells]
        union = (
            min(box[0] for box in boxes),
            min(box[1] for box in boxes),
            max(box[2] for box in boxes),
            max(box[3] for box in boxes),
        )
        width = union[2] - union[0]
        height = union[3] - union[1]
        scale = min(MAX_VISIBLE[0] / width, MAX_VISIBLE[1] / height)
        # The median bottom is the persistent prop's ground line; outlying particles are
        # allowed to pass below it without dragging the prop away from the ground.
        baseline = statistics.median(box[3] for box in boxes)
        return union, scale, baseline

    all_cells = [cell for row in rows for cell in row]
    sheet_metrics = group_metrics(all_cells)
    result = Image.new(
        "RGBA", (SHEET_CELL[0] * SOURCE_COLUMNS, SHEET_CELL[1] * SOURCE_ROWS)
    )
    for state, row in enumerate(rows):
        union, scale, baseline = sheet_metrics if uniform_sheet_scale else group_metrics(row)
        for frame, (cell, _) in enumerate(row):
            crop = cell.crop(union)
            width = max(1, round(crop.width * scale))
            height = max(1, round(crop.height * scale))
            sprite = sanitize_alpha(crop).resize(
                (width, height), Image.Resampling.LANCZOS
            )
            sprite = sanitize_alpha(sprite)
            x = frame * SHEET_CELL[0] + (SHEET_CELL[0] - width) // 2
            baseline_in_crop = (baseline - union[1]) * scale
            y = state * SHEET_CELL[1] + SHEET_FOOT_Y - round(baseline_in_crop)
            result.alpha_composite(sprite, (x, y))

    output.parent.mkdir(parents=True, exist_ok=True)
    sanitize_alpha(result).save(output, "PNG", optimize=True)


def build_atlas() -> None:
    atlas = Image.new(
        "RGBA", (ATLAS_CELL[0] * 16, ATLAS_CELL[1] * len(SOURCES))
    )
    for atlas_row, (sheet_name, _, _) in enumerate(SOURCES):
        sheet = Image.open(SHEET_DIR / sheet_name).convert("RGBA")
        expected = (SHEET_CELL[0] * 4, SHEET_CELL[1] * 4)
        if sheet.size != expected:
            raise ValueError(f"Unexpected sheet size for {sheet_name}: {sheet.size}")
        for state in range(4):
            for frame in range(4):
                cell = sheet.crop(
                    (
                        frame * SHEET_CELL[0],
                        state * SHEET_CELL[1],
                        (frame + 1) * SHEET_CELL[0],
                        (state + 1) * SHEET_CELL[1],
                    )
                )
                cell = sanitize_alpha(cell).resize(
                    ATLAS_CELL, Image.Resampling.LANCZOS
                )
                column = state * 4 + frame
                atlas.alpha_composite(
                    sanitize_alpha(cell),
                    (column * ATLAS_CELL[0], atlas_row * ATLAS_CELL[1]),
                )

    # Register the frames before saving.
    #
    # The crop above walks a rigid grid over the source sheet, so whatever offset the art
    # has inside its source cell is carried straight into the atlas cell - and drawCell in
    # public/atlas.js centres the *cell* on the tile, never the art, so that offset is
    # rendered as the prop sliding around the tile as it animates. The first build shipped
    # a lamppost that slid 51px and a hydrant that slid 23px. See art/align_frames.py.
    atlas = sanitize_alpha(atlas)
    for row, columns, label in ENTITY_GROUPS:
        align_group(atlas, columns, row, ATLAS_CELL[0], ATLAS_CELL[1], label=label)

    ATLAS_PATH.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(ATLAS_PATH, "PNG", optimize=True)

    background = Image.new("RGB", atlas.size, (49, 42, 58))
    background.paste(atlas, mask=atlas.getchannel("A"))
    background.resize((1024, 640), Image.Resampling.LANCZOS).save(
        PREVIEW_PATH, "JPEG", quality=94, optimize=True
    )


def validate() -> None:
    for sheet_name, _, _ in SOURCES:
        sheet = Image.open(SHEET_DIR / sheet_name).convert("RGBA")
        assert sheet.size == (1024, 2048), (sheet_name, sheet.size)
        for state in range(4):
            for frame in range(4):
                cell = sheet.crop(
                    (
                        frame * SHEET_CELL[0],
                        state * SHEET_CELL[1],
                        (frame + 1) * SHEET_CELL[0],
                        (state + 1) * SHEET_CELL[1],
                    )
                )
                bbox = visible_bbox(cell)
                assert bbox is not None, (sheet_name, state, frame)
                assert bbox[0] >= 6 and bbox[2] <= 250, (
                    sheet_name,
                    state,
                    frame,
                    bbox,
                )
                assert bbox[3] <= 500, (
                    sheet_name,
                    state,
                    frame,
                    bbox,
                )

    atlas = Image.open(ATLAS_PATH).convert("RGBA")
    assert atlas.size == (2048, 1280), atlas.size
    assert atlas.getpixel((0, 0))[3] == 0
    for row in range(len(SOURCES)):
        for column in range(16):
            cell = atlas.crop(
                (
                    column * ATLAS_CELL[0],
                    row * ATLAS_CELL[1],
                    (column + 1) * ATLAS_CELL[0],
                    (row + 1) * ATLAS_CELL[1],
                )
            )
            assert visible_bbox(cell) is not None, (row, column)

    # Registration. A prop whose base wanders between frames is drawn sliding around its
    # tile, because drawCell centres the cell and not the art. The first build shipped a
    # lamppost at 51px of drift; a pixel or two is the most that reads as still.
    for row, columns, label in ENTITY_GROUPS:
        spread = group_spread(atlas, columns, row, ATLAS_CELL[0], ATLAS_CELL[1])
        assert spread <= 2.0, f"{label} drifts {spread:.1f}px between frames"
        print(f"registration: {label:14s} {spread:4.1f}px")

    digest = hashlib.sha256(ATLAS_PATH.read_bytes()).hexdigest().upper()
    print(f"entity atlas: {ATLAS_PATH}")
    print(f"size/mode: {atlas.size} {atlas.mode}")
    print(f"sha256: {digest}")


def main() -> None:
    source_paths = [SOURCE_DIR / source_name for _, source_name, _ in SOURCES]
    if all(path.is_file() for path in source_paths):
        for sheet_name, source_name, uniform_sheet_scale in SOURCES:
            normalize_sheet(
                SOURCE_DIR / source_name,
                SHEET_DIR / sheet_name,
                uniform_sheet_scale,
            )
    elif not all((SHEET_DIR / sheet_name).is_file() for sheet_name, _, _ in SOURCES):
        missing = [str(path) for path in source_paths if not path.is_file()]
        raise FileNotFoundError("Missing chroma sources and normalized sheets: " + ", ".join(missing))

    build_atlas()
    validate()


if __name__ == "__main__":
    main()
