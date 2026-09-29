# Klahompton

A comic-book pirate game on the west side of San Juan Island: dig up beach treasure, trade broadsides with the Royal Navy, and haul the loot home to Wold Cabin. It's turning into a browser PvP game with a Colyseus game server as the referee.

## Run it

```bash
npm install
npm run dev
```

That starts both halves:

- **Game page:** http://localhost:5173 (opens the harbor menu: sail solo, start a voyage, or join one by code)
- **Game server:** ws://localhost:2567

**Sail online:** pick **New voyage** in one tab; it gets a 4-letter code and the address becomes `?v=CODE`, the invite link. Open that link in another tab (or type the code under **Join**). Each captain launches from their own hideout. A phone on the same Wi-Fi can join using the Network address Vite prints.

Shortcuts that skip the menu: `?solo`, `?new&name=Anne`, `?v=CODE&name=Calico`.

**Server tests** (with the server running):

- `node server/test/two-captains.js`: two captains join and see each other sail
- `node server/test/sea-battle.js`: broadsides, reloads, a ram, sinking and respawn (needs `KLH_DEBUG=1`, which `server/.env.development` sets for local runs)
- `node server/test/voyage-features.js`: join codes, private voyages, hideouts, the Navy on the server, full-sail boost, the Kraken and the White Whale, repairs (needs `KLH_DEBUG=1`)
- `node server/test/captain.js`: going ashore, walking to an X, digging, carrying the chest back aboard, banking it, and rowing home for a fresh ship after sinking (needs `KLH_DEBUG=1`)
- `node server/test/sail-latency.js`: how fast a course is accepted, and top speed

**Testing by hand:** add `&debug` to the address and the browser console gets `__klh` (online: `place(x, z, yaw)` moves your ship; single-player: `raise('kraken' | 'whale', x, z)` calls up a monster).

## Layout

| Folder | What's in it |
| --- | --- |
| `shared/` | The islands and hideouts (`world`), sea routes (`nav`), sailing with the full-sail boost and wind push (`ship`), combat (`combat`), the Navy and merchantmen (`npc`), the Kraken and White Whale (`monsters`), the wind and storms (`weather`), the captain ashore (`captain`: dinghy, walking, digging, the swivel gun) and buried treasure (`treasure`). No three.js, so the server runs it too. |
| `server/` | Colyseus server. Each `VoyageRoom` is a private match named by its 4-letter code; it owns every ship and monster and referees at 20 Hz. |
| `client/` | The three.js game (Vite). `src/main.js` is the game, including the harbor menu; `src/net.js` creates or joins a voyage. |

## Settings

- `GAME_PORT`: game server port (default 2567). Not `PORT`, because dev tools use that for the web page.
- `VITE_SERVER_URL`: where the page finds the game server when it isn't on the same host, port 2567.

## Status

Phases 1 and 2 of the [PvP plan](https://claude.ai/code/artifact/578762fa-3e5d-4af3-89cf-1aa8c6b7bc31) are done, plus part of phase 3:

- a harbor menu with private voyages and join codes
- a hideout per crew (respawn and repairs)
- the Navy and merchantmen on the server
- the full-sail boost
- wind systems with a storm
- the Kraken and the White Whale

- the captain off the ship: row the dinghy ashore, walk, dig up treasure under the X's, a swivel gun; sink and you row home for a new ship
- treasure, floating coins, the hold and banking, online as well as single-player
- a treasure map

Not built yet: a scoreboard and a win condition.
