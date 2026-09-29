// Captain test: go ashore in the dinghy, walk to a buried chest, dig it up, carry it back aboard, bank it at the
// hideout; get sunk and row home for a fresh ship; the pistol; boarding only by button; splash damage to a captain ashore.
// Needs the server started with KLH_DEBUG=1:  node server/test/captain.js
import { Client } from '@colyseus/sdk';
import { buildWorld, findHomeSpot, sdAt } from '@klh/shared/world';
import { buildNav, nearestOpen, cellPos } from '@klh/shared/nav';
import { chestSpot } from '@klh/shared/treasure';

buildWorld(); buildNav();
const url = process.env.SERVER_URL || 'http://localhost:2568';
const wait = ms => new Promise(r => setTimeout(r, ms));
const ok = (label, pass, extra = '') => console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
const until = async (cond, secs) => { for (let k = 0; k < secs * 10 && !cond(); k++) await wait(100); return cond(); };

const a = await new Client(url).create('voyage', { name: 'Anne Bonny' }); a.onMessage('*', () => {});
const log = []; for (const t of ['captain', 'dug', 'bank', 'sunk', 'shot', 'impact']) a.onMessage(t, m => log.push({ type: t, ...m }));
await wait(500);
const A = () => a.state.ships.get(a.sessionId);
ok('treasure is buried', a.state.chests.size === 8, `${a.state.chests.size} chests`);

// 1) anchor off a beach below a chest we bury ourselves, go ashore, walk up, dig
const [cx, cz] = chestSpot(Math.random, []), [wx, wz] = cellPos(...nearestOpen(cx, cz));
a.send('debug-chest', { x: cx, z: cz }); a.send('debug-place', { x: wx, z: wz, yaw: 0 }); await wait(300);
a.send('ashore'); await wait(300);
ok('into the dinghy', A().mode === 'dinghy');
a.send('sail', { x: cx, z: cz });
ok('rowed to the beach and stepped ashore', await until(() => A().mode === 'shore', 60), `${log.filter(e => e.event === 'landed').length} landing`);
ok('walked up to the X', await until(() => Math.hypot(A().ax - cx, A().az - cz) < 8 && !A().moving, 90), `${Math.hypot(A().ax - cx, A().az - cz).toFixed(1)} units away`);
a.send('dig');
ok('dug up the chest', await until(() => A().carry === 100, 6), `carrying ${A().carry}`);
ok('...and it is gone from the map', ![...a.state.chests.values()].some(c => Math.hypot(c.x - cx, c.z - cz) < 1));

// 2) the pistol: fires straight ahead any time it's loaded (once per 1.5 s)
const pistols = () => log.filter(e => e.type === 'shot' && e.pistol).length;
a.send('shoot'); a.send('shoot'); await wait(400);
ok('the pistol fires straight ahead (and the second shot waits for the reload)', pistols() === 1, `${pistols()} shot`);
await wait(1300); a.send('shoot'); await wait(800); // it goes off 0.3 s after he raises it
ok('...and fires again once reloaded', pistols() === 2);

// 3) tapping the dinghy doesn't climb in: only Back does. Back walks to the dinghy and rows out to the ship
a.send('sail', { x: A().dinX, z: A().dinZ }); await wait(4000);
ok('a tap on the dinghy just walks there (no boarding)', A().mode === 'shore', `mode ${A().mode}`);
a.send('back');
ok('walked back, rowed out and boarded', await until(() => A().mode === 'ship', 120), `hold ${A().cargo}`);
ok('the chest is in the hold', A().cargo === 100);

// 4) bank it at the hideout
const home = findHomeSpot(A().home), [hx, hz] = cellPos(...nearestOpen(...home));
a.send('debug-place', { x: hx, z: hz, yaw: 0 });
ok('banked at the hideout', await until(() => A().gold === 100, 3), `gold ${A().gold}, hold ${A().cargo}`);

// 5) splash damage: ashore again, a cannonball lands at your feet (fired by a second captain at the captain's spot)
const b = await new Client(url).joinById(a.roomId, { name: 'Calico Jack' }); b.onMessage('*', () => {});
a.send('debug-place', { x: wx, z: wz, yaw: 0 }); await wait(300); a.send('ashore'); await wait(200); a.send('sail', { x: cx, z: cz });
await until(() => A().mode === 'shore' && !A().moving, 90);
const hearts0 = A().hearts;
// put Calico Jack broadside-on 90 units off, his starboard guns toward Anne's captain
const ax = A().ax, az = A().az; let tries = 0;
while (A().hearts === hearts0 && A().mode === 'shore' && tries++ < 3) {
  for (let r = 90; r < 200; r += 10) { const x = ax - r, z = az; if (sdAt(x, z) < -12) { b.send('debug-place', { x, z, yaw: Math.PI / 2 }); break; } } // bow north: starboard faces east
  await wait(300); b.send('fire', { side: 1 }); await wait(7400);
}
console.log(`INFO  captain ashore under fire: hearts ${hearts0} -> ${A().hearts}, events: ${log.filter(e => e.type === 'captain' && ['heart', 'knocked', 'boat'].includes(e.event)).map(e => e.event).join(', ') || 'none (the broadside missed)'}`);

// 6) sunk: the captain pops up in the dinghy, and rowing home brings a fresh ship
if (A().marooned) console.log('INFO  the beached dinghy was smashed: marooned, waiting for the crew'); else { a.send('debug-avatar', { x: A().dinX, z: A().dinZ }); a.send('back'); }
ok('back aboard (rowed out, or rescued if marooned)', await until(() => A().mode === 'ship' || A().sinking, 60), A().sinking ? 'her anchored ship was sunk by the crossfire meanwhile' : '');
if (A().sinking) { a.send('debug-avatar', { x: hx + 60, z: hz }); a.send('back'); await until(() => A().mode === 'ship' && !A().sinking, 30); }
a.send('debug-place', { x: -1150, z: 300, yaw: Math.PI / 2 }); await wait(3500); // out to open water, clear of the hideout (which repairs) and the spawn shield
const launches0 = A().launches;
for (let k = 0; k < 4 && !A().sinking; k++) { const s = A(); b.send('debug-place', { x: s.x + 90, z: s.z, yaw: Math.PI / 2 }); await wait(200); b.send('fire', { side: -1 }); await wait(7300); }
ok('sunk: the captain takes to the dinghy', A().sinking && A().mode === 'dinghy', `mode ${A().mode}`);
a.send('debug-avatar', { x: hx + 60, z: hz }); a.send('back');
ok('rowed home: a fresh ship', await until(() => A().launches > launches0 && A().mode === 'ship' && !A().sinking, 30), `launches ${launches0} -> ${A().launches}`);

await a.leave(); await b.leave(); process.exit(0);
