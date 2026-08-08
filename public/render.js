// Board rendering. Pure drawing: it never touches the socket and never mutates state.

import {
  drawBuilding,
  drawDog,
  drawDogStatus,
  drawDrain,
  drawFence,
  drawGround,
  drawLake,
  drawPerson,
  drawPlacedTile,
  drawSniff,
  drawSquirrel,
} from './sprites.js';

const WALL = '#';
const key = (x, y) => `${x},${y}`;
const personPhase = (x, y) => ((x * 3 + y * 5) % 4 + 4) % 4;

/** Loop one of four atlas frames without making every entity on the board move in sync. */
function loopFrame(now, fps, x, y) {
  return (Math.floor(now / (1000 / fps)) + personPhase(x, y)) % 4;
}

/** Ground to paint under a wall tile: match a neighbour so fences sit on their surroundings. */
function nearbyGround(map, x, y) {
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
    const ch = map.rows[ny][nx];
    if (ch !== WALL) return ch === ',' ? ',' : '.';
  }
  return '.';
}

export function cellSize(canvas, map) {
  return Math.floor(Math.min(canvas.width / map.width, canvas.height / map.height));
}

/** Screen point -> tile coordinate, or null if outside the board. */
export function cellAt(canvas, map, px, py) {
  const rect = canvas.getBoundingClientRect();
  const s = cellSize(canvas, map);
  const scale = canvas.width / rect.width;
  const x = Math.floor(((px - rect.left) * scale) / s);
  const y = Math.floor(((py - rect.top) * scale) / s);
  return x >= 0 && y >= 0 && x < map.width && y < map.height ? { x, y } : null;
}

export function draw(canvas, view) {
  const ctx = canvas.getContext('2d');
  const { map } = view;
  const s = cellSize(canvas, map);
  const at = (x, y) => (x < 0 || y < 0 || x >= map.width || y >= map.height ? WALL : map.rows[y][x]);
  const solid = (x, y) => at(x, y) === WALL;

  ctx.fillStyle = '#0f1115';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // --- ground everywhere, then walls on top ----------------------------------------------
  // Ground goes under wall tiles too: a fence is see-through, and needs street or grass
  // beneath it rather than the page background.
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const ch = at(x, y);
      drawGround(ctx, ch === WALL ? nearbyGround(map, x, y) : ch, x * s, y * s, s, x, y);
    }
  }
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (!solid(x, y)) continue;
      // A wall with open ground on both opposite sides is a one-tile fence run, not a
      // building — draw it as railings so the two read differently at a glance.
      const thinV = !solid(x - 1, y) && !solid(x + 1, y);
      const thinH = !solid(x, y - 1) && !solid(x, y + 1);
      if (thinV || thinH) drawFence(ctx, x * s, y * s, s, thinV);
      else
        drawBuilding(ctx, x * s, y * s, s, x, y, {
          n: !solid(x, y - 1),
          s: !solid(x, y + 1),
          // The border ring is drawn plainer than interior blocks so its detail does not
          // compete with the playfield.
          border: x === 0 || y === 0 || x === map.width - 1 || y === map.height - 1,
        });
    }
  }

  // --- pickups and stopping points -------------------------------------------------------
  // A dog collecting a treat stands on the same tile as the person handing it over, so for
  // a moment they step apart — person left, dog right — with the treat between them.
  const exchange = (x, y) => view.exchanges?.find((e) => e.x === x && e.y === y);
  const sniffReaction = (x, y) => view.sniffReactions?.find((e) => e.x === x && e.y === y);
  const stopReaction = (x, y, reason) =>
    view.stopReactions?.find((e) => e.x === x && e.y === y && e.reason === reason);
  /** Sideways offset in tiles, out and back over the life of the exchange. */
  const nudge = (e) => (e ? Math.sin(Math.min(1, e.age) * Math.PI) * 0.2 : 0);

  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const ch = at(x, y);
      const k = key(x, y);
      if (ch === 'S') {
        const reaction = sniffReaction(x, y);
        const state = reaction
          ? 'reaction'
          : view.spent?.has(k)
            ? 'spent'
            : view.sniffed?.has(k)
              ? 'sniffed'
              : 'fresh';
        const frame = reaction
          ? Math.min(3, Math.floor(reaction.age * 4))
          : loopFrame(view.animationMs ?? 0, 5, x, y);
        drawSniff(ctx, x * s, y * s, s, x, y, state, frame);
      }
      else if (ch === 'P') {
        const e = exchange(x, y);
        // Lean in as well as step aside: a little bigger reads as offering the treat.
        const lean = e ? 1 + Math.sin(Math.min(1, e.age) * Math.PI) * 0.18 : 1;
        ctx.save();
        if (e) {
          ctx.translate((x + 0.5) * s - nudge(e) * s, (y + 0.5) * s);
          ctx.scale(lean, lean);
          ctx.translate(-(x + 0.5) * s, -(y + 0.5) * s);
        }
        const state = e ? 'giving' : view.taken?.has(k) ? 'given' : 'idle';
        // Giving is a one-shot four-frame action. Idle and given are deliberately slower
        // loops, with a per-tile phase offset so a crowd never bobs in lockstep.
        const frame = e
          ? Math.min(3, Math.floor(e.age * 4))
          : loopFrame(view.animationMs ?? 0, state === 'given' ? 5 : 6, x, y);
        drawPerson(ctx, x * s, y * s, s, x, y, state, frame);
        ctx.restore();
      } else if (ch === 'Q') {
        const reaction = stopReaction(x, y, 'squirrel');
        let frame;
        if (!reaction) frame = loopFrame(view.animationMs ?? 0, 6, x, y);
        else if (reaction.age < 0.55)
          frame = 4 + Math.min(7, Math.floor((reaction.age / 0.55) * 8));
        else frame = 12 + Math.min(3, Math.floor(((reaction.age - 0.55) / 0.45) * 4));
        drawSquirrel(ctx, x * s, y * s, s, frame);
      } else if (ch === '~') {
        const reaction = stopReaction(x, y, 'lake');
        const frame = reaction
          ? 4 + Math.min(3, Math.floor(reaction.age * 4))
          : loopFrame(view.animationMs ?? 0, 4, x, y);
        drawLake(ctx, x * s, y * s, s, frame);
      } else if (ch === 'D') {
        const reaction = stopReaction(x, y, 'drain');
        const frame = reaction
          ? 12 + Math.min(3, Math.floor(reaction.age * 4))
          : 8 + loopFrame(view.animationMs ?? 0, 2, x, y);
        drawDrain(ctx, x * s, y * s, s, frame);
      }
    }
  }

  // --- placed tiles -----------------------------------------------------------------------
  for (const t of view.tiles) drawPlacedTile(ctx, t.kind, t.x * s, t.y * s, s, view.colorFor(t.ownerId));

  // Your own pending placement, which nobody else can see yet.
  if (view.pending) {
    const { x, y, kind } = view.pending;
    drawPlacedTile(ctx, kind, x * s, y * s, s, view.colorFor(view.you), 0.6);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(x * s + 1, y * s + 1, s - 2, s - 2);
    ctx.setLineDash([]);
  }

  if (view.hover && view.selecting) {
    ctx.strokeStyle = view.legal ? 'rgba(255,255,255,0.75)' : 'rgba(255,90,90,0.85)';
    ctx.lineWidth = 2;
    ctx.strokeRect(view.hover.x * s + 1, view.hover.y * s + 1, s - 2, s - 2);
  }

  // --- dogs ---------------------------------------------------------------------------------
  for (const dog of view.dogs) {
    const spec = view.specFor(dog.id);
    // The other half of the treat exchange: the dog steps right as the person steps left.
    const e = exchange(Math.round(dog.x), Math.round(dog.y));
    const px = dog.x * s + nudge(e) * s;
    const py = dog.y * s;
    drawDogStatus(ctx, px, py, s, {
      stamina: dog.stamina,
      maxStamina: view.stamina,
      stopped: dog.stopped,
      scale: spec.scale ?? 1,
      accent: view.colorFor(dog.id),
    });
    drawDog(ctx, px, py, s, {
      dir: dog.dir,
      color: view.colorFor(dog.id),
      spec,
      gait: view.gait ?? 0,
      moving: Boolean(dog.moving) && !dog.stopped,
      stopped: dog.stopped,
      lift: dog.lift ?? 0,
    });
  }

  // --- spent tiles ------------------------------------------------------------------------
  // Tiles are single use. The burst is what tells a player their arrow just fired and is
  // gone, rather than it silently vanishing between frames.
  for (const b of view.bursts ?? []) {
    const cx = b.x * s + s / 2;
    const cy = b.y * s + s / 2;
    ctx.save();
    ctx.globalAlpha = 1 - b.age;
    ctx.translate(cx, cy);
    ctx.scale(1 + b.age * 0.9, 1 + b.age * 0.9);
    drawPlacedTile(ctx, b.kind, -s / 2, -s / 2, s, b.color, 1 - b.age);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = (1 - b.age) * 0.8;
    ctx.strokeStyle = b.color;
    ctx.lineWidth = Math.max(2, s * 0.07) * (1 - b.age);
    ctx.beginPath();
    ctx.arc(cx, cy, s * (0.3 + b.age * 0.45), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // --- floating score popups -----------------------------------------------------------------
  for (const pop of view.popups ?? []) {
    ctx.globalAlpha = Math.max(0, 1 - pop.age);
    ctx.font = `bold ${Math.round(s * 0.42)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const ty = pop.y * s - pop.age * s * 1.1 + s * 0.25;
    ctx.lineWidth = Math.max(2, s * 0.08);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(pop.text, pop.x * s + s / 2, ty);
    ctx.fillStyle = pop.points < 0 ? '#ff8080' : '#ffe066';
    ctx.fillText(pop.text, pop.x * s + s / 2, ty);
    ctx.globalAlpha = 1;
  }
}

/**
 * Interpolate dog positions between two ticks so playback reads as trotting rather than
 * teleporting. `f` is 0..1 through the step from `ticks[i]` to `ticks[i+1]`.
 */
export function interpolate(ticks, i, f) {
  const a = ticks[Math.min(i, ticks.length - 1)];
  const b = ticks[Math.min(i + 1, ticks.length - 1)];
  const byId = new Map(b.dogs.map((d) => [d.id, d]));
  return a.dogs.map((da) => {
    const db = byId.get(da.id) ?? da;
    const moving = da.x !== db.x || da.y !== db.y;
    return {
      ...db,
      x: da.x + (db.x - da.x) * f,
      y: da.y + (db.y - da.y) * f,
      // Turn on the spot happens early in the step, so the new heading reads before the move.
      dir: f < 0.35 ? da.dir : db.dir,
      moving,
      // A two-tile move arcs, so jumps look different from a fast walk.
      lift: db.jumped ? Math.sin(Math.PI * f) * 0.5 : 0,
    };
  });
}
