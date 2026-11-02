"""
brazil_radar's CF/Radial reader (NASA's GPM-VN volumes of the CEMADEN radars)
and the store around it: gzip, the DMS slip in NASA's positions, the ZDR
calibration and its zdrOffsetDb in the products' meta, the moments kept, the
cached volume against info.json, and the radars the relay hook lists.

Every store here is a temporary folder, set before brazil_radar is imported:
the user's own volumes (~/.weatherts/radar-br) are never read or written. The
one real volume read is NASA's sample, when it is on this machine.

Run from the repository root:
    backend/.venv/Scripts/python.exe -m unittest discover -s backend/tests -v
"""
from __future__ import annotations

import gzip
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

BACKEND = Path(__file__).resolve().parents[1]
_TMP = Path(tempfile.mkdtemp(prefix="weatherts-cfradial-test-"))
os.environ["WEATHERTS_RADAR_BR"] = str(_TMP / "store")
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import h5py  # noqa: E402
import numpy as np  # noqa: E402

import brazil_radar as br  # noqa: E402

# One of NASA's own files (Maceio, 2026-02-24 13:30 UTC), downloaded by hand.
SAMPLE = Path(r"C:\Users\pablo\AppData\Local\Temp\brf\gv\vol\MC1_2026_0224_133002.cf.gz")
CANONICAL = {"DBZH", "TH", "VRAD", "WRAD", "ZDR", "RHOHV", "PHIDP", "KDP"}
# What the products need of the model, without asking Open-Meteo.
ENV = {"h0": 4600.0, "h20": 7900.0, "source": "test column", "wind": [], "motion": {"speedKt": 0.0, "toward": 0.0}}


def tearDownModule() -> None:  # noqa: N802 - unittest's name
    shutil.rmtree(_TMP, ignore_errors=True)


def _chars(s: str, n: int = 32) -> np.ndarray:
    return np.array([c.encode() for c in s.ljust(n, "\0")], dtype="S1")


def make_cf(*, ident="MC1", lat=-8.448888888888888, lon=-34.22944444444445, with_cz=True, zdr_bias=-2.75,
            tcs="2026-02-24T13:30:02Z", ident_as_var=False, gz=True, t_shift=0.0, drop=(), extras=True) -> bytes:
    """A small CF/Radial volume as NASA writes them: 2 PPI sweeps of 360 rays
    and one RHI, 100 gates of 250 m; the position with NASA's DMS slip (the
    defaults are Maceio's); ZDR off by `zdr_bias` over light rain's 0.25 dB;
    two of NASA's own products (FH, RC) unless `extras` is False; any field
    named in `drop` left out."""
    nr, ng = 360, 100
    bio = io.BytesIO()
    with h5py.File(bio, "w") as f:
        if not ident_as_var:
            f.attrs["instrument_name"] = np.bytes_(ident.encode())
        else:
            f.create_dataset("instrument_name", data=_chars(ident))
        f.attrs["Conventions"] = np.bytes_(b"CF/Radial")
        rays = 2 * nr + 10
        # Ray centres, the first sweep starting at 100.5 deg (out of order).
        az0 = np.mod(np.arange(nr) + 100.5, 360.0)
        az1 = np.mod(np.arange(nr) + 200.5, 360.0)
        azr = np.full(10, 45.0)
        f.create_dataset("azimuth", data=np.concatenate([az0, az1, azr]).astype(np.float32))
        f.create_dataset("elevation", data=np.concatenate(
            [np.full(nr, 0.5), np.full(nr, 1.5), np.linspace(0, 20, 10)]).astype(np.float32))
        t = np.concatenate([np.arange(nr) * 0.08, 30 + np.arange(nr) * 0.08, 60 + np.arange(10) * 0.1]) + t_shift
        tv = f.create_dataset("time", data=t.astype(np.float64))
        tv.attrs["units"] = np.bytes_(b"seconds since 2026-02-24T13:30:02Z")
        rv = f.create_dataset("range", data=(125.0 + 250.0 * np.arange(ng)).astype(np.float32))
        rv.attrs["units"] = np.bytes_(b"meters")
        f.create_dataset("sweep_start_ray_index", data=np.array([0, nr, 2 * nr], dtype=np.int32))
        f.create_dataset("sweep_end_ray_index", data=np.array([nr - 1, 2 * nr - 1, 2 * nr + 9], dtype=np.int32))
        f.create_dataset("fixed_angle", data=np.array([0.5, 1.5, 0.0], dtype=np.float32))
        f.create_dataset("sweep_mode", data=np.stack(
            [_chars("azimuth_surveillance"), _chars("azimuth_surveillance"), _chars("rhi")]))
        f.create_dataset("nyquist_velocity", data=np.concatenate(
            [np.full(nr, 26.5), np.zeros(nr), np.zeros(10)]).astype(np.float32))
        f.create_dataset("latitude", data=np.float64(lat))
        f.create_dataset("longitude", data=np.float64(lon))
        f.create_dataset("altitude", data=np.float64(102.0))
        f.create_dataset("frequency", data=np.array([2.8e9], dtype=np.float32))
        f.create_dataset("time_coverage_start", data=_chars(tcs))

        def put(name: str, data: np.ndarray):
            return None if name in drop else f.create_dataset(name, data=data)

        # Reflectivity 24 dBZ everywhere but ray 0 of each PPI (40 dBZ), gate 0 missing.
        z = np.full((rays, ng), 24.0)
        z[0, :] = 40.0
        z[nr, :] = 40.0
        packed = np.rint((z + 32.0) / 0.5).astype(np.int16)
        packed[:, 0] = -32768
        if with_cz and (cz := put("CZ", packed)) is not None:
            cz.attrs["scale_factor"] = np.float32(0.5)
            cz.attrs["add_offset"] = np.float32(-32.0)
            cz.attrs["_FillValue"] = np.int16(-32768)
        dz = put("DZ", (packed + 2).astype(np.int16))   # +1 dBZ over CZ
        if dz is not None:
            dz.attrs["scale_factor"] = np.float32(0.5)
            dz.attrs["add_offset"] = np.float32(-32.0)
            dz.attrs["_FillValue"] = np.int16(-32766)    # (-32768 + 2)
        v = np.full((rays, ng), 5.0, dtype=np.float32)
        v[:, 1] = -327.68          # UF's own mark
        v[:, 2] = -9999.0
        vv = put("VEL", v)
        if vv is not None:
            vv.attrs["_FillValue"] = np.float32(-9999.0)
        put("WIDTH", np.full((rays, ng), 1.5, dtype=np.float32))
        put("ZDR", np.full((rays, ng), 0.25 + zdr_bias, dtype=np.float32))
        put("RHOHV", np.full((rays, ng), 0.99, dtype=np.float32))
        put("SNR", np.full((rays, ng), 30.0, dtype=np.float32))
        put("KDP", np.full((rays, ng), 0.1, dtype=np.float64))
        if extras:
            put("FH", np.full((rays, ng), 2.0, dtype=np.float32))     # NASA's hydrometeor class
            put("RC", np.full((rays, ng), 1.2, dtype=np.float32))     # and one of its rain rates
    raw = bio.getvalue()
    return gzip.compress(raw) if gz else raw


class _TempStore(unittest.TestCase):
    """A fresh store per test, the caches cleared, the store and the relay
    hook put back as they were after."""

    def setUp(self) -> None:
        self._old_store = br.STORE
        self._old_hook = br.EXTRA_SITES
        self.store = Path(tempfile.mkdtemp(dir=_TMP)) / "store"
        self.store.mkdir()
        br.STORE = self.store
        self.assertTrue(str(br.STORE).startswith(str(_TMP)))     # never the user's store
        self._clear()

    def tearDown(self) -> None:
        self._clear()
        br.EXTRA_SITES = self._old_hook
        br.STORE = self._old_store

    @staticmethod
    def _clear() -> None:
        with br._LOCK:  # noqa: SLF001
            br._VOLUMES.clear()  # noqa: SLF001
            br._GRIDS.clear()  # noqa: SLF001


# ---------------------------------------------------------------------------
# The reader
# ---------------------------------------------------------------------------
class GunzipTest(unittest.TestCase):
    def test_members_and_damage(self):
        a, b = b"hello " * 1000, b"world" * 10
        self.assertEqual(br._gunzip(gzip.compress(a) + gzip.compress(b)), a + b)
        with self.assertRaises(ValueError):
            br._gunzip(gzip.compress(a)[:-20])
        with self.assertRaises(ValueError):
            br._gunzip(b"\x1f\x8b" + b"\x00" * 30)

    def test_size_cap(self):
        old = br._GUNZIP_MAX
        try:
            br._GUNZIP_MAX = 1000
            with self.assertRaises(ValueError):
                br._gunzip(gzip.compress(b"x" * 5000))
            self.assertEqual(len(br._gunzip(gzip.compress(b"x" * 1000))), 1000)
        finally:
            br._GUNZIP_MAX = old

    def test_read_any_rejects(self):
        with self.assertRaises(ValueError):
            br.read_any(gzip.compress(b"not a radar file"))
        with self.assertRaises(ValueError):
            br.read_any(b"CDF\x01" + b"\x00" * 100)


class DmsTest(unittest.TestCase):
    def test_slip(self):
        self.assertAlmostEqual(br._dms_slip(-8.448888888888888), -9.551111111111112, places=9)
        self.assertAlmostEqual(br._dms_slip(-34.22944444444445), -35.77055555555555, places=9)
        self.assertEqual(br._dms_slip(12.5), 12.5)
        self.assertEqual(br._dms_slip(-9.0), -9.0)


class CfRadialTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vol = br.read_any(make_cf(), "MC1_2026_0224_133002.cf.gz")

    def test_identity_and_position(self):
        v = self.vol
        self.assertEqual(v.radar, "BR-MCZ")
        self.assertEqual(v.ident, "MC1")
        self.assertAlmostEqual(v.lat, -9.5511, places=3)
        self.assertAlmostEqual(v.lon, -35.7706, places=3)
        self.assertEqual(v.alt_m, 102.0)
        self.assertEqual(br._stamp(v.unix), "20260224133002")
        self.assertAlmostEqual(v.wavelength_m, 299792458.0 / 2.8e9, places=4)

    def test_sweeps(self):
        v = self.vol
        self.assertEqual([s.elev for s in v.sweeps], [0.5, 1.5])          # the RHI is left out
        s0, s1 = v.sweeps
        self.assertEqual(s0.nrays, 360)
        self.assertAlmostEqual(s0.r0_km, 0.0)
        self.assertAlmostEqual(s0.dr_km, 0.25)
        self.assertEqual(s0.unix, v.unix)
        self.assertEqual(s1.unix, v.unix + 30)
        self.assertAlmostEqual(s0.nyquist, 26.5)
        self.assertIsNone(s1.nyquist)                                     # zeros mean unknown
        # Centres -> starts, sorted: 0, 1, ..., 359.
        np.testing.assert_allclose(s0.az, np.arange(360), atol=1e-4)
        self.assertEqual(s0.az.dtype, np.float32)

    def test_moments(self):
        s0 = self.vol.sweeps[0]
        # Only the moments the products use: no SNR, no NASA products, no copy of the published ZDR.
        self.assertEqual(set(s0.data), {"DBZH", "TH", "VRAD", "WRAD", "ZDR", "RHOHV", "KDP"})
        for k, a in s0.data.items():
            self.assertEqual(a.dtype, np.float32, k)
            self.assertEqual(a.shape, (360, 100), k)
        z = s0.data["DBZH"]
        # The file's first ray (40 dBZ) started at 100 deg: now row 100.
        self.assertAlmostEqual(float(z[100, 5]), 40.0)
        self.assertAlmostEqual(float(z[101, 5]), 24.0)
        self.assertTrue(np.isnan(z[:, 0]).all())                          # _FillValue on packed numbers
        self.assertAlmostEqual(float(s0.data["TH"][101, 5]), 25.0)       # DZ: the unfiltered one
        vr = s0.data["VRAD"]
        self.assertTrue(np.isnan(vr[:, 1]).all() and np.isnan(vr[:, 2]).all())
        self.assertAlmostEqual(float(vr[0, 3]), 5.0)

    def test_zdr_offset(self):
        v = self.vol
        self.assertAlmostEqual(v.zdr_offset_db, -2.75, places=2)
        for s in v.sweeps:
            self.assertAlmostEqual(float(s.data["ZDR"][101, 50]), 0.25, places=3)
            self.assertNotIn("UZDR", s.data)                              # the number only

    def test_small_bias_untouched_and_dz_alone(self):
        v = br.read_any(make_cf(with_cz=False, zdr_bias=0.3, ident="XYZ", lat=-8.5, lon=-34.2, ident_as_var=True),
                        "x.cf.gz")
        self.assertIsNone(v.zdr_offset_db)
        s0 = v.sweeps[0]
        self.assertNotIn("UZDR", s0.data)
        self.assertNotIn("TH", s0.data)
        self.assertAlmostEqual(float(s0.data["DBZH"][101, 5]), 25.0)    # DZ is the reflectivity now
        self.assertAlmostEqual(float(s0.data["ZDR"][101, 50]), 0.55, places=3)   # as the file says
        self.assertEqual(v.ident, "XYZ")
        self.assertEqual(v.radar, "BR-XYZ")
        self.assertEqual((v.lat, v.lon), (-8.5, -34.2))                  # unknown radar: as the file says

    def test_plain_hdf5_and_detection(self):
        raw = make_cf(gz=False)
        self.assertEqual(br.read_hdf5(raw).radar, "BR-MCZ")              # not mistaken for GAMIC
        self.assertEqual(br.read_cfradial(make_cf()).radar, "BR-MCZ")   # bytes, gzipped
        # A file with none of the moments drawn here says so, rather than filing empty sweeps.
        with self.assertRaises(ValueError):
            br.read_any(make_cf(drop=("CZ", "DZ", "VEL", "WIDTH", "ZDR", "RHOHV", "KDP")))


# ---------------------------------------------------------------------------
# The store
# ---------------------------------------------------------------------------
class ImportTest(_TempStore):
    def test_import_and_grouping(self):
        a = br.import_file("MC1_2026_0224_133002.cf.gz", make_cf())
        b = br.import_file("MC1_other.cf.gz", make_cf(tcs="2026-02-24T13:30:47Z"))   # 45 s later: same volume
        c = br.import_file("MC1_late.cf.gz", make_cf(tcs="2026-02-24T13:40:02Z"))    # 10 min later: next
        self.assertEqual(a["stamp"], "20260224133002")
        self.assertEqual(b["stamp"], "20260224133002")
        self.assertEqual(c["stamp"], "20260224134002")
        kept = self.store / "BR-MCZ" / "20260224133002" / "MC1_2026_0224_133002.cf.gz"
        self.assertEqual(kept.read_bytes()[:2], b"\x1f\x8b")              # stored as it came
        vols = br.volumes("BR-MCZ")
        self.assertEqual([v["stamp"] for v in vols], ["20260224133002", "20260224134002"])
        self.assertTrue(set(vols[0]["moments"]) <= CANONICAL)            # info.json: no UZDR, no FH/RC
        vol = br.load("BR-MCZ", "20260224133002")
        self.assertEqual(len(vol.sweeps), 2)
        self.assertEqual(sorted(vol.files), ["MC1_2026_0224_133002.cf.gz", "MC1_other.cf.gz"])

    def test_bad_ids_and_stamps(self):
        br.import_file("MC1_2026_0224_133002.cf.gz", make_cf())
        self.assertEqual(br.volumes("BR-../BR-MCZ"), [])
        self.assertEqual(br.volumes("br-mcz"), [])
        with self.assertRaises(ValueError):
            br.load("BR-MCZ", "../BR-MCZ/20260224133002")
        with self.assertRaises(ValueError):
            br.load("BR-MCZ", "20260224133003")                          # no such volume


class ZdrMetaTest(_TempStore):
    """zdrOffsetDb: on ZDR, the classification and the rain rate of a
    corrected volume -- the dB added to the published ZDR -- and nowhere else."""

    def setUp(self) -> None:
        super().setUp()
        p1 = mock.patch.object(br, "environment", lambda lat, lon, unix: ENV)
        p2 = mock.patch.object(br, "_palette", lambda kind: ("TEST", -32.0, 200.0))
        p1.start()
        p2.start()
        self.addCleanup(p1.stop)
        self.addCleanup(p2.stop)

    def test_corrected_volume(self):
        st = br.import_file("MC1_2026_0224_133002.cf.gz", make_cf(zdr_bias=-2.9))["stamp"]
        key = f"L2BR:{st}"
        self.assertAlmostEqual(br.load("BR-MCZ", st).zdr_offset_db, -2.9, places=2)
        for code in ("L2X0", "L2H0", "L2Q0", "L2X1"):    # ZDR, classification, rain rate; both sweeps
            meta = br.polar("BR-MCZ", code, key)["meta"]
            self.assertEqual(meta["zdrOffsetDb"], 2.9, code)
        for code in ("L2B0", "L2G0", "L2C0", "L2VCR"):
            self.assertNotIn("zdrOffsetDb", br.polar("BR-MCZ", code, key)["meta"], code)
        # What is drawn is the corrected ZDR: 0.25 dB over light rain.
        out = br.polar("BR-MCZ", "L2X0", key)
        codes = out["codes"][101, 50]
        self.assertAlmostEqual(float(out["lut"][codes]), 0.25, delta=0.5)

    def test_uncorrected_volume(self):
        st = br.import_file("MC1_2026_0224_133002.cf.gz", make_cf(zdr_bias=0.3))["stamp"]
        for code in ("L2X0", "L2H0", "L2Q0"):
            self.assertNotIn("zdrOffsetDb", br.polar("BR-MCZ", code, f"L2BR:{st}")["meta"], code)


class CacheTest(_TempStore):
    """load() against import_file: a cached volume that misses a file its
    folder lists now is read again -- once."""

    STAMP = "20260224133002"

    def _stale_copy(self) -> br.Volume:
        """The race: a load() read the folder before the second file was filed,
        and put its volume back after import_file had dropped the cache."""
        br.import_file("MC1_2026_0224_133002.cf.gz", make_cf(drop=("KDP",)))
        old = br.load("BR-MCZ", self.STAMP)
        self.assertNotIn("KDP", old.sweeps[0].data)
        br.import_file("MC1_kdp.cf.gz", make_cf(tcs="2026-02-24T13:30:05Z"))
        self.assertNotIn(("BR-MCZ", self.STAMP), br._VOLUMES)  # noqa: SLF001 - import_file dropped it
        with br._LOCK:  # noqa: SLF001
            br._VOLUMES[("BR-MCZ", self.STAMP)] = old  # noqa: SLF001
        return old

    def test_reload_after_race(self):
        old = self._stale_copy()
        new = br.load("BR-MCZ", self.STAMP)
        self.assertIsNot(new, old)
        self.assertEqual(sorted(new.files), ["MC1_2026_0224_133002.cf.gz", "MC1_kdp.cf.gz"])
        self.assertIn("KDP", new.sweeps[0].data)
        self.assertIs(br.load("BR-MCZ", self.STAMP), new)              # and cached from then on

    def test_unreadable_listed_file_reloads_once(self):
        br.import_file("MC1_2026_0224_133002.cf.gz", make_cf())
        first = br.load("BR-MCZ", self.STAMP)
        vdir = self.store / "BR-MCZ" / self.STAMP
        (vdir / "broken.cf.gz").write_bytes(b"not a volume")
        info = json.loads((vdir / "info.json").read_text(encoding="utf-8"))
        info["files"].append("broken.cf.gz")
        (vdir / "info.json").write_text(json.dumps(info), encoding="utf-8")
        second = br.load("BR-MCZ", self.STAMP)
        self.assertIsNot(second, first)
        self.assertIs(br.load("BR-MCZ", self.STAMP), second)           # not again on every call

    def test_grid_of_a_stale_volume_not_cached(self):
        old = self._stale_copy()
        with mock.patch.object(br, "_palette", lambda kind: ("TEST", -32.0, 200.0)):
            with mock.patch.object(br, "load", lambda radar, stamp: old):
                br.polar("BR-MCZ", "L2B0", f"L2BR:{self.STAMP}")
            self.assertNotIn(("BR-MCZ", self.STAMP, "L2B0"), br._GRIDS)  # noqa: SLF001
            br.polar("BR-MCZ", "L2B0", f"L2BR:{self.STAMP}")
            self.assertIn(("BR-MCZ", self.STAMP, "L2B0"), br._GRIDS)  # noqa: SLF001


class SitesHookTest(_TempStore):
    """EXTRA_SITES: the relay's radars beside the ones kept here."""

    NEWEST = int(datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc).timestamp())

    def setUp(self) -> None:
        super().setUp()
        br.import_file("MC1_2026_0224_133002.cf.gz", make_cf())

    def hook(self):
        return [
            {"id": "BR-MCZ", "name": "Maceio", "lat": -9.55, "lon": -35.77, "newest": self.NEWEST, "live": True,
             "operator": "CEMADEN"},
            {"id": "br-nat", "name": "Natal (RN)", "lat": -5.8969, "lon": -35.2479, "newest": self.NEWEST,
             "live": True, "operator": "CEMADEN"},
            {"id": "BR-SSA", "name": "", "lat": "x", "lon": None, "newest": None, "live": False, "operator": ""},
            {"id": "BR-QQQ", "name": "Nowhere", "lat": None, "lon": None, "newest": None, "live": True},
            {"id": "../etc", "lat": 0, "lon": 0},
            "not a dict",
        ]

    def test_no_hook(self):
        br.EXTRA_SITES = None
        s = br.sites()
        self.assertEqual([x["id"] for x in s], ["BR-MCZ"])
        self.assertIs(s[0]["live"], False)                               # an archive case

    def test_merge(self):
        br.EXTRA_SITES = self.hook
        by = {x["id"]: x for x in br.sites()}
        self.assertEqual(set(by), {"BR-MCZ", "BR-NAT", "BR-SSA"})        # BR-QQQ: nowhere to draw it
        for x in by.values():
            self.assertIsInstance(x["live"], bool)
        mcz = by["BR-MCZ"]                                               # the local entry, live from the hook
        self.assertEqual(mcz["volumes"], 1)
        self.assertEqual(mcz["name"], "Maceió (AL) · CEMADEN")
        self.assertEqual(mcz["lastScanDay"], "2026-02-24")
        self.assertIs(mcz["live"], True)
        nat = by["BR-NAT"]                                               # only the relay has it
        self.assertEqual((nat["volumes"], nat["online"], nat["live"]), (0, True, True))
        self.assertEqual(nat["lastScanDay"], "2026-10-17")
        self.assertEqual(nat["name"], "Natal (RN) · CEMADEN")
        self.assertEqual((nat["lat"], nat["lon"], nat["icao"], nat["country"]), (-5.8969, -35.2479, "NAT", "BR"))
        ssa = by["BR-SSA"]                                               # bad position: the table's
        self.assertEqual((ssa["lat"], ssa["lon"]), (br.RADARS["BR-SSA"]["lat"], br.RADARS["BR-SSA"]["lon"]))
        self.assertEqual((ssa["online"], ssa["live"], ssa["lastScanDay"]), (False, False, None))
        self.assertEqual(ssa["name"], "Salvador (BA) · CEMADEN")

    def test_hook_failure(self):
        def boom():
            raise RuntimeError("relay client broke")

        for hook in (boom, lambda: None, lambda: 42):
            br.EXTRA_SITES = hook
            s = br.sites()
            self.assertEqual([x["id"] for x in s], ["BR-MCZ"])
            self.assertIs(s[0]["live"], False)

    def test_hook_only_radar_has_nothing_yet(self):
        br.EXTRA_SITES = self.hook
        self.assertEqual(br.scans("BR-NAT"), [])
        self.assertEqual(br.scans("BR-NAT", 10, int(time.time()) - 3600), [])
        a = br.availability("BR-NAT")
        self.assertEqual(a["cuts"], [])
        self.assertIsNone(a["newestScan"])
        self.assertTrue(a["families"])
        self.assertTrue(all(t == [] for t in a["families"].values()))
        for fid in ("B", "L2X", "H", "RR", "CR", "POSH"):
            self.assertEqual(a["families"][fid], [], fid)
        self.assertEqual(br.cuts("BR-NAT")["cuts"], [])
        with self.assertRaises(RuntimeError):
            br.polar("BR-NAT", "L2B0")


@unittest.skipUnless(SAMPLE.is_file(), "NASA's sample volume is not on this machine")
class SampleTest(unittest.TestCase):
    def test_sample(self):
        v = br.read_any(SAMPLE.read_bytes(), SAMPLE.name)
        self.assertEqual(v.radar, "BR-MCZ")
        self.assertEqual(len(v.sweeps), 16)
        self.assertEqual(round(v.sweeps[0].elev, 2), 1.0)
        self.assertEqual(round(v.sweeps[-1].elev, 2), 25.0)
        self.assertLess(br._km(v.lat, v.lon, -9.5409, -35.7587), 5.0)
        for m in CANONICAL:
            self.assertTrue(all(m in s.data for s in v.sweeps), m)
        self.assertEqual({m for s in v.sweeps for m in s.data}, CANONICAL)   # SD FH DM NW MW MI RC RP left out
        z = np.concatenate([s.data["DBZH"].ravel() for s in v.sweeps])
        z = z[np.isfinite(z)]
        self.assertTrue(-30 <= z.min() and z.max() <= 75)
        self.assertIsNotNone(v.zdr_offset_db)
        self.assertLess(v.zdr_offset_db, -0.5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
