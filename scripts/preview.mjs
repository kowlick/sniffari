/**
 * Renders a map — and optionally a simulated walk — to an SVG you can open in a browser.
 *
 * This is the map-authoring and sim-debugging tool: edit maps/large.txt, run this, and
 * look at where the dogs actually go before inflicting the map on eight people.
 *
 *   node scripts/preview.mjs [--map maps/large.txt] [--out preview.svg] [--walk]
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadMap, mapStats } from '../src/sim/map.ts';
import { simulateWalk } from '../src/sim/simulate.ts';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const next = process.argv[i + 1];
    args.set(process.argv[i], next && !next.startsWith('--') ? next : true);
  }
}

const MAP = resolve(process.cwd(), args.get('--map') ?? 'maps/large.txt');
const OUT = resolve(process.cwd(), args.get('--out') ?? 'preview.svg');
const CELL = 22;
const PAD = 14;

const COLORS = { '#': '#262a31', '.': '#3c424b', ',': '#2f5d43', S: '#3c424b', P: '#3c424b', Q: '#3c424b', '~': '#1f4e79', D: '#3c424b' };
const DOG_COLORS = ['#e4572e', '#f4a259', '#8b8c89', '#a15e49', '#4a4e69', '#2a9d8f', '#9c6ade', '#3d8bfd'];

const map = await loadMap(MAP);
const stats = mapStats(map);
const W = map.width * CELL + PAD * 2;
const H = map.height * CELL + PAD * 2 + 26;
const p = (n) => PAD + n * CELL;
const mid = (n) => PAD + n * CELL + CELL / 2;

const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`];
out.push(`<rect width="${W}" height="${H}" fill="#14161a"/>`);

for (let y = 0; y < map.height; y++) {
  for (let x = 0; x < map.width; x++) {
    const ch = map.terrain[y * map.width + x];
    out.push(`<rect x="${p(x)}" y="${p(y)}" width="${CELL - 1}" height="${CELL - 1}" fill="${COLORS[ch] ?? '#3c424b'}"/>`);
    if (ch === 'S') out.push(`<circle cx="${mid(x)}" cy="${mid(y)}" r="${CELL * 0.16}" fill="#c9d64b"/>`);
    if (ch === 'P') out.push(`<circle cx="${mid(x)}" cy="${mid(y)}" r="${CELL * 0.2}" fill="#f06595"/>`);
    if (ch === 'Q') {
      out.push(`<circle cx="${mid(x)}" cy="${mid(y)}" r="${CELL * 0.32}" fill="#3f8f5a"/>`);
      out.push(`<circle cx="${mid(x)}" cy="${mid(y)}" r="${CELL * 0.13}" fill="#d98324"/>`);
    }
    if (ch === 'D') out.push(`<rect x="${mid(x) - CELL * 0.26}" y="${mid(y) - CELL * 0.16}" width="${CELL * 0.52}" height="${CELL * 0.32}" fill="#22262c" rx="2"/>`);
  }
}

let caption = `${map.name} · ${map.width}x${map.height} · ${stats.walkable} walkable (${Math.round(stats.walkableFraction * 100)}%) · ${stats.sniffs} sniffs · ${stats.people} people · 1 stopper per ${stats.walkablePerStopper.toFixed(1)} tiles`;

if (args.get('--walk')) {
  const dogs = map.starts.map((s, i) => ({ id: `d${i}`, breed: `d${i}`, x: s.x, y: s.y, dir: s.dir }));
  const result = simulateWalk(map, dogs, new Map());

  // One path per dog through every tile it stood on.
  dogs.forEach((d, i) => {
    const pts = result.ticks.map((t) => t.dogs.find((s) => s.id === d.id)).filter(Boolean);
    const path = pts.map((s) => `${mid(s.x)},${mid(s.y)}`).join(' ');
    out.push(`<polyline points="${path}" fill="none" stroke="${DOG_COLORS[i]}" stroke-width="2.6" stroke-opacity="0.85" stroke-linejoin="round" stroke-linecap="round"/>`);
    const last = pts.at(-1);
    out.push(`<circle cx="${mid(d.x)}" cy="${mid(d.y)}" r="${CELL * 0.3}" fill="${DOG_COLORS[i]}"/>`);
    out.push(`<circle cx="${mid(last.x)}" cy="${mid(last.y)}" r="${CELL * 0.34}" fill="${DOG_COLORS[i]}" stroke="#fff" stroke-width="2"/>`);
  });

  const summary = result.scores
    .map((s, i) => `${i + 1}:${s.score}(${s.stopped})`)
    .join('  ');
  caption = `${result.ticks.length} ticks · ${summary}`;
  console.log(`walk: ${result.ticks.length} ticks`);
  for (const [i, s] of result.scores.entries()) console.log(`  dog ${i + 1}: ${String(s.score).padStart(3)} pts, ${s.sniffs} sniffs, ${s.treats} treats, stopped by ${s.stopped}`);
}

out.push(`<text x="${PAD}" y="${H - 8}" fill="#929aa6" font-family="system-ui,sans-serif" font-size="12">${caption}</text>`);
out.push('</svg>');

await writeFile(OUT, out.join('\n'));
console.log(`wrote ${OUT}`);
