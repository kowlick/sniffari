import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CONFIG } from '../src/config.ts';
import { loadMap } from '../src/sim/map.ts';
import { key, type PlacedTile } from '../src/sim/types.ts';
import { Room, makeBoard, type Board, type Connection } from '../src/server/room.ts';
import {
  candidates,
  legalSquares,
  scoresWith,
  valueOf,
  valueOfPlacement,
} from '../src/server/ai/evaluate.ts';
import { chooseMove, budgetFor } from '../src/server/ai/bot.ts';
import { makeRng } from '../src/server/ai/rng.ts';
import { buildView } from '../src/server/ai/view.ts';

const ROOT = join(import.meta.dirname, '..');
const silent: Connection = { send() {} };

async function boards(): Promise<Board[]> {
  return Promise.all(
    CONFIG.boards.map(async (b) => makeBoard(b, await loadMap(join(ROOT, 'maps', b.file), b.name))),
  );
}

const seat = (room: Room, name: string, dogId: string) => {
  const p = room.addPlayer(name, silent);
  assert.ok(!('error' in p), `${name} could not join`);
  assert.equal(room.pickDog((p as { id: string }).id, dogId), null);
  return p as { id: string };
};

/** A room in mid-round, sitting on a placement turn with a live view available. */
async function playing() {
  const room = new Room(await boards());
  const host = seat(room, 'Ada', 'beagle');
  const foe = seat(room, 'Bo', 'labrador');
  assert.equal(room.start(host.id), null);
  // start() lands in 'setup'; step to the first placement turn without waiting on timers.
  room.phase = 'place';
  room.turn = 1;
  return { room, host, foe };
}

// --- the information boundary -------------------------------------------------------

/**
 * The one that matters. A bot runs inside the server with `secretTiles` in scope, and a
 * bot that could read them would be cheating undetectably. The view is built from the
 * client payload precisely so that cannot happen; this test fails if that ever stops
 * being true.
 */
test('a bot cannot see secret tiles', async () => {
  const { room, host } = await playing();

  const before = room.viewFor(host.id);
  assert.ok(before, 'the host should have a view');
  const beforeCount = before.tiles.size;

  // Plant a secret tile the way the secret turn does, straight into the room's private map.
  const secret = room as unknown as { secretTiles: Map<string, PlacedTile> };
  const target = legalSquares(before)[0]!;
  secret.secretTiles.set(key(target.x, target.y), {
    kind: 'J',
    ownerId: 'somebody',
    secret: true,
  });

  const after = room.viewFor(host.id);
  assert.ok(after);
  assert.equal(after.tiles.size, beforeCount, 'the secret tile must not appear in the view');
  assert.equal(
    after.tiles.has(key(target.x, target.y)),
    false,
    'the bot must not know that square is taken',
  );
  // And it still believes it may place there, exactly as a human would.
  assert.ok(
    legalSquares(after).some((s) => s.x === target.x && s.y === target.y),
    'the square should still look free to the bot, as it does to a player',
  );
});

test("a bot cannot see other players' pending placements", async () => {
  const { room, host, foe } = await playing();
  const square = legalSquares(room.viewFor(host.id)!)[3]!;
  assert.equal(room.place(foe.id, square.x, square.y, 'N'), null);

  const view = room.viewFor(host.id)!;
  assert.equal(
    view.tiles.has(key(square.x, square.y)),
    false,
    'a placement that has not been revealed yet is invisible',
  );
});

test('a view carries no start markers, because the wire format has none', async () => {
  const { room, host } = await playing();
  const view = room.viewFor(host.id)!;
  assert.deepEqual(view.map.starts, [], 'starts are stripped by boardRows and stay stripped');
  assert.equal(view.dogs.length, 2, 'dog positions come from the payload instead');
  assert.ok(view.map.width > 0 && view.map.height > 0);
});

// --- legality ------------------------------------------------------------------------

/**
 * `legalSquares` mirrors `Room.illegalSquare` by hand, because the bot only knows what the
 * payload told it and cannot call the server's own check. If the two ever drift, a bot
 * silently forfeits turns — `place()` refuses it and nothing says why.
 */
test('every square a bot considers is one the room would actually accept', async () => {
  const { room, host } = await playing();
  const view = room.viewFor(host.id)!;
  const squares = legalSquares(view);
  assert.ok(squares.length > 10, 'there should be plenty of room to place');

  for (const s of squares) {
    assert.equal(
      room.place(host.id, s.x, s.y, 'N'),
      null,
      `the room rejected ${s.x},${s.y} but the bot thought it was legal`,
    );
  }
});

test('a bot never proposes a move the room refuses', async () => {
  const { room, host } = await playing();
  const view = room.viewFor(host.id)!;
  const rng = makeRng(7);
  for (let i = 0; i < 8; i++) {
    const move = await chooseMove(view, 'scout', Date.now() + 400, rng);
    assert.ok(move, 'a bot should find something to place');
    assert.equal(room.place(host.id, move.x, move.y, move.kind), null);
  }
});

// --- the search itself ----------------------------------------------------------------

test('a bot picks a placement that measurably improves its own round', async () => {
  const { room, host } = await playing();
  const view = room.viewFor(host.id)!;
  const rng = makeRng(11);

  const before = valueOf(view, scoresWith(view, view.tiles), 0);
  const move = await chooseMove(view, 'scout', Date.now() + 2000, rng);
  assert.ok(move);

  const tiles = new Map(view.tiles);
  tiles.set(key(move.x, move.y), { kind: move.kind, ownerId: view.playerId, secret: false });
  const after = valueOf(view, scoresWith(view, tiles), 0);

  assert.ok(
    after >= before,
    `Scout should not choose a placement that costs it points (${before} -> ${after})`,
  );
});

/**
 * The reproducibility contract is per seed, not per board.
 *
 * Scout takes the argmax, but early in a round most placements change nothing and score
 * identically, so ties are common. Candidates are shuffled before scoring precisely so
 * that ties do not always resolve to the top-left square — without it Scout opens in the
 * same corner every single game. That makes the seed part of the input.
 */
test('the same seed replays the same move; a different seed may break a tie elsewhere', async () => {
  const { room, host } = await playing();
  const view = room.viewFor(host.id)!;

  const a = await chooseMove(view, 'scout', Date.now() + 2000, makeRng(42));
  const b = await chooseMove(view, 'scout', Date.now() + 2000, makeRng(42));
  assert.deepEqual(a, b, 'a match must be replayable from its seed');
});

test('Scout always takes a best-valued move; Pup deliberately does not', async () => {
  const { room, host } = await playing();
  const view = room.viewFor(host.id)!;

  // Whatever tie Scout breaks, the move it returns must be worth as much as the best one
  // on the board. That is the real contract, and it holds regardless of seed.
  const best = Math.max(...candidates(view).map((c) => valueOfPlacement(view, c, 0.25)));
  for (const seed of [1, 2, 999]) {
    const m = await chooseMove(view, 'scout', Date.now() + 4000, makeRng(seed));
    assert.equal(valueOfPlacement(view, m!, 0.25), best, 'Scout settled for less than the best');
  }

  // Pup samples part of the board and picks softmax-weighted among what it saw, so over
  // eight draws an identical result would mean the temperature is doing nothing.
  const picks = new Set<string>();
  for (let s = 0; s < 8; s++) {
    const m = await chooseMove(view, 'pup', Date.now() + 2000, makeRng(s + 1));
    picks.add(`${m!.x},${m!.y},${m!.kind}`);
  }
  assert.ok(picks.size > 1, 'Pup should not always play the same move');
});

test('a bot honours its deadline', async () => {
  const { room, host } = await playing();
  const view = room.viewFor(host.id)!;
  assert.ok(candidates(view).length > 100, 'this board should be big enough to matter');

  const t0 = Date.now();
  const move = await chooseMove(view, 'scout', t0 + 1, makeRng(3));
  const elapsed = Date.now() - t0;
  assert.ok(move, 'an expired budget still yields a move, just a worse-considered one');
  assert.ok(elapsed < 250, `a 1ms budget should not take ${elapsed}ms`);
});

test('the turn budget is shared out, not handed to each bot', () => {
  const many = budgetFor(['scout', 'scout', 'scout', 'scout']);
  assert.equal(many.length, 4);
  const total = many.reduce((a, b) => a + b, 0);
  assert.ok(
    total <= CONFIG.ai.turnBudgetMs + 4 * CONFIG.ai.minBudgetMs,
    `four bots should share the budget, not multiply it (got ${total}ms)`,
  );

  // A lone bot gets the lot whatever its tier — weight only decides how a *shared* budget
  // is split, so the comparison only means anything within one team.
  const mixed = budgetFor(['pup', 'scout']);
  assert.ok(mixed[0]! < mixed[1]!, 'the stronger tier should get the larger slice');

  // Eight opponents must still each be able to think.
  const full = budgetFor(['pup', 'pup', 'pup', 'pup', 'scout', 'scout', 'scout', 'scout']);
  for (const b of full) assert.ok(b >= CONFIG.ai.minBudgetMs);
});

test('buildView refuses a spectator payload', async () => {
  const { room } = await playing();
  const state = room.stateFor(null);
  assert.equal(state.t, 'state');
  assert.equal(buildView(state as never), null, 'nobody to build a view for');
});

// --- the driver ------------------------------------------------------------------------

/**
 * A room on an open placement turn with one seat left deliberately in human hands.
 *
 * That last seat is the point: once *every* seat has locked the turn resolves and clears
 * both `pending` and `locked`, so a test that inspects them afterwards is reading state
 * the room has already tidied away. Leaving one player un-automated holds the turn open.
 */
async function openTurn() {
  const room = new Room(await boards());
  const watcher = seat(room, 'Ada', 'beagle'); // host, keeps playing by hand
  const auto = seat(room, 'Bo', 'labrador');
  assert.equal(room.addBot(watcher.id, 'scout'), null);
  assert.equal(room.addBot(watcher.id, 'pup'), null);
  assert.equal(room.start(watcher.id), null);

  room.phase = 'place';
  room.turn = 1;
  for (const p of room.players.values()) {
    p.locked = false;
    p.pending = null;
  }
  return { room, watcher, auto };
}

/** Let the driver finish; it yields to the event loop between chunks of the sweep. */
async function settle(room: Room) {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setImmediate(r));
    const pending = [...room.players.values()].filter((p) => p.ai && !p.locked);
    if (pending.length === 0) return;
  }
}

/**
 * Every computer-controlled seat must actually take its turn — bots and autopiloted humans
 * alike. A seat that is quietly skipped still gets a dog and a score, so the failure looks
 * like bad luck rather than a bug.
 */
test('every computer-controlled seat places and locks, bot or autopilot', async () => {
  const { room, watcher, auto } = await openTurn();
  assert.equal(room.setAutopilot(auto.id, 'pup'), null);
  await settle(room);

  assert.equal(room.phase, 'place', 'the human seat should still be holding the turn open');
  for (const p of room.players.values()) {
    if (p.id === watcher.id) {
      assert.equal(p.locked, false, 'the seat still played by a person is untouched');
      assert.equal(p.pending, null);
      continue;
    }
    assert.ok(p.locked, `${p.name} never locked in`);
    assert.ok(p.pending, `${p.name} locked without placing anything`);
  }

  // Deliberately not asserting three *distinct* squares. Two bots wanting the same one is a
  // legal outcome — it collides into a scuff — and on the 8x8 board, where a turn offers
  // only a few dozen legal squares to four dogs, it happens often.
  const placed = [...room.players.values()].filter((p) => p.pending);
  assert.equal(placed.length, 3, 'three computer seats should each have chosen a square');
});

test('an autopiloted human is searched exactly as hard as a bot is', async () => {
  const { room, auto } = await openTurn();
  assert.equal(room.setAutopilot(auto.id, 'scout'), null);
  await settle(room);

  // The autopiloted human and the Scout bot ran the same search at the same tier, so
  // neither should have settled for less than the best move on the board.
  const scouts = [...room.players.values()].filter((p) => p.ai === 'scout');
  assert.equal(scouts.length, 2, 'one autopiloted human and one Scout bot');
  for (const p of scouts) {
    const view = room.viewFor(p.id)!;
    const best = Math.max(...candidates(view).map((c) => valueOfPlacement(view, c, 0.25)));
    assert.ok(p.pending, `${p.name} placed nothing`);
    assert.equal(
      valueOfPlacement(view, p.pending!, 0.25),
      best,
      `${p.name} (${p.kind}) settled for less than the best move`,
    );
  }
});

test('taking a dog back off autopilot stops the computer playing it', async () => {
  const { room, auto } = await openTurn();
  assert.equal(room.setAutopilot(auto.id, 'scout'), null);
  await settle(room);
  assert.ok(room.players.get(auto.id)!.pending, 'the computer took the turn');

  assert.equal(room.setAutopilot(auto.id, null), null);
  assert.equal(room.players.get(auto.id)!.ai, null, 'and hands it straight back');
});
