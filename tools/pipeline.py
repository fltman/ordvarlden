#!/usr/bin/env python3
"""Word -> assets/words/<slug>/{original.png, flat.png, traced.svg, scene.json}.

run_pipeline(word) validates + slugifies the word, generates original.png via
OpenRouter (skipped if it already exists), using the most recently generated
other word as style reference, then vectorizes to scene.json.
"""

import argparse
import json
import re
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TOOLS_DIR.parent
WORDS_DIR = PROJECT_ROOT / "assets" / "words"

if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import generate as generate_mod
import vectorize

# CONTRACT.md: 1–16 chars of letters (incl. åäö), digits, space, ! ? -
WORD_RE = re.compile(r"^[A-Za-zÅÄÖåäö0-9 !?\-]{1,16}$")

_SLUG_TRANSLATE = str.maketrans({"å": "a", "ä": "a", "ö": "o"})


def validate_word(word) -> bool:
    return isinstance(word, str) and bool(WORD_RE.match(word))


def display_word(word: str) -> str:
    """Form used in the prompt and in scene.json (monumental letters)."""
    return word.strip().upper()


def slugify(word: str) -> str:
    """Validate per CONTRACT first, then: lowercase, å/ä->a ö->o,
    spaces->'-', strip all other characters. Raises ValueError."""
    if not validate_word(word):
        raise ValueError("Ogiltigt ord: 1–16 tecken av A–Ö, siffror, mellanslag, ! ? -")
    s = word.lower().translate(_SLUG_TRANSLATE).replace(" ", "-")
    s = re.sub(r"[^a-z0-9-]", "", s)
    s = re.sub(r"-{2,}", "-", s).strip("-")
    if not s:
        raise ValueError("Ordet gav en tom slug — använd minst en bokstav eller siffra")
    return s


def _latest_style_ref(exclude_slug: str) -> Path | None:
    """original.png of the most recently generated OTHER word, if any."""
    best, best_mtime = None, -1.0
    if WORDS_DIR.is_dir():
        for d in WORDS_DIR.iterdir():
            if not d.is_dir() or d.name == exclude_slug:
                continue
            png = d / "original.png"
            if png.is_file():
                mtime = png.stat().st_mtime
                if mtime > best_mtime:
                    best, best_mtime = png, mtime
    return best


def run_pipeline(word: str, status_callback=None, no_generate: bool = False) -> dict:
    slug = slugify(word)
    display = display_word(word)
    word_dir = WORDS_DIR / slug
    word_dir.mkdir(parents=True, exist_ok=True)
    original = word_dir / "original.png"
    scene_path = word_dir / "scene.json"

    def phase(p: str):
        if status_callback:
            status_callback(p)

    generated = False
    if not original.is_file():
        if no_generate:
            raise RuntimeError(f"original.png saknas för '{slug}' och generering är avstängd (--no-generate)")
        phase("generating")
        style_ref = _latest_style_ref(slug)
        if not generate_mod.generate(display, original, style_ref):
            raise RuntimeError(f"Bildgenereringen misslyckades för '{display}'")
        generated = True

    phase("vectorizing")
    scene = vectorize.vectorize(original, scene_path, display)

    return {
        "word": display,
        "slug": slug,
        "dir": str(word_dir),
        "scene_json": str(scene_path),
        "generated": generated,
        "shapes": len(scene["shapes"]),
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Ord -> genererad + vektoriserad scen")
    ap.add_argument("word")
    ap.add_argument("--no-generate", action="store_true",
                    help="hoppa över genereringssteget (fel om original.png saknas)")
    a = ap.parse_args()
    try:
        info = run_pipeline(a.word, status_callback=lambda p: print(f"[{p}]", flush=True),
                            no_generate=a.no_generate)
    except (ValueError, RuntimeError) as e:
        print(f"FEL: {e}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(info, ensure_ascii=False))
