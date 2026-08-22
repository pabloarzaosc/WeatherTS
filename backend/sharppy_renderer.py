"""
Render the official SHARPpy SPCWidget layout to a PNG for the web viewer.

SHARPpy's GUI is a Qt desktop widget. The small compatibility layer below
lets the current PyQt5 wheel accept numeric values that older SHARPpy code
passes as floats, then grabs the widget as an offscreen image.
"""
from __future__ import annotations

import base64
import os
import json
import struct
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Optional

import numpy as np

MISSING = -9999.0
# PNG "quality" in Qt is the zlib compression level, NOT lossy fidelity: 100
# means "barely compress" (a ~2.7 MB frame here), while 80 losslessly shrinks
# the identical image to ~215 KB. Smaller frames make every hop cheaper --
# JSON-encode, base64, network, and browser decode -- which is what the
# timeline scrubbing felt slow on.
_PNG_QUALITY = 80
_RENDER_TIMEOUT = 60.0  # seconds; a hung worker falls back to a one-shot render
_QT_LOCK = threading.Lock()
_PATCHED_QT = False
# SHARPpy sizes some marker labels with hard-coded pixel rectangles (the RM/LM
# and Corfidi text on the hodograph are 55x12) and draws them WITHOUT
# TextDontClip. Those numbers assume the widget is about the size SHARPpy's own
# window gives it; enlarge the widget and its own fonts grow past the rects, so
# "335/18 RM" renders as "5/18 RM". Enabled only while rendering a standalone
# widget at panel size, where a clipped label is never what SHARPpy meant.
_NO_CLIP_TEXT = False
_INPROCESS_RENDERER = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sharppy-qt")


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float, np.integer, np.floating))


def _to_int(value: Any) -> Any:
    return int(round(float(value))) if _is_number(value) else value


def _patch_qt() -> None:
    """Patch PyQt overload strictness before SHARPpy imports Qt classes."""
    global _PATCHED_QT
    if _PATCHED_QT:
        return

    os.environ.setdefault("QT_API", "pyqt5")
    if os.name == "nt" and os.environ.get("QT_QPA_PLATFORM") == "offscreen":
        os.environ.pop("QT_QPA_PLATFORM", None)
    elif os.name != "nt":
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

    from qtpy import QtCore, QtGui, QtWidgets

    original_qfont = QtGui.QFont

    class CompatQFont(original_qfont):
        def __init__(self, *args, **kwargs):
            bold = kwargs.pop("bold", None)
            args = list(args)
            if len(args) >= 2:
                args[1] = _to_int(args[1])
            super().__init__(*args, **kwargs)
            if bold is not None:
                self.setBold(bool(bold))

        def setPixelSize(self, size):  # noqa: N802 - Qt API name
            return super().setPixelSize(_to_int(size))

        def setPointSize(self, size):  # noqa: N802 - Qt API name
            return super().setPointSize(_to_int(size))

    QtGui.QFont = CompatQFont

    original_qpainter = QtGui.QPainter

    class CompatQPainter(original_qpainter):
        def drawLine(self, *args):  # noqa: N802 - Qt API name
            if len(args) == 4 and all(_is_number(v) for v in args):
                return super().drawLine(QtCore.QLineF(*[float(v) for v in args]))
            return super().drawLine(*args)

        def drawRect(self, *args):  # noqa: N802 - Qt API name
            if len(args) == 4 and all(_is_number(v) for v in args):
                return super().drawRect(QtCore.QRectF(*[float(v) for v in args]))
            return super().drawRect(*args)

        def drawEllipse(self, *args):  # noqa: N802 - Qt API name
            if len(args) == 4 and all(_is_number(v) for v in args):
                return super().drawEllipse(QtCore.QRectF(*[float(v) for v in args]))
            return super().drawEllipse(*args)

        def drawText(self, *args):  # noqa: N802 - Qt API name
            if len(args) == 3 and all(_is_number(v) for v in args[:2]):
                return super().drawText(_to_int(args[0]), _to_int(args[1]), args[2])
            if _NO_CLIP_TEXT and len(args) == 3 and hasattr(args[0], "width"):
                rect, flags, text = args
                metrics = self.fontMetrics()
                advance = getattr(metrics, "horizontalAdvance", None) or metrics.width
                if advance(str(text)) > rect.width():
                    flags = int(flags) | int(QtCore.Qt.TextDontClip)
                return super().drawText(rect, flags, text)
            if len(args) >= 6 and all(_is_number(v) for v in args[:4]):
                converted = [_to_int(v) for v in args[:4]]
                return super().drawText(*converted, *args[4:])
            return super().drawText(*args)

    QtGui.QPainter = CompatQPainter

    for name in ("QRect", "QPoint", "QSize"):
        original = getattr(QtCore, name)

        class CompatQtCoreClass(original):  # type: ignore[misc, valid-type]
            def __init__(self, *args, **kwargs):
                super().__init__(*[_to_int(v) for v in args], **kwargs)

        setattr(QtCore, name, CompatQtCoreClass)

    original_action_group = QtWidgets.QActionGroup

    class CompatQActionGroup(original_action_group):
        def __init__(self, *args, **kwargs):
            exclusive = kwargs.pop("exclusive", None)
            super().__init__(*args, **kwargs)
            if exclusive is not None:
                self.setExclusive(bool(exclusive))

    QtWidgets.QActionGroup = CompatQActionGroup
    _PATCHED_QT = True


def _valid_dt(meta: dict[str, Any]) -> datetime:
    valid = meta.get("validUnix")
    if valid:
        return datetime.fromtimestamp(int(valid), tz=timezone.utc).replace(tzinfo=None)
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _make_profile(levels: list[dict[str, float]], meta: dict[str, Any]):
    _patch_qt()
    import sharppy.sharptab.profile as profile

    return profile.create_profile(
        profile="convective",
        pres=np.array([level["p"] for level in levels], dtype=float),
        hght=np.array([level["h"] for level in levels], dtype=float),
        tmpc=np.array([level["t"] for level in levels], dtype=float),
        dwpc=np.array([level["td"] for level in levels], dtype=float),
        wdir=np.array([level["wd"] for level in levels], dtype=float),
        wspd=np.array([level["ws"] for level in levels], dtype=float),
        missing=MISSING,
        strictQC=False,
        date=_valid_dt(meta),
        location=f"{meta.get('lat', 0):.2f},{meta.get('lon', 0):.2f}",
        latitude=float(meta.get("lat") or 0.0),
    )


def render_spc_widget_png(levels: list[dict[str, float]], meta: dict[str, Any]) -> bytes:
    """Return a PNG bytestring containing the official SHARPpy SPCWidget.

    Qt widgets are safest in a single-purpose process. Uvicorn may execute
    sync endpoints in worker threads, and SHARPpy's Qt widgets can crash the
    interpreter when reused across those threads. The parent API process
    therefore delegates the actual Qt rendering to a dedicated child process.

    Scrubbing the forecast timeline asks for a new frame every few hundred ms,
    so we keep ONE long-lived worker warm (its QApplication and the numpy /
    sharppy / PyQt imports survive between frames) instead of paying a fresh
    interpreter start-up per frame. If the warm worker ever misbehaves we fall
    back to the proven one-shot subprocess so a render never fails outright.
    """
    if os.environ.get("SHARPPY_RENDER_CHILD") == "1" or os.environ.get("SHARPPY_RENDER_WORKER") == "1":
        return _render_spc_widget_png_inprocess(levels, meta)

    # PyInstaller cannot start a Python child from the bundled executable.
    # Keep all Qt work on one permanent thread instead; QApplication and every
    # SPCWidget then have one consistent Qt affinity across concurrent requests.
    if getattr(sys, "frozen", False):
        return _render_spc_widget_png_serialized(levels, meta)

    return _WORKER.render(levels, meta)


def _render_spc_widget_png_serialized(
    levels: list[dict[str, float]], meta: dict[str, Any]
) -> bytes:
    future = _INPROCESS_RENDERER.submit(_render_spc_widget_png_inprocess, levels, meta)
    return future.result(timeout=_RENDER_TIMEOUT)


def _render_spc_widget_png_oneshot(levels: list[dict[str, float]], meta: dict[str, Any]) -> bytes:
    """Render in a throwaway child process (reliable fallback path).

    In PyInstaller-bundled context, sys.executable points to the exe itself,
    not a Python interpreter, so subprocess spawning fails. Fall back to
    in-process rendering when this happens.
    """
    # Check if we're in a bundled context (PyInstaller)
    if getattr(sys, "frozen", False):
        return _render_spc_widget_png_serialized(levels, meta)

    # The child has to be THIS interpreter. Looking "python" up on PATH finds
    # whichever one happens to be installed system-wide -- on Windows that is
    # usually the Microsoft Store alias -- and that is a different environment
    # with no numpy, sharppy or PyQt in it, so every render died with
    # ModuleNotFoundError. sys.executable is by definition the environment the
    # backend's dependencies were installed into.
    python_exe = sys.executable

    payload = json.dumps({"levels": levels, "meta": meta}, separators=(",", ":")).encode("utf-8")
    env = os.environ.copy()
    env["SHARPPY_RENDER_CHILD"] = "1"
    env.setdefault("PYTHONWARNINGS", "ignore")
    if os.name == "nt":
        env.pop("QT_QPA_PLATFORM", None)

    try:
        completed = subprocess.run(
            [python_exe, __file__],
            input=payload,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=os.path.dirname(__file__),
            env=env,
            timeout=_RENDER_TIMEOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    except Exception as exc:  # noqa: BLE001
        # Subprocess failed, fall back to in-process rendering
        return _render_spc_widget_png_inprocess(levels, meta)

    if completed.returncode != 0:
        err = completed.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(err or f"SHARPpy renderer exited with {completed.returncode}")
    if not completed.stdout:
        err = completed.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(err or "SHARPpy renderer returned an empty image")
    return completed.stdout


# ---------------------------------------------------------------------------
# Persistent render worker (parent side)
# ---------------------------------------------------------------------------
def _read_exact(stream, n: int) -> bytes:
    """Read exactly n bytes or return what arrived before EOF (< n)."""
    chunks: list[bytes] = []
    remaining = n
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


class _WorkerBroken(Exception):
    """Transport-level failure: the worker must be recycled."""


class _RenderWorker:
    """Owns a single warm child process and talks to it over framed stdio."""

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()

    def _spawn(self) -> None:
        if getattr(sys, "frozen", False):
            # Bundled context: fall back to in-process rendering by raising _WorkerBroken
            raise _WorkerBroken("bundled context - use in-process fallback")
        # This interpreter, not PATH's -- see the note in the one-shot path.
        python_exe = sys.executable
        env = os.environ.copy()
        env["SHARPPY_RENDER_WORKER"] = "1"
        env.setdefault("PYTHONWARNINGS", "ignore")
        env.setdefault("PYTHONUNBUFFERED", "1")
        if os.name == "nt":
            env.pop("QT_QPA_PLATFORM", None)
        self._proc = subprocess.Popen(
            [python_exe, __file__],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=os.path.dirname(__file__),
            env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

    def _kill(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            proc.kill()
        except Exception:
            pass
        for stream in (proc.stdin, proc.stdout):
            try:
                if stream is not None:
                    stream.close()
            except Exception:
                pass

    def _roundtrip(self, payload: bytes) -> bytes:
        proc = self._proc
        if proc is None or proc.poll() is not None or proc.stdin is None or proc.stdout is None:
            raise _WorkerBroken("worker not running")
        try:
            proc.stdin.write(struct.pack(">I", len(payload)))
            proc.stdin.write(payload)
            proc.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise _WorkerBroken(f"write failed: {exc}") from exc

        header = _read_exact(proc.stdout, 5)
        if len(header) < 5:
            raise _WorkerBroken("worker closed the stream")
        status = header[0]
        (length,) = struct.unpack(">I", header[1:5])
        body = _read_exact(proc.stdout, length)
        if len(body) < length:
            raise _WorkerBroken("truncated worker response")
        if status == 0:
            return body
        # status 1: the render itself failed (bad data, not a broken worker).
        raise RuntimeError(body.decode("utf-8", errors="replace") or "SHARPpy render failed")

    def render(self, levels: list[dict[str, float]], meta: dict[str, Any]) -> bytes:
        payload = json.dumps({"levels": levels, "meta": meta}, separators=(",", ":")).encode("utf-8")
        body = self.request(payload)
        if body is not None:
            return body
        # Warm worker could not deliver: fall back to a fresh one-shot process
        # so the caller still gets a frame.
        return _render_spc_widget_png_oneshot(levels, meta)

    def widgets(
        self,
        levels: list[dict[str, float]],
        meta: dict[str, Any],
        specs: dict[str, tuple[int, int]],
    ) -> dict[str, bytes]:
        """Ask the worker for a set of individual SHARPpy widgets."""
        payload = json.dumps(
            {"levels": levels, "meta": meta, "widgets": {k: list(v) for k, v in specs.items()}},
            separators=(",", ":"),
        ).encode("utf-8")
        body = self.request(payload)
        if body is None:
            body = _render_vwp_widgets_oneshot(levels, meta, specs)
        return {k: base64.b64decode(v) for k, v in json.loads(body.decode("utf-8")).items()}

    def request(self, payload: bytes) -> Optional[bytes]:
        """One framed round-trip, with a respawn retry. None = worker gave up.

        A render error raised by the child (status 1) is re-raised: that is the
        data being wrong, and retrying or falling back would only produce the
        same failure more slowly.
        """
        with self._lock:
            box: dict[str, Any] = {}

            def _do() -> None:
                try:
                    box["body"] = self._roundtrip(payload)
                except Exception as exc:  # noqa: BLE001
                    box["err"] = exc

            for attempt in range(2):
                if self._proc is None or self._proc.poll() is not None:
                    self._spawn()
                box.clear()
                worker = threading.Thread(target=_do, daemon=True)
                worker.start()
                worker.join(_RENDER_TIMEOUT)
                if worker.is_alive():  # hung render: recycle and stop waiting
                    self._kill()
                    worker.join(5)
                    break
                if "body" in box:
                    return box["body"]
                err = box.get("err")
                if isinstance(err, _WorkerBroken):
                    self._kill()
                    continue  # respawn and retry once
                # A genuine render error (status 1) -- surface it as-is.
                raise err if isinstance(err, Exception) else RuntimeError("unknown render error")

        return None


_WORKER = _RenderWorker()


# What the panel can ask for. SHARPpy names its parcels SFC/ML/FCST/MU/EFF and
# USER, and its storm-motion "deviant" is right/left only -- everything else is
# a vector the profile already computed, pushed in through modifyVector.
PARCELS = {"SFC", "ML", "FCST", "MU", "EFF", "USER"}
STORM_MOTIONS = {"right", "left", "mean", "corfidi-up", "corfidi-down", "custom"}


def _motion_vector(prof, kind: str, meta: dict[str, Any]):
    """(u, v) in knots for a storm motion the widget cannot select on its own."""
    from sharppy.sharptab import interp, utils as sutils, winds

    if kind == "custom":
        d = meta.get("stormMotionDir")
        spd = meta.get("stormMotionSpd")
        if not _is_number(d) or not _is_number(spd):
            return None
        return sutils.vec2comp(float(d), float(spd))

    if kind == "mean":
        # The 0-6 km mean wind, which is what a hodograph labels "MEAN" --
        # not SHARPpy's 850-250 default, which is a different layer entirely.
        ptop = interp.pres(prof, interp.to_msl(prof, 6000.0))
        return winds.mean_wind(prof, pbot=prof.pres[prof.sfc], ptop=ptop)

    if kind in ("corfidi-up", "corfidi-down"):
        vec = getattr(prof, "upshear_downshear", None)
        if vec is None or len(vec) < 4:
            return None
        up_u, up_v, dn_u, dn_v = vec[0], vec[1], vec[2], vec[3]
        return (up_u, up_v) if kind == "corfidi-up" else (dn_u, dn_v)

    return None


def _apply_view(widget, meta: dict[str, Any]) -> None:
    """Apply the panel's parcel and storm-motion choices to a built widget.

    Runs AFTER addProfileCollection: that call ends in updateProfs(), which
    resets the parcel to the widget's default and picks the deviant from the
    hemisphere. Applying any of this earlier would simply be overwritten.
    """
    prof = getattr(widget, "default_prof", None)
    if prof is None:
        return

    parcel = str(meta.get("parcel") or "").upper()
    if parcel == "USER" and _is_number(meta.get("parcelPressure")):
        # A user parcel has to be computed and handed to the collection; the
        # widget only knows how to *select* parcels the profile already has.
        try:
            from sharppy.sharptab import params

            pcl = params.parcelx(prof, pres=float(meta["parcelPressure"]), flag=5)
            widget.defineUserParcel(pcl)
        except Exception:  # noqa: BLE001 - fall through to the default parcel
            parcel = ""
    if parcel in PARCELS:
        try:
            widget.parcel_type = parcel
            pcl = widget.getParcelObj(widget.default_prof, parcel)
            if pcl is not None:
                widget.sound.setParcel(pcl)
                widget.storm_slinky.setParcel(pcl)
        except Exception:  # noqa: BLE001 - a bad parcel must not lose the plot
            pass

    motion = str(meta.get("stormMotion") or "").lower()
    if motion not in STORM_MOTIONS:
        return
    # right/left pick which Bunkers vector every SR calculation reads from;
    # the others REPLACE that vector, so they still need a side to sit on.
    side = "left" if motion == "left" else "right"
    try:
        if motion not in ("right", "left"):
            vec = _motion_vector(widget.default_prof, motion, meta)
            if vec is not None and all(_is_number(c) for c in vec):
                widget.modifyVector(side, float(vec[0]), float(vec[1]))
        widget.toggleVector(side)
    except Exception:  # noqa: BLE001
        pass


def _render_spc_widget_png_inprocess(levels: list[dict[str, float]], meta: dict[str, Any]) -> bytes:
    """Render the official SHARPpy SPCWidget inside the current process."""
    with _QT_LOCK:
        _patch_qt()

        from qtpy.QtCore import QByteArray, QBuffer, QIODevice, Qt
        from qtpy.QtWidgets import QApplication
        from sharppy.sharptab import prof_collection
        import sharppy.sharptab.profile as profile
        from sharppy.viz.SPCWindow import SPCWidget
        from sharppy.viz.preferences import PrefDialog
        from sutils.config import Config

        app = QApplication.instance()
        if app is None:
            app = QApplication([])

        cfg = Config(os.devnull)
        PrefDialog.initConfig(cfg)

        valid_dt = _valid_dt(meta)
        prof = _make_profile(levels, meta)
        loc = f"{meta.get('lat', 0):.2f},{meta.get('lon', 0):.2f}"
        model = str(meta.get("modelLabel") or meta.get("model") or "MODEL")
        prof_col = prof_collection.ProfCollection(
            {"": [prof]},
            [valid_dt],
            target_type=profile.ConvectiveProfile,
            observed=bool(meta.get("observed", False)),
            loc=loc,
            run=valid_dt,
            model=model,
            base_time=valid_dt,
        )

        widget = SPCWidget(cfg=cfg)
        widget.resize(1180, 800)
        widget.setAttribute(Qt.WA_DontShowOnScreen, True)
        widget.show()
        app.processEvents()
        widget.addProfileCollection(prof_col, f"{loc}-{model}", focus=True)
        app.processEvents()
        _apply_view(widget, meta)
        app.processEvents()
        widget.repaint()
        app.processEvents()

        pixmap = widget.grab()
        data = QByteArray()
        buffer = QBuffer(data)
        buffer.open(QIODevice.WriteOnly)
        try:
            pixmap.save(buffer, "PNG", _PNG_QUALITY)
        finally:
            buffer.close()
            widget.close()
            widget.deleteLater()
            app.processEvents()

        return bytes(data.data())


# ---------------------------------------------------------------------------
# Individual SHARPpy widgets, for panels assembled outside the SPCWidget
# ---------------------------------------------------------------------------
# The VWP panel is laid out differently from SHARPpy's own window -- one large
# hodograph, the kinematics beside it -- but every plot on it is SHARPpy's own
# widget, rendered by SHARPpy's own paint code. Only the arrangement is ours.
VWP_WIDGET_KINDS = ("hodo", "kinematics", "speed", "srwinds")


def render_vwp_widgets(
    levels: list[dict[str, float]],
    meta: dict[str, Any],
    specs: dict[str, tuple[int, int]],
) -> dict[str, bytes]:
    """Render the named SHARPpy widgets offscreen: one PNG each, at the given size."""
    specs = {k: (int(w), int(h)) for k, (w, h) in specs.items() if k in VWP_WIDGET_KINDS}
    if not specs:
        return {}
    if os.environ.get("SHARPPY_RENDER_CHILD") == "1" or os.environ.get("SHARPPY_RENDER_WORKER") == "1":
        return _render_vwp_widgets_inprocess(levels, meta, specs)
    if getattr(sys, "frozen", False):
        future = _INPROCESS_RENDERER.submit(_render_vwp_widgets_inprocess, levels, meta, specs)
        return future.result(timeout=_RENDER_TIMEOUT)
    return _WORKER.widgets(levels, meta, specs)


def _render_vwp_widgets_oneshot(
    levels: list[dict[str, float]],
    meta: dict[str, Any],
    specs: dict[str, tuple[int, int]],
) -> bytes:
    """Throwaway child process, returning the JSON body the worker would have."""
    if getattr(sys, "frozen", False):
        future = _INPROCESS_RENDERER.submit(_render_vwp_widgets_inprocess, levels, meta, specs)
        return _encode_widget_pngs(future.result(timeout=_RENDER_TIMEOUT))

    payload = json.dumps(
        {"levels": levels, "meta": meta, "widgets": {k: list(v) for k, v in specs.items()}},
        separators=(",", ":"),
    ).encode("utf-8")
    env = os.environ.copy()
    env["SHARPPY_RENDER_CHILD"] = "1"
    env.setdefault("PYTHONWARNINGS", "ignore")
    if os.name == "nt":
        env.pop("QT_QPA_PLATFORM", None)

    try:
        completed = subprocess.run(
            [sys.executable, __file__],
            input=payload,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=os.path.dirname(__file__),
            env=env,
            timeout=_RENDER_TIMEOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    except Exception:  # noqa: BLE001 - no child available; do it here instead
        return _encode_widget_pngs(_render_vwp_widgets_inprocess(levels, meta, specs))

    if completed.returncode != 0 or not completed.stdout:
        err = completed.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(err or "SHARPpy widget renderer produced nothing")
    return completed.stdout


def _encode_widget_pngs(pngs: dict[str, bytes]) -> bytes:
    return json.dumps(
        {k: base64.b64encode(v).decode("ascii") for k, v in pngs.items()},
        separators=(",", ":"),
    ).encode("utf-8")


def _pixmap_to_png(pixmap) -> bytes:
    from qtpy.QtCore import QByteArray, QBuffer, QIODevice

    data = QByteArray()
    buffer = QBuffer(data)
    buffer.open(QIODevice.WriteOnly)
    try:
        pixmap.save(buffer, "PNG", _PNG_QUALITY)
    finally:
        buffer.close()
    return bytes(data.data())


def _render_vwp_widgets_inprocess(
    levels: list[dict[str, float]],
    meta: dict[str, Any],
    specs: dict[str, tuple[int, int]],
) -> dict[str, bytes]:
    with _QT_LOCK:
        _patch_qt()

        from qtpy.QtCore import Qt
        from qtpy.QtWidgets import QApplication, QWidget
        from sharppy.sharptab import prof_collection
        import sharppy.sharptab.profile as profile
        from sharppy.viz import plotHodo, plotKinematics, plotSpeed, plotWinds
        from sharppy.viz.preferences import PrefDialog
        from sutils.config import Config

        app = QApplication.instance()
        if app is None:
            app = QApplication([])

        cfg = Config(os.devnull)
        PrefDialog.initConfig(cfg)
        prefs = dict((field, value) for (section, field), value in cfg if section == "preferences")

        valid_dt = _valid_dt(meta)
        prof = _make_profile(levels, meta)
        observed = bool(meta.get("observed", False))
        prof_col = prof_collection.ProfCollection(
            {"": [prof]},
            [valid_dt],
            target_type=profile.ConvectiveProfile,
            observed=observed,
            loc=f"{meta.get('lat', 0):.2f},{meta.get('lon', 0):.2f}",
            run=valid_dt,
            model=str(meta.get("modelLabel") or meta.get("model") or "VWP"),
            base_time=valid_dt,
        )

        # The storm motion every storm-relative number is measured against.
        # right/left choose which Bunkers vector to read; the others replace
        # that vector on the profile, exactly as the SPCWidget does it.
        motion = str(meta.get("stormMotion") or "right").lower()
        side = "left" if motion == "left" else "right"
        if motion not in ("right", "left"):
            vec = _motion_vector(prof, motion, meta)
            if vec is not None and all(_is_number(c) for c in vec):
                prof_col.modifyStormMotion(side, float(vec[0]), float(vec[1]))
        active = prof_col.getHighlightedProf()

        # A parent keeps every widget in one window: SHARPpy's hodograph calls
        # parentWidget().setFocus() when the storm-motion side changes, and a
        # top-level widget has no parent to call it on.
        host = QWidget()
        host.setAttribute(Qt.WA_DontShowOnScreen, True)
        host.resize(1, 1)
        host.show()

        builders = {
            "hodo": plotHodo,
            "kinematics": plotKinematics,
            "speed": plotSpeed,
            "srwinds": plotWinds,
        }

        global _NO_CLIP_TEXT
        out: dict[str, bytes] = {}
        _NO_CLIP_TEXT = True
        try:
            for name, (width, height) in specs.items():
                widget = builders[name]()
                widget.setParent(host)
                widget.resize(max(int(width), 40), max(int(height), 40))
                widget.setAttribute(Qt.WA_DontShowOnScreen, True)
                widget.show()
                app.processEvents()

                widget.setPreferences(update_gui=False, **prefs)
                if name == "hodo":
                    widget.addProfileCollection(prof_col)
                    if not observed:
                        widget.setAllObserved(False, update_gui=False)
                    widget.setActiveCollection(0)
                else:
                    widget.setProf(active)
                app.processEvents()
                # Wind speed vs height is the one widget with no storm-relative
                # half, so SHARPpy never gives it a side to sit on.
                if hasattr(widget, "setDeviant"):
                    widget.setDeviant(side)
                app.processEvents()
                widget.repaint()
                app.processEvents()

                out[name] = _pixmap_to_png(widget.grab())
                widget.close()
                widget.deleteLater()
        finally:
            _NO_CLIP_TEXT = False
            host.close()
            host.deleteLater()
            app.processEvents()

        return out


def _main() -> None:
    payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    if payload.get("widgets"):
        specs = {k: tuple(v) for k, v in payload["widgets"].items()}
        body = _encode_widget_pngs(
            _render_vwp_widgets_inprocess(payload["levels"], payload["meta"], specs)
        )
    else:
        body = _render_spc_widget_png_inprocess(payload["levels"], payload["meta"])
    sys.stdout.buffer.write(body)


def _worker_loop() -> None:
    """Long-lived render server: read framed requests on stdin, write framed
    responses on a private copy of stdout.

    stdout is redirected onto stderr for the rest of the process so that any
    stray prints from Qt / sharppy can never corrupt the binary frame stream.
    """
    in_stream = sys.stdin.buffer
    resp_fd = os.dup(1)
    os.dup2(2, 1)  # library chatter -> stderr, keeping the frame channel clean
    out = os.fdopen(resp_fd, "wb", buffering=0)

    # Warm the imports / QApplication up front so the first real frame is fast.
    _patch_qt()

    def _send(status: int, body: bytes) -> None:
        out.write(bytes([status]))
        out.write(struct.pack(">I", len(body)))
        out.write(body)
        out.flush()

    while True:
        header = _read_exact(in_stream, 4)
        if len(header) < 4:
            break  # parent closed the pipe -> exit
        (length,) = struct.unpack(">I", header)
        payload = _read_exact(in_stream, length)
        if len(payload) < length:
            break
        try:
            req = json.loads(payload.decode("utf-8"))
            if req.get("widgets"):
                specs = {k: tuple(v) for k, v in req["widgets"].items()}
                body = _encode_widget_pngs(
                    _render_vwp_widgets_inprocess(req["levels"], req["meta"], specs)
                )
            else:
                body = _render_spc_widget_png_inprocess(req["levels"], req["meta"])
            _send(0, body)
        except Exception as exc:  # noqa: BLE001 - report render errors to the parent
            _send(1, str(exc).encode("utf-8"))


if __name__ == "__main__":
    if os.environ.get("SHARPPY_RENDER_WORKER") == "1":
        _worker_loop()
    else:
        _main()
