// morph.js — formmatchning A<->B och byggande av GPU-färdig morph-vertexdata.
// Se CONTRACT.md: vertexformat 32 byte/vertex (posA, posB f32x2; colorA,
// colorB unorm8x4; bandA, bandB f32), uint32-index förhandssorterade
// bakifrån-och-fram.

import { resampleRing, triangulateRing } from './tess.js';

// Duotone-fallback för scener utan rgb-fält (äldre gråskale-scener): samma
// tusch/papper-konstanter som tidigare låg i fragmentshadern — utseendet för
// gamla scener är exakt oförändrat.
const INK = [0.05, 0.055, 0.08];
const PAPER = [0.985, 0.975, 0.945];

// Formens flata färg som RGBA-packad u32 (little-endian: r | g<<8 | b<<16).
function packColor(s) {
  let r, g, b;
  if (s.rgb) {
    [r, g, b] = s.rgb;
  } else {
    const t = s.grey / 255;
    r = Math.round((INK[0] + (PAPER[0] - INK[0]) * t) * 255);
    g = Math.round((INK[1] + (PAPER[1] - INK[1]) * t) * 255);
    b = Math.round((INK[2] + (PAPER[2] - INK[2]) * t) * 255);
  }
  return (r | (g << 8) | (b << 16) | (255 << 24)) >>> 0;
}

const W_CENTROID = 1.0;
const W_AREA = 0.7;
const W_GREY = 0.5;
const W_BAND = 0.6;
const COST_LIMIT = 2.0;
const BAND_DIFF_MAX = 1.2; // matcha aldrig former långt isär i djup
const N_MIN = 24;
const N_MAX = 160;

// Djup = målarordning. vtracer stacked är back-to-front-kompositering, så den
// enda vilokorrekta djupordningen är målarordningen själv (först målad = längst
// bort). Semantiskt "fjärrfält" (himmel/galaxer, morphar i stället för att
// världsförankras) kodas som bandF ∈ [3.5, 4]; världsinnehåll som [0, 3.5).
// Pythons bbox-band används INTE för djup (bbox-botten felar för himmel/mark
// som spänner över hela bilden).
function classify(scene) {
  const shapes = scene.shapes;
  const n = shapes.length;
  const W = scene.width, H = scene.height;
  return shapes.map((s, i) => {
    // Massiv scenstruktur (himmel, golv, kanjonväggar — allt > 8 % av bilden)
    // morphar kameraförankrat; bara detaljer (bokstäver ≈5 %, stenar, blommor)
    // världsförankras och flyger förbi. Bokstavskroppar ligger under tröskeln.
    const isFar = i === 0
      || s.area > 0.08 * W * H
      || s.bbox[3] < 0.48 * H; // helt ovan horisonten (galaxer, stjärnor)
    const p = n > 1 ? 1 - i / (n - 1) : 1; // 1 = först målad (bakerst)
    // Världsinnehåll komprimeras till band 0..2.8 (d 6..36) så att allt hinner
    // passera i god tid före ankomsten; fjärrfältet ligger på 3.5..4 (d 56..78).
    const bandF = isFar ? 3.5 + 0.5 * p : 2.8 * p;
    return { isFar, bandF };
  });
}

function ringPointCount(area) {
  return Math.min(N_MAX, Math.max(N_MIN, Math.round(Math.sqrt(area) / 3)));
}

function features(shapes, cls) {
  const n = shapes.length;
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  const logArea = new Float64Array(n);
  const grey = new Float64Array(n);
  const band = new Float64Array(n);
  const far = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const s = shapes[i];
    cx[i] = s.centroid[0];
    cy[i] = s.centroid[1];
    logArea[i] = Math.log(Math.max(s.area, 1e-6));
    grey[i] = s.grey;
    band[i] = cls[i].bandF;
    far[i] = cls[i].isFar ? 1 : 0;
  }
  return { cx, cy, logArea, grey, band, far };
}

// Normaliserad rymd per CONTRACT: xn i ±aspekt, yn i ±1 (uppåt positiv).
// Varje scen använder sin EGEN width/height/aspekt.
function makeNorm(scene) {
  const w = scene.width;
  const h = scene.height;
  const aspect = w / h;
  return {
    x: (x) => (x / w - 0.5) * 2 * aspect,
    y: (y) => (0.5 - y / h) * 2,
  };
}

// Greedy matchning: kostnad för alla A×B-par, ta lägsta först där båda sidor
// är omatchade och kostnaden < COST_LIMIT. diag = diagonalen av scen A.
function matchShapes(fa, fb, diag) {
  const nA = fa.cx.length;
  const nB = fb.cx.length;
  const costs = new Float64Array(nA * nB);
  const cand = [];
  for (let i = 0; i < nA; i++) {
    const cxi = fa.cx[i], cyi = fa.cy[i];
    const lai = fa.logArea[i], gi = fa.grey[i], bi = fa.band[i];
    const row = i * nB;
    for (let j = 0; j < nB; j++) {
      const bandDiff = Math.abs(bi - fb.band[j]);
      if (bandDiff > BAND_DIFF_MAX || fa.far[i] !== fb.far[j]) {
        costs[row + j] = Infinity; continue;
      }
      const dx = cxi - fb.cx[j];
      const dy = cyi - fb.cy[j];
      const c = W_CENTROID * Math.sqrt(dx * dx + dy * dy) / diag
              + W_AREA * Math.abs(lai - fb.logArea[j])
              + W_GREY * Math.abs(gi - fb.grey[j]) / 255
              + W_BAND * bandDiff;
      costs[row + j] = c;
      if (c < COST_LIMIT) cand.push(row + j);
    }
  }
  cand.sort((p, q) => costs[p] - costs[q]);

  const matchA = new Int32Array(nA).fill(-1);
  const matchB = new Int32Array(nB).fill(-1);
  for (let k = 0; k < cand.length; k++) {
    const pid = cand[k];
    const i = (pid / nB) | 0;
    const j = pid % nB;
    if (matchA[i] < 0 && matchB[j] < 0) {
      matchA[i] = j;
      matchB[j] = i;
    }
  }
  return { matchA, matchB };
}

// Bygger morph-mesh mellan två scene JSON. Returnerar:
// {
//   vertexData: Float32Array (vertexCount*8) — [ax,ay,bx,by,colorA(u32),
//               colorB(u32),bandA,bandB]; färgslottarna skrivs via en
//               Uint32Array-vy över samma buffert (unorm8x4 i pipelinen)
//   indexData:  Uint32Array — ETT draw-call; chunk-sorterad efter max(bandA,bandB)
//               fallande, därefter ursprunglig målarordning stigande
//   drawOrder:  [{firstIndex, indexCount, band, kind, a, b, paint}] i indexordning,
//               kind: 'matched' | 'collapse' | 'grow'
// }
export function buildMorphMesh(sceneA, sceneB) {
  const shA = sceneA.shapes;
  const shB = sceneB.shapes;
  const clsA = classify(sceneA);
  const clsB = classify(sceneB);
  const fa = features(shA, clsA);
  const fb = features(shB, clsB);
  const diag = Math.hypot(sceneA.width, sceneA.height);
  const { matchA, matchB } = matchShapes(fa, fb, diag);
  const normA = makeNorm(sceneA);
  const normB = makeNorm(sceneB);

  // Jobblista: A-former i målarordning (matchade + kollapsande), sedan
  // omatchade B-former i målarordning. Endast rings[0] används (hål ignoreras;
  // stacked-läget gör hål till egna former).
  const jobs = [];
  for (let i = 0; i < shA.length; i++) {
    const j = matchA[i];
    if (j >= 0) {
      jobs.push({ kind: 'matched', a: i, b: j, paint: i,
                  n: ringPointCount(Math.max(shA[i].area, shB[j].area)) });
    } else {
      jobs.push({ kind: 'collapse', a: i, b: -1, paint: i,
                  n: ringPointCount(shA[i].area) });
    }
  }
  for (let j = 0; j < shB.length; j++) {
    if (matchB[j] < 0) {
      jobs.push({ kind: 'grow', a: -1, b: j, paint: j,
                  n: ringPointCount(shB[j].area) });
    }
  }

  let vertexCount = 0;
  for (const job of jobs) {
    job.base = vertexCount;
    vertexCount += job.n;
  }
  const vertexData = new Float32Array(vertexCount * 8);
  const vertexU32 = new Uint32Array(vertexData.buffer); // färgslottar (unorm8x4)

  let indexCount = 0;
  for (const job of jobs) {
    const n = job.n;
    const base = job.base;
    let ringA, ringB;       // pixelrymd, Float64Array 2n
    let colorA, colorB, bandA, bandB;
    let na, nb;             // normalisering per ringens källscen

    if (job.kind === 'matched') {
      const A = shA[job.a], B = shB[job.b];
      ringA = resampleRing(A.rings[0], n);
      ringB = resampleRing(B.rings[0], n);
      colorA = packColor(A); colorB = packColor(B);
      bandA = clsA[job.a].bandF;
      bandB = clsB[job.b].bandF;
      na = normA; nb = normB;
      job.tri = triangulateRing(ringA);
    } else if (job.kind === 'collapse') {
      // Omatchad A-form: posB = A:s centroid (alla n punkter i centroiden).
      const A = shA[job.a];
      ringA = resampleRing(A.rings[0], n);
      ringB = new Float64Array(2 * n);
      for (let k = 0; k < n; k++) {
        ringB[2 * k] = A.centroid[0];
        ringB[2 * k + 1] = A.centroid[1];
      }
      colorA = colorB = packColor(A);
      bandA = bandB = clsA[job.a].bandF;
      na = nb = normA;
      job.tri = triangulateRing(ringA);
    } else {
      // Omatchad B-form: posA = B:s centroid; triangulera B-ringen
      // (A-ringen är degenererad; indexen är ringlokala och överförbara).
      const B = shB[job.b];
      ringB = resampleRing(B.rings[0], n);
      ringA = new Float64Array(2 * n);
      for (let k = 0; k < n; k++) {
        ringA[2 * k] = B.centroid[0];
        ringA[2 * k + 1] = B.centroid[1];
      }
      colorA = colorB = packColor(B);
      bandA = bandB = clsB[job.b].bandF;
      na = nb = normB;
      job.tri = triangulateRing(ringB);
    }

    for (let k = 0; k < n; k++) {
      const o = (base + k) * 8;
      vertexData[o]     = na.x(ringA[2 * k]);
      vertexData[o + 1] = na.y(ringA[2 * k + 1]);
      vertexData[o + 2] = nb.x(ringB[2 * k]);
      vertexData[o + 3] = nb.y(ringB[2 * k + 1]);
      vertexU32[o + 4]  = colorA;
      vertexU32[o + 5]  = colorB;
      vertexData[o + 6] = bandA;
      vertexData[o + 7] = bandB;
    }
    job.band = Math.max(bandA, bandB);
    indexCount += job.tri.length;
  }

  // Bakifrån-och-fram: max(bandA,bandB) fallande, målarordning stigande.
  // Array#sort är stabil → jobblistans ordning avgör kvarvarande likavärden.
  const order = jobs.slice().sort((p, q) => (q.band - p.band) || (p.paint - q.paint));

  const indexData = new Uint32Array(indexCount);
  const drawOrder = [];
  let off = 0;
  for (const job of order) {
    const tri = job.tri;
    const base = job.base;
    for (let k = 0; k < tri.length; k++) indexData[off + k] = base + tri[k];
    drawOrder.push({
      firstIndex: off, indexCount: tri.length,
      band: job.band, kind: job.kind, a: job.a, b: job.b, paint: job.paint,
    });
    off += tri.length;
  }

  return { vertexData, indexData, drawOrder };
}
