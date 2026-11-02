"""
Where the relay keeps the files: a folder on this machine ("local", the
default) or any S3-compatible bucket ("s3": Cloudflare R2, Backblaze B2,
AWS S3, MinIO). Keys are <prefix><radar>/<stamp>/<name>, the bytes exactly as
the source sent them; index.json (index.py) sits beside them, at
<prefix>index.json.

A download goes to a staging file first and is committed only once complete,
with its size checked: locally an os.replace into place (atomic on one
filesystem), on S3 a single PUT, which S3 makes visible only whole, then a
HEAD to check the stored size. A half-downloaded file is never under a key the
API serves.

boto3 is imported only when an s3 storage is configured, so a local relay
needs nothing beyond fastapi, uvicorn and requests.
"""
from __future__ import annotations

import logging
import os
import shutil
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Iterator, Optional

from .config import RADAR_ID_RE, Config
from .stamps import STAMP_RE, valid_name

log = logging.getLogger("relay.storage")

# Each file is named by its volume's scan time and never changes, so caches
# may keep it for the whole 36 h it can exist.
IMMUTABLE = "public, max-age=129600, immutable"
OCTET = "application/octet-stream"
INDEX_KEY = "index.json"


class StorageError(RuntimeError):
    pass


def file_key(radar: str, stamp: str, name: str) -> str:
    return f"{radar}/{stamp}/{name}"


def split_key(rel: str) -> Optional[tuple[str, str, str]]:
    """(radar, stamp, name) for a stored file's key below the prefix, or None
    for anything else (index.json, stray objects)."""
    parts = rel.split("/")
    if len(parts) != 3:
        return None
    radar, stamp, name = parts
    if RADAR_ID_RE.match(radar) and STAMP_RE.match(stamp) and valid_name(name):
        return radar, stamp, name
    return None


class Storage:
    kind = "base"
    prefix = ""
    static_api = False

    def object_key(self, key: str) -> str:
        """The full key in the store (the prefix included): what a public
        bucket URL ends with."""
        return self.prefix + key

    # What every store gives.
    def staging_dir(self) -> Path: ...
    def commit(self, key: str, tmp: Path, size: int) -> None: ...
    def size(self, key: str) -> Optional[int]: ...
    def local_path(self, key: str) -> Optional[Path]:
        return None
    def open_stream(self, key: str) -> Optional[tuple[Iterator[bytes], int]]: ...
    def delete_volume(self, radar: str, stamp: str) -> int: ...
    # (radar, stamp, name, size, mtime): mtime is the file's modification
    # time (S3: LastModified) as unix seconds, None when the store has none;
    # index.rebuild() takes it as the file's "added" time.
    def list_files(self) -> Iterator[tuple[str, str, str, int, Optional[float]]]: ...
    def read_meta(self, key: str = INDEX_KEY) -> Optional[bytes]: ...
    def read_meta_if_changed(self, key: str, token: Any) -> tuple[Optional[bytes], Any]: ...
    def write_meta(self, key: str, data: bytes) -> None: ...
    def put_public(self, abs_key: str, data: bytes, content_type: str, cache_control: str) -> None: ...
    def describe(self) -> str:
        return self.kind


# ---------------------------------------------------------------------------
# Local folder
# ---------------------------------------------------------------------------
class LocalStorage(Storage):
    kind = "local"

    def __init__(self, root: Path, prefix: str = "", static_api: bool = False):
        self.root = Path(root).resolve()
        self.prefix = prefix
        self.static_api = static_api
        self.base = (self.root / prefix).resolve() if prefix else self.root
        self.base.mkdir(parents=True, exist_ok=True)
        self._staging = self.root / ".staging"
        self._staging.mkdir(parents=True, exist_ok=True)
        self._sweep_staging()

    def describe(self) -> str:
        return f"local {self.root}"

    def _sweep_staging(self, older_than_s: float = 3600.0) -> None:
        """Leftovers of a download cut by a crash: never committed, so never served."""
        now = time.time()
        for p in self._staging.glob("*.part"):
            try:
                if now - p.stat().st_mtime > older_than_s:
                    p.unlink()
            except OSError:
                pass

    def _path(self, key: str) -> Path:
        p = (self.base / key).resolve()
        if self.base not in p.parents:
            raise StorageError(f"key outside the store: {key!r}")
        return p

    def staging_dir(self) -> Path:
        return self._staging

    def commit(self, key: str, tmp: Path, size: int) -> None:
        dest = self._path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        got = tmp.stat().st_size
        if got != size:
            raise StorageError(f"{key}: staging file has {got} bytes, expected {size}")
        os.replace(tmp, dest)
        if dest.stat().st_size != size:
            dest.unlink(missing_ok=True)
            raise StorageError(f"{key}: stored size differs from {size}")

    def size(self, key: str) -> Optional[int]:
        try:
            p = self._path(key)
            return p.stat().st_size if p.is_file() else None
        except (OSError, StorageError):
            return None

    def local_path(self, key: str) -> Optional[Path]:
        p = self._path(key)
        return p if p.is_file() else None

    def open_stream(self, key: str) -> Optional[tuple[Iterator[bytes], int]]:
        p = self.local_path(key)
        if p is None:
            return None
        size = p.stat().st_size
        f = open(p, "rb")

        def chunks() -> Iterator[bytes]:
            with f:
                while True:
                    b = f.read(1 << 16)
                    if not b:
                        return
                    yield b
        return chunks(), size

    def delete_volume(self, radar: str, stamp: str) -> int:
        if not (RADAR_ID_RE.match(radar) and STAMP_RE.match(stamp)):
            raise StorageError(f"not a volume: {radar}/{stamp}")
        d = self._path(f"{radar}/{stamp}")
        if not d.is_dir():
            return 0
        n = sum(1 for p in d.iterdir() if p.is_file())
        shutil.rmtree(d, ignore_errors=True)
        return n

    def list_files(self) -> Iterator[tuple[str, str, str, int, Optional[float]]]:
        for rd in sorted(self.base.iterdir()) if self.base.is_dir() else []:
            if not rd.is_dir() or not RADAR_ID_RE.match(rd.name):
                continue
            for sd in sorted(rd.iterdir()):
                if not sd.is_dir() or not STAMP_RE.match(sd.name):
                    continue
                for f in sorted(sd.iterdir()):
                    if f.is_file() and valid_name(f.name):
                        st = f.stat()
                        yield rd.name, sd.name, f.name, st.st_size, st.st_mtime

    def read_meta(self, key: str = INDEX_KEY) -> Optional[bytes]:
        try:
            return self._path(key).read_bytes()
        except FileNotFoundError:
            return None

    def read_meta_if_changed(self, key: str, token: Any) -> tuple[Optional[bytes], Any]:
        p = self._path(key)
        try:
            st = p.stat()
        except FileNotFoundError:
            return None, None
        now_token = (st.st_mtime_ns, st.st_size)
        if now_token == token:
            return None, token
        try:
            return p.read_bytes(), now_token
        except FileNotFoundError:
            return None, None

    def _atomic_write(self, dest: Path, data: bytes) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.tmp")
        tmp.write_bytes(data)
        # On Windows a reader holding the file open blocks the replace for a
        # moment: try a few times before giving up.
        for attempt in range(20):
            try:
                os.replace(tmp, dest)
                return
            except PermissionError:
                time.sleep(0.05 * (attempt + 1))
        tmp.unlink(missing_ok=True)
        raise StorageError(f"could not replace {dest}")

    def write_meta(self, key: str, data: bytes) -> None:
        self._atomic_write(self._path(key), data)

    def put_public(self, abs_key: str, data: bytes, content_type: str, cache_control: str) -> None:
        p = (self.root / abs_key).resolve()
        if self.root not in p.parents:
            raise StorageError(f"key outside the store: {abs_key!r}")
        self._atomic_write(p, data)


# ---------------------------------------------------------------------------
# S3-compatible bucket
# ---------------------------------------------------------------------------
class S3Storage(Storage):
    kind = "s3"

    def __init__(self, bucket: str, endpoint_url: str = "", region: str = "auto", access_key_id: str = "",
                 secret_access_key: str = "", prefix: str = "", static_api: bool = False,
                 addressing_style: str = "path"):
        try:
            import boto3
            from botocore.config import Config as BotoConfig
            from botocore.exceptions import ClientError
        except ImportError as e:
            raise StorageError("storage kind 's3' needs boto3: pip install boto3") from e
        if not bucket:
            raise StorageError("[storage] bucket is empty")
        self._ClientError = ClientError
        self.bucket = bucket
        self.prefix = prefix
        self.static_api = static_api
        self.endpoint_url = endpoint_url
        kw: dict[str, Any] = {"retries": {"max_attempts": 5, "mode": "standard"},
                              "s3": {"addressing_style": addressing_style}, "signature_version": "s3v4"}
        # botocore 1.36+ adds CRC checksums to every upload by default, which
        # some S3-compatible stores refuse; only when an operation needs one.
        try:
            boto_cfg = BotoConfig(**kw, request_checksum_calculation="when_required",
                                  response_checksum_validation="when_required")
        except TypeError:
            boto_cfg = BotoConfig(**kw)
        self.s3 = boto3.client("s3", endpoint_url=endpoint_url or None, region_name=region or "auto",
                               aws_access_key_id=access_key_id or None,
                               aws_secret_access_key=secret_access_key or None, config=boto_cfg)
        self._staging = Path(tempfile.gettempdir()) / "weatherts-relay-staging"
        self._staging.mkdir(parents=True, exist_ok=True)

    def describe(self) -> str:
        where = self.endpoint_url or "aws"
        return f"s3 {where} bucket={self.bucket} prefix={self.prefix or '(none)'}"

    def _missing(self, e: Exception) -> bool:
        if not isinstance(e, self._ClientError):
            return False
        code = str(e.response.get("Error", {}).get("Code", ""))
        status = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        return code in ("404", "NoSuchKey", "NotFound") or status == 404

    def staging_dir(self) -> Path:
        return self._staging

    def commit(self, key: str, tmp: Path, size: int) -> None:
        got = tmp.stat().st_size
        if got != size:
            raise StorageError(f"{key}: staging file has {got} bytes, expected {size}")
        k = self.object_key(key)
        try:
            self.s3.upload_file(str(tmp), self.bucket, k,
                                ExtraArgs={"ContentType": OCTET, "CacheControl": IMMUTABLE})
            head = self.s3.head_object(Bucket=self.bucket, Key=k)
        except Exception as e:
            raise StorageError(f"upload {k}: {e}") from e
        if int(head.get("ContentLength", -1)) != size:
            try:
                self.s3.delete_object(Bucket=self.bucket, Key=k)
            except Exception:
                pass
            raise StorageError(f"{k}: stored size {head.get('ContentLength')} differs from {size}")

    def size(self, key: str) -> Optional[int]:
        try:
            return int(self.s3.head_object(Bucket=self.bucket, Key=self.object_key(key))["ContentLength"])
        except Exception as e:
            if self._missing(e):
                return None
            raise StorageError(str(e)) from e

    def open_stream(self, key: str) -> Optional[tuple[Iterator[bytes], int]]:
        try:
            obj = self.s3.get_object(Bucket=self.bucket, Key=self.object_key(key))
        except Exception as e:
            if self._missing(e):
                return None
            raise StorageError(str(e)) from e
        body = obj["Body"]

        def chunks() -> Iterator[bytes]:
            try:
                yield from body.iter_chunks(1 << 16)
            finally:
                body.close()
        return chunks(), int(obj["ContentLength"])

    def _objects(self, prefix: str) -> Iterator[dict[str, Any]]:
        pages = self.s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix)
        for page in pages:
            yield from page.get("Contents", []) or []

    def _keys(self, prefix: str) -> Iterator[tuple[str, int]]:
        for o in self._objects(prefix):
            yield o["Key"], int(o.get("Size", 0))

    def delete_volume(self, radar: str, stamp: str) -> int:
        if not (RADAR_ID_RE.match(radar) and STAMP_RE.match(stamp)):
            raise StorageError(f"not a volume: {radar}/{stamp}")
        keys = [k for k, _ in self._keys(self.object_key(f"{radar}/{stamp}/"))]
        for i in range(0, len(keys), 1000):
            batch = [{"Key": k} for k in keys[i:i + 1000]]
            r = self.s3.delete_objects(Bucket=self.bucket, Delete={"Objects": batch, "Quiet": True})
            if r.get("Errors"):
                raise StorageError(f"delete {radar}/{stamp}: {r['Errors'][:3]}")
        return len(keys)

    def list_files(self) -> Iterator[tuple[str, str, str, int, Optional[float]]]:
        for o in self._objects(self.prefix):
            parts = split_key(o["Key"][len(self.prefix):])
            if parts:
                mod = o.get("LastModified")         # a datetime from boto3
                try:
                    mtime = float(mod.timestamp()) if mod is not None else None
                except (AttributeError, TypeError, ValueError, OverflowError):
                    mtime = None
                yield (*parts, int(o.get("Size", 0)), mtime)

    def read_meta(self, key: str = INDEX_KEY) -> Optional[bytes]:
        try:
            return self.s3.get_object(Bucket=self.bucket, Key=self.object_key(key))["Body"].read()
        except Exception as e:
            if self._missing(e):
                return None
            raise StorageError(str(e)) from e

    def read_meta_if_changed(self, key: str, token: Any) -> tuple[Optional[bytes], Any]:
        kw: dict[str, Any] = {"Bucket": self.bucket, "Key": self.object_key(key)}
        if token:
            kw["IfNoneMatch"] = token
        try:
            obj = self.s3.get_object(**kw)
        except Exception as e:
            if isinstance(e, self._ClientError):
                status = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
                if status == 304 or str(e.response.get("Error", {}).get("Code")) == "304":
                    return None, token
            if self._missing(e):
                return None, None
            raise StorageError(str(e)) from e
        return obj["Body"].read(), obj.get("ETag")

    def write_meta(self, key: str, data: bytes) -> None:
        self.s3.put_object(Bucket=self.bucket, Key=self.object_key(key), Body=data,
                           ContentType="application/json", CacheControl="no-cache")

    def put_public(self, abs_key: str, data: bytes, content_type: str, cache_control: str) -> None:
        self.s3.put_object(Bucket=self.bucket, Key=abs_key, Body=data, ContentType=content_type,
                           CacheControl=cache_control)


def make_storage(cfg: Config) -> Storage:
    st = cfg.storage
    prefix = str(st.get("prefix") or "")
    static_api = bool(st.get("static_api", False))
    if st.get("kind", "local") == "s3":
        return S3Storage(bucket=str(st.get("bucket", "")), endpoint_url=str(st.get("endpoint_url", "") or ""),
                         region=str(st.get("region", "auto") or "auto"),
                         access_key_id=str(st.get("access_key_id", "") or ""),
                         secret_access_key=str(st.get("secret_access_key", "") or ""),
                         prefix=prefix, static_api=static_api,
                         addressing_style=str(st.get("addressing_style", "path")))
    return LocalStorage(cfg.resolve_path(str(st.get("path", "./data"))), prefix=prefix, static_api=static_api)
