# WeatherTS radar relay. Build from this folder (relay/):
#
#   docker build -t weatherts-relay .                          local storage only
#   docker build -t weatherts-relay --build-arg WITH_S3=1 .    with boto3, for R2 / B2 / S3
#
# Run (poller + API, files in a volume):
#
#   docker run -d --name relay -p 8080:8080 -v relay-data:/data \
#     -e RELAY_CEMADEN_ENABLED=1 -e RELAY_CEMADEN_HOST=... \
#     -e RELAY_CEMADEN_USER=... -e RELAY_CEMADEN_PASSWORD=... \
#     weatherts-relay
#
# The image starts from config.example.toml (/config/config.toml); mount your
# own over it (-v ./config.toml:/config/config.toml:ro) or override with
# RELAY_* variables. Files go to /data unless RELAY_STORAGE_PATH says otherwise.
FROM python:3.13-slim

ARG WITH_S3=0
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    RELAY_CONFIG=/config/config.toml \
    RELAY_STORAGE_PATH=/data \
    RELAY_PORT=8080

WORKDIR /app
COPY requirements.txt requirements-s3.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
 && if [ "$WITH_S3" = "1" ]; then pip install --no-cache-dir -r requirements-s3.txt; fi

COPY relay ./relay
COPY config.example.toml /config/config.toml

RUN useradd --system --uid 10001 --home-dir /app relay \
 && mkdir -p /data \
 && chown relay /data
USER relay

VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('RELAY_PORT', '8080'), timeout=4)"

CMD ["python", "-m", "relay"]
