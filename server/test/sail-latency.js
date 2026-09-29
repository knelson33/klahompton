// How long from "sail here" until the server has the ship moving, and how fast it goes after that.
// node server/test/sail-latency.js   (SERVER_URL=https://klahompton.fly.dev for the live server)
import { Client } from '@colyseus/sdk';

const url = process.env.SERVER_URL || 'http://localhost:2567';
const room = await new Client(url).create('voyage', { name: 'Test Captain' });
await new Promise(r => setTimeout(r, 500));
const me = () => room.state.ships.get(room.sessionId);
const t0 = performance.now(), start = [me().x, me().z];
room.send('sail', { x: me().x, z: me().z + 400 });
let moving = null;
while (performance.now() - t0 < 12000) {
  await new Promise(r => setTimeout(r, 25));
  if (!moving && me().sailing) moving = performance.now() - t0;
  if (performance.now() - t0 > 8000) break;
}
console.log(`course accepted after ${moving ? moving.toFixed(0) + ' ms' : 'never'}; after 8 s: sailed ${Math.hypot(me().x - start[0], me().z - start[1]).toFixed(0)} units, speed ${me().speed.toFixed(1)}`);
await room.leave(); process.exit(0);
