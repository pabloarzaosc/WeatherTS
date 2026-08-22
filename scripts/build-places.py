"""Rebuild public/data/us-places.json from GeoNames.

The impacts list needs somewhere to look up "what town is the storm about to
hit". Bundling it rather than geocoding on demand keeps it working on a rural
data connection, which is exactly where it gets used.

    python scripts/build-places.py

Rerun when the towns look stale; GeoNames publishes daily, but this data
barely moves and the file is checked in.
"""
from __future__ import annotations

import io
import json
import pathlib
import zipfile

import requests

SOURCE = "https://download.geonames.org/export/dump/US.zip"
OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "data" / "us-places.json"

# Population floor. Chase targets are small towns, so this sits low on purpose;
# below ~100 the file fills with unincorporated crossroads that no one would
# recognise as a place a storm is "hitting".
MIN_POPULATION = 100

# Populated-place feature codes worth listing. PPLX (a *section* of a place)
# and PPLL (a locality) are left out: they duplicate the parent city's name and
# would show the same town twice in one impacts list.
KEEP_CODES = {"PPL", "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPLA5", "PPLC", "PPLG"}

# GeoNames column positions, per its readme.
COL_NAME, COL_ASCII, COL_LAT, COL_LON = 1, 2, 4, 5
COL_CLASS, COL_CODE, COL_STATE, COL_POP = 6, 7, 10, 14


def main() -> None:
    print(f"downloading {SOURCE} ...")
    r = requests.get(SOURCE, timeout=300, headers={"User-Agent": "WeatherTS build-places"})
    r.raise_for_status()
    text = zipfile.ZipFile(io.BytesIO(r.content)).read("US.txt").decode("utf-8")

    # (name, state) -> row. GeoNames lists the same town under several feature
    # codes; the most populous entry is the real one.
    best: dict[tuple[str, str], tuple[str, str, float, float, int]] = {}
    for line in text.split("\n"):
        parts = line.split("\t")
        if len(parts) < 15 or parts[COL_CLASS] != "P" or parts[COL_CODE] not in KEEP_CODES:
            continue
        try:
            pop = int(parts[COL_POP] or 0)
            lat, lon = float(parts[COL_LAT]), float(parts[COL_LON])
        except ValueError:
            continue
        if pop < MIN_POPULATION:
            continue
        name = parts[COL_NAME] or parts[COL_ASCII]
        state = parts[COL_STATE]
        if not name or len(state) != 2:
            continue
        key = (name, state)
        prev = best.get(key)
        if prev is None or pop > prev[4]:
            best[key] = (name, state, round(lat, 4), round(lon, 4), pop)

    # Biggest first: ties along a storm path should resolve to the town people
    # have actually heard of.
    rows = sorted(best.values(), key=lambda p: -p[4])
    payload = {
        "source": "GeoNames (CC BY 4.0)",
        "minPopulation": MIN_POPULATION,
        "fields": ["name", "state", "lat", "lon", "population"],
        "places": [list(p) for p in rows],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} — {len(rows)} places, {OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
