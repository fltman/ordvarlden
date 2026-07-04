// song.js — låt-läge: uppladdning → transkribering → generering → uppspelning.
// Frusna exporter per CONTRACT.md: initSongMode, buildStations, songPosition,
// updateKaraoke. Ingen DOM-åtkomst vid importtillfället — alla DOM-uppslag sker
// inuti funktionerna (modulen enhetstestas i node).

import { uploadSong, getSong, generateSongWords, listInterludes, updateSongWords } from './api.js';

// ---- konstanter -------------------------------------------------------------

const POLL_MS = 3000;                    // pollintervall, var 3:e sekund (CONTRACT)
const GAP_S = 8;                         // lucka > 8 s ⇒ mellanspel (CONTRACT)
const MAX_INTERLUDES = 3;                // max mellanspel per lucka (CONTRACT)
const MIN_SEG_S = 0.15;                  // golv för nämnaren i songPosition (CONTRACT)
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024; // servern avvisar > 60 MB (CONTRACT)
const SEC_PER_WORD = 35;                 // grov uppskattning: generationstid per ord
const WORKERS = 3;                       // servern kör 3 parallella workers (CONTRACT)
const USD_PER_IMAGE = 0.15;              // grov uppskattning: kostnad per AI-bild

// ---- rena funktioner (tillståndslösa, node-testbara) -------------------------

// -> [{key, slug, w, start, sceneUrl}] i tidsordning. Ett inslag per
// ordförekomst (key = slug). Vid lucka > 8 s mellan två ords start (samt före
// första ordet) skjuts min(3, floor(lucka/8)) mellanspel in, jämnt fördelade i
// luckan. Mellanspel roteras (1,2,3,1,…) över hela låten; key = "~inter-n",
// w = "♪". Tom interludes-lista ⇒ inga mellanspel.
export function buildStations(song, interludes) {
  const words = (song && song.words) || [];
  const inters = (interludes || []).filter((x) => x && x.slug);
  const stations = [];
  let rot = 0; // rotationsräknare — fortsätter över luckorna

  const pushInterludes = (t0, t1) => {
    if (inters.length === 0) return;
    const gap = t1 - t0;
    if (gap <= GAP_S) return;
    const k = Math.min(MAX_INTERLUDES, Math.floor(gap / GAP_S));
    for (let j = 1; j <= k; j++) {
      const slug = inters[rot % inters.length].slug;
      rot++;
      stations.push({
        key: `~${slug}`,
        slug,
        w: '♪',
        start: t0 + (gap * j) / (k + 1),
        sceneUrl: `/assets/interludes/${slug}/scene.json`,
      });
    }
  };

  let prevStart = 0; // luckan före första ordet räknas från 0
  for (const word of words) {
    pushInterludes(prevStart, word.start);
    stations.push({
      key: word.slug,
      slug: word.slug,
      w: word.w,
      start: word.start,
      sceneUrl: `/assets/words/${word.slug}/scene.json`,
    });
    prevStart = word.start;
  }
  return stations;
}

// -> {index, t}: index = stationsindex (0..n-1), t = 0..1 fram till nästa
// stations start. Binärsökning över stations[].start; nämnaren golvas till
// 0.15 s. Före stations[0].start: {index: 0, t: 0}. Efter sista: {n-1, 0}.
export function songPosition(stations, currentTime) {
  const n = stations ? stations.length : 0;
  if (n === 0) return { index: 0, t: 0 };
  if (currentTime < stations[0].start) return { index: 0, t: 0 };
  if (currentTime >= stations[n - 1].start) return { index: n - 1, t: 0 };

  // binärsökning: största i med stations[i].start <= currentTime
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (stations[mid].start <= currentTime) lo = mid;
    else hi = mid - 1;
  }
  const seg = Math.max(MIN_SEG_S, stations[lo + 1].start - stations[lo].start);
  const t = Math.min(1, Math.max(0, (currentTime - stations[lo].start) / seg));
  return { index: lo, t };
}

// Textremsa (föregående / aktuellt / nästa ord); aktuellt markeras via CSS.
// Mellanspel visar sitt w = "♪". No-op utanför DOM (nodtester).
export function updateKaraoke(stations, index) {
  if (typeof document === 'undefined') return;
  const k = document.getElementById('karaoke');
  if (!k) return;
  const at = (i) => (stations && i >= 0 && i < stations.length ? stations[i].w : '');
  k.querySelector('.karaoke-prev').textContent = at(index - 1);
  k.querySelector('.karaoke-current').textContent = at(index);
  k.querySelector('.karaoke-next').textContent = at(index + 1);
}

// ---- UI-flödet ---------------------------------------------------------------

let els = null;
let callbacks = {};
let song = null;        // senaste GET /api/song/<id>-svar med status "ready"
let songId = null;
let audio = null;       // <audio>-elementet under uppspelning
let pollTimer = null;
let generating = false; // generera-knappen tryckt, ord på väg
let playing = false;    // låt-läget aktivt (pill + karaoke synliga)
let editing = false;    // ett inline-redigeringsfält är öppet i transkriptet
let recorder = null;    // MediaRecorder under videoexport (null annars)
let recordChunks = [];
let audioCtx = null;    // WebAudio-kontext för att tappa låtljudet (återanvänds)

function q() {
  if (!els) {
    els = {
      toggle: document.getElementById('song-toggle'),
      file: document.getElementById('song-file'),
      panel: document.getElementById('songpanel'),
      close: document.getElementById('song-close'),
      stepPick: document.getElementById('song-step-pick'),
      choose: document.getElementById('song-choose'),
      stepTranscribe: document.getElementById('song-step-transcribe'),
      transcribeName: document.getElementById('song-transcribe-name'),
      stepResult: document.getElementById('song-step-result'),
      resultName: document.getElementById('song-result-name'),
      stats: document.getElementById('song-stats'),
      mood: document.getElementById('song-mood'),
      editHint: document.getElementById('song-edit-hint'),
      lyrics: document.getElementById('song-lyrics'),
      generate: document.getElementById('song-generate'),
      cost: document.getElementById('song-cost'),
      progress: document.getElementById('song-progress'),
      progressText: document.getElementById('song-progress-text'),
      play: document.getElementById('song-play'),
      newSong: document.getElementById('song-new'),
      error: document.getElementById('song-error'),
      exportBtn: document.getElementById('song-export'),
      pill: document.getElementById('songpill'),
      pillTitle: document.getElementById('songpill-title'),
      pause: document.getElementById('song-pause'),
      stop: document.getElementById('song-stop'),
      karaoke: document.getElementById('karaoke'),
    };
  }
  return els;
}

function showError(msg) {
  const e = q();
  e.error.textContent = msg;
  e.error.hidden = false;
}

function clearError() {
  const e = q();
  e.error.hidden = true;
  e.error.textContent = '';
}

function showStep(step) {
  const e = q();
  e.stepPick.hidden = step !== 'pick';
  e.stepTranscribe.hidden = step !== 'transcribe';
  e.stepResult.hidden = step !== 'result';
}

function togglePanel(force) {
  const e = q();
  const open = force !== undefined ? force : e.panel.hidden;
  e.panel.hidden = !open;
  e.toggle.setAttribute('aria-expanded', String(open));
}

function allReady(s) {
  const unique = (s && s.unique) || [];
  return unique.length > 0 && unique.every((u) => u.ready);
}

// Resultatvyn: "N ord · M unika · K klara" + generera/progress/spela.
function renderResult() {
  const e = q();
  if (!song) return;
  const nWords = (song.words || []).length;
  const unique = song.unique || [];
  const nReady = unique.filter((u) => u.ready).length;
  const missing = unique.length - nReady;

  e.resultName.textContent = song.title || '';
  e.stats.textContent = `${nWords} ord · ${unique.length} unika · ${nReady} klara`;

  // AI-skriven stämningsklausul (fri text ur låttexten) — visas som kuriosa.
  if (e.mood) {
    const clause = typeof song.mood === 'string' ? song.mood.trim() : '';
    e.mood.textContent = clause;
    e.mood.hidden = !clause;
  }

  // Textförhandsvisning: hela transkriptet, ogenererade ord markerade.
  // Orden är klickbara (rätta/ta bort); rör inte DOM:en medan ett fält är öppet.
  if (e.lyrics && !editing) {
    const readySlugs = new Set(unique.filter((u) => u.ready).map((u) => u.slug));
    e.lyrics.textContent = '';
    (song.words || []).forEach((w, i) => {
      const span = document.createElement('span');
      span.textContent = w.w;
      span.title = `${w.start.toFixed(1)} s — klicka för att rätta`;
      span.className = 'lyric-word' + (readySlugs.has(w.slug) ? '' : ' lyric-missing');
      span.dataset.index = String(i);
      e.lyrics.appendChild(span);
      e.lyrics.appendChild(document.createTextNode(' '));
    });
    e.lyrics.hidden = (song.words || []).length === 0;
    if (e.editHint) e.editHint.hidden = e.lyrics.hidden;
  }

  const showGen = missing > 0 && !generating;
  e.generate.hidden = !showGen;
  e.cost.hidden = !showGen;
  if (showGen) {
    const min = Math.max(1, Math.ceil((missing * SEC_PER_WORD) / WORKERS / 60));
    e.generate.textContent = `Generera ${missing} ord (~${min} min)`;
    const usd = (missing * USD_PER_IMAGE).toFixed(2).replace('.', ',');
    e.cost.textContent =
      `Skapar ${missing} nya AI-bilder — kostar riktiga pengar (≈ ${usd} USD).`;
  }

  const showProgress = generating && missing > 0;
  e.progress.hidden = !showProgress;
  if (showProgress) e.progressText.textContent = `${nReady}/${unique.length} klara`;

  e.play.disabled = playing || unique.length === 0 || missing > 0;
  if (e.exportBtn) e.exportBtn.disabled = e.play.disabled;
  if (unique.length === 0) {
    showError('Inga sångord hittades i låten — bara instrumental?');
  }
  showStep('result');
}

// ---- transkript-redigering ---------------------------------------------------
// Klick på ett ord → inline-<input>. Enter/blur = spara, Escape = avbryt,
// tomt fält = ta bort ordet. Hela nya listan POST:as (utan slugs); panelen
// uppdateras från serverns svar.

function beginWordEdit(span) {
  if (editing || !song || !songId) return;
  const index = Number(span.dataset.index);
  const words = song.words || [];
  if (!Number.isInteger(index) || index < 0 || index >= words.length) return;
  editing = true;

  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 16;
  input.value = words[index].w;
  input.className = 'lyric-edit';
  input.setAttribute('aria-label', 'Rätta ordet');
  span.replaceChildren(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    editing = false;
    const value = input.value.trim();
    if (!commit || value === words[index].w) {
      renderResult();
      return;
    }
    commitWordEdit(index, value);
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

async function commitWordEdit(index, value) {
  // value === '' ⇒ ordet tas bort. Skicka {w, start, end} — aldrig slugs.
  const words = (song.words || [])
    .map((w, i) => (i === index && value === '' ? null : {
      w: i === index ? value : w.w,
      start: w.start,
      ...(typeof w.end === 'number' ? { end: w.end } : {}),
    }))
    .filter(Boolean);
  clearError();
  try {
    song = await updateSongWords(songId, words);
  } catch (err) {
    showError(`Kunde inte spara ändringen: ${err.message}`);
  }
  renderResult();
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollSong, POLL_MS);
}

async function pollSong() {
  if (!songId) {
    stopPolling();
    return;
  }
  let s;
  try {
    s = await getSong(songId);
  } catch (err) {
    stopPolling();
    showError(`Kunde inte läsa låtens status: ${err.message}`);
    showStep('pick');
    return;
  }
  if (s.status === 'error') {
    stopPolling();
    showError(s.error || 'Transkriberingen misslyckades.');
    showStep('pick');
    return;
  }
  if (s.status === 'transcribing') return;
  song = s;
  if (allReady(s)) {
    generating = false;
    stopPolling();
  }
  renderResult();
}

async function onFileChosen() {
  const e = q();
  const file = e.file.files && e.file.files[0];
  e.file.value = ''; // så att samma fil kan väljas igen
  if (!file) return;
  clearError();
  if (file.size > MAX_UPLOAD_BYTES) {
    showError('Filen är för stor — max 60 MB.');
    return;
  }
  stopPolling();
  song = null;
  songId = null;
  generating = false;
  e.transcribeName.textContent = file.name;
  showStep('transcribe');
  try {
    const res = await uploadSong(file);
    songId = res.id;
    startPolling();
  } catch (err) {
    showError(`Uppladdningen misslyckades: ${err.message}`);
    showStep('pick');
  }
}

async function onGenerate() {
  const e = q();
  if (!songId) return;
  clearError();
  e.generate.disabled = true;
  try {
    await generateSongWords(songId);
    generating = true;
    renderResult();
    startPolling();
  } catch (err) {
    showError(`Kunde inte köa genereringen: ${err.message}`);
  } finally {
    e.generate.disabled = false;
  }
}

// ---- videoexport --------------------------------------------------------------
// Spelar in canvasen (WebGPU) + låtens ljud under uppspelningen och laddar ner
// filen när låten tar slut/stoppas. Helt klientside; realtid (låtens längd).

function startRecorder(audioEl) {
  try {
    if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder saknas');
    const canvas = document.getElementById('gpu');
    const stream = canvas.captureStream(30);
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    // Ljudet dras genom WebAudio: till högtalarna OCH till inspelningsspåret.
    const src = audioCtx.createMediaElementSource(audioEl);
    const dest = audioCtx.createMediaStreamDestination();
    src.connect(audioCtx.destination);
    src.connect(dest);
    for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
    const mime = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4',
                  'video/webm;codecs=vp9,opus', 'video/webm']
      .find((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) throw new Error('ingen videocodec stöds');
    recordChunks = [];
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
    recorder.addEventListener('dataavailable', (ev) => {
      if (ev.data && ev.data.size) recordChunks.push(ev.data);
    });
    recorder.addEventListener('stop', saveRecording);
    recorder.start(1000);
    return true;
  } catch (err) {
    recorder = null;
    showError(`Inspelningen kunde inte startas: ${err.message}`);
    return false;
  }
}

function stopRecorder() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

function saveRecording() {
  const mime = (recorder && recorder.mimeType) || 'video/webm';
  const blob = new Blob(recordChunks, { type: mime });
  recordChunks = [];
  recorder = null;
  if (!blob.size) return;
  const base = ((song && song.title) || 'ordvärlden').replace(/\.[^.]+$/, '') || 'ordvärlden';
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${base} — ordvärlden.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function wireAudio(a) {
  const e = q();
  a.addEventListener('play', () => { e.pause.textContent = 'Paus'; });
  a.addEventListener('pause', () => { if (playing) e.pause.textContent = 'Spela'; });
  a.addEventListener('ended', () => { if (playing) exitSong(); });
}

async function onPlay(record = false) {
  const e = q();
  if (!song || playing) return;
  clearError();
  e.play.disabled = true;
  try {
    let inters = [];
    try {
      inters = await listInterludes();
    } catch {
      inters = []; // inga mellanspel är helt okej
    }
    const stations = buildStations(song, inters);
    if (stations.length === 0) throw new Error('låten innehåller inga ord att resa mellan');

    audio = new Audio(`/assets/songs/${encodeURIComponent(song.id)}/audio`);
    audio.preload = 'auto';
    wireAudio(audio);
    const recording = record && startRecorder(audio); // fel stoppar inte uppspelningen
    await audio.play();
    playing = true;

    // panelen kollapsar till mini-pillen; karaokeremsan tänds
    togglePanel(false);
    e.pillTitle.textContent = (recording ? '● ' : '') + (song.title || 'Låt');
    e.pause.textContent = 'Paus';
    e.pill.hidden = false;
    e.karaoke.hidden = false;
    updateKaraoke(stations, 0);

    if (callbacks.onEnterSong) callbacks.onEnterSong({ song, stations, audio });
  } catch (err) {
    playing = false;
    audio = null;
    showError(`Kunde inte starta uppspelningen: ${err.message}`);
  } finally {
    renderResult();
  }
}

function togglePause() {
  if (!audio) return;
  if (audio.paused) audio.play();
  else audio.pause();
}

function exitSong() {
  const e = q();
  stopRecorder(); // laddar ner filen om en inspelning pågick
  if (audio) {
    try { audio.pause(); } catch { /* redan stoppad */ }
  }
  audio = null;
  playing = false;
  e.pill.hidden = true;
  e.karaoke.hidden = true;
  if (callbacks.onExitSong) callbacks.onExitSong();
  renderResult();       // Spela aktiveras igen
  togglePanel(true);    // panelen tillbaka så låten kan spelas om
}

// Kopplar UI: ♪-knapp → panel → fil → upload → transkriberingsvy →
// "Generera N ord" → progress → "Spela". onEnterSong({song, stations, audio})
// anropas när användaren trycker Spela (audio = färdigt <audio>-element,
// spelande). onExitSong() när användaren lämnar låt-läget.
export function initSongMode({ onEnterSong, onExitSong }) {
  callbacks = { onEnterSong, onExitSong };
  const e = q();

  e.toggle.addEventListener('click', () => togglePanel());
  e.close.addEventListener('click', () => togglePanel(false));
  e.choose.addEventListener('click', () => e.file.click());
  e.file.addEventListener('change', onFileChosen);
  e.generate.addEventListener('click', onGenerate);
  if (e.lyrics) {
    e.lyrics.addEventListener('click', (ev) => {
      const span = ev.target.closest('.lyric-word');
      if (span) beginWordEdit(span);
    });
  }
  e.play.addEventListener('click', () => onPlay(false));
  if (e.exportBtn) e.exportBtn.addEventListener('click', () => onPlay(true));
  e.pause.addEventListener('click', togglePause);
  e.stop.addEventListener('click', exitSong);
  if (e.newSong) {
    e.newSong.addEventListener('click', () => {
      stopPolling();
      song = null;
      songId = null;
      generating = false;
      clearError();
      showStep('pick');
    });
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !e.panel.hidden) togglePanel(false);
  });
}
