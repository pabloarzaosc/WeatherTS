"""Tropical cyclone guidance from the NHC's ATCF decks: every model's track for
the active Atlantic, East and Central Pacific storms.

The a-deck (aid_public/a{basin}{nn}{yyyy}.dat.gz) holds each model's forecast
positions and intensity for every cycle; the b-deck (btk/b...dat) the storm's
own history, name included. A "run" here is 'CYCLE~STORM' ('2026092218~ep172026'),
the same shape the storm models use, so the Models panel's run picker lists
storm and cycle together; its frames are the forecast hours.

Guidance comes in two cycles at once: the early models (AVNI, HWFI ...) are the
previous cycle's runs shifted to start at this one, which is what a forecaster
has in hand at the cycle; the late ones (AVNO, HWRF ...) arrive six hours on.
"""

from __future__ import annotations

import gzip
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import model_sources as ms

AID = "https://ftp.nhc.noaa.gov/atcf/aid_public/"
BTK = "https://ftp.nhc.noaa.gov/atcf/btk/"

_LOCK = threading.Lock()
_DECKS: dict[str, tuple[float, list[list[str]]]] = {}
_ACTIVE: list[Any] = [0.0, []]
_TTL = 600.0

# The guidance a forecaster reads first, in the order it is drawn: NHC's own
# forecast, the consensus, then the dynamical models.
SELECTED = ("OFCL", "TVCN", "AVNI", "EMXI", "EGRI", "CMCI", "NVGI", "HWFI", "HMNI", "HFAI", "HFBI", "CTCI", "AEMI")
COLOURS = {
    "OFCL": "#ffffff", "TVCN": "#f2d23c", "AVNI": "#3d6fcf", "EMXI": "#e4552e", "EGRI": "#5cbf5c",
    "CMCI": "#c02a5a", "NVGI": "#8e2a9e", "HWFI": "#f0a83c", "HMNI": "#9ed1f0", "HFAI": "#2fb8b0",
    "HFBI": "#7fbf6a", "CTCI": "#d060c0", "AEMI": "#6c9dff",
}
# The letter a storm number is written with: 06L, 17E, 02C.
_BASIN = {"al": "L", "ep": "E", "cp": "C"}
# Saffir-Simpson by the maximum wind, kt.
CATEGORIES = ((137, "C5"), (113, "C4"), (96, "C3"), (83, "C2"), (64, "C1"), (34, "TS"), (0, "TD"))


def _colour(tech: str) -> str:
    if tech in COLOURS:
        return COLOURS[tech]
    h = sum(ord(c) * (i + 7) for i, c in enumerate(tech)) % 360
    return f"hsl({h}, 55%, 62%)"


def _category(vmax: float) -> str:
    return next(name for floor, name in CATEGORIES if vmax >= floor)


def active() -> list[str]:
    """The storms whose a-deck changed in the last two days: 'ep172026' ..."""
    if time.time() - _ACTIVE[0] < _TTL:
        return _ACTIVE[1]
    r = ms._get(AID)
    out: list[str] = []
    if r is not None:
        now = datetime.now(timezone.utc)
        for sid, stamp in re.findall(r'href="a([a-z]{2}\d{6})\.dat\.gz">[^<]*</a>\s+(\d{4}-\d\d-\d\d \d\d:\d\d)', r.text):
            when = datetime.strptime(stamp, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
            # Invests (90-99) come and go: only named or numbered storms.
            if now - when < timedelta(hours=48) and int(sid[2:4]) < 90:
                out.append(sid)
    _ACTIVE[0], _ACTIVE[1] = time.time(), out
    return out


def _deck(url: str, compressed: bool) -> list[list[str]]:
    with _LOCK:
        hit = _DECKS.get(url)
    if hit and time.time() - hit[0] < _TTL:
        return hit[1]
    r = ms._get(url)
    rows: list[list[str]] = []
    if r is not None:
        text = gzip.decompress(r.content).decode("latin-1") if compressed else r.text
        rows = [[f.strip() for f in line.split(",")] for line in text.splitlines() if line.count(",") > 8]
    with _LOCK:
        _DECKS[url] = (time.time(), rows)
    return rows


def _latlon(lat: str, lon: str) -> Optional[tuple[float, float]]:
    try:
        y = int(lat[:-1]) / 10.0 * (1 if lat[-1] == "N" else -1)
        x = int(lon[:-1]) / 10.0 * (1 if lon[-1] == "E" else -1)
    except (ValueError, IndexError):
        return None
    return y, x


def _name(sid: str) -> str:
    rows = _deck(f"{BTK}b{sid}.dat", False)
    for row in reversed(rows):
        if len(row) > 27 and row[27]:
            return row[27].upper()
    return ""


def storm_runs() -> list[dict]:
    """Storm and cycle, newest cycle first: the last four cycles of each storm."""
    out: list[dict] = []
    for sid in active():
        rows = _deck(f"{AID}a{sid}.dat.gz", True)
        cycles = sorted({row[2] for row in rows if len(row) > 5}, reverse=True)[:4]
        name = _name(sid)
        label = f"{sid[2:4]}{_BASIN.get(sid[:2], sid[0].upper())} {name}".strip()
        for cycle in cycles:
            run = datetime.strptime(cycle, "%Y%m%d%H").replace(tzinfo=timezone.utc)
            out.append({"run": f"{cycle}~{sid}", "unix": int(run.timestamp()),
                        "label": f"{label} · {run:%a %d %b %HZ}"})
    out.sort(key=lambda r: -r["unix"])
    return out


def _rows(rid: str) -> list[list[str]]:
    cycle, sid = rid.split("~", 1)
    return [row for row in _deck(f"{AID}a{sid}.dat.gz", True) if len(row) > 8 and row[2] == cycle]


def frames(rid: str) -> list[dict]:
    """The forecast hours the cycle's guidance reaches, six-hourly."""
    taus = [int(row[5]) for row in _rows(rid) if row[5].lstrip("-").isdigit()]
    if not taus:
        return []
    cycle = datetime.strptime(rid[:10], "%Y%m%d%H").replace(tzinfo=timezone.utc)
    last = min(max(taus), 240)
    return [{"key": f"{rid}_f{fh:03d}", "unix": int((cycle + timedelta(hours=fh)).timestamp()),
             "label": f"F{fh:03d} {cycle + timedelta(hours=fh):%a %HZ}", "fh": fh, "run": rid}
            for fh in range(0, last + 1, 6)]


def _wanted(tech: str, which: str) -> bool:
    if which == "all":
        return True
    if which == "gefs":
        # The GEFS control, its 30 members and their mean.
        return tech in ("AC00", "AEMN") or bool(re.fullmatch(r"AP\d\d", tech))
    return tech in SELECTED


def tracks(rid: str, which: str = "selected") -> dict[str, Any]:
    """The cycle's tracks as GeoJSON: a line per model (split into pieces by
    intensity category, for the intensity view to colour), a point per
    position, and the storm's own path so far. `which`: "selected" guidance,
    "all" of it, or the "gefs" members."""
    cycle, sid = rid.split("~", 1)
    by_tech: dict[str, dict[int, tuple[float, float, float]]] = {}
    for row in _rows(rid):
        tech, tau = row[4], row[5]
        if not tau.lstrip("-").isdigit() or int(tau) < 0:
            continue
        if not _wanted(tech, which):
            continue
        pos = _latlon(row[6], row[7])
        if pos is None:
            continue
        vmax = float(row[8]) if row[8].isdigit() else 0.0
        by_tech.setdefault(tech, {})[int(tau)] = (pos[0], pos[1], vmax)

    lines, points, legend = [], [], []
    order = [t for t in SELECTED if t in by_tech] + sorted(t for t in by_tech if t not in SELECTED)
    for tech in order:
        track = [by_tech[tech][t] + (t,) for t in sorted(by_tech[tech])]
        if len(track) < 2:
            continue
        colour = "#8fb4ff" if re.fullmatch(r"AP\d\d|AC00", tech) else _colour(tech)
        legend.append({"tech": tech, "colour": colour})
        for (y0, x0, v0, t0), (y1, x1, v1, _t1) in zip(track, track[1:]):
            lines.append({"type": "Feature",
                          "geometry": {"type": "LineString", "coordinates": [[x0, y0], [x1, y1]]},
                          "properties": {"tech": tech, "colour": colour, "vmax": v0, "cat": _category(v0),
                                         "official": tech in ("OFCL", "AEMN")}})
        for y, x, v, t in track:
            points.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [x, y]},
                           "properties": {"tech": tech, "colour": colour, "tau": t, "vmax": v,
                                          "cat": _category(v), "label": f"{tech} {int(v)} kt" if v else tech}})

    # The storm's own path up to this cycle.
    best = []
    seen: dict[str, tuple[float, float, float]] = {}
    for row in _deck(f"{BTK}b{sid}.dat", False):
        if len(row) > 8 and row[2] <= cycle:
            pos = _latlon(row[6], row[7])
            if pos is not None:
                seen[row[2]] = (pos[0], pos[1], float(row[8]) if row[8].isdigit() else 0.0)
    path = [seen[k] for k in sorted(seen)]
    if len(path) >= 2:
        best.append({"type": "Feature",
                     "geometry": {"type": "LineString", "coordinates": [[x, y] for y, x, _v in path]},
                     "properties": {"kind": "best"}})
    name = _name(sid)
    return {
        "run": rid, "storm": f"{sid[2:4]}{_BASIN.get(sid[:2], sid[0].upper())} {name}".strip(), "cycle": cycle,
        "lines": {"type": "FeatureCollection", "features": lines},
        "points": {"type": "FeatureCollection", "features": points},
        "best": {"type": "FeatureCollection", "features": best},
        "legend": legend,
    }
