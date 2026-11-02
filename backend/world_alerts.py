"""Alerts from outside the US, one source at a time, in the NWS alert's own shape.

The browser's alert code (src/lib/nwsAlerts.ts) only knows one shape of alert, so
every source here ends in the same record: the CAP fields under the NWS's names,
plus `source`, `country`, `kind`, `color`, `level` and `regions`.

The other sources: Environment Canada's GeoMet API, MeteoAlarm's feeds for 38
European countries (backend/data/emma_regions.json.gz has its regions' outlines; see
scripts/build-emma-regions.py), and for the rest of the world the WMO's collection of
CAP messages and the national feeds it does not carry.

Brazil has two systems, and they are different things:

- INMET's avisos (apiprevmet3.inmet.gov.br/avisos/ativos): the yellow, orange and
  red notices of the national weather service, hours to days ahead and over whole
  regions. Closer to a watch than a warning; they are named "... Alert" here and
  kept with the watches (Pablo, 2026-11-02).
- The Defesa Civil's alerts: the national IDAP system, in which every state's and
  many cities' civil defences publish, and which the phone alerts come out of. Its
  public CAP feed is the one the WMO's register of alerting authorities lists for
  SEDEC (idapfile.mdr.gov.br/idap/api/rss/cap). These are named "... Warning".
  Paraná's alertas-vigentes page is read too, for what the feed has let go of.

The feed is Atom with the whole CAP message inside each entry: 11 MB for 70 alerts,
because a polygon can run to 45 000 points, and it takes 15 s to come. An alert
already read is never parsed again, and polygons are thinned before they are kept.
The feed only reaches back about twelve hours and INMET's list only has what is in force,
so what has been read is also kept on disk: a timeline played back over the last
days finds the alerts that have since expired.
"""
from __future__ import annotations

import gzip
import json
import os
import re
import sys
import threading
import time
import unicodedata
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np
import requests

STORE = Path(os.environ.get("WEATHERTS_WORLD_ALERTS", str(Path.home() / ".weatherts" / "world-alerts")))
# How long after it ends an alert is kept, for a timeline played back.
KEEP_S = 3 * 86400
# Asked for without a `since`: this much of what has ended comes along.
DEFAULT_LOOKBACK_S = 6 * 3600
MAX_POINTS = 300
MIN_TOLERANCE = 0.002

_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "WeatherTS/1.0 (desktop weather app; https://weatherts.tech)"

CAP = "{urn:oasis:names:tc:emergency:cap:1.2}"
ATOM = "{http://www.w3.org/2005/Atom}"

YELLOW = "#ffe100"
ORANGE = "#ff7a00"
RED = "#ff1a1a"
MINOR = "#8fb8ff"


def _now() -> float:
    return time.time()


def _unix(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _plain(text: str) -> str:
    """Lower case with no accents, for matching names from a source."""
    return "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn").lower()


# ---------------------------------------------------------------- geometry ---


def _thin(ring: np.ndarray, tolerance: float) -> np.ndarray:
    """Douglas-Peucker over a closed ring, without recursion."""
    n = len(ring)
    if n <= 4:
        return ring
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        seg = ring[b] - ring[a]
        rel = ring[a + 1 : b] - ring[a]
        length = float(np.hypot(seg[0], seg[1]))
        if length == 0:
            dist = np.hypot(rel[:, 0], rel[:, 1])
        else:
            dist = np.abs(seg[0] * rel[:, 1] - seg[1] * rel[:, 0]) / length
        i = int(np.argmax(dist))
        if dist[i] > tolerance:
            i += a + 1
            keep[i] = True
            stack.append((a, i))
            stack.append((i, b))
    return ring[keep]


def _clean_ring(points: list[list[float]], min_tolerance: float = MIN_TOLERANCE) -> list[list[float]] | None:
    """A closed ring of at most MAX_POINTS, or None if it has no area to draw."""
    if len(points) < 3:
        return None
    ring = np.asarray(points, dtype=float)
    if not np.array_equal(ring[0], ring[-1]):
        ring = np.vstack([ring, ring[0]])
    keep = np.ones(len(ring), dtype=bool)
    keep[1:] = np.any(ring[1:] != ring[:-1], axis=1)
    ring = ring[keep]
    if len(ring) < 4:
        return None
    span = float(max(np.ptp(ring[:, 0]), np.ptp(ring[:, 1])))
    tolerance = max(min_tolerance, span / 400)
    thinned = _thin(ring, tolerance)
    while len(thinned) > MAX_POINTS:
        tolerance *= 1.6
        thinned = _thin(ring, tolerance)
    if len(thinned) < 4:
        return None
    return [[round(float(x), 4), round(float(y), 4)] for x, y in thinned]


def _geometry(rings: list[list[list[float]]], min_tolerance: float = MIN_TOLERANCE) -> dict[str, Any] | None:
    clean = [r for r in (_clean_ring(p, min_tolerance) for p in rings) if r]
    if not clean:
        return None
    if len(clean) == 1:
        return {"type": "Polygon", "coordinates": [clean[0]]}
    return {"type": "MultiPolygon", "coordinates": [[r] for r in clean]}


def _cap_polygon(text: str) -> list[list[float]]:
    """CAP's "lat,lon lat,lon ..." as [lon, lat] points."""
    out: list[list[float]] = []
    for pair in (text or "").split():
        parts = pair.split(",")
        if len(parts) < 2:
            continue
        try:
            out.append([float(parts[1]), float(parts[0])])
        except ValueError:
            continue
    return out


def _cap_circle(text: str) -> list[list[float]]:
    """CAP's "lat,lon radius-km" as a 32-sided ring."""
    try:
        centre, radius = (text or "").split()
        lat, lon = (float(v) for v in centre.split(","))
        km = float(radius)
    except ValueError:
        return []
    if km <= 0:
        return []
    angle = np.linspace(0, 2 * np.pi, 33)
    dlat = km / 111.32 * np.cos(angle)
    dlon = km / (111.32 * max(0.05, float(np.cos(np.radians(lat))))) * np.sin(angle)
    return [[float(lon + x), float(lat + y)] for x, y in zip(dlon, dlat)]


# ------------------------------------------------------------- Brazil: INMET ---

INMET_LIST = "https://apiprevmet3.inmet.gov.br/avisos/ativos"
INMET_RSS = "https://apiprevmet3.inmet.gov.br/avisos/rss"

INMET_EVENTS: list[tuple[str, str]] = [
    ("tempestade", "Storm Alert"),
    ("chuvas intensas", "Heavy Rain Alert"),
    ("acumulado de chuva", "Rain Accumulation Alert"),
    ("baixa umidade", "Low Humidity Alert"),
    ("onda de calor", "Heat Wave Alert"),
    ("onda de frio", "Cold Wave Alert"),
    ("declinio de temperatura", "Temperature Drop Alert"),
    ("geada", "Frost Alert"),
    ("vendaval", "Damaging Wind Alert"),
    ("ventos costeiros", "Coastal Wind Alert"),
    ("ressaca", "High Surf Alert"),
    ("granizo", "Hail Alert"),
    ("neve", "Snow Alert"),
    ("nevoeiro", "Fog Alert"),
    ("incendio", "Wildfire Alert"),
    ("seca", "Drought Alert"),
    ("estiagem", "Dry Spell Alert"),
    ("deslizamento", "Landslide Alert"),
    ("inundac", "Flood Alert"),
    ("alagamento", "Urban Flooding Alert"),
]

INMET_LEVELS = {
    "perigo potencial": ("Moderate", YELLOW, "Yellow: potential danger"),
    "perigo": ("Severe", ORANGE, "Orange: danger"),
    "grande perigo": ("Extreme", RED, "Red: great danger"),
}


def _inmet_event(name: str) -> str:
    plain = _plain(name)
    for word, event in INMET_EVENTS:
        if word in plain:
            return event
    return f"{name.strip().title()} Alert" if name.strip() else "Weather Alert"


def _inmet_sent(row_id: Any) -> str | None:
    """When a notice was issued: only its CAP message has it. The JSON's dates are
    midnight, and the RSS's pubDate is when the notice starts."""
    try:
        r = _SESSION.get(f"{INMET_RSS}/{row_id}", timeout=(10, 30))
        r.raise_for_status()
        return ET.fromstring(r.content).findtext(f"{CAP}sent")
    except (requests.RequestException, ET.ParseError):
        return None


def _inmet_time(text: str | None) -> str | None:
    """INMET's "2026-11-02 10:00" is Brasília time, as its CAP messages show."""
    if not text:
        return None
    try:
        return datetime.strptime(text.strip()[:16], "%Y-%m-%d %H:%M").replace(
            tzinfo=timezone(timedelta(hours=-3))
        ).isoformat()
    except ValueError:
        return None


def _inmet_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return [value.strip()] if isinstance(value, str) and value.strip() else []


def _inmet(known: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    r = _SESSION.get(INMET_LIST, timeout=(10, 40))
    r.raise_for_status()
    data = r.json()
    out: dict[str, dict[str, Any]] = {}
    for rows in data.values():
        if not isinstance(rows, list):
            continue
        for row in rows:
            if row.get("encerrado"):
                continue
            aid = f"br-inmet:{row.get('codigo') or row.get('id')}"
            if aid in known and known[aid].get("sequence") == row.get("id_sequencia"):
                out[aid] = known[aid]
                continue
            try:
                shape = json.loads(row.get("poligono") or "null")
            except ValueError:
                shape = None
            rings: list[list[list[float]]] = []
            if shape and shape.get("type") == "Polygon":
                rings = [shape["coordinates"][0]]
            elif shape and shape.get("type") == "MultiPolygon":
                rings = [p[0] for p in shape["coordinates"]]
            severity, color, level = INMET_LEVELS.get(
                _plain(row.get("severidade") or ""), ("Moderate", YELLOW, row.get("severidade") or "")
            )
            event = _inmet_event(row.get("descricao") or "")
            towns = [t for t in (row.get("municipios") or "").split(",") if t.strip()]
            regions = sorted({m for t in towns for m in re.findall(r" - ([A-Z]{2}) \(", t)})
            states = [s.strip() for s in (row.get("estados") or "").split(",") if s.strip()]
            start = _inmet_time(row.get("inicio"))
            issued = _inmet_sent(row.get("id")) or start or datetime.now(timezone.utc).isoformat()
            risks = _inmet_list(row.get("riscos"))
            out[aid] = {
                "id": aid,
                "sequence": row.get("id_sequencia"),
                "source": "br-inmet",
                "country": "BR",
                "kind": "watch",
                "color": color,
                "level": level,
                "regions": regions,
                "areaDesc": "; ".join(states),
                "sent": issued,
                # When it starts, not when it was issued: INMET issues days ahead,
                # and the map should not show Wednesday's storm alert on Monday.
                "effective": start or issued,
                "onset": start,
                "expires": _inmet_time(row.get("fim")),
                "ends": _inmet_time(row.get("fim")),
                "status": "Actual",
                "messageType": "Alert",
                "category": "Met",
                "severity": severity,
                "certainty": "Likely",
                "urgency": "Expected",
                "event": event,
                "senderName": "INMET",
                "headline": f"{event}, {level.split(':')[0].lower()} level",
                "description": "\n\n".join(risks + ([f"{len(towns)} municipalities."] if towns else [])),
                "instruction": "\n".join(_inmet_list(row.get("instrucoes"))) or None,
                "response": "Prepare",
                "web": f"https://avisos.inmet.gov.br/{row.get('id')}",
                "parameters": {},
                "affectedZones": [],
                "geometry": _geometry(rings),
            }
    return out


# ------------------------------------------------------ Brazil: Defesa Civil ---

IDAP_FEED = "https://idapfile.mdr.gov.br/idap/api/rss/cap"

# COBRADE's names, the classification the Defesa Civil's events use, by the word
# that decides each. First match wins, so the specific come before the general.
DEFESA_CIVIL_EVENTS: list[tuple[str, str]] = [
    ("tornado", "Tornado Warning"),
    ("granizo", "Hail Warning"),
    ("vendaval", "Damaging Wind Warning"),
    ("raios", "Lightning Warning"),
    ("ciclone", "Cyclone Warning"),
    ("ventos costeiros", "Coastal Wind Warning"),
    ("ressaca", "High Surf Warning"),
    ("enxurrada", "Flash Flood Warning"),
    ("inundac", "Flood Warning"),
    ("alagamento", "Urban Flooding Warning"),
    ("deslizamento", "Landslide Warning"),
    ("movimento de massa", "Landslide Warning"),
    ("erosao", "Erosion Warning"),
    ("incendio", "Wildfire Warning"),
    ("onda de calor", "Heat Wave Warning"),
    ("onda de frio", "Cold Wave Warning"),
    ("geada", "Frost Warning"),
    ("friagem", "Cold Snap Warning"),
    ("neve", "Snow Warning"),
    ("baixa umidade", "Low Humidity Warning"),
    ("umidade", "Low Humidity Warning"),
    ("estiagem", "Dry Spell Warning"),
    ("seca", "Drought Warning"),
    ("qualidade do ar", "Air Quality Warning"),
    ("barragem", "Dam Failure Warning"),
    ("sismo", "Earthquake Warning"),
    ("tremor", "Earthquake Warning"),
    ("tsunami", "Tsunami Warning"),
    ("produtos perigosos", "Hazardous Materials Warning"),
    ("radiolog", "Radiological Hazard Warning"),
    ("tempestade", "Severe Storm Warning"),
    ("chuvas intensas", "Heavy Rain Warning"),
    ("chuva", "Heavy Rain Warning"),
]

DEFESA_CIVIL_LEVELS = {
    "Extreme": (RED, "Very high"),
    "Severe": (ORANGE, "High"),
    "Moderate": (YELLOW, "Moderate"),
    "Minor": (YELLOW, "Low"),
}


def _defesa_civil_event(name: str) -> str:
    plain = _plain(name)
    # "TEMPESTADE LOCAL/CONVECTIVA - CHUVAS INTENSAS": the storm is what it says
    # first, and heavy rain is only one of the forms a storm comes in.
    if "tempestade local" in plain and not re.search(r"tornado|granizo|vendaval|raios", plain):
        return "Severe Storm Warning"
    for word, event in DEFESA_CIVIL_EVENTS:
        if word in plain:
            return event
    return "Civil Defense Warning"


def _place(text: str) -> str:
    """"SANTA CATARINA/SC" -> "Santa Catarina, SC"."""
    place = (text or "").strip()
    state = ""
    m = re.match(r"^(.*)/([A-Z]{2})$", place)
    if m:
        place, state = m.group(1).strip(), m.group(2)
    if place.isupper():
        small = {"de", "do", "da", "dos", "das", "e"}
        place = " ".join(w.lower() if w.lower() in small else w.capitalize() for w in place.split())
    return f"{place}, {state}" if state else place


def _idap(known: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    r = _SESSION.get(IDAP_FEED, timeout=(15, 120))
    r.raise_for_status()
    root = ET.fromstring(r.content)
    out: dict[str, dict[str, Any]] = {}
    ended: list[tuple[str, str]] = []
    for entry in root.findall(f"{ATOM}entry"):
        content = entry.find(f"{ATOM}content")
        alert = content.find(f"{CAP}alert") if content is not None else None
        if alert is None:
            continue
        identifier = alert.findtext(f"{CAP}identifier") or ""
        aid = f"br-defesacivil:{identifier}"
        if aid in known:
            out[aid] = known[aid]
            continue
        status = alert.findtext(f"{CAP}status") or "Actual"
        if status != "Actual":
            continue
        msg = alert.findtext(f"{CAP}msgType") or "Alert"
        sent = alert.findtext(f"{CAP}sent") or ""
        for ref in (alert.findtext(f"{CAP}references") or "").split():
            parts = ref.split(",")
            if len(parts) >= 2:
                ended.append((f"br-defesacivil:{parts[1]}", sent))
        if msg == "Cancel":
            continue
        info = alert.find(f"{CAP}info")
        if info is None:
            continue
        rings: list[list[list[float]]] = []
        places: list[str] = []
        regions: set[str] = set()
        for area in info.findall(f"{CAP}area"):
            desc = area.findtext(f"{CAP}areaDesc") or ""
            if desc:
                places.append(_place(desc))
                m = re.search(r"/([A-Z]{2})$", desc.strip())
                if m:
                    regions.add(m.group(1))
            rings += [_cap_polygon(p.text or "") for p in area.findall(f"{CAP}polygon")]
            rings += [_cap_circle(c.text or "") for c in area.findall(f"{CAP}circle")]
        severity = info.findtext(f"{CAP}severity") or "Unknown"
        color, level = DEFESA_CIVIL_LEVELS.get(severity, (YELLOW, ""))
        onset = info.findtext(f"{CAP}onset") or info.findtext(f"{CAP}effective")
        expires = info.findtext(f"{CAP}expires")
        out[aid] = {
            "id": aid,
            "source": "br-defesacivil",
            "country": "BR",
            "kind": "warning",
            "color": color,
            "level": level and f"{level} severity",
            "regions": sorted(regions),
            "areaDesc": "; ".join(places),
            "sent": sent,
            "effective": onset or sent,
            "onset": onset,
            "expires": expires,
            "ends": None,
            "status": "Actual",
            "messageType": msg,
            "category": info.findtext(f"{CAP}category") or "Met",
            "severity": severity,
            "certainty": info.findtext(f"{CAP}certainty") or "Unknown",
            "urgency": info.findtext(f"{CAP}urgency") or "Unknown",
            "event": _defesa_civil_event(info.findtext(f"{CAP}event") or ""),
            "senderName": info.findtext(f"{CAP}senderName") or "Defesa Civil",
            "headline": info.findtext(f"{CAP}headline"),
            "description": info.findtext(f"{CAP}description") or "",
            "instruction": info.findtext(f"{CAP}instruction"),
            "response": info.findtext(f"{CAP}responseType") or "",
            "web": info.findtext(f"{CAP}web"),
            "parameters": {},
            "affectedZones": [],
            "geometry": _geometry(rings),
        }
    for aid, sent in ended:
        if aid in out:
            out[aid] = {**out[aid], "ends": sent}
        elif aid in known:
            known[aid] = {**known[aid], "ends": sent}
    return out


PARANA_WFS = (
    "https://geoserver.pr.gov.br/geoserver/defesa_civil/ows?service=WFS&version=1.1.0&request=GetFeature"
    "&typeName=defesa_civil:alertas_vigentes_pol_p4326&outputFormat=application/json&srsName=EPSG:4326"
)
# Paraná's page lists what IDAP also has, a minute or two apart in its times.
TWIN_SENT_S = 300
TWIN_END_S = 600


def _parana_time(text: str | None) -> str | None:
    """Its "01-11-2026 23:33:10" is Brasília time."""
    try:
        return datetime.strptime((text or "").strip(), "%d-%m-%Y %H:%M:%S").replace(
            tzinfo=timezone(timedelta(hours=-3))
        ).isoformat()
    except ValueError:
        return None


def _parana(known: dict[str, dict[str, Any]], idap: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """What Paraná's own alertas-vigentes page has and the national feed does not.
    The feed only reaches back about twelve hours, so a statewide notice issued
    last night is on the state's page and no longer in the feed."""
    r = _SESSION.get(PARANA_WFS, timeout=(10, 40))
    r.raise_for_status()
    theirs = [
        (_unix(row.get("sent")), _unix(row.get("expires")))
        for row in idap.values()
        if "Paran" in (row.get("senderName") or "")
    ]
    out: dict[str, dict[str, Any]] = {}
    for feature in r.json().get("features", []):
        p = feature.get("properties") or {}
        aid = f"br-defesacivil:pr-{p.get('identifier')}"
        if aid in known:
            out[aid] = known[aid]
            continue
        sent = _parana_time(p.get("data_inicio"))
        ends = _parana_time(p.get("data_fim"))
        at, until = _unix(sent), _unix(ends)
        if at is None or until is None:
            continue
        if any(
            s is not None and e is not None and abs(s - at) < TWIN_SENT_S and abs(e - until) < TWIN_END_S
            for s, e in theirs
        ):
            continue
        shape = feature.get("geometry") or {}
        coords = shape.get("coordinates") or []
        rings = [coords[0]] if shape.get("type") == "Polygon" and coords else [q[0] for q in coords if q]
        severity = p.get("severidade") or "Unknown"
        color, level = DEFESA_CIVIL_LEVELS.get(severity, (YELLOW, ""))
        out[aid] = {
            "id": aid,
            "source": "br-defesacivil",
            "country": "BR",
            "kind": "warning",
            "color": color,
            "level": level and f"{level} severity",
            "regions": ["PR"],
            "areaDesc": "Paraná, PR",
            "sent": sent,
            "effective": sent,
            "onset": sent,
            "expires": ends,
            "ends": None,
            "status": "Actual",
            "messageType": "Alert",
            "category": "Met",
            "severity": severity,
            "certainty": p.get("confiabilidade") or "Unknown",
            "urgency": p.get("urgencia") or "Unknown",
            "event": _defesa_civil_event(p.get("evento") or ""),
            "senderName": "Defesa Civil Estadual do Paraná",
            "headline": p.get("descricao"),
            "description": p.get("descricao_completa") or "",
            "instruction": p.get("instrucoes"),
            "response": "",
            "web": "https://www.defesacivil.pr.gov.br/alertas-vigentes",
            "parameters": {},
            "affectedZones": [],
            "geometry": _geometry(rings),
        }
    return out


def _defesa_civil(known: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out = _idap(known)
    try:
        out.update(_parana(known, out | known))
    except (requests.RequestException, ValueError):
        pass
    return out


# ------------------------------------------------------------------ Canada ---

ECCC_ALERTS = "https://api.weather.gc.ca/collections/weather-alerts/items?limit=4000&f=json"

# Environment Canada's names the NWS has no colour for, by the NWS product each is
# closest to. What the NWS also issues (Tornado Warning, Blizzard Warning...) has no
# entry: it is drawn in that product's colour, so the map reads the same either side
# of the border.
ECCC_COLORS: list[tuple[str, str]] = [
    ("snowfall", "#ff69b4"),
    ("rainfall", "#00ff00"),
    ("wind", "#daa520"),
    ("freezing rain", "#8b008b"),
    ("freezing drizzle", "#da70d6"),
    ("flash freeze", "#8b008b"),
    ("heat", "#c71585"),
    ("fog", "#708090"),
    ("air quality", "#808080"),
    ("dust", "#ffe4c4"),
    ("arctic", "#0000ff"),
    ("cold", "#afeeee"),
    ("frost", "#6495ed"),
    ("weather", "#c0a062"),
]
NWS_NAMES = re.compile(
    r"^(tornado|severe thunderstorm|blizzard|winter storm|ice storm|snow squall|special weather|"
    r"extreme cold|frost advisory|hurricane|tropical storm|storm surge|flood|dense fog)",
    re.I,
)


def _eccc(known: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    r = _SESSION.get(ECCC_ALERTS, timeout=(15, 90))
    r.raise_for_status()
    # One feature per forecast zone: an alert is all those sharing the id's first part.
    grouped: dict[str, list[dict[str, Any]]] = {}
    for feature in r.json().get("features", []):
        grouped.setdefault(str(feature.get("id", "")).split("_")[0], []).append(feature)
    out: dict[str, dict[str, Any]] = {}
    for key, features in grouped.items():
        p = features[0].get("properties") or {}
        aid = f"ca-eccc:{key}:{p.get('alert_code')}"
        status = p.get("status_en") or ""
        published = p.get("publication_datetime")
        if aid in known and known[aid].get("sent") == published and known[aid].get("state") == status:
            out[aid] = known[aid]
            continue
        rings: list[list[list[float]]] = []
        for feature in features:
            shape = feature.get("geometry") or {}
            coords = shape.get("coordinates") or []
            if shape.get("type") == "Polygon" and coords:
                rings.append(coords[0])
            elif shape.get("type") == "MultiPolygon":
                rings += [q[0] for q in coords if q]
        event = (p.get("alert_name_en") or "weather alert").strip().title()
        kind = p.get("alert_type") if p.get("alert_type") in ("warning", "watch", "advisory", "statement") else "advisory"
        colour = (p.get("risk_colour_en") or "").capitalize()
        confidence = p.get("confidence_en")
        impact = p.get("impact_en")
        facts = [f"{colour} level"] if colour else []
        if impact and impact != "None":
            facts.append(f"{impact} impact")
        if confidence and confidence != "None":
            facts.append(f"{confidence} confidence")
        fill = None
        if not NWS_NAMES.match(event):
            plain = event.lower()
            fill = next((c for word, c in ECCC_COLORS if word in plain), None)
        names = sorted({str((f.get("properties") or {}).get("feature_name_en") or "") for f in features} - {""})
        regions = {s for f in features for s in str((f.get("properties") or {}).get("province") or "").split("/") if s}
        ended = status == "ended"
        out[aid] = {
            "id": aid,
            "state": status,
            "source": "ca-eccc",
            "country": "CA",
            "kind": kind,
            "color": fill,
            "level": ", ".join(facts),
            "regions": sorted(regions),
            "areaDesc": "; ".join(f"{n}, {p.get('province')}" if "/" not in str(p.get("province")) else n for n in names[:80]),
            "sent": published,
            "effective": p.get("validity_datetime") or published,
            "onset": p.get("validity_datetime") or published,
            "expires": p.get("expiration_datetime"),
            # Ended by the forecaster: from when it said so, not its printed end.
            "ends": published if ended else p.get("event_end_datetime"),
            "status": "Actual",
            "messageType": "Cancel" if ended else "Alert",
            "category": "Met",
            "severity": "Extreme" if colour == "Red" else "Severe" if colour == "Orange" else "Moderate",
            "certainty": "Likely",
            "urgency": "Expected",
            "event": event,
            "senderName": "Environment Canada",
            "headline": p.get("alert_short_name_en"),
            "description": p.get("alert_text_en") or "",
            "instruction": None,
            "response": "",
            "web": "https://weather.gc.ca/?layers=alert",
            "parameters": {},
            "affectedZones": [],
            "geometry": _geometry(rings, min_tolerance=0.005),
        }
    return out


# ------------------------------------------------------------------ Europe ---

METEOALARM_FEEDS = {
    "andorra": "AD", "austria": "AT", "belgium": "BE", "bosnia-herzegovina": "BA", "bulgaria": "BG",
    "croatia": "HR", "cyprus": "CY", "czechia": "CZ", "denmark": "DK", "estonia": "EE", "finland": "FI",
    "france": "FR", "germany": "DE", "greece": "GR", "hungary": "HU", "iceland": "IS", "ireland": "IE",
    "israel": "IL", "italy": "IT", "latvia": "LV", "lithuania": "LT", "luxembourg": "LU", "malta": "MT",
    "moldova": "MD", "montenegro": "ME", "netherlands": "NL", "norway": "NO", "poland": "PL", "portugal": "PT",
    "romania": "RO", "serbia": "RS", "slovakia": "SK", "slovenia": "SI", "spain": "ES", "sweden": "SE",
    "switzerland": "CH", "ukraine": "UA", "united-kingdom": "GB",
}
METEOALARM_TYPES = {
    "wind": "Wind", "snow-ice": "Snow and Ice", "thunderstorm": "Thunderstorm", "thunderstorms": "Thunderstorm",
    "fog": "Fog", "high-temperature": "Heat", "low-temperature": "Cold", "coastalevent": "Coastal",
    "forest-fire": "Forest Fire", "avalanches": "Avalanche", "avalanche": "Avalanche", "rain": "Rain",
    "flooding": "Flood", "flood": "Flood", "rain-flood": "Rain and Flood",
}
EMMA_FILE = "emma_regions.json.gz"
_emma_lock = threading.Lock()
_emma_codes: dict[str, list[list[list[float]]]] = {}
_emma_names: dict[tuple[str, str], list[list[list[float]]]] = {}


def _region_key(name: str) -> str:
    """"Oost-Vlaanderen" and "Oost Vlaanderen", "Cork" and "County Cork" are one."""
    words = re.sub(r"[-_/'.,]", " ", _plain(name)).split()
    return " ".join(w for w in words if w not in ("county", "region"))


def _emma_load() -> None:
    with _emma_lock:
        if _emma_codes:
            return
        base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "data" / EMMA_FILE
        with gzip.open(base, "rt", encoding="utf-8") as f:
            for row in json.load(f):
                _emma_codes[row["code"]] = row["rings"]
                _emma_names[(row["country"], _region_key(row["name"]))] = row["rings"]


def _region_rings(codes: list[str], names: list[str], country: str) -> list[list[list[float]]]:
    """A region's outline from its code, or else its name in any of the message's
    languages: Bulgaria, France, Hungary and Romania give NUTS codes, which the
    geocodes file does not have, and it spells Belgium's names in Dutch."""
    _emma_load()
    rings: list[list[list[float]]] = []
    for code in codes:
        if code in _emma_codes:
            rings += _emma_codes[code]
    for name in names:
        if rings:
            break
        rings = _emma_names.get((country, _region_key(name)), [])
    return rings


def _pick_info(infos: list[dict[str, Any]]) -> dict[str, Any] | None:
    for info in infos:
        if str(info.get("language") or "").lower().startswith("en"):
            return info
    return infos[0] if infos else None


def _parameter(info: dict[str, Any], name: str) -> str:
    for p in info.get("parameter") or []:
        if p.get("valueName") == name:
            return str(p.get("value") or "")
    return ""


def _meteoalarm_feed(name: str) -> list[dict[str, Any]]:
    r = _SESSION.get(f"https://feeds.meteoalarm.org/api/v1/warnings/feeds-{name}", timeout=(10, 60))
    if r.status_code == 404:
        return []
    r.raise_for_status()
    return r.json().get("warnings") or []


def _meteoalarm(known: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    failed = 0
    with ThreadPoolExecutor(6) as pool:
        futures = {pool.submit(_meteoalarm_feed, name): code for name, code in METEOALARM_FEEDS.items()}
        for future, country in futures.items():
            try:
                warnings = future.result()
            except (requests.RequestException, ValueError):
                failed += 1
                # A country whose feed did not answer keeps what it had.
                out.update({k: v for k, v in known.items() if v.get("country") == country})
                continue
            for warning in warnings:
                alert = warning.get("alert") or {}
                if alert.get("status") != "Actual" or alert.get("msgType") == "Cancel":
                    continue
                aid = f"eu-meteoalarm:{alert.get('identifier')}"
                if aid in known:
                    out[aid] = known[aid]
                    continue
                info = _pick_info(alert.get("info") or [])
                if info is None:
                    continue
                level = [v.strip() for v in _parameter(info, "awareness_level").split(";")]
                # Level 1, green, is MeteoAlarm saying there is nothing: 2000 of 2900.
                if len(level) < 3 or level[0] == "1":
                    continue
                colour = level[1].capitalize()
                kind = str(_parameter(info, "awareness_type").split(";")[-1]).strip().lower()
                hazard = METEOALARM_TYPES.get(kind, kind.title() or "Weather")
                rings: list[list[list[float]]] = []
                places: list[str] = []
                others = [i.get("area") or [] for i in alert.get("info") or [] if i is not info]
                for index, area in enumerate(info.get("area") or []):
                    desc = area.get("areaDesc") or ""
                    if desc:
                        places.append(desc)
                    shapes = area.get("polygon") or []
                    shapes = [shapes] if isinstance(shapes, str) else shapes
                    found = [_cap_polygon(s) for s in shapes]
                    circles = area.get("circle") or []
                    found += [_cap_circle(c) for c in ([circles] if isinstance(circles, str) else circles)]
                    codes = [str(g.get("value")) for g in area.get("geocode") or []]
                    names = [desc] + [o[index].get("areaDesc") or "" for o in others if index < len(o)]
                    rings += found if any(found) else _region_rings(codes, names, country)
                sent = alert.get("sent")
                onset = info.get("onset") or info.get("effective") or sent
                out[aid] = {
                    "id": aid,
                    "source": "eu-meteoalarm",
                    "country": country,
                    # Yellow is MeteoAlarm's "be aware", drawn as a shaded area like an
                    # advisory. Germany alone has warnings over 400 districts at once.
                    "kind": "advisory" if colour == "Yellow" else "warning",
                    "color": {"Yellow": YELLOW, "Orange": ORANGE, "Red": RED}.get(colour, YELLOW),
                    "level": f"{colour} level",
                    "regions": [],
                    "areaDesc": "; ".join(places[:80]) + (f"; {len(places) - 80} more" if len(places) > 80 else ""),
                    "sent": sent,
                    "effective": onset,
                    "onset": onset,
                    "expires": info.get("expires"),
                    "ends": None,
                    "status": "Actual",
                    "messageType": alert.get("msgType") or "Alert",
                    "category": "Met",
                    "severity": level[2],
                    "certainty": info.get("certainty") or "Unknown",
                    "urgency": info.get("urgency") or "Unknown",
                    "event": f"{colour} {hazard} Warning",
                    "senderName": info.get("senderName") or "MeteoAlarm",
                    "headline": info.get("headline"),
                    "description": info.get("description") or "",
                    "instruction": info.get("instruction"),
                    "response": "",
                    "web": info.get("web") or "https://meteoalarm.org",
                    "parameters": {},
                    "affectedZones": [],
                    "geometry": _geometry(rings, min_tolerance=0.01),
                }
    if failed == len(METEOALARM_FEEDS):
        raise RuntimeError("MeteoAlarm did not answer")
    return out


# ------------------------------------------------------- the rest of the world ---

# The WMO's Severe Weather Information Centre keeps every member's CAP messages in
# one place, one list and a file per alert. Those with a source of their own here
# are left out. Others publish only to their own feeds (the sources behind the IFRC
# Alert Hub, whose list is at alert-hub-sources.s3.amazonaws.com/json).
WMO_LIST = "https://severeweather.wmo.int/json/wmo_all.json"
WMO_CAP = "https://severeweather.wmo.int/v2/cap-alerts/"
WMO_SKIP = set(
    "us ca br ad at be ba bg hr cy cz dk ee fi fr de gr hu is ie il it lv lt lu mt md me nl no pl pt ro rs sk si es se "
    "ch ua uk".split()
)
CAP_FEEDS = {
    "ar": "https://ssl.smn.gob.ar/CAP/AR.php",
    "uy": "https://www.inumet.gub.uy/reportes/riesgo/rss.xml",
    "mx": "https://smn.conagua.gob.mx/tools/PHP/feedsmn/cap.php",
    "ph": "https://publicalert.pagasa.dost.gov.ph/feeds/",
    "do": "https://cap-sources.s3.amazonaws.com/do-indomet-es/rss.xml",
    "pa": "https://cap-sources.s3.amazonaws.com/pa-imhpa-es/rss.xml",
    "tt": "https://metproducts.gov.tt/ttms/public/api/feed?type=rss",
    "bz": "https://cap-sources.s3.amazonaws.com/bz-nms-en/rss.xml",
    "gy": "https://cap-sources.s3.amazonaws.com/gy-hms-en/rss.xml",
    "lc": "https://saint-lucia.cap-composer.wiscaribbeancmo.org/api/cap/rss.xml",
    "hk": "https://alerts.weather.gov.hk/V1/cap_atom.xml",
    "mo": "https://rss.smg.gov.mo/cap_rss.xml",
    "sg": "https://www.weather.gov.sg/files/rss/rsscapalert/rsscapalert.xml",
    "in": "https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml",
    "mv": "https://cap.meteorology.gov.mv/rss/alerts/",
    "kw": "https://www.met.gov.kw/rss_eng/kuwait_cap.xml",
    "qa": "https://cap-sources.s3.amazonaws.com/qa-caa-ar/rss.xml",
    "sy": "https://climweb.med.gov.sy/api/cap/rss.xml",
    "kg": "https://meteoalert.meteoinfo.ru/kyrgyzstan/cap-feed/ru/atom.xml",
    "sb": "https://cap-sources.s3.amazonaws.com/sb-met-en/rss.xml",
    "vu": "https://cap-sources.s3.amazonaws.com/vu-vmgd-en/rss.xml",
    "ly": "https://cap-sources.s3.amazonaws.com/ly-nmc-ar/rss.xml",
    "ke": "https://meteo.go.ke/api/cap/rss.xml",
    "et": "https://www.ethiomet.gov.et/api/cap/rss.xml",
    "gh": "https://www.meteo.gov.gh/api/cap/rss.xml",
    "tz": "https://cap-sources.s3.amazonaws.com/tz-tma-en/rss.xml",
    "mg": "https://cap-sources.s3.amazonaws.com/mg-meteo-en/rss.xml",
    "mz": "https://inam.gov.mz/api/cap/rss.xml",
    "mw": "https://www.metmalawi.gov.mw/api/cap/rss.xml",
    "zm": "https://zmd.gov.zm/api/cap/rss.xml",
    "zw": "https://www.weatherzw.org.zw/api/cap/rss.xml",
    "bw": "https://cap-sources.s3.amazonaws.com/bw-met-en/rss.xml",
    "cm": "https://cap-sources.s3.amazonaws.com/cm-meteo-en/rss.xml",
    "bj": "https://www.meteobenin.bj/api/cap/rss.xml",
    "bf": "https://www.meteoburkina.bf/api/cap/rss.xml",
    "cd": "https://meteordcongo.cd/api/cap/rss.xml",
    "cg": "https://dirmet.cg/api/cap/rss.xml",
    "dj": "https://meteodjibouti.dj/api/cap/rss.xml",
    "gm": "https://meteogambia.gm/api/cap/rss.xml",
    "km": "https://meteocomores.km/api/cap/rss.xml",
    "lr": "https://meteoliberia.com/api/cap/rss.xml",
    "ml": "https://www.malimeteo.ml/api/cap/rss.xml",
    "mr": "https://meteomauritanie.mr/api/cap/rss.xml",
    "sc": "https://www.meteo.sc/api/cap/rss.xml",
    "sd": "https://meteosudan.sd/api/cap/rss.xml",
    "so": "https://meteosomalia.so/api/cap/rss.xml",
    "ss": "https://meteosouthsudan.com.ss/api/cap/rss.xml",
    "td": "https://www.meteotchad.org/api/cap/rss.xml",
    "tg": "https://meteotogo.tg/api/cap/rss.xml",
}
FEED_ITEMS = 40
CAP_WORKERS = 12
CAP_PER_READ = 1500

# What a hazard is called, from the words the feeds use for it. CAP messages in
# English are named as they stand; this is for the rest, so the list stays English.
HAZARD_WORDS: list[tuple[str, str]] = [
    (r"tsunami|maremoto", "Tsunami"),
    (r"tropical|cyclone|ciclon|typhoon|hurrican|huracan|tifon|тайфун|циклон", "Tropical Cyclone"),
    (r"tornado|trombe", "Tornado"),
    (r"thunder|tormenta|orage|trovoada|gewitter|гроз", "Thunderstorm"),
    (r"hail|granizo|grele|град", "Hail"),
    (r"flood|inundac|crecida|inondation|cheia|паводок|наводн", "Flood"),
    (r"landslide|deslizamiento|deslizamento|glissement|оползень|сель", "Landslide"),
    (r"snow|nieve|nevada|neige|снег|метел", "Snow"),
    (r"rain|lluvia|pluie|chuva|precipitac|дожд|ливень|осадк", "Rain"),
    (r"wind|viento|vent|vento|gale|ветер", "Wind"),
    (r"fog|niebla|brouillard|nevoeiro|туман", "Fog"),
    (r"heat|calor|chaleur|canicula|жара", "Heat"),
    (r"cold|frio|froid|helada|gelee|мороз|заморозк", "Cold"),
    (r"fire|incendio|feu|пожар", "Fire"),
    (r"dust|polvo|poussiere|sable|sand|пыль", "Dust"),
    (r"wave|oleaje|marejada|marea|surf|mer |ressaca|волн", "Coastal"),
    (r"volcan|вулкан", "Volcano"),
    (r"earthquake|sismo|seisme|землетряс", "Earthquake"),
]


def _cap_event(event: str, headline: str, language: str, severity: str) -> str:
    strong = severity in ("Extreme", "Severe")
    suffix = "Warning" if strong else "Advisory"
    name = re.sub(r"\s+", " ", event or "").strip()
    if language.lower().startswith("en") and name and name.isascii():
        name = name.title()
        return name if re.search(r"warning|watch|advisory|alert|statement", name, re.I) else f"{name} {suffix}"
    plain = _plain(f"{event} {headline}")
    for pattern, hazard in HAZARD_WORDS:
        if re.search(pattern, plain):
            return f"{hazard} {suffix}"
    return f"Weather {suffix}"


def _cap_record(content: bytes, country: str, sid: str) -> dict[str, Any] | None:
    root = ET.fromstring(content)
    ns = root.tag[: root.tag.index("}") + 1] if root.tag.startswith("{") else ""
    if root.tag != f"{ns}alert" or (root.findtext(f"{ns}status") or "Actual") != "Actual":
        return None
    msg = root.findtext(f"{ns}msgType") or "Alert"
    # "sender,identifier,sent" each: what this message replaces or calls off.
    replaced = [
        f"{sid}:{country}:{ref.split(',')[1]}" for ref in (root.findtext(f"{ns}references") or "").split() if ref.count(",") >= 2
    ]
    if msg == "Cancel":
        return {"id": None, "replaced": replaced, "sent": root.findtext(f"{ns}sent")}
    infos = root.findall(f"{ns}info")
    info = next((i for i in infos if (i.findtext(f"{ns}language") or "").lower().startswith("en")), None)
    info = info if info is not None else (infos[0] if infos else None)
    if info is None:
        return None
    severity = info.findtext(f"{ns}severity") or "Unknown"
    sent = root.findtext(f"{ns}sent")
    expires = info.findtext(f"{ns}expires")
    rings: list[list[list[float]]] = []
    places: list[str] = []
    for area in info.findall(f"{ns}area"):
        desc = area.findtext(f"{ns}areaDesc") or ""
        if desc:
            places.append(desc)
        found = [_cap_polygon(p.text or "") for p in area.findall(f"{ns}polygon")]
        found += [_cap_circle(c.text or "") for c in area.findall(f"{ns}circle")]
        codes = [g.findtext(f"{ns}value") or "" for g in area.findall(f"{ns}geocode")]
        rings += found if any(found) else _region_rings(codes, [desc], country.upper())
    geometry = _geometry(rings)
    if geometry is None:
        return {"id": None, "replaced": replaced, "sent": sent}
    onset = info.findtext(f"{ns}onset") or info.findtext(f"{ns}effective") or sent
    headline = info.findtext(f"{ns}headline")
    color = {"Extreme": RED, "Severe": ORANGE, "Moderate": YELLOW, "Minor": MINOR}.get(severity, MINOR)
    event = _cap_event(info.findtext(f"{ns}event") or "", headline or "", info.findtext(f"{ns}language") or "", severity)
    return {
        "id": f"{sid}:{country}:{root.findtext(f'{ns}identifier')}",
        "replaced": replaced,
        "source": sid,
        "country": country.upper(),
        "kind": "warning" if severity in ("Extreme", "Severe") else "advisory",
        "color": color,
        "level": {"Extreme": "Extreme", "Severe": "Severe", "Moderate": "Moderate", "Minor": "Minor"}.get(severity, ""),
        "regions": [],
        "areaDesc": "; ".join(places[:80]),
        "sent": sent,
        "effective": onset,
        "onset": onset,
        "expires": expires,
        "ends": None,
        "status": "Actual",
        "messageType": msg,
        "category": info.findtext(f"{ns}category") or "Met",
        "severity": severity,
        "certainty": info.findtext(f"{ns}certainty") or "Unknown",
        "urgency": info.findtext(f"{ns}urgency") or "Unknown",
        "event": event,
        "senderName": info.findtext(f"{ns}senderName") or root.findtext(f"{ns}sender") or "",
        "headline": headline,
        "description": info.findtext(f"{ns}description") or "",
        "instruction": info.findtext(f"{ns}instruction"),
        "response": info.findtext(f"{ns}responseType") or "",
        "web": info.findtext(f"{ns}web"),
        "parameters": {},
        "affectedZones": [],
        "geometry": geometry,
    }


def _feed_links(country: str, url: str) -> list[tuple[str, str]]:
    """The newest CAP links of a national feed; a feed that is down has none today."""
    try:
        r = _SESSION.get(url, timeout=(8, 25))
        r.raise_for_status()
        root = ET.fromstring(r.content)
    except (requests.RequestException, ET.ParseError):
        return []
    links = [i.findtext("link") or "" for i in root.iter("item")]
    links += [l.get("href") or "" for e in root.iter(f"{ATOM}entry") for l in e.findall(f"{ATOM}link")]
    return [(country, l.strip()) for l in links if l.strip()][:FEED_ITEMS]


def _cap_fetch(job: tuple[str, str]) -> tuple[str, dict[str, Any] | None, bool]:
    """One CAP file: (its url, the alert if there is one, whether to ask again)."""
    country, url = job
    try:
        r = _SESSION.get(url, timeout=(8, 25))
        if r.status_code in (403, 404, 410):
            return url, None, False
        r.raise_for_status()
        return url, _cap_record(r.content, country, "world-cap"), False
    except requests.RequestException:
        return url, None, True
    except (ET.ParseError, ValueError):
        return url, None, False


def _world_cap(known: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    seen_path = STORE / "world-cap-seen.json"
    try:
        seen: dict[str, float] = json.loads(seen_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        seen = {}
    jobs: list[tuple[str, str]] = []
    try:
        for item in _SESSION.get(WMO_LIST, timeout=(10, 60)).json().get("items", []):
            path = item.get("capURL") or item.get("url") or ""
            country = path[:2]
            if "/" not in path or country in WMO_SKIP:
                continue
            jobs.append((country, path if path.startswith("http") else WMO_CAP + path))
    except (requests.RequestException, ValueError):
        pass
    with ThreadPoolExecutor(CAP_WORKERS) as pool:
        for links in pool.map(lambda kv: _feed_links(*kv), CAP_FEEDS.items()):
            jobs += links
        jobs = [j for j in jobs if j[1] not in seen][:CAP_PER_READ]
        out: dict[str, dict[str, Any]] = {}
        source = SOURCES["world-cap"]
        now = _now()
        for i, (url, row, again) in enumerate(pool.map(_cap_fetch, jobs)):
            if not again:
                seen[url] = now
            if row:
                for old in row["replaced"]:
                    if old in out:
                        out[old] = {**out[old], "ends": row["sent"]}
                    elif old in known:
                        out[old] = {**known[old], "ends": row["sent"]}
                if row["id"]:
                    out[row["id"]] = row
            if i % 25 == 24:
                source.partial(out)
    # Forgotten after a month: long since expired, and off every feed.
    seen = {k: v for k, v in seen.items() if now - v < 30 * 86400}
    try:
        STORE.mkdir(parents=True, exist_ok=True)
        seen_path.write_text(json.dumps(seen), encoding="utf-8")
    except OSError:
        pass
    return out


# ------------------------------------------------------------- the sources ---


class _Source:
    """One source's alerts, what has been read of it, and its next read."""

    def __init__(
        self,
        sid: str,
        read: Callable[[dict[str, dict[str, Any]]], dict[str, dict[str, Any]]],
        ttl: float,
        # A list of what is in force: an alert gone from it before its end has ended.
        authoritative: bool = False,
        # Too slow for anyone to wait on: the first read also runs behind.
        background: bool = False,
    ) -> None:
        self.id = sid
        self.read = read
        self.ttl = ttl
        self.authoritative = authoritative
        self.background = background
        self.rows: dict[str, dict[str, Any]] = {}
        self.read_at = 0.0
        self.error: str | None = None
        self.lock = threading.Lock()
        self.loading = False
        self.loaded = False

    def _path(self) -> Path:
        return STORE / f"{self.id}.json"

    def _load_disk(self) -> None:
        if self.loaded:
            return
        self.loaded = True
        try:
            self.rows = json.loads(self._path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.rows = {}

    def _save_disk(self) -> None:
        try:
            STORE.mkdir(parents=True, exist_ok=True)
            tmp = self._path().with_suffix(".tmp")
            tmp.write_text(json.dumps(self.rows, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self._path())
        except OSError:
            pass

    @staticmethod
    def _end(row: dict[str, Any]) -> float:
        return _unix(row.get("ends")) or _unix(row.get("expires")) or (_unix(row.get("sent")) or 0) + 86400

    def partial(self, rows: dict[str, dict[str, Any]]) -> None:
        """What a long read has so far, for whoever asks meanwhile."""
        self.rows = {**self.rows, **rows}

    def refresh(self) -> None:
        """One read of the source. Whoever holds the lock reads; nobody waits on
        the network holding `rows`, which are replaced whole."""
        with self.lock:
            self._load_disk()
            if _now() - self.read_at < self.ttl and self.read_at:
                return
            self.loading = True
            try:
                known = dict(self.rows)
                fresh = self.read(known)
                now = _now()
                stamp = datetime.fromtimestamp(now, timezone.utc).isoformat()
                merged: dict[str, dict[str, Any]] = {}
                for aid, row in known.items():
                    if aid in fresh:
                        continue
                    if self.authoritative and self._end(row) > now:
                        row = {**row, "ends": stamp}
                    if self._end(row) > now - KEEP_S:
                        merged[aid] = row
                merged.update(fresh)
                changed = merged != self.rows
                self.rows = merged
                self.read_at = now
                self.error = None
                if changed:
                    self._save_disk()
            except Exception as exc:  # noqa: BLE001  a source being down is not an error of ours
                self.error = str(exc)[:200]
                self.read_at = _now() - self.ttl + 60  # try again in a minute
            finally:
                self.loading = False

    def get(self, since: float) -> dict[str, Any]:
        # The lock is held for a whole read, which can take minutes here: what has
        # been read so far is answered meanwhile.
        if not self.loaded:
            with self.lock:
                self._load_disk()
        if not self.read_at and not self.background:
            self.refresh()
        elif _now() - self.read_at >= self.ttl and not self.loading:
            self.loading = True
            threading.Thread(target=self.refresh, daemon=True).start()
        rows = [r for r in self.rows.values() if r.get("geometry") and self._end(r) >= since]
        return {"source": self.id, "alerts": rows, "read_at": self.read_at, "error": self.error, "loading": self.loading}


SOURCES: dict[str, _Source] = {
    s.id: s
    for s in (
        _Source("br-inmet", _inmet, 180, authoritative=True),
        # IDAP's feed is cached five minutes on their side.
        _Source("br-defesacivil", _defesa_civil, 300),
        _Source("ca-eccc", _eccc, 180, authoritative=True),
        _Source("eu-meteoalarm", _meteoalarm, 300, authoritative=True),
        _Source("world-cap", _world_cap, 600, background=True),
    )
}


def alerts(source: str, since: float | None = None) -> dict[str, Any]:
    src = SOURCES.get(source)
    if src is None:
        raise KeyError(source)
    return src.get(since if since is not None else _now() - DEFAULT_LOOKBACK_S)
