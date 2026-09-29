// Feature test: join codes, hideouts, the Navy on the server, full-sail boost, wind, and both sea monsters.
// Needs the server started with KLH_DEBUG=1:  node server/test/voyage-features.js
import { Client } from '@colyseus/sdk';
import { buildWorld, findHomeSpot } from '@klh/shared/world';
import { buildNav, nearestOpen, cellPos } from '@klh/shared/nav';
buildWorld(); buildNav(); // to find where each captain's hideout is

const url = process.env.SERVER_URL || 'http://localhost:2568';
const wait = ms => new Promise(r => setTimeout(r, ms));
const ok = (label, pass, extra = '') => console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);

// 1) codes: a new voyage gets a 4-letter code; friends join by it; a wrong code is refused
const a = await new Client(url).create('voyage', { name: 'Anne Bonny' });
ok('voyage code is 4 letters', /^[A-HJ-NP-Z]{4}$/.test(a.roomId), a.roomId);
const b = await new Client(url).joinById(a.roomId, { name: 'Calico Jack' });
ok('friend joins by code', b.roomId === a.roomId);
let refused = false; try { await new Client(url).joinById('QQQQ', { name: 'Nobody' }); } catch (e) { refused = true; }
ok('unknown code refused', refused);
let notPublic = false; try { const r = await new Client(url).join('voyage', { name: 'Stranger' }); await r.leave(); } catch (e) { notPublic = true; }
ok('voyages are private (no join-any)', notPublic);
for (const r of [a, b]) r.onMessage('*', () => {}); // quiet: we only listen for some messages
await wait(400);

// 2) hideouts and the fleet
const ships = () => [...a.state.ships.values()];
const A = a.state.ships.get(a.sessionId), B = a.state.ships.get(b.sessionId);
ok('each captain has their own hideout', A.home >= 0 && B.home >= 0 && A.home !== B.home, `homes ${A.home}, ${B.home}`);
ok('launched at different coves', Math.hypot(A.x - B.x, A.z - B.z) > 300, `${Math.hypot(A.x - B.x, A.z - B.z).toFixed(0)} units apart`);
const fleet = ships().filter(s => s.kind !== 'pirate');
ok('the Navy and merchantmen are on the water', fleet.length === 5, fleet.map(s => `${s.name} (${s.kind})`).join(', '));

// 3) full sail: a long straight run in open water (and no wind: debug-time picks a calm moment is not guaranteed, so just look for the boost flag)
a.send('debug-place', { x: -1250, z: 1200, yaw: -Math.PI / 2, speed: 0 }); await wait(200);
a.send('sail', { x: -1250, z: 1900 }); // due south, straight down Haro Strait
let boosted = false, top = 0; for (let k = 0; k < 60; k++) { await wait(200); top = Math.max(top, A.speed); if (A.boost) boosted = true; }
ok('full-sail boost after a straight run', boosted && top > 27, `top speed ${top.toFixed(1)} (max 26 + boost 4.8)`);
a.send('anchor');

// 4) a storm brews; at full strength the Kraken rises under it, grabs and squeezes; drive it off and the storm clears
const log = []; for (const type of ['maul', 'monster', 'repaired', 'sunk', 'engage', 'storm']) a.onMessage(type, m => log.push({ type, ...m }));
a.send('debug-place', { x: -1100, z: 300, yaw: Math.PI / 2 }); b.send('debug-place', { x: -900, z: -400, yaw: Math.PI / 2 }); await wait(300);
a.send('debug-storm', { x: -1150, z: 600 }); await wait(1000);
ok('a storm brews', log.some(e => e.type === 'storm' && e.event === 'brew') && a.state.stormFade > 0, `fade ${a.state.stormFade.toFixed(2)}`);
const kraken = () => [...a.state.monsters.values()].find(m => m.kind === 'kraken');
for (let k = 0; k < 40 && !kraken(); k++) await wait(1000);
const K = kraken();
ok('the Kraken rises under the storm once it is full', !!K && a.state.stormFade >= 0.99, K ? `${Math.hypot(K.x - a.state.stormX, K.z - a.state.stormZ).toFixed(0)} units from the storm's centre` : 'no Kraken');
if (K) { await wait(3200); a.send('debug-place', { x: K.x - 70, z: K.z, yaw: Math.PI / 2 }); } // sail Anne up to it
await wait(9000);
const squeezes = log.filter(e => e.type === 'maul' && e.how === 'squeeze');
ok('the Kraken grabs Anne', log.some(e => e.type === 'monster' && e.event === 'grab' && e.ship === a.sessionId));
ok('...and squeezes her hull', squeezes.length >= 2, `${squeezes.length} squeezes, Anne hull ${A.hp}/${A.maxHp}`);
// shoot it: Calico Jack comes alongside and fires until it's driven off
for (let k = 0; k < 8 && K && K.mode !== 'sink' && !log.some(e => e.event === 'slain' && e.kind === 'kraken'); k++) {
  b.send('debug-place', { x: K.x + 90, z: K.z, yaw: Math.PI / 2 }); await wait(150); b.send('fire', { side: -1 }); await wait(7200);
}
ok('cannon fire drives the Kraken off', log.some(e => e.type === 'monster' && e.event === 'slain' && e.kind === 'kraken'), `hp ${K ? K.hp : '?'}`);
ok('...and its storm starts to clear', log.some(e => e.type === 'storm' && e.event === 'clear'));
for (let k = 0; k < 25 && a.state.stormFade > 0; k++) await wait(1000);
ok('the storm is gone, and so is the Kraken', a.state.stormFade === 0 && !kraken() && log.some(e => e.type === 'storm' && e.event === 'gone'));

// 5) the White Whale charges and rams
a.send('debug-place', { x: -1150, z: 900, yaw: Math.PI / 2 }); await wait(300);
log.length = 0; a.send('debug-monster', { kind: 'whale', x: -1150, z: 1250 });
for (let k = 0; k < 60 && !log.some(e => e.type === 'maul' && e.how === 'ram'); k++) await wait(250);
const ram = log.find(e => e.type === 'maul' && e.how === 'ram');
ok('the White Whale rams', !!ram, ram ? `${ram.dmg} hits to ${ram.ship === a.sessionId ? 'Anne' : ram.ship}` : 'no ram in 15 s');

// 6) repairs at your own hideout
const hpBefore = A.hp;
const [hx, hz] = cellPos(...nearestOpen(...findHomeSpot(A.home))); a.send('debug-place', { x: hx, z: hz, yaw: 0 }); await wait(600);
if (A.sinking || hpBefore === 0) console.log('SKIP  repaired at your hideout | Anne was sunk by the patrols first (run again)');
else ok('repaired at your hideout', A.hp === A.maxHp && (hpBefore === A.maxHp || log.some(e => e.type === 'repaired')), `hull ${hpBefore} -> ${A.hp}`);

console.log(`weather clock t=${a.state.t.toFixed(1)}s`);
await a.leave(); await b.leave(); process.exit(0);
