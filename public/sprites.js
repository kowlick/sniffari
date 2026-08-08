// All the artwork, drawn procedurally in a normalised [-0.5, 0.5] tile space so it scales
// to any board size without assets.
//
// Art direction: chunky chibi. Thick dark outlines, flat fills, big rounded shapes, cream
// muzzles and paws, tiny expressive faces. Dogs are drawn in a 3/4 Zelda-ish view rather
// than from directly above — see drawDog.

import { drawCell, loadSheet, measureCells } from './atlas.js';

const hash = (x, y) => ((x * 73856093) ^ (y * 19349663)) >>> 0;

// --- dog atlas ------------------------------------------------------------------------
// 16 columns x 8 rows of 128px cells. Column = direction * 4 + frame, row = breed, in the
// order of DOGS in protocol.ts. See art/chibi-dogs/HANDOFF.md.
export const DOG_CELL = 128;
const DOG_SHEET_URL = '/art/dogs-chibi.png';
export const PEOPLE_CELL_WIDTH = 128;
export const PEOPLE_CELL_HEIGHT = 256;
const PEOPLE_COUNT = 8;
const PEOPLE_SHEET_URL = '/art/people-chibi.png';
/**
 * A walk cycle from the four supplied poses: step A, passing, step B, passing. Frame 0 is
 * the neutral stand and is reserved for dogs that are not moving.
 */
const WALK_FRAMES = [1, 2, 3, 2];

// ?art=drawn forces the procedural sprites, for comparing the two.
const useAtlas = new URLSearchParams(location.search).get('art') !== 'drawn';
export const dogSheet = useAtlas ? loadSheet(DOG_SHEET_URL) : { ready: false, failed: true };
export const peopleSheet = useAtlas ? loadSheet(PEOPLE_SHEET_URL) : { ready: false, failed: true };

/**
 * Per-cell bounding boxes and per-breed average figure height, measured from the sheet.
 *
 * The renderer needs both. A breed's *intended* relative size lives in `scale`, but the art
 * has its own incidental variation — the two Aussie Shepherds are specified identically yet
 * one is drawn 5% taller in its front frame with its feet 1.5% lower in the cell. Scaling by
 * `scale` on top of that compounds the two errors, so instead every cell is normalised
 * against its breed's measured height and anchored on its own measured foot line.
 */
let metrics = null;
function dogMetrics() {
  if (metrics || !dogSheet.ready) return metrics;
  const cells = measureCells(dogSheet, DOG_CELL, 16, 8);
  if (!cells) return null;
  const byRow = new Map();
  for (const c of cells) {
    if (c.empty) continue;
    if (!byRow.has(c.row)) byRow.set(c.row, []);
    byRow.get(c.row).push(c);
  }
  const avgHeight = [];
  for (const [row, list] of byRow) {
    avgHeight[row] = list.reduce((a, c) => a + c.height, 0) / list.length;
  }
  metrics = { cell: (row, col) => cells[row * 16 + col], avgHeight };
  return metrics;
}

export const CREAM = '#fdf2df';
const INK = '#3b2a1e';

/** Run fn in a space where the tile is 1 unit wide and centred on the origin. */
function inTile(ctx, px, py, s, fn) {
  ctx.save();
  ctx.translate(px + s / 2, py + s / 2);
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  fn();
  ctx.restore();
}

/** Filled shape with the thick outline that defines the whole look. */
function ink(ctx, fill, w, path, stroke = INK) {
  ctx.beginPath();
  path();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (w > 0) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = w;
    ctx.stroke();
  }
}

const circlePath = (ctx, x, y, r) => ctx.arc(x, y, r, 0, Math.PI * 2);
const ellipsePath = (ctx, x, y, rx, ry, rot = 0) => ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
const roundPath = (ctx, x, y, w, h, r) => ctx.roundRect(x - w / 2, y - h / 2, w, h, r);

const dot = (ctx, x, y, r, fill) => {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
};

/**
 * The wordmark, drawn rather than set in a font — the game ships no font files, and this
 * way the title carries the same chunky outline as everything else on the board. Letters
 * bounce along an arc and tilt alternately, which is what makes it read as chibi rather
 * than just bold.
 */
export function drawWordmark(canvas, text = 'Sniffari', h = 34) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const ctx = canvas.getContext('2d');
  const font = `900 ${h}px "Arial Rounded MT Bold", "Nunito", system-ui, sans-serif`;

  ctx.font = font;
  const widths = [...text].map((c) => ctx.measureText(c).width);
  const spacing = h * 0.04;
  const w = widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1) + h * 0.5;
  const boxH = h * 1.7;

  // Only the backing store is sized here. Display size is left to CSS so the header can
  // shrink the wordmark on a narrow screen; the canvas keeps its aspect ratio.
  canvas.width = Math.ceil(w * dpr);
  canvas.height = Math.ceil(boxH * dpr);

  ctx.scale(dpr, dpr);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  let x = h * 0.25;
  [...text].forEach((ch, i) => {
    const t = i / Math.max(1, text.length - 1);
    const bounce = Math.sin(t * Math.PI) * h * 0.13; // arc up through the middle
    const tilt = (i % 2 ? 1 : -1) * 0.055;
    ctx.save();
    ctx.translate(x + widths[i] / 2, boxH / 2 - bounce);
    ctx.rotate(tilt);
    // Outline first, then fill, then a highlight across the top — the sticker look.
    ctx.strokeStyle = '#2a1a0c';
    ctx.lineWidth = h * 0.28;
    ctx.strokeText(ch, 0, 0);
    ctx.fillStyle = '#f0a63d';
    ctx.fillText(ch, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(-h, -h, h * 2, h * 0.62);
    ctx.clip();
    ctx.fillStyle = '#ffd98a';
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    ctx.restore();
    x += widths[i] + spacing;
  });
}

/** Perceived brightness, 0..1. */
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** Lighten (t > 0) or darken (t < 0) a #rrggbb colour. */
function shade(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.round(t > 0 ? v + (255 - v) * t : v * (1 + t)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// --- terrain ---------------------------------------------------------------------------

export const GROUND = { street: '#4b515b', park: '#3c7a52', water: '#2277b8' };

export function drawGround(ctx, ch, px, py, s, x, y) {
  const h = hash(x, y);
  if (ch === '~') {
    ctx.fillStyle = GROUND.water;
    ctx.fillRect(px, py, s, s);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = Math.max(1.5, s * 0.055);
    ctx.lineCap = 'round';
    for (let i = 0; i < 2; i++) {
      const cy = py + s * (0.36 + i * 0.28);
      ctx.beginPath();
      ctx.arc(px + s * (0.5 + (i ? 0.1 : -0.08)), cy + s * 0.25, s * 0.22, Math.PI * 1.2, Math.PI * 1.8);
      ctx.stroke();
    }
    return;
  }

  const park = ch === ',';
  ctx.fillStyle = park ? GROUND.park : GROUND.street;
  ctx.fillRect(px, py, s, s);

  if (park) {
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = Math.max(1.2, s * 0.055);
    for (let i = 0; i < 3; i++) {
      const gx = px + s * (0.2 + ((h >> (i * 4)) % 7) * 0.09);
      const gy = py + s * (0.32 + ((h >> (i * 3 + 2)) % 6) * 0.09);
      ctx.beginPath();
      ctx.moveTo(gx, gy + s * 0.09);
      ctx.lineTo(gx + s * 0.035, gy);
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(
        px + s * (0.12 + ((h >> (i * 5)) % 9) * 0.09),
        py + s * (0.12 + ((h >> (i * 4 + 1)) % 9) * 0.09),
        s * 0.06,
        s * 0.06,
      );
    }
  }
}

export function drawBuilding(ctx, px, py, s, x, y, edges) {
  const h = hash(x, y);
  ctx.fillStyle = edges.border ? '#242932' : ['#39404c', '#333a46', '#3e4552'][h % 3];
  ctx.fillRect(px, py, s, s);

  if (edges.n) {
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    ctx.fillRect(px, py, s, s * 0.12);
  }
  if (edges.s) {
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(px, py + s * 0.88, s, s * 0.12);
  }
  if (edges.border) return;

  const lit = (h >> 3) % 4 !== 0;
  const w = s * 0.17;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      if ((h >> (i * 2 + j + 5)) % 5 === 0) continue;
      const wx = px + s * (0.23 + i * 0.36);
      const wy = py + s * (0.25 + j * 0.33);
      ctx.fillStyle = lit ? '#ffd98a' : 'rgba(160,180,205,0.2)';
      ctx.beginPath();
      ctx.roundRect(wx, wy, w, w, s * 0.03);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = Math.max(1, s * 0.025);
      ctx.stroke();
    }
  }
}

export function drawFence(ctx, px, py, s, vertical) {
  ctx.save();
  ctx.translate(px + s / 2, py + s / 2);
  if (vertical) ctx.rotate(Math.PI / 2);
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  const W = 0.05;
  ink(ctx, '#a8794f', W, () => {
    roundPath(ctx, 0, -0.15, 1.0, 0.13, 0.05);
  });
  ink(ctx, '#a8794f', W, () => {
    roundPath(ctx, 0, 0.08, 1.0, 0.13, 0.05);
  });
  for (const px2 of [-0.34, 0.34]) {
    ink(ctx, '#8a6039', W, () => {
      roundPath(ctx, px2, -0.02, 0.15, 0.66, 0.05);
    });
  }
  ctx.restore();
}

// --- pickups and stopping points -----------------------------------------------------------

export function drawSniff(ctx, px, py, s, x, y, spent) {
  const kind = hash(x, y) % 3;
  inTile(ctx, px, py, s, () => {
    ctx.globalAlpha = spent ? 0.4 : 1;
    const W = 0.05;
    if (kind === 0) {
      // Fire hydrant.
      ink(ctx, '#e8503a', W, () => roundPath(ctx, 0, 0.06, 0.4, 0.12, 0.05)); // nozzles
      ink(ctx, '#e8503a', W, () => roundPath(ctx, 0, 0.06, 0.26, 0.34, 0.09)); // body
      ink(ctx, '#f4705c', W, () => roundPath(ctx, 0, -0.13, 0.3, 0.16, 0.07)); // cap
      ink(ctx, '#c33f2c', W, () => roundPath(ctx, 0, 0.24, 0.36, 0.1, 0.04)); // base
    } else if (kind === 1) {
      // Lamppost with a warm pool of light.
      dot(ctx, 0, -0.14, 0.24, 'rgba(255,214,130,0.22)');
      ink(ctx, '#3a3f49', W, () => roundPath(ctx, 0, 0.13, 0.11, 0.42, 0.05));
      ink(ctx, '#3a3f49', W, () => roundPath(ctx, 0, 0.3, 0.32, 0.1, 0.04));
      ink(ctx, '#ffd98a', W, () => roundPath(ctx, 0, -0.16, 0.26, 0.24, 0.09));
    } else {
      // Bush.
      ink(ctx, '#4b9a5e', W, () => {
        circlePath(ctx, -0.13, 0.08, 0.15);
      });
      ink(ctx, '#4b9a5e', W, () => {
        circlePath(ctx, 0.13, 0.08, 0.15);
      });
      ink(ctx, '#5cb070', W, () => {
        circlePath(ctx, 0, -0.06, 0.18);
      });
      dot(ctx, -0.05, -0.11, 0.05, 'rgba(255,255,255,0.4)');
    }
    ctx.globalAlpha = 1;
  });
}

export function drawPerson(ctx, px, py, s, x, y, state = 'idle', frame = 0) {
  const stateIndex = { idle: 0, giving: 1, given: 2 }[state] ?? 0;
  const column = stateIndex * 4 + (Math.floor(frame) % 4 + 4) % 4;
  const row = hash(x, y) % PEOPLE_COUNT;
  if (
    drawCell(
      ctx,
      peopleSheet,
      {
        sx: column * PEOPLE_CELL_WIDTH,
        sy: row * PEOPLE_CELL_HEIGHT,
        sw: PEOPLE_CELL_WIDTH,
        sh: PEOPLE_CELL_HEIGHT,
      },
      px,
      py,
      s,
      { anchor: 'foot', footRatio: 0.85 },
    )
  )
    return;

  // Procedural fallback for ?art=drawn and for a failed atlas request.
  const shirt = ['#e8628f', '#4f9fd8', '#f0a63d'][hash(x, y) % 3];
  inTile(ctx, px, py, s, () => {
    ctx.globalAlpha = state === 'given' ? 0.4 : 1;
    const W = 0.05;
    ink(ctx, shirt, W, () => roundPath(ctx, 0, 0.14, 0.3, 0.3, 0.1)); // body
    ink(ctx, '#f0c49a', W, () => circlePath(ctx, 0, -0.16, 0.19)); // head
    ink(ctx, '#4a3a2e', W, () => {
      // hair
      ctx.arc(0, -0.17, 0.19, Math.PI * 1.05, Math.PI * 1.95);
      ctx.closePath();
    });
    // The treat bag, which is the bit that says "come here".
    ink(ctx, '#d9932f', W, () => roundPath(ctx, 0.22, 0.14, 0.18, 0.2, 0.05));
    dot(ctx, -0.07, -0.12, 0.028, INK);
    dot(ctx, 0.07, -0.12, 0.028, INK);
    ctx.globalAlpha = 1;
  });
}

export function drawSquirrel(ctx, px, py, s) {
  inTile(ctx, px, py, s, () => {
    const W = 0.05;
    ink(ctx, '#8a5f3c', W, () => roundPath(ctx, 0, 0.16, 0.16, 0.34, 0.05)); // trunk
    // Canopy is a deeper green than park grass, or the biggest prize on the board
    // disappears into the lawn it stands on.
    ink(ctx, '#2b7a45', W, () => circlePath(ctx, -0.16, -0.06, 0.19));
    ink(ctx, '#2b7a45', W, () => circlePath(ctx, 0.16, -0.06, 0.19));
    ink(ctx, '#359352', W, () => circlePath(ctx, 0, -0.22, 0.21));
    // Squirrel, tail first.
    ink(ctx, '#c9773a', W * 0.8, () => {
      ctx.moveTo(0.14, 0.16);
      ctx.quadraticCurveTo(0.38, 0.08, 0.27, -0.14);
      ctx.quadraticCurveTo(0.24, 0.04, 0.12, 0.08);
      ctx.closePath();
    });
    ink(ctx, '#d9884a', W * 0.8, () => ellipsePath(ctx, 0.09, 0.09, 0.08, 0.1));
    ink(ctx, '#d9884a', W * 0.8, () => circlePath(ctx, 0.05, -0.02, 0.07));
    dot(ctx, 0.03, -0.03, 0.022, INK);
  });
}

export function drawDrain(ctx, px, py, s) {
  inTile(ctx, px, py, s, () => {
    const W = 0.05;
    ink(ctx, '#4a515c', W, () => roundPath(ctx, 0, 0, 0.66, 0.44, 0.07));
    ctx.fillStyle = '#171b21';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.roundRect(-0.24, i * 0.13 - 0.045, 0.48, 0.09, 0.03);
      ctx.fill();
    }
  });
}

// --- placed tiles -----------------------------------------------------------------------------

const ARROW_ROT = { N: 0, E: 90, S: 180, W: 270 };

export function drawPlacedTile(ctx, kind, px, py, s, color, alpha = 1) {
  inTile(ctx, px, py, s, () => {
    ctx.globalAlpha = alpha;
    const W = 0.05;

    if (kind === 'X') {
      ink(ctx, '#8d857a', W, () => roundPath(ctx, 0, 0, 0.86, 0.86, 0.1));
      ctx.strokeStyle = INK;
      ctx.lineWidth = 0.1;
      for (const d of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(-0.21 * d, -0.21);
        ctx.lineTo(0.21 * d, 0.21);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      return;
    }

    // A chalk pad so the arrow reads over grass, asphalt or a pickup.
    ink(ctx, shade(color, 0.55), W, () => roundPath(ctx, 0, 0, 0.86, 0.86, 0.1));

    if (kind === 'J') {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 0.07;
      ctx.setLineDash([0.09, 0.07]);
      ctx.beginPath();
      ctx.arc(0, 0.2, 0.28, Math.PI, 0);
      ctx.stroke();
      ctx.setLineDash([]);
      // Paw print at the apex.
      ink(ctx, color, 0.035, () => ellipsePath(ctx, 0, -0.09, 0.085, 0.07));
      for (const dx of [-0.1, -0.035, 0.035, 0.1]) ink(ctx, color, 0.03, () => circlePath(ctx, dx, -0.21, 0.032));
      ctx.globalAlpha = 1;
      return;
    }

    ctx.rotate((ARROW_ROT[kind] * Math.PI) / 180);
    ink(ctx, color, W, () => {
      ctx.moveTo(0, -0.3);
      ctx.lineTo(0.24, -0.03);
      ctx.lineTo(0.1, -0.03);
      ctx.lineTo(0.1, 0.27);
      ctx.lineTo(-0.1, 0.27);
      ctx.lineTo(-0.1, -0.03);
      ctx.lineTo(-0.24, -0.03);
      ctx.closePath();
    });
    ctx.globalAlpha = 1;
  });
}

// --- dogs ---------------------------------------------------------------------------------------

/** How much of a tile a dog fills. Big: this is the thing you track across the board. */
const DOG_SIZE = 1.12;
/** Outline weight. Heavy enough to read at tile size, light enough to leave room for breed
 *  detail — at 0.055 the outlines ate the coat markings and every dog looked the same. */
const W = 0.034;

/**
 * Draw a dog in a 3/4 view rather than from directly overhead.
 *
 *   dir 0 (up)    — seen from behind, tail toward you
 *   dir 1 (right) — side profile
 *   dir 2 (down)  — facing you head-on
 *   dir 3 (left)  — side profile, mirrored
 *
 * Four hand-built poses rather than one rotated sprite: a top-down sprite spun 90 degrees
 * reads as a beetle, and the whole appeal here is that the dogs are cute.
 */
/**
 * Draw a dog from the sprite atlas. Returns false if the sheet is not usable, so callers
 * can fall through to the procedural version.
 */
function drawDogFromAtlas(ctx, px, py, s, o) {
  const { dir = 2, spec = {}, gait = 0, moving = false, lift = 0 } = o;
  const row = spec.atlasRow;
  if (!dogSheet.ready || row === undefined) return false;

  const frame = moving ? WALK_FRAMES[Math.floor(gait * WALK_FRAMES.length) % WALK_FRAMES.length] : 0;
  const col = dir * 4 + frame;
  const m = dogMetrics();
  const cell = m?.cell(row, col);

  return drawCell(
    ctx,
    dogSheet,
    { sx: col * DOG_CELL, sy: row * DOG_CELL, sw: DOG_CELL, sh: DOG_CELL },
    px,
    py,
    s,
    {
      // Growing with the lift sells the jump as coming toward the camera rather than
      // just sliding upward.
      scale: atlasScale(row, spec, m) * (1 + lift * JUMP_ZOOM),
      lift,
      anchor: 'foot',
      // Each cell is anchored on its own foot line, not a global constant, so every dog
      // plants on its ring no matter how the artist framed that pose.
      footRatio: cell?.bottom ?? ATLAS_FOOT_RATIO,
    },
  );
}

/**
 * How tall a dog is drawn, as a fraction of tile height, before its breed multiplier.
 * The board version is a little over one tile; much larger and eight dogs on the small
 * board become an unreadable pile.
 */
const ATLAS_FIGURE_HEIGHT = 0.92;
const ATLAS_FOOT_RATIO = 0.85;
/** How much bigger a dog gets at the top of a jump — it is coming toward the camera. */
const JUMP_ZOOM = 0.5;

/**
 * Cell scale that makes a breed render at `ATLAS_FIGURE_HEIGHT * spec.scale` tiles tall,
 * regardless of how large the artist happened to draw it inside its cell. Without this,
 * `scale` double-counts against the art's own size variation.
 */
function atlasScale(row, spec, m) {
  const target = ATLAS_FIGURE_HEIGHT * (spec.scale ?? 1);
  const artHeight = m?.avgHeight[row];
  return artHeight ? target / artHeight : target / 0.74;
}

/**
 * A standing portrait for the lobby picker, framed to its own box rather than to a tile.
 *
 * The board anchoring deliberately draws a dog larger than its tile and standing above it,
 * which is right on the map and wrong in a 52px button — it ran the heads off the top. Here
 * the dog is sized to the box and planted near the bottom, and breed scale is preserved so
 * the wolfhound really is the tallest. It may overhang the top of its box; the button is
 * not allowed to clip it.
 */
export function drawDogPortrait(ctx, w, h, { spec = {}, color = '#c88', dir = 2 } = {}) {
  const scale = spec.scale ?? 1;
  const footY = h * 0.94;
  const row = spec.atlasRow;
  if (dogSheet.ready && row !== undefined) {
    const col = dir * 4;
    const m = dogMetrics();
    const cell = m?.cell(row, col);
    // Normalise against *this frame's* height, not the breed average: the portrait always
    // shows the front pose, and a raised tail there would otherwise make one breed look
    // bigger than an identically specified sibling.
    const figure = cell?.height ?? 0.74;
    const size = (h * 0.7 * scale) / figure;
    ctx.drawImage(
      dogSheet.img,
      col * DOG_CELL,
      row * DOG_CELL,
      DOG_CELL,
      DOG_CELL,
      (w - size) / 2,
      footY - (cell?.bottom ?? ATLAS_FOOT_RATIO) * size,
      size,
      size,
    );
    return;
  }
  // Procedural fallback: hand it a virtual tile sized so the dog lands in the same place.
  const tile = h * 0.72;
  drawDog(ctx, (w - tile) / 2, footY - tile * 0.8, tile, { dir, color, spec, gait: 0, moving: false });
}

export function drawDog(ctx, px, py, s, o) {
  const { dir = 2, color = '#c88', spec = {}, gait = 0, moving = false, stopped = null, lift = 0 } = o;
  const scale = (spec.scale ?? 1) * DOG_SIZE;
  // `color` is the player's identity colour and is worn as a collar; the coat is its own.
  const fur = spec.fur ?? color;
  // A darker outline is invisible on a black dog, so very dark coats get a lighter rim.
  const veryDark = luminance(fur) < 0.16;
  // Just enough rim to hold the silhouette. Any lighter and a black lab reads as grey.
  const line = veryDark ? shade(fur, 0.26) : shade(fur, -0.5);
  const swing = moving ? Math.sin(gait * Math.PI * 2) : 0;
  const wag = Math.sin(gait * Math.PI * (moving ? 4 : 1.4)) * (moving ? 0.45 : 0.2);
  const bob = moving ? Math.abs(Math.cos(gait * Math.PI * 2)) * 0.022 : 0;

  // Shadow stays on the ground while a jumping dog rises above it. The renderer owns this
  // for both art paths — the atlas deliberately ships without baked shadows.
  ctx.save();
  ctx.translate(px + s / 2, py + s / 2);
  ctx.scale(s, s);
  ctx.fillStyle = `rgba(0,0,0,${0.3 - lift * 0.18})`;
  ctx.beginPath();
  ctx.ellipse(0, 0.3, 0.24 * scale * (1 - lift * 0.25), 0.075 * scale * (1 - lift * 0.25), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (drawDogFromAtlas(ctx, px, py, s, o)) return;

  ctx.save();
  ctx.translate(px + s / 2, py + s / 2 - lift * s);
  const zoom = s * scale * (1 + lift * JUMP_ZOOM);
  ctx.scale(zoom, zoom);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (dir === 3) ctx.scale(-1, 1); // left is right, mirrored
  ctx.translate(0, -bob);

  const C = {
    color: fur,
    accent: color,
    line,
    veryDark,
    muzzle: spec.muzzle ?? CREAM,
    paws: spec.paws ?? CREAM,
    spec,
    swing,
    wag,
    stopped,
    // Breed proportions: a wolfhound is tall and lean, a beagle low and stocky.
    bw: spec.bw ?? 1,
    bh: spec.bh ?? 1,
    leg: spec.leg ?? 1,
  };
  if (dir === 2) dogFront(ctx, C);
  else if (dir === 0) dogBack(ctx, C);
  else dogSide(ctx, C);

  ctx.restore();
}

/** The player's identity colour, worn where you can see it from across the room. */
function collar(ctx, C, x, y, w) {
  ink(ctx, C.accent, W * 0.9, () => roundPath(ctx, x, y, w, 0.075, 0.035), shade(C.accent, -0.5));
  ink(ctx, '#ffd45e', W * 0.6, () => circlePath(ctx, x, y + 0.055, 0.032), '#8a6a1e'); // tag
}

/** Ears. `side` draws the single visible ear of a profile view. */
function ears(ctx, C, pose) {
  const { line, spec } = C;
  const style = spec.ear ?? 'floppy';
  const shell = shade(C.color, -0.22);
  const draw = (x, flip) => {
    ctx.save();
    ctx.scale(flip, 1);
    if (style === 'perky') {
      ink(ctx, shell, W, () => {
        ctx.moveTo(x - 0.02, -0.2);
        ctx.quadraticCurveTo(x + 0.03, -0.42, x + 0.15, -0.33);
        ctx.quadraticCurveTo(x + 0.14, -0.18, x - 0.02, -0.2);
        ctx.closePath();
      }, line);
    } else {
      const len = style === 'long' ? 0.24 : 0.17;
      ink(ctx, shell, W, () => ctx.ellipse(x + 0.06, -0.16 + len * 0.35, 0.085, len, 0.18, 0, Math.PI * 2), line);
    }
    ctx.restore();
  };
  if (pose === 'side') draw(0.02, 1);
  else {
    draw(0.13, 1);
    draw(0.13, -1);
  }
}

/** Body markings that are not the universal cream underside. */
function markings(ctx, C, w, h, cx, cy) {
  const { spec } = C;
  if (!spec.patch) return;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - h / 2, w, h, Math.min(w, h) * 0.42);
  ctx.clip();
  ctx.fillStyle = spec.patch;
  if (spec.patchStyle === 'brindle') {
    for (let i = -4; i <= 4; i++) ctx.fillRect(cx + i * 0.075, cy - h, 0.028, h * 2);
  } else {
    ctx.beginPath();
    ctx.ellipse(cx - w * 0.22, cy + h * 0.1, w * 0.24, h * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function coat(ctx, C, pts) {
  if (C.spec.furStyle === 'curly') {
    ctx.fillStyle = shade(C.color, 0.24);
    for (const [x, y] of pts) {
      ctx.beginPath();
      ctx.arc(x, y, 0.048, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (C.spec.furStyle === 'wire') {
    ctx.strokeStyle = shade(C.color, 0.24);
    ctx.lineWidth = 0.022;
    for (const [x, y] of pts) {
      ctx.beginPath();
      ctx.moveTo(x, y - 0.03);
      ctx.lineTo(x + 0.03, y + 0.04);
      ctx.stroke();
    }
  }
}

function face(ctx, C, cx, cy, wide) {
  const { line, stopped, veryDark } = C;
  // On a very dark coat, ink-on-ink details vanish — the features are drawn in the lighter
  // rim colour instead, and the eyes get a pale backing so they read at all.
  const detail = veryDark ? line : INK;

  ink(ctx, C.muzzle, W, () => ctx.ellipse(cx, cy + 0.11, wide ? 0.17 : 0.13, 0.11, 0, 0, Math.PI * 2), line);
  ink(ctx, veryDark ? shade(C.color, 0.28) : INK, veryDark ? W * 0.7 : 0, () =>
    ctx.ellipse(cx, cy + 0.055, 0.055, 0.042, 0, 0, Math.PI * 2), line);
  ctx.strokeStyle = detail;
  ctx.lineWidth = 0.028;
  ctx.beginPath(); // little smile
  ctx.arc(cx - 0.045, cy + 0.11, 0.045, 0, Math.PI * 0.85);
  ctx.moveTo(cx + 0.09, cy + 0.11);
  ctx.arc(cx + 0.045, cy + 0.11, 0.045, Math.PI * 0.15, Math.PI);
  ctx.stroke();

  const ex = wide ? 0.115 : 0.075;
  for (const d of wide ? [-1, 1] : [1]) {
    if (stopped) {
      ctx.strokeStyle = detail;
      ctx.lineWidth = 0.032;
      ctx.beginPath();
      ctx.arc(cx + d * ex, cy - 0.06, 0.05, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    } else {
      if (veryDark) dot(ctx, cx + d * ex, cy - 0.06, 0.055, '#efeae0');
      dot(ctx, cx + d * ex, cy - 0.06, 0.042, INK);
      dot(ctx, cx + d * ex + 0.016, cy - 0.075, 0.016, '#fff');
    }
  }
  // Blush.
  ctx.fillStyle = 'rgba(255,140,140,0.3)';
  for (const d of wide ? [-1, 1] : [1]) {
    ctx.beginPath();
    ctx.ellipse(cx + d * (ex + 0.1), cy + 0.045, 0.055, 0.035, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function dogFront(ctx, C) {
  const { color, line, swing, bw, bh, leg } = C;
  const bodyW = 0.46 * bw;
  const bodyH = 0.36 * bh;
  const footY = 0.3 + (leg - 1) * 0.06;

  ctx.save();
  ctx.translate(0.2, 0.2);
  ctx.rotate(C.wag * 0.5);
  ink(ctx, shade(color, -0.12), W, () => ellipsePath(ctx, 0.08, 0, 0.1, 0.07), line);
  ctx.restore();

  ink(ctx, color, W, () => roundPath(ctx, 0, 0.14, bodyW, bodyH, 0.16), line);
  markings(ctx, C, bodyW, bodyH, 0, 0.14);
  coat(ctx, C, [
    [-bodyW * 0.4, 0.06],
    [-bodyW * 0.3, 0.24],
    [bodyW * 0.34, 0.06],
    [bodyW * 0.42, 0.24],
  ]);
  ink(ctx, C.paws, W, () => roundPath(ctx, 0, 0.22, 0.22 * bw, 0.2, 0.09), line); // chest

  for (const d of [-1, 1]) {
    ink(ctx, C.paws, W, () =>
      roundPath(ctx, d * 0.14 * bw, footY + d * swing * 0.022, 0.15, 0.12 * leg, 0.055), line);
  }

  ears(ctx, C, 'front');
  ink(ctx, color, W, () => circlePath(ctx, 0, -0.14, 0.26), line);
  face(ctx, C, 0, -0.14, true);
  // After the head: drawn before it, the skull paints straight over the collar.
  collar(ctx, C, 0, 0.09, 0.3 * bw);
}

function dogBack(ctx, C) {
  const { color, line, swing, bw, bh, leg } = C;
  const bodyW = 0.46 * bw;
  const bodyH = 0.36 * bh;
  const footY = 0.3 + (leg - 1) * 0.06;

  ink(ctx, color, W, () => roundPath(ctx, 0, 0.14, bodyW, bodyH, 0.16), line);
  markings(ctx, C, bodyW, bodyH, 0, 0.14);
  coat(ctx, C, [
    [-bodyW * 0.4, 0.06],
    [-bodyW * 0.3, 0.24],
    [bodyW * 0.34, 0.06],
    [bodyW * 0.42, 0.24],
  ]);
  for (const d of [-1, 1]) {
    ink(ctx, C.paws, W, () =>
      roundPath(ctx, d * 0.14 * bw, footY - d * swing * 0.022, 0.15, 0.12 * leg, 0.055), line);
  }

  ears(ctx, C, 'front');
  ink(ctx, color, W, () => circlePath(ctx, 0, -0.14, 0.24), line); // back of the head
  collar(ctx, C, 0, 0.08, 0.28 * bw);

  // The tail is the star of the back view and the main thing distinguishing it from the
  // front, so it is drawn last and set off to the side — centred behind the head it was
  // completely hidden.
  ctx.save();
  ctx.translate(0.23, 0.04);
  ctx.rotate(C.wag * 0.6);
  ink(ctx, shade(color, -0.15), W, () => {
    ctx.moveTo(-0.05, 0.1);
    ctx.quadraticCurveTo(-0.02, -0.18, 0.14, -0.22);
    ctx.quadraticCurveTo(0.24, -0.19, 0.19, -0.09);
    ctx.quadraticCurveTo(0.1, -0.11, 0.09, 0.09);
    ctx.closePath();
  }, line);
  ctx.restore();
}

function dogSide(ctx, C) {
  const { color, line, swing, bw, bh, leg } = C;
  const bodyW = 0.5 * bw;
  const bodyH = 0.32 * bh;
  const legH = 0.16 * leg;
  const footY = 0.28 + legH * 0.35;

  // Far legs first, so the near pair reads in front of the body.
  for (const lx of [-0.21, 0.09]) {
    ink(ctx, shade(color, -0.3), W, () =>
      roundPath(ctx, lx - swing * 0.075, footY, 0.11, legH, 0.05), line);
  }

  // Tail.
  ctx.save();
  ctx.translate(-0.26, 0.02);
  ctx.rotate(C.wag * 0.7);
  ink(ctx, shade(color, -0.12), W, () => {
    ctx.moveTo(0.06, 0.08);
    ctx.quadraticCurveTo(-0.2, 0.04, -0.12, -0.16);
    ctx.quadraticCurveTo(-0.04, -0.06, 0.08, -0.04);
    ctx.closePath();
  }, line);
  ctx.restore();

  ink(ctx, color, W, () => roundPath(ctx, -0.06, 0.12, bodyW, bodyH, 0.15), line); // body
  markings(ctx, C, bodyW, bodyH, -0.06, 0.12);
  coat(ctx, C, [
    [-bodyW * 0.48, 0.02],
    [-bodyW * 0.2, -0.01],
    [bodyW * 0.08, 0.02],
    [-bodyW * 0.36, 0.22],
  ]);
  // A chest patch at the front, not a full-width underside stripe — a light bar spanning
  // the whole belly plus four pale paws makes the dog read as a bench on wheels.
  ink(ctx, C.paws, W * 0.8, () => roundPath(ctx, 0.09, 0.18, 0.18, 0.13, 0.06), line);

  // Near legs, well clear of the underside and swinging further so the trot reads.
  for (const lx of [-0.17, 0.15]) {
    ink(ctx, C.paws, W, () => roundPath(ctx, lx + swing * 0.075, footY + 0.02, 0.12, legH, 0.055), line);
  }

  ears(ctx, C, 'side');
  ink(ctx, color, W, () => circlePath(ctx, 0.22, -0.12, 0.23), line); // head
  face(ctx, C, 0.28, -0.12, false);
  // Seen edge-on the collar is a band round the neck, drawn over the head's near edge.
  ink(ctx, C.accent, W * 0.9, () => roundPath(ctx, 0.05, 0.04, 0.1, 0.24, 0.045), shade(C.accent, -0.5));
  ink(ctx, '#ffd45e', W * 0.6, () => circlePath(ctx, 0.05, 0.17, 0.035), '#8a6a1e');
}

/** Stamina ring / stopped halo, in screen space so it never rotates with the dog. */
export function drawDogStatus(ctx, px, py, s, { stamina, maxStamina, stopped, scale = 1, accent }) {
  // A ring on the ground at the dog's feet, not a circle around the tile. These sprites
  // stand *above* their tile centre, so a tile-centred ring reads as sitting behind the
  // dog rather than belonging to it.
  const cx = px + s / 2;
  const cy = py + s * 0.8;
  const rx = s * 0.42 * Math.max(1, scale);
  const ry = rx * 0.4;
  const ring = (a0, a1) => {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, a0, a1);
    ctx.stroke();
  };

  // A pool of the player's colour. The atlas art carries no collar, so this and the ring
  // are what tell eight people which dog is theirs.
  if (accent) {
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 0.82, ry * 0.82, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.lineWidth = Math.max(2, s * 0.05);
  if (stopped) {
    ctx.strokeStyle = accent ?? 'rgba(255,255,255,0.7)';
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([s * 0.09, s * 0.07]);
    ring(0, Math.PI * 2);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    return;
  }
  const frac = Math.max(0, Math.min(1, stamina / maxStamina));
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ring(0, Math.PI * 2);
  ctx.strokeStyle = frac > 0.25 ? (accent ?? '#fff') : '#ff8787';
  ring(-Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
}
