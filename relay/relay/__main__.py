"""
python -m relay [--config config.toml] [--poller-only | --api-only | --once]

    (no mode)       the API, with the poller in a background thread: one
                    process does everything (a small VM, a container)
    --api-only      the API alone, following index.json that a poller
                    elsewhere writes to the same store (a bucket)
    --poller-only   the poller alone, no HTTP
    --once          one round (every radar once, then prune and write the
                    index), then exit: for cron, systemd timers, GitHub
                    Actions. A source that lists files without modification
                    times is listed a second time, [relay] recheck_seconds
                    (20) later, to confirm their sizes before downloading.
                    Exit status 1 when a radar failed.

Exit status 2: the configuration is wrong ("configuration: ..." on stderr),
or the store cannot be opened.

    --retention-hours H   override [relay] retention_hours (e.g. 8760 to keep
                          a year of NASA demonstration volumes)
    --radar ID            poll only this radar (repeatable); others stay listed
    --reconcile           check index.json against the store before starting
    --host, --port        where the API listens
    --log-level           DEBUG, INFO, WARNING
"""
from __future__ import annotations

import argparse
import logging
import re
import sys
import threading
import time

from . import __version__
from .config import ConfigError, load_config
from .index import Index
from .storage import StorageError, make_storage

log = logging.getLogger("relay")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m relay", description="WeatherTS radar relay")
    ap.add_argument("--config", help="TOML file (default: $RELAY_CONFIG, else ./config.toml)")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--api-only", action="store_true", help="serve the API only")
    mode.add_argument("--poller-only", action="store_true", help="run the poller only")
    mode.add_argument("--once", action="store_true", help="one poll round, prune, exit")
    ap.add_argument("--retention-hours", type=float)
    ap.add_argument("--radar", action="append", default=[], metavar="ID")
    ap.add_argument("--reconcile", action="store_true")
    ap.add_argument("--host")
    ap.add_argument("--port", type=int)
    ap.add_argument("--log-level")
    ap.add_argument("--version", action="version", version=f"relay {__version__}")
    args = ap.parse_args(argv)

    try:
        cfg = load_config(args.config)
        if args.retention_hours is not None:
            if args.retention_hours <= 0:
                raise ConfigError("--retention-hours must be above 0")
            cfg.retention_hours = args.retention_hours
        if args.radar:
            cfg.only(args.radar)
        if args.host:
            cfg.api.host = args.host
        if args.port:
            cfg.api.port = args.port
    except ConfigError as e:
        print(f"configuration: {e}", file=sys.stderr)
        return 2

    # Log times in UTC, like the stamps.
    logging.Formatter.converter = time.gmtime
    logging.basicConfig(level=(args.log_level or cfg.log_level or "INFO").upper(),
                        format="%(asctime)sZ %(levelname)s %(name)s: %(message)s")
    try:
        storage = make_storage(cfg)
    except StorageError as e:
        log.error("storage: %s", e)
        return 2
    log.info("relay %s: %s, retention %g h, %d radars listed (config: %s)", __version__, storage.describe(),
             cfg.retention_hours, len(cfg.radars), cfg.path or "built-in defaults")

    index = Index(storage).open(reconcile=args.reconcile or not (args.once or args.api_only))

    if args.api_only:
        return _serve(cfg, storage, index, follow_index=True)

    from .poller import Poller
    from .sources import SourceError
    try:
        poller = Poller(cfg, storage, index)
    except (SourceError, ValueError, re.error) as e:
        # A source the configuration let through but cannot be built (config.py
        # catches the known cases; this is the net for the rest).
        print(f"configuration: {e}", file=sys.stderr)
        return 2
    for rid, src in poller.sources.items():
        log.info("%s: polling %s every %g s", rid, src.describe(), poller._poll_s(rid))

    if args.once:
        reports = poller.poll_once()
        failed = [r for r in reports if r.error]
        total = sum(r.downloaded for r in reports)
        log.info("round done: %d radars, %d files downloaded, %d failed; store holds %d volumes, %d files",
                 len(reports), total, len(failed), index.count_volumes(), index.count_files())
        return 1 if failed else 0

    stop = threading.Event()
    if args.poller_only:
        try:
            poller.run_forever(stop)
        except KeyboardInterrupt:
            stop.set()
        return 0

    t = threading.Thread(target=poller.run_forever, args=(stop,), name="relay-poller", daemon=True)
    t.start()
    try:
        return _serve(cfg, storage, index, follow_index=False)
    finally:
        stop.set()
        t.join(timeout=60)


def _serve(cfg, storage, index, follow_index: bool) -> int:
    import uvicorn

    from .api import create_app
    app = create_app(cfg, storage, index, follow_index=follow_index)
    uvicorn.run(app, host=cfg.api.host, port=cfg.api.port, log_level="warning", proxy_headers=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
