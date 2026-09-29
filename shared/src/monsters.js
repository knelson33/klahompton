// Sea monsters: the Kraken and the White Whale. Each picks on the nearest hull (pirate, Navy or merchant alike)
// and sinks back once it's shot to pieces. The Kraken rises under each storm once it's at full strength (the dark
// clouds are the clue), grabs a ship and squeezes; it stays until it's driven off or the storm blows out.
// The White Whale turns up every few minutes near a ship (never in the storm), charges and rams, and leaves after a couple of minutes.
// Pure rules shared by the server (online) and the browser (single-player).
import { clamp, TAU } from './world.js';
import { sailable } from './nav.js';
import { hullOf, closestOnSegments } from './combat.js';
import { STORM } from './weather.js';

export const MONSTERS = {
  kraken: { name: 'The Kraken', hp: 10, life: 120 },
  whale: { name: 'The White Whale', hp: 12, life: 120 },
};
export const MONSTER_FIRST = [60, 150], MONSTER_NEXT = [120, 240]; // seconds before the first White Whale, and between them
export const KRAKEN_AFTER = 8; // seconds after a storm reaches full strength before its Kraken rises
const RISE_S = 3, SINK_S = 4;
export const KRAKEN_SIZE = 2; // the Kraken is drawn (and reaches, and takes hits) at twice its model size
const DEPTH = { kraken: 14 * KRAKEN_SIZE, whale: 14 };   // how far down it rises from
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// deep water 350-700 units from one of the ships, so somebody meets it, and clear of any storm (that's the Kraken's)
export function monsterSpot(ships, rnd, storm = null) {
  for (let k = 0; k < 400 && ships.length; k++) {
    const s = ships[Math.floor(rnd() * ships.length)], a = rnd() * TAU, r = 350 + rnd() * 350, x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
    if (sailable(x, z, 55) && (!storm || Math.hypot(x - storm.x, z - storm.z) > STORM.r) && ships.every(o => Math.hypot(o.x - x, o.z - z) > 250)) return [x, z];
  }
  return null;
}
// deep water under the storm's clouds (null while it's over land: try again shortly)
export function stormSpot(ships, storm, rnd) {
  for (let k = 0; k < 400; k++) { const a = rnd() * TAU, r = Math.sqrt(rnd()) * STORM.r * 0.6, x = storm.x + Math.cos(a) * r, z = storm.z + Math.sin(a) * r;
    if (sailable(x, z, 55) && ships.every(o => Math.hypot(o.x - x, o.z - z) > 250)) return [x, z]; }
  return null;
}
// send a monster back down (its storm has blown out)
export const dismissMonster = m => { if (m.mode !== 'sink' && m.mode !== 'gone') { m.mode = 'sink'; m.t = 0; m.grab = null; } };
export function newMonster(kind, x, z, rnd) {
  const M = MONSTERS[kind];
  return { kind, x, z, yaw: rnd() * TAU, y: -DEPTH[kind], speed: 0, hp: M.hp, maxHp: M.hp, mode: 'rise', t: 0, age: 0, grab: null, grabT: 0, squeezes: 0, cool: 0, target: null, veer: 0, slain: false };
}

// is a cannonball at (x, y, z) inside the monster? (the Kraken's head, the Whale's body)
export function monsterHit(m, x, y, z) {
  if (m.mode === 'gone' || m.slain || m.y < -5) return false;
  if (m.kind === 'kraken') return y < 16 * KRAKEN_SIZE && Math.hypot(x - m.x, z - m.z) < 12 * KRAKEN_SIZE;
  const fx = Math.cos(m.yaw), fz = -Math.sin(m.yaw), ax = m.x - fx * 14, az = m.z - fz * 14, dx = fx * 27, dz = fz * 27;
  const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
  return y < 9 && Math.hypot(x - (ax + dx * t), z - (az + dz * t)) < 6.5;
}
// cannon damage; returns true when this hit finishes it
export function hurtMonster(m, n) {
  if (m.slain || m.mode === 'gone') return false;
  m.hp = Math.max(0, m.hp - n); if (m.hp > 0) return false;
  m.slain = true; m.mode = 'sink'; m.t = 0; m.grab = null; return true;
}

// one step. ships: every hull afloat ({ id, x, z, yaw, speed, driftV, kind }).
// act: { maul(m, ship, dmg, how), grab(m, ship), leave(m) } — maul hurts a ship ('squeeze' or 'ram').
// storm: the Kraken's storm, which it drifts along under
export function stepMonster(m, dt, ships, act, storm = null) {
  if (m.mode === 'gone') return;
  if (m.mode === 'rise') { m.t += dt; m.y = -DEPTH[m.kind] * (1 - Math.min(1, m.t / RISE_S)); if (m.t >= RISE_S) { m.mode = 'hunt'; m.t = 0; } return; }
  if (m.mode === 'sink') { m.t += dt; m.y -= dt * (m.slain ? 3 : 5) * (m.kind === 'kraken' ? KRAKEN_SIZE : 1); m.speed *= 1 - dt; if (m.t >= SINK_S) m.mode = 'gone'; return; }
  m.age += dt;
  if (m.kind === 'whale' && m.age > MONSTERS.whale.life) { m.mode = 'sink'; m.t = 0; act.leave?.(m); return; } // the Kraken stays as long as its storm
  const near = (range) => { let best = null, bd = range; for (const s of ships) { const d = Math.hypot(s.x - m.x, s.z - m.z); if (d < bd) { bd = d; best = s; } } return best; };
  if (m.kind === 'kraken') stepKraken(m, dt, ships, act, near, storm);
  else stepWhale(m, dt, ships, act, near);
}

// the Kraken lurks, creeps toward the nearest ship, then wraps it in tentacles: held nearly still, squeezed
// once every 2.5 s (three squeezes at most) before it lets go to catch its breath
function stepKraken(m, dt, ships, act, near, storm) {
  m.cool = Math.max(0, m.cool - dt);
  if (m.grab != null) {
    const s = ships.find(o => o.id === m.grab);
    if (!s || Math.hypot(s.x - m.x, s.z - m.z) > 70 * KRAKEN_SIZE) { m.grab = null; m.cool = 5; return; }
    s.speed = Math.min(s.speed, 3); s.straightT = 0; // held fast
    m.grabT += dt;
    if (m.grabT >= 2.5 * (m.squeezes + 1)) { m.squeezes++; act.maul(m, s, 1, 'squeeze'); }
    if (m.squeezes >= 3) { m.grab = null; m.cool = 6; }
    return;
  }
  const s = near(500); m.target = s ? s.id : null;
  if (!s) { // nothing to grab: keep under the storm as it drifts
    if (!storm) return;
    const dx = storm.x - m.x, dz = storm.z - m.z, d = Math.hypot(dx, dz);
    if (d > STORM.r * 0.35) { const v = 5 * dt, x = m.x + dx / d * v, z = m.z + dz / d * v; if (sailable(x, z, 20)) { m.x = x; m.z = z; } }
    return;
  }
  const dx = s.x - m.x, dz = s.z - m.z, d = Math.hypot(dx, dz);
  m.yaw = Math.atan2(-dz, dx);
  if (d > 32 * KRAKEN_SIZE) { const v = 8 * dt, x = m.x + dx / d * v, z = m.z + dz / d * v; if (sailable(x, z, 8)) { m.x = x; m.z = z; } }
  if (m.cool <= 0 && d < 50 * KRAKEN_SIZE) { m.grab = s.id; m.grabT = 0; m.squeezes = 0; act.grab?.(m, s); }
}

// the White Whale cruises until it spots a ship within 800, then charges at up to 36 units/s (faster than any
// ship). Ramming costs the ship 2 hits and knocks it aside; the Whale swims off, turns, and comes again.
function stepWhale(m, dt, ships, act, near) {
  let want = m.yaw, top = 12;
  if (m.veer > 0) { m.veer -= dt; want = m.veerYaw; top = 22; }
  else {
    const s = m.target != null ? ships.find(o => o.id === m.target && Math.hypot(o.x - m.x, o.z - m.z) < 900) || near(800) : near(800);
    m.target = s ? s.id : null;
    if (s) { // lead the target a little
      const lead = Math.min(1.2, Math.hypot(s.x - m.x, s.z - m.z) / 40), tx = s.x + Math.cos(s.yaw) * s.speed * lead, tz = s.z - Math.sin(s.yaw) * s.speed * lead;
      want = Math.atan2(-(tz - m.z), tx - m.x); top = 36;
      // contact: the Whale's head meets the ship's hull
      const H = hullOf(s), fx = Math.cos(m.yaw), fz = -Math.sin(m.yaw), head = { ax: m.x, az: m.z, bx: m.x + fx * 14, bz: m.z + fz * 14 };
      const [u, v] = closestOnSegments(head, H), px = head.ax + (head.bx - head.ax) * u, pz = head.az + (head.bz - head.az) * u, qx = H.ax + (H.bx - H.ax) * v, qz = H.az + (H.bz - H.az) * v;
      if (Math.hypot(px - qx, pz - qz) < H.r + 5 && m.speed > 14) {
        const side = Math.sign((m.x - s.x) * H.R[0] + (m.z - s.z) * H.R[1]) || 1; // knocked away from the side it was hit on
        s.driftV = (s.driftV || 0) - side * 16; s.speed *= 0.3; s.straightT = 0;
        act.maul(m, s, 2, 'ram');
        m.speed *= 0.35; m.veer = 5; m.veerYaw = m.yaw + (Math.random() < 0.5 ? 2.3 : -2.3);
      }
    }
    else want = m.yaw + Math.sin(m.age * 0.3) * 0.4; // wander
  }
  m.yaw += clamp(wrap(want - m.yaw), -1.3 * dt, 1.3 * dt);
  m.speed += clamp(top - m.speed, -20 * dt, 10 * dt);
  const x = m.x + Math.cos(m.yaw) * m.speed * dt, z = m.z - Math.sin(m.yaw) * m.speed * dt;
  if (sailable(x, z, 8)) { m.x = x; m.z = z; } else { m.yaw += 2.2 * dt; m.speed *= 1 - dt * 2; } // shoaling: swing back to deep water
}
