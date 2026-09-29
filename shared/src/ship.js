// How a ship sails: follow the planned legs, turn at a limited rate, ease speed up and down,
// stop short of land (and re-plan), and bleed off any sideways shove. The server runs this for every
// ship in a match; the browser runs it in single-player.
import { clamp } from './world.js';
import { sailable, findPath } from './nav.js';
import { KNOT } from './weather.js';

export const MAX_SPEED = 26, TURN_RATE = 0.75; // 26 units/s is about 11 knots
export const BOOST = 2 * KNOT, BOOST_AFTER = 5;  // hold a straight course at full speed for 5 s and she makes 2 knots more
export const DAMAGE_SLOW = 1 * KNOT;              // every hit of hull lost costs 1 knot of top speed
// top speed for a ship with this much hull left (full hull: MAX_SPEED)
export const topSpeed = s => MAX_SPEED - (s.maxHp && s.hp < s.maxHp ? (s.maxHp - Math.max(0, s.hp)) * DAMAGE_SLOW : 0);

// s needs: x, z, yaw, speed, turn, driftV, path ([[x, z], ...]), goal ([x, z] or null), and hp / maxHp (damage slows her);
// wind: { wx, wz } (units/s) or null
// returns 'leg' when a waypoint is passed, 'arrived' at the end of the course, 'replanned' when land forced a new route
export function stepShip(s, dt, halted = false, wind = null) {
  let target = 0, turnWant = 0, ev = null; const top = topSpeed(s);
  if (!halted && s.path.length) {
    const [wx, wz] = s.path[0], dx = wx - s.x, dz = wz - s.z, dist = Math.hypot(dx, dz), last = s.path.length === 1;
    if (dist < (last ? 6 : 22)) { s.path.shift(); ev = s.path.length ? 'leg' : 'arrived'; if (!s.path.length) s.goal = null; }
    else { let diff = Math.atan2(-dz, dx) - s.yaw; diff = Math.atan2(Math.sin(diff), Math.cos(diff)); turnWant = clamp(diff * 2, -1, 1);
      target = top * (1 - Math.min(0.75, Math.abs(diff) / Math.PI * 1.4)); if (last) target = Math.min(target, dist * 0.7 + 2); }
  }
  // full sail: a steady run at top speed builds up, and any real turn or slowdown loses it
  const steady = !halted && target >= top - 0.01 && s.speed >= top - 0.6 && Math.abs(s.turn) < 0.15;
  s.straightT = steady ? (s.straightT || 0) + dt : 0; s.boost = s.straightT >= BOOST_AFTER;
  if (s.boost) target = top + BOOST;
  s.turn += (turnWant - s.turn) * Math.min(1, dt * 3);
  s.yaw += s.turn * TURN_RATE * dt * clamp(s.speed / 8, 0.35, 1);
  s.speed += clamp(target - s.speed, -12 * dt, 5 * dt);
  const nx = s.x + Math.cos(s.yaw) * s.speed * dt, nz = s.z - Math.sin(s.yaw) * s.speed * dt;
  if (sailable(nx, nz, 3)) { s.x = nx; s.z = nz; }
  else { s.speed = 0; s.straightT = 0; if (s.goal) { const [gx, gz] = s.goal; s.path = findPath(s.x, s.z, gx, gz) || []; ev = 'replanned'; } }
  blow(s, dt, wind, MAX_SPEED);
  // sideways shove (broadside recoil, collisions) fades out
  s.driftV *= Math.max(0, 1 - dt * 1.4);
  const sx = s.x + Math.sin(s.yaw) * s.driftV * dt, sz = s.z + Math.cos(s.yaw) * s.driftV * dt;
  if (sailable(sx, sz, 3)) { s.x = sx; s.z = sz; }
  return ev;
}

// the wind pushes a ship in proportion to how much sail she's carrying (an anchored ship holds fast)
export function blow(s, dt, wind, top) {
  if (!wind || (!wind.wx && !wind.wz)) return;
  const sail = clamp(s.speed / top, 0, 1), x = s.x + wind.wx * sail * dt, z = s.z + wind.wz * sail * dt;
  if (sailable(x, z, 3)) { s.x = x; s.z = z; }
}
// speed over the water plus what the wind adds along the heading: what the log line reads
export const groundSpeed = (s, wind, top = MAX_SPEED) => s.speed + (wind ? (wind.wx * Math.cos(s.yaw) - wind.wz * Math.sin(s.yaw)) * clamp(s.speed / top, 0, 1) : 0);
