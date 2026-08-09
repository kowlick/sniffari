import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import { CONFIG } from '../config.ts';
import { loadMap } from '../sim/map.ts';
import { Room, boardRows, type Board, type Connection } from './room.ts';
import { DOGS, type ClientMessage, type ServerMessage } from './protocol.ts';
import { buildLevel } from '../puzzle/generate.mjs';
import { createRun, step, tap, tapTarget } from '../shared/puzzle-rules.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const PUBLIC_DIR = join(ROOT, 'public');

/**
 * Small and large. Which one a match uses is chosen by the number of players, and
 * the map itself is regenerated at match start (CONFIG.freshMapEachMatch) — these shipped
 * maps are what the lobby shows before anyone has pressed start.
 */
const boards: Board[] = await Promise.all(
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

/** One game per server. Everyone is on the same LAN, so there is nothing to disambiguate. */
const room = new Room(boards);

// --- static files ---------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let path = url.pathname;
  if (path === '/') path = '/index.html';
  if (path === '/board') path = '/board.html';
  if (path === '/solo') path = '/solo.html';

  // normalize() collapses any ../ before we join, so requests cannot escape public/.
  const file = join(PUBLIC_DIR, normalize(path));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      // No caching: this is a LAN dev server and a stale client.js is a genuinely
      // confusing failure — you edit the game and the browser shows you the old one.
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        board: room.board.name,
        phase: room.phase,
        players: room.players.size,
      }),
    );
    return;
  }
  // Served rather than duplicated in client code, so names and colours cannot drift.
  if (req.url === '/dogs.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(DOGS));
    return;
  }

  /**
   * The solo puzzle's rules, served to the browser.
   *
   * `public/` cannot import from `src/` because it is never compiled — but this file is
   * plain JavaScript with no types to strip, so the browser can load the very same module
   * the generator and the tests run. That is the whole point: the alternative was a second
   * copy of the movement rules in `public/`, drifting quietly away from the real one.
   *
   * Deliberately one named file rather than a directory mount. Serving `src/` wholesale
   * would put the server's own source a URL away.
   */
  if (req.url === '/shared/puzzle-rules.mjs') {
    void serveShared(res);
    return;
  }

  const level = req.url?.match(/^\/solo\/level\/(\d+)$/);
  if (level) {
    void serveLevel(res, Number(level[1]));
    return;
  }

  /**
   * The intended solution, deliberately behind its own URL.
   *
   * Keeping it out of the level payload means a curious player has to go looking rather
   * than find the answer sitting in the response to the board they are staring at. It is a
   * development aid; when it stops being one, delete this route and the button that calls
   * it and nothing else changes.
   */
  const answer = req.url?.match(/^\/solo\/level\/(\d+)\/solution$/);
  if (answer) {
    void serveSolution(res, Number(answer[1]));
    return;
  }

  void serveStatic(req, res);
});

async function serveShared(res: ServerResponse) {
  try {
    const body = await readFile(join(ROOT, 'src', 'shared', 'puzzle-rules.mjs'));
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

/**
 * Levels are expensive to build and free to remember.
 *
 * Generating one means rolling candidate boards until the solver agrees the level has the
 * shape we asked for, which runs from a couple of milliseconds early on to about three
 * seconds at the hard end. It is also a pure function of the level number, so the answer
 * can be cached forever and shared by everybody.
 */
const levelCache = new Map<number, unknown>();

function levelFor(n: number) {
  const cached = levelCache.get(n);
  if (cached) return cached;
  const built = buildLevel(n);
  if (built) levelCache.set(n, built);
  return built;
}

async function serveLevel(res: ServerResponse, n: number) {
  if (!Number.isInteger(n) || n < 1 || n > 9999) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('No such level');
    return;
  }
  const level = levelFor(n);
  if (!level) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('Could not build that level');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(level));

  // Build the next two while the player is busy with this one. Generation runs from a
  // millisecond early on to several seconds at the hard end, and somebody working through
  // the levels in order should never meet that wait.
  void prewarmLevels(n + 2, n + 1);
}

/**
 * Where each tile of the intended solution ends up, and on which tick.
 *
 * Replayed rather than stored: a schedule of tap ticks is the canonical form of a solution,
 * and the squares fall out of walking it. Storing both would be storing the same fact twice.
 */
async function serveSolution(res: ServerResponse, n: number) {
  const level = levelFor(n) as {
    solution?: number[];
    queue: string[];
  } | null;
  if (!level?.solution) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('No solution recorded');
    return;
  }

  const run = createRun(level as never);
  const placements: { x: number; y: number; kind: string; tick: number }[] = [];
  const wanted = [...level.solution].sort((a, b) => a - b);
  let i = 0;
  for (let guard = 0; guard < 500 && run.outcome === 'running'; guard++) {
    while (i < wanted.length && wanted[i] === run.tick) {
      const target = tapTarget(level as never, run);
      if (target) placements.push({ ...target, tick: run.tick });
      tap(level as never, run);
      i++;
    }
    step(level as never, run);
  }

  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ taps: level.solution, placements }));
}

/**
 * Build the opening levels before anyone asks for them, one per turn of the event loop.
 *
 * The first few are quick, but a player who opens the puzzle and waits three seconds for
 * level one has already formed an opinion. Yielding between them keeps a party game running
 * on the same thread from stuttering while this happens.
 */
async function prewarmLevels(upTo: number, from = 1) {
  for (let n = from; n <= upTo; n++) {
    if (levelCache.has(n)) continue;
    await new Promise((r) => setImmediate(r));
    levelFor(n);
  }
}

// --- websockets -----------------------------------------------------------------------

const wss = new WebSocketServer({ server });

/**
 * Liveness, so `connected: false` is worth something.
 *
 * A closed tab sends a FIN and 'close' fires immediately. A phone that leaves the Wi-Fi,
 * goes flat, or is carried out of the house sends nothing, and the socket sits there
 * looking open until the OS TCP timeout — minutes. That is exactly the case where the host
 * has left and the room needs to notice, so we ping and hang up on anyone who misses two.
 */
const alive = new WeakSet<WebSocket>();

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate(); // fires 'close', which drops the connection from the room
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, CONFIG.lobby.heartbeatMs);
heartbeat.unref();

wss.on('connection', (ws: WebSocket) => {
  alive.add(ws);
  ws.on('pong', () => alive.add(ws));
  const conn: Connection = {
    send: (msg: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
  };
  let playerId: string | null = null;
  const fail = (message: string) => conn.send({ t: 'error', message });

  ws.on('message', (raw) => {
    alive.add(ws); // traffic is proof of life too, not just pongs
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return fail('Malformed message.');
    }

    switch (msg.t) {
      case 'join':
      case 'rejoin': {
        const result =
          msg.t === 'join' ? room.addPlayer(msg.name, conn) : room.rejoin(msg.token, conn);
        if ('error' in result) return fail(result.error);
        playerId = result.id;
        conn.send({ t: 'joined', playerId: result.id, token: result.token });
        return room.broadcast();
      }

      case 'spectate': {
        room.spectators.add(conn);
        return conn.send(room.stateFor(null));
      }

      // Everything past this point needs a seat at the table. Each handler returns an
      // error string or null.
      default: {
        if (!playerId) return fail('Join the game first.');
        const id = playerId;
        const err = (() => {
          switch (msg.t) {
            case 'pickDog':
              return room.pickDog(id, msg.dogId);
            case 'start':
              return room.start(id);
            case 'claimHost':
              return room.claimHost(id);
            case 'addBot':
              return room.addBot(id, msg.difficulty);
            case 'removePlayer':
              return room.removePlayer(id, msg.playerId);
            case 'leave':
              // The socket stays open; they are back at the join screen, not disconnected.
              playerId = null;
              return room.leave(id);
            case 'setAutopilot':
              return room.setAutopilot(id, msg.difficulty);
            case 'setRounds':
              return room.setRounds(id, msg.rounds);
            case 'endMatch':
              return room.endMatch(id);
            case 'place':
              return room.place(id, msg.x, msg.y, msg.kind);
            case 'lock':
              return room.lock(id);
            case 'unplace':
              room.unplace(id);
              return null;
            default:
              return 'Unknown message.';
          }
        })();
        if (err) fail(err);
      }
    }
  });

  ws.on('close', () => room.dropConnection(conn));
});

// --- listen ---------------------------------------------------------------------------

/**
 * Interfaces that are never the Wi-Fi everyone's phone is on: VPN tunnels, hypervisor
 * bridges, container bridges. A machine with NordVPN or Docker running has several
 * non-internal IPv4 addresses and the first one is usually the wrong one to print.
 */
const NOT_THE_LAN = /vmware|virtualbox|vbox|docker|hyper-v|vethernet|nordlynx|wireguard|openvpn|tailscale|zerotier|tap-|tun\d|vpn|bluetooth/i;

/** Every address a phone might reach us on, most likely first. */
function candidateAddresses() {
  const found: { address: string; iface: string; score: number }[] = [];
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // link-local, never routable
      let score = a.address.startsWith('192.168.')
        ? 3
        : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address)
          ? 2
          : a.address.startsWith('10.')
            ? 1
            : 0;
      if (NOT_THE_LAN.test(iface)) score -= 5;
      found.push({ address: a.address, iface, score });
    }
  }
  return found.sort((a, b) => b.score - a.score);
}

server.listen(CONFIG.port, '0.0.0.0', () => {
  const addrs = candidateAddresses();
  const best = addrs[0]?.address ?? 'localhost';
  const sizes = boards.map((b) => `${b.name} ${b.map.width}x${b.map.height} (≤${b.maxPlayers})`);
  console.log(`\n  Sniffari — boards: ${sizes.join(', ')}\n`);
  console.log(`  Players:  http://${best}:${CONFIG.port}`);
  console.log(`  Board:    http://${best}:${CONFIG.port}/board`);
  if (addrs.length > 1) {
    console.log('\n  Other addresses on this machine, if that one does not work:');
    for (const a of addrs.slice(1)) console.log(`    http://${a.address}:${CONFIG.port}  (${a.iface})`);
  }
  console.log(
    "\n  Phone can't connect? Windows Firewall blocks Node by default. See README.md.\n",
  );
});
