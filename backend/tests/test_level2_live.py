"""
level2_live: the Level II volume being written, and the tilts a volume
flies more than once (SAILS / MRLE).

All synthetic, nothing downloaded: chunk listings shaped like the live
bucket's (start chunk, then 120 radials of one cut per chunk), with the scan
strategies read from real volumes on 2026-10-19 (KOKX VCP 212 with one SAILS
cut, KDGX with SAILS on its 0.3 deg low cut, KBMX's 0.40 + 0.48).

Run from the repository root:
    backend/.venv/Scripts/python.exe -m unittest discover -s backend/tests -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import level2_live as lv  # noqa: E402
import nexrad_level2 as l2  # noqa: E402

# (angle, radials) per cut, as _volume_plan reads them.
KOKX = [(0.48, 720), (0.48, 720), (0.88, 720), (0.88, 720), (1.27, 720), (1.27, 720),
        (0.48, 720), (0.48, 720), (1.8, 360), (2.42, 360), (3.08, 360), (4.0, 360), (5.1, 360), (6.42, 360)]
KDGX = [(0.31, 720), (0.31, 720), (0.48, 720), (0.48, 720), (0.88, 720), (0.88, 720), (0.31, 720), (0.31, 720),
        (1.27, 720), (1.27, 720), (1.8, 360), (2.42, 360), (3.08, 360), (4.0, 360), (5.1, 360), (6.42, 360)]
KBMX = [(0.4, 720), (0.4, 720), (0.48, 720), (0.48, 720), (0.88, 720), (0.88, 720), (1.27, 720), (1.27, 720),
        (1.8, 360), (2.42, 360), (3.08, 360), (4.0, 360), (5.1, 360), (6.42, 360)]

STAMP = "20261019-170729"


def listing(n: int, site: str = "KOKX", vol: int = 430, end: bool = False, size: int = 100_000):
    """Chunks 1..n of a volume directory, the last one an end chunk if `end`."""
    out = []
    for c in range(1, n + 1):
        kind = "S" if c == 1 else ("E" if end and c == n else "I")
        out.append((f"{site}/{vol}/{STAMP}-{c:03d}-{kind}", size))
    return out


class KeyTest(unittest.TestCase):
    def test_parse_keys(self):
        self.assertEqual(lv.parse_key("L2P:430:20261019-170729"), (True, 430, STAMP, 1))
        self.assertEqual(lv.parse_key("L2:429:20261019-165751:c2"), (False, 429, "20261019-165751", 2))
        self.assertEqual(lv.parse_key("L2P:430:20261019-170729:c3"), (True, 430, STAMP, 3))
        with self.assertRaises(RuntimeError):
            lv.parse_key("L2A:KTLX20130520_195941_V06.gz:c2")


class PlanTest(unittest.TestCase):
    def test_layout_counts_chunks_per_cut(self):
        lay = lv.layout(KOKX)
        self.assertEqual(lay[0], (2, 6))
        self.assertEqual(lay[6], (38, 6))  # the SAILS cut after six 720-radial cuts
        self.assertEqual(lay[8], (50, 3))
        self.assertEqual(1 + sum(n for _, n in lay), 67)

    def test_sails_is_a_second_scan_of_the_lowest_tilt(self):
        runs = lv.slot_runs(KOKX)
        self.assertEqual(runs["0"], [[0, 1], [6, 7]])  # surveillance + Doppler pair, twice
        self.assertEqual(runs["A"], [[2, 3]])
        self.assertEqual(len(runs["6"]), 1)

    def test_sails_on_the_low_cut(self):
        runs = lv.slot_runs(KDGX)
        self.assertEqual(runs["L"], [[0, 1], [6, 7]])
        self.assertEqual(runs["0"], [[2, 3]])

    def test_close_cuts_keep_their_own_slots(self):
        runs = lv.slot_runs(KBMX)
        self.assertEqual(runs["L"], [[0, 1]])
        self.assertEqual(runs["0"], [[2, 3]])

    def test_avset_volume_holds_the_first_cuts(self):
        # 1 + 8*6 + 3*3 = 58 chunks: the volume stopped after 3.08 deg.
        self.assertEqual(len(lv.flown_plan(KOKX, 58)), 11)
        self.assertEqual(len(lv.flown_plan(KOKX, 67)), 14)

    def test_scan_times_follow_the_chunks(self):
        lay = lv.layout(KOKX)
        runs = lv.slot_runs(KOKX)["0"]
        landed = {2: 1000.0, 38: 1290.0}
        self.assertEqual(lv.run_times(runs, lay, landed, 990, 67), [990.0, 1280.0])
        # No landing times: the share of the chunks between them, of 5 min.
        t = lv.run_times(runs, lay, {}, 990, 67)
        self.assertAlmostEqual(t[1], 990 + 300 * 36 / 67)


class StatusTest(unittest.TestCase):
    def test_volume_coming_in(self):
        ch = listing(27)  # start + 0.5 x2 + 0.9 x2 whole, 2 chunks of 1.3
        prev = {c: 75_000 for c in range(1, 68)}
        st = lv.summarize("KOKX", 430, ch, KOKX, prev, now=0)
        self.assertFalse(st["complete"])
        self.assertEqual(st["cutsPlanned"], 14)
        self.assertEqual(st["cutsDone"], 4)
        self.assertEqual(st["cuts"][4]["got"], 2)
        self.assertEqual(st["bytes"], 27 * 100_000)
        self.assertEqual(st["bytesExpected"], 27 * 100_000 + 40 * 75_000)
        self.assertEqual(sorted(st["scanned"]), ["0", "A"])
        self.assertEqual(st["key"], f"L2P:430:{STAMP}")
        self.assertEqual(len(st["reps"]["0"]), 1)  # the SAILS scan is not in yet

    def test_volume_complete(self):
        st = lv.summarize("KOKX", 430, listing(67, end=True), KOKX, {}, now=0)
        self.assertTrue(st["complete"])
        self.assertEqual(st["cutsDone"], 14)
        self.assertEqual(st["bytesExpected"], st["bytes"])
        self.assertEqual(len(st["reps"]["0"]), 2)

    def test_expected_size_without_a_matching_previous_volume(self):
        st = lv.summarize("KOKX", 430, listing(14), KOKX, {1: 5}, now=0)
        self.assertEqual(st["bytesExpected"], 67 * 100_000)

    def test_stale_volume(self):
        ch = listing(10)
        for k, _ in ch:
            l2._CHUNK_TIMES[k] = "2026-10-19T17:00:00.000Z"  # noqa: SLF001
        st = lv.summarize("KOKX", 430, ch, KOKX, {}, now=1792429200 + 3600)
        self.assertTrue(st["stale"])
        st = lv.summarize("KOKX", 430, ch, KOKX, {}, now=1792429200 + 60)
        self.assertFalse(st["stale"])


class ListingRefreshTest(unittest.TestCase):
    """A volume that has just finished is listed on the next ask, not 2 min on."""

    def tearDown(self):
        l2._LIST_CACHE.pop("KTST", None)  # noqa: SLF001

    def _cache(self, newest_vol, age):
        import time

        l2._LIST_CACHE["KTST"] = (time.time() - age, [{"vol": newest_vol - 1}, {"vol": newest_vol}])  # noqa: SLF001

    def test_previous_volume_missing_from_the_list(self):
        self._cache(5, 60)
        lv._drop_stale_listing("KTST", 7, complete=False)  # noqa: SLF001 - vol 6 is whole now
        self.assertNotIn("KTST", l2._LIST_CACHE)  # noqa: SLF001

    def test_list_up_to_date(self):
        self._cache(6, 60)
        lv._drop_stale_listing("KTST", 7, complete=False)  # noqa: SLF001
        self.assertIn("KTST", l2._LIST_CACHE)  # noqa: SLF001
        lv._drop_stale_listing("KTST", 7, complete=True)  # noqa: SLF001 - 7 itself finished
        self.assertNotIn("KTST", l2._LIST_CACHE)  # noqa: SLF001

    def test_not_more_than_every_ten_seconds(self):
        self._cache(5, 2)
        lv._drop_stale_listing("KTST", 7, complete=False)  # noqa: SLF001
        self.assertIn("KTST", l2._LIST_CACHE)  # noqa: SLF001

    def test_wraps_at_999(self):
        self._cache(999, 60)
        lv._drop_stale_listing("KTST", 1, complete=False)  # noqa: SLF001
        self.assertIn("KTST", l2._LIST_CACHE)  # noqa: SLF001


class ChunkQueueTest(unittest.TestCase):
    """Two foreground requests for one chunk queued behind a busy pool: the
    second waits for the first's fetch instead of cancelling it (that gave the
    first a CancelledError -- a 502 with no detail on SAILS rescans in a loop).
    A background fill's queued chunk is still taken over by a request."""

    def setUp(self):
        import threading
        from concurrent.futures import ThreadPoolExecutor

        self.threading = threading
        self.saved = (l2._POOL, l2._REST, l2._fetch_chunk)  # noqa: SLF001
        self.release = threading.Event()
        self.calls = []

        def fake_fetch(key, url):
            self.calls.append(key)
            try:
                return b"chunk-%d" % key[3]
            finally:
                with l2._CHUNK_LOCK:  # noqa: SLF001
                    l2._INFLIGHT.pop(key, None)  # noqa: SLF001
                    l2._INFLIGHT_BG.discard(key)  # noqa: SLF001

        l2._POOL = ThreadPoolExecutor(1)  # noqa: SLF001
        l2._REST = ThreadPoolExecutor(1)  # noqa: SLF001
        l2._fetch_chunk = fake_fetch  # noqa: SLF001
        self.ch = [(f"KTST/1/20261025-000000-{n:03d}-{'S' if n == 1 else 'I'}", 10) for n in range(1, 5)]

    def tearDown(self):
        self.release.set()
        l2._POOL.shutdown(wait=True)  # noqa: SLF001
        l2._REST.shutdown(wait=True)  # noqa: SLF001
        l2._POOL, l2._REST, l2._fetch_chunk = self.saved  # noqa: SLF001
        with l2._CHUNK_LOCK:  # noqa: SLF001
            for k in [k for k in l2._CHUNK_BYTES if k[0] == "KTST"]:  # noqa: SLF001
                l2._CHUNK_BYTES.pop(k)  # noqa: SLF001

    def _run(self, pool_for_first):
        results, errors = {}, {}

        def ask(name, pool=None):
            try:
                results[name] = l2._get_chunks("KTST", 1, "20261025-000000", self.ch, [2], pool=pool)  # noqa: SLF001
            except Exception as exc:  # noqa: BLE001
                errors[name] = exc

        blocker_pool = pool_for_first or l2._POOL  # noqa: SLF001
        blocker_pool.submit(self.release.wait)  # the pool's one worker is busy
        first = self.threading.Thread(target=ask, args=("first", pool_for_first))
        first.start()
        for _ in range(200):
            if ("KTST", 1, "20261025-000000", 2) in l2._INFLIGHT:  # noqa: SLF001
                break
            self.threading.Event().wait(0.01)
        second = self.threading.Thread(target=ask, args=("second",))
        second.start()
        if pool_for_first is not None:
            second.join(2.0)
        self.early = not second.is_alive()
        self.release.set()
        first.join(5)
        second.join(5)
        return results, errors

    def test_second_foreground_request_waits_for_the_first(self):
        results, errors = self._run(None)
        self.assertEqual(errors, {})
        self.assertEqual(results["first"], [b"chunk-2"])
        self.assertEqual(results["second"], [b"chunk-2"])
        self.assertEqual(len(self.calls), 1)

    def test_a_request_takes_a_queued_background_chunk(self):
        results, errors = self._run(l2._REST)  # noqa: SLF001
        # The request did not wait for the background queue to move.
        self.assertTrue(self.early)
        self.assertEqual(results.get("second"), [b"chunk-2"])
        self.assertNotIn("second", errors)


class CutForTest(unittest.TestCase):
    """An in-progress frame waits only for the cut carrying its moment."""

    def test_split_cut_halves(self):
        run = [0, 1]   # surveillance, then Doppler, at 0.5 deg
        self.assertEqual(lv.cut_for(run, "C"), ([0], lv.SURVEILLANCE_FAMS))
        self.assertEqual(lv.cut_for(run, "B"), ([0], lv.SURVEILLANCE_FAMS))
        self.assertEqual(lv.cut_for(run, "G"), ([1], lv.DOPPLER_FAMS))
        self.assertEqual(lv.cut_for(run, "W"), ([1], lv.DOPPLER_FAMS))

    def test_single_cut_is_read_whole(self):
        cuts, fams = lv.cut_for([5], "G")
        self.assertEqual(cuts, [5])
        self.assertEqual(set(fams), set(l2.L2_MOMENTS))

    def test_families_cover_every_moment_once(self):
        self.assertEqual(sorted(lv.SURVEILLANCE_FAMS + lv.DOPPLER_FAMS), sorted(l2.L2_MOMENTS))


if __name__ == "__main__":
    unittest.main()
