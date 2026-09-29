// Smoke test: two captains join the same voyage, one sets a course, and both see it sail.
// Run with the server up:  node server/test/two-captains.js
import { Client, Callbacks } from '@colyseus/sdk';

const url = process.env.SERVER_URL || 'http://localhost:2567';
const a = await new Client(url).create('voyage', { name: 'Anne Bonny' });
const b = await new Client(url).joinById(a.roomId, { name: 'Calico Jack' });
await new Promise(r => setTimeout(r, 300));
const seen = room => [...room.state.ships.values()].map(s => `${s.name} @ ${s.x.toFixed(0)},${s.z.toFixed(0)}`);
console.log('same room:', a.roomId === b.roomId, '| A sees', seen(a), '| B sees', seen(b));

const me = a.state.ships.get(a.sessionId), start = [me.x, me.z];
a.send('sail', { x: me.x, z: me.z + 400 }); // out of Open Bay to the south
let moves = 0; Callbacks.get(b).onChange(b.state.ships.get(a.sessionId), () => moves++);
await new Promise(r => setTimeout(r, 4000));
const seenByB = b.state.ships.get(a.sessionId);
console.log(`Anne sailed ${Math.hypot(seenByB.x - start[0], seenByB.z - start[1]).toFixed(0)} units; Calico Jack saw ${moves} updates; sailing=${seenByB.sailing} speed=${seenByB.speed.toFixed(1)}`);
await a.leave(); await new Promise(r => setTimeout(r, 300));
console.log('after Anne leaves, B sees', seen(b));
await b.leave(); process.exit(0);
