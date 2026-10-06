"""The Solar Dynamics Observatory's newest pictures, and the frames for a loop.

sdo.gsfc.nasa.gov publishes every browse image in a dated directory
(/assets/img/browse/YYYY/MM/DD/20261005_221817_2048_0193.jpg), and a fixed
"latest_2048_0193.jpg" beside them. The fixed names stopped turning over on
2026-09-21 while the dated directories carried on, and the site sends no CORS
headers, so the browser cannot list a directory itself: the backend reads the
directory listings (about 1 MB a day) and hands on the file names.

HMI's pictures (magnetogram, intensitygram, dopplergram) stop on 2026-09-22 in
the directories too; a channel with nothing today or yesterday is simply not
offered.
"""
from __future__ import annotations

import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

BROWSE = "https://sdo.gsfc.nasa.gov/assets/img/browse"
_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "WeatherTS/1.0 (desktop weather app)"
_NAME = re.compile(r'href="((\d{8})_(\d{6})_(\d+)_([A-Za-z0-9]+)\.jpg)"')
_LOCK = threading.Lock()
# "YYYY/MM/DD" -> (read at, [(unix, size, channel, name)])
_DAYS: dict[str, tuple[float, list[tuple[float, int, str, str]]]] = {}
LOOKBACK_DAYS = 7


def _day(d: datetime) -> list[tuple[float, int, str, str]]:
    """One day's directory, cached: five minutes for today, a day for the past."""
    key = d.strftime("%Y/%m/%d")
    today = d.date() == datetime.now(timezone.utc).date()
    ttl = 300 if today else 86400
    now = time.time()
    with _LOCK:
        hit = _DAYS.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    rows: list[tuple[float, int, str, str]] = []
    r = None
    for attempt in range(2):
        try:
            r = _SESSION.get(f"{BROWSE}/{key}/", timeout=(10, 40))
            break
        except requests.RequestException:
            if attempt:
                raise
    assert r is not None
    if r.status_code != 404:
        r.raise_for_status()
        seen = set()
        for m in _NAME.finditer(r.text):
            name = m.group(1)
            if name in seen:
                continue
            seen.add(name)
            ts = datetime.strptime(m.group(2) + m.group(3), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).timestamp()
            rows.append((ts, int(m.group(4)), m.group(5), name))
        rows.sort()
    with _LOCK:
        _DAYS[key] = (now, rows)
        # Keep the cache to the days a loop or the lookback can ask for.
        for k in sorted(_DAYS)[:-(LOOKBACK_DAYS + 2)]:
            _DAYS.pop(k, None)
    return rows


def _url(ts: float, name: str) -> str:
    return f"{BROWSE}/{datetime.fromtimestamp(ts, timezone.utc).strftime('%Y/%m/%d')}/{name}"


def latest(size: int) -> dict[str, Any]:
    """The newest picture of every channel at this size, today or yesterday
    (yesterday covers the first minutes of a UTC day, before today has any)."""
    out: dict[str, dict[str, Any]] = {}
    now = datetime.now(timezone.utc)
    for back in range(2):
        for ts, sz, ch, name in reversed(_day(now - timedelta(days=back))):
            if sz == size and ch not in out:
                out[ch] = {"url": _url(ts, name), "t": int(ts * 1000)}
    return {"size": size, "channels": out}


def frames(channel: str, size: int, hours: float) -> dict[str, Any]:
    """Every picture of one channel over the last `hours`, oldest first."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=hours)
    days = []
    d = start
    while d.date() <= now.date():
        days.append(d)
        d += timedelta(days=1)
    out = []
    for day in days:
        for ts, sz, ch, name in _day(day):
            if ch == channel and sz == size and ts >= start.timestamp():
                out.append({"url": _url(ts, name), "t": int(ts * 1000)})
    return {"channel": channel, "size": size, "frames": out}
