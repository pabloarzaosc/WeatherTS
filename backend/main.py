"""
FastAPI server for the SHARPpy sounding viewer.

Run (from backend/):
    .venv/Scripts/python.exe -m uvicorn main:app --port 8787 --reload
"""
from __future__ import annotations

import asyncio
import base64
import json
import math
import os
import struct
import sys
import threading
from typing import Optional
from concurrent.futures import ThreadPoolExecutor

import anyio
from fastapi import Body, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

import fast_tls
import sounding_core
import sounding_upload
import vwp_panel
import vwp_sounding
import sounding_view
import model_fields
import nadocast_core
import cpc_hazards
import raob_core
import stations
import surface_obs
import aviation
import aviation_world
import brazil_radar
import radar_relay_client
import nexrad_core
import tdwr
import radar_status
import observations
import nexrad_level2
import radar_xsect
import radar_volume3d
import radar_detect
import nexrad_availability
import nexrad_storms
import storm_attributes
import nexrad_vwp
import lsr_core
import fronts_core
import fronts_model
import spc_md
import acars_core
import area_sounding
import satellite
import space_sdo
import world_alerts
import opera_radar
import tropical
import sat_net
import glm
import rivers
import brazil_rivers

# Certificates loaded once, and new connections opened a dozen at a time, for
# every module's sessions -- those made above too (see fast_tls).
fast_tls.install()

app = FastAPI(title="WeatherTS Sounding API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    # POST too: the web build (weatherts.tech/app) is a real cross-origin page,
    # where the desktop's Electron skips CORS -- the cancel, prefetch and
    # sounding calls are POSTs.
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    expose_headers=["X-Sat-Detail"],
)
# Polar scans are ~5 MB of float32 that is >80% NaN -> compresses to a fraction.
# level 6, not the default 9: on a radar scan 9 costs ~600 ms of CPU to save
# ~5% over 6, which takes ~20 ms.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)


if os.environ.get("WEATHERTS_HOSTED"):
    # The web version's backend serves everyone from a fixed monthly budget:
    # one address may make 1500 requests in any 5 minutes (5 a second on
    # average, far above a person looping radar and satellite at once), and
    # past that gets 429 until its window empties. The desktop's own backend
    # serves one person and never counts.
    import threading as _threading
    import time as _time
    from collections import deque as _deque

    from starlette.responses import JSONResponse as _JSONResponse

    _RATE_WINDOW_S = 300.0
    _RATE_MAX = 1500
    _rate_hits: dict[str, _deque] = {}
    _rate_lock = _threading.Lock()

    @app.middleware("http")
    async def _rate_limit(request, call_next):
        # Behind Cloudflare the visitor is CF-Connecting-IP; behind Modal's
        # proxy, the first X-Forwarded-For.
        fwd = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for", "")
        ip = fwd.split(",")[0].strip() or (request.client.host if request.client else "?")
        now = _time.monotonic()
        with _rate_lock:
            q = _rate_hits.setdefault(ip, _deque())
            while q and now - q[0] > _RATE_WINDOW_S:
                q.popleft()
            if len(q) >= _RATE_MAX:
                return _JSONResponse({"detail": "Too many requests from this address; try again in a few minutes."}, status_code=429)
            q.append(now)
            if len(_rate_hits) > 50_000:
                # Forget addresses that went quiet, so the table cannot grow without end.
                for k in [k for k, v in _rate_hits.items() if not v or now - v[-1] > _RATE_WINDOW_S]:
                    del _rate_hits[k]
        return await call_next(request)


# An analysis endpoint waits on downloads for seconds. Run as a plain `def`,
# each one holds a thread of the request pool for that whole wait -- and a
# browser giving up does not end it, so clicking through a few products filled
# the pool and even /api/obs/frames queued behind the downloads. The work goes
# to a pool of its own and the handlers await it: when the browser moves on,
# the request is let go at once, and the download finishes into the cache for
# whenever that product is asked for again.
_OBS_POOL = ThreadPoolExecutor(max_workers=6, thread_name_prefix="obs-api")
# Satellite pictures wait on downloads the same way; a pool of their own, so a
# loop coming in never holds up the analyses (or the other way round).
_SAT_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="sat-api")
# Frame lists apart from the pictures: a product switch must not wait for the
# old product's pictures to finish before it learns its own times.
_SAT_LIST_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="sat-list")


async def _obs_call(fn, *args, **kwargs):
    return await asyncio.wrap_future(_OBS_POOL.submit(fn, *args, **kwargs))


def _drop_queued_work() -> None:
    """Background queues let go on shutdown, so the process can exit."""
    observations.shutdown()
    _OBS_POOL.shutdown(wait=False, cancel_futures=True)
    _SAT_POOL.shutdown(wait=False, cancel_futures=True)
    _SAT_LIST_POOL.shutdown(wait=False, cancel_futures=True)


app.router.on_shutdown.append(_drop_queued_work)


def _exit_without_waiting() -> None:
    """Leave as soon as the server has stopped.

    Python joins every worker thread before it exits, and a loop's downloads
    already under way can take minutes on a slow line. The server was done and
    the process lingered -- in development the reloader waited on it with no
    backend running at all. Nothing left in those threads is worth the wait:
    finished frames are already on disk, half-done ones are fetched again.
    """
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


# Registered after concurrent.futures' own hook, and these run last-first, so
# this one runs before the threads would be joined.
if hasattr(threading, "_register_atexit"):
    threading._register_atexit(_exit_without_waiting)  # noqa: SLF001


def _roomier_thread_pool() -> None:
    """Plain handlers run on a pool of forty threads, and several of them wait on
    a download: a loop being made, the frame a timeline landed on. Forty such
    waits and every endpoint queued -- a panel then opened with no
    catalogue at all. Threads that only wait cost next to nothing."""
    anyio.to_thread.current_default_thread_limiter().total_tokens = 256


app.router.on_startup.append(_roomier_thread_pool)


def _warm_satellite() -> None:
    """The satellite's frame list and sector placements, fetched while the app
    is still opening instead of when the layer is turned on."""
    _SAT_POOL.submit(satellite.warm)
    # The station networks behind the plots: the WMO list and the SYNOP set,
    # then the mesonets' 32 MB hour, in the background.
    import station_networks  # noqa: PLC0415

    station_networks.warm()


app.router.on_startup.append(_warm_satellite)


# The Brazilian radars stay out of the released app (Pablo, 2026-11-02): the
# packaged backend offers none of them, whatever the store holds, unless
# WEATHERTS_BR_RADARS=1. A dev run (not frozen) keeps them, for the CEMADEN demo.
BR_RADARS_ON = os.environ.get("WEATHERTS_BR_RADARS") == "1" or not getattr(sys, "frozen", False)
opera_radar.install()


def _follow_radar_relay() -> None:
    """The Brazilian radars live from the WeatherTS radar relay, in the
    background, when WEATHERTS_RADAR_RELAY names one: its radars in the picker,
    the ones the app looks at (radar_relay_client.touch) downloaded. Relay or
    not, relayed volumes past the retention are pruned once, in a thread."""
    if BR_RADARS_ON:
        radar_relay_client.start()


app.router.on_startup.append(_follow_radar_relay)


@app.get("/health")
def health():
    return {"ok": True, "service": "sounding", "engine": "SHARPpy"}


@app.get("/api/models")
def models():
    return {"models": sounding_core.list_models(), "default": sounding_core.DEFAULT_MODEL}


@app.get("/api/sounding")
def sounding(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    model: str = Query(sounding_core.DEFAULT_MODEL),
    hour: int = Query(0, ge=0, le=384),
    parcel: str = Query("", description="SFC | ML | MU | EFF | FCST | USER"),
    parcelPressure: float | None = Query(None, ge=100, le=1100),
    stormMotion: str = Query("", description="right | left | mean | corfidi-up | corfidi-down | custom"),
    stormMotionDir: float | None = Query(None),
    stormMotionSpd: float | None = Query(None, ge=0),
    render: bool = Query(True, description="false returns parameters without the SHARPpy plot"),
):
    try:
        view = sounding_view.parse_view(parcel, parcelPressure, stormMotion,
                                        stormMotionDir, stormMotionSpd)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    try:
        return sounding_core.build_sounding(lat, lon, model, hour, view, render)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/raob")
def raob(
    station: str = Query(...),
    name: str = Query(""),
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    hour: int = Query(0, ge=0),
    wmo: str = Query(""),
    parcel: str = Query("", description="SFC | ML | MU | EFF | FCST | USER"),
    parcelPressure: float | None = Query(None, ge=100, le=1100),
    stormMotion: str = Query("", description="right | left | mean | corfidi-up | corfidi-down | custom"),
    stormMotionDir: float | None = Query(None),
    stormMotionSpd: float | None = Query(None, ge=0),
    render: bool = Query(True, description="false returns parameters without the SHARPpy plot"),
    axis: bool = Query(True, description="false skips probing the whole window for the time axis"),
):
    try:
        view = sounding_view.parse_view(parcel, parcelPressure, stormMotion,
                                        stormMotionDir, stormMotionSpd)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    try:
        return raob_core.build_raob(station, name, lat, lon, hour, wmo, view, render, axis)
    except raob_core.NoObservationError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/sounding/area")
def sounding_area(
    bbox: str = Query(..., description="lat0,lon0,lat1,lon1 — any two opposite corners"),
    model: str = Query(sounding_core.DEFAULT_MODEL),
    hour: int = Query(0, ge=0, le=384),
    side: int = Query(area_sounding.DEFAULT_SIDE, ge=area_sounding.MIN_SIDE,
                      le=area_sounding.MAX_SIDE),
    parcel: str = Query("", description="SFC | ML | MU | EFF | FCST | USER"),
    parcelPressure: float | None = Query(None, ge=100, le=1100),
    stormMotion: str = Query("", description="right | left | mean | corfidi-up | corfidi-down | custom"),
    stormMotionDir: float | None = Query(None),
    stormMotionSpd: float | None = Query(None, ge=0),
):
    """One sounding averaged over the rectangle the user drew on the map."""
    try:
        view = sounding_view.parse_view(parcel, parcelPressure, stormMotion,
                                        stormMotionDir, stormMotionSpd)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    try:
        parts = [float(x) for x in bbox.split(",")]
        if len(parts) != 4:
            raise ValueError("bbox must be lat0,lon0,lat1,lon1")
        return area_sounding.build_area_sounding(*parts, model=model, hour=hour, side=side,
                                                 view=view)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/acars/profiles")
def acars_profiles(
    hours: int = Query(acars_core.DEFAULT_HOURS, ge=1, le=acars_core.MAX_HOURS),
    end: float | None = Query(None, ge=0),
):
    """Airports with a recent aircraft (ACARS/AMDAR) ascent or descent."""
    try:
        return acars_core.list_profiles(hours, end)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/acars/sounding")
def acars_sounding(
    airport: str = Query(..., min_length=2, max_length=6),
    unix: int | None = Query(None, ge=0),
    hours: int = Query(acars_core.DEFAULT_HOURS, ge=1, le=acars_core.MAX_HOURS),
    parcel: str = Query("", description="SFC | ML | MU | EFF | FCST | USER"),
    parcelPressure: float | None = Query(None, ge=100, le=1100),
    stormMotion: str = Query("", description="right | left | mean | corfidi-up | corfidi-down | custom"),
    stormMotionDir: float | None = Query(None),
    stormMotionSpd: float | None = Query(None, ge=0),
):
    """One aircraft profile, in the same shape as every other sounding."""
    try:
        view = sounding_view.parse_view(parcel, parcelPressure, stormMotion,
                                        stormMotionDir, stormMotionSpd)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    try:
        return acars_core.build_acars(airport, unix, hours, view)
    except acars_core.NoProfileError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/api/sounding/upload")
def sounding_upload_endpoint(payload: dict = Body(...)):
    """Render a sounding the user pasted, through the same SHARPpy pipeline."""
    try:
        return sounding_upload.build_upload(
            str(payload.get("text") or ""),
            str(payload.get("title") or ""),
            float(payload.get("lat") or 35.0),
            float(payload.get("lon") or -97.0),
        )
    except sounding_upload.BadSounding as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/lsr")
def lsr(
    hours: int = Query(12, ge=1, le=lsr_core.MAX_HOURS),
    end: float | None = Query(None, ge=0),
    bbox: str = Query(""),
    start: float | None = Query(None, ge=0),
):
    """NWS Local Storm Reports over a trailing window, or from `start` to `end`."""
    try:
        box = None
        if bbox:
            parts = [float(x) for x in bbox.split(",")]
            if len(parts) != 4:
                raise ValueError("bbox must be lat0,lon0,lat1,lon1")
            box = (min(parts[0], parts[2]), min(parts[1], parts[3]),
                   max(parts[0], parts[2]), max(parts[1], parts[3]))
        return lsr_core.fetch_lsr(hours=hours, end_unix=end, bbox=box, start_unix=start)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/lsr/types")
def lsr_types():
    return lsr_core.list_types()


@app.get("/api/fronts")
def fronts(
    history: int = Query(4, ge=0, le=24),
    forecast: bool = Query(True),
    source: str = Query("wpc", pattern="^(wpc|gfs|model)$"),
    model: str = Query(fronts_model.DEFAULT_MODEL),
):
    """Surface fronts and progs, as timeline frames of GeoJSON.

    `source` picks the analysis: "wpc" is WPC's hand analysis of North America;
    "model" (or "gfs", its first name) is fronts found automatically in `model`,
    which can be any model /api/model-fields/models marks as `fronts`.
    `history` past analyses plus the 12 h and 24 h forecast positions, so the
    fronts can be scrubbed on the same timeline as everything else.
    """
    try:
        if source in ("gfs", "model"):
            return fronts_model.build_fronts(model=model, history=history, forecast=forecast)
        return fronts_core.build_fronts(history=history, forecast=forecast)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/spc/mesoscale")
def spc_mesoscale():
    """Live SPC Mesoscale Discussions as GeoJSON polygons.

    An empty list is a normal answer: SPC issues these only while a forecaster
    is actively watching an area, which on a quiet day is nowhere.
    """
    try:
        return spc_md.build_mds()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nexrad/storms")
def nexrad_storm_tracks(
    site: str = Query(..., min_length=3, max_length=10),
    unix: int | None = Query(None, ge=0),
):
    """SCIT storm cells (past + forecast tracks) and mesocyclone detections.

    `unix` picks the storm scan nearest that instant so the tracks follow a
    scrubbed radar loop instead of always showing the latest volume.
    """
    if brazil_radar.is_br(site):
        r = brazil_radar.RADARS.get(site.upper(), {})
        return {"meta": {"site": site.upper(), "siteLat": r.get("lat", 0.0), "siteLon": r.get("lon", 0.0),
                         "maxRangeKm": 250.0, "validUnix": None, "key": None, "cellCount": 0, "mesoCount": 0,
                         "attributedCount": 0}, "cells": [], "mesos": []}
    try:
        return nexrad_storms.build_storms(site, unix)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nexrad/storms/history")
def nexrad_storm_history(
    site: str = Query(..., min_length=3, max_length=10),
    cell: str = Query(..., min_length=1, max_length=4),
    volumes: int = Query(storm_attributes.DEFAULT_HISTORY_VOLUMES, ge=2, le=40),
):
    """How one tracked cell's hail and structure changed over recent volumes.

    Oldest sample first. Empty is a normal answer -- the live feed only reaches
    back about a day, and a cell only appears in the scans it was tracked in.
    """
    if brazil_radar.is_br(site):
        return {"site": site.upper(), "cell": cell.upper(), "samples": []}
    try:
        return {"site": site.upper(), "cell": cell.upper(),
                "samples": storm_attributes.fetch_history(site, cell, volumes)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nexrad/vwp")
def nexrad_vwp_profile(
    site: str = Query(..., min_length=3, max_length=10),
    columns: int = Query(12, ge=1, le=nexrad_vwp.MAX_COLUMNS),
):
    """VAD Wind Profile: the radar's own wind profile, one column per volume."""
    if brazil_radar.is_br(site):
        raise HTTPException(status_code=404, detail="No VAD wind profile for this radar.")
    try:
        return nexrad_vwp.build_vwp(site, columns)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nexrad/vwp/sounding")
def nexrad_vwp_sounding(
    site: str = Query(..., min_length=3, max_length=4),
    model: str = Query(sounding_core.DEFAULT_MODEL),
    parcel: str = Query(""),
    parcelPressure: float | None = Query(None, ge=100, le=1100),
    stormMotion: str = Query(""),
    stormMotionDir: float | None = Query(None),
    stormMotionSpd: float | None = Query(None, ge=0),
    render: bool = Query(True),
):
    """The radar's VAD winds on the model's thermodynamics, as a SHARPpy plot."""
    try:
        view = sounding_view.parse_view(parcel, parcelPressure, stormMotion,
                                        stormMotionDir, stormMotionSpd)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    try:
        return vwp_sounding.build_vwp_sounding(site.strip("Kk ") or site, model, view, render)
    except vwp_sounding.NoProfileError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nexrad/vwp/panel")
def nexrad_vwp_panel(
    site: str = Query(..., min_length=3, max_length=4),
    motion: str = Query("right"),
    motionDir: float | None = Query(None, ge=0, le=360),
    motionSpd: float | None = Query(None, ge=0, le=200),
    product: str = Query("N0B"),
    showMap: bool = Query(True),
):
    """The full VWP hodograph panel as one image, parameters computed by SHARPpy."""
    custom = None
    if motion == "custom":
        if motionDir is None or motionSpd is None:
            raise HTTPException(status_code=400,
                                detail="A custom storm motion needs both a direction and a speed.")
        custom = (float(motionDir), float(motionSpd))
    try:
        out = vwp_panel.render_vwp_panel(site, motion, custom, product, showMap)
    except vwp_sounding.NoProfileError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    return {
        "image": base64.b64encode(out["png"]).decode("ascii"),
        "meta": out["meta"],
        "motions": out["motions"],
        "rows": out["rows"],
        "critical": out["critical"],
    }


@app.get("/api/nexrad/sites")
def nexrad_sites():
    try:
        out = nexrad_core.list_sites()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    # The Brazilian radars beside the NEXRADs: online where a volume is kept.
    try:
        if BR_RADARS_ON:
            out = out + brazil_radar.sites()
    except Exception:  # noqa: BLE001 - the NEXRAD list stands alone
        pass
    out = out + opera_radar.sites()
    try:
        return {"sites": out}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nexrad/site-status")
def nexrad_site_status():
    """Every radar's live standing, NEXRAD and TDWR (radar_status): ok / late / stale / down / unknown."""
    return radar_status.statuses()


@app.get("/api/nexrad/site-status/detail")
def nexrad_site_status_detail(site: str = Query(...)):
    """One radar's standing with its reasons: RDA alarms, the office's outage
    notice (FTM), and when its newest Level II chunk / Level III scan came in."""
    try:
        return radar_status.site_detail(site)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nexrad/site-scans")
def nexrad_site_scans(ids: str = Query("")):
    """When each listed radar's newest 0.5 deg reflectivity came in (the labels' blink)."""
    return {"scans": radar_status.newest_scans(ids.split(","))}


@app.get("/api/nexrad/availability")
def nexrad_availability_route(site: str = Query(...), quick: bool = Query(False), at: int = Query(0, ge=0)):
    """Every product and tilt this radar is publishing now, at its real angle.
    `quick` answers from Level III alone first (see nexrad_availability); `at`
    asks what it had at that moment, for archive playback."""
    if brazil_radar.is_br(site):
        radar_relay_client.touch(site)
        try:
            return brazil_radar.availability(site.upper(), at or None)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=str(exc))
    try:
        out = nexrad_availability.site_availability(site, quick, at or None)
        if isinstance(out, dict) and isinstance(out.get("families"), dict):
            brazil_radar.empty_families(out["families"])
        return out
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nexrad/cuts")
def nexrad_cuts(site: str = Query(...), at: int = Query(0, ge=0)):
    """The elevations this radar is flying: every cut, and the one below 0.5 deg if it has one."""
    if brazil_radar.is_br(site):
        return brazil_radar.cuts(site.upper(), at or None)
    try:
        return nexrad_level2.site_cuts(site, at or None)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nexrad/meta")
def nexrad_meta():
    return {
        "products": nexrad_core.list_products(),
        # `catalog` stays as the flat Level III list for anything still reading it.
        "catalog": nexrad_core.product_catalog(),
        # One product list, each moment from its best source (Level III unless
        # Level II genuinely wins: CC, ZDR, SW, PHI, CFP). No more picking the
        # worse source of a product that's in both.
        # ...and the families only the Brazilian radars' volumes make.
        "grids": nexrad_level2.merged_catalog(nexrad_core.product_catalog()) + brazil_radar.extra_catalog(),
        "palettes": nexrad_core.list_palettes(),
        "defaultProduct": nexrad_core.DEFAULT_PRODUCT,
    }


@app.get("/api/nexrad/palettes.json")
def nexrad_palettes():
    """Raw .pal tables so the client can colour the mesh itself (instant swaps)."""
    return {
        "palettes": {
            pid: {"label": spec["label"], "pal": spec["pal"]}
            for pid, spec in nexrad_core.PALETTES.items()
        },
        "kindDefaults": nexrad_core._KIND_DEFAULT_PALETTE,
    }


@app.get("/api/nexrad/data")
def nexrad_data(
    site: str = Query(...),
    product: str = Query(nexrad_core.DEFAULT_PRODUCT),
    key: str = Query(""),
    dealias: str = Query("", max_length=8),
    motion: str = Query("", max_length=16),
):
    """Binary polar scan.

    `dealias` (region | vad | off) and `motion` (auto | sti | <from deg>/<kt>)
    apply to Level II velocity, SRV, VROT and PTDS; they are folded into the
    product code (radar_derived.with_options), which the caches key on.

    Layout: [4-byte header len][JSON header][az f32 * (nAz+1)][lut f32 * 256]
            [codes u8 * nAz*nGates]
    Gates stay in their native 8-bit codes; the client maps them through the lut.
    See nexrad_core.polar_data for why.
    """
    try:
        # "L2..." products come from a live Level II volume (super-res); the rest
        # from Level III. Same wire format either way.
        if brazil_radar.is_br(site):
            out = brazil_radar.polar(site.upper(), product.upper(), key or "")
        elif tdwr.is_tdwr(site):
            # An airport radar is Level III only: a code held over from another
            # radar is answered under its own code for that moment, and a moment
            # it does not have is refused (tdwr.to_tdwr).
            out = nexrad_core.polar_data(site, product, key or None)
        elif product.upper().startswith("L2"):
            if dealias or motion:
                import radar_derived  # noqa: PLC0415

                product = radar_derived.with_options(product, dealias, motion)
            out = nexrad_level2.polar_data_l2(site, product.upper(), key or "")
        else:
            out = nexrad_core.polar_data(site, product, key or None)
    except (tdwr.NotOnTdwr, brazil_radar.NoData) as exc:
        # 400, not 422: the frame is fine, this radar just has no such moment.
        raise HTTPException(status_code=400, detail=str(exc))
    except nexrad_core.UndecodableScan as exc:
        # Permanent: 422, so the app drops the frame instead of retrying it.
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))

    header = json.dumps(out["meta"]).encode("utf-8")
    body = (
        struct.pack("<I", len(header))
        + header
        + out["az"].astype("<f4").tobytes()
        + out["lut"].astype("<f4").tobytes()
        + out["codes"].tobytes()
    )
    return Response(
        content=body,
        media_type="application/octet-stream",
        # a published scan never changes -- let the browser keep it; a tilt of
        # the volume still being written that isn't scanned yet will, and so
        # will a young frame of a European radar, as its files land
        headers={"Cache-Control": "no-store" if out["meta"].get("pending") or out["meta"].get("young")
                 else "public, max-age=86400"},
    )


@app.get("/api/radar/file/info")
def radar_file_info(site: str = Query(..., max_length=16), key: str = Query(..., max_length=96)):
    """What a loop frame's original radar file is: name, bytes, source
    (radar_files.py). The Frames panel's details row."""
    import radar_files  # noqa: PLC0415

    try:
        return radar_files.describe(site, key)
    except radar_files.FileError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc).strip("'\""))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/radar/file")
def radar_file(site: str = Query(..., max_length=16), key: str = Query(..., max_length=96)):
    """A loop frame's original radar file (Level II volume, Level III product,
    kept Brazilian volume), as an attachment."""
    import radar_files  # noqa: PLC0415

    try:
        name, raw = radar_files.original(site, key)
    except radar_files.FileError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc).strip("'\""))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    return Response(
        content=raw,
        media_type="application/zip" if name.endswith(".zip") else "application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            # Already compressed (bzip2 records): GZipMiddleware leaves it be.
            "Content-Encoding": "identity",
            "Cache-Control": "no-store" if "_partial" in name else "public, max-age=86400",
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


@app.get("/api/net/probe")
def net_probe():
    """Whether the backend reaches the internet, and how fast: one small HEAD to
    the Level III bucket (the app's connection badge asks when requests fail)."""
    import time as _t  # noqa: PLC0415

    t0 = _t.perf_counter()
    try:
        r = nexrad_core._SESSION.head(nexrad_core.S3, timeout=(4, 6))
        ok = r.status_code < 500
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "ms": round((_t.perf_counter() - t0) * 1000), "error": type(exc).__name__}
    return {"ok": ok, "ms": round((_t.perf_counter() - t0) * 1000)}


@app.get("/api/nexrad/xsect")
def nexrad_xsect(
    site: str = Query(...),
    a: str = Query(..., description="lat,lon"),
    b: str = Query(..., description="lat,lon"),
    fam: str = Query("B", min_length=1, max_length=1),
    at: float | None = Query(None, gt=0),
    key: str = Query(""),
    top: float = Query(16.0, ge=4, le=25),
    dealias: str = Query("off", pattern="^(off|region|vad)$"),
    motion: str = Query("", max_length=24),
):
    """A vertical cross-section, A to B, through the Level II volume nearest
    `at` (or `key`, or the newest). Layout: [4-byte header len][JSON header]
    [codes u8 * rows*cols], top row first; the header carries the lut."""
    if tdwr.is_tdwr(site):
        raise HTTPException(status_code=422, detail=tdwr.LEVEL2_NOTE)
    try:
        pa = tuple(float(x) for x in a.split(","))
        pb = tuple(float(x) for x in b.split(","))
        if len(pa) != 2 or len(pb) != 2:
            raise ValueError("a and b must be lat,lon")
        if brazil_radar.is_br(site):
            fu = fam.upper()
            if fu not in radar_xsect.SECTION_SPECS:
                raise ValueError(f"Unknown moment {fam}")
            st = brazil_radar.stack(site.upper(), key, at, fu)
            label, units, kind = radar_xsect.SECTION_SPECS[fu]
            mo = st.get("motion")
            out = radar_xsect.section(st, pa, pb, fam=fu, label=label, units=units, kind=kind,
                                      site_label=site.upper()[3:], key=st["key"], scan_unix=st["unix"],
                                      motion=(mo["speedKt"], mo["toward"]) if mo else None, top_km=top)
        else:
            out = radar_xsect.cross_section(site, pa, pb, fam.upper(), at, key, top,
                                            dealias=dealias, motion=motion)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    header = json.dumps(out["meta"]).encode("utf-8")
    body = struct.pack("<I", len(header)) + header + out["codes"].tobytes()
    return Response(content=body, media_type="application/octet-stream", headers={"Cache-Control": "no-store"})


@app.get("/api/radar/volume3d")
def radar_volume3d_route(
    site: str = Query(...),
    fam: str = Query("B", min_length=1, max_length=1),
    at: float | None = Query(None, gt=0),
    key: str = Query(""),
    fill: str = Query("none", pattern="^(none|neighbor)$"),
    bbox: str = Query("", description="west,south,east,north (lon/lat)"),
    lightning: bool = Query(True),
    part: str = Query("all", pattern="^(all|glm)$"),
    rid: str = Query("", max_length=48),
    dealias: str = Query("off", pattern="^(off|region|vad)$"),
    motion: str = Query("", max_length=24),
    look: str = Query("smooth", pattern="^(smooth|beams)$"),
):
    """The 3D view's voxel box (backend/radar_volume3d.py): every tilt of the
    Level II volume nearest `at` (or `key`, or the newest whole one) on a grid
    over `bbox` -- or around the radar without one -- gzipped. A box out of the
    radar's range answers 422 with the reason. `rid` names the request for
    /api/radar/volume3d/progress."""
    if tdwr.is_tdwr(site):
        radar_volume3d._say(rid, stage="error", error=tdwr.LEVEL2_NOTE)
        raise HTTPException(status_code=422, detail=tdwr.LEVEL2_NOTE)
    box = None
    if bbox:
        try:
            box = tuple(float(v) for v in bbox.split(","))
        except ValueError:
            raise HTTPException(status_code=400, detail="bbox must be west,south,east,north")
        if len(box) != 4:
            raise HTTPException(status_code=400, detail="bbox must be west,south,east,north")
    try:
        body = radar_volume3d.volume3d(site, fam=fam.upper(), at=at, key=key, fill=fill, bbox=box,
                                       lightning=lightning, part=part, rid=rid, compress=True,
                                       dealias=dealias, motion=motion, look=look)
    except radar_volume3d.BoxError as exc:
        radar_volume3d._say(rid, stage="error", error=str(exc))
        raise HTTPException(status_code=422, detail=str(exc))
    except ValueError as exc:
        radar_volume3d._say(rid, stage="error", error=str(exc))
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        radar_volume3d._say(rid, stage="error", error=str(exc))
        raise HTTPException(status_code=502, detail=str(exc))
    return Response(content=body, media_type="application/octet-stream",
                    headers={"Content-Encoding": "gzip", "Cache-Control": "no-store"})


@app.get("/api/radar/volume3d/progress")
def radar_volume3d_progress(rid: str = Query(..., max_length=48)):
    """Where a 3D volume request is: its stage, the radars downloading, the
    building's steps -- for the view's loading pill."""
    return radar_volume3d.progress(rid) or {"stage": "waiting"}


@app.get("/api/radar/detections")
def radar_detections(
    site: str = Query(..., min_length=3, max_length=12),
    key: str = Query("", max_length=160),
    at: float | None = Query(None, gt=0),
    trail: bool = Query(False),
):
    """Storm detections computed from the radar's own volume: mesocyclones and
    weaker circulations (base, top, Vrot, track), the strongest velocity
    couplets at the low tilts, and tornado debris signatures. The Level II (or
    kept Brazilian) volume is `key` when it names one, else the one at or just
    before `at`, else the newest; results are kept per (site, volume). `trail`
    also reads the volume before when it is not kept, so tracks come back."""
    if tdwr.is_tdwr(site):
        raise HTTPException(status_code=422, detail=tdwr.LEVEL2_NOTE)
    try:
        return radar_detect.detections(site, key or "", at, trail)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


def _loop_window(scans: list[dict], minutes: int, start: int) -> list[dict]:
    """A loop of `minutes`: back from the newest scan (live), or on from
    `start` (archive). 0 = as listed."""
    if not minutes or not scans:
        return scans
    if start:
        return [s for s in scans if s["time"] < start + minutes * 60]
    newest = max(s["time"] for s in scans)
    return [s for s in scans if s["time"] >= newest - minutes * 60]


@app.get("/api/nexrad/scans")
def nexrad_scans(
    site: str = Query(...),
    product: str = Query(nexrad_core.DEFAULT_PRODUCT),
    date: str = Query(""),
    limit: int = Query(0, ge=0, le=500),
    start: int = Query(0, ge=0),
    minutes: int = Query(0, ge=0, le=480),
    sails: bool = Query(False),
):
    """`minutes` makes the loop a span of time (30 min to 8 h) instead of a
    count; `sails` adds each live Level II volume's rescanned tilts
    (``reps``: {slot: [unix of each scan]}, level2_live.reps_for)."""
    if brazil_radar.is_br(site):
        radar_relay_client.touch(site)
        try:
            # The Whole day picker: that day's frames, or none (today's are not that day's).
            if date and opera_radar.handles(site):
                return {"scans": opera_radar.day_scans(site.upper(), date), "archiveStart": None}
            got = brazil_radar.scans(site.upper(), max(limit, 120) if minutes else limit, start or None)
            out = {"scans": _loop_window(got, minutes, start), "archiveStart": None}
            # A European radar gone quiet says since when, for the viewer to say so.
            if not got and not start and opera_radar.handles(site):
                out["note"] = opera_radar.quiet_note(site.upper())
            return out
        except Exception as exc:  # noqa: BLE001
            # An answer the browser can read (a bare 500 has no CORS header): it would
            # take it for a lost connection and wait for a reconnect that never comes.
            raise HTTPException(status_code=502, detail=str(exc))
    # An airport radar: Level III whatever the code asked for.
    if tdwr.is_tdwr(site):
        try:
            product = tdwr.to_tdwr(product)
        except tdwr.NotOnTdwr as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    try:
        # Level II frames are whole volumes: live off the chunk bucket, which
        # keeps about two days, and archive playback out of the archive. Each
        # is 7-16 MB, so the loop is capped tighter than the Level III one.
        if product.upper().startswith("L2") and date:
            # A whole UTC day out of the archive (archive-l2), back to 1991:
            # every volume but the fragments.
            day = [v for v in nexrad_level2.archive_day(site, date) if not v["partial"]]
            return {"scans": [{"key": v["key"], "time": v["time"]} for v in day],
                    "archiveStart": nexrad_core.ARCHIVE_START}
        if product.upper().startswith("L2"):
            # A volume every 4-10 min: an 8 h loop is up to ~124 of them.
            n = min(math.ceil(minutes / 4) + 4, 130) if minutes else min(limit or 30, nexrad_level2.MAX_LOOP)
            vols = _loop_window(nexrad_level2.list_volumes(site, n, start=start or None), minutes, start)
            rows = [{"key": v["key"], "time": v["time"]} for v in vols]
            if sails and not start:
                import level2_live  # noqa: PLC0415

                with ThreadPoolExecutor(16) as ex:
                    reps = list(ex.map(lambda v: level2_live.reps_for(site, int(v["vol"])), vols))
                for row, rp in zip(rows, reps):
                    if rp:
                        row["reps"] = rp
            return {"scans": rows, "archiveStart": nexrad_core.ARCHIVE_START}
        n = min(minutes + 10, 500) if minutes else limit
        return {
            "scans": _loop_window(nexrad_core.list_scans(site, product, date or None, n,
                                                         start=start or None), minutes, start),
            "archiveStart": nexrad_core.ARCHIVE_START,
        }
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nexrad/archive/day")
def nexrad_archive_day(site: str = Query(..., max_length=8), date: str = Query(..., max_length=10)):
    """Every Level II volume of a UTC day in the public archive (back to 1991),
    for the Archive panel's list: key, start time, bytes, and whether the file
    is a fragment. `level3` says whether Level III products exist that day.
    An airport radar lists its Level III scans the same way."""
    try:
        if tdwr.is_tdwr(site):
            return {
                "site": nexrad_core.icao_for(site),
                "date": date,
                "volumes": nexrad_core.tdwr_day(site, date),
                "level3": True,
                "tdwr": True,
            }
        vols = nexrad_level2.archive_day(site, date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    return {
        "site": nexrad_level2.icao_for(site),
        "date": date,
        "volumes": [{"key": v["key"], "time": v["time"], "size": v["size"], "partial": v["partial"]} for v in vols],
        "level3": date >= nexrad_core.ARCHIVE_START,
    }


@app.get("/api/nexrad/l2/live")
def nexrad_l2_live(site: str = Query(...)):
    """The Level II volume being written now: cuts in, megabytes so far and
    expected, the tilts already whole (level2_live.status)."""
    import level2_live  # noqa: PLC0415

    try:
        return level2_live.status(site)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nexrad/render")
def nexrad_render(
    site: str = Query(...),
    product: str = Query(nexrad_core.DEFAULT_PRODUCT),
    palette: str = Query(""),
    key: str = Query(""),
):
    try:
        out = nexrad_core.render(site, product, palette or None, key or None)
        return {
            "image": base64.b64encode(out["png"]).decode("ascii"),
            "bounds": out["bounds"],
            "meta": out["meta"],
        }
    except tdwr.NotOnTdwr as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


# ---------------------------------------------------------------------------
# Observations — the hourly analyses, as timeline frames
# ---------------------------------------------------------------------------

nexrad_core.warm_site_status()


# ---------------------------------------------------------------------------
# Aviation (aviation.py): the AWC's products and the FAA's TFRs, read through
# here because neither answers a browser from another origin; and the rest of
# the world's (aviation_world.py): OurAirports, the FIRs, the GFS aloft.
# ---------------------------------------------------------------------------
def _avn(make, *args):
    try:
        return make(*args)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Aviation data unavailable: {exc}")


@app.get("/api/aviation/metars")
def aviation_metars():
    """Every airport's newest METAR worldwide, with its flight category."""
    return _avn(aviation.metars)


@app.get("/api/aviation/tafs")
def aviation_tafs(at: int = Query(0, ge=0, description="the instant to read each TAF at (unix s); now when 0")):
    """Each TAF's forecast at one instant: what prevails, and the worst a TEMPO or PROB allows."""
    return _avn(aviation.taf_points, at or None)


@app.get("/api/aviation/pireps")
def aviation_pireps():
    return _avn(aviation.pireps)


@app.get("/api/aviation/sigmets")
def aviation_sigmets():
    return _avn(aviation.sigmets)


@app.get("/api/aviation/gairmets")
def aviation_gairmets():
    return _avn(aviation.gairmets)


@app.get("/api/aviation/cwas")
def aviation_cwas():
    return _avn(aviation.cwas)


@app.get("/api/aviation/tcf")
def aviation_tcf():
    return _avn(aviation.tcf)


@app.get("/api/aviation/tfrs")
def aviation_tfrs():
    return _avn(aviation.tfrs)


@app.get("/api/aviation/winds")
def aviation_winds(level: str = Query("low"), fcst: str = Query("06"),
                   source: str = Query("fb", pattern="^(fb|gfs)$"),
                   height: int = Query(30000, ge=1000, le=60000), lead: float = Query(6, ge=0, le=120)):
    """Winds and temperatures aloft: the FB forecast decoded onto its US
    stations, or the GFS at one altitude on a grid over the whole world."""
    if source == "gfs":
        return _avn(aviation_world.gfs_aloft, height, lead)
    return _avn(aviation.winds_aloft, level, fcst)


@app.get("/api/aviation/firs")
def aviation_firs():
    """The world's flight information regions."""
    return _avn(aviation_world.firs)


@app.get("/api/aviation/profile")
def aviation_profile(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
                     elev: float = Query(None), model: str = Query("gfs", pattern="^(gfs|ecmwf|icon)$")):
    """The air over one place hour by hour: winds, temperatures, cloud, icing, turbulence."""
    return _avn(aviation_world.profile, lat, lon, elev, model)


@app.get("/api/aviation/airspace")
def aviation_airspace(kind: str = Query("class", pattern="^(class|sua|artcc)$")):
    """US airspace outlines: classes B/C/D, special use airspace, ARTCC boundaries."""
    return _avn(aviation.airspace, kind)


@app.get("/api/aviation/airport")
def aviation_airport(icao: str = Query(..., min_length=2, max_length=10), hours: float = Query(24, ge=1, le=360),
                     model: str = Query("gfs", pattern="^(gfs|ecmwf|icon)$")):
    """One airport's page: runways, METARs, TAF, nearby PIREPs, advisories, winds aloft."""
    return _avn(aviation.airport, icao, hours, model)


@app.get("/api/aviation/search")
def aviation_search(q: str = Query(..., min_length=1, max_length=60)):
    return {"airports": _avn(aviation.search, q)}


@app.get("/api/obs/catalog")
def obs_catalog():
    """Which analyses are wired, and which fields each one carries."""
    return observations.catalog()


@app.get("/api/obs/bar")
def obs_bar(field: str = Query(...)):
    """A product's colour scale on its own: a compare view shows it before any
    picture has been drawn."""
    if field not in observations.PRODUCTS:
        raise HTTPException(status_code=400, detail=f"Unknown product: {field}")
    return observations.colour_bar(field)


@app.get("/api/obs/tracks")
async def obs_tracks(source: str = Query("atcf"), field: str = Query("trk_sel"), key: str = Query(...)):
    """An ATCF source's model tracks for the storm and cycle `key` names."""
    try:
        return await _obs_call(observations.track_data, source, field, key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/obs/compare")
async def obs_compare(
    source: str = Query(...),
    field: str = Query(...),
    unix: int = Query(..., description="the valid time to compare at"),
    mode: str = Query("models", pattern="^models$"),
    run: str = Query(""),
):
    """Every model with the product at one valid time (Compare models' "All models")."""
    try:
        return {"cells": await _obs_call(observations.compare, source, field, unix, mode, run)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/obs/strip")
def obs_strip(
    source: str = Query(...),
    run: str = Query("", description="the run on screen: a storm model's strip is that storm's runs"),
):
    """The runs Compare runs picks from, oldest first, each with its hours.
    A plain handler, not _obs_call: on the obs pool it queued behind the map's
    pictures while they downloaded."""
    try:
        runs, partial = observations.strip(source, run)
        return {"runs": runs, "partial": partial}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/obs/window")
async def obs_window(
    source: str = Query(...),
    field: str = Query(...),
    unix: int = Query(..., description="the timeline's valid time"),
    run: str = Query("", description="keep this run while it reaches the time; the newest otherwise"),
):
    """One window of a custom compare grid: any model, any product, at the
    timeline's valid time (or the model's nearest hour). Null when it has none."""
    try:
        return {"cell": await _obs_call(observations.window_at, source, field, unix, run)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/obs/runs")
def obs_runs(source: str = Query(...)):
    """A forecast model's runs that can be opened, newest first."""
    try:
        return {"runs": observations.runs(source)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/obs/frames")
def obs_frames(
    source: str = Query(observations.DEFAULT_SOURCE),
    field: str = Query("", description="the field about to be drawn — its newest hour starts warming"),
    hours: float = Query(0, ge=0, le=24 * 7, description="only the last this many hours, thinned to a loop"),
    run: str = Query("", description="a forecast model's run (YYYYMMDDHH); the newest when empty"),
    at: int = Query(0, ge=0, description="the archive: the instant whose day to open (unix s)"),
):
    """The timeline's frames, oldest first: the last `hours` of them, or every
    hour the source keeps -- or, for a forecast model, one run's hours, or for
    the archive, the day around `at`."""
    try:
        if observations.is_archive(source):
            out = observations.archive_frames(source, at or None)
            if field and out:
                # The picked hour is the one about to be drawn.
                pick = min(out, key=lambda f: abs(f["unix"] - at)) if at else out[-1]
                observations.warm_hour(source, field, pick["key"])
            return {"frames": out}
        # A model opened is a strip made ahead: Compare runs then opens at once.
        observations.warm_strip(source, run)
        if run:
            return {"frames": observations.run_frames(source, run)}
        out = observations.frames_for(source, hours) if hours > 0 else observations.frames(source)
        if field:
            observations.warm_newest(source, field)
        return {"frames": out}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/obs/value")
async def obs_value(
    source: str = Query(observations.DEFAULT_SOURCE),
    field: str = Query(observations.DEFAULT_FIELD),
    key: str = Query(""),
    lat: float = Query(...),
    lon: float = Query(...),
):
    """The analysed value at one point — what the pointer is over."""
    try:
        return await _obs_call(observations.value_at, source, field, key, lat, lon)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/obs/vectors")
async def obs_vectors(
    source: str = Query(observations.DEFAULT_SOURCE),
    field: str = Query(observations.DEFAULT_FIELD),
    key: str = Query(""),
):
    """Labelled contours over the field, and the outline of the analysed area."""
    try:
        body = await _obs_call(observations.vectors, source, field, key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    return Response(content=body, media_type="application/json")


@app.get("/api/obs/meta")
async def obs_meta(
    source: str = Query(observations.DEFAULT_SOURCE),
    field: str = Query(observations.DEFAULT_FIELD),
    key: str = Query(""),
    width: int = Query(observations.DEFAULT_WIDTH, ge=400, le=2400),
):
    """Where the picture goes and what it shows, without the picture itself.

    The picture is served apart (/api/obs/image) as a plain PNG: inside JSON it
    was base64 -- a third larger, parsed as text, then decoded again -- where
    the map can fetch and decode a PNG natively, and the browser can cache it.
    """
    try:
        out = await _obs_call(observations.render, source=source, field=field, key=key, width=width)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    b = out["bounds"]
    return {
        "coordinates": [
            [b["west"], b["north"]],
            [b["east"], b["north"]],
            [b["east"], b["south"]],
            [b["west"], b["south"]],
        ],
        "meta": {k: v for k, v in out.items() if k != "png"},
    }


@app.get("/api/obs/image")
async def obs_image(
    source: str = Query(observations.DEFAULT_SOURCE),
    field: str = Query(observations.DEFAULT_FIELD),
    key: str = Query(...),
    width: int = Query(observations.DEFAULT_WIDTH, ge=400, le=2400),
):
    """The picture for one hour, as the PNG itself."""
    try:
        out = await _obs_call(observations.render, source=source, field=field, key=key, width=width, warm=False)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    # An analysis hour never changes once published, so the browser may keep it.
    return Response(content=out["png"], media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.post("/api/obs/prefetch")
def obs_prefetch(payload: dict = Body(...)):
    """Start making a loop of analysis frames: {source, field, keys, view?}.
    `view` ({west, south, east, north, width, height}) also makes each frame's
    sharp picture of that box -- what the timeline plays when zoomed in."""
    try:
        return observations.prefetch(
            str(payload.get("source") or observations.DEFAULT_SOURCE),
            str(payload.get("field") or observations.DEFAULT_FIELD),
            [str(k) for k in (payload.get("keys") or [])],
            payload.get("view"),
        )
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/obs/cancel")
def obs_cancel():
    """Stop making the loop being loaded."""
    return observations.cancel_loop()


@app.post("/api/obs/loop-status")
def obs_loop_status(payload: dict = Body(...)):
    """Which frames of a loop are made: {source, field, keys} -> {ready, failed}."""
    try:
        return observations.loop_status(
            str(payload.get("source") or observations.DEFAULT_SOURCE),
            str(payload.get("field") or observations.DEFAULT_FIELD),
            [str(k) for k in (payload.get("keys") or [])],
        )
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/obs/points")
async def obs_points(payload: dict = Body(...)):
    """Values under a list of places: {source, field, key, points: [[lat, lon], ...]}."""
    try:
        points = [[float(a), float(b)] for a, b in (payload.get("points") or [])]
        return await _obs_call(
            observations.points_at,
            str(payload.get("source") or observations.DEFAULT_SOURCE),
            str(payload.get("field") or observations.DEFAULT_FIELD),
            str(payload.get("key") or ""),
            points,
        )
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/obs/view")
async def obs_view(
    source: str = Query(observations.DEFAULT_SOURCE),
    field: str = Query(observations.DEFAULT_FIELD),
    key: str = Query(...),
    west: float = Query(..., ge=-540, le=540),
    south: float = Query(..., ge=-90, le=90),
    east: float = Query(..., ge=-540, le=540),
    north: float = Query(..., ge=-90, le=90),
    width: int = Query(1024, ge=64, le=3072),
    height: int = Query(768, ge=64, le=3072),
):
    """The part of one hour on screen, sharp at the zoom it is looked at."""
    try:
        png = await _obs_call(observations.render_view, source, field, key, west, south, east, north, width, height)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    return Response(content=png, media_type=observations.VIEW_MEDIA,
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/obs/render")
async def obs_render(
    source: str = Query(observations.DEFAULT_SOURCE),
    field: str = Query(observations.DEFAULT_FIELD),
    key: str = Query("", description="YYYYMMDDHH — blank means the newest hour"),
    width: int = Query(1600, ge=400, le=2400),
):
    """One hour of one field as a Mercator PNG plus the corners to place it at."""
    try:
        out = await _obs_call(observations.render, source=source, field=field, key=key, width=width)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    b = out["bounds"]
    return {
        "image": base64.b64encode(out["png"]).decode("ascii"),
        # Clockwise from the top left, which is the order MapLibre expects.
        "coordinates": [
            [b["west"], b["north"]],
            [b["east"], b["north"]],
            [b["east"], b["south"]],
            [b["west"], b["south"]],
        ],
        "meta": {k: v for k, v in out.items() if k != "png"},
    }


@app.get("/api/surface-obs")
def surface_obs_endpoint(
    bbox: str = Query(...),
    cell: float | None = Query(None, gt=0, le=20, description="One station per cell this many degrees across"),
    networks: str = Query("metar,synop,mesonet"),
    at: int | None = Query(None, gt=0, description="The reports in force at this instant (unix s) instead of the newest"),
):
    try:
        return surface_obs.fetch_surface_obs(bbox, cell=cell, networks=networks, at=at)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/stations/networks")
def stations_networks_status():
    """How many stations each network has now, and the INMET token's state."""
    import station_networks  # noqa: PLC0415

    return station_networks.networks_status()


@app.post("/api/stations/inmet-token")
def stations_inmet_token(payload: dict = Body(...)):
    """Keep the user's INMET token (empty clears it) and read the network with it."""
    import station_networks  # noqa: PLC0415

    if os.environ.get("WEATHERTS_HOSTED"):
        # One server for every visitor of the web version: a token set here
        # would be everyone's, and anyone could clear it.
        raise HTTPException(status_code=403, detail="The web version cannot store an INMET token; the desktop app can.")

    return station_networks.set_inmet_token(str(payload.get("token") or ""))


@app.get("/api/surface-obs/history")
def surface_obs_history(station: str = Query(..., min_length=2), hours: int = Query(24, ge=1, le=48)):
    try:
        return {"observations": surface_obs.fetch_surface_history(station, hours)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/stations/directory")
def stations_directory(refresh: bool = Query(False)):
    try:
        return stations.station_directory(force=refresh)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/stations/series")
def stations_series(
    station: str = Query(..., min_length=2),
    hours: int = Query(24, ge=6, le=168),
    network: str = Query(""),
):
    try:
        return stations.station_series(station, hours, network)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/glm/flashes")
def glm_flashes(
    sat: str = Query("both", pattern="^(both|goes19|goes18)$"),
    minutes: int = Query(15, ge=1, le=glm.MAX_MINUTES),
    end: float | None = Query(None, gt=0),
    bbox: str = Query(""),
):
    """Lightning flashes from the GOES GLMs over the `minutes` before `end`
    (now when left out), inside bbox "west,south,east,north". Packed floats:
    see glm.pack. A window still downloading says so in its `pending`."""
    try:
        box = None
        if bbox:
            parts = [float(x) for x in bbox.split(",")]
            if len(parts) != 4:
                raise ValueError("bbox must be west,south,east,north")
            box = (parts[0], parts[1], parts[2], parts[3])
        data = glm.window(sat, minutes, end, box)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    return Response(content=data, media_type="application/octet-stream", headers={"Cache-Control": "no-store"})


@app.get("/api/rivers/gauges")
def rivers_gauges():
    """Every NWS river gauge: stage now, its flood category, the category
    stages, and the forecast's highest category."""
    try:
        return rivers.gauges()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/rivers/brazil")
def rivers_brazil():
    """Brazil's river stations: SGB's alert stations with the level they are
    in, and ANA's telemetry stations."""
    try:
        return brazil_rivers.stations()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


_SID = r"^[a-z]{2}\d{6}$"
# A deck id (al122005) or an IBTrACS one (2005236N23285).
_TRACK_ID = r"^([a-z]{2}\d{6}|\d{7}[NS]\d{5})$"
_BASIN = r"^(al|ep|cp|wp|io|sh|sl)$"


def _tropical(fn, *args, **kw):
    try:
        return fn(*args, **kw)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/tropical/storms")
def tropical_storms():
    """Every active tropical system worldwide: NHC's and JTWC's storms and invests."""
    return _tropical(tropical.storms)


@app.get("/api/tropical/track")
def tropical_track(id: str = Query(..., pattern=_TRACK_ID)):
    """A storm's best track with wind radii, and its ACE."""
    return _tropical(tropical.track, id)


@app.get("/api/tropical/guidance")
def tropical_guidance(id: str = Query(..., pattern=_SID), cycle: Optional[str] = Query(None, pattern=r"^\d{10}$"),
                      which: str = Query("selected", pattern=r"^(selected|all)$")):
    """Model track and intensity guidance from the storm's ATCF a-deck."""
    return _tropical(tropical.guidance, id, cycle, which)


@app.get("/api/tropical/season")
def tropical_season(basin: str = Query(..., pattern=_BASIN), year: int = Query(..., ge=1842, le=2100),
                    invests: bool = False):
    """A season: every storm's summary and track, and ACE day by day."""
    return _tropical(tropical.season, basin, year, invests)


@app.get("/api/tropical/hurdat")
def tropical_hurdat(basin: str = Query(..., pattern=r"^(al|ep)$"), year_from: int = Query(1851, alias="from"),
                    year_to: int = Query(2100, alias="to"), min_peak: float = Query(0, alias="min")):
    """HURDAT2 tracks over a span of seasons, for the archive map."""
    return _tropical(tropical.hurdat_tracks, basin, year_from, year_to, min_peak)


@app.get("/api/tropical/records")
def tropical_records(basin: str = Query(..., pattern=r"^(al|ep)$")):
    """HURDAT2's record book and formations by month."""
    return _tropical(tropical.records, basin)


@app.get("/api/tropical/density")
def tropical_density(basin: str = Query(..., pattern=r"^(al|ep)$"), year_from: int = Query(1991, alias="from"),
                     year_to: int = Query(2100, alias="to")):
    """Named-storm track density on a 2-degree grid."""
    return _tropical(tropical.density, basin, year_from, year_to)


@app.get("/api/tropical/recon")
def tropical_recon(basin: str = Query("al", pattern=r"^(al|ep|cp)$"), hours: float = Query(24, gt=0, le=240),
                   start: Optional[str] = None, end: Optional[str] = None):
    """Hurricane Hunter HDOBs gathered into missions: the last hours, or a span."""
    def go():
        from datetime import datetime as _dt, timedelta as _td, timezone as _tz
        if start and end:
            a = _dt.fromisoformat(start.replace("Z", "+00:00"))
            b = _dt.fromisoformat(end.replace("Z", "+00:00"))
            if (b - a).days > 21:
                raise HTTPException(status_code=400, detail="At most three weeks at a time")
        else:
            b = _dt.now(_tz.utc)
            a = b - _td(hours=hours)
        return tropical.recon(basin, a, b)
    return _tropical(go)


@app.get("/api/tropical/recon/years")
def tropical_recon_years():
    return _tropical(tropical.recon_years)


@app.get("/api/tropical/enso")
def tropical_enso():
    """ONI, the weekly Nino indices, MEI v2, Nino 3.4 since 1870, the Tropical
    North Atlantic index and the AMO."""
    return _tropical(tropical.enso)


@app.get("/api/tropical/mjo")
def tropical_mjo():
    """The MJO every day since 1991, on RMM's axes, with its phase."""
    return _tropical(tropical.mjo)


@app.get("/api/radar/mosaic/europe")
def radar_mosaic_europe(hours: float = Query(3.0, gt=0, le=23)):
    """The times of EUMETNET OPERA's composite, and the corners its pictures cover."""
    try:
        return {"times": opera_radar.mosaic_times(hours), "bounds": opera_radar.MOSAIC_BOUNDS}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/radar/mosaic/europe.png")
def radar_mosaic_europe_png(t: int = Query(..., gt=0)):
    try:
        return Response(opera_radar.mosaic_png(t), media_type="image/png", headers={"Cache-Control": "max-age=86400"})
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/alerts/world/{source}")
def alerts_world(source: str, since: float | None = Query(None)):
    """The alerts of one source from outside the US (backend/world_alerts.py),
    in force or ended since `since` (unix seconds)."""
    try:
        return world_alerts.alerts(source, since)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No alert source {source}")


@app.get("/api/space/sdo")
def space_sdo_latest(size: int = Query(512, ge=256, le=4096)):
    """SDO's newest picture of each channel at one size."""
    try:
        return space_sdo.latest(size)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/space/sdo/frames")
def space_sdo_frames(
    ch: str = Query(..., pattern=r"^[A-Za-z0-9]{3,16}$"),
    size: int = Query(1024, ge=256, le=4096),
    hours: float = Query(24, gt=0, le=72),
):
    """Every SDO picture of one channel over the last hours, for a loop."""
    try:
        return space_sdo.frames(ch, size, hours)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/rivers/context")
def rivers_context(lid: str = Query(..., min_length=3, max_length=40)):
    """Around a gauge: the river's other gauges, the normal flow for each date
    (USGS), the rain past and forecast."""
    try:
        if lid.upper().startswith("BR:"):
            return brazil_rivers.context(lid)
        return rivers.context(lid)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/rivers/hydrograph")
def rivers_hydrograph(lid: str = Query(..., min_length=3, max_length=40)):
    """One gauge's observed and forecast stages, flood categories, crests and
    impacts; "BR:<code>" for a Brazilian station."""
    try:
        if lid.upper().startswith("BR:"):
            return brazil_rivers.hydrograph(lid)
        return rivers.hydrograph(lid)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/glm/prefetch")
def glm_prefetch(
    sat: str = Query("both", pattern="^(both|goes19|goes18)$"),
    start: float = Query(..., gt=0),
    end: float = Query(..., gt=0),
    bbox: str = Query(""),
):
    """Start downloading every GLM file from `start` to `end` and return at
    once: a loop's span, read ahead of its play."""
    try:
        box = tuple(float(x) for x in bbox.split(",")) if bbox else None
        if box is not None and len(box) != 4:
            raise ValueError("bbox must be west,south,east,north")
        return glm.prefetch(sat, start, end, box)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/sat/catalog")
def sat_catalog():
    """Satellites, their regions, and each region's products."""
    return satellite.catalog()


@app.get("/api/sat/frames")
async def sat_frames(
    sat: str = Query(...),
    region: str = Query(...),
    product: str = Query(...),
    count: int = Query(24, ge=1, le=400),
):
    """The newest `count` times of a product, oldest first, and where the region is."""
    try:
        return await asyncio.wrap_future(_SAT_LIST_POOL.submit(satellite.frames, sat, region, product, count))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/sat/image")
async def sat_image(
    request: Request,
    sat: str = Query(...),
    region: str = Query(...),
    product: str = Query(...),
    time: str = Query(..., description="YYYY-MM-DDTHH:MM:SSZ"),
    west: float = Query(..., ge=-540, le=540),
    south: float = Query(..., ge=-90, le=90),
    east: float = Query(..., ge=-540, le=540),
    north: float = Query(..., ge=-90, le=90),
    width: int = Query(1024, ge=32, le=3072),
    height: int = Query(768, ge=32, le=3072),
    detail: str = Query("full", pattern="^(full|coarse)$"),
):
    """One frame over a box of the map, as a Web Mercator WebP. 204 when the
    source lists the time but has no picture for it. `detail=coarse` asks for
    a quick picture first; X-Sat-Detail says which one came."""
    fut = _SAT_POOL.submit(satellite.image, sat, region, product, time, (west, south, east, north),
                           width, height, detail)
    try:
        # The layer drops the requests of a view or product left behind; one
        # still queued here is let go too, or eight of them held every worker
        # and the picture now wanted waited behind them.
        waiting = asyncio.wrap_future(fut)
        while True:
            done, _ = await asyncio.wait({waiting}, timeout=0.4)
            if done:
                data, media, got = waiting.result()
                break
            if await request.is_disconnected():
                fut.cancel()
                return Response(status_code=204)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except sat_net.Missing:
        return Response(status_code=204)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    # "identity": the GZip middleware skips a response that says how it is
    # encoded. A WebP does not shrink, and gzipping 1-2 MB of it on the event
    # loop held every other request for ~0.1 s a frame while a loop came in.
    return Response(content=data, media_type=media,
                    headers={"Cache-Control": "public, max-age=3600", "X-Sat-Detail": got,
                             "Content-Encoding": "identity"})


@app.post("/api/sat/prefetch")
def sat_prefetch(payload: dict = Body(...)):
    """Start making a loop: {sat, region, product, times, west, south, east, north, width, height}."""
    try:
        return satellite.prefetch(
            str(payload["sat"]), str(payload["region"]), str(payload["product"]),
            [str(t) for t in (payload.get("times") or [])],
            (float(payload["west"]), float(payload["south"]), float(payload["east"]), float(payload["north"])),
            int(payload["width"]), int(payload["height"]),
            coarse_first=bool(payload.get("coarse", True)),
        )
    except (KeyError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/sat/cancel")
def sat_cancel():
    """Stop making the loop being loaded."""
    return satellite.cancel()


@app.get("/api/outlooks/cpc-hazards")
def outlooks_cpc_hazards():
    """CPC's 8-14 day hazards, from its own shapefiles (see cpc_hazards)."""
    try:
        return cpc_hazards.hazards_8_14()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nadocast")
def nadocast(
    hazard: str = Query("tornado"),
    model: str = Query("auto"),
):
    try:
        return nadocast_core.build_nadocast(hazard, model)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/model-fields/models")
def model_field_models():
    """The sidebar's model picker: every model that can back a model field."""
    return {"models": model_fields.list_models(), "default": model_fields.DEFAULT_MODEL}


if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    
    import sys
    import uvicorn

    port = 8787
    args = sys.argv[1:]
    for i, arg in enumerate(args):
        if arg == "--port" and i + 1 < len(args):
            port = int(args[i + 1])

    print(f"Starting WeatherTS backend on port {port}...")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
