// Ordvärlden — integration: boot, tillstånd, kontroller, render-loop.
// Alla modulgränssnitt är frusna i CONTRACT.md.

import { Renderer } from './renderer.js';
import { makeProjection, makeView, Journey, STATION_L } from './planet.js';
import { buildMorphMesh } from './morph.js';
import * as api from './api.js';
import { initUI, setStatus, setWordList, setBusy, focusWordInput } from './ui.js';
import { initSongMode, songPosition, updateKaraoke } from './song.js';

const canvas = document.getElementById('gpu');

const state = {
  words: [],            // [{word, slug, scene}] — endast färdiga ord, i världsordning
  journey: new Journey(),
  meshCache: new Map(), // "keyA|keyB" -> {vertexData, indexData}, LRU
  currentMeshKey: null,
  song: null,           // {song, stations, audio} i låt-läge, annars null
  songSpeed: 0,         // glättad fart (stationer/s / 0.45) för blur/sway
  songLastPos: 0,
  throttle: 0.35,       // autofart framåt
  keyThrottle: 0,
  wheelImpulse: 0,
  yaw: 0, pitch: 0,
  yawTarget: 0, pitchTarget: 0,
  dragging: false,
  rollAnim: null,          // {start, dur, dir} under pågående barrel roll
  segmentsSinceRoll: 0,
  proj: null,
  renderer: null,
  lastTime: performance.now(),
};
window.ORD = state; // debughandtag

function fatal(msg) {
  const el = document.getElementById('fatal');
  const p = document.getElementById('fatal-msg');
  if (p) p.textContent = msg;
  if (el) el.hidden = false;
  const boot = document.getElementById('boot');
  if (boot) boot.hidden = true;
}

const MESH_CACHE_MAX = 80; // LRU per CONTRACT

function meshForPair(keyA, sceneA, keyB, sceneB) {
  const key = `${keyA}|${keyB}`;
  let mesh = state.meshCache.get(key);
  if (mesh) {
    state.meshCache.delete(key); // LRU-bump
    state.meshCache.set(key, mesh);
  } else {
    mesh = buildMorphMesh(sceneA, sceneB);
    state.meshCache.set(key, mesh);
    if (state.meshCache.size > MESH_CACHE_MAX) {
      state.meshCache.delete(state.meshCache.keys().next().value);
    }
  }
  return { key, mesh };
}

const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 120));

function prebuildPair(keyA, sceneA, keyB, sceneB) {
  if (state.meshCache.has(`${keyA}|${keyB}`)) return;
  idle(() => meshForPair(keyA, sceneA, keyB, sceneB));
}

function prebuildNext(ib) {
  const n = state.words.length;
  if (n < 2) return;
  const ic = (ib + 1) % n;
  prebuildPair(state.words[ib].slug, state.words[ib].scene,
               state.words[ic].slug, state.words[ic].scene);
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
    state.renderer.resize(w, h);
    state.proj = makeProjection(w / h);
  }
}

function initControls() {
  canvas.addEventListener('pointerdown', (e) => {
    state.dragging = true;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', (e) => {
    state.dragging = false;
    canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!state.dragging) return;
    state.yawTarget = clamp(state.yawTarget - e.movementX * 0.0022, -0.7, 0.7);
    state.pitchTarget = clamp(state.pitchTarget - e.movementY * 0.0018, -0.35, 0.35);
  });
  window.addEventListener('wheel', (e) => {
    if (state.song) return; // i låt-läge styr musiken farten
    if (e.target.closest && e.target.closest('#wordbar')) return;
    state.wheelImpulse = clamp(state.wheelImpulse - e.deltaY * 0.004, -2, 2);
  }, { passive: true });
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (state.song) {
      if (e.key === ' ') { // mellanslag pausar/återupptar låten
        const a = state.song.audio;
        if (a.paused) a.play(); else a.pause();
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp') state.keyThrottle = 1;
    if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') state.keyThrottle = -1;
    if (e.key === ' ') { state.throttle = state.throttle === 0 ? 0.35 : 0; e.preventDefault(); }
    if (e.key === 'Enter') { focusWordInput(); e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => {
    if (['w', 'W', 'ArrowUp', 's', 'S', 'ArrowDown'].includes(e.key)) state.keyThrottle = 0;
  });
  window.addEventListener('resize', resize);
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function easeInOutCubic(p) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

// Då och då: en mjuk 360° barrel roll strax efter avfärd från ett ord.
function maybeBarrelRoll(now) {
  state.segmentsSinceRoll++;
  if (state.rollAnim) return;
  if (state.segmentsSinceRoll >= 3 && Math.random() < 0.35) {
    state.rollAnim = { start: now, dur: 1500, dir: Math.random() < 0.5 ? 1 : -1 };
    state.segmentsSinceRoll = 0;
  }
}

function currentRoll(now) {
  const a = state.rollAnim;
  if (!a) return 0;
  const p = (now - a.start) / a.dur;
  if (p >= 1) { state.rollAnim = null; return 0; }
  return a.dir * 2 * Math.PI * easeInOutCubic(p);
}

let statusResetTimer = null;
function flashStatus(msg, kind) {
  setStatus(msg, kind);
  clearTimeout(statusResetTimer);
  if (kind === 'ok' || kind === 'info') {
    statusResetTimer = setTimeout(() => setStatus(null), 4000);
  }
}

async function onSubmitWord(text) {
  const word = text.trim();
  if (!word) return;
  if (state.words.some((w) => w.word.toUpperCase() === word.toUpperCase())) {
    flashStatus(`"${word}" finns redan på planeten`, 'info');
    return;
  }
  setBusy(true);
  try {
    setStatus(`Skissar "${word}" …`, 'busy');
    const res = await api.requestWord(word);
    let status = res.status;
    const slug = res.slug;
    const phrases = {
      queued: `"${word}" står i kö …`,
      generating: `Tecknar "${word}" …`,
      vectorizing: `Vektoriserar "${word}" …`,
    };
    while (status !== 'ready') {
      if (status === 'error') throw new Error('genereringen misslyckades');
      setStatus(phrases[status] || `Arbetar med "${word}" …`, 'busy');
      await new Promise((r) => setTimeout(r, 2500));
      const poll = await api.pollWord(slug);
      status = poll.status;
      if (poll.error) throw new Error(poll.error);
    }
    const scene = await api.getScene(slug);
    state.words.push({ word: scene.word || word.toUpperCase(), slug, scene });
    state.journey.setStations(state.words.length);
    setWordList(state.words.map((w) => w.word), Math.floor(state.journey.segment.a));
    flashStatus(`"${word}" har landat på planeten`, 'ok');
  } catch (err) {
    flashStatus(`Kunde inte skapa "${word}": ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

// Segmentkälla i låt-läge: ljudklockan driver positionen; ankomst till
// station i sker exakt vid stations[i].start. Fart härleds ur stationstempot.
function songSegment(now, dt) {
  const st = state.song.stations;
  const { index, t } = songPosition(st, state.song.audio.currentTime);
  const ia = index, ib = Math.min(index + 1, st.length - 1);
  const posFloat = index + t;
  const target = clamp(Math.abs(posFloat - state.songLastPos) / Math.max(dt, 1e-3) / 0.45, 0, 1.2);
  state.songSpeed += (target - state.songSpeed) * Math.min(1, 6 * dt);
  state.songLastPos = posFloat;
  return {
    keyA: st[ia].key, sceneA: st[ia].scene,
    keyB: st[ib].key, sceneB: st[ib].scene,
    t, sp: state.songSpeed,
    onMeshChange: () => {
      updateKaraoke(st, ia);
      const ic = Math.min(ib + 1, st.length - 1);
      prebuildPair(st[ib].key, st[ib].scene, st[ic].key, st[ic].scene);
      // barrel roll i låt-läge: bara på väg in i ett mellanspel
      if (st[ib].key.startsWith('~') && !state.rollAnim && Math.random() < 0.6) {
        state.rollAnim = { start: now, dur: 1500, dir: Math.random() < 0.5 ? 1 : -1 };
      }
    },
  };
}

function journeySegment(now, dt) {
  // gaspådrag: tangent > hjulimpuls > autofart
  state.wheelImpulse *= Math.pow(0.15, dt); // klingar av
  const throttle = clamp(
    state.keyThrottle !== 0 ? state.keyThrottle : state.throttle + state.wheelImpulse,
    -1, 1
  );
  const { speed } = state.journey.update(dt, throttle);
  const seg = state.journey.segment;
  if (state.words.length === 0) return null;
  const a = state.words[seg.a], b = state.words[seg.b];
  return {
    keyA: a.slug, sceneA: a.scene,
    keyB: b.slug, sceneB: b.scene,
    t: seg.t, sp: Math.abs(speed) / 0.45,
    onMeshChange: () => {
      setWordList(state.words.map((w) => w.word), seg.a);
      prebuildNext(seg.b);
      maybeBarrelRoll(now);
    },
  };
}

// Låt-läge: när användaren trycker Spela laddas alla stationers scener
// (unika hämtas en gång), sedan tar songSegment över render-loopen.
async function onEnterSong({ song, stations, audio }) {
  try {
    setStatus('Laddar scener …', 'busy');
    const fetches = new Map();
    for (const s of stations) {
      if (!fetches.has(s.key)) {
        fetches.set(s.key, fetch(s.sceneUrl).then((r) => {
          if (!r.ok) throw new Error(`kunde inte läsa scenen för "${s.w}"`);
          return r.json();
        }));
      }
    }
    for (const s of stations) s.scene = await fetches.get(s.key);
    state.song = { song, stations, audio };
    state.songLastPos = 0;
    state.songSpeed = 0;
    state.currentMeshKey = null; // tvinga mesh-byte första framen
    updateKaraoke(stations, 0);
    setStatus(null);
  } catch (err) {
    audio.pause();
    state.song = null;
    flashStatus(`Låt-läget kunde inte starta: ${err.message}`, 'error');
  }
}

function onExitSong() {
  state.song = null;
  state.currentMeshKey = null;
  state.songSpeed = 0;
  setStatus(null);
}

function frame(now) {
  const dt = clamp((now - state.lastTime) / 1000, 0, 0.1);
  state.lastTime = now;

  const segData = state.song ? songSegment(now, dt) : journeySegment(now, dt);

  if (segData) {
    const { key, mesh } = meshForPair(segData.keyA, segData.sceneA, segData.keyB, segData.sceneB);
    if (key !== state.currentMeshKey) {
      state.renderer.setMesh(mesh);
      state.currentMeshKey = key;
      segData.onMeshChange();
    }

    // titta omkring: mjuk återgång mot rakt fram när man inte drar
    const ease = state.dragging ? 1 : 1 - Math.pow(0.4, dt);
    if (!state.dragging) {
      state.yawTarget *= Math.pow(0.5, dt);
      state.pitchTarget *= Math.pow(0.5, dt);
    }
    state.yaw += (state.yawTarget - state.yaw) * Math.min(1, 12 * dt * ease + 8 * dt);
    state.pitch += (state.pitchTarget - state.pitch) * Math.min(1, 12 * dt * ease + 8 * dt);

    const t = now / 1000;
    const sp = segData.sp;
    const swayX = Math.sin(t * 1.7) * 0.05 * sp;
    const swayY = Math.sin(t * 2.3 + 1.3) * 0.03 * sp;
    const bobY = Math.sin(t * 3.1) * 0.02 * sp;
    const posZ = -segData.t * STATION_L; // kameradollyn: rusningen mellan stationerna
    const view = makeView({
      yaw: state.yaw,
      pitch: state.pitch,
      swayX, swayY, bobY, posZ,
      roll: currentRoll(now),
    });

    const aA = segData.sceneA.width / segData.sceneA.height;
    const aB = segData.sceneB.width / segData.sceneB.height;
    state.renderer.setUniforms({
      proj: state.proj,
      view,
      t: segData.t, // linjär — kameradollyn och morphens t måste följas åt
      time: t,
      speed: sp,
      aspectRef: aA + (aB - aA) * segData.t,
      camPos: [swayX, bobY + swayY, posZ],
    });
    state.renderer.render();
  }

  requestAnimationFrame(frame);
}

async function boot() {
  try {
    state.renderer = await Renderer.create(canvas);
  } catch (err) {
    fatal(err.message);
    return;
  }

  initUI({ onSubmitWord });
  initSongMode({ onEnterSong, onExitSong });
  initControls();
  resize();

  try {
    const list = await api.listWords();
    const ready = list.filter((w) => w.ready);
    const scenes = await Promise.all(ready.map((w) => api.getScene(w.slug)));
    state.words = ready.map((w, i) => ({ word: scenes[i].word || w.word, slug: w.slug, scene: scenes[i] }));
  } catch (err) {
    fatal(`Kunde inte läsa orden från servern: ${err.message}`);
    return;
  }

  if (state.words.length === 0) {
    fatal('Inga ord på planeten ännu — generera ett första ord via pipelinen.');
    return;
  }

  state.journey.setStations(state.words.length);
  setWordList(state.words.map((w) => w.word), 0);

  const bootEl = document.getElementById('boot');
  if (bootEl) {
    bootEl.classList.add('done');
    setTimeout(() => { bootEl.hidden = true; }, 950);
  }

  state.lastTime = performance.now();
  requestAnimationFrame(frame);
}

boot();
