// Test av web/js/planet.js — ren matematik, körs i Node.
// Kör: cd /Users/andersbj/Projekt/3dworldtext && node tools/test_planet.mjs

import {
  BANDS, FOV_Y, bandDistance, makeProjection, makeView, Journey,
} from '../web/js/planet.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

// Kolumn-major mat4 × vec4
function mulVec(m, v) {
  const out = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) {
    out[r] = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3];
  }
  return out;
}
function hasNaN(m) { return Array.from(m).some((x) => Number.isNaN(x)); }

// --- bandDistance mot CONTRACT-tabellen (6.0, 11.4, 21.7, 41.2, 78.3) ---
const table = [6.0, 11.4, 21.7, 41.2, 78.3];
const dists = [0, 1, 2, 3, 4].map(bandDistance);
console.log('bandDistance:', dists.map((d) => d.toFixed(3)).join(', '));
for (let b = 0; b < 5; b++) {
  check(`bandDistance(${b}) ≈ ${table[b]}`, Math.abs(dists[b] - table[b]) < 0.15,
    `fick ${dists[b].toFixed(4)}`);
}
check('BANDS-konstanter', BANDS.D0 === 6.0 && BANDS.F === 1.9 && BANDS.COUNT === 5);
check('FOV_Y = 55°', Math.abs(FOV_Y - 55 * Math.PI / 180) < 1e-12);

// --- Projektion ---
const aspect = 16 / 9;
const proj = makeProjection(aspect);
check('proj utan NaN', !hasNaN(proj));

const clip = mulVec(proj, [0, 0, -10, 1]);
const depth10 = clip[2] / clip[3];
check('z=-10: w > 0', clip[3] > 0, `w=${clip[3].toFixed(4)}`);
check('z=-10: djup i 0..1', depth10 >= 0 && depth10 <= 1, `depth=${depth10.toFixed(5)}`);

const nearClip = mulVec(proj, [0, 0, -0.1, 1]);
const farClip = mulVec(proj, [0, 0, -400, 1]);
check('nära-plan → djup ≈ 0', Math.abs(nearClip[2] / nearClip[3]) < 1e-5);
check('fjärr-plan → djup ≈ 1', Math.abs(farClip[2] / farClip[3] - 1) < 1e-5);

// Frustumkant: x = d·tan(fov/2)·aspect vid z=-d ska ge ndc.x ≈ 1
const d0 = bandDistance(0);
const edge = mulVec(proj, [d0 * Math.tan(FOV_Y / 2) * aspect, 0, -d0, 1]);
check('frustumkant → ndc.x ≈ 1', Math.abs(edge[0] / edge[3] - 1) < 1e-5,
  `ndc.x=${(edge[0] / edge[3]).toFixed(6)}`);

// --- Vy-matris ---
const viewId = makeView({ yaw: 0, pitch: 0, swayX: 0, swayY: 0, bobY: 0 });
const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
check('vilokamera → identitet', ident.every((v, i) => Math.abs(viewId[i] - v) < 1e-7));

const view = makeView({ yaw: 0.3, pitch: -0.1, swayX: 0.2, swayY: 0.05, bobY: 0.02 });
check('view utan NaN', !hasNaN(view));

// Punkt rakt framför roterad kamera ska hamna på -Z i vy-rymd:
// kamerans framåt i världen = Ry(yaw)Rx(pitch)·(0,0,-1)
const yaw = 0.3, pitch = -0.1;
const fwd = [
  -Math.cos(pitch) * Math.sin(yaw) * 10 + 0.2,
  Math.sin(pitch) * 10 + 0.07,
  -Math.cos(pitch) * Math.cos(yaw) * 10,
];
const vp = mulVec(view, [...fwd, 1]);
check('punkt längs blickriktningen → (0,0,-10) i vy-rymd',
  Math.abs(vp[0]) < 1e-5 && Math.abs(vp[1]) < 1e-5 && Math.abs(vp[2] + 10) < 1e-5,
  `fick (${vp[0].toFixed(6)}, ${vp[1].toFixed(6)}, ${vp[2].toFixed(6)})`);

// proj·view på en bandpunkt: inga NaN, w > 0
const pv = mulVec(proj, mulVec(view, [0, 0, -bandDistance(2), 1]));
check('proj·view på band 2: djup i 0..1 och w>0',
  pv[3] > 0 && pv[2] / pv[3] >= 0 && pv[2] / pv[3] <= 1,
  `depth=${(pv[2] / pv[3]).toFixed(5)}`);

// --- Journey ---
const j = new Journey();
j.setStations(3);
const dt = 1 / 60;
let maxSpeed = 0;
let posOk = true;
let travelled = 0;
for (let i = 0; i < 60 * 60; i++) { // 60 simulerade sekunder, full gas
  const { pos, speed } = j.update(dt, 1);
  maxSpeed = Math.max(maxSpeed, speed);
  travelled += speed * dt;
  if (pos < 0 || pos >= 3) posOk = false;
}
check('60 s gas: fart når taket 0.45', Math.abs(maxSpeed - 0.45) < 1e-9,
  `maxfart=${maxSpeed.toFixed(5)}`);
check('60 s gas: fart aldrig över 0.45', maxSpeed <= 0.45 + 1e-12);
check('pos loopar inom [0,3)', posOk, `pos=${j.pos.toFixed(4)}`);
// 60 s × 0.45 = 27 stationer max, minus uppstartsramp → ska ha loopat många varv
check('har färdats > 8 varv (24 stationer)', travelled > 24 && posOk,
  `färdats ${travelled.toFixed(2)} stationer = ${(travelled / 3).toFixed(1)} varv, slutpos=${j.pos.toFixed(3)}`);

// Segment-geometri
j.pos = 2.75;
let seg = j.segment;
check('segment vid pos 2.75 → {a:2, b:0, t:0.75}',
  seg.a === 2 && seg.b === 0 && Math.abs(seg.t - 0.75) < 1e-12,
  JSON.stringify(seg));

// Gas släpps → glider till stopp
let stopped = -1;
for (let i = 0; i < 30 * 60; i++) {
  const { speed } = j.update(dt, 0);
  if (speed === 0) { stopped = i * dt; break; }
}
check('gas 0 → glider till exakt stopp', stopped >= 0, `stannade efter ${stopped.toFixed(2)} s`);
check('står still: fart = 0', j.update(dt, 0).speed === 0);

// Back: negativ throttle ger negativ fart, pos wrappar under 0
const jb = new Journey();
jb.setStations(3);
for (let i = 0; i < 5 * 60; i++) jb.update(dt, -1);
check('back: fart negativ, capped ≥ -0.45',
  jb.speed < 0 && jb.speed >= -0.45, `fart=${jb.speed.toFixed(4)}`);
check('back: pos wrappar till [0,3)', jb.pos >= 0 && jb.pos < 3, `pos=${jb.pos.toFixed(4)}`);

// En station
const j1 = new Journey();
j1.setStations(1);
j1.update(dt, 1);
seg = j1.segment;
check('stations=1 → segment {a:0,b:0,t:0}',
  seg.a === 0 && seg.b === 0 && seg.t === 0, JSON.stringify(seg));

console.log(failures === 0 ? '\nAlla test gröna.' : `\n${failures} test FALLERADE.`);
process.exit(failures === 0 ? 0 : 1);
