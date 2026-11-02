"""
What the relay holds: per radar, per volume (stamp), each file's name, size
and "added" time. The API answers from it, and the poller asks it before every
download, so a file already stored is never fetched again.

"added" is the relay's own clock (unix seconds) when the file was committed to
the store: the poller's injectable clock, so the tests run on a fixed one.
Clients use it as their cursor (?addedSince=, contract v1.1): it says when the
relay got a file, which a backlog fetched late makes very different from the
stamp, and it is one clock, so a client's own clock never matters.

Kept in the store as index.json, written whole and atomically (a local
os.replace, one S3 PUT) and only when something changed:

    {"version": 2, "updated": 1791800000,
     "radars": {"BR-MCZ": {"20261012074005": {"2026101207400500dBZ.vol": 6873211, ...}}},
     "added":  {"BR-MCZ": {"20261012074005": {"2026101207400500dBZ.vol": 1791791230, ...}}}}

"radars" is exactly version 1's map (name -> size), so a relay of 1.0 reading
this file still serves it; "added" sits beside it, same shape. An entry with
no added time (a version 1 file, a hand edit) counts as added at its volume's
stamp. When index.json is missing (a new store, a deleted file) it is rebuilt
by listing the store, each file's added time its modification time (S3:
LastModified) rounded up to the second, else its stamp; reconcile() does the
same against an existing index, for a crash between a file's commit and the
next index write, keeping the added time of every file it already had.

An API running apart from the poller (--api-only, sharing the store) calls
refresh(), which re-reads index.json at most every few seconds and only when
it changed (its mtime, or the object's ETag). The API's forced refresh (a
/v1/files miss) still waits FORCE_INTERVAL since the last forced one, so a
flood of requests for missing files cannot turn into a flood of store reads.
"""
from __future__ import annotations

import json
import logging
import math
import threading
import time
from typing import Any, Optional

from .config import RADAR_ID_RE
from .stamps import STAMP_RE, stamp_unix, valid_name
from .storage import INDEX_KEY, Storage

log = logging.getLogger("relay.index")

INDEX_VERSION = 2
FORCE_INTERVAL = 1.0            # seconds between two forced refreshes, at least

# radar -> stamp -> name -> (size, added)
Data = dict[str, dict[str, dict[str, tuple[int, int]]]]
# What volumes() gives: (stamp, unix, added, [(name, size, added)]), "added"
# of the volume being the newest of its files'.
Volume = tuple[str, int, int, list[tuple[str, int, int]]]


def _whole(v: Any) -> Optional[int]:
    """An added time read from JSON: a non-negative number, else None."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
        return None
    return int(v)


def _added_from_mtime(mtime: Optional[float], unix: int) -> int:
    """A stored file's added time when only the store knows it: its
    modification time rounded up (never before the second it was committed
    in), else the volume's stamp."""
    if mtime is None:
        return unix
    try:
        return int(math.ceil(float(mtime)))
    except (TypeError, ValueError, OverflowError):
        return unix


class Index:
    def __init__(self, storage: Storage):
        self.storage = storage
        self._lock = threading.RLock()
        self._save_lock = threading.Lock()
        self._refresh_lock = threading.Lock()
        self._data: Data = {}
        self._dirty = False
        self._token: Any = None
        self._checked = 0.0
        self._forced = float("-inf")

    # --- loading -----------------------------------------------------------
    @staticmethod
    def _clean(raw: Any) -> Data:
        out: Data = {}
        radars = raw.get("radars", {}) if isinstance(raw, dict) else {}
        added = raw.get("added", {}) if isinstance(raw, dict) else {}
        added = added if isinstance(added, dict) else {}
        for rid, vols in (radars or {}).items():
            if not RADAR_ID_RE.match(str(rid)) or not isinstance(vols, dict):
                continue
            rid_added = added.get(rid) if isinstance(added.get(rid), dict) else {}
            for stamp, files in vols.items():
                u = stamp_unix(stamp) if STAMP_RE.match(str(stamp)) else None
                if u is None or not isinstance(files, dict):
                    continue
                adds = rid_added.get(stamp) if isinstance(rid_added.get(stamp), dict) else {}
                for name, size in files.items():
                    if valid_name(str(name)) and isinstance(size, int) and not isinstance(size, bool) and size >= 0:
                        a = _whole(adds.get(name))
                        out.setdefault(rid, {}).setdefault(stamp, {})[name] = (size, u if a is None else a)
        return out

    def load(self) -> bool:
        """index.json from the store; False when there is none (or it is unreadable)."""
        raw, token = self.storage.read_meta_if_changed(INDEX_KEY, None)
        if raw is None:
            return False
        try:
            data = self._clean(json.loads(raw.decode("utf-8")))
        except (ValueError, UnicodeDecodeError) as e:
            log.warning("index.json unreadable (%s); rebuilding from the store", e)
            return False
        with self._lock:
            self._data = data
            self._token = token
            self._dirty = False
            self._checked = time.monotonic()
        return True

    def _scan(self) -> Data:
        out: Data = {}
        for rid, stamp, name, size, mtime in self.storage.list_files():
            u = stamp_unix(stamp)
            if u is not None:
                out.setdefault(rid, {}).setdefault(stamp, {})[name] = (int(size), _added_from_mtime(mtime, u))
        return out

    def rebuild(self) -> None:
        data = self._scan()
        with self._lock:
            self._data = data
            self._dirty = True
        log.info("index rebuilt from the store: %d volumes, %d files", self.count_volumes(), self.count_files())

    def reconcile(self) -> tuple[int, int]:
        """Make the index match the store: files stored but not indexed (a
        crash before the index was written) are added, entries whose file is
        gone are dropped; a file indexed with the same size keeps its added
        time. Returns (added, dropped)."""
        actual = self._scan()
        added = dropped = 0
        with self._lock:
            for rid, vols in actual.items():
                for stamp, files in vols.items():
                    have = self._data.get(rid, {}).get(stamp, {})
                    for name, (size, _when) in files.items():
                        old = have.get(name)
                        if old is not None and old[0] == size:
                            files[name] = old
                        else:
                            added += 1
            for rid, vols in self._data.items():
                for stamp, files in vols.items():
                    real = actual.get(rid, {}).get(stamp, {})
                    dropped += sum(1 for n in files if n not in real)
            if added or dropped:
                self._data = actual
                self._dirty = True
        if added or dropped:
            log.info("index reconciled with the store: %d files added, %d dropped", added, dropped)
        return added, dropped

    def open(self, reconcile: bool = False) -> "Index":
        """Load index.json, or rebuild it from the store when there is none."""
        if not self.load():
            self.rebuild()
            self.save()
        elif reconcile:
            self.reconcile()
            self.save()
        return self

    def refresh(self, min_interval: float = 5.0, force: bool = False, force_interval: float = 0.0) -> None:
        """Pick up what another process (the poller) wrote; cheap to call often.
        force skips min_interval, but not force_interval since the last forced
        refresh (then it is an ordinary call): the API passes FORCE_INTERVAL."""
        now = time.monotonic()
        with self._refresh_lock:
            if force and now - self._forced < force_interval:
                force = False
            if not force and now - self._checked < min_interval:
                return
            self._checked = now
            if force:
                self._forced = now
        try:
            raw, token = self.storage.read_meta_if_changed(INDEX_KEY, self._token)
        except Exception as e:
            log.warning("index refresh failed: %s", e)
            return
        if raw is None:
            return
        try:
            data = self._clean(json.loads(raw.decode("utf-8")))
        except (ValueError, UnicodeDecodeError) as e:
            log.warning("index.json unreadable on refresh: %s", e)
            return
        with self._lock:
            self._data = data
            self._token = token

    # --- saving ------------------------------------------------------------
    @property
    def dirty(self) -> bool:
        return self._dirty

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            live = sorted((rid, v) for rid, v in self._data.items() if v)
            radars = {rid: {s: {n: sa[0] for n, sa in sorted(f.items())} for s, f in sorted(v.items())}
                      for rid, v in live}
            added = {rid: {s: {n: sa[1] for n, sa in sorted(f.items())} for s, f in sorted(v.items())}
                     for rid, v in live}
        return {"version": INDEX_VERSION, "updated": int(time.time()), "radars": radars, "added": added}

    def save(self, force: bool = False) -> bool:
        """Write index.json when something changed since the last write."""
        with self._save_lock:
            with self._lock:
                if not (self._dirty or force):
                    return False
                self._dirty = False
                body = json.dumps(self.snapshot(), separators=(",", ":")).encode("utf-8")
            try:
                self.storage.write_meta(INDEX_KEY, body)
            except Exception:
                with self._lock:
                    self._dirty = True
                raise
        return True

    # --- reading and changing ----------------------------------------------
    def has(self, radar: str, stamp: str, name: str) -> bool:
        with self._lock:
            return name in self._data.get(radar, {}).get(stamp, {})

    def size(self, radar: str, stamp: str, name: str) -> Optional[int]:
        with self._lock:
            got = self._data.get(radar, {}).get(stamp, {}).get(name)
        return got[0] if got else None

    def added(self, radar: str, stamp: str, name: str) -> Optional[int]:
        with self._lock:
            got = self._data.get(radar, {}).get(stamp, {}).get(name)
        return got[1] if got else None

    def add(self, radar: str, stamp: str, name: str, size: int, added: Optional[float] = None) -> None:
        """A file committed to the store; added: the commit time on the
        poller's clock (default: now)."""
        when = int(added if added is not None else time.time())
        with self._lock:
            self._data.setdefault(radar, {}).setdefault(stamp, {})[name] = (int(size), when)
            self._dirty = True

    def remove_volume(self, radar: str, stamp: str) -> None:
        with self._lock:
            vols = self._data.get(radar)
            if vols and vols.pop(stamp, None) is not None:
                self._dirty = True
                if not vols:
                    self._data.pop(radar, None)

    def older_than(self, cutoff_unix: float) -> list[tuple[str, str]]:
        """(radar, stamp) of every volume that started before the cutoff."""
        with self._lock:
            return [(rid, s) for rid, vols in self._data.items() for s in vols
                    if (stamp_unix(s) or 0) < cutoff_unix]

    def volumes(self, radar: str, since: Optional[float] = None, not_before: Optional[float] = None,
                added_since: Optional[float] = None) -> list[Volume]:
        """(stamp, unix, added, [(name, size, added)]) oldest first. `since`
        keeps unix > since; `added_since` keeps the volumes with a file added
        after it (all their files listed); `not_before` hides what the
        retention has outlived but the poller has not pruned yet."""
        with self._lock:
            vols = {s: sorted((n, sa[0], sa[1]) for n, sa in f.items())
                    for s, f in self._data.get(radar, {}).items() if f}
        out = []
        for stamp in sorted(vols):
            u = stamp_unix(stamp)
            if u is None or (since is not None and u <= since) or (not_before is not None and u < not_before):
                continue
            files = vols[stamp]
            newest = max(a for _n, _s, a in files)
            if added_since is not None and newest <= added_since:
                continue
            out.append((stamp, u, newest, files))
        return out

    def newest(self, radar: str) -> Optional[int]:
        """The newest indexed volume's stamp, as unix; None when there is none."""
        with self._lock:
            stamps = [s for s, f in self._data.get(radar, {}).items() if f]
        return stamp_unix(max(stamps)) if stamps else None

    def radars(self) -> list[str]:
        with self._lock:
            return sorted(self._data)

    def count_volumes(self) -> int:
        with self._lock:
            return sum(len(v) for v in self._data.values())

    def count_files(self) -> int:
        with self._lock:
            return sum(len(f) for v in self._data.values() for f in v.values())
