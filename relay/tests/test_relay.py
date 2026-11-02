"""
The relay end to end, on this machine: sources in temporary folders (and a
local HTTP server for the listing sources), storage in a temporary folder, a
fixed clock, and the API served by uvicorn on a free port.

    python -m unittest discover -s relay/tests -v      (from the repository)
    python -m unittest discover -s tests -v            (from relay/)

File contents are dummy bytes (the relay never reads them), except the NASA
file, which is real gzip so serving it undecompressed is checked.
"""
from __future__ import annotations

import contextlib
import ftplib
import functools
import gzip
import http.client
import http.server
import io
import json
import logging
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from unittest import mock
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import requests  # noqa: E402
import uvicorn  # noqa: E402

from relay import index as index_module  # noqa: E402
from relay import views  # noqa: E402
from relay.__main__ import main as relay_main  # noqa: E402
from relay.api import create_app  # noqa: E402
from relay.config import ConfigError, from_dict, load_config  # noqa: E402
from relay.index import Index  # noqa: E402
from relay.poller import Poller  # noqa: E402
from relay.sources import (FtpSource, HttpIndexSource, Source, SourceError, SourceGone, make_source,  # noqa: E402
                           parse_list_line)
from relay.stamps import parse_name, unix_stamp, valid_name  # noqa: E402
from relay.storage import IMMUTABLE, INDEX_KEY, LocalStorage, make_storage  # noqa: E402

logging.basicConfig(level=logging.CRITICAL)

NOW = datetime(2026, 10, 12, 12, 0, 0, tzinfo=timezone.utc).timestamp()
H = 3600.0


class Clock:
    def __init__(self, t: float):
        self.t = t

    def __call__(self) -> float:
        return self.t


def stamp(unix: float) -> str:
    return unix_stamp(unix)


def nasa_name(site: str, unix: float) -> str:
    d = datetime.fromtimestamp(unix, tz=timezone.utc)
    return f"{site}_{d:%Y}_{d:%m%d}_{d:%H%M%S}.cf.gz"


def write(path: Path, data: bytes) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ApiServer:
    """uvicorn in a background thread, on a free port."""

    def __init__(self, app):
        self.port = free_port()
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="critical",
                                                    lifespan="off"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        deadline = time.time() + 20
        while not self.server.started:
            if time.time() > deadline or not self.thread.is_alive():
                raise RuntimeError("uvicorn did not start")
            time.sleep(0.05)
        return f"http://127.0.0.1:{self.port}"

    def __exit__(self, *exc):
        self.server.should_exit = True
        self.thread.join(timeout=15)


class StaticServer:
    """http.server over a folder: its directory pages are Apache-like listings."""

    def __init__(self, root: Path):
        handler = functools.partial(_QuietHandler, directory=str(root))
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.requests: list[str] = _QuietHandler.log

    def __enter__(self) -> str:
        _QuietHandler.log.clear()
        _QuietHandler.calls.clear()
        self.thread.start()
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    log: list[str] = []
    calls: list[tuple[str, str]] = []     # (method, path)

    def log_message(self, fmt, *args):
        _QuietHandler.log.append(self.path)
        _QuietHandler.calls.append((self.command, self.path))


class Fixture:
    """Source folders with CEMADEN- and NASA-named files, a local store, and a
    configuration with four radars: two that work, one whose folder is
    missing (fails every poll), one CEMADEN radar not configured (idle)."""

    def __init__(self, tmp: Path, **storage):
        self.tmp = tmp
        self.src = tmp / "source"
        self.data = tmp / "data"
        self.bytes: dict[str, bytes] = {}
        self.s_new, self.s_mid, self.s_old = stamp(NOW - 1 * H), stamp(NOW - 2 * H), stamp(NOW - 40 * H)
        i = 0
        for s in (self.s_new, self.s_mid, self.s_old):
            for mom in ("dBZ", "V", "dBuZ", "uPhiDP"):
                i += 1
                name = f"{s}00{mom}.vol"
                self.bytes[name] = write(self.src / "maceio" / name, os.urandom(1000 + 37 * i))
            write(self.src / "maceio" / f"{s}00dBZ.vol.h5", os.urandom(500))   # the HDF5 copy: skipped
        write(self.src / "maceio" / "README.txt", b"not a volume")
        self.nasa_new = nasa_name("NT1", NOW - 3 * H)
        self.nasa_old = nasa_name("NT1", NOW - 50 * H)
        self.bytes[self.nasa_new] = write(self.src / "NT1" / self.nasa_new, gzip.compress(b"CfRadial" * 4000))
        write(self.src / "NT1" / self.nasa_old, gzip.compress(b"old" * 100))
        write(self.src / "NT1" / self.nasa_new.replace(".cf.gz", "_class_PPI.png"), b"\x89PNG")
        st = {"kind": "local", "path": str(self.data)}
        st.update(storage)
        self.cfg = from_dict({
            "relay": {"retention_hours": 36, "poll_seconds": 120, "concurrency": 2, "max_backoff_seconds": 1800},
            "storage": st,
            "sources": {
                "cem": {"type": "cemaden", "transport": "local", "path": str(self.src / "{site}")},
                "drop": {"type": "local", "path": str(self.src / "{SITE}"), "filename_regex": r"\.cf\.gz$"},
                "broken": {"type": "local", "path": str(tmp / "missing")},
                "cemaden_off": {"type": "cemaden", "enabled": False, "transport": "ftp", "host": ""},
            },
            "radars": [
                {"id": "BR-MCZ", "source": "cem"},
                {"id": "BR-NAT", "source": "drop", "site": "NT1"},
                {"id": "BR-SSA", "source": "broken"},
                {"id": "BR-ALM", "source": "cemaden_off"},
            ]}, base_dir=tmp)
        self.storage = make_storage(self.cfg)
        self.index = Index(self.storage).open()
        self.clock = Clock(NOW)
        self.poller = Poller(self.cfg, self.storage, self.index, now=self.clock)

    def kept(self, s: str) -> list[str]:
        return sorted(f"{s}00{m}.vol" for m in ("dBZ", "V"))


class TmpCase(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.tmp = Path(self._td.name)

    def tearDown(self):
        self._td.cleanup()


# ---------------------------------------------------------------------------
class TestNames(unittest.TestCase):
    def test_rainbow(self):
        p = parse_name("2026101207400500dBZ.vol")
        self.assertEqual((p.stamp, p.moment, p.fmt, p.kind), ("20261012074005", "dBZ", "vol", "rainbow"))
        self.assertEqual(p.unix, int(datetime(2026, 10, 12, 7, 40, 5, tzinfo=timezone.utc).timestamp()))
        self.assertEqual(parse_name("2026101207400500uPhiDP.vol.h5").fmt, "vol.h5")

    def test_nasa(self):
        p = parse_name("MC1_2026_0224_133002.cf.gz")
        self.assertEqual((p.stamp, p.site, p.kind), ("20260224133002", "MC1", "nasa_vn"))

    def test_generic(self):
        for n in ("radar_20261012-074005.h5", "X_20261012_074005.nc", "x20261012074005", "KTLX20261012_074005_V06"):
            self.assertEqual(parse_name(n).stamp, "20261012074005", n)
        for n in ("README.txt", "MC1_2026_0224_133002_class_PPI.png", "20261399999999.vol", "00000000000000"):
            self.assertIsNone(parse_name(n), n)

    def test_valid_name(self):
        for n in ("2026101207400500dBZ.vol", "MC1_2026_0224_133002.cf.gz"):
            self.assertTrue(valid_name(n))
        for n in ("..", "../x", "a/b", "a\\b", ".hidden", "C:x", "a..b", "", "x" * 200):
            self.assertFalse(valid_name(n), n)

    def test_ftp_list_lines(self):
        self.assertEqual(parse_list_line("-rw-r--r--   1 ftp ftp  6873211 Oct 12 07:47 2026101207400500dBZ.vol"),
                         ("2026101207400500dBZ.vol", 6873211, False))
        self.assertEqual(parse_list_line("drwxr-xr-x   2 ftp ftp     4096 Oct 12 07:47 2026"), ("2026", 4096, True))
        self.assertEqual(parse_list_line("10-12-26  07:47AM              6873211 2026101207400500dBZ.vol"),
                         ("2026101207400500dBZ.vol", 6873211, False))
        self.assertEqual(parse_list_line("10-12-26  07:47AM       <DIR>          maceio"), ("maceio", None, True))
        self.assertIsNone(parse_list_line("total 12"))


# ---------------------------------------------------------------------------
class TestPolling(TmpCase):
    def test_first_poll_stores_second_downloads_nothing(self):
        fx = Fixture(self.tmp)
        self.assertEqual(sorted(fx.poller.active), ["BR-MCZ", "BR-NAT", "BR-SSA"])   # BR-ALM idle
        reports = {r.radar: r for r in fx.poller.poll_once()}

        mcz = reports["BR-MCZ"]
        self.assertIsNone(mcz.error)
        self.assertEqual(mcz.downloaded, 4)          # 2 volumes in the window x dBZ, V
        self.assertEqual(sorted(mcz.names), sorted(fx.kept(fx.s_new) + fx.kept(fx.s_mid)))
        self.assertEqual(mcz.names[:2], fx.kept(fx.s_new))   # newest volume first
        self.assertEqual(reports["BR-NAT"].names, [fx.nasa_new])
        self.assertIsNotNone(reports["BR-SSA"].error)

        for s in (fx.s_new, fx.s_mid):
            for n in fx.kept(s):
                self.assertEqual((fx.data / "BR-MCZ" / s / n).read_bytes(), fx.bytes[n])
                self.assertEqual(fx.index.size("BR-MCZ", s, n), len(fx.bytes[n]))
        self.assertFalse((fx.data / "BR-MCZ" / fx.s_old).exists())     # older than the retention
        stored_nasa = fx.data / "BR-NAT" / parse_name(fx.nasa_new).stamp / fx.nasa_new
        self.assertEqual(stored_nasa.read_bytes(), fx.bytes[fx.nasa_new])    # still gzip, same bytes
        self.assertEqual(list((fx.data / ".staging").iterdir()), [])
        saved = json.loads((fx.data / INDEX_KEY).read_text())
        self.assertEqual(sorted(saved["radars"]), ["BR-MCZ", "BR-NAT"])

        # Second round: every file is in the index, nothing is fetched.
        calls = []
        for src in fx.poller.sources.values():
            orig = src.fetch
            src.fetch = lambda f, dest, mx, _o=orig: (calls.append(f.name), _o(f, dest, mx))[1]
        reports2 = {r.radar: r for r in fx.poller.poll_once()}
        self.assertEqual(calls, [])
        self.assertEqual(reports2["BR-MCZ"].downloaded, 0)
        self.assertEqual(reports2["BR-MCZ"].listed, 4)
        self.assertEqual(reports2["BR-NAT"].downloaded, 0)

    def test_failing_radar_backs_off_and_others_continue(self):
        fx = Fixture(self.tmp)
        fx.poller.poll_once()
        st = fx.poller.state["BR-SSA"]
        self.assertEqual(st.failures, 1)
        self.assertEqual(st.next_due, NOW + 120 * 2)
        fx.poller.poll_once()
        self.assertEqual(st.failures, 2)
        self.assertEqual(st.next_due, NOW + 120 * 4)
        for _ in range(6):
            fx.poller.poll_once()
        self.assertEqual(st.next_due, NOW + 1800)          # capped
        self.assertEqual(fx.poller.state["BR-MCZ"].failures, 0)
        # The broken radar recovers: its folder appears.
        write(self.tmp / "missing" / f"{stamp(NOW - H)}00dBZ.vol", b"x" * 10)
        rep = fx.poller.poll_radar("BR-SSA")
        self.assertIsNone(rep.error)
        self.assertEqual(rep.downloaded, 1)
        self.assertEqual(st.failures, 0)

    def test_prune_after_retention(self):
        fx = Fixture(self.tmp)
        fx.poller.poll_once()
        fx.clock.t = NOW + 34.5 * H     # s_mid is 36.5 h old, s_new 35.5 h, the NASA volume 37.5 h
        reports = {r.radar: r for r in fx.poller.poll_once()}
        self.assertEqual(reports["BR-MCZ"].downloaded, 0)
        self.assertFalse((fx.data / "BR-MCZ" / fx.s_mid).exists())
        self.assertTrue((fx.data / "BR-MCZ" / fx.s_new).exists())
        self.assertFalse((fx.data / "BR-NAT").exists() and any((fx.data / "BR-NAT").iterdir()))
        self.assertEqual([v[0] for v in fx.index.volumes("BR-MCZ")], [fx.s_new])
        self.assertEqual(fx.index.volumes("BR-NAT"), [])
        saved = json.loads((fx.data / INDEX_KEY).read_text())
        self.assertEqual(list(saved["radars"]["BR-MCZ"]), [fx.s_new])
        self.assertNotIn("BR-NAT", saved["radars"])
        fx.clock.t = NOW + 40 * H
        fx.poller.poll_once()
        self.assertEqual(fx.index.count_volumes(), 0)

    def test_index_persists_and_rebuilds(self):
        fx = Fixture(self.tmp)
        fx.poller.poll_once()
        want = fx.index.snapshot()["radars"]
        self.assertEqual(Index(fx.storage).open().snapshot()["radars"], want)
        (fx.data / INDEX_KEY).unlink()
        rebuilt = Index(fx.storage).open()
        self.assertEqual(rebuilt.snapshot()["radars"], want)
        self.assertTrue((fx.data / INDEX_KEY).exists())
        # A file committed but never indexed (a crash in between) is found by reconcile.
        stray = f"{fx.s_new}00W.vol"
        write(fx.data / "BR-MCZ" / fx.s_new / stray, b"w" * 77)
        added, dropped = rebuilt.reconcile()
        self.assertEqual((added, dropped), (1, 0))
        self.assertEqual(rebuilt.size("BR-MCZ", fx.s_new, stray), 77)

    def test_incomplete_download_is_never_committed(self):
        fx = Fixture(self.tmp)

        class Short(Source):
            type = "short"

            def _entries(self, since, now):
                yield f"{stamp(NOW - H)}00dBZ.vol", "x", 100, NOW - H     # an mtime: no second listing needed

            def _fetch(self, ref, size, dest, max_bytes):
                dest.write_bytes(b"x" * 60)       # the connection dropped at 60 of 100 bytes
                return 60

        fx.poller.sources = {"BR-MCZ": Short(fx.cfg.radar("BR-MCZ"), {"names": "rainbow"}, fx.cfg)}
        fx.poller.state = {"BR-MCZ": fx.poller.state["BR-MCZ"]}
        rep = fx.poller.poll_radar("BR-MCZ")
        self.assertEqual(rep.downloaded, 0)
        self.assertEqual(rep.failed, 1)
        self.assertIsNotNone(rep.error)
        self.assertFalse((fx.data / "BR-MCZ").exists())
        self.assertEqual(list((fx.data / ".staging").iterdir()), [])
        self.assertEqual(fx.index.count_files(), 0)
        # Tried again right away? No: the file waits, and the radar is not in error for it.
        rep = fx.poller.poll_radar("BR-MCZ")
        self.assertEqual((rep.failed, rep.cooling, rep.error), (0, 1, None))

    def test_max_files_per_poll(self):
        fx = Fixture(self.tmp)
        fx.cfg.max_files_per_poll = 2
        rep = fx.poller.poll_radar("BR-MCZ")
        self.assertEqual((rep.downloaded, rep.deferred), (2, 2))
        self.assertEqual(sorted(rep.names), fx.kept(fx.s_new))
        self.assertEqual(fx.poller.poll_radar("BR-MCZ").downloaded, 2)
        self.assertEqual(fx.poller.poll_radar("BR-MCZ").downloaded, 0)

    def test_static_api_mirror(self):
        # The bucket mirror (S3 only): what put_public receives, recorded.
        fx = Fixture(self.tmp)
        written: dict[str, tuple] = {}
        fx.storage.static_api = True
        fx.storage.put_public = lambda key, data, ct, cc: written.__setitem__(key, (json.loads(data), ct, cc))
        fx.poller.poll_once()
        self.assertEqual(sorted(written), ["health", "v1/radars", "v1/radars/BR-ALM/volumes",
                                           "v1/radars/BR-MCZ/volumes", "v1/radars/BR-NAT/volumes",
                                           "v1/radars/BR-SSA/volumes"])
        self.assertEqual(written["health"][0], {"ok": True, "radars": 4})
        self.assertEqual(written["v1/radars"][0], json.loads(json.dumps(views.radars(fx.cfg, fx.index, NOW))))
        self.assertEqual(written["v1/radars"][1], "application/json")
        vols = written["v1/radars/BR-MCZ/volumes"][0]
        self.assertEqual([v["stamp"] for v in vols["volumes"]], [fx.s_mid, fx.s_new])
        written.clear()
        fx.poller.poll_once()
        self.assertEqual(written, {})                 # nothing changed, nothing rewritten
        fx.clock.t = NOW + 34.5 * H
        fx.poller.poll_once()
        self.assertIn("v1/radars/BR-MCZ/volumes", written)

    def test_static_api_config(self):
        with self.assertRaises(ConfigError):
            from_dict({"storage": {"kind": "local", "static_api": True, "prefix": "v1/files/"}})
        with self.assertRaises(ConfigError):
            from_dict({"storage": {"kind": "s3", "bucket": "b", "static_api": True}})
        cfg = from_dict({"storage": {"kind": "s3", "bucket": "b", "static_api": True, "prefix": "v1/files"}})
        self.assertEqual(cfg.storage["prefix"], "v1/files/")

    def test_settle_seconds_waits_for_writers(self):
        fx = Fixture(self.tmp)
        src = fx.poller.sources["BR-MCZ"]
        src.settle_s = 3600                       # every file was written just now
        rep = fx.poller.poll_radar("BR-MCZ")
        self.assertEqual((rep.downloaded, rep.settling), (0, 4))
        src.settle_s = 0
        self.assertEqual(fx.poller.poll_radar("BR-MCZ").downloaded, 4)


# ---------------------------------------------------------------------------
class TestApi(TmpCase):
    def test_contract(self):
        fx = Fixture(self.tmp)
        fx.poller.poll_once()
        app = create_app(fx.cfg, fx.storage, fx.index, now=fx.clock)
        with ApiServer(app) as base:
            r = requests.get(f"{base}/health", timeout=10)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json(), {"ok": True, "radars": 4})

            r = requests.get(f"{base}/v1/radars", timeout=10)
            body = r.json()
            self.assertEqual(set(body), {"retentionHours", "radars"})
            self.assertEqual(body["retentionHours"], 36)
            by_id = {x["id"]: x for x in body["radars"]}
            self.assertEqual(sorted(by_id), ["BR-ALM", "BR-MCZ", "BR-NAT", "BR-SSA"])
            for x in body["radars"]:
                self.assertEqual(set(x), {"id", "name", "lat", "lon", "newest", "volumes", "updated"})
                self.assertIsInstance(x["lat"], float)
            self.assertEqual(by_id["BR-MCZ"]["name"], "Maceió (AL)")
            self.assertEqual(by_id["BR-MCZ"]["newest"], int(NOW - H))
            self.assertEqual(by_id["BR-MCZ"]["volumes"], 2)
            self.assertEqual((by_id["BR-SSA"]["newest"], by_id["BR-SSA"]["volumes"]), (None, 0))
            self.assertEqual(by_id["BR-MCZ"]["updated"], int(NOW))          # the poller's clock at the commit
            self.assertIsNone(by_id["BR-SSA"]["updated"])

            r = requests.get(f"{base}/v1/radars/BR-MCZ/volumes", timeout=10)
            body = r.json()
            self.assertEqual(set(body), {"radar", "volumes"})
            self.assertEqual(body["radar"], "BR-MCZ")
            self.assertEqual([v["stamp"] for v in body["volumes"]], [fx.s_mid, fx.s_new])     # oldest first
            v = body["volumes"][1]
            self.assertEqual(set(v), {"stamp", "unix", "added", "files"})
            self.assertEqual(v["unix"], int(NOW - H))
            self.assertEqual(v["added"], int(NOW))
            self.assertEqual([f["name"] for f in v["files"]], fx.kept(fx.s_new))
            for f in v["files"]:
                self.assertEqual(set(f), {"name", "size", "added", "url"})
                self.assertEqual(f["added"], int(NOW))
                self.assertEqual(f["url"], f"/v1/files/BR-MCZ/{fx.s_new}/{f['name']}")
                self.assertEqual(f["size"], len(fx.bytes[f["name"]]))

            # since: only volumes that started after it.
            r = requests.get(f"{base}/v1/radars/BR-MCZ/volumes", params={"since": int(NOW - 2 * H)}, timeout=10)
            self.assertEqual([v["stamp"] for v in r.json()["volumes"]], [fx.s_new])
            r = requests.get(f"{base}/v1/radars/BR-MCZ/volumes", params={"since": int(NOW - 2 * H) - 1}, timeout=10)
            self.assertEqual(len(r.json()["volumes"]), 2)
            r = requests.get(f"{base}/v1/radars/BR-MCZ/volumes", params={"since": int(NOW)}, timeout=10)
            self.assertEqual(r.json(), {"radar": "BR-MCZ", "volumes": []})

            # The file, byte for byte.
            name = fx.kept(fx.s_new)[0]
            r = requests.get(f"{base}{v['files'][0]['url']}", timeout=10)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.content, fx.bytes[name])
            self.assertEqual(r.headers["content-type"], "application/octet-stream")
            self.assertEqual(r.headers["cache-control"], IMMUTABLE)
            r = requests.head(f"{base}{v['files'][0]['url']}", timeout=10)
            self.assertEqual((r.status_code, int(r.headers["content-length"])), (200, len(fx.bytes[name])))

            # A .cf.gz is served as stored: gzip bytes, no Content-Encoding.
            nat = requests.get(f"{base}/v1/radars/BR-NAT/volumes", timeout=10).json()["volumes"]
            url = nat[0]["files"][0]["url"]
            r = requests.get(f"{base}{url}", timeout=10)
            self.assertNotIn("content-encoding", {k.lower() for k in r.headers})
            self.assertEqual(r.content, fx.bytes[fx.nasa_new])
            self.assertEqual(gzip.decompress(r.content)[:8], b"CfRadial")

            # Unknown radars: 404 JSON.
            for rid in ("BR-XXX", "br-mcz", "KTLX"):
                r = requests.get(f"{base}/v1/radars/{rid}/volumes", timeout=10)
                self.assertEqual(r.status_code, 404, rid)
                self.assertIn("error", r.json())

            # CORS, open to GET.
            r = requests.get(f"{base}/v1/radars", headers={"Origin": "https://weatherts.tech"}, timeout=10)
            self.assertEqual(r.headers.get("access-control-allow-origin"), "*")
            r = requests.options(f"{base}/v1/radars", timeout=10, headers={
                "Origin": "https://weatherts.tech", "Access-Control-Request-Method": "GET"})
            self.assertEqual(r.status_code, 200)

            # Pruned: gone from the listing, 404 on the file.
            old_url = f"/v1/files/BR-MCZ/{fx.s_mid}/{fx.kept(fx.s_mid)[0]}"
            self.assertEqual(requests.get(base + old_url, timeout=10).status_code, 200)
            fx.clock.t = NOW + 34.5 * H
            fx.poller.poll_once()
            self.assertEqual(requests.get(base + old_url, timeout=10).status_code, 404)
            r = requests.get(f"{base}/v1/radars/BR-MCZ/volumes", timeout=10)
            self.assertEqual([v["stamp"] for v in r.json()["volumes"]], [fx.s_new])

    def test_traversal_rejected(self):
        fx = Fixture(self.tmp)
        fx.poller.poll_once()
        secret = self.tmp / "secret.txt"
        secret.write_text("SECRET")
        write(fx.data / "BR-MCZ" / "notes.txt", b"SECRET")
        app = create_app(fx.cfg, fx.storage, fx.index, now=fx.clock)
        s = fx.s_new
        paths = [
            f"/v1/files/BR-MCZ/{s}/..%2F..%2Findex.json",
            f"/v1/files/BR-MCZ/{s}/..%2F..%2F..%2Fsecret.txt",
            f"/v1/files/BR-MCZ/{s}/%2e%2e",
            f"/v1/files/BR-MCZ/{s}/..",
            "/v1/files/BR-MCZ/../../index.json",
            "/v1/files/BR-MCZ/..%2F..%2Findex.json/x/y",
            f"/v1/files/BR-MCZ/{s}/..%5C..%5Cindex.json",
            f"/v1/files/BR-MCZ/{s}/C:%5Cwindows%5Cwin.ini",
            f"/v1/files/BR-MCZ/{s}/index.json",
            f"/v1/files/BR-MCZ/{s}/.staging",
            "/v1/files/BR-MCZ/notes.txt/x",
            f"/v1/files/BR-MCZ/2026/{fx.kept(s)[0]}",
            f"/v1/files/BR-MCZ/99999999999999/{fx.kept(s)[0]}",
            f"/v1/files/..%2Fsecret.txt/{s}/{fx.kept(s)[0]}",
            f"/v1/files/BR-XXX/{s}/{fx.kept(s)[0]}",
            f"/v1/files/BR-MCZ/{s}/{fx.kept(s)[0]}%00.txt",
            f"/v1/files/BR-MCZ/{s}/{fx.kept(fx.s_old)[0]}",      # in the source, never stored
        ]
        with ApiServer(app) as base:
            for p in paths:
                conn = http.client.HTTPConnection("127.0.0.1", int(base.rsplit(":", 1)[1]), timeout=10)
                conn.request("GET", p)
                resp = conn.getresponse()
                body = resp.read()
                conn.close()
                self.assertIn(resp.status, (400, 404, 422), p)
                self.assertNotIn(b"SECRET", body, p)
                self.assertNotIn(b'"radars"', body, p)
            ok = requests.get(f"{base}/v1/files/BR-MCZ/{s}/{fx.kept(s)[0]}", timeout=10)
            self.assertEqual(ok.status_code, 200)

    def test_public_base_url_redirects(self):
        fx = Fixture(self.tmp)
        fx.poller.poll_once()
        fx.cfg.api.public_base_url = "https://files.example.org/radar/"
        app = create_app(fx.cfg, fx.storage, fx.index, now=fx.clock)
        name = fx.kept(fx.s_new)[0]
        with ApiServer(app) as base:
            r = requests.get(f"{base}/v1/files/BR-MCZ/{fx.s_new}/{name}", allow_redirects=False, timeout=10)
            self.assertEqual(r.status_code, 302)
            self.assertEqual(r.headers["location"], f"https://files.example.org/radar/BR-MCZ/{fx.s_new}/{name}")
            r = requests.get(f"{base}/v1/files/BR-MCZ/{fx.s_new}/nope.vol", allow_redirects=False, timeout=10)
            self.assertEqual(r.status_code, 404)

    def test_api_only_follows_the_pollers_index(self):
        fx = Fixture(self.tmp)
        api_index = Index(fx.storage).open()          # another process's view, before anything is stored
        app = create_app(fx.cfg, fx.storage, api_index, follow_index=True, now=fx.clock)
        with ApiServer(app) as base:
            self.assertEqual(requests.get(f"{base}/v1/radars/BR-MCZ/volumes", timeout=10).json()["volumes"], [])
            fx.poller.poll_once()                      # the poller writes index.json
            name = fx.kept(fx.s_new)[0]
            r = requests.get(f"{base}/v1/files/BR-MCZ/{fx.s_new}/{name}", timeout=10)
            self.assertEqual(r.status_code, 200)       # a miss re-reads index.json at once
            self.assertEqual(r.content, fx.bytes[name])
            vols = requests.get(f"{base}/v1/radars/BR-MCZ/volumes", timeout=10).json()["volumes"]
            self.assertEqual(len(vols), 2)


# ---------------------------------------------------------------------------
class TestHttpSources(TmpCase):
    def test_cemaden_over_http_index_by_day(self):
        root = self.tmp / "www"
        d = datetime.fromtimestamp(NOW - H, tz=timezone.utc)
        day_dir = root / "radar" / "petrolina" / f"{d:%Y%m%d}"
        names = {}
        for mom in ("dBZ", "ZDR", "RhoHV", "dBuZ", "SQI"):
            n = f"{stamp(NOW - H)}00{mom}.vol"
            names[n] = write(day_dir / n, os.urandom(4096))
        write(day_dir / f"{stamp(NOW - H)}00dBZ.vol.h5", os.urandom(100))
        with StaticServer(root) as http_base:
            cfg = from_dict({
                "relay": {"recheck_seconds": 0},
                "storage": {"kind": "local", "path": str(self.tmp / "data")},
                "sources": {"cem": {"type": "cemaden", "transport": "http_index",
                                    "url": http_base + "/radar/{site}/{date:%Y%m%d}/"}},
                "radars": [{"id": "BR-PTL", "source": "cem"}]}, base_dir=self.tmp)
            storage = make_storage(cfg)
            index = Index(storage).open()
            poller = Poller(cfg, storage, index, now=Clock(NOW))
            rep = poller.poll_once()[0]
            self.assertIsNone(rep.error)
            want = sorted(n for n in names if any(n.endswith(f"00{m}.vol") for m in ("dBZ", "ZDR", "RhoHV")))
            self.assertEqual(sorted(rep.names), want)
            for n in want:
                self.assertEqual((self.tmp / "data" / "BR-PTL" / stamp(NOW - H) / n).read_bytes(), names[n])
            # Two day folders listed (the 36 h window spans two UTC days); one is missing, which is fine.
            self.assertEqual(poller.poll_once()[0].downloaded, 0)

    def test_nasa_vn_layout(self):
        root = self.tmp / "www"
        inside = NOW - 3 * H
        outside = NOW - 10 * 24 * H
        n_in = nasa_name("MC1", inside)
        n_out = nasa_name("MC1", outside)
        di = datetime.fromtimestamp(inside, tz=timezone.utc)
        do = datetime.fromtimestamp(outside, tz=timezone.utc)
        payload = write(root / "GPM" / "MC1" / f"{di:%Y}" / f"{di:%m%d}" / n_in, gzip.compress(b"volume" * 999))
        write(root / "GPM" / "MC1" / f"{di:%Y}" / f"{di:%m%d}" / n_in.replace(".cf.gz", "_class_PPI.png"), b"png")
        write(root / "GPM" / "MC1" / f"{do:%Y}" / f"{do:%m%d}" / n_out, b"old")
        write(root / "GPM" / "NT1" / f"{di:%Y}" / f"{di:%m%d}" / nasa_name("NT1", inside), b"other radar")
        with StaticServer(root) as http_base:
            cfg = from_dict({
                "relay": {"recheck_seconds": 0},
                "storage": {"kind": "local", "path": str(self.tmp / "data")},
                "sources": {"nasa": {"type": "nasa_vn", "base_url": http_base + "/GPM"}},
                "radars": [{"id": "BR-MCZ", "source": "nasa"}]}, base_dir=self.tmp)
            self.assertEqual(cfg.radar("BR-MCZ").site, "MC1")
            storage = make_storage(cfg)
            poller = Poller(cfg, storage, Index(storage).open(), now=Clock(NOW))
            rep = poller.poll_once()[0]
            self.assertIsNone(rep.error)
            self.assertEqual(rep.names, [n_in])
            self.assertFalse(any(f"/{do:%m%d}/" in p for p in _QuietHandler.log))   # the old day is never opened
            stored = self.tmp / "data" / "BR-MCZ" / parse_name(n_in).stamp / n_in
            self.assertEqual(stored.read_bytes(), payload)

    def test_only_dates(self):
        root = self.tmp / "www"
        n = "MC1_2026_0224_133002.cf.gz"
        payload = write(root / "GPM" / "MC1" / "2026" / "0224" / n, gzip.compress(b"maceio" * 10))
        with StaticServer(root) as http_base:
            cfg = from_dict({
                "relay": {"retention_hours": 24 * 365, "recheck_seconds": 0},
                "storage": {"kind": "local", "path": str(self.tmp / "data")},
                "sources": {"nasa": {"type": "nasa_vn", "base_url": http_base + "/GPM", "only_dates": ["2026-02-24"]}},
                "radars": [{"id": "BR-MCZ", "source": "nasa"}]}, base_dir=self.tmp)
            storage = make_storage(cfg)
            rep = Poller(cfg, storage, Index(storage).open(), now=Clock(NOW)).poll_once()[0]
            self.assertEqual(rep.names, [n])
            # Only the chosen day: no year listing. The day is listed twice and the file asked for
            # its size twice (no modification times in an HTML listing), then fetched once.
            day, f = "/GPM/MC1/2026/0224/", f"/GPM/MC1/2026/0224/{n}"
            self.assertEqual({p for _m, p in _QuietHandler.calls}, {day, f})
            self.assertEqual(_QuietHandler.calls, [("GET", day), ("HEAD", f), ("GET", day), ("HEAD", f), ("GET", f)])
            self.assertEqual((self.tmp / "data" / "BR-MCZ" / "20260224133002" / n).read_bytes(), payload)


class _RedirectHandler(http.server.BaseHTTPRequestHandler):
    """/home/ -> 302 to another host name for the same server; /captcha -> 302
    to the CEMADEN map; records the Authorization header of every request."""
    seen: list[tuple[str, str, Optional[str]]] = []
    away_base = ""

    def do_GET(self):
        _RedirectHandler.seen.append((self.headers.get("Host", ""), self.path, self.headers.get("Authorization")))
        if self.path == "/home/":
            self.send_response(302)
            self.send_header("Location", f"{_RedirectHandler.away_base}/away/")
            self.end_headers()
        elif self.path == "/captcha/":
            self.send_response(302)
            self.send_header("Location", "https://mapainterativo.cemaden.gov.br/download/radar/maceio")
            self.end_headers()
        elif self.path == "/away/":
            body = b'<a href="20261012110000.h5">x</a>'
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):
        pass


class TestHttpRedirects(TmpCase):
    def test_redirects_are_checked_and_credentials_stay_home(self):
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _RedirectHandler)
        port = httpd.server_address[1]
        _RedirectHandler.seen = []
        _RedirectHandler.away_base = f"http://localhost:{port}"
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        try:
            cfg = from_dict({"sources": {"h": {"type": "http_index", "url": f"http://127.0.0.1:{port}/home/",
                                               "token": "T0KEN"},
                                         "c": {"type": "http_index", "url": f"http://127.0.0.1:{port}/captcha/"}},
                             "radars": [{"id": "BR-MCZ", "source": "h"}, {"id": "BR-NAT", "source": "c"}]})
            src = make_source(cfg.radar("BR-MCZ"), cfg)
            files = src.list(NOW - 36 * H, NOW)
            self.assertEqual([f.name for f in files], ["20261012110000.h5"])
            self.assertEqual(files[0].ref, f"http://localhost:{port}/away/20261012110000.h5")
            auth = {path: a for _host, path, a in _RedirectHandler.seen}
            self.assertEqual(auth["/home/"], "Bearer T0KEN")
            self.assertIsNone(auth["/away/"])                     # not forwarded to another host
            with self.assertRaises(SourceError):
                make_source(cfg.radar("BR-NAT"), cfg).list(NOW - 36 * H, NOW)
        finally:
            httpd.shutdown()
            httpd.server_close()


class FakeFTP:
    """Just enough of ftplib.FTP: one folder per radar, MLSD or LIST (or, with
    nlst=True, a LIST no parser reads, so the source falls back to NLST)."""

    def __init__(self, files: dict[str, bytes], mlsd: bool = True, nlst: bool = False):
        self.files = files
        self.has_mlsd = mlsd
        self.nlst_only = nlst
        self.retrieved: list[str] = []
        self.sized: list[str] = []

    def _dir(self, path):
        out = {p.rsplit("/", 1)[1]: b for p, b in self.files.items() if p.rsplit("/", 1)[0] == path.rstrip("/")}
        if not out:
            raise ftplib.error_perm("550 No such directory")
        return out

    def mlsd(self, path, facts=()):
        if not self.has_mlsd:
            raise ftplib.error_perm("500 MLSD not understood")
        for n, b in self._dir(path).items():
            yield n, {"type": "file", "size": str(len(b)), "modify": "20261012000000"}
        yield ".", {"type": "cdir"}

    def retrlines(self, cmd, callback):
        for n, b in self._dir(cmd.split(" ", 1)[1]).items():
            callback(f"?? {n}" if self.nlst_only else f"-rw-r--r--   1 ftp ftp {len(b):>10} Oct 12 07:47 {n}")

    def nlst(self, path):
        return [f"{path.rstrip('/')}/{n}" for n in self._dir(path)]

    def retrbinary(self, cmd, callback, blocksize=8192):
        path = cmd.split(" ", 1)[1]
        self.retrieved.append(path)
        data = self.files[path]
        for i in range(0, len(data), blocksize):
            callback(data[i:i + blocksize])

    def voidcmd(self, cmd):
        return "200"

    def size(self, path):
        self.sized.append(path)
        return len(self.files[path])

    def quit(self):
        pass

    def close(self):
        pass


class TestFtpSource(TmpCase):
    def _run(self, mlsd: bool):
        s = stamp(NOW - H)
        files = {f"/radar/maceio/{s}00{m}.vol": os.urandom(3000) for m in ("dBZ", "V", "dBuZ")}
        fake = FakeFTP(files, mlsd=mlsd)
        cfg = from_dict({
            "relay": {"recheck_seconds": 0},
            "storage": {"kind": "local", "path": str(self.tmp / f"data{int(mlsd)}")},
            "sources": {"cem": {"type": "cemaden", "transport": "ftp", "host": "ftp.example.org",
                                "path": "/radar/{site}"}},
            "radars": [{"id": "BR-MCZ", "source": "cem"}, {"id": "BR-NAT", "source": "cem"}]}, base_dir=self.tmp)
        storage = make_storage(cfg)
        poller = Poller(cfg, storage, Index(storage).open(), now=Clock(NOW))
        for src in poller.sources.values():
            self.assertIsInstance(src, FtpSource)
            src._connect = lambda f=fake: f
        reps = {r.radar: r for r in poller.poll_once()}
        self.assertEqual(sorted(reps["BR-MCZ"].names), sorted([f"{s}00dBZ.vol", f"{s}00V.vol"]))
        self.assertIsNotNone(reps["BR-NAT"].error)          # no such folder, and no {date}: an error
        self.assertEqual(sorted(fake.retrieved), [f"/radar/maceio/{s}00V.vol", f"/radar/maceio/{s}00dBZ.vol"])
        for n in reps["BR-MCZ"].names:
            got = (self.tmp / f"data{int(mlsd)}" / "BR-MCZ" / s / n).read_bytes()
            self.assertEqual(got, files[f"/radar/maceio/{n}"])

    def test_ftp_mlsd(self):
        self._run(mlsd=True)

    def test_ftp_list_fallback(self):
        self._run(mlsd=False)


# ---------------------------------------------------------------------------
class TestConfig(TmpCase):
    def setUp(self):
        super().setUp()
        self._env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)
        super().tearDown()

    def test_example_config_is_idle_until_access(self):
        cfg = load_config(HERE.parent / "config.example.toml")
        self.assertEqual([r.id for r in cfg.radars],
                         ["BR-ALM", "BR-JAR", "BR-MCZ", "BR-NAT", "BR-PTL", "BR-SSA", "BR-STE", "BR-SFR", "BR-TMA"])
        self.assertEqual({r.source for r in cfg.radars}, {"cemaden"})
        self.assertEqual(cfg.retention_hours, 36)
        self.assertEqual(cfg.radar("BR-MCZ").name, "Maceió (AL)")
        self.assertTrue(all(make_source(r, cfg) is None for r in cfg.radars))

    def test_env_switches_cemaden_on(self):
        os.environ.update({"RELAY_CEMADEN_ENABLED": "1", "RELAY_CEMADEN_HOST": "ftp.example.org",
                           "RELAY_CEMADEN_USER": "weatherts", "RELAY_CEMADEN_PASSWORD": "s3cret",
                           "RELAY_RETENTION_HOURS": "48"})
        cfg = load_config(HERE.parent / "config.example.toml")
        self.assertEqual(cfg.retention_hours, 48)
        r = cfg.radar("BR-MCZ")
        self.assertEqual((r.options["host"], r.options["user"], r.options["password"]),
                         ("ftp.example.org", "weatherts", "s3cret"))
        src = make_source(r, cfg)                           # no connection is made here
        self.assertIsInstance(src, FtpSource)
        self.assertEqual(src.expand(src.opts["path"], NOW - 36 * H, NOW), ["/maceio/"])
        self.assertEqual(src.moments, {m.lower() for m in ("dBZ", "V", "W", "ZDR", "RhoHV", "KDP", "PhiDP")})

    def test_generic_ftp_password_env(self):
        os.environ["RELAY_FTP_PASSWORD"] = "from-env"
        cfg = from_dict({"sources": {"x": {"type": "ftp", "host": "h"}},
                         "radars": [{"id": "BR-MCZ", "source": "x"}]})
        self.assertEqual(cfg.radar("BR-MCZ").options["password"], "from-env")

    def test_captcha_site_is_refused(self):
        for table in ({"type": "cemaden", "transport": "http_index",
                       "url": "https://mapainterativo.cemaden.gov.br/download/radar/{site}"},
                      {"type": "http_index", "url": "https://MapaInterativo.cemaden.gov.br/"},
                      {"type": "cemaden", "transport": "ftp", "host": "mapainterativo.cemaden.gov.br"}):
            with self.assertRaises(ConfigError):
                from_dict({"sources": {"x": table}, "radars": [{"id": "BR-MCZ", "source": "x"}]})
        # And at request time, whatever a listing links to.
        cfg = from_dict({"sources": {"x": {"type": "http_index", "url": "http://127.0.0.1:9/"}},
                         "radars": [{"id": "BR-MCZ", "source": "x"}]})
        src = HttpIndexSource(cfg.radar("BR-MCZ"), cfg.radar("BR-MCZ").options, cfg)
        with self.assertRaises(SourceError):
            src._get("https://mapainterativo.cemaden.gov.br/download/x.vol")

    def test_bad_configs(self):
        bad = [
            {"radars": [{"id": "maceio"}]},
            {"radars": [{"id": "BR-MCZ"}, {"id": "BR-MCZ"}]},
            {"radars": [{"id": "BR-MCZ", "source": "nope"}]},
            {"radars": [{"id": "BR-NEW"}]},                                     # unknown radar without name/lat/lon
            {"sources": {"x": {"type": "gopher"}}},
            {"relay": {"retention_hours": 0}},
            {"storage": {"kind": "s3", "static_api": True}},
            {"storage": {"prefix": "../up"}},
        ]
        for d in bad:
            with self.assertRaises(ConfigError, msg=str(d)):
                from_dict(d)

    def test_no_file_defaults(self):
        os.environ.pop("RELAY_CONFIG", None)
        cwd = os.getcwd()
        os.chdir(self.tmp)
        try:
            cfg = load_config(None)
        finally:
            os.chdir(cwd)
        self.assertEqual(len(cfg.radars), 9)
        self.assertTrue(all(not r.source for r in cfg.radars))


class TestStorage(TmpCase):
    def test_local_keys_stay_inside(self):
        st = LocalStorage(self.tmp / "data")
        from relay.storage import StorageError
        for key in ("../x", "BR-MCZ/../../x", "/etc/passwd"):
            with self.assertRaises(StorageError):
                st._path(key)
        with self.assertRaises(StorageError):
            st.delete_volume("..", "20261012000000")
        with self.assertRaises(StorageError):
            st.delete_volume("BR-MCZ", "../..")

    def test_s3_class_imports_lazily(self):
        import importlib.util
        from relay.storage import S3Storage, StorageError
        if importlib.util.find_spec("boto3") is None:
            with self.assertRaises(StorageError):
                S3Storage(bucket="b")
        else:
            st = S3Storage(bucket="b", endpoint_url="http://127.0.0.1:9", access_key_id="k",
                           secret_access_key="s", prefix="v1/files/")
            self.assertEqual(st.object_key("BR-MCZ/20261012000000/x.vol"), "v1/files/BR-MCZ/20261012000000/x.vol")


class _FakeBody:
    def __init__(self, data: bytes):
        import io
        self._b = io.BytesIO(data)

    def read(self):
        return self._b.read()

    def iter_chunks(self, n):
        while True:
            c = self._b.read(n)
            if not c:
                return
            yield c

    def close(self):
        pass


class FakeS3:
    """The calls S3Storage makes, against a dict; errors as botocore raises them."""

    def __init__(self):
        from botocore.exceptions import ClientError
        self.ClientError = ClientError
        self.objects: dict[str, dict] = {}

    def _err(self, code, status, op):
        return self.ClientError({"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": status}}, op)

    def _put(self, key, data, **meta):
        import hashlib
        self.objects[key] = {"data": data, "etag": '"%s"' % hashlib.md5(data).hexdigest(),
                             "modified": datetime.now(timezone.utc), **meta}

    def upload_file(self, filename, bucket, key, ExtraArgs=None):
        self._put(key, Path(filename).read_bytes(), **(ExtraArgs or {}))

    def put_object(self, Bucket, Key, Body, ContentType=None, CacheControl=None):
        self._put(Key, Body, ContentType=ContentType, CacheControl=CacheControl)

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise self._err("404", 404, "HeadObject")
        return {"ContentLength": len(self.objects[Key]["data"])}

    def get_object(self, Bucket, Key, IfNoneMatch=None):
        o = self.objects.get(Key)
        if o is None:
            raise self._err("NoSuchKey", 404, "GetObject")
        if IfNoneMatch and IfNoneMatch == o["etag"]:
            raise self._err("304", 304, "GetObject")
        return {"Body": _FakeBody(o["data"]), "ContentLength": len(o["data"]), "ETag": o["etag"]}

    def delete_object(self, Bucket, Key):
        self.objects.pop(Key, None)

    def delete_objects(self, Bucket, Delete):
        for o in Delete["Objects"]:
            self.objects.pop(o["Key"], None)
        return {}

    def get_paginator(self, name):
        return self

    def paginate(self, Bucket, Prefix=""):
        keys = sorted(k for k in self.objects if k.startswith(Prefix))
        for i in range(0, max(1, len(keys)), 2):          # several pages, as a real listing
            yield {"Contents": [{"Key": k, "Size": len(self.objects[k]["data"]),
                                 "LastModified": self.objects[k]["modified"]} for k in keys[i:i + 2]]}


@unittest.skipUnless(__import__("importlib").util.find_spec("boto3"), "boto3 not installed (optional, for s3)")
class TestS3Pipeline(TmpCase):
    def test_poll_serve_rebuild_prune_on_a_bucket(self):
        from relay.storage import OCTET, S3Storage
        fx = Fixture(self.tmp)
        st = S3Storage(bucket="radar", endpoint_url="http://127.0.0.1:9", access_key_id="k", secret_access_key="s",
                       prefix="v1/files/", static_api=True)
        st.s3 = fake = FakeS3()
        index = Index(st).open()
        poller = Poller(fx.cfg, st, index, now=fx.clock)
        reports = {r.radar: r for r in poller.poll_once()}
        self.assertEqual(reports["BR-MCZ"].downloaded, 4)
        name = fx.kept(fx.s_new)[0]
        obj = fake.objects[f"v1/files/BR-MCZ/{fx.s_new}/{name}"]
        self.assertEqual((obj["data"], obj["ContentType"], obj["CacheControl"]), (fx.bytes[name], OCTET, IMMUTABLE))
        self.assertIn("v1/files/index.json", fake.objects)
        self.assertEqual(json.loads(fake.objects["health"]["data"]), {"ok": True, "radars": 4})
        self.assertEqual(len(json.loads(fake.objects["v1/radars/BR-MCZ/volumes"]["data"])["volumes"]), 2)
        self.assertEqual(poller.poll_once()[0].downloaded, 0)

        # Served from the bucket through the API (streamed, not a local file).
        app = create_app(fx.cfg, st, index, now=fx.clock)
        with ApiServer(app) as base:
            r = requests.get(f"{base}/v1/files/BR-MCZ/{fx.s_new}/{name}", timeout=10)
            self.assertEqual((r.status_code, r.content), (200, fx.bytes[name]))
            self.assertEqual(r.headers["cache-control"], IMMUTABLE)
            r = requests.head(f"{base}/v1/files/BR-MCZ/{fx.s_new}/{name}", timeout=10)
            self.assertEqual(int(r.headers["content-length"]), len(fx.bytes[name]))

        # index.json lost: rebuilt from the bucket listing, "added" from LastModified (rounded up).
        want = index.snapshot()["radars"]
        del fake.objects["v1/files/index.json"]
        rebuilt = Index(st).open()
        self.assertEqual(rebuilt.snapshot()["radars"], want)
        mod = fake.objects[f"v1/files/BR-MCZ/{fx.s_new}/{name}"]["modified"].timestamp()
        self.assertEqual(rebuilt.added("BR-MCZ", fx.s_new, name), int(-(-mod // 1)))

        # An API process following the index by ETag.
        follower = Index(st).open()
        self.assertEqual(follower.refresh(force=True), None)
        fx.clock.t = NOW + 34.5 * H
        poller.poll_once()
        self.assertFalse(any(k.startswith(f"v1/files/BR-MCZ/{fx.s_mid}/") for k in fake.objects))
        self.assertTrue(any(k.startswith(f"v1/files/BR-MCZ/{fx.s_new}/") for k in fake.objects))
        follower.refresh(force=True)
        self.assertEqual([v[0] for v in follower.volumes("BR-MCZ")], [fx.s_new])


# ---------------------------------------------------------------------------
# Contract v1.1: "added" on files and volumes, "updated" on radars, ?addedSince=
class TestAdded(TmpCase):
    def test_added_updated_and_added_since(self):
        fx = Fixture(self.tmp)
        fx.poller.poll_once()                         # both BR-MCZ volumes committed at NOW
        # A file of the older volume reaches the source late (a backlog): committed a minute later.
        late = f"{fx.s_mid}00W.vol"
        fx.bytes[late] = write(fx.src / "maceio" / late, os.urandom(321))
        fx.clock.t = NOW + 60
        self.assertEqual(fx.poller.poll_radar("BR-MCZ").names, [late])
        app = create_app(fx.cfg, fx.storage, fx.index, now=fx.clock)
        with ApiServer(app) as base:
            def vols(**params):
                r = requests.get(f"{base}/v1/radars/BR-MCZ/volumes", params=params, timeout=10)
                self.assertEqual(r.status_code, 200)
                return r.json()["volumes"]

            allv = vols()
            self.assertEqual([(v["stamp"], v["added"]) for v in allv],
                             [(fx.s_mid, int(NOW + 60)), (fx.s_new, int(NOW))])      # a volume: its newest file
            self.assertEqual({f["name"]: f["added"] for f in allv[0]["files"]},
                             {**{n: int(NOW) for n in fx.kept(fx.s_mid)}, late: int(NOW + 60)})
            # since cannot see it: the volume is older than the newest one a client holds...
            self.assertEqual(vols(since=int(NOW - H)), [])
            # ...addedSince can, and the volume comes with all its files.
            got = vols(addedSince=int(NOW))
            self.assertEqual([v["stamp"] for v in got], [fx.s_mid])
            self.assertEqual(sorted(f["name"] for f in got[0]["files"]), sorted(fx.kept(fx.s_mid) + [late]))
            self.assertEqual(len(vols(addedSince=int(NOW) - 1)), 2)          # strictly after
            self.assertEqual(vols(addedSince=int(NOW + 60)), [])
            # Both filters apply.
            self.assertEqual(vols(addedSince=int(NOW), since=int(NOW - 2 * H)), [])
            self.assertEqual([v["stamp"] for v in vols(addedSince=int(NOW), since=int(NOW - 2 * H) - 1)],
                             [fx.s_mid])
            r = requests.get(f"{base}/v1/radars/BR-MCZ/volumes", params={"addedSince": "soon"}, timeout=10)
            self.assertEqual(r.status_code, 422)
            radars = {x["id"]: x for x in requests.get(f"{base}/v1/radars", timeout=10).json()["radars"]}
            self.assertEqual(radars["BR-MCZ"]["updated"], int(NOW + 60))
            self.assertEqual(radars["BR-MCZ"]["newest"], int(NOW - H))          # still the newest stamp
            self.assertEqual(radars["BR-NAT"]["updated"], int(NOW))
            self.assertIsNone(radars["BR-ALM"]["updated"])

    def test_index_json_keeps_added_and_migrates_v1(self):
        fx = Fixture(self.tmp)
        fx.poller.poll_once()
        saved = json.loads((fx.data / INDEX_KEY).read_text())
        name, other = fx.kept(fx.s_new)
        self.assertEqual(saved["version"], 2)
        self.assertEqual(saved["radars"]["BR-MCZ"][fx.s_new][name], len(fx.bytes[name]))   # version 1's map
        self.assertEqual(saved["added"]["BR-MCZ"][fx.s_new][name], int(NOW))
        again = Index(fx.storage).open()
        self.assertEqual(again.added("BR-MCZ", fx.s_new, name), int(NOW))    # the poller's clock, not the mtime
        # A version 1 index.json (no "added"): every file counts as added at its volume's stamp.
        (fx.data / INDEX_KEY).write_text(json.dumps({"version": 1, "updated": 1, "radars": saved["radars"]}))
        old = Index(fx.storage).open()
        self.assertEqual(old.snapshot()["radars"], saved["radars"])
        self.assertEqual(old.added("BR-MCZ", fx.s_new, name), int(NOW - H))
        vol = views.volumes(fx.cfg, old, "BR-MCZ", NOW)["volumes"][-1]
        self.assertEqual((vol["stamp"], vol["added"]), (fx.s_new, int(NOW - H)))
        # A broken value, and a file "added" does not name: the stamp too.
        (fx.data / INDEX_KEY).write_text(json.dumps(dict(saved, added={"BR-MCZ": {fx.s_new: {name: "yesterday"}}})))
        mixed = Index(fx.storage).open()
        self.assertEqual(mixed.added("BR-MCZ", fx.s_new, name), int(NOW - H))
        self.assertEqual(mixed.added("BR-MCZ", fx.s_new, other), int(NOW - H))
        self.assertEqual(mixed.added("BR-MCZ", fx.s_mid, fx.kept(fx.s_mid)[0]), int(NOW - 2 * H))

    def test_rebuild_takes_file_times_and_reconcile_keeps_known_ones(self):
        fx = Fixture(self.tmp)
        fx.poller.poll_once()
        name = fx.kept(fx.s_new)[0]
        path = fx.data / "BR-MCZ" / fx.s_new / name
        os.utime(path, (NOW + 123.4, NOW + 123.4))
        (fx.data / INDEX_KEY).unlink()
        rebuilt = Index(fx.storage).open()
        self.assertEqual(rebuilt.added("BR-MCZ", fx.s_new, name), int(NOW) + 124)          # rounded up
        saved = json.loads((fx.data / INDEX_KEY).read_text())
        self.assertEqual(saved["added"]["BR-MCZ"][fx.s_new][name], int(NOW) + 124)
        # reconcile: a file it had keeps its time; a stray one gets its own.
        stray = f"{fx.s_new}00W.vol"
        write(fx.data / "BR-MCZ" / fx.s_new / stray, b"w" * 77)
        os.utime(fx.data / "BR-MCZ" / fx.s_new / stray, (NOW + 500, NOW + 500))
        os.utime(path, (NOW + 999, NOW + 999))
        self.assertEqual(rebuilt.reconcile(), (1, 0))
        self.assertEqual(rebuilt.added("BR-MCZ", fx.s_new, stray), int(NOW + 500))
        self.assertEqual(rebuilt.added("BR-MCZ", fx.s_new, name), int(NOW) + 124)
        # A store that has no modification time for a file: the stamp.
        with mock.patch.object(fx.storage, "list_files", lambda: iter([("BR-MCZ", fx.s_new, name, 5, None)])):
            self.assertEqual(Index(fx.storage)._scan()["BR-MCZ"][fx.s_new][name], (5, int(NOW - H)))

    def test_s3_listing_gives_last_modified(self):
        from relay.storage import S3Storage
        st = S3Storage.__new__(S3Storage)             # no client: only the listing is exercised
        st.bucket, st.prefix = "b", "v1/files/"
        when = datetime.fromtimestamp(NOW + 7.25, tz=timezone.utc)
        s = stamp(NOW)

        class Pages:
            def get_paginator(self, name):
                return self

            def paginate(self, Bucket, Prefix=""):
                yield {"Contents": [{"Key": f"v1/files/BR-MCZ/{s}/a.vol", "Size": 3, "LastModified": when},
                                    {"Key": f"v1/files/BR-MCZ/{s}/b.vol", "Size": 4},
                                    {"Key": "v1/files/index.json", "Size": 9, "LastModified": when}]}

        st.s3 = Pages()
        self.assertEqual(list(st.list_files()), [("BR-MCZ", s, "a.vol", 3, NOW + 7.25), ("BR-MCZ", s, "b.vol", 4, None)])
        scanned = Index(st)._scan()["BR-MCZ"][s]
        self.assertEqual(scanned, {"a.vol": (3, int(NOW) + 8), "b.vol": (4, int(NOW))})


# ---------------------------------------------------------------------------
# Files listed without a modification time: the same size on two listings
class TestHalfWritten(TmpCase):
    def _no_mtime(self, fx) -> dict[str, bytes]:
        """BR-MCZ alone, from a source that lists sizes but no modification
        times (like FTP LIST); the returned dict is what it lists."""
        files: dict[str, bytes] = {}

        class NoMtime(Source):
            type = "no-mtime"

            def _entries(self, since, now):
                for name, data in list(files.items()):
                    yield name, name, len(data), None

            def _fetch(self, ref, size, dest, max_bytes):
                dest.write_bytes(files[ref])
                return len(files[ref])

        fx.poller.sources = {"BR-MCZ": NoMtime(fx.cfg.radar("BR-MCZ"), {"names": "rainbow"}, fx.cfg)}
        fx.poller.state = {"BR-MCZ": fx.poller.state["BR-MCZ"]}
        return files

    def test_no_mtime_needs_the_same_size_twice(self):
        fx = Fixture(self.tmp)
        files = self._no_mtime(fx)
        name = f"{stamp(NOW - H)}00dBZ.vol"
        files[name] = b"x" * 100                      # being written
        rep = fx.poller.poll_radar("BR-MCZ")
        self.assertEqual((rep.downloaded, rep.confirming, rep.error), (0, 1, None))
        files[name] = b"x" * 250                      # still growing
        rep = fx.poller.poll_radar("BR-MCZ")
        self.assertEqual((rep.downloaded, rep.confirming), (0, 1))
        rep = fx.poller.poll_radar("BR-MCZ")          # the same size twice: complete
        self.assertEqual((rep.downloaded, rep.confirming, rep.names), (1, 0, [name]))
        self.assertEqual((fx.data / "BR-MCZ" / stamp(NOW - H) / name).read_bytes(), b"x" * 250)
        self.assertEqual(fx.poller.poll_radar("BR-MCZ").downloaded, 0)

    def test_once_lists_again_after_the_pause(self):
        fx = Fixture(self.tmp)
        files = self._no_mtime(fx)
        name = f"{stamp(NOW - H)}00V.vol"
        files[name] = b"v" * 64
        src = fx.poller.sources["BR-MCZ"]
        listings: list[float] = []
        orig = src.list
        src.list = lambda since, now: (listings.append(time.monotonic()), orig(since, now))[1]
        fx.cfg.recheck_seconds = 0.3
        rep = fx.poller.poll_once()[0]
        self.assertEqual((rep.downloaded, rep.names, rep.confirming, rep.error), (1, [name], 0, None))
        self.assertEqual(len(listings), 2)
        self.assertGreaterEqual(listings[1] - listings[0], 0.25)
        listings.clear()
        self.assertEqual(fx.poller.poll_once()[0].downloaded, 0)
        self.assertEqual(len(listings), 1)              # nothing waiting: one listing, no pause

    def test_once_does_not_pause_for_sources_with_mtimes(self):
        fx = Fixture(self.tmp)
        fx.cfg.recheck_seconds = 30
        counts: dict[str, int] = {}
        for rid, src in fx.poller.sources.items():
            orig = src.list
            src.list = lambda since, now, _o=orig, _r=rid: (counts.__setitem__(_r, counts.get(_r, 0) + 1),
                                                           _o(since, now))[1]
        t0 = time.monotonic()
        reports = {r.radar: r for r in fx.poller.poll_once()}
        self.assertLess(time.monotonic() - t0, 10)
        self.assertEqual(counts, {"BR-MCZ": 1, "BR-NAT": 1, "BR-SSA": 1})
        self.assertEqual(reports["BR-MCZ"].downloaded, 4)

    def test_once_leaves_a_growing_file_for_the_next_run(self):
        fx = Fixture(self.tmp)
        files = self._no_mtime(fx)
        name = f"{stamp(NOW - H)}00dBZ.vol"
        src = fx.poller.sources["BR-MCZ"]
        orig = src._entries

        def growing(since, now):
            files[name] = files.get(name, b"") + b"g" * 10      # a writer still busy at every listing
            yield from orig(since, now)

        src._entries = growing
        fx.cfg.recheck_seconds = 0
        rep = fx.poller.poll_once()[0]
        self.assertEqual((rep.downloaded, rep.confirming, rep.error), (0, 1, None))
        self.assertEqual(fx.index.count_files(), 0)

    def test_html_listing_sizes_come_from_head(self):
        root = self.tmp / "www"
        n = f"{stamp(NOW - H)}.h5"
        f = root / "radar" / n
        write(f, b"a" * 1000)
        with StaticServer(root) as http_base:
            cfg = from_dict({"storage": {"kind": "local", "path": str(self.tmp / "data")},
                             "sources": {"h": {"type": "http_index", "url": http_base + "/radar/"}},
                             "radars": [{"id": "BR-MCZ", "source": "h"}]}, base_dir=self.tmp)
            storage = make_storage(cfg)
            poller = Poller(cfg, storage, Index(storage).open(), now=Clock(NOW))
            rep = poller.poll_radar("BR-MCZ")
            self.assertEqual((rep.downloaded, rep.confirming), (0, 1))
            with open(f, "ab") as out:
                out.write(b"b" * 500)                  # the writer was not done
            self.assertEqual(poller.poll_radar("BR-MCZ").downloaded, 0)
            rep = poller.poll_radar("BR-MCZ")
            self.assertEqual(rep.names, [n])
            self.assertEqual((self.tmp / "data" / "BR-MCZ" / stamp(NOW - H) / n).read_bytes(),
                             b"a" * 1000 + b"b" * 500)
            heads = [p for m, p in _QuietHandler.calls if m == "HEAD"]
            gets = [p for m, p in _QuietHandler.calls if m == "GET" and p.endswith(n)]
            self.assertEqual((len(heads), len(gets)), (3, 1))

    def test_ftp_nlst_sizes_come_from_size(self):
        s = stamp(NOW - H)
        path = f"/radar/maceio/{s}00dBZ.vol"
        fake = FakeFTP({path: os.urandom(2000)}, mlsd=False, nlst=True)
        cfg = from_dict({"relay": {"recheck_seconds": 0},
                         "storage": {"kind": "local", "path": str(self.tmp / "data")},
                         "sources": {"cem": {"type": "cemaden", "transport": "ftp", "host": "ftp.example.org",
                                             "path": "/radar/{site}"}},
                         "radars": [{"id": "BR-MCZ", "source": "cem"}]}, base_dir=self.tmp)
        storage = make_storage(cfg)
        poller = Poller(cfg, storage, Index(storage).open(), now=Clock(NOW))
        poller.sources["BR-MCZ"]._connect = lambda: fake
        rep = poller.poll_once()[0]
        self.assertEqual(rep.names, [f"{s}00dBZ.vol"])
        self.assertEqual(fake.sized, [path, path])      # once per listing; the download already knew it
        self.assertEqual(fake.retrieved, [path])
        self.assertEqual((self.tmp / "data" / "BR-MCZ" / s / f"{s}00dBZ.vol").read_bytes(), fake.files[path])


# ---------------------------------------------------------------------------
# --api-only: a /v1/files miss forces an index read only when it can help
class _Mono:
    """relay.index's `time`, with a monotonic clock the test moves."""

    def __init__(self, t: float = 1000.0):
        self.t = t

    def monotonic(self) -> float:
        return self.t

    def time(self) -> float:
        return time.time()


class TestProbeFailures(TmpCase):
    """The size probe (HEAD, FTP SIZE) for listings without sizes: a file
    gone from the source, a server failing, and one that never says."""

    def _probing(self, fx, files: dict[str, bytes], probe) -> None:
        class Probing(Source):
            type = "probing"

            def _entries(self, since, now):
                for name in list(files):
                    yield name, name, None, None          # no size, no modification time

            def _probe(self, ref):
                return probe(ref)

            def _fetch(self, ref, size, dest, max_bytes):
                dest.write_bytes(files[ref])
                return len(files[ref])

        fx.poller.sources = {"BR-MCZ": Probing(fx.cfg.radar("BR-MCZ"), {"names": "rainbow"}, fx.cfg)}
        fx.poller.state = {"BR-MCZ": fx.poller.state["BR-MCZ"]}

    def _files(self) -> tuple[str, list[str], dict[str, bytes]]:
        newest = f"{stamp(NOW - H)}00dBZ.vol"
        older = [f"{stamp(NOW - (2 + k) * H)}00dBZ.vol" for k in range(3)]
        return newest, older, {newest: b"n" * 300, **{o: b"o" * 100 for o in older}}

    def test_gone_files_do_not_stop_the_confirmed_ones(self):
        fx = Fixture(self.tmp)
        newest, older, files = self._files()
        gone: set[str] = set()

        def probe(ref):
            if ref in gone:
                raise SourceGone(f"{ref}: gone (404)")
            return len(files[ref])
        self._probing(fx, files, probe)
        rep = fx.poller.poll_radar("BR-MCZ")              # first listing: nothing confirmed yet
        self.assertEqual((rep.downloaded, rep.error), (0, None))
        gone.update(older)                                # purged at the source, still listed
        rep = fx.poller.poll_radar("BR-MCZ")
        self.assertEqual((rep.downloaded, rep.names, rep.error), (1, [newest], None))
        self.assertEqual(fx.poller.state["BR-MCZ"].failures, 0)

    def test_failing_probes_stop_asking_but_keep_what_was_confirmed(self):
        fx = Fixture(self.tmp)
        newest, older, files = self._files()
        down: set[str] = set()

        def probe(ref):
            if ref in down:
                raise SourceError(f"HEAD {ref}: HTTP 503")
            return len(files[ref])
        self._probing(fx, files, probe)
        fx.poller.poll_radar("BR-MCZ")
        down.update(older)
        rep = fx.poller.poll_radar("BR-MCZ")
        self.assertEqual((rep.downloaded, rep.names, rep.error), (1, [newest], None))
        self.assertEqual(rep.confirming, 3)
        # Their sizes from the first listing are kept: once the server answers
        # again they are confirmed on the next poll, not two polls later.
        down.clear()
        rep = fx.poller.poll_radar("BR-MCZ")
        self.assertEqual(rep.downloaded, 3)

    def test_unknown_sizes_wait_on_the_scans_age(self):
        fx = Fixture(self.tmp)
        young = f"{stamp(NOW - 300)}00dBZ.vol"            # scan 5 min ago: maybe still being written
        old = f"{stamp(NOW - 1200)}00dBZ.vol"             # 20 min ago: surely complete
        files = {young: b"y" * 50, old: b"o" * 70}
        self._probing(fx, files, lambda ref: None)
        rep = fx.poller.poll_radar("BR-MCZ")
        self.assertEqual((rep.downloaded, rep.names, rep.confirming), (1, [old], 1))
        rep = fx.poller.poll_radar("BR-MCZ")              # listed twice, still no size: not proof
        self.assertEqual((rep.downloaded, rep.confirming), (0, 1))
        fx.clock.t += 400                                 # now 11+ min after its scan
        rep = fx.poller.poll_radar("BR-MCZ")
        self.assertEqual((rep.downloaded, rep.names), (1, [young]))

    def test_head_answers(self):
        src = HttpIndexSource.__new__(HttpIndexSource)

        class Resp:
            def __init__(self, status, length=None):
                self.status_code = status
                self.headers = {"Content-Length": length} if length else {}

            def close(self):
                pass
        answers = {"a": Resp(200, "123"), "b": Resp(405), "c": Resp(403), "d": Resp(404), "e": Resp(503),
                   "f": Resp(200)}
        src._request = lambda method, ref, headers=None: answers[ref]
        self.assertEqual(src._probe("a"), 123)
        self.assertIsNone(src._probe("b"))                # no HEAD
        self.assertIsNone(src._probe("c"))                # a GET-only server or a WAF: size unknown
        self.assertIsNone(src._probe("f"))                # no Content-Length
        with self.assertRaises(SourceGone):
            src._probe("d")
        with self.assertRaises(SourceError) as e:
            src._probe("e")
        self.assertNotIsInstance(e.exception, SourceGone)

    def test_cemaden_network_sources_settle_by_default(self):
        cfg = from_dict({
            "storage": {"kind": "local", "path": str(self.tmp / "data")},
            "sources": {
                "ftp": {"type": "cemaden", "transport": "ftp", "host": "ftp.example.org"},
                "ftp5": {"type": "cemaden", "transport": "ftp", "host": "ftp.example.org", "settle_seconds": 5},
                "drop": {"type": "cemaden", "transport": "local", "path": str(self.tmp / "{site}")},
            },
            "radars": [{"id": "BR-MCZ", "source": "ftp"}, {"id": "BR-NAT", "source": "ftp5"},
                       {"id": "BR-SSA", "source": "drop"}]}, base_dir=self.tmp)
        self.assertEqual(make_source(cfg.radar("BR-MCZ"), cfg).settle_s, 30.0)
        self.assertEqual(make_source(cfg.radar("BR-NAT"), cfg).settle_s, 5.0)
        self.assertEqual(make_source(cfg.radar("BR-SSA"), cfg).settle_s, 0.0)


class TestApiOnlyRefresh(TmpCase):
    def _count_reads(self, storage) -> list[str]:
        reads: list[str] = []
        real = storage.read_meta_if_changed
        storage.read_meta_if_changed = lambda key, token: (reads.append(key), real(key, token))[1]
        return reads

    def test_forced_refreshes_are_rate_limited(self):
        fx = Fixture(self.tmp)
        mono = _Mono()
        with mock.patch.object(index_module, "time", mono):
            idx = Index(fx.storage).open()
            reads = self._count_reads(fx.storage)
            for _ in range(50):
                idx.refresh(force=True, force_interval=index_module.FORCE_INTERVAL)    # as the API asks
            self.assertEqual(len(reads), 1)
            mono.t += 1.0
            idx.refresh(force=True, force_interval=index_module.FORCE_INTERVAL)
            self.assertEqual(len(reads), 2)
            mono.t += 0.2
            idx.refresh()                             # an ordinary call: 5 s since the last read
            self.assertEqual(len(reads), 2)
            mono.t += 5
            idx.refresh()
            self.assertEqual(len(reads), 3)
            idx.refresh(force=True)                   # a caller's own force (no interval): always reads
            idx.refresh(force=True)
            self.assertEqual(len(reads), 5)

    def test_misses_force_a_read_only_for_newer_stamps(self):
        fx = Fixture(self.tmp)
        fx.poller.poll_once()
        mono = _Mono()
        with mock.patch.object(index_module, "time", mono):
            follower = Index(fx.storage).open()       # an --api-only process, loaded just now
            reads = self._count_reads(fx.storage)
            app = create_app(fx.cfg, fx.storage, follower, follow_index=True, now=fx.clock)
            with ApiServer(app) as base:
                def get(st: str, name: str) -> int:
                    return requests.get(f"{base}/v1/files/BR-MCZ/{st}/{name}", timeout=10).status_code

                # Misses at or below the newest indexed volume: no store read at all.
                for _ in range(5):
                    self.assertEqual(get(fx.s_new, "nope00dBZ.vol"), 404)
                    self.assertEqual(get(fx.s_mid, f"{fx.s_mid}00W.vol"), 404)
                self.assertEqual(reads, [])
                # Newer than the newest: one forced read, then at most one a second.
                newer = stamp(NOW - 0.5 * H)
                for _ in range(10):
                    self.assertEqual(get(newer, f"{newer}00dBZ.vol"), 404)
                self.assertEqual(len(reads), 1)
                mono.t += 0.5
                self.assertEqual(get(newer, f"{newer}00dBZ.vol"), 404)
                self.assertEqual(len(reads), 1)
                # The poller stores that volume; the next forced read finds it.
                write(fx.src / "maceio" / f"{newer}00dBZ.vol", b"n" * 99)
                self.assertEqual(fx.poller.poll_radar("BR-MCZ").downloaded, 1)
                fx.poller.finish_round()              # index.json written
                mono.t += 0.6
                self.assertEqual(get(newer, f"{newer}00dBZ.vol"), 200)
                self.assertEqual(len(reads), 2)


# ---------------------------------------------------------------------------
class TestStartupChecks(TmpCase):
    def setUp(self):
        super().setUp()
        self._env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)
        super().tearDown()

    def test_public_base_url_never_on_the_captcha_host(self):
        for url in ("https://mapainterativo.cemaden.gov.br/radar", "//MapaInterativo.cemaden.gov.br./x",
                    "mapainterativo.cemaden.gov.br/files", "https://cdn.mapainterativo.cemaden.gov.br"):
            with self.assertRaises(ConfigError, msg=url):
                from_dict({"api": {"public_base_url": url}})
        os.environ["RELAY_PUBLIC_BASE_URL"] = "https://mapainterativo.cemaden.gov.br/"
        with self.assertRaises(ConfigError):
            from_dict({"api": {"public_base_url": "https://files.example.org"}})
        with self.assertRaises(ConfigError):
            load_config(HERE.parent / "config.example.toml")
        del os.environ["RELAY_PUBLIC_BASE_URL"]
        cfg = from_dict({"api": {"public_base_url": "https://files.example.org/radar"}})
        self.assertEqual(cfg.api.public_base_url, "https://files.example.org/radar")
        # A configuration changed after loading is refused by the API too.
        cfg.api.public_base_url = "https://mapainterativo.cemaden.gov.br"
        st = LocalStorage(self.tmp / "d")
        with self.assertRaises(ValueError):
            create_app(cfg, st, Index(st))

    def test_source_mistakes_are_configuration_errors(self):
        bad = [
            {"type": "cemaden", "transport": "gopher"},
            {"type": "nasa_vn", "only_dates": ["2026-02-30"]},
            {"type": "nasa_vn", "only_dates": "24/02/2026"},
            {"type": "nasa_vn", "only_dates": 20260224},
            {"type": "local", "path": "x", "filename_regex": "("},
            {"type": "http_index", "url": "http://h/", "link_regex": "[a-"},
            {"type": "local", "path": "x", "names": "klingon"},
        ]
        for table in bad:
            with self.assertRaises(ConfigError, msg=str(table)):
                from_dict({"sources": {"x": table}, "radars": [{"id": "BR-MCZ", "source": "x"}]})
        with self.assertRaises(ConfigError):                 # through a radar's own source_options too
            from_dict({"sources": {"x": {"type": "cemaden", "transport": "local", "path": "p"}},
                       "radars": [{"id": "BR-MCZ", "source": "x", "source_options": {"transport": "smtp"}}]})
        with self.assertRaises(ConfigError):
            from_dict({"relay": {"recheck_seconds": -1}})
        # only_dates from the environment is one comma-separated string.
        os.environ["RELAY_NASA_ONLY_DATES"] = "2026-02-24, 2026-02-25"
        os.environ["RELAY_RECHECK_SECONDS"] = "3"
        cfg = from_dict({"sources": {"nasa": {"type": "nasa_vn"}}, "radars": [{"id": "BR-MCZ", "source": "nasa"}]})
        self.assertEqual(cfg.radar("BR-MCZ").options["only_dates"], ["2026-02-24", "2026-02-25"])
        self.assertEqual(len(make_source(cfg.radar("BR-MCZ"), cfg).only), 2)
        self.assertEqual(cfg.recheck_seconds, 3)

    def _main(self, source_toml: str) -> tuple[int, str]:
        conf = self.tmp / "relay.toml"
        conf.write_text(f'[storage]\nkind = "local"\npath = {json.dumps(str(self.tmp / "data"))}\n'
                        f'[sources.x]\n{source_toml}\n[[radars]]\nid = "BR-MCZ"\nsource = "x"\n', encoding="utf-8")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = relay_main(["--config", str(conf), "--once"])
        return code, err.getvalue()

    def test_main_exits_2_with_a_message(self):
        code, err = self._main('type = "cemaden"\ntransport = "gopher"\npath = "drop"')
        self.assertEqual(code, 2)
        self.assertTrue(err.startswith("configuration: ") and "transport" in err, err)
        # One only building the source finds out: caught around Poller(), same answer.
        code, err = self._main('type = "local"\npath = "drop"\ntimeout = "soon"')
        self.assertEqual(code, 2)
        self.assertTrue(err.startswith("configuration: ") and "soon" in err, err)


if __name__ == "__main__":
    unittest.main(verbosity=2)
