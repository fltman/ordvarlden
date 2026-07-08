// imagecloud.js — bild → sorterat partikelmoln (Partikelvärlden).
//
// Varje ords original.png samplas ner till ett FAST rutnät (GRID_X×GRID_Y) så
// att alla moln har EXAKT samma antal partiklar. Partiklarna sorteras efter
// luminans; morphen (cloudmorph.js) zippar två sorterade moln rang-för-rang,
// så att ljusa partiklar i moln A flyter till ljusa områden i moln B — ett
// sammanhängande virvlande återsamlande i stället för en platt övertoning.
//
// Konstant partikelantal ⇒ ingen matchning behövs, och överlämningen mellan
// två segment (…→B och B→…) blir sömlös: B-molnet har identiskt sorterad
// uppsättning i båda paren.

export const GRID_X = 320;
export const GRID_Y = 180;
export const CLOUD_N = GRID_X * GRID_Y; // 57 600 partiklar

const READY_MAX = 48;                   // LRU över avkodade moln (bild + sortering)
const ready = new Map();                // key -> cloud (Map-ordning = LRU)
const pending = new Map();              // key -> Promise<cloud>

function packRGBA(r, g, b) {
  return (r | (g << 8) | (b << 16) | (255 << 24)) >>> 0;
}

// Ordbildens URL (fritt läge). Låt-läget skickar in URL:en direkt (interludes
// ligger i en annan katalog) via loadCloudUrl.
export function imageUrl(slug) {
  return `/assets/words/${encodeURIComponent(slug)}/original.png`;
}

async function decode(key, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`kunde inte läsa bilden (${key})`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);

  // Nedsampling till rutnätet via 2D-canvas (bilinjär medelvärdesbildning).
  const cv = document.createElement('canvas');
  cv.width = GRID_X;
  cv.height = GRID_Y;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, GRID_X, GRID_Y);
  if (bmp.close) bmp.close();
  const data = ctx.getImageData(0, 0, GRID_X, GRID_Y).data;

  const aspect = GRID_X / GRID_Y;
  const pos = new Float32Array(CLOUD_N * 2);
  const col = new Uint32Array(CLOUD_N);
  const lum = new Float32Array(CLOUD_N);
  const order = new Uint32Array(CLOUD_N);

  let k = 0;
  for (let gy = 0; gy < GRID_Y; gy++) {
    // Normaliserad rymd per CONTRACT: yn i ±1 (uppåt positiv), xn i ±aspekt.
    const yn = (0.5 - (gy + 0.5) / GRID_Y) * 2;
    for (let gx = 0; gx < GRID_X; gx++) {
      const o = (gy * GRID_X + gx) * 4;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      pos[k * 2] = ((gx + 0.5) / GRID_X - 0.5) * 2 * aspect;
      pos[k * 2 + 1] = yn;
      col[k] = packRGBA(r, g, b);
      lum[k] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      order[k] = k;
      k++;
    }
  }

  // Stabil sortering efter luminans (index som tiebreak ⇒ deterministisk och
  // rumsligt sammanhängande för lika toner: läsordning uppe→ner, vänster→höger).
  const ord = Array.from(order);
  ord.sort((a, b) => (lum[a] - lum[b]) || (a - b));

  const sPos = new Float32Array(CLOUD_N * 2);
  const sCol = new Uint32Array(CLOUD_N);
  for (let i = 0; i < CLOUD_N; i++) {
    const j = ord[i];
    sPos[i * 2] = pos[j * 2];
    sPos[i * 2 + 1] = pos[j * 2 + 1];
    sCol[i] = col[j];
  }

  return { key, N: CLOUD_N, pos: sPos, col: sCol, aspect };
}

function remember(key, cloud) {
  ready.delete(key);
  ready.set(key, cloud);
  if (ready.size > READY_MAX) {
    ready.delete(ready.keys().next().value); // äldsta ut
  }
  return cloud;
}

// Ladda ett moln under given cachenyckel från en godtycklig bild-URL.
export function loadCloudUrl(key, url) {
  const hit = ready.get(key);
  if (hit) { remember(key, hit); return Promise.resolve(hit); }
  let p = pending.get(key);
  if (!p) {
    p = decode(key, url)
      .then((c) => { pending.delete(key); return remember(key, c); })
      .catch((e) => { pending.delete(key); throw e; });
    pending.set(key, p);
  }
  return p;
}

// Bekvämlighet för fritt läge (nyckel = slug, URL = ordets original.png).
export function loadCloud(slug) {
  return loadCloudUrl(slug, imageUrl(slug));
}

// Returnerar ett redan avkodat moln direkt, annars null (utan att ladda).
export function peekCloud(key) {
  const c = ready.get(key);
  if (c) remember(key, c); // LRU-bump
  return c || null;
}
