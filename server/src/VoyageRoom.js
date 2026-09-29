// One voyage on the water. The server owns every ship and referees every fight: browsers only ask to
// sail, anchor or fire, and the room moves the ships (captains, the Navy and merchantmen), flies the
// cannonballs, runs the sea monsters, and decides hits, rams and sinkings at 20 Hz, using the same
// rules the single-player game plays by. Each voyage is private and found by its 4-letter code.
import { Room, matchMaker } from 'colyseus';
import { schema, t } from '@colyseus/schema';
import { HOMES, HOME_RADIUS, findHomeSpot, heightAt, seawardYaw } from '@klh/shared/world';
import { nearestOpen, cellPos, sailable, findPath } from '@klh/shared/nav';
import { stepShip } from '@klh/shared/ship';
import { PORT, STARBOARD, RELOAD, HULL_HITS, SPAWN_SHIELD_S, GUNS, GUN_STAGGER, layGuns, gunBall, stepBall, inHull, collide } from '@klh/shared/combat';
import { FLEET, NPC_NAMES, NPC_RESPAWN_S, NPC_SINK_S, newNpc, openSpot, stepNpc, moveNpc } from '@klh/shared/npc';
import { MONSTER_FIRST, MONSTER_NEXT, KRAKEN_AFTER, monsterSpot, stormSpot, dismissMonster, newMonster, monsterHit, hurtMonster, stepMonster } from '@klh/shared/monsters';
import { STORM_FIRST, STORM_NEXT, windAt, newStorm, stepStorm, clearStorm } from '@klh/shared/weather';
import { newAvatar, launchDinghy, resetAvatar, avatarGo, stepAvatar, startDig, pistolBall, splashAvatar, PISTOL_RELOAD, PISTOL_DRAW } from '@klh/shared/captain';
import { CHEST_COUNT, CHEST_GOLD, CHEST_RESPAWN_S, COIN_GOLD, chestSpot } from '@klh/shared/treasure';

// what every browser sees (synced automatically, only the fields that changed each tick)
export const Ship = schema({
  name: t.string(), color: t.string(), kind: t.string(), home: t.int8(),
  x: t.float32(), z: t.float32(), yaw: t.float32(), speed: t.float32(),
  sailing: t.boolean(), goalX: t.float32(), goalZ: t.float32(), boost: t.boolean(),
  hp: t.uint8(), maxHp: t.uint8(), sinking: t.boolean(), shielded: t.boolean(),
  launches: t.uint16(), // counts fresh ships: browsers redraw a ship whenever this goes up
  // the captain off the ship: mode 'ship' | 'dinghy' | 'shore' | 'lost'; ax/az the dinghy or captain, dinX/dinZ the beached dinghy
  mode: t.string(), ax: t.float32(), az: t.float32(), ayaw: t.float32(), moving: t.boolean(), digging: t.boolean(), marooned: t.boolean(),
  dinX: t.float32(), dinZ: t.float32(), dinYaw: t.float32(), hearts: t.uint8(),
  carry: t.uint16(), cargo: t.uint16(), gold: t.uint32(), // loot: in the captain's hands (or dinghy), in the hold, banked at the hideout
}, 'Ship');
export const Spot = schema({ x: t.float32(), z: t.float32() }, 'Spot'); // a buried chest, or a floating coin
export const Monster = schema({
  kind: t.string(), x: t.float32(), z: t.float32(), y: t.float32(), yaw: t.float32(), speed: t.float32(),
  hp: t.uint8(), maxHp: t.uint8(), mode: t.string(), grab: t.string(),
}, 'Monster');
export const VoyageState = schema({ ships: t.map(Ship), monsters: t.map(Monster), chests: t.map(Spot), coins: t.map(Spot), t: t.float32(),
  stormX: t.float32(), stormZ: t.float32(), stormDir: t.float32(), stormFade: t.float32() }, 'VoyageState'); // stormFade 0: no storm

const COLORS = ['#c8352b', '#2e86de', '#27ae60', '#f2c14e', '#8e44ad', '#e67e22', '#1abc9c', '#f4ecd3']; // sail colours, one per crew
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: they read as 1 and 0
const TICK_MS = 50;
const num = v => typeof v === 'number' && Number.isFinite(v);
const round1 = v => Math.round(v * 10) / 10;
const rr = (a, b) => a + (b - a) * Math.random();

// a free berth in the water off a hideout, so crews don't launch on top of each other
function launchSpot(home, ships) {
  const [cx, cz] = findHomeSpot(home), w = nearestOpen(cx, cz), [hx, hz] = w ? cellPos(...w) : [cx, cz];
  const free = (x, z) => ships.every(s => Math.hypot(s.x - x, s.z - z) > 26);
  for (let r = 0; r <= 90; r += 15) for (let a = 0; a < 8; a++) { const x = hx + Math.cos(a * Math.PI / 4) * r, z = hz + Math.sin(a * Math.PI / 4) * r; if (sailable(x, z, 8) && free(x, z)) return [x, z]; }
  return [hx, hz];
}

export class VoyageRoom extends Room {
  maxClients = HOMES.length;

  async onCreate() {
    this.roomId = await this.uniqueCode(); // the join code IS the room's id
    await this.setPrivate(true);           // found only by its code, never by "join any"
    this.setState(new VoyageState());
    this.bodies = new Map(); // id -> the ship as the rules see it (position, sailing physics, hull, guns); captains and patrols
    this.balls = [];         // cannonballs in flight (or waiting for their gun to go off)
    this.nextBall = 1;
    this.time = 0;
    this.monsters = new Map(); this.nextMonster = 1;
    this.whaleT = rr(...MONSTER_FIRST);            // the White Whale comes on its own timer...
    this.storm = null; this.stormT = rr(...STORM_FIRST); this.krakenT = null; // ...the Kraken with each storm
    this.npcs = FLEET.map((kind, k) => ({ id: `npc${k}`, kind, down: 0, named: 0 }));
    this.chests = new Map(); this.coins = new Map(); this.nextSpot = 1; this.chestTimers = [];
    for (let k = 0; k < CHEST_COUNT; k++) this.buryChest();
    // 'sail' means go there: sail, row or walk, whichever the captain is doing
    this.onMessage('sail', (client, msg) => {
      const b = this.bodies.get(client.sessionId); if (!b || !msg || !num(msg.x) || !num(msg.z)) return;
      if (b.av.mode !== 'ship') { avatarGo(b.av, msg.x, msg.z, b.sinking ? null : b); return; }
      if (b.sinking) return;
      const path = findPath(b.x, b.z, msg.x, msg.z); if (!path) return;
      b.path = path; b.goal = path[path.length - 1];
    });
    this.onMessage('anchor', client => { const b = this.bodies.get(client.sessionId); if (b && b.av.mode === 'ship') { b.path = []; b.goal = null; } });
    // off the ship into the dinghy (anchored and nearly stopped), and back again
    this.onMessage('ashore', client => { const b = this.bodies.get(client.sessionId);
      if (!b || b.sinking || b.av.mode !== 'ship' || b.speed > 3) return;
      b.path = []; b.goal = null; launchDinghy(b.av, b); this.broadcast('captain', { ship: b.id, event: 'ashore' }); });
    this.onMessage('back', client => { const b = this.bodies.get(client.sessionId); if (!b) return; const a = b.av;
      if (a.mode === 'shore') avatarGo(a, a.dinX, a.dinZ, b.sinking ? null : b, true); // walk back to the dinghy (and row out to the ship)
      else if (a.mode === 'dinghy') { if (!b.sinking) avatarGo(a, b.x, b.z, b, true); else { const w = nearestOpen(...findHomeSpot(b.home)); if (w) avatarGo(a, ...cellPos(...w), null); } } });
    // standing ashore, the captain faces where his player's camera looks (the pistol fires that way)
    this.onMessage('face', (client, m) => { const b = this.bodies.get(client.sessionId), a = b && b.av;
      if (a && m && num(m.yaw) && a.mode === 'shore' && !a.path.length && !a.dig) a.yaw = m.yaw; });
    this.onMessage('dig', client => { const b = this.bodies.get(client.sessionId); if (!b) return;
      const c = startDig(b.av, [...this.chests.values()]); if (c) this.broadcast('captain', { ship: b.id, event: 'dig', chest: c.id }); });
    // the captain's pistol: he raises it (everyone sees), and a moment later it fires straight ahead, ashore or in the dinghy
    this.onMessage('shoot', client => { const b = this.bodies.get(client.sessionId), a = b && b.av; if (!a || (a.mode !== 'shore' && a.mode !== 'dinghy') || a.reload > 0 || a.dig || a.drawT > 0) return;
      a.reload = PISTOL_RELOAD; a.drawT = PISTOL_DRAW; this.broadcast('aim', { ship: b.id }); });
    this.onMessage('fire', (client, msg) => { const b = this.bodies.get(client.sessionId), side = msg && msg.side;
      if (!b || b.sinking || b.av.mode !== 'ship' || (side !== PORT && side !== STARBOARD) || b.reload[side] > 0) return;
      b.reload[side] = RELOAD; this.fire(b, side, layGuns(b, side, this.targetsFor(b)), 6, GUN_STAGGER); });
    if (process.env.KLH_DEBUG) { // tests only
      this.onMessage('debug-place', (client, m) => { const b = this.bodies.get(m && m.id || client.sessionId); if (!b || !m) return;
        Object.assign(b, { x: m.x, z: m.z, yaw: m.yaw ?? b.yaw, speed: m.speed ?? 0, path: [], goal: null, shield: 0 }); });
      this.onMessage('debug-monster', (client, m) => { const b = this.bodies.get(client.sessionId); if (b) this.raiseMonster(m && m.kind || 'kraken', m && m.x, m && m.z); });
      this.onMessage('debug-storm', (client, m) => { this.storm = Object.assign(newStorm(Math.random, []), m && num(m.x) ? { x: m.x, z: m.z } : {}); this.broadcast('storm', { event: 'brew', x: round1(this.storm.x), z: round1(this.storm.z) }); });
      this.onMessage('debug-time', (client, m) => { if (m && num(m.t)) this.time = m.t; });
      this.onMessage('debug-chest', (client, m) => { if (m && num(m.x)) this.addSpot(this.chests, 'chests', m.x, m.z); });
      this.onMessage('debug-avatar', (client, m) => { const b = this.bodies.get(client.sessionId); if (b && m && num(m.x)) Object.assign(b.av, { x: m.x, z: m.z, path: [], then: null }); });
      this.onMessage('debug-cargo', (client, m) => { const b = this.bodies.get(client.sessionId); if (b && m) Object.assign(b, { cargo: m.cargo ?? b.cargo }); });
    }
    this.setPatchRate(TICK_MS);
    this.setSimulationInterval(ms => this.update(Math.min(ms, 100) / 1000), TICK_MS);
    console.log(`Voyage ${this.roomId} created`);
  }

  async uniqueCode() {
    for (let k = 0; k < 50; k++) {
      const code = Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
      if (!(await matchMaker.query({ roomId: code })).length) return code;
    }
    return undefined; // fall back to a generated id
  }

  onJoin(client, options = {}) {
    const pirates = [...this.bodies.values()].filter(b => b.kind === 'pirate');
    const used = new Set(pirates.map(b => b.home)), free = HOMES.map((h, i) => i).filter(i => !used.has(i));
    const home = free[Math.floor(Math.random() * free.length)]; // a random free cove for each crew
    const color = COLORS[home];
    const name = String(options.name || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 20) || `Captain ${home + 1}`;
    const b = { id: client.sessionId, kind: 'pirate', home, turn: 0, driftV: 0, path: [], goal: null, av: newAvatar(), cargo: 0, gold: 0,
      hp: HULL_HITS.pirate, maxHp: HULL_HITS.pirate, sinking: false, sinkT: 0, shield: SPAWN_SHIELD_S, reload: { [PORT]: 0, [STARBOARD]: 0 }, bump: new Map() };
    this.launch(b, pirates);
    this.bodies.set(b.id, b);
    const ship = new Ship(); Object.assign(ship, { name, color, kind: 'pirate', home, goalX: b.x, goalZ: b.z });
    this.state.ships.set(b.id, ship); this.publish(b, ship);
    if (!this.npcs.some(n => this.bodies.has(n.id))) for (const n of this.npcs) this.spawnNpc(n); // the first captain brings out the fleet
    console.log(`${this.roomId}: ${name} joined at ${HOMES[home].name} (${pirates.length + 1} aboard)`);
  }

  onLeave(client) {
    const s = this.state.ships.get(client.sessionId);
    this.state.ships.delete(client.sessionId); this.bodies.delete(client.sessionId);
    for (const b of this.bodies.values()) if (b.provoked) b.provoked.delete(client.sessionId);
    console.log(`${this.roomId}: ${s ? s.name : client.sessionId} left`);
  }

  // a fresh ship at a free berth off its crew's hideout, bow out to sea
  launch(b, others) {
    [b.x, b.z] = launchSpot(b.home, others.filter(o => o !== b));
    b.launches = (b.launches || 0) + 1;
    Object.assign(b, { yaw: seawardYaw(b.x, b.z), speed: 0, turn: 0, driftV: 0, path: [], goal: null, hp: b.maxHp, sinking: false, sinkT: 0, shield: SPAWN_SHIELD_S, straightT: 0, boost: false });
    if (b.av) { resetAvatar(b.av); b.av.x = b.x; b.av.z = b.z; }
  }

  pistol(b) {
    const ball = pistolBall(b.av), shot = { id: this.nextBall++, owner: b.id, live: true, pistol: true, ...ball }; this.balls.push(shot);
    this.broadcast('shot', { id: shot.id, ship: b.id, side: 0, pistol: true, x: round1(shot.x), y: round1(shot.y), z: round1(shot.z), vx: round1(shot.vx), vy: round1(shot.vy), vz: round1(shot.vz) });
  }

  // ---------------------------------------------------------------- treasure and loot
  addSpot(map, key, x, z) { const id = `${key[0]}${this.nextSpot++}`; map.set(id, { id, x, z }); const st = new Spot(); Object.assign(st, { x, z }); this.state[key].set(id, st); return id; }
  dropSpot(map, key, id) { map.delete(id); this.state[key].delete(id); }
  buryChest() { const spot = chestSpot(Math.random, [...this.chests.values()]); if (spot) this.addSpot(this.chests, 'chests', ...spot); else this.chestTimers.push(10); }
  // loot spilled into the sea as floating coins (a sunk hold, a lost dinghy, a knocked-out captain)
  spill(x, z, gold, spread = 50) {
    const n = Math.min(24, Math.ceil(gold / COIN_GOLD));
    for (let k = 0; k < n; k++) { const cx = x + (Math.random() - 0.5) * spread, cz = z + (Math.random() - 0.5) * spread; if (sailable(cx, cz, 2)) this.addSpot(this.coins, 'coins', cx, cz); }
    return n;
  }

  // ---------------------------------------------------------------- the Navy and merchantmen
  spawnNpc(n) {
    const pirates = [...this.bodies.values()].filter(b => b.kind === 'pirate');
    const spot = openSpot(pirates, 450, 1600, Math.random); if (!spot) { n.down = 3; return; }
    const e = Object.assign(newNpc(n.kind, spot[0], spot[1], Math.random), { id: n.id, reload: { [PORT]: 0, [STARBOARD]: 0 }, bump: new Map(), shield: 0 });
    this.bodies.set(n.id, e);
    const names = NPC_NAMES[n.kind], ship = new Ship();
    Object.assign(ship, { name: names[(n.named++ + Number(n.id.slice(3))) % names.length], color: '', kind: n.kind, home: -1 });
    this.state.ships.set(n.id, ship); this.publish(e, ship);
  }

  // who a ship's guns lay onto: every other hull afloat, and a monster that's up
  targetsFor(b) {
    const list = [...this.bodies.values()].filter(o => o !== b && !o.sinking);
    for (const m of this.monsters.values()) if (!m.slain && m.y > -3) list.push(m);
    return list;
  }

  // a broadside: three balls rippling bow to stern; each gun announces itself with a 'shot' message as it fires
  fire(b, side, vh, spread, stagger) {
    this.balls.push(...GUNS.map((lx, k) => ({ id: this.nextBall++, owner: b.id, side, lx, vh, spread, delay: k * stagger, live: false })));
  }

  // hull damage from any cause; at zero the ship founders (a captain waits for a fresh ship, a patrol is replaced)
  damage(b, n, by, cause) {
    if (n <= 0 || b.sinking || b.shield > 0) return 0;
    const dealt = Math.min(n, b.hp); b.hp -= dealt;
    if (b.kind !== 'pirate' && this.bodies.get(by)?.kind === 'pirate') b.provoked.add(by); // attacked: it fights back
    if (b.hp <= 0) {
      b.sinking = true; b.sinkT = 0; b.path = []; b.goal = null; this.broadcast('sunk', { ship: b.id, by, cause });
      if (b.kind === 'pirate') { this.spill(b.x, b.z, b.cargo); b.cargo = 0; if (b.av.mode === 'ship') launchDinghy(b.av, b); } // abandon ship!
      else this.spill(b.x, b.z, 100, 40); // a sunk patrol scatters its purse
    }
    return dealt;
  }

  // ---------------------------------------------------------------- sea monsters
  // the Kraken rises under the storm; the White Whale near a captain, clear of the storm
  raiseMonster(kind, x, z) {
    const pirates = [...this.bodies.values()].filter(b => b.kind === 'pirate' && !b.sinking);
    const spot = num(x) && num(z) ? [x, z] : kind === 'kraken' ? (this.storm && stormSpot(pirates, this.storm, Math.random)) : monsterSpot(pirates, Math.random, this.storm);
    if (!spot) { if (kind === 'kraken') this.krakenT = 5; else this.whaleT = 10; return; } // try again shortly
    const m = Object.assign(newMonster(kind, spot[0], spot[1], Math.random), { id: `m${this.nextMonster++}` });
    this.monsters.set(m.id, m);
    const st = new Monster(); Object.assign(st, { kind, maxHp: m.maxHp, grab: '' }); this.state.monsters.set(m.id, st); this.publishMonster(m);
    this.broadcast('monster', { id: m.id, kind, event: 'rise', x: round1(m.x), z: round1(m.z) });
  }
  publishMonster(m) {
    const st = this.state.monsters.get(m.id); if (!st) return;
    Object.assign(st, { x: m.x, z: m.z, y: m.y, yaw: m.yaw, speed: m.speed, hp: m.hp, mode: m.mode, grab: m.grab || '' });
  }

  update(dt) {
    this.time += dt; this.state.t = this.time;
    const bodies = [...this.bodies.values()], afloat = () => bodies.filter(b => !b.sinking);
    const pirates = bodies.filter(b => b.kind === 'pirate');

    // captains: sail, founder, relaunch at their hideout, get patched up there
    for (const b of pirates) {
      for (const sd of [PORT, STARBOARD]) b.reload[sd] = Math.max(0, b.reload[sd] - dt);
      b.shield = Math.max(0, b.shield - dt);
      if (b.sinking) b.sinkT += dt;
      stepShip(b, dt, b.sinking, windAt(b.x, b.z, this.time, this.storm));
      const [hx, hz] = findHomeSpot(b.home), a = b.av, atHome = (x, z) => Math.hypot(x - hx, z - hz) < HOME_RADIUS;
      if (!b.sinking && b.hp < b.maxHp && atHome(b.x, b.z)) { b.hp = b.maxHp; this.broadcast('repaired', { ship: b.id }); }
      // the captain: aboard, rowing, or ashore
      if (a.drawT > 0 && (a.drawT -= dt) <= 0 && (a.mode === 'shore' || a.mode === 'dinghy')) this.pistol(b);
      const ev = stepAvatar(a, dt, b.sinking ? null : b);
      if (ev === 'boarded') { b.cargo += a.carry; a.carry = 0; this.broadcast('captain', { ship: b.id, event: 'boarded' }); }
      else if (ev === 'landed' || ev === 'embarked') this.broadcast('captain', { ship: b.id, event: ev });
      else if (ev === 'dug') { const c = this.chests.get(a.dig); a.dig = null; a.digT = 0;
        if (c) { this.dropSpot(this.chests, 'chests', c.id); this.chestTimers.push(CHEST_RESPAWN_S); a.carry += CHEST_GOLD; this.broadcast('dug', { ship: b.id, chest: c.id, x: round1(c.x), z: round1(c.z) }); } }
      else if (ev === 'rescued') { this.launch(b, pirates); this.broadcast('captain', { ship: b.id, event: 'rescued' }); }
      if (a.mode === 'ship') { a.x = b.x; a.z = b.z; a.yaw = b.yaw; }
      // home: the hold (or the dinghy's load) is banked; a captain who rowed home without a ship gets a fresh one
      if (a.mode === 'dinghy' && atHome(a.x, a.z)) {
        if (a.carry) { b.gold += a.carry; this.broadcast('bank', { ship: b.id, gold: a.carry, total: b.gold }); a.carry = 0; }
        if (b.sinking) { this.launch(b, pirates); this.broadcast('captain', { ship: b.id, event: 'newship' }); }
      }
      if (a.mode === 'ship' && !b.sinking && b.cargo && atHome(b.x, b.z)) { b.gold += b.cargo; this.broadcast('bank', { ship: b.id, gold: b.cargo, total: b.gold }); b.cargo = 0; }
      // floating coins: scooped up by a ship or a dinghy
      for (const c of [...this.coins.values()]) {
        if (a.mode === 'ship' && !b.sinking && Math.hypot(b.x - c.x, b.z - c.z) < 18) { b.cargo += COIN_GOLD; this.dropSpot(this.coins, 'coins', c.id); }
        else if (a.mode === 'dinghy' && Math.hypot(a.x - c.x, a.z - c.z) < 12) { a.carry += COIN_GOLD; this.dropSpot(this.coins, 'coins', c.id); }
      }
    }
    // dug chests are buried again somewhere else after a while
    for (let i = this.chestTimers.length - 1; i >= 0; i--) if ((this.chestTimers[i] -= dt) <= 0) { this.chestTimers.splice(i, 1); this.buryChest(); }

    // patrols: chase and fight captains, or founder and make way for a replacement
    const foes = pirates.filter(b => !b.sinking && b.shield <= 0);
    for (const n of this.npcs) {
      const e = this.bodies.get(n.id);
      if (!e) { if (pirates.length && (n.down -= dt) <= 0) this.spawnNpc(n); continue; }
      if (e.sinking) {
        e.speed *= 1 - dt * 0.6; moveNpc(e, dt, null);
        if ((e.sinkT += dt) >= NPC_SINK_S) { this.bodies.delete(n.id); this.state.ships.delete(n.id); n.down = NPC_RESPAWN_S; }
        continue;
      }
      stepNpc(e, dt, foes, {
        rnd: Math.random,
        fire: (e, side, vh) => this.fire(e, side, vh, 18, 0.16),
        engage: (e, foe, provoked) => this.broadcast('engage', { ship: e.id, target: foe.id, provoked }),
      }, windAt(e.x, e.z, this.time, this.storm));
    }

    // the storm: brews over open water, drifts, and brings the Kraken once it's at full strength
    const anyoneAfloat = pirates.some(b => !b.sinking);
    if (this.storm) {
      const ev = stepStorm(this.storm, dt);
      if (ev === 'full') this.krakenT = KRAKEN_AFTER;
      if (this.storm.mode === 'clear' || ev === 'gone') for (const m of this.monsters.values()) if (m.kind === 'kraken' && m.mode !== 'sink' && m.mode !== 'gone') { dismissMonster(m); this.broadcast('monster', { id: m.id, kind: m.kind, event: 'leave' }); }
      if (ev === 'gone') { this.storm = null; this.stormT = rr(...STORM_NEXT); this.krakenT = null; this.broadcast('storm', { event: 'gone' }); }
    } else if (anyoneAfloat && (this.stormT -= dt) <= 0) {
      this.storm = newStorm(Math.random, pirates); if (!this.storm) this.stormT = 10; else this.broadcast('storm', { event: 'brew', x: round1(this.storm.x), z: round1(this.storm.z) });
    }
    if (this.krakenT != null && (this.krakenT -= dt) <= 0) { this.krakenT = null; if (this.storm && this.storm.mode === 'full') this.raiseMonster('kraken'); }
    const s = this.storm; Object.assign(this.state, { stormX: s ? s.x : 0, stormZ: s ? s.z : 0, stormDir: s ? s.dir : 0, stormFade: s ? s.fade : 0 });

    // the White Whale: every few minutes near someone
    const whaleUp = [...this.monsters.values()].some(m => m.kind === 'whale');
    if (!whaleUp && anyoneAfloat && (this.whaleT -= dt) <= 0) { this.whaleT = rr(...MONSTER_NEXT); this.raiseMonster('whale'); }

    // monsters go after whatever hull is nearest
    for (const m of [...this.monsters.values()]) {
      stepMonster(m, dt, afloat(), {
        maul: (m, s, n, how) => { const dealt = this.damage(s, n, m.id, m.kind); this.broadcast('maul', { monster: m.id, ship: s.id, how, dmg: dealt, x: round1(s.x), z: round1(s.z) }); },
        grab: (m, s) => this.broadcast('monster', { id: m.id, kind: m.kind, event: 'grab', ship: s.id }),
        leave: m => this.broadcast('monster', { id: m.id, kind: m.kind, event: 'leave' }),
      }, m.kind === 'kraken' ? this.storm : null);
      this.publishMonster(m);
      if (m.mode === 'gone') { this.state.monsters.delete(m.id); this.monsters.delete(m.id); }
    }

    // cannonballs: each gun fires on its beat, then the ball flies until it hits a ship, a monster, the water or the land
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const ball = this.balls[i], owner = this.bodies.get(ball.owner);
      if (!ball.live) {
        ball.delay -= dt; if (ball.delay > 0) continue;
        if (!owner || owner.sinking) { this.balls.splice(i, 1); continue; }
        Object.assign(ball, gunBall(owner, ball.side, ball.lx, ball.vh, ball.spread, Math.random), { live: true });
        owner.driftV -= ball.side * 2.6; owner.speed *= 0.93; // every gun kicks the ship sideways
        this.broadcast('shot', { id: ball.id, ship: ball.owner, side: ball.side, x: round1(ball.x), y: round1(ball.y), z: round1(ball.z), vx: round1(ball.vx), vy: round1(ball.vy), vz: round1(ball.vz) });
      }
      stepBall(ball, dt);
      const hit = bodies.find(o => o.id !== ball.owner && !o.sinking && inHull(o, ball.x, ball.y, ball.z));
      const beast = hit ? null : [...this.monsters.values()].find(m => monsterHit(m, ball.x, ball.y, ball.z)) || null;
      const ground = heightAt(ball.x, ball.z);
      let kind = null;
      if (hit) { kind = 'ship'; const dealt = this.damage(hit, 1, ball.owner, 'cannon'); if (!dealt) kind = 'shrug'; }
      else if (beast) { kind = 'monster'; if (hurtMonster(beast, 1)) { this.broadcast('monster', { id: beast.id, kind: beast.kind, event: 'slain', by: ball.owner });
        if (beast.kind === 'kraken' && this.storm) { clearStorm(this.storm); this.broadcast('storm', { event: 'clear', by: ball.owner }); } } } // beat the Kraken and its storm clears
      else if (ball.y < Math.max(ground, 0)) kind = ground > 0.3 ? 'land' : 'water';
      if (!kind) continue;
      if (kind === 'water' || kind === 'land' || kind === 'ship') for (const p of pirates) { // splash damage to captains off their ships
        if (p.id === ball.owner) continue; const a = p.av, carried = a.carry, where = [a.x, a.z], res = splashAvatar(a, ball.x, ball.z); if (!res) continue;
        if (res === 'dinghy' || res === 'knocked') { this.spill(...where, carried, 20); a.carry = 0; }
        this.broadcast('captain', { ship: p.id, event: res, by: ball.owner });
      }
      this.broadcast('impact', { id: ball.id, kind, ship: hit ? hit.id : beast ? beast.id : null, by: ball.owner, x: round1(ball.x), y: round1(Math.max(ball.y, ground, 0)), z: round1(ball.z) });
      this.balls.splice(i, 1);
    }

    // collisions: hulls push apart and bounce; a hard scrape or ram costs hull when a captain is involved
    const up = afloat();
    for (let i = 0; i < up.length; i++) for (let j = i + 1; j < up.length; j++) {
      const P = up[i], Q = up[j], hit = collide(P, Q); if (!hit || !hit.hard) continue;
      if (P.kind !== 'pirate' && Q.kind !== 'pirate') continue; // patrols just bounce off each other
      const last = P.bump.get(Q.id) || 0; if (this.clock.currentTime - last < 1200) continue; // one bump per pair per 1.2 s
      P.bump.set(Q.id, this.clock.currentTime);
      const dmgP = this.damage(P, hit.dmgP, Q.id, 'collision'), dmgQ = this.damage(Q, hit.dmgQ, P.id, 'collision');
      this.broadcast('bump', { a: P.id, b: Q.id, kind: hit.kind, rammer: hit.kind === 'ram' ? (hit.rammer === 'P' ? P.id : Q.id) : null, dmgA: dmgP, dmgB: dmgQ, x: round1(hit.cx), z: round1(hit.cz) });
    }

    for (const b of this.bodies.values()) { const s = this.state.ships.get(b.id); if (s) this.publish(b, s); }
  }

  publish(b, s) {
    Object.assign(s, { x: b.x, z: b.z, yaw: b.yaw, speed: b.speed, sailing: b.path.length > 0, boost: !!b.boost, hp: b.hp, maxHp: b.maxHp, sinking: b.sinking, shielded: b.shield > 0, launches: b.launches || 0 });
    const a = b.av; if (a) Object.assign(s, { mode: a.mode, ax: a.x, az: a.z, ayaw: a.yaw, moving: a.moving, digging: !!a.dig, marooned: a.marooned, dinX: a.dinX, dinZ: a.dinZ, dinYaw: a.dinYaw,
      hearts: a.hearts, carry: a.carry, cargo: b.cargo, gold: b.gold });
    if (b.goal) { s.goalX = b.goal[0]; s.goalZ = b.goal[1]; }
  }
}

