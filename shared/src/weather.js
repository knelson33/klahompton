// Weather: three breezes drifting over the islands, and now and then a storm. Inside a wind system a ship under
// sail is pushed along the way the wind blows: a tailwind adds up to its strength in knots, a headwind takes it
// away, a crosswind shoves you sideways. The breezes are a pure function of the clock, so everyone agrees on them
// without sending anything. A storm is an event: it brews over open water, drifts slowly, and clears when its
// Kraken is driven off (or after a long while); the server sends its position, single-player runs it locally.
import { clamp, smooth, sdAt, TAU } from './world.js';

export const KNOT = 1 / 0.42; // world units per second in one knot (the speed readout shows speed × 0.42)

// cx/cz ± ax/az: the box each breeze wanders over (a slow Lissajous loop); fx/fz: loop speeds (rad/s);
// dir: the way the wind blows (world angle: 0 = east, π/2 = south), swinging ±swing over time
export const SYSTEMS = [
  { kind: 'breeze', kn: 2, r: 500, cx: -1000, ax: 260, cz: 250, az: 1400, fx: 0.0071, fz: 0.0043, ph: 0.3, dir: -Math.PI / 2, swing: 0.7 }, // Haro Strait, blowing up the strait
  { kind: 'breeze', kn: 1, r: 420, cx: 330, ax: 300, cz: 100, az: 1000, fx: 0.0063, fz: 0.0052, ph: 2.1, dir: 0.4, swing: 0.9 },           // the San Juan bays
  { kind: 'breeze', kn: 2, r: 460, cx: -300, ax: 750, cz: -1350, az: 300, fx: 0.0048, fz: 0.0069, ph: 4.0, dir: Math.PI, swing: 0.6 },    // off Roche Harbor and Pearl Island
];
// the storm: 3 knots, a wide squall, drifting at a slow walk; it takes brewS to build and clearS to clear
export const STORM = { kn: 3, r: 420, speed: 1.5, brewS: 20, clearS: 15, lifeS: 420 };
export const STORM_FIRST = [30, 60], STORM_NEXT = [120, 240]; // seconds before the first storm, and between storms

// where a breeze is at time t (seconds) and which way it blows
export function systemAt(S, t) {
  return { x: S.cx + S.ax * Math.sin(t * S.fx + S.ph), z: S.cz + S.az * Math.sin(t * S.fz + S.ph * 1.7), dir: S.dir + S.swing * Math.sin(t * 0.011 + S.ph * 3) };
}
// how strongly a system reaches a point: full over its middle, fading out toward its edge
const reach = (r, sx, sz, x, z) => 1 - smooth(r * 0.55, r, Math.hypot(x - sx, z - sz));

// ------------------------------------------------------------ the storm (an event, not a loop)
const BOX = { x0: -1300, x1: 1000, z0: -1800, z1: 2400 }; // where storms roam: the charted sea
const open = (x, z) => sdAt(x, z) < -80;
// a new storm over open water, away from `avoid` (ships) so it's seen coming
export function newStorm(rnd, avoid = []) {
  for (let k = 0; k < 600; k++) {
    const x = BOX.x0 + rnd() * (BOX.x1 - BOX.x0), z = BOX.z0 + rnd() * (BOX.z1 - BOX.z0);
    if (!open(x, z) || avoid.some(o => Math.hypot(o.x - x, o.z - z) < 500)) continue;
    const dir0 = rnd() * TAU;
    return { x, z, heading: rnd() * TAU, dir0, dir: dir0, age: 0, fade: 0, mode: 'brew' };
  }
  return null;
}
// drift, grow in, blow itself out; returns 'full' the moment it reaches full strength and 'gone' when it has cleared
export function stepStorm(s, dt) {
  s.age += dt; let ev = null;
  if (s.mode === 'brew') { s.fade = Math.min(1, s.fade + dt / STORM.brewS); if (s.fade >= 1) { s.mode = 'full'; ev = 'full'; } }
  else if (s.mode === 'full') { if (s.age > STORM.lifeS) s.mode = 'clear'; }
  else if (s.mode === 'clear') { s.fade = Math.max(0, s.fade - dt / STORM.clearS); if (s.fade <= 0) { s.mode = 'gone'; ev = 'gone'; } }
  // wander slowly, steering for open water and staying inside the chart
  s.heading += Math.sin(s.age * 0.05) * 0.03 * dt;
  const ax = s.x + Math.cos(s.heading) * 300, az = s.z + Math.sin(s.heading) * 300;
  if (!open(ax, az) || ax < BOX.x0 || ax > BOX.x1 || az < BOX.z0 || az > BOX.z1) s.heading += 0.35 * dt;
  s.x = clamp(s.x + Math.cos(s.heading) * STORM.speed * dt, BOX.x0, BOX.x1); s.z = clamp(s.z + Math.sin(s.heading) * STORM.speed * dt, BOX.z0, BOX.z1);
  s.dir = s.dir0 + 0.5 * Math.sin(s.age * 0.02);
  return ev;
}
export const clearStorm = s => { if (s && (s.mode === 'brew' || s.mode === 'full')) s.mode = 'clear'; };

// the wind at a point: the strongest system there wins (they don't stack past 3 knots)
// storm: the current storm ({ x, z, dir, fade }) or null
// returns { wx, wz } in units/s, kn (knots), dir (world angle) and storm (0..1, how deep in the storm you are)
export function windAt(x, z, t, storm = null) {
  let best = null, bk = 0, st = 0;
  for (const S of SYSTEMS) {
    const p = systemAt(S, t), f = reach(S.r, p.x, p.z, x, z); if (f <= 0) continue;
    const k = S.kn * f; if (k > bk) { bk = k; best = p; }
  }
  if (storm && storm.fade > 0) { const f = reach(STORM.r, storm.x, storm.z, x, z) * storm.fade; st = f; const k = STORM.kn * f; if (k > bk) { bk = k; best = storm; } }
  if (!best) return { wx: 0, wz: 0, kn: 0, dir: 0, storm: st };
  const v = bk * KNOT; return { wx: Math.cos(best.dir) * v, wz: Math.sin(best.dir) * v, kn: bk, dir: best.dir, storm: st };
}
export const windKnots = kn => kn < 0.3 ? 0 : clamp(Math.round(kn), 1, 3);
