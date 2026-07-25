# WeatherTS Sounding backend (SHARPpy)

Python service that fetches a vertical profile at an arbitrary lat/lon
(Open-Meteo pressure levels) for a model + forecast hour, runs it through
**SHARPpy**, renders SHARPpy's official `SPCWidget` template as a PNG image,
and returns JSON (levels + parcel path + full parameter suite + image).

## Setup (Python 3.13)

SHARPpy's PyPI package pins an ancient numpy that will not build on Python
3.12+, so install it **without deps** after the modern deps are in place:

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe -m pip install sharppy --no-deps
```

## Run

```bash
.venv/Scripts/python.exe -m uvicorn main:app --port 8787
```

The Vite dev server proxies `/sounding-backend/*` here (see `vite.config.ts`),
so the frontend calls `/sounding-backend/api/sounding?...`.

## Endpoints

- `GET /health`
- `GET /api/models`
- `GET /api/sounding?lat=..&lon=..&model=auto&hour=0`

Models: `auto`, `hrrr`, `gfs`, `icon`, `icon_eu`, `ecmwf`, `gem` (Open-Meteo backends).
`auto` uses Open-Meteo best match and is the default. If HRRR is requested
outside its U.S. coverage, the backend falls back to GFS and reports that in
`meta.fallbackReason`.
