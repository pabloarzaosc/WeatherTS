"""Probe Open-Meteo pressure-level API: confirm we can get a vertical profile
at an arbitrary lat/lon for a given model + forecast hour."""
import requests

LEVELS = [1000, 925, 850, 700, 500, 300, 200, 100]
fields = []
for lv in LEVELS:
    for base in ("temperature", "relative_humidity", "wind_speed", "wind_direction", "geopotential_height"):
        fields.append(f"{base}_{lv}hPa")

for model in ("gfs_seamless", "icon_seamless", "gfs_hrrr"):
    print(f"\n===== model={model} =====")
    try:
        r = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": 35.22, "longitude": -97.44,
                "hourly": ",".join(fields),
                "forecast_days": 2,
                "models": model,
                "wind_speed_unit": "kn",
                "cell_selection": "nearest",
            },
            timeout=30,
        )
        print("status", r.status_code)
        j = r.json()
        if "error" in j:
            print("ERROR:", j.get("reason"))
            continue
        h = j["hourly"]
        t0 = h["time"][0]
        print("first time:", t0, "| n_hours:", len(h["time"]))
        print("sample @1000hPa: T=%s RH=%s WS=%s WD=%s GH=%s" % (
            h.get("temperature_1000hPa", ["?"])[0],
            h.get("relative_humidity_1000hPa", ["?"])[0],
            h.get("wind_speed_1000hPa", ["?"])[0],
            h.get("wind_direction_1000hPa", ["?"])[0],
            h.get("geopotential_height_1000hPa", ["?"])[0],
        ))
        print("sample @500hPa:  T=%s RH=%s GH=%s" % (
            h.get("temperature_500hPa", ["?"])[0],
            h.get("relative_humidity_500hPa", ["?"])[0],
            h.get("geopotential_height_500hPa", ["?"])[0],
        ))
    except Exception as e:
        print("EXC:", repr(e))
