"""A VAD wind profile, rendered as a SHARPpy sounding.

A VWP is winds against height and nothing else -- no temperature, no moisture.
SHARPpy needs a thermodynamic profile to draw a skew-T or compute a parcel, so
a VAD on its own cannot produce one.

What it CAN produce is the standard operational hybrid: take the model sounding
at the radar's own location, and replace its winds with the ones the radar
actually measured. The thermodynamics stay modelled and the kinematics become
observed, which is exactly the half a VAD is trusted for. Everything derived
from the hodograph -- shear, helicity, storm motion -- is then measurement
rather than forecast, while CAPE and the parcel remain the model's opinion.

The result is labelled as such. It is not a radiosonde and must never read as
one.
"""
from __future__ import annotations

import base64
import math
from typing import Any, Optional

from nexrad_core import icao_for
import nexrad_vwp
import sounding_core


class NoProfileError(RuntimeError):
    """No VAD, or no model profile to hang it on."""


def _vad_points(levels: list[dict]) -> list[tuple[float, float, float]]:
    """(height MSL in m, u, v) in knots, ascending, usable levels only."""
    out: list[tuple[float, float, float]] = []
    for lv in levels:
        alt = lv.get("altM")
        u, v = lv.get("u"), lv.get("v")
        if alt is None or u is None or v is None:
            continue
        out.append((float(alt), float(u), float(v)))
    out.sort(key=lambda x: x[0])
    return out


def _interp_uv(points: list[tuple[float, float, float]], h: float):
    """Wind at a height, or None outside the VAD's own depth.

    Not extrapolated at either end: above the top the radar lost returns, and
    below the bottom its beam was never that low. Those model levels keep the
    model's wind, which is the honest fallback -- the alternative is stretching
    one measured level across kilometres it never described.
    """
    if len(points) < 2 or h < points[0][0] or h > points[-1][0]:
        return None
    for i in range(1, len(points)):
        if h <= points[i][0]:
            z0, u0, v0 = points[i - 1]
            z1, u1, v1 = points[i]
            span = z1 - z0
            t = 0.0 if span == 0 else (h - z0) / span
            return (u0 + (u1 - u0) * t, v0 + (v1 - v0) * t)
    return None


def _dir_spd(u: float, v: float) -> tuple[float, float]:
    spd = math.hypot(u, v)
    d = math.degrees(math.atan2(-u, -v))
    return (d + 360.0) % 360.0, spd


def build_vwp_sounding(
    site: str,
    model: str = sounding_core.DEFAULT_MODEL,
    view: Optional[dict] = None,
    render: bool = True,
) -> dict[str, Any]:
    vwp = nexrad_vwp.build_vwp(site, columns=1)
    cols = vwp.get("columns") or []
    if not cols:
        raise NoProfileError(f"No VAD wind profile available for {icao_for(site)}.")
    latest = cols[-1]
    points = _vad_points(latest.get("levels") or [])
    if len(points) < 3:
        raise NoProfileError(
            f"{icao_for(site)} published a VAD but it carried fewer than three usable "
            "wind levels, which is not enough to build a profile."
        )

    lat = vwp["meta"]["siteLat"]
    lon = vwp["meta"]["siteLon"]
    base = sounding_core.build_sounding(lat, lon, model, 0, None, False)
    levels = [dict(lv) for lv in (base.get("levels") or [])]
    if len(levels) < 4:
        raise NoProfileError("No model profile available at the radar to carry the VAD winds.")

    replaced = 0
    for lv in levels:
        uv = _interp_uv(points, float(lv.get("h", 0.0)))
        if uv is None:
            continue
        d, s = _dir_spd(*uv)
        lv["wd"] = d
        lv["ws"] = s
        replaced += 1
    if replaced == 0:
        raise NoProfileError(
            "The VAD and the model profile do not overlap in height, so none of the "
            "measured winds could be placed."
        )

    result = sounding_core.compute(levels, lat=lat)
    label = f"{vwp['meta']['site']} VAD + {model.upper()} thermo"
    meta: dict[str, Any] = {
        "lat": lat,
        "lon": lon,
        # The model's surface height at the radar. The VAD reports heights MSL,
        # so this is what the viewer needs to talk about the profile in AGL.
        "elevation": float((base.get("meta") or {}).get("elevation") or 0.0),
        "model": f"vwp:{site.upper()}",
        "requestedModel": f"vwp:{site.upper()}",
        "modelLabel": label,
        "requestedModelLabel": label,
        "modelGroup": "Radar",
        # Which model supplied the temperature, moisture and the winds above
        # the VAD's top -- the panel prints this, so it cannot be inferred from
        # "model", which names the radar.
        "thermoModel": model,
        "observed": False,
        "hour": 0,
        "requestedHour": 0,
        "forecastMaxHour": 0,
        "validHours": [0],
        "times": [vwp["meta"]["validUnix"]],
        "nTimes": 1,
        "validUnix": vwp["meta"]["validUnix"],
        "station": vwp["meta"]["site"],
        "stationName": label,
        "source": f"NEXRAD VAD winds over {model.upper()} temperature and moisture",
        "vadLevelsUsed": replaced,
        "vadTopM": points[-1][0],
        "vadBottomM": points[0][0],
        # Said plainly, because the skew-T will look like any other and the
        # thermodynamics on it were never measured.
        "fallbackReason": (
            f"Winds are the radar's own VAD ({replaced} model levels replaced between "
            f"{points[0][0]:.0f} and {points[-1][0]:.0f} m). Temperature and moisture "
            f"are {model.upper()} — this is not a radiosonde."
        ),
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

    return {
        "meta": meta,
        "levels": levels,
        "params": result.get("params", {}),
        "parcelTrace": result.get("parcelTrace"),
        "effBotP": result.get("effBotP"),
        "effTopP": result.get("effTopP"),
        "image": image,
        "imageError": image_error,
    }
