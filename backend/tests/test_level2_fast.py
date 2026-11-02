"""
level2_fast: one moment of a Level II volume read straight from its bytes.

A small volume is built here message by message -- a volume header, the scan
strategy (message 5) and message 31 radials over three sweeps, one of them a
split cut's second pass -- stored as bz2 records the way the archive keeps
them. The fast reader must give radar_xsect._stack exactly what MetPy's parse
gives it; a legacy volume must be left to MetPy.

Run from the repository root:
    backend/.venv/Scripts/python.exe -m unittest discover -s backend/tests -v
"""
from __future__ import annotations

import bz2
import gzip
import struct
import sys
import unittest
from pathlib import Path
from unittest import mock

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import numpy as np  # noqa: E402

import level2_fast  # noqa: E402
import radar_xsect as xs  # noqa: E402

RNG = np.random.default_rng(7)
LAT, LON, AMSL, FEED, VCP = 35.3331, -97.2778, 370, 20, 212


def _frame(mtype: int, body: bytes, fixed: bool) -> bytes:
    if len(body) % 2:
        body += b"\0"
    hdr = struct.pack(">HBBHHIHH", (16 + len(body)) // 2, 8, mtype, 1, 20000, 1000, 1, 1)
    msg = b"\0" * 12 + hdr + body
    return msg + b"\0" * (2432 - len(msg)) if fixed else msg


def _msg5(angles: list[float]) -> bytes:
    els = b"".join(struct.pack(">H", int(round(a * 65536 / 360.0))) + b"\0" * 44 for a in angles)
    head = struct.pack(">HHHHBBBB4xHH2x", (22 + len(els)) // 2, 2, VCP, len(angles), 1, 1, 2, 1, 0, 0)
    return _frame(5, head + els, fixed=True)


def _block(name: bytes, codes: np.ndarray, first_m: int, width_m: int, scale: float, offset: float) -> bytes:
    hdr = struct.pack(">4sIHHHHhBBff", b"D" + name, 0, codes.size, first_m, width_m, 0, 0, 0, 8, scale, offset)
    return hdr + codes.astype(">u1").tobytes()


def _msg31(az: float, el_num: int, el_angle: float, status: int, blocks: list[bytes]) -> bytes:
    vol = struct.pack(">4sHBBffhHfffffHH", b"RVOL", 44, 2, 0, LAT, LON, AMSL, FEED, 0, 0, 0, 0, 0, VCP, 0)
    parts = [vol, *blocks]
    nblk = len(parts)
    head_len = 32 + 4 * nblk
    ptrs, off = [], head_len
    for p in parts:
        ptrs.append(off)
        off += len(p)
    head = struct.pack(">4sIHHfBxHBBBBfBBH", b"KTST", 1000, 20000, 1, az, 0, off, 1, status, el_num, 1,
                       el_angle, 0, 0, nblk)
    return _frame(31, head + struct.pack(f">{nblk}I", *ptrs) + b"".join(parts), fixed=False)


def _sweep(el_num: int, el_angle: float, nrad: int, moments: dict, first_status: int, rotate: int = 0) -> list[bytes]:
    """`moments`: name -> gates. Radials start `rotate` steps round from north."""
    out = []
    for k in range(nrad):
        az = ((k + rotate) % nrad) * 360.0 / nrad + 0.25
        blocks = [_block(name, RNG.integers(0, 256, gates), 2125, 250, 2.0, 66.0) for name, gates in moments.items()]
        status = first_status if k == 0 else (2 if k == nrad - 1 else 1)
        out.append(_msg31(az, el_num, el_angle, status, blocks))
    return out


def volume(bz: bool = True, legacy: bool = False) -> bytes:
    """Three sweeps: 0.5 surveillance (REF 120 gates), 0.5 Doppler pass (REF 60
    gates + VEL), 1.5 (REF + VEL, radials starting part way round). The
    antenna reads 0.48 and 1.47; the scan strategy says 0.5 and 1.5. The
    same codes every call."""
    global RNG
    RNG = np.random.default_rng(7)
    msgs = [_msg5([0.5, 0.5, 1.5])]
    msgs += _sweep(1, 0.48, 36, {b"REF": 120}, 3)
    msgs += _sweep(2, 0.48, 36, {b"REF": 60, b"VEL": 90}, 0)
    msgs += _sweep(3, 1.47, 24, {b"REF": 80, b"VEL": 80}, 5, rotate=7)
    if legacy:
        msgs.insert(1, _frame(1, b"\0" * 100, fixed=True))
    head = struct.pack(">9s3sII4s", b"AR2V0006.", b"001", 20000, 1000, b"KTST")
    if not bz:
        return head + b"".join(msgs)
    half = len(msgs) // 2
    recs = []
    for chunk in (msgs[:half], msgs[half:]):
        c = bz2.compress(b"".join(chunk))
        recs.append(struct.pack(">i", -len(c)) + c)  # MetPy takes the size's absolute value
    return head + b"".join(recs)


def stack_both(raw: bytes, fam: str) -> tuple[dict, dict]:
    """radar_xsect._stack through level2_fast and through MetPy."""
    xs._STACKS.clear()
    with mock.patch.object(xs, "_raw", return_value=(raw, "20260101-000000")):
        fast = xs._stack("TST", "L2A:fast", "x", fam)
        with mock.patch.object(level2_fast, "read_moment", return_value=None):
            slow = xs._stack("TST", "L2A:metpy", "x", fam)
    xs._STACKS.clear()
    return fast, slow


class PlainTest(unittest.TestCase):
    def test_bz2_records_come_out_as_the_messages(self):
        self.assertEqual(level2_fast.plain(volume(bz=True)), volume(bz=False))

    def test_gzip_and_already_plain(self):
        plain = volume(bz=False)
        self.assertEqual(level2_fast.plain(plain), plain)
        self.assertEqual(level2_fast.plain(gzip.compress(plain)), plain)

    def test_a_broken_record_ends_the_volume_there(self):
        raw = volume(bz=True)
        n = abs(struct.unpack(">i", raw[24:28])[0])
        broken = raw[:28 + n] + struct.pack(">i", 50) + b"x" * 50
        self.assertEqual(level2_fast.plain(broken), raw[:24] + bz2.decompress(raw[28:28 + n]))


class ReadMomentTest(unittest.TestCase):
    def assert_same(self, fast: dict, slow: dict):
        for k in ("lat", "lon", "heightKm", "groundKm", "vcp"):
            self.assertEqual(fast[k], slow[k], k)
        self.assertEqual([s["elev"] for s in fast["sweeps"]], [s["elev"] for s in slow["sweeps"]])
        for a, b in zip(fast["sweeps"], slow["sweeps"]):
            self.assertEqual((a["first"], a["width"]), (b["first"], b["width"]))
            np.testing.assert_array_equal(a["az"], b["az"])
            self.assertEqual(a["vals"].dtype, b["vals"].dtype)
            np.testing.assert_array_equal(a["vals"], b["vals"])

    def test_reflectivity_matches_metpy(self):
        fast, slow = stack_both(volume(), "B")
        self.assert_same(fast, slow)
        # One sweep per angle, the surveillance pass (more gates) for 0.5.
        self.assertEqual([s["elev"] for s in fast["sweeps"]], [0.5, 1.5])
        self.assertEqual(fast["sweeps"][0]["vals"].shape, (36, 120))
        self.assertAlmostEqual(fast["heightKm"], (AMSL + FEED) / 1000.0)
        self.assertEqual(fast["vcp"], VCP)

    def test_velocity_matches_metpy_in_knots(self):
        fast, slow = stack_both(volume(), "G")
        self.assert_same(fast, slow)
        self.assertEqual(fast["sweeps"][0]["vals"].shape, (36, 90))
        self.assertTrue(np.all(np.diff(fast["sweeps"][1]["az"]) > 0))   # sorted from north

    def test_codes_0_and_1_are_no_data(self):
        out = level2_fast.read_moment(volume(bz=False), b"REF")
        self.assertIsNotNone(out)
        v = out["sweeps"][0]["vals"].astype(np.float32)
        self.assertTrue(np.isnan(v).any())
        self.assertGreaterEqual(np.nanmin(v), (2 - 66.0) / 2.0)

    def test_moment_missing_and_legacy_answer_none(self):
        self.assertIsNone(level2_fast.read_moment(volume(bz=False), b"RHO"))
        self.assertIsNone(level2_fast.read_moment(volume(bz=False, legacy=True), b"REF"))
        self.assertIsNone(level2_fast.read_moment(b"not a volume", b"REF"))


if __name__ == "__main__":
    unittest.main()
