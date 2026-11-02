"""
WeatherTS radar relay: one server that downloads each radar file once from its
source, keeps the last 36 hours, and serves them to every copy of the app.

The app never talks to the radar operator. The relay polls the operator's
endpoint (CEMADEN's FTP or HTTP access once granted; a local drop folder; the
NASA GPM Validation Network archive for demonstrations), stores each file
exactly as it came, under <radar>/<stamp>/<name>, and answers a small HTTP API:

    GET /health
    GET /v1/radars
    GET /v1/radars/{id}/volumes?since=<unix>&addedSince=<unix>
    GET /v1/files/{id}/{stamp}/{name}

(contract v1.1: every file and volume carries "added", the relay's clock when
it stored the file, and each radar "updated"; see views.py.)

So whatever number of people open the app, the operator sees one download per
file. Modules:

    config    the TOML file, environment overrides for secrets
    stamps    a file's name -> its volume's scan time (and moment, for Rainbow)
    sources   ftp, http_index, local, nasa_vn, and the cemaden preset
    storage   local folder or any S3-compatible bucket (R2, B2)
    index     what is stored, per radar and volume, kept as index.json
    poller    list, download once, prune past the retention
    api       the FastAPI app
"""
__version__ = "1.1.0"
