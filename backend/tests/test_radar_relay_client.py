"""
radar_relay_client against a fake relay: the relay API (contract v1.1, or v1
with legacy=True) served by http.server from a temporary folder, synced into
a temporary store.

Run from the repository root:
    backend/.venv/Scripts/python.exe -m unittest discover -s backend/tests -v
"""
from __future__ import annotations

import gzip
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, unquote, urlsplit

import requests

BACKEND = Path(__file__).resolve().parents[1]
# The tests' own store, set before brazil_radar is imported: the user's
# volumes are never read or written.
_TMP = Path(tempfile.mkdtemp(prefix="weatherts-relay-test-"))
os.environ["WEATHERTS_RADAR_BR"] = str(_TMP / "store")
_ENV = ("WEATHERTS_RADAR_RELAY", "WEATHERTS_RADAR_RELAY_POLL", "WEATHERTS_RADAR_RELAY_HOURS",
        "WEATHERTS_RADAR_RELAY_RADARS")
for _k in _ENV:
    os.environ.pop(_k, None)
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import brazil_radar  # noqa: E402
import radar_relay_client  # noqa: E402

# A real volume: the Sao Paulo archive case (GAMIC HDF5), copied -- never moved or changed.
_ARCHIVE = Path.home() / ".weatherts" / "radar-br" / "BR-PNV" / "20230218220003" / "PNOVA2-20230218220003.HDF5"
_HAD_EXTRA = hasattr(brazil_radar, "EXTRA_SITES")
_EXTRA_BEFORE = getattr(brazil_radar, "EXTRA_SITES", None)
# The relay's clock for "added": nowhere near this machine's, as a relay's may be.
_RELAY_CLOCK = 5_000_000
# The host the client must never request. Only its root appears here, as a
# redirect target the client refuses before any request is made.
_FORBIDDEN = "mapainterativo.cemaden.gov.br"


def tearDownModule() -> None:  # noqa: N802 - unittest's name
    if _HAD_EXTRA:
        brazil_radar.EXTRA_SITES = _EXTRA_BEFORE
    elif hasattr(brazil_radar, "EXTRA_SITES"):
        delattr(brazil_radar, "EXTRA_SITES")
    shutil.rmtree(_TMP, ignore_errors=True)


def _unix(stamp: str) -> int:
    return int(datetime.strptime(stamp, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).timestamp())


def _ago(hours: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y%m%d%H%M%S")


def fake_import(name: str, raw: bytes) -> dict:
    """What import_file does, minus reading the file: "AAA_<stamp>_<moment>.vol"
    says the radar (BR-AAA) and the time."""
    site, stamp, _ = name.split("_")
    vdir = brazil_radar.STORE / f"BR-{site}" / stamp
    vdir.mkdir(parents=True, exist_ok=True)
    (vdir / name).write_bytes(raw)
    try:
        info = json.loads((vdir / "info.json").read_text(encoding="utf-8"))
    except OSError:
        info = {}
    info.update(radar=f"BR-{site}", stamp=stamp, unix=_unix(stamp), lat=-10.0, lon=-40.0,
                files=sorted(set(info.get("files", [])) | {name}))
    (vdir / "info.json").write_text(json.dumps(info), encoding="utf-8")
    return {"radar": f"BR-{site}", "stamp": stamp}


class RecordingSession(requests.Session):
    """A requests session that notes every URL asked for, and refuses to send
    one to the forbidden host even if the client let it through."""

    def __init__(self) -> None:
        super().__init__()
        self.urls: list[str] = []

    def get(self, url, **kw):  # noqa: D401 - requests' name
        self.urls.append(url)
        if radar_relay_client._forbidden(url):  # noqa: SLF001
            raise RuntimeError("test: the client tried to request the forbidden host")
        return super().get(url, **kw)


class FakeRelay:
    """The relay contract, served from root/<radar id>/<stamp>/<file>; each
    file's "added" from the shared `added` map (the relay's clock)."""

    def __init__(self, root: Path, added: dict, retention_hours: float = 36.0, broken=(), sizes=None,
                 legacy: bool = False, redirect: str = ""):
        self.root = root
        self.added = added
        self.retention_hours = retention_hours
        self.broken = set(broken)           # radars whose volume listing answers 500
        self.sizes = dict(sizes or {})      # file name -> size to list instead of the real one
        self.legacy = legacy                # contract v1: no "added", "updated" or addedSince
        self.redirect = redirect            # "blob": files 302 to /blob/...; "forbidden": 302 to the map
        self.file_hits: list[str] = []
        self.queries: dict[str, list[dict]] = {}
        relay = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # noqa: D401 - quiet
                pass

            def do_GET(self):  # noqa: N802 - http.server's name
                relay.route(self)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def volumes(self, rid: str, since=None, added_since=None) -> list[dict]:
        out = []
        rdir = self.root / rid
        for vdir in sorted(rdir.iterdir()) if rdir.is_dir() else ():
            unix = _unix(vdir.name)
            if since is not None and unix <= since:
                continue
            files = []
            for p in sorted(vdir.iterdir()):
                f = {"name": p.name, "size": self.sizes.get(p.name, p.stat().st_size),
                     "url": f"/v1/files/{rid}/{vdir.name}/{p.name}"}
                if not self.legacy:
                    f["added"] = self.added.get((rid, vdir.name, p.name), unix)
                files.append(f)
            v = {"stamp": vdir.name, "unix": unix, "files": files}
            if not self.legacy:
                v["added"] = max(f["added"] for f in files)
                if added_since is not None and v["added"] <= added_since:
                    continue
            out.append(v)
        return out

    @staticmethod
    def send(h, body: bytes, status: int = 200, ctype: str = "application/json", extra=None) -> None:
        h.send_response(status)
        h.send_header("Content-Type", ctype)
        h.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            h.send_header(k, v)
        h.end_headers()
        h.wfile.write(body)

    def json(self, h, data, status: int = 200) -> None:
        self.send(h, json.dumps(data).encode(), status)

    def route(self, h) -> None:
        parts = urlsplit(h.path)
        segs = [unquote(s) for s in parts.path.strip("/").split("/")]
        rids = sorted(d.name for d in self.root.iterdir() if d.is_dir()) if self.root.is_dir() else []
        if segs == ["health"]:
            return self.json(h, {"ok": True, "radars": len(rids)})
        if segs == ["v1", "radars"]:
            radars = []
            for rid in rids:
                vols = self.volumes(rid)
                e = {"id": rid, "name": f"Radar {rid[3:]}", "lat": -10.0, "lon": -40.0,
                     "newest": vols[-1]["unix"] if vols else None, "volumes": len(vols)}
                if not self.legacy:
                    e["updated"] = max((v["added"] for v in vols), default=None)
                radars.append(e)
            return self.json(h, {"retentionHours": self.retention_hours, "radars": radars})
        if len(segs) == 4 and segs[:2] == ["v1", "radars"] and segs[3] == "volumes":
            rid = segs[2]
            if rid in self.broken:
                return self.json(h, {"detail": "broken on purpose"}, 500)
            if rid not in rids:
                return self.json(h, {"detail": "unknown radar"}, 404)
            q = {k: int(v[0]) for k, v in parse_qs(parts.query).items()}
            self.queries.setdefault(rid, []).append(q)
            added_since = None if self.legacy else q.get("addedSince")
            return self.json(h, {"radar": rid, "volumes": self.volumes(rid, q.get("since"), added_since)})
        via_blob = len(segs) == 4 and segs[0] == "blob"     # the relay's public bucket
        if via_blob or (len(segs) == 5 and segs[:2] == ["v1", "files"]):
            rid, stamp, name = segs[-3:]
            p = self.root / rid / stamp / name
            if not p.is_file():
                return self.json(h, {"detail": "pruned"}, 404)
            if not via_blob and self.redirect == "blob":
                return self.send(h, b"", 302, extra={"Location": f"/blob/{rid}/{stamp}/{name}"})
            if not via_blob and self.redirect == "forbidden":
                return self.send(h, b"", 302, extra={"Location": f"http://{_FORBIDDEN}/"})
            self.file_hits.append(name)
            return self.send(h, p.read_bytes(), ctype="application/octet-stream",
                             extra={"Cache-Control": "public, max-age=129600, immutable"})
        return self.json(h, {"detail": "not found"}, 404)


class RelayClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(dir=_TMP))
        self.store = self.root / "store"
        self.store.mkdir()
        brazil_radar.STORE = self.store
        # Nothing here may ever reach the user's own store.
        self.assertTrue(str(brazil_radar.STORE).startswith(str(_TMP)))
        self.relay_root = self.root / "relay"
        self.relay_root.mkdir()
        self.relays: list[FakeRelay] = []
        self.added: dict = {}
        self.clock = _RELAY_CLOCK

    def tearDown(self) -> None:
        radar_relay_client.stop()
        t = radar_relay_client._PRUNE_THREAD  # noqa: SLF001
        if t is not None:
            t.join(10)
        for k in _ENV:
            os.environ.pop(k, None)
        for r in self.relays:
            r.close()
        with brazil_radar._LOCK:  # noqa: SLF001
            brazil_radar._VOLUMES.clear()  # noqa: SLF001
            brazil_radar._GRIDS.clear()  # noqa: SLF001

    def relay(self, **kw) -> FakeRelay:
        r = FakeRelay(self.relay_root, self.added, **kw)
        self.relays.append(r)
        return r

    def relay_file(self, rid: str, stamp: str, name: str, data: bytes = b"", src: Path = None,
                   added: int = None) -> Path:
        """A file the relay has committed: at `added` on its clock, else the next second of it."""
        d = self.relay_root / rid / stamp
        d.mkdir(parents=True, exist_ok=True)
        if src is not None:
            shutil.copyfile(src, d / name)
        else:
            (d / name).write_bytes(data)
        if added is None:
            self.clock += 1
            added = self.clock
        self.added[(rid, stamp, name)] = added
        return d / name

    def local_volume(self, radar: str, stamp: str, extra: dict) -> Path:
        vdir = self.store / radar / stamp
        vdir.mkdir(parents=True)
        name = f"{stamp}00dBZ.vol"
        (vdir / name).write_bytes(b"volume")
        info = {"radar": radar, "stamp": stamp, "unix": _unix(stamp), "files": [name], "moments": ["DBZH"],
                "lat": 0.0, "lon": 0.0, **extra}
        (vdir / "info.json").write_text(json.dumps(info), encoding="utf-8")
        return vdir

    def marked(self, radar: str, stamp: str, relay_stamp: str = None) -> Path:
        rs = relay_stamp or stamp
        return self.local_volume(radar, stamp, {"source": "relay",
                                                "relay": {"radar": radar, "stamp": rs, "unix": _unix(rs)}})

    @staticmethod
    def wait_for(cond, timeout: float = 15.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if cond():
                return True
            time.sleep(0.05)
        return cond()

    # ------------------------------------------------------------------
    @unittest.skipUnless(_ARCHIVE.is_file(), "the BR-PNV archive volume is not on this machine")
    def test_sync_imports_marks_and_never_downloads_twice(self) -> None:
        recent = _ago(1)
        self.relay_file("BR-PNV", recent, _ARCHIVE.name, src=_ARCHIVE)
        # A radar whose listing fails: the others go on.
        self.relay_file("BR-MCZ", recent, f"{recent}00dBZ.vol", b"<volume/>")
        relay = self.relay(broken={"BR-MCZ"})
        client = radar_relay_client.Client(relay.url, radars=["BR-PNV", "BR-MCZ"])

        s1 = client.sync_once()
        self.assertEqual(s1["files"], 1)
        self.assertEqual(relay.file_hits, [_ARCHIVE.name])
        vols = brazil_radar.volumes("BR-PNV")
        self.assertEqual(len(vols), 1)
        v = vols[0]
        self.assertEqual(v["source"], "relay")
        self.assertEqual(v["relay"], {"radar": "BR-PNV", "stamp": recent, "unix": _unix(recent)})
        self.assertEqual(v["files"], [_ARCHIVE.name])
        self.assertIn("RHOHV", v["moments"])        # what import_file wrote is kept
        self.assertEqual((self.store / "BR-PNV" / v["stamp"] / _ARCHIVE.name).stat().st_size,
                         _ARCHIVE.stat().st_size)
        self.assertEqual(brazil_radar.scans("BR-PNV")[-1]["key"], f"L2BR:{v['stamp']}")
        st = client.status()
        self.assertIsNone(st["lastError"])
        self.assertEqual(st["contract"], "1.1")
        self.assertEqual(st["radars"]["BR-PNV"]["volumes"], 1)
        self.assertEqual(st["radars"]["BR-PNV"]["newest"], _unix(recent))
        self.assertTrue(st["radars"]["BR-MCZ"]["lastError"])
        # The first pass lists the whole window, by "since" alone.
        first = relay.queries["BR-PNV"][0]
        self.assertNotIn("addedSince", first)
        self.assertLessEqual(abs(first["since"] - (time.time() - 36 * 3600)), 120)

        # Second pass: from the arrival cursor, nothing downloaded again.
        s2 = client.sync_once()
        self.assertEqual(s2["files"], 0)
        self.assertEqual(len(relay.file_hits), 1)
        self.assertEqual(relay.queries["BR-PNV"][-1]["addedSince"],
                         self.added[("BR-PNV", recent, _ARCHIVE.name)] - 1)

        # After a restart the store says what is here.
        s3 = radar_relay_client.Client(relay.url, radars=["BR-PNV"]).sync_once()
        self.assertEqual(s3["files"], 0)
        self.assertEqual(len(relay.file_hits), 1)
        self.assertEqual(len(brazil_radar.volumes("BR-PNV")), 1)
        # The original archive file is untouched.
        self.assertTrue(_ARCHIVE.is_file())

    def test_newest_first_radars_in_turn_and_bounded(self) -> None:
        """With a pass capped at 3 files: each radar's present first, the
        history after, over passes that follow at once ("more")."""
        h3, h2, h1 = _ago(3), _ago(2), _ago(1)
        for stamp in (h3, h2, h1):
            for m in ("dBZ", "vel"):
                self.relay_file("BR-AAA", stamp, f"AAA_{stamp}_{m}.vol", b"a" * 10)
        for stamp in (h2, h1):
            self.relay_file("BR-BBB", stamp, f"BBB_{stamp}_dBZ.vol", b"b" * 10)
        relay = self.relay()
        client = radar_relay_client.Client(relay.url, radars=["BR-AAA", "BR-BBB"])
        with mock.patch.object(brazil_radar, "import_file", fake_import), \
                mock.patch.object(radar_relay_client, "_MAX_FILES", 3):
            s1 = client.sync_once()
            self.assertEqual(relay.file_hits, [f"AAA_{h1}_dBZ.vol", f"AAA_{h1}_vel.vol", f"BBB_{h1}_dBZ.vol"])
            self.assertTrue(s1["more"])
            s2 = client.sync_once()
            self.assertEqual(relay.file_hits[3:], [f"AAA_{h2}_dBZ.vol", f"AAA_{h2}_vel.vol", f"BBB_{h2}_dBZ.vol"])
            self.assertTrue(s2["more"])
            s3 = client.sync_once()
            self.assertEqual(relay.file_hits[6:], [f"AAA_{h3}_dBZ.vol", f"AAA_{h3}_vel.vol"])
            self.assertFalse(s3["more"])
            self.assertEqual(client.sync_once()["files"], 0)
        self.assertEqual(len(relay.file_hits), 8)
        for rid, n in (("BR-AAA", 3), ("BR-BBB", 2)):
            vols = brazil_radar.volumes(rid)
            self.assertEqual(len(vols), n)
            self.assertTrue(all(v["source"] == "relay" and v["relay"]["radar"] == rid for v in vols))

    def test_untouched_radars_are_listed_never_downloaded(self) -> None:
        """On demand: every relay radar in the picker, only the touched one
        synced -- its newest volume first -- and only for the follow window."""
        h3, h2, h1 = _ago(3), _ago(2), _ago(1)
        for stamp in (h3, h2, h1):
            self.relay_file("BR-AAA", stamp, f"AAA_{stamp}_dBZ.vol", b"a" * 10)
            self.relay_file("BR-BBB", stamp, f"BBB_{stamp}_dBZ.vol", b"b" * 10)
        relay = self.relay()
        client = radar_relay_client.Client(relay.url)
        with mock.patch.object(brazil_radar, "import_file", fake_import):
            s = client.sync_once()
            self.assertEqual((s["files"], relay.file_hits, relay.queries), (0, [], {}))
            self.assertEqual(list(self.store.iterdir()), [])
            sites = {e["id"]: e for e in client.sites()}
            self.assertEqual(sorted(sites), ["BR-AAA", "BR-BBB"])
            for rid, e in sites.items():
                self.assertEqual(set(e), {"id", "name", "lat", "lon", "newest", "live", "operator"})
                self.assertEqual((e["newest"], e["live"]), (_unix(h1), True))
                self.assertEqual((e["lat"], e["lon"]), (-10.0, -40.0))
            self.assertEqual(client.status()["followed"], [])

            client.touch("br-aaa", wait=0)
            client.sync_once()
            self.assertEqual(relay.file_hits, [f"AAA_{h1}_dBZ.vol", f"AAA_{h2}_dBZ.vol", f"AAA_{h3}_dBZ.vol"])
            self.assertNotIn("BR-BBB", relay.queries)
            self.assertNotIn("addedSince", relay.queries["BR-AAA"][0])  # a first touch lists the whole window
            self.assertFalse((self.store / "BR-BBB").exists())
            followed = client.status()["followed"]
            self.assertEqual([f["id"] for f in followed], ["BR-AAA"])
            self.assertLessEqual(abs(followed[0]["lastTouch"] - time.time()), 5)
            self.assertFalse(followed[0]["always"])
            self.assertTrue(followed[0]["onRelay"])

            # An hour without a touch: no longer followed, a new volume waits.
            new = _ago(0.2)
            self.relay_file("BR-AAA", new, f"AAA_{new}_dBZ.vol", b"a" * 10)
            with client._lock:  # noqa: SLF001
                client._touched["BR-AAA"] -= 3700  # noqa: SLF001
            client.sync_once()
            self.assertEqual(len(relay.file_hits), 3)
            self.assertEqual(client.status()["followed"], [])
            client.touch("BR-AAA", wait=0)      # touched again: in it comes
            client.sync_once()
            self.assertEqual(relay.file_hits[3:], [f"AAA_{new}_dBZ.vol"])
            self.assertNotIn("addedSince", relay.queries["BR-AAA"][-1])
            # A radar the relay does not list is noted, never asked for.
            client.touch("BR-PNV", wait=0)
            client.sync_once()
            self.assertNotIn("BR-PNV", relay.queries)
            self.assertFalse([f for f in client.status()["followed"] if f["id"] == "BR-PNV"][0]["onRelay"])

    def test_first_touch_wakes_the_thread_and_waits_for_the_newest(self) -> None:
        h3, h2, h1 = _ago(3), _ago(2), _ago(1)
        for stamp in (h3, h2, h1):
            for m in ("dBZ", "vel"):
                self.relay_file("BR-AAA", stamp, f"AAA_{stamp}_{m}.vol", b"a" * 10)
            self.relay_file("BR-BBB", stamp, f"BBB_{stamp}_dBZ.vol", b"b" * 10)
        relay = self.relay()
        os.environ["WEATHERTS_RADAR_RELAY"] = relay.url
        os.environ["WEATHERTS_RADAR_RELAY_POLL"] = "600"     # only a touch starts the next pass
        with mock.patch.object(brazil_radar, "import_file", fake_import):
            self.assertTrue(radar_relay_client.start())
            self.assertTrue(self.wait_for(lambda: radar_relay_client.status()["lastSync"]))
            self.assertEqual(relay.file_hits, [])
            self.assertEqual(sorted(e["id"] for e in brazil_radar.EXTRA_SITES()), ["BR-AAA", "BR-BBB"])

            t0 = time.time()
            radar_relay_client.touch("BR-AAA")
            took = time.time() - t0
            newest = {f"AAA_{h1}_dBZ.vol", f"AAA_{h1}_vel.vol"}
            self.assertLess(took, 1.6)
            # Either the newest volume was in when the touch returned, or the touch waited its second out.
            self.assertTrue(newest <= set(relay.file_hits) or took >= 0.9, (took, relay.file_hits))
            self.assertTrue(self.wait_for(lambda: len(relay.file_hits) == 6))
            self.assertEqual(set(relay.file_hits[:2]), newest)
            self.assertEqual(relay.file_hits[2:], [f"AAA_{h2}_dBZ.vol", f"AAA_{h2}_vel.vol",
                                                   f"AAA_{h3}_dBZ.vol", f"AAA_{h3}_vel.vol"])
            # A touch after the first returns at once.
            t0 = time.time()
            radar_relay_client.touch("BR-AAA")
            self.assertLess(time.time() - t0, 0.2)
            radar_relay_client.stop()
        self.assertNotIn("BR-BBB", relay.queries)
        self.assertEqual(len(brazil_radar.volumes("BR-AAA")), 3)
        self.assertIsNone(brazil_radar.EXTRA_SITES)

    def test_a_backlog_fetched_late_arrives_by_added_since(self) -> None:
        """Volumes the relay fetched late, with stamps older than what is here
        already, come in by their arrival on the relay's clock."""
        h3, h2, h1 = _ago(3), _ago(2), _ago(1)
        for stamp in (h3, h2, h1):
            self.relay_file("BR-AAA", stamp, f"AAA_{stamp}_dBZ.vol", b"a" * 10)
        relay = self.relay()
        client = radar_relay_client.Client(relay.url, radars=["BR-AAA"])
        with mock.patch.object(brazil_radar, "import_file", fake_import):
            self.assertEqual(client.sync_once()["files"], 3)
            cursor = max(self.added.values())
            self.assertEqual(client.status()["radars"]["BR-AAA"]["cursor"], cursor)
            # The relay catches up an outage: an older volume, and a moment of one kept here.
            h6 = _ago(6)
            self.relay_file("BR-AAA", h6, f"AAA_{h6}_dBZ.vol", b"a" * 10)
            self.relay_file("BR-AAA", h2, f"AAA_{h2}_vel.vol", b"a" * 10)
            s = client.sync_once()
            self.assertEqual(s["files"], 2)
            self.assertEqual(relay.file_hits[3:], [f"AAA_{h2}_vel.vol", f"AAA_{h6}_dBZ.vol"])
            q = relay.queries["BR-AAA"][-1]
            self.assertEqual(q["addedSince"], cursor - 1)
            self.assertLessEqual(abs(q["since"] - (time.time() - 36 * 3600)), 120)
            # A file committed in the cursor's own second still comes.
            same = self.added[("BR-AAA", h2, f"AAA_{h2}_vel.vol")]
            self.relay_file("BR-AAA", h3, f"AAA_{h3}_vel.vol", b"a" * 10, added=same)
            self.assertEqual(client.sync_once()["files"], 1)
            self.assertEqual(client.sync_once()["files"], 0)
        self.assertEqual(len(relay.file_hits), 6)
        self.assertEqual(len(brazil_radar.volumes("BR-AAA")), 4)
        self.assertEqual(sorted(brazil_radar.volumes("BR-AAA")[1]["files"]),
                         [f"AAA_{h3}_dBZ.vol", f"AAA_{h3}_vel.vol"])

    def test_a_v1_relay_is_listed_over_the_whole_window(self) -> None:
        h2, h1 = _ago(2), _ago(1)
        for stamp in (h2, h1):
            self.relay_file("BR-AAA", stamp, f"AAA_{stamp}_dBZ.vol", b"a" * 10)
        relay = self.relay(legacy=True)
        client = radar_relay_client.Client(relay.url, radars=["BR-AAA"])
        with mock.patch.object(brazil_radar, "import_file", fake_import):
            self.assertEqual(client.sync_once()["files"], 2)
            h5 = _ago(5)
            self.relay_file("BR-AAA", h5, f"AAA_{h5}_dBZ.vol", b"a" * 10)
            self.assertEqual(client.sync_once()["files"], 1)
            self.assertEqual(client.sync_once()["files"], 0)
        self.assertEqual(relay.file_hits[2:], [f"AAA_{h5}_dBZ.vol"])
        for q in relay.queries["BR-AAA"]:
            self.assertEqual(set(q), {"since"})
            self.assertLessEqual(abs(q["since"] - (time.time() - 36 * 3600)), 120)
        self.assertEqual(client.status()["contract"], "1")

    def test_an_archive_relay_feeds_a_long_window(self) -> None:
        """A relay keeping 8760 h (the NASA demo) feeds a client keeping as
        long; with the default 36 h nothing that old is taken."""
        old = _ago(5000)
        self.relay_file("BR-AAA", old, f"AAA_{old}_dBZ.vol", b"a" * 10)
        relay = self.relay(retention_hours=8760)
        with mock.patch.object(brazil_radar, "import_file", fake_import):
            short = radar_relay_client.Client(relay.url, radars=["BR-AAA"])
            self.assertEqual(short.sync_once()["files"], 0)
            self.assertEqual(short.status()["retentionHours"], 36)
            client = radar_relay_client.Client(relay.url, hours=8760, radars=["BR-AAA"])
            s = client.sync_once()
        self.assertEqual((s["files"], s["pruned"]), (1, 0))
        self.assertEqual(client.status()["retentionHours"], 8760)
        self.assertLessEqual(abs(relay.queries["BR-AAA"][-1]["since"] - (time.time() - 8760 * 3600)), 120)
        self.assertEqual([v["stamp"] for v in brazil_radar.volumes("BR-AAA")], [old])
        self.assertEqual(client.prune(rescan=True), 0)
        os.environ["WEATHERTS_RADAR_RELAY_HOURS"] = "8760"
        self.assertEqual(radar_relay_client.config()["retentionHours"], 8760)
        os.environ["WEATHERTS_RADAR_RELAY_HOURS"] = "100000"
        self.assertEqual(radar_relay_client.config()["retentionHours"], 9600)

    def test_bytes_arrive_exactly_as_the_relay_keeps_them(self) -> None:
        """A ".cf.gz" stays gzip: compression added on the way is undone, a
        stored .gz labelled gzip-encoded is kept as it is."""
        recent = _ago(1)
        inner = os.urandom(3000) + b"\0" * 20000
        gz_name = f"MC1_{recent[:4]}_{recent[4:8]}_{recent[8:]}.cf.gz"
        vol_name = f"{recent}00dBZ.vol"
        stored = {gz_name: gzip.compress(inner), vol_name: b"<volume>" + inner}
        for name, data in stored.items():
            self.relay_file("BR-MCZ", recent, name, data)
        relay = self.relay()
        sent = {gz_name: stored[gz_name], vol_name: gzip.compress(stored[vol_name])}
        original = FakeRelay.send

        def send(h, body, status=200, ctype="application/json", extra=None):
            name = h.path.rsplit("/", 1)[-1]
            if name in sent:        # both answered as "Content-Encoding: gzip"
                return original(h, sent[name], status, ctype, {**(extra or {}), "Content-Encoding": "gzip"})
            return original(h, body, status, ctype, extra)

        got = {}

        def import_mcz(name: str, raw: bytes) -> dict:
            got[name] = raw
            vdir = brazil_radar.STORE / "BR-MCZ" / recent
            vdir.mkdir(parents=True, exist_ok=True)
            (vdir / name).write_bytes(raw)
            try:
                info = json.loads((vdir / "info.json").read_text(encoding="utf-8"))
            except OSError:
                info = {}
            info.update(radar="BR-MCZ", stamp=recent, unix=_unix(recent),
                        files=sorted(set(info.get("files", [])) | {name}))
            (vdir / "info.json").write_text(json.dumps(info), encoding="utf-8")
            return {"radar": "BR-MCZ", "stamp": recent}

        with mock.patch.object(FakeRelay, "send", staticmethod(send)), \
                mock.patch.object(brazil_radar, "import_file", import_mcz):
            s = radar_relay_client.Client(relay.url, radars=["BR-MCZ"]).sync_once()
        self.assertEqual((s["files"], s["errors"]), (2, 0))
        self.assertEqual(got, stored)

    def test_size_mismatch_is_not_imported_and_waits(self) -> None:
        recent = _ago(2)
        name = f"{recent}00dBZ.vol"
        self.relay_file("BR-NAT", recent, name, b"x" * 100)
        relay = self.relay(sizes={name: 99})
        client = radar_relay_client.Client(relay.url, radars=["BR-NAT"])
        s = client.sync_once()
        self.assertEqual((s["files"], s["errors"]), (0, 1))
        self.assertEqual(relay.file_hits, [name])
        self.assertIn("listing says 99", client.status()["radars"]["BR-NAT"]["lastError"])
        self.assertEqual(list(self.store.iterdir()), [])
        # The file waits out its backoff, and the cursor stays below it.
        client.sync_once()
        self.assertEqual(relay.file_hits, [name])
        self.assertEqual(relay.queries["BR-NAT"][-1]["addedSince"], self.added[("BR-NAT", recent, name)] - 2)

    def test_redirects_are_followed_by_hand_and_checked(self) -> None:
        recent = _ago(1)
        name = f"AAA_{recent}_dBZ.vol"
        self.relay_file("BR-AAA", recent, name, b"a" * 10)
        # A relay that sends the bytes from its public bucket: followed.
        blob = self.relay(redirect="blob")
        with mock.patch.object(brazil_radar, "import_file", fake_import):
            s = radar_relay_client.Client(blob.url, radars=["BR-AAA"]).sync_once()
        self.assertEqual((s["files"], blob.file_hits), (1, [name]))
        shutil.rmtree(self.store / "BR-AAA")

        # A redirect to CEMADEN's map: refused before any request goes there.
        bad = self.relay(redirect="forbidden")
        session = RecordingSession()
        client = radar_relay_client.Client(bad.url, radars=["BR-AAA"], session=session)
        with mock.patch.object(brazil_radar, "import_file", fake_import):
            s = client.sync_once()
        self.assertEqual((s["files"], s["errors"]), (0, 1))
        self.assertFalse([u for u in session.urls if radar_relay_client._forbidden(u)])  # noqa: SLF001
        self.assertTrue(session.urls)
        self.assertIn("refusing", client.status()["radars"]["BR-AAA"]["lastError"])
        self.assertFalse((self.store / "BR-AAA").exists())

        # Nor is a relay on that host followed at all, however it is spelt.
        for base in (f"https://{_FORBIDDEN}", f"http://WWW.{_FORBIDDEN.upper()}./", f"https://{_FORBIDDEN}:443"):
            self.assertFalse(radar_relay_client._allowed(base), base)  # noqa: SLF001
            with self.assertRaises(ValueError):
                radar_relay_client.Client(base)
            os.environ["WEATHERTS_RADAR_RELAY"] = base
            self.assertFalse(radar_relay_client.enabled())
            self.assertFalse(radar_relay_client.start())
        self.assertTrue(radar_relay_client._allowed("https://relay.weatherts.tech"))  # noqa: SLF001
        self.assertTrue(radar_relay_client._allowed("https://cemaden.gov.br.example.org"))  # noqa: SLF001

    def test_prune_removes_only_old_relayed_volumes(self) -> None:
        old, older, recent = _ago(50), _ago(80), _ago(3)
        gone_a = self.marked("BR-MCZ", old)
        gone_b = self.local_volume("BR-MCZ", older, {"source": "relay"})    # no relay stamp: the folder's
        kept = self.marked("BR-MCZ", recent)
        # Aged by the relay's stamp, not the time inside the file.
        kept_by_stamp = self.marked("BR-SSA", older, relay_stamp=recent)
        archive = self.local_volume("BR-PNV", "20230218220003", {})     # no mark: never touched
        with brazil_radar._LOCK:  # noqa: SLF001
            brazil_radar._VOLUMES[("BR-MCZ", old)] = "cached"  # noqa: SLF001
            brazil_radar._GRIDS[("BR-MCZ", old, "L2B0")] = "cached"  # noqa: SLF001
            brazil_radar._GRIDS[("BR-MCZ", old, "L2VCR")] = "cached"  # noqa: SLF001
            brazil_radar._VOLUMES[("BR-PNV", "20230218220003")] = "cached"  # noqa: SLF001
            brazil_radar._GRIDS[("BR-PNV", "20230218220003", "L2B0")] = "cached"  # noqa: SLF001
        relay = self.relay()        # a relay with nothing to give
        s = radar_relay_client.Client(relay.url).sync_once()
        self.assertEqual(s["pruned"], 2)
        self.assertFalse(gone_a.exists())
        self.assertFalse(gone_b.exists())
        self.assertTrue((kept / "info.json").is_file())
        self.assertTrue((kept_by_stamp / "info.json").is_file())
        self.assertEqual(sorted(p.name for p in archive.iterdir()), ["2023021822000300dBZ.vol", "info.json"])
        self.assertEqual([v["stamp"] for v in brazil_radar.volumes("BR-MCZ")], [recent])
        self.assertNotIn(("BR-MCZ", old), brazil_radar._VOLUMES)  # noqa: SLF001
        self.assertFalse([k for k in brazil_radar._GRIDS if k[1] == old])  # noqa: SLF001
        self.assertIn(("BR-PNV", "20230218220003"), brazil_radar._VOLUMES)  # noqa: SLF001
        self.assertIn(("BR-PNV", "20230218220003", "L2B0"), brazil_radar._GRIDS)  # noqa: SLF001

    def test_startup_prune_runs_with_the_relay_off(self) -> None:
        a, b, c, d = _ago(50), _ago(120), _ago(3), _ago(80)
        mark_50 = self.marked("BR-MCZ", a)
        mark_120 = self.marked("BR-MCZ", b)
        mark_3 = self.marked("BR-MCZ", c)
        users = self.local_volume("BR-MCZ", d, {})                          # the user's own import
        by_stamp = self.marked("BR-SSA", b, relay_stamp=c)                 # the relay's stamp is recent
        archive = self.local_volume("BR-PNV", "20230218220003", {})
        self.assertEqual(radar_relay_client.prune_store(hours=100), 1)
        self.assertFalse(mark_120.exists())
        self.assertTrue(mark_50.exists())

        self.assertFalse(radar_relay_client.enabled())
        self.assertFalse(radar_relay_client.start())        # no relay: the startup prune, 36 h
        radar_relay_client._PRUNE_THREAD.join(10)  # noqa: SLF001
        self.assertFalse(mark_50.exists())
        for kept in (mark_3, users, by_stamp, archive):
            self.assertTrue((kept / "info.json").is_file(), kept)
        self.assertEqual(sorted(p.name for p in archive.iterdir()), ["2023021822000300dBZ.vol", "info.json"])
        self.assertEqual(radar_relay_client.status()["followed"], [])
        radar_relay_client.touch("BR-MCZ")      # no relay: nothing at all

    def test_the_relays_shorter_retention_wins(self) -> None:
        vdir = self.marked("BR-STE", _ago(30))
        client = radar_relay_client.Client(self.relay(retention_hours=24).url, hours=36)
        self.assertEqual(client.sync_once()["pruned"], 1)
        self.assertFalse(vdir.exists())
        self.assertEqual(client.status()["retentionHours"], 24)

    def test_disabled_without_a_relay(self) -> None:
        os.environ.pop("WEATHERTS_RADAR_RELAY", None)
        self.assertFalse(radar_relay_client.enabled())
        self.assertFalse(radar_relay_client.start())
        st = radar_relay_client.status()
        self.assertFalse(st["enabled"])
        self.assertFalse(st["running"])
        self.assertFalse([t for t in threading.enumerate() if t.name == "radar-relay" and t.is_alive()])
        os.environ["WEATHERTS_RADAR_RELAY"] = "ftp://example.invalid/radar"
        self.assertFalse(radar_relay_client.enabled())
        self.assertFalse(radar_relay_client.start())

    def test_start_follows_the_configured_relay(self) -> None:
        recent = _ago(1)
        self.relay_file("BR-AAA", recent, f"AAA_{recent}_dBZ.vol", b"a" * 10)
        relay = self.relay()
        os.environ["WEATHERTS_RADAR_RELAY"] = relay.url + "/"
        os.environ["WEATHERTS_RADAR_RELAY_RADARS"] = "br-aaa, nonsense"
        with mock.patch.object(brazil_radar, "import_file", fake_import):
            self.assertTrue(radar_relay_client.start())
            self.assertTrue(self.wait_for(lambda: radar_relay_client.status()["lastSync"]))
            st = radar_relay_client.status()
            self.assertTrue(st["enabled"])
            self.assertTrue(st["running"])
            self.assertEqual(st["relay"], relay.url)
            self.assertEqual(st["followed"], [{"id": "BR-AAA", "always": True, "lastTouch": None, "onRelay": True}])
            self.assertEqual(relay.file_hits, [f"AAA_{recent}_dBZ.vol"])   # always followed: no touch needed
            self.assertEqual([e["id"] for e in brazil_radar.EXTRA_SITES()], ["BR-AAA"])
            radar_relay_client.stop()
        self.assertFalse([t for t in threading.enumerate() if t.name == "radar-relay" and t.is_alive()])
        self.assertIsNone(brazil_radar.EXTRA_SITES)


if __name__ == "__main__":
    unittest.main()
