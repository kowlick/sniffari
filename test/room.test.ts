import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CONFIG } from '../src/config.ts';
import { loadMap } from '../src/sim/map.ts';
import { TILE } from '../src/sim/types.ts';
import { Room, boardRows, type Board, type Connection } from '../src/server/room.ts';
import type { ServerMessage } from '../src/server/protocol.ts';

const ROOT = join(import.meta.dirname, '..');
const silent: Connection = { send() {} };

async function boards(): Promise<Board[]> {
  return Promise.all(
    CONFIG.boards.map(async (b) => {
      const map = await loadMap(join(ROOT, 'maps', b.file), b.name);
      return {
        name: b.name,
        stamina: b.stamina,
        maxPlayers: b.maxPlayers,
        size: b.size,
        map,
        rows: boardRows(map),
      };
    }),
  );
}

const seat = (room: Room, name: string, dogId: string) => {
  const p = room.addPlayer(name, silent);
  assert.ok(!('error' in p), `${name} could not join`);
  assert.equal(room.pickDog((p as { id: string }).id, dogId), null);
  return p as { id: string };
};

test('players can join and pick dogs between matches, but not mid-match', async () => {
  const room = new Room(await boards());
  seat(room, 'Ada', 'beagle');

  // The gap between matches is the whole point: someone who wandered over during the last
  // round should be able to get in for the next one.
  room.phase = 'match-end';
  const late = room.addPlayer('Bo', silent);
  assert.ok(!('error' in late), 'joining at match-end should be allowed');
  assert.equal(room.pickDog((late as { id: string }).id, 'labrador'), null, 'and pick a dog');

  room.phase = 'place';
  const tooLate = room.addPlayer('Cy', silent);
  assert.ok('error' in tooLate, 'joining mid-match should be refused');
});

test('a rematch re-picks the board for the new player count', async () => {
  const room = new Room(await boards());
  seat(room, 'Ada', 'beagle');
  seat(room, 'Bo', 'labrador');
  assert.equal(room.board.name, 'small', 'two players start on the small board');

  const host = [...room.players.values()][0]!;
  assert.equal(room.start(host.id), null);
  assert.equal(room.board.name, 'small', 'board is frozen for the match');

  // Five more join for the rematch. The frozen board must be released, or everyone plays
  // the two-player board.
  room.phase = 'match-end';
  for (const dogId of ['cockapoo', 'wolfhound', 'aussie-bw', 'doodle-lab', 'doodle-poodle'])
    seat(room, dogId, dogId);
  assert.equal(room.start(host.id), null, 'rematch starts');
  assert.equal(room.board.name, 'large', 'seven players get the large board');
});

test('unused start squares are placeable; occupied ones are not', async () => {
  const room = new Room(await boards());
  const ada = seat(room, 'Ada', 'beagle');
  room.phase = 'place';

  // Ada holds seat 0. Every other start slot is empty ground in a one-player game.
  const mine = room.map.starts[0]!;
  const other = room.map.starts[3]!;

  assert.match(
    room.place(ada.id, mine.x, mine.y, TILE.N) ?? '',
    /dog is standing/i,
    'cannot place under a dog',
  );
  assert.equal(room.place(ada.id, other.x, other.y, TILE.N), null, 'empty start slot is fine');
});

test('each match gets a freshly generated map', async () => {
  const room = new Room(await boards());
  const ada = seat(room, 'Ada', 'beagle');
  const shipped = room.map.terrain.join('');

  assert.equal(room.start(ada.id), null);
  const first = room.map.terrain.join('');
  assert.notEqual(first, shipped, 'the match should not just replay the shipped map');
  assert.equal(room.map.width, 10, 'still the right board size for one player');

  room.phase = 'match-end';
  assert.equal(room.start(ada.id), null);
  const second = room.map.terrain.join('');
  assert.notEqual(second, first, 'a rematch should be somewhere new');
});

test('the map is stable across the rounds within one match', async () => {
  const room = new Room(await boards());
  const ada = seat(room, 'Ada', 'beagle');
  assert.equal(room.start(ada.id), null);
  const during = room.map.terrain.join('');
  // Knowing the ground is most of the skill, so it must not move between rounds.
  room.broadcast();
  assert.equal(room.map.terrain.join(''), during);
});

test('only the host sets the match length, and only between matches', async () => {
  const room = new Room(await boards());
  const host = seat(room, 'Ada', 'beagle');
  const other = seat(room, 'Bo', 'labrador');

  assert.equal(room.setRounds(host.id, 2), null);
  assert.equal(room.roundsPerMatch, 2);

  assert.match(room.setRounds(other.id, 1) ?? '', /host/i, 'guests cannot change it');
  assert.equal(room.roundsPerMatch, 2);

  assert.ok(room.setRounds(host.id, 0), 'zero rounds is refused');
  assert.ok(room.setRounds(host.id, CONFIG.round.maxRounds + 1), 'past the cap is refused');
  assert.equal(room.roundsPerMatch, 2, 'and a refusal leaves it alone');

  assert.equal(room.start(host.id), null);
  assert.match(room.setRounds(host.id, 2) ?? '', /already started/i);
});

test('the host can end a match early, and scores stand', async () => {
  const room = new Room(await boards());
  const host = seat(room, 'Ada', 'beagle');
  const other = seat(room, 'Bo', 'labrador');
  assert.equal(room.start(host.id), null);

  assert.match(room.endMatch(other.id) ?? '', /host/i, 'guests cannot end it');
  assert.notEqual(room.phase, 'match-end');

  assert.equal(room.endMatch(host.id), null);
  assert.equal(room.phase, 'match-end');
  // Ending is "we're done", not "throw it away" — the room must be replayable.
  assert.equal(room.endMatch(host.id), 'No match is running.');
  assert.equal(room.start(host.id), null, 'and a new match can start from there');
});

test('solo is allowed to start', async () => {
  const room = new Room(await boards());
  const ada = seat(room, 'Ada', 'beagle');
  assert.equal(room.start(ada.id), null);
  assert.notEqual(room.phase, 'lobby');
});

// --- the host seat ------------------------------------------------------------------

/**
 * A lobby whose host closed their tab is unstartable, and nobody in it has the authority
 * to fix that — so the seat has to become claimable. The grace period is what keeps a host
 * who merely reloaded the page from losing the room.
 */
test('the host seat opens up once the host has been gone past the grace period', async () => {
  const room = new Room(await boards());
  // Distinct connections: dropConnection matches by identity, and the shared `silent`
  // would drop everybody at once.
  const hostConn: Connection = { send() {} };
  const guestConn: Connection = { send() {} };
  const host = room.addPlayer('Ada', hostConn) as { id: string };
  const guest = room.addPlayer('Bo', guestConn) as { id: string };
  assert.equal(room.pickDog(host.id, 'beagle'), null);
  assert.equal(room.pickDog(guest.id, 'labrador'), null);
  assert.equal(room.hostId, host.id, 'first in the door hosts');
  assert.equal(room.hostAway, false);

  room.dropConnection(hostConn);
  assert.equal(room.hostAway, false, 'a socket that just dropped is still within grace');
  assert.match(room.claimHost(guest.id) ?? '', /still here/i);
  assert.equal(room.hostId, host.id);

  room.hostAwaySince = Date.now() - CONFIG.lobby.hostGraceMs - 1;
  assert.equal(room.hostAway, true);
  assert.equal(room.claimHost(guest.id), null, 'anyone left in the room may take over');
  assert.equal(room.hostId, guest.id);
  assert.equal(room.hostAway, false, 'and the seat is filled again');
  assert.equal(room.start(guest.id), null, 'which is the whole point — the game can start');
});

test('a host who reconnects inside the grace period keeps the room', async () => {
  const room = new Room(await boards());
  const hostConn: Connection = { send() {} };
  const host = room.addPlayer('Ada', hostConn) as { id: string; token: string };
  room.addPlayer('Bo', { send() {} });

  room.dropConnection(hostConn);
  assert.ok(room.hostAwaySince !== null);
  const back: Connection = { send() {} };
  assert.ok(!('error' in room.rejoin(host.token, back)), 'rejoin by token works');
  assert.equal(room.hostAwaySince, null, 'the clock is cleared');
  assert.equal(room.hostId, host.id);
  assert.equal(room.hostAway, false);
});

test('a claimed room is not handed back when the old host returns', async () => {
  const room = new Room(await boards());
  const hostConn: Connection = { send() {} };
  const host = room.addPlayer('Ada', hostConn) as { id: string; token: string };
  const guest = room.addPlayer('Bo', { send() {} }) as { id: string };

  room.dropConnection(hostConn);
  room.hostAwaySince = Date.now() - CONFIG.lobby.hostGraceMs - 1;
  assert.equal(room.claimHost(guest.id), null);

  assert.ok(!('error' in room.rejoin(host.token, { send() {} })));
  assert.equal(room.hostId, guest.id, 'the seat stays with whoever picked it up');
  assert.match(room.start(host.id) ?? '', /host/i);
  assert.equal(room.claimHost(host.id) ?? '', 'The host is still here.');
});

test('claiming is refused while the host is present, and is a no-op for the host', async () => {
  const room = new Room(await boards());
  const host = seat(room, 'Ada', 'beagle');
  const guest = seat(room, 'Bo', 'labrador');
  assert.match(room.claimHost(guest.id) ?? '', /still here/i);
  assert.match(room.claimHost(host.id) ?? '', /already the host/i);
  assert.equal(room.hostId, host.id);
});

// --- computer opponents ---------------------------------------------------------------

test('bots take seats and dogs, and only the host may add or remove them', async () => {
  const room = new Room(await boards());
  const host = seat(room, 'Ada', 'beagle');
  const guest = seat(room, 'Bo', 'labrador');

  assert.match(room.addBot(guest.id, 'scout') ?? '', /host/i, 'guests cannot add opponents');
  assert.equal(room.addBot(host.id, 'scout'), null);
  assert.equal(room.players.size, 3);

  const bot = [...room.players.values()].find((p) => p.kind === 'bot')!;
  assert.ok(bot.dogId, 'a bot gets a dog, or it is not playing');
  assert.notEqual(bot.dogId, 'beagle');
  assert.notEqual(bot.dogId, 'labrador');
  assert.equal(bot.ai, 'scout');

  assert.match(room.removePlayer(guest.id, bot.id) ?? '', /host/i);
  assert.match(room.removePlayer(host.id, host.id) ?? '', /yourself/i);
  assert.match(room.removePlayer(host.id, guest.id) ?? '', /still connected/i);
  assert.equal(room.removePlayer(host.id, bot.id), null);
  assert.equal(room.players.size, 2);
});

/**
 * A bot has no socket, and `conn === null` otherwise means "this player dropped". Getting
 * this wrong greys out every opponent as though the whole table had walked off.
 */
test('a bot is never absent, never rejoinable, and never the host', async () => {
  const room = new Room(await boards());
  const host = seat(room, 'Ada', 'beagle');
  assert.equal(room.addBot(host.id, 'pup'), null);
  const bot = [...room.players.values()].find((p) => p.kind === 'bot')!;

  const state = room.stateFor(host.id);
  assert.equal(state.t, 'state');
  const wire = (state as Extract<typeof state, { t: 'state' }>).players.find((p) => p.id === bot.id)!;
  assert.equal(wire.connected, true, 'a bot with no socket is present, not disconnected');
  assert.equal(wire.isBot, true);
  assert.equal(wire.ai, 'pup');

  // A bot's token is not a session anyone may resume.
  assert.ok('error' in room.rejoin(bot.token, silent), 'a bot token must not open a seat');

  // And the host seat is never a machine's, even once the real host has gone.
  assert.equal(room.hostId, host.id);
  assert.match(room.claimHost(bot.id) ?? '', /cannot host/i);
  room.dropConnection(silent);
  room.hostAwaySince = Date.now() - CONFIG.lobby.hostGraceMs - 1;
  assert.equal(room.hostAway, true);
  assert.equal(room.hostId, host.id, 'the seat stays empty rather than falling to the bot');
});

test('a bot dropping out is not what dropConnection is for', async () => {
  const room = new Room(await boards());
  const hostConn: Connection = { send() {} };
  const host = room.addPlayer('Ada', hostConn) as { id: string };
  assert.equal(room.pickDog(host.id, 'beagle'), null);
  assert.equal(room.addBot(host.id, 'scout'), null);

  room.dropConnection(hostConn);
  const bot = [...room.players.values()].find((p) => p.kind === 'bot')!;
  assert.equal(bot.conn, null, 'a bot never had a connection to lose');
  assert.equal(room.hostId, host.id, 'and dropping a human does not disturb the bot');
});

/** A person always beats a machine for a seat. */
test('a full lobby stands a bot up rather than turning a human away', async () => {
  const room = new Room(await boards());
  const host = seat(room, 'Ada', 'beagle');
  for (let i = 1; i < CONFIG.lobby.maxPlayers; i++) {
    assert.equal(room.addBot(host.id, i === 1 ? 'scout' : 'pup'), null, `bot ${i}`);
  }
  assert.equal(room.players.size, CONFIG.lobby.maxPlayers);
  assert.equal(room.addBot(host.id, 'pup'), 'That game is full (8 players).');

  const late = room.addPlayer('Bo', silent);
  assert.ok(!('error' in late), 'a human must still get in');
  assert.equal(room.players.size, CONFIG.lobby.maxPlayers, 'and the room is still capped at 8');

  const tiers = [...room.players.values()].filter((p) => p.kind === 'bot').map((p) => p.ai);
  assert.ok(tiers.includes('scout'), 'the strongest opponent should have survived the eviction');
});

test('a player can hand their own dog to the computer, but not anyone else s', async () => {
  const room = new Room(await boards());
  const host = seat(room, 'Ada', 'beagle');
  const guest = seat(room, 'Bo', 'labrador');

  assert.equal(room.setAutopilot(host.id, 'scout'), null);
  assert.equal(room.players.get(host.id)!.ai, 'scout');
  assert.equal(room.players.get(host.id)!.kind, 'human', 'autopilot does not make you a bot');
  assert.equal(room.players.get(guest.id)!.ai, null, 'and it does not touch anybody else');

  // Handing it back.
  assert.equal(room.setAutopilot(host.id, null), null);
  assert.equal(room.players.get(host.id)!.ai, null);

  assert.match(room.setAutopilot(host.id, 'nope' as never) ?? '', /difficulty/i);
});

/**
 * Nothing ever removed a player. Closing a tab only nulled the socket, so a seat kept its
 * dog forever — against the eight-player cap and against the board size, which follows the
 * number of dogs. A host who wanted to play alone had no way to get there.
 */
test('the host can clear out a seat whose player has actually gone', async () => {
  const room = new Room(await boards());
  const hostConn: Connection = { send() {} };
  const ghostConn: Connection = { send() {} };
  const host = room.addPlayer('Ada', hostConn) as { id: string };
  assert.equal(room.pickDog(host.id, 'beagle'), null);
  const ghost = room.addPlayer('Watcher', ghostConn) as { id: string };
  assert.equal(room.pickDog(ghost.id, 'labrador'), null);

  assert.match(room.removePlayer(host.id, ghost.id) ?? '', /still connected/i);

  room.dropConnection(ghostConn);
  assert.match(
    room.removePlayer(host.id, ghost.id) ?? '',
    /reconnecting/i,
    'a socket that just dropped may only be reloading',
  );

  room.players.get(ghost.id)!.awaySince = Date.now() - CONFIG.lobby.hostGraceMs - 1;
  assert.equal(room.removePlayer(host.id, ghost.id), null);
  assert.equal(room.players.size, 1, 'and the host is alone, which was the point');
  assert.equal(room.start(host.id), null, 'solo play is reachable again');
});

test('removability is published, so the button cannot promise what the room refuses', async () => {
  const room = new Room(await boards());
  const hostConn: Connection = { send() {} };
  const ghostConn: Connection = { send() {} };
  const host = room.addPlayer('Ada', hostConn) as { id: string };
  room.pickDog(host.id, 'beagle');
  const ghost = room.addPlayer('Watcher', ghostConn) as { id: string };
  assert.equal(room.addBot(host.id, 'pup'), null);

  const wire = () => {
    const s = room.stateFor(host.id) as Extract<ServerMessage, { t: 'state' }>;
    return new Map(s.players.map((p) => [p.id, p.removable]));
  };

  assert.equal(wire().get(host.id), false, 'the host is not removable');
  assert.equal(wire().get(ghost.id), false, 'nor is a connected player');
  const bot = [...room.players.values()].find((p) => p.kind === 'bot')!;
  assert.equal(wire().get(bot.id), true, 'a bot always is');

  room.dropConnection(ghostConn);
  assert.equal(wire().get(ghost.id), false, 'still inside the grace period');
  room.players.get(ghost.id)!.awaySince = Date.now() - CONFIG.lobby.hostGraceMs - 1;
  assert.equal(wire().get(ghost.id), true, 'and removable once they are really gone');
});

/**
 * Tiles go on open ground. Everything else on the board is *something* — a hydrant, a
 * person, a squirrel, water — and a tile on top of one covered the art and read as a bug.
 */
test('tiles go on open ground, not on top of things', async () => {
  const room = new Room(await boards());
  const ada = seat(room, 'Ada', 'beagle');
  room.phase = 'place';

  const found = new Map<string, { x: number; y: number }>();
  for (let y = 0; y < room.map.height; y++) {
    for (let x = 0; x < room.map.width; x++) {
      const t = room.map.terrain[y * room.map.width + x]!;
      if (!found.has(t)) found.set(t, { x, y });
    }
  }

  for (const ch of ['S', 'P', 'Q', '~', 'D'] as const) {
    const at = found.get(ch);
    if (!at) continue;
    assert.match(
      room.place(ada.id, at.x, at.y, TILE.N) ?? '',
      /open ground/i,
      `placing on '${ch}' should be refused`,
    );
  }

  for (const ch of ['.', ','] as const) {
    const at = found.get(ch);
    if (!at) continue;
    const start = room.map.starts[0]!;
    if (at.x === start.x && at.y === start.y) continue;
    assert.equal(room.place(ada.id, at.x, at.y, TILE.N), null, `'${ch}' is open ground`);
  }
});
