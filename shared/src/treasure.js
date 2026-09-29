// Buried treasure: chests inland (25-70 units from the shore) under a big painted X, each one reachable on foot
// from a beach the dinghy can row to. Shared so the server and single-player bury them the same way.
import { sdAt, HOMES, findHomeSpot } from './world.js';
import { walkable, nearestOpen, cellPos, findWalk } from './nav.js';

export const CHEST_COUNT = 8, CHEST_GOLD = 100, CHEST_RESPAWN_S = 60, COIN_GOLD = 10;

// a fresh spot, well apart from the chests already buried (taken: [{ x, z }]) and from the hideouts
export function chestSpot(rnd, taken = []) {
  for (let k = 0; k < 4000; k++) {
    const x = -1250 + rnd() * 2150, z = -1750 + rnd() * 4100, sd = sdAt(x, z);
    if (sd < 25 || sd > 70 || !walkable(x, z)) continue;
    if (taken.some(c => Math.hypot(c.x - x, c.z - z) < 380)) continue;
    if (HOMES.some((h, i) => { const [hx, hz] = findHomeSpot(i); return Math.hypot(hx - x, hz - z) < 250; })) continue;
    const w = nearestOpen(x, z); if (!w) continue; const [wx, wz] = cellPos(...w);
    if (Math.hypot(wx - x, wz - z) > 170 || !findWalk(wx, wz, x, z)) continue; // a beach nearby, and a way up from it
    return [x, z];
  }
  return null;
}
