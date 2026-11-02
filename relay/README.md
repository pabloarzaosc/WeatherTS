# WeatherTS radar relay

One server that downloads each Brazilian radar file **once** from its source,
keeps the last **36 hours**, deletes everything older, and serves the files to
every copy of WeatherTS (desktop and web). The app never talks to the radar
operator: the operator sees a single client making one download per file,
whatever the number of people who open the app.

It is ready to switch on. The one missing piece is **CEMADEN's access**: an FTP
account or an HTTP URL that does not go through the CAPTCHA of the public
Interactive Map. When CEMADEN grants it, the access details go into the
configuration (or into environment variables) and the nine CEMADEN radars go
live. Until then the CEMADEN source stays switched off, and the relay can be
demonstrated end to end with real CEMADEN volumes that NASA republishes
(see [The demonstration](#the-demonstration-real-cemaden-volumes-from-nasa)).

> The relay never sends a request to `mapainterativo.cemaden.gov.br`. The
> Interactive Map's downloads are behind a CAPTCHA, which is CEMADEN saying that
> no program downloads from it. The relay refuses that host in its
> configuration and at request time, whatever a listing links to. Access for
> the relay is whatever CEMADEN grants on purpose.

## What it does

```
source (CEMADEN FTP/HTTP, a drop folder, NASA GPM-VN)
   |   every 2 min per radar: list, take what is new, download it once
   v
store (a local folder, or an R2 / B2 / S3 bucket)   <radar>/<stamp>/<name>
   |   + index.json (what is stored), pruned past 36 h
   v
HTTP API  /v1/radars, /v1/radars/{id}/volumes, /v1/files/...   ->  every app
```

* **Polling.** Every `poll_seconds` (120), for each radar: list the source for
  files of volumes that started inside the retention window; drop what the index
  already holds (a file is never downloaded twice); download the rest, newest
  volume first, each to a staging file, size checked, then committed. Up to
  `concurrency` (3) radars at once. A radar that fails waits
  `poll_seconds x 2^failures` (at most 30 min) and never stops the others.
* **Never half a file.** When the listing gives modification times (FTP MLSD,
  nginx JSON, a local folder), a file is taken once it is `settle_seconds` old.
  When it does not (an Apache/nginx HTML page, NASA's archive, FTP LIST or
  NLST), a file is taken only once two consecutive listings saw it with the
  same size: the listing's size, or, where it gives none, a `HEAD`
  (Content-Length) over HTTP or `SIZE` over FTP. So such a file arrives one
  poll after it first appears, and the download is checked against that size.
  When nothing gives a size at all (no HEAD, no SIZE), two listings prove
  nothing: the file is taken once its scan started 10 minutes ago (or
  `settle_seconds`, if longer), and only the transfer's own length is checked.
  A file that answers 404 to the size request is skipped, not counted as a
  server failure; three other failures in a row stop the size requests for
  that poll, and the files already confirmed are still downloaded.
* **Committing.** A half-downloaded file is never served: locally the staging
  file is moved into place with one atomic rename, on a bucket it is one PUT
  (S3 makes an object visible only whole) followed by a size check.
* **Pruning.** After each round, every volume whose scan started more than 36 h
  ago leaves the index (the API answers 404 from that moment) and the store.
* **Serving.** The files are byte for byte what the source sent: never renamed,
  never decompressed (a NASA `.cf.gz` stays gzip, a Rainbow `.vol` stays
  Rainbow). The relay does not parse radar data at all; the app does.

### Why 36 hours

* It covers what the app shows from live data: loops, the timeline, and the
  storms of the previous afternoon and night reviewed the next morning.
* It keeps the store small enough for a free tier (below), so the relay costs
  nothing to run.
* It is not an archive: CEMADEN keeps about 17 days itself, and older cases
  belong to the operator's own archive, not to a mirror.

## The API (the relay contract)

Contract **v1.1**. It only adds to v1: every v1 field and filter means what it
did, so a v1 client keeps working.

| Request | Answer |
| --- | --- |
| `GET /health` | `{"ok": true, "radars": 9}` (the radars the relay lists) |
| `GET /v1/radars` | `{"retentionHours": 36, "radars": [{"id": "BR-MCZ", "name": "Maceió (AL)", "lat": -9.5409, "lon": -35.7587, "newest": 1791790805, "volumes": 214, "updated": 1791791230}]}`; `newest` (the newest volume's stamp) and `updated` (v1.1: the newest `added` of its volumes) are unix times or `null` |
| `GET /v1/radars/{id}/volumes` | `{"radar": "BR-MCZ", "volumes": [{"stamp": "20261012074005", "unix": 1791790805, "added": 1791791230, "files": [{"name": "2026101207400500dBZ.vol", "size": 6873211, "added": 1791791230, "url": "/v1/files/BR-MCZ/20261012074005/2026101207400500dBZ.vol"}]}]}`, oldest first; `404` JSON for a radar the relay does not list |
| `GET /v1/radars/{id}/volumes?since=<unix>` | the same, only volumes whose `unix` is **greater than** `since` |
| `GET /v1/radars/{id}/volumes?addedSince=<unix>` | v1.1: the same, only volumes with at least one file whose `added` is **greater than** `addedSince`, each listed with **all** its files. Combines with `since` (both filters apply) |
| `GET /v1/files/{id}/{stamp}/{name}` | the file, `application/octet-stream`, `Cache-Control: public, max-age=129600, immutable`; `404` once pruned |

* **`added`** (v1.1) is the relay's own clock, in unix seconds, when the file
  was committed to its store. A volume's `added` is the newest of its files',
  and a radar's `updated` the newest `added` over its volumes. The stamp says
  when the radar scanned; `added` says when the relay got the file. The two
  differ by hours when the relay fetches a backlog late (after an outage of the
  source, or a source that uploads late).
* **Catching up: use `added`, not `since`.** Keep the newest `added` you hold as
  your cursor and ask `addedSince=<cursor - 1>`, skipping the names you already
  have. That brings every file the relay got after your last read, old stamps
  included, and since `added` comes from the relay's one clock, your own clock
  never matters. The `- 1` is there because `added` counts whole seconds: a file
  committed in the same second as the newest one you saw, just after you read,
  has the same `added`. `since` stays what it was, a filter on scan time
  ("volumes that started after"), for time windows.
* **Older stores:** an entry indexed before v1.1 (no recorded `added`) counts as
  added at its volume's stamp. When `index.json` is rebuilt from the store, a
  file's `added` is its modification time (a bucket's `LastModified`), rounded
  up to the second, else its stamp.

* **Radar ids:** `BR-ALM` Almenara, `BR-JAR` Jaraguari, `BR-MCZ` Maceió, `BR-NAT`
  Natal, `BR-PTL` Petrolina, `BR-SSA` Salvador, `BR-STE` Santa Teresa, `BR-SFR`
  São Francisco, `BR-TMA` Três Marias.
* **A volume** is named by its scan start, the **stamp**: UTC `YYYYMMDDHHMMSS`.
  Every file of one volume shares it. From the file names:
  * CEMADEN Rainbow 5: `<stamp><2 digits><moment>.vol` (or `.vol.h5`), e.g.
    `2026101207400500dBZ.vol` is stamp `20261012074005`, moment `dBZ`.
  * NASA GPM-VN: `<SITE>_<YYYY>_<MMDD>_<HHMMSS>.cf.gz`, e.g.
    `MC1_2026_0224_133002.cf.gz` is stamp `20260224133002`. NASA's codes:
    AL1 `BR-ALM`, JG1 `BR-JAR`, MC1 `BR-MCZ`, NT1 `BR-NAT`, PE1 `BR-PTL`,
    SV1 `BR-SSA`, ST1 `BR-STE`, SF1 `BR-SFR`, TM1 `BR-TMA`.
  * Anything else: the first 14-digit run, or `YYYYMMDD-HHMMSS`,
    `YYYYMMDD_HHMMSS`.
* **A volume can grow.** CEMADEN writes one file per moment, so the files of
  the newest volume may arrive over a couple of polls. `addedSince` returns the
  volume again, with all its files, whenever one is added to it. (A v1 client
  that polls with `since=<newest unix it has>` will not see them; it has to ask
  with `since=<newest unix> - 1` or re-read the newest volume.)
* Listings carry `Cache-Control: public, max-age=10`. CORS is open to GET from
  any origin (`[api] cors_origins` narrows it).
* A file is served only when its radar is listed, its stamp is a real time,
  its name is plain (`[A-Za-z0-9._-]`, no `..`) and the index holds it, so no
  request can reach anything outside the store.
* With `[api] public_base_url` set (the files in a public bucket, or behind a
  CDN), `/v1/files/...` answers `302` to `<public_base_url>/<key>` and the bytes
  never pass through the relay. (A `public_base_url` on the CAPTCHA host is
  refused when the configuration loads, `RELAY_PUBLIC_BASE_URL` included.)
* `--api-only` (following an `index.json` that another process writes): a
  `/v1/files` miss re-reads the index at once only when the stamp asked for is
  newer than the newest volume indexed for that radar, and at most once a
  second. Any other miss waits for the ordinary refresh (every 5 s at most), so
  requests for files that do not exist cost no store reads.

## Storage sizing

Measured: a full CEMADEN-style volume (every moment) is about **7 MB**. One
every 10 minutes is 144 a day, about **1 GB per radar per day**. At 36 h:

| | |
| --- | --- |
| one radar, 1.5 days | ~1.5 GB |
| 7 radars x 1.5 days | ~8.5-10 GB |
| all 9 radars, every moment | ~13-14 GB |

So with only the moments the app reads (the default: `dBZ`, `V`, `W`, `ZDR`,
`RhoHV`, `KDP`, `PhiDP`, in the `.vol` form; the unfiltered duplicates `dBuZ` and
`uPhiDP` and the `.vol.h5` copies skipped) the store fits the **10 GB free tier
of Cloudflare R2 or Backblaze B2**. Requests stay inside the free operation
counts too: about 9 radars x 144 volumes x 7 files = 9,000 uploads a day
(~270,000 a month), plus one `index.json` write per round that changed
something. R2 charges no egress; check each provider's current limits before
relying on them. On a VM's own disk, plan ~15 GB.

A NASA GPM-VN volume (one gzipped CfRadial file, every elevation and moment)
is about 3.4 MB.

## Running it

Python 3.11 or newer.

```sh
cd relay
pip install -r requirements.txt            # + requirements-s3.txt for a bucket
cp config.example.toml config.toml         # then fill in [sources.cemaden]
python -m relay --config config.toml
```

On the WeatherTS development machine the backend's venv has everything:
`..\backend\.venv\Scripts\python.exe -m relay --config config.toml` from `relay\`.
(Run it from `relay/`, or put `relay/` on `PYTHONPATH`: the package is
`relay/relay`.)

| Command | What runs |
| --- | --- |
| `python -m relay` | the API, with the poller in a background thread (one process does everything) |
| `python -m relay --api-only` | the API alone, following `index.json` that a poller elsewhere writes to the same store |
| `python -m relay --poller-only` | the poller alone |
| `python -m relay --once` | one round (every radar once, prune, write the index), then exit; status 1 if a radar failed, 2 for a configuration error (`configuration: ...` on stderr). A radar whose listing has no modification times is listed a second time `recheck_seconds` (20) later, in the same run, to confirm the sizes |

Also: `--retention-hours H`, `--radar BR-MCZ` (repeatable: poll only these),
`--reconcile` (check `index.json` against the store first; the long-running
modes always do), `--host`, `--port`, `--log-level DEBUG`.

### The demonstration: real CEMADEN volumes from NASA

The NASA GPM Validation Network republishes CEMADEN's volumes around each GPM
overpass: <https://pmm-gv.gsfc.nasa.gov/pub/gpmarchive/Radar/VN/GPM/MC1/> for
Maceió. They are real CEMADEN data (CfRadial, all elevations and moments) but
weeks old and only a few per month, so they demonstrate the pipeline, not a
live feed. `config.nasa-demo.toml` serves Maceió's volume of 24 February 2026:

```sh
python -m relay --config config.nasa-demo.toml --once        # downloads it (3.4 MB)
python -m relay --config config.nasa-demo.toml --once        # downloads nothing
python -m relay --config config.nasa-demo.toml --api-only    # http://127.0.0.1:8090/v1/radars
```

Its retention is a year (`retention_hours = 8760`) so a February volume is not
pruned.

### Docker

```sh
docker build -t weatherts-relay .                         # add --build-arg WITH_S3=1 for a bucket
docker run -d --name relay --restart unless-stopped -p 8080:8080 -v relay-data:/data \
  -e RELAY_CEMADEN_ENABLED=1 -e RELAY_CEMADEN_HOST=<host> \
  -e RELAY_CEMADEN_USER=<user> -e RELAY_CEMADEN_PASSWORD=<password> \
  -e RELAY_CEMADEN_PATH='/{site}/' \
  weatherts-relay
```

The image starts from `config.example.toml`; mount your own with
`-v $PWD/config.toml:/config/config.toml:ro`.

### A small VM

Any 1 vCPU / 512 MB machine with ~15 GB of disk (or a bucket). With systemd:

```ini
# /etc/systemd/system/weatherts-relay.service
[Unit]
Description=WeatherTS radar relay
After=network-online.target
Wants=network-online.target

[Service]
User=relay
WorkingDirectory=/opt/weatherts/relay
EnvironmentFile=/etc/weatherts-relay.env     # RELAY_CEMADEN_PASSWORD=... (chmod 600)
ExecStart=/opt/weatherts/relay/.venv/bin/python -m relay --config /opt/weatherts/relay/config.toml
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Put a TLS reverse proxy (Caddy, nginx) or Cloudflare in front of port 8080.

### As a scheduled job: GitHub Actions + R2, no server

`--once` runs one round and exits, so cron, a systemd timer or GitHub Actions
can drive the poller. The state lives in the bucket (`index.json`), so each run
continues where the last one stopped. With `static_api` the poller also writes
the API's JSON answers into the bucket (`health`, `v1/radars`,
`v1/radars/<id>/volumes`), and the files sit under `v1/files/`, so a public R2
bucket on a custom domain serves the whole contract without any server.
(A bucket ignores `?since=` and `?addedSince=`; clients filter by `since` and
`added` themselves, which is correct against the live API too: the JSON
carries every file's `added`.)

```yaml
# .github/workflows/radar-relay.yml
name: radar-relay
on:
  schedule:
    - cron: "*/5 * * * *"      # GitHub's minimum; runs can start a few minutes late
  workflow_dispatch:
concurrency: { group: radar-relay, cancel-in-progress: false }
jobs:
  poll:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.13" }
      - run: pip install -r relay/requirements.txt -r relay/requirements-s3.txt
      - run: python -m relay --config config.example.toml --once
        working-directory: relay
        env:
          RELAY_STORAGE_KIND: s3
          RELAY_STORAGE_PREFIX: v1/files/
          RELAY_STATIC_API: "1"
          RELAY_S3_BUCKET: weatherts-radar
          RELAY_S3_ENDPOINT: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
          RELAY_S3_KEY_ID: ${{ secrets.R2_KEY_ID }}
          RELAY_S3_SECRET: ${{ secrets.R2_SECRET }}
          RELAY_CEMADEN_ENABLED: "1"
          RELAY_CEMADEN_HOST: ${{ secrets.CEMADEN_HOST }}
          RELAY_CEMADEN_USER: ${{ secrets.CEMADEN_USER }}
          RELAY_CEMADEN_PASSWORD: ${{ secrets.CEMADEN_PASSWORD }}
```

Then give the bucket a public custom domain (R2: Settings, Custom Domains) and
a CORS rule allowing GET from any origin. Limits of this setup: one round every
5 minutes at best (the live API polls every 2), and GitHub's runners have no
fixed IP address: if CEMADEN's access is restricted to known addresses, use a
VM instead. Alternatively, keep `--once` on a timer and run `--api-only` (with
`public_base_url`) on any small host.

## Where CEMADEN's access goes

In `[sources.cemaden]` of `config.toml`, or entirely in environment variables
(`RELAY_CEMADEN_<KEY>` sets any key of that table):

| They give | Set |
| --- | --- |
| an FTP account | `transport = "ftp"`, `host`, `user`, `password` (better: `RELAY_CEMADEN_PASSWORD`), `tls = true` for FTPS, `path` |
| an HTTP directory | `transport = "http_index"`, `url`, and `token` (bearer) or `user`/`password` (basic) |
| files pushed to us | `transport = "local"`, `path` = the folder they land in |

then `enabled = true` (or `RELAY_CEMADEN_ENABLED=1`).

`path` and `url` are templates: `{site}` is the radar's `site` in `[[radars]]`
(set to CEMADEN's folder names once known; the defaults are the app's names:
`maceio`, `natal`...), `{SITE}` the same in upper case, `{id}` the relay id, and
`{date:%Y/%m/%d}` a UTC day, listed for each day of the 36 h window
(`day_offset_hours = -3` when their day folders follow Brasília time).
`settle_seconds = 30` leaves a file alone until it is 30 s old, when the listing
gives modification times (FTP MLSD does), so a file still being written is
never taken. Without them (an HTTP listing, an FTP server with LIST only) the
relay waits for the same size on two listings instead (see "Never half a
file" above); nothing to set.

Which moments are kept is `moments` (default `dBZ`, `V`, `W`, `ZDR`, `RhoHV`,
`KDP`, `PhiDP`) and `formats` (default `["vol"]`; add `"vol.h5"` for the HDF5
copies).

## Configuration

`config.example.toml` lists every key with a comment; `relay/config.py`
documents the environment variables:

* `RELAY_CONFIG` (the file), `RELAY_RETENTION_HOURS`, `RELAY_POLL_SECONDS`,
  `RELAY_RECHECK_SECONDS`, `RELAY_HOST`, `RELAY_PORT` (or `PORT`),
  `RELAY_PUBLIC_BASE_URL`, `RELAY_LOG_LEVEL`
* `RELAY_STORAGE_KIND`, `RELAY_STORAGE_PATH`, `RELAY_STORAGE_PREFIX`,
  `RELAY_STATIC_API`, `RELAY_S3_BUCKET`, `RELAY_S3_ENDPOINT`, `RELAY_S3_REGION`,
  `RELAY_S3_KEY_ID`, `RELAY_S3_SECRET`
* `RELAY_<SOURCE>_<KEY>` for any source key; `RELAY_FTP_USER` /
  `RELAY_FTP_PASSWORD` and `RELAY_HTTP_USER` / `RELAY_HTTP_PASSWORD` /
  `RELAY_HTTP_TOKEN` fill every ftp / http_index source left without them
* any value written `"env:NAME"` in the file is read from `$NAME`

`config.toml` and the data folders are in `.gitignore`: the live configuration
may hold credentials.

Mistakes are caught when the configuration loads, before anything is polled:
an unknown `transport` for `cemaden`, an `only_dates` day that is not
`YYYY-MM-DD` (from the environment: one comma-separated string), a
`filename_regex` or `link_regex` that does not compile, a `public_base_url` on
the CAPTCHA host. The relay prints `configuration: ...` and exits with status 2.

Source types: `ftp`, `http_index` (Apache/nginx listings, or nginx's JSON
autoindex), `local`, `nasa_vn`, and `cemaden` (a preset over the first three).
Storage: `local` (default) or `s3` (any S3-compatible bucket; boto3 is imported
only then).

## Tests

```sh
cd relay
python -m unittest discover -s tests -v
```

(or `python -m unittest discover -s relay/tests -v` from the repository root).
No network and no pytest: sources in temporary folders and on a local HTTP
server, a fake FTP server and a fake S3 client (that test runs when boto3 is
installed), a fixed clock to run "36 hours later", and the API under uvicorn on
a free port.

## Files

```
relay/
  relay/
    __main__.py   python -m relay: modes and flags
    config.py     TOML + environment; the nine radars' defaults; the CAPTCHA-host guard
    stamps.py     file name -> stamp (Rainbow, NASA VN, generic)
    sources.py    ftp, http_index, local, nasa_vn, cemaden
    storage.py    local folder, S3-compatible bucket
    index.py      index.json: what is stored
    poller.py     list, download once, prune
    views.py      the API's JSON (shared with the static bucket copy)
    api.py        FastAPI app
  tests/test_relay.py
  config.example.toml       the nine CEMADEN radars, source switched off
  config.nasa-demo.toml     the NASA demonstration, ready to run
  requirements.txt, requirements-s3.txt, Dockerfile
```
