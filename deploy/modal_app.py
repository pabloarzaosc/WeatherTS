"""The web version's backend on Modal (modal.com): the desktop's own FastAPI
app from backend/, unchanged, in a Linux container.

Modal's Starter plan gives $30 of compute a month with no card on file. That
money is spent only while a container is up. CPU and memory are billed on
whichever is higher, the request or what is actually used. So the request
here is small: an idle container costs little, and a busy one bursts to
several cores and pays for what it used.

Deploy (from the repo root, after `modal token new` once):
    modal deploy deploy/modal_app.py
The API then answers at https://<workspace>--weatherts-api-api.modal.run,
which goes in .env.web as VITE_BACKEND_BASE.
"""
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"

image = (
    modal.Image.debian_slim(python_version="3.13")
    # Qt draws SHARPpy's sounding off screen; these are the libraries its
    # offscreen platform still loads, and a font for the labels.
    .apt_install(
        "libgl1", "libegl1", "libglib2.0-0", "libfontconfig1", "libdbus-1-3",
        "libxkbcommon0", "libxkbcommon-x11-0", "fonts-dejavu-core",
    )
    .pip_install_from_requirements(str(BACKEND / "requirements-server.txt"))
    .run_commands("pip install sharppy==1.4.0a5 --no-deps")
    .env({"QT_QPA_PLATFORM": "offscreen", "PYTHONUNBUFFERED": "1", "WEATHERTS_HOSTED": "1"})
    .add_local_dir(
        str(BACKEND),
        "/root/backend",
        ignore=[".venv", ".venv/**", "build", "build/**", "dist", "dist/**", "**/__pycache__", "**/*.pyc", "test_*.py", "*.spec"],
    )
    # The radar colour tables live beside backend/, at <repo>/palettes
    # (pal_tables.py reads them from there, and nexrad_core needs them at import).
    .add_local_dir(str(ROOT / "palettes"), "/root/palettes")
)

app = modal.App("weatherts-api", image=image)


@app.function(
    # A quarter of a core held, up to eight more while a request needs them;
    # 1 GiB held, never more than 6 (a runaway cache is killed, not billed).
    cpu=(0.25, 8.0),
    memory=(1024, 6144),
    # No container kept up for nobody: the first visitor after ten quiet
    # minutes waits for one to start.
    min_containers=0,
    scaledown_window=600,
    timeout=600,
)
@modal.concurrent(max_inputs=64)
@modal.asgi_app()
def api():
    import os
    import sys

    sys.path.insert(0, "/root/backend")
    os.chdir("/root/backend")
    import main  # noqa: PLC0415

    return main.app
