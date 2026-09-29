// Combat smoke test: broadsides, hits, a ram, sinking and respawn, all refereed by the server.
// Needs the server started with KLH_DEBUG=1 (for the debug-place command):  node server/test/sea-battle.js
import { Client } from '@colyseus/sdk';
import { buildWorld, findHomeSpot } from '@klh/shared/world';
buildWorld();

const url = process.env.SERVER_URL || 'http://localhost:2568';
const wait = ms => new Promise(r => setTimeout(r, ms));
const a = await new Client(url).create('voyage', { name: 'Anne Bonny' }), b = await new Client(url).joinById(a.roomId, { name: 'Calico Jack' });
const log = []; for (const [who, room] of [['A', a], ['B', b]]) for (const type of ['shot', 'impact', 'bump', 'sunk', 'respawn']) room.onMessage(type, m => { if (who === 'A') log.push({ type, ...m }); });
await wait(300);
const hp = room => [...room.state.ships.values()].filter(s => s.kind === 'pirate').map(s => `${s.name} ${s.hp}/${s.maxHp}${s.sinking ? ' SINKING' : ''}`).join(', ');

// 1) broadside: Anne faces north in Haro Strait, Calico Jack 90 units off her starboard (east) side
a.send('debug-place', { x: -1150, z: 300, yaw: Math.PI / 2 }); b.send('debug-place', { x: -1060, z: 300, yaw: Math.PI / 2 });
await wait(300);
a.send('fire', { side: 1 }); await wait(2500);
const impacts = log.filter(e => e.type === 'impact');
console.log(`broadside: ${log.filter(e => e.type === 'shot').length} shots, impacts: ${impacts.map(i => i.kind).join(', ')} | ${hp(a)}`);
a.send('fire', { side: 1 }); await wait(500);
console.log(`fire again at once (reloading): ${log.filter(e => e.type === 'shot').length} shots total (expect 3)`);

// 2) ram: Calico Jack drives his bow at full speed into Anne's side
a.send('debug-place', { x: -1150, z: 300, yaw: Math.PI / 2 }); b.send('debug-place', { x: -1122, z: 300, yaw: Math.PI, speed: 26 });
await wait(2500);
const bump = log.find(e => e.type === 'bump');
console.log(`ram: ${bump ? `${bump.kind}, rammer=${bump.rammer === b.sessionId ? 'Calico Jack' : bump.rammer}, damage A=${bump.dmgA} B=${bump.dmgB}` : 'no bump'} | ${hp(a)}`);

// 3) sink Anne with more broadsides from Calico Jack, then wait for her fresh ship
for (let k = 0; k < 4 && !log.some(e => e.type === 'sunk'); k++) {
  b.send('debug-place', { x: -1060, z: 300, yaw: Math.PI / 2 }); a.send('debug-place', { x: -1150, z: 300, yaw: Math.PI / 2 });
  await wait(200); b.send('fire', { side: -1 }); await wait(7300);
}
const sunk = log.find(e => e.type === 'sunk');
console.log(`sunk: ${sunk ? `${sunk.ship === a.sessionId ? 'Anne' : 'Calico'} by ${sunk.cause}` : 'no'} | ${hp(a)}`);
// sunk: Anne takes to the dinghy; rowing home (put her just off her hideout) brings a fresh ship
const annie = () => a.state.ships.get(a.sessionId), launches0 = annie().launches;
console.log(`abandon ship: Anne is in the ${annie().mode}`);
const [hx, hz] = findHomeSpot(annie().home); a.send('debug-avatar', { x: hx + 70, z: hz }); a.send('back');
for (let k = 0; k < 150 && annie().launches === launches0; k++) await wait(100);
console.log(`rowed home: ${annie().launches > launches0 ? 'fresh ship' : 'no ship'} | ${hp(a)} | Anne shielded=${annie().shielded}`);
await a.leave(); await b.leave(); process.exit(0);
