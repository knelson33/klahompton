// Builds the Klahanie map for Klahompton from OpenStreetMap data (© OpenStreetMap contributors, ODbL).
//   node data/build-map.mjs   ->  shared/src/klahanie.json  (+ data/klahanie-game-preview.svg to check it)
// World units are metres: +x east, +z south, origin near the middle of Klahanie.
// The road layout is true to the map; road WIDTHS are exaggerated so cars have room to maneuver.
// Houses come from their real outlines, thinned out and kept clear of the widened roads, so every kept one is solid.
import fs from 'fs';
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const osm = JSON.parse(fs.readFileSync(here + 'klahanie-osm.json', 'utf8')).elements;
const lakes = JSON.parse(fs.readFileSync(here + 'lakes.json', 'utf8')).elements;

// ---------------------------------------------------------------- projection
const LAT0 = 47.5725, LON0 = -122.0065, MY = 111320, MX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toXZ = (lat, lon) => [(lon - LON0) * MX, -(lat - LAT0) * MY];
const P = p => toXZ(p.lat, p.lon);
const r1 = v => Math.round(v * 10) / 10;

// ---------------------------------------------------------------- the play boundary, traced from the user's outlined satellite image
// fit image pixels -> lat/lon with four road junctions found in the data (least squares, north-up)
const REF = [[212, 606, 47.5676908, -122.0247789], [1058, 323, 47.5754322, -121.9880451], [296, 1040, 47.5547119, -122.0213417], [1024, 488, 47.5716622, -121.9899844]];
const fit = (col) => { // v = a + b*px + c*py
  const n = REF.length; let S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], y = [0, 0, 0];
  for (const r of REF) { const row = [1, r[0], r[1]]; for (let i = 0; i < 3; i++) { y[i] += row[i] * r[col]; for (let j = 0; j < 3; j++) S[i][j] += row[i] * row[j]; } }
  // solve 3x3
  const M = S.map((r, i) => [...r, y[i]]); for (let i = 0; i < 3; i++) { let p = i; for (let k = i + 1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k; [M[i], M[p]] = [M[p], M[i]];
    for (let k = 0; k < 3; k++) if (k !== i) { const f = M[k][i] / M[i][i]; for (let j = i; j < 4; j++) M[k][j] -= f * M[i][j]; } }
  return M.map((r, i) => r[3] / r[i]);
};
const fLat = fit(2), fLon = fit(3), pix = (px, py) => toXZ(fLat[0] + fLat[1] * px + fLat[2] * py, fLon[0] + fLon[1] * px + fLon[2] * py);
const fitErr = Math.max(...REF.map(r => { const [x, z] = pix(r[0], r[1]), [X, Z] = toXZ(r[2], r[3]); return Math.hypot(x - X, z - Z); }));
// the dotted outline, clockwise from the north-west corner (SE 32nd St at 241st Ave)
const OUTLINE_PX = [[350, 142], [500, 142], [640, 146], [700, 152], [780, 185], [880, 225], [960, 262], [1030, 300], [1062, 322], [1062, 400], [1045, 460], [1022, 490],
  [940, 545], [860, 590], [780, 640], [700, 700], [640, 760], [585, 815], [572, 870], [540, 905], [480, 960], [430, 1000], [372, 1047], [345, 1015], [296, 1040],
  [262, 960], [230, 850], [210, 740], [208, 640], [218, 520], [240, 420], [262, 360], [283, 337], [320, 320], [340, 260], [343, 190]];
const boundary = OUTLINE_PX.map(([px, py]) => pix(px, py));
const inPoly = (poly, x, z) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) c = !c; } return c; };
const segDist = (x, z, ax, az, bx, bz) => { const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz, t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L)) : 0; return Math.hypot(x - ax - dx * t, z - az - dz * t); };
const polyDist = (poly, x, z) => { let d = Infinity; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; d = Math.min(d, segDist(x, z, a[0], a[1], b[0], b[1])); } return d; };
const near = (x, z, m) => inPoly(boundary, x, z) || polyDist(boundary, x, z) < m; // inside, or within m of the edge

// ---------------------------------------------------------------- roads: true centrelines, gameplay widths
const MAIN_NAMES = /Klahanie|Issaquah|Duthie|32nd Street|Beaver Lake Road/;
const CLASS = { primary: 'main', secondary: 'main', tertiary: 'main', secondary_link: 'main', tertiary_link: 'main', unclassified: 'res', residential: 'res', living_street: 'res', service: 'svc' };
const WIDTH = { main: 18, res: 13, svc: 8 };
const roads = [];
for (const e of osm) {
  const t = e.tags || {}; let c = CLASS[t.highway]; if (!c || !e.geometry) continue;
  if (t.highway === 'service' && ['driveway', 'drive-through', 'emergency_access'].includes(t.service)) continue; // no driving up driveways
  if (t.area === 'yes') continue;
  const all = e.geometry.map(P), keys = e.geometry.map(g => g.lat.toFixed(7) + ',' + g.lon.toFixed(7));
  if (c !== 'main' && t.name && MAIN_NAMES.test(t.name)) c = 'main';
  // keep only the stretches inside the play area (plus a little margin), so roads don't run off into the countryside
  let run = [];
  const flush = () => { if (run.length >= 2) roads.push({ id: e.id, c, w: WIDTH[c], name: t.name || '', pts: run.map(i => all[i]), nodes: run.map(i => keys[i]) }); run = []; };
  for (let i = 0; i < all.length; i++) { if (near(...all[i], 40)) run.push(i); else flush(); }
  flush();
}
// cul-de-sacs: residential dead ends get a turning circle
const endUse = new Map(); for (const r of roads) for (const k of r.nodes) endUse.set(k, (endUse.get(k) || 0) + 1);
const culs = [];
for (const r of roads) if (r.c === 'res') for (const i of [0, r.pts.length - 1]) if (endUse.get(r.nodes[i]) === 1) culs.push([...r.pts[i], 12]);
// parking lots are drivable (QFC, the schools, the pool)
const lots = [];
for (const e of osm) { const t = e.tags || {}; if (t.amenity !== 'parking' || !e.geometry || e.geometry.length < 4) continue; const pts = e.geometry.map(P); if (!pts.some(([x, z]) => near(x, z, 0))) continue; lots.push(pts); }

// how far a point is from drivable surface (negative: on it)
const onRoad = (x, z, pad = 0) => {
  for (const r of roads) for (let i = 0; i < r.pts.length - 1; i++) { const a = r.pts[i], b = r.pts[i + 1]; if (segDist(x, z, a[0], a[1], b[0], b[1]) < r.w / 2 + pad) return true; }
  for (const [cx, cz, cr] of culs) if (Math.hypot(x - cx, z - cz) < cr + pad) return true;
  for (const l of lots) if (inPoly(l, x, z) || polyDist(l, x, z) < pad) return true;
  return false;
};
// a coarse bucket grid over the roads so the overlap tests stay fast
const BK = 60, buckets = new Map(), bkey = (i, j) => i + ',' + j;
const addB = (x0, z0, x1, z1, item) => { for (let i = Math.floor(Math.min(x0, x1) / BK); i <= Math.floor(Math.max(x0, x1) / BK); i++) for (let j = Math.floor(Math.min(z0, z1) / BK); j <= Math.floor(Math.max(z0, z1) / BK); j++) { const k = bkey(i, j); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(item); } };
for (const r of roads) for (let i = 0; i < r.pts.length - 1; i++) { const a = r.pts[i], b = r.pts[i + 1], m = r.w / 2 + 6; addB(a[0] - m, a[1] - m, b[0] + m, b[1] + m, { s: [a, b], w: r.w }); }
for (const [cx, cz, cr] of culs) addB(cx - cr - 6, cz - cr - 6, cx + cr + 6, cz + cr + 6, { c: [cx, cz, cr] });
for (const l of lots) { const xs = l.map(p => p[0]), zs = l.map(p => p[1]); addB(Math.min(...xs) - 6, Math.min(...zs) - 6, Math.max(...xs) + 6, Math.max(...zs) + 6, { l }); }
const clearOf = (x, z, pad) => { // distance-ish test: true when (x, z) is at least pad beyond every drivable edge
  const k = bkey(Math.floor(x / BK), Math.floor(z / BK)); for (const it of buckets.get(k) || []) {
    if (it.s) { const [a, b] = it.s; if (segDist(x, z, a[0], a[1], b[0], b[1]) < it.w / 2 + pad) return false; }
    else if (it.c) { if (Math.hypot(x - it.c[0], z - it.c[1]) < it.c[2] + pad) return false; }
    else if (inPoly(it.l, x, z) || polyDist(it.l, x, z) < pad) return false; }
  return true;
};
// the nearest point on a drivable edge, to push a house back from
const pushFrom = (x, z) => { let best = null, bd = Infinity; const k = bkey(Math.floor(x / BK), Math.floor(z / BK));
  for (const it of buckets.get(k) || []) if (it.s) { const [a, b] = it.s, dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz, t = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L)) : 0, px = a[0] + dx * t, pz = a[1] + dz * t, d = Math.hypot(x - px, z - pz) - it.w / 2;
    if (d < bd) { bd = d; best = [px, pz]; } } else if (it.c) { const d = Math.hypot(x - it.c[0], z - it.c[1]) - it.c[2]; if (d < bd) { bd = d; best = [it.c[0], it.c[1]]; } }
  return best; };

// ---------------------------------------------------------------- buildings
const SIDEWALK = 3.5; // houses keep this far back from the (widened) road edge
// houses that are always kept, whatever the thinning does (OSM building ids)
const ALWAYS = new Set([
  1212820905, // 3968 262nd Ave SE
  1209932034, // 3965 262nd Ave SE, across the street from it
]);
const kindOf = t => t.building === 'school' || t.amenity === 'school' ? 'school' : ['retail', 'commercial', 'supermarket'].includes(t.building) || t.shop ? 'retail' : t.building === 'church' || t.amenity === 'place_of_worship' ? 'church'
  : ['garage', 'garages', 'shed', 'roof'].includes(t.building) ? 'small' : t.building === 'apartments' || t.building === 'residential' ? 'apartments' : 'house';
const area = pts => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a / 2); };
const hash = n => { let h = n % 2147483647; h = (h * 16807) % 2147483647; h = (h * 16807) % 2147483647; return h / 2147483647; };
const stats = { buildingsIn: 0, pushed: 0, droppedRoad: 0, droppedThin: 0, droppedOverlap: 0, kept: 0 };
const kept = [];
const bb = pts => { const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]); return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)]; };
const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const cand = [];
for (const e of osm) {
  const t = e.tags || {}; if (!t.building || !e.geometry || e.geometry.length < 4) continue;
  let pts = e.geometry.slice(0, -1).map(P); const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  if (!near(cx, cz, 120)) continue; // inside Klahanie, plus a ring of scenery around it
  stats.buildingsIn++; const k = kindOf(t), A = area(pts); if (A < 12) continue;
  cand.push({ id: e.id, k, pts, cx, cz, A, name: t.name || '', levels: +(t['building:levels'] || 0), always: ALWAYS.has(e.id) });
}
cand.sort((a, b) => b.always - a.always || (b.k !== 'house') - (a.k !== 'house') || b.A - a.A); // must-keeps, then landmarks and big buildings first
const placed = [];
for (const b of cand) {
  const special = b.k !== 'house' && b.k !== 'small';
  // thin the ordinary houses to about one in two, and sheds/garages further
  if (!special && !b.always && hash(b.id) > (b.k === 'small' ? 0.25 : 0.55)) { stats.droppedThin++; continue; }
  // keep clear of the widened road: push back up to 8 m, else drop
  let pts = b.pts, ok = pts.every(([x, z]) => clearOf(x, z, SIDEWALK)) && clearOf(b.cx, b.cz, SIDEWALK);
  if (!ok && !special) {
    const n = pushFrom(b.cx, b.cz);
    if (n) { const dx = b.cx - n[0], dz = b.cz - n[1], L = Math.hypot(dx, dz) || 1;
      for (const step of [2, 4, 6, 8]) { const moved = pts.map(([x, z]) => [x + dx / L * step, z + dz / L * step]);
        if (moved.every(([x, z]) => clearOf(x, z, SIDEWALK))) { pts = moved; ok = true; stats.pushed++; break; } } }
  }
  if (!ok && special) ok = true; // schools and shops stay where they are (their lots are around them, not through them)
  if (!ok) { stats.droppedRoad++; continue; }
  const box = bb(pts); if (placed.some(p => overlaps(p, box))) { stats.droppedOverlap++; continue; }
  placed.push(box); kept.push({ k: b.k, pts: pts.map(([x, z]) => [r1(x), r1(z)]), ...(b.name ? { name: b.name } : {}), ...(b.levels ? { lv: b.levels } : {}) });
}
stats.kept = kept.length;

// ---------------------------------------------------------------- water, woods, parks, fields, points of interest
const rings = rel => { const segs = rel.members.filter(m => m.role !== 'inner' && m.geometry).map(m => m.geometry.slice()), out = [], same = (a, b) => a.lat === b.lat && a.lon === b.lon;
  while (segs.length) { let ring = segs.shift(), grew = true; while (grew && !same(ring[0], ring[ring.length - 1])) { grew = false; for (let i = 0; i < segs.length; i++) { const s = segs[i];
    if (same(ring[ring.length - 1], s[0])) ring = ring.concat(s.slice(1)); else if (same(ring[ring.length - 1], s[s.length - 1])) ring = ring.concat(s.slice(0, -1).reverse()); else continue; segs.splice(i, 1); grew = true; break; } } out.push(ring); }
  return out; };
const keepPoly = pts => pts.some(([x, z]) => near(x, z, 150));
const water = [], woods = [], parks = [], fields = [], streams = [], paths = [], pois = [];
for (const l of lakes) for (const r of rings(l)) { const pts = r.map(P); if (keepPoly(pts)) water.push({ name: l.tags.name, pts }); }
for (const e of osm) {
  const t = e.tags || {}, g = e.geometry; if (!g || g.length < 2) continue; const pts = g.map(P), closed = g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
  if (!keepPoly(pts)) continue;
  if (t.natural === 'water' && closed) water.push({ name: t.name || '', pts: pts.slice(0, -1) });
  else if (t.waterway === 'stream') streams.push(pts);
  else if ((t.natural === 'wood' || t.landuse === 'forest') && closed) woods.push(pts.slice(0, -1));
  else if (['park', 'playground', 'garden', 'dog_park'].includes(t.leisure) || ['grass', 'meadow', 'recreation_ground'].includes(t.landuse)) { if (closed) parks.push(pts.slice(0, -1)); }
  else if (t.leisure === 'pitch' && closed) fields.push({ sport: t.sport || '', pts: pts.slice(0, -1) });
  else if (['footway', 'path', 'cycleway', 'pedestrian', 'steps', 'track'].includes(t.highway)) paths.push(pts);
  if (t.name && (t.amenity === 'school' || t.leisure === 'park' || t.shop || t.amenity === 'place_of_worship' || t.leisure === 'swimming_pool' || t.leisure === 'sports_centre' || t.natural === 'water')) {
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cz = pts.reduce((s, p) => s + p[1], 0) / pts.length; if (near(cx, cz, 60)) pois.push({ name: t.name, kind: t.amenity || t.leisure || t.shop || t.natural, x: r1(cx), z: r1(cz) });
  }
}
const R = arr => arr.map(p => [r1(p[0]), r1(p[1])]);
const xs = boundary.map(p => p[0]), zs = boundary.map(p => p[1]);
const out = {
  about: 'Klahanie, Sammamish WA. Map data © OpenStreetMap contributors (ODbL). Road widths exaggerated for play; houses thinned.',
  origin: [LAT0, LON0], bounds: [r1(Math.min(...xs)), r1(Math.min(...zs)), r1(Math.max(...xs)), r1(Math.max(...zs))], boundary: R(boundary),
  roads: roads.map(r => ({ c: r.c, w: r.w, ...(r.name ? { name: r.name } : {}), pts: R(r.pts) })), culs: culs.map(c => [r1(c[0]), r1(c[1]), c[2]]), lots: lots.map(R),
  buildings: kept, water: water.map(w => ({ ...(w.name ? { name: w.name } : {}), pts: R(w.pts) })), woods: woods.map(R), parks: parks.map(R), fields: fields.map(f => ({ sport: f.sport, pts: R(f.pts) })), streams: streams.map(R), paths: paths.map(R), pois,
};
const json = JSON.stringify(out); fs.writeFileSync(here + '../shared/src/klahanie.json', json);
const byKind = {}; for (const b of kept) byKind[b.k] = (byKind[b.k] || 0) + 1;
console.log(`boundary fit error ${fitErr.toFixed(0)} m; map ${(out.bounds[2] - out.bounds[0]).toFixed(0)} x ${(out.bounds[3] - out.bounds[1]).toFixed(0)} m`);
console.log(`roads ${roads.length} (main ${roads.filter(r => r.c === 'main').length}, residential ${roads.filter(r => r.c === 'res').length}, service ${roads.filter(r => r.c === 'svc').length}), cul-de-sacs ${culs.length}, parking lots ${lots.length}`);
console.log(`buildings near Klahanie ${stats.buildingsIn}: kept ${stats.kept} ${JSON.stringify(byKind)}, pushed back ${stats.pushed}, dropped for road ${stats.droppedRoad}, thinned ${stats.droppedThin}, overlapping ${stats.droppedOverlap}`);
console.log(`water ${water.length}, woods ${woods.length}, parks ${parks.length}, fields ${fields.length}, streams ${streams.length}, paths ${paths.length}, places ${pois.length}; ${(json.length / 1e6).toFixed(2)} MB`);

// ---------------------------------------------------------------- a preview of the game map, to check before it goes 3D
const d = pts => 'M' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L');
const W = out.bounds[2] - out.bounds[0] + 300, H = out.bounds[3] - out.bounds[1] + 300, X0 = out.bounds[0] - 150, Z0 = out.bounds[1] - 150;
const svg = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${X0} ${Z0} ${W} ${H}" width="1400" height="${Math.round(1400 * H / W)}" style="background:#e9eddc">`];
for (const p of woods) svg.push(`<path d="${d(p)}Z" fill="#a8cf96"/>`);
for (const p of parks) svg.push(`<path d="${d(p)}Z" fill="#c8e8b0"/>`);
for (const f of fields) svg.push(`<path d="${d(f.pts)}Z" fill="#9fd8a6"/>`);
for (const w of water) svg.push(`<path d="${d(w.pts)}Z" fill="#8cc4e6"/>`);
for (const s of streams) svg.push(`<path d="${d(s)}" fill="none" stroke="#6aaed6" stroke-width="3"/>`);
svg.push(`<path d="${d(boundary)}Z" fill="none" stroke="#c8352b" stroke-width="8" stroke-dasharray="30 18" opacity="0.7"/>`);
for (const l of lots) svg.push(`<path d="${d(l)}Z" fill="#8f949a"/>`);
for (const p of paths) svg.push(`<path d="${d(p)}" fill="none" stroke="#b98a5a" stroke-width="1.6" stroke-dasharray="4 3"/>`);
for (const r of roads) svg.push(`<path d="${d(r.pts)}" fill="none" stroke="#6b6f75" stroke-width="${r.w}" stroke-linecap="round" stroke-linejoin="round"/>`);
for (const [x, z, rr] of culs) svg.push(`<circle cx="${x.toFixed(1)}" cy="${z.toFixed(1)}" r="${rr}" fill="#6b6f75"/>`);
for (const r of roads) if (r.c === 'main') svg.push(`<path d="${d(r.pts)}" fill="none" stroke="#f2c14e" stroke-width="0.8" stroke-dasharray="6 6"/>`);
const COL = { house: '#c9c1b6', apartments: '#b8b0c8', school: '#b9a7d6', retail: '#e0a38a', church: '#e8d6a0', small: '#d8d0c4' };
for (const b of kept) svg.push(`<path d="${d(b.pts)}Z" fill="${COL[b.k]}" stroke="#5a5048" stroke-width="0.7"/>`);
for (const p of pois) svg.push(`<text x="${p.x}" y="${p.z}" font-size="22" font-family="sans-serif" text-anchor="middle" fill="#222" stroke="#fff" stroke-width="4" paint-order="stroke">${p.name}</text>`);
svg.push(`<text x="${X0 + W - 20}" y="${Z0 + H - 20}" font-size="26" font-family="sans-serif" text-anchor="end" fill="#555">© OpenStreetMap contributors</text></svg>`);
fs.writeFileSync(here + 'klahanie-game-preview.svg', svg.join(''));
