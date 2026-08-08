import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CONFIG } from '../src/config.ts';
import { loadMap } from '../src/sim/map.ts';
import { TILE } from '../src/sim/types.ts';
import { Room, boardRows, type Board, type Connection } from '../src/server/room.ts';

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
