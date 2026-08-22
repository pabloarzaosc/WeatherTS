"""The panel's plot options, as the renderer wants them.

One place rather than four: every sounding endpoint (model, RAOB, area, ACARS)
takes the same parcel and storm-motion choices and hands them to the same
SHARPpy renderer, so parsing them per endpoint would be four chances to drift.

Validated here, not in the renderer, so a bad value is a 400 on the request
that made it rather than a plot that silently ignored what was asked for.
"""
from __future__ import annotations

from typing import Any, Optional

from sharppy_renderer import PARCELS, STORM_MOTIONS


def parse_view(
    parcel: str = "",
    parcel_pressure: Optional[float] = None,
    storm_motion: str = "",
    storm_motion_dir: Optional[float] = None,
    storm_motion_spd: Optional[float] = None,
) -> dict[str, Any]:
    view: dict[str, Any] = {}

    if parcel:
        p = parcel.strip().upper()
        if p not in PARCELS:
            raise ValueError(f"unknown parcel {parcel!r}; expected one of {sorted(PARCELS)}")
        view["parcel"] = p
        if p == "USER":
            if parcel_pressure is None:
                raise ValueError("parcel=USER needs parcelPressure (mb)")
            if not 100 <= parcel_pressure <= 1100:
                raise ValueError("parcelPressure must be between 100 and 1100 mb")
            view["parcelPressure"] = float(parcel_pressure)

    if storm_motion:
        m = storm_motion.strip().lower()
        if m not in STORM_MOTIONS:
            raise ValueError(
                f"unknown stormMotion {storm_motion!r}; expected one of {sorted(STORM_MOTIONS)}"
            )
        view["stormMotion"] = m
        if m == "custom":
            if storm_motion_dir is None or storm_motion_spd is None:
                raise ValueError("stormMotion=custom needs stormMotionDir and stormMotionSpd")
            view["stormMotionDir"] = float(storm_motion_dir) % 360.0
            view["stormMotionSpd"] = float(storm_motion_spd)

    return view


def cache_suffix(view: dict[str, Any]) -> str:
    """A stable key fragment, so two plot settings never share a cached image."""
    if not view:
        return ""
    return "|" + ",".join(f"{k}={view[k]}" for k in sorted(view))
