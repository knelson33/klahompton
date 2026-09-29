// The islands, shared by the browser (to draw them) and the game server (to sail around them).
// Nothing in here touches three.js or the DOM, so it runs the same in Node.

// ------------------------------------------------------------ seeded randomness + noise
// One random stream for the whole world. The server only uses it for the noise table; the browser keeps
// drawing from the same stream for scenery, so trees and cabins land exactly where single-player put them.
let _seed = 1859; // the year of the Pig War, fought (bloodlessly) right here
export const rand = () => { _seed = (_seed * 1664525 + 1013904223) >>> 0; return _seed / 4294967296; };
export const rr = (a, b) => a + (b - a) * rand();
export const pick = a => a[Math.floor(rand() * a.length)];
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
export const TAU = Math.PI * 2;

const PERM = new Uint8Array(512);
{ const p = [...Array(256).keys()]; for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]; }
const GX = [1, -1, 0, 0, 0.7071, -0.7071, 0.7071, -0.7071], GZ = [0, 0, 1, -1, 0.7071, 0.7071, -0.7071, -0.7071];
export function noise(x, y) {
  const X = Math.floor(x), Y = Math.floor(y), xf = x - X, yf = y - Y, xi = X & 255, yi = Y & 255;
  const g = (i, j, dx, dy) => { const h = PERM[PERM[i] + j] & 7; return GX[h] * dx + GZ[h] * dy; };
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  return lerp(lerp(g(xi, yi, xf, yf), g(xi + 1, yi, xf - 1, yf), u), lerp(g(xi, yi + 1, xf, yf - 1), g(xi + 1, yi + 1, xf - 1, yf - 1), u), v);
}
export function fbm(x, y, oct = 4) { let a = 0.5, f = 1, s = 0; for (let i = 0; i < oct; i++) { s += a * noise(x * f, y * f); f *= 2.03; a *= 0.5; } return s; }

// ------------------------------------------------------------ geography (traced from the two maps)
// Map points are in screenshot pixels of the Roche Harbor / Henry Island view; the Mitchell Bay view was scaled into the same frame.
// world units: +x east, +z south, 1 unit ≈ 2.5 m
export const S = 2.2, P = ([px, py]) => [(px - 500) * S, (py - 1000) * S];
const HENRY = [
  [[270, 335], [300, 350], [330, 420], [335, 520], [310, 600], [340, 650], [330, 700], [290, 720], [250, 700], [240, 640], [230, 560], [235, 470], [245, 390]], // north arm
  [[170, 640], [240, 650], [270, 720], [255, 800], [245, 880], [235, 960], [225, 1060], [200, 1130], [140, 1120], [80, 1070], [45, 960], [55, 860], [90, 720]], // west lobe
  [[330, 730], [380, 720], [440, 730], [465, 770], [450, 830], [410, 870], [360, 885], [335, 850], [320, 790]], // north-east lobe
  [[240, 800], [330, 800], [340, 880], [300, 905], [245, 900]], // middle
  [[300, 880], [330, 900], [360, 940], [400, 970], [430, 1030], [450, 1100], [420, 1160], [370, 1160], [320, 1080], [305, 1000], [310, 940], [285, 910]], // south-east lobe
].map(p => p.map(P));
const PEARL = [[430, 440], [470, 420], [540, 405], [575, 420], [565, 460], [520, 475], [460, 470]].map(P);
const SANJUAN = [[650, 225], [760, 212], [860, 232], [960, 255], [1100, 270], [1400, 290], [1400, 2300], [700, 2300], [690, 2150], [660, 2000], [640, 1900], [595, 1825], [560, 1725], [535, 1625], [535, 1525], [570, 1420], [560, 1370], [565, 1325],
  [530, 1275], [540, 1155], [530, 1085], [545, 1000], [520, 960], [505, 900], [495, 830], [510, 790], [560, 760], [530, 700], [525, 620], [560, 575], [600, 460], [620, 400], [615, 330], [630, 270]].map(P);
const BAYS = { // water carved out of San Juan Island
  roche: [[595, 455], [650, 455], [705, 480], [725, 525], [700, 565], [640, 590], [575, 592], [545, 560], [570, 500]],
  westcott: [[505, 768], [600, 735], [680, 730], [760, 740], [830, 780], [845, 860], [810, 930], [760, 960], [700, 950], [640, 900], [605, 830], [520, 805]],
  garrison: [[690, 940], [760, 950], [800, 985], [840, 1025], [830, 1080], [805, 1110], [730, 1110], [700, 1085], [660, 1040], [640, 1000], [660, 960]],
  snug: [[540, 1335], [600, 1335], [640, 1352], [680, 1372], [712, 1400], [740, 1440], [790, 1448], [800, 1472], [740, 1480], [705, 1457], [660, 1440], [605, 1420], [540, 1425]],
  mitchell: [[760, 1300], [800, 1290], [840, 1310], [870, 1360], [860, 1430], [830, 1470], [790, 1476], [770, 1445], [765, 1390]],
};
for (const k in BAYS) BAYS[k] = BAYS[k].map(P);
const ISLETS = [[190, 305, 12], [530, 290, 6], [455, 395, 6], [820, 1065, 7], [120, 280, 5]].map(([x, y, r]) => { const [wx, wz] = P([x, y]); return [wx, wz, r * S]; });
function inPoly(poly, x, z) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) c = !c; } return c; }
function landRaw(x, z) { // coastlines get a little wiggle so they don't look ruled
  const wx = x + noise(x * 0.012 + 3.1, z * 0.012 - 1.7) * 13, wz = z + noise(x * 0.012 - 5.3, z * 0.012 + 2.9) * 13;
  for (const [ix, iz, r] of ISLETS) if (Math.hypot(wx - ix, wz - iz) < r) return true;
  if (HENRY.some(p => inPoly(p, wx, wz)) || inPoly(PEARL, wx, wz)) return true;
  if (!inPoly(SANJUAN, wx, wz)) return false;
  for (const k in BAYS) if (inPoly(BAYS[k], wx, wz)) return false;
  return true;
}

// ------------------------------------------------------------ signed distance to the coast + ground heights
// SD: + on land, - at sea (chamfer distance transform on a grid). The grid step is fixed so server and browser
// agree to the unit on where the coast is.
export const TER = { x0: -1400, x1: 2000, z0: -1900, z1: 2600, step: 8 };
TER.nx = Math.round((TER.x1 - TER.x0) / TER.step) + 1; TER.nz = Math.round((TER.z1 - TER.z0) / TER.step) + 1;
export const SD = new Float32Array(TER.nx * TER.nz), HEIGHTS = new Float32Array(TER.nx * TER.nz);
export function buildWorld() {
  const n = TER.nx * TER.nz, land = new Uint8Array(n), dl = new Float32Array(n), dw = new Float32Array(n), INF = 1e9;
  for (let j = 0; j < TER.nz; j++) for (let i = 0; i < TER.nx; i++) { const k = j * TER.nx + i; land[k] = landRaw(TER.x0 + i * TER.step, TER.z0 + j * TER.step) ? 1 : 0; dl[k] = land[k] ? INF : 0; dw[k] = land[k] ? 0 : INF; }
  const D = 1.41421, pass = (d) => {
    for (let j = 0; j < TER.nz; j++) for (let i = 0; i < TER.nx; i++) { const k = j * TER.nx + i; let v = d[k]; if (!v) continue;
      if (i > 0) v = Math.min(v, d[k - 1] + 1); if (j > 0) { v = Math.min(v, d[k - TER.nx] + 1); if (i > 0) v = Math.min(v, d[k - TER.nx - 1] + D); if (i < TER.nx - 1) v = Math.min(v, d[k - TER.nx + 1] + D); } d[k] = v; }
    for (let j = TER.nz - 1; j >= 0; j--) for (let i = TER.nx - 1; i >= 0; i--) { const k = j * TER.nx + i; let v = d[k]; if (!v) continue;
      if (i < TER.nx - 1) v = Math.min(v, d[k + 1] + 1); if (j < TER.nz - 1) { v = Math.min(v, d[k + TER.nx] + 1); if (i < TER.nx - 1) v = Math.min(v, d[k + TER.nx + 1] + D); if (i > 0) v = Math.min(v, d[k + TER.nx - 1] + D); } d[k] = v; }
  };
  pass(dl); pass(dw);
  for (let k = 0; k < n; k++) SD[k] = land[k] ? (dl[k] - 0.5) * TER.step : -(dw[k] - 0.5) * TER.step;
  // ground height: low shores, rolling hills inland, a shelving sea floor
  for (let j = 0; j < TER.nz; j++) for (let i = 0; i < TER.nx; i++) {
    const k = j * TER.nx + i, x = TER.x0 + i * TER.step, z = TER.z0 + j * TER.step, sd = SD[k];
    let h;
    if (sd > 0) {
      h = 0.9 + 15 * smooth(0, 90, sd) * (0.6 + 0.4 * fbm(x * 0.01, z * 0.01, 2)) + Math.max(0, fbm(x * 0.0035 + 7, z * 0.0035 - 2, 4)) * 55 * smooth(30, 220, sd);
      const ed = Math.max((x - (TER.x1 - 220)) / 220, (z - (TER.z1 - 220)) / 220); if (ed > 0) h = lerp(h, 8, smooth(0, 1, ed)); // meet the far countryside
    } else h = Math.max(-16, -0.8 + sd * 0.16);
    HEIGHTS[k] = h;
  }
  woldHeadland();
}
// Wold Cabin's headland: the cabin stands on a rocky knoll a little south of its dock, and the shore between the two
// rises in a grassy ridge to the same height, so a path runs level from the top of the dock's cliff to the cabin's deck
export let WOLD = null; // { dock: [x, z], bend: [x, z], knoll: [x, z], dockH, base, top }: heights as they were before the ridge went up
function woldHeadland() {
  const [x0, z0] = findHomeSpot(0); let knoll = [x0 + 10, z0 + 35], bd = Infinity;
  for (let dz = 20; dz <= 50; dz += 2) for (let dx = -12; dx <= 24; dx += 2) { const x = x0 + dx, z = z0 + dz, sd = sdAt(x, z); if (sd < 15 || sd > 26) continue; const d = Math.hypot(dx - 6, dz - 32); if (d < bd) { bd = d; knoll = [x, z]; } }
  // the ridge bends a little inland on its way, so it keeps to solid ground where the shore cuts in between
  const mx = (x0 + knoll[0]) / 2, mz = (z0 + knoll[1]) / 2, e = 6, gx = sdAt(mx + e, mz) - sdAt(mx - e, mz), gz = sdAt(mx, mz + e) - sdAt(mx, mz - e), gl = Math.hypot(gx, gz) || 1;
  const bend = [mx + gx / gl * 14, mz + gz / gl * 14];
  const base = heightAt(...knoll); WOLD = { dock: [x0, z0], bend, knoll, dockH: heightAt(x0, z0), base, top: base + 8 };
  const crest = WOLD.top - 0.35, legs = [[[x0, z0], bend], [bend, knoll]];
  const segDist = (x, z, [[ax0, az0], [bx0, bz0]]) => { const ax = bx0 - ax0, az = bz0 - az0, t = clamp(((x - ax0) * ax + (z - az0) * az) / (ax * ax + az * az), 0, 1); return Math.hypot(x - (ax0 + ax * t), z - (az0 + az * t)); };
  for (let j = 0; j < TER.nz; j++) for (let i = 0; i < TER.nx; i++) {
    const k = j * TER.nx + i, x = TER.x0 + i * TER.step, z = TER.z0 + j * TER.step, sd = SD[k]; if (sd <= 0 || Math.abs(x - x0) > 90 || Math.abs(z - z0) > 110) continue;
    const d = Math.min(segDist(x, z, legs[0]), segDist(x, z, legs[1])); // distance from the dock-bend-knoll line
    const w = (1 - smooth(12, 32, d)) * smooth(0, 2.5, sd); // full along the line, fading inland; a steep grassy bank down to the water
    if (w > 0) HEIGHTS[k] = Math.max(HEIGHTS[k], lerp(HEIGHTS[k], crest, w));
  }
}
function gridSample(A, x, z, outside) {
  const fx = (x - TER.x0) / TER.step, fz = (z - TER.z0) / TER.step;
  if (fx < 0 || fz < 0 || fx >= TER.nx - 1 || fz >= TER.nz - 1) return outside;
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * TER.nx + i;
  return lerp(lerp(A[k], A[k + 1], tx), lerp(A[k + TER.nx], A[k + TER.nx + 1], tx), tz);
}
export const sdAt = (x, z) => gridSample(SD, x, z, (x > TER.x1 - 20 && z > -1560) || (z > TER.z1 - 20 && x > 425) ? 200 : -300);
export const heightAt = (x, z) => gridSample(HEIGHTS, x, z, sdAt(x, z) > 0 ? 8 : -14);
export const isField = (x, z) => fbm(x * 0.0042 + 3.3, z * 0.0042 + 9.1, 3) > 0.17;
export function facingSea(x, z) { const e = 6, gx = sdAt(x + e, z) - sdAt(x - e, z), gz = sdAt(x, z + e) - sdAt(x, z - e); return Math.atan2(-gx, -gz); } // yaw whose front (+z) looks down-slope toward the water

// Hideouts: one per crew in an online voyage (Wold Cabin is the single-player home and the first crew's).
// Each sits on solid ground just above the beach, near a spot traced from the map.
export const HOMES = [
  { name: 'Wold Cabin', at: [306, 932] },   // eastern inner shore of Open Bay, Henry Island
  { name: 'Roche Harbor', at: [585, 598] }, // south-west shore of the harbour
  { name: 'Garrison Bay', at: [690, 1090] },
  { name: 'Snug Harbor', at: [575, 1328] },
  { name: 'Westcott Bay', at: [690, 728] },
  { name: 'Mitchell Bay', at: [868, 1400] },
  { name: 'Nelson Bay', at: [300, 722] },
  { name: 'Pearl Island', at: [520, 472] },
];
const _homeSpots = [];
export function findHomeSpot(i = 0) {
  if (_homeSpots[i]) return _homeSpots[i];
  const [ax, az] = P(HOMES[i].at); let best = null, bd = Infinity;
  for (let dz = -90; dz <= 90; dz += 3) for (let dx = -90; dx <= 90; dx += 3) { const x = ax + dx, z = az + dz, sd = sdAt(x, z); if (sd < 9 || sd > 18) continue; const d = Math.hypot(dx, dz); if (d < bd) { bd = d; best = [x, z]; } }
  return (_homeSpots[i] = best || [ax, az]);
}
export const findCabinSpot = () => findHomeSpot(0);
export const HOME_RADIUS = 85; // sail this close to your hideout to repair (and, with loot, to bank it)
// the heading a ship needs (yaw 0 = east, bow along (cos, -sin)) to point straight out to sea from here
export function seawardYaw(x, z) { const e = 6, gx = sdAt(x + e, z) - sdAt(x - e, z), gz = sdAt(x, z + e) - sdAt(x, z - e); return Math.atan2(gz, -gx); }
