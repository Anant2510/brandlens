"""Structured JSON logging.

Every log line carries `request_id` so a single control-plane job can be traced
through the engine without correlating on timestamps. structlog contextvars are
used rather than passing a logger around because analyzers are called from deep
inside the pipeline and threading a logger through every signature would bloat
the analyzer contract for no benefit.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

import structlog
from structlog.contextvars import bind_contextvars, clear_contextvars

_CONFIGURED = False


def configure_logging(level: str = "info", json_output: bool = True) -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return

    numeric = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=numeric)
    # uvicorn installs its own handlers; keep them but let structlog own format.
    for noisy in ("uvicorn.access", "httpx", "httpcore", "PIL"):
        logging.getLogger(noisy).setLevel(max(numeric, logging.WARNING))

    processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]
    processors.append(
        structlog.processors.JSONRenderer() if json_output else structlog.dev.ConsoleRenderer()
    )

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(numeric),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )
    _CONFIGURED = True


def get_logger(name: str = "brandlens.engine") -> structlog.stdlib.BoundLogger:
    if not _CONFIGURED:
        configure_logging()
    return structlog.get_logger(name)  # type: ignore[no-any-return]


def bind_request(request_id: str, **extra: object) -> None:
    clear_contextvars()
    bind_contextvars(request_id=request_id, **extra)


def clear_request() -> None:
    clear_contextvars()


__all__ = ["configure_logging", "get_logger", "bind_request", "clear_request"]
