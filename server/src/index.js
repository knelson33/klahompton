// Klahompton game server: builds the islands once, then hosts voyages (match rooms) over WebSockets.
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { buildWorld } from '@klh/shared/world';
import { buildNav } from '@klh/shared/nav';
import { VoyageRoom } from './VoyageRoom.js';

const t0 = Date.now();
buildWorld(); buildNav(); // the same coastline and sea lanes the browsers draw
console.log(`Charted the islands in ${Date.now() - t0} ms`);

const port = Number(process.env.GAME_PORT) || 2567; // its own variable: dev tools set PORT for the web page
const server = new Server({ transport: new WebSocketTransport() });
server.define('voyage', VoyageRoom);
await server.listen(port);
console.log(`Klahompton server listening on ws://localhost:${port}`);
