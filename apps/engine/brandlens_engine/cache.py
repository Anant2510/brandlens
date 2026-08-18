"""Content-addressed measurement cache: in-process LRU in front of a disk tier.

Measurement is a pure function of (bytes, analyzer, params). That makes caching
safe and makes re-review cheap — a reviewer re-running a check after a copy
tweak should not pay to re-measure the logo. Keys therefore include the asset
content hash, so a changed file can never hit a stale entry.

The disk tier survives process restarts (the Windows VM restarts the service on
deploy) and is bounded by byte budget with LRU eviction on write.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar

import orjson

from .config import Settings, get_settings
from .logging import get_logger

log = get_logger(__name__)

T = TypeVar("T")


def stable_key(*parts: object) -> str:
    """Deterministic key over arbitrary JSON-able parts.

    `sort_keys` matters: dict ordering differences between two identical
    requests must not produce two cache entries.
    """
    payload = json.dumps(parts, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def measurement_key(content_hash: str, fn: str, params: dict[str, Any] | None = None, version: str = "1") -> str:
    return f"{fn}:{content_hash[:16]}:{stable_key(params or {}, version)[:16]}"


@dataclass(slots=True)
class CacheStats:
    hits: int = 0
    misses: int = 0
    writes: int = 0
    evictions: int = 0

    def as_dict(self) -> dict[str, int]:
        return {"hits": self.hits, "misses": self.misses, "writes": self.writes, "evictions": self.evictions}


class LRUCache:
    """Thread-safe in-process LRU. Values must be picklable-free JSON-ables."""

    def __init__(self, capacity: int = 512) -> None:
        self._data: OrderedDict[str, Any] = OrderedDict()
        self._capacity = max(1, capacity)
        self._lock = threading.RLock()
        self.stats = CacheStats()

    def get(self, key: str) -> Any | None:
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
                self.stats.hits += 1
                return self._data[key]
            self.stats.misses += 1
            return None

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._data[key] = value
            self._data.move_to_end(key)
            self.stats.writes += 1
            while len(self._data) > self._capacity:
                self._data.popitem(last=False)
                self.stats.evictions += 1

    def __contains__(self, key: str) -> bool:
        with self._lock:
            return key in self._data

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


class DiskCache:
    """Bounded JSON blob store under the engine temp dir."""

    def __init__(self, root: Path, max_bytes: int) -> None:
        self.root = root
        self.max_bytes = max(0, max_bytes)
        self._lock = threading.RLock()
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            self.enabled = self.max_bytes > 0
        except OSError as exc:  # read-only volume -> memory tier only
            log.warning("disk_cache_disabled", error=str(exc))
            self.enabled = False

    def _path(self, key: str) -> Path:
        h = hashlib.sha256(key.encode("utf-8")).hexdigest()
        return self.root / h[:2] / f"{h}.json"

    def get(self, key: str) -> Any | None:
        if not self.enabled:
            return None
        p = self._path(key)
        try:
            raw = p.read_bytes()
        except OSError:
            return None
        try:
            os.utime(p, None)  # touch for LRU ordering
        except OSError:
            pass
        try:
            return orjson.loads(raw)
        except orjson.JSONDecodeError:
            try:
                p.unlink()
            except OSError:
                pass
            return None

    def set(self, key: str, value: Any) -> None:
        if not self.enabled:
            return
        p = self._path(key)
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(f".{os.getpid()}.tmp")
            tmp.write_bytes(orjson.dumps(value, option=orjson.OPT_SERIALIZE_NUMPY))
            tmp.replace(p)
        except (OSError, TypeError) as exc:
            log.debug("disk_cache_write_failed", key=key, error=str(exc))
            return
        self._evict_if_needed()

    def _evict_if_needed(self) -> None:
        with self._lock:
            files: list[tuple[float, int, Path]] = []
            total = 0
            for f in self.root.rglob("*.json"):
                try:
                    st = f.stat()
                except OSError:
                    continue
                files.append((st.st_mtime, st.st_size, f))
                total += st.st_size
            if total <= self.max_bytes:
                return
            files.sort(key=lambda t: t[0])
            for _mtime, size, f in files:
                if total <= self.max_bytes * 0.9:
                    break
                try:
                    f.unlink()
                    total -= size
                except OSError:
                    continue


class MeasurementCache:
    """Two-tier cache with a `get_or_compute` façade."""

    def __init__(self, settings: Settings | None = None, memory_capacity: int = 1024) -> None:
        s = settings or get_settings()
        self.memory = LRUCache(memory_capacity)
        self.disk = DiskCache(s.temp_dir / "measure-cache", s.engine_disk_cache_mb * 1024 * 1024)
        self.stats = CacheStats()

    def get(self, key: str) -> Any | None:
        v = self.memory.get(key)
        if v is not None:
            self.stats.hits += 1
            return v
        v = self.disk.get(key)
        if v is not None:
            self.memory.set(key, v)
            self.stats.hits += 1
            return v
        self.stats.misses += 1
        return None

    def set(self, key: str, value: Any) -> None:
        self.memory.set(key, value)
        self.disk.set(key, value)
        self.stats.writes += 1

    def get_or_compute(self, key: str, compute: object) -> Any:
        cached = self.get(key)
        if cached is not None:
            return cached
        t0 = time.perf_counter()
        value = compute()  # type: ignore[operator]
        if value is not None:
            self.set(key, value)
        log.debug("measurement_computed", key=key, ms=round((time.perf_counter() - t0) * 1000, 2))
        return value


_GLOBAL: MeasurementCache | None = None
_GLOBAL_LOCK = threading.Lock()


def get_cache() -> MeasurementCache:
    global _GLOBAL
    with _GLOBAL_LOCK:
        if _GLOBAL is None:
            _GLOBAL = MeasurementCache()
        return _GLOBAL


__all__ = [
    "CacheStats",
    "DiskCache",
    "LRUCache",
    "MeasurementCache",
    "get_cache",
    "measurement_key",
    "stable_key",
]
