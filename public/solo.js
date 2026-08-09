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

import {
  DIRS,
  OUTCOME,
  createRun,
  patrolAt,
  step,
  tap,
  tapTarget,
} from '/shared/puzzle-rules.mjs';
import {
  drawDog,
  drawGround,
  drawPerson,
  drawPlacedTile,
  drawWordmark,
  dogSheet,
  entitySheet,
  peopleSheet,
  drawDrain,
  drawLake,
  drawSquirrel,
} from './sprites.js';
import { whenReady } from './atlas.js';

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');

const STORE = 'sniffari.solo';
/** Milliseconds per tick. Slow enough to react, brisk enough that a retry is cheap. */
const TICK_MS = 620;

let level = null;
let run = null;
let playing = false;
let lastTickAt = 0;
/** Where the dog was at the end of the previous tick, so movement can be interpolated. */
let prev = null;
let flash = null;

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
  prev = { x: run.x, y: run.y, dir: run.dir };
  playing = false;
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
    lastTickAt = performance.now();
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

function frame(now) {
  if (playing && run?.outcome === OUTCOME.RUNNING && now - lastTickAt >= TICK_MS) {
    lastTickAt = now;
    prev = { x: run.x, y: run.y, dir: run.dir };
    step(level, run);
    if (run.outcome !== OUTCOME.RUNNING) finish();
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
    } else {
      // Reaching the parent with tiles still in hand is not the intended route. The level
      // was built so that every tile is needed, so this means a shortcut nobody planned.
      banner('Home — but you had tiles left', 'secret');
      $('next').classList.remove('hidden');
    }
    return;
  }
  banner(
    run.outcome === OUTCOME.LOST_DOG
      ? 'Another dog! Try again'
      : run.outcome === OUTCOME.LOST_HAZARD
        ? 'Ended up somewhere wet. Try again'
        : 'Out of puff. Try again',
    'secret',
  );
}

// --- drawing -----------------------------------------------------------------------------

function fit() {
  const wrap = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const side = Math.max(120, Math.min(wrap.width, wrap.height) - 8);
  canvas.style.width = `${side}px`;
  canvas.style.height = `${side}px`;
  canvas.width = side * dpr;
  canvas.height = side * dpr;
}

function render(now = performance.now()) {
  if (!level || !run) return;
  fit();
  const s = canvas.width / level.width;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Terrain.
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const ch = level.terrain[y][x];
      drawGround(ctx, ch === 'P' ? '.' : ch, x * s, y * s, s, x, y);
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

  drawPatrolRoutes(s);

  // The parent. The thing the whole level is about, so it gets a ring.
  const g = level.goal;
  ctx.save();
  ctx.strokeStyle = '#ffd45e';
  ctx.lineWidth = Math.max(2, s * 0.06);
  ctx.globalAlpha = 0.5 + 0.3 * Math.sin(now / 400);
  ctx.beginPath();
  ctx.arc(g.x * s + s / 2, g.y * s + s * 0.78, s * 0.34, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  drawPerson(ctx, g.x * s, g.y * s, s, g.x, g.y, 'idle', Math.floor(now / 200) % 4);

  // Tiles the player has dropped and the dog has not reached yet.
  for (const [k, kind] of run.tiles) {
    const [tx, ty] = k.split(',').map(Number);
    drawPlacedTile(ctx, kind, tx * s, ty * s, s, '#f4a259', 1);
  }

  // Where the next tap would land.
  const target = tapTarget(level, run);
  if (target && run.outcome === OUTCOME.RUNNING) {
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.25 * Math.sin(now / 260);
    drawPlacedTile(ctx, target.kind, target.x * s, target.y * s, s, '#8fd4ff', 1);
    ctx.restore();
  }

  drawPatrols(s, now);
  drawTheDog(s, now);
  drawFlash(s, now);
  renderQueue();
  updateMeta();
}

/** Patrol routes are drawn in full: this is a planning game, not a memory test. */
function drawPatrolRoutes(s) {
  ctx.save();
  for (const patrol of level.patrols) {
    ctx.strokeStyle = 'rgba(255,120,120,0.35)';
    ctx.lineWidth = Math.max(1.5, s * 0.05);
    ctx.setLineDash([s * 0.14, s * 0.12]);
    ctx.beginPath();
    patrol.route.forEach((c, i) => {
      const px = c.x * s + s / 2;
      const py = c.y * s + s / 2;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
  ctx.restore();
}

function drawPatrols(s, now) {
  const t = run.tick;
  const into = playing ? Math.min(1, (now - lastTickAt) / TICK_MS) : 0;
  for (const patrol of level.patrols) {
    const from = patrolAt(patrol, Math.max(0, t - (playing ? 1 : 0)));
    const to = patrolAt(patrol, t);
    const x = (from.x + (to.x - from.x) * into) * s;
    const y = (from.y + (to.y - from.y) * into) * s;
    // A different breed and a red collar, so "not your dog" reads instantly.
    drawDog(ctx, x, y, s, {
      spec: { ear: 'perky', furStyle: 'wire', tail: 'plume', scale: 0.92 },
      color: '#e8503a',
      fur: '#7d7468',
      dir: 2,
      gait: (now / 500) % 1,
      moving: true,
    });
    // Draw the danger, not the dog — and draw its real shape.
    //
    // A circle was the obvious choice and it lies: it reaches into the diagonal squares,
    // which are safe. Meeting is Manhattan distance ≤ 1, so the hazard is a diamond through
    // the four orthogonal neighbours, and a player has to be able to see that a corner is
    // a corner they can stand on.
    const cx = x + s / 2;
    const cy = y + s / 2;
    const r = s * 1.5;
    ctx.save();
    ctx.fillStyle = 'rgba(255,90,90,0.10)';
    ctx.strokeStyle = 'rgba(255,90,90,0.34)';
    ctx.lineWidth = Math.max(1.5, s * 0.045);
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function drawTheDog(s, now) {
  const into = playing && run.outcome === OUTCOME.RUNNING ? Math.min(1, (now - lastTickAt) / TICK_MS) : 1;
  const x = (prev.x + (run.x - prev.x) * into) * s;
  const y = (prev.y + (run.y - prev.y) * into) * s;
  drawDog(ctx, x, y, s, {
    spec: { ear: 'floppy', furStyle: 'curly', tail: 'curl', scale: 0.9 },
    color: '#4a8fe0',
    fur: '#f2e4c8',
    dir: run.dir,
    gait: (now / 420) % 1,
    moving: playing && run.outcome === OUTCOME.RUNNING,
  });
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
await Promise.all([whenReady(dogSheet), whenReady(peopleSheet), whenReady(entitySheet)]);

const startAt = Number(new URLSearchParams(location.search).get('level')) || saved().reached || 1;
await load(Math.max(1, startAt));
requestAnimationFrame(frame);
