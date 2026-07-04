#!/usr/bin/env python3
"""Sångtext -> fri stämningsklausul via OpenRouter (textmodell).
Se CONTRACT.md "Stämning".

write_mood_clause(words, title="") -> 2–4 engelska meningar (sceninnehåll +
flat färgpalett) som appendas till bildprompten för alla låtens ord. Får
ALDRIG fälla transkriberingen: alla fel (saknad API-nyckel, API-fel, tomt
svar) ger "" (= neutral, ingen klausul).

CLI: mood.py <words.json>  — skriver klausulen på stdout (för test).
"""

import json
import os
import re
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import generate  # laddar .env och äger _client()

MODEL = os.environ.get("MOOD_MODEL", "google/gemini-2.5-flash")
MAX_CLAUSE_CHARS = 600

_PROMPT_TEMPLATE = """\
You write art direction for an illustrated world built from a song.

The base illustration style is locked and will be prepended for you — do not
restate it: hand-drawn comic ink, completely flat tones (at most 6), no
gradients, first-person view on a tiny round planet, a winding path toward
giant carved stone letters, starry night sky.

Read the full lyrics below and write 2-4 sentences that give the scene the
song's emotional atmosphere. You may direct:
- a limited FLAT color palette (name at most 6 specific flat colors/tones)
- weather and sky elements
- the state of the vegetation and the path
- the condition and character of the stone letters
- small props along the path

Rules: keep the hand-drawn flat-ink style; never ask for gradients, glow,
photorealism or a different line style; do not mention any specific word from
the lyrics or any text/letters content; write in English; output ONLY the
sentences, nothing else.

{title_line}Lyrics:
{lyrics}"""


def _prompt(lyrics: str, title: str) -> str:
    title_line = f'Song title: "{title}"\n\n' if title else ""
    return _PROMPT_TEMPLATE.format(title_line=title_line, lyrics=lyrics)


def _sanitize(text: str) -> str:
    """En rad, rimlig längd; citattecken/etiketter från modellen tvättas."""
    clause = re.sub(r"\s+", " ", (text or "")).strip().strip('"').strip()
    if len(clause) > MAX_CLAUSE_CHARS:
        cut = clause[:MAX_CLAUSE_CHARS]
        clause = cut[:cut.rfind(".") + 1] or cut  # klipp vid sista hela meningen
    return clause


def write_mood_clause(words: list, title: str = "") -> str:
    lyrics = " ".join(str(w) for w in words).strip()
    if not lyrics:
        return ""
    try:
        client = generate._client()
    except RuntimeError as e:
        print(f"stämningsklausul hoppas över: {e}", flush=True)
        return ""
    last_err = "okänt fel"
    for attempt in (1, 2):
        try:
            response = client.chat.completions.create(
                model=MODEL,
                messages=[{"role": "user", "content": _prompt(lyrics, title)}],
            )
            clause = _sanitize(response.choices[0].message.content)
            if clause:
                print(f"stämningsklausul: {clause}", flush=True)
                return clause
            last_err = "tomt svar"
        except Exception as e:
            last_err = str(e)
        if attempt == 1:
            print(f"stämningsklausul försök 1 misslyckades ({last_err}), försöker igen ...",
                  flush=True)
    print(f"stämningsklausul misslyckades: {last_err} — neutral", file=sys.stderr, flush=True)
    return ""


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("användning: mood.py <words.json>", file=sys.stderr)
        sys.exit(1)
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    print(write_mood_clause([w["w"] for w in data.get("words", [])], data.get("title", "")))
