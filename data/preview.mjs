// A top-down preview of the Klahanie OpenStreetMap data (roads, houses, water, parks, woods, schools), to check
// the map before it goes into the game. node data/preview.mjs  ->  data/klahanie-preview.svg
import fs from 'fs';
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const d = JSON.parse(fs.readFileSync(here + 'klahanie-osm.json', 'utf8'));
// metres from the centre of the area (good enough over a few kilometres)
const LAT0 = 47.5725, LON0 = -122.005, MY = 111320, MX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const xy = p => [(p.lon - LON0) * MX, -(p.lat - LAT0) * MY];
const W = 4700, H = 4600, S = 1; // svg units are metres, centred
const path = (g, close) => 'M' + g.map(p => xy(p).map(v => v.toFixed(1)).join(',')).join('L') + (close ? 'Z' : '');
const out = [], layer = { land: [], wood: [], park: [], water: [], stream: [], school: [], roads: [], build: [] };
const ROAD = { secondary: [12, '#f7d68b'], secondary_link: [9, '#f7d68b'], tertiary: [10, '#fff2c0'], tertiary_link: [8, '#fff2c0'], residential: [7, '#ffffff'], unclassified: [7, '#ffffff'], service: [4, '#f4f4f4'], footway: [1.6, '#c9805a'], path: [1.6, '#b98a5a'], cycleway: [2, '#6a8fd6'], pedestrian: [3, '#dddddd'], steps: [2, '#c9805a'], track: [2, '#a08050'] };
for (const e of d.elements) {
  const t = e.tags || {}, g = e.geometry; if (!g || g.length < 2) continue;
  const closed = g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
  if (t.building) layer.build.push(`<path d="${path(g, true)}" fill="${t.building === 'school' ? '#b9a7d6' : ['retail', 'commercial'].includes(t.building) ? '#e0a38a' : '#c9c1b6'}" stroke="#8a8278" stroke-width="0.6"/>`);
  else if (t.highway && ROAD[t.highway]) { const [w, c] = ROAD[t.highway]; layer.roads.push(`<path d="${path(g, false)}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${w > 3 ? ' data-casing="1"' : ''}/>`); }
  else if (t.natural === 'water' && closed) layer.water.push(`<path d="${path(g, true)}" fill="#8cc4e6"/>`);
  else if (t.waterway) layer.stream.push(`<path d="${path(g, false)}" fill="none" stroke="#6aaed6" stroke-width="3"/>`);
  else if ((t.natural === 'wood' || t.landuse === 'forest') && closed) layer.wood.push(`<path d="${path(g, true)}" fill="#a8cf96"/>`);
  else if ((t.leisure === 'park' || t.leisure === 'pitch' || t.leisure === 'playground' || t.landuse === 'grass' || t.landuse === 'meadow' || t.landuse === 'recreation_ground') && closed) layer.park.push(`<path d="${path(g, true)}" fill="${t.leisure === 'pitch' ? '#9fd8a6' : '#c8e8b0'}"/>`);
  else if (t.amenity === 'school' && closed) layer.school.push(`<path d="${path(g, true)}" fill="#efe6c8"/>`);
  else if (t.amenity === 'parking' && closed) layer.land.push(`<path d="${path(g, true)}" fill="#dcdcdc"/>`);
}
// multipolygons (Yellow Lake, Beaver Lake): stitch the outer pieces into closed rings
function rings(rel) {
  const segs = rel.members.filter(m => m.role !== 'inner' && m.geometry).map(m => m.geometry.slice()), out = [];
  const same = (a, b) => a.lat === b.lat && a.lon === b.lon;
  while (segs.length) { let ring = segs.shift(), grew = true;
    while (grew && !same(ring[0], ring[ring.length - 1])) { grew = false;
      for (let i = 0; i < segs.length; i++) { const s = segs[i];
        if (same(ring[ring.length - 1], s[0])) ring = ring.concat(s.slice(1)); else if (same(ring[ring.length - 1], s[s.length - 1])) ring = ring.concat(s.slice(0, -1).reverse()); else continue;
        segs.splice(i, 1); grew = true; break; } }
    out.push(ring); }
  return out;
}
const lakes = JSON.parse(fs.readFileSync(here + 'lakes.json', 'utf8')).elements; // their shorelines, fetched on their own
for (const e of lakes) for (const r of rings(e)) layer.water.push(`<path d="${path(r, true)}" fill="#8cc4e6"/>`);
const casing = layer.roads.filter(r => r.includes('data-casing')).map(r => r.replace(/stroke="[^"]+"/, 'stroke="#9a9a9a"').replace(/stroke-width="([\d.]+)"/, (m, w) => `stroke-width="${+w + 2}"`));
// labels for the named main roads (one per name, at the middle of its longest piece)
const best = new Map(); for (const e of d.elements) { const t = e.tags || {}; if (!t.highway || !t.name || !['secondary', 'tertiary', 'residential'].includes(t.highway) || !e.geometry) continue; const L = e.geometry.length; if (!best.has(t.name) || best.get(t.name).geometry.length < L) best.set(t.name, e); }
const labels = [...best.values()].filter(e => ['secondary', 'tertiary'].includes(e.tags.highway) || e.geometry.length > 12).map(e => { const [x, y] = xy(e.geometry[e.geometry.length >> 1]); return `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" font-size="${e.tags.highway === 'residential' ? 16 : 24}" font-family="sans-serif" text-anchor="middle" fill="#333" stroke="#fff" stroke-width="4" paint-order="stroke">${e.tags.name.replace('Southeast', 'SE').replace('Avenue', 'Ave').replace('Street', 'St').replace('Boulevard', 'Blvd').replace('Drive', 'Dr')}</text>`; });
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-W / 2} ${-H / 2} ${W} ${H}" width="1600" height="${Math.round(1600 * H / W)}" style="background:#eef0e6">
${layer.wood.join('')}${layer.park.join('')}${layer.school.join('')}${layer.land.join('')}${layer.water.join('')}${layer.stream.join('')}${casing.join('')}${layer.roads.join('')}${layer.build.join('')}${labels.join('')}
<text x="${W / 2 - 20}" y="${H / 2 - 20}" font-size="28" font-family="sans-serif" text-anchor="end" fill="#555">© OpenStreetMap contributors</text></svg>`;
fs.writeFileSync(here + 'klahanie-preview.svg', svg);
console.log('wrote klahanie-preview.svg', (svg.length / 1e6).toFixed(1) + ' MB', 'buildings', layer.build.length, 'roads', layer.roads.length);
