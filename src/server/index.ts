import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import { CONFIG } from '../config.ts';
import { loadMap } from '../sim/map.ts';
import { Room, boardRows, type Board, type Connection } from './room.ts';
import { DOGS, type ClientMessage, type ServerMessage } from './protocol.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const PUBLIC_DIR = join(ROOT, 'public');

/**
 * Small / medium / large. Which one a match uses is chosen by the number of players, and
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
  void serveStatic(req, res);
});

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
