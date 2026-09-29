// Routes: A* over grid cells, then string-pulled into a few straight legs.
// Sea routes keep a hull's width from shore; walking routes stay on gentle ground ashore.
import { sdAt, heightAt, clamp, lerp } from './world.js';

export const NAV = { cell: 10, x0: -1400, z0: -1900, x1: 1300, z1: 2500, clear: 9 };
NAV.nx = Math.ceil((NAV.x1 - NAV.x0) / NAV.cell); NAV.nz = Math.ceil((NAV.z1 - NAV.z0) / NAV.cell);
let NAVOK = null, LANDOK = null; // sea cells a ship can use; land cells a captain can walk
// walkable ground: on land, clear of the waterline, and not too steep
const steep = (x, z) => { const e = 5; return Math.hypot(heightAt(x + e, z) - heightAt(x - e, z), heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e) > 0.75; };
export const walkable = (x, z) => x > NAV.x0 && x < NAV.x1 && z > NAV.z0 && z < NAV.z1 && sdAt(x, z) > 3 && !steep(x, z);
export function buildNav() {
  NAVOK = new Uint8Array(NAV.nx * NAV.nz); LANDOK = new Uint8Array(NAV.nx * NAV.nz);
  for (let j = 0; j < NAV.nz; j++) for (let i = 0; i < NAV.nx; i++) { const x = NAV.x0 + (i + 0.5) * NAV.cell, z = NAV.z0 + (j + 0.5) * NAV.cell;
    NAVOK[j * NAV.nx + i] = sdAt(x, z) < -NAV.clear ? 1 : 0; LANDOK[j * NAV.nx + i] = walkable(x, z) ? 1 : 0; }
}
export const cellOf = (x, z) => [clamp(Math.floor((x - NAV.x0) / NAV.cell), 0, NAV.nx - 1), clamp(Math.floor((z - NAV.z0) / NAV.cell), 0, NAV.nz - 1)];
export const cellPos = (i, j) => [NAV.x0 + (i + 0.5) * NAV.cell, NAV.z0 + (j + 0.5) * NAV.cell];
export const sailable = (x, z, clear = 6) => x > NAV.x0 && x < NAV.x1 && z > NAV.z0 && z < NAV.z1 && sdAt(x, z) < -clear;

// the nearest open cell in a grid (spiralling out from the cell under x, z)
function nearestIn(OK, x, z, maxR = 120) {
  const [ci, cj] = cellOf(x, z); if (OK[cj * NAV.nx + ci]) return [ci, cj];
  for (let r = 1; r < maxR; r++) { let best = null, bd = Infinity;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) { if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue; const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= NAV.nx || j >= NAV.nz || !OK[j * NAV.nx + i]) continue; const d = di * di + dj * dj; if (d < bd) { bd = d; best = [i, j]; } }
    if (best) return best; }
  return null;
}
export const nearestOpen = (x, z) => nearestIn(NAVOK, x, z);
export const nearestWalk = (x, z, maxR = 60) => nearestIn(LANDOK, x, z, maxR);
export function lineClear(ax, az, bx, bz) { const L = Math.hypot(bx - ax, bz - az), n = Math.ceil(L / 5); for (let k = 1; k < n; k++) if (!sailable(lerp(ax, bx, k / n), lerp(az, bz, k / n), 7)) return false; return true; }
export function lineWalk(ax, az, bx, bz) { const L = Math.hypot(bx - ax, bz - az), n = Math.ceil(L / 4); for (let k = 1; k < n; k++) if (!walkable(lerp(ax, bx, k / n), lerp(az, bz, k / n))) return false; return true; }

// A* from cell s to cell t over the open cells of OK; returns cell centres, start to end (null: no way through)
function astar(OK, s, t) {
  const N = NAV.nx * NAV.nz, g = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const heap = [], push = (k, f) => { heap.push([f, k]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const h = (i, j) => { const dx = Math.abs(i - t[0]), dz = Math.abs(j - t[1]); return Math.max(dx, dz) + 0.414 * Math.min(dx, dz); };
  const sk = s[1] * NAV.nx + s[0], tk = t[1] * NAV.nx + t[0]; g[sk] = 0; push(sk, h(s[0], s[1]));
  const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  while (heap.length) { const [, k] = pop(); if (closed[k]) continue; closed[k] = 1; if (k === tk) break; const i = k % NAV.nx, j = (k / NAV.nx) | 0;
    for (const [di, dj, c] of NB) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= NAV.nx || nj >= NAV.nz) continue; const nk = nj * NAV.nx + ni; if (!OK[nk] || closed[nk]) continue;
      const ng = g[k] + c; if (ng < g[nk]) { g[nk] = ng; from[nk] = k; push(nk, ng + h(ni, nj)); } } }
  if (from[tk] < 0 && tk !== sk) return null;
  const cells = []; for (let k = tk; k >= 0; k = from[k]) { cells.push(cellPos(k % NAV.nx, (k / NAV.nx) | 0)); if (k === sk) break; } cells.reverse();
  return cells;
}
// string-pull: from each anchor jump to the farthest cell still in clear view
function pull(cells, sx, sz, clear) {
  const out = []; let ax = sx, az = sz, i = 0;
  while (i < cells.length - 1) { let j = cells.length - 1; while (j > i + 1 && !clear(ax, az, cells[j][0], cells[j][1])) j--; out.push(cells[j]); [ax, az] = cells[j]; i = j; }
  if (!out.length) out.push(cells[cells.length - 1]);
  return out;
}
// a sea route for a ship (or a dinghy): [[x, z], ...]
export function findPath(sx, sz, tx, tz) {
  const s = nearestOpen(sx, sz), t = nearestOpen(tx, tz); if (!s || !t) return null;
  const cells = astar(NAVOK, s, t); return cells && pull(cells, sx, sz, lineClear);
}
// a walking route over land for the captain: [[x, z], ...] ending at the walkable spot nearest the target
export function findWalk(sx, sz, tx, tz) {
  const s = nearestWalk(sx, sz), t = nearestWalk(tx, tz); if (!s || !t) return null;
  const cells = astar(LANDOK, s, t); return cells && pull(cells, sx, sz, lineWalk);
}
