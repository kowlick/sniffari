/**
 * Heel — the solo puzzle client.
 *
 * The dog walks on its own and you have one button. Tapping drops the next tile from the
 * queue onto the square directly ahead of it, which the dog then walks onto and obeys.
 *
 * The rules are not in this file. They come from `/shared/puzzle-rules.mjs`, which is the
 * same module the level generator and the tests run — so what the browser shows and what
 * the solver proved solvable cannot disagree. See src/shared/puzzle-rules.mjs.
 */

import { OUTCOME, createRun, patrolAt, step, tap, tapTarget } from '/shared/puzzle-rules.mjs';
import {
  drawHedge,
  drawDog,
  drawDrain,
  drawGround,
  drawLake,
  drawPerson,
  drawPlacedTile,
  drawSquirrel,
  drawWordmark,
  dogSheet,
  entitySheet,
  peopleSheet,
} from './sprites.js';
import { whenReady } from './atlas.js';

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');

const STORE = 'sniffari.solo';
/**
 * Milliseconds per tile.
 *
 * The whole tick is a tap window — the tile drops on the square she is walking onto, right
 * up until she reaches the middle of it — so this is also how long you get to decide.
 *
 * Walked back down from 2s through 1.5s. The original 620ms was a reaction test; 2s made a
 * failed attempt drag; 1.5s still felt like waiting. A second is enough to read the board
 * and act on it without the walk between decisions becoming dead time.
 */
const TICK_MS = 1000;

let level = null;
let run = null;
let playing = false;
let lastTickAt = 0;
/**
 * Where this tick's walk is taking her, worked out one tick ahead purely to animate toward.
 *
 * The rules resolve a tick in one go, so the moment `step` runs she *is* on the next square.
 * Running it at the start of the animation therefore left her logical position a whole tile
 * in front of the drawn one — and since a tap drops its tile ahead of the *logical*
 * position, tiles landed one square farther out than the player aimed. The step now happens
 * when the walk finishes rather than when it starts, and this is the peek that lets the
 * picture move in the meantime.
 */
let walkingTo = null;
let flash = null;
/** Little rising hearts when she gets home. Cleared on reset. */
let hearts = [];
/** The intended answer, once it has been asked for. Never arrives unbidden. */
let revealed = null;
let advanceAt = 0;

/**
 * Breed art, from the same `/dogs.json` the party game uses.
 *
 * `atlasRow` is the index into that list and is what selects a row of the sprite sheet —
 * without it `drawDog` silently falls back to the procedural art, which is the fallback for
 * a missing sheet rather than a style choice.
 */
let YOURS = {};
let THEIRS = {};

async function loadBreeds() {
  const dogs = await (await fetch('/dogs.json')).json();
  dogs.forEach((d, i) => (d.atlasRow = i));
  // The Cockapoo is the one you walk. The other dogs get the wolfhound: much bigger, much
  // greyer, and unmistakably not yours at a glance.
  YOURS = dogs.find((d) => d.id === 'cockapoo') ?? dogs[0];
  THEIRS = dogs.find((d) => d.id === 'wolfhound') ?? dogs[1];
}

const saved = () => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? 'null') ?? { reached: 1 };
  } catch {
    return { reached: 1 };
  }
};
const remember = (patch) =>
  localStorage.setItem(STORE, JSON.stringify({ ...saved(), ...patch }));

// --- loading ---------------------------------------------------------------------------

async function load(n) {
  banner(`Level ${n}`, '');
  $('solo-hint').textContent = 'Fetching the park…';
  const res = await fetch(`/solo/level/${n}`);
  if (!res.ok) {
    $('solo-hint').textContent = 'That level could not be built.';
    return;
  }
  level = await res.json();
  $('level-input').value = String(level.level);
  reset();
  clearBanner();
}

/** Back to the start of the current level with a fresh queue. Instant, and free. */
function reset() {
  run = createRun(level);
  walkingTo = null;
  playing = false;
  hearts = [];
  revealed = null;
  advanceAt = 0;
  flash = null;
  lastTickAt = 0;
  $('next').classList.add('hidden');
  $('share').classList.add('hidden');
  render();
}

// --- the one button --------------------------------------------------------------------

/**
 * Drop the next tile in front of the dog.
 *
 * The first press also starts the level. That means the dog never moves before the player
 * is looking at it, and it removes the "wait, it already started?" moment that a countdown
 * would create.
 */
function drop() {
  if (!level || !run) return;
  if (run.outcome !== OUTCOME.RUNNING) return;
  if (!playing) {
    playing = true;
    beginWalk(performance.now());
    return;
  }
  const placed = tap(level, run);
  if (placed) {
    flash = { ...placed, born: performance.now(), ok: true };
  } else {
    // Refused: a wall ahead, a tile already there, or the queue is empty. Nothing is spent,
    // so a mistimed press costs only the moment.
    flash = { x: run.x, y: run.y, born: performance.now(), ok: false };
  }
  renderQueue();
}

/**
 * Ask the server what it had in mind.
 *
 * Fetched on demand rather than shipped with the level, so the answer is not sitting in the
 * response to the board you are looking at. Purely for building the thing.
 */
$('reveal')?.addEventListener('click', async () => {
  if (revealed) {
    revealed = null;
    $('reveal').textContent = 'Show the solution';
    return;
  }
  const res = await fetch(`/solo/level/${level.level}/solution`);
  if (!res.ok) return toast('No solution recorded for this level.');
  revealed = await res.json();
  $('reveal').textContent = `Hide (taps on ${revealed.taps.join(', ')})`;
});

$('drop').addEventListener('click', drop);
$('retry').addEventListener('click', reset);
$('next').addEventListener('click', () => load(level.level + 1));
$('prev-level').addEventListener('click', () => load(Math.max(1, level.level - 1)));
$('go-level').addEventListener('click', () => load(Math.max(1, Number($('level-input').value) || 1)));

// Space and tap-anywhere, because on a phone the button is not always where your thumb is.
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    drop();
  }
  if (e.code === 'KeyR') reset();
});
$('board').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  drop();
});

/**
 * A solution is the list of ticks you tapped on, which is short enough to say out loud.
 *
 * That is the whole sharing story: levels are a pure function of their number, so a level
 * and a tap schedule is everything another person needs to watch exactly what you did.
 */
$('share').addEventListener('click', async () => {
  const code = `sniffari heel ${level.level}: ${run.taps.join(' ')}`;
  try {
    await navigator.clipboard.writeText(code);
    toast('Solution copied');
  } catch {
    toast(code);
  }
});

// --- the loop ---------------------------------------------------------------------------

/**
 * One tick of movement per TICK_MS, with the ending held back until she gets there.
 *
 * The rules resolve a whole tick at once — she is on the next square the instant the tick
 * turns over — but the *picture* takes TICK_MS to catch up. Calling it over at the moment
 * the rules said so made her snap onto the parent, or onto the other dog, from wherever the
 * animation had got to. So a terminal outcome does not end the level; it ends the level
 * once the walk that caused it has finished playing.
 */
/**
 * Look one tick ahead, so the picture has somewhere to walk to.
 *
 * Only the destination is taken from the peek. The real `step` runs when the walk finishes
 * and is authoritative — which matters because a tap can land *during* the walk. It cannot
 * change where she is going (a tile on the destination sets her facing on arrival, not the
 * move she is already making), but it can change everything after that.
 */
function beginWalk(now) {
  const peek = { ...run, tiles: new Map(run.tiles), taps: [...run.taps], trail: null };
  step(level, peek);
  walkingTo = { x: peek.x, y: peek.y };
  lastTickAt = now;
}

function frame(now) {
  if (advanceAt && now >= advanceAt) {
    advanceAt = 0;
    void load(level.level + 1);
  }
  if (playing && now - lastTickAt >= TICK_MS) {
    // The walk we have been showing is over, so make it real.
    step(level, run);
    if (run.outcome !== OUTCOME.RUNNING) {
      playing = false;
      finish();
    } else {
      beginWalk(now);
    }
  }
  render(now);
  requestAnimationFrame(frame);
}

function finish() {
  playing = false;
  if (run.outcome === OUTCOME.WON) {
    const complete = run.used === level.queue.length;
    if (complete) {
      banner('Home!', 'go');
      remember({ reached: Math.max(saved().reached, level.level + 1) });
      $('next').classList.remove('hidden');
      $('share').classList.remove('hidden');
      burstHearts();
      // Straight on to the next one. Long enough to watch the hearts and register that she
      // made it; short enough that the game never asks you to press anything to keep going.
      advanceAt = performance.now() + 2200;
    } else {
      // Reaching the parent with tiles still in hand is not the intended route. The level
      // was built so that every tile is needed, so this means a shortcut nobody planned.
      banner('Home — but you had tiles left', 'secret');
      $('next').classList.remove('hidden');
    }
    return;
  }
  banner(
    {
      [OUTCOME.LOST_DOG]: 'Ran into another dog',
      [OUTCOME.LOST_HAZARD]: 'Something else caught her eye',
      [OUTCOME.LOST_ESCAPED]: 'Out of the park!',
      [OUTCOME.LOST_CRASH]: 'Straight into the hedge',
      [OUTCOME.LOST_TIRED]: 'Out of puff',
    }[run.outcome] ?? 'Try again',
    'secret',
  );
}

// --- drawing -----------------------------------------------------------------------------

/**
 * Size the canvas, with headroom above the board.
 *
 * Dogs are drawn taller than their tile and stand on it, so one on the top row reaches up
 * out of the board. With the fence gone that row is playable, and the patrols up there were
 * getting their heads cropped off by the edge of the canvas. Half a tile of sky fixes it.
 */
const HEADROOM = 0.6;
let tile = 0;

function fit() {
  const wrap = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cols = level.width;
  const rows = level.height + HEADROOM;
  const side = Math.max(
    60,
    Math.min((wrap.width - 8) / cols, (wrap.height - 8) / rows),
  );
  const w = side * cols;
  const h = side * rows;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  tile = side * dpr;
}

function render(now = performance.now()) {
  if (!level || !run) return;
  fit();
  const s = tile;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Everything below draws in board coordinates; the sky sits above it.
  ctx.save();
  ctx.translate(0, s * HEADROOM);

  // Terrain. Walls came out looking exactly like walkable street, which on a board whose
  // whole subject is where a dog can and cannot go is the worst thing they could look like.
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const ch = level.terrain[y][x];
      if (ch !== '#') {
        drawGround(ctx, ch === 'P' ? ',' : ch, x * s, y * s, s, x, y);
        continue;
      }
      // A hedge, not a building. The party game's blocks are lit apartment buildings, which
      // on a board of grass and footpaths look like they wandered in from another game.
      drawHedge(ctx, x * s, y * s, s, x, y, {
        n: level.terrain[y - 1]?.[x] !== '#',
        s: level.terrain[y + 1]?.[x] !== '#',
      });
    }
  }
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const ch = level.terrain[y][x];
      if (ch === '~') drawLake(ctx, x * s, y * s, s, 0);
      else if (ch === 'D') drawDrain(ctx, x * s, y * s, s, 8);
      else if (ch === 'Q') drawSquirrel(ctx, x * s, y * s, s, 0);
    }
  }

  drawEdgeWarning(s, now);

  // The parent — the entire point of the level, and previously the least visible thing on
  // the board. A warm pool of light under the square, a ring that breathes, and an arrow
  // above so it can be found without hunting.
  const g = level.goal;
  const gx = g.x * s + s / 2;
  const gy = g.y * s + s / 2;
  ctx.save();
  const glow = ctx.createRadialGradient(gx, gy + s * 0.2, s * 0.1, gx, gy + s * 0.2, s * 0.85);
  glow.addColorStop(0, 'rgba(255,212,94,0.30)');
  glow.addColorStop(1, 'rgba(255,212,94,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(g.x * s - s, g.y * s - s, s * 3, s * 3);
  ctx.strokeStyle = '#ffd45e';
  ctx.lineWidth = Math.max(2.5, s * 0.075);
  ctx.globalAlpha = 0.65 + 0.35 * Math.sin(now / 400);
  ctx.beginPath();
  ctx.arc(gx, g.y * s + s * 0.8, s * 0.4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  drawPerson(ctx, g.x * s, g.y * s, s, g.x, g.y, 'idle', Math.floor(now / 200) % 4);

  ctx.save();
  ctx.fillStyle = '#ffd45e';
  ctx.globalAlpha = 0.85;
  const bob = Math.sin(now / 400) * s * 0.05;
  ctx.beginPath();
  ctx.moveTo(gx, g.y * s - s * 0.02 + bob);
  ctx.lineTo(gx - s * 0.16, g.y * s - s * 0.28 + bob);
  ctx.lineTo(gx + s * 0.16, g.y * s - s * 0.28 + bob);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Tiles the player has dropped and the dog has not reached yet.
  for (const [k, kind] of run.tiles) {
    const [tx, ty] = k.split(',').map(Number);
    drawPlacedTile(ctx, kind, tx * s, ty * s, s, '#f4a259', 1);
  }

  // The square the next tap would claim. Worth showing again now that it is the square she
  // is walking onto rather than the one beyond it.
  const target = tapTarget(level, run);
  if (target && run.outcome === OUTCOME.RUNNING) {
    ctx.save();
    ctx.globalAlpha = 0.28 + 0.16 * Math.sin(now / 260);
    ctx.strokeStyle = '#8fd4ff';
    ctx.lineWidth = Math.max(2, s * 0.06);
    ctx.setLineDash([s * 0.16, s * 0.12]);
    ctx.strokeRect(target.x * s + s * 0.1, target.y * s + s * 0.1, s * 0.8, s * 0.8);
    ctx.restore();
  }

  drawSolution(s, now);
  drawPatrols(s, now);
  drawTheDog(s, now);
  drawFlash(s, now);
  drawHearts(s, now);
  ctx.restore();
  renderQueue();
  updateMeta();
}

/**
 * The park has no fence, so the edge has to say so.
 *
 * A hard boundary you cannot cross needs no explanation; an open one that ends the round
 * does. A warm band bleeding inward from every side reads as "past here she is gone",
 * without putting a wall where there is not one.
 */
function drawEdgeWarning(s, now) {
  const w = s * level.width;
  const h = s * level.height;
  const band = s * 0.5;
  const pulse = 0.16 + 0.06 * Math.sin(now / 700);
  const edges = [
    [0, 0, w, band, 0, 0, 0, band],
    [0, h - band, w, band, 0, h, 0, h - band],
    [0, 0, band, h, 0, 0, band, 0],
    [w - band, 0, band, h, w, 0, w - band, 0],
  ];
  ctx.save();
  for (const [x, y, bw, bh, gx0, gy0, gx1, gy1] of edges) {
    const grad = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    grad.addColorStop(0, `rgba(255,150,90,${pulse})`);
    grad.addColorStop(1, 'rgba(255,150,90,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, bw, bh);
  }
  ctx.restore();
}

function drawPatrols(s, now) {
  const t = run.tick;
  const into = playing ? Math.min(1, (now - lastTickAt) / TICK_MS) : 0;
  for (const patrol of level.patrols) {
    // Same clock as the dog: standing on tick t and walking toward t+1, so what you see
    // beside her is what the rules will compare her against when this walk lands.
    const from = patrolAt(patrol, t);
    const to = patrolAt(patrol, t + 1);
    const x = (from.x + (to.x - from.x) * into) * s;
    const y = (from.y + (to.y - from.y) * into) * s;
    // Faces where it is *going*, taken from the next tick rather than the last one. Derived
    // from the previous tick it stood facing north whenever the board was paused, which is
    // exactly when a player is studying it to work out where it will be.
    const dir =
      to.x > from.x ? 1 : to.x < from.x ? 3 : to.y > from.y ? 2 : to.y < from.y ? 0 : 2;
    drawDog(ctx, x, y, s, {
      spec: THEIRS,
      color: '#e8503a',
      dir,
      gait: (now / 500) % 1,
      moving: true,
    });
  }
}

function drawTheDog(s, now) {
  // She is drawn walking *from* her logical square toward the next one, which is the whole
  // point: where she appears and where the rules think she is now agree, so a tile dropped
  // "in front of her" lands in front of her.
  const into = playing && walkingTo ? Math.min(1, (now - lastTickAt) / TICK_MS) : 0;
  const to = walkingTo ?? run;
  const x = (run.x + (to.x - run.x) * into) * s;
  const y = (run.y + (to.y - run.y) * into) * s;
  drawDog(ctx, x, y, s, {
    spec: YOURS,
    color: YOURS.color ?? '#e8503a',
    dir: run.dir,
    gait: (now / 420) % 1,
    moving: playing && run.outcome === OUTCOME.RUNNING,
  });
}

/** A handful of hearts over the parent, drifting up and fading. */
function burstHearts() {
  const born = performance.now();
  hearts = Array.from({ length: 7 }, (_, i) => ({
    born: born + i * 90,
    dx: (i - 3) * 0.13 + (i % 2 ? 0.05 : -0.05),
    scale: 0.55 + (i % 3) * 0.18,
  }));
}

function drawHearts(s, now) {
  if (!hearts.length) return;
  const g = level.goal;
  ctx.save();
  for (const h of hearts) {
    const age = (now - h.born) / 1500;
    if (age < 0 || age >= 1) continue;
    const x = (g.x + 0.5 + h.dx) * s;
    const y = (g.y + 0.5 - age * 1.5) * s;
    const r = s * 0.16 * h.scale * (1 + age * 0.25);
    ctx.globalAlpha = age < 0.15 ? age / 0.15 : 1 - (age - 0.15) / 0.85;
    ctx.fillStyle = '#ff7a9c';
    // Two lobes and a point: a heart at eight pixels across needs no more than that.
    ctx.beginPath();
    ctx.arc(x - r * 0.5, y - r * 0.35, r * 0.62, Math.PI * 0.9, Math.PI * 2.05);
    ctx.arc(x + r * 0.5, y - r * 0.35, r * 0.62, Math.PI * 0.95, Math.PI * 2.1);
    ctx.lineTo(x, y + r);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * The intended answer, drawn on the board: each tile on the square it lands on, numbered in
 * the order it is dropped.
 *
 * A development aid, and it looks like one on purpose — nothing here tries to be subtle.
 */
function drawSolution(s, now) {
  if (!revealed) return;

  /*
   * A square can be used twice.
   *
   * Tiles are single use, so once she has walked over one the square is free again and a
   * later tile can land on the same spot. Drawn all at once that reads as one tile — the
   * last one drawn simply covers the others, and its number covers theirs, so the answer
   * silently loses a step. Squares with more than one tile cycle instead, at the pace she
   * walks, with a row of pips saying how many are taking turns.
   */
  const bySquare = new Map();
  revealed.placements.forEach((p, i) => {
    const k = `${p.x},${p.y}`;
    if (!bySquare.has(k)) bySquare.set(k, []);
    bySquare.get(k).push({ ...p, order: i + 1 });
  });

  ctx.save();
  for (const stack of bySquare.values()) {
    const p = stack[Math.floor(now / TICK_MS) % stack.length];

    ctx.globalAlpha = 0.55;
    drawPlacedTile(ctx, p.kind, p.x * s, p.y * s, s, '#8fd4ff', 1);
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#0b0d11';
    ctx.beginPath();
    ctx.arc(p.x * s + s * 0.8, p.y * s + s * 0.2, s * 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8fd4ff';
    ctx.font = `700 ${s * 0.24}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.order), p.x * s + s * 0.8, p.y * s + s * 0.21);

    if (stack.length > 1) {
      // One pip per tile that shares this square, the current one filled in.
      const gap = s * 0.13;
      const left = p.x * s + s / 2 - (gap * (stack.length - 1)) / 2;
      const y = p.y * s + s * 0.88;
      stack.forEach((q, i) => {
        ctx.beginPath();
        ctx.arc(left + i * gap, y, s * 0.045, 0, Math.PI * 2);
        ctx.fillStyle = q === p ? '#8fd4ff' : 'rgba(143,212,255,0.3)';
        ctx.fill();
      });
    }
  }
  ctx.restore();
}

function drawFlash(s, now) {
  if (!flash) return;
  const age = (now - flash.born) / 420;
  if (age >= 1) {
    flash = null;
    return;
  }
  ctx.save();
  ctx.globalAlpha = (1 - age) * 0.9;
  ctx.strokeStyle = flash.ok ? '#8fd4ff' : '#ff8080';
  ctx.lineWidth = Math.max(2, s * 0.08);
  const r = s * (0.3 + age * 0.4);
  ctx.beginPath();
  ctx.arc(flash.x * s + s / 2, flash.y * s + s / 2, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

const GLYPH = { N: '↑', E: '→', S: '↓', W: '←', J: '⇧' };

function renderQueue() {
  const el = $('queue');
  el.innerHTML = '';
  level.queue.forEach((kind, i) => {
    const b = document.createElement('span');
    b.className = 'qtile' + (i < run.used ? ' spent' : i === run.used ? ' next' : '');
    b.textContent = GLYPH[kind] ?? kind;
    el.appendChild(b);
  });
  const left = level.queue.length - run.used;
  $('solo-hint').textContent = !playing
    ? run.outcome === OUTCOME.RUNNING
      ? 'Tap Drop to set off.'
      : 'Tap Retry to go again.'
    : left === 0
      ? 'That was the last one — see where she ends up.'
      : `${left} tile${left > 1 ? 's' : ''} left. Drop it in front of her.`;
}

function updateMeta() {
  $('round').innerHTML =
    `Level ${level.level}<span class="sep">·</span>${run.steps} steps`;
  const uniq = level.solutions === 1 ? 'one solution' : `${level.solutions}+ solutions`;
  $('solo-meta').textContent = `${level.queue.length} tiles · ${level.patrols.length} other dog${
    level.patrols.length === 1 ? '' : 's'
  } · ${uniq}`;
}

// --- chrome ------------------------------------------------------------------------------

let bannerTimer = null;
function banner(text, cls) {
  const el = $('banner');
  el.textContent = text;
  el.className = `banner show ${cls}`;
  clearTimeout(bannerTimer);
  if (cls === '') bannerTimer = setTimeout(clearBanner, 900);
}
const clearBanner = () => {
  $('banner').className = 'banner';
};

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

drawWordmark($('wordmark'), 'Sniffari', 30);
await Promise.all([
  loadBreeds(),
  whenReady(dogSheet),
  whenReady(peopleSheet),
  whenReady(entitySheet),
]);

const startAt = Number(new URLSearchParams(location.search).get('level')) || saved().reached || 1;
await load(Math.max(1, startAt));
requestAnimationFrame(frame);
