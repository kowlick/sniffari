// Sprite-sheet loading and anchored cell drawing.
//
// The anchoring is the only interesting part. A tile is a square of side `s`, but sprites
// are not squares of side `s`: a dog is drawn larger than its tile and stands on it, and a
// tall prop (a tree, a lamppost) occupies its tile but towers over the one behind. Both are
// expressed as "which point of the cell lands on which point of the tile".

/**
 * Start loading a sheet. Returns immediately with a handle whose `ready` flips to true when
 * the image is usable; callers fall back to procedural art until then, and permanently if
 * the file is missing.
 */
export function loadSheet(url) {
  const handle = { img: new Image(), ready: false, failed: false, url };
  handle.img.onload = () => {
    handle.ready = handle.img.naturalWidth > 0;
    handle.failed = !handle.ready;
  };
  handle.img.onerror = () => {
    handle.failed = true;
  };
  handle.img.src = url;
  return handle;
}

/** Resolves true once the sheet is usable, false if it failed or did not arrive in time. */
export function whenReady(handle, timeoutMs = 4000) {
  if (handle.ready || handle.failed) return Promise.resolve(handle.ready);
  return new Promise((resolve) => {
    handle.img.addEventListener('load', () => resolve(handle.ready), { once: true });
    handle.img.addEventListener('error', () => resolve(false), { once: true });
    setTimeout(() => resolve(handle.ready), timeoutMs);
  });
}

/**
 * Where the sprite's "ground" sits inside a tile, as a fraction of tile height. Matches the
 * procedural shadow, so atlas dogs and drawn dogs plant their feet in the same place.
 */
export const GROUND_LINE = 0.8;

/**
 * Draw one cell of a sheet onto a tile.
 *
 * `anchor`:
 *   'foot'   — the cell's foot line (a fraction of cell height, `footRatio`) is placed on
 *              the tile's ground line. Used for characters, which are drawn bigger than
 *              their tile and must appear to stand on it.
 *   'bottom' — the cell's bottom edge is placed on the tile's bottom edge and the cell keeps
 *              its aspect ratio. A 128x256 cell therefore covers its own tile and overhangs
 *              exactly one tile upward. Used for tall scenery.
 *   'tile'   — the cell simply fills the tile square.
 */
export function drawCell(ctx, sheet, cell, px, py, s, opts = {}) {
  if (!sheet?.ready) return false;
  const { sx, sy, sw, sh } = cell;
  const { scale = 1, lift = 0, anchor = 'foot', footRatio = 0.85, alpha = 1 } = opts;

  let dw;
  let dh;
  let dx;
  let dy;

  if (anchor === 'bottom') {
    dw = s * scale;
    dh = dw * (sh / sw);
    dx = px + (s - dw) / 2;
    dy = py + s - dh;
  } else if (anchor === 'tile') {
    dw = s * scale;
    dh = dw * (sh / sw);
    dx = px + (s - dw) / 2;
    dy = py + (s - dh) / 2;
  } else {
    dw = s * scale;
    dh = dw * (sh / sw);
    dx = px + s / 2 - dw / 2;
    dy = py + s * GROUND_LINE - footRatio * dh;
  }

  dy -= lift * s;

  const prev = ctx.globalAlpha;
  if (alpha !== 1) ctx.globalAlpha = prev * alpha;
  ctx.drawImage(sheet.img, sx, sy, sw, sh, dx, dy, dw, dh);
  ctx.globalAlpha = prev;
  return true;
}

/**
 * Measure the opaque bounding box of every cell in a sheet, as fractions of cell size.
 *
 * This is not just a QA tool — the renderer uses it. Hand-drawn art has incidental
 * variation in how big each figure is inside its cell and exactly where its feet fall, and
 * scaling by a hard-coded per-breed number on top of that compounds the two. Measuring lets
 * the renderer honour the *intended* relative sizes and put every foot on the ground.
 *
 * Returns null until the sheet is ready. One pass over the whole sheet, not one read per
 * cell — 128 getImageData calls is slow enough to be noticeable at startup.
 */
export function measureCells(sheet, cell, cols, rows) {
  if (!sheet?.ready) return null;
  const w = cols * cell;
  const h = rows * cell;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(sheet.img, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h);

  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      let minX = cell;
      let maxX = -1;
      let minY = cell;
      let maxY = -1;
      for (let y = 0; y < cell; y++) {
        const rowStart = ((r * cell + y) * w + k * cell) * 4;
        for (let x = 0; x < cell; x++) {
          if (data[rowStart + x * 4 + 3] < 12) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      const empty = maxX < 0;
      out.push({
        row: r,
        col: k,
        empty,
        left: minX / cell,
        right: (maxX + 1) / cell,
        top: minY / cell,
        bottom: (maxY + 1) / cell,
        height: empty ? 0 : (maxY + 1 - minY) / cell,
      });
    }
  }
  return out;
}
