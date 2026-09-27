"""
FastAPI server for the SHARPpy sounding viewer.

Run (from backend/):
    .venv/Scripts/python.exe -m uvicorn main:app --port 8787 --reload
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import struct
import sys
import threading
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
import nexrad_core
import observations
import nexrad_level2
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
import sat_net

# Certificates loaded once, and new connections opened a dozen at a time, for
# every module's sessions -- those made above too (see fast_tls).
fast_tls.install()

app = FastAPI(title="WeatherTS Sounding API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
    expose_headers=["X-Sat-Detail"],
)
# Polar scans are ~5 MB of float32 that is >80% NaN -> compresses to a fraction.
# level 6, not the default 9: on a radar scan 9 costs ~600 ms of CPU to save
# ~5% over 6, which takes ~20 ms.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)


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
    site: str = Query(..., min_length=3, max_length=4),
    unix: int | None = Query(None, ge=0),
):
    """SCIT storm cells (past + forecast tracks) and mesocyclone detections.

    `unix` picks the storm scan nearest that instant so the tracks follow a
    scrubbed radar loop instead of always showing the latest volume.
    """
    try:
        return nexrad_storms.build_storms(site, unix)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nexrad/storms/history")
def nexrad_storm_history(
    site: str = Query(..., min_length=3, max_length=4),
    cell: str = Query(..., min_length=1, max_length=4),
    volumes: int = Query(storm_attributes.DEFAULT_HISTORY_VOLUMES, ge=2, le=40),
):
    """How one tracked cell's hail and structure changed over recent volumes.

    Oldest sample first. Empty is a normal answer -- the live feed only reaches
    back about a day, and a cell only appears in the scans it was tracked in.
    """
    try:
        return {"site": site.upper(), "cell": cell.upper(),
                "samples": storm_attributes.fetch_history(site, cell, volumes)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nexrad/vwp")
def nexrad_vwp_profile(
    site: str = Query(..., min_length=3, max_length=4),
    columns: int = Query(12, ge=1, le=nexrad_vwp.MAX_COLUMNS),
):
    """VAD Wind Profile: the radar's own wind profile, one column per volume."""
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
        return {"sites": nexrad_core.list_sites()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nexrad/availability")
def nexrad_availability_route(site: str = Query(...), quick: bool = Query(False), at: int = Query(0, ge=0)):
    """Every product and tilt this radar is publishing now, at its real angle.
    `quick` answers from Level III alone first (see nexrad_availability); `at`
    asks what it had at that moment, for archive playback."""
    try:
        return nexrad_availability.site_availability(site, quick, at or None)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/nexrad/cuts")
def nexrad_cuts(site: str = Query(...), at: int = Query(0, ge=0)):
    """The elevations this radar is flying: every cut, and the one below 0.5 deg if it has one."""
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
        "grids": nexrad_level2.merged_catalog(nexrad_core.product_catalog()),
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
):
    """Binary polar scan.

    Layout: [4-byte header len][JSON header][az f32 * (nAz+1)][lut f32 * 256]
            [codes u8 * nAz*nGates]
    Gates stay in their native 8-bit codes; the client maps them through the lut.
    See nexrad_core.polar_data for why.
    """
    try:
        # "L2..." products come from a live Level II volume (super-res); the rest
        # from Level III. Same wire format either way.
        if product.upper().startswith("L2"):
            out = nexrad_level2.polar_data_l2(site, product.upper(), key or "")
        else:
            out = nexrad_core.polar_data(site, product, key or None)
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
        # a published scan never changes -- let the browser keep it
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/nexrad/scans")
def nexrad_scans(
    site: str = Query(...),
    product: str = Query(nexrad_core.DEFAULT_PRODUCT),
    date: str = Query(""),
    limit: int = Query(0, ge=0, le=500),
    start: int = Query(0, ge=0),
):
    try:
        # Level II frames are whole volumes: live off the chunk bucket, which
        # keeps about two days, and archive playback out of the archive. Each
        # is 7-16 MB, so the loop is capped tighter than the Level III one.
        if product.upper().startswith("L2"):
            vols = nexrad_level2.list_volumes(site, min(limit or 30, nexrad_level2.MAX_LOOP),
                                              start=start or None)
            return {"scans": [{"key": v["key"], "time": v["time"]} for v in vols],
                    "archiveStart": nexrad_core.ARCHIVE_START}
        return {
            "scans": nexrad_core.list_scans(site, product, date or None, limit,
                                            start=start or None),
            "archiveStart": nexrad_core.ARCHIVE_START,
        }
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
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


# ---------------------------------------------------------------------------
# Observations — the hourly analyses, as timeline frames
# ---------------------------------------------------------------------------

nexrad_core.warm_site_status()


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
):
    """The timeline's frames, oldest first: the last `hours` of them, or every
    hour the source keeps -- or, for a forecast model, one run's hours."""
    try:
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
):
    try:
        return surface_obs.fetch_surface_obs(bbox, cell=cell, networks=networks)
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
