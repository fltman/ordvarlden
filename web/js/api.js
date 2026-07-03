// api.js — fetch mot servern (port 8144, samma origin). Signaturer per CONTRACT.md.

async function requestJSON(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error('Kunde inte nå servern — är den igång?');
  }
  let data = null;
  try {
    data = await res.json();
  } catch { /* icke-JSON-svar; hanteras nedan */ }
  if (!res.ok) {
    const msg = data && (data.error || data.message || data.detail);
    throw new Error(msg || `Serverfel (HTTP ${res.status})`);
  }
  return data;
}

// GET /api/words -> [{word, slug, ready}]
export async function listWords() {
  return requestJSON('/api/words');
}

// GET /assets/words/<slug>/scene.json -> scene JSON
export async function getScene(slug) {
  return requestJSON(`/assets/words/${encodeURIComponent(slug)}/scene.json`);
}

// POST /api/word {word} -> {slug, status}
export async function requestWord(text) {
  return requestJSON('/api/word', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word: text }),
  });
}

// GET /api/word/<slug>/status -> {status: 'queued'|'generating'|'vectorizing'|'ready'|'error', error?}
export async function pollWord(slug) {
  return requestJSON(`/api/word/${encodeURIComponent(slug)}/status`);
}

// ---- Låt-läge (song mode) ----

// POST /api/song?name=<filnamn> — body = råa filbytes (ingen multipart).
// -> {id, status: 'transcribing'}
export async function uploadSong(file) {
  return requestJSON(`/api/song?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    body: file,
  });
}

// GET /api/song/<id> -> {id, title, duration, status: 'transcribing'|'ready'|'error',
//                        error?, words?: [...], unique?: [{slug, w, ready}]}
export async function getSong(id) {
  return requestJSON(`/api/song/${encodeURIComponent(id)}`);
}

// POST /api/song/<id>/generate — köar alla saknade unika ord -> {queued: n}
export async function generateSongWords(id) {
  return requestJSON(`/api/song/${encodeURIComponent(id)}/generate`, { method: 'POST' });
}

// GET /api/interludes -> [{slug: 'inter-1'}, ...] (tom lista om inga finns)
export async function listInterludes() {
  return requestJSON('/api/interludes');
}
