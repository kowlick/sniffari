"""Normalize the accepted people sheets and assemble the runtime atlas.

The generated sources are 4 columns x 3 rows on a green chroma background.
This script removes chroma, plants every logical sprite on a common foot line,
and emits both reusable 256x512-cell sheets and a 128x256-cell runtime atlas.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = Path(
    r"C:\Users\Daniel Chan\.codex\generated_images\019fde68-7477-74b0-b5e0-5b850bf243c4"
)
CHROMA_HELPER = Path(
    r"C:\Users\Daniel Chan\.codex\skills\.system\imagegen\scripts\remove_chroma_key.py"
)
TMP_DIR = ROOT / "tmp" / "imagegen" / "chibi-people"
SHEET_DIR = ROOT / "art" / "chibi-entities" / "people-sheets"
ATLAS_PATH = ROOT / "public" / "art" / "people-chibi.png"
PREVIEW_PATH = ROOT / "art" / "chibi-entities" / "people-preview.jpg"

SOURCES = [
    ("00-kid.png", "exec-ecd16420-3dd6-4fc7-bb80-a09d026fadb5.png"),
    ("01-jogger.png", "exec-99d6758b-a1d1-4abc-8e86-59b12e606790.png"),
    ("02-older-neighbor.png", "exec-c0d6d85a-84b6-421e-9f27-cfcf212b258a.png"),
    ("03-barista.png", "exec-ff22aa97-75ae-4875-a5cb-b508dd2dab23.png"),
    ("04-skateboarder.png", "exec-5c6301e8-46cd-4874-8a02-7e55f146ddc7.png"),
    ("05-parent-pram.png", "exec-63fdc7ea-1283-4983-96c0-a3cf73b8350a.png"),
    ("06-cyclist.png", "exec-806a8a90-b7c8-4619-b914-87e3f646e219.png"),
    ("07-picnicker.png", "exec-5ce156b5-f08b-4be4-9d53-81e435638950.png"),
]

SOURCE_COLUMNS = 4
SOURCE_ROWS = 3
SHEET_CELL = (256, 512)
ATLAS_CELL = (128, 256)
MAX_VISIBLE = (232, 424)
SHEET_FOOT_Y = 436
ALPHA_THRESHOLD = 32


def split_bounds(size: int, parts: int) -> list[int]:
    """Return balanced integer boundaries with half-up rounding."""
    return [(index * size + parts // 2) // parts for index in range(parts + 1)]


def sanitize_alpha(image: Image.Image) -> Image.Image:
    """Clear hidden RGB and any surviving green-screen pixels."""
    image = image.convert("RGBA")
    pixels = bytearray(image.tobytes())
    for offset in range(0, len(pixels), 4):
        red, green, blue, alpha = pixels[offset : offset + 4]
        chroma_green = (
            alpha > 0
            and green > 80
            and green * 4 > red * 5
            and green * 4 > blue * 5
        )
        if alpha == 0 or chroma_green:
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
    ]
    subprocess.run(command, check=True)


def normalize_sheet(source: Path, output: Path) -> None:
    chroma_path = TMP_DIR / "alpha" / source.name
    remove_chroma(source, chroma_path)
    image = sanitize_alpha(Image.open(chroma_path))
    x_bounds = split_bounds(image.width, SOURCE_COLUMNS)
    y_bounds = split_bounds(image.height, SOURCE_ROWS)

    result = Image.new(
        "RGBA", (SHEET_CELL[0] * SOURCE_COLUMNS, SHEET_CELL[1] * SOURCE_ROWS)
    )

    for state in range(SOURCE_ROWS):
        crops: list[Image.Image] = []
        dimensions: list[tuple[int, int]] = []
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
                raise ValueError(f"Empty source cell: {source.name} state={state} frame={frame}")
            crop = cell.crop(expanded_bbox(bbox, cell.size))
            crops.append(crop)
            dimensions.append(crop.size)

        scale = min(
            MAX_VISIBLE[0] / max(width for width, _ in dimensions),
            MAX_VISIBLE[1] / max(height for _, height in dimensions),
        )

        for frame, crop in enumerate(crops):
            width = max(1, round(crop.width * scale))
            height = max(1, round(crop.height * scale))
            sprite = sanitize_alpha(crop).resize(
                (width, height), Image.Resampling.LANCZOS
            )
            sprite = sanitize_alpha(sprite)
            x = frame * SHEET_CELL[0] + (SHEET_CELL[0] - width) // 2
            y = state * SHEET_CELL[1] + SHEET_FOOT_Y - height + 1
            result.alpha_composite(sprite, (x, y))

    output.parent.mkdir(parents=True, exist_ok=True)
    sanitize_alpha(result).save(output, "PNG", optimize=True)


def build_atlas() -> None:
    atlas = Image.new("RGBA", (ATLAS_CELL[0] * 12, ATLAS_CELL[1] * len(SOURCES)))
    for cast_row, (output_name, _) in enumerate(SOURCES):
        sheet = Image.open(SHEET_DIR / output_name).convert("RGBA")
        if sheet.size != (1024, 1536):
            raise ValueError(f"Unexpected sheet size for {output_name}: {sheet.size}")
        for state in range(3):
            for frame in range(4):
                cell = sheet.crop(
                    (
                        frame * 256,
                        state * 512,
                        (frame + 1) * 256,
                        (state + 1) * 512,
                    )
                )
                cell = sanitize_alpha(cell).resize(ATLAS_CELL, Image.Resampling.LANCZOS)
                cell = sanitize_alpha(cell)
                atlas_column = state * 4 + frame
                atlas.alpha_composite(cell, (atlas_column * 128, cast_row * 256))
    ATLAS_PATH.parent.mkdir(parents=True, exist_ok=True)
    sanitize_alpha(atlas).save(ATLAS_PATH, "PNG", optimize=True)

    background = Image.new("RGB", atlas.size, (49, 42, 58))
    background.paste(atlas, mask=atlas.getchannel("A"))
    background.resize((768, 1024), Image.Resampling.LANCZOS).save(
        PREVIEW_PATH, "JPEG", quality=94, optimize=True
    )


def validate() -> None:
    for output_name, _ in SOURCES:
        sheet = Image.open(SHEET_DIR / output_name).convert("RGBA")
        assert sheet.size == (1024, 1536)
        for state in range(3):
            for frame in range(4):
                cell = sheet.crop(
                    (
                        frame * 256,
                        state * 512,
                        (frame + 1) * 256,
                        (state + 1) * 512,
                    )
                )
                bbox = visible_bbox(cell)
                assert bbox is not None
                assert bbox[0] >= 6 and bbox[2] <= 250, (output_name, state, frame, bbox)
                assert bbox[3] <= SHEET_FOOT_Y + 2, (output_name, state, frame, bbox)

    atlas = Image.open(ATLAS_PATH).convert("RGBA")
    assert atlas.size == (1536, 2048)
    assert atlas.getpixel((0, 0))[3] == 0
    for row in range(8):
        for column in range(12):
            cell = atlas.crop((column * 128, row * 256, (column + 1) * 128, (row + 1) * 256))
            assert visible_bbox(cell) is not None, (row, column)

    digest = hashlib.sha256(ATLAS_PATH.read_bytes()).hexdigest().upper()
    print(f"people atlas: {ATLAS_PATH}")
    print(f"size/mode: {atlas.size} {atlas.mode}")
    print(f"sha256: {digest}")


def main() -> None:
    for output_name, source_name in SOURCES:
        source = SOURCE_ROOT / source_name
        if not source.is_file():
            raise FileNotFoundError(source)
        normalize_sheet(source, SHEET_DIR / output_name)
    build_atlas()
    validate()


if __name__ == "__main__":
    main()
