"""
The Brazilian radars live: volumes pulled from the WeatherTS radar relay into
the store brazil_radar reads, so the radar viewer shows them with its normal
timeline, history and products.

CEMADEN keeps every volume of its nine S-band radars behind a CAPTCHA, which
says no program fetches them on its own. The relay is a separate server: the
one place that downloads each file once, from the access CEMADEN grants it,
keeps 36 hours and serves them. The users' apps talk to the relay only, never
to CEMADEN -- this client refuses a relay on mapainterativo.cemaden.gov.br and
any redirect there. Until a relay is configured it only prunes (below).

    WEATHERTS_RADAR_RELAY         the relay's base URL (http or https); unset = off
    WEATHERTS_RADAR_RELAY_POLL    seconds between passes (default 120)
    WEATHERTS_RADAR_RELAY_HOURS   hours kept here (default 36, up to 9600 so a relay
                                  serving archive cases -- the NASA demo keeps
                                  8760 h -- can feed the app; the relay's own
                                  retentionHours wins when it is shorter)
    WEATHERTS_RADAR_RELAY_RADARS  optional comma list of radar ids always followed

The relay's API, contract v1.1 (its server implements the same; v1 lacks the
"added"/"updated"/"addedSince" parts and is still followed):

    GET /v1/radars                      {"retentionHours", "radars": [{"id", "name", "lat", "lon",
                                         "newest", "volumes", "updated"}]}
    GET /v1/radars/{id}/volumes?since=&addedSince=
                                        {"radar", "volumes": [{"stamp", "unix", "added", "files":
                                         [{"name", "size", "url", "added"}]}]}, oldest first; since:
                                         only unix > since; addedSince: only volumes with a file
                                         added after it, each with ALL its files
    GET /v1/files/{id}/{stamp}/{name}   the file's bytes exactly as the source wrote them; 404 once
                                         pruned; may 302 to the relay's public bucket

A volume is its scan start in UTC, "YYYYMMDDHHMMSS" (the stamp), and every
moment file of it shares the stamp. Radar ids are the app's (BR-MCZ ...).
"added" is the relay's own clock when it committed a file, "updated" a radar's
newest "added": the arrival cursor, free of any skew between the two clocks.

On demand, not a mirror. Every pass lists the relay's radars (published to the
radar picker through brazil_radar.EXTRA_SITES, live even with nothing here),
but downloads only the radars being watched: the backend touch()es a radar
whenever the app asks for its scans or availability, and a radar touched in
the last hour is followed, as is each one in WEATHERTS_RADAR_RELAY_RADARS. A
first touch wakes the client thread at once and waits up to a second for the
newest volume, so the first answer can already show it.

A pass:
  1. Lists the radars, then each followed radar's volumes inside the window.
     The first pass after start, and the first after a radar is touched, lists
     the whole window; after that, only what arrived since the radar's cursor
     (addedSince = the newest "added" done, less one second: a file committed
     later in that same second carries the same "added"). A backlog the relay
     fetched late, older stamps and all, comes in this way. A v1 relay (no
     "updated") is listed over the whole window every pass.
  2. Downloads every file not here yet -- newest volume first, a radar just
     touched ahead of the rest, the radars in turn, so each radar's present
     shows up before any history -- at most 200 files and 1 GB a pass; with
     more waiting, the next pass follows at once (and a radar touched meanwhile
     cuts the pass short to go first). Each download is checked against the
     listed size; redirects are followed by hand, each hop checked.
  3. Hands each file to brazil_radar.import_file, which reads it, learns the
     radar and the time from it and files it beside the other moments of its
     volume; the volume folder's info.json then gets "source": "relay" and the
     relay's radar and stamp. A folder the user already had (an import of
     their own) is filled in but never marked.
  4. Prunes: relayed volumes older than the retention -- by the relay's stamp
     -- are deleted with their cached grids. A folder without the mark (the
     archive cases, the user's own imports) is never touched. The backend runs
     one such prune at startup whether a relay is configured or not
     (prune_store), so a relay switched off leaves nothing behind for good.

One radar's failure leaves the others going; a file that fails waits 1, 2, 4
... minutes before it is tried again (given up after six tries, or at once on
a 404), a radar that fails waits likewise, and a relay that cannot be reached
is asked again after one poll interval, then two, four ... up to 30 minutes.
"""
from __future__ import annotations

import copy
import json
import os
import re
import sys
import threading
import time
import zlib
from bisect import bisect_left, insort
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote, urljoin, urlsplit

import requests

import brazil_radar

_ID_RE = re.compile(r"BR-[A-Z0-9]{2,8}")
_STAMP_RE = re.compile(r"\d{14}")
# Rainbow ("2026101207400500dBZ.vol"), its HDF5 export (".vol.h5") and NASA's
# CfRadial ("MC1_2026_0224_133002.cf.gz"): never a path, never hidden.
_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}")
# CEMADEN's public Interactive Map: its downloads are behind a CAPTCHA, so no
# request of this client goes there, whatever a relay or a redirect says.
_FORBIDDEN_HOSTS = ("mapainterativo.cemaden.gov.br",)

_FOLLOW_S = 3600.0              # a touched radar is followed this long
_TOUCH_WAIT_S = 1.0             # a first touch waits this long for the newest volume
_MAX_FILES = 200                # files a pass
_MAX_BYTES = 1 << 30            # bytes a pass
_MAX_FILE = 400 * 1024 * 1024   # import_file's own ceiling
_MAX_HOPS = 5                   # redirects followed
_GROUP_S = 90                   # import_file's: moments within 90 s are one volume
_FILE_TRIES = 6
_FILE_RETRY_S = 60.0
_BACKOFF_MAX_S = 1800.0
_BUSY_PAUSE_S = 5.0             # between passes while a backlog is still coming in
_STALE_S = 1800.0               # a radar list older than this no longer says "live"
_HOURS_MAX = 9600.0


def _log(msg: str) -> None:
    print(f"[radar-relay] {msg}", file=sys.stderr, flush=True)


def _brief(exc: BaseException) -> str:
    """An error in a few words: requests' own messages run to three lines."""
    if isinstance(exc, requests.Timeout):
        return "timed out"
    if isinstance(exc, requests.ConnectionError):
        return "cannot connect"
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        return f"HTTP {exc.response.status_code}"
    return (str(exc) or type(exc).__name__)[:200]


def _stamp_unix(stamp: str) -> Optional[int]:
    try:
        return int(datetime.strptime(stamp, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).timestamp())
    except (TypeError, ValueError):
        return None


def _int(x: Any) -> Optional[int]:
    """A JSON number as an int; None for anything else (a bool included)."""
    return int(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def _num(x: Any) -> Optional[float]:
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def _safe(name: str) -> str:
    """The name import_file keeps a file under."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", Path(name).name)


def _host(url: str) -> str:
    try:
        return (urlsplit(str(url)).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


def _forbidden(url: str) -> bool:
    """True for a URL on a host this client must never request."""
    h = _host(url)
    return any(h == f or h.endswith("." + f) for f in _FORBIDDEN_HOSTS)


def _allowed(url: str) -> bool:
    """An http(s) URL with a host, and not a forbidden one."""
    try:
        scheme = urlsplit(str(url)).scheme.lower()
    except ValueError:
        return False
    return scheme in ("http", "https") and bool(_host(url)) and not _forbidden(url)


def _env_float(name: str, default: float, lo: float, hi: float) -> float:
    try:
        v = float(os.environ.get(name, "") or default)
    except ValueError:
        v = default
    return min(max(v, lo), hi)


def config() -> dict:
    """The relay settings as the environment has them now."""
    radars = {r.strip().upper() for r in (os.environ.get("WEATHERTS_RADAR_RELAY_RADARS") or "").split(",")}
    return {
        "relay": (os.environ.get("WEATHERTS_RADAR_RELAY") or "").strip().rstrip("/"),
        "pollSeconds": _env_float("WEATHERTS_RADAR_RELAY_POLL", 120.0, 15.0, 3600.0),
        "retentionHours": _env_float("WEATHERTS_RADAR_RELAY_HOURS", 36.0, 1.0, _HOURS_MAX),
        "radars": sorted(r for r in radars if _ID_RE.fullmatch(r)),
    }


def enabled() -> bool:
    base = config()["relay"]
    return bool(re.match(r"https?://[^/\s]+", base)) and _allowed(base)


def _read_info(vdir: Path) -> Optional[dict]:
    try:
        info = json.loads((vdir / "info.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return info if isinstance(info, dict) else None


def _write_info(vdir: Path, info: dict) -> None:
    """info.json replaced whole, so brazil_radar.volumes() never reads half of
    it (the ".part" is skipped by its loader). Windows refuses the replace
    while a reader holds the file open: a few tries, then a plain write."""
    path, tmp = vdir / "info.json", vdir / "info.json.part"
    tmp.write_text(json.dumps(info), encoding="utf-8")
    for _ in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.05)
    path.write_text(json.dumps(info), encoding="utf-8")
    tmp.unlink(missing_ok=True)


def _drop_cached(radar: str, stamp: str) -> None:
    """A pruned volume out of the viewer's memory too."""
    with brazil_radar._LOCK:  # noqa: SLF001 - the store's own lock over its caches
        brazil_radar._VOLUMES.pop((radar, stamp), None)  # noqa: SLF001
        for k in [k for k in brazil_radar._GRIDS if k[0] == radar and k[1] == stamp]:  # noqa: SLF001
            brazil_radar._GRIDS.pop(k, None)  # noqa: SLF001


def _delete_volume(vdir: Path) -> Optional[bool]:
    """A relayed volume's folder removed: True when gone, False when it is not
    a relayed volume (left alone), None when something held it (tried again
    next pass). The data files go before info.json, so a folder half deleted
    still carries its mark."""
    if vdir.is_symlink():
        return False
    info = _read_info(vdir)
    if info is None or info.get("source") != "relay":
        return False
    try:
        entries = list(vdir.iterdir())
        if any(p.is_dir() for p in entries):
            return False    # not a volume folder as import_file makes them
        for p in entries:
            if p.name != "info.json":
                p.unlink()
        (vdir / "info.json").unlink()
        vdir.rmdir()
    except OSError:
        return None
    return True


def _relayed_on_disk() -> dict[tuple[str, str], dict]:
    """Every relayed volume in the store, by its relay radar and stamp (the
    folder's own when the mark lacks them): {"dir", "relay": True, "unix"}."""
    index: dict[tuple[str, str], dict] = {}
    store = brazil_radar.STORE
    try:
        rdirs = [d for d in store.iterdir() if d.is_dir() and d.name.startswith("BR-")] if store.is_dir() else []
    except OSError:
        rdirs = []
    for rdir in rdirs:
        try:
            vdirs = [d for d in rdir.iterdir() if _STAMP_RE.fullmatch(d.name) and d.is_dir()]
        except OSError:
            continue
        for vdir in vdirs:
            info = _read_info(vdir)
            if not info or info.get("source") != "relay":
                continue
            rel = info.get("relay") if isinstance(info.get("relay"), dict) else {}
            rid, rstamp = str(rel.get("radar", "")), str(rel.get("stamp", ""))
            if not (_ID_RE.fullmatch(rid) and _STAMP_RE.fullmatch(rstamp) and _stamp_unix(rstamp)):
                rid, rstamp = rdir.name, vdir.name
            unix = _stamp_unix(rstamp)
            if unix is not None:
                index[(rid, rstamp)] = {"dir": vdir, "relay": True, "unix": unix}
    return index


def prune_store(hours: Optional[float] = None) -> int:
    """One prune of the store with no relay needed: every folder marked
    "source": "relay" older than `hours` (default: the configured retention,
    36 h) deleted with its cached grids; how many went. Unmarked folders --
    the archive cases, the user's own imports -- are never touched."""
    if hours is None:
        hours = config()["retentionHours"]
    cutoff = time.time() - float(hours) * 3600.0
    gone = 0
    for e in _relayed_on_disk().values():
        if e["unix"] < cutoff and _delete_volume(e["dir"]):
            gone += 1
            _drop_cached(e["dir"].parent.name, e["dir"].name)
    return gone


class _Gone(Exception):
    """The relay no longer has the file."""


class _Refused(ValueError):
    """A URL this client will not request."""


class Client:
    """One relay, synced into brazil_radar's store. The module runs one in a
    daemon thread (start()); a test drives one with sync_once(). `radars`
    are followed always, the rest once touch()ed."""

    def __init__(self, base: str, poll_s: float = 120.0, hours: float = 36.0, radars: Any = (),
                 session: Optional[requests.Session] = None):
        self.base = base.strip().rstrip("/")
        if not _allowed(self.base):
            raise ValueError(f"not a relay this client may follow: {self.base!r}")
        self.poll_s = float(poll_s)
        self.hours = float(hours)
        self.always = {str(r).upper() for r in radars or ()}
        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = "WeatherTS radar relay client"
        self._remote_hours: Optional[float] = None
        # The relay's radars as last listed, and when (local clock).
        self._catalog: Optional[list[dict]] = None
        self._catalog_at = 0.0
        self._arrival: Optional[bool] = None    # the relay speaks v1.1 ("added"); None: not known yet
        # (relay radar, relay stamp) -> {"dir": the local folder, "relay": marked, "unix": the relay stamp's}
        self._index: dict[tuple[str, str], dict] = {}
        self._scanned = False
        # radar -> every file with "added" <= this is done (the relay's clock)
        self._cursor: dict[str, int] = {}
        self._synced: set[str] = set()                          # whole window listed since followed
        self._touched: dict[str, float] = {}                    # radar -> last touch (local clock)
        self._urgent: set[str] = set()                          # touched first, not yet in a pass
        self._first: dict[str, threading.Event] = {}            # set once that radar's newest is in
        self._failed: dict[tuple[str, str, str], list] = {}     # (radar, stamp, name) -> [tries, retry_at, unix]
        self._radar_fail: dict[str, list] = {}                  # radar -> [fails, retry_at]
        # What one pass learns of the store, read once.
        self._dirs: dict[str, list[tuple[int, str]]] = {}
        self._infos: dict[Path, Optional[dict]] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._last_logged = ""
        self._status: dict[str, Any] = {
            "enabled": True, "relay": self.base, "lastSync": None, "lastAttempt": None, "lastError": None,
            "pollSeconds": self.poll_s, "files": 0, "bytes": 0, "pruned": 0, "lastPass": None, "radars": {},
        }

    # --- settings ------------------------------------------------------------
    @property
    def retention_s(self) -> float:
        hours = self.hours
        if self._remote_hours and self._remote_hours < hours:
            hours = self._remote_hours
        return hours * 3600.0

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # --- the thread ----------------------------------------------------------
    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="radar-relay", daemon=True)
        self._thread.start()

    def stop(self, timeout: Optional[float] = None) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout)

    def _run(self) -> None:
        _log(f"following {self.base} every {self.poll_s:g} s, keeping {self.hours:g} h"
             + (f", always {', '.join(sorted(self.always))}" if self.always else ""))
        fails = 0
        while not self._stop.is_set():
            self._wake.clear()      # a touch from here on wakes the wait below at once
            try:
                s = self.sync_once()
                fails = 0
                self._last_logged = ""
                if s["files"] or s["pruned"]:
                    _log(f"{s['files']} files in ({s['bytes'] / 1e6:.1f} MB), {s['pruned']} volumes pruned"
                         + (", more to come" if s["more"] else ""))
                delay = _BUSY_PAUSE_S if s["more"] else self.poll_s
            except Exception as exc:  # noqa: BLE001 - the relay is asked again later
                fails += 1
                delay = min(self.poll_s * 2 ** min(fails - 1, 8), max(_BACKOFF_MAX_S, self.poll_s))
                if _brief(exc) != self._last_logged:    # the same failure once, not every pass
                    _log(f"relay unreachable ({_brief(exc)}); next try in {delay:g} s")
                    self._last_logged = _brief(exc)
            self._wake.wait(delay)

    # --- on demand -----------------------------------------------------------
    def touch(self, radar: str, wait: float = _TOUCH_WAIT_S) -> None:
        """The app is looking at this radar: follow it for the next hour. A
        first touch (or the first after an hour without one) wakes the thread
        and waits up to `wait` seconds for the newest volume; a radar the
        relay does not list is only noted. Never touches the network."""
        rid = str(radar or "").strip().upper()
        if not _ID_RE.fullmatch(rid):
            return
        now = time.time()
        with self._lock:
            last = self._touched.get(rid)
            self._touched[rid] = now
            fresh = rid not in self.always and (last is None or now - last >= _FOLLOW_S)
            ids = None if self._catalog is None else {e["id"] for e in self._catalog}
            ev = None
            if fresh and (ids is None or rid in ids):
                ev = self._first[rid] = threading.Event()
                self._urgent.add(rid)
            elif rid in self._first:
                ev = self._first[rid]   # its first fetch is still under way: wait for it too
        if ev is None:
            return
        if fresh:
            self._wake.set()
        if wait > 0 and self.running:
            ev.wait(wait)

    def followed(self, now: Optional[float] = None) -> set[str]:
        """The radars synced now: the configured ones, and each touched in the last hour."""
        now = time.time() if now is None else now
        with self._lock:
            return self.always | {r for r, t in self._touched.items() if now - t < _FOLLOW_S}

    def sites(self) -> list[dict]:
        """The relay's radars for the radar picker (brazil_radar.EXTRA_SITES):
        {"id", "name", "lat", "lon", "newest", "live", "operator"}; live while
        the relay has a volume in its window -- an archive relay's too, or its
        radars could never be picked, so never touched -- and the list is
        recent (half an hour, or three polls)."""
        with self._lock:
            cat = list(self._catalog or [])
            fresh = time.time() - self._catalog_at < max(_STALE_S, 3 * self.poll_s)
        out = []
        for e in cat:
            r = brazil_radar.RADARS.get(e["id"], {})
            lat = e["lat"] if e["lat"] is not None else _num(r.get("lat"))
            lon = e["lon"] if e["lon"] is not None else _num(r.get("lon"))
            if lat is None or lon is None:
                continue    # nowhere to put it on the map
            out.append({"id": e["id"], "name": e["name"] or r.get("name") or e["id"], "lat": lat, "lon": lon,
                        "newest": e["newest"], "live": fresh and e["newest"] is not None,
                        "operator": e["operator"] or r.get("op") or ""})
        return out

    # --- one pass ------------------------------------------------------------
    def sync_once(self) -> dict:
        """One pass: list, download, import, mark, prune. Raises when the relay
        cannot be listed at all (after pruning: old volumes go regardless)."""
        now = time.time()
        self._dirs, self._infos = {}, {}
        summary = {"files": 0, "bytes": 0, "volumes": 0, "pruned": 0, "more": False, "errors": 0}
        if not self._scanned:
            # What is here, read once: and the startup prune, before any download.
            self._index = _relayed_on_disk()
            self._scanned = True
            summary["pruned"] += self.prune()
        with self._lock:
            self._status["lastAttempt"] = int(now)
            urgent, self._urgent = self._urgent, set()
            events = {r: self._first[r] for r in urgent if r in self._first}
        try:
            self._pass(now, summary, urgent, events)
            with self._lock:
                self._status["lastSync"] = int(time.time())
                self._status["lastError"] = None
        except Exception as exc:
            with self._lock:
                self._status["lastError"] = f"relay: {_brief(exc)}"
            raise
        finally:
            with self._lock:
                for rid, ev in events.items():
                    ev.set()
                    if self._first.get(rid) is ev:
                        del self._first[rid]
            summary["pruned"] += self.prune()
            self._refresh_status(summary)
        return summary

    def _get(self, path_or_url: str, params: Optional[dict] = None, stream: bool = False,
             headers: Optional[dict] = None, timeout: tuple = (10, 30)) -> requests.Response:
        """GET with redirects followed by hand, each hop checked before it is
        requested: a relay with a public bucket answers 302 to it, and nothing
        may send this client to CEMADEN's Interactive Map."""
        url = path_or_url if "://" in path_or_url else self.base + path_or_url
        for _ in range(_MAX_HOPS + 1):
            if not _allowed(url):
                raise _Refused(f"refusing to request {_host(url) or url}")
            r = self.session.get(url, params=params, headers=headers, stream=stream, timeout=timeout,
                                 allow_redirects=False)
            if not r.is_redirect:
                return r
            nxt = urljoin(r.url, r.headers.get("Location", ""))
            r.close()
            url, params = nxt, None
        raise ValueError(f"more than {_MAX_HOPS} redirects")

    def _get_json(self, path: str, params: Optional[dict] = None) -> dict:
        r = self._get(path, params)
        try:
            r.raise_for_status()
            data = r.json()
        finally:
            r.close()
        if not isinstance(data, dict):
            raise ValueError(f"{path}: not a JSON object")
        return data

    def _radar_status(self, rid: str) -> dict:
        with self._lock:
            return self._status["radars"].setdefault(
                rid, {"newest": None, "volumes": 0, "remoteNewest": None, "cursor": None, "lastError": None})

    def _radar_error(self, rid: str, msg: str) -> None:
        st = self._radar_status(rid)
        with self._lock:
            st["lastError"] = msg[:300]

    def _catalog_of(self, listing: dict) -> list[dict]:
        """The listing's radars, checked: a valid id, numbers where numbers go."""
        out, seen = [], set()
        for e in listing.get("radars") if isinstance(listing.get("radars"), list) else []:
            rid = str(e.get("id", "")).upper() if isinstance(e, dict) else ""
            if not _ID_RE.fullmatch(rid) or rid in seen:
                continue
            seen.add(rid)
            out.append({"id": rid, "name": str(e.get("name") or "")[:120], "lat": _num(e.get("lat")),
                        "lon": _num(e.get("lon")), "newest": _int(e.get("newest")), "hasNewest": "newest" in e,
                        "updated": _int(e.get("updated")), "operator": str(e.get("operator") or "")[:120]})
        return out

    def _pass(self, now: float, summary: dict, urgent: set[str], events: dict[str, threading.Event]) -> None:
        listing = self._get_json("/v1/radars")
        try:
            rh = float(listing.get("retentionHours"))
            self._remote_hours = rh if rh > 0 else None
        except (TypeError, ValueError):
            pass
        cat = self._catalog_of(listing)
        raw = [e for e in listing.get("radars") or [] if isinstance(e, dict)]
        if raw:
            self._arrival = any("updated" in e for e in raw)
        with self._lock:
            self._catalog, self._catalog_at = cat, time.time()
            # A touch older than the follow window is forgotten: its next one is a first again.
            for r in [r for r, t in self._touched.items() if now - t >= _FOLLOW_S]:
                del self._touched[r]
        follow = self.followed(now)
        # A radar no longer followed, or touched afresh, starts over from the whole window.
        for rid in [r for r in self._synced if r not in follow or r in urgent]:
            self._synced.discard(rid)
            self._cursor.pop(rid, None)
        keep_from = int(now - self.retention_s)
        arrival = bool(self._arrival)
        plans: dict[str, list[dict]] = {}
        targets: dict[str, dict] = {}
        for e in sorted(cat, key=lambda e: e["id"] not in urgent):     # a radar just touched first
            rid = e["id"]
            if rid not in follow:
                continue
            if self._stop.is_set():
                break
            st = self._radar_status(rid)
            with self._lock:
                st["remoteNewest"] = e["newest"]
            fail = self._radar_fail.get(rid)
            if fail and now < fail[1]:
                continue
            if e["hasNewest"] and e["newest"] is None:
                continue    # nothing on the relay inside its window
            whole = not arrival or rid not in self._synced or rid not in self._cursor
            params: dict[str, int] = {"since": keep_from}
            if not whole:
                params["addedSince"] = self._cursor[rid] - 1
            try:
                data = self._get_json(f"/v1/radars/{quote(rid, safe='')}/volumes", params)
                vols = self._volumes_of(data, keep_from)
            except Exception as exc:  # noqa: BLE001 - this radar waits, the rest go on
                n = (fail[0] if fail else 0) + 1
                self._radar_fail[rid] = [n, now + min(self.poll_s * 2 ** min(n - 1, 8), _BACKOFF_MAX_S)]
                self._radar_error(rid, f"volumes: {_brief(exc)}")
                summary["errors"] += 1
                continue
            self._radar_fail.pop(rid, None)
            self._synced.add(rid)
            with self._lock:
                st["lastError"] = None
            for v in vols:
                v["open"] = []
                v["todo"] = []
                for name, size, _added in v["files"]:
                    if self._present(rid, v, name):
                        self._failed.pop((rid, v["stamp"], name), None)
                        continue
                    f = self._failed.get((rid, v["stamp"], name))
                    if f and f[0] >= _FILE_TRIES:
                        continue    # given up (or gone from the relay)
                    v["open"].append(name)
                    if not f or now >= f[1]:
                        v["todo"].append((name, size))
            plans[rid] = vols
            if rid in events:
                if vols and vols[-1]["todo"]:
                    targets[rid] = vols[-1]
                else:
                    events[rid].set()   # its newest is here already (or there is none)

        # Newest volume first, the radars in turn (a radar just touched leading).
        queues = [(rid, [v for v in reversed(vols) if v["todo"]]) for rid, vols in plans.items()]
        order = []
        for depth in range(max((len(q) for _, q in queues), default=0)):
            order += [(rid, q[depth]) for rid, q in queues if depth < len(q)]
        files = 0
        nbytes = 0
        full = False
        for rid, v in order:
            took = False
            for name, size in v["todo"]:
                if (self._stop.is_set() or files >= _MAX_FILES or (nbytes and nbytes + size > _MAX_BYTES)
                        or self._urgent):
                    full = True     # capped, stopping, or a radar touched meanwhile goes first
                    break
                files += 1
                nbytes += size
                took = True
                if self._fetch(rid, v, name, size, now, summary):
                    v["open"].remove(name)
            summary["volumes"] += took
            if targets.get(rid) is v:
                events[rid].set()
            if full:
                summary["more"] = True
                break

        # Cursors: every file added up to the cursor is done -- below the
        # oldest arrival still open, else the newest arrival listed.
        # A whole window with nothing in it starts at the radar's "updated".
        if arrival:
            updated = {c["id"]: c["updated"] for c in cat}
            for rid, vols in plans.items():
                still = [a for v in vols for n, _, a in v["files"] if n in v["open"]]
                seen = [a for v in vols for _, _, a in v["files"]]
                if still:
                    self._cursor[rid] = min(still) - 1
                elif seen:
                    self._cursor[rid] = max(seen)
                elif rid not in self._cursor and updated.get(rid) is not None:
                    self._cursor[rid] = updated[rid]

    def _volumes_of(self, data: dict, keep_from: int) -> list[dict]:
        """The listing's volumes, checked: a stamp, files with safe names, each
        with its arrival ("added"; the volume's, else its stamp, when absent)."""
        out = []
        for v in data.get("volumes") or []:
            if not isinstance(v, dict) or not _STAMP_RE.fullmatch(str(v.get("stamp", ""))):
                continue
            unix = _stamp_unix(v["stamp"])
            if unix is None or unix < keep_from:
                continue
            vadded = _int(v.get("added"))
            files = []
            for f in v.get("files") or []:
                if not isinstance(f, dict):
                    continue
                name, size = str(f.get("name", "")), f.get("size")
                if not _NAME_RE.fullmatch(name) or ".." in name:
                    continue
                size = int(size) if isinstance(size, (int, float)) and size >= 0 else 0
                added = _int(f.get("added"))
                added = added if added is not None else vadded if vadded is not None else unix
                if size <= _MAX_FILE:
                    files.append((name, size, added))
            if files:
                out.append({"stamp": v["stamp"], "unix": unix, "files": files})
        out.sort(key=lambda v: v["unix"])
        return out

    # --- what is here --------------------------------------------------------
    def _scan_store(self) -> None:
        """Every relayed volume on disk, by its relay radar and stamp."""
        self._index = _relayed_on_disk()
        self._scanned = True

    def _info(self, vdir: Path) -> Optional[dict]:
        if vdir not in self._infos:
            self._infos[vdir] = _read_info(vdir)
        return self._infos[vdir]

    def _find_dir(self, radar: str, unix: int) -> Optional[Path]:
        """The folder import_file would add a moment of this time to."""
        lst = self._dirs.get(radar)
        if lst is None:
            lst = []
            rdir = brazil_radar.STORE / radar
            try:
                for d in rdir.iterdir() if rdir.is_dir() else ():
                    u = _stamp_unix(d.name) if _STAMP_RE.fullmatch(d.name) else None
                    if u is not None and d.is_dir():
                        lst.append((u, d.name))
            except OSError:
                pass
            lst.sort()
            self._dirs[radar] = lst
        i = bisect_left(lst, (unix - _GROUP_S, ""))
        best = None
        while i < len(lst) and lst[i][0] <= unix + _GROUP_S:
            if best is None or abs(lst[i][0] - unix) < abs(best[0] - unix):
                best = lst[i]
            i += 1
        return brazil_radar.STORE / radar / best[1] if best else None

    def _present(self, rid: str, v: dict, name: str) -> bool:
        safe = _safe(name)
        e = self._index.get((rid, v["stamp"]))
        cands = [e["dir"]] if e else []
        d = self._find_dir(rid, v["unix"])
        if d is not None and d not in cands:
            cands.append(d)
        for c in cands:
            info = self._info(c)
            if info and safe in (info.get("files") or []) and (c / safe).is_file():
                if e is None or e["dir"] != c:
                    self._index[(rid, v["stamp"])] = {"dir": c, "relay": info.get("source") == "relay",
                                                      "unix": v["unix"]}
                return True
        return False

    # --- one file ------------------------------------------------------------
    def _download(self, url: str, size: int) -> bytes:
        """The file's bytes as the relay stores them. Asked for without any
        transfer compression; a server that adds it anyway (or labels a stored
        .gz as gzip-encoded) is undone only when that is what makes the
        listed size."""
        limit = size + size // 16 + 65536 if size > 0 else _MAX_FILE
        buf = bytearray()
        with self._get(url, stream=True, headers={"Accept-Encoding": "identity"}, timeout=(10, 120)) as r:
            if r.status_code == 404:
                raise _Gone()
            r.raise_for_status()
            for chunk in r.raw.stream(1 << 20, decode_content=False):
                buf += chunk
                if len(buf) > limit:
                    raise ValueError("larger than the listing says")
            enc = r.headers.get("Content-Encoding", "").strip().lower()
        raw = bytes(buf)
        if size > 0 and len(raw) != size and enc in ("gzip", "x-gzip", "deflate"):
            try:
                raw = zlib.decompressobj(47 if "gzip" in enc else 15).decompress(raw, size + 1)
            except zlib.error:
                pass
        if size > 0 and len(raw) != size:
            raise ValueError(f"{len(raw)} bytes where the listing says {size}")
        if not raw:
            raise ValueError("empty file")
        return raw

    def _fetch(self, rid: str, v: dict, name: str, size: int, now: float, summary: dict) -> bool:
        """One file in: True when it is done with (kept, or given up)."""
        key = (rid, v["stamp"], name)
        pre = self._find_dir(rid, v["unix"])
        users = pre if pre is not None and (self._info(pre) or {}).get("source") != "relay" else None
        url = f"{self.base}/v1/files/{quote(rid, safe='')}/{v['stamp']}/{quote(name, safe='')}"
        try:
            raw = self._download(url, size)
            res = brazil_radar.import_file(name, raw)
        except _Gone:
            self._failed[key] = [_FILE_TRIES, float("inf"), v["unix"]]
            return True
        except Exception as exc:  # noqa: BLE001 - this file waits, the rest go on
            tries = (self._failed.get(key) or [0])[0] + 1
            wait = min(_FILE_RETRY_S * 2 ** (tries - 1), 3600.0)
            self._failed[key] = [tries, now + wait, v["unix"]]
            self._radar_error(rid, f"{name}: {_brief(exc)}")
            summary["errors"] += 1
            return tries >= _FILE_TRIES
        self._failed.pop(key, None)
        summary["files"] += 1
        summary["bytes"] += len(raw)
        radar, stamp = str((res or {}).get("radar", "")), str((res or {}).get("stamp", ""))
        u = _stamp_unix(stamp) if _STAMP_RE.fullmatch(stamp) else None
        if not radar.startswith("BR-") or u is None:
            # Kept, but where is not known: not marked, so never pruned either.
            self._radar_error(rid, f"{name}: imported, but import_file did not say where")
            return True
        vdir = brazil_radar.STORE / radar / stamp
        self._infos.pop(vdir, None)
        lst = self._dirs.get(radar)
        if lst is not None and (u, stamp) not in lst:
            insort(lst, (u, stamp))
        marked = self._mark(vdir, rid, v, users is not None and users == vdir)
        self._index[(rid, v["stamp"])] = {"dir": vdir, "relay": marked, "unix": v["unix"]}
        return True

    def _mark(self, vdir: Path, rid: str, v: dict, users: bool) -> bool:
        """The volume folder marked as the relay's, unless it is the user's
        own: one that was here unmarked before, or holds a file the relay did
        not list for this volume."""
        info = self._info(vdir)
        if info is None:
            return False
        if info.get("source") == "relay":
            return True
        if users or not set(info.get("files") or []) <= {_safe(n) for n, _, _ in v["files"]}:
            return False
        info["source"] = "relay"
        info["relay"] = {"radar": rid, "stamp": v["stamp"], "unix": v["unix"]}
        try:
            _write_info(vdir, info)
        except OSError:
            return False
        return True

    # --- pruning -------------------------------------------------------------
    def prune(self, rescan: bool = False) -> int:
        """Relayed volumes older than the retention deleted; how many went."""
        if rescan:
            self._scan_store()
        cutoff = time.time() - self.retention_s
        gone = 0
        for key, e in list(self._index.items()):
            if e["unix"] >= cutoff:
                continue
            if e["relay"]:
                done = _delete_volume(e["dir"])
                if done is None:
                    continue    # held open: next pass
                if done:
                    gone += 1
                    _drop_cached(e["dir"].parent.name, e["dir"].name)
                    lst = self._dirs.get(e["dir"].parent.name)
                    if lst is not None:
                        lst[:] = [x for x in lst if x[1] != e["dir"].name]
                    self._infos.pop(e["dir"], None)
            self._index.pop(key, None)
        for k in [k for k, f in self._failed.items() if f[2] < cutoff]:
            self._failed.pop(k, None)
        return gone

    # --- status --------------------------------------------------------------
    def _refresh_status(self, summary: dict) -> None:
        per: dict[str, list] = {}
        for (rid, _), e in self._index.items():
            if e["relay"]:
                p = per.setdefault(rid, [None, 0])
                p[0] = max(p[0] or 0, e["unix"])
                p[1] += 1
        for rid in per:
            self._radar_status(rid)
        with self._lock:
            for rid, st in self._status["radars"].items():
                st["newest"], st["volumes"] = per.get(rid, [None, 0])
                st["cursor"] = self._cursor.get(rid)
            self._status["files"] += summary["files"]
            self._status["bytes"] += summary["bytes"]
            self._status["pruned"] += summary["pruned"]
            self._status["lastPass"] = {k: summary[k] for k in ("files", "bytes", "pruned", "more", "errors")}

    def status(self) -> dict:
        now = time.time()
        follow = self.followed(now)
        with self._lock:
            out = copy.deepcopy(self._status)
            touched = dict(self._touched)
            ids = None if self._catalog is None else {e["id"] for e in self._catalog}
        out["running"] = self.running
        out["retentionHours"] = round(self.retention_s / 3600.0, 2)
        out["contract"] = None if self._arrival is None else "1.1" if self._arrival else "1"
        out["relayRadars"] = None if ids is None else sorted(ids)
        out["followMinutes"] = round(_FOLLOW_S / 60.0)
        out["followed"] = [{"id": rid, "always": rid in self.always,
                            "lastTouch": int(touched[rid]) if rid in touched else None,
                            "onRelay": None if ids is None else rid in ids} for rid in sorted(follow)]
        return out


# ---------------------------------------------------------------------------
# The app's one client
# ---------------------------------------------------------------------------
_CLIENT: Optional[Client] = None
_START_LOCK = threading.Lock()
_PRUNE_THREAD: Optional[threading.Thread] = None


def extra_sites() -> list[dict]:
    """brazil_radar.EXTRA_SITES while a relay is followed: its radars for the picker."""
    client = _CLIENT
    return client.sites() if client is not None else []


def _startup_prune(hours: float) -> None:
    try:
        n = prune_store(hours)
    except Exception as exc:  # noqa: BLE001 - next startup tries again
        _log(f"startup prune failed ({_brief(exc)})")
        return
    if n:
        _log(f"{n} relayed volumes older than {hours:g} h pruned")


def start() -> bool:
    """Follow the configured relay in the background (its first pass prunes
    the store first); with none, only the one-shot prune of relayed volumes
    past the retention, in a thread of its own. True when a relay is followed."""
    global _CLIENT, _PRUNE_THREAD
    cfg = config()
    if not enabled():
        if cfg["relay"] and _forbidden(cfg["relay"]):
            _log(f"WEATHERTS_RADAR_RELAY is on {_FORBIDDEN_HOSTS[0]}, CEMADEN's CAPTCHA-protected map; "
                 "this client never requests it -- not following any relay")
        elif cfg["relay"]:
            _log("WEATHERTS_RADAR_RELAY is not an http(s) URL; not following any relay")
        with _START_LOCK:
            if _PRUNE_THREAD is None or not _PRUNE_THREAD.is_alive():
                _PRUNE_THREAD = threading.Thread(target=_startup_prune, args=(cfg["retentionHours"],),
                                                 name="radar-relay-prune", daemon=True)
                _PRUNE_THREAD.start()
        return False
    with _START_LOCK:
        if _CLIENT is None:
            _CLIENT = Client(cfg["relay"], cfg["pollSeconds"], cfg["retentionHours"], cfg["radars"])
        _CLIENT.start()
        brazil_radar.EXTRA_SITES = extra_sites
    return True


def stop(timeout: Optional[float] = 5.0) -> None:
    global _CLIENT
    with _START_LOCK:
        client, _CLIENT = _CLIENT, None
        if getattr(brazil_radar, "EXTRA_SITES", None) is extra_sites:
            brazil_radar.EXTRA_SITES = None
    if client is not None:
        client.stop(timeout)


def touch(site: str) -> None:
    """The app asked for this radar's scans or availability: follow it (see
    Client.touch; waits at most about a second). Nothing when no relay is."""
    client = _CLIENT
    if client is None:
        return
    try:
        client.touch(site)
    except Exception:  # noqa: BLE001 - the app's answer never waits on the relay's bookkeeping
        pass


def status() -> dict:
    """Where the relay sync stands, for the app's UI."""
    client = _CLIENT
    if client is not None:
        return client.status()
    cfg = config()
    return {"enabled": enabled(), "running": False, "relay": cfg["relay"] or None, "lastSync": None,
            "lastAttempt": None, "lastError": None, "pollSeconds": cfg["pollSeconds"],
            "retentionHours": cfg["retentionHours"], "files": 0, "bytes": 0, "pruned": 0, "lastPass": None,
            "radars": {}, "contract": None, "relayRadars": None, "followMinutes": round(_FOLLOW_S / 60.0),
            "followed": []}
