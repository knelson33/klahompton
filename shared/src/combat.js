// Combat rules shared by the server (which decides what happens) and the browser (which draws it, and
// referees single-player): hull shapes, reloads, cannonball flight, hits, and what a collision does.
import { clamp, lerp } from './world.js';
import { sailable } from './nav.js';

export const PORT = -1, STARBOARD = 1;       // broadside sides: port is left of the bow, starboard right
export const RELOAD = 7;                      // seconds for one side's guns to reload
export const BALL_G = 25, BALL_VY = 15;       // cannonball gravity and launch lift (units/s², units/s)
export const HULL_HITS = { pirate: 6, navy: 6, merchant: 4 };
export const RESPAWN_S = 10;                  // a sunk crew waits this long for a fresh ship
export const SPAWN_SHIELD_S = 3;              // ...and can't be hurt for this long after launching
export const GUNS = [-2.5, 0, 2.5];           // gun positions along the hull (model units), fired bow to stern
export const GUN_STAGGER = 0.13;              // seconds between guns in a broadside

export const hullScale = kind => kind === 'merchant' ? 1.35 : 1.5;
// every hull is a rounded segment along its keel, stern to bow
export const hullOf = e => { const sc = hullScale(e.kind), fx = Math.cos(e.yaw), fz = -Math.sin(e.yaw);
  return { sc, r: 2.4 * sc, F: [fx, fz], R: [Math.sin(e.yaw), Math.cos(e.yaw)], ax: e.x - fx * 6 * sc, az: e.z - fz * 6 * sc, bx: e.x + fx * 7.5 * sc, bz: e.z + fz * 7.5 * sc }; };
// is a point inside a hull? (a little generous, so a ball skimming the rail still counts)
export const inHull = (e, x, y, z) => { const H = hullOf(e), dx = H.bx - H.ax, dz = H.bz - H.az, t = clamp(((x - H.ax) * dx + (z - H.az) * dz) / (dx * dx + dz * dz), 0, 1);
  return y < 18 && y > -1.5 && Math.hypot(x - (H.ax + dx * t), z - (H.az + dz * t)) < H.r + 1.4; };
export function closestOnSegments(A, B) { // Ericson: parameters s on A, t on B of the closest points
  const d1x = A.bx - A.ax, d1z = A.bz - A.az, d2x = B.bx - B.ax, d2z = B.bz - B.az, rx = A.ax - B.ax, rz = A.az - B.az;
  const a = d1x * d1x + d1z * d1z, e = d2x * d2x + d2z * d2z, f = d2x * rx + d2z * rz, c = d1x * rx + d1z * rz, b = d1x * d2x + d1z * d2z, den = a * e - b * b;
  let s = den > 1e-6 ? clamp((b * f - c * e) / den, 0, 1) : 0, t = (b * s + f) / e;
  if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
  return [s, t];
}

// ------------------------------------------------------------ guns
// lay the guns: muzzle speed that carries a ball to the nearest target on that side (within 280 units),
// or a standard 95-unit range when nothing is there
export function layGuns(s, sd, targets) {
  const R = [Math.sin(s.yaw), Math.cos(s.yaw)]; let across = 95, bd = 280;
  for (const e of targets) { const dx = e.x - s.x, dz = e.z - s.z, d = Math.hypot(dx, dz); if (Math.sign(dx * R[0] + dz * R[1]) === sd && d < bd) { bd = d; across = Math.abs(dx * R[0] + dz * R[1]); } }
  return clamp(across / (2 * BALL_VY / BALL_G), 30, 140);
}
// one ball out of one gun: where it starts and how it flies. rnd() supplies the scatter (0..1).
export function gunBall(s, sd, lx, vh, spread, rnd) {
  const sc = hullScale(s.kind), F = [Math.cos(s.yaw), -Math.sin(s.yaw)], R = [Math.sin(s.yaw), Math.cos(s.yaw)], jig = (rnd() - 0.5) * spread;
  return { x: s.x + F[0] * lx * sc + R[0] * sd * 2.8 * sc, y: 2.2, z: s.z + F[1] * lx * sc + R[1] * sd * 2.8 * sc,
    vx: R[0] * sd * (vh + jig * 0.6) + F[0] * (s.speed + jig), vy: BALL_VY * (1 + (rnd() - 0.5) * 0.1), vz: R[1] * sd * (vh + jig * 0.6) + F[1] * (s.speed + jig) };
}
export function stepBall(b, dt) { b.vy -= BALL_G * dt; b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt; }

// ------------------------------------------------------------ collisions
// Separate two overlapping hulls and bounce them apart. Returns null when they don't touch or are already
// parting; otherwise how hard they met and, for a hard hit, who takes how many hits:
// a glancing scrape costs both ships 1; a bow driven into the middle of another ship's side costs the rammed
// ship 2 (3 at full speed) and the rammer at most 1.
export function collide(P, Q) {
  const A = hullOf(P), B = hullOf(Q), [s, t] = closestOnSegments(A, B);
  const px = lerp(A.ax, A.bx, s), pz = lerp(A.az, A.bz, s), qx = lerp(B.ax, B.bx, t), qz = lerp(B.az, B.bz, t), d = Math.hypot(px - qx, pz - qz), reach = A.r + B.r;
  if (d >= reach) return null;
  const nx = d > 1e-3 ? (px - qx) / d : B.R[0], nz = d > 1e-3 ? (pz - qz) / d : B.R[1], pen = reach - d;
  for (const [e, sg] of [[P, 1], [Q, -1]]) { const x = e.x + nx * pen * 0.5 * sg, z = e.z + nz * pen * 0.5 * sg; if (sailable(x, z, 3)) { e.x = x; e.z = z; } }
  const vPx = A.F[0] * P.speed + A.R[0] * (P.driftV || 0), vPz = A.F[1] * P.speed + A.R[1] * (P.driftV || 0);
  const vQx = B.F[0] * Q.speed + B.R[0] * (Q.driftV || 0), vQz = B.F[1] * Q.speed + B.R[1] * (Q.driftV || 0);
  const vn = (vPx - vQx) * nx + (vPz - vQz) * nz; if (vn >= 0) return null; // already parting
  const imp = -vn * 0.6, joltP = (A.R[0] * nx + A.R[1] * nz) * imp, joltQ = -(B.R[0] * nx + B.R[1] * nz) * imp;
  P.speed = Math.max(0, P.speed + (A.F[0] * nx + A.F[1] * nz) * imp); Q.speed = Math.max(0, Q.speed - (B.F[0] * nx + B.F[1] * nz) * imp);
  P.driftV = (P.driftV || 0) + joltP; Q.driftV = (Q.driftV || 0) + joltQ;
  const impact = -vn, rel = Math.hypot(vPx - vQx, vPz - vQz), hit = { cx: (px + qx) / 2, cz: (pz + qz) / 2, impact, joltP, joltQ, hard: rel >= 7, kind: null, dmgP: 0, dmgQ: 0 };
  if (!hit.hard) return hit; // a gentle bump, no harm done
  const across = Math.abs(A.F[0] * B.F[0] + A.F[1] * B.F[1]) < 0.75 && impact > 7;
  const pRams = across && s > 0.82 && t > 0.12 && t < 0.88, qRams = across && t > 0.82 && s > 0.12 && s < 0.88;
  const heavy = impact > 16 ? 3 : 2, light = impact > 12 ? 1 : 0;
  if (pRams) Object.assign(hit, { kind: 'ram', rammer: 'P', dmgQ: heavy, dmgP: light });
  else if (qRams) Object.assign(hit, { kind: 'ram', rammer: 'Q', dmgP: heavy, dmgQ: light });
  else Object.assign(hit, { kind: 'swipe', dmgP: 1, dmgQ: 1 });
  return hit;
}
