// tess.js — earcut-wrapper + jämn ringomsampling + triangulering.
// Fungerar i både webbläsare (index.html laddar earcut.vendor.js som klassiskt
// script före modulgrafen → window.earcut) och node (createRequire på UMD-filen).

let earcutImpl;
if (typeof window !== 'undefined') {
  earcutImpl = window.earcut;
  if (!earcutImpl) {
    throw new Error('tess.js: earcut.vendor.js måste laddas före modulgrafen');
  }
} else {
  const { createRequire } = await import('module');
  earcutImpl = createRequire(import.meta.url)('./earcut.vendor.js');
}

export function earcut(vertices, holeIndices, dim) {
  return earcutImpl(vertices, holeIndices, dim);
}

// Jämn båglängdsomsampling av en sluten polygonring till exakt n punkter.
// ring: [[x,y], ...] i pixelrymd (y nedåt). Returnerar Float64Array längd 2n.
// Normaliserar först vridriktning (medurs i pixelrymd = positiv signerad area
// med y nedåt) och roterar startpunkten till den vertex vars vinkel från
// centroiden ligger närmast 0 rad (öster) — förhindrar tvinnade morpher.
export function resampleRing(ring, n) {
  const out = new Float64Array(2 * n);
  let m = ring.length;
  if (m === 0) return out;

  // Släpp dubblerad slutpunkt om ringen är explicit stängd.
  if (m > 1 && ring[0][0] === ring[m - 1][0] && ring[0][1] === ring[m - 1][1]) m--;

  const xs = new Float64Array(m);
  const ys = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    xs[i] = ring[i][0];
    ys[i] = ring[i][1];
  }
  if (m < 3) {
    for (let k = 0; k < n; k++) {
      out[2 * k] = xs[0];
      out[2 * k + 1] = ys[0];
    }
    return out;
  }

  // Signerad area (shoelace). Negativ → vänd ringen så alla blir medurs.
  let area2 = 0;
  for (let i = 0, j = m - 1; i < m; j = i++) {
    area2 += xs[j] * ys[i] - xs[i] * ys[j];
  }
  if (area2 < 0) {
    for (let i = 0, j = m - 1; i < j; i++, j--) {
      let t = xs[i]; xs[i] = xs[j]; xs[j] = t;
      t = ys[i]; ys[i] = ys[j]; ys[j] = t;
    }
    area2 = -area2;
  }

  // Centroid (polygoncentroid; vertexmedel som fallback för degenererad ring).
  let cx = 0, cy = 0;
  if (area2 > 1e-9) {
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const cross = xs[j] * ys[i] - xs[i] * ys[j];
      cx += (xs[j] + xs[i]) * cross;
      cy += (ys[j] + ys[i]) * cross;
    }
    cx /= 3 * area2;
    cy /= 3 * area2;
  } else {
    for (let i = 0; i < m; i++) { cx += xs[i]; cy += ys[i]; }
    cx /= m;
    cy /= m;
  }

  // Startvertex: minsta |vinkel| från centroiden (atan2 med y nedåt).
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < m; i++) {
    const a = Math.abs(Math.atan2(ys[i] - cy, xs[i] - cx));
    if (a < best) { best = a; start = i; }
  }

  // Kumulativa båglängder runt ringen från startvertexen (m segment inkl. stängning).
  const cum = new Float64Array(m + 1);
  for (let s = 0; s < m; s++) {
    const i = (start + s) % m;
    const j = (start + s + 1) % m;
    const dx = xs[j] - xs[i];
    const dy = ys[j] - ys[i];
    cum[s + 1] = cum[s] + Math.sqrt(dx * dx + dy * dy);
  }
  const total = cum[m];
  if (total < 1e-12) {
    for (let k = 0; k < n; k++) {
      out[2 * k] = xs[start];
      out[2 * k + 1] = ys[start];
    }
    return out;
  }

  // Sampla vid k*total/n, k = 0..n-1 (sluten ring — startpunkten repeteras ej).
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / n;
    while (seg < m - 1 && cum[seg + 1] < target) seg++;
    const d = cum[seg + 1] - cum[seg];
    const t = d > 1e-12 ? (target - cum[seg]) / d : 0;
    const i = (start + seg) % m;
    const j = (start + seg + 1) % m;
    out[2 * k] = xs[i] + (xs[j] - xs[i]) * t;
    out[2 * k + 1] = ys[i] + (ys[j] - ys[i]) * t;
  }
  return out;
}

// Triangulerar en enkel ring utan hål. flatRing: Float64Array [x0,y0,x1,y1,...].
// Returnerar Uint32Array med ringlokala index (trippel per triangel).
export function triangulateRing(flatRing) {
  return Uint32Array.from(earcutImpl(flatRing, null, 2));
}
