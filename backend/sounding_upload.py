"""A sounding the user pasted in, rendered like any other.

Accepts the two shapes people actually have on hand: SHARPpy's own .SHARPPY
file, and a bare whitespace/comma table of pressure, height, temperature,
dewpoint, wind direction and speed. Anything else is rejected with a message
that says what was expected, rather than a stack trace about a float.
"""
from __future__ import annotations

import base64
import math
import re
from typing import Any

import sounding_core

# SHARPpy writes its levels between %RAW% markers, comma separated, with -9999
# for missing. The header lines above carry the title and valid time.
_RAW = re.compile(r"%RAW%(.*?)%END%", re.S | re.I)
# SHARPpy's own sentinel. Missing values have to reach the renderer AS this,
# not as NaN: create_profile is told `missing=MISSING` and skips those levels,
# whereas a NaN reaches Qt and dies inside drawLine.
MISSING = -9999.0
# Anything at or below this in the input is a missing marker, whichever
# sentinel the file used (-999, -9999, -9900 all show up in the wild).
MISSING_BELOW = -900.0


class BadSounding(ValueError):
    """The text could not be read as a sounding."""


def _num(tok: str) -> float:
    v = float(tok)
    return MISSING if v <= MISSING_BELOW else v


def parse_levels(text: str) -> list[dict[str, float]]:
    body = text or ""
    m = _RAW.search(body)
    if m:
        body = m.group(1)

    levels: list[dict[str, float]] = []
    for raw in body.splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";", "%")):
            continue
        # A header row of names, not numbers, is common at the top of a paste.
        toks = [t for t in re.split(r"[,\s]+", line) if t]
        if len(toks) < 6:
            continue
        try:
            p, h, t, td, wd, ws = (_num(x) for x in toks[:6])
        except ValueError:
            continue
        if p <= 0 or p == MISSING:
            continue
        levels.append({"p": p, "h": h, "t": t, "td": td, "wd": wd, "ws": ws})

    if len(levels) < 4:
        raise BadSounding(
            "Could not read a sounding from that text. Expected one level per "
            "line as: pressure(mb) height(m) temperature(C) dewpoint(C) "
            "wind-direction(deg) wind-speed(kt) — or a SHARPpy %RAW% block."
        )
    # Pressure descends with height; a table pasted the other way round is
    # still a valid sounding, just written upward.
    levels.sort(key=lambda x: -x["p"])
    return levels


def build_upload(text: str, title: str = "", lat: float = 35.0, lon: float = -97.0,
                 view: dict | None = None, render: bool = True) -> dict[str, Any]:
    levels = parse_levels(text)
    result = sounding_core.compute(levels, lat=lat)

    label = (title or "Uploaded sounding").strip()
    meta: dict[str, Any] = {
        "lat": lat, "lon": lon,
        "model": "upload", "requestedModel": "upload",
        "modelLabel": label, "requestedModelLabel": label,
        "modelGroup": "Uploaded",
        "hour": 0, "requestedHour": 0, "forecastMaxHour": 0,
        "validHours": [0], "nTimes": 1, "times": [],
        "validUnix": None, "observed": True,
        "source": "Pasted by the user",
        "station": label, "stationName": label,
        "elevation": levels[-1]["h"] if levels else 0.0,
    }

    image = None
    image_error = None
    if render:
        try:
            from sharppy_renderer import render_spc_widget_png

            meta.update(view or {})
            image = base64.b64encode(render_spc_widget_png(levels, meta)).decode("ascii")
        except Exception as exc:  # noqa: BLE001 - the numbers still stand
            image_error = str(exc)

    # NaN is not JSON: a missing wind or dewpoint in the paste would otherwise
    # take the whole response down with a 500 from the encoder.
    def _json_safe(o: Any) -> Any:
        if isinstance(o, float):
            return o if math.isfinite(o) else None
        if isinstance(o, dict):
            return {k: _json_safe(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [_json_safe(v) for v in o]
        return o

    return _json_safe({
        "meta": meta,
        "levels": levels,
        "params": result.get("params", {}),
        "parcelTrace": result.get("parcelTrace"),
        "effBotP": result.get("effBotP"),
        "effTopP": result.get("effTopP"),
        "image": image,
        "imageError": image_error,
    })
