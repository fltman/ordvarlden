#!/usr/bin/env python3
"""Ordvärlden — static files + word/song API. Stdlib only. Port: env PORT (default 8144).

Static: GET / -> web/index.html, /js /css from web/, /assets/* from assets/.
API:    GET /api/words, POST /api/word, GET /api/word/<slug>/status,
        POST /api/song?name=, GET /api/song/<id>, POST /api/song/<id>/generate,
        GET /api/interludes, GET /assets/songs/<id>/audio.
Three worker threads run the generation/vectorization queue (API-bound);
each song transcription runs in its own background thread.
"""

import json
import os
import queue
import re
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

PROJECT_ROOT = Path(__file__).resolve().parent
WEB_DIR = PROJECT_ROOT / "web"
ASSETS_DIR = PROJECT_ROOT / "assets"
WORDS_DIR = ASSETS_DIR / "words"
SONGS_DIR = ASSETS_DIR / "songs"
INTERLUDES_DIR = ASSETS_DIR / "interludes"
PORT = int(os.environ.get("PORT", "8144"))
PIPELINE_WORKERS = 3
MAX_SONG_BYTES = 60 * 1024 * 1024  # 60 MB

sys.path.insert(0, str(PROJECT_ROOT / "tools"))
import pipeline

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}

AUDIO_TYPES = {
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "wav": "audio/wav",
    "aiff": "audio/aiff",
    "aif": "audio/aiff",
    "ogg": "audio/ogg",
    "flac": "audio/flac",
}

ACTIVE_STATUSES = ("queued", "generating", "vectorizing")

# ---------------------------------------------------------------- job queue

_jobs_lock = threading.Lock()
_jobs: dict[str, dict] = {}  # slug -> {"word", "status", "error"} (insertion = queue order)
_job_queue: queue.Queue = queue.Queue()


def _set_status(slug: str, status: str, error: str | None = None):
    with _jobs_lock:
        job = _jobs.get(slug)
        if job is not None:
            job["status"] = status
            job["error"] = error


def _worker():
    while True:
        slug, word, mood = _job_queue.get()
        try:
            pipeline.run_pipeline(word, status_callback=lambda p: _set_status(slug, p),
                                  mood=mood)
            _set_status(slug, "ready")
        except Exception as e:
            _set_status(slug, "error", str(e))
            print(f"jobb '{slug}' misslyckades: {e}", flush=True)
        finally:
            _job_queue.task_done()


# -------------------------------------------------------------------- songs

_songs_lock = threading.Lock()
_songs: dict[str, dict] = {}  # id -> {"title", "status", "error", "data"}


def _transcribe_song_job(song_id: str, input_path: Path, song_dir: Path, title: str):
    """Background thread: run tools/transcribe.py on the uploaded file."""
    try:
        import transcribe  # lazy — tools/ is first on sys.path
    except ImportError as e:
        with _songs_lock:
            song = _songs.get(song_id)
            if song is not None:
                song.update(status="error", error=f"tools/transcribe.py saknas: {e}")
        print(f"låt '{song_id}': transcribe-modulen saknas: {e}", flush=True)
        return
    try:
        data = transcribe.transcribe_song(input_path, song_dir)
        data["title"] = title  # server knows the uploaded filename; fix it in words.json
        try:
            import mood as mood_mod  # tools/ is first on sys.path
            data["mood"] = mood_mod.write_mood_clause(
                [w["w"] for w in data.get("words", [])], title)
        except Exception as e:  # write_mood_clause är felsäker, men import kan fela
            data["mood"] = ""
            print(f"låt '{song_id}': stämningsklausulen hoppades över: {e}", flush=True)
        (song_dir / "words.json").write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8")
        with _songs_lock:
            song = _songs.get(song_id)
            if song is not None:
                song.update(status="ready", error=None, data=data)
        print(f"låt '{song_id}' transkriberad: {len(data.get('words', []))} ord", flush=True)
    except Exception as e:
        with _songs_lock:
            song = _songs.get(song_id)
            if song is not None:
                song.update(status="error", error=str(e))
        print(f"låt '{song_id}': transkriberingen misslyckades: {e}", flush=True)


def _song_mood(data: dict) -> str:
    """Låtens stämningsklausul ur words.json; saknat/ogiltigt ⇒ "" (neutral)."""
    mood = data.get("mood", "")
    return mood.strip() if isinstance(mood, str) else ""


def _unique_words(words: list[dict]) -> list[dict]:
    """Unique words in first-occurrence order; ready = scene.json exists."""
    seen, out = set(), []
    for w in words:
        slug = w["slug"]
        if slug in seen:
            continue
        seen.add(slug)
        out.append({"slug": slug, "w": w["w"],
                    "ready": (WORDS_DIR / slug / "scene.json").is_file()})
    return out


def _song_state(song_id: str) -> dict | None:
    """In-memory state, falling back to disk (survives server restart)."""
    with _songs_lock:
        song = _songs.get(song_id)
        if song is not None:
            return dict(song)
    song_dir = SONGS_DIR / song_id
    words_json = song_dir / "words.json"
    if words_json.is_file():
        try:
            data = json.loads(words_json.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"title": "", "status": "error",
                    "error": "words.json är oläsbar", "data": None}
        song = {"title": data.get("title", ""), "status": "ready",
                "error": None, "data": data}
        with _songs_lock:
            _songs.setdefault(song_id, song)
        return dict(song)
    if song_dir.is_dir():
        return {"title": "", "status": "error",
                "error": "Transkriberingen avbröts (servern startades om)", "data": None}
    return None


def _song_response(song_id: str) -> dict | None:
    song = _song_state(song_id)
    if song is None:
        return None
    resp = {"id": song_id, "title": song["title"], "status": song["status"]}
    if song["status"] == "error" and song["error"]:
        resp["error"] = song["error"]
    if song["status"] == "ready" and song["data"] is not None:
        data = song["data"]
        mood = _song_mood(data)
        resp["duration"] = data.get("duration")
        resp["mood"] = mood
        # words.json bär rena ordslugs; API-svaret bär asset-slugs
        # (<slug>--m<hash>) så att frontenden kan bygga scene-URL:er rakt av.
        resp["words"] = [{**w, "slug": pipeline.asset_slug(w["slug"], mood)}
                         for w in data.get("words", [])]
        resp["unique"] = _unique_words(resp["words"])
    return resp


def _list_interludes() -> list[dict]:
    if not INTERLUDES_DIR.is_dir():
        return []
    return [{"slug": p.parent.name}
            for p in sorted(INTERLUDES_DIR.glob("*/scene.json"))]


# ---------------------------------------------------------------- word list

_word_cache: dict[Path, tuple[float, str]] = {}  # scene.json -> (mtime, word)


def _scene_word(scene_path: Path) -> str:
    mtime = scene_path.stat().st_mtime
    cached = _word_cache.get(scene_path)
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        word = json.loads(scene_path.read_text())["word"]
    except (OSError, ValueError, KeyError):
        word = scene_path.parent.name.upper()
    _word_cache[scene_path] = (mtime, word)
    return word


def _list_words() -> list[dict]:
    """World order = scene.json mtime ascending (stable append order),
    then queued/in-progress words with ready:false."""
    scenes = sorted(WORDS_DIR.glob("*/scene.json"), key=lambda p: p.stat().st_mtime) \
        if WORDS_DIR.is_dir() else []
    out, seen = [], set()
    for scene in scenes:
        slug = scene.parent.name
        seen.add(slug)
        out.append({"word": _scene_word(scene), "slug": slug, "ready": True})
    with _jobs_lock:
        pending = [(slug, job["word"]) for slug, job in _jobs.items()
                   if slug not in seen and job["status"] in ACTIVE_STATUSES]
    for slug, word in pending:
        out.append({"word": word, "slug": slug, "ready": False})
    return out


# ------------------------------------------------------------------ handler

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Ordvarlden/1.0"

    def log_message(self, fmt, *args):  # one line per request, to stdout
        print(f"{self.address_string()} {fmt % args}", flush=True)

    # -- responses ----------------------------------------------------------
    def _send_json(self, obj, status: int = 200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_404(self):
        body = "404 — hittades inte".encode("utf-8")
        self.send_response(404)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_file(self, path: Path):
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(path.suffix.lower(),
                                                           "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    # -- static -------------------------------------------------------------
    def _resolve_static(self, url_path: str) -> Path | None:
        """Map URL to a file under web/ or assets/, confined to project root."""
        rel = unquote(url_path).lstrip("/")
        if rel == "":
            rel, base = "index.html", WEB_DIR
        elif rel == "assets" or rel.startswith("assets/"):
            rel, base = rel[len("assets"):].lstrip("/"), ASSETS_DIR
        else:
            base = WEB_DIR
        try:
            target = (base / rel).resolve()
        except OSError:
            return None
        if not target.is_relative_to(base.resolve()):
            return None  # traversal attempt
        return target

    # -- routes ---------------------------------------------------------------
    def do_GET(self):
        self._handle_get()

    def do_HEAD(self):
        self._handle_get()

    def _handle_get(self):
        path = urlsplit(self.path).path
        if path == "/api/words":
            return self._send_json(_list_words())
        if path == "/api/interludes":
            return self._send_json(_list_interludes())
        m = re.fullmatch(r"/api/word/([A-Za-z0-9\-]{1,32})/status", path)
        if m:
            return self._api_status(m.group(1))
        m = re.fullmatch(r"/api/song/([0-9a-f]{8})", path)
        if m:
            resp = _song_response(m.group(1))
            if resp is None:
                return self._send_json({"error": "Okänd låt"}, 404)
            return self._send_json(resp)
        if path.startswith("/api/"):
            return self._send_json({"error": "Okänd API-väg"}, 404)
        m = re.fullmatch(r"/assets/songs/([0-9a-f]{8})/audio", path)
        if m:
            return self._serve_song_audio(m.group(1))
        target = self._resolve_static(path)
        if target is None or not target.is_file():
            return self._send_404()
        self._send_file(target)

    def _serve_song_audio(self, song_id: str):
        """Serve original.<ext> with correct content-type; supports byte ranges
        (Safari kräver Range-stöd för <audio>)."""
        song_dir = SONGS_DIR / song_id
        matches = sorted(song_dir.glob("original.*")) if song_dir.is_dir() else []
        if not matches:
            return self._send_404()
        path = matches[0]
        ctype = AUDIO_TYPES.get(path.suffix.lower().lstrip("."), "application/octet-stream")
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip()) if rng else None
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:  # suffix range: last N bytes
                start = max(size - int(m.group(2)), 0)
            if size == 0 or start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        if self.command == "HEAD":
            return
        with path.open("rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(1 << 20, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _api_status(self, slug: str):
        with _jobs_lock:
            job = dict(_jobs[slug]) if slug in _jobs else None
        if job is not None:
            resp = {"status": job["status"]}
            if job["error"]:
                resp["error"] = job["error"]
            return self._send_json(resp)
        if (WORDS_DIR / slug / "scene.json").is_file():
            return self._send_json({"status": "ready"})
        return self._send_json({"error": "Okänt ord"}, 404)

    def handle_expect_100(self):
        """Reject oversized uploads before the client sends the body."""
        length = self.headers.get("Content-Length", "")
        if length.isdigit() and int(length) > MAX_SONG_BYTES:
            self._send_json({"error": "Filen är för stor (max 60 MB)"}, 413)
            self.close_connection = True
            return False
        return super().handle_expect_100()

    def do_POST(self):
        url = urlsplit(self.path)
        path = url.path
        if path == "/api/song":
            return self._api_song_upload(url.query)
        m = re.fullmatch(r"/api/song/([0-9a-f]{8})/generate", path)
        if m:
            return self._api_song_generate(m.group(1))
        m = re.fullmatch(r"/api/song/([0-9a-f]{8})/words", path)
        if m:
            return self._api_song_words(m.group(1))
        if path == "/api/word":
            return self._api_word_post()
        return self._send_json({"error": "Okänd API-väg"}, 404)

    def _api_word_post(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            word = data.get("word")
        except (ValueError, UnicodeDecodeError, AttributeError):
            return self._send_json({"error": "Ogiltig JSON-body — förväntar {\"word\": \"...\"}"}, 400)
        if not isinstance(word, str):
            return self._send_json({"error": "Fältet 'word' saknas eller är inte en sträng"}, 400)
        try:
            slug = pipeline.slugify(word)
        except ValueError as e:
            return self._send_json({"error": str(e)}, 400)

        if (WORDS_DIR / slug / "scene.json").is_file():
            return self._send_json({"slug": slug, "status": "ready"})

        enqueue = False
        with _jobs_lock:
            job = _jobs.get(slug)
            if job is not None and job["status"] != "error":
                status = job["status"]
            else:
                _jobs[slug] = {"word": pipeline.display_word(word), "status": "queued", "error": None}
                status, enqueue = "queued", True
        if enqueue:
            _job_queue.put((slug, word, None))
        return self._send_json({"slug": slug, "status": status})

    def _api_song_words(self, song_id: str):
        """Redigerad transkribering: validera, slugifiera om, skriv words.json.
        Body = {"words": [{"w", "start", "end"?}, ...]} (hela nya listan,
        utan slugs). Svar = samma format som GET /api/song/<id>."""
        state = _song_state(song_id)
        if state is None:
            return self._send_json({"error": "Okänd låt"}, 404)
        if state["status"] != "ready" or state["data"] is None:
            return self._send_json(
                {"error": "Låten är inte färdigtranskriberad", "status": state["status"]}, 409)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            raw_words = body.get("words")
        except (ValueError, UnicodeDecodeError, AttributeError):
            return self._send_json({"error": "Ogiltig JSON-body — förväntar {\"words\": [...]}"}, 400)
        if not isinstance(raw_words, list):
            return self._send_json({"error": "Fältet 'words' saknas eller är inte en lista"}, 400)

        new_words = []
        for w in raw_words:
            if not isinstance(w, dict):
                return self._send_json({"error": "Varje ord måste vara ett objekt {w, start}"}, 400)
            word, start = w.get("w"), w.get("start")
            if not isinstance(word, str) or not isinstance(start, (int, float)):
                return self._send_json({"error": "Varje ord behöver 'w' (sträng) och 'start' (tal)"}, 400)
            try:
                slug = pipeline.slugify(word)
            except ValueError:
                return self._send_json(
                    {"error": f"Ogiltigt ord \"{word.strip()}\" — 1–16 tecken av A–Ö, "
                              "siffror, mellanslag, ! ? -"}, 400)
            entry = {"w": pipeline.display_word(word), "slug": slug, "start": float(start)}
            if isinstance(w.get("end"), (int, float)):
                entry["end"] = float(w["end"])
            new_words.append(entry)
        new_words.sort(key=lambda e: e["start"])

        with _songs_lock:
            song = _songs.get(song_id)
            if song is None or song["data"] is None:
                return self._send_json({"error": "Okänd låt"}, 404)
            song["data"]["words"] = new_words
            data = dict(song["data"])
        (SONGS_DIR / song_id / "words.json").write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return self._send_json(_song_response(song_id))

    # -- song routes ----------------------------------------------------------
    def _api_song_upload(self, query: str):
        length_hdr = self.headers.get("Content-Length", "")
        if not length_hdr.isdigit():
            return self._send_json({"error": "Content-Length krävs"}, 411)
        length = int(length_hdr)
        if length > MAX_SONG_BYTES:
            self.close_connection = True  # don't try to read the huge body
            return self._send_json({"error": "Filen är för stor (max 60 MB)"}, 413)
        if length == 0:
            return self._send_json({"error": "Tom fil"}, 400)

        params = parse_qs(query)
        name = Path((params.get("name") or ["låt"])[0]).name.strip() or "låt"
        ext = Path(name).suffix.lower().lstrip(".")
        if not re.fullmatch(r"[a-z0-9]{1,5}", ext or ""):
            ext = "bin"

        song_id = secrets.token_hex(4)  # 8 hex chars
        while (SONGS_DIR / song_id).exists():
            song_id = secrets.token_hex(4)
        song_dir = SONGS_DIR / song_id
        song_dir.mkdir(parents=True, exist_ok=True)
        dest = song_dir / f"original.{ext}"

        remaining = length
        with dest.open("wb") as f:
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        if remaining > 0:
            dest.unlink(missing_ok=True)
            self.close_connection = True
            return self._send_json({"error": "Ofullständig uppladdning"}, 400)

        with _songs_lock:
            _songs[song_id] = {"title": name, "status": "transcribing",
                               "error": None, "data": None}
        threading.Thread(target=_transcribe_song_job,
                         args=(song_id, dest, song_dir, name),
                         daemon=True, name=f"transcribe-{song_id}").start()
        return self._send_json({"id": song_id, "status": "transcribing"})

    def _api_song_generate(self, song_id: str):
        resp = _song_response(song_id)
        if resp is None:
            return self._send_json({"error": "Okänd låt"}, 404)
        if resp["status"] != "ready":
            return self._send_json(
                {"error": "Låten är inte färdigtranskriberad", "status": resp["status"]}, 409)
        mood = resp.get("mood", "")
        queued = 0
        for u in resp["unique"]:  # already first-occurrence order
            if u["ready"]:
                continue
            slug, word = u["slug"], u["w"]  # slug = asset-slug (<slug>--m<hash>)
            try:
                if pipeline.asset_slug(pipeline.slugify(word), mood) != slug:
                    print(f"låt '{song_id}': hoppar över '{word}' (slug-avvikelse)", flush=True)
                    continue
            except ValueError:
                continue
            with _jobs_lock:
                job = _jobs.get(slug)
                if job is not None and job["status"] in ACTIVE_STATUSES:
                    continue  # already queued/in progress
                _jobs[slug] = {"word": pipeline.display_word(word),
                               "status": "queued", "error": None}
            _job_queue.put((slug, word, mood))
            queued += 1
        return self._send_json({"queued": queued})


def main():
    for i in range(PIPELINE_WORKERS):
        threading.Thread(target=_worker, daemon=True,
                         name=f"pipeline-worker-{i + 1}").start()
    server = ThreadingHTTPServer(("", PORT), Handler)
    server.daemon_threads = True
    print(f"Ordvärlden-server på http://localhost:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("avslutar")


if __name__ == "__main__":
    main()
