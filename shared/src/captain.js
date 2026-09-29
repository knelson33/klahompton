// The captain off the ship: rowing the dinghy, walking ashore, digging up treasure, and a pistol.
// Pure rules shared by the server (online) and the browser (single-player).
//
// An avatar is one captain: { mode, x, z, yaw, path, then, dinX, dinZ, dinYaw, carry, hearts, dig, digT, reload, lostT, marooned }
//   mode 'ship'   aboard (x, z follow the ship)
//        'dinghy' rowing (x, z is the dinghy)
//        'shore'  walking (x, z is the captain; dinX/dinZ is the dinghy, pulled up on the beach)
//        'lost'   dinghy sunk or captain knocked out: waiting lostT seconds to wash up at the hideout
import { sdAt, heightAt, clamp } from './world.js';
import { findPath, findWalk, nearestOpen, nearestWalk, cellPos } from './nav.js';
import { KNOT } from './weather.js';

export const DINGHY_SPEED = 3.5 * KNOT, WALK_SPEED = 4 * KNOT, CARRY_SPEED = 2.8 * KNOT;
export const HEARTS = 3, DIG_S = 3, DIG_RANGE = 12, BOARD_RANGE = 26, LOST_S = 10;
export const PISTOL_RELOAD = 1.5;                  // the pistol fires straight ahead, a small cannonball good for about 80 units
export const PISTOL_DRAW = 0.3;                    // he raises the pistol this long before it goes off
export const HURT_R = { dinghy: 5, shore: 6 }; // a cannonball landing this close sinks the dinghy / costs the captain a heart

export const newAvatar = () => ({ mode: 'ship', x: 0, z: 0, yaw: 0, path: [], then: null, dinX: 0, dinZ: 0, dinYaw: 0, carry: 0, hearts: HEARTS, dig: null, digT: 0, reload: 0, lostT: 0, marooned: false, moving: false });

// into the dinghy beside the ship (going ashore, or abandoning a sinking ship)
export function launchDinghy(a, ship) {
  const R = [Math.sin(ship.yaw), Math.cos(ship.yaw)];
  Object.assign(a, { mode: 'dinghy', x: ship.x + R[0] * 12, z: ship.z + R[1] * 12, yaw: ship.yaw, path: [], then: null, dig: null, marooned: false });
}
// back to a fresh ship at the hideout: full hearts, empty hands
export const resetAvatar = a => Object.assign(a, { mode: 'ship', path: [], then: null, carry: 0, hearts: HEARTS, dig: null, digT: 0, lostT: 0, marooned: false });

// plan a move toward (tx, tz) for the current mode. ship: your ship, or null once it has sunk. false: no way there.
// board: this is the Board / Back button, which is the only way back aboard the ship or into the dinghy (a tap just goes there)
export function avatarGo(a, tx, tz, ship, board = false) {
  a.then = null; a.dig = null; a.digT = 0;
  if (a.mode === 'dinghy') {
    if (board && ship && !ship.sinking) { // back aboard
      const p = findPath(a.x, a.z, ship.x, ship.z); if (!p) return false; a.path = p; a.then = { do: 'board' }; return true;
    }
    if (sdAt(tx, tz) > 0) { // row for the beach nearest the spot, then step ashore and walk on
      const w = nearestOpen(tx, tz), l = w && nearestWalk(...cellPos(...w)); if (!l) return false;
      const [wx, wz] = cellPos(...w), [lx, lz] = cellPos(...l), p = findPath(a.x, a.z, wx, wz); if (!p) return false;
      let bx = wx, bz = wz; const L = Math.hypot(lx - wx, lz - wz); // run in through the shallows to the waterline
      for (let s = 0; s < L; s += 2) { const x = wx + (lx - wx) * s / L, z = wz + (lz - wz) * s / L; if (sdAt(x, z) > -1.5) break; bx = x; bz = z; }
      a.path = [...p, [bx, bz]]; a.then = { do: 'land', lx, lz, tx, tz }; return true;
    }
    const p = findPath(a.x, a.z, tx, tz); if (!p) return false; a.path = p; return true;
  }
  if (a.mode === 'shore') {
    if (board && !a.marooned) { // back to the dinghy
      const l = nearestWalk(a.dinX, a.dinZ); if (!l) return false; const p = findWalk(a.x, a.z, ...cellPos(...l)); if (!p) return false;
      a.path = p; a.then = { do: 'embark', board: !!(ship && !ship.sinking) }; return true;
    }
    const p = findWalk(a.x, a.z, tx, tz); if (!p) return false; a.path = p; return true;
  }
  return false;
}

// one step. Returns what happened: 'landed' | 'boarded' | 'embarked' | 'arrived' | 'dug' | 'rescued' | null
export function stepAvatar(a, dt, ship) {
  a.reload = Math.max(0, a.reload - dt);
  if (a.mode === 'lost' || a.marooned) { a.lostT -= dt; if (a.lostT <= 0) return 'rescued'; if (a.mode === 'lost') return null; }
  if (a.dig) { a.moving = false; a.digT += dt; if (a.digT >= DIG_S) return 'dug'; return null; }
  if (a.mode !== 'dinghy' && a.mode !== 'shore') return null;
  if (a.then && a.then.do === 'board' && ship && !ship.sinking && Math.hypot(a.x - ship.x, a.z - ship.z) < BOARD_RANGE) { a.path = []; a.then = null; a.mode = 'ship'; return 'boarded'; }
  if (!a.path.length) { a.moving = false; return null; }
  const speed = a.mode === 'dinghy' ? DINGHY_SPEED : a.carry ? CARRY_SPEED : WALK_SPEED;
  const [wx, wz] = a.path[0], dx = wx - a.x, dz = wz - a.z, d = Math.hypot(dx, dz), step = speed * dt;
  if (d > 0.01) { const want = Math.atan2(-dz, dx), diff = Math.atan2(Math.sin(want - a.yaw), Math.cos(want - a.yaw)); a.yaw += clamp(diff, -4 * dt, 4 * dt); }
  a.moving = true;
  if (d > step) { a.x += dx / d * step; a.z += dz / d * step; return null; }
  a.x = wx; a.z = wz; a.path.shift(); if (a.path.length) return null;
  a.moving = false;
  const then = a.then; a.then = null;
  if (then && then.do === 'land') { // pull the dinghy up and step ashore
    Object.assign(a, { dinX: a.x, dinZ: a.z, dinYaw: a.yaw, mode: 'shore', x: then.lx, z: then.lz });
    if (Math.hypot(then.tx - then.lx, then.tz - then.lz) > 8) a.path = findWalk(a.x, a.z, then.tx, then.tz) || [];
    return 'landed';
  }
  if (then && then.do === 'embark') { Object.assign(a, { mode: 'dinghy', x: a.dinX, z: a.dinZ, yaw: a.dinYaw + Math.PI });
    if (then.board && ship && !ship.sinking) avatarGo(a, ship.x, ship.z, ship, true); // pushed off: row on out to the ship
    return 'embarked'; }
  if (then && then.do === 'board') { a.then = then; return null; } // not there yet: the ship moved; the caller re-routes
  return 'arrived';
}

// the nearest undug chest within reach ({ id, x, z } list)
export const nearestChest = (a, chests, range = DIG_RANGE) => { let best = null, bd = range; for (const c of chests) { const d = Math.hypot(c.x - a.x, c.z - a.z); if (d < bd) { bd = d; best = c; } } return best; };
export function startDig(a, chests) {
  if (a.mode !== 'shore' || a.carry || a.dig) return null;
  const c = nearestChest(a, chests); if (!c) return null;
  Object.assign(a, { dig: c.id, digT: 0, path: [], then: null, yaw: Math.atan2(-(c.z - a.z), c.x - a.x) }); return c;
}

// the pistol: one ball straight ahead the way the captain (or his dinghy) faces, flying like a cannonball.
// It leaves from the muzzle: his right hand held out ahead at shoulder height (lower and further back when he's sitting in the dinghy).
export function pistolBall(a) {
  const F = [Math.cos(a.yaw), -Math.sin(a.yaw)], R = [Math.sin(a.yaw), Math.cos(a.yaw)], vh = 70;
  const [ahead, right, up] = a.mode === 'shore' ? [2.5, 0.9, Math.max(0, heightAt(a.x, a.z)) + 3.75] : [1.6, 0.72, 2.45];
  return { x: a.x + F[0] * ahead + R[0] * right, y: up, z: a.z + F[1] * ahead + R[1] * right, vx: F[0] * vh, vy: 10, vz: F[1] * vh };
}

// a cannonball came down at (x, z): does it hurt this captain? returns 'dinghy' (sunk), 'heart', 'knocked' (out of hearts),
// 'boat' (the beached dinghy is smashed: marooned), or null. Spills whatever the captain carried when the dinghy sinks or he's knocked out.
export function splashAvatar(a, x, z) {
  if (a.mode === 'dinghy' && Math.hypot(x - a.x, z - a.z) < HURT_R.dinghy) { Object.assign(a, { mode: 'lost', lostT: LOST_S, path: [], then: null, dig: null }); return 'dinghy'; }
  if (a.mode !== 'shore') return null;
  if (!a.marooned && Math.hypot(x - a.dinX, z - a.dinZ) < HURT_R.dinghy) { a.marooned = true; a.lostT = LOST_S; return 'boat'; }
  if (Math.hypot(x - a.x, z - a.z) < HURT_R.shore) {
    a.hearts -= 1; if (a.hearts > 0) return 'heart';
    Object.assign(a, { mode: 'lost', lostT: LOST_S, path: [], then: null, dig: null }); return 'knocked';
  }
  return null;
}
