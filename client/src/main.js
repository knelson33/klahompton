import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rand, rr, pick, clamp, lerp, smooth, TAU, noise, fbm, S, P, TER, SD, HEIGHTS, buildWorld, sdAt, heightAt, isField, facingSea, HOMES, HOME_RADIUS, findHomeSpot, seawardYaw, WOLD } from '@klh/shared/world';
import { buildNav, cellPos, sailable, nearestOpen, findPath } from '@klh/shared/nav';
import { MAX_SPEED, stepShip, groundSpeed } from '@klh/shared/ship';
import { PORT, STARBOARD, RELOAD, BALL_G, GUNS, GUN_STAGGER, layGuns, gunBall, stepBall, inHull, collide } from '@klh/shared/combat';
import { FLEET, newNpc, openSpot, stepNpc, moveNpc } from '@klh/shared/npc';
import { MONSTERS, MONSTER_FIRST, MONSTER_NEXT, KRAKEN_SIZE, KRAKEN_AFTER, monsterSpot, stormSpot, dismissMonster, newMonster, monsterHit, hurtMonster, stepMonster } from '@klh/shared/monsters';
import { SYSTEMS, STORM, STORM_FIRST, STORM_NEXT, systemAt, windAt, windKnots, newStorm, stepStorm, clearStorm } from '@klh/shared/weather';
import { newAvatar, launchDinghy, resetAvatar, avatarGo, stepAvatar, startDig, nearestChest, pistolBall, splashAvatar, PISTOL_RELOAD, PISTOL_DRAW, DIG_S } from '@klh/shared/captain';
import { CHEST_COUNT, CHEST_GOLD, CHEST_RESPAWN_S, COIN_GOLD, chestSpot } from '@klh/shared/treasure';
import { newVoyage, joinVoyage } from './net.js';

window.addEventListener('error', e => { const el = document.getElementById('err'); el.style.display = 'block'; el.textContent = 'Error: ' + e.message; });
const setStatus = t => { document.getElementById('loadmsg').textContent = t; };
const nextFrame = () => new Promise(r => { let done = false; const go = () => { if (!done) { done = true; setTimeout(r, 0); } }; requestAnimationFrame(go); setTimeout(go, 60); });

// ============================================================ utilities (the seeded world, noise and maths live in @klh/shared/world)
const V3 = THREE.Vector3;
function canvasTex(w, h, draw, repeat = false) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}

// ============================================================ renderer / scene
const canvas = document.getElementById('view');
const MOBILE = window.matchMedia('(pointer: coarse)').matches || Math.min(window.innerWidth, window.innerHeight) < 600;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, MOBILE ? 1.25 : 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; renderer.shadowMap.autoUpdate = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene(), labelScene = new THREE.Scene();
const FOG_COLOR = new THREE.Color('#cfe9ff');
scene.fog = new THREE.Fog(FOG_COLOR, 1800, 24000);
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 30000);
// the camera is locked onto the ship: drag orbits around it, scroll / pinch zooms — no panning, so it can never drift off
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.enablePan = false;
// zoom: a button steps the camera between three distances; pinch / scroll zoom is an opt-in setting
const ZOOMS = [{ name: 'Close', d: 115 }, { name: 'Medium', d: 330 }, { name: 'Far', d: 850 }];
const ZOOMS_SHORE = [{ name: 'Close', d: 40 }, { name: 'Medium', d: 90 }, { name: 'Far', d: 200 }]; // in the dinghy or ashore
let zoomLevel = 0, zoomTo = null; // zoomTo: the distance the camera is gliding to (null once it's there)
let pinchZoom = false; try { pinchZoom = localStorage.getItem('klh-pinch') === '1'; } catch (e) { }
controls.enableZoom = pinchZoom;
controls.minDistance = 12; controls.maxDistance = 1400; controls.maxPolarAngle = 1.45; controls.zoomToCursor = false;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };

const GRAD = (() => { const t = new THREE.DataTexture(new Uint8Array([95, 185, 255]), 3, 1, THREE.RedFormat); t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t; })();
const matCache = new Map();
function toon(color, extra) {
  const key = String(color) + (extra ? JSON.stringify(extra) : '');
  let m = matCache.get(key); if (!m) { m = new THREE.MeshToonMaterial({ color, gradientMap: GRAD, ...(extra || {}) }); matCache.set(key, m); } return m;
}
const VC = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: GRAD });
function mesh(geo, color, x, y, z, parent = scene, shadow = true) { const m = new THREE.Mesh(geo, typeof color === 'object' ? color : toon(color)); m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true; parent.add(m); return m; }
function setShadows(o) { o.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } }); return o; }
function vcol(geo, hex) { const g = geo.index ? geo.toNonIndexed() : geo, c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; }

// lights, sky, sun
const SUN_DIR = new V3(-0.55, 0.7, 0.45).normalize();
const hemi = new THREE.HemisphereLight(0xd6efff, 0x5f7f55, 1.35); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1d8, 2.3); sun.castShadow = true;
sun.shadow.mapSize.set(MOBILE ? 2048 : 4096, MOBILE ? 2048 : 4096); sun.shadow.camera.near = 10; sun.shadow.camera.far = 3400; sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);
{
  const skyMat = new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: true, fog: false,
    uniforms: { top: { value: new THREE.Color('#3d9cf0') }, mid: { value: new THREE.Color('#8fd0ff') }, bot: { value: FOG_COLOR.clone() } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bot; varying vec3 vDir; void main(){ float y = vDir.y; vec3 c = mix(bot, mid, smoothstep(0.0, 0.12, y)); c = mix(c, top, smoothstep(0.12, 0.7, y)); gl_FragColor = vec4(c,1.0); }` });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(20000, 32, 16), skyMat); sky.frustumCulled = false; scene.add(sky);
}
const sunDisc = new THREE.Group();
{ sunDisc.add(new THREE.Mesh(new THREE.CircleGeometry(700, 40), new THREE.MeshBasicMaterial({ color: '#fff4a8', fog: false })), new THREE.Mesh(new THREE.RingGeometry(780, 900, 40), new THREE.MeshBasicMaterial({ color: '#ffd23a', fog: false })));
  for (let i = 0; i < 12; i++) { const s = new THREE.Shape(); s.moveTo(-100, 970); s.lineTo(100, 970); s.lineTo(0, 1370); s.lineTo(-100, 970); const r = new THREE.Mesh(new THREE.ShapeGeometry(s), new THREE.MeshBasicMaterial({ color: '#ffb52e', fog: false })); r.rotation.z = i / 12 * TAU; sunDisc.add(r); }
  sunDisc.position.copy(SUN_DIR).multiplyScalar(17500); scene.add(sunDisc); }

// ============================================================ terrain (the coastline, distance field and heights live in @klh/shared/world)
const C = { forest: new THREE.Color('#3f8a3c'), forest2: new THREE.Color('#4f9a45'), field: new THREE.Color('#c9c26a'), field2: new THREE.Color('#9fd05a'), sand: new THREE.Color('#ecd9a0'),
  rock: new THREE.Color('#8d877c'), shallow: new THREE.Color('#9fe0d8'), deep: new THREE.Color('#1c5f86') };
function buildTerrain() {
  const geo = new THREE.PlaneGeometry(TER.x1 - TER.x0, TER.z1 - TER.z0, TER.nx - 1, TER.nz - 1); geo.rotateX(-Math.PI / 2);
  geo.translate((TER.x0 + TER.x1) / 2, 0, (TER.z0 + TER.z1) / 2);
  const pos = geo.attributes.position, cols = new Float32Array(pos.count * 3), tc = new THREE.Color();
  for (let j = 0; j < TER.nz; j++) for (let i = 0; i < TER.nx; i++) {
    const k = j * TER.nx + i, x = TER.x0 + i * TER.step, z = TER.z0 + j * TER.step, sd = SD[k];
    pos.setY(k, HEIGHTS[k]);
    const n1 = fbm(x * 0.03, z * 0.03, 2);
    if (sd > 0) {
      if (isField(x, z)) tc.copy(C.field).lerp(C.field2, clamp(0.5 + n1 * 1.6, 0, 1)); else tc.copy(C.forest).lerp(C.forest2, clamp(0.5 + n1 * 1.4, 0, 1));
      if (sd < 9) tc.copy(noise(x * 0.02, z * 0.02) > 0.05 ? C.rock : C.sand);
    } else tc.copy(C.shallow).lerp(C.deep, smooth(0, 70, -sd));
    cols[k * 3] = tc.r; cols[k * 3 + 1] = tc.g; cols[k * 3 + 2] = tc.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3)); geo.computeVertexNormals();
  const t = new THREE.Mesh(geo, VC); t.receiveShadow = true; scene.add(t);
  // the rest of San Juan Island rolls on past the edge of the chart
  const sh = new THREE.Shape([[1990, 1560], [30000, 1560], [30000, -30000], [425, -30000], [425, -2590], [1990, -2590]].map(([x, z]) => new THREE.Vector2(x, z)));
  const og = new THREE.ShapeGeometry(sh); og.rotateX(-Math.PI / 2);
  const outer = new THREE.Mesh(og, toon('#4a8f3e')); outer.position.y = 7.6; outer.receiveShadow = true; scene.add(outer);
}

// sea: a big animated toon plane, see-through enough to show the shallows
let waterTex;
function buildSea() {
  waterTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 30; i++) { const x = rand() * w, y = rand() * h, s = rr(10, 22); g.strokeStyle = 'rgba(205,240,255,1)'; g.lineWidth = 4; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + s * 0.5, y - s * 0.45, x + s, y); g.quadraticCurveTo(x + s * 1.5, y + s * 0.45, x + s * 2, y); g.stroke(); }
  }, true);
  waterTex.repeat.set(400, 400);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), new THREE.MeshToonMaterial({ color: '#2b8fd6', map: waterTex, gradientMap: GRAD, emissive: '#0b3a66', emissiveIntensity: 0.3, transparent: true, opacity: 0.8 }));
  sea.rotation.x = -Math.PI / 2; sea.receiveShadow = true; sea.renderOrder = 1; scene.add(sea);
}

// ============================================================ scenery
function makeMountain({ x, z, r, h, seed, snow = 0.72, rock = 0.5, forest = '#3f7d3c', rings = 16, seg = 44, sharp = 1.35, y0 = -2 }) {
  const Pp = [], Cc = [], I = [], cF = new THREE.Color(forest), cR = new THREE.Color('#8d8a86'), cS = new THREE.Color('#ffffff'), tc = new THREE.Color();
  for (let i = 0; i <= rings; i++) { const t = i / rings; for (let j = 0; j < seg; j++) { const a = j / seg * TAU, nr = 1 + 0.28 * noise(Math.cos(a) * 1.7 + seed, Math.sin(a) * 1.7 + seed), rad = r * t * nr;
    let y = h * Math.pow(1 - t, sharp) + (i > 0 && i < rings ? noise(a * 3 + seed * 2, t * 5) * h * 0.09 * Math.sin(t * Math.PI) : 0); if (i === rings) y = 0;
    Pp.push(x + Math.cos(a) * rad, y0 + y, z + Math.sin(a) * rad); const rel = y / h + noise(a * 5 + seed, t * 7) * 0.06; tc.copy(cF); if (rel > rock) tc.copy(cR); if (rel > snow) tc.copy(cS); Cc.push(tc.r, tc.g, tc.b); } }
  for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) { const a = i * seg + j, b = i * seg + (j + 1) % seg; I.push(a, a + seg, b, b, a + seg, b + seg); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(Pp, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3)); g.setIndex(I); g.computeVertexNormals();
  scene.add(new THREE.Mesh(g, VC));
}
function buildHorizon() {
  // Vancouver Island across Haro Strait, the Olympics to the south-west, Mount Baker to the east
  for (let k = 0; k < 14; k++) makeMountain({ x: -6200 + rr(-500, 500), z: -9000 + k * 1400, r: rr(1100, 1600), h: rr(260, 520), seed: k * 1.3, snow: 2, rock: 2, sharp: 0.9, forest: pick(['#3f7d3c', '#4a8a40']), rings: 10, seg: 30 });
  for (let k = 0; k < 9; k++) makeMountain({ x: -5000 + k * 1500 + rr(-300, 300), z: 13000 + rr(-600, 600), r: rr(1300, 1800), h: rr(1300, 1900), seed: 40 + k, snow: 0.6, rock: 0.4 });
  makeMountain({ x: 11000, z: -7000, r: 3200, h: 3300, seed: 3.1, snow: 0.35, rock: 0.22, sharp: 1.25, rings: 22, seg: 60 });
  for (const [x, z, r, h] of [[400, -3600, 900, 60], [2200, -3200, 700, 70], [-2600, -3900, 600, 40]]) makeMountain({ x, z, r, h, seed: x * 0.01, snow: 2, rock: 2, sharp: 0.7, forest: '#4a8a40', rings: 8, seg: 28 }); // Spieden & friends
}

const TREE = {};
function buildTrees() {
  const coneGeo = mergeGeometries([new THREE.ConeGeometry(0.4, 0.55, 7).translate(0, 0.4, 0), new THREE.ConeGeometry(0.3, 0.45, 7).translate(0, 0.68, 0), new THREE.ConeGeometry(0.18, 0.32, 7).translate(0, 0.9, 0)]);
  const madGeo = mergeGeometries([new THREE.SphereGeometry(0.42, 8, 6).scale(1, 0.8, 1).translate(0, 0.7, 0), new THREE.SphereGeometry(0.3, 7, 5).translate(0.22, 0.86, 0.1)]);
  const trunk = new THREE.CylinderGeometry(0.05, 0.08, 0.5, 5).translate(0, 0.25, 0);
  const list = [], step = MOBILE ? 13 : 10;
  const CONI = ['#2f7d3a', '#3a8f42', '#2a6e35', '#357a44', '#2d6b3f'], MAD = ['#5cb84a', '#6cc24e', '#4fa843'];
  const add = (x, z, big) => { const madrone = rand() < 0.12, h = (madrone ? rr(7, 11) : rr(11, 20)) * big; list.push({ x, z, y: heightAt(x, z) - 0.3, h, w: madrone ? h * 0.9 : h * rr(0.48, 0.6), m: madrone, col: madrone ? pick(MAD) : pick(CONI), yaw: rand() * TAU }); };
  for (let z = TER.z0; z < TER.z1; z += step) for (let x = TER.x0; x < TER.x1; x += step) {
    const px = x + rr(-step / 2, step / 2), pz = z + rr(-step / 2, step / 2), sd = sdAt(px, pz); if (sd < 6) continue;
    if (isField(px, pz) ? rand() > 0.03 : rand() > 0.72) continue; if (nearBuilt(px, pz)) continue; add(px, pz, 1);
  }
  for (let k = 0; k < (MOBILE ? 1500 : 4000); k++) { const x = rr(2000, 5500), z = rr(-1500, 6000); add(x, z, rr(1.2, 1.6)); list[list.length - 1].y = 7.3; } // the far countryside
  const mk = (geo, mat, n) => { const m = new THREE.InstancedMesh(geo, mat, n); m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; scene.add(m); return m; };
  const nm = list.filter(t => t.m).length, nc = list.length - nm, tmp = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  const cone = mk(coneGeo, new THREE.MeshToonMaterial({ gradientMap: GRAD }), nc), mad = mk(madGeo, new THREE.MeshToonMaterial({ gradientMap: GRAD }), nm);
  const tC = mk(trunk, toon('#6b4423'), nc), tM = mk(trunk, toon('#a0462a'), nm); // madrones have red bark
  let ic = 0, im = 0;
  for (const t of list) { tmp.compose(new V3(t.x, t.y, t.z), q.setFromAxisAngle(new V3(0, 1, 0), t.yaw), new V3(t.w, t.h, t.w));
    if (t.m) { mad.setMatrixAt(im, tmp); tM.setMatrixAt(im, tmp); mad.setColorAt(im++, c.set(t.col)); } else { cone.setMatrixAt(ic, tmp); tC.setMatrixAt(ic, tmp); cone.setColorAt(ic++, c.set(t.col)); } }
}

// buildings: cabins along the shores, the Roche Harbor resort, English Camp, Snug Harbor
const BUILT = []; // [x, z, r] footprints that keep trees away
const nearBuilt = (x, z) => BUILT.some(([bx, bz, r]) => Math.abs(x - bx) < r && Math.abs(z - bz) < r);
const ROOF_GEO = (() => { const p = [-0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0, -0.5, 0, 0.5, 0.5, 1, 0, -0.5, 1, 0, 0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, 0, 0.5, 0, -0.5, -0.5, 1, 0, 0.5, 1, 0, -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0, 0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, 0];
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.computeVertexNormals(); return g; })();
const winTex = canvasTex(128, 128, (g, w, h) => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); g.fillStyle = 'rgba(0,0,0,0.07)'; for (let y = 6; y < h; y += 9) g.fillRect(0, y, w, 2);
  for (const [x, y] of [[18, 26], [82, 26], [18, 80], [82, 80]]) { g.fillStyle = '#ffffff'; g.fillRect(x - 4, y - 4, 36, 36); g.fillStyle = '#35587a'; g.fillRect(x, y, 28, 28); g.fillStyle = '#9fd0f0'; g.fillRect(x + 3, y + 3, 10, 10); } });
function building(x, z, rot, w, d, h, color, roof, roofH = 3) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot; scene.add(g);
  const base = heightAt(x, z) - 1;
  mesh(new THREE.BoxGeometry(w, h + 1, d), new THREE.MeshToonMaterial({ color, map: winTex, gradientMap: GRAD }), 0, base + (h + 1) / 2, 0, g);
  const r = mesh(ROOF_GEO, roof, 0, base + h + 1, 0, g); r.scale.set(w * 1.12, roofH, d * 1.12);
  BUILT.push([x, z, Math.max(w, d) * 0.8]); return { g, top: base + h + 1 };
}
function buildTowns() {
  const CAB = ['#f3e9d2', '#b8d8c8', '#9fc5e8', '#f6d68a', '#e8b4a0', '#d3d9e0', '#b04a3c', '#3f5f7f', '#8a6f55', '#f0f0ea'], RF = ['#3b3f47', '#51463f', '#2f4a3a', '#6e3b2e', '#4a5568', '#7a5a3a'];
  // cabins cluster around the harbours the maps show as built up
  const hubs = [[720, 560, 110, 26], [770, 820, 150, 26], [600, 880, 70, 12], [760, 1130, 90, 10], [720, 1420, 140, 26], [620, 1600, 120, 18], [880, 400, 150, 18], [560, 1250, 60, 10], [330, 1020, 60, 4], [150, 760, 60, 4]];
  for (const [hx, hy, rad, n] of hubs) { const [cx, cz] = P([hx, hy]); let made = 0;
    for (let t = 0; t < n * 30 && made < n; t++) { const a = rand() * TAU, r = Math.sqrt(rand()) * rad * S, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, sd = sdAt(x, z);
      if (sd < 9 || sd > 70 || nearBuilt(x, z)) continue; building(x, z, facingSea(x, z), rr(7, 10), rr(7, 9), rand() < 0.4 ? rr(6, 7) : rr(4, 5), pick(CAB), pick(RF), rr(2.2, 3.2)); made++; } }
}
function flagTex(draw) { return canvasTex(96, 64, draw); }
// Roche Harbor, after the photos: Hotel de Haro (three white storeys, two full-width verandas, HOTEL DE HARO across the top)
// above its formal garden, wisteria pergola and stone seawall; a bell tower and white buildings behind; the Lime Kiln Cafe
// at the head of the marina; and the marina itself, a long main pier running out north-west with finger piers full of
// white yachts, and a second long pier running north along the east shore. The little white church and the lime kilns stay.
function makeYacht(len = 1) { // one merged mesh: white hull, cabin, dark windows, a flybridge on the big ones
  const parts = [], add = (geo, col, x, y, z) => { geo.translate(x, y, z); parts.push(vcol(geo, col)); };
  const hull = new THREE.SphereGeometry(1, 12, 6, 0, TAU, 0, Math.PI / 2); hull.rotateX(Math.PI); hull.scale(5 * len, 1.1, 1.7); add(hull, '#f6f6f2', 0, 0.6, 0);
  add(new THREE.BoxGeometry(9.6 * len, 0.3, 3.2), '#e4e4de', 0, 0.75, 0);
  add(new THREE.BoxGeometry(4.2 * len, 1.3, 2.4), '#ffffff', -0.6 * len, 1.5, 0);
  add(new THREE.BoxGeometry(4 * len, 0.5, 2.46), '#2a3440', -0.4 * len, 1.6, 0);
  if (len > 1.1) add(new THREE.BoxGeometry(2.6 * len, 0.9, 2.1), '#ffffff', -1 * len, 2.5, 0);
  const m = new THREE.Mesh(mergeGeometries(parts), VC); m.castShadow = true; m.receiveShadow = true; return m;
}
function buildRocheHarbor() {
  // the hotel: on the east shore of the harbour, looking north-west over the marina
  const P0 = P([740, 555]), bayC = P([640, 520]); let H = P0;
  for (let t = 0; t <= 1; t += 0.01) { const x = P0[0] + (bayC[0] - P0[0]) * t, z = P0[1] + (bayC[1] - P0[1]) * t; if (sdAt(x, z) < 30) { H = [x, z]; break; } }
  const [hx, hz] = H, yaw = facingSea(hx, hz), fwd = [Math.sin(yaw), Math.cos(yaw)], right = [Math.cos(yaw), -Math.sin(yaw)], y0 = heightAt(hx, hz);
  const at = (lx, lz) => [hx + right[0] * lx + fwd[0] * lz, hz + right[1] * lx + fwd[1] * lz]; // hotel-local to world (local +z toward the water)
  const g = new THREE.Group(); g.position.set(hx, y0 - 0.4, hz); g.rotation.y = yaw; scene.add(g); BUILT.push([hx, hz, 20]);
  const W = 28, D = 11, FL = 3.4, HT = FL * 3 + 3.2, WHITE = '#f4f1e8'; // HT: wall height, with a band above the verandas for the sign
  const facade = canvasTex(512, 256, (c, w, h) => { // clapboard, three rows of windows and doors, the sign across the top
    c.fillStyle = '#f7f4ec'; c.fillRect(0, 0, w, h); c.fillStyle = 'rgba(0,0,0,0.06)'; for (let y = 4; y < h; y += 7) c.fillRect(0, y, w, 1.5);
    c.fillStyle = '#efe9da'; c.fillRect(0, 0, w, 54); c.fillStyle = '#6b4a2a'; c.font = 'bold 32px Georgia, serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    const txt = 'HOTEL  DE  HARO.'; let x = w / 2 - c.measureText(txt).width / 2 - 20; for (const ch of txt) { c.fillText(ch, x + 12, 28); x += c.measureText(ch).width + 3; }
    for (let r = 0; r < 3; r++) for (let k = 0; k < 11; k++) { const x0 = 18 + k * 44, y0r = 88 + r * 56; c.fillStyle = '#3d4a58'; c.fillRect(x0, y0r, 18, 30); c.fillStyle = '#ffffff'; c.fillRect(x0 - 2, y0r - 2, 22, 3); c.fillRect(x0 + 8, y0r, 2, 30); }
  });
  const plain = toon(WHITE), front = new THREE.MeshToonMaterial({ map: facade, gradientMap: GRAD });
  mesh(new THREE.BoxGeometry(W, HT, D), [plain, plain, plain, plain, front, plain], 0, HT / 2, 0, g); // +z face is the facade
  const roof = mesh(new THREE.ConeGeometry(1, 1, 4), '#9aa0a6', 0, HT + 1.1, 0, g); roof.rotation.y = Math.PI / 4; roof.scale.set((W + 1.5) / Math.SQRT2, 2.2, (D + 1.5) / Math.SQRT2); // a low hip roof
  mesh(new THREE.BoxGeometry(1.6, 3.5, 1.6), '#8a4a3a', -W / 2 + 3, HT + 1.6, -2, g); mesh(new THREE.BoxGeometry(1.6, 3.5, 1.6), '#8a4a3a', W / 2 - 4, HT + 1.6, -2, g); // chimneys
  // two full-width verandas across the front on white posts, with railings
  for (const lv of [1, 2]) { mesh(new THREE.BoxGeometry(W + 1, 0.35, 3.2), WHITE, 0, lv * FL, D / 2 + 1.6, g); mesh(new THREE.BoxGeometry(W + 1, 0.9, 0.15), WHITE, 0, lv * FL + 0.8, D / 2 + 3.1, g);
    for (let k = -W / 2; k <= W / 2; k += 0.9) mesh(new THREE.BoxGeometry(0.08, 0.9, 0.08), WHITE, k, lv * FL + 0.45, D / 2 + 3.1, g, false); }
  for (let k = -W / 2; k <= W / 2 + 0.1; k += W / 9) mesh(new THREE.BoxGeometry(0.35, FL * 3, 0.35), WHITE, k, FL * 1.5, D / 2 + 3.1, g);
  mesh(new THREE.BoxGeometry(W + 1, 0.4, 3.4), WHITE, 0, FL * 3, D / 2 + 1.6, g); // the veranda roof
  // stairs down each end, and the flag on the roof
  for (const sd of [-1, 1]) { const st = mesh(new THREE.BoxGeometry(1.6, 0.4, 6), WHITE, sd * (W / 2 + 1.2), FL / 2, D / 2 - 1, g); st.rotation.x = -0.5; }
  mesh(new THREE.CylinderGeometry(0.12, 0.12, 8, 6), '#ffffff', W / 2 - 6, HT + 4.6, 0, g);
  const stars = canvasTex(96, 56, (c, w, h) => { for (let k = 0; k < 13; k++) { c.fillStyle = k % 2 ? '#ffffff' : '#b22234'; c.fillRect(0, k * h / 13, w, h / 13 + 1); } c.fillStyle = '#3c3b6e'; c.fillRect(0, 0, w * 0.42, h * 0.54); });
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 2), new THREE.MeshBasicMaterial({ map: stars, side: THREE.DoubleSide })); flag.position.set(W / 2 - 4.3, HT + 7.6, 0); g.add(flag); ANIM.push(t => { flag.rotation.y = Math.sin(t * 2.4) * 0.25; });
  // behind: the blue house with its bell tower, and a couple of white buildings
  { const [bx, bz] = at(W / 2 + 12, -8), bg = new THREE.Group(); bg.position.set(bx, heightAt(bx, bz) - 0.4, bz); bg.rotation.y = yaw; scene.add(bg); BUILT.push([bx, bz, 12]);
    mesh(new THREE.BoxGeometry(12, 8, 9), '#6d8fb0', 0, 4, 0, bg); mesh(ROOF_GEO, '#4a5568', 0, 8, 0, bg).scale.set(13.4, 3.6, 10.2);
    mesh(new THREE.BoxGeometry(12.2, 0.4, 0.3), '#ffffff', 0, 4, 4.6, bg);
    mesh(new THREE.BoxGeometry(3.2, 15, 3.2), '#f4f1e8', -7.5, 7.5, 2, bg); mesh(new THREE.BoxGeometry(3.4, 2.6, 3.4), '#e8e2d2', -7.5, 16.2, 2, bg); // bell tower and belfry
    mesh(new THREE.ConeGeometry(2.8, 4.5, 4), '#5b7a6a', -7.5, 19.7, 2, bg).rotation.y = Math.PI / 4; }
  for (const [lx, lz, w, d, h] of [[-W / 2 - 16, -6, 16, 10, 7], [-W / 2 - 4, -24, 20, 12, 6]]) { const [bx, bz] = at(lx, lz); building(bx, bz, yaw, w, d, h, '#f4f1e8', '#9aa0a6', 1.2); }
  // the formal garden between the hotel and the water: lawn, clipped hedges, the wisteria pergola, the stone seawall
  let shore = 14; while (shore < 60 && sdAt(...at(0, shore)) > 1.5) shore += 1;
  const gy = t => heightAt(...at(0, t)) - y0 + 0.2;
  mesh(new THREE.BoxGeometry(W + 4, 0.4, shore - 9), '#5fae4f', 0, gy((shore + 9) / 2), (shore + 9) / 2, g);
  for (const [lx, lz, w, d] of [[-8, 11.5, 8, 1.2], [8, 11.5, 8, 1.2], [-8, shore - 6, 8, 1.2], [8, shore - 6, 8, 1.2], [-12.5, (shore + 5) / 2, 1.2, shore - 16], [12.5, (shore + 5) / 2, 1.2, shore - 16], [-3.5, (shore + 5) / 2, 1.2, shore - 16], [3.5, (shore + 5) / 2, 1.2, shore - 16]])
    mesh(new THREE.BoxGeometry(w, 1.2, d), '#2f6b35', lx, gy(lz) + 0.8, lz, g); // box hedges round the beds
  for (let k = -W / 2; k <= W / 2 + 0.1; k += 4) { mesh(new THREE.BoxGeometry(0.35, 3.2, 0.35), WHITE, k, gy(shore - 3) + 1.6, shore - 3, g); mesh(new THREE.BoxGeometry(0.35, 3.2, 0.35), WHITE, k, gy(shore - 6) + 1.6, shore - 6, g); } // pergola posts
  mesh(new THREE.BoxGeometry(W + 1, 0.3, 3.6), WHITE, 0, gy(shore - 4.5) + 3.3, shore - 4.5, g);
  for (let k = -W / 2; k < W / 2; k += 2.2) { const b = mesh(new THREE.SphereGeometry(1.3, 7, 5), k % 4.4 < 2.2 ? '#b8c95a' : '#9fbf5a', k + 1, gy(shore - 4.5) + 3.7, shore - 4.5, g); b.scale.set(1, 0.55, 1.6); } // wisteria
  for (let k = -W / 2 - 4; k <= W / 2 + 4; k += 2.4) { const st = mesh(new THREE.BoxGeometry(2.4, 3.4, 1.8), k % 4.8 < 2.4 ? '#7d776c' : '#6e695f', k, -0.8 - y0 + 0.4 + 1.7, shore, g); st.scale.y = 0.9 + ((k * 7) % 3) * 0.05; } // stone seawall
  // the marina: the main pier runs north-west from the shore just south of the hotel, finger piers off both sides;
  // a second long pier runs north along the east shore. Everything in the water is one merged mesh per kind.
  const dockParts = [], dockAdd = (x, z, len, rot, w = 3) => { const geo = new THREE.BoxGeometry(w, 0.7, len); geo.rotateY(rot); geo.translate(x, 0.5, z); dockParts.push(vcol(geo, '#b89668')); };
  const boats = [], moor = (x, z, rot, big) => { if (sdAt(x, z) > -6 || boats.length > 185) return; const b = makeYacht(big ? 1.3 : 0.9 + R01() * 0.3); b.position.set(x, 0, z); b.rotation.y = rot; scene.add(b); boats.push(b); SAILBOATS.push({ g: b, x, z, yaw: rot, ph: R01() * 10 }); };
  const rootA = at(W / 2 + 10, shore + 2), dirA = Math.atan2(-0.55, -1) /* world west-north-west, out into the deep water */, fA = [Math.cos(dirA), Math.sin(dirA)], sA = [-fA[1], fA[0]];
  let lenA = 0; while (lenA < 175 && !(lenA > 40 && sdAt(rootA[0] + fA[0] * lenA, rootA[1] + fA[1] * lenA) > -25)) lenA += 4; // out until it nears the far side
  const yawA = Math.atan2(fA[0], fA[1]); dockAdd(rootA[0] + fA[0] * lenA / 2, rootA[1] + fA[1] * lenA / 2, lenA, yawA, 3.4);
  for (let t = 24; t < lenA - 6; t += 16) for (const sd of [-1, 1]) { // finger piers, with yachts both sides
    const L = 38, cx = rootA[0] + fA[0] * t + sA[0] * sd * (L / 2 + 1.5), cz = rootA[1] + fA[1] * t + sA[1] * sd * (L / 2 + 1.5); if (sdAt(cx, cz) > -8) continue;
    dockAdd(cx, cz, L, Math.atan2(sA[0], sA[1]), 2.2);
    for (let k = 4; k < L; k += 7) for (const q of [-1, 1]) if (R01() < 0.85) { const px = rootA[0] + fA[0] * (t + q * 4.2) + sA[0] * sd * (k + 1.5), pz = rootA[1] + fA[1] * (t + q * 4.2) + sA[1] * sd * (k + 1.5); moor(px, pz, Math.atan2(-sA[1] * sd, sA[0] * sd), k < 10); }
  }
  const rootB = at(-W / 2 - 6, shore + 2), dB = Math.atan2(-1, -0.45), fB = [Math.cos(dB), Math.sin(dB)], sB = [-fB[1], fB[0]]; // north, along the east shore
  let lenB = 0; while (lenB < 170 && !(lenB > 30 && sdAt(rootB[0] + fB[0] * lenB, rootB[1] + fB[1] * lenB) > -8)) lenB += 4;
  dockAdd(rootB[0] + fB[0] * lenB / 2, rootB[1] + fB[1] * lenB / 2, lenB, Math.atan2(fB[0], fB[1]), 3);
  for (let t = 18; t < lenB - 4; t += 10) for (const sd of [-1, 1]) if (R01() < 0.8) moor(rootB[0] + fB[0] * t + sB[0] * sd * 5.5, rootB[1] + fB[1] * t + sB[1] * sd * 5.5, Math.atan2(fB[0], fB[1]) - Math.PI / 2, false);
  if (dockParts.length) { const docks = new THREE.Mesh(mergeGeometries(dockParts), VC); docks.receiveShadow = true; scene.add(docks); }
  // the Lime Kiln Cafe at the head of the main pier
  { const [cx, cz] = at(W / 2 + 10, shore - 5); building(cx, cz, yaw, 12, 8, 4.5, '#e8e2d2', '#5a616b', 1.8); }
  // the little white church up the hill, and the old lime-kiln chimneys
  const [cx, cz] = P([790, 515]), ch = building(cx, cz, facingSea(cx, cz), 7, 12, 7, '#ffffff', '#3b3f47', 3.5);
  mesh(new THREE.BoxGeometry(2.4, 6, 2.4), '#ffffff', 0, ch.top + 3, 5, ch.g); mesh(new THREE.ConeGeometry(1.9, 5, 4), '#3b3f47', 0, ch.top + 8.5, 5, ch.g).rotation.y = Math.PI / 4;
  for (const [px, py] of [[700, 610], [715, 618]]) { const [kx, kz] = P([px, py]), h0 = heightAt(kx, kz); mesh(new THREE.CylinderGeometry(1.4, 2, 14, 10), '#d7cfc0', kx, h0 + 7, kz); BUILT.push([kx, kz, 5]); }
}
function buildLandmarks() {
  // Roche Harbor
  buildRocheHarbor();
  // English Camp on Garrison Bay: blockhouse, white barracks, Union Jack
  { const [x, z] = P([770, 1128]), yaw = facingSea(x, z);
    building(x, z, yaw, 16, 7, 5, '#f4f1e8', '#6e3b2e', 2.5);
    const [bx, bz] = P([745, 1122]), h0 = heightAt(bx, bz), bh = new THREE.Group(); bh.position.set(bx, h0, bz); bh.rotation.y = Math.PI / 4; scene.add(bh);
    mesh(new THREE.BoxGeometry(6, 4, 6), '#8a6a44', 0, 2, 0, bh); mesh(new THREE.BoxGeometry(8, 4, 8), '#7a5a3a', 0, 6, 0, bh); mesh(new THREE.ConeGeometry(6.2, 3, 4), '#51463f', 0, 9.5, 0, bh).rotation.y = Math.PI / 4; BUILT.push([bx, bz, 6]);
    const [fx, fz] = P([785, 1112]), fh = heightAt(fx, fz); mesh(new THREE.CylinderGeometry(0.2, 0.2, 16, 6), '#ffffff', fx, fh + 8, fz);
    const uj = flagTex((c, w, h) => { c.fillStyle = '#1f3b8a'; c.fillRect(0, 0, w, h); c.strokeStyle = '#ffffff'; c.lineWidth = 14; c.beginPath(); c.moveTo(0, 0); c.lineTo(w, h); c.moveTo(w, 0); c.lineTo(0, h); c.stroke();
      c.strokeStyle = '#c8102e'; c.lineWidth = 5; c.stroke(); c.fillStyle = '#ffffff'; c.fillRect(w / 2 - 10, 0, 20, h); c.fillRect(0, h / 2 - 10, w, 20); c.fillStyle = '#c8102e'; c.fillRect(w / 2 - 6, 0, 12, h); c.fillRect(0, h / 2 - 6, w, 12); });
    const f = mesh(new THREE.PlaneGeometry(5, 3.2), new THREE.MeshBasicMaterial({ map: uj, side: THREE.DoubleSide }), fx + 2.6, fh + 14.2, fz, scene, false); ANIM.push(t => { f.rotation.y = Math.sin(t * 2.5) * 0.25; });
  }
  // Snug Harbor Resort & Marina
  { const [x, z] = P([690, 1470]); building(x, z, facingSea(x, z), 14, 8, 5, '#b8d8c8', '#2f4a3a', 2.4);
    const [dx, dz] = P([690, 1440]); mesh(new THREE.BoxGeometry(60, 0.7, 3), '#a47a4a', dx, 0.5, dz, scene, false);
    for (let k = 0; k < 4; k++) { mesh(new THREE.BoxGeometry(2.5, 0.7, 16), '#a47a4a', dx - 24 + k * 16, 0.5, dz - 8, scene, false); moored(dx - 20 + k * 16, dz - 10, Math.PI / 2); } }
}
const ANIM = [];

// ============================================================ boats, orcas, eagles
const SAILBOATS = [];
function makeSailboat(hull = '#ffffff', sailUp = true) {
  const g = new THREE.Group();
  const h = mesh(new THREE.SphereGeometry(1, 12, 6), hull, 0, 0.3, 0, g); h.scale.set(4.2, 0.9, 1.4);
  mesh(new THREE.BoxGeometry(3, 0.8, 1.6), '#f4f1e8', -0.4, 1.2, 0, g);
  mesh(new THREE.CylinderGeometry(0.1, 0.1, 10, 6), '#dddddd', 0.6, 5.5, 0, g);
  if (sailUp) { const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(0, 8.5); s.lineTo(-3.8, 0); const sail = new THREE.Mesh(new THREE.ShapeGeometry(s), new THREE.MeshToonMaterial({ color: '#fbf8ee', gradientMap: GRAD, side: THREE.DoubleSide })); sail.position.set(0.5, 1.4, 0); g.add(sail); g.userData.sail = sail; }
  return setShadows(g);
}
function moored(x, z, yaw) { const b = makeSailboat(pick(['#ffffff', '#ffffff', '#2e5e8e', '#b8412c']), false); b.position.set(x, 0, z); b.rotation.y = yaw; scene.add(b); SAILBOATS.push({ g: b, x, z, yaw, ph: rand() * 10 }); }
const CRUISERS = [];
function buildBoats() {
  // boats riding at anchor in the bays
  for (const [px, py, n] of [[760, 1030, 6], [740, 850, 8], [640, 520, 3], [815, 1380, 3], [300, 760, 2]]) { const [cx, cz] = P([px, py]);
    for (let k = 0; k < n; k++) { for (let t = 0; t < 20; t++) { const x = cx + rr(-60, 60), z = cz + rr(-60, 60); if (sdAt(x, z) < -14) { moored(x, z, rand() * TAU); break; } } } }
  // a few sailing out in Haro Strait
  for (let k = 0; k < 4; k++) { const g = makeSailboat(pick(['#ffffff', '#f6d68a'])); scene.add(g); CRUISERS.push({ g, cx: rr(-1320, -1180), cz: rr(-1000, 1600), r: rr(70, 140), a: rand() * TAU, w: rr(0.03, 0.06) * (k % 2 ? 1 : -1) }); }
}
const ORCAS = [];
function makeOrca() {
  const g = new THREE.Group();
  const b = mesh(new THREE.SphereGeometry(1, 14, 10), '#15121c', 0, 0, 0, g); b.scale.set(4, 1.3, 1.3);
  const belly = mesh(new THREE.SphereGeometry(1, 12, 8), '#ffffff', 0.6, -0.45, 0, g); belly.scale.set(3, 0.8, 1.05);
  for (const s of [1, -1]) mesh(new THREE.SphereGeometry(0.35, 8, 6), '#ffffff', 2.5, 0.35, s * 0.95, g).scale.set(1.6, 0.6, 0.5); // eye patches
  const fs = new THREE.Shape(); fs.moveTo(-1, 0); fs.lineTo(0.8, 0); fs.quadraticCurveTo(0.2, 1.4, -0.6, 3.2); fs.lineTo(-1, 0);
  const fin = new THREE.Mesh(new THREE.ExtrudeGeometry(fs, { depth: 0.3, bevelEnabled: false }), toon('#15121c')); fin.position.set(-0.3, 1, -0.15); g.add(fin);
  const tail = mesh(new THREE.BoxGeometry(1.2, 0.2, 3.2), '#15121c', -4.3, 0, 0, g);
  g.scale.setScalar(1.3); return setShadows(g);
}
function buildWildlife() {
  // a pod of orcas cruising Haro Strait, surfacing now and then
  for (let k = 0; k < 5; k++) { const g = makeOrca(); scene.add(g); ORCAS.push({ g, lane: rr(-40, 40), lag: k * 14 + rr(0, 6), ph: rand() * 6, big: k === 0 ? 1.25 : k === 4 ? 0.7 : 1 }); }
}
const EAGLES = [];
function makeEagle() {
  const g = new THREE.Group();
  const b = mesh(new THREE.SphereGeometry(0.5, 10, 8), '#4a2f1a', 0, 0, 0, g); b.scale.set(1.8, 0.6, 0.7);
  mesh(new THREE.SphereGeometry(0.33, 10, 8), '#ffffff', 0.95, 0.12, 0, g);
  const bk = mesh(new THREE.ConeGeometry(0.1, 0.35, 6), '#ffc21e', 1.33, 0.06, 0, g); bk.rotation.z = -Math.PI / 2;
  const tl = mesh(new THREE.SphereGeometry(1, 10, 5), '#ffffff', -1.05, 0, 0, g); tl.scale.set(0.5, 0.07, 0.35);
  const wings = []; for (const s of [1, -1]) { const p = new THREE.Group(); p.position.set(0, 0.1, s * 0.3); const w = mesh(new THREE.SphereGeometry(1, 12, 6), '#3b2513', 0, 0, s * 1.6, p); w.scale.set(0.75, 0.07, 1.7); g.add(p); wings.push({ p, s }); }
  g.scale.setScalar(2.6); g.userData.wings = wings; return setShadows(g);
}
function buildEagles() { for (const [px, py] of [[250, 600], [700, 520], [800, 1050], [150, 1000], [700, 1420]]) { const [cx, cz] = P([px, py]), g = makeEagle(); scene.add(g); EAGLES.push({ g, cx, cz, r: rr(60, 140), alt: rr(70, 130), w: rr(0.12, 0.2) * (rand() < 0.5 ? 1 : -1), a: rand() * TAU, t: rand() * 100 }); } }

// seagulls: flocks wheeling over the bays, and a few that trail your ship
const GULLS = [];
function makeGull() {
  const g = new THREE.Group();
  const b = mesh(new THREE.SphereGeometry(0.5, 10, 8), '#ffffff', 0, 0, 0, g); b.scale.set(1.6, 0.55, 0.6);
  mesh(new THREE.SphereGeometry(0.28, 10, 8), '#ffffff', 0.8, 0.15, 0, g);
  const bk = mesh(new THREE.ConeGeometry(0.07, 0.3, 6), '#f2c14e', 1.12, 0.12, 0, g); bk.rotation.z = -Math.PI / 2;
  const tl = mesh(new THREE.SphereGeometry(1, 8, 5), '#e9ecf0', -0.85, 0, 0, g); tl.scale.set(0.35, 0.05, 0.25);
  const wings = [];
  for (const s of [1, -1]) { const p = new THREE.Group(); p.position.set(0.05, 0.08, s * 0.25); const w = mesh(new THREE.SphereGeometry(1, 10, 5), '#c9ced6', 0, 0, s * 1.15, p); w.scale.set(0.42, 0.05, 1.2);
    const tip = mesh(new THREE.SphereGeometry(1, 8, 5), '#2b2b30', -0.05, 0, s * 2.2, p); tip.scale.set(0.24, 0.05, 0.32); g.add(p); wings.push({ p, s }); }
  g.scale.setScalar(1.7); g.userData.wings = wings; return setShadows(g);
}
function buildGulls() {
  for (const [px, py, n] of [[640, 520, 5], [750, 1030, 4], [160, 1300, 5], [700, 1430, 4]]) { const [cx, cz] = P([px, py]);
    for (let k = 0; k < n; k++) { const g = makeGull(); scene.add(g); GULLS.push({ g, cx: cx + rr(-40, 40), cz: cz + rr(-40, 40), r: rr(25, 70), alt: rr(22, 50), w: rr(0.35, 0.6) * (rand() < 0.5 ? 1 : -1), a: rand() * TAU, t: rand() * 20 }); } }
  const wold = HIDEOUTS[0]; if (wold) for (let k = 0; k < 3; k++) { const g = makeGull(); scene.add(g); GULLS.push({ g, cx: wold.x, cz: wold.z, r: rr(16, 30), alt: rr(18, 30), w: rr(0.5, 0.8) * (k % 2 ? 1 : -1), a: rand() * TAU, t: rand() * 20 }); } // a few hang around Wold Cabin
}
function updateGulls(dt) {
  for (const b of GULLS) { b.a += b.w * dt; b.t += dt; const s = Math.sign(b.w), cx = b.cx, cz = b.cz;
    const r = b.r * (1 + 0.2 * Math.sin(b.t * 0.3)), x = cx + Math.cos(b.a) * r, z = cz + Math.sin(b.a) * r, y = b.alt + Math.sin(b.t * 0.7) * 4;
    b.g.position.set(x, y, z); b.g.rotation.set(0, Math.atan2(-Math.cos(b.a) * s, -Math.sin(b.a) * s), 0); b.g.rotateX(-0.3 * s);
    const flap = Math.sin(b.t * 0.9) > 0.1; for (const w of b.g.userData.wings) w.p.rotation.x = w.s * (flap ? Math.sin(b.t * 11) * 0.6 : 0.12); }
}

// ============================================================ the pirate ship
const JOLLY_ROGER = (c, w, h) => { c.fillStyle = '#15121c'; c.fillRect(0, 0, w, h); c.fillStyle = '#ffffff'; c.beginPath(); c.arc(w / 2, 32, 14, 0, TAU); c.fill(); c.fillRect(w / 2 - 9, 38, 18, 10);
  c.fillStyle = '#15121c'; c.beginPath(); c.arc(w / 2 - 6, 31, 4, 0, TAU); c.arc(w / 2 + 6, 31, 4, 0, TAU); c.fill(); c.strokeStyle = '#ffffff'; c.lineWidth = 6; c.lineCap = 'round';
  c.beginPath(); c.moveTo(w / 2 - 24, 52); c.lineTo(w / 2 + 24, 72); c.moveTo(w / 2 + 24, 52); c.lineTo(w / 2 - 24, 72); c.stroke(); };
const UNION_JACK = (c, w, h) => { c.fillStyle = '#1f3b8a'; c.fillRect(0, 0, w, h); c.strokeStyle = '#ffffff'; c.lineWidth = 16; c.beginPath(); c.moveTo(0, 0); c.lineTo(w, h); c.moveTo(w, 0); c.lineTo(0, h); c.stroke();
  c.strokeStyle = '#c8102e'; c.lineWidth = 6; c.stroke(); c.fillStyle = '#ffffff'; c.fillRect(w / 2 - 13, 0, 26, h); c.fillRect(0, h / 2 - 13, w, 26); c.fillStyle = '#c8102e'; c.fillRect(w / 2 - 8, 0, 16, h); c.fillRect(0, h / 2 - 8, w, 16); };
const RED_ENSIGN = (c, w, h) => { c.fillStyle = '#c8102e'; c.fillRect(0, 0, w, h); c.save(); c.scale(0.5, 0.5); UNION_JACK(c, w, h); c.restore(); };
const SHIP_STYLES = {
  pirate: { top: '#2a1a10', stripe: '#e3b04b', hull: '#7a4a2a', keel: '#1c1410', deck: '#c89a64', castle: '#6a3e22', sail: '#f4ecd3', flag: JOLLY_ROGER },
  navy: { top: '#f2f0ea', stripe: '#e3b04b', hull: '#1f3b6e', keel: '#15121c', deck: '#d8b88a', castle: '#2a4a82', sail: '#ffffff', flag: UNION_JACK },
  merchant: { top: '#5a3a1e', stripe: '#3f7a4a', hull: '#b58a55', keel: '#3a2a1a', deck: '#d9c29a', castle: '#8a6a44', sail: '#e9dcc0', flag: RED_ENSIGN },
};
function makeShip(styleName = 'pirate') {
  const ST = SHIP_STYLES[styleName];
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  // hull: a top-down outline (pointed bow at +x, square stern) extruded upward, pinched toward the keel, painted in bands
  const o = new THREE.Shape(); o.moveTo(-7, -2.3); o.lineTo(1.5, -2.5); o.quadraticCurveTo(6, -2.2, 8.2, 0); o.quadraticCurveTo(6, 2.2, 1.5, 2.5); o.lineTo(-7, 2.3); o.lineTo(-7, -2.3);
  let hull = new THREE.ExtrudeGeometry(o, { depth: 3.4, bevelEnabled: false, curveSegments: 10 }); hull.rotateX(-Math.PI / 2); hull.translate(0, -1.3, 0); hull = hull.index ? hull.toNonIndexed() : hull;
  { const p = hull.attributes.position, col = new Float32Array(p.count * 3), c = new THREE.Color();
    for (let i = 0; i < p.count; i++) { const y = p.getY(i), k = lerp(0.45, 1, smooth(-1.3, 0.9, y)); p.setX(i, p.getX(i) * lerp(0.85, 1, k)); p.setZ(i, p.getZ(i) * k);
      c.set(y > 1.5 ? ST.top : y > 0.35 && y < 0.8 ? ST.stripe : y < -0.6 ? ST.keel : ST.hull); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    hull.setAttribute('color', new THREE.BufferAttribute(col, 3)); hull.computeVertexNormals(); }
  const hullMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: GRAD }); // own copy so battle damage can darken it
  mesh(hull, hullMat, 0, 0, 0, body);
  const deck = new THREE.ShapeGeometry(o); deck.rotateX(-Math.PI / 2); mesh(deck, ST.deck, 0, 1.95, 0, body).scale.set(0.97, 1, 0.94);
  // stern castle with glowing windows, bowsprit, cannons
  mesh(new THREE.BoxGeometry(3.4, 2, 4.4), ST.castle, -5.4, 3, 0, body); mesh(new THREE.BoxGeometry(3.8, 0.3, 4.8), '#2a1a10', -5.4, 4.1, 0, body);
  for (const z of [-1.2, 0, 1.2]) mesh(new THREE.BoxGeometry(0.1, 0.7, 0.7), new THREE.MeshBasicMaterial({ color: '#ffd76a' }), -7.12, 2.9, z, body, false);
  for (const s of [-1, 1]) mesh(new THREE.BoxGeometry(0.5, 0.6, 0.5), new THREE.MeshBasicMaterial({ color: '#ffd76a' }), -7.1, 4.6, s * 2.1, body, false); // stern lanterns
  const bs = mesh(new THREE.CylinderGeometry(0.12, 0.18, 6, 6), '#5a3a1e', 9.6, 3.2, 0, body); bs.rotation.z = -1.2;
  for (const s of [-1, 1]) for (const x of [-2.5, 0, 2.5]) { const cn = mesh(new THREE.CylinderGeometry(0.22, 0.26, 1.3, 8), '#1a1a1a', x, 1.1, s * 2.55, body); cn.rotation.x = Math.PI / 2; }
  // masts, yards and billowing sails
  const sailMat = new THREE.MeshToonMaterial({ color: ST.sail, gradientMap: GRAD, side: THREE.DoubleSide });
  const sail = (w, h) => { const geo = new THREE.PlaneGeometry(w, h, 6, 4); const p = geo.attributes.position; for (let i = 0; i < p.count; i++) { const u = p.getX(i) / (w / 2), v = p.getY(i) / (h / 2); p.setZ(i, (1 - u * u) * (1 - 0.3 * v * v) * w * 0.14); } geo.computeVertexNormals(); geo.rotateY(Math.PI / 2); return geo; };
  const sails = [];
  for (const [x, h, w] of [[3.6, 13, 5.2], [0, 16, 6.2], [-3.8, 11, 4.4]]) {
    mesh(new THREE.CylinderGeometry(0.16, 0.22, h, 8), '#4a2e18', x, 2 + h / 2, 0, body);
    for (const [f, sw] of [[0.45, 1], [0.78, 0.8]]) { const y = 2 + h * f, ww = w * sw, hh = h * 0.28;
      const yd = mesh(new THREE.CylinderGeometry(0.1, 0.1, ww + 0.8, 6), '#4a2e18', x, y + hh / 2, 0, body); yd.rotation.x = Math.PI / 2;
      const s = mesh(sail(ww, hh), sailMat, x + 0.05, y, 0, body); sails.push(s); }
  }
  mesh(new THREE.CylinderGeometry(0.9, 0.7, 0.8, 10, 1, true), '#4a2e18', 0, 2 + 16 * 0.9, 0, body); // crow's nest
  // colours: Jolly Roger, Union Jack or red ensign
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.25, 6, 1), new THREE.MeshBasicMaterial({ map: canvasTex(128, 80, ST.flag), side: THREE.DoubleSide })); flag.position.set(-1.9, 2 + 16 + 0.8, 0); body.add(flag);
  g.userData = { body, sails, flag, hullMat };
  g.scale.setScalar(1.5); return setShadows(g);
}
const SHIP = { id: 'me', g: null, x: 0, z: 0, y: 0, yaw: Math.PI / 2, speed: 0, turn: 0, path: [], goal: null, anchored: true, rollA: 0, rollV: 0, driftV: 0,
  hp: 6, maxHp: 6, sinking: false, sinkT: 0, list: 0, listT: 0, listDir: 1, fires: [], fireT: 0 };
// (routes: A* + string-pulling in @klh/shared/nav; sailing physics in @klh/shared/ship)

// destination marker (a red X) and the dotted course line
const marker = new THREE.Group();
{ for (const r of [Math.PI / 4, -Math.PI / 4]) { const b = mesh(new THREE.BoxGeometry(9, 0.5, 1.8), '#c8352b', 0, 0.35, 0, marker, false); b.rotation.y = r; }
  const ring = new THREE.Mesh(new THREE.RingGeometry(6.5, 7.6, 32), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8 })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.3; marker.add(ring); marker.userData.ring = ring;
  marker.visible = false; scene.add(marker); }
const courseMat = new THREE.LineDashedMaterial({ color: '#ffffff', dashSize: 6, gapSize: 5, transparent: true, opacity: 0.85 });
let courseLine = null;
function drawCourse() {
  if (courseLine) { scene.remove(courseLine); courseLine.geometry.dispose(); courseLine = null; }
  if (!SHIP.path.length) return;
  const pts = [new V3(SHIP.x, 0.6, SHIP.z), ...SHIP.path.map(([x, z]) => new V3(x, 0.6, z))];
  courseLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), courseMat); courseLine.computeLineDistances(); scene.add(courseLine);
}
function setSail(tx, tz, name) {
  if (SHIP.sinking || !MODE) return;
  const path = findPath(SHIP.x, SHIP.z, tx, tz);
  if (!path) { toast("Can't find a way through there, captain!"); return; }
  SHIP.path = path; SHIP.anchored = false; const [gx, gz] = path[path.length - 1]; SHIP.goal = [gx, gz];
  if (NET) { NET.room.send('sail', { x: tx, z: tz }); SHIP.wasSailing = true; } // online the server steers; the course drawn here is the same route
  marker.position.set(gx, 0, gz); marker.visible = true; drawCourse();
  const onLand = sdAt(tx, tz) > 0;
  toast(name ? `Setting course for ${name}!` : onLand ? 'Land ho! Sailing as close as we can.' : 'Aye aye, captain!', 1800);
  btn('bAnchor').classList.remove('on');
}
function dropAnchor() { if (NET) NET.room.send('anchor'); SHIP.path = []; SHIP.goal = null; SHIP.anchored = true; marker.visible = false; drawCourse(); btn('bAnchor').classList.add('on'); toast('Anchor dropped!', 1400); }

// ============================================================ battle: effects, cannonballs, enemy ships, treasure & coins
const PGEO = { sph: new THREE.SphereGeometry(1, 8, 6), box: new THREE.BoxGeometry(1, 1, 1), ring: new THREE.RingGeometry(0.82, 1, 28).rotateX(-Math.PI / 2),
  col: new THREE.CylinderGeometry(1, 1.3, 1, 10, 1, true).translate(0, 0.5, 0), coin: new THREE.CylinderGeometry(1, 1, 0.25, 14), tet: new THREE.TetrahedronGeometry(1),
  // a spout: a faceted funnel of spray, narrow at the blowhole and ragged at the top
  spout: (() => { const g = new THREE.CylinderGeometry(1, 0.18, 1, 7, 3, true); const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i) + 0.5; if (y > 0.3) { const j = 1 + (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.35 * y; p.setX(i, p.getX(i) * j); p.setZ(i, p.getZ(i) * j); if (y > 0.9) p.setY(i, p.getY(i) + Math.abs(Math.sin(i * 7.1)) * 0.25); } }
    g.translate(0, 0.5, 0); g.computeVertexNormals(); return g; })() };
const PARTS = [], R01 = Math.random;
function part(geo, color, x, y, z, o = {}) {
  // lit (toon-shaded) parts read as solid puffs of smoke; unlit ones as flashes and spray
  const mat = o.lit ? new THREE.MeshToonMaterial({ color, gradientMap: GRAD, transparent: true, depthWrite: false }) : new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  if (o.flat) mat.flatShading = true;
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.renderOrder = 3; scene.add(m); // after the see-through sea, or the water tints it
  if (o.rot) { m.rotation.order = 'YXZ'; m.rotation.set(...o.rot); }
  PARTS.push({ m, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0, g: o.g || 0, drag: o.drag || 0, life: o.life || 1, age: 0, s0: o.s0 ?? 1, s1: o.s1 ?? o.s0 ?? 1, sy: o.sy, syOut: o.syOut, op: o.opacity ?? 1, fade: o.fade ?? true, fp: o.fadePow || 2, spin: o.spin || 0 });
}
function updateParts(dt) {
  for (let i = PARTS.length - 1; i >= 0; i--) { const p = PARTS[i]; p.age += dt; const u = p.age / p.life;
    if (u >= 1) { scene.remove(p.m); p.m.material.dispose(); PARTS.splice(i, 1); continue; }
    p.vy -= p.g * dt; if (p.drag) { const k = Math.max(0, 1 - p.drag * dt); p.vx *= k; p.vz *= k; p.vy *= k; }
    p.m.position.x += p.vx * dt; p.m.position.y += p.vy * dt; p.m.position.z += p.vz * dt;
    const s = lerp(p.s0, p.s1, 1 - (1 - u) * (1 - u)); p.m.scale.set(s, p.sy ? lerp(p.sy[0], p.sy[1], p.syOut ? 1 - (1 - u) ** 3 : Math.sin(u * Math.PI)) : s, s);
    if (p.spin) { p.m.rotation.x += p.spin * dt; p.m.rotation.y += p.spin * dt * 0.7; }
    if (p.fade) p.m.material.opacity = p.op * (1 - Math.pow(u, p.fp)); }
}
const fx = {
  splash(x, z) { // ring + water column + droplets
    part(PGEO.ring, '#ffffff', x, 0.3, z, { life: 1.4, s0: 1.5, s1: 11 });
    part(PGEO.col, '#e8f7ff', x, 0, z, { life: 0.9, s0: 1.4, s1: 0.6, sy: [0.5, 9] });
    for (let k = 0; k < 10; k++) { const a = R01() * TAU, v = 3 + R01() * 6; part(PGEO.sph, '#ffffff', x, 1, z, { vx: Math.cos(a) * v, vz: Math.sin(a) * v, vy: 10 + R01() * 10, g: 30, life: 1.1, s0: 0.7, s1: 0.3 }); }
  },
  // thick gray-white powder smoke; `push` blows it out sideways (cannon muzzles) before it drifts up
  smoke(x, y, z, n = 5, color = null, size = 1.6, push = [0, 0]) { for (let k = 0; k < n; k++) part(PGEO.sph, color || ['#f2f2f2', '#dcdcdc', '#c4c4c4', '#aeaeae'][k % 4], x + (R01() - 0.5) * 2, y + R01(), z + (R01() - 0.5) * 2,
    { vx: push[0] * (0.6 + R01() * 0.8) + (R01() - 0.5) * 2, vz: push[1] * (0.6 + R01() * 0.8) + (R01() - 0.5) * 2, vy: 1.5 + R01() * 2.5, drag: 1.6, life: 2.4 + R01() * 1.4, s0: size, s1: size * 3, lit: true, fadePow: 4 }); },
  dirt(x, y, z) { for (let k = 0; k < 8; k++) { const a = R01() * TAU; part(PGEO.sph, k % 2 ? '#8a6a44' : '#6b5a3a', x, y + 1, z, { vx: Math.cos(a) * 5, vz: Math.sin(a) * 5, vy: 8 + R01() * 6, g: 25, life: 0.9, s0: 1, s1: 0.4 }); } fx.smoke(x, y + 1, z, 3, '#b9a98a'); },
  flash(x, y, z, s = 2.2) { part(PGEO.sph, '#ffd23a', x, y, z, { life: 0.18, s0: s, s1: s * 2 }); part(PGEO.sph, '#ff7a1e', x, y, z, { life: 0.3, s0: s * 0.6, s1: s * 1.6 }); },
  hit(x, y, z) { fx.flash(x, y, z, 3); fx.smoke(x, y, z, 6, '#555555', 2);
    for (let k = 0; k < 12; k++) { const a = R01() * TAU; part(PGEO.box, k % 3 ? '#7a4a2a' : '#c89a64', x, y, z, { vx: Math.cos(a) * 9, vz: Math.sin(a) * 9, vy: 8 + R01() * 8, g: 25, life: 1.4, s0: 0.6, s1: 0.5, spin: 8, fade: false }); } },
  // a whale's blow: the funnel shoots up and fans out, then breaks into angular droplets. tilt leans it (the sperm whale's goes forward-left)
  spout(x, z, h = 9, yaw = 0, tilt = 0, lean = 0) {
    part(PGEO.spout, '#eef9ff', x, 0.6, z, { life: 1.7, s0: 1.2, s1: 2.6, sy: [0.6, h], syOut: true, lit: true, flat: true, rot: [lean, yaw, -tilt], opacity: 0.9, fadePow: 3 });
    part(PGEO.spout, '#ffffff', x, 0.6, z, { life: 1.2, s0: 0.6, s1: 1.4, sy: [0.4, h * 0.8], syOut: true, lit: true, flat: true, rot: [lean, yaw + 0.4, -tilt], opacity: 0.8, fadePow: 2 });
    const fx_ = Math.cos(yaw) * Math.sin(tilt), fz_ = -Math.sin(yaw) * Math.sin(tilt);
    for (let k = 0; k < 9; k++) part(PGEO.tet, k % 2 ? '#ffffff' : '#cfeeff', x + fx_ * h * 0.7, h * 0.9, z + fz_ * h * 0.7,
      { vx: fx_ * 4 + (R01() - 0.5) * 5, vz: fz_ * 4 + (R01() - 0.5) * 5, vy: 2 + R01() * 4, g: 18, life: 1.3, s0: 0.45, s1: 0.2, spin: 6, lit: true, flat: true, fadePow: 3 });
  },
  gold(x, y, z, n = 14) { for (let k = 0; k < n; k++) { const a = R01() * TAU, v = 2 + R01() * 4; part(PGEO.coin, '#f5c518', x, y, z, { vx: Math.cos(a) * v, vz: Math.sin(a) * v, vy: 9 + R01() * 7, g: 22, life: 1.4, s0: 0.7, s1: 0.7, spin: 10, fade: false }); }
    part(PGEO.sph, '#fff4a8', x, y, z, { life: 0.4, s0: 2, s1: 6 }); },
};

let gold = 0, cargo = 0; // single-player loot: banked at Wold Cabin, and in the hold (the captain's hands are CAP.carry)
let hudKey = '';
const hud = () => {
  const L = NET && NET.st ? { gold: NET.st.gold, cargo: NET.st.cargo, carry: NET.st.carry } : { gold, cargo, carry: CAP.carry }, hp = Math.max(0, SHIP.hp);
  const key = [L.gold, L.cargo, L.carry, hp, SHIP.maxHp].join(); if (key === hudKey) return; hudKey = key;
  btn('gold').textContent = L.gold; btn('cargo').textContent = L.cargo; btn('carry').textContent = L.carry;
  btn('hullBar').innerHTML = '<i></i>'.repeat(hp) + '<i class="lost"></i>'.repeat(SHIP.maxHp - hp);
  btn('log').classList.toggle('low', hp <= 2); btn('hullBar').setAttribute('aria-label', `Hull ${hp} of ${SHIP.maxHp}`); };

// Hideouts: Wold Cabin (on the eastern inner shore of Open Bay, Henry Island) is home in single-player; online
// every crew gets its own cove. All eight spots are kept clear of trees from the start; a cabin goes up when a crew moves in.
const HIDEOUTS = []; // home index -> { i, name, x, z, wx, wz, g, pen, label }
let CABIN = null;    // your own hideout
function reserveHomes() { for (let i = 0; i < HOMES.length; i++) { const [x, z] = findHomeSpot(i); BUILT.push([x, z, 14]); } const [wx, wz] = woldSpot(); BUILT.push([wx, wz, 24]); const [dx, dz] = WOLD.dock, [bx, bz] = WOLD.bend;
  for (let u = 0; u <= 1; u += 0.1) BUILT.push([lerp(dx, bx, u), lerp(dz, bz, u), 7], [lerp(bx, wx, u), lerp(bz, wz, u), 7]); } // keep trees off the path

// Wold Cabin: a brown cabin up on a rocky knoll just south of its dock, looking south: a long ground floor, a smaller upper
// floor over its west end with one window on the water, peaked roofs on both, and a deck hanging out to the south-west over Open Bay.
// Where the dock meets land a little rock cliff rises to the same height, with a stair straight up it; the shore between rises with it.
// a Pacific madrone: a twisting red-orange trunk that leans out from the rock, forking into branches with dark green clumps
// lean: which way it leans (world angle, 0 = east), h: its height
function makeMadrone(lean, h, seed = 0) {
  const g = new THREE.Group(), bark = toon('#b5532a'), leaf = [toon('#3f7d3c'), toon('#4f9a45'), toon('#356b33')];
  const up = new V3(0, 1, 0), seg = (a, b, r0, r1) => { const d = new V3().subVectors(b, a), m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, d.length(), 7), bark);
    m.position.copy(a).addScaledVector(d, 0.5); m.quaternion.setFromUnitVectors(up, d.normalize()); m.castShadow = true; g.add(m); };
  const out = new V3(Math.cos(lean), 0, Math.sin(lean)), side = new V3(-out.z, 0, out.x);
  // the trunk: out from the rock, then curving up, with a twist
  const pts = [new V3(0, 0, 0)]; for (let k = 1; k <= 4; k++) { const u = k / 4; pts.push(new V3().addScaledVector(out, h * (0.34 * u - 0.08 * u * u)).addScaledVector(side, Math.sin(u * 3 + seed) * h * 0.06).setY(h * 0.62 * u)); }
  for (let k = 0; k < 4; k++) seg(pts[k], pts[k + 1], 0.9 - k * 0.16, 0.74 - k * 0.16);
  // branches from the top of the trunk, each ending in a clump of leaves
  const topP = pts[4];
  for (let b = 0; b < 4; b++) { const a = lean + (b - 1.5) * 0.9 + seed, dir = new V3(Math.cos(a), 0.9 + (b % 2) * 0.4, Math.sin(a)).normalize(), end = topP.clone().addScaledVector(dir, h * (0.22 + (b % 3) * 0.05));
    seg(topP, end, 0.36, 0.2);
    for (let c = 0; c < 3; c++) { const m = new THREE.Mesh(new THREE.SphereGeometry(h * (0.1 + c * 0.02), 9, 7), leaf[(b + c) % 3]); m.position.copy(end).add(new V3((c - 1) * h * 0.07, c * h * 0.04, ((b + c) % 2 - 0.5) * h * 0.08)); m.scale.y = 0.72; m.castShadow = true; g.add(m); } }
  return g;
}
function woldSpot() { return WOLD.knoll; }
function buildWoldCabin() {
  const [dx0, dz0] = WOLD.dock, [x, z] = WOLD.knoll, base = WOLD.base, top = WOLD.top; // the knoll lifts the cabin 8 units
  // the knoll: grass on top, grey rock falling away
  const knoll = new THREE.Group(); knoll.position.set(x, base - 0.5, z); scene.add(knoll);
  mesh(new THREE.CylinderGeometry(16, 20, 8.5, 16), '#8a8578', 0, 4.25, 0, knoll);
  mesh(new THREE.CylinderGeometry(16.3, 16.3, 0.6, 16), '#4f9a45', 0, 8.6, 0, knoll);
  for (let k = 0; k < 6; k++) { const a = k * 1.05 + 0.3, r = mesh(new THREE.DodecahedronGeometry(2 + (k % 3) * 0.8), '#7d776c', Math.cos(a) * 18.5, 1.5 + (k % 2), Math.sin(a) * 18.5, knoll); r.scale.y = 0.7; } // boulders
  // madrones growing out of the rock face, leaning out over the water
  for (const [a, h, sd] of [[2.1, 22, 0.3], [0.9, 18, 1.7], [3.4, 20, 2.9]]) { const t = makeMadrone(a, h, sd); t.position.set(x + Math.cos(a) * 17.5, base + 5.5, z + Math.sin(a) * 17.5); scene.add(t); }
  // the cabin, turned 30 degrees so its windows (and the deck) look south-west over the water
  const FACE = -Math.PI / 6, g = new THREE.Group(); g.position.set(x, top, z); g.rotation.y = FACE; scene.add(g);
  const planks = canvasTex(64, 64, (c, w, h) => { c.fillStyle = '#7a4a2a'; c.fillRect(0, 0, w, h); for (let y = 0; y < h; y += 8) { c.fillStyle = '#5e381f'; c.fillRect(0, y + 6, w, 2); c.fillStyle = '#8c5a34'; c.fillRect(0, y + 1, w, 1); } }, true); planks.repeat.set(3, 3);
  const wall = new THREE.MeshToonMaterial({ map: planks, gradientMap: GRAD });
  // ground floor: a full-depth west end, and a skinnier east end set back behind it
  mesh(new THREE.BoxGeometry(8, 5, 10), wall, -4, 2.5, 0, g);
  mesh(new THREE.BoxGeometry(8, 4.6, 7), wall, 4, 2.3, -1.5, g);
  // each part of the ground floor has its own peaked roof (the east one a little lower)...
  mesh(ROOF_GEO, '#3b2a1e', -4, 5, 0, g).scale.set(9, 2.8, 11.4);
  mesh(ROOF_GEO, '#3b2a1e', 4.2, 4.6, -1.5, g).scale.set(8.6, 2.2, 8.2);
  // ...and a smaller upper floor rises through it over the west end, its roof slope showing below the window
  mesh(new THREE.BoxGeometry(6.4, 5.8, 5.4), wall, -4, 7.9, 0, g);
  mesh(ROOF_GEO, '#3b2a1e', -4, 10.8, 0, g).scale.set(7.6, 2.8, 6.8);
  const glass = new THREE.MeshBasicMaterial({ color: '#ffd76a' });
  for (const wx of [-5.5, -2]) mesh(new THREE.BoxGeometry(2.2, 2.4, 0.2), glass, wx, 2.5, 5.05, g, false);   // ground-floor windows: two on the west front...
  for (const wx of [2, 5.5]) mesh(new THREE.BoxGeometry(2.2, 2.4, 0.2), glass, wx, 2.4, 2.05, g, false);     // ...and two set back on the east
  mesh(new THREE.BoxGeometry(2.6, 2.2, 0.2), glass, -4, 8.9, 2.75, g, false);        // the one upstairs window, looking out on the water
  mesh(new THREE.BoxGeometry(0.2, 3.4, 1.8), '#b8412c', -8.05, 1.7, 1.5, g);          // door onto the deck
  mesh(new THREE.BoxGeometry(1.8, 10, 1.8), '#8d877c', 5.5, 5, -3, g);                 // stone chimney through the lower roof
  // the deck: wraps the south and west sides and hangs out over the slope toward the water (south-west)
  const deckC = '#a47a4a', deck = new THREE.Group(); deck.position.set(x, top, z); deck.rotation.y = FACE; scene.add(deck);
  mesh(new THREE.BoxGeometry(25, 0.5, 9), deckC, -4.5, 0.25, 9.5, deck);                            // south
  mesh(new THREE.BoxGeometry(8, 0.5, 3.2), deckC, 4, 0.25, 3.5, deck);                               // filling in up to the set-back east wall
  mesh(new THREE.BoxGeometry(9, 0.5, 20), deckC, -12.5, 0.25, 0, deck);                             // west
  for (const [px, pz] of [[-16.5, 13.5], [-7, 13.5], [7.5, 13.5], [-16.5, -9.5], [-16.5, 3]]) mesh(new THREE.CylinderGeometry(0.35, 0.35, 12, 6), '#6b4423', px, -5.8, pz, deck); // stilts down the knoll
  for (const [cx, cz, L, rot] of [[-4.5, 13.8, 25, 0], [-16.8, 2, 23, Math.PI / 2]]) { const rail = mesh(new THREE.BoxGeometry(L, 0.25, 0.25), '#6b4423', cx, 2.2, cz, deck); rail.rotation.y = rot;
    for (let k = -L / 2; k <= L / 2; k += 2.5) mesh(new THREE.BoxGeometry(0.2, 2, 0.2), '#6b4423', cx + (rot ? 0 : k), 1.2, cz + (rot ? k : 0), deck); } // railings
  for (const [cx, cz, s] of [[-13, 8, 1], [-14.5, 5.5, 0.8]]) { const c = makeChest(); c.position.set(cx, 0.5, cz); c.scale.setScalar(s * 1.2); c.userData.lid.rotation.x = -1.6; deck.add(c); } // the stash
  for (const [bx, bz] of [[-9, 11.5], [-7.5, 12]]) mesh(new THREE.CylinderGeometry(0.8, 0.8, 1.8, 10), '#7a5a3a', bx, 1.4, bz, deck);
  // the Jolly Roger at the deck's corner, and the crew's pennant under it (online)
  mesh(new THREE.CylinderGeometry(0.18, 0.18, 14, 6), '#5a3a1e', -16, 7, 13, deck);
  const jr = new THREE.Mesh(new THREE.PlaneGeometry(4, 2.5), new THREE.MeshBasicMaterial({ map: canvasTex(128, 80, JOLLY_ROGER), side: THREE.DoubleSide })); jr.position.set(-14, 12.6, 13); deck.add(jr); ANIM.push(t => { jr.rotation.y = Math.sin(t * 2.6) * 0.3; });
  const pen = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.2), new THREE.MeshBasicMaterial({ color: '#c8352b', side: THREE.DoubleSide })); pen.position.set(-14.2, 10.4, 13); pen.visible = false; deck.add(pen); ANIM.push(t => { pen.rotation.y = Math.sin(t * 3.1) * 0.35; });
  // the dock and the stair up the bank. Both follow the ground as it now lies (the shore here rises to the cabin's height),
  // so nothing sinks into it: the dock starts right at the waterline, and every tread sits just above the slope beneath it
  const dy = facingSea(dx0, dz0), F = [Math.sin(dy), Math.cos(dy)], R = [Math.cos(dy), -Math.sin(dy)], at = t => [dx0 + F[0] * t, dz0 + F[1] * t]; // t: along the dock line, + out to sea
  const DECK = 0.8; // the dock's walking height above the sea
  let tw = 0; while (tw < 60 && heightAt(...at(tw)) > DECK - 0.1) tw += 0.5; // the waterline, where the dock begins
  const dl = clamp(sdAt(dx0, dz0) + 16, 20, 40), dock = new THREE.Group(); dock.position.set(...[at(tw)[0], 0, at(tw)[1]]); dock.rotation.y = dy; scene.add(dock);
  mesh(new THREE.BoxGeometry(3.2, 0.6, dl), deckC, 0, DECK - 0.3, dl / 2 - 0.5, dock, false);
  for (let k = 4; k < dl; k += 6) for (const sd of [-1.4, 1.4]) mesh(new THREE.CylinderGeometry(0.22, 0.22, 3, 6), '#6b4423', sd, DECK - 1.6, k, dock); // pilings
  // the stair: from the dock's land end up the bank until the ground levels off at the top
  const treads = []; for (let t = tw; t > tw - 40; t -= 0.9) { const [x1, z1] = at(t), [x2, z2] = at(t - 0.9), y = Math.max(heightAt(x1, z1), heightAt(x2, z2), DECK - 0.3) + 0.25; treads.push([t - 0.45, y]); if (heightAt(x2, z2) > top - 0.6) break; }
  for (const [t, y] of treads) { const [tx, tz] = at(t), m = mesh(new THREE.BoxGeometry(2.6, 0.3, 1.0), deckC, tx, y, tz); m.rotation.y = dy; }
  for (let i = 0; i < treads.length; i += 3) for (const sd of [-1.4, 1.4]) { const [t, y] = treads[i], [tx, tz] = at(t); mesh(new THREE.BoxGeometry(0.18, 2, 0.18), '#6b4423', tx + R[0] * sd, y + 1, tz + R[1] * sd); } // handrail posts
  for (let i = 0; i + 3 < treads.length; i += 3) for (const sd of [-1.4, 1.4]) { // handrails between the posts
    const [t1, y1] = treads[i], [t2, y2] = treads[i + 3], [ax, az] = at(t1), [bx, bz] = at(t2), len = Math.hypot(bx - ax, bz - az, y2 - y1);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, len), toon('#6b4423')); rail.position.set((ax + bx) / 2 + R[0] * sd, (y1 + y2) / 2 + 2, (az + bz) / 2 + R[1] * sd);
    rail.lookAt(bx + R[0] * sd, y2 + 2, bz + R[1] * sd); scene.add(rail); }
  { const [t] = treads[treads.length - 1], [mx, mz] = at(t - 2), mad = makeMadrone(dy + Math.PI + 0.9, 17, 4.1); mad.position.set(mx + R[0] * -5, heightAt(mx + R[0] * -5, mz + R[1] * -5) - 0.5, mz + R[1] * -5); scene.add(mad); } // a madrone by the top of the stair
  const w = nearestOpen(dx0, dz0);
  return (HIDEOUTS[0] = { i: 0, name: HOMES[0].name, x: dx0, z: dz0, lx: x, lz: z, ly: top + 16, wx: w ? cellPos(...w)[0] : dx0, wz: w ? cellPos(...w)[1] : dz0, g, pen, label: null });
}
function buildCabin(i = 0) {
  if (HIDEOUTS[i]) return HIDEOUTS[i];
  if (i === 0) return buildWoldCabin();
  const [x, z] = findHomeSpot(i), yaw = facingSea(x, z), h0 = heightAt(x, z), g = new THREE.Group(); g.position.set(x, h0 - 0.4, z); g.rotation.y = yaw; scene.add(g);
  const logs = canvasTex(64, 64, (c, w, h) => { c.fillStyle = '#8a5a32'; c.fillRect(0, 0, w, h); for (let y = 0; y < h; y += 8) { c.fillStyle = '#6b4423'; c.fillRect(0, y + 6, w, 2); c.fillStyle = '#a06a3c'; c.fillRect(0, y + 1, w, 2); } }, true); logs.repeat.set(2, 2);
  mesh(new THREE.BoxGeometry(11, 5.5, 8), new THREE.MeshToonMaterial({ map: logs, gradientMap: GRAD }), 0, 2.75, 0, g);
  const roof = mesh(ROOF_GEO, '#4a3a2a', 0, 5.5, 0, g); roof.scale.set(13, 3.6, 10);
  mesh(new THREE.BoxGeometry(1.8, 9, 1.8), '#8d877c', -4.2, 5, -2.5, g); // stone chimney
  mesh(new THREE.BoxGeometry(1.6, 3, 0.2), '#b8412c', 1.5, 1.5, 4.05, g); // red door
  for (const wx of [-2.8, 4.2]) mesh(new THREE.BoxGeometry(1.6, 1.4, 0.2), new THREE.MeshBasicMaterial({ color: '#ffd76a' }), wx, 3, 4.05, g, false);
  mesh(new THREE.BoxGeometry(13, 0.4, 3.4), '#a47a4a', 0, 0.5, 5.6, g); // porch
  const pole = mesh(new THREE.CylinderGeometry(0.18, 0.18, 14, 6), '#5a3a1e', 7.2, 7, 3, g);
  const jr = new THREE.Mesh(new THREE.PlaneGeometry(4, 2.5), new THREE.MeshBasicMaterial({ map: canvasTex(128, 80, JOLLY_ROGER), side: THREE.DoubleSide })); jr.position.set(9.2, 12.6, 3); g.add(jr); ANIM.push(t => { jr.rotation.y = Math.sin(t * 2.6) * 0.3; });
  // a pennant in the crew's sail colour under the Jolly Roger (online)
  const pen = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.2), new THREE.MeshBasicMaterial({ color: '#c8352b', side: THREE.DoubleSide })); pen.position.set(9, 10.4, 3); pen.visible = false; g.add(pen); ANIM.push(t => { pen.rotation.y = Math.sin(t * 3.1 + i) * 0.35; });
  for (const [cx, cz, s] of [[-7, 5, 1], [-8.5, 3, 0.8]]) { const c = makeChest(); c.position.set(cx, 0.2, cz); c.scale.setScalar(s * 1.2); c.userData.lid.rotation.x = -1.6; g.add(c); } // the stash
  for (const [bx, bz] of [[-6, 7.5], [-4.8, 8.2]]) mesh(new THREE.CylinderGeometry(0.8, 0.8, 1.8, 10), '#7a5a3a', bx, 0.9, bz, g);
  // a dock running out into the bay
  const dl = clamp(sdAt(x, z) + 16, 20, 40); mesh(new THREE.BoxGeometry(3.2, 0.6, dl), '#a47a4a', 0, 1.2 - h0, 7 + dl / 2, g, false); // deck sits just above the water
  const w = nearestOpen(x, z);
  return (HIDEOUTS[i] = { i, name: HOMES[i].name, x, z, wx: w ? cellPos(...w)[0] : x, wz: w ? cellPos(...w)[1] : z, g, pen, label: null });
}

// cannons: a broadside of three balls, rippling down the side; it lays onto the nearest ship in range
const BALLS = [], SHOTS = [], ballGeo = new THREE.SphereGeometry(0.55, 8, 6), ballMat = toon('#1a1a1a');
const reload = { [PORT]: 0, [STARBOARD]: 0 }; // each side's guns reload on their own (online, this mirrors the server's)
let shake = 0; const shakeOff = new V3();
function fireBroadside(sd) {
  if (reload[sd] > 0 || !SHIP.g || SHIP.sinking || !MODE) return;
  if (NET) { NET.room.send('fire', { side: sd }); reload[sd] = RELOAD; return; } // online the server fires the guns
  const vh = layGuns(SHIP, sd, [...ENEMIES.filter(e => e.g && !e.sinking && !e.dead), ...SOLO_MONS.filter(m => !m.slain && m.y > -3)]); // lay the guns for the nearest ship (or monster) on this side
  GUNS.forEach((lx, k) => SHOTS.push({ t: k * GUN_STAGGER, from: SHIP, sd, lx, vh, spread: 6 }));
  reload[sd] = RELOAD;
}
// the flash, smoke and kick of one gun going off, on any ship
function gunFx(s, sd, b) {
  const R = [Math.sin(s.yaw), Math.cos(s.yaw)];
  fx.flash(b.x + R[0] * sd * 1.5, b.y, b.z + R[1] * sd * 1.5, 1.8);
  fx.smoke(b.x + R[0] * sd * 2.5, b.y, b.z + R[1] * sd * 2.5, 6, null, 1.7, [R[0] * sd * 9, R[1] * sd * 9]);
  // every gun kicks: the ship heels away from the broadside and rocks back
  if (s === SHIP) { s.rollV -= sd * 0.32; shake = Math.min(1.4, shake + 0.55); } else s.list -= sd * 0.05;
}
// single-player: one gun going off, on any ship
function shoot({ from: s, sd, lx, vh, spread }) {
  if (!s.g || s.sinking || s.dead) return;
  const b = gunBall(s, sd, lx, vh, spread, R01);
  const m = new THREE.Mesh(ballGeo, ballMat); m.position.set(b.x, b.y, b.z); m.castShadow = true; scene.add(m);
  BALLS.push({ m, from: s, vx: b.vx, vy: b.vy, vz: b.vz });
  gunFx(s, sd, b); if (s === SHIP) s.speed *= 0.93;
  s.driftV = (s.driftV || 0) - sd * 2.6; // ...and is shoved sideways
}
function updateBalls(dt) {
  for (let i = SHOTS.length - 1; i >= 0; i--) { SHOTS[i].t -= dt; if (SHOTS[i].t <= 0) { shoot(SHOTS[i]); SHOTS.splice(i, 1); } }
  for (let i = BALLS.length - 1; i >= 0; i--) {
    const b = BALLS[i], p = b.m.position; b.vy -= BALL_G * dt; p.x += b.vx * dt; p.y += b.vy * dt; p.z += b.vz * dt;
    let hit = null, beast = null; // any ship but the one that fired
    for (const e of [SHIP, ...ENEMIES]) { if (e === b.from || !e.g || e.dead || e.sinking) continue; if (inHull(e, p.x, p.y, p.z)) { hit = e; break; } }
    const ground = heightAt(p.x, p.z);
    if (hit === SHIP) { damagePlayer(1, p.x, p.y, p.z); if (!SHIP.sinking) toast(`We're hit! Hull ${SHIP.hp}/${SHIP.maxHp}`, 1200); shake = Math.min(1.4, shake + 0.9); }
    else if (hit) { damageShip(hit, p.x, p.y, p.z, 1, b.from !== SHIP); if (b.from === SHIP) hit.provoked.add(SHIP.id); }
    else if ((beast = SOLO_MONS.find(m => monsterHit(m, p.x, p.y, p.z)))) { monsterFx(beast, p.x, p.y, p.z, b.from === SHIP); if (hurtMonster(beast, 1)) { monsterNews({ id: beast.id, kind: beast.kind, event: 'slain', by: b.from.id }); if (beast.kind === 'kraken') clearStorm(soloStorm); } }
    else if (p.y < Math.max(ground, 0)) { if (ground > 0.3) fx.dirt(p.x, ground, p.z); else fx.splash(p.x, p.z); }
    else continue;
    if (b.from !== SHIP) soloSplash(p.x, p.z);
    scene.remove(b.m); BALLS.splice(i, 1);
  }
}

// enemy ships: Royal Navy and merchantmen on patrol; hits start fires, tear sails and make them list until they founder
const ENEMIES = [];
function spawnEnemy(e) {
  const spot = openSpot([SHIP], 450, 1600, R01); if (!spot) { e.respawn = 3; return; }
  if (e.g) scene.remove(e.g);
  e.g = makeShip(e.kind); if (e.kind === 'merchant') e.g.scale.setScalar(1.35); scene.add(e.g);
  Object.assign(e, newNpc(e.kind, spot[0], spot[1], R01), { y: 0, dead: false, list: 0, listT: 0, listDir: 1, pitch: 0, fires: [], fireT: 0, bumpCD: 0 });
}
// visible battle damage on any ship, yours included: splinters, a darker hull, a torn sail, a list toward the hit, a fire
function scar(e, x, y, z) {
  fx.hit(x, y, z);
  const u = e.g.userData; u.hullMat.color.multiplyScalar(0.84);
  const up = u.sails.filter(s => s.visible); if (up.length && R01() < 0.75) { const s = up[Math.floor(R01() * up.length)]; if (R01() < 0.5) s.visible = false; else { s.scale.y = 0.5; s.position.y -= 1.2; } s.material.color.multiplyScalar(0.9); }
  const side = Math.sign((x - e.x) * Math.sin(e.yaw) + (z - e.z) * Math.cos(e.yaw)) || 1; e.listDir = side; e.listT = clamp(e.listT + 0.05 * side, -0.25, 0.25);
  e.g.updateMatrixWorld(); const lp = u.body.worldToLocal(new V3(x, Math.max(y, 2.5), z)); lp.z = clamp(lp.z, -2, 2); lp.y = clamp(lp.y, 1.5, 3); e.fires.push(lp);
}
function damageShip(e, x, y, z, n = 1, quiet = false) {
  if (e.sinking || e.dead) return;
  for (let k = 0; k < n && e.hp > 0; k++) { e.hp--; scar(e, x, y, z); }
  if (e.hp <= 0) { e.sinking = true; e.path = []; toast(e.kind === 'navy' ? "She's going down! Grab the gold!" : 'Merchantman sinking! Grab the gold!', 2400);
    for (let k = 0; k < 10; k++) addCoin(e.x + (R01() - 0.5) * 40, e.z + (R01() - 0.5) * 40); }
  else if (!quiet) toast(['Direct hit!', 'Ka-BOOM!', 'Hull breached!', 'Right in the timbers!'][Math.floor(R01() * 4)], 1100);
}
// your ship: 6 hits of hull; at zero it founders and spills the hold as coins; you escape in the dinghy
function damagePlayer(n, x, y, z) {
  const s = SHIP; if (s.sinking || n <= 0) return;
  for (let k = 0; k < n && s.hp > 0; k++) { s.hp--; scar(s, x, y, z); }
  hud(); if (s.hp <= 0) sinkPlayer();
}
function sinkPlayer() {
  const s = SHIP; s.sinking = true; s.sinkT = 0; s.path = []; s.goal = null; marker.visible = false; drawCourse();
  const spilled = cargo; spillCoins(s.x, s.z, cargo); cargo = 0; hud();
  if (CAP.mode === 'ship') launchDinghy(CAP, s); // abandon ship!
  toast((spilled ? 'We\'re sinking and the loot spilled! ' : "We're sinking! ") + 'Into the dinghy: row home for a new ship.', 3600);
}
function freshShip() { if (SHIP.g) scene.remove(SHIP.g); SHIP.g = makeShip(); scene.add(SHIP.g); Object.assign(SHIP, { hp: SHIP.maxHp, list: 0, listT: 0, fires: [], fireT: 0 }); }
function respawnPlayer() {
  freshShip(); const s = SHIP; s.g.visible = true;
  Object.assign(s, { sinking: false, sinkT: 0, y: 0, speed: 0, turn: 0, rollA: 0, rollV: 0, driftV: 0, path: [], goal: null, anchored: true, yaw: -Math.PI / 2 });
  [s.x, s.z] = CABIN ? [CABIN.wx, CABIN.wz] : [s.x, s.z]; s.yaw = seawardYaw(s.x, s.z); btn('bAnchor').classList.add('on'); hud();
}
// smoke and flame from wherever a ship was hurt
function emitFires(e, dt) {
  if (!e.fires.length || (e.fireT -= dt) > 0 || e.y < -6) return;
  e.fireT = 0.18; e.g.updateMatrixWorld(); _fw.copy(e.fires[Math.floor(R01() * e.fires.length)]); e.g.userData.body.localToWorld(_fw);
  part(PGEO.sph, R01() < 0.5 ? '#ff7a1e' : '#ffd23a', _fw.x, _fw.y + 0.5, _fw.z, { vy: 3, life: 0.35, s0: 0.9, s1: 0.3 });
  part(PGEO.sph, R01() < 0.5 ? '#4a4a4a' : '#6a6a6a', _fw.x, _fw.y + 1, _fw.z, { vy: 4, vx: 1, life: 2.6, s0: 1.2, s1: 4.2, lit: true, fadePow: 3 });
}

// collisions (single-player): the shared rules separate and bounce hulls; only collisions involving your ship do damage
function collideShips(dt) {
  if (NET) return; // online the server resolves every collision
  const ships = [...(SHIP.sinking || !SHIP.g ? [] : [SHIP]), ...ENEMIES.filter(e => e.g && !e.dead && !e.sinking)];
  for (const e of ENEMIES) e.bumpCD = Math.max(0, (e.bumpCD || 0) - dt);
  for (let i = 0; i < ships.length; i++) for (let j = i + 1; j < ships.length; j++) {
    const P = ships[i], Q = ships[j], hit = collide(P, Q); if (!hit) continue;
    if (P === SHIP) SHIP.rollV += hit.joltP * 0.04; else if (Q === SHIP) SHIP.rollV += hit.joltQ * 0.04; // a jolt you can see
    const other = P === SHIP ? Q : Q === SHIP ? P : null; if (!other || other.bumpCD > 0 || !hit.hard) continue;
    other.bumpCD = 1.2; other.provoked.add(SHIP.id); shake = Math.min(1.4, shake + 0.8);
    const hurt = (e, n) => e === SHIP ? damagePlayer(n, hit.cx, 2, hit.cz) : damageShip(e, hit.cx, 2, hit.cz, n, true);
    hurt(P, hit.dmgP); hurt(Q, hit.dmgQ);
    if (hit.kind === 'ram') { const ram = hit.rammer === 'P' ? P : Q, heavy = Math.max(hit.dmgP, hit.dmgQ);
      if (!other.sinking) toast(ram === SHIP ? `Rammed 'em amidships! (${heavy} hits)` : `We've been rammed! (${heavy} hits)`, 1600); }
    else if (!other.sinking && !SHIP.sinking) toast('Scraped hulls! Both ships damaged', 1400);
  }
}
const _fw = new V3();
// badly holed (half the hull or less): she lists toward her wounds and wallows. On a 6-hit hull: 8° at 3, 15° at 2, 24° at 1
const WOUND_LIST = [0.14, 0.26, 0.42], WOUND_WALLOW = [0.04, 0.06, 0.09];
const woundList = (e, hp, max) => { if (!max || hp > max / 2 || hp <= 0) return 0; const k = Math.min(2, Math.floor(max / 2) - hp);
  return (e.listDir || 1) * WOUND_LIST[k] + Math.sin(time * 0.7 + (e.x || 0) * 0.01) * WOUND_WALLOW[k]; };
const engageLine = (kind, provoked) => kind === 'navy' ? (provoked ? 'The frigate comes about to return fire!' : 'Spotted! A Navy frigate is coming about!') : 'The merchantman is firing back!';
function updateEnemies(dt) {
  for (const e of ENEMIES) {
    if (e.dead) { e.respawn -= dt; if (e.respawn <= 0) spawnEnemy(e); continue; }
    if (e.sinking) { e.sinkT += dt; e.speed *= 1 - dt * 0.6; e.listT = lerp(e.listT, e.listDir * 1.2, dt * 0.25); e.pitch = lerp(e.pitch, -0.3, dt * 0.25); e.y -= dt * (0.3 + e.sinkT * 0.09);
      if (e.y < -32) { scene.remove(e.g); e.g = null; e.dead = true; e.respawn = 25; continue; } }
    else stepNpc(e, dt, SHIP.sinking || !SHIP.g ? [] : [SHIP], {
      rnd: R01,
      fire: (e, sd, vh) => GUNS.forEach((gx, k) => SHOTS.push({ t: k * 0.16, from: e, sd, lx: gx, vh, spread: 18 })),
      engage: (e, foe, provoked) => toast(engageLine(e.kind, provoked), 2200),
    }, windAt(e.x, e.z, wxTime(), curStorm()));
    if (e.sinking) moveNpc(e, dt, null);
    e.list = lerp(e.list, e.listT + (e.sinking ? 0 : woundList(e, e.hp, e.maxHp)), Math.min(1, dt * 1.5));
    const b = e.g.userData.body; e.g.position.set(e.x, 0.35 + e.y + Math.sin(time * 1.2 + e.x) * 0.22, e.z); e.g.rotation.y = e.yaw;
    b.rotation.x = e.list + Math.sin(time * 0.9 + e.z) * 0.04; b.rotation.z = e.pitch; e.g.userData.flag.rotation.y = Math.sin(time * 3 + e.x) * 0.2;
    emitFires(e, dt); // fires and smoke where the shots landed
  }
}

// floating coins (from sunken ships) and treasure chests on the beaches
const COINS = [], coinMat = new THREE.MeshToonMaterial({ color: '#f5c518', gradientMap: GRAD, emissive: '#6a4a00', emissiveIntensity: 0.4 });
function addCoin(x, z) { if (!sailable(x, z, 2)) return; const m = new THREE.Mesh(PGEO.coin, coinMat); m.scale.setScalar(1.3); m.rotation.x = Math.PI / 2; m.position.set(x, 0.9, z); m.castShadow = true; scene.add(m); COINS.push({ m, x, z, ph: R01() * 6 }); }
function makeChest() {
  const g = new THREE.Group(), wood = '#7a4a2a', band = '#f5c518';
  mesh(new THREE.BoxGeometry(2.4, 1.3, 1.6), wood, 0, 0.65, 0, g);
  mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.2, 12), band, 0, 1.2, 0, g).scale.set(1.5, 0.2, 1); // gold heaped inside
  for (const x of [-0.9, 0.9]) mesh(new THREE.BoxGeometry(0.2, 1.34, 1.64), band, x, 0.65, 0, g);
  const lid = new THREE.Group(); lid.position.set(0, 1.3, -0.8); g.add(lid);
  const top = mesh(new THREE.CylinderGeometry(0.8, 0.8, 2.4, 14, 1, false, 0, Math.PI), wood, 0, 0, 0.8, lid); top.rotation.z = Math.PI / 2;
  for (const x of [-0.9, 0.9]) { const b = mesh(new THREE.CylinderGeometry(0.83, 0.83, 0.2, 14, 1, false, 0, Math.PI), band, x, 0, 0.8, lid); b.rotation.z = Math.PI / 2; }
  mesh(new THREE.BoxGeometry(0.35, 0.45, 0.12), band, 0, 0, 1.62, lid);
  g.userData.lid = lid; g.scale.setScalar(1.6); return setShadows(g);
}
function updateLoot(dt) {
  for (let i = COINS.length - 1; i >= 0; i--) { const c = COINS[i]; c.m.position.y = 0.9 + Math.sin(time * 2 + c.ph) * 0.25; c.m.rotation.z = time * 2 + c.ph;
    if (NET) continue; // online the server hands out the coins
    const byShip = CAP.mode === 'ship' && !SHIP.sinking && Math.hypot(SHIP.x - c.x, SHIP.z - c.z) < 18, byBoat = CAP.mode === 'dinghy' && Math.hypot(CAP.x - c.x, CAP.z - c.z) < 12;
    if (byShip || byBoat) { if (byShip) cargo += COIN_GOLD; else CAP.carry += COIN_GOLD; fx.gold(c.x, 1.5, c.z, 5); scene.remove(c.m); COINS.splice(i, 1); hud(); } }
  if (NET || !CABIN) return;
  // the hideout patches up a damaged ship, and loot only counts once it's stashed there
  const home = Math.hypot(SHIP.x - CABIN.x, SHIP.z - CABIN.z) < HOME_RADIUS && !SHIP.sinking;
  if (home && SHIP.hp < SHIP.maxHp) { freshShip(); hud(); toast('Ship repaired at Wold Cabin!', 1800); }
  if (home && cargo > 0 && CAP.mode === 'ship') { gold += cargo; fx.gold(CABIN.x, heightAt(CABIN.x, CABIN.z) + 4, CABIN.z, 24); toast(`Stashed ${cargo} gold at Wold Cabin! ${gold} in the stash.`, 3200); cargo = 0; hud(); }
}

// ============================================================ labels
const LABELS = [], LABEL_SPRITES = [];
function labelTexture(text, style) {
  const st = { place: ['#f6e7c1', '#1a1410'], water: ['#d4f1ff', '#0b4f7a'], island: ['#b9e28a', '#1f4a1a'], big: ['#f2c14e', '#1a1410'], home: ['#c8352b', '#ffffff'] }[style];
  const fs = 54, c = document.createElement('canvas'), g = c.getContext('2d'), font = style === 'big' || style === 'island' || style === 'home' ?`${fs + 6}px 'Pirata One', Bangers, serif` : `${fs}px Bangers, Impact, sans-serif`;
  g.font = font; const tw = g.measureText(text).width, pad = 22, w = Math.ceil(tw + pad * 2 + 10), h = fs + 34; c.width = w; c.height = h + 10;
  g.fillStyle = '#1a1410'; g.beginPath(); g.roundRect(8, 10, w - 10, h - 4, 12); g.fill();
  g.fillStyle = st[0]; g.strokeStyle = '#1a1410'; g.lineWidth = 5; g.beginPath(); g.roundRect(3, 3, w - 12, h - 6, 12); g.fill(); g.stroke();
  g.font = font; g.fillStyle = st[1]; g.textBaseline = 'middle'; g.fillText(text, pad, h / 2 + 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return { t, aspect: c.width / c.height };
}
function buildLabels() {
  const L = (text, px, py, style, lift = 16) => { const [x, z] = P([px, py]); LABELS.push({ text, x, z, y: Math.max(0, heightAt(x, z)) + lift, style }); };
  L('Haro Strait', 170, 1500, 'water'); L('Henry Island', 150, 880, 'island', 40); L('Mosquito Pass', 475, 960, 'water'); L('Nelson Bay', 295, 760, 'water');
  L('Open Bay', 270, 1010, 'water'); L('Roche Harbor', 650, 520, 'big', 26); L('Westcott Bay', 740, 845, 'water'); L('Garrison Bay', 755, 1030, 'water');
  L('English Camp', 765, 1140, 'place', 24); L('Delacombe Point', 560, 1030, 'place', 20); L('Mitchell Bay', 815, 1370, 'water'); L('Snug Harbor', 690, 1478, 'place', 18);
  L('Pearl Island', 505, 440, 'island', 26); L('San Juan Island', 900, 1650, 'island', 60);
  for (const Lb of LABELS) addLabel(Lb.text, Lb.x, Lb.y, Lb.z, Lb.style);
}
function addLabel(text, x, y, z, style) {
  const { t, aspect } = labelTexture(text, style);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true }));
  const s = style === 'water' || style === 'place' ? 0.042 : 0.05; sp.scale.set(s * aspect, s, 1); sp.position.set(x, y, z); sp.center.set(0.5, 0);
  labelScene.add(sp); const L = { sp, aspect, base: s, pri: style === 'home' ? -1 : style === 'big' ? 0 : style === 'island' ? 1 : 2, text, x, z }; LABEL_SPRITES.push(L); return L;
}
function dropLabel(L) { if (!L) return; labelScene.remove(L.sp); L.sp.material.map.dispose(); L.sp.material.dispose(); const k = LABEL_SPRITES.indexOf(L); if (k >= 0) LABEL_SPRITES.splice(k, 1); }
function labelHome(h, text, style) { if (h.label && h.label.text === text && h.labelStyle === style) return; dropLabel(h.label); h.label = text ? addLabel(text, h.lx ?? h.x, h.ly ?? heightAt(h.x, h.z) + 22, h.lz ?? h.z, style) : null; h.labelStyle = style; }
const _lv = new V3(), _placed = [], _cand = [];
function declutterLabels() {
  _placed.length = 0; _cand.length = 0;
  const W = window.innerWidth, H = window.innerHeight, k = H / (2 * Math.tan(camera.fov * Math.PI / 360)), f = clamp(camera.aspect / 1.2, 0.55, 1);
  for (const L of LABEL_SPRITES) { L.sp.scale.set(L.base * f * L.aspect, L.base * f, 1); L.sp.visible = false;
    const d = camera.position.distanceTo(L.sp.position); if (d > 3200) continue; _lv.copy(L.sp.position).project(camera); if (_lv.z > 1 || Math.abs(_lv.x) > 1.2 || Math.abs(_lv.y) > 1.2) continue;
    _cand.push({ L, d, x: (_lv.x * 0.5 + 0.5) * W, y: (-_lv.y * 0.5 + 0.5) * H }); }
  _cand.sort((a, b) => a.L.pri - b.L.pri || a.d - b.d);
  for (const c of _cand) { const h = c.L.sp.scale.y * k, w = h * c.L.aspect, r = { x0: c.x - w / 2 - 4, x1: c.x + w / 2 + 4, y0: c.y - h - 3, y1: c.y + 3, L: c.L };
    if (_placed.some(p => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0)) continue; _placed.push(r); c.L.sp.visible = true; }
}
const labelAt = (x, y) => { for (let i = _placed.length - 1; i >= 0; i--) { const r = _placed[i]; if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return r.L; } return null; };

// ============================================================ post-processing (ink + halftone)
const rtColor = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: MOBILE ? 2 : 4 });
const rtNormal = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }); rtNormal.depthTexture = new THREE.DepthTexture(1, 1);
const normalMat = new THREE.MeshNormalMaterial();
const postMat = new THREE.ShaderMaterial({
  uniforms: { tColor: { value: rtColor.texture }, tNormal: { value: rtNormal.texture }, tDepth: { value: rtNormal.depthTexture }, resolution: { value: new THREE.Vector2() }, cameraNear: { value: camera.near }, cameraFar: { value: camera.far }, pr: { value: 1 } },
  depthTest: false, depthWrite: false,
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tColor; uniform sampler2D tNormal; uniform sampler2D tDepth; uniform vec2 resolution; uniform float cameraNear, cameraFar, pr; varying vec2 vUv;
    float linD(vec2 uv){ float z = texture2D(tDepth, uv).x * 2.0 - 1.0; return 2.0 * cameraNear * cameraFar / (cameraFar + cameraNear - z * (cameraFar - cameraNear)); }
    vec3 nrm(vec2 uv){ return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }
    void main(){
      vec4 col = texture2D(tColor, vUv); vec2 px = 1.0 / resolution, ox = vec2(px.x, 0.0), oy = vec2(0.0, px.y);
      float d = linD(vUv), w = 1.0 / d;
      float lap = abs(1.0/linD(vUv-ox) + 1.0/linD(vUv+ox) + 1.0/linD(vUv+oy) + 1.0/linD(vUv-oy) - 4.0*w) / w;
      float eD = smoothstep(0.035, 0.11, lap); vec3 n = nrm(vUv);
      float m = min(min(dot(n, nrm(vUv-ox)), dot(n, nrm(vUv+ox))), min(dot(n, nrm(vUv+oy)), dot(n, nrm(vUv-oy))));
      float eN = (1.0 - smoothstep(0.55, 0.85, m)) * (1.0 - smoothstep(500.0, 2200.0, d));
      float ink = max(eD, eN) * (1.0 - 0.6 * smoothstep(1800.0, 9000.0, d));
      vec3 c = col.rgb; float L = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = max(mix(vec3(L), c, 1.12), 0.0);
      float Ls = pow(max(L, 0.0), 1.0/2.2); vec2 g = mat2(0.7071, -0.7071, 0.7071, 0.7071) * (gl_FragCoord.xy / (4.5 * pr));
      float dd = length(fract(g) - 0.5), rad = clamp((0.52 - Ls) * 1.15, 0.0, 0.5), ht = 1.0 - smoothstep(rad - 0.07, rad + 0.07, dd);
      c *= 1.0 - 0.2 * ht * step(d, 12000.0); c = mix(c, vec3(0.018, 0.014, 0.03), ink);
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
    }` });
const postScene = new THREE.Scene(), postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
{ const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat); q.frustumCulled = false; postScene.add(q); }
function resize() {
  const w = window.innerWidth, h = window.innerHeight, pr = renderer.getPixelRatio(); renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  rtColor.setSize(Math.floor(w * pr), Math.floor(h * pr)); rtNormal.setSize(Math.floor(w * pr), Math.floor(h * pr));
  rtNormal.depthTexture.dispose(); rtNormal.depthTexture = new THREE.DepthTexture(Math.floor(w * pr), Math.floor(h * pr)); postMat.uniforms.tDepth.value = rtNormal.depthTexture;
  postMat.uniforms.resolution.value.set(Math.floor(w * pr), Math.floor(h * pr)); postMat.uniforms.pr.value = pr;
}
window.addEventListener('resize', resize); resize();

// ============================================================ interaction
const btn = id => document.getElementById(id);
let toastT = 0;
function toast(text, ms = 2600) { const el = btn('toast'); el.textContent = text; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), ms); }
const sailHome = () => { if (CABIN && MODE) goTo(CABIN.wx, CABIN.wz, NET ? 'your hideout' : 'Wold Cabin'); };
btn('bAnchor').onclick = () => { if (CAP.mode === 'ship') dropAnchor(); }; btn('bMap').onclick = () => { if (MODE) setMap(btn('mapWrap').hidden); };
btn('bAshore').onclick = () => { if (!MODE) return; if (CAP.mode === 'ship') goAshore(); else goBack(); };
// zoom button: Close → Medium → Far → Close (from wherever pinching left the camera, the next step out)
function cycleZoom() {
  const d = camera.position.distanceTo(controls.target), cur = zoomTo != null ? zoomLevel : (CAP.mode === 'dinghy' || CAP.mode === 'shore' ? ZOOMS_SHORE : ZOOMS).reduce((best, z, i, Z) => Math.abs(z.d - d) < Math.abs(Z[best].d - d) ? i : best, 0); // mid-glide: step on from where it's heading
  const Z = CAP.mode === 'dinghy' || CAP.mode === 'shore' ? ZOOMS_SHORE : ZOOMS;
  zoomLevel = (cur + 1) % ZOOMS.length; zoomTo = Z[zoomLevel].d;
  btn('zoomLbl').textContent = ZOOMS[zoomLevel].name; btn('bZoom').setAttribute('aria-label', `Camera zoom: ${ZOOMS[zoomLevel].name.toLowerCase()}. Tap to change`);
  btn('zoomPlus').style.display = zoomLevel === ZOOMS.length - 1 ? '' : 'none'; // the icon shows what the next tap does: − (out) until Far, then + (back in)
}
btn('bZoom').onclick = cycleZoom;
btn('optPinch').checked = pinchZoom;
btn('optPinch').onchange = e => { pinchZoom = e.target.checked; controls.enableZoom = pinchZoom; try { localStorage.setItem('klh-pinch', pinchZoom ? '1' : '0'); } catch (err) { } };
const portAction = () => CAP.mode === 'shore' ? doDig() : CAP.mode === 'ship' ? fireBroadside(PORT) : null;
const starAction = () => CAP.mode === 'shore' || CAP.mode === 'dinghy' ? doShoot() : CAP.mode === 'ship' ? fireBroadside(STARBOARD) : null;
btn('firePort').onclick = portAction; btn('fireStar').onclick = starAction;
// How to play opens only from the logo, and closes with its ✕ (or by tapping the logo again)
const setHelp = open => { btn('help').hidden = !open; btn('title').setAttribute('aria-expanded', String(open)); };
btn('title').onclick = () => setHelp(btn('help').hidden); btn('helpClose').onclick = () => setHelp(false);
window.addEventListener('keydown', e => { const k = e.key.toLowerCase(); if (e.repeat && k !== 'f') return; if (!MODE || e.target.tagName === 'INPUT') return;
  if (k === 'h') sailHome(); else if (k === 'z') cycleZoom(); else if (k === 'm') setMap(btn('mapWrap').hidden); else if (k === 'b') btn('bAshore').click();
  else if (k === 'q') portAction(); else if (k === 'e') starAction(); else if (k === 'escape') { setHelp(false); setMap(false); } else if (k === ' ') { e.preventDefault(); if (CAP.mode === 'ship') dropAnchor(); } });
// a tap (not a drag) on the water sets the course; on a place name it sails there
const ptrs = new Set(); let down = null;
canvas.addEventListener('pointerdown', e => { ptrs.add(e.pointerId); down = ptrs.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null; });
for (const t of ['pointercancel', 'pointerleave']) canvas.addEventListener(t, e => ptrs.delete(e.pointerId));
canvas.addEventListener('pointerup', e => {
  ptrs.delete(e.pointerId); const d = down; down = null;
  if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 450) return;
  const L = labelAt(e.clientX, e.clientY); if (L) { goTo(L.x, L.z, L.text); return; }
  const ndc = new THREE.Vector2(e.clientX / window.innerWidth * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1), ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, dir = ray.ray.direction; if (dir.y >= 0) return;
  for (let t = 0; t < 8000; t += 2) { const x = o.x + dir.x * t, y = o.y + dir.y * t, z = o.z + dir.z * t; if (y < Math.max(heightAt(x, z), 0)) { goTo(x, z); return; } }
});
canvas.addEventListener('pointermove', e => { if (e.buttons) return; canvas.style.cursor = labelAt(e.clientX, e.clientY) ? 'pointer' : 'crosshair'; });

// ============================================================ the captain: dinghy, walking ashore, digging, the pistol
// CAP is you off the ship. Single-player runs the shared rules on it; online it mirrors what the server says.
const CAP = newAvatar();
const shipOrNull = () => SHIP.sinking ? null : SHIP;
const SKIN = '#f1c49a';
// the captain: long black coat with gold buttons, cuffs in the crew's colour, a white shirt, dreadlocks and a goatee,
// a sabre on his hip, and a tricorn with its brim turned up on three sides. Forward is +x; his right hand is +z.
const COAT = '#1d1d26', HATC = '#2b1d14';
const TRICORN_BRIM = (() => { // a ring whose brim is folded up on three sides, one point to the front and two behind
  const g = new THREE.RingGeometry(0.55, 1.6, 42, 5); g.rotateX(-Math.PI / 2); const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z), th = Math.atan2(z, x), rf = (r - 0.55) / 1.05, c = Math.cos(3 * th);
    const k = 1 + 0.16 * c * rf; p.setX(i, x * k); p.setZ(i, z * k); p.setY(i, rf * rf * 1.05 * (0.5 - 0.5 * c)); }
  g.computeVertexNormals(); return g; })();
function makeCaptain(accent = '#9e2a2a') {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  const legs = [], arms = [];
  for (const s of [-1, 1]) { // legs swing from the hips when he walks
    const hip = new THREE.Group(); hip.position.set(0, 1.9, s * 0.4); body.add(hip); legs.push(hip);
    mesh(new THREE.CylinderGeometry(0.26, 0.23, 1.2, 8), '#4a3a2e', 0, -0.5, 0, hip);         // breeches
    mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 8), '#5a3a1e', 0, -1.35, 0, hip);          // boots
    mesh(new THREE.BoxGeometry(0.8, 0.3, 0.46), '#4a2e18', 0.15, -1.8, 0, hip);
  }
  mesh(new THREE.CylinderGeometry(0.7, 1.08, 2.7, 12), COAT, 0, 2.85, 0, body);                 // long coat, flaring to the knees
  mesh(new THREE.BoxGeometry(0.12, 1.2, 0.55), '#efe6d2', 0.7, 3.55, 0, body);                  // shirt showing down the front
  for (const z of [-0.36, 0.36]) for (let k = 0; k < 4; k++) mesh(new THREE.SphereGeometry(0.075, 6, 5), '#f5c518', 0.8, 2.55 + k * 0.38, z, body); // gold buttons
  mesh(new THREE.CylinderGeometry(0.84, 0.86, 0.34, 12), '#5a3a22', 0, 2.3, 0, body);            // belt...
  mesh(new THREE.BoxGeometry(0.2, 0.46, 0.56), '#d4a017', 0.84, 2.3, 0, body);                  // ...and its big buckle
  mesh(new THREE.BoxGeometry(0.1, 0.3, 0.36), '#5a3a22', 0.92, 2.3, 0, body);
  for (const s of [-1, 1]) { // arms from the shoulders, coat sleeves with coloured cuffs
    const sh = new THREE.Group(); sh.position.set(0, 3.95, s * 0.95); body.add(sh); arms.push(sh);
    mesh(new THREE.CylinderGeometry(0.23, 0.21, 1.4, 8), COAT, 0, -0.7, 0, sh);
    mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.38, 8), accent, 0, -1.35, 0, sh);
    mesh(new THREE.SphereGeometry(0.22, 8, 6), SKIN, 0, -1.68, 0, sh);
  }
  // a pistol in his right hand, out when he fires
  const pistol = new THREE.Group(); pistol.position.set(0, -1.75, 0); arms[1].add(pistol); pistol.visible = false;
  mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.1, 8), '#3a3a40', 0, -0.5, 0, pistol); mesh(new THREE.BoxGeometry(0.22, 0.45, 0.2), '#6b4423', -0.2, 0.05, 0, pistol);
  // the sabre on his left hip: a curved blade in its scabbard, gold guard up front
  const sabre = new THREE.Group(); sabre.position.set(0.1, 2.25, -0.95); sabre.rotation.z = -0.55; body.add(sabre);
  mesh(new THREE.BoxGeometry(0.16, 1.5, 0.22), '#3a2414', 0, -0.9, 0, sabre);
  mesh(new THREE.BoxGeometry(0.15, 1.0, 0.2), '#3a2414', -0.1, -2.05, 0, sabre).rotation.z = 0.25;
  const guard = mesh(new THREE.TorusGeometry(0.22, 0.05, 6, 12, Math.PI), '#d4a017', 0.1, 0.05, 0, sabre); guard.rotation.y = Math.PI / 2;
  mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 6), '#15121c', 0, 0.35, 0, sabre); mesh(new THREE.SphereGeometry(0.1, 6, 5), '#d4a017', 0, 0.62, 0, sabre);
  // head: a tanned face, moustache and goatee, dreadlocks
  mesh(new THREE.SphereGeometry(0.6, 14, 12), '#e0a878', 0, 4.72, 0, body);
  for (const z of [-0.18, 0.18]) mesh(new THREE.SphereGeometry(0.07, 6, 5), '#1a1410', 0.55, 4.82, z, body); // eyes
  const mous = mesh(new THREE.BoxGeometry(0.12, 0.1, 0.5), '#2a1a10', 0.58, 4.55, 0, body); mous.rotation.x = 0.1;
  const goatee = mesh(new THREE.ConeGeometry(0.2, 0.55, 8), '#2a1a10', 0.46, 4.2, 0, body); goatee.rotation.z = Math.PI + 0.3;
  for (let k = 0; k < 14; k++) { const a = Math.PI * 0.32 + k / 13 * Math.PI * 1.36, L = 1.2 + (k % 3) * 0.3; // locks hang round the sides and back, over the shoulders
    const d = mesh(new THREE.CylinderGeometry(0.1, 0.08, L, 5), '#4a2a1a', Math.cos(a) * 0.66, 4.95 - L / 2, Math.sin(a) * 0.7, body); d.rotation.set(Math.sin(a) * 0.32, 0, -Math.cos(a) * 0.32);
    mesh(new THREE.SphereGeometry(0.1, 5, 4), k % 2 ? '#d4a017' : '#b8322a', Math.cos(a) * (0.66 + L * 0.16), 4.95 - L * 0.95, Math.sin(a) * (0.7 + L * 0.16), body); } // beads
  // the tricorn
  mesh(new THREE.CylinderGeometry(0.6, 0.68, 0.72, 16), HATC, 0, 5.52, 0, body);
  mesh(TRICORN_BRIM, new THREE.MeshToonMaterial({ color: HATC, gradientMap: GRAD, side: THREE.DoubleSide }), 0, 5.2, 0, body);
  // the shovel for digging (left hand), and a chest carried overhead
  const shovel = new THREE.Group(); shovel.position.set(0, -1.6, 0); arms[0].add(shovel); shovel.visible = false;
  mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.6, 6), '#7a5a3a', 0.9, -0.2, 0, shovel).rotation.z = 1.1;
  mesh(new THREE.BoxGeometry(0.7, 0.9, 0.08), '#9aa0a8', 2.05, -0.8, 0, shovel).rotation.z = 1.1;
  const load = makeChest(); load.scale.setScalar(0.85); load.position.set(0, 6.9, 0); body.add(load); load.visible = false;
  g.userData = { body, legs, arms, shovel, load, pistol }; g.scale.setScalar(0.95); return setShadows(g);
}
function makeDinghy(coat) {
  const g = new THREE.Group(), o = new THREE.Shape();
  o.moveTo(-4, -1.3); o.lineTo(1.5, -1.5); o.quadraticCurveTo(3.8, -1.2, 4.6, 0); o.quadraticCurveTo(3.8, 1.2, 1.5, 1.5); o.lineTo(-4, 1.3); o.lineTo(-4, -1.3);
  let hull = new THREE.ExtrudeGeometry(o, { depth: 1.3, bevelEnabled: false, curveSegments: 8 }); hull.rotateX(-Math.PI / 2); hull.translate(0, -0.4, 0);
  mesh(hull, '#8a5a32', 0, 0, 0, g); const rim = new THREE.ShapeGeometry(o); rim.rotateX(-Math.PI / 2); mesh(rim, '#5a3a1e', 0, 0.92, 0, g).scale.set(0.92, 1, 0.8); // dark inside
  mesh(new THREE.BoxGeometry(0.6, 0.2, 2.6), '#a47a4a', -0.6, 0.95, 0, g); // thwart
  const oars = []; for (const s of [-1, 1]) { const p = new THREE.Group(); p.position.set(-0.4, 1.1, s * 1.4); g.add(p); oars.push({ p, s });
    const shaft = mesh(new THREE.CylinderGeometry(0.08, 0.08, 4.6, 6), '#c8a060', 0, 0, s * 2, p); shaft.rotation.x = Math.PI / 2; mesh(new THREE.BoxGeometry(0.9, 0.08, 0.5), '#c8a060', 0, 0, s * 4.3, p); }
  const rower = makeCaptain(coat); rower.scale.setScalar(0.8); rower.position.set(-0.6, -0.9, 0); g.add(rower); for (const l of rower.userData.legs) l.visible = false;
  const load = makeChest(); load.scale.setScalar(0.8); load.position.set(2.4, 0.5, 0); g.add(load); load.visible = false;
  g.userData = { oars, rower, load }; return setShadows(g);
}
// one captain's dinghy and walker, drawn from an avatar (yours, or a rival's from the server)
function avatarView(coat) { const v = { dinghy: makeDinghy(coat), walker: makeCaptain(coat) }; scene.add(v.dinghy, v.walker); v.dinghy.visible = v.walker.visible = false; return v; }
function drawAvatar(v, a) {
  const off = a.mode === 'dinghy', ashore = a.mode === 'shore', D = v.dinghy.userData, W = v.walker.userData;
  v.dinghy.visible = off || (ashore && !a.marooned); v.walker.visible = ashore;
  if (off) { v.dinghy.position.set(a.x, 0.35 + Math.sin(time * 2 + a.x) * 0.15, a.z); v.dinghy.rotation.set(0, a.yaw, Math.sin(time * 1.6) * 0.05); }
  else if (ashore) { v.dinghy.position.set(a.dinX, Math.max(0.3, heightAt(a.dinX, a.dinZ) + 0.2), a.dinZ); v.dinghy.rotation.set(0, a.dinYaw, 0.12); }
  D.rower.visible = off; D.load.visible = off && a.carry >= CHEST_GOLD;
  const RW = D.rower.userData, aimB = off && time < (a.aimUntil || 0); RW.pistol.visible = aimB; RW.arms[1].rotation.z = aimB ? Math.PI / 2 : 0; // firing from the dinghy
  for (const o of D.oars) { const r = off && a.moving ? Math.sin(time * 5) : 0; o.p.rotation.y = r * 0.55 * o.s; o.p.rotation.x = (off && a.moving ? -Math.cos(time * 5) * 0.25 : 0.1) * o.s; } // blades dip on the back stroke: rowing forward
  if (!ashore) return;
  v.walker.position.set(a.x, heightAt(a.x, a.z), a.z); v.walker.rotation.y = a.yaw;
  const walk = a.moving ? Math.sin(time * 9) : 0, digging = !!a.dig;
  for (let k = 0; k < 2; k++) { W.legs[k].rotation.z = walk * 0.6 * (k ? 1 : -1); W.arms[k].rotation.z = digging ? 0 : -walk * 0.5 * (k ? 1 : -1); }
  W.shovel.visible = digging; if (digging) { const d = Math.sin(time * 7); W.arms[0].rotation.z = 0.9 + d * 0.6; W.arms[1].rotation.z = 0.7 + d * 0.5; W.body.rotation.z = -0.25 + d * 0.1; } else W.body.rotation.z = 0;
  W.load.visible = a.carry >= CHEST_GOLD; if (W.load.visible) { W.arms[0].rotation.x = W.arms[1].rotation.x = 0; W.arms[0].rotation.z = W.arms[1].rotation.z = Math.PI * 0.9; }
  const aiming = time < (a.aimUntil || 0); W.pistol.visible = aiming; if (aiming) W.arms[1].rotation.z = Math.PI / 2; // pistol out, straight ahead
  W.body.position.y = a.moving ? Math.abs(Math.sin(time * 9)) * 0.15 : 0;
}
let MYVIEW = null; // your own dinghy and walker
// when something stands between the camera and your captain, the hidden parts of him show through as a dark silhouette:
// a copy drawn after everything else, only where it's BEHIND what's already there
const XRAY_MAT = new THREE.MeshBasicMaterial({ color: '#1a1410', transparent: true, opacity: 0.55, depthFunc: THREE.GreaterDepth, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 }); // nudged toward the camera, so it never flickers over his own visible surface
function makeXray(walker) {
  const ghost = walker.clone(true), src = [], dst = [];
  walker.traverse(o => src.push(o)); ghost.traverse(o => { dst.push(o); if (o.isMesh) { o.material = XRAY_MAT; o.castShadow = o.receiveShadow = false; o.renderOrder = 9; } });
  scene.add(ghost); return { ghost, src, dst };
}
function syncXray(X) { for (let i = 0; i < X.src.length; i++) { const a = X.src[i], b = X.dst[i]; b.position.copy(a.position); b.quaternion.copy(a.quaternion); b.scale.copy(a.scale); b.visible = a.visible; } }
let MYXRAY = null;
// standing ashore, the captain turns to face the way the camera looks (so the pistol fires where you're looking)
let faceSent = 0, faceT = 0;
function faceCamera(dt) {
  if (CAP.mode !== 'shore' || CAP.moving || CAP.dig) return;
  const want = Math.atan2(-(controls.target.z - camera.position.z), controls.target.x - camera.position.x);
  CAP.yaw += wrapAngle(want - CAP.yaw) * Math.min(1, dt * 8);
  if (NET && (faceT -= dt) <= 0 && Math.abs(wrapAngle(want - faceSent)) > 0.03) { faceT = 0.1; faceSent = want; NET.room.send('face', { yaw: want }); } // the server aims the pistol the same way
}

// ---- treasure: big red X's painted on the ground over each buried chest (single-player and online alike)
const XMARKS = new Map(); // id -> { x, z, g }
const xMat = toon('#d62828');
function addXMark(id, x, z) {
  const g = new THREE.Group(), y = heightAt(x, z), e = 4, n = new V3(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
  g.position.set(x, y + 0.25, z); g.quaternion.setFromUnitVectors(new V3(0, 1, 0), n); scene.add(g);
  for (const r of [Math.PI / 4, -Math.PI / 4]) { const b = new THREE.Mesh(new THREE.BoxGeometry(16, 0.4, 2.8), xMat); b.rotation.y = r; b.receiveShadow = true; g.add(b); }
  const mound = mesh(new THREE.SphereGeometry(2.2, 10, 6), '#8a6a44', 0, -0.9, 0, g); mound.scale.y = 0.45; // freshly turned earth
  XMARKS.set(id, { x, z, g });
}
function dropXMark(id, dug) { const X = XMARKS.get(id); if (!X) return; scene.remove(X.g); XMARKS.delete(id); if (dug) { const y = heightAt(X.x, X.z); fx.dirt(X.x, y, X.z); fx.gold(X.x, y + 2, X.z, 20); } }
// single-player: the chests the rules know about, and chests waiting to be buried again
const SOLO_CHESTS = []; let chestN = 1; const chestTimers = [];
function buryChest() { const spot = chestSpot(R01, SOLO_CHESTS); if (!spot) { chestTimers.push(10); return; } const c = { id: `c${chestN++}`, x: spot[0], z: spot[1] }; SOLO_CHESTS.push(c); addXMark(c.id, c.x, c.z); }
function buildTreasure() { for (let k = 0; k < CHEST_COUNT; k++) buryChest(); }
const chestList = () => NET ? [...XMARKS.entries()].map(([id, X]) => ({ id, x: X.x, z: X.z })) : SOLO_CHESTS;

// ---- what you can do off the ship (both modes: single-player runs it here, online asks the server)
function goAshore() {
  if (CAP.mode !== 'ship' || SHIP.sinking) return;
  if (SHIP.speed > 3) { toast('Drop anchor first, captain!', 1600); return; }
  if (NET) { NET.room.send('ashore'); }
  else { SHIP.path = []; SHIP.goal = null; SHIP.anchored = true; launchDinghy(CAP, SHIP); }
  marker.visible = false; drawCourse(); toast('Into the dinghy! Tap the shore to row there.', 2600);
}
function goBack() {
  if (NET) { NET.room.send('back'); return; }
  if (CAP.mode === 'shore') { if (!avatarGo(CAP, CAP.dinX, CAP.dinZ, shipOrNull(), true)) toast("Can't find a way back to the dinghy!", 1800); }
  else if (CAP.mode === 'dinghy') { if (!SHIP.sinking) avatarGo(CAP, SHIP.x, SHIP.z, SHIP, true); else { const w = nearestOpen(CABIN.x, CABIN.z); if (w) avatarGo(CAP, ...cellPos(...w), null); } }
}
function doDig() {
  if (CAP.mode !== 'shore') return;
  if (CAP.carry >= CHEST_GOLD) { toast("Your hands are full! Take this chest back to the dinghy first.", 2200); return; }
  const c = nearestChest(CAP, chestList()); if (!c) { toast('Nothing buried here. Find an X!', 1600); return; }
  if (NET) NET.room.send('dig'); else startDig(CAP, SOLO_CHESTS);
  toast('Digging…', 1500);
}
// the pistol: fires straight ahead the way the captain (or his dinghy) faces, any time it's loaded
function doShoot() {
  if ((CAP.mode !== 'shore' && CAP.mode !== 'dinghy') || CAP.dig || CAP.reload > 0) return;
  CAP.reload = PISTOL_RELOAD; CAP.aimUntil = time + PISTOL_DRAW + 0.45; // up goes the arm...
  if (NET) { NET.room.send('shoot'); return; } // (online the server fires it after the same pause)
  CAP.fireAt = time + PISTOL_DRAW; // ...and a moment later, bang
}
function firePistolNow() {
  if (CAP.mode !== 'shore' && CAP.mode !== 'dinghy') return;
  const ball = pistolBall(CAP), m = new THREE.Mesh(ballGeo, ballMat); m.scale.setScalar(0.6); m.position.set(ball.x, ball.y, ball.z); scene.add(m);
  BALLS.push({ m, from: SHIP, vx: ball.vx, vy: ball.vy, vz: ball.vz }); pistolFx(ball);
}
// a small crack of flame and a wisp of smoke
function pistolFx(b) { fx.flash(b.x, b.y, b.z, 0.22); fx.smoke(b.x, b.y, b.z, 2, null, 0.14, [b.vx * 0.02, b.vz * 0.02]); }
// where to go, whatever you are: sail, row or walk
function goTo(tx, tz, name) {
  if (!MODE) return;
  if (CAP.mode === 'ship') { setSail(tx, tz, name); return; }
  if (CAP.mode === 'lost') return;
  if (NET) NET.room.send('sail', { x: tx, z: tz });
  else if (!avatarGo(CAP, tx, tz, shipOrNull())) { toast(CAP.mode === 'shore' ? "Can't walk there from here!" : "Can't row there!", 1600); return; }
  marker.position.set(tx, Math.max(0, heightAt(tx, tz)), tz); marker.visible = true;
  toast(name ? `Heading for ${name}!` : CAP.mode === 'dinghy' ? (sdAt(tx, tz) > 0 ? 'Rowing for the beach!' : 'Rowing!') : 'Walking…', 1400);
}
// a cannonball came down: splash damage to you off the ship (single-player; online the server decides)
function soloSplash(x, z) {
  if (NET || CAP.mode === 'ship') return;
  const carried = CAP.carry, where = [CAP.x, CAP.z], res = splashAvatar(CAP, x, z); if (!res) return;
  if (res === 'dinghy' || res === 'knocked') { spillCoins(...where, carried, 20); CAP.carry = 0; }
  captainNews({ event: res }); hud();
}
function spillCoins(x, z, g, spread = 50) { for (let k = 0; k < Math.min(24, Math.ceil(g / COIN_GOLD)); k++) addCoin(x + (R01() - 0.5) * spread, z + (R01() - 0.5) * spread); }
// what happened to you, in words
function captainNews(m) {
  const say = { ashore: 'Into the dinghy! Tap the shore to row there.', landed: 'Ashore! Tap to walk. Find an X and dig.', embarked: 'Pushed off in the dinghy.', boarded: CAP.carry ? 'Back aboard! The loot is in the hold.' : 'Back aboard!',
    heart: `Ow! A near miss. ${Math.max(0, CAP.hearts)} heart${CAP.hearts === 1 ? '' : 's'} left.`, knocked: 'Knocked out! The crew will fetch you home…', dinghy: 'The dinghy is sunk! Swim for it… the crew will fetch you home.',
    boat: "They've smashed our dinghy! We're marooned… the crew is on its way.", rescued: 'The crew brought you home. A fresh ship awaits!', newship: 'Home! A fresh ship awaits.' }[m.event];
  if (say) toast(say, 2600);
  if (m.event === 'heart' || m.event === 'knocked' || m.event === 'dinghy') shake = Math.min(1.4, shake + 0.8);
}
// single-player: step the captain along, and settle what he's done
function updateCaptain(dt) {
  if (NET && NET.st) { // online: glide toward what the server says
    const st = NET.st, mode = st.mode || 'ship', snap = mode !== CAP.mode, k = snap ? 1 : Math.min(1, dt * 10);
    Object.assign(CAP, { mode, moving: st.moving, dig: st.digging ? 1 : null, dinX: st.dinX, dinZ: st.dinZ, dinYaw: st.dinYaw, hearts: st.hearts, carry: st.carry, marooned: st.marooned });
    CAP.x += (st.ax - CAP.x) * k; CAP.z += (st.az - CAP.z) * k; if (!(mode === 'shore' && !st.moving && !st.digging)) CAP.yaw += wrapAngle(st.ayaw - CAP.yaw) * k; CAP.reload = Math.max(0, CAP.reload - dt);
    hud(); // loot counts follow the server (hud only redraws when something changed)
  } else if (MODE === 'solo') {
    if (CAP.fireAt && time >= CAP.fireAt) { CAP.fireAt = 0; firePistolNow(); }
    const ev = stepAvatar(CAP, dt, shipOrNull());
    if (ev === 'boarded') { cargo += CAP.carry; CAP.carry = 0; }
    else if (ev === 'dug') { const i = SOLO_CHESTS.findIndex(c => c.id === CAP.dig); CAP.dig = null; CAP.digT = 0;
      if (i >= 0) { const c = SOLO_CHESTS.splice(i, 1)[0]; dropXMark(c.id, true); CAP.carry += CHEST_GOLD; chestTimers.push(CHEST_RESPAWN_S); toast('Treasure! Carry it back to the dinghy (it slows you down).', 2800); } }
    else if (ev === 'rescued') { respawnPlayer(); resetAvatar(CAP); }
    if (ev && ev !== 'arrived' && ev !== 'dug') captainNews({ event: ev });
    if (ev === 'arrived' || ev === 'landed' && !CAP.path.length) marker.visible = false;
    if (CAP.mode === 'ship') { CAP.x = SHIP.x; CAP.z = SHIP.z; CAP.yaw = SHIP.yaw; }
    // rowing home: bank the dinghy's load; with no ship left, a fresh one
    if (CAP.mode === 'dinghy' && CABIN && Math.hypot(CAP.x - CABIN.x, CAP.z - CABIN.z) < HOME_RADIUS) {
      if (CAP.carry) { gold += CAP.carry; fx.gold(CABIN.x, heightAt(CABIN.x, CABIN.z) + 4, CABIN.z, 24); toast(`Stashed ${CAP.carry} gold at Wold Cabin!`, 2600); CAP.carry = 0; }
      if (SHIP.sinking) { respawnPlayer(); resetAvatar(CAP); captainNews({ event: 'newship' }); }
    }
    for (let i = chestTimers.length - 1; i >= 0; i--) if ((chestTimers[i] -= dt) <= 0) { chestTimers.splice(i, 1); buryChest(); }
    hud();
  }
  faceCamera(dt);
  if (MYVIEW) { drawAvatar(MYVIEW, CAP); if (!MYXRAY) MYXRAY = makeXray(MYVIEW.walker); syncXray(MYXRAY); }
}

// ---- the treasure map: a parchment chart of the islands, with an X for every chest; tap it to set a course
const MAPBOX = { x0: -1400, x1: 1300, z0: -1900, z1: 2500 }, MAP_W = 540, MAP_H = Math.round(MAP_W * (MAPBOX.z1 - MAPBOX.z0) / (MAPBOX.x1 - MAPBOX.x0));
let mapBase = null;
function drawMapBase() {
  const c = document.createElement('canvas'); c.width = MAP_W; c.height = MAP_H; const g = c.getContext('2d'), img = g.createImageData(MAP_W, MAP_H), sx = (MAPBOX.x1 - MAPBOX.x0) / MAP_W, sz = (MAPBOX.z1 - MAPBOX.z0) / MAP_H;
  for (let j = 0; j < MAP_H; j++) for (let i = 0; i < MAP_W; i++) {
    const x = MAPBOX.x0 + (i + 0.5) * sx, z = MAPBOX.z0 + (j + 0.5) * sz, sd = sdAt(x, z), n = noise(x * 0.02, z * 0.02) * 10 + (Math.random() - 0.5) * 8; let r, gg, b;
    if (Math.abs(sd) < sx * 0.9) { r = 70; gg = 45; b = 25; } // inked coastline
    else if (sd > 0) { const h = heightAt(x, z); r = 196 - h * 0.6; gg = 170 - h * 0.3; b = 110 - h * 0.5; } // land, a little darker uphill
    else { const ring = sd > -14 && ((j + i) % 5 === 0); r = ring ? 150 : 233; gg = ring ? 125 : 220; b = ring ? 90 : 180; } // parchment sea, hatched along the shore
    const k = (j * MAP_W + i) * 4; img.data[k] = r + n; img.data[k + 1] = gg + n; img.data[k + 2] = b + n; img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // wave marks, place names, a compass rose, a scorched edge
  g.strokeStyle = 'rgba(90,60,30,0.45)'; g.lineWidth = 1.2;
  for (let k = 0; k < 60; k++) { const i = Math.random() * MAP_W, j = Math.random() * MAP_H, x = MAPBOX.x0 + i * sx, z = MAPBOX.z0 + j * sz; if (sdAt(x, z) > -60) continue; g.beginPath(); g.moveTo(i, j); g.quadraticCurveTo(i + 4, j - 4, i + 8, j); g.quadraticCurveTo(i + 12, j + 4, i + 16, j); g.stroke(); }
  g.fillStyle = '#3a2412'; g.textAlign = 'center';
  for (const L of LABELS) { const i = (L.x - MAPBOX.x0) / sx, j = (L.z - MAPBOX.z0) / sz; if (i < 0 || i > MAP_W || j < 0 || j > MAP_H) continue;
    g.font = L.style === 'water' ? "italic 14px 'Pirata One', serif" : "16px 'Pirata One', serif"; g.fillText(L.text, i, j); }
  const cx = MAP_W - 60, cy = 70; g.strokeStyle = '#3a2412'; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, 34, 0, TAU); g.stroke();
  g.fillStyle = '#b8322a'; g.beginPath(); g.moveTo(cx, cy - 40); g.lineTo(cx + 8, cy); g.lineTo(cx - 8, cy); g.fill(); g.fillStyle = '#3a2412'; g.beginPath(); g.moveTo(cx, cy + 40); g.lineTo(cx + 8, cy); g.lineTo(cx - 8, cy); g.fill();
  g.font = "20px 'Pirata One', serif"; g.fillText('N', cx, cy - 44);
  g.font = "34px 'Pirata One', serif"; g.fillText('The San Juan Isles', MAP_W / 2, 44);
  const vg = g.createRadialGradient(MAP_W / 2, MAP_H / 2, MAP_W * 0.35, MAP_W / 2, MAP_H / 2, MAP_H * 0.62); vg.addColorStop(0, 'rgba(90,50,10,0)'); vg.addColorStop(1, 'rgba(90,50,10,0.55)'); g.fillStyle = vg; g.fillRect(0, 0, MAP_W, MAP_H);
  return c;
}
const toMap = (x, z) => [(x - MAPBOX.x0) / (MAPBOX.x1 - MAPBOX.x0) * MAP_W, (z - MAPBOX.z0) / (MAPBOX.z1 - MAPBOX.z0) * MAP_H];
function drawMap() {
  const cv = btn('mapCanvas'), g = cv.getContext('2d'); if (!mapBase) mapBase = drawMapBase();
  cv.width = MAP_W; cv.height = MAP_H; g.drawImage(mapBase, 0, 0);
  const X = (x, z, s = 11) => { const [i, j] = toMap(x, z); g.lineCap = 'round'; for (const [w, col] of [[7, '#3a2412'], [4.5, '#d62828']]) { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(i - s, j - s); g.lineTo(i + s, j + s); g.moveTo(i + s, j - s); g.lineTo(i - s, j + s); g.stroke(); } };
  const icon = (x, z, text, col = '#3a2412', size = 22) => { const [i, j] = toMap(x, z); g.font = `${size}px serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = col; g.fillText(text, i, j); };
  for (const [, m] of XMARKS) X(m.x, m.z);
  if (CABIN) icon(CABIN.x, CABIN.z, '☠', '#15121c', 24);
  if (NET) for (const r of RIVALS.values()) if (r.kind === 'pirate' && !r.sinking) icon(r.x, r.z, '⛵', r.st.color || '#3a2412', 18);
  if (!SHIP.sinking) icon(SHIP.x, SHIP.z, '⛵', '#b8322a', 24);
  if (CAP.mode === 'dinghy') icon(CAP.x, CAP.z, '🛶', '#b8322a', 18);
  if (CAP.mode === 'shore') { icon(CAP.dinX, CAP.dinZ, '🛶', '#b8322a', 16); icon(CAP.x, CAP.z, '🏴‍☠️', '#15121c', 18); }
}
const setMap = open => { btn('mapWrap').hidden = !open; if (open) drawMap(); };
btn('mapCanvas').addEventListener('click', e => {
  const r = btn('mapCanvas').getBoundingClientRect(), x = MAPBOX.x0 + (e.clientX - r.left) / r.width * (MAPBOX.x1 - MAPBOX.x0), z = MAPBOX.z0 + (e.clientY - r.top) / r.height * (MAPBOX.z1 - MAPBOX.z0);
  const nearX = [...XMARKS.values()].find(m => Math.hypot(m.x - x, m.z - z) < 60);
  setMap(false); goTo(nearX ? nearX.x : x, nearX ? nearX.z : z, nearX ? 'the X' : null);
});
btn('mapClose').onclick = () => setMap(false);
btn('mapWrap').addEventListener('click', e => { if (e.target === btn('mapWrap')) setMap(false); });

// ============================================================ online voyage (a private match found by its 4-letter code)
const PARAMS = new URLSearchParams(location.search);
let MODE = null; // 'solo' or 'online' once you've set sail from the harbor menu
let NET = null;  // { room, me, st, code, t, tAt } once connected; st is our own ship as the server sees it
const RIVALS = new Map(); // id -> { g, sp, st, kind, x, z, yaw } — other captains, and the Navy and merchantmen
const tintSails = (g, color) => { if (color) g.userData.sails[0].material.color.set(color); }; // every sail on a ship shares one material
function rivalModel(st) { const g = makeShip(st.kind === 'pirate' ? 'pirate' : st.kind); if (st.kind === 'merchant') g.scale.setScalar(1.35); if (st.kind === 'pirate') tintSails(g, st.color); scene.add(g); return g; }
function addRival(id, st) {
  const g = rivalModel(st);
  let sp = null; // captains carry their name; patrols fly their colours
  if (st.kind === 'pirate') { const { t, aspect } = labelTexture(st.name, 'place'); sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true })); sp.center.set(0.5, 0); sp.scale.set(0.034 * aspect, 0.034, 1); labelScene.add(sp); }
  const r = { id, g, sp, st, kind: st.kind, x: st.x, z: st.z, yaw: st.yaw, y: 0, list: 0, listT: 0, listDir: 1, fires: [], fireT: 0, sinking: st.sinking, sinkT: 0, launches: st.launches,
    av: st.kind === 'pirate' ? avatarView(st.color) : null, a: { mode: 'ship', x: st.x, z: st.z, yaw: 0 } };
  RIVALS.set(id, r);
  for (let k = st.hp; k < st.maxHp; k++) scar(r, r.x + (R01() - 0.5) * 8, 2.5, r.z + (R01() - 0.5) * 8); // show damage it already carries
}
function removeRival(id) { const r = RIVALS.get(id); if (!r) return; scene.remove(r.g); if (r.sp) labelScene.remove(r.sp); if (r.av) scene.remove(r.av.dinghy, r.av.walker); RIVALS.delete(id); if (r.kind === 'pirate') toast(`${r.st.name} sailed off.`, 2000); }
// who's who (both modes)
const shipById = id => NET ? (id === NET.me ? SHIP : RIVALS.get(id)) : id === SHIP.id ? SHIP : ENEMIES.find(e => e.id === id);
const nameOf = id => { const mv = MONVIEW.get(id); if (mv) return MONSTERS[mv.kind].name;
  if (!NET) return id === SHIP.id ? 'You' : 'A ship'; return (id === NET.me ? 'You' : RIVALS.get(id)?.st.name) || 'A ship'; };
const isMe = id => id === (NET ? NET.me : SHIP.id);

// hideouts online: a cabin at every crew's cove, flying the crew's colour; yours is labelled "Your hideout"
function refreshHomes() {
  if (!NET) return;
  const owners = new Map(); if (NET.st) owners.set(NET.st.home, { me: true, st: NET.st });
  for (const r of RIVALS.values()) if (r.kind === 'pirate' && r.st.home >= 0) owners.set(r.st.home, { me: false, st: r.st });
  for (const [i, o] of owners) buildCabin(i);
  for (const h of HIDEOUTS) { if (!h) continue; const o = owners.get(h.i);
    h.pen.visible = !!o; if (o) h.pen.material.color.set(o.st.color);
    if (o && o.me) labelHome(h, 'Your hideout', 'home'); else if (o) labelHome(h, `${o.st.name}'s hideout`, 'place'); else labelHome(h, h.i === 0 ? 'Wold Cabin' : null, 'place'); }
}

// ---- online combat: the server decides; these draw what it reports
const NETBALLS = new Map(); // ball id -> { m, x, y, z, vx, vy, vz }
function netShot(m) {
  const s = shipById(m.ship), mm = new THREE.Mesh(ballGeo, ballMat); mm.position.set(m.x, m.y, m.z); mm.castShadow = true; scene.add(mm);
  NETBALLS.set(m.id, { m: mm, x: m.x, y: m.y, z: m.z, vx: m.vx, vy: m.vy, vz: m.vz });
  if (m.pistol) { mm.scale.setScalar(0.6); pistolFx(m); return; }
  if (s && s.g) gunFx(s, m.side, m);
}
function netImpact(m) {
  const b = NETBALLS.get(m.id); if (b) { scene.remove(b.m); NETBALLS.delete(m.id); }
  if (m.kind === 'water' || m.kind === 'shrug') return fx.splash(m.x, m.z);
  if (m.kind === 'land') return fx.dirt(m.x, m.y, m.z);
  if (m.kind === 'monster') { const mv = MONVIEW.get(m.ship); monsterFx(mv ? mv.src : { kind: 'kraken' }, m.x, m.y, m.z, m.by === NET.me); return; }
  const target = shipById(m.ship); if (!target || !target.g) return fx.hit(m.x, m.y, m.z);
  scar(target, m.x, m.y, m.z);
  if (target === SHIP) { shake = Math.min(1.4, shake + 0.9); toast(`We're hit! ${nameOf(m.by)}'s guns found us`, 1200); }
  else if (m.by === NET.me) toast(['Direct hit!', 'Ka-BOOM!', 'Hull breached!', 'Right in the timbers!'][Math.floor(R01() * 4)], 1100);
}
function netBump(m) {
  const A = shipById(m.a), B = shipById(m.b), meIn = m.a === NET.me || m.b === NET.me;
  if (m.dmgA || m.dmgB) fx.hit(m.x, 2, m.z);
  for (const [s, n] of [[A, m.dmgA], [B, m.dmgB]]) if (s && s.g) for (let k = 0; k < n; k++) scar(s, m.x, 2, m.z);
  if (!meIn) return;
  shake = Math.min(1.4, shake + 0.8); SHIP.rollV += (R01() - 0.5) * 0.6;
  const other = nameOf(m.a === NET.me ? m.b : m.a), dealt = m.a === NET.me ? m.dmgB : m.dmgA, took = m.a === NET.me ? m.dmgA : m.dmgB;
  if (m.kind === 'ram') toast(m.rammer === NET.me ? `Rammed ${other} amidships! (${dealt} hits)` : `${other} rammed us! (${took} hits)`, 1800);
  else toast(`Scraped hulls with ${other}! Both ships damaged`, 1500);
}
function netSunk(m) {
  const s = shipById(m.ship); if (s) { s.sinking = true; s.sinkT = 0; }
  if (m.ship === NET.me) { SHIP.path = []; SHIP.goal = null; marker.visible = false; drawCourse(); toast(`We're sinking! ${m.by && m.by !== NET.me ? nameOf(m.by) + ' got us. ' : ''}Into the dinghy: row home for a new ship.`, 3600); }
  else if (m.by === NET.me) toast(`You sank ${nameOf(m.ship)}!`, 2600);
  else if (RIVALS.get(m.ship)?.kind === 'pirate') toast(`${nameOf(m.ship)} is going down!`, 2000);
}
// a fresh ship, drawn when the server's launch count for it goes up (not on the 'respawn' message, which can arrive
// before the state that goes with it, and not on the sinking flag, which a backgrounded tab can miss entirely)
function netRespawn(m) {
  if (m.ship === NET.me) {
    freshShip(); tintSails(SHIP.g, NET.st.color);
    Object.assign(SHIP, { sinking: false, sinkT: 0, y: 0, rollA: 0, rollV: 0, path: [], goal: null, x: NET.st.x, z: NET.st.z, yaw: NET.st.yaw });
    btn('bAnchor').classList.add('on'); hud(); return;
  }
  const r = RIVALS.get(m.ship); if (!r) return;
  scene.remove(r.g); r.g = rivalModel(r.st);
  Object.assign(r, { x: r.st.x, z: r.st.z, yaw: r.st.yaw, y: 0, list: 0, listT: 0, fires: [], sinking: false, sinkT: 0 });
}
function netRepaired(m) {
  if (m.ship === NET.me) { freshShip(); tintSails(SHIP.g, NET.st.color); hud(); toast('Ship repaired at your hideout!', 1800); return; }
  const r = RIVALS.get(m.ship); if (r) { scene.remove(r.g); r.g = rivalModel(r.st); Object.assign(r, { list: 0, listT: 0, fires: [] }); }
}
function netEngage(m) { const r = RIVALS.get(m.ship); if (r && m.target === NET.me) toast(engageLine(r.kind, m.provoked), 2200); }
function updateNetBalls(dt) {
  for (const [id, b] of NETBALLS) { stepBall(b, dt); b.m.position.set(b.x, b.y, b.z); if (b.y < -20) { scene.remove(b.m); NETBALLS.delete(id); } } // lost impact: tidy up
}
async function goOnline(code, name) {
  const { room, callbacks } = code ? await joinVoyage(code, name) : await newVoyage(name);
  NET = { room, me: room.sessionId, st: null, code: room.roomId, t: 0, tAt: performance.now() };
  callbacks.listen('t', v => { NET.t = v; NET.tAt = performance.now(); });
  callbacks.onAdd('ships', (st, id) => {
    if (id === NET.me) { NET.st = st; SHIP.x = st.x; SHIP.z = st.z; SHIP.yaw = st.yaw; tintSails(SHIP.g, st.color); CABIN = buildCabin(st.home); refreshHomes();
      callbacks.listen(st, 'hp', v => { SHIP.hp = v; hud(); }); return; } // the hull meter follows the server the moment it changes
    addRival(id, st); refreshHomes(); if (NET.ready && st.kind === 'pirate') toast(`${st.name} has joined the voyage!`, 2200);
  });
  callbacks.onRemove('ships', (st, id) => { removeRival(id); refreshHomes(); });
  callbacks.onAdd('monsters', (st, id) => addMonView(id, st));
  callbacks.onAdd('chests', (st, id) => addXMark(id, st.x, st.z)); callbacks.onRemove('chests', (st, id) => dropXMark(id, true));
  callbacks.onAdd('coins', (st, id) => { addCoin(st.x, st.z); COINS[COINS.length - 1].id = id; });
  callbacks.onRemove('coins', (st, id) => { const i = COINS.findIndex(c => c.id === id); if (i >= 0) { const c = COINS[i]; fx.gold(c.x, 1.5, c.z, 5); scene.remove(c.m); COINS.splice(i, 1); } });
  callbacks.onRemove('monsters', (st, id) => dropMonView(id));
  room.onMessage('shot', netShot); room.onMessage('impact', netImpact); room.onMessage('bump', netBump);
  room.onMessage('sunk', netSunk); room.onMessage('respawn', () => {}); room.onMessage('repaired', netRepaired); room.onMessage('engage', netEngage);
  room.onMessage('maul', m => maulFx(m)); room.onMessage('monster', m => monsterNews(m)); room.onMessage('storm', m => stormNews(m));
  room.onMessage('captain', m => { if (m.ship === NET.me) captainNews(m); });
  room.onMessage('aim', m => { const a = m.ship === NET.me ? CAP : RIVALS.get(m.ship)?.a; if (a) a.aimUntil = time + PISTOL_DRAW + 0.45; }); // arm up before the shot
  room.onMessage('dug', m => { if (m.ship === NET.me) toast('Treasure! Carry it back to the dinghy (it slows you down).', 2800); else toast(`${nameOf(m.ship)} dug up a chest!`, 2000); });
  room.onMessage('bank', m => { if (m.ship === NET.me) { toast(`Stashed ${m.gold} gold at your hideout! ${m.total} in the stash.`, 3200); if (CABIN) fx.gold(CABIN.x, heightAt(CABIN.x, CABIN.z) + 4, CABIN.z, 24); } });
  room.onLeave(() => { toast('Lost contact with the game server.', 4000); NET = null; });
  // the first full state arrives just after joining: wait (briefly) for our own ship before going on
  for (let k = 0; k < 40 && !NET.st; k++) await new Promise(r => setTimeout(r, 50));
  NET.ready = true;
  if (PARAMS.has('debug')) Object.assign(window.__klh, { place: (x, z, yaw, speed) => NET.room.send('debug-place', { x, z, yaw, speed }) }); // for local testing
}
function updateRivals(dt) {
  const k = Math.min(1, dt * 10);
  for (const r of RIVALS.values()) {
    r.x += (r.st.x - r.x) * k; r.z += (r.st.z - r.z) * k; r.yaw += wrapAngle(r.st.yaw - r.yaw) * k;
    if (r.st.launches !== r.launches) { if (r.launches != null) netRespawn({ ship: r.id }); r.launches = r.st.launches; }
    if (r.st.sinking && !r.sinking) { r.sinking = true; r.sinkT = 0; }
    if (r.sinking) { r.sinkT += dt; r.listT = lerp(r.listT, r.listDir * 1.2, dt * 0.35); r.y -= dt * (r.kind === 'pirate' ? 0.4 + r.sinkT * 0.2 : 0.3 + r.sinkT * 0.09); }
    r.list = lerp(r.list, r.listT + (r.sinking ? 0 : woundList(r, r.st.hp, r.st.maxHp)), Math.min(1, dt * 1.5)); emitFires(r, dt);
    const b = r.g.userData.body; r.g.position.set(r.x, 0.35 + r.y + Math.sin(time * 1.3 + r.x) * 0.25, r.z); r.g.rotation.y = r.yaw;
    b.rotation.x = Math.sin(time * 0.9 + r.z) * 0.045 + r.list; r.g.userData.flag.rotation.y = Math.sin(time * 3 + r.x) * 0.2;
    const top = r.kind === 'pirate' ? MAX_SPEED : r.kind === 'navy' ? 12 : 9;
    for (const sl of r.g.userData.sails) sl.scale.x = 0.35 + 0.65 * clamp(r.st.speed / top + 0.2, 0, 1);
    if (r.st.speed > 3 && R01() < dt * 14) { const kk = 1.5 * 6.8; for (const sd of [-1, 1]) spawnFoam(r.x - Math.cos(r.yaw) * kk + Math.sin(r.yaw) * sd * 2.5, r.z + Math.sin(r.yaw) * kk + Math.cos(r.yaw) * sd * 2.5); }
    if (r.av) { const st = r.st, a = r.a, snap = st.mode !== a.mode, kk = snap ? 1 : k; // their captain off the ship
      Object.assign(a, { mode: st.mode || 'ship', moving: st.moving, dig: st.digging ? 1 : null, dinX: st.dinX, dinZ: st.dinZ, dinYaw: st.dinYaw, carry: st.carry, marooned: st.marooned });
      a.x += (st.ax - a.x) * kk; a.z += (st.az - a.z) * kk; a.yaw += wrapAngle(st.ayaw - a.yaw) * kk; drawAvatar(r.av, a);
      if (r.sinking && r.y < -40) r.g.visible = false; }
    if (r.sp) { const off = r.a && (r.a.mode === 'dinghy' || r.a.mode === 'shore'); r.sp.position.set(off ? r.a.x : r.x, off ? Math.max(0, heightAt(r.a.x, r.a.z)) + 12 : 30, off ? r.a.z : r.z); }
  }
}

// ============================================================ sea monsters: the Kraken and the White Whale
const T_SEGS = 14, T_RING = 6; // tentacle: points along it, sides around it
const _tt = new V3(), _tn = new V3(), _tb = new V3(), _up = new V3(0, 1, 0);
function shapeTentacle(T) {
  const P = T.pts, pos = T.m.geometry.attributes.position;
  for (let j = 0; j < T_SEGS; j++) {
    _tt.subVectors(P[Math.min(j + 1, T_SEGS - 1)], P[Math.max(j - 1, 0)]).normalize();
    _tn.crossVectors(_tt, _up); if (_tn.lengthSq() < 1e-4) _tn.set(1, 0, 0); _tn.normalize(); _tb.crossVectors(_tn, _tt);
    const r = lerp(2.4, 0.4, j / (T_SEGS - 1));
    for (let i = 0; i < T_RING; i++) { const a = i / T_RING * TAU, c = Math.cos(a) * r, s = Math.sin(a) * r;
      pos.setXYZ(j * T_RING + i, P[j].x + _tn.x * c + _tb.x * s, P[j].y + _tn.y * c + _tb.y * s, P[j].z + _tn.z * c + _tb.z * s); }
  }
  const L = P[T_SEGS - 1]; pos.setXYZ(T_SEGS * T_RING, L.x + _tt.x * 1.6, L.y + _tt.y * 1.6, L.z + _tt.z * 1.6); // pointed tip
  pos.needsUpdate = true; T.m.geometry.computeVertexNormals();
}
function makeKraken() {
  const g = new THREE.Group(), skin = '#a23b5c';
  const head = mesh(new THREE.SphereGeometry(8, 18, 14), skin, 0, 3, 0, g); head.scale.set(1, 1.35, 1);
  const mantle = mesh(new THREE.ConeGeometry(6.5, 10, 14), skin, -5, 13, 0, g); mantle.rotation.z = 0.9; // the droopy mantle behind the head
  for (let k = 0; k < 9; k++) { const a = k * 2.4, s = mesh(new THREE.SphereGeometry(1, 8, 6), '#7a2745', Math.cos(a) * 6.5 - 1, 6 + Math.sin(k) * 3.5, Math.sin(a) * 6.5, g); s.scale.set(1.3, 0.9, 1.3); } // spots
  for (const sd of [-1, 1]) { mesh(new THREE.SphereGeometry(2.5, 14, 10), '#ffe066', 6.4, 5, sd * 3.6, g); const p = mesh(new THREE.BoxGeometry(0.8, 3, 1.1), '#15121c', 8.6, 5, sd * 3.9, g); p.rotation.y = sd * 0.35; } // eyes, slit pupils
  // eight tentacles: each one solid, faceted tube that tapers to a point, re-shaped along its curve every frame
  const tents = [], tMat = new THREE.MeshToonMaterial({ color: skin, gradientMap: GRAD, flatShading: true });
  for (let k = 0; k < 8; k++) {
    const geo = new THREE.BufferGeometry(), idx = [];
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((T_SEGS * T_RING + 1) * 3), 3));
    for (let j = 0; j < T_SEGS - 1; j++) for (let i = 0; i < T_RING; i++) { const a = j * T_RING + i, b = j * T_RING + (i + 1) % T_RING; idx.push(a, a + T_RING, b, b, a + T_RING, b + T_RING); }
    const tip = T_SEGS * T_RING; for (let i = 0; i < T_RING; i++) idx.push((T_SEGS - 1) * T_RING + i, tip, (T_SEGS - 1) * T_RING + (i + 1) % T_RING);
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, tMat); m.castShadow = true; m.frustumCulled = false; g.add(m);
    tents.push({ a: k / 8 * TAU + 0.2, m, pts: Array.from({ length: T_SEGS }, () => new V3()) });
  }
  g.userData = { tents }; g.scale.setScalar(KRAKEN_SIZE); return setShadows(g);
}
function makeWhale() {
  const g = new THREE.Group(), white = '#f1efe8', scar = '#d6d2c6';
  // one smooth body turned on a lathe: the sperm whale's great rounded head, tapering back to the tail
  const prof = [[0.3, -17], [1.6, -15.5], [2.7, -12], [3.5, -7], [3.9, -2], [4.1, 3], [4.25, 8], [4.15, 11], [3.8, 13], [3.0, 14.3], [1.6, 15], [0, 15.2]].map(([r, y]) => new THREE.Vector2(r, y));
  const bg = new THREE.LatheGeometry(prof, 22); bg.rotateZ(-Math.PI / 2); bg.scale(1, 0.92, 0.9); // nose toward +x, a little taller than wide
  mesh(bg, white, 0, 0, 0, g);
  const jaw = mesh(new THREE.CapsuleGeometry(0.6, 9, 6, 10), '#e4e0d4', 8, -3.2, 0, g); jaw.rotation.z = Math.PI / 2 + 0.06; // the narrow lower jaw
  for (const sd of [-1, 1]) mesh(new THREE.SphereGeometry(0.45, 10, 8), '#15121c', 3.5, -1.2, sd * 3.75, g); // eyes
  for (let k = 0; k < 5; k++) { const sc = mesh(new THREE.CapsuleGeometry(0.1, rr(1.5, 3.5), 3, 6), scar, rr(-5, 9), 3.75, rr(-1.2, 1.2), g); sc.rotation.set(0, rr(-0.6, 0.6), Math.PI / 2); } // old harpoon scars
  const hump = mesh(new THREE.SphereGeometry(1.2, 12, 8), white, -8, 2.9, 0, g); hump.scale.set(1.4, 0.8, 0.8);
  const tail = new THREE.Group(); tail.position.set(-16.5, 0, 0); g.add(tail);
  const fs = new THREE.Shape(); fs.moveTo(0, 0); fs.quadraticCurveTo(-3, 5, -5.5, 6.5); fs.quadraticCurveTo(-4.5, 3, -6, 0.6); fs.lineTo(-5.2, 0); fs.lineTo(-6, -0.6); fs.quadraticCurveTo(-4.5, -3, -5.5, -6.5); fs.quadraticCurveTo(-3, -5, 0, 0);
  const flukes = new THREE.Mesh(new THREE.ExtrudeGeometry(fs, { depth: 0.5, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 2, curveSegments: 12 }), toon(white)); flukes.rotation.x = Math.PI / 2; flukes.position.set(0.5, 0.25, 0); tail.add(flukes);
  g.userData = { tail, hump }; return setShadows(g);
}
// every monster on the water (both modes): { id, kind, g, label, src } — src holds x, z, y, yaw, speed, hp, maxHp, mode, grab
const MONVIEW = new Map();
// single-player: the storm and the monsters' rules run here (online the server runs them)
const SOLO_MONS = []; let soloStorm = null, stormT = rr(...STORM_FIRST), krakenT = null, whaleT = rr(...MONSTER_FIRST), monN = 1;
function addMonView(id, src) {
  const g = src.kind === 'kraken' ? makeKraken() : makeWhale(); g.position.set(src.x, src.y, src.z); scene.add(g);
  MONVIEW.set(id, { id, kind: src.kind, g, src, label: null, hpShown: -1, x: src.x, z: src.z, yaw: src.yaw, y: src.y, spoutT: 2, grabU: 0 });
}
function dropMonView(id) { const v = MONVIEW.get(id); if (!v) return; scene.remove(v.g); dropLabel(v.label); MONVIEW.delete(id); }
function updateMonViews(dt) {
  const k = Math.min(1, dt * (NET ? 10 : 30));
  for (const v of MONVIEW.values()) {
    const s = v.src; v.x += (s.x - v.x) * k; v.z += (s.z - v.z) * k; v.yaw += wrapAngle(s.yaw - v.yaw) * k; v.y += (s.y - v.y) * k;
    const g = v.g; g.position.set(v.x, v.y, v.z); g.rotation.y = v.yaw;
    // name and wounds float over it while it's up
    const up = v.y > -6 && s.mode !== 'sink';
    if (up && v.hpShown !== s.hp) { dropLabel(v.label); v.label = addLabel(`${MONSTERS[v.kind].name} ${'♥'.repeat(Math.ceil(s.hp / 2))}`, v.x, 26, v.z, 'home'); v.hpShown = s.hp; }
    if (!up && v.label) { dropLabel(v.label); v.label = null; v.hpShown = -1; }
    if (v.label) { v.label.sp.position.set(v.x, v.kind === 'kraken' ? 30 * KRAKEN_SIZE : 16, v.z); v.label.x = v.x; v.label.z = v.z; }
    if (v.kind === 'kraken') animateKraken(v, dt); else animateWhale(v, dt);
  }
}
const _tp = new V3();
function animateKraken(v, dt) {
  const g = v.g, s = v.src, grabbed = s.grab ? shipById(s.grab) : null;
  v.grabU = clamp(v.grabU + (grabbed ? dt * 1.5 : -dt), 0, 1);
  g.children[0].scale.y = 1.35 + Math.sin(time * 1.6) * 0.05;
  if (grabbed) { g.updateMatrixWorld(); _tp.set(grabbed.x, 2, grabbed.z); g.worldToLocal(_tp); }
  for (let t = 0; t < g.userData.tents.length; t++) {
    const T = g.userData.tents[t], n = T_SEGS, reach = grabbed && t < 6; // six grab the ship, two keep thrashing
    for (let j = 0; j < n; j++) {
      const u = j / (n - 1), a = T.a + Math.sin(time * 2 + u * 4 + t) * 0.25 * u;
      // free: arch up out of the water and curl
      let x = Math.cos(a) * (6 + u * 24), z = Math.sin(a) * (6 + u * 24), y = Math.sin(u * Math.PI) * (8 + 3 * Math.sin(time * 1.5 + t)) - 1 - u * 2 + Math.sin(time * 3 + u * 6 + t) * u * 2;
      if (reach && v.grabU > 0) { // wrap: a high arch from the head to a coil around the hull
        const bx = Math.cos(T.a) * 6, bz = Math.sin(T.a) * 6, along = (t - 2.5) * 3.4, ex = _tp.x + Math.cos(time * 3 + t + u * 9) * 3.5 * u, ez = _tp.z + along * 0.6 + Math.sin(time * 3 + t + u * 9) * 3.5 * u;
        const gx = lerp(bx, ex, u), gz = lerp(bz, ez, u), gy = Math.sin(u * Math.PI) * 18 + lerp(0, 3, u);
        x = lerp(x, gx, v.grabU); z = lerp(z, gz, v.grabU); y = lerp(y, gy, v.grabU);
      }
      T.pts[j].set(x, y, z);
    }
    shapeTentacle(T);
  }
}
function animateWhale(v, dt) {
  const u = v.g.userData, s = v.src, sp = s.speed || 0;
  u.tail.rotation.z = Math.sin(time * (2 + sp * 0.12)) * 0.3; u.tail.position.y = Math.sin(time * (2 + sp * 0.12) - 0.5) * 0.6;
  v.g.position.y = v.y - 1.4 + Math.sin(time * 1.2) * 0.3; v.g.rotation.z = Math.sin(time * 0.8) * 0.03;
  if (sp > 20 && R01() < dt * 20) spawnFoam(v.x + Math.cos(v.yaw) * 14, v.z - Math.sin(v.yaw) * 14); // bow wave when it charges
  // the blow: forward and to the left, as sperm whales do
  if (s.mode === 'hunt' && v.y > -2 && (v.spoutT -= dt) <= 0) { v.spoutT = rr(4, 7); fx.spout(v.x + Math.cos(v.yaw) * 14, v.z - Math.sin(v.yaw) * 14, 11, v.yaw, 0.75, -0.35); }
}
// a cannonball striking a monster: a splash of spray, a flash, and (the Kraken) a puff of ink
function monsterFx(m, x, y, z, mine) {
  fx.flash(x, y, z, 2.6); fx.splash(x, z);
  if (m.kind === 'kraken') fx.smoke(x, y, z, 5, '#3a1030', 2.2);
  if (mine) toast(['Right in the eye!', 'It roars!', 'Ka-BOOM!', 'Hit it!'][Math.floor(R01() * 4)], 1000);
}
// what a monster does to a ship: squeezes (the Kraken) or rams (the Whale)
function maulFx(m) {
  const s = shipById(m.ship); fx.hit(m.x, 2.5, m.z);
  if (NET && s && s.g) for (let k = 0; k < m.dmg; k++) scar(s, m.x + (R01() - 0.5) * 8, 2.5, m.z + (R01() - 0.5) * 8); // single-player scars come from damagePlayer / damageShip
  if (!isMe(m.ship)) return;
  shake = Math.min(1.4, shake + 1); SHIP.rollV += (R01() - 0.5) * (m.how === 'ram' ? 1.2 : 0.5);
  if (m.dmg) toast(m.how === 'ram' ? `The White Whale rammed us! (${m.dmg} hits)` : 'The Kraken squeezes the hull! Fire on it!', 1800);
}
// news of a monster: rising, grabbing, giving up, or beaten
function monsterNews(m) {
  const name = MONSTERS[m.kind].name, near = m.x == null || Math.hypot(m.x - SHIP.x, m.z - SHIP.z) < 1000;
  if (m.event === 'rise') toast(m.kind === 'kraken' ? (near ? 'The Kraken rises beneath the storm! Beware!' : 'The Kraken has risen beneath the storm!') : near ? `${name} has surfaced nearby! Beware!` : `${name} has been sighted in the islands!`, 3600);
  else if (m.event === 'grab' && isMe(m.ship)) toast("The Kraken's got us! Fire both broadsides!", 2600);
  else if (m.event === 'leave') toast(`${name} sinks back into the deep.`, 2200);
  else if (m.event === 'slain') { const it = name.replace(/^The /, 'the '); toast((isMe(m.by) ? `You drove off ${it}!` : `${nameOf(m.by)} drove off ${it}!`) + (m.kind === 'kraken' ? ' The storm is clearing.' : ''), 3200);
    const v = MONVIEW.get(m.id); if (v && !NET && isMe(m.by)) for (let k = 0; k < 12; k++) addCoin(v.x + (R01() - 0.5) * 50, v.z + (R01() - 0.5) * 50); } // single-player: it coughs up treasure
}
// a storm: where it is and how far it's grown in (online from the server's state)
function curStorm() {
  if (!NET) return soloStorm;
  const s = NET.room.state; return s.stormFade > 0 ? { x: s.stormX, z: s.stormZ, dir: s.stormDir, fade: s.stormFade } : null;
}
// which way something lies from the ship, in compass words
function bearingWords(x, z) { const b = (Math.atan2(x - SHIP.x, -(z - SHIP.z)) * 180 / Math.PI + 360) % 360; return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(b / 45) % 8]; }
function stormNews(m) {
  if (m.event === 'brew') toast(`A storm is brewing to the ${bearingWords(m.x, m.z)}. Something stirs beneath it…`, 4000);
  else if (m.event === 'gone') toast('The storm has passed.', 2000);
}
function updateSoloMonsters(dt) {
  if (MODE !== 'solo') return;
  // the storm brews, drifts, brings the Kraken at full strength, and clears when the Kraken is beaten (or in time)
  if (soloStorm) {
    const ev = stepStorm(soloStorm, dt);
    if (ev === 'full') krakenT = KRAKEN_AFTER;
    if (soloStorm.mode === 'clear' || ev === 'gone') for (const m of SOLO_MONS) if (m.kind === 'kraken' && m.mode !== 'sink' && m.mode !== 'gone') { dismissMonster(m); monsterNews({ id: m.id, kind: m.kind, event: 'leave' }); }
    if (ev === 'gone') { soloStorm = null; stormT = rr(...STORM_NEXT); krakenT = null; stormNews({ event: 'gone' }); }
  } else if (!SHIP.sinking && (stormT -= dt) <= 0) { soloStorm = newStorm(R01, [SHIP]); if (!soloStorm) stormT = 10; else stormNews({ event: 'brew', x: soloStorm.x, z: soloStorm.z }); }
  if (krakenT != null && (krakenT -= dt) <= 0) { krakenT = null; if (soloStorm && soloStorm.mode === 'full') raiseSoloMonster('kraken'); }
  // the White Whale on its own timer
  if (!SOLO_MONS.some(m => m.kind === 'whale') && !SHIP.sinking && (whaleT -= dt) <= 0) { whaleT = rr(...MONSTER_NEXT); raiseSoloMonster('whale'); }
  const afloat = [...(SHIP.sinking ? [] : [SHIP]), ...ENEMIES.filter(e => e.g && !e.sinking && !e.dead)];
  for (const mon of [...SOLO_MONS]) {
    stepMonster(mon, dt, afloat, {
      maul: (m, s, n, how) => { if (s === SHIP) damagePlayer(n, s.x, 2.5, s.z); else damageShip(s, s.x, 2.5, s.z, n, true); maulFx({ ship: s.id, how, dmg: n, x: s.x, z: s.z }); },
      grab: (m, s) => monsterNews({ id: m.id, kind: m.kind, event: 'grab', ship: s.id }),
      leave: m => monsterNews({ id: m.id, kind: m.kind, event: 'leave' }),
    }, mon.kind === 'kraken' ? soloStorm : null);
    if (mon.mode === 'gone') { dropMonView(mon.id); SOLO_MONS.splice(SOLO_MONS.indexOf(mon), 1); }
  }
}
function raiseSoloMonster(kind, x, z) {
  const spot = x != null ? [x, z] : kind === 'kraken' ? (soloStorm && stormSpot([SHIP], soloStorm, R01)) : monsterSpot([SHIP], R01, soloStorm);
  if (!spot) { if (kind === 'kraken') krakenT = 5; else whaleT = 10; return; } // try again shortly
  const m = Object.assign(newMonster(kind, spot[0], spot[1], R01), { id: `m${monN++}` }); SOLO_MONS.push(m); addMonView(m.id, m);
  monsterNews({ id: m.id, kind, event: 'rise', x: spot[0], z: spot[1] });
}

// ============================================================ weather: a cloud bank over every wind system, rain and lightning in the storm,
// wind streaks and whitecaps where it blows, and the wind on the compass
const WX = { clouds: [], stormG: null, stormClouds: [], curtains: [], dark: 0, boltT: 6, flash: 0, streaks: [], rain: null, bolt: null };
const wxTime = () => NET ? NET.t + (performance.now() - NET.tAt) / 1000 : time;
const RAIN_CURTAIN = (() => {
  const tex = canvasTex(64, 128, (c, w, h) => { c.clearRect(0, 0, w, h); for (let k = 0; k < 40; k++) { const x = Math.random() * w, y = Math.random() * h * 0.3, a = 0.15 + Math.random() * 0.35; c.strokeStyle = `rgba(90,98,112,${a})`; c.lineWidth = 1 + Math.random() * 2; c.beginPath(); c.moveTo(x, y); c.lineTo(x - 4, h); c.stroke(); } }, true);
  const geo = new THREE.CylinderGeometry(34, 44, 1, 14, 1, true); geo.translate(0, -0.5, 0); // hangs from the cloud (y = 0) down one unit; stretched to reach the sea
  return { geo, mat: new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }) };
})();
function makeCloud(storm) {
  const g = new THREE.Group(), mat = toon(storm ? '#6b717c' : '#ffffff'), n = storm ? 9 : 6, w = storm ? 60 : 38;
  for (let k = 0; k < n; k++) { const r = rr(12, 22) * (storm ? 1.3 : 1); const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat); m.position.set(rr(-w, w), rr(0, 10) - (storm ? 8 : 0), rr(-w * 0.6, w * 0.6)); m.scale.y = 0.6; m.castShadow = true; g.add(m); }
  if (storm) for (let k = 0; k < 4; k++) { const m = new THREE.Mesh(new THREE.SphereGeometry(rr(14, 20), 10, 8), toon('#4a4f59')); m.position.set(rr(-w, w), -14, rr(-w * 0.5, w * 0.5)); m.scale.y = 0.45; g.add(m); } // dark bellies
  if (storm) for (let k = 0; k < 3; k++) { // grey curtains of rain hanging down to the sea: you can see the squall from miles off
    const c = new THREE.Mesh(RAIN_CURTAIN.geo, RAIN_CURTAIN.mat); c.position.set(rr(-w * 0.7, w * 0.7), 0, rr(-w * 0.4, w * 0.4)); c.rotation.y = R01() * TAU; c.scale.set(rr(0.8, 1.3), 1, rr(0.8, 1.3)); c.renderOrder = 3; g.add(c); WX.curtains.push(c); }
  return g;
}
function buildWeather() {
  SYSTEMS.forEach((S, si) => { for (let k = 0; k < 4; k++) { const g = makeCloud(false); scene.add(g); const a = R01() * TAU, r = Math.sqrt(R01()) * S.r * 0.6;
    WX.clouds.push({ g, si, ox: Math.cos(a) * r, oz: Math.sin(a) * r, alt: rr(170, 230), ph: R01() * 6 }); } });
  // the storm's cloud bank (hidden until a storm brews); it follows the storm and swells as it grows in
  WX.stormG = new THREE.Group(); WX.stormG.visible = false; scene.add(WX.stormG);
  for (let k = 0; k < 7; k++) { const g = makeCloud(true), a = R01() * TAU, r = Math.sqrt(R01()) * STORM.r * 0.6, alt = rr(110, 140); g.position.set(Math.cos(a) * r, alt, Math.sin(a) * r); WX.stormG.add(g); WX.stormClouds.push({ g, alt, ph: R01() * 6 }); }
  // rain: short streaks falling around the camera, only drawn inside the storm
  const N = MOBILE ? 350 : 700, pos = new Float32Array(N * 6);
  WX.rain = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3)), new THREE.LineBasicMaterial({ color: '#dfe7f2', transparent: true, opacity: 0.6 }));
  WX.rain.frustumCulled = false; WX.rain.visible = false; WX.rain.userData.drops = Array.from({ length: N }, () => ({ x: rr(-120, 120), y: rr(0, 120), z: rr(-120, 120) })); scene.add(WX.rain);
  // lightning: a zigzag bolt from the cloud to the sea
  WX.bolt = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(10 * 3), 3)), new THREE.LineBasicMaterial({ color: '#fffbd0' }));
  WX.bolt.frustumCulled = false; WX.bolt.visible = false; scene.add(WX.bolt);
  // wind streaks: little curls of air riding the wind
  const curve = new THREE.CatmullRomCurve3([new V3(-8, 0, 0), new V3(-3, 0.6, 1), new V3(2, -0.3, -0.6), new V3(8, 0.4, 0.4)]), sg = new THREE.TubeGeometry(curve, 16, 0.22, 4);
  for (let k = 0; k < 28; k++) { const m = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false })); m.visible = false; m.renderOrder = 3; scene.add(m); WX.streaks.push({ m, life: 0, age: 1, vx: 0, vz: 0 }); }
}
const FOG_CLEAR = FOG_COLOR.clone(), FOG_STORM = new THREE.Color('#8e97a3'), windArrow = document.getElementById('windArrow'), windTag = document.getElementById('windTag'), compassEl = document.getElementById('compass');
let windShown = '';
function updateWeather(dt) {
  const T = wxTime();
  for (const c of WX.clouds) { const p = systemAt(SYSTEMS[c.si], T); c.g.position.set(p.x + c.ox, c.alt + Math.sin(time * 0.2 + c.ph) * 3, p.z + c.oz); }
  const S = curStorm(); WX.stormG.visible = !!S;
  if (S) { WX.stormG.position.set(S.x, 0, S.z); const f = 0.25 + 0.75 * S.fade;
    for (const c of WX.stormClouds) { c.g.scale.set(f, f, f); c.g.position.y = c.alt + Math.sin(time * 0.2 + c.ph) * 3; }
    RAIN_CURTAIN.mat.opacity = 0.8 * S.fade; }
  for (const c of WX.curtains) c.scale.y = c.parent.position.y / c.parent.scale.y; // rain reaches from the cloud to the water
  const w = windAt(SHIP.x, SHIP.z, T, S); SHIP.wind = w;
  // compass: a blue arrow the way the wind blows, turned with the view like the needle
  const kn = windKnots(w.kn), tag = kn ? `${kn} kn` : 'calm';
  compassEl.classList.toggle('windy', kn > 0); compassEl.classList.toggle('storm', w.storm > 0.3);
  if (tag !== windShown) { windShown = tag; windTag.textContent = w.storm > 0.3 ? `storm ${tag}` : tag; }
  if (kn) windArrow.style.transform = `rotate(${controls.getAzimuthalAngle() + Math.atan2(w.wx, -w.wz)}rad)`;
  // under the storm: darker light, grey fog, rain, lightning
  WX.dark = lerp(WX.dark, w.storm, Math.min(1, dt * 0.8)); const d = WX.dark;
  WX.flash = Math.max(0, WX.flash - dt * 4);
  hemi.intensity = 1.35 - 0.6 * d + WX.flash * 1.5; sun.intensity = 2.3 * (1 - 0.65 * d) + WX.flash * 2; scene.fog.color.copy(FOG_CLEAR).lerp(FOG_STORM, d * 0.8);
  scene.fog.far = lerp(24000, 5000, d); scene.fog.near = lerp(1800, 500, d);
  const R = WX.rain; R.visible = d > 0.05;
  if (R.visible) { R.material.opacity = 0.65 * d; const p = R.geometry.attributes.position, cx = controls.target.x, cz = controls.target.z, lean = 0.25;
    R.userData.drops.forEach((q, i) => { q.y -= dt * 160; if (q.y < 0) { q.y = 120; q.x = rr(-120, 120); q.z = rr(-120, 120); }
      p.setXYZ(i * 2, cx + q.x, q.y, cz + q.z); p.setXYZ(i * 2 + 1, cx + q.x + w.wx * lean, q.y - 5, cz + q.z + w.wz * lean); });
    p.needsUpdate = true; }
  WX.bolt.visible = WX.flash > 0.5;
  if (d > 0.3 && (WX.boltT -= dt) <= 0) { WX.boltT = rr(3, 9); WX.flash = 1;
    const a = R01() * TAU, r = rr(80, 300), bx = SHIP.x + Math.cos(a) * r, bz = SHIP.z + Math.sin(a) * r, p = WX.bolt.geometry.attributes.position;
    for (let k = 0; k < 10; k++) p.setXYZ(k, bx + (k ? rr(-9, 9) : 0) + k * 1.5, 130 - k * 14.4, bz + (k ? rr(-9, 9) : 0)); p.needsUpdate = true;
    fx.splash(bx + 13, bz); }
  // streaks and whitecaps near the ship, wherever the wind blows
  for (const st of WX.streaks) { if (st.age >= st.life) { st.m.visible = false; continue; } st.age += dt; const u = st.age / st.life;
    st.m.position.x += st.vx * dt; st.m.position.z += st.vz * dt; st.m.material.opacity = 0.7 * Math.sin(u * Math.PI); st.m.scale.x = 0.6 + u * 0.8; }
  const rate = 10 + 25 * d;
  if (R01() < dt * rate) { const a = R01() * TAU, r = rr(20, 260), x = SHIP.x + Math.cos(a) * r, z = SHIP.z + Math.sin(a) * r, ww = windAt(x, z, T, S);
    if (ww.kn > 0.3 && sdAt(x, z) < -4) {
      const st = WX.streaks.find(q => q.age >= q.life); if (st) { st.age = 0; st.life = rr(1.4, 2.4); st.vx = ww.wx * 5; st.vz = ww.wz * 5; st.m.visible = true; st.m.position.set(x, rr(3, 12), z); st.m.rotation.set(0, Math.atan2(-ww.wz, ww.wx), 0); }
      if (R01() < 0.3 + d * 0.6) spawnFoam(x, z); } }
}

// ============================================================ the harbor menu: sail solo, start a voyage, or join one by its code
const lobby = btn('lobby'), lobbyMsg = btn('lobbyMsg'), capName = btn('capName'), joinCode = btn('joinCode');
const cleanCode = v => String(v || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
function savedName() { try { return localStorage.getItem('klh-name') || ''; } catch (e) { return ''; } }
function saveName(n) { try { localStorage.setItem('klh-name', n); } catch (e) { } }
function showLobby(code) {
  capName.value = PARAMS.get('name') || savedName();
  if (code) { lobby.classList.add('invite'); joinCode.value = code; btn('lobbyTitle').textContent = `Join voyage ${code}`; }
  lobby.hidden = false; (code || !capName.value ? capName : btn('goSolo')).focus();
}
const lobbyBusy = on => { for (const id of ['goSolo', 'goNew', 'goJoin']) btn(id).disabled = on; };
function startSolo() {
  MODE = 'solo'; lobby.hidden = true; btn('soloRow').hidden = false; btn('stats').hidden = false;
  buildTreasure(); hud();
  for (const [k, kind] of FLEET.entries()) { const e = { id: `npc${k}`, kind }; ENEMIES.push(e); spawnEnemy(e); }
  labelHome(HIDEOUTS[0], 'Wold Cabin', 'home');
  toast('Ahoy! Treasure is buried under the X\'s: open the map, anchor off a beach, and go ashore. Tap the title for help.', 5000);
}
async function startOnline(code, name) {
  if (code && !/^[A-Z]{4}$/.test(code)) { lobbyMsg.textContent = 'A voyage code is 4 letters.'; joinCode.focus(); return; }
  name = (name || '').trim().slice(0, 20); if (name) saveName(name);
  lobbyBusy(true); lobbyMsg.textContent = code ? `Hailing voyage ${code}…` : 'Launching a new voyage…';
  try { await goOnline(code, name); }
  catch (err) {
    console.warn('Could not join a voyage', err); NET = null; lobbyBusy(false); lobby.hidden = false;
    lobbyMsg.textContent = /not found|invalid/i.test(err && err.message) ? `No voyage called ${code}. Check the code with your crew.` : /full|locked/i.test(err && err.message) ? `Voyage ${code} is full (8 ships).` : "Couldn't reach the game server. Try again in a moment.";
    return;
  }
  MODE = 'online'; lobby.hidden = true; lobbyBusy(false);
  history.replaceState(null, '', `${location.pathname}?v=${NET.code}`); // the address is now the invite link
  btn('stats').hidden = false; btn('voyageRow').hidden = false; btn('vCode').textContent = NET.code;
  [SHIP.x, SHIP.z, SHIP.yaw] = [NET.st.x, NET.st.z, NET.st.yaw]; btn('bAnchor').classList.add('on'); hud();
  const others = [...RIVALS.values()].filter(r => r.kind === 'pirate').length;
  toast(others ? `Aboard voyage ${NET.code} with ${others} other ship${others > 1 ? 's' : ''}. Your hideout: ${HOMES[NET.st.home].name}.` : `Voyage ${NET.code} is yours. Share the code (tap the title) so friends can join!`, 5000);
}
btn('goSolo').onclick = () => { const n = capName.value.trim(); if (n) saveName(n); startSolo(); };
btn('goNew').onclick = () => startOnline(null, capName.value);
btn('goJoin').onclick = () => startOnline(cleanCode(joinCode.value), capName.value);
joinCode.addEventListener('input', () => { joinCode.value = cleanCode(joinCode.value); lobbyMsg.textContent = ''; });
joinCode.addEventListener('keydown', e => { if (e.key === 'Enter') btn('goJoin').click(); });
capName.addEventListener('keydown', e => { if (e.key === 'Enter') (lobby.classList.contains('invite') ? btn('goJoin') : btn('goSolo')).click(); });
const inviteUrl = () => `${location.origin}${location.pathname}?v=${NET ? NET.code : ''}`;
btn('copyLink').onclick = async () => { try { await navigator.clipboard.writeText(inviteUrl()); toast('Invite link copied. Send it to your crew!', 2200); } catch (e) { toast(inviteUrl(), 6000); } };
btn('leave').onclick = () => { location.href = location.pathname; };
btn('toMenu').onclick = () => { location.href = location.pathname; };
function chooseMode() {
  const code = cleanCode(PARAMS.get('v'));
  if (PARAMS.has('solo')) return startSolo();
  if ((PARAMS.has('new') || code) && PARAMS.get('name')) return startOnline(code || null, PARAMS.get('name')).then(() => { if (!NET) showLobby(code); }); // links for testing
  showLobby(code);
}

// ============================================================ main + animation
async function main() {
  try { await Promise.race([Promise.all([document.fonts.load("60px 'Pirata One'"), document.fonts.load('60px Bangers')]), new Promise(r => setTimeout(r, 2500))]); } catch (e) { }
  setStatus('charting the islands'); await nextFrame(); buildWorld();
  setStatus('raising the land'); await nextFrame(); buildTerrain(); buildSea(); buildHorizon(); buildNav();
  setStatus('building Roche Harbor'); await nextFrame(); reserveHomes(); buildCabin(0); buildLandmarks(); buildTowns();
  setStatus('planting firs & madrones'); await nextFrame(); buildTrees();
  setStatus('waking the orcas'); await nextFrame(); buildBoats(); buildWildlife(); buildEagles(); buildGulls(); buildLabels(); buildWeather();
  labelHome(HIDEOUTS[0], 'Wold Cabin', 'place');
  // moored off Wold Cabin while you choose, bow pointing out of Open Bay
  CABIN = HIDEOUTS[0]; SHIP.g = makeShip(); scene.add(SHIP.g); [SHIP.x, SHIP.z] = [CABIN.wx, CABIN.wz]; SHIP.yaw = seawardYaw(SHIP.x, SHIP.z);
  controls.target.set(SHIP.x, 6, SHIP.z); camera.position.set(SHIP.x + 60, 50, SHIP.z - 90); controls.update();
  btn('bAnchor').classList.add('on'); MYVIEW = avatarView('#b8322a'); hud();
  document.getElementById('loading').style.opacity = '0'; setTimeout(() => document.getElementById('loading').remove(), 700);
  renderer.setAnimationLoop(tick);
  if (PARAMS.has('debug')) window.__klh = { SHIP, RIVALS, MONVIEW, ENEMIES, tick, raise: (kind, x, z) => raiseSoloMonster(kind, x, z), storm: (x, z) => { soloStorm = Object.assign(newStorm(R01, []), x != null ? { x, z } : {}); return soloStorm; }, get net() { return NET; }, get mons() { return SOLO_MONS; }, get storm_() { return soloStorm; }, CAP, SOLO_CHESTS, XMARKS, goTo, goAshore, goBack, doDig, doShoot, setMap, camera, controls };
  chooseMode();
}

const clock = new THREE.Clock(), foam = [], needle = document.getElementById('needle'), logEl = document.getElementById('log'), spdEl = document.getElementById('spd');
let time = 0, foamT = 0;
const foamGeo = new THREE.CircleGeometry(1, 12); foamGeo.rotateX(-Math.PI / 2);
function spawnFoam(x, z) {
  let f = foam.find(q => q.age >= q.life);
  if (!f) { if (foam.length > 120) return; f = { m: new THREE.Mesh(foamGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false })) }; f.m.renderOrder = 2; scene.add(f.m); foam.push(f); }
  f.age = 0; f.life = 2.6; f.m.position.set(x, 0.25, z); f.m.visible = true;
}
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
function updateShip(dt) {
  const s = SHIP;
  if (s.sinking) { // heel over, settle, and go under; then a fresh ship at the hideout
    s.sinkT += dt; s.listT = lerp(s.listT, s.listDir * 1.2, dt * 0.35); s.y -= dt * (0.4 + s.sinkT * 0.2);
    if (s.y < -40) s.g.visible = false; // gone to the bottom: a fresh ship comes when you row home
  }
  if (NET && NET.st) {
    // online: the server sails the ship; glide toward where it says we are
    const st = NET.st, k = Math.min(1, dt * 10), dyaw = wrapAngle(st.yaw - s.yaw);
    if (st.launches !== NET.launches) { if (NET.launches != null) netRespawn({ ship: NET.me }); NET.launches = st.launches; }
    if (st.sinking && !s.sinking) { s.sinking = true; s.sinkT = 0; }
    s.x += (st.x - s.x) * k; s.z += (st.z - s.z) * k; s.yaw += dyaw * k; s.speed = st.speed; s.turn = clamp(dyaw * 6, -1, 1); s.boost = st.boost;
    if (s.path.length > 1 && Math.hypot(s.path[0][0] - s.x, s.path[0][1] - s.z) < 22) { s.path.shift(); drawCourse(); }
    if (s.path.length && s.wasSailing && !st.sailing) { s.path = []; s.goal = null; marker.visible = false; drawCourse(); toast('Arrived, captain!', 1400); }
    s.wasSailing = st.sailing;
  } else {
    const ev = stepShip(s, dt, s.sinking, s.wind); // single-player: sail here, with the same code the server runs
    if (ev) { drawCourse(); if (ev === 'arrived') { marker.visible = false; toast('Arrived, captain!', 1400); } }
  }
  const b = s.g.userData.body;
  s.g.position.set(s.x, 0.35 + s.y + Math.sin(time * 1.3) * 0.25, s.z); s.g.rotation.y = s.yaw;
  s.list = lerp(s.list, s.listT + (s.sinking ? 0 : woundList(s, s.hp, s.maxHp)), Math.min(1, dt * 1.5)); emitFires(s, dt);
  // broadside recoil: a damped spring rolls the hull and rocks it back and forth
  s.rollV += (-7 * s.rollA - 1.1 * s.rollV) * dt; s.rollA += s.rollV * dt;
  b.rotation.x = Math.sin(time * 0.9) * 0.045 - s.turn * 0.07 * clamp(s.speed / 10, 0, 1) + s.rollA + s.list; b.rotation.z = Math.sin(time * 1.1 + 1) * 0.02 + Math.abs(s.rollA) * 0.15;
  for (const sl of s.g.userData.sails) sl.scale.x = 0.35 + 0.65 * clamp(s.speed / MAX_SPEED + 0.2, 0, 1);
  s.g.userData.flag.rotation.y = Math.sin(time * 3) * 0.2;
  foamT += dt; if (s.speed > 3 && foamT > 0.07) { foamT = 0; const k = 1.5 * 6.8; for (const sd of [-1, 1]) spawnFoam(s.x - Math.cos(s.yaw) * k + Math.sin(s.yaw) * sd * 2.5, s.z + Math.sin(s.yaw) * k + Math.cos(s.yaw) * sd * 2.5); }
  const hearts = '♥'.repeat(Math.max(0, CAP.hearts));
  if (CAP.mode === 'dinghy') spdEl.textContent = `Rowing ${hearts}`; else if (CAP.mode === 'shore') spdEl.textContent = `${CAP.dig ? 'Digging' : CAP.marooned ? 'Marooned' : 'Ashore'} ${hearts}`; else if (CAP.mode === 'lost') spdEl.textContent = 'Overboard!';
  else spdEl.textContent = s.sinking ? 'Sinking!' : s.speed > 0.5 ? `${Math.max(0, Math.round(groundSpeed(s, s.wind) * 0.42))} kn` : s.anchored ? 'Anchored' : 'Holding';
  const full = !!s.boost && !s.sinking; if (full && !logEl.classList.contains('boost')) toast('Full sail! +2 knots', 1400); logEl.classList.toggle('boost', full);
}
// the bottom buttons say what they'll do for what you are: a ship's broadsides, or off the ship a spade and a pistol
let btnKey = '', btnOff = false;
function updateButtons(dt) {
  for (const sd of [PORT, STARBOARD]) reload[sd] = Math.max(0, reload[sd] - dt);
  const m = CAP.mode, near = m === 'shore' && !CAP.carry && !!nearestChest(CAP, chestList()), key = `${m}|${near}|${SHIP.sinking}`;
  if (key !== btnKey) { btnKey = key;
    const face = (id, arr, big, small, cls, label) => { const f = btn(id); f.innerHTML = `<span class="arr" aria-hidden="true">${arr}</span>${big}<small>${small}</small>`; f.className = `fire ${cls}`; f.setAttribute('aria-label', label); };
    if (m === 'shore') { face('firePort', '⛏', 'DIG', near ? 'HERE!' : 'FIND AN X', `dig ${near ? '' : 'off'}`, 'Dig for treasure'); face('fireStar', '✹', 'FIRE', 'PISTOL', '', 'Fire the pistol straight ahead'); }
    else if (m === 'dinghy') { face('firePort', '◀', 'FIRE', 'PORT', 'off', 'Broadsides only from the ship'); face('fireStar', '✹', 'FIRE', 'PISTOL', '', 'Fire the pistol straight ahead'); }
    else { face('firePort', '◀', 'FIRE', 'PORT', m === 'ship' ? '' : 'off', 'Fire port broadside'); face('fireStar', '▶', 'FIRE', 'STARBOARD', m === 'ship' ? '' : 'off', 'Fire starboard broadside'); }
    btn('ashoreLbl').textContent = m === 'ship' ? 'Ashore' : m === 'dinghy' ? (SHIP.sinking ? 'Home' : 'Board') : m === 'shore' ? 'Back' : '…';
    btn('bAshore').setAttribute('aria-label', { ship: 'Go ashore in the dinghy', dinghy: SHIP.sinking ? 'Row home' : 'Row back to the ship', shore: 'Walk back to the dinghy' }[m] || 'Waiting for the crew');
    btn('bAnchor').setAttribute('aria-disabled', m === 'ship' ? 'false' : 'true');
    const off = m === 'dinghy' || m === 'shore'; if (off !== btnOff) { btnOff = off; zoomTo = (off ? ZOOMS_SHORE : ZOOMS)[zoomLevel].d; } // a closer camera off the ship
  }
  // reload rings: broadsides on the ship; the spade's progress and the pistol's reload off it
  const ring = (id, p) => { const f = btn(id); f.style.setProperty('--p', clamp(p, 0, 1).toFixed(3)); };
  if (m === 'shore' || m === 'dinghy') { ring('firePort', CAP.dig ? (NET ? 0.5 : CAP.digT / DIG_S) : 1); ring('fireStar', 1 - CAP.reload / PISTOL_RELOAD); }
  else { ring('firePort', 1 - reload[PORT] / RELOAD); ring('fireStar', 1 - reload[STARBOARD] / RELOAD); }
  btn('firePort').setAttribute('aria-disabled', m === 'ship' ? String(reload[PORT] > 0) : m === 'shore' ? String(!near) : 'true');
  btn('fireStar').setAttribute('aria-disabled', m === 'ship' ? String(reload[STARBOARD] > 0) : m === 'shore' || m === 'dinghy' ? String(CAP.reload > 0) : 'true');
  btn('bAshore').setAttribute('aria-disabled', m === 'ship' ? String(SHIP.sinking || SHIP.speed > 3) : m === 'lost' ? 'true' : 'false');
}
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05); time += dt;
  if (waterTex) { waterTex.offset.x = time * 0.004; waterTex.offset.y = Math.sin(time * 0.3) * 0.01; }
  updateWeather(dt); updateShip(dt); updateRivals(dt); updateNetBalls(dt);
  updateBalls(dt); updateEnemies(dt); updateSoloMonsters(dt); updateMonViews(dt); collideShips(dt); updateCaptain(dt); updateLoot(dt); updateParts(dt);
  updateButtons(dt);
  for (const f of foam) if (f.age < f.life) { f.age += dt; const u = f.age / f.life; f.m.scale.setScalar(0.8 + u * 3.2); f.m.material.opacity = 0.75 * (1 - u); if (u >= 1) f.m.visible = false; }
  if (courseLine) { const p = courseLine.geometry.attributes.position; p.setXYZ(0, SHIP.x, 0.6, SHIP.z); p.needsUpdate = true; courseLine.computeLineDistances(); } // course starts at the bow
  if (marker.visible) { const p = 1 + Math.sin(time * 4) * 0.12; marker.scale.set(p, 1, p); marker.rotation.y = time * 0.5; }
  for (const f of ANIM) f(time);
  for (const b of SAILBOATS) { b.g.position.y = Math.sin(time * 1.4 + b.ph) * 0.15; b.g.rotation.z = Math.sin(time * 1.1 + b.ph) * 0.04; }
  for (const c of CRUISERS) { c.a += c.w * dt; const s = Math.sign(c.w), x = c.cx + Math.cos(c.a) * c.r, z = c.cz + Math.sin(c.a) * c.r * 1.6; c.g.position.set(x, Math.sin(time + c.a) * 0.15, z); c.g.rotation.set(0, Math.atan2(-(Math.cos(c.a) * c.r * 1.6 * s), -Math.sin(c.a) * c.r * s), 0.12 * s); }
  // orcas: the pod swims a long loop up and down the strait, each one arcing out of the water in turn
  // orcas cruise at about 10 knots (24 units/s along the strait) and blow a spout each time they surface
  for (const o of ORCAS) { const u = (time * 0.0026 + 0.1) % 1, a = u * TAU, cx = -1250 + Math.sin(a) * 100, cz = 300 + Math.cos(a) * 1500;
    const hx = Math.cos(a) * 100, hz = -Math.sin(a) * 1500, l = Math.hypot(hx, hz), yaw = Math.atan2(-hz / l, hx / l);
    const cyc = (time * 0.3 + o.ph) % 3, surf = cyc < 1 ? Math.sin(cyc * Math.PI) : 0;
    const ox = cx - hz / l * o.lane - hx / l * o.lag, oz = cz + hx / l * o.lane - hz / l * o.lag;
    o.g.position.set(ox, -3.2 + surf * 3.6, oz); o.g.rotation.set(0, yaw, 0); o.g.rotateZ(Math.cos(cyc * Math.PI) * 0.35 * (cyc < 1 ? 1 : 0)); o.g.scale.setScalar(1.3 * o.big);
    if (cyc > 0.32 && cyc < 0.6 && !o.blew) { o.blew = true; fx.spout(ox + hx / l * 3.4 * o.big, oz + hz / l * 3.4 * o.big, 7 * o.big); }
    if (cyc > 1.2) o.blew = false; }
  updateGulls(dt);
  for (const e of EAGLES) { e.a += e.w * dt; e.t += dt; const x = e.cx + Math.cos(e.a) * e.r, z = e.cz + Math.sin(e.a) * e.r, s = Math.sign(e.w);
    e.g.position.set(x, e.alt + Math.sin(e.t * 0.3) * 10, z); e.g.rotation.set(0, Math.atan2(-Math.cos(e.a) * s, -Math.sin(e.a) * s), 0); e.g.rotateX(-0.35 * s);
    const fl = Math.sin(e.t * 0.4) > 0.6; for (const w of e.g.userData.wings) w.p.rotation.x = w.s * (fl ? Math.sin(e.t * 9) * 0.55 : 0.08); }

  // camera stays centred on the ship every frame, keeping whatever angle and zoom the player chose
  camera.position.sub(shakeOff); // take last frame's shake out before re-centring, so it never accumulates
  const focus = CAP.mode === 'dinghy' || CAP.mode === 'shore' ? [CAP.x, Math.max(0, heightAt(CAP.x, CAP.z)) + 3, CAP.z] : [SHIP.x, 6, SHIP.z];
  const off = camera.position.clone().sub(controls.target); controls.target.set(...focus);
  if (zoomTo != null) { const L = off.length(), n = lerp(L, zoomTo, Math.min(1, dt * 5)); off.setLength(n); if (Math.abs(n - zoomTo) < 0.5) zoomTo = null; } // glide to the chosen zoom
  camera.position.copy(controls.target).add(off);
  controls.update();
  shake = Math.max(0, shake - dt * 2.2); const sk = shake * shake * 0.9; shakeOff.set((R01() - 0.5) * sk, (R01() - 0.5) * sk, (R01() - 0.5) * sk); camera.position.add(shakeOff);
  const floor = Math.max(heightAt(camera.position.x, camera.position.z), 0) + 3; if (camera.position.y < floor) camera.position.y = floor;
  needle.style.transform = `rotate(${controls.getAzimuthalAngle()}rad)`;
  const dist = camera.position.distanceTo(controls.target), Sd = clamp(dist * 0.95, 70, 1400), sc = sun.shadow.camera;
  sc.left = -Sd; sc.right = Sd; sc.top = Sd; sc.bottom = -Sd; sc.updateProjectionMatrix();
  sun.position.copy(controls.target).addScaledVector(SUN_DIR, 1600); sun.target.position.copy(controls.target); sun.target.updateMatrixWorld(); sun.shadow.normalBias = Sd * 0.0016;
  sunDisc.lookAt(camera.position); declutterLabels();
  renderer.shadowMap.needsUpdate = true;
  renderer.setRenderTarget(rtColor); renderer.render(scene, camera);
  // rain, lightning and wind streaks stay out of the outline pass, or the ink turns them into black scribbles
  const noInk = [WX.rain, WX.bolt, ...WX.streaks.map(q => q.m), ...WX.curtains, MYXRAY && MYXRAY.ghost].filter(o => o && o.visible); for (const o of noInk) o.visible = false;
  scene.overrideMaterial = normalMat; const fog = scene.fog; scene.fog = null; renderer.setRenderTarget(rtNormal); renderer.render(scene, camera); scene.overrideMaterial = null; scene.fog = fog;
  for (const o of noInk) o.visible = true;
  renderer.setRenderTarget(null); renderer.render(postScene, postCam);
  renderer.autoClear = false; renderer.clearDepth(); renderer.render(labelScene, camera); renderer.autoClear = true;
}
main().catch(err => { const el = document.getElementById('err'); el.style.display = 'block'; el.textContent = 'Error: ' + err.message; console.error(err); });
