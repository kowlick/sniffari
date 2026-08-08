"""Normalize accepted ImageGen dog edits and assemble the runtime atlas.

ImageGen exported the edited sheets over a baked near-white checkerboard. The
cleanup below removes only checkerboard pixels connected to the image border,
which preserves enclosed white and cream coat fills. Each logical sprite is
then planted on one shared foot baseline before atlas assembly.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[2]
GENERATED = Path(
    r"C:\Users\Daniel Chan\.codex\generated_images\019fde68-7477-74b0-b5e0-5b850bf243c4"
)
STAGE = ROOT / "tmp" / "imagegen" / "chibi-dogs"
STAGE_SHEETS = STAGE / "breed-sheets"
FINAL_SHEETS = ROOT / "art" / "chibi-dogs" / "breed-sheets"
FINAL_ATLAS = ROOT / "public" / "art" / "dogs-chibi.png"
FINAL_PREVIEW = ROOT / "art" / "chibi-dogs" / "atlas-preview.jpg"
BEAGLE_REFERENCE = Path(
    r"C:\Users\DANIEL~1\AppData\Local\Temp\codex-clipboard-bdb08178-11e7-4369-9045-e1b27802c33c.png"
)
FINAL_BEAGLE_REFERENCE = ROOT / "art" / "chibi-dogs" / "beagle-color-reference.png"

SOURCES = [
    ("00-cockapoo.png", "exec-33d4d3d0-23fc-4f89-9d0c-9102a5e4c45e.png"),
    ("01-labrador-black.png", "exec-103638e2-2595-420e-9102-0278eefc2956.png"),
    ("02-irish-wolfhound.png", "exec-4da57dcc-44e4-4346-8b5b-9796dfd1f714.png"),
    ("03-aussie-brindle.png", "exec-5b085928-9644-4b13-857f-4501b9d635de.png"),
    ("04-aussie-black-white.png", "exec-6c808a01-5fda-4d21-b597-4656cb17216f.png"),
    ("05-labradoodle-cream.png", "exec-2a1a8864-1f07-4cd7-aaa2-2a76df5e67db.png"),
    ("06-labradoodle-white.png", "exec-882abd9a-ae01-4a77-a082-b470e702ca74.png"),
    ("07-beagle-mix-brown.png", "exec-bff43632-4341-418c-83fd-fcc6299e303d.png"),
]

CELL = 256
ATLAS_CELL = 128
MAX_VISIBLE = (232, 205)
FOOT_Y = 218
ALPHA_THRESHOLD = 32


def split_bounds(size: int, parts: int = 4) -> list[int]:
    return [(index * size + parts // 2) // parts for index in range(parts + 1)]


def sanitize_alpha(image: Image.Image) -> Image.Image:
    image = image.convert("RGBA")
    pixels = bytearray(image.tobytes())
    for offset in range(0, len(pixels), 4):
        if pixels[offset + 3] == 0:
            pixels[offset : offset + 4] = b"\x00\x00\x00\x00"
    return Image.frombytes("RGBA", image.size, bytes(pixels))


def remove_checkerboard(image: Image.Image) -> Image.Image:
    """Remove the border-connected neutral near-white checkerboard safely."""
    rgb = image.convert("RGB")
    candidates = bytearray(rgb.width * rgb.height)
    for index, (red, green, blue) in enumerate(rgb.get_flattened_data()):
        candidates[index] = (
            255
            if min(red, green, blue) >= 190
            and max(red, green, blue) - min(red, green, blue) <= 22
            else 0
        )

    connected = Image.frombytes("L", rgb.size, bytes(candidates))
    if connected.getpixel((0, 0)) != 255:
        raise ValueError("Top-left pixel is not checkerboard background")
    ImageDraw.floodfill(connected, (0, 0), 128, thresh=0)

    alpha = connected.point(lambda value: 0 if value == 128 else 255)
    # Contract one source pixel to discard the light antialias halo left by the
    # baked preview, then restore a subpixel-soft edge for later downsampling.
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(
        ImageFilter.GaussianBlur(0.65)
    )
    result = rgb.convert("RGBA")
    result.putalpha(alpha)
    return sanitize_alpha(result)


def visible_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    alpha = image.getchannel("A").point(
        lambda value: 255 if value >= ALPHA_THRESHOLD else 0
    )
    return alpha.getbbox()


def keep_largest_component(image: Image.Image) -> Image.Image:
    """Discard disconnected checker-matte flecks inside one logical cell."""
    image = image.convert("RGBA")
    alpha = image.getchannel("A")
    width, height = image.size
    visible = bytes(
        1 if value >= ALPHA_THRESHOLD else 0
        for value in alpha.get_flattened_data()
    )
    visited = bytearray(width * height)
    largest: list[int] = []

    for start, is_visible in enumerate(visible):
        if not is_visible or visited[start]:
            continue
        component: list[int] = []
        queue: deque[int] = deque([start])
        visited[start] = 1
        while queue:
            index = queue.popleft()
            component.append(index)
            x = index % width
            y = index // width
            if x > 0:
                neighbor = index - 1
                if visible[neighbor] and not visited[neighbor]:
                    visited[neighbor] = 1
                    queue.append(neighbor)
            if x + 1 < width:
                neighbor = index + 1
                if visible[neighbor] and not visited[neighbor]:
                    visited[neighbor] = 1
                    queue.append(neighbor)
            if y > 0:
                neighbor = index - width
                if visible[neighbor] and not visited[neighbor]:
                    visited[neighbor] = 1
                    queue.append(neighbor)
            if y + 1 < height:
                neighbor = index + width
                if visible[neighbor] and not visited[neighbor]:
                    visited[neighbor] = 1
                    queue.append(neighbor)
        if len(component) > len(largest):
            largest = component

    if not largest:
        return Image.new("RGBA", image.size)
    keep = bytearray(width * height)
    for index in largest:
        keep[index] = 255
    keep_mask = Image.frombytes("L", image.size, bytes(keep)).filter(
        ImageFilter.MaxFilter(3)
    )
    clean_alpha = Image.composite(alpha, Image.new("L", image.size), keep_mask)
    image.putalpha(clean_alpha)
    return sanitize_alpha(image)


def expanded_bbox(
    bbox: tuple[int, int, int, int], size: tuple[int, int], padding: int = 2
) -> tuple[int, int, int, int]:
    left, top, right, bottom = bbox
    return (
        max(0, left - padding),
        max(0, top - padding),
        min(size[0], right + padding),
        min(size[1], bottom + padding),
    )


def normalize_sheet(source: Path, output: Path) -> None:
    image = remove_checkerboard(Image.open(source))
    x_bounds = split_bounds(image.width)
    y_bounds = split_bounds(image.height)
    crops: list[list[Image.Image]] = []
    dimensions: list[tuple[int, int]] = []

    for direction in range(4):
        row: list[Image.Image] = []
        for frame in range(4):
            cell = image.crop(
                (
                    x_bounds[frame],
                    y_bounds[direction],
                    x_bounds[frame + 1],
                    y_bounds[direction + 1],
                )
            )
            cell = keep_largest_component(cell)
            bbox = visible_bbox(cell)
            if bbox is None:
                raise ValueError(
                    f"Empty generated cell: {source.name} direction={direction} frame={frame}"
                )
            crop = cell.crop(expanded_bbox(bbox, cell.size))
            row.append(crop)
            dimensions.append(crop.size)
        crops.append(row)

    scale = min(
        MAX_VISIBLE[0] / max(width for width, _ in dimensions),
        MAX_VISIBLE[1] / max(height for _, height in dimensions),
    )
    result = Image.new("RGBA", (1024, 1024))
    for direction in range(4):
        for frame in range(4):
            crop = crops[direction][frame]
            width = max(1, round(crop.width * scale))
            height = max(1, round(crop.height * scale))
            sprite = sanitize_alpha(crop).resize(
                (width, height), Image.Resampling.LANCZOS
            )
            sprite = sanitize_alpha(sprite)
            sprite_bbox = visible_bbox(sprite)
            if sprite_bbox is None:
                raise ValueError(
                    f"Empty normalized cell: {source.name} direction={direction} frame={frame}"
                )
            visible_width = sprite_bbox[2] - sprite_bbox[0]
            x = (
                frame * CELL
                + (CELL - visible_width) // 2
                - sprite_bbox[0]
            )
            y = direction * CELL + FOOT_Y - (sprite_bbox[3] - 1)
            result.alpha_composite(sprite, (x, y))

    output.parent.mkdir(parents=True, exist_ok=True)
    sanitize_alpha(result).save(output, "PNG", optimize=True)


def build_atlas(sheet_dir: Path, atlas_path: Path, preview_path: Path) -> None:
    atlas = Image.new("RGBA", (2048, 1024))
    for breed_row, (name, _) in enumerate(SOURCES):
        sheet = Image.open(sheet_dir / name).convert("RGBA")
        if sheet.size != (1024, 1024):
            raise ValueError(f"Unexpected sheet size for {name}: {sheet.size}")
        for direction in range(4):
            for frame in range(4):
                cell = sheet.crop(
                    (
                        frame * CELL,
                        direction * CELL,
                        (frame + 1) * CELL,
                        (direction + 1) * CELL,
                    )
                )
                cell = sanitize_alpha(cell).resize(
                    (ATLAS_CELL, ATLAS_CELL), Image.Resampling.LANCZOS
                )
                cell = sanitize_alpha(cell)
                atlas_column = direction * 4 + frame
                atlas.alpha_composite(
                    cell, (atlas_column * ATLAS_CELL, breed_row * ATLAS_CELL)
                )

    atlas_path.parent.mkdir(parents=True, exist_ok=True)
    sanitize_alpha(atlas).save(atlas_path, "PNG", optimize=True)
    background = Image.new("RGB", atlas.size, (49, 42, 58))
    background.paste(atlas, mask=atlas.getchannel("A"))
    background.resize((1024, 512), Image.Resampling.LANCZOS).save(
        preview_path, "JPEG", quality=94, optimize=True
    )


def validate(sheet_dir: Path, atlas_path: Path) -> str:
    for name, _ in SOURCES:
        sheet = Image.open(sheet_dir / name).convert("RGBA")
        assert sheet.size == (1024, 1024)
        for direction in range(4):
            for frame in range(4):
                cell = sheet.crop(
                    (
                        frame * CELL,
                        direction * CELL,
                        (frame + 1) * CELL,
                        (direction + 1) * CELL,
                    )
                )
                bbox = visible_bbox(cell)
                assert bbox is not None, (name, direction, frame)
                assert bbox[0] >= 6 and bbox[2] <= 250, (name, direction, frame, bbox)
                assert FOOT_Y - 1 <= bbox[3] - 1 <= FOOT_Y + 1, (
                    name,
                    direction,
                    frame,
                    bbox,
                )

    # Explicit regression check for the reported floating front-view Aussie.
    brindle = Image.open(sheet_dir / "03-aussie-brindle.png").convert("RGBA")
    front_bottoms = []
    for frame in range(4):
        cell = brindle.crop((frame * 256, 512, (frame + 1) * 256, 768))
        bbox = visible_bbox(cell)
        assert bbox is not None
        front_bottoms.append(bbox[3] - 1)
    assert max(front_bottoms) - min(front_bottoms) <= 1, front_bottoms
    assert all(FOOT_Y - 1 <= value <= FOOT_Y + 1 for value in front_bottoms)

    atlas = Image.open(atlas_path).convert("RGBA")
    assert atlas.size == (2048, 1024)
    assert atlas.getpixel((0, 0))[3] == 0
    for row in range(8):
        for column in range(16):
            cell = atlas.crop(
                (
                    column * ATLAS_CELL,
                    row * ATLAS_CELL,
                    (column + 1) * ATLAS_CELL,
                    (row + 1) * ATLAS_CELL,
                )
            )
            assert visible_bbox(cell) is not None, (row, column)
    return hashlib.sha256(atlas_path.read_bytes()).hexdigest().upper()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--promote",
        action="store_true",
        help="Copy the staged sheets/atlas/preview into their runtime locations.",
    )
    parser.add_argument(
        "--assemble-only",
        action="store_true",
        help="Rebuild from the packaged normalized breed sheets without ImageGen sources.",
    )
    args = parser.parse_args()

    if args.assemble_only:
        assembly_sheets = FINAL_SHEETS
    else:
        for output_name, source_name in SOURCES:
            source = GENERATED / source_name
            if not source.is_file():
                raise FileNotFoundError(source)
            normalize_sheet(source, STAGE_SHEETS / output_name)
        assembly_sheets = STAGE_SHEETS

    stage_atlas = STAGE / "dogs-chibi.png"
    stage_preview = STAGE / "atlas-preview.jpg"
    build_atlas(assembly_sheets, stage_atlas, stage_preview)
    digest = validate(assembly_sheets, stage_atlas)
    print(f"staged atlas sha256: {digest}")

    if args.promote:
        if not args.assemble_only:
            FINAL_SHEETS.mkdir(parents=True, exist_ok=True)
            for name, _ in SOURCES:
                shutil.copy2(STAGE_SHEETS / name, FINAL_SHEETS / name)
        shutil.copy2(stage_atlas, FINAL_ATLAS)
        shutil.copy2(stage_preview, FINAL_PREVIEW)
        if BEAGLE_REFERENCE.is_file():
            shutil.copy2(BEAGLE_REFERENCE, FINAL_BEAGLE_REFERENCE)
        final_digest = validate(FINAL_SHEETS, FINAL_ATLAS)
        print(f"promoted atlas sha256: {final_digest}")


if __name__ == "__main__":
    main()
