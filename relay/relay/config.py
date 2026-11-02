"""
The relay's configuration: one TOML file, with environment variables on top
for everything secret or deployment-specific, so the file can be committed and
the passwords live in the host's secret store.

    [relay]      retention_hours (36), poll_seconds (120), concurrency (3),
                 max_backoff_seconds (1800), max_files_per_poll (300),
                 max_file_mb (200), recheck_seconds (20: --once, the pause
                 before the second listing that confirms the sizes of files
                 listed without a modification time), log_level
    [api]        host, port, public_base_url (never on a FORBIDDEN_HOSTS
                 host), cors_origins
    [storage]    kind = "local" (path) | "s3" (bucket, endpoint_url, region,
                 access_key_id, secret_access_key), prefix, static_api
    [sources.X]  type = "ftp" | "http_index" | "local" | "nasa_vn" | "cemaden",
                 enabled, and the type's own keys (sources.py)
    [[radars]]   id, source (a [sources.X] name), site (what the source calls
                 the radar), name/lat/lon (defaults for the nine CEMADEN
                 radars), enabled, poll_seconds, and [radars.source_options]
                 to override any source key for that radar alone

Environment, read after the file:

    RELAY_CONFIG                      the file, when --config is not given
    RELAY_<SOURCE>_<KEY>              any key of [sources.<SOURCE>], e.g.
                                      RELAY_CEMADEN_PASSWORD, RELAY_CEMADEN_HOST,
                                      RELAY_CEMADEN_ENABLED=1
    RELAY_FTP_USER, RELAY_FTP_PASSWORD           every ftp source left without
    RELAY_HTTP_USER, RELAY_HTTP_PASSWORD,        and every http_index source
    RELAY_HTTP_TOKEN                             left without
    RELAY_S3_BUCKET, RELAY_S3_ENDPOINT, RELAY_S3_REGION,
    RELAY_S3_KEY_ID, RELAY_S3_SECRET             the bucket
    RELAY_STORAGE_KIND, RELAY_STORAGE_PATH, RELAY_STORAGE_PREFIX,
    RELAY_STATIC_API, RELAY_RETENTION_HOURS,
    RELAY_POLL_SECONDS, RELAY_RECHECK_SECONDS, RELAY_PUBLIC_BASE_URL,
    RELAY_HOST, RELAY_PORT (or PORT), RELAY_LOG_LEVEL

Everything a source or the poller would only trip over at startup (an
unknown cemaden transport, a bad only_dates day, a regex that does not
compile, a public_base_url on the CAPTCHA host) is a ConfigError here.

Any string value written "env:NAME" in the file is read from $NAME instead.
"""
from __future__ import annotations

import copy
import os
import re
import tomllib
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

RADAR_ID_RE = re.compile(r"^[A-Z]{2}-[A-Z0-9]{2,10}$")

# The nine CEMADEN S-band radars, as the app names them (backend/brazil_radar.py).
# "site" is CEMADEN's own name for the radar; "nasa" the GPM Validation Network's.
KNOWN_RADARS: dict[str, dict[str, Any]] = {
    "BR-ALM": {"name": "Almenara (MG)", "lat": -16.1862, "lon": -40.6507, "site": "almenara", "nasa": "AL1"},
    "BR-JAR": {"name": "Jaraguari (MS)", "lat": -20.2592, "lon": -54.4424, "site": "jaraguari", "nasa": "JG1"},
    "BR-MCZ": {"name": "Maceió (AL)", "lat": -9.5409, "lon": -35.7587, "site": "maceio", "nasa": "MC1"},
    "BR-NAT": {"name": "Natal (RN)", "lat": -5.8969, "lon": -35.2479, "site": "natal", "nasa": "NT1"},
    "BR-PTL": {"name": "Petrolina (PE)", "lat": -9.3567, "lon": -40.5613, "site": "petrolina", "nasa": "PE1"},
    "BR-SSA": {"name": "Salvador (BA)", "lat": -12.9025, "lon": -38.3267, "site": "salvador", "nasa": "SV1"},
    "BR-STE": {"name": "Santa Teresa (ES)", "lat": -19.9698, "lon": -40.5484, "site": "santa_teresa", "nasa": "ST1"},
    "BR-SFR": {"name": "São Francisco (MG)", "lat": -15.9932, "lon": -44.6726, "site": "sao_francisco", "nasa": "SF1"},
    "BR-TMA": {"name": "Três Marias (MG)", "lat": -18.1896, "lon": -45.4328, "site": "tres_marias", "nasa": "TM1"},
}

SOURCE_TYPES = ("ftp", "http_index", "local", "nasa_vn", "cemaden")
CEMADEN_TRANSPORTS = ("ftp", "http_index", "local")
NAME_PARSERS = ("any", "rainbow", "nasa_vn")       # sources.py's _PARSERS

# CEMADEN's public Interactive Map puts every download behind a CAPTCHA: its
# way of saying that no program downloads from it. The relay never sends a
# request there, whatever the configuration says; access for the relay is
# whatever CEMADEN grants on purpose (an FTP account, an HTTP URL).
FORBIDDEN_HOSTS = ("mapainterativo.cemaden.gov.br",)


class ConfigError(ValueError):
    pass


def forbidden_url(url: str) -> bool:
    """True for any URL on a host the relay must never request."""
    try:
        host = (urlsplit(str(url)).hostname or "").lower().rstrip(".")
    except ValueError:
        return False
    return any(host == h or host.endswith("." + h) for h in FORBIDDEN_HOSTS)


def forbidden_host(host: str) -> bool:
    h = str(host or "").lower().rstrip(".")
    if "://" in h:
        return forbidden_url(h)
    h = h.split("/")[0].split(":")[0]
    return any(h == f or h.endswith("." + f) for f in FORBIDDEN_HOSTS)


def forbidden_any(value: str) -> bool:
    """A URL with or without its scheme ("https://h/x", "//h/x", "h/x"): True
    when any reading of it lands on a forbidden host."""
    return forbidden_url(value) or forbidden_host(value)


@dataclass
class RadarConf:
    id: str
    name: str
    lat: float
    lon: float
    source: str                     # a [sources.X] name; "" = no source (listed, never polled)
    site: str                       # the source's name for the radar
    enabled: bool = True
    poll_seconds: Optional[float] = None
    options: dict[str, Any] = field(default_factory=dict)   # the source table, merged with overrides


@dataclass
class ApiConf:
    host: str = "0.0.0.0"
    port: int = 8080
    public_base_url: str = ""
    cors_origins: list[str] = field(default_factory=lambda: ["*"])


@dataclass
class Config:
    retention_hours: float = 36.0
    poll_seconds: float = 120.0
    concurrency: int = 3
    max_backoff_seconds: float = 1800.0
    max_files_per_poll: int = 300
    max_file_mb: float = 200.0
    recheck_seconds: float = 20.0
    log_level: str = "INFO"
    api: ApiConf = field(default_factory=ApiConf)
    storage: dict[str, Any] = field(default_factory=lambda: {"kind": "local", "path": "./data"})
    sources: dict[str, dict[str, Any]] = field(default_factory=dict)
    radars: list[RadarConf] = field(default_factory=list)
    base_dir: Path = field(default_factory=Path.cwd)
    path: Optional[Path] = None

    @property
    def retention_seconds(self) -> float:
        return float(self.retention_hours) * 3600.0

    def radar(self, rid: str) -> Optional[RadarConf]:
        for r in self.radars:
            if r.id == rid:
                return r
        return None

    def resolve_path(self, p: str) -> Path:
        """Relative paths in the file are relative to the file itself."""
        q = Path(os.path.expanduser(str(p)))
        return q if q.is_absolute() else (self.base_dir / q).resolve()

    def only(self, ids: list[str]) -> None:
        """Poll only these radars (the others stay listed, idle)."""
        want = {i.upper() for i in ids}
        unknown = want - {r.id for r in self.radars}
        if unknown:
            raise ConfigError(f"--radar: not in the configuration: {', '.join(sorted(unknown))}")
        for r in self.radars:
            if r.id not in want:
                r.enabled = False


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
def _env_ref(v: Any) -> Any:
    if isinstance(v, str) and v.startswith("env:"):
        return os.environ.get(v[4:].strip(), "")
    if isinstance(v, dict):
        return {k: _env_ref(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_env_ref(x) for x in v]
    return v


def _coerce(raw: str, like: Any) -> Any:
    """An environment string, read as the type the file had for that key."""
    if isinstance(like, bool):
        return raw.strip().lower() in ("1", "true", "yes", "on")
    if isinstance(like, int):
        return int(raw)
    if isinstance(like, float):
        return float(raw)
    if isinstance(like, list):
        return [s.strip() for s in raw.split(",") if s.strip()]
    low = raw.strip().lower()
    if low in ("true", "false"):
        return low == "true"
    return raw


def _env_name(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "_", s.upper())


def _source_env(name: str, table: dict[str, Any]) -> dict[str, Any]:
    out = dict(table)
    pre = f"RELAY_{_env_name(name)}_"
    for k, v in os.environ.items():
        if k.upper().startswith(pre) and len(k) > len(pre):
            key = k[len(pre):].lower()
            out[key] = _coerce(v, table.get(key, ""))
    kind = str(out.get("type", ""))
    transport = str(out.get("transport", kind)) if kind == "cemaden" else kind
    generic = {"ftp": ("FTP", ("user", "password")),
               "http_index": ("HTTP", ("user", "password", "token"))}.get(transport)
    if generic:
        tag, keys = generic
        for key in keys:
            ev = os.environ.get(f"RELAY_{tag}_{key.upper()}")
            if ev and not out.get(key):
                out[key] = ev
    return out


def _check_source(name: str, t: dict[str, Any]) -> None:
    """Validate one source table (in place: only_dates given as one
    comma-separated string, from the environment, becomes a list)."""
    kind = t.get("type")
    if kind not in SOURCE_TYPES:
        raise ConfigError(f"[sources.{name}] type must be one of {', '.join(SOURCE_TYPES)} (got {kind!r})")
    for key in ("url", "base_url", "url_template"):
        if t.get(key) and forbidden_any(str(t[key])):
            raise ConfigError(f"[sources.{name}] {key}: the relay never requests {FORBIDDEN_HOSTS[0]} "
                              "(the public map's downloads are behind a CAPTCHA; use the access CEMADEN grants)")
    if t.get("host") and forbidden_host(str(t["host"])):
        raise ConfigError(f"[sources.{name}] host: the relay never connects to {FORBIDDEN_HOSTS[0]}")
    if kind == "cemaden":
        transport = str(t.get("transport", "ftp"))
        if transport not in CEMADEN_TRANSPORTS:
            raise ConfigError(f"[sources.{name}] transport must be one of {', '.join(CEMADEN_TRANSPORTS)} "
                              f"(got {transport!r})")
    if t.get("only_dates"):
        days = t["only_dates"]
        if isinstance(days, str):
            days = [s.strip() for s in days.split(",") if s.strip()]
        if not isinstance(days, list):
            raise ConfigError(f"[sources.{name}] only_dates must be a list of \"YYYY-MM-DD\" days")
        for d in days:
            try:
                date.fromisoformat(str(d))
            except ValueError:
                raise ConfigError(f"[sources.{name}] only_dates: {d!r} is not a \"YYYY-MM-DD\" day") from None
        t["only_dates"] = [str(d) for d in days]
    for key in ("filename_regex", "link_regex"):
        if t.get(key):
            try:
                re.compile(str(t[key]))
            except re.error as e:
                raise ConfigError(f"[sources.{name}] {key}: {e}") from None
    if "names" in t and str(t["names"]) not in NAME_PARSERS:
        raise ConfigError(f"[sources.{name}] names must be one of {', '.join(NAME_PARSERS)} (got {t['names']!r})")


def from_dict(data: dict[str, Any], base_dir: Optional[Path] = None, path: Optional[Path] = None) -> Config:
    data = _env_ref(copy.deepcopy(data))
    cfg = Config(base_dir=Path(base_dir or Path.cwd()).resolve(), path=path)
    rel = data.get("relay", {}) or {}
    for key in ("retention_hours", "poll_seconds", "max_backoff_seconds", "max_file_mb", "recheck_seconds"):
        if key in rel:
            setattr(cfg, key, float(rel[key]))
    for key in ("concurrency", "max_files_per_poll"):
        if key in rel:
            setattr(cfg, key, int(rel[key]))
    if "log_level" in rel:
        cfg.log_level = str(rel["log_level"]).upper()
    api = data.get("api", {}) or {}
    cfg.api = ApiConf(host=str(api.get("host", "0.0.0.0")), port=int(api.get("port", 8080)),
                      public_base_url=str(api.get("public_base_url", "") or ""),
                      cors_origins=list(api.get("cors_origins", ["*"]) or ["*"]))
    st = dict(data.get("storage", {}) or {})
    st.setdefault("kind", "local")
    st.setdefault("path", "./data")
    st.setdefault("prefix", "")
    st.setdefault("static_api", False)
    cfg.storage = st

    # Environment over the file.
    env = os.environ.get
    if env("RELAY_RETENTION_HOURS"):
        cfg.retention_hours = float(env("RELAY_RETENTION_HOURS"))
    if env("RELAY_POLL_SECONDS"):
        cfg.poll_seconds = float(env("RELAY_POLL_SECONDS"))
    if env("RELAY_RECHECK_SECONDS"):
        cfg.recheck_seconds = float(env("RELAY_RECHECK_SECONDS"))
    if env("RELAY_LOG_LEVEL"):
        cfg.log_level = env("RELAY_LOG_LEVEL").upper()
    if env("RELAY_HOST"):
        cfg.api.host = env("RELAY_HOST")
    port = env("RELAY_PORT") or env("PORT")
    if port:
        cfg.api.port = int(port)
    if env("RELAY_PUBLIC_BASE_URL"):
        cfg.api.public_base_url = env("RELAY_PUBLIC_BASE_URL")
    for ev, key in (("RELAY_STORAGE_KIND", "kind"), ("RELAY_STORAGE_PATH", "path"),
                    ("RELAY_STORAGE_PREFIX", "prefix"), ("RELAY_S3_BUCKET", "bucket"),
                    ("RELAY_S3_ENDPOINT", "endpoint_url"), ("RELAY_S3_REGION", "region"),
                    ("RELAY_S3_KEY_ID", "access_key_id"), ("RELAY_S3_SECRET", "secret_access_key")):
        if env(ev):
            cfg.storage[key] = env(ev)
    if env("RELAY_STATIC_API"):
        cfg.storage["static_api"] = _coerce(env("RELAY_STATIC_API"), False)

    if cfg.retention_hours <= 0:
        raise ConfigError("[relay] retention_hours must be above 0")
    if cfg.poll_seconds < 5:
        raise ConfigError("[relay] poll_seconds must be at least 5")
    if cfg.recheck_seconds < 0:
        raise ConfigError("[relay] recheck_seconds must be 0 or more")
    cfg.concurrency = max(1, cfg.concurrency)
    # /v1/files redirects there: the same guard as every source URL, for the
    # file and for RELAY_PUBLIC_BASE_URL alike.
    if cfg.api.public_base_url and forbidden_any(cfg.api.public_base_url):
        raise ConfigError(f"[api] public_base_url: the relay never sends anyone to {FORBIDDEN_HOSTS[0]}")
    if cfg.storage["kind"] not in ("local", "s3"):
        raise ConfigError(f"[storage] kind must be 'local' or 's3' (got {cfg.storage['kind']!r})")
    prefix = str(cfg.storage.get("prefix") or "")
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    if prefix.startswith("/") or ".." in prefix:
        raise ConfigError("[storage] prefix must be relative, like 'v1/files/'")
    cfg.storage["prefix"] = prefix
    if cfg.storage.get("static_api"):
        # On a disk "v1/radars" would have to be a file and a folder at once;
        # a bucket's keys are flat. Locally, the API itself serves the JSON.
        if cfg.storage["kind"] != "s3":
            raise ConfigError("[storage] static_api is for a bucket (kind = \"s3\")")
        if prefix != "v1/files/":
            raise ConfigError("[storage] static_api needs prefix = \"v1/files/\", so the bucket's own paths are "
                              "the API's /v1/files/{id}/{stamp}/{name}")

    for name, table in (data.get("sources", {}) or {}).items():
        if not isinstance(table, dict):
            raise ConfigError(f"[sources.{name}] must be a table")
        t = _source_env(name, table)
        t.setdefault("enabled", True)
        _check_source(name, t)
        cfg.sources[name] = t

    seen: set[str] = set()
    for r in data.get("radars", []) or []:
        rid = str(r.get("id", "")).upper()
        if not RADAR_ID_RE.match(rid):
            raise ConfigError(f"[[radars]] id {rid!r}: ids look like BR-MCZ")
        if rid in seen:
            raise ConfigError(f"[[radars]] {rid} is listed twice")
        seen.add(rid)
        known = KNOWN_RADARS.get(rid, {})
        src = str(r.get("source", "") or "")
        if src and src not in cfg.sources:
            raise ConfigError(f"[[radars]] {rid}: source {src!r} has no [sources.{src}] table")
        opts = dict(cfg.sources.get(src, {}))
        overrides = r.get("source_options", {}) or {}
        opts.update(overrides)
        if src:
            _check_source(f"{src} (for {rid})", opts)
        site = str(r.get("site") or (known.get("nasa") if opts.get("type") == "nasa_vn" else known.get("site")) or rid)
        if "name" not in r and not known:
            raise ConfigError(f"[[radars]] {rid}: give name, lat and lon (only the CEMADEN radars have defaults)")
        cfg.radars.append(RadarConf(
            id=rid, name=str(r.get("name", known.get("name", rid))),
            lat=float(r.get("lat", known.get("lat", 0.0))), lon=float(r.get("lon", known.get("lon", 0.0))),
            source=src, site=site, enabled=bool(r.get("enabled", True)),
            poll_seconds=float(r["poll_seconds"]) if "poll_seconds" in r else None, options=opts))
    return cfg


def load_config(path: Optional[str | Path] = None) -> Config:
    """The configuration from a TOML file (--config, else $RELAY_CONFIG, else
    ./config.toml); with no file at all, the nine CEMADEN radars and no source
    (the API answers, nothing is polled)."""
    p = path or os.environ.get("RELAY_CONFIG") or "config.toml"
    p = Path(p)
    if not p.exists():
        if path or os.environ.get("RELAY_CONFIG"):
            raise ConfigError(f"no configuration file at {p}")
        return from_dict({"radars": [{"id": rid} for rid in KNOWN_RADARS]})
    with open(p, "rb") as f:
        data = tomllib.load(f)
    return from_dict(data, base_dir=p.resolve().parent, path=p.resolve())
