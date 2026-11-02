"""Builds backend/data/emma_regions.json.gz: the outline of every MeteoAlarm region.

MeteoAlarm's warnings name regions by EMMA_ID and carry no shapes. The shapes are in
its 33 MB geocodes file (gitlab.com/meteoalarm-pm-group/documents); this thins them
to about a kilometre and keeps code, country and name.

    backend/.venv/Scripts/python.exe scripts/build-emma-regions.py <MeteoAlarm_Geocodes_*.json>
"""
from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
import numpy as np  # noqa: E402

from world_alerts import _thin  # noqa: E402

TOLERANCE = 0.01


def ring(points: list[list[float]]) -> list[list[float]] | None:
    thinned = _thin(np.asarray(points, dtype=float), TOLERANCE)
    if len(thinned) < 4:
        return None
    return [[round(float(x), 3), round(float(y), 3)] for x, y in thinned]


def mended(name: str) -> str:
    """Some of the file's names are UTF-8 read as Latin-1 ("HÃ©rault")."""
    try:
        return name.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name


def main(src: str) -> None:
    data = json.loads(Path(src).read_text(encoding="utf-8"))
    out = []
    for feature in data["features"]:
        props = feature["properties"]
        geometry = feature["geometry"]
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        rings = [r for r in (ring(p[0]) for p in polygons) if r]
        if rings:
            out.append({"code": props["code"], "country": props["country"], "name": mended(props["name"]), "rings": rings})
    target = Path(__file__).resolve().parent.parent / "backend" / "data" / "emma_regions.json.gz"
    target.parent.mkdir(exist_ok=True)
    with gzip.open(target, "wt", encoding="utf-8", compresslevel=9) as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(len(out), "regions,", sum(len(r) for o in out for r in o["rings"]), "points,", target.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main(sys.argv[1])
