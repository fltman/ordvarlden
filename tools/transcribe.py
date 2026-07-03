#!/usr/bin/env python3
"""Låt -> words.json: ord-för-ord-transkribering med tidsstämplar.

Kedja (CONTRACT.md "Låt-läge", fruset API):
  ffmpeg -> audio.wav (16 kHz mono pcm_s16le)
  whisper-cli -ojf --dtw --prompt "Sångtext / lyrics:"
  tokens -> ord med DTW-tidsstämplar (attention-alignade = när ordet SJUNGS)
  interpunktionstvätt (å ä ö behålls) + ordvalidering + hallucinationsfilter
  -> <song_dir>/words.json  (fruset format) som även returneras som dict.

Fältfynd som styr designen (2026-07-04):
  * Utan lyrics-prompt hallucinerar whisper över musik ("We'll be right back",
    "Textning Stina Hedin ...") och hör INGEN sång. Prompten väcker den.
  * -ml 1 ger usla ordtider på musik (segmentgränserna smetas över tystnad).
    --dtw ger token-tider som pekar på när ordet faktiskt sjungs.

CLI: transcribe.py <ljudfil> <song_dir>
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from pipeline import slugify  # samma slug-regler som ordpipelinen — dubblera inte

WHISPER_CLI = os.environ.get(
    "WHISPER_CLI", "/Users/andersbj/Projekt/whisper.cpp/build/bin/whisper-cli")
WHISPER_MODEL = os.environ.get(
    "WHISPER_MODEL", "/Users/andersbj/Projekt/whisper.cpp/models/ggml-large-v3-turbo.bin")
WHISPER_DTW = os.environ.get("WHISPER_DTW", "large.v3.turbo")  # måste matcha modellen
WHISPER_PROMPT = os.environ.get("WHISPER_PROMPT", "Sångtext / lyrics:")

# Hallucinationsfilter: en riktig sångrad varar aldrig > 12 s; längre segment
# är whisper som fabulerar över instrumentala partier.
MAX_SEGMENT_SEC = 12.0

# Kända whisper-hallucinationer över musik/tystnad (case-insensitive).
KNOWN_HALLUCINATIONS = re.compile(
    r"we'?ll be right back|i'?ll see you next time|thanks? for watching|"
    r"textning|undertexter?|btistudios|www\.|\.com|\.se\b|"
    r"tack (för att du|till er som) titta", re.I)

# CONTRACT "Låt-läge": 1–16 tecken [A-Za-zÅÄÖåäö0-9!?-] efter interpunktionstvätt
# (obs: inget mellanslag här — transkriberade ord är enstaka ord).
SONG_WORD_RE = re.compile(r"^[A-Za-zÅÄÖåäö0-9!?\-]{1,16}$")
# Interpunktionstvätt: ta bort skiljetecken (kommatecken, punkter, citattecken,
# ♪ …) men behåll ALLA bokstäver — ord med bokstäver utanför den tillåtna
# mängden (t.ex. 'ú', 'ß') ska falla på valideringen, inte tvättas om till
# något annat ord.
_STRIP_RE = re.compile(r"[^\w!?\-]+", re.UNICODE)


def _run(cmd, what):
    """Kör ett externt kommando; RuntimeError med läsbart fel vid misslyckande."""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError as e:
        raise RuntimeError(f"{what}: hittar inte binären '{cmd[0]}'") from e
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-6:]
        raise RuntimeError(f"{what} misslyckades (kod {proc.returncode}): " + " | ".join(tail))
    return proc


def _ffprobe_duration(path) -> float:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True)
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return 0.0


def _clean_word(token: str) -> str:
    """'hjärta,' -> 'hjärta'; '- Hej' -> 'Hej'; '♪' -> ''. Behåller å ä ö."""
    return _STRIP_RE.sub("", token).strip("-_")


def _is_hallucination(text: str, dur: float) -> bool:
    if dur > MAX_SEGMENT_SEC:
        return True
    # Icke-tal-etiketter: *musik*, [Applåder], (instrumental)
    if text and text[0] in "*[(" and text[-1] in "*])":
        return True
    return False


def _token_groups(seg) -> list[dict]:
    """Gruppera whisper-tokens till ord. Token som börjar med mellanslag
    inleder ett nytt ord; efterföljande subword-tokens ('Bo'+'ots') slås ihop.
    Starttid = t_dtw (centisekunder, attention-alignad) med tokenoffset som
    fallback när DTW saknas (-1)."""
    groups = []
    for tok in seg.get("tokens") or []:
        text = str(tok.get("text", ""))
        if text.startswith("[_") or not text.strip():
            continue  # [_BEG_]/[_TT_..] och rena whitespace-tokens
        dtw = tok.get("t_dtw", -1)
        if isinstance(dtw, (int, float)) and dtw >= 0:
            tstart = float(dtw) / 100.0
        else:
            tstart = float((tok.get("offsets") or {}).get("from", 0)) / 1000.0
        if text.startswith(" ") or not groups:
            groups.append({"text": text.strip(), "start": tstart})
        else:
            groups[-1]["text"] += text.strip()
    return groups


def _segments_to_words(segments) -> list[dict]:
    words = []
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        text = str(seg.get("text", "")).strip()
        if not text:
            continue
        offsets = seg.get("offsets") or {}
        try:
            seg_start = float(offsets.get("from", 0)) / 1000.0
            seg_end = float(offsets.get("to", 0)) / 1000.0
        except (TypeError, ValueError):
            continue
        if _is_hallucination(text, seg_end - seg_start):
            continue
        if KNOWN_HALLUCINATIONS.search(text):
            continue

        groups = _token_groups(seg)
        if not groups:
            # Fallback utan tokendata (-oj i stället för -ojf): dela raden linjärt.
            parts = text.split()
            span = (seg_end - seg_start) / max(1, len(parts))
            groups = [{"text": p, "start": seg_start + i * span}
                      for i, p in enumerate(parts)]

        for i, g in enumerate(groups):
            cleaned = _clean_word(g["text"])
            if not cleaned or not SONG_WORD_RE.match(cleaned):
                continue  # klarar inte valideringen -> filtreras bort
            display = cleaned.upper()
            try:
                slug = slugify(display)
            except ValueError:
                continue  # t.ex. bara '!?' -> tom slug
            w_start = g["start"]
            w_end = groups[i + 1]["start"] if i + 1 < len(groups) else min(seg_end, w_start + 0.6)
            w_end = max(w_end, w_start + 0.05)
            words.append({"w": display, "slug": slug,
                          "start": round(w_start, 3), "end": round(w_end, 3)})

    words.sort(key=lambda w: w["start"])  # stabil — bevarar segmentordning
    # Säkerställ strikt stigande starttider (songPosition kräver monotoni).
    for i in range(1, len(words)):
        if words[i]["start"] <= words[i - 1]["start"]:
            words[i]["start"] = round(words[i - 1]["start"] + 0.01, 3)
            words[i]["end"] = max(words[i]["end"], words[i]["start"] + 0.05)
    return words


def transcribe_song(input_path, song_dir, title=None) -> dict:
    """Transkribera en låt ord-för-ord. Skriver <song_dir>/words.json och
    returnerar samma dict (fruset format, se CONTRACT.md).

    title: visningsnamn för låten; default = ljudfilens filnamn.
    """
    input_path = Path(input_path)
    song_dir = Path(song_dir)
    if not input_path.is_file():
        raise RuntimeError(f"Ljudfilen finns inte: {input_path}")
    song_dir.mkdir(parents=True, exist_ok=True)

    # 1) ffmpeg -> 16 kHz mono pcm_s16le för whisper
    wav = song_dir / "audio.wav"
    if input_path.resolve() != wav.resolve():
        _run(["ffmpeg", "-nostdin", "-y", "-i", str(input_path), "-vn",
              "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)],
             "ffmpeg-konvertering")

    # 2) längd via ffprobe (originalet; fallback till wav:en)
    duration = _ffprobe_duration(input_path)
    if duration <= 0:
        duration = _ffprobe_duration(wav)

    # 3) whisper-cli, JSON-utdata till tempkatalog
    if not Path(WHISPER_CLI).is_file():
        raise RuntimeError(f"whisper-cli saknas: {WHISPER_CLI}")
    if not Path(WHISPER_MODEL).is_file():
        raise RuntimeError(f"whisper-modellen saknas: {WHISPER_MODEL}")
    with tempfile.TemporaryDirectory() as tmp:
        out_prefix = os.path.join(tmp, "whisper")
        _run([WHISPER_CLI, "-m", WHISPER_MODEL, "-f", str(wav),
              "-l", "auto", "-ojf", "--dtw", WHISPER_DTW,
              "--prompt", WHISPER_PROMPT,
              "-t", str(os.cpu_count() or 4), "-of", out_prefix],
             "whisper-cli")
        json_path = out_prefix + ".json"
        if not os.path.exists(json_path):
            raise RuntimeError("whisper-cli skrev ingen JSON-utdata")
        with open(json_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)

    # 4) segment -> validerade ord med tidsstämplar
    words = _segments_to_words(data.get("transcription") or [])

    # 5) words.json (FRUSET format)
    result = {
        "id": song_dir.name,
        "title": str(title) if title else input_path.name,
        "duration": round(duration, 2),
        "words": words,
    }
    out_path = song_dir / "words.json"
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)
    return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Låt -> words.json (ord + tidsstämplar)")
    ap.add_argument("ljudfil")
    ap.add_argument("song_dir")
    ap.add_argument("--titel", default=None, help="visningsnamn (default: filnamnet)")
    a = ap.parse_args()
    try:
        res = transcribe_song(a.ljudfil, a.song_dir, title=a.titel)
    except RuntimeError as e:
        print(f"FEL: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"{len(res['words'])} ord, {res['duration']} s", file=sys.stderr)
    print(json.dumps(res, ensure_ascii=False))
