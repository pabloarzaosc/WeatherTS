"""
The API's answers, built in one place so the live API (api.py) and the static
copy written to a public bucket (poller.publish_static) are the same bytes.

    /health                       {"ok": true, "radars": <int>}
    /v1/radars                    {"retentionHours": 36, "radars": [{"id", "name",
                                   "lat", "lon", "newest": <unix|null>, "volumes": <int>,
                                   "updated": <unix|null>}]}
    /v1/radars/{id}/volumes       {"radar": id, "volumes": [{"stamp", "unix", "added",
                                   "files": [{"name", "size", "added", "url"}]}]}, oldest first

Contract v1.1 (additive, v1 unchanged): "added" is the relay's clock when a
file was committed (index.py), a volume's "added" the newest of its files',
a radar's "updated" the newest "added" over its volumes. ?addedSince=<unix>
keeps the volumes with at least one file added after it, each with all its
files; it combines with ?since=.

"radars" counts the radars the relay lists (every configured one, polled or
not). A volume past the retention is hidden even before the poller deletes it.
"""
from __future__ import annotations

from typing import Any, Optional

from .config import Config
from .index import Index


def _hours(h: float) -> float | int:
    return int(h) if float(h).is_integer() else float(h)


def file_url(radar: str, stamp: str, name: str) -> str:
    return f"/v1/files/{radar}/{stamp}/{name}"


def health(cfg: Config, index: Index) -> dict[str, Any]:
    return {"ok": True, "radars": len(cfg.radars)}


def radars(cfg: Config, index: Index, now: float) -> dict[str, Any]:
    floor = now - cfg.retention_seconds
    out = []
    for r in cfg.radars:
        vols = index.volumes(r.id, not_before=floor)
        out.append({"id": r.id, "name": r.name, "lat": r.lat, "lon": r.lon,
                    "newest": vols[-1][1] if vols else None, "volumes": len(vols),
                    "updated": max(v[2] for v in vols) if vols else None})
    return {"retentionHours": _hours(cfg.retention_hours), "radars": out}


def volumes(cfg: Config, index: Index, radar: str, now: float, since: Optional[float] = None,
            added_since: Optional[float] = None) -> dict[str, Any]:
    floor = now - cfg.retention_seconds
    return {"radar": radar, "volumes": [
        {"stamp": stamp, "unix": unix, "added": added,
         "files": [{"name": n, "size": size, "added": a, "url": file_url(radar, stamp, n)}
                   for n, size, a in files]}
        for stamp, unix, added, files in index.volumes(radar, since=since, not_before=floor,
                                                         added_since=added_since)]}
