# CONTRACT.md — 3dworldtext ("Ordvärlden")

**Detta dokument är bibeln.** Alla moduler byggs mot dessa gränssnitt. Ändra aldrig
ett fruset gränssnitt utan att uppdatera detta dokument först.

## Koncept

AI-genererade skissbilder (Gemini via OpenRouter) av monumentala 3D-ord på en liten
planet → vektoriseras (vtracer) → renderas som djupbands-diorama i WebGPU.
Användaren färdas längs planetens omkrets; resan mellan två ord driver en
GPU-vertexmorph mellan scenernas vektorformer. Nya ord kan genereras i realtid
från ett textfält.

## Portar & processer

- HTTP-server: **port 8144** (statiska filer + API). `python3 server.py` (körs med `venv/bin/python`).
- Ingen byggkedja för webben: vanilla ES-moduler, vendorerad earcut. Cache-bump med `?v=N` vid JS-ändringar.

## Katalogstruktur

```
tools/generate.py     ord (+stämning) -> original.png (OpenRouter gemini-3-pro-image-preview)
tools/mood.py         sångtext -> stämning (LLM-klassning via OpenRouter, fallback "neutral")
tools/vectorize.py    original.png -> scene.json (vtracer CLI + parsning + band)
tools/pipeline.py     ord (+stämning) -> assets/words/<asset-slug>/{original.png,flat.png,traced.svg,scene.json}
server.py             statiskt + API, port 8144, jobbkö för generering
web/index.html        UI-skal
web/css/style.css
web/js/main.js        boot, tillstånd, integration (skrivs av integratören — rör ej)
web/js/renderer.js    WebGPU: device, pipeline, WGSL, draw
web/js/planet.js      kamera-/världsmatematik (ren matematik, inga GPU-anrop)
web/js/tess.js        earcut (vendorerad) + ringomsampling + triangulering
web/js/morph.js       formmatchning A<->B + byggande av morph-vertexdata
web/js/api.js         fetch mot servern
web/js/ui.js          textfält, statusnotiser, hjälpoverlay
assets/words/<slug>/  per ord: original.png, flat.png, traced.svg, scene.json
```

## Scene JSON (FRUSET format)

```json
{
  "word": "WOW",
  "width": 1408,
  "height": 768,
  "shapes": [
    {
      "rings": [[[x,y], ...], ...],
      "grey": 179,
      "rgb": [90, 110, 160],
      "area": 12345.6,
      "centroid": [x, y],
      "bbox": [x0, y0, x1, y1],
      "band": 3
    }
  ]
}
```

- Koordinater i bildpixelrymd, y nedåt. `rings[0]` = ytterkontur; extra ringar = hål.
  (vtracer stacked-läge ger oftast en ring per form; hål blir egna staplade former.)
- `shapes` i målarordning: index 0 = bakerst (bakgrunden), sista = överst.
- `grey` 0–255 = formens LUMINANS (Rec. 709) — används av matchning/heuristik.
- `rgb` (VALFRITT fält, nya scener): formens flata färg 0–255 per kanal.
  Saknas `rgb` (äldre gråskale-scener) mappar JS grey → duotone (tusch/papper),
  vilket återger det gamla utseendet exakt.
- `band` 0–4: **0 = närmast kameran, 4 = bakgrund/himmel**. Sätts i Python:
  - form 0 → band 4. Former vars bbox-botten ligger ovanför horisonten
    (`y1 < 0.48*height`) → band 4.
  - Övriga: bbox-botten mappas linjärt `0.48H..1.0H` → band 3..0 (närmare botten = lägre band = närmare).

## Normaliserad geometrirymd (FRUSET)

JS konverterar pixelkoordinater till:
- `xn = (x/width - 0.5) * 2 * (width/height)`  (x i ±aspekt)
- `yn = (0.5 - y/height) * 2`                   (y i ±1, uppåt positiv)

## Resemodell (renderer + planet.js + morph.js) — UPPDATERAD efter fältfynd

**Djup = målarordning, INTE bbox-band.** vtracer stacked är back-to-front-
kompositering; varje djupordning som inverterar målarordningen förstör
kompositionen i vila (himlen i COOL har bbox-botten y=470 → bbox-heuristiken
satte den i band 1 och den ockluderade allt). Pythons `band`-fält i scene JSON
finns kvar men används INTE av JS.

morph.js `classify(scene)` beräknar per form:
- `isFar`: `i === 0` ELLER `area > 8 % av bildytan` (massiv scenstruktur:
  himmel, golv, kanjonväggar — bokstavskroppar ligger på ~5 %) ELLER
  `bbox-botten < 0.48*H` (galaxer/stjärnor helt ovan horisonten).
- `p = 1 - i/(n-1)` (1 = först målad = bakerst).
- `bandF = isFar ? 3.5 + 0.5*p : 2.8*p`  (fjärrfält d ≈ 56..78, värld d ≈ 6..36
  via `d = 6.0 * 1.9^bandF`).

**Rendering: ETT draw-call, 2 instanser** (`drawIndexed(n, 2)`):
- **Fjärrfält** (`max(bandA,bandB) ≥ 3.5`, endast instans 0; instans 1 kastas
  utanför clip): kameraförankrat (`world = camPos + lokal`), morphar
  `mix(posA,posB,t)` + `mix(bandA,bandB,t)`; skala ×1.12 döljer scenkanter.
- **Värld, instans 0** = scen A förankrad vid station z=0: `(posA*s, posA.y*s - duck, -d)`
  där `duck = 1.35 * s * clamp(60t/d, 0, 2)^0.7` — varje plan dyker under
  kameran lagom när dollyn når det (vi rusar ÖVER världen, aldrig igenom).
- **Värld, instans 1** = scen B förankrad vid z=-STATION_L:
  `(posB*s, posB.y*s - 0.9*s*(1-t), -(60+d))` — B stiger upp över horisonten.
- Kameran dollyar `posZ = -t * STATION_L` (**STATION_L = 60**, export i planet.js).
- Skalning per plan: `s = d * tan(fovY/2)`; **fovY = 55°**; xn bär aspekten.
  Vid t=0 återges bild A exakt, vid t=1 bild B exakt.
- Depth: strikt `less`, kontinuerliga bandF-värden ger deterministisk ordning.
- Omatchade former: A-form utan partner krymper till sin centroid (försvinner
  under resan); B-form växer fram ur sin centroid. Matchning förbjuden mellan
  isFar/värld och vid |ΔbandF| > 1.2.
- Världens "framåt" = −Z (kameran tittar mot −Z). Right-handed, Y upp.

## Morph-vertexformat (FRUSET — 32 byte/vertex)

```
posA   : float32x2   (xn, yn i normaliserad rymd, scen A)   offset 0
posB   : float32x2   (scen B)                               offset 8
colorA : unorm8x4    (RGBA-packad flat färg, scen A)        offset 16
colorB : unorm8x4    (scen B)                               offset 20
bandA  : float32     (0..4, flyttal — interpoleras)         offset 24
bandB  : float32                                            offset 28
```

Färgen sätts vid mesh-bygget: `rgb` ur scene JSON, eller — om `rgb` saknas —
duotone-mappning `mix(ink, paper, grey/255)` med ink #0d0e14 / paper #fbf9f1
(samma konstanter som förut låg i fragmentshadern). Fragmentshadern ritar
färgen rakt av (`mix(colorA, colorB, t)` i fjärrfältet).

Indexbuffert: uint32. Trianguleringen görs på A-formens ring (eller mittform);
samma indexbuffert används under hela morphen.

## Uniforms (FRUSET layout, en enda uniform-buffer, std140-kompatibel)

```wgsl
struct Uniforms {
  proj      : mat4x4f,   // perspektiv
  view      : mat4x4f,   // kamera (yaw/pitch/sway/bob + dolly posZ)
  t         : f32,       // rese-/morph-t 0..1 mellan station A och B (LINJÄR)
  time      : f32,       // sekunder sedan start
  speed     : f32,       // aktuell fart 0..1 (för effekter)
  aspectRef : f32,       // bildernas aspekt (interpolerad)
  camPos    : vec3f,     // kamerans världsposition (för kameraförankrat fjärrfält)
}
```
Buffert 160 byte; camPos på float-offset 36..38. `t` är LINJÄR (ingen smoothstep) —
kameradollyn och morphen måste följas åt.

## Modul-API:er (FRUSNA signaturer)

### tess.js
```js
export function earcut(vertices, holeIndices, dim)          // vendorerad, oförändrad
export function resampleRing(ring, n)                        // ring: [[x,y],..] -> Float64Array längd 2n, jämn båglängd, startpunkt normaliserad till minsta-vinkel-punkt relativt centroid
export function triangulateRing(flatRing)                    // Float64Array 2n -> Uint32Array index (earcut på enkel ring utan hål)
```

### morph.js
```js
// sceneA/sceneB: scene JSON. Returnerar GPU-färdig data:
// { vertexData: Float32Array (N*8), indexData: Uint32Array, drawOrder: beskrivet nedan }
export function buildMorphMesh(sceneA, sceneB)
```
- Matchning: greedy över kostnad `w1*|Δcentroid|/diag + w2*|log(areaA/areaB)| + w3*|Δgrey|/255 + w4*|Δband|`
  med w = [1.0, 0.7, 0.5, 0.6]. Endast former med kostnad < 2.0 matchas.
- Omatchad A-form: posB = A:s centroid (kollaps). Omatchad B-form: posA = B:s centroid (växer fram).
- Ringar omsamplas till `n = clamp(round(sqrt(area)/3), 24, 160)` punkter (max av A/B).
- Målarordning under morph: sortera trianglar efter `max(bandA,bandB)` fallande (bakerst först),
  därefter ursprunglig målarordning. Ett enda draw-call med förberäknad indexordning.
- Vertexdata i normaliserad rymd (se ovan). grey normaliseras 0..1.

### planet.js
```js
export const BANDS = { D0: 6.0, F: 1.9, COUNT: 5 }
export const FOV_Y = 55 * Math.PI / 180
export function bandDistance(b)                              // D0 * F^b
export function makeProjection(aspectCanvas, near=0.1, far=400) // Float32Array 16, WebGPU depth 0..1
export function makeView(cam)                                // cam: {yaw,pitch,swayX,swayY,bobY} -> Float32Array 16
export class Journey {
  // stations: antal ord; pos: flyttal 0..stations (loopar)
  constructor()
  setStations(n)
  update(dt, throttle)      // throttle -1..1; intern fart med tröghet; returnerar {pos, speed}
  get segment()             // {a: index, b: index, t: 0..1} — vilket ordpar + morph-t
}
```
- `Journey`: fart integreras med tröghet (accel 0.6/s², friktion), maxfart 0.45 stationer/s.
  `pos` loopar modulo stations. `t` = frac(pos). Kamerabob: hanteras i main (via speed).

### renderer.js
```js
export class Renderer {
  static async create(canvas)                 // throw med läsbart fel om WebGPU saknas
  setMesh({vertexData, indexData})            // ladda/ersätt morph-mesh (kan anropas när segment byter)
  setUniforms({proj, view, t, time, speed, aspectRef})
  render()                                    // en frame; MSAA 4x; clear = #0a0a12
  resize(w, h)                                // uppdatera swapchain/depth/MSAA-targets
}
```
- En render-pipeline, opaka fyllda trianglar, depth24plus, MSAA 4x.
- Depth per vertex: `z = d(band)` + epsilon: `eps = -0.002 * paintIndex` inbakat i
  vertexdata? NEJ — paintIndex ryms inte i vertexformatet. I stället: **indexbufferten
  är redan sorterad bakifrån-och-fram; rendera med depthCompare 'less-equal' så att
  senare trianglar vinner inom samma band.** Enkelt och deterministiskt.

### api.js
```js
export async function listWords()            // GET /api/words -> [{word, slug, ready}]
export async function getScene(slug)         // GET /assets/words/<slug>/scene.json
export async function requestWord(text)      // POST /api/word {word} -> {slug, status}
export async function pollWord(slug)         // GET /api/word/<slug>/status -> {status: 'queued'|'generating'|'vectorizing'|'ready'|'error', error?}
```

### ui.js
```js
export function initUI({onSubmitWord})       // textfält + knapp; enter submittar; visar hjälp första gången
export function setStatus(msg, kind)         // kind: 'info'|'busy'|'ok'|'error'; null döljer
export function setWordList(words, currentIndex) // liten HUD-lista över ord på planeten
```

## Server-API (FRUSET)

- `GET /` → web/index.html; statiskt från `web/` och `assets/`.
- `GET /api/words` → `[{ "word": "WOW", "slug": "wow", "ready": true }, ...]`
  (ordning = världsordning; läses från `assets/words/*/scene.json` + kö).
- `POST /api/word` body `{"word": "MAGIC"}` → `{"slug": "magic", "status": "queued"}`.
  Validering: 1–16 tecken, `[A-Za-zÅÄÖåäö0-9 !?\-]`. Slug: lowercase, åäö→aao, mellanslag→`-`.
  Om scene.json redan finns → `{"status": "ready"}` direkt.
- `GET /api/word/<slug>/status` → se pollWord.
- Generering körs i **en** bakgrundstråd (kö, ett jobb åt gången).
  Stilprompten är låst i `tools/generate.py` (STYLE_PROMPT-konstant) och använder
  förra ordets original.png som stilreferens (img2img) om en finns, annars text-only.

## Vektorisering (tools/vectorize.py)

- vtracer **CLI** (`~/.cargo/bin/vtracer`), INTE Python-bindningen (segfaultar på py3.14).
- Postrisera först till max 12 FLATA FÄRGER (PIL-kvantisering, MAXCOVERAGE —
  bevarar små accentfärger som MEDIANCUT slår ihop — INGEN dithering);
  monokroma bilder ger som förut flata gråtoner.
  Trace: colormode color, hierarchical stacked, mode polygon, filter_speckle 8,
  color_precision 8, gradient_step/layer_difference 24, path_precision 2.
- Per form skrivs `rgb` (flata färgen) och `grey` (Rec. 709-luminans av den).
- Släng former med area < 0.002% av bildytan (utom form 0).
- Sikta på 150–500 former, 5k–40k punkter per scen.

## Låt-läge (song mode)

En uppladdad låt transkriberas ord-för-ord med tidsstämplar (whisper-cli);
varje unikt ord genereras/vektoriseras som vanligt (befintlig kö + cache per
slug ⇒ återkommande ord återanvänds gratis); uppspelning driver kameran så att
**ankomsten till ord k sker exakt vid ordets starttid**.

### Kataloger

`assets/songs/<id>/`: `original.<ext>` (uppladdad fil), `audio.wav` (16 kHz mono
för whisper), `words.json`. `<id>` = 8 hex-tecken (slumpat).

### words.json (FRUSET)

```json
{ "id": "a1b2c3d4", "title": "låtnamn.mp3", "duration": 213.4,
  "mood": "A cold indigo night; rain streaks the sky ...",
  "words": [ {"w": "SOLEN", "slug": "solen", "start": 12.34, "end": 12.71}, ... ] }
```
- `words` i tidsordning, inkluderar upprepningar. `slug` per befintliga regler
  (RENA ordslugs — stämningen mappas till asset-slugs först i API-svaret).
- `mood`: låtens stämning (se "Stämning" nedan); sätts av servern efter
  transkriberingen via `tools/mood.py`. Saknat/okänt värde tolkas som "neutral".
- Ord som inte klarar validering (1–16 tecken `[A-Za-zÅÄÖåäö0-9!?-]` efter
  interpunktionstvätt) filtreras bort vid transkribering.

### Stämning (mood) — sångtexten färgar bildprompterna

En textmodell läser HELA låttexten och skriver en FRI stämningsklausul
(engelska, 2–4 meningar) som läggs sist i bildprompten för alla låtens ord.
**Stilskelettet förblir låst** (handtecknad serietusch, flata toner utan
gradienter, planet, huggna bokstäver) — klausulen varierar sceninnehåll (väder,
växtlighet, himmelselement, bokstävernas skick, rekvisita) OCH FÄRGPALETT
(en begränsad flat palett, max ~6 toner). Utan stämning (fritt läge) gäller
den ursprungliga monokroma paletten (NEUTRAL_PALETTE i generate.py).

- `mood` i words.json = klausulens råtext (fri sträng). Tom sträng/saknat
  fält = neutral (ingen klausul, ren `<slug>`).
- **Asset-slug**: icke-tom klausul ger katalog
  `assets/words/<slug>--m<hex8>/` där `hex8` = första 8 tecknen av
  sha1(klausulen, utf-8). Deterministiskt ur words.json; samma klausul ⇒
  samma katalog (upprepade ord inom låten återanvänds gratis). Separatorn
  `--` är kollisionsfri: slugify kollapsar bindestrecksserier, så rena
  ordslugs kan aldrig innehålla `--`. Fritt läge/textfältet är alltid neutralt.
- `pipeline.asset_slug(word_slug, mood) -> str` är den enda källan till
  mappningen. `pipeline.run_pipeline(word, mood=None)` genererar/vektoriserar
  i stämningskatalogen och skickar klausulen till generate (mood-parametern är
  klausultexten, appendas till STYLE_PROMPT).
- Stilreferens: `_latest_style_ref` föredrar senaste original.png med SAMMA
  `--`-suffix (= samma låtstämning). Saknas sådan: vid icke-tom stämning
  används INGEN referens (text-only, så att klausulens palett inte dras mot
  referensens); neutral använder senaste oavsett (oförändrat beteende).
- `tools/mood.py` (FRUSET API):
  ```python
  def write_mood_clause(words: list[str], title: str = "") -> str
  ```
  En textmodell via OpenRouter (env `MOOD_MODEL`, default
  `google/gemini-2.5-flash`) skriver klausulen ur hela texten. Får ALDRIG
  fälla transkriberingen: alla fel (saknad nyckel, API-fel, tomt svar) ⇒ `""`.
  Svaret saneras (radbrytningar → mellanslag, max ~600 tecken).
- Servern anropar write_mood_clause efter transcribe_song och skriver `mood`
  till words.json. I `GET /api/song/<id>` mappas `slug` i `words` och `unique`
  till asset-slugs (`<slug>--m<hex8>`) och svaret får fältet `"mood"` (klausulen)
  — frontenden bygger scene-URL:er av slugarna och behöver inte känna till
  mappningen. Panelen visar klausulen i `#song-mood`.

### tools/transcribe.py (FRUSET API)

```python
def transcribe_song(input_path, song_dir) -> dict   # → words.json-dicten (skriver även filen)
```
- ffmpeg → `audio.wav` (16 kHz mono pcm_s16le). whisper-cli:
  `-m <modell> -f audio.wav -l auto -ojf --dtw large.v3.turbo
  --prompt "Sångtext / lyrics:" -t <cpus>`.
  Binär: `/Users/andersbj/Projekt/whisper.cpp/build/bin/whisper-cli`,
  modell: `/Users/andersbj/Projekt/whisper.cpp/models/ggml-large-v3-turbo.bin`
  (env `WHISPER_CLI`/`WHISPER_MODEL`/`WHISPER_DTW`/`WHISPER_PROMPT`).
- **Lyrics-prompten är obligatorisk**: utan den hallucinerar whisper över musik
  ("We'll be right back", "Textning ...") och hör ingen sång alls.
- **Ordtider ur DTW-tokens** (`t_dtw`, centisekunder = när ordet sjungs), inte
  `-ml 1`-segmentgränser (som smetas ut över tystnad). Token som börjar med
  mellanslag inleder nytt ord; subword-tokens slås ihop. Starttider görs
  strikt stigande efteråt (songPosition kräver monotoni).
- Hallucinationsfilter: segment > 12 s, `*...*`/`[...]`/`(...)`-etiketter,
  kända fraser (KNOWN_HALLUCINATIONS-regexen), tomma efter tvätt.
- `duration` via ffprobe. CLI: `transcribe.py <ljudfil> <song_dir>`.

### Server-API (FRUSET tillägg)

- `POST /api/song?name=<filnamn>` — body = råa filbytes (ingen multipart).
  → `{"id", "status": "transcribing"}` direkt; transkribering i bakgrundstråd.
- `GET /api/song/<id>` → `{"id", "title", "duration", "status":
  "transcribing"|"ready"|"error", "error"?, "mood"?, "words"?: [...],
  "unique"?: [{"slug", "w", "ready": bool}]}` (words/unique när status=ready;
  unique i första-förekomst-ordning, `ready` = scene.json finns).
  `slug` i words/unique är ASSET-slugs (`<slug>--<mood>` vid icke-neutral
  stämning); `mood` = låtens stämning.
- `POST /api/song/<id>/generate` → köar alla saknade unika ord i befintliga
  ordkön (första-förekomst-ordning) → `{"queued": n}`.
- `POST /api/song/<id>/words` — redigera transkriberingen (rätta/ta bort ord).
  Body `{"words": [{"w", "start", "end"?}, ...]}` = HELA nya ordlistan
  (klienten skickar inte slug — servern validerar varje ord per ordreglerna,
  slugifierar om och sorterar på starttid). Ogiltigt ord ⇒ 400 med ordet i
  felmeddelandet; låt som inte är "ready" ⇒ 409. words.json skrivs om
  (title/duration/mood orörda — stämningsklausulen räknas INTE om) och svaret
  är samma format som `GET /api/song/<id>`.
- `GET /assets/songs/<id>/audio` → originalfilen med rätt content-type
  (uppspelning i `<audio>`).
- Genereringskön körs med **3 parallella workers** (API-bunden last).
- Max uppladdning 60 MB; avvisa större med 413.

### Mellanspel (ordlösa scener för instrumentala partier)

- `assets/interludes/inter-<n>/scene.json` (n = 1..3): samma scene JSON-format,
  genererade i samma stil men UTAN text/bokstäver (rena landskap). Skapas en
  gång av integratören och återanvänds för alla låtar. `GET /api/interludes`
  → `[{"slug": "inter-1"}, ...]` (kataloglistning; tom lista om inga finns).
- Stationsnyckel för mellanspel är `~inter-<n>` (tilde är ogiltigt i ordslugs
  ⇒ kollisionsfritt i mesh-cachen); scenen hämtas från
  `/assets/interludes/inter-<n>/scene.json`.

### web/js/song.js (FRUSET API)

```js
export function initSongMode({ onEnterSong, onExitSong })
  // kopplar UI: fil-knapp -> upload -> transkriberingsvy -> "Generera N ord"
  // -> progress -> "Spela". onEnterSong({song, stations, audio}) anropas när
  // användaren trycker Spela (audio = färdigt <audio>-element, spelande).
  // onExitSong() när användaren lämnar låt-läget.
export function buildStations(song, interludes)
  // -> [{key, slug, w, start, sceneUrl}] i tidsordning. Ett inslag per
  // ordförekomst (key = slug, sceneUrl = /assets/words/<slug>/scene.json).
  // Vid lucka > 8 s mellan två stationers start (samt före första ordet)
  // skjuts min(3, floor(lucka/8)) mellanspel in, jämnt fördelade i luckan:
  // {key: "~inter-n", w: "♪", sceneUrl: /assets/interludes/inter-n/scene.json}.
  // Mellanspel roteras (1,2,3,1,...). Tom interludes-lista ⇒ inga insatta.
export function songPosition(stations, currentTime)
  // -> {index, t}: index = stationsindex (0..n-1), t = 0..1 fram till nästa
  // stations start. Binärsökning över stations[].start; nämnaren golvas till
  // 0.15 s. Före stations[0].start: {index: 0, t: 0}. Efter sista: {n-1, 0}.
export function updateKaraoke(stations, index)  // textremsa (föreg/aktuellt/nästa)
```
- Transkriptet i panelen är redigerbart: klick på ett ord öppnar ett
  inline-fält (Enter/blur = spara, Escape = avbryt, tomt fält = ta bort
  ordet) → `POST /api/song/<id>/words` med hela nya listan → panelen
  uppdateras från svaret. Pollningen rör inte panelen medan ett fält är
  öppet. `api.js`: `export async function updateSongWords(id, words)`.
- Videoexport: knappen `#song-export` ("Spela in video", aktiv när Spela är
  det) startar uppspelningen MED inspelning — helt klientside: canvasens
  `captureStream(30)` + låtens ljud via WebAudio (MediaElementSource →
  MediaStreamDestination; källan kopplas även till högtalarna) →
  MediaRecorder (mp4 om webbläsaren stödjer det, annars webm,
  ~10 Mbit/s). Realtid: inspelningen tar låtens längd. När låten tar slut
  eller användaren trycker Stopp laddas filen ner som
  `<låtnamn> — ordvärlden.<ext>`. Pillen visar "●" under inspelning.
  Fel vid inspelningsstart avbryter INTE uppspelningen (visas som fel i
  panelen).
- main.js (integratören) äger uppspelningsloopen: i låt-läge ersätter
  `songPosition(...)` Journey-segmentet; mesh-cache nycklas `keyA|keyB`
  ⇒ upprepade ord och mellanspel återanvänder byggda meshar.
- UI-element (ui-ägaren skapar): `#songbar` (♪-knapp + dold file-input),
  `#songpanel` (transkriberingsresultat, generera-knapp med antal + tids-/
  kostnadshint, progress, Spela/Avbryt), `#karaoke` (textremsa nederst,
  aktuellt ord markerat). Allt på svenska med korrekta å ä ö.

### Mesh-cache

LRU med max 80 par (Map-ordning: delete+set vid träff, äldsta först ut).

## Stil (låst skelett — ändra ej utan användarens OK)

Handtecknad serietusch med FLATA toner (max ~6), inga gradienter;
förstapersonsvy på en liten rund planet med kraftigt krökt horisont;
slingrande stig mot gigantiska huggna 3D-stenbokstäver med ORDET; stjärnhimmel
med spiralgalaxer; stenar och små blommor längs stigen; bred 16:9 som fyller
hela bildytan kant till kant (ingen ram/vinjett — viktigt för text-only-fallet
utan stilreferens).

PALETTEN är INTE låst: stämningsklausulen (se "Stämning") väljer fritt en
begränsad flat färgpalett utifrån låttexten, plus sceninnehåll (väder,
blommornas skick, himmelselement, bokstävernas slitage). Utan stämning gäller
NEUTRAL_PALETTE (generate.py): den ursprungliga monokroma looken — exakt
4 flata gråtoner, ingen färg. Klausuler får aldrig införa gradienter,
fotorealism eller annat linjemanér.
