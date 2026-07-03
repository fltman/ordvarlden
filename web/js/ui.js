// ui.js — textfält, statusnotiser, hjälpoverlay. Ren DOM, inga GPU-anrop.
// API per CONTRACT.md: initUI({onSubmitWord}), setStatus(msg, kind), setWordList(words, currentIndex).
// Extra: setBusy(bool), focusWordInput().
// Låt-lägets UI (#songbar, #songpanel, #songpill, #karaoke) är statisk markup i
// index.html; allt beteende bor i song.js (initSongMode m.fl., frusna i CONTRACT.md).

const HELP_SEEN_KEY = 'ordvarlden.helpSeen';

let els = null;
let busy = false;

function q() {
  if (!els) {
    els = {
      bar: document.getElementById('wordbar'),
      input: document.getElementById('word-input'),
      button: document.getElementById('word-submit'),
      status: document.getElementById('status'),
      statusText: document.getElementById('status-text'),
      wordlist: document.getElementById('wordlist'),
      help: document.getElementById('help'),
      helpToggle: document.getElementById('help-toggle'),
      helpPanel: document.getElementById('help-panel'),
    };
  }
  return els;
}

function toggleHelp(force) {
  const e = q();
  const open = force !== undefined ? force : e.helpPanel.hidden;
  e.helpPanel.hidden = !open;
  e.helpToggle.setAttribute('aria-expanded', String(open));
  e.help.classList.toggle('open', open);
}

export function initUI({ onSubmitWord }) {
  const e = q();

  e.bar.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (busy) return;
    const word = e.input.value.trim();
    if (!word) return;
    e.input.value = '';
    if (onSubmitWord) onSubmitWord(word);
  });

  // Tangenter i fältet ska inte styra kameran (W/S i main.js lyssnar på document).
  e.input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') e.input.blur();
    ev.stopPropagation();
  });

  e.helpToggle.addEventListener('click', () => toggleHelp());
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !e.helpPanel.hidden) toggleHelp(false);
  });

  // Visa den längre hjälpen vid första besöket.
  let seen = false;
  try { seen = localStorage.getItem(HELP_SEEN_KEY) === '1'; } catch { /* privat läge */ }
  if (!seen) {
    toggleHelp(true);
    try { localStorage.setItem(HELP_SEEN_KEY, '1'); } catch { /* privat läge */ }
  }
}

export function setBusy(b) {
  const e = q();
  busy = !!b;
  e.bar.classList.toggle('busy', busy);
  e.input.disabled = busy;
  e.button.disabled = busy;
  e.button.textContent = busy ? 'Skapar …' : 'Skapa';
}

export function setStatus(msg, kind = 'info') {
  const e = q();
  if (msg == null || msg === '') {
    e.status.hidden = true;
    return;
  }
  e.statusText.textContent = msg;
  e.status.dataset.kind = kind || 'info';
  e.status.hidden = false;
}

export function setWordList(words, currentIndex) {
  const e = q();
  e.wordlist.replaceChildren();
  for (let i = 0; i < (words ? words.length : 0); i++) {
    const w = words[i];
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = typeof w === 'string' ? w : w.word;
    if (i === currentIndex) span.classList.add('current');
    if (w && typeof w === 'object' && w.ready === false) span.classList.add('pending');
    e.wordlist.appendChild(span);
  }
}

export function focusWordInput() {
  q().input.focus();
}
