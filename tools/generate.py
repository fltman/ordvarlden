#!/usr/bin/env python3
"""Generate a word-monument sketch PNG via OpenRouter (Gemini image preview).

Text-to-image by default; with a style reference the image is sent along
(img2img) so the new scene copies the established art style exactly.

Importable: generate(word, output, style_ref=None, mood=None) -> bool.
mood: fri stämningsklausul (text) som appendas till prompten; tom/None ger
NEUTRAL_PALETTE (den ursprungliga monokroma looken).
Configuration errors (missing API key / openai package) raise RuntimeError;
generation failures retry once and then return False.
"""

import argparse
import base64
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

try:
    from dotenv import load_dotenv
    load_dotenv(PROJECT_ROOT / ".env")
except ImportError:
    pass  # python-dotenv is optional; rely on the environment instead

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None

MODEL = "google/gemini-3-pro-image-preview"

# Locked style SKELETON per CONTRACT.md "Stil" — the palette is chosen by the
# mood clause (song mode) or NEUTRAL_PALETTE (free mode). The FOCAL element
# (what the path leads to) is either the carved word or, for a concrete noun,
# the object itself (subject.py). Do not change the skeleton without user's OK.
STYLE_PROMPT = (
    "Hand-drawn comic ink illustration with completely flat tones (at most 6), "
    "no gradients. First-person view standing on a tiny round planet "
    "with a strongly curved horizon. A winding path leads from the viewer toward "
    "{FOCAL}. "
    "Starry night sky with spiral galaxies. Rocks and small flowers along the "
    "path. Wide 16:9 landscape composition; the scene fills the entire frame "
    "edge to edge — no border, no vignette, no frame."
)

# Default focal element: the word as carved stone letters.
FOCAL_TEXT = 'giant monumental carved 3D stone letters spelling the word "{WORD}"'
# Concrete-noun focal element: the object itself as a colossal monument, no text.
FOCAL_OBJECT = (
    "a monumental sculpture of {SUBJECT} rising at the end of the path, as the "
    "single giant landmark — absolutely NO carved letters, words or writing anywhere"
)

# Free mode (no mood): the original monochrome look.
NEUTRAL_PALETTE = (
    "Strictly monochrome: exactly 4 flat grey tones, no color."
)

STYLE_REF_INSTRUCTION = (
    "Copy the exact art style of the reference image — the same line work, the "
    "same flat tones, the same composition language — but depict a NEW "
    "scene with a NEW subject: "
)

MIME_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}


def _client():
    if OpenAI is None:
        raise RuntimeError("openai-paketet saknas — installera i venv")
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY är inte satt (miljövariabel eller .env)")
    return OpenAI(base_url="https://openrouter.ai/api/v1", api_key=api_key)


def _extract_image(response) -> bytes | None:
    """OpenRouter puts images in message.images[*].image_url.url as data: URLs."""
    if not response.choices or not response.choices[0].message:
        return None
    message = response.choices[0].message
    for item in getattr(message, "images", None) or []:
        if isinstance(item, dict):
            url = (item.get("image_url") or {}).get("url", "")
        else:
            image_url = getattr(item, "image_url", None)
            url = getattr(image_url, "url", "") if image_url is not None else ""
        if url.startswith("data:image"):
            return base64.b64decode(url.split(",", 1)[1])
    return None


def _build_messages(word: str, style_ref, mood=None, subject=None) -> list:
    # mood = fri stämningsklausul (sceninnehåll + palett) skriven av tools/mood.py
    # subject = engelsk föremålsfras (subject.py); icke-tom ⇒ rita föremålet i
    # stället för de huggna bokstäverna.
    if subject and str(subject).strip():
        focal = FOCAL_OBJECT.replace("{SUBJECT}", str(subject).strip())
    else:
        focal = FOCAL_TEXT.replace("{WORD}", str(word))
    prompt = STYLE_PROMPT.replace("{FOCAL}", focal)
    prompt += " " + (mood.strip() if mood and mood.strip() else NEUTRAL_PALETTE)
    if style_ref:
        ref = Path(style_ref)
        if not ref.is_file():
            raise RuntimeError(f"stilreferensen finns inte: {ref}")
        mime = MIME_TYPES.get(ref.suffix.lower(), "image/png")
        b64 = base64.b64encode(ref.read_bytes()).decode("ascii")
        content = [
            {"type": "text", "text": "Generate an image. " + STYLE_REF_INSTRUCTION + prompt},
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
        ]
    else:
        content = "Generate an image. " + prompt
    return [{"role": "user", "content": content}]


def generate(word: str, output, style_ref=None, mood=None, subject=None) -> bool:
    output = Path(output)
    client = _client()
    messages = _build_messages(word, style_ref, mood, subject)

    last_err = "okänt fel"
    for attempt in (1, 2):
        try:
            response = client.chat.completions.create(model=MODEL, messages=messages)
            data = _extract_image(response)
            if data:
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(data)
                print(f"{word}: bild sparad -> {output} ({len(data) // 1024} KB)", flush=True)
                return True
            last_err = "svaret innehöll ingen bild"
        except Exception as e:  # network/API errors: retry once, then give up
            last_err = str(e)
        if attempt == 1:
            print(f"{word}: försök 1 misslyckades ({last_err}), försöker igen ...", flush=True)
    print(f"{word}: generering misslyckades: {last_err}", file=sys.stderr, flush=True)
    return False


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Ord -> monument-PNG via OpenRouter")
    ap.add_argument("word")
    ap.add_argument("--output", required=True, help="sökväg till PNG som skrivs")
    ap.add_argument("--style-ref", help="tidigare original.png att kopiera stilen från")
    ap.add_argument("--mood", help="fri stämningsklausul (sceninnehåll + palett)")
    ap.add_argument("--subject", help="engelsk föremålsfras: rita föremålet i "
                    "stället för de huggna bokstäverna (t.ex. 'a giant sausage')")
    a = ap.parse_args()
    try:
        ok = generate(a.word, a.output, a.style_ref, a.mood, a.subject)
    except RuntimeError as e:
        print(f"FEL: {e}", file=sys.stderr)
        sys.exit(1)
    sys.exit(0 if ok else 1)
