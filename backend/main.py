"""
FastAPI server for the SHARPpy sounding viewer.

Run (from backend/):
    .venv/Scripts/python.exe -m uvicorn main:app --port 8787 --reload
"""
from __future__ import annotations

import base64
import json
import struct

from fastapi import Body, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

import sounding_core
import sounding_upload
import vwp_panel
import vwp_sounding
import sounding_view
import model_fields
import nadocast_core
import raob_core
import surface_obs
import nexrad_core
import nexrad_level2
import nexrad_storms
import storm_attributes
import nexrad_vwp
import lsr_core
import fronts_core
import spc_md
import acars_core
import area_sounding

app = FastAPI(title="WeatherTS Sounding API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)
# Polar scans are ~5 MB of float32 that is >80% NaN -> compresses to a fraction.
# level 6, not the default 9: on a radar scan 9 costs ~600 ms of CPU to save
# ~5% over 6, which takes ~20 ms.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)


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
):
    """NWS Local Storm Reports over a trailing window."""
    try:
        box = None
        if bbox:
            parts = [float(x) for x in bbox.split(",")]
            if len(parts) != 4:
                raise ValueError("bbox must be lat0,lon0,lat1,lon1")
            box = (min(parts[0], parts[2]), min(parts[1], parts[3]),
                   max(parts[0], parts[2]), max(parts[1], parts[3]))
        return lsr_core.fetch_lsr(hours=hours, end_unix=end, bbox=box)
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
):
    """WPC surface analysis and progs, as timeline frames of GeoJSON.

    `history` past analyses plus the 12 h and 24 h forecast positions, so the
    fronts can be scrubbed on the same timeline as everything else.
    """
    try:
        return fronts_core.build_fronts(history=history, forecast=forecast)
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
        # Level II frames are whole volumes off the live chunk bucket, which
        # keeps a few hundred of them. Each is ~7 MB, so the loop is capped
        # tighter than the Level III one.
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


@app.get("/api/surface-obs")
def surface_obs_endpoint(bbox: str = Query(...)):
    try:
        return surface_obs.fetch_surface_obs(bbox)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/surface-obs/history")
def surface_obs_history(station: str = Query(..., min_length=2), hours: int = Query(24, ge=1, le=48)):
    try:
        return {"observations": surface_obs.fetch_surface_history(station, hours)}
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


@app.get("/api/model-fields/mslp")
def model_field_mslp(
    model: str = Query(model_fields.DEFAULT_MODEL),
    hour: int = Query(0, ge=0, le=384),
    interval: float = Query(4.0, gt=0, le=50),
    centres: bool = Query(True),
    smooth: float = Query(1.0, ge=0, le=4),
):
    """Isobars + H/L centres for one model run hour, as GeoJSON."""
    try:
        return model_fields.build_mslp(
            model=model, hour=hour, interval=interval, centres=centres, smooth=smooth
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


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
