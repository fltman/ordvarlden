// Partikelvärlden — integration: boot, tillstånd, kontroller, render-loop.
// Ny version av Ordvärlden: i stället för att morpha vektorformer bygger vi
// morphande 3D-partikelmoln direkt ur ordbilderna. Återanvänder planet.js
// (kamera/resa), api.js, ui.js och song.js oförändrade; byter ut morph.js →
// cloudmorph.js och renderer.js → particles.js.

import { ParticleRenderer } from './particles.js';
import { makeProjection, makeView, Journey } from '../planet.js';
import { buildPair } from './cloudmorph.js';
import { loadCloud, loadCloudUrl, peekCloud, imageUrl } from './imagecloud.js';
import * as api from '../api.js';
import { initUI, setStatus, setWordList, setBusy, focusWordInput } from '../ui.js';
import { initSongMode, songPosition, updateKaraoke } from '../song.js';

const canvas = document.getElementById('gpu');

// Bas-amplituder för molnets rese-dramatik; skalas per bildruta med farten så
// att ett STILLASTÅENDE moln är lugnt och läsbart, ett rusande moln dramatiskt.
const BASE = { explodeXY: 0.14, explodeZ: 0.50, swirl: 0.35, push: 1.1 };

const state = {
  words: [],            // [{word, slug}] i världsordning (endast färdiga ord)
  journey: new Journey(),
  currentKey: null,     // "keyA|keyB" som just nu ligger i instansbufferten
  song: null,           // {song, stations, audio} i låt-läge
  songSpeed: 0,
  songLastPos: 0,
  throttle: 0.35,       // autofart framåt
  keyThrottle: 0,
  wheelImpulse: 0,
  yaw: 0, pitch: 0,
  yawTarget: 0, pitchTarget: 0,
  dragging: false,
  rollAnim: null,
  segmentsSinceRoll: 0,
  proj: null,
  renderer: null,
  lastTime: performance.now(),
};
window.PARTIKEL = state; // debughandtag

function fatal(msg) {
  const el = document.getElementById('fatal');
  const p = document.getElementById('fatal-msg');
  if (p) p.textContent = msg;
  if (el) el.hidden = false;
  const boot = document.getElementById('boot');
  if (boot) boot.hidden = true;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function easeInOutCubic(p) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

// URL till en stations bild (ord ELLER mellanspel) — härleds ur sceneUrl.
function stationImageUrl(st) {
  return st.sceneUrl.replace(/scene\.json$/, 'original.png');
}

// Hämta ett avkodat moln direkt; annars trigga laddning och returnera null.
function ensureCloud(key, url) {
  const c = peekCloud(key);
  if (c) return c;
  loadCloudUrl(key, url).catch((err) => console.warn('moln:', err.message));
  return null;
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
    if (state.song) return;
    if (e.target.closest && e.target.closest('#wordbar')) return;
    state.wheelImpulse = clamp(state.wheelImpulse - e.deltaY * 0.004, -2, 2);
  }, { passive: true });
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (state.song) {
      if (e.key === ' ') {
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
      vectorizing: `Bearbetar "${word}" …`,
    };
    while (status !== 'ready') {
      if (status === 'error') throw new Error('genereringen misslyckades');
      setStatus(phrases[status] || `Arbetar med "${word}" …`, 'busy');
      await new Promise((r) => setTimeout(r, 2500));
      const poll = await api.pollWord(slug);
      status = poll.status;
      if (poll.error) throw new Error(poll.error);
    }
    await loadCloud(slug); // avkoda molnet innan vi lägger till ordet
    state.words.push({ word: word.toUpperCase(), slug });
    state.journey.setStations(state.words.length);
    setWordList(state.words.map((w) => w.word), Math.floor(state.journey.segment.a));
    flashStatus(`"${word}" har landat på planeten`, 'ok');
  } catch (err) {
    flashStatus(`Kunde inte skapa "${word}": ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

// Segmentkälla i låt-läge: ljudklockan driver positionen.
function songSegment(now, dt) {
  const st = state.song.stations;
  const { index, t } = songPosition(st, state.song.audio.currentTime);
  const ia = index, ib = Math.min(index + 1, st.length - 1);
  const posFloat = index + t;
  const target = clamp(Math.abs(posFloat - state.songLastPos) / Math.max(dt, 1e-3) / 0.45, 0, 1.2);
  state.songSpeed += (target - state.songSpeed) * Math.min(1, 6 * dt);
  state.songLastPos = posFloat;
  const sA = st[ia], sB = st[ib];
  return {
    keyA: sA.key, urlA: stationImageUrl(sA),
    keyB: sB.key, urlB: stationImageUrl(sB),
    t, sp: state.songSpeed,
    onMeshChange: () => {
      updateKaraoke(st, ia);
      const ic = Math.min(ib + 1, st.length - 1);
      loadCloudUrl(st[ib].key, stationImageUrl(st[ib])).catch(() => {});
      loadCloudUrl(st[ic].key, stationImageUrl(st[ic])).catch(() => {});
      if (st[ib].key.startsWith('~') && !state.rollAnim && Math.random() < 0.6) {
        state.rollAnim = { start: now, dur: 1500, dir: Math.random() < 0.5 ? 1 : -1 };
      }
    },
  };
}

function journeySegment(now, dt) {
  state.wheelImpulse *= Math.pow(0.15, dt);
  const throttle = clamp(
    state.keyThrottle !== 0 ? state.keyThrottle : state.throttle + state.wheelImpulse,
    -1, 1
  );
  const { speed } = state.journey.update(dt, throttle);
  const seg = state.journey.segment;
  if (state.words.length === 0) return null;
  const a = state.words[seg.a], b = state.words[seg.b];
  return {
    keyA: a.slug, urlA: imageUrl(a.slug),
    keyB: b.slug, urlB: imageUrl(b.slug),
    t: seg.t, sp: Math.abs(speed) / 0.45,
    onMeshChange: () => {
      setWordList(state.words.map((w) => w.word), seg.a);
      const c = state.words[(seg.b + 1) % state.words.length];
      if (c) loadCloud(c.slug).catch(() => {});
      maybeBarrelRoll(now);
    },
  };
}

async function onEnterSong({ song, stations, audio }) {
  try {
    setStatus('Laddar moln …', 'busy');
    const head = stations.slice(0, 3);
    await Promise.all(head.map((s) => loadCloudUrl(s.key, stationImageUrl(s)).catch(() => {})));
    state.song = { song, stations, audio };
    state.songLastPos = 0;
    state.songSpeed = 0;
    state.currentKey = null;
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
  state.currentKey = null;
  state.songSpeed = 0;
  setStatus(null);
}

function frame(now) {
  const dt = clamp((now - state.lastTime) / 1000, 0, 0.1);
  state.lastTime = now;

  const seg = state.song ? songSegment(now, dt) : journeySegment(now, dt);

  if (seg) {
    const a = ensureCloud(seg.keyA, seg.urlA);
    const bReady = ensureCloud(seg.keyB, seg.urlB);
    if (a) {
      const b = bReady || a; // fallback: visa bild A skarpt tills B avkodats
      const key = `${seg.keyA}|${bReady ? seg.keyB : seg.keyA}`;
      if (key !== state.currentKey) {
        state.renderer.setInstances(buildPair(a, b));
        state.currentKey = key;
        seg.onMeshChange();
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
      const sp = seg.sp;
      const e = Math.min(1, sp);
      const k = 0.35 + 0.65 * e; // stillastående = lugnare, men aldrig helt platt
      state.renderer.setParams({
        explodeXY: BASE.explodeXY * k,
        explodeZ: BASE.explodeZ * k,
        swirl: BASE.swirl * k,
        push: BASE.push * k,
      });

      const swayX = Math.sin(t * 1.7) * 0.05 * sp;
      const swayY = Math.sin(t * 2.3 + 1.3) * 0.03 * sp;
      const bobY = Math.sin(t * 3.1) * 0.02 * sp;
      const view = makeView({
        yaw: state.yaw, pitch: state.pitch,
        swayX, swayY, bobY, posZ: 0,
        roll: currentRoll(now),
      });

      state.renderer.setUniforms({
        proj: state.proj, view,
        t: seg.t, time: t, speed: sp,
      });
      state.renderer.render();
    }
  }

  requestAnimationFrame(frame);
}

async function boot() {
  try {
    state.renderer = await ParticleRenderer.create(canvas);
  } catch (err) {
    fatal(err.message);
    return;
  }
  state.renderer.setParams({
    particleSize: 0.032, relief: 0.18, dist: 8.0, sizeBurst: -0.15, sway: 0.10,
  });

  initUI({ onSubmitWord });
  initSongMode({ onEnterSong, onExitSong });
  initControls();
  resize();

  try {
    const list = await api.listWords();
    state.words = list.filter((w) => w.ready).map((w) => ({ word: w.word, slug: w.slug }));
  } catch (err) {
    fatal(`Kunde inte läsa orden från servern: ${err.message}`);
    return;
  }

  if (state.words.length === 0) {
    fatal('Inga ord på planeten ännu — generera ett första ord via textfältet.');
    return;
  }

  // Avkoda de första molnen innan vi startar loopen (skarp bild direkt).
  try {
    await loadCloud(state.words[0].slug);
    if (state.words[1]) loadCloud(state.words[1].slug).catch(() => {});
    if (state.words[2]) loadCloud(state.words[2].slug).catch(() => {});
  } catch (err) {
    fatal(`Kunde inte läsa bilden: ${err.message}`);
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
