"""
The HTTP API the app reads (the relay contract):

    GET /health                              {"ok": true, "radars": n}
    GET /v1/radars                           every radar, its newest volume, count and
                                             "updated" (the newest "added")
    GET /v1/radars/{id}/volumes?since=<unix>&addedSince=<unix>
                                             the volumes kept, oldest first; with since,
                                             only those that started after it; with
                                             addedSince, only those with a file the relay
                                             added after it (every file listed); 404 JSON
                                             for a radar the relay does not list
    GET /v1/files/{id}/{stamp}/{name}        the file, byte for byte as the source sent
                                             it (application/octet-stream, cacheable for
                                             the 36 h it can exist); 404 once pruned

The JSON is views.py's (contract v1.1: "added" on files and volumes).

A file is served only when its radar is configured, its stamp is 14 digits
of a real time, its name is plain ([A-Za-z0-9._-], no "..") and the index
holds it, so no path can leave the store. With api.public_base_url set (a
public bucket, or a CDN in front of one), /v1/files answers 302 to
<public_base_url>/<key> and the bytes never pass through this process.

Following another process's index (--api-only), a /v1/files miss re-reads
index.json at once only when the stamp asked for is newer than the newest
volume indexed for that radar (a file the poller may just have written), and
at most once a second (index.FORCE_INTERVAL); any other miss waits for the
ordinary refresh, so requests for files that do not exist cost no store reads.

CORS is open to GET from any origin (api.cors_origins narrows it): the app
runs in Electron and on weatherts.tech, and the data is public.
"""
from __future__ import annotations

import logging
import time
from typing import Callable, Optional

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse

from . import __version__, views
from .config import FORBIDDEN_HOSTS, RADAR_ID_RE, Config, forbidden_any
from .index import FORCE_INTERVAL, Index
from .stamps import STAMP_RE, stamp_unix, valid_name
from .storage import IMMUTABLE, OCTET, Storage, file_key

log = logging.getLogger("relay.api")

LIST_CACHE = "public, max-age=10"


def create_app(cfg: Config, storage: Storage, index: Index, follow_index: bool = False,
               now: Optional[Callable[[], float]] = None) -> FastAPI:
    """The app. follow_index: re-read index.json written by a poller in
    another process (--api-only); now: the clock (tests inject one)."""
    clock = now or time.time
    app = FastAPI(title="WeatherTS radar relay", version=__version__, docs_url=None, redoc_url=None,
                  openapi_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=cfg.api.cors_origins or ["*"],
                       allow_methods=["GET", "HEAD", "OPTIONS"], allow_headers=["*"],
                       expose_headers=["Content-Length", "Cache-Control"], max_age=86400)
    listed = {r.id for r in cfg.radars}
    public = cfg.api.public_base_url.rstrip("/")
    if public and forbidden_any(public):       # config.py refuses it too; this is for a changed cfg
        raise ValueError(f"api.public_base_url: the relay never sends anyone to {FORBIDDEN_HOSTS[0]}")

    def fresh(force: bool = False) -> None:
        if follow_index:
            index.refresh(force=force, force_interval=FORCE_INTERVAL)

    def not_found(msg: str) -> JSONResponse:
        return JSONResponse({"error": msg}, status_code=404)

    @app.get("/health")
    def health() -> JSONResponse:
        fresh()
        return JSONResponse(views.health(cfg, index), headers={"Cache-Control": "no-cache"})

    @app.get("/v1/radars")
    def radars() -> JSONResponse:
        fresh()
        return JSONResponse(views.radars(cfg, index, clock()), headers={"Cache-Control": LIST_CACHE})

    @app.get("/v1/radars/{rid}/volumes")
    def volumes(rid: str, since: Optional[int] = None,
                added_since: Optional[int] = Query(None, alias="addedSince")) -> JSONResponse:
        if rid not in listed:
            return not_found(f"unknown radar: {rid}")
        fresh()
        return JSONResponse(views.volumes(cfg, index, rid, clock(), since=since, added_since=added_since),
                            headers={"Cache-Control": LIST_CACHE})

    @app.api_route("/v1/files/{rid}/{stamp}/{name}", methods=["GET", "HEAD"])
    def files(rid: str, stamp: str, name: str, request: Request) -> Response:
        if not (RADAR_ID_RE.match(rid) and rid in listed and STAMP_RE.match(stamp)
                and stamp_unix(stamp) is not None and valid_name(name)):
            return not_found("no such file")
        if not index.has(rid, stamp, name):
            if follow_index:
                newest = index.newest(rid)
                fresh(force=newest is None or stamp_unix(stamp) > newest)
            if not index.has(rid, stamp, name):
                return not_found("no such file (never stored, or pruned)")
        key = file_key(rid, stamp, name)
        headers = {"Cache-Control": IMMUTABLE}
        if public:
            return RedirectResponse(f"{public}/{storage.object_key(key)}", status_code=302, headers=headers)
        path = storage.local_path(key)
        if path is not None:
            return FileResponse(path, media_type=OCTET, headers=headers)
        if request.method == "HEAD":
            size = storage.size(key)
            if size is None:
                return not_found("no such file (pruned)")
            headers["Content-Length"] = str(size)
            return Response(status_code=200, media_type=OCTET, headers=headers)
        got = storage.open_stream(key)
        if got is None:
            return not_found("no such file (pruned)")
        chunks, size = got
        headers["Content-Length"] = str(size)
        return StreamingResponse(chunks, media_type=OCTET, headers=headers)

    return app
