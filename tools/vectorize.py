#!/usr/bin/env python3
"""Vectorize a word-monument PNG into a scene JSON for the WebGPU renderer.

Pipeline: PNG -> posterize to flat greys -> vtracer (polygon mode) -> parse SVG
-> normalized scene JSON with stacked polygon rings, flat colors, paint order.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image

VTRACER = os.path.expanduser("~/.cargo/bin/vtracer")

# Posterize to this many grey levels before tracing; keeps shapes flat and clean.
GREY_LEVELS = 5


def posterize(src: Path, dst: Path) -> tuple[int, int]:
    img = Image.open(src).convert("L")
    w, h = img.size
    step = 255 // (GREY_LEVELS - 1)
    img = img.point(lambda p: min(255, round(p / step) * step))
    img.convert("RGB").save(dst)
    return w, h


PATH_RE = re.compile(r'<path[^>]*?d="([^"]+)"[^>]*?fill="([^"]+)"[^>]*?/?>', re.S)
TRANSFORM_RE = re.compile(r'transform="translate\(([-\d.]+),([-\d.]+)\)"')


def parse_svg(svg_text: str):
    """Parse vtracer polygon-mode SVG into a list of shapes.

    vtracer emits <path d="M x,y L x,y ... Z M ..." fill="#rrggbb" transform="translate(tx,ty)"/>.
    Each subpath after the first is a hole (stacked hierarchical mode).
    Paint order in the file = stacking order (later paths on top).
    """
    shapes = []
    for m in re.finditer(r"<path[^>]+/?>", svg_text):
        tag = m.group(0)
        d_m = re.search(r'd="([^"]+)"', tag)
        fill_m = re.search(r'fill="([^"]+)"', tag)
        if not d_m or not fill_m:
            continue
        tx, ty = 0.0, 0.0
        t_m = TRANSFORM_RE.search(tag)
        if t_m:
            tx, ty = float(t_m.group(1)), float(t_m.group(2))
        rings = []
        for sub in re.split(r"(?=M)", d_m.group(1)):
            sub = sub.strip()
            if not sub:
                continue
            pts = re.findall(r"([-\d.]+)[ ,]+([-\d.]+)", sub)
            ring = [[round(float(x) + tx, 2), round(float(y) + ty, 2)] for x, y in pts]
            if len(ring) >= 3:
                rings.append(ring)
        if not rings:
            continue
        fill = fill_m.group(1)
        if fill.startswith("#"):
            grey = int(fill[1:3], 16)
        else:
            grey = 128
        shapes.append({"rings": rings, "grey": grey})
    return shapes


def ring_area_centroid(ring):
    a = 0.0
    cx = cy = 0.0
    n = len(ring)
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    a *= 0.5
    if abs(a) < 1e-9:
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return 0.0, sum(xs) / n, sum(ys) / n
    return abs(a), cx / (6 * a), cy / (6 * a)


HORIZON_FRAC = 0.48  # image y below this fraction counts as sky/backdrop


def assign_band(index: int, bbox, height: int) -> int:
    """Depth band 0..4 per CONTRACT.md: 0 = nearest, 4 = sky/backdrop."""
    if index == 0:
        return 4
    y_bottom = bbox[3]
    horizon = HORIZON_FRAC * height
    if y_bottom < horizon:
        return 4
    # linear map: horizon..bottom -> band 3..0 (lower in image = nearer)
    f = (y_bottom - horizon) / (height - horizon)
    return max(0, min(3, int((1.0 - f) * 4)))


def build_scene(word: str, shapes, width: int, height: int, min_area_frac: float):
    """Annotate shapes with area/centroid/bbox/band, drop specks, keep paint order."""
    out = []
    min_area = min_area_frac * width * height
    for i, s in enumerate(shapes):
        outer = s["rings"][0]
        area, cx, cy = ring_area_centroid(outer)
        if area < min_area and i > 0:  # always keep the background shape
            continue
        xs = [p[0] for r in s["rings"] for p in r]
        ys = [p[1] for r in s["rings"] for p in r]
        bbox = [round(min(xs), 1), round(min(ys), 1), round(max(xs), 1), round(max(ys), 1)]
        out.append({
            "rings": s["rings"],
            "grey": s["grey"],
            "area": round(area, 1),
            "centroid": [round(cx, 1), round(cy, 1)],
            "bbox": bbox,
            "band": assign_band(i, bbox, height),
        })
    return {"word": word, "width": width, "height": height, "shapes": out}


def vectorize(src: Path, out_json: Path, word: str, min_area_frac: float = 0.00002):
    work = out_json.parent
    work.mkdir(parents=True, exist_ok=True)
    flat_png = work / "flat.png"
    w, h = posterize(src, flat_png)

    svg_path = work / "traced.svg"
    subprocess.run([
        VTRACER, "--input", str(flat_png), "--output", str(svg_path),
        "--colormode", "color",
        "--hierarchical", "stacked",
        "--mode", "polygon",
        "--filter_speckle", "8",
        "--color_precision", "8",
        "--gradient_step", "24",
        "--corner_threshold", "60",
        "--segment_length", "4",
        "--splice_threshold", "45",
        "--path_precision", "2",
    ], check=True, capture_output=True)

    svg_text = svg_path.read_text()
    shapes = parse_svg(svg_text)
    scene = build_scene(word, shapes, w, h, min_area_frac)
    out_json.write_text(json.dumps(scene))

    n_pts = sum(len(r) for s in scene["shapes"] for r in s["rings"])
    print(f"{word}: {len(shapes)} raw shapes -> {len(scene['shapes'])} kept, "
          f"{n_pts} points, JSON {out_json.stat().st_size // 1024} KB")
    return scene


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--word", required=True)
    ap.add_argument("--min-area-frac", type=float, default=0.00002)
    a = ap.parse_args()
    vectorize(Path(a.input), Path(a.output), a.word, a.min_area_frac)
