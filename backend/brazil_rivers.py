"""
River stations in Brazil, from the two public services that publish them.

  * SGB's SACE (sace.sgb.gov.br), the hydrological alert systems of the
    Geological Survey of Brazil: some 290 stations on the rivers that flood
    towns -- Guaíba, Taquari, Caí, Uruguai, Doce, Muriaé, Acre, Amazonas,
    Madeira and the rest. Each has the levels SGB set with the towns it warns
    (cota de atenção, de alerta, de inundação), and its colour on SACE's map
    is the level the river is in now. A station's report page carries its
    last 30 days of level and rain and those levels.
  * ANA's telemetry (telemetriaws1.ana.gov.br, the public Hidro-Telemetria web
    service): about 4,900 river stations of the national network (RHN), the
    power sector, the semi-arid reservoirs and the rest. Level (cm), flow
    (m³/s) and rain (mm), every 15 min to an hour; no alert levels, those are
    SGB's.

A station in both is one station: its level and alert levels come from SACE
(the levels are measured against SACE's own series), its flow from ANA.

Times in both are Brasília time (UTC-3), Acre's and Amazonas's stations too.
"""
from __future__ import annotations

import calendar
import json
import re
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from pathlib import Path
from typing import Any, Optional

import requests

import rivers  # the rain at a point, and its cache, are shared with the NWS side

SACE = "https://sace.sgb.gov.br"
ANA = "http://telemetriaws1.ana.gov.br/ServiceANA.asmx"
BRT = 3 * 3600  # Brasília time is UTC-3 all year (no daylight saving since 2019)
MAP_TTL = 10 * 60
REPORT_TTL = 10 * 60
ANA_DATA_TTL = 10 * 60
ANA_LIST_TTL = 24 * 3600
HISTORY_DAYS = 30
_TIMEOUT = 40
CACHE = Path(tempfile.gettempdir()) / "weatherts-rivers"

_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "WeatherTS/1.0 (desktop weather app)"

_LOCK = threading.Lock()
_MAP: Optional[tuple[float, list[dict]]] = None
_ANA_LIST: Optional[tuple[float, dict[str, dict]]] = None
_REPORTS: dict[str, tuple[float, Optional[dict]]] = {}
_ANA_DATA: dict[str, tuple[float, dict]] = {}
_POOL = ThreadPoolExecutor(max_workers=6, thread_name_prefix="br-rivers")

# SGB's levels, in the categories the hydrograph draws: atenção in the action
# yellow, alerta in the minor orange, inundação in the red. SGB has no fourth
# level; "severa"/"emergência" are here for a system that adds one.
_LEVEL_KEYS = (("aten", "action"), ("alerta", "minor"), ("severa", "major"), ("emerg", "major"), ("inunda", "moderate"))


# The app is in English: SGB's level names, its situation text and ANA's
# network names are put into it.
_LEVEL_EN = {"action": "Attention", "minor": "Alert", "moderate": "Flood", "major": "Severe flood"}

_ORIGINS_EN = {
    "rhn": "National network (RHN)",
    "setor elétrico": "Power sector",
    "açudes semiárido": "Semi-arid reservoirs",
    "cotaonline": "CotaOnline",
    "setores regulados": "Regulated sectors",
    "poços": "Wells",
    "inpe/sivam(desativadas)": "INPE/SIVAM (retired)",
}


def _origin_en(origin: str) -> str:
    return _ORIGINS_EN.get(origin.strip().lower(), origin)


def _situation_en(text: str) -> str:
    """SGB's "Situação" ("Cota de Atenção", "Normal") in English."""
    low = text.strip().lower()
    if not low:
        return "No situation given"
    if low.startswith("normal"):
        return "Normal"
    k = _level_key(low)
    if k:
        return f"{_LEVEL_EN[k]} level"
    if "dados" in low:
        return "No recent data"
    return text.strip()


def _level_key(label: str) -> Optional[str]:
    low = label.lower()
    for word, key in _LEVEL_KEYS:
        if word in low:
            return key
    return None


def _status_of_color(color: str) -> str:
    """The category of a SACE map colour. SACE draws each level in one of two
    shades (#ffff00 and #ffff33 both atenção), so this reads the hue."""
    try:
        r, g, b = (int(color[i:i + 2], 16) for i in (1, 3, 5))
    except ValueError:
        return "obs_not_current"
    if r == g == b:
        return "obs_not_current"  # grey: no recent data
    if g > 200 and r < 120:
        return "no_flooding"
    if r > 200 and g > 200:
        return "action"
    if r > 200 and g > 80:
        return "minor"
    if r > 150:
        return "moderate"
    return "obs_not_current"


_SMALL = {"de", "da", "do", "das", "dos", "e", "a", "o", "em", "na", "no"}
# Acronyms in station names: power plants (UHE, PCH, CGH), roads (BR), works.
_UPPER = {"uhe", "pch", "cgh", "ute", "br", "eta", "ete", "sp", "rj", "mg", "rs", "sc", "pr"}


def _title(s: str) -> str:
    """"RIO DAS ANTAS" -> "Rio das Antas"; mixed-case names stay as they are."""
    s = " ".join(s.split())
    if not s or s != s.upper():
        return s
    # Words between spaces, slashes and hyphens: "MUÇUM/ENCANTADO" -> "Muçum/Encantado".
    parts = re.split(r"([ /-])", s.lower())
    out = []
    for i, w in enumerate(parts):
        if i % 2 or not w:
            out.append(w)  # a separator
        elif i and w in _SMALL:
            out.append(w)
        elif w in _UPPER or re.fullmatch(r"[ivx]+", w) or re.fullmatch(r"[a-z]?\d+[a-z]?", w):
            out.append(w.upper())  # roman numerals, "C6", "UHE 2"
        else:
            lead = len(w) - len(w.lstrip("(\"'"))  # "(base" -> "(Base"
            out.append(w[:lead] + w[lead:lead + 1].upper() + w[lead + 1:])
    return "".join(out)


def _brt(stamp: str) -> Optional[int]:
    """Unix seconds of a "2026-10-03 23:00:00" Brasília time."""
    try:
        return calendar.timegm(time.strptime(stamp.strip()[:19], "%Y-%m-%d %H:%M:%S")) + BRT
    except ValueError:
        return None


def _num(s: Any) -> Optional[float]:
    try:
        v = float(str(s).strip())
    except (TypeError, ValueError):
        return None
    return v if v == v else None


# --- SACE ------------------------------------------------------------------

_MAP_SRC = re.compile(r'relatorio\.php\?apenas_grafico=sim&bacia=([a-z_]+)&pm=(\d+)&s=(\d*)&sr=(\d*)')
_MAP_AT = re.compile(r'L\.circleMarker\(\[(-?[\d.]+),\s*(-?[\d.]+)\]')
_MAP_COLOR = re.compile(r'fillColor:\s*"(#[0-9A-Fa-f]{6})"')
_MAP_TIP = re.compile(r'bindTooltip\("([^"]*)"')

# The basins' names as SACE's menu writes them.
BASINS = {
    "acre": "Acre", "amazonas": "Amazonas", "araguaia": "Araguaia", "branco": "Branco", "cai": "Caí",
    "doce": "Doce", "guaiba": "Guaíba", "itapecuru": "Itapecuru", "madeira": "Madeira", "mundau": "Mundaú",
    "muriae": "Muriaé", "paraguai": "Paraguai", "parnaiba": "Parnaíba", "pomba": "Pomba",
    "saofrancisco": "São Francisco", "taquari": "Taquari", "uruguai": "Uruguai", "velhas": "Velhas",
    "xingu": "Xingu",
}


def _parse_tip(tip: str) -> tuple[Optional[str], str]:
    """"87450004 - Cais Mauá C6" or "ESP - 13572000 - ESPALHA" -> code, name.
    Some systems drop the code's trailing zeros ("7715000 - Uruguaiana" is
    ANA's 77150000), so short codes are padded on the right."""
    parts = [p.strip() for p in tip.split(" - ") if p.strip().upper() != "WEB"]
    for i, p in enumerate(parts):
        if re.fullmatch(r"\d{6,8}", p):
            return p.ljust(8, "0"), " - ".join(parts[i + 1:]) or tip
    # The code inside the name: "Bandeirantes (25700000)", "Gameleira-46035000".
    joined = " - ".join(parts)
    inner = re.search(r"\(?\b(\d{8})\b\)?", joined)
    if inner:
        name = (joined[:inner.start()] + joined[inner.end():]).strip(" -")
        name = re.sub(r"^[A-Za-z]{2,6} - ", "", name)
        return inner.group(1), name or joined
    # No code: "MAO - Manaus", "PMurt - PORTO MURTINHO"; the short tag goes.
    if len(parts) > 1 and re.fullmatch(r"[A-Za-z]{2,6}", parts[0]):
        return None, " - ".join(parts[1:])
    return None, joined


_RANK = {"major": 4, "moderate": 3, "minor": 2, "action": 1}


def _sace_map() -> list[dict]:
    """Every station on SACE's map: where, its report, and the colour of the
    level it is in now."""
    global _MAP
    with _LOCK:
        if _MAP and time.time() - _MAP[0] < MAP_TTL:
            return _MAP[1]
    r = _SESSION.get(f"{SACE}/estacoes_mapa.php", params={"bacia": "brasil"}, timeout=_TIMEOUT)
    r.raise_for_status()
    html = r.content.decode("utf-8", "replace")
    by_code: dict[str, dict] = {}
    for chunk in html.split("const popupContent")[1:]:
        src, at, color, tip = _MAP_SRC.search(chunk), _MAP_AT.search(chunk), _MAP_COLOR.search(chunk), _MAP_TIP.search(chunk)
        if not (src and at and color and tip):
            continue
        bacia, pm, s, sr = src.groups()
        code, name = _parse_tip(tip.group(1))
        st = {
            "code": code or f"SGB-{bacia}-{pm}",
            "name": _title(name),
            "bacia": bacia,
            "report": {"bacia": bacia, "pm": pm, "s": s, "sr": sr},
            "lat": round(float(at.group(1)), 5),
            "lon": round(float(at.group(2)), 5),
            "status": _status_of_color(color.group(1)),
        }
        # A station on two basins' systems (Muçum is on the Taquari's and the
        # Guaíba's) is one station: keep the entry in the worse level, so a
        # stale copy never hides a flood.
        prev = by_code.get(st["code"])
        if prev is None or _RANK.get(st["status"], 0) > _RANK.get(prev["status"], 0) or (
            prev["status"] == "obs_not_current" and st["status"] != "obs_not_current"
        ):
            by_code[st["code"]] = st
    out = list(by_code.values())
    if not out:
        raise RuntimeError("SACE's station map came back without stations.")
    with _LOCK:
        _MAP = (time.time(), out)
    return out


_REP_LABELS = re.compile(r"const labels = \[(.*?)\];", re.S)
_REP_COTA = re.compile(r"const valoresCota = \[(.*?)\];", re.S)
_REP_CHUVA = re.compile(r"const valoresChuva = \[(.*?)\];", re.S)
_REP_LEVEL = re.compile(r"label: '([^']+)',\s*data: Array\.from\(\{ length: labels\.length \}, \(\) => (-?[\d.]+)\)")
_REP_SIT = re.compile(r"Situa[^:]*:\s*<span[^>]*></span>([^<]*)")
_REP_NOW = re.compile(r"<h2[^>]*>\s*([\d.,]+)\s*Cota")


def _report(st: dict) -> Optional[dict]:
    """A SACE station's report: the alert levels, the situation, and the last
    30 days of level and rain. None when SACE has too little data to draw one."""
    key = f"{st['bacia']}:{st['report']['pm']}"
    with _LOCK:
        hit = _REPORTS.get(key)
        if hit and time.time() - hit[0] < REPORT_TTL:
            return hit[1]
    p = st["report"]
    r = _SESSION.get(f"{SACE}/relatorio.php", params={
        "apenas_grafico": "sim", "bacia": p["bacia"], "pm": p["pm"], "s": p["s"], "sr": p["sr"],
    }, timeout=_TIMEOUT)
    r.raise_for_status()
    page = r.content.decode("utf-8", "replace")
    result: Optional[dict] = None
    labels_m, cota_m = _REP_LABELS.search(page), _REP_COTA.search(page)
    if labels_m and cota_m:
        stamps = [s.strip().strip("'\"") for s in labels_m.group(1).split(",")]
        cotas = [_num(v) for v in cota_m.group(1).split(",")]
        chuva_m = _REP_CHUVA.search(page)
        chuvas = [_num(v) for v in chuva_m.group(1).split(",")] if chuva_m else []
        since = time.time() - HISTORY_DAYS * 86400
        points, hourly_rain = [], {}
        for i, stamp in enumerate(stamps):
            t = _brt(stamp)
            if t is None or t < since:
                continue
            if i < len(cotas) and cotas[i] is not None:
                points.append([t, cotas[i]])
            # Rain per reading (15 min on most systems), summed by the hour.
            if i < len(chuvas) and chuvas[i] is not None and 0 <= chuvas[i] < 500:
                hour = -(-t // 3600) * 3600
                hourly_rain[hour] = hourly_rain.get(hour, 0.0) + chuvas[i]
        points.sort()
        cut = points[-1][0] - 2 * 86400 if points else 0
        level: list[list] = []
        for p in points:
            if p[0] < cut and level and p[0] - level[-1][0] < 3600:
                continue
            level.append(p)
        rain = [[t, round(v, 1)] for t, v in sorted(hourly_rain.items())]
        levels: dict[str, float] = {}
        names: dict[str, str] = {}
        for label, value in _REP_LEVEL.findall(page):
            k = _level_key(label)
            v = _num(value)
            if k and v is not None:
                levels[k] = v
                names[k] = _LEVEL_EN[k]
        sit = _REP_SIT.search(page)
        now = _REP_NOW.search(page)
        now_v = _num(now.group(1).replace(".", "").replace(",", ".")) if now else None
        result = {
            "level": level,
            "rain": rain,
            "levels": levels,
            "names": names,
            "situation": _situation_en(sit.group(1)) if sit else None,
            "now": now_v if now_v is not None else (level[-1][1] if level else None),
            "nowTime": level[-1][0] if level else None,
        }
    with _LOCK:
        _REPORTS[key] = (time.time(), result)
        while len(_REPORTS) > 400:
            _REPORTS.pop(next(iter(_REPORTS)))
    return result


# --- ANA -------------------------------------------------------------------

_ANA_ROW = re.compile(r"<Table [^>]*>(.*?)</Table>", re.S)
_ANA_FIELD = re.compile(r"<([A-Za-z-]+)>([^<]*)</\1>")


def _ana_text(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def _unescape(s: str) -> str:
    return s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'")


def _ana_list() -> dict[str, dict]:
    """ANA's telemetry river stations by code. The list is 4 MB of XML and
    changes rarely, so it is kept on disk for a day."""
    global _ANA_LIST
    with _LOCK:
        if _ANA_LIST and time.time() - _ANA_LIST[0] < ANA_LIST_TTL:
            return _ANA_LIST[1]
    # Versioned: a change to how names are written takes a fresh list.
    path = CACHE / "ana_stations_v2.json"
    try:
        if time.time() - path.stat().st_mtime < ANA_LIST_TTL:
            stations = json.loads(path.read_text("utf-8"))
            with _LOCK:
                _ANA_LIST = (path.stat().st_mtime, stations)
            return stations
    except (OSError, ValueError):
        pass
    try:
        r = _SESSION.get(f"{ANA}/ListaEstacoesTelemetricas", params={"statusEstacoes": "0", "origem": ""}, timeout=90)
        r.raise_for_status()
        text = _ana_text(r.content)
    except Exception:
        # A stale list beats none: ANA's service has bad hours.
        try:
            stations = json.loads(path.read_text("utf-8"))
            with _LOCK:
                _ANA_LIST = (time.time() - ANA_LIST_TTL + 3600, stations)
            return stations
        except (OSError, ValueError):
            raise
    stations: dict[str, dict] = {}
    for row in _ANA_ROW.findall(text):
        f = {k: _unescape(v.strip()) for k, v in _ANA_FIELD.findall(row)}
        code = f.get("CodEstacao", "")
        lat, lon = _num(f.get("Latitude")), _num(f.get("Longitude"))
        # River (fluviometric) stations' codes start with their basin, 1-9;
        # rain gauges' with 0.
        if not code or code[0] == "0" or lat is None or lon is None or (lat == 0 and lon == 0):
            continue
        muni = f.get("Municipio-UF", "")
        town, _, uf = muni.rpartition("-")
        stations[code] = {
            "code": code,
            "name": _title(f.get("NomeEstacao", code)),
            "river": _title(f.get("NomeRio", "")),
            "town": _title(town),
            "uf": uf.strip()[:2],
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "origin": f.get("Origem", ""),
            "operator": re.sub(r"^\d+\s*-\s*", "", f.get("Responsavel", "")).rstrip("."),
        }
    if not stations:
        raise RuntimeError("ANA's station list came back empty.")
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(stations, ensure_ascii=False), "utf-8")
    except OSError:
        pass
    with _LOCK:
        _ANA_LIST = (time.time(), stations)
    return stations


_DATA_ROW = re.compile(r"<DadosHidrometereologicos [^>]*>(.*?)</DadosHidrometereologicos>", re.S)


def _ana_data(code: str) -> dict:
    """A telemetry station's last 30 days: [[unix, level cm, flow m³/s]] and
    [[unix, rain mm]], oldest first."""
    with _LOCK:
        hit = _ANA_DATA.get(code)
        if hit and time.time() - hit[0] < ANA_DATA_TTL:
            return hit[1]
    now_brt = time.time() - BRT
    params = {
        "codEstacao": code,
        "dataInicio": time.strftime("%d/%m/%Y", time.gmtime(now_brt - HISTORY_DAYS * 86400)),
        "dataFim": time.strftime("%d/%m/%Y", time.gmtime(now_brt + 86400)),
    }
    last: Optional[Exception] = None
    text = ""
    # A station's first request of the day can take 20 s while the service
    # gathers it, then a second; the service drops the work when the client
    # gives up, so wait it out rather than retry early.
    for attempt in range(2):
        try:
            r = _SESSION.get(f"{ANA}/DadosHidrometeorologicos", params=params, timeout=(10, 50))
            r.raise_for_status()
            text = _ana_text(r.content)
            break
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1)
    else:
        raise RuntimeError(f"ANA's telemetry service did not answer for station {code}: {last}")
    rows = []
    hourly_rain: dict[int, float] = {}
    for row in _DATA_ROW.findall(text):
        f = dict(_ANA_FIELD.findall(row))
        t = _brt(f.get("DataHora", ""))
        if t is None:
            continue
        level, flow, mm = _num(f.get("Nivel")), _num(f.get("Vazao")), _num(f.get("Chuva"))
        if level is not None or flow is not None:
            rows.append([t, level, flow])
        # Each reading's rain is the rain since the one before (15 min, 5 min):
        # summed by the hour that ends at or after it.
        if mm is not None and 0 <= mm < 500:
            hour = -(-t // 3600) * 3600
            hourly_rain[hour] = hourly_rain.get(hour, 0.0) + mm
    rows.sort(key=lambda p: p[0])
    # Some stations report every 5 min; past the last two days one point an
    # hour draws the same line.
    cut = rows[-1][0] - 2 * 86400 if rows else 0
    series: list[list] = []
    for p in rows:
        if p[0] < cut and series and p[0] - series[-1][0] < 3600:
            continue
        series.append(p)
    rain = [[t, round(v, 1)] for t, v in sorted(hourly_rain.items())]
    result = {"series": series, "rain": rain}
    with _LOCK:
        _ANA_DATA[code] = (time.time(), result)
        while len(_ANA_DATA) > 200:
            _ANA_DATA.pop(next(iter(_ANA_DATA)))
    return result


# --- the map's list and a station's hydrograph -------------------------------

def _sace_by_code() -> dict[str, dict]:
    return {s["code"]: s for s in _sace_map()}


_MATCH: dict[str, Optional[str]] = {}
_MATCH_DEG = 0.025  # ~2.5 km: the same gauge, give or take how each list rounds it


def _ana_code(st: dict, ana: dict[str, dict]) -> Optional[str]:
    """The ANA telemetry station a SACE station is. Most carry ANA's code;
    the Amazon systems' tooltips carry none ("MAO - Manaus") and a few carry
    another network's, so those are matched to the nearest ANA river station."""
    if st["code"] in ana:
        return st["code"]
    if st["code"] in _MATCH:
        return _MATCH[st["code"]]
    best, best_d = None, _MATCH_DEG ** 2
    for code, a in ana.items():
        dy, dx = a["lat"] - st["lat"], a["lon"] - st["lon"]
        if abs(dy) < _MATCH_DEG and abs(dx) < _MATCH_DEG and dx * dx + dy * dy < best_d:
            best, best_d = code, dx * dx + dy * dy
    _MATCH[st["code"]] = best
    return best


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _sace_stations(ana: dict[str, dict]) -> list[dict]:
    """SACE's stations, one per gauge, each with the ANA station it is ("ana").
    A gauge on two basins' systems under two tags (Rio Branco is "13600002" on
    the Acre's and "RBR" on the Amazonas's; Vacaria is on three) is one gauge:
    the entry in the worse level stays, and the one with a code on a tie."""
    out: list[dict] = []
    for s in _sace_map():
        m = _ana_code(s, ana)
        s = {**s, "ana": m}
        dup = next((i for i, o in enumerate(out) if (m and o["ana"] == m) or (
            _norm(o["name"]) == _norm(s["name"]) and abs(o["lat"] - s["lat"]) < 0.05 and abs(o["lon"] - s["lon"]) < 0.05
        )), None)
        if dup is None:
            out.append(s)
            continue
        o = out[dup]
        worse = _RANK.get(s["status"], 0) - _RANK.get(o["status"], 0)
        if worse > 0 or (worse == 0 and o["code"].startswith("SGB-") and not s["code"].startswith("SGB-")) or (
            o["status"] == "obs_not_current" and s["status"] != "obs_not_current"
        ):
            out[dup] = s
    return out


def _sace_for(code: str, ana: dict[str, dict]) -> Optional[dict]:
    """The SACE station for a code: its own, or the ANA station it is."""
    merged = _sace_stations(ana)
    low = code.lower()
    return next((s for s in merged if s["code"].lower() == low), None) or next(
        (s for s in merged if s["ana"] == code), None
    ) or next((s for s in _sace_map() if s["code"].lower() == low), None)


def stations() -> dict:
    """Every Brazilian river station for the map, in the shape of the NWS
    gauge list: SACE's with their alert colour (and level and alert levels for
    the ones above normal), then ANA's telemetry stations SACE does not have."""
    errors = []
    try:
        ana = _ana_list()
    except Exception as exc:  # noqa: BLE001
        ana = {}
        errors.append(f"ANA telemetry: {exc}")
    try:
        sace = _sace_stations(ana)
    except Exception as exc:  # noqa: BLE001
        sace = []
        errors.append(f"SGB SACE: {exc}")
    if not sace and not ana:
        raise RuntimeError("; ".join(errors) or "No Brazilian river stations.")

    # The stations above normal get their report now, for the list's levels.
    raised = [s for s in sace if s["status"] in ("action", "minor", "moderate", "major")]
    reports = dict(zip((s["code"] for s in raised), _POOL.map(_safe_report, raised)))

    out = []
    covered: set[str] = set()
    for s in sace:
        matched = s["ana"]
        if matched:
            covered.add(matched)
        a = ana.get(matched or "") or {}
        rep = reports.get(s["code"])
        lv = (rep or {}).get("levels") or {}
        out.append({
            "lid": f"BR:{s['code']}",
            "net": "sgb",
            "river": a.get("river") or "",
            "place": s["name"],
            "state": a.get("uf") or "",
            "wfo": BASINS.get(s["bacia"], s["bacia"]),
            "lat": s["lat"],
            "lon": s["lon"],
            "status": s["status"],
            "stage": (rep or {}).get("now"),
            "units": "cm",
            "obsTime": _iso((rep or {}).get("nowTime")),
            "action": lv.get("action"),
            "flood": lv.get("minor"),
            "moderate": lv.get("moderate"),
            "major": lv.get("major"),
            "fstatus": None,
            "fstage": None,
            "fTime": None,
        })
    for code, a in ana.items():
        if code in covered:
            continue
        out.append({
            "lid": f"BR:{code}",
            "net": "ana",
            "river": a["river"],
            "place": a["name"],
            "state": a["uf"],
            "wfo": _origin_en(a["origin"]),
            "lat": a["lat"],
            "lon": a["lon"],
            "status": "not_defined",
            "stage": None,
            "units": "cm",
            "obsTime": None,
            "action": None, "flood": None, "moderate": None, "major": None,
            "fstatus": None, "fstage": None, "fTime": None,
        })
    return {"gauges": out, "updated": time.time(), "count": len(out), "sgb": len(sace),
            "ana": len(out) - len(sace), "errors": errors}


def _safe_report(st: dict) -> Optional[dict]:
    try:
        return _report(st)
    except Exception:  # noqa: BLE001 - one station's report failing leaves its colour
        return None


def _iso(t: Optional[int]) -> Optional[str]:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)) if t else None


def hydrograph(code: str) -> dict:
    """One Brazilian station, in the shape of the NWS hydrograph: level (and
    flow where ANA measures it) for 30 days, rain, SGB's alert levels."""
    code = code.strip()
    if code[:3].upper() == "BR:":
        code = code[3:]
    try:
        ana_all = _ana_list()
    except Exception:  # noqa: BLE001
        ana_all = {}
    sace = _sace_for(code, ana_all)
    ana_code = _ana_code(sace, ana_all) if sace else (code if code in ana_all else None)
    ana = ana_all.get(ana_code or "")
    if not sace and not ana:
        raise ValueError(f"No Brazilian river station {code}.")

    rep_f = _POOL.submit(_report, sace) if sace else None
    ana_f = _POOL.submit(_ana_data, ana_code) if ana else None
    rep, data, errors = None, None, []
    if rep_f:
        try:
            rep = rep_f.result()
        except Exception as exc:  # noqa: BLE001
            errors.append(f"SGB SACE: {exc}")
    if ana_f:
        # SACE has the level; ANA adds the flow. When ANA is in one of its slow
        # spells the hydrograph goes without the flow rather than wait, and
        # the request carries on to have it cached for the next look.
        wait = 8 if rep and rep["level"] else None
        try:
            data = ana_f.result(timeout=wait)
        except FutureTimeout:
            errors.append("ANA's flow is still on its way; open the station again in a moment.")
        except Exception as exc:  # noqa: BLE001
            errors.append(str(exc))
    if not rep and not data:
        raise RuntimeError("; ".join(errors) or f"No recent data for station {code}.")

    # Level from SACE when it has a series (its alert levels are on its own
    # gauge datum), else ANA's; flow from ANA either way.
    observed: list[list] = []
    level_src = "sgb" if rep and rep["level"] else "ana"
    if level_src == "sgb":
        observed = [[t, v, None] for t, v in rep["level"]]
        observed += [[t, None, q] for t, _, q in (data or {}).get("series", []) if q is not None]
        observed.sort(key=lambda p: p[0])
    elif data:
        observed = [list(p) for p in data["series"]]
    rain = (rep or {}).get("rain") or (data or {}).get("rain") or []

    levels = (rep or {}).get("levels") or {}
    names = (rep or {}).get("names") or {}
    has_flow = any(p[2] is not None for p in observed)
    a = ana or {}
    name = (sace or {}).get("name") or a.get("name") or code
    river = a.get("river") or ""
    return {
        "lid": f"BR:{code}",
        "net": "sgb" if sace else "ana",
        "name": f"{river} at {name}" if river and river.lower() not in name.lower() else name,
        "code": ana_code or code,
        "usgsId": None,
        "state": a.get("uf") or None,
        "wfo": None,
        "rfc": None,
        "basin": BASINS.get((sace or {}).get("bacia", ""), None),
        "town": a.get("town") or None,
        "operator": a.get("operator") or None,
        "origin": _origin_en(a.get("origin") or "") or None,
        "lat": (sace or a).get("lat"),
        "lon": (sace or a).get("lon"),
        "units": "cm",
        "flowUnits": "m³/s" if has_flow else "",
        "stages": {k: levels.get(k) for k in ("action", "minor", "moderate", "major")},
        "stageNames": names,
        "flows": {"action": None, "minor": None, "moderate": None, "major": None},
        "observed": observed,
        "observedMeta": {"primaryName": "Stage", "primaryUnits": "cm", "secondaryName": "Flow",
                         "secondaryUnits": "m³/s" if has_flow else ""},
        "forecast": [],
        "forecastMeta": {},
        "rain": rain,
        "crests": [],
        "record": None,
        "impacts": [],
        "status": {"observed": (sace or {}).get("status"), "forecast": None},
        "situation": (rep or {}).get("situation"),
        "levelSource": level_src,
        "links": {
            **({"sace": f"{SACE}/relatorio.php?bacia={sace['report']['bacia']}&pm={sace['report']['pm']}"
                        f"&s={sace['report']['s']}&sr={sace['report']['sr']}"} if sace else {}),
            # HidroWeb has no deep link to a station; its series page searches by code.
            "hidroweb": "https://www.snirh.gov.br/hidroweb/serieshistoricas",
        },
        "upstream": None,
        "downstream": None,
        "notes": [],
        "warnings": errors,
    }


def context(code: str) -> dict:
    """What the hydrograph screen shows around a Brazilian station: the other
    stations on its river, upstream first, and the rain past and forecast.
    ANA's codes run downstream along a basin (the first digit is the basin,
    then the sub-basin, then the order), so the stations of one river sorted
    by code are its chain from the source to the mouth."""

    code = code.strip()
    if code[:3].upper() == "BR:":
        code = code[3:]
    try:
        ana_all = _ana_list()
    except Exception:  # noqa: BLE001
        ana_all = {}
    sace = _sace_for(code, ana_all)
    ana_code = _ana_code(sace, ana_all) if sace else (code if code in ana_all else None)
    here = sace or ana_all.get(ana_code or "")
    if not here:
        raise ValueError(f"No Brazilian river station {code}.")
    errors: list[str] = []

    nodes: list[dict] = []
    river = (ana_all.get(ana_code or "") or {}).get("river") or ""
    if river and ana_code:
        by_ana = {s["ana"]: s for s in _sace_stations(ana_all) if s.get("ana")}
        same = sorted(
            (a for a in ana_all.values() if a["river"] == river and a["code"][0] == ana_code[0]),
            key=lambda a: int(a["code"]),
        )
        i = next((k for k, a in enumerate(same) if a["code"] == ana_code), None)
        if i is not None:
            for a in same[max(0, i - 4): i + 5]:
                s = by_ana.get(a["code"])
                rep = None
                if s:
                    with _LOCK:
                        rep = (_REPORTS.get(f"{s['bacia']}:{s['report']['pm']}") or (0, None))[1]
                nodes.append({
                    "lid": f"BR:{s['code'] if s else a['code']}",
                    "river": river,
                    "place": s["name"] if s else a["name"],
                    "status": s["status"] if s else "not_defined",
                    "stage": (rep or {}).get("now"),
                    "units": "cm",
                    "fstatus": None,
                    "self": a["code"] == ana_code,
                })

    rain = None
    try:
        rain = rivers.rain(here["lat"], here["lon"])
    except Exception as exc:  # noqa: BLE001
        errors.append(f"rain: {exc}")
    return {"lid": f"BR:{code}", "chain": nodes, "normals": None, "rain": rain, "errors": errors}
