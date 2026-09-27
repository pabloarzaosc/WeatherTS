"""
Network and disk plumbing shared by the satellite readers.

The link to the data is slow and far: every server answers a quarter of a
second after a request (the round trip), one stream gets 2-10 Mbit/s, and in
parallel SLIDER tops out near 18 Mbit/s, AWS 12, Google Cloud 35 (measured
2026-09-26; a CDN like WeatherWise's gives 80+). So everything big goes in
parallel ranges, and what costs most is a chain of requests one after
another, or a new connection (its TLS handshake). Every request passes a gate
per host -- 16 at once, 32 to Google -- so a loop of pictures cannot open a
hundred connections at once (S3 starts closing them past about thirty).
"""
from __future__ import annotations

import hashlib
import io
import os
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

import requests
from requests.adapters import HTTPAdapter

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "WeatherTS/1.0 (desktop weather app)"
SESSION.mount("https://", HTTPAdapter(pool_connections=48, pool_maxsize=48, max_retries=0))
SESSION.mount("http://", HTTPAdapter(pool_connections=8, pool_maxsize=8, max_retries=0))

TIMEOUT = (8, 25)
GATE = threading.BoundedSemaphore(16)
# Google Cloud keeps gaining up to ~32 streams (35 Mbit/s); SLIDER and AWS
# flatten out by 16 and get worse past it.
_HOST_GATES = {"storage.googleapis.com": threading.BoundedSemaphore(32)}
POOL = ThreadPoolExecutor(max_workers=40, thread_name_prefix="sat-net")
# Fan-out over the bands of one picture. Kept apart from POOL on purpose: a
# band's task waits on its tiles, which run on POOL, and with both on one pool
# a few pictures at once filled it with waiting band tasks and nothing was left
# to fetch the tiles -- every satellite request hung.
BANDS = ThreadPoolExecutor(max_workers=48, thread_name_prefix="sat-band")


class Missing(Exception):
    """The server says the thing is not there (404, or an empty answer)."""


# When each host was last asked for something: a host in use has its
# connections open already (see warm).
_LAST_USE: dict[str, float] = {}


def _host(url: str) -> str:
    return url.split("/", 3)[2] if "://" in url else ""


def _gate(url: str) -> threading.BoundedSemaphore:
    host = _host(url)
    _LAST_USE[host] = time.time()
    return _HOST_GATES.get(host, GATE)


def get(url: str, *, params: Optional[dict] = None, headers: Optional[dict] = None,
        tries: int = 3, timeout=TIMEOUT) -> requests.Response:
    """GET through the gate, tried again on a dropped connection or a 5xx."""
    last: Optional[Exception] = None
    for attempt in range(tries):
        try:
            with _gate(url):
                r = SESSION.get(url, params=params, headers=headers, timeout=timeout)
            if r.status_code in (403, 404):
                raise Missing(f"{r.status_code} {url}")
            if r.status_code >= 500 or r.status_code == 429:
                raise requests.HTTPError(f"{r.status_code} {url}")
            r.raise_for_status()
            return r
        except Missing:
            raise
        except requests.RequestException as err:
            last = err
            time.sleep(0.4 * (attempt + 1))
    raise last if last else RuntimeError(url)


def warm(url: str, n: int = 16) -> None:
    """Open (or keep open) `n` connections to a host with as many small HEAD
    requests at once: a request on an open connection answers in 0.2 s from
    here, on a new one in 0.8 s (the TLS handshake), and a picture's dozen
    tiles all at once opened a dozen. Both SLIDER and Google keep an idle
    connection past 50 s (measured 2026-09-26). Skipped while the host is in
    use: its connections are open, and sixteen HEADs would hold the gate
    ahead of a loop's tiles."""
    if time.time() - _LAST_USE.get(_host(url), 0.0) < 20:
        return

    def one(_i: int) -> None:
        try:
            with _gate(url):
                SESSION.head(url, timeout=TIMEOUT)
        except requests.RequestException:
            pass

    list(POOL.map(one, range(n)))


def get_range(url: str, start: int, end: int) -> bytes:
    """Bytes start..end (inclusive) of a file."""
    r = get(url, headers={"Range": f"bytes={start}-{end}"})
    return r.content


class RangeFile(io.RawIOBase):
    """A remote file read in blocks by HTTP range, for h5py to walk the
    metadata of a netCDF without downloading the data behind it. `fetch`
    (start, end inclusive) -> bytes replaces the plain GET when given."""

    def __init__(self, url: str, size: int, block: int = 1 << 16, fetch=None):
        super().__init__()
        self.url = url
        self.size = size
        self.pos = 0
        self.block = block
        self.blocks: dict[int, bytes] = {}
        self.requests = 0
        self.fetch = fetch or (lambda start, end: get_range(url, start, end))

    def preload(self, spans: list[tuple[int, int]]) -> None:
        """Fetch these byte spans at once, in parallel: where a file's index
        sits (its head and its tail) costs one round trip instead of one per
        block -- a quarter of a second each on this link."""
        def one(span: tuple[int, int]) -> tuple[int, bytes]:
            start = (max(0, span[0]) // self.block) * self.block
            end = min(self.size, span[1]) - 1
            return start, self.fetch(start, end)

        for start, data in POOL.map(one, spans):
            first = start // self.block
            for k in range(0, len(data), self.block):
                self.blocks[first + k // self.block] = data[k:k + self.block]

    def seekable(self) -> bool:
        return True

    def readable(self) -> bool:
        return True

    def seek(self, off: int, whence: int = 0) -> int:
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def tell(self) -> int:
        return self.pos

    def _block(self, i: int) -> bytes:
        got = self.blocks.get(i)
        if got is None:
            start = i * self.block
            # Read ahead: metadata sits together, so fetch four blocks at once.
            end = min(self.size, start + 4 * self.block) - 1
            data = self.fetch(start, end)
            self.requests += 1
            for k in range(0, len(data), self.block):
                self.blocks[i + k // self.block] = data[k:k + self.block]
            got = self.blocks.get(i, b"")
        return got

    def readinto(self, b) -> int:
        n = len(b)
        out = bytearray()
        while len(out) < n and self.pos < self.size:
            i = self.pos // self.block
            data = self._block(i)
            if not data:
                break
            piece = data[self.pos - i * self.block:][: n - len(out)]
            out += piece
            self.pos += len(piece)
        b[: len(out)] = out
        return len(out)


# ---------------------------------------------------------------------------
# Disk cache for finished pictures and tiles
# ---------------------------------------------------------------------------
CACHE_DIR = Path(tempfile.gettempdir()) / "weatherts-sat"
DISK_BUDGET = int(1.5 * 1024 ** 3)
_TRIM_LOCK = threading.Lock()
_WRITES = 0


def _path(kind: str, key: str) -> Path:
    h = hashlib.sha1(key.encode()).hexdigest()
    return CACHE_DIR / kind / h[:2] / h


def disk_get(kind: str, key: str) -> Optional[bytes]:
    p = _path(kind, key)
    try:
        data = p.read_bytes()
    except OSError:
        return None
    try:
        os.utime(p)
    except OSError:
        pass
    return data


def disk_put(kind: str, key: str, data: bytes) -> None:
    global _WRITES
    p = _path(kind, key)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".part")
        tmp.write_bytes(data)
        os.replace(tmp, p)
    except OSError:
        return
    _WRITES += 1
    if _WRITES % 200 == 0:
        POOL.submit(trim)


def trim() -> None:
    """Oldest-first down to the budget: the app must never fill the disk."""
    with _TRIM_LOCK:
        try:
            files = []
            for root, _dirs, names in os.walk(CACHE_DIR):
                for n in names:
                    p = Path(root) / n
                    try:
                        st = p.stat()
                    except OSError:
                        continue
                    files.append((st.st_mtime, st.st_size, p))
            total = sum(f[1] for f in files)
            if total <= DISK_BUDGET:
                return
            files.sort()
            for _mt, size, p in files:
                if total <= DISK_BUDGET * 0.85:
                    break
                try:
                    p.unlink()
                    total -= size
                except OSError:
                    pass
        except OSError:
            pass
