# Sniffari

Up to 8 players, one map of San Francisco, eight dogs off the leash at once.

Everyone picks a dog. Over five turns you secretly place direction tiles on an open field of
San Francisco — one per turn, four revealed, the last one hidden, and you can use any tile
as often as you like. Then all the dogs walk simultaneously, turning right at walls,
following whatever tiles they land on, collecting sniffs and treats until a squirrel, a
lake, or plain exhaustion stops them. Most points wins.

The full rules and the reasoning behind every tuning number are in [DESIGN.md](DESIGN.md).

## Running it

```bash
npm install
```

```bash
npm start
```

The server prints a join URL and a board URL. Players open the join URL on a phone or
laptop, type a name, and they're in — there is no room code, because there is one game per
server and everyone is on the same Wi-Fi. Put the board URL on a TV if you have one.

The board size is chosen by how many of you there are: 10×10 for 2–3 players, 13×13 for
4–5, 16×16 for 6–8.

Node 22.6+ is required — `.ts` files run directly with no build step.

On Windows, `restart.bat` is the quickest way to bounce the server between games: it kills
whatever node process is holding the port, waits for the port to actually come free, and
starts a fresh one. Double-click it, or pass a port (`restart.bat 8080`).

| | |
|---|---|
| `npm start` | Run the server on port 9663 (`WOOF` on a keypad) |
| `restart.bat` | Windows: free the port and restart the server |
| `npm run dev` | Same, restarting on file changes |
| `npm test` | Run the sim and map test suites |
| `npm test -- --test-name-pattern "jump"` | Run a single test by name |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run map` | Regenerate `maps/mission.txt` |
| `node scripts/preview.mjs --walk` | Render a map + simulated walk to `preview.svg` |
| `npm run tune` | Sweep map densities over many seeds and report how rounds actually play |
| `npm run ai-tourney` | Play the opponent difficulties against each other and report win rates |

This is a LAN game and nothing else — no accounts, no internet dependency, no remote play.
`PORT` is the only environment variable.

### Phones can't connect (Windows)

Almost always Windows Firewall, not the code. Windows creates **Block** rules for
`node.exe` when the firewall popup is dismissed or denied, and block rules take precedence
over allow rules — so adding an allow rule alone will not fix it. Check with:

```powershell
Get-NetFirewallApplicationFilter | Where-Object Program -like '*node.exe*' | Get-NetFirewallRule | Select-Object DisplayName, Direction, Action, Enabled, Profile
```

If any say `Block`, remove them and add a rule scoped to just this game's port, in an
**Administrator** PowerShell:

```powershell
Get-NetFirewallRule -DisplayName "Node.js JavaScript Runtime" | Remove-NetFirewallRule
```

```powershell
New-NetFirewallRule -DisplayName "Sniffari (TCP 9663)" -Direction Inbound -Protocol TCP -LocalPort 9663 -Action Allow -Profile Private,Public -RemoteAddress LocalSubnet
```

`-RemoteAddress LocalSubnet` keeps this to your own network rather than opening the port
generally.

Other things worth checking:

- **The address.** On startup the server prints its best guess plus every other address on
  the machine. A VPN client (NordVPN, Tailscale, WireGuard) adds interfaces that look like
  LAN addresses but aren't reachable from a phone; the server now demotes those, but if
  the first address doesn't work, try the others it lists.
- **A VPN blocking LAN traffic.** Some clients block local network access by default. Look
  for a "LAN discovery" or "Allow local network" setting.
- **Compare against something that works.** If another server on the same machine is
  reachable from a phone, the network is fine and the difference is per-application
  firewall rules.

## Layout

```
src/sim/        the game rules — deterministic, no clock, no randomness, no network
src/server/     rooms, turn state machine, websockets, static file serving
public/         the client: canvas renderer + a small amount of DOM
maps/           ASCII maps (see maps/README.md)
scripts/        map generator and SVG preview tool
test/           sim and map tests
```

## The one thing to understand

The walk phase is a **deterministic finite automaton**. A dog's entire state is
`(position, facing)`, so the same map plus the same tiles always produces the same round,
tick for tick. Everything else is built on that: players can reason about placements, the
server can send a whole round as one message, and the sim is testable with no mocks.

It also means every dog *must* eventually loop forever unless something stops it — which
is why stamina exists. See DESIGN.md §3.3.
