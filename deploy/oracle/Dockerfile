# The web version's backend on the Oracle Always Free VM (Ampere, arm64):
# the desktop's own FastAPI app from backend/, unchanged.
#
# Debian 13 because its system Python is 3.13, the desktop's, and because
# PyQt5 (SHARPpy draws soundings with Qt, off screen) has no Linux arm64
# wheel on PyPI: it comes from Debian's python3-pyqt5, which the venv sees
# through --system-site-packages. Everything else is pip, as on the desktop.
#
# Built from the repo root by deploy/oracle/deploy.sh.
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip python3-pyqt5 \
      libgl1 libegl1 libglib2.0-0 libfontconfig1 libdbus-1-3 libxkbcommon0 libxkbcommon-x11-0 \
      fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv --system-site-packages /opt/venv
COPY backend/requirements-server.txt /tmp/requirements.txt
RUN grep -iv '^pyqt5' /tmp/requirements.txt > /tmp/req.txt \
 && /opt/venv/bin/pip install --no-cache-dir -r /tmp/req.txt \
 && /opt/venv/bin/pip install --no-cache-dir sharppy==1.4.0a5 --no-deps

COPY palettes /app/palettes
COPY backend /app/backend

ENV QT_QPA_PLATFORM=offscreen \
    PYTHONUNBUFFERED=1 \
    WEATHERTS_HOSTED=1
WORKDIR /app/backend
EXPOSE 8787
CMD ["/opt/venv/bin/python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8787", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
