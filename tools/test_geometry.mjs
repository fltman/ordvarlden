// test_geometry.mjs — tester för tess.js + morph.js.
// Kör: cd /Users/andersbj/Projekt/3dworldtext && node tools/test_geometry.mjs

import { readFileSync } from 'fs';
import { earcut, resampleRing, triangulateRing } from '../web/js/tess.js';
import { buildMorphMesh } from '../web/js/morph.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  OK   ${name}`);
  } else {
    failures++;
    console.error(`  FEL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ---------------------------------------------------------------- test 1
console.log('Test 1: resampleRing på kvadrat 4 -> 32 punkter');
{
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const n = 32;
  const r = resampleRing(sq, n);
  check('längd = 2n', r.length === 2 * n, `fick ${r.length}`);

  const eps = 1e-9;
  let onPerimeter = true;
  for (let k = 0; k < n; k++) {
    const x = r[2 * k], y = r[2 * k + 1];
    const onV = (Math.abs(x) < eps || Math.abs(x - 10) < eps) && y > -eps && y < 10 + eps;
    const onH = (Math.abs(y) < eps || Math.abs(y - 10) < eps) && x > -eps && x < 10 + eps;
    if (!onV && !onH) { onPerimeter = false; break; }
  }
  check('alla punkter på perimetern', onPerimeter);

  // Startvertex är ett hörn (minsta-vinkel-regeln) och 40/32 = 1.25 delar
  // varje sida jämnt → varje konsekutivt avstånd ska bli exakt 1.25.
  const step = 40 / n;
  let evenSpacing = true;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    const dx = r[2 * k2] - r[2 * k];
    const dy = r[2 * k2 + 1] - r[2 * k + 1];
    if (Math.abs(Math.sqrt(dx * dx + dy * dy) - step) > 1e-9) { evenSpacing = false; break; }
  }
  check(`jämn båglängd (steg ${step})`, evenSpacing);
}

// ---------------------------------------------------------------- test 2
console.log('Test 2: triangulateRing på icke-konvex ring (L-form)');
{
  // L-form, 6 hörn, area 4*1 + 1*3 = 7.
  const flat = new Float64Array([0, 0, 4, 0, 4, 1, 1, 1, 1, 4, 0, 4]);
  const idx = triangulateRing(flat);
  check('Uint32Array', idx instanceof Uint32Array);
  check('triangelantal = n-2 = 4', idx.length === 3 * 4, `fick ${idx.length / 3}`);
  check('alla index < 6', idx.every((i) => i < 6));

  let area = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    area += Math.abs(
      (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) -
      (flat[2 * c] - flat[2 * a]) * (flat[2 * b + 1] - flat[2 * a + 1])
    ) / 2;
  }
  check('triangelarea = polygonarea (7)', Math.abs(area - 7) < 1e-9, `fick ${area}`);

  // Frusen export: earcut(vertices, holeIndices, dim) direkt.
  const raw = earcut([0, 0, 4, 0, 4, 4, 0, 4], null, 2);
  check('earcut-exporten fungerar', raw.length === 6);
}

// ---------------------------------------------------------------- test 3
console.log('Test 3: buildMorphMesh på riktiga scener');
const wow = JSON.parse(readFileSync(new URL('../assets/words/wow/scene.json', import.meta.url)));
const cool = JSON.parse(readFileSync(new URL('../assets/words/cool/scene.json', import.meta.url)));

function testBuild(label, a, b) {
  console.log(`  ${label} (${a.shapes.length} -> ${b.shapes.length} former)`);
  const t0 = performance.now();
  const mesh = buildMorphMesh(a, b);
  const ms = performance.now() - t0;
  const { vertexData, indexData, drawOrder } = mesh;
  const vertexCount = vertexData.length / 8;

  check('vertexData.length = vertexCount*8', vertexData.length === vertexCount * 8
    && Number.isInteger(vertexCount));

  let hasNaN = false;
  for (let i = 0; i < vertexData.length; i++) {
    if (Number.isNaN(vertexData[i])) { hasNaN = true; break; }
  }
  check('ingen NaN i vertexData', !hasNaN);

  let idxOk = true;
  for (let i = 0; i < indexData.length; i++) {
    if (indexData[i] >= vertexCount) { idxOk = false; break; }
  }
  check('alla index < vertexCount', idxOk);
  check('index i triplar', indexData.length % 3 === 0);

  // Normaliserade koordinater inom rimliga gränser (±max-aspekt, ±1).
  const maxAspect = Math.max(a.width / a.height, b.width / b.height) + 0.01;
  let boundsOk = true;
  for (let v = 0; v < vertexCount && boundsOk; v++) {
    const o = v * 8;
    boundsOk = Math.abs(vertexData[o]) <= maxAspect && Math.abs(vertexData[o + 1]) <= 1.01
      && Math.abs(vertexData[o + 2]) <= maxAspect && Math.abs(vertexData[o + 3]) <= 1.01;
  }
  check('positioner inom normaliserad rymd', boundsOk);

  // Indexordning: max-band fallande per chunk.
  let sorted = true;
  for (let i = 1; i < drawOrder.length; i++) {
    if (drawOrder[i].band > drawOrder[i - 1].band) { sorted = false; break; }
  }
  check('drawOrder sorterad band fallande', sorted);

  check(`byggtid < 2000 ms`, ms < 2000, `${ms.toFixed(0)} ms`);

  const counts = { matched: 0, collapse: 0, grow: 0 };
  for (const c of drawOrder) counts[c.kind]++;
  console.log(`    vertex: ${vertexCount}, trianglar: ${indexData.length / 3}, ` +
    `matchade: ${counts.matched}, kollapsade: ${counts.collapse}, växande: ${counts.grow}, ` +
    `tid: ${ms.toFixed(1)} ms`);
}

testBuild('cool -> wow', cool, wow);
testBuild('wow -> cool', wow, cool);

if (failures > 0) {
  console.error(`\n${failures} test misslyckades`);
  process.exit(1);
}
console.log('\nAlla tester gröna');
