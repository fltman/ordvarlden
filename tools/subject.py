#!/usr/bin/env python3
"""Ord -> föremålsfras via OpenRouter (textmodell). Se CONTRACT.md "Stil".

object_for_word(word) avgör om ordet är ett KONKRET, avbildbart substantiv
(ett fysiskt föremål/varelse/ting man kan hugga som en jättestaty). I så fall
returneras en kort engelsk fras i monumental skala ("a giant sausage",
"an enormous mosquito"); annars "" (⇒ behåll de huggna bokstäverna).

Får ALDRIG fälla en generering: alla fel (saknad API-nyckel, API-fel, tomt
svar) ger "" (= text-fallback). Styrs av env WORD_AS_OBJECT (hanteras av
anroparen, pipeline.py) och SUBJECT_MODEL (default google/gemini-2.5-flash).

CLI: subject.py <ord> [<ord> ...]  — skriver "ORD -> fras|NONE" per rad (test).
"""

import os
import re
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import generate  # laddar .env och äger _client()

MODEL = os.environ.get("SUBJECT_MODEL", "google/gemini-2.5-flash")
MAX_PHRASE_CHARS = 70

_PROMPT_TEMPLATE = """\
You label a single word from song lyrics for an illustrated world. Each scene \
shows a tiny planet with a winding path leading to one giant monument.

If the word is a CONCRETE, PHYSICAL, depictable noun — a specific object, \
creature, animal, food, plant, tool, vehicle, garment, or body part that could \
be built as a colossal statue — reply with a SHORT English noun phrase naming \
it at monumental scale, for example:
  "a giant sausage", "a towering pine tree", "an enormous mosquito", \
"a colossal wristwatch", "a giant grilling fork".

For ANYTHING else reply with exactly: NONE
That includes verbs, adjectives, adverbs, pronouns, prepositions, articles, \
numbers, greetings, names of people or places, and ABSTRACT nouns \
(seasons, weather, emotions, ideas, time, sounds).

The word may be Swedish — translate it first. Prefer NONE when unsure. \
Reply with ONLY the phrase, or NONE. Nothing else.

Word: "{WORD}\""""


def _sanitize(text: str) -> str:
    phrase = re.sub(r"\s+", " ", (text or "")).strip().strip('"').strip()
    if not phrase:
        return ""
    # Modellen kan råka svara i flera rader; ta första raden.
    phrase = phrase.splitlines()[0].strip().strip('"').strip().rstrip(".")
    if not phrase or phrase.upper() == "NONE":
        return ""
    if len(phrase) > MAX_PHRASE_CHARS:
        return ""  # ett helt stycke = troligen inte en ren föremålsfras
    return phrase


def object_for_word(word: str, title: str = "") -> str:
    word = (word or "").strip()
    if not word:
        return ""
    try:
        client = generate._client()
    except RuntimeError as e:
        print(f"föremålsklassning hoppas över: {e}", flush=True)
        return ""
    last_err = "okänt fel"
    for attempt in (1, 2):
        try:
            response = client.chat.completions.create(
                model=MODEL,
                messages=[{"role": "user",
                           "content": _PROMPT_TEMPLATE.format(WORD=word)}],
            )
            phrase = _sanitize(response.choices[0].message.content)
            if phrase:
                print(f"föremål: {word} -> {phrase}", flush=True)
            else:
                print(f"föremål: {word} -> (text)", flush=True)
            return phrase  # tomt svar = NONE = text (giltigt utfall, ingen retry)
        except Exception as e:
            last_err = str(e)
        if attempt == 1:
            print(f"föremålsklassning försök 1 misslyckades ({last_err}), försöker igen ...",
                  flush=True)
    print(f"föremålsklassning misslyckades: {last_err} — text", file=sys.stderr, flush=True)
    return ""


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("användning: subject.py <ord> [<ord> ...]", file=sys.stderr)
        sys.exit(1)
    for w in sys.argv[1:]:
        phrase = object_for_word(w)
        print(f"{w} -> {phrase or 'NONE'}")
