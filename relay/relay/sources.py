"""
Where the radar files come from. One Source object per radar (so two radars
polled at once never share an FTP connection), built from the radar's
[sources.X] table merged with its own source_options.

    ftp         an FTP (or FTPS) folder: host, port, user, password, tls,
                passive, path (template), timeout
    http_index  an Apache/nginx directory listing: url (template), format
                ("html" | "json", nginx's autoindex_format json), link_regex,
                user/password (basic auth) or token (bearer), headers
    local       a folder on this machine: path (template); for tests and a
                manual drop folder
    nasa_vn     the NASA GPM Validation Network archive,
                https://pmm-gv.gsfc.nasa.gov/pub/gpmarchive/Radar/VN/GPM/
                <SITE>/<YYYY>/<MMDD>/<SITE>_<YYYY>_<MMDD>_<HHMMSS>.cf.gz:
                real CEMADEN volumes (CfRadial, every elevation and moment),
                but only those around a GPM overpass, weeks after the fact.
                For demonstrations of the whole pipeline, not live data.
    cemaden     CEMADEN's Rainbow 5 files over ftp, http_index or local
                (transport = ...): names parsed as <stamp><nn><moment>.vol,
                only the moments the app reads kept (moments = [...]), the
                .vol.h5 copies skipped (formats = ["vol"]). Idle until access
                is configured (a host, or a url).

Path and URL templates are Python format strings with {site} (the source's
name for the radar), {SITE} (the same, upper case), {id} (BR-MCZ) and {date}
(a UTC datetime, so "{date:%Y/%m/%d}"): a template with {date} is listed once
per day of the retention window, day_offset_hours shifting the days for an
operator that files by local time (-3 for Brasilia).

Every source also takes:
    filename_regex   only names this matches (re.search)
    moments          Rainbow names only: keep these moments
    formats          Rainbow names only: "vol", "vol.h5"
    settle_seconds   leave a file alone until its modification time (when the
                     listing gives one) is this old: a file still being
                     written is never taken half-way
    timeout          seconds, per network operation

A listing without modification times (an Apache/nginx HTML page, NASA's, FTP
LIST or NLST) cannot say whether a file is still being written, so the poller
takes such a file only once two consecutive listings saw it with the same
size (poller.py). Where the listing gives no size either, probe_size() asks
for it: a HEAD (Content-Length) over HTTP, SIZE over FTP.

No source ever sends a request to mapainterativo.cemaden.gov.br, the public
map whose downloads are behind a CAPTCHA (config.FORBIDDEN_HOSTS).
"""
from __future__ import annotations

import email.utils
import ftplib
import logging
import os
import posixpath
import re
import ssl
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Optional
from urllib.parse import quote, unquote, urljoin, urlsplit

import requests

from . import __version__
from .config import Config, RadarConf, forbidden_host, forbidden_url
from .stamps import Parsed, parse_name, parse_nasa_vn, parse_rainbow, valid_name

log = logging.getLogger("relay.sources")

USER_AGENT = f"WeatherTS-radar-relay/{__version__} (+https://weatherts.tech)"
NASA_VN_BASE = "https://pmm-gv.gsfc.nasa.gov/pub/gpmarchive/Radar/VN/GPM"
# The moments the app reads from a CEMADEN volume (the filtered ones), and
# the file form: Rainbow's own .vol. Skipped by default: the unfiltered
# duplicates (dBuZ, uPhiDP, uZDR...), the quality fields, and the .vol.h5
# copies of the same data.
CEMADEN_MOMENTS = ["dBZ", "V", "W", "ZDR", "RhoHV", "KDP", "PhiDP"]
CEMADEN_FORMATS = ["vol"]
FUTURE_SLACK_S = 6 * 3600     # a stamp further ahead than this is a broken clock, not a volume


class SourceError(RuntimeError):
    pass


class SourceGone(SourceError):
    """The file is no longer at the source (404): nothing to take, and no
    sign the server is failing."""


@dataclass
class RemoteFile:
    name: str
    stamp: str
    unix: int
    ref: str                       # what fetch() needs: a server path, a URL, a local path
    size: Optional[int] = None     # bytes, when the listing says
    mtime: Optional[float] = None  # unix, when the listing says
    moment: Optional[str] = None


_PARSERS: dict[str, Callable[[str], Optional[Parsed]]] = {
    "any": parse_name, "rainbow": parse_rainbow, "nasa_vn": parse_nasa_vn,
}


class Source:
    """The part every source shares: the window, the days, the name rules.
    Subclasses give _entries(since, now) -> (name, ref, size, mtime) and
    _fetch(ref, size, dest, max_bytes) -> bytes written, and may give
    _probe(ref) -> the file's size now (None: no way to ask)."""

    type = "base"

    def __init__(self, radar: RadarConf, opts: dict[str, Any], cfg: Optional[Config] = None):
        self.radar = radar
        self.opts = opts
        self.cfg = cfg
        self.timeout = float(opts.get("timeout", 60))
        self.settle_s = float(opts.get("settle_seconds", 0) or 0)
        self.day_offset_s = float(opts.get("day_offset_hours", 0) or 0) * 3600.0
        rx = opts.get("filename_regex")
        self.filename_re = re.compile(rx) if rx else None
        moms = opts.get("moments")
        self.moments = {str(m).lower() for m in moms} if moms else None
        fmts = opts.get("formats")
        self.formats = {str(f).lower().lstrip(".") for f in fmts} if fmts else None
        self.parse = _PARSERS[str(opts.get("names", "any"))]

    # --- what subclasses give -------------------------------------------
    def configured(self) -> tuple[bool, str]:
        return True, ""

    def _entries(self, since: float, now: float) -> Iterable[tuple[str, str, Optional[int], Optional[float]]]:
        raise NotImplementedError

    def _fetch(self, ref: str, size: Optional[int], dest: Path, max_bytes: int) -> int:
        raise NotImplementedError

    def _probe(self, ref: str) -> Optional[int]:
        return None

    def close(self) -> None:
        pass

    # --- shared ----------------------------------------------------------
    def describe(self) -> str:
        return self.type

    def fmt(self, template: str, day: Optional[datetime] = None) -> str:
        site = self.radar.site
        try:
            return str(template).format(site=site, SITE=site.upper(), id=self.radar.id, date=day)
        except (KeyError, IndexError, ValueError, AttributeError) as e:
            raise SourceError(f"bad template {template!r}: {e}") from e

    def days(self, since: float, now: float) -> list[datetime]:
        """The UTC days of the window, oldest first (shifted by day_offset_hours)."""
        d0 = datetime.fromtimestamp(since + self.day_offset_s, tz=timezone.utc).date()
        d1 = datetime.fromtimestamp(now + self.day_offset_s, tz=timezone.utc).date()
        out = []
        while d0 <= d1:
            out.append(datetime(d0.year, d0.month, d0.day, tzinfo=timezone.utc))
            d0 += timedelta(days=1)
        return out

    def expand(self, template: str, since: float, now: float) -> list[str]:
        """The folders (or URLs) to list for this window: one per day when the
        template has {date}, else just the one."""
        if "{date" not in template:
            return [self.fmt(template)]
        seen, out = set(), []
        for d in self.days(since, now):
            s = self.fmt(template, d)
            if s not in seen:
                seen.add(s)
                out.append(s)
        return out

    def keep(self, name: str) -> Optional[Parsed]:
        """The parsed name when the relay should store this file, else None."""
        if not valid_name(name):
            return None
        if self.filename_re and not self.filename_re.search(name):
            return None
        p = self.parse(name)
        if p is None:
            return None
        if p.kind == "rainbow":
            if self.moments is not None and (p.moment or "").lower() not in self.moments:
                return None
            if self.formats is not None and (p.fmt or "").lower() not in self.formats:
                return None
        return p

    def list(self, since: float, now: float) -> list[RemoteFile]:
        """Files of volumes that started at or after `since`, that the rules
        keep, oldest first. Raises SourceError when the source cannot be read."""
        out: dict[str, RemoteFile] = {}
        for name, ref, size, mtime in self._entries(since, now):
            p = self.keep(name)
            if p is None or p.unix < since or p.unix > now + FUTURE_SLACK_S or name in out:
                continue
            out[name] = RemoteFile(name=name, stamp=p.stamp, unix=p.unix, ref=ref, size=size, mtime=mtime,
                                   moment=p.moment)
        return sorted(out.values(), key=lambda f: (f.unix, f.name))

    def settled(self, f: RemoteFile, wall: Optional[float] = None) -> bool:
        if self.settle_s <= 0 or f.mtime is None:
            return True
        return (wall if wall is not None else time.time()) - f.mtime >= self.settle_s

    def probe_size(self, f: RemoteFile) -> Optional[int]:
        """The file's size as the source has it now: the listing's when it
        gave one, else asked for (None when the source cannot say). Raises
        SourceError when asking fails (the file gone, the server down)."""
        if f.size is not None:
            return f.size
        return self._probe(f.ref)

    def fetch(self, f: RemoteFile, dest: Path, max_bytes: int) -> int:
        """Download one file to dest (a staging file); returns its size. The
        size must match what the source announced, or SourceError."""
        n = self._fetch(f.ref, f.size, dest, max_bytes)
        if f.size is not None and n != f.size:
            raise SourceError(f"{f.name}: got {n} bytes, the listing said {f.size}")
        return n


def _write_capped(chunks: Iterable[bytes], dest: Path, max_bytes: int, what: str) -> int:
    n = 0
    with open(dest, "wb") as out:
        for chunk in chunks:
            if not chunk:
                continue
            n += len(chunk)
            if n > max_bytes:
                raise SourceError(f"{what}: larger than max_file_mb ({max_bytes} bytes)")
            out.write(chunk)
    return n


# ---------------------------------------------------------------------------
# Local folder
# ---------------------------------------------------------------------------
class LocalSource(Source):
    type = "local"

    def configured(self) -> tuple[bool, str]:
        return (bool(self.opts.get("path")), "no path")

    def _dir(self, s: str) -> Path:
        p = Path(s).expanduser()
        if not p.is_absolute() and self.cfg is not None:
            p = self.cfg.resolve_path(s)
        return p

    def _entries(self, since: float, now: float):
        template = str(self.opts["path"])
        dated = "{date" in template
        for s in self.expand(template, since, now):
            d = self._dir(s)
            if not d.is_dir():
                if dated:
                    continue            # no folder for that day (yet)
                raise SourceError(f"folder not found: {d}")
            try:
                with os.scandir(d) as it:
                    for e in it:
                        if e.is_file():
                            st = e.stat()
                            yield e.name, e.path, int(st.st_size), float(st.st_mtime)
            except OSError as e:
                raise SourceError(f"cannot list {d}: {e}") from e

    def _fetch(self, ref: str, size: Optional[int], dest: Path, max_bytes: int) -> int:
        try:
            with open(ref, "rb") as src:
                return _write_capped(iter(lambda: src.read(1 << 20), b""), dest, max_bytes, ref)
        except OSError as e:
            raise SourceError(f"cannot read {ref}: {e}") from e

    def _probe(self, ref: str) -> Optional[int]:
        try:
            return os.stat(ref).st_size
        except OSError as e:
            raise SourceError(f"cannot stat {ref}: {e}") from e


# ---------------------------------------------------------------------------
# FTP / FTPS
# ---------------------------------------------------------------------------
_DOS_LINE = re.compile(r"^\d{2}-\d{2}-\d{2,4}\s+\d{1,2}:\d{2}\s*(?:[AP]M)?\s+(<DIR>|\d+)\s+(.+)$", re.I)


def _mlsd_time(s: str) -> Optional[float]:
    try:
        return datetime.strptime(s[:14], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).timestamp()
    except (ValueError, TypeError):
        return None


def parse_list_line(line: str) -> Optional[tuple[str, Optional[int], bool]]:
    """One line of an FTP LIST: (name, size, is_dir), unix or DOS style."""
    m = _DOS_LINE.match(line.strip())
    if m:
        is_dir = m.group(1).upper() == "<DIR>"
        return m.group(2), (None if is_dir else int(m.group(1))), is_dir
    parts = line.split(None, 8)
    if len(parts) >= 9 and parts[0][:1] in "-dlcbps" and parts[4].isdigit():
        return parts[8], int(parts[4]), parts[0][0] == "d"
    parts = line.split(None, 7)       # no group column
    if len(parts) >= 8 and parts[0][:1] in "-dlcbps" and parts[3].isdigit():
        return parts[7], int(parts[3]), parts[0][0] == "d"
    return None


class FtpSource(Source):
    type = "ftp"

    def __init__(self, radar, opts, cfg=None):
        super().__init__(radar, opts, cfg)
        self._ftp: Optional[ftplib.FTP] = None

    def configured(self) -> tuple[bool, str]:
        return (bool(self.opts.get("host")), "no host")

    def describe(self) -> str:
        return f"{self.type} {self.opts.get('host')}"

    def _connect(self) -> ftplib.FTP:
        if self._ftp is not None:
            return self._ftp
        o = self.opts
        host = str(o["host"])
        if forbidden_host(host):
            raise SourceError(f"refusing to connect to {host}")
        tls = bool(o.get("tls", False))
        if tls:
            ctx = ssl.create_default_context()
            if o.get("tls_verify", True) is False:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            ftp: ftplib.FTP = ftplib.FTP_TLS(context=ctx, timeout=self.timeout,
                                             encoding=str(o.get("encoding", "utf-8")))
        else:
            ftp = ftplib.FTP(timeout=self.timeout, encoding=str(o.get("encoding", "utf-8")))
        try:
            ftp.connect(host, int(o.get("port", 21)))
            ftp.login(str(o.get("user") or "anonymous"), str(o.get("password") or ""))
            if tls:
                ftp.prot_p()          # the data connections encrypted too
            ftp.set_pasv(bool(o.get("passive", True)))
        except (OSError, EOFError, ftplib.Error) as e:
            try:
                ftp.close()
            except Exception:
                pass
            raise SourceError(f"ftp {host}: {e}") from e
        self._ftp = ftp
        return ftp

    def close(self) -> None:
        ftp, self._ftp = self._ftp, None
        if ftp is None:
            return
        try:
            ftp.quit()
        except Exception:
            try:
                ftp.close()
            except Exception:
                pass

    def _drop(self) -> None:
        ftp, self._ftp = self._ftp, None
        if ftp is not None:
            try:
                ftp.close()
            except Exception:
                pass

    def _list_dir(self, path: str, dated: bool):
        ftp = self._connect()
        try:
            try:
                for name, facts in ftp.mlsd(path, facts=["type", "size", "modify"]):
                    if facts.get("type", "file").lower() != "file":
                        continue
                    size = int(facts["size"]) if facts.get("size", "").isdigit() else None
                    yield posixpath.basename(name), posixpath.join(path, posixpath.basename(name)), size, \
                        _mlsd_time(facts.get("modify", ""))
                return
            except ftplib.error_perm as e:
                code = str(e)[:3]
                if code == "550":
                    raise
                if code not in ("500", "501", "502", "504"):
                    raise
            # No MLSD: LIST, read as unix or DOS lines; NLST if neither parses.
            lines: list[str] = []
            ftp.retrlines(f"LIST {path}", lines.append)
            parsed = [p for p in (parse_list_line(ln) for ln in lines) if p]
            if parsed or not lines:
                for name, size, is_dir in parsed:
                    if not is_dir:
                        base = posixpath.basename(name.split(" -> ")[0])
                        yield base, posixpath.join(path, base), size, None
                return
            for name in ftp.nlst(path):
                base = posixpath.basename(name)
                yield base, posixpath.join(path, base), None, None
        except ftplib.error_perm as e:
            if str(e)[:3] == "550" and dated:
                return                # no folder for that day (yet)
            raise SourceError(f"ftp list {path}: {e}") from e
        except (OSError, EOFError, ftplib.Error) as e:
            self._drop()
            raise SourceError(f"ftp list {path}: {e}") from e

    def _entries(self, since: float, now: float):
        template = str(self.opts.get("path", "/"))
        dated = "{date" in template
        for path in self.expand(template, since, now):
            yield from list(self._list_dir(path, dated))

    def _fetch(self, ref: str, size: Optional[int], dest: Path, max_bytes: int) -> int:
        ftp = self._connect()
        try:
            if size is None:
                try:
                    ftp.voidcmd("TYPE I")
                    s = ftp.size(ref)
                    size = int(s) if s is not None else None
                except (ftplib.error_perm, ValueError):
                    size = None
            n = 0
            with open(dest, "wb") as out:
                def write(chunk: bytes) -> None:
                    nonlocal n
                    n += len(chunk)
                    if n > max_bytes:
                        raise SourceError(f"{ref}: larger than max_file_mb ({max_bytes} bytes)")
                    out.write(chunk)
                ftp.retrbinary(f"RETR {ref}", write, blocksize=1 << 16)
        except SourceError:
            self._drop()              # the transfer was cut: the control connection is in no known state
            raise
        except (OSError, EOFError, ftplib.Error) as e:
            self._drop()
            raise SourceError(f"ftp get {ref}: {e}") from e
        if size is not None and n != size:
            raise SourceError(f"{ref}: got {n} bytes, the server said {size}")
        return n

    def _probe(self, ref: str) -> Optional[int]:
        """SIZE, for a listing that gave none (NLST); None when the server
        does not answer it."""
        ftp = self._connect()
        try:
            ftp.voidcmd("TYPE I")         # SIZE in ASCII mode is refused, or wrong
            s = ftp.size(ref)
            return int(s) if s is not None else None
        except (ftplib.error_perm, ValueError):
            return None
        except (OSError, EOFError, ftplib.Error) as e:
            self._drop()
            raise SourceError(f"ftp size {ref}: {e}") from e


# ---------------------------------------------------------------------------
# HTTP directory listing
# ---------------------------------------------------------------------------
_HREF = r"""href\s*=\s*["']([^"']+)["']"""


class HttpIndexSource(Source):
    type = "http_index"

    def __init__(self, radar, opts, cfg=None):
        super().__init__(radar, opts, cfg)
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self.session.verify = opts.get("verify", True)
        # Credentials and custom headers go to the configured host only, never
        # to wherever a redirect points.
        self._home = (urlsplit(str(opts.get("url") or opts.get("base_url") or "")).hostname or "").lower()
        self._headers = {str(k): str(v) for k, v in (opts.get("headers") or {}).items()}
        self._auth = None
        if opts.get("token"):
            self._headers["Authorization"] = f"Bearer {opts['token']}"
        elif opts.get("user"):
            self._auth = (str(opts["user"]), str(opts.get("password") or ""))
        self.link_re = re.compile(str(opts.get("link_regex") or _HREF), re.I)
        self.same_dir_only = bool(opts.get("same_dir_only", True))

    def configured(self) -> tuple[bool, str]:
        return (bool(self.opts.get("url")), "no url")

    def describe(self) -> str:
        u = urlsplit(str(self.opts.get("url", "")))
        return f"{self.type} {u.scheme}://{u.netloc}"

    def close(self) -> None:
        pass                          # the session's connections are reused next poll

    def _request(self, method: str, url: str, stream: bool = False, headers: Optional[dict[str, str]] = None
                 ) -> requests.Response:
        """One request, following redirects by hand so every hop passes the
        host guard before it is requested; the final answer, whatever its
        status."""
        for _hop in range(6):
            if forbidden_url(url):
                raise SourceError(f"refusing to request {url}")
            home = (urlsplit(url).hostname or "").lower() == self._home
            h = dict(headers or {})
            if home:
                h.update(self._headers)
            try:
                r = self.session.request(method, url, timeout=(min(15.0, self.timeout), self.timeout),
                                         stream=stream, headers=h, auth=self._auth if home else None,
                                         allow_redirects=False)
            except requests.RequestException as e:
                raise SourceError(f"{method} {url}: {e}") from e
            if r.is_redirect and r.headers.get("Location"):
                nxt = urljoin(url, r.headers["Location"])
                r.close()
                url = nxt
                continue
            return r
        raise SourceError(f"{method} {url}: too many redirects")

    def _get(self, url: str, stream: bool = False, headers: Optional[dict[str, str]] = None
             ) -> Optional[requests.Response]:
        """GET through _request; None on 404."""
        r = self._request("GET", url, stream=stream, headers=headers)
        if r.status_code == 404:
            r.close()
            return None
        if r.status_code >= 400:
            r.close()
            raise SourceError(f"GET {r.url or url}: HTTP {r.status_code}")
        return r

    def _probe(self, ref: str) -> Optional[int]:
        """HEAD: the Content-Length the server would send now, uncompressed
        on the way like _fetch asks; None when it does not say (no HEAD, no
        length)."""
        r = self._request("HEAD", ref, headers={"Accept-Encoding": "identity"})
        r.close()
        if r.status_code == 404:
            raise SourceGone(f"{ref}: gone (404)")
        # 405/501 (no HEAD) and any other 4xx -- a WAF or a server that only
        # answers GET -- say nothing about the file: its size is unknown, not
        # an error, or a GET-only server would never get past the probe.
        if 400 <= r.status_code < 500 or r.status_code == 501:
            return None
        if r.status_code >= 500:
            raise SourceError(f"HEAD {ref}: HTTP {r.status_code}")
        length = r.headers.get("Content-Length")
        return int(length) if length and length.isdigit() else None

    def links(self, url: str) -> Optional[list[tuple[str, str, bool]]]:
        """(name, absolute url, is_dir) for every link a listing page makes
        to its own children; None when the page does not exist."""
        r = self._get(url)
        if r is None:
            return None
        final = r.url or url
        text = r.text
        r.close()
        base = urlsplit(final)
        base_dir = base.path if base.path.endswith("/") else posixpath.dirname(base.path) + "/"
        out, seen = [], set()
        for href in self.link_re.findall(text):
            if href.startswith(("?", "#", "mailto:", "javascript:")):
                continue
            absu = urljoin(final, href.split("#")[0])
            u = urlsplit(absu)
            if u.query or u.netloc != base.netloc:
                continue
            is_dir = u.path.endswith("/")
            path = u.path.rstrip("/")
            if not path.startswith(base_dir):
                continue              # the parent, or somewhere else on the host
            if self.same_dir_only and posixpath.dirname(path) + "/" != base_dir:
                continue
            name = unquote(posixpath.basename(path))
            if name and name not in seen:
                seen.add(name)
                out.append((name, absu, is_dir))
        return out

    def _json_entries(self, url: str) -> Optional[list[tuple[str, str, Optional[int], Optional[float]]]]:
        r = self._get(url)
        if r is None:
            return None
        try:
            items = r.json()
        except ValueError as e:
            raise SourceError(f"{url}: not a JSON listing") from e
        finally:
            r.close()
        out = []
        for it in items if isinstance(items, list) else []:
            if not isinstance(it, dict) or it.get("type", "file") != "file" or not it.get("name"):
                continue
            mtime = None
            if it.get("mtime"):
                try:
                    mtime = email.utils.parsedate_to_datetime(str(it["mtime"])).timestamp()
                except (TypeError, ValueError):
                    mtime = None
            size = it.get("size")
            out.append((str(it["name"]), urljoin(r.url or url, quote(str(it["name"]))),
                        int(size) if isinstance(size, (int, float)) else None, mtime))
        return out

    def _entries(self, since: float, now: float):
        template = str(self.opts["url"])
        dated = "{date" in template
        as_json = str(self.opts.get("format", "html")).lower() == "json"
        for url in self.expand(template, since, now):
            found = self._json_entries(url) if as_json else self.links(url)
            if found is None:
                if dated:
                    continue            # no listing for that day (yet)
                raise SourceError(f"listing not found (404): {url}")
            if as_json:
                yield from found
                continue
            for name, absu, is_dir in found:
                if not is_dir:
                    yield name, absu, None, None

    def _fetch(self, ref: str, size: Optional[int], dest: Path, max_bytes: int) -> int:
        # Raw bytes, exactly as the server keeps them: "identity" asks it not
        # to compress on the way, and decode_content=False keeps requests
        # from unpacking a .gz the server labels Content-Encoding: gzip.
        r = self._get(ref, stream=True, headers={"Accept-Encoding": "identity"})
        if r is None:
            raise SourceGone(f"{ref}: gone (404)")
        try:
            length = r.headers.get("Content-Length")
            expected = int(length) if length and length.isdigit() else None
            n = _write_capped(r.raw.stream(1 << 16, decode_content=False), dest, max_bytes, ref)
        except (requests.RequestException, OSError) as e:
            raise SourceError(f"GET {ref}: {e}") from e
        except Exception as e:        # urllib3's ProtocolError and friends on a cut connection
            if isinstance(e, SourceError):
                raise
            raise SourceError(f"GET {ref}: {e}") from e
        finally:
            r.close()
        if expected is not None and n != expected:
            raise SourceError(f"{ref}: got {n} bytes, Content-Length said {expected}")
        return n


# ---------------------------------------------------------------------------
# NASA GPM Validation Network
# ---------------------------------------------------------------------------
class NasaVnSource(HttpIndexSource):
    """<base>/<SITE>/<YYYY>/<MMDD>/<SITE>_<YYYY>_<MMDD>_<HHMMSS>.cf.gz. Days
    are sparse (a folder only where GPM flew over), so the year folder is
    read first and only the days inside the window are opened; `only_dates`
    ("YYYY-MM-DD", ...) narrows it to chosen days without reading the years."""

    type = "nasa_vn"

    def __init__(self, radar, opts, cfg=None):
        opts = dict(opts)
        opts.setdefault("names", "nasa_vn")
        super().__init__(radar, opts, cfg)
        self.base = str(opts.get("base_url") or NASA_VN_BASE).rstrip("/")
        self.code = radar.site.upper()
        dates = opts.get("only_dates") or []
        self.only: Optional[set[date]] = {date.fromisoformat(str(d)) for d in dates} or None

    def configured(self) -> tuple[bool, str]:
        return (bool(re.match(r"^[A-Z0-9]{2,4}$", self.code)), "no NASA site code (site = \"MC1\" ...)")

    def describe(self) -> str:
        return f"nasa_vn {self.code}"

    def keep(self, name: str) -> Optional[Parsed]:
        p = super().keep(name)
        return p if p is not None and p.site == self.code else None

    def _day_urls(self, since: float, now: float) -> list[str]:
        d0 = datetime.fromtimestamp(since, tz=timezone.utc).date()
        d1 = datetime.fromtimestamp(now, tz=timezone.utc).date()
        if self.only is not None:
            return [f"{self.base}/{self.code}/{d:%Y}/{d:%m%d}/" for d in sorted(self.only) if d0 <= d <= d1]
        out = []
        for year in range(d0.year, d1.year + 1):
            for name, _absu, is_dir in self.links(f"{self.base}/{self.code}/{year}/") or []:
                if not is_dir or not re.match(r"^\d{4}$", name):
                    continue
                try:
                    d = date(year, int(name[:2]), int(name[2:]))
                except ValueError:
                    continue
                if d0 <= d <= d1:
                    out.append(f"{self.base}/{self.code}/{year}/{name}/")
        return out

    def _entries(self, since: float, now: float):
        for url in self._day_urls(since, now):
            for name, absu, is_dir in self.links(url) or []:
                if not is_dir:
                    yield name, absu, None, None


# ---------------------------------------------------------------------------
# The CEMADEN preset, and the factory
# ---------------------------------------------------------------------------
_TRANSPORTS: dict[str, type[Source]] = {"ftp": FtpSource, "http_index": HttpIndexSource, "local": LocalSource}
_TYPES: dict[str, type[Source]] = {**_TRANSPORTS, "nasa_vn": NasaVnSource}


def cemaden_options(opts: dict[str, Any]) -> dict[str, Any]:
    o = dict(opts)
    o["names"] = "rainbow"
    o.setdefault("moments", list(CEMADEN_MOMENTS))
    o.setdefault("formats", list(CEMADEN_FORMATS))
    # Over the network, a listing that gives modification times (FTP MLSD, a
    # JSON index) still leaves a file alone this long, the value
    # config.example.toml uses: left at 0 a file was taken the instant it was
    # listed, mid-write. A local drop folder keeps its own setting.
    if str(o.get("transport", "ftp")) != "local":
        o.setdefault("settle_seconds", 30)
    return o


def make_source(radar: RadarConf, cfg: Optional[Config] = None) -> Optional[Source]:
    """The radar's source, or None when it has none, it is switched off, or
    its access is not configured yet (logged once by the caller)."""
    opts = radar.options
    if not radar.source or not radar.enabled or not opts.get("enabled", True):
        return None
    kind = opts.get("type")
    if kind == "cemaden":
        transport = str(opts.get("transport", "ftp"))
        cls = _TRANSPORTS.get(transport)
        if cls is None:
            raise SourceError(f"cemaden transport must be one of {', '.join(_TRANSPORTS)} (got {transport!r})")
        src = cls(radar, cemaden_options(opts), cfg)
        src.type = f"cemaden/{transport}"
    else:
        cls = _TYPES.get(str(kind))
        if cls is None:
            raise SourceError(f"unknown source type {kind!r}")
        src = cls(radar, opts, cfg)
    ok, why = src.configured()
    if not ok:
        log.warning("%s: source %r is not configured (%s); the radar stays idle", radar.id, radar.source, why)
        return None
    return src
