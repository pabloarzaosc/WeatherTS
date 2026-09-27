"""
One set of CA certificates for every HTTPS connection the backend opens.

requests hands urllib3 the path of certifi's bundle with every request, and
urllib3 loads it into a brand-new SSL context for every new connection. Under
OpenSSL 3 that load is about 0.2 s of CPU, where the request itself is a few
milliseconds: opening a radar not seen yet opens dozens of connections to S3
at once (its tilts, its newest Level II volume, its scans), and the tilt check
that answers in 0.2 s on open connections took two to ten seconds on new ones.

`install()` loads the bundle once, into one context shared by every pool, and
stops requests from asking for it again. Verification is unchanged: the
certificate chain is still checked against the same bundle, and urllib3 still
matches the host name. Only requests made with the default `verify=True` are
affected; a session given its own bundle or `verify=False` keeps that.

It also lets at most `_OPENING` TLS handshakes run at once, process-wide, and
gives up on one that stalls. From here, twenty-odd handshakes started together
lose some of them for about five seconds (the per-connection certificate load
used to space them out, by accident), and now and then one stalls like that on
its own. Queued, and a stalled one started again after `_OPEN_TRY_S`,
thirty-two new connections open in about a second and a half. Only the
handshake queues -- a host that is down, stuck in its TCP connect, holds up no
one else -- a connection already open is never held up, and the last attempt
gets the caller's own timeout.
"""
from __future__ import annotations

import ssl
import threading
from typing import Any

import requests.adapters
import urllib3.connection
from requests.utils import DEFAULT_CA_BUNDLE_PATH
from urllib3.util.ssl_ import create_urllib3_context

_CTX: ssl.SSLContext | None = None
_LOCK = threading.Lock()
_INSTALLED = False
_OPENING = 12
_OPEN_SLOTS = threading.BoundedSemaphore(_OPENING)
# A TLS handshake takes 0.2-0.5 s from here, to AWS in Virginia or to Europe;
# one still going after this is stalled, not slow.
_OPEN_TRY_S = 2.0
_OPEN_TRIES = 2
# Set while a handshake may be given up and the connection opened again: the
# TCP connect keeps the caller's timeout, so a host that is down times out
# exactly as it did.
_HEDGE = threading.local()


class _Stalled(Exception):
    """A TLS handshake that went quiet; the connection is opened again."""


def _context() -> ssl.SSLContext:
    global _CTX
    with _LOCK:
        if _CTX is None:
            ctx = create_urllib3_context(cert_reqs=ssl.CERT_REQUIRED)
            ctx.load_verify_locations(DEFAULT_CA_BUNDLE_PATH)
            _CTX = ctx
        return _CTX


def install() -> None:
    """Patch requests' HTTPAdapter, once; every session, made before or after."""
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True
    adapter = requests.adapters.HTTPAdapter
    build_keys = adapter.build_connection_pool_key_attributes
    verify_cert = adapter.cert_verify

    def build_connection_pool_key_attributes(self: Any, request: Any, verify: Any, cert: Any = None):
        host_params, pool_kwargs = build_keys(self, request, verify, cert)
        if verify is True and cert is None and host_params.get("scheme") == "https":
            pool_kwargs["ssl_context"] = _context()
        return host_params, pool_kwargs

    def cert_verify(self: Any, conn: Any, url: str, verify: Any, cert: Any) -> None:
        verify_cert(self, conn, url, verify, cert)
        # The shared context already holds these: loading them again per
        # connection is the cost this module exists to avoid.
        shared = getattr(conn, "conn_kw", {}).get("ssl_context")
        if verify is True and cert is None and shared is not None and shared is _CTX:
            conn.ca_certs = None
            conn.ca_cert_dir = None

    adapter.build_connection_pool_key_attributes = build_connection_pool_key_attributes
    adapter.cert_verify = cert_verify

    https = urllib3.connection.HTTPSConnection
    connect = https.connect
    wrap = urllib3.connection._ssl_wrap_socket_and_match_hostname  # noqa: SLF001

    def queued_wrap(sock: Any, *args: Any, **kwargs: Any) -> Any:
        was = sock.gettimeout()
        with _OPEN_SLOTS:
            if not getattr(_HEDGE, "on", False) or (was is not None and was <= _OPEN_TRY_S):
                return wrap(sock, *args, **kwargs)
            sock.settimeout(_OPEN_TRY_S)
            try:
                out = wrap(sock, *args, **kwargs)
            except TimeoutError as e:
                raise _Stalled from e
        # The TLS socket took over `sock` with the short timeout; the caller's
        # goes back on it (`sock` itself is detached by now).
        out.socket.settimeout(was)
        return out

    def retried_connect(self: Any) -> None:
        for _ in range(_OPEN_TRIES):
            _HEDGE.on = True
            try:
                connect(self)
                return
            except _Stalled:
                self.close()
            finally:
                _HEDGE.on = False
        connect(self)

    urllib3.connection._ssl_wrap_socket_and_match_hostname = queued_wrap  # noqa: SLF001
    https.connect = retried_connect
