import { cellAt, draw, interpolate } from './render.js';
import { drawDogPortrait, drawWordmark, dogSheet, entitySheet, peopleSheet } from './sprites.js';
import { whenReady } from './atlas.js';
import { isMuted, playMusic, setMuted, sfx, stopMusic, unlock } from './audio.js';

const MODE = document.body.dataset.mode; // 'player' | 'board'
const $ = (id) => document.getElementById(id);
const canvas = $('board');

let DOG_COLORS = new Map();
let DOG_SPECS = new Map();
let ws = null;
let state = null;
let you = null;
let selected = null;
let hover = null;
let playback = null; // { ticks, tickMs, start, popups }
let toast = null;
let lastSecond = -1;
const TREAT_EXCHANGE_MS = 480;
const SNIFF_REACTION_MS = 520;
const STOP_REACTION_MS = { squirrel: 1500, lake: 520, drain: 620 };

const STORE = 'sniffari.session';

/** Suggested names, shown greyed out as a placeholder. Used verbatim if left blank. */
const SILLY_NAMES = [
  'Bark Twain', 'Sniff Rogers', 'Waggy Stardust', 'Droolius Caesar',
  'Mary Puppins', 'Winston Furchill', 'Vincent van Growl', 'Jane Pawsten',
  'Sherlock Bones', 'Hairy Pawter', 'Indiana Bones', 'Woofgang Puck',
  'Chew Barka', 'Sir Waggington', 'Duchess Drool', 'Lord Sniffington',
  'Captain Zoomies', 'Biscuit Baron', 'Pup Tart', 'Muddy Paws',
  'Tennis Ball Tim', 'Squirrel Watch', 'Treat Detective', 'Puddle Jumper',
  'Bin Inspector', 'Nap Enthusiast', 'Professor Fetch', 'Baron von Snout',
  'Wanda Wanders', 'Gnasher Keaton', 'Rolo Tomasi', 'The Sniffster',
];
const randomName = () => SILLY_NAMES[Math.floor(Math.random() * SILLY_NAMES.length)];
const saved = () => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? 'null');
  } catch {
    return null;
  }
};

// --- connection -----------------------------------------------------------------------

function connect(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = onOpen;
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    showToast('Disconnected — reconnecting…');
    setTimeout(() => connect(resume), 1500);
  };
}

const send = (msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

let rejoining = false;

function resume() {
  // One room per server on a LAN, so the board just attaches and a returning player only
  // needs their token.
  if (MODE === 'board') return send({ t: 'spectate' });
  const s = saved();
  if (s?.token) {
    rejoining = true;
    send({ t: 'rejoin', token: s.token });
  }
}

function handle(msg) {
  if (msg.t === 'error') {
    // A token from a previous server run is expected to fail. Drop it and show the join
    // form rather than greeting the player with an error they cannot act on.
    if (rejoining) {
      rejoining = false;
      localStorage.removeItem(STORE);
      return;
    }
    return showToast(msg.message);
  }

  if (msg.t === 'joined') {
    rejoining = false;
    you = msg.playerId;
    localStorage.setItem(STORE, JSON.stringify({ token: msg.token }));
    // Deliberately does NOT dismiss the lobby — picking a dog happens there, and you
    // cannot start a match without one. renderUI decides what the overlay shows.
    return;
  }

  if (msg.t === 'state') {
    const wasLobby = state?.phase === 'lobby';
    const prevPhase = state?.phase;
    const prevTurn = state?.turn;
    state = msg;
    you = msg.you ?? you;
    if (msg.phase !== 'place') selected = null;
    if (msg.phase === 'place' && wasLobby) selected = null;

    if (msg.phase === 'place' && (prevPhase !== 'place' || prevTurn !== msg.turn)) {
      const secret = msg.turn === msg.config.turns;
      announce(
        secret ? 'Secret turn — place a tile!' : `Turn ${msg.turn} of ${msg.config.turns} — place a tile!`,
        secret ? 'secret' : '',
      );
      chime('warn');
    } else if (prevPhase !== msg.phase) {
      if (msg.phase === 'walk') announce('Walkies!', 'go');
      else if (msg.phase === 'setup') {
        // A new round: the board is reset, so forget what the last walk used up.
        resetConsumed();
        announce('Dogs on their marks…');
      } else if (msg.phase === 'score') announceStandings();
      // Nothing at match-end: the lobby overlay comes up with the final standings on it,
      // and a banner behind that overlay is just noise nobody can read.
      else if (msg.phase === 'match-end') {
        clearBanner();
        hidePodium();
      } else hidePodium();
    }

    // Placing and walking get different music; everything else is quiet so the standings
    // read-out and the timer chimes have room.
    if (prevPhase !== msg.phase) {
      if (msg.phase === 'place') playMusic('place');
      else if (msg.phase === 'walk') playMusic('walk');
      else if (msg.phase === 'lobby' || msg.phase === 'match-end' || msg.phase === 'score')
        stopMusic();
    }

    fitCanvas();
    renderUI();
    return;
  }

  if (msg.t === 'reveal') {
    const parts = [];
    if (msg.placed.length) parts.push(`${msg.placed.length} tile${msg.placed.length > 1 ? 's' : ''} placed`);
    for (const c of msg.cancelled) parts.push(`collision at ${c.x},${c.y} — scuff mark!`);
    for (const id of msg.skipped ?? []) {
      const who = id === you ? 'You' : (state?.players.find((p) => p.id === id)?.name ?? 'Someone');
      parts.push(`${who} ran out of time — no tile this turn`);
    }
    if (parts.length) log(parts.join(' · '));
    return;
  }

  if (msg.t === 'walk') {
    playback = {
      ticks: msg.ticks,
      tickMs: msg.tickMs,
      start: performance.now(),
      popups: [],
      bursts: [],
      exchanges: [],
      sniffReactions: [],
      stopReactions: [],
      seen: -1,
    };
    log('The dogs are off!');
    return;
  }
}

// --- lobby ----------------------------------------------------------------------------

/** Blank means "I'll take the suggestion", so send the placeholder rather than nothing. */
const chosenName = () => $('name').value.trim() || $('name').placeholder;
const doJoin = () => {
  unlockAudio();
  send({ t: 'join', name: chosenName() });
};
$('join')?.addEventListener('click', doJoin);
$('name')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doJoin();
});
$('start')?.addEventListener('click', () => send({ t: 'start' }));
$('lobby-start')?.addEventListener('click', () => send({ t: 'start' }));
$('claim-host')?.addEventListener('click', () => send({ t: 'claimHost' }));
$('lock')?.addEventListener('click', () => send({ t: 'lock' }));

// Ending a match is destructive and cannot be undone, so it asks first — inline rather
// than a browser confirm(), which phones handle badly.
$('end-match')?.addEventListener('click', () => {
  $('end-match').classList.add('hidden');
  $('end-confirm').classList.remove('hidden');
});
$('end-no')?.addEventListener('click', () => {
  $('end-confirm').classList.add('hidden');
  $('end-match').classList.remove('hidden');
  sfx('consume');
});
$('end-yes')?.addEventListener('click', () => {
  send({ t: 'endMatch' });
  $('end-confirm').classList.add('hidden');
});

$('mute')?.addEventListener('click', () => {
  unlock();
  const m = setMuted(!isMuted());
  $('mute').textContent = m ? '🔇' : '🔊';
  localStorage.setItem('sniffari.muted', m ? '1' : '0');
});

// --- board interaction ----------------------------------------------------------------

if (MODE === 'player') {
  canvas.addEventListener('mousemove', (e) => {
    if (!state) return;
    hover = cellAt(canvas, state.map, e.clientX, e.clientY);
  });
  canvas.addEventListener('mouseleave', () => (hover = null));
  canvas.addEventListener('click', (e) => {
    if (!state || state.phase !== 'place' || !selected) return;
    const cell = cellAt(canvas, state.map, e.clientX, e.clientY);
    if (cell) send({ t: 'place', x: cell.x, y: cell.y, kind: selected });
  });
}

function legalHere(cell) {
  if (!state || !cell) return false;
  const ch = state.map.rows[cell.y][cell.x];
  if (ch === '#' || ch === 'Q' || ch === '~' || ch === 'D') return false;
  if (state.tiles.some((t) => t.x === cell.x && t.y === cell.y)) return false;
  // During placement every dog is still on its start square, which is not placeable.
  if (state.dogs.some((d) => d.x === cell.x && d.y === cell.y)) return false;
  return true;
}

// --- UI ---------------------------------------------------------------------------------

const PHASE_TEXT = {
  lobby: 'Waiting for players',
  setup: 'Dogs are on their marks',
  place: 'Place a tile',
  reveal: 'Revealing',
  walk: 'Walkies!',
  score: 'Scoring',
  'match-end': 'Match over',
};

function renderUI() {
  if (!state) return;
  $('phase').textContent =
    state.phase === 'place' && state.turn === state.config.turns
      ? 'Secret turn — nobody sees this one'
      : (PHASE_TEXT[state.phase] ?? state.phase);
  $('round').innerHTML =
    state.round > 0
      ? `Round ${state.round}<span class="of">/${state.config.roundsPerMatch}</span>` +
        `<span class="sep">·</span>Turn ${state.turn}<span class="of">/${state.config.turns}</span>`
      : '';

  renderPlayers();
  if (MODE === 'player') {
    renderLobby();
    renderHand();
    const me = state.players.find((p) => p.id === you);
    // Starting lives in the lobby overlay, which is up for both 'lobby' and 'match-end'.
    $('start').classList.add('hidden');
    const mid = state.phase !== 'lobby' && state.phase !== 'match-end';
    const canEnd = Boolean(me?.isHost) && mid;
    if (!canEnd) $('end-confirm').classList.add('hidden');
    $('end-match').classList.toggle('hidden', !canEnd || !$('end-confirm').classList.contains('hidden'));
    // A dog on autopilot is not yours to place for — the computer has the turn, and
    // leaving the controls live would just race it.
    const auto = Boolean(me?.ai);
    $('lock').classList.toggle('hidden', state.phase !== 'place' || auto);
    $('lock').disabled = !state.pending || me?.locked;
    $('lock').textContent = me?.locked ? 'Locked in' : 'Lock it in';
    // Placing is what counts; locking only ends the turn early. Say so, because "no tile
    // on the board when the timer ends" is a forfeited placement.
    $('place-hint').textContent = auto
      ? me?.locked
        ? 'The computer has placed for you.'
        : 'The computer is thinking…'
      : me?.locked
        ? 'Waiting for the others.'
        : state.pending
          ? 'Placed. It locks in automatically when the timer runs out.'
          : 'Pick a tile, then click a square. No tile placed = no tile this turn.';
    $('place-hint').classList.toggle('hidden', state.phase !== 'place');
  }
  $('join-url').textContent = `Others join at ${location.origin}`;
}

/**
 * The lobby overlay is live for the whole lobby phase — join, pick a dog, start — and comes
 * back at match end so latecomers can join the next one.
 */
function renderLobby() {
  const lobby = $('lobby');
  if (!lobby) return;
  const open = state.phase === 'lobby' || state.phase === 'match-end';
  lobby.classList.toggle('hidden', !open);
  if (!open) return;

  const over = state.phase === 'match-end';
  $('lobby-title').textContent = over ? 'Match over' : 'Join the walk';
  $('final').classList.toggle('hidden', !over);
  if (over) {
    const ranked = [...state.players].filter((p) => p.dogId).sort((a, b) => b.matchScore - a.matchScore);
    $('final').innerHTML = ranked
      .map(
        (p, i) =>
          `<div class="lp"><span class="swatch" style="background:${DOG_COLORS.get(p.dogId) ?? '#3a3f47'}"></span>` +
          `<span class="pname">${i === 0 ? '🏆 ' : ''}${escapeHtml(p.name)}</span>` +
          `<span class="pdog">${p.matchScore} pts</span></div>`,
      )
      .join('');
  }

  const joined = Boolean(you);
  $('join-row').classList.toggle('hidden', joined);
  $('pick-row').classList.toggle('hidden', !joined);
  if (!joined) return;

  renderDogPicker();

  const me = state.players.find((p) => p.id === you);
  const withDogs = state.players.filter((p) => p.dogId).length;
  renderRoundPicker(Boolean(me?.isHost));
  renderBotPicker(Boolean(me?.isHost));
  renderAutopilot(me);

  $('lobby-players').innerHTML = state.players
    .map((p) => {
      // Say who is choosing the placements, so a seat on autopilot is never mistaken for
      // a person who has gone quiet.
      const tier = state.config.difficulties?.find((d) => d.id === p.ai)?.label ?? p.ai;
      const tag = p.isBot ? ` · ${tier}` : p.ai ? ` · auto (${tier})` : '';
      return (
        `<div class="lp"><span class="swatch" style="background:${DOG_COLORS.get(p.dogId) ?? '#3a3f47'}"></span>` +
        `<span class="pname">${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</span>` +
        `<span class="pdog">${p.dogId ? escapeHtml(dogName(p.dogId)) : 'choosing…'}${escapeHtml(tag)}</span></div>`
      );
    })
    .join('');

  // The host's seat is empty and I am not in it — the room cannot be started until someone
  // takes over, so offer it rather than leaving everyone waiting on a person who left.
  const canClaim = state.hostAway && !me?.isHost;
  $('claim-host').classList.toggle('hidden', !canClaim);

  // Say exactly what is missing, rather than only refusing on the Start button.
  const min = state.config.minPlayers;
  const hint = !me?.dogId
    ? 'Pick a dog above to join the walk.'
    : withDogs < min
      ? `Waiting for ${min - withDogs} more (${withDogs} of ${min} ready).`
      : canClaim
        ? `${withDogs} ready — the host has left. Claim host to start the match.`
        : !me.isHost
          ? `${withDogs} ready — waiting for the host to start.`
          : withDogs === 1
            ? 'Ready. You can start solo, or wait for others to join.'
            : `${withDogs} dogs ready — start whenever you like.`;
  $('lobby-hint').textContent = hint;

  const canStart = Boolean(me?.isHost) && withDogs >= min;
  $('lobby-start').classList.toggle('hidden', !me?.isHost);
  $('lobby-start').disabled = !canStart;
  $('lobby-start').textContent = over ? 'Play again' : 'Start the match';
}

function renderPlayers() {
  const el = $('players');
  el.innerHTML = '';
  const sorted = [...state.players].sort((a, b) => b.matchScore - a.matchScore);
  for (const p of sorted) {
    const row = document.createElement('div');
    row.className = 'player' + (p.id === you ? ' me' : '') + (p.connected ? '' : ' gone');
    row.innerHTML = `
      <span class="swatch" style="background:${DOG_COLORS.get(p.dogId) ?? '#666'}"></span>
      <span class="pname">${escapeHtml(p.name)}${p.isBot ? ' 🤖' : p.ai ? ' ⚙️' : ''}</span>
      <span class="pdog">${escapeHtml(dogName(p.dogId))}</span>
      <span class="pscore">${p.matchScore}${state.phase === 'score' || state.phase === 'match-end' ? ` (+${p.roundScore})` : ''}</span>
      <span class="plock">${p.locked ? '✓' : ''}</span>`;
    el.appendChild(row);
  }
}

function renderDogPicker() {
  const el = $('dogs');
  // Also at match-end: the room reopens between matches, so anyone who just arrived — or
  // who wants a different breed — has to be able to pick. Without this the overlay said
  // "pick a dog" over an empty space, and a player who joined then was left off the board.
  if (!el || (state.phase !== 'lobby' && state.phase !== 'match-end')) {
    el?.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = '';
  for (const [id, color] of DOG_COLORS) {
    const taken = state.players.find((p) => p.dogId === id);
    const b = document.createElement('button');
    b.className = 'dog' + (taken ? ' taken' : '') + (taken?.id === you ? ' mine' : '');
    b.style.setProperty('--dog', color);
    b.disabled = Boolean(taken) && taken.id !== you;
    b.onclick = () => send({ t: 'pickDog', dogId: id });

    // Show the actual sprite, so you pick a dog rather than a colour swatch. The canvas is
    // taller than the row and overhangs it, so the tallest breeds keep their heads.
    const pic = document.createElement('canvas');
    const w = 60;
    const h = 84;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    pic.width = w * dpr;
    pic.height = h * dpr;
    pic.style.width = `${w}px`;
    pic.style.height = `${h}px`;
    drawDogPortrait(pic.getContext('2d'), w * dpr, h * dpr, {
      spec: DOG_SPECS.get(id) ?? {},
      color,
      dir: 2, // facing the player
    });
    b.appendChild(pic);
    b.appendChild(Object.assign(document.createElement('span'), { textContent: dogName(id) }));
    el.appendChild(b);
  }
}

/** How many rounds the match runs. Host's call, made before starting. */
function renderRoundPicker(isHost) {
  const wrap = $('host-rounds');
  if (!wrap) return;
  wrap.classList.toggle('hidden', !isHost);
  if (!isHost) return;
  const el = $('rounds');
  const max = state.config.maxRounds ?? 3;
  const options = [1, 2, 3].filter((n) => n <= max);
  el.innerHTML = '';
  for (const n of options) {
    const b = document.createElement('button');
    b.className = 'tile' + (state.config.roundsPerMatch === n ? ' sel' : '');
    b.textContent = n;
    b.onclick = () => send({ t: 'setRounds', rounds: n });
    el.appendChild(b);
  }
  const label = document.createElement('span');
  label.className = 'hint';
  label.textContent = `${state.config.roundsPerMatch} round${state.config.roundsPerMatch > 1 ? 's' : ''}`;
  el.appendChild(label);
}

/**
 * Adding and removing computer opponents. Host's call, between matches.
 *
 * The tiers come from the server rather than being listed here, so the lobby can never
 * offer a difficulty the search cannot actually play.
 */
function renderBotPicker(isHost) {
  const wrap = $('host-bots');
  if (!wrap) return;
  wrap.classList.toggle('hidden', !isHost);
  if (!isHost) return;

  const el = $('bots');
  const tiers = state.config.difficulties ?? [];
  const bots = state.players.filter((p) => p.isBot);
  const full = state.players.length >= 8;
  el.innerHTML = '';

  for (const tier of tiers) {
    const b = document.createElement('button');
    b.className = 'tile';
    b.textContent = `+ ${tier.label}`;
    b.disabled = full;
    b.onclick = () => send({ t: 'addBot', difficulty: tier.id });
    el.appendChild(b);
  }
  if (bots.length) {
    const remove = document.createElement('button');
    remove.className = 'tile';
    remove.textContent = `− Remove`;
    remove.onclick = () => send({ t: 'removePlayer', playerId: bots[bots.length - 1].id });
    el.appendChild(remove);
  }

  const label = document.createElement('span');
  label.className = 'hint';
  label.textContent = full
    ? '8 is the limit — opponents take a seat like anyone else.'
    : bots.length
      ? `${bots.length} opponent${bots.length > 1 ? 's' : ''}`
      : 'none';
  el.appendChild(label);

  // Seats whose player has actually gone. Without this they keep a dog for ever, which
  // counts against the eight-player cap and against the board size. `removable` comes from
  // the server, so the button never offers something the room would refuse.
  const ghosts = $('ghosts');
  ghosts.innerHTML = '';
  for (const g of state.players.filter((p) => p.removable && !p.isBot)) {
    const b = document.createElement('button');
    b.className = 'tile';
    b.textContent = `− ${g.name} (left)`;
    b.onclick = () => send({ t: 'removePlayer', playerId: g.id });
    ghosts.appendChild(b);
  }
}

/**
 * Hand your own dog to the computer, or take it back.
 *
 * Available to every player, not just the host: it is your dog. With every seat on
 * autopilot nobody has anything left to place, so the match plays itself and the room
 * becomes something to watch.
 */
function renderAutopilot(me) {
  const wrap = $('autopilot');
  if (!wrap) return;
  wrap.classList.toggle('hidden', !me?.dogId);
  if (!me?.dogId) return;

  const el = $('autopilot-picks');
  el.innerHTML = '';

  const mine = document.createElement('button');
  mine.className = 'tile' + (me.ai ? '' : ' sel');
  mine.textContent = 'I play';
  mine.onclick = () => send({ t: 'setAutopilot', difficulty: null });
  el.appendChild(mine);

  for (const tier of state.config.difficulties ?? []) {
    const b = document.createElement('button');
    b.className = 'tile' + (me.ai === tier.id ? ' sel' : '');
    b.textContent = tier.label;
    b.onclick = () => send({ t: 'setAutopilot', difficulty: tier.id });
    el.appendChild(b);
  }

  const humans = state.players.filter((p) => p.dogId && !p.ai).length;
  const label = document.createElement('span');
  label.className = 'hint';
  label.textContent = !me.ai
    ? 'or let the computer play it'
    : humans === 0
      ? 'watching — nobody is placing tiles'
      : 'the computer is playing your dog';
  el.appendChild(label);
}

const TILE_GLYPH = { N: '↑', E: '→', S: '↓', W: '←', J: '⇧ jump' };

function renderHand() {
  const el = $('hand');
  el.innerHTML = '';
  // A palette, not a hand: every kind is available every turn, forever.
  for (const kind of state.config.palette) {
    const b = document.createElement('button');
    b.className = 'tile' + (selected === kind ? ' sel' : '');
    b.textContent = TILE_GLYPH[kind] ?? kind;
    b.onclick = () => {
      selected = selected === kind ? null : kind;
      renderHand();
    };
    el.appendChild(b);
  }
  if (state.pending) {
    const b = document.createElement('button');
    b.className = 'tile pending';
    b.textContent = `${TILE_GLYPH[state.pending.kind]} @ ${state.pending.x},${state.pending.y} ✕`;
    b.onclick = () => send({ t: 'unplace' });
    el.appendChild(b);
  }
}

const dogName = (id) => (id ? (DOG_NAMES.get(id) ?? id) : 'no dog yet');
let DOG_NAMES = new Map();

function log(text) {
  const el = $('log');
  const line = document.createElement('div');
  line.textContent = text;
  el.prepend(line);
  while (el.children.length > 8) el.lastChild.remove();
}

// --- announcements, timer sound -------------------------------------------------------------

let bannerTimer = null;
let bannerQueue = [];

/** Big animated call-out over the board. Restarts its animation on every call. */
function announce(text, tone = '') {
  bannerQueue = [];
  showBanner(text, tone, 2200);
}

/** Drop the banner and anything queued behind it. */
function clearBanner() {
  bannerQueue = [];
  clearTimeout(bannerTimer);
  $('banner')?.classList.remove('show');
}

function showBanner(text, tone, holdMs) {
  const el = $('banner');
  if (!el) return;
  el.textContent = text;
  el.className = `banner ${tone}`;
  void el.offsetWidth; // force reflow so the animation replays
  el.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    const next = bannerQueue.shift();
    if (next) showBanner(next.text, next.tone, next.hold);
    else el.classList.remove('show');
  }, holdMs);
}

/** Show a run of banners back to back — used to read out the placings. */
function announceSequence(items) {
  bannerQueue = items.slice(1);
  if (items.length) showBanner(items[0].text, items[0].tone, items[0].hold);
}

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

let podiumTimer = null;

/**
 * The scoring phase: each dog takes the whole board in turn, rushing toward the camera with
 * its placing and score, then blowing past. Paced by the server's per-placing time so the
 * read-out and the phase end together.
 */
function announceStandings() {
  const ranked = [...state.players]
    .filter((p) => p.dogId)
    .sort((a, b) => b.matchScore - a.matchScore);
  if (!ranked.length || !$('podium')) return;

  const hold = state.config.scorePerPlacingMs ?? 2600;
  // Last place first, so the round builds to the winner.
  const order = [...ranked].reverse();

  let i = 0;
  const showNext = () => {
    if (i >= order.length) {
      $('podium').classList.remove('show');
      return;
    }
    const p = order[i];
    const place = ranked.indexOf(p);
    showPodium(p, place, ranked.length);
    i += 1;
    podiumTimer = setTimeout(showNext, hold);
  };
  clearTimeout(podiumTimer);
  showNext();
}

function showPodium(player, place, total) {
  const el = $('podium');
  const spec = DOG_SPECS.get(player.dogId) ?? {};
  $('podium-place').textContent = ORDINALS[place] ?? `${place + 1}th`;
  $('podium-name').textContent = player.name;
  $('podium-score').innerHTML = `<b>${player.matchScore}</b> point${player.matchScore === 1 ? '' : 's'}`;
  el.classList.toggle('first', place === 0);

  const cv = $('podium-dog');
  const size = 320;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = size * dpr;
  cv.height = size * dpr;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  drawDogPortrait(ctx, cv.width, cv.height, { spec, color: player.dogId ? DOG_COLORS.get(player.dogId) : '#888', dir: 2 });

  // Restart the animation for each placing.
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  sfx(place === 0 ? 'squirrel' : 'treat');
  if (place === 0 && total > 1) announce('Winner!', 'go');
}

function hidePodium() {
  clearTimeout(podiumTimer);
  $('podium')?.classList.remove('show');
}

/** Browsers only allow audio after a gesture, so this is called from the Join click. */
const unlockAudio = () => unlock();

/** The turn-timer countdown. Distinct from the event sounds in audio.js. */
function chime(kind) {
  if (kind === 'warn') sfx('reveal');
  else sfx('consume');
}

/** Which sound an event makes. Stop events pick by reason. */
const EVENT_SFX = {
  sniff: 'sniff',
  treat: 'treat',
  greet: 'greet',
  bump: 'bump',
  consume: 'consume',
  reveal: 'reveal',
};

function showToast(text) {
  toast = { text, until: performance.now() + 3000 };
  $('toast').textContent = text;
  $('toast').classList.remove('hidden');
  setTimeout(() => $('toast').classList.add('hidden'), 3000);
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// --- frame loop -------------------------------------------------------------------------

function frame(now) {
  requestAnimationFrame(frame);
  if (!state) return;

  fitCanvas();

  let dogs = state.dogs;
  let popups = [];
  let bursts = [];
  let exchanges = [];
  let sniffReactions = [];
  let stopReactions = [];
  // Idle dogs breathe and wag slowly; walking dogs take one leg cycle per tick, so the
  // gait lands exactly on each tile.
  let gait = (now / 1400) % 1;

  if (playback) {
    const elapsed = now - playback.start;
    const idx = Math.floor(elapsed / playback.tickMs);
    const f = (elapsed % playback.tickMs) / playback.tickMs;
    gait = f;

    // Fire popups for each tick exactly once as playback passes it.
    while (playback.seen < Math.min(idx, playback.ticks.length - 1)) {
      playback.seen += 1;
      for (const ev of playback.ticks[playback.seen].events) {
        recordConsumption(ev);
        addPopup(ev, now);
      }
    }

    if (idx >= playback.ticks.length - 1) {
      dogs = playback.ticks.at(-1).dogs;
      if (elapsed > (playback.ticks.length + 6) * playback.tickMs) playback = null;
    } else {
      dogs = interpolate(playback.ticks, idx, f);
    }
    popups = playback
      ? playback.popups
          .map((p) => ({ ...p, age: (now - p.born) / 1200 }))
          .filter((p) => p.age < 1)
      : [];
    if (playback) playback.popups = playback.popups.filter((p) => now - p.born < 1200);
    bursts = playback
      ? playback.bursts.map((b) => ({ ...b, age: (now - b.born) / 600 })).filter((b) => b.age < 1)
      : [];
    if (playback) playback.bursts = playback.bursts.filter((b) => now - b.born < 600);
    exchanges = playback
      ? playback.exchanges
          .map((e) => ({ ...e, age: (now - e.born) / TREAT_EXCHANGE_MS }))
          .filter((e) => e.age < 1)
      : [];
    if (playback)
      playback.exchanges = playback.exchanges.filter((e) => now - e.born < TREAT_EXCHANGE_MS);
    sniffReactions = playback
      ? playback.sniffReactions
          .map((e) => ({ ...e, age: (now - e.born) / SNIFF_REACTION_MS }))
          .filter((e) => e.age < 1)
      : [];
    if (playback)
      playback.sniffReactions = playback.sniffReactions.filter(
        (e) => now - e.born < SNIFF_REACTION_MS,
      );
    stopReactions = playback
      ? playback.stopReactions
          .map((e) => ({ ...e, age: (now - e.born) / STOP_REACTION_MS[e.reason] }))
          .filter((e) => e.age < 1)
      : [];
    if (playback)
      playback.stopReactions = playback.stopReactions.filter(
        (e) => now - e.born < STOP_REACTION_MS[e.reason],
      );
  }

  // Secret tiles the walk has revealed so far get drawn alongside the public ones, minus
  // any that have already been spent.
  const { sniffed, spent, taken, usedTiles } = consumed;
  const tiles = [...state.tiles, ...revealedTiles()].filter((t) => !usedTiles.has(`${t.x},${t.y}`));
  const dogIdOf = (playerId) => state.players.find((p) => p.id === playerId)?.dogId;

  draw(canvas, {
    map: state.map,
    tiles,
    dogs,
    pending: MODE === 'player' ? state.pending : null,
    you,
    hover,
    selecting: Boolean(selected),
    legal: legalHere(hover),
    stamina: state.config.stamina,
    popups,
    gait,
    spent,
    sniffed,
    taken,
    bursts,
    exchanges,
    sniffReactions,
    stopReactions,
    animationMs: now,
    colorFor: (playerId) => DOG_COLORS.get(dogIdOf(playerId)) ?? '#8b8c89',
    specFor: (playerId) => DOG_SPECS.get(dogIdOf(playerId)) ?? {},
  });

  const t = $('timer');
  // Scoring runs as long as the read-out takes, so a countdown there is meaningless.
  if (state.deadline && state.phase !== 'score') {
    const secs = Math.ceil(Math.max(0, state.deadline - Date.now()) / 1000);
    t.textContent = `${secs}`;
    t.classList.toggle('warn', secs <= 10 && secs > 5);
    t.classList.toggle('urgent', secs <= 5);
    t.classList.remove('hidden');

    // Count down audibly, but only at someone who still has a decision to make.
    const me = state.players.find((p) => p.id === you);
    const needsToAct = state.phase === 'place' && MODE === 'player' && me?.dogId && !me.locked;
    if (secs !== lastSecond) {
      if (needsToAct && secs === 10) chime('warn');
      if (needsToAct && secs <= 5 && secs >= 1) chime('tick');
      if (needsToAct && secs === 5) announce('5 seconds!', 'urgent');
      lastSecond = secs;
    }
  } else {
    t.textContent = '';
    t.classList.add('hidden');
    t.classList.remove('warn', 'urgent');
    lastSecond = -1;
  }
}

/** Secret tiles a dog has stepped on. Persists past playback for the same reason. */
const revealedTiles = () => consumed.revealed;

/**
 * What the walk used up: diminished sniff spots, taken treats, spent tiles.
 *
 * These outlive `playback`. The walk payload is discarded a few seconds after it finishes,
 * and deriving this from it meant every spent tile popped back onto the board the moment
 * playback was dropped — right as the scoring phase began. Cleared when the next round sets
 * up, which is when the server clears the tiles for real.
 */
const consumed = {
  sniffed: new Set(),
  spent: new Set(),
  taken: new Set(),
  usedTiles: new Set(),
  revealed: [],
};

function resetConsumed() {
  consumed.sniffed.clear();
  consumed.spent.clear();
  consumed.taken.clear();
  consumed.usedTiles.clear();
  consumed.revealed = [];
}

function recordConsumption(ev) {
  // order 1 is the second dog, after which a sniff spot is worth nothing.
  if (ev.t === 'sniff' && ev.order === 0) consumed.sniffed.add(`${ev.x},${ev.y}`);
  else if (ev.t === 'sniff' && ev.order >= 1) consumed.spent.add(`${ev.x},${ev.y}`);
  else if (ev.t === 'treat') consumed.taken.add(`${ev.x},${ev.y}`);
  else if (ev.t === 'consume') consumed.usedTiles.add(`${ev.x},${ev.y}`);
  else if (ev.t === 'reveal') consumed.revealed.push({ x: ev.x, y: ev.y, kind: ev.kind, ownerId: null });
}

function addPopup(ev, now) {
  const push = (x, y, text, points) => playback.popups.push({ x, y, text, points, born: now });

  // Sound is driven off the same events as the visuals, so they can never drift apart.
  if (ev.t === 'stop') sfx(ev.reason);
  else if (ev.t === 'sniff' && ev.points === 0) sfx('bump');
  else sfx(EVENT_SFX[ev.t]);

  if (ev.t === 'treat') {
    // Nudge the pair apart for a moment: the dog and the person share one tile, and the
    // treat is on the person's screen-right, so separating them puts the exchange between
    // them instead of drawing one on top of the other.
    playback.exchanges.push({ x: ev.x, y: ev.y, born: now });
  }
  if (ev.t === 'sniff') playback.sniffReactions.push({ x: ev.x, y: ev.y, born: now });
  if (ev.t === 'stop' && STOP_REACTION_MS[ev.reason]) {
    playback.stopReactions.push({ x: ev.x, y: ev.y, reason: ev.reason, born: now });
  }

  if (ev.t === 'consume') {
    // The tile fired and is gone. Burst where it was so the disappearance is legible.
    const dogId = state.players.find((p) => p.id === ev.dogId)?.dogId;
    playback.bursts.push({
      x: ev.x,
      y: ev.y,
      kind: ev.kind,
      color: DOG_COLORS.get(dogId) ?? '#fff',
      born: now,
    });
    return;
  }
  if (ev.t === 'sniff' && ev.points > 0) push(ev.x, ev.y, `+${ev.points}`, ev.points);
  else if (ev.t === 'treat') push(ev.x, ev.y, `treat +${ev.points}`, ev.points);
  else if (ev.t === 'greet') push(ev.x, ev.y, `hello! +${ev.points}`, ev.points);
  else if (ev.t === 'reveal') push(ev.x, ev.y, 'secret!', 1);
  else if (ev.t === 'stop') {
    const label = { squirrel: 'squirrel! +5', lake: 'splash! -2', drain: 'stopped', tuckered: 'tuckered out', stuck: 'stuck', tail: 'chasing tail' }[ev.reason];
    push(ev.x, ev.y, label, ev.points);
  }
}

function fitCanvas() {
  const box = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Clamp to the viewport as well as the parent. On a phone the parent can be reported
  // larger than the screen for a frame during layout or an orientation change, and sizing
  // off that alone is what made the board flash oversized before snapping back.
  const size = Math.max(
    120,
    Math.floor(Math.min(box.width, box.height, window.innerWidth, window.innerHeight)),
  );
  if (canvas.width === size * dpr) return;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
}

addEventListener('resize', fitCanvas);
addEventListener('orientationchange', () => setTimeout(fitCanvas, 150));

// --- boot ---------------------------------------------------------------------------------

// A different suggestion each time the page loads; blank submits the suggestion.
if ($('name')) $('name').placeholder = randomName();
if ($('wordmark')) drawWordmark($('wordmark'), 'Sniffari', MODE === 'board' ? 40 : 30);

if (localStorage.getItem('sniffari.muted') === '1') {
  setMuted(true);
  if ($('mute')) $('mute').textContent = '🔇';
}

const dogs = await fetch('/dogs.json').then((r) => r.json());
// Atlas rows follow the server's DOGS order; see art/chibi-dogs/HANDOFF.md.
dogs.forEach((d, i) => {
  d.atlasRow = i;
});
DOG_COLORS = new Map(dogs.map((d) => [d.id, d.color]));
DOG_NAMES = new Map(dogs.map((d) => [d.id, d.name]));
DOG_SPECS = new Map(dogs.map((d) => [d.id, d]));

// Wait for the character sheets before the first paint, so neither dogs nor people visibly
// swap from procedural fallbacks after the board appears. Each falls through independently
// if its file is missing.
await Promise.all([whenReady(dogSheet), whenReady(peopleSheet), whenReady(entitySheet)]);

connect(resume);
requestAnimationFrame(frame);
