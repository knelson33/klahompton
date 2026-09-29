// The Royal Navy and the merchantmen: how they patrol, when they pick a fight, and how they fight.
// The server runs this online; the browser runs it in single-player. Pure rules: the caller supplies
// the ships they can fight and does the firing, planning and announcing.
import { clamp, TAU, sdAt } from './world.js';
import { NAV, sailable, findPath } from './nav.js';
import { BALL_G, BALL_VY, HULL_HITS } from './combat.js';
import { blow } from './ship.js';

export const NPC_TOP = { navy: 12, merchant: 9 };   // top speeds (units/s)
export const NPC_RELOAD = { navy: 6, merchant: 8 };
export const NPC_RESPAWN_S = 25;                     // a sunk patrol is replaced this long after it goes under
export const NPC_SINK_S = 12;                         // ...and takes this long to go under
export const SIGHT = 450, CHASE = 650;               // the Navy engages a ship ahead of its bow within SIGHT; anyone gives up past CHASE
export const FLEET = ['navy', 'navy', 'merchant', 'navy', 'merchant'];
export const NPC_NAMES = { navy: ['HMS Satellite', 'HMS Plumper', 'HMS Tribune', 'HMS Hecate'], merchant: ['Brig Constance', 'Schooner Mary Ellen', 'Barque Otter'] };

// open water at least minD from every point in `away` (and within maxD of the first), inside the charted sea
export function openSpot(away, minD, maxD, rnd) {
  const [x0, z0] = away.length ? [away[0].x, away[0].z] : [-900, 300];
  for (let t = 0; t < 600; t++) { const a = rnd() * TAU, r = minD + rnd() * (maxD - minD), x = x0 + Math.cos(a) * r, z = z0 + Math.sin(a) * r;
    if (x > NAV.x0 + 60 && x < Math.min(NAV.x1, 1050) && z > NAV.z0 + 60 && z < NAV.z1 - 60 && sdAt(x, z) < -45 && away.every(o => Math.hypot(o.x - x, o.z - z) >= minD)) return [x, z]; }
  return null;
}
// a fresh patrol (fields the rules need; callers add their own)
export function newNpc(kind, x, z, rnd) {
  const hp = HULL_HITS[kind];
  return { kind, x, z, yaw: rnd() * TAU, speed: 0, turn: 0, driftV: 0, path: [], planT: 0, hp, maxHp: hp, max: NPC_TOP[kind],
    target: null, provoked: new Set(), gunT: 0, sinking: false, sinkT: 0 };
}

// one step for a ship afloat. foes: ships it may fight ({ id, x, z, yaw, speed }).
// act: { rnd, fire(e, side, vh), engage(e, foe, provoked) } — engage is told when it picks a new target.
export function stepNpc(e, dt, foes, act, wind = null) {
  // who to fight: keep chasing the same ship until it's CHASE away; otherwise the nearest one it has a reason to
  let tgt = e.target != null ? foes.find(f => f.id === e.target) : null;
  if (tgt && Math.hypot(tgt.x - e.x, tgt.z - e.z) > CHASE) tgt = null;
  if (!tgt) {
    let bd = Infinity;
    for (const f of foes) { const dx = f.x - e.x, dz = f.z - e.z, d = Math.hypot(dx, dz), ahead = dx * Math.cos(e.yaw) - dz * Math.sin(e.yaw) > 0;
      const sees = e.provoked.has(f.id) ? d < CHASE : e.kind === 'navy' && ahead && d < SIGHT; if (sees && d < bd) { bd = d; tgt = f; } }
    if (tgt) { e.path = []; e.gunT = 2.5; act.engage?.(e, tgt, e.provoked.has(tgt.id)); }
    else if (e.target != null) e.planT = 0; // lost them: back to patrolling
  }
  e.target = tgt ? tgt.id : null;

  let target = 0, want = 0;
  if (tgt) {
    // close in, then turn side-on so the guns bear
    const dxp = tgt.x - e.x, dzp = tgt.z - e.z, dP = Math.hypot(dxp, dzp), toP = Math.atan2(-dzp, dxp), wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
    const head = dP > 170 ? toP : Math.abs(wrap(toP + Math.PI / 2 - e.yaw)) < Math.abs(wrap(toP - Math.PI / 2 - e.yaw)) ? toP + Math.PI / 2 : toP - Math.PI / 2;
    want = clamp(wrap(head - e.yaw) * 2, -1, 1); target = e.max * (dP > 170 ? 1 : 0.6);
    // fire a broadside when the target is abeam and in range, laying the guns where it will be when the balls land
    e.gunT -= dt;
    const T = 2 * BALL_VY / BALL_G, R = [Math.sin(e.yaw), Math.cos(e.yaw)], F = [Math.cos(e.yaw), -Math.sin(e.yaw)];
    const lx = dxp + Math.cos(tgt.yaw) * tgt.speed * T, lz = dzp - Math.sin(tgt.yaw) * tgt.speed * T, across = lx * R[0] + lz * R[1], along = lx * F[0] + lz * F[1];
    if (e.gunT <= 0 && Math.abs(across) > 25 && Math.abs(across) < 240 && Math.abs(along) < Math.abs(across) * 0.6) {
      act.fire(e, Math.sign(across), clamp(Math.abs(across) / T, 30, 140)); e.gunT = NPC_RELOAD[e.kind];
    }
  }
  else if (e.path.length) { const [wx, wz] = e.path[0], dx = wx - e.x, dz = wz - e.z; if (Math.hypot(dx, dz) < 25) e.path.shift();
    else { let diff = Math.atan2(-dz, dx) - e.yaw; diff = Math.atan2(Math.sin(diff), Math.cos(diff)); want = clamp(diff * 2, -1, 1); target = e.max * (1 - Math.min(0.7, Math.abs(diff) / Math.PI * 1.4)); } }
  else if ((e.planT -= dt) <= 0) { const spot = openSpot([e], 250, 800, act.rnd); const p = spot && findPath(e.x, e.z, spot[0], spot[1]); if (p) e.path = p; else e.planT = 1; }
  e.turn += (want - e.turn) * Math.min(1, dt * 2); e.yaw += e.turn * 0.5 * dt * clamp(e.speed / 6, 0.35, 1);
  e.speed += clamp(target * (0.4 + 0.6 * e.hp / e.maxHp) - e.speed, -8 * dt, 3 * dt); // a battered ship sails slower
  moveNpc(e, dt, wind, !!tgt);
}
// movement for any NPC hull, afloat or foundering: forward, blocked by land, wind, and sideways shove
export function moveNpc(e, dt, wind, engaged = false) {
  const nx = e.x + Math.cos(e.yaw) * e.speed * dt, nz = e.z - Math.sin(e.yaw) * e.speed * dt;
  if (sailable(nx, nz, 3)) { e.x = nx; e.z = nz; } else { e.speed = 0; e.path = []; if (engaged) e.yaw += dt * 0.9; } // blocked by land: swing clear
  if (!e.sinking) blow(e, dt, wind, e.max);
  e.driftV = (e.driftV || 0) * Math.max(0, 1 - dt * 1.4);
  const sx = e.x + Math.sin(e.yaw) * e.driftV * dt, sz = e.z + Math.cos(e.yaw) * e.driftV * dt; if (sailable(sx, sz, 3)) { e.x = sx; e.z = sz; }
}
