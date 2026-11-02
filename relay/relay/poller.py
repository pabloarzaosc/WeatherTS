"""
The loop that keeps the store current. Every poll_seconds, per radar:

    1. list the source for files of volumes that started inside the
       retention window (now - retention_hours .. now);
    2. drop what the index already holds: a file is downloaded once, ever;
    3. keep what is surely complete: a file the listing gives a modification
       time for once it is settle_seconds old; one without (HTML listings,
       NASA, FTP LIST/NLST) once two consecutive listings saw it with the
       same size (the listing's, or probe_size()'s: HEAD, FTP SIZE). The
       previous listing's sizes are kept per radar in memory;
    4. download those, newest volume first (after an outage the app gets
       the current scan before the backlog), each to a staging file, size
       checked, then committed to the store and added to the index with its
       "added" time, this poller's clock at the commit;
    5. after the round, prune: every volume that started before the window
       leaves the store and the index, whatever radar it belongs to.

--once (poll_once) starts with no memory, so a radar with files waiting for
their second listing is listed again recheck_seconds (20) later, inside the
same run; the long-running loop confirms them on its next poll.

One radar failing never stops the others: its error is logged and it waits
poll_seconds * 2^failures (at most max_backoff_seconds) before the next try.
At most `concurrency` radars are polled at once. A poll downloads at most
max_files_per_poll files (the rest come next poll), so a long backlog cannot
hold a radar's slot for hours.

The clock is injectable (Poller(now=...)): the tests run "36 hours later"
without waiting, and --once runs from cron or GitHub Actions use the same
code as the long-running loop.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable, Optional

from . import views
from .config import Config
from .index import Index
from .sources import RemoteFile, Source, SourceError, SourceGone, make_source
from .storage import Storage, StorageError, file_key

log = logging.getLogger("relay.poller")

SAVE_EVERY = 50                 # index.json written at least every N downloads during a backlog
FAILS_BEFORE_GIVING_UP = 3      # consecutive failed downloads that end a radar's poll
# A file no listing and no probe gives a size for cannot be seen to stop
# growing: it is taken once its scan started this long ago (a radar writes a
# volume's files within a minute or two of the scan), or settle_seconds when
# that is longer. Age, not memory, so --once runs from cron reach it too.
UNKNOWN_SIZE_AGE_S = 600


@dataclass
class RadarState:
    failures: int = 0
    next_due: float = 0.0
    last_ok: Optional[float] = None
    last_error: Optional[str] = None


@dataclass
class RadarReport:
    radar: str
    listed: int = 0
    new: int = 0
    downloaded: int = 0
    bytes: int = 0
    failed: int = 0
    settling: int = 0
    deferred: int = 0
    cooling: int = 0               # failed recently, waiting before the next try
    confirming: int = 0            # no modification time: waiting for a second listing, same size
    seconds: float = 0.0
    error: Optional[str] = None
    names: list[str] = field(default_factory=list)

    def then(self, later: "RadarReport") -> "RadarReport":
        """This poll followed by a second one of the same radar (--once's
        recheck): what was downloaded adds up, the rest is the later state."""
        return RadarReport(self.radar, listed=later.listed, new=self.new,
                           downloaded=self.downloaded + later.downloaded, bytes=self.bytes + later.bytes,
                           failed=self.failed + later.failed, settling=later.settling,
                           deferred=later.deferred, cooling=later.cooling, confirming=later.confirming,
                           seconds=self.seconds + later.seconds, error=later.error,
                           names=self.names + later.names)


class Poller:
    def __init__(self, cfg: Config, storage: Storage, index: Index,
                 sources: Optional[dict[str, Source]] = None, now: Optional[Callable[[], float]] = None):
        self.cfg = cfg
        self.storage = storage
        self.index = index
        self.now = now or time.time
        if sources is None:
            sources = {}
            for r in cfg.radars:
                src = make_source(r, cfg)
                if src is not None:
                    sources[r.id] = src
        self.sources = sources
        self.state = {rid: RadarState() for rid in self.sources}
        self._stop = threading.Event()
        self._static_hash: dict[str, str] = {}
        self._undeleted: set[tuple[str, str]] = set()
        # Per radar (each touched by its own poll only): name -> (failed
        # attempts, not before this wall time).
        self._bad: dict[str, dict[str, tuple[int, float]]] = {}
        # Per radar, the same way: name -> size (None: unknown) at the last
        # listing, for the files it gave no modification time.
        self._sizes: dict[str, dict[str, Optional[int]]] = {}

    @property
    def active(self) -> list[str]:
        return list(self.sources)

    def _poll_s(self, rid: str) -> float:
        r = self.cfg.radar(rid)
        return float(r.poll_seconds) if r is not None and r.poll_seconds else float(self.cfg.poll_seconds)

    # --- one radar -----------------------------------------------------------
    def _download(self, rid: str, src: Source, f: RemoteFile) -> int:
        tmp = self.storage.staging_dir() / f"{rid}.{f.stamp}.{uuid.uuid4().hex}.part"
        try:
            n = src.fetch(f, tmp, int(self.cfg.max_file_mb * 1024 * 1024))
            if n <= 0:
                raise SourceError(f"{f.name}: empty")
            self.storage.commit(file_key(rid, f.stamp, f.name), tmp, n)
            return n
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

    def _ready(self, rid: str, src: Source, todo: list[RemoteFile], rep: RadarReport,
               wall: float) -> list[RemoteFile]:
        """Which of the new files (newest first) can be taken now, by step 3
        of the module docstring; counts the others in rep. Sizes are asked
        for (probe_size) for at most 2 x max_files_per_poll files a poll: the
        ones this poll can download and the next poll's, so a long backlog
        neither waits a poll per batch nor asks for every file at once."""
        cap = self.cfg.max_files_per_poll
        window = 2 * cap if cap else None
        prev = self._sizes.get(rid, {})
        seen: dict[str, Optional[int]] = {}
        ready: list[RemoteFile] = []
        streak = 0
        probing = True
        now = self.now()
        try:
            for f in todo:
                if f.mtime is not None:
                    if src.settled(f, wall):
                        ready.append(f)
                    else:
                        rep.settling += 1
                    continue
                if window is not None and len(seen) >= window:
                    rep.deferred += 1
                    continue
                if not probing:
                    # The server stopped answering size requests this poll:
                    # what was confirmed above is still taken, the rest waits
                    # with its last known size.
                    rep.confirming += 1
                    if f.name in prev:
                        seen[f.name] = prev[f.name]
                    continue
                try:
                    size = src.probe_size(f)
                    streak = 0
                except SourceGone as e:
                    # Purged at the source while a lagging listing still shows
                    # it: nothing to take, and no reason to stop the others.
                    log.debug("%s: %s", rid, e)
                    continue
                except SourceError as e:
                    streak += 1
                    rep.confirming += 1
                    if f.name in prev:
                        seen[f.name] = prev[f.name]
                    log.debug("%s: size of %s unknown this time: %s", rid, f.name, e)
                    if streak >= FAILS_BEFORE_GIVING_UP:
                        probing = False
                        log.warning("%s: %d size requests in a row failed; the unconfirmed files wait for the "
                                    "next poll (last: %s)", rid, streak, e)
                    continue
                seen[f.name] = size
                if size is None:
                    # Listed twice with no size either time proves nothing: wait
                    # on the scan's age instead (UNKNOWN_SIZE_AGE_S).
                    if now - f.unix >= max(float(src.settle_s), UNKNOWN_SIZE_AGE_S):
                        ready.append(f)
                    else:
                        rep.confirming += 1
                    continue
                if f.name in prev and prev[f.name] == size:
                    if f.size is None:
                        f.size = size       # so the download is checked against it
                    ready.append(f)
                else:
                    rep.confirming += 1     # new, or still growing
        finally:
            # Kept even when a request fails mid-loop: the next poll compares
            # against what this one did learn.
            self._sizes[rid] = seen
        return ready

    def poll_radar(self, rid: str) -> RadarReport:
        rep = RadarReport(rid)
        src = self.sources[rid]
        st = self.state[rid]
        t0 = time.monotonic()
        now = self.now()
        cutoff = now - self.cfg.retention_seconds
        try:
            listing = src.list(cutoff, now)
            rep.listed = len(listing)
            bad = self._bad.setdefault(rid, {})
            listed = {f.name for f in listing}
            for name in [n for n in bad if n not in listed]:
                del bad[name]           # gone from the source, or out of the window
            todo = [f for f in listing if not self.index.has(rid, f.stamp, f.name)]
            rep.new = len(todo)
            todo.sort(key=lambda f: (-f.unix, f.name))
            wall = time.time()
            ready = self._ready(rid, src, todo, rep, wall)
            cap = self.cfg.max_files_per_poll
            if cap and len(ready) > cap:
                rep.deferred += len(ready) - cap
                ready = ready[:cap]
            streak = 0
            for f in ready:
                if self._stop.is_set():
                    break
                if f.unix < self.now() - self.cfg.retention_seconds:
                    continue            # aged out while the backlog ran
                tried = bad.get(f.name)
                if tried and tried[1] > wall:
                    rep.cooling += 1
                    continue            # failed recently: the others go first
                try:
                    n = self._download(rid, src, f)
                except (SourceError, StorageError, OSError) as e:
                    rep.failed += 1
                    streak += 1
                    count = (tried[0] if tried else 0) + 1
                    bad[f.name] = (count, wall + min(3600.0, self._poll_s(rid) * 2 ** min(count, 10)))
                    log.warning("%s: %s failed: %s", rid, f.name, e)
                    if streak >= FAILS_BEFORE_GIVING_UP:
                        raise SourceError(f"{streak} downloads in a row failed; last: {e}") from e
                    continue
                streak = 0
                bad.pop(f.name, None)
                self.index.add(rid, f.stamp, f.name, n, added=self.now())
                rep.downloaded += 1
                rep.bytes += n
                rep.names.append(f.name)
                if rep.downloaded % SAVE_EVERY == 0:
                    self._save()
            if rep.failed and not rep.downloaded:
                raise SourceError(f"every download failed ({rep.failed})")
        except Exception as e:
            rep.error = str(e) or e.__class__.__name__
        finally:
            try:
                src.close()
            except Exception:
                pass
            rep.seconds = time.monotonic() - t0

        done = self.now()
        if rep.error:
            st.failures += 1
            st.last_error = rep.error
            wait = min(self.cfg.max_backoff_seconds, self._poll_s(rid) * (2 ** min(st.failures, 20)))
            st.next_due = done + wait
            log.error("%s: poll failed (%s, attempt %d); next try in %.0f s", rid, rep.error, st.failures, wait)
        else:
            first = st.last_ok is None
            st.failures = 0
            st.last_error = None
            st.last_ok = done
            st.next_due = done + self._poll_s(rid)
            if rep.downloaded or rep.failed or rep.settling or rep.deferred or rep.cooling or rep.confirming \
                    or first:
                log.info("%s: listed %d, new %d, downloaded %d (%.1f MB) in %.1f s%s%s%s%s%s", rid, rep.listed,
                         rep.new, rep.downloaded, rep.bytes / 1e6, rep.seconds,
                         f", {rep.failed} failed" if rep.failed else "",
                         f", {rep.settling} still being written" if rep.settling else "",
                         f", {rep.confirming} waiting for a second listing" if rep.confirming else "",
                         f", {rep.deferred} left for the next poll" if rep.deferred else "",
                         f", {rep.cooling} waiting after a failure" if rep.cooling else "")
            else:
                log.debug("%s: listed %d, nothing new", rid, rep.listed)
        return rep

    # --- the store as a whole ------------------------------------------------
    def prune(self) -> int:
        """Delete every volume that started before now - retention. Returns
        how many volumes went."""
        cutoff = self.now() - self.cfg.retention_seconds
        gone = 0
        todo = set(self.index.older_than(cutoff)) | self._undeleted
        for rid, stamp in sorted(todo):
            # Out of the index first: from this moment the API answers 404,
            # then the bytes go. A deletion that fails is tried again next
            # round (the volume is no longer served meanwhile).
            self.index.remove_volume(rid, stamp)
            try:
                n = self.storage.delete_volume(rid, stamp)
                self._undeleted.discard((rid, stamp))
                gone += 1
                log.info("%s: pruned %s (%d files)", rid, stamp, n)
            except Exception as e:
                self._undeleted.add((rid, stamp))
                log.warning("%s: pruning %s failed (%s); retried next round", rid, stamp, e)
        return gone

    def _save(self) -> None:
        try:
            self.index.save()
        except Exception as e:
            log.error("index.json not written: %s", e)

    def publish_static(self) -> int:
        """With [storage] static_api, write the API's JSON answers into the
        store itself (health, v1/radars, v1/radars/<id>/volumes), so a public
        bucket on its own serves the contract; only what changed is written.
        Clients filter by `since` themselves there (a bucket ignores it)."""
        if not self.storage.static_api:
            return 0
        now = self.now()
        docs = {"health": views.health(self.cfg, self.index), "v1/radars": views.radars(self.cfg, self.index, now)}
        for r in self.cfg.radars:
            docs[f"v1/radars/{r.id}/volumes"] = views.volumes(self.cfg, self.index, r.id, now)
        written = 0
        for key, doc in docs.items():
            body = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            h = hashlib.sha256(body).hexdigest()
            if self._static_hash.get(key) == h:
                continue
            try:
                self.storage.put_public(key, body, "application/json", "public, max-age=10")
                self._static_hash[key] = h
                written += 1
            except Exception as e:
                log.warning("static %s not written: %s", key, e)
        return written

    def finish_round(self) -> None:
        self.prune()
        self._save()
        self.publish_static()

    # --- driving it ------------------------------------------------------------
    def poll_once(self, radars: Optional[list[str]] = None, recheck: Optional[float] = None) -> list[RadarReport]:
        """Every active radar once (due or not), `concurrency` at a time, then
        prune and write the index: what --once and the tests run. A radar
        left with files waiting for their second listing (no modification
        time) is polled again after `recheck` seconds (default [relay]
        recheck_seconds), and its report covers both polls."""
        ids = [r for r in (radars or self.active) if r in self.sources]
        if not ids:
            self.finish_round()
            return []
        with ThreadPoolExecutor(max_workers=max(1, min(self.cfg.concurrency, len(ids))),
                                thread_name_prefix="relay-poll") as pool:
            reports = list(pool.map(self.poll_radar, ids))
            again = [r.radar for r in reports if r.confirming and not r.error]
            if again and not self._stop.is_set():
                pause = float(self.cfg.recheck_seconds if recheck is None else recheck)
                log.info("%s: %d files listed without a modification time; listing again in %g s to confirm "
                         "their sizes", ", ".join(again), sum(r.confirming for r in reports), pause)
                if pause > 0:
                    self._stop.wait(pause)
                if not self._stop.is_set():
                    later = {r.radar: r for r in pool.map(self.poll_radar, again)}
                    reports = [r.then(later[r.radar]) if r.radar in later else r for r in reports]
        self.finish_round()
        return reports

    def run_forever(self, stop: Optional[threading.Event] = None, tick: float = 1.0) -> None:
        """Poll each radar when it is due, until `stop` is set."""
        stop = stop or self._stop
        self._stop = stop
        if not self.sources:
            log.warning("nothing to poll: no radar has an enabled, configured source; serving what is stored")
        self.finish_round()
        inflight: dict[str, object] = {}
        last_round = time.monotonic()
        pool = ThreadPoolExecutor(max_workers=max(1, self.cfg.concurrency), thread_name_prefix="relay-poll")
        try:
            while not stop.is_set():
                now = self.now()
                for rid in self.active:
                    if rid not in inflight and self.state[rid].next_due <= now:
                        inflight[rid] = pool.submit(self.poll_radar, rid)
                finished = False
                for rid, fut in list(inflight.items()):
                    if fut.done():
                        inflight.pop(rid)
                        finished = True
                        exc = fut.exception()
                        if exc is not None:
                            log.error("%s: poll crashed: %r", rid, exc)
                            self.state[rid].next_due = self.now() + self._poll_s(rid)
                if finished or time.monotonic() - last_round >= self.cfg.poll_seconds:
                    self.finish_round()
                    last_round = time.monotonic()
                stop.wait(tick)
        finally:
            pool.shutdown(wait=True, cancel_futures=True)
            self._save()
