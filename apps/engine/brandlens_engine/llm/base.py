"""Provider-agnostic LLM interface.

`system` is always the *static* half of the prompt (role, brand ontology,
rubric, exemplars) and `prompt` the *variable* half (this asset's measurements).
Providers that support prompt caching mark the system block cacheable, which is
why the split is part of the interface rather than an implementation detail:
with self-consistency k=5 and a 4k-token brand ontology, cache hits are the
difference between a viable per-asset cost and an unusable one.
"""

from __future__ import annotations

import abc
import hashlib
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
from tenacity import (
    RetryCallState,
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

from ..logging import get_logger
from .pricing import approx_tokens, estimate_cost

log = get_logger(__name__)


class LLMError(RuntimeError):
    """Any provider failure. Callers degrade to `insufficient_evidence`."""

    def __init__(self, message: str, *, retryable: bool = False, status: int | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status


class LLMRetryable(LLMError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message, retryable=True, status=status)


@dataclass(slots=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cached_input_tokens: int = 0
    cache_write_tokens: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "cachedInputTokens": self.cached_input_tokens,
            "cacheWriteTokens": self.cache_write_tokens,
        }


@dataclass(slots=True)
class Completion:
    text: str
    usage: Usage = field(default_factory=Usage)
    cost_usd: float = 0.0
    model: str = ""
    provider: str = ""
    latency_ms: float = 0.0
    finish_reason: str | None = None
    raw: dict[str, Any] | None = None


def _log_retry(state: RetryCallState) -> None:
    log.warning(
        "llm_retry",
        attempt=state.attempt_number,
        error=str(state.outcome.exception()) if state.outcome else None,
    )


def with_retries(max_attempts: int):  # noqa: ANN201 - tenacity's decorator type is unwieldy
    """Retry only on transport/5xx/429. A 400 means a malformed prompt and
    retrying it just burns budget on the same failure."""
    return retry(
        retry=retry_if_exception_type((LLMRetryable, httpx.TimeoutException, httpx.TransportError)),
        stop=stop_after_attempt(max(1, max_attempts)),
        wait=wait_exponential_jitter(initial=0.6, max=12.0),
        before_sleep=_log_retry,
        reraise=True,
    )


def classify_http_error(status: int, body: str) -> LLMError:
    snippet = (body or "")[:400]
    if status in (408, 409, 429) or status >= 500:
        return LLMRetryable(f"provider HTTP {status}: {snippet}", status=status)
    return LLMError(f"provider HTTP {status}: {snippet}", status=status)


class LLMProvider(abc.ABC):
    """One vendor. Implementations must never raise anything but `LLMError`."""

    name: str = "base"

    def __init__(self, model: str, api_key: str = "", timeout: float = 90.0, max_attempts: int = 3) -> None:
        self.model = model
        self.api_key = api_key
        self.timeout = timeout
        self.max_attempts = max_attempts

    # -- interface ----------------------------------------------------------
    @abc.abstractmethod
    def complete(
        self,
        system: str,
        prompt: str,
        temperature: float = 0.0,
        max_tokens: int = 1024,
        enable_cache: bool = True,
        stop: list[str] | None = None,
    ) -> Completion: ...

    @abc.abstractmethod
    def complete_vision(
        self,
        system: str,
        prompt: str,
        images: list[bytes],
        temperature: float = 0.0,
        max_tokens: int = 1024,
        enable_cache: bool = True,
        media_type: str = "image/png",
    ) -> Completion: ...

    # -- shared helpers -----------------------------------------------------
    def supports_vision(self) -> bool:
        return True

    def prompt_hash(self, system: str, prompt: str) -> str:
        return hashlib.sha256(f"{self.name}|{self.model}|{system}|{prompt}".encode()).hexdigest()[:16]

    def _client(self) -> httpx.Client:
        return httpx.Client(timeout=httpx.Timeout(self.timeout, connect=15.0))

    def _post(self, url: str, headers: dict[str, str], payload: dict[str, Any]) -> dict[str, Any]:
        try:
            with self._client() as client:
                resp = client.post(url, headers=headers, json=payload)
        except (httpx.TimeoutException, httpx.TransportError):
            raise
        except Exception as exc:  # noqa: BLE001
            raise LLMError(f"{self.name} request failed: {exc}") from exc
        if resp.status_code >= 400:
            raise classify_http_error(resp.status_code, resp.text)
        try:
            return dict(resp.json())
        except ValueError as exc:
            raise LLMError(f"{self.name} returned non-JSON body") from exc

    def _finalize(
        self,
        text: str,
        usage: Usage,
        started: float,
        system: str = "",
        prompt: str = "",
        finish_reason: str | None = None,
        raw: dict[str, Any] | None = None,
    ) -> Completion:
        if usage.input_tokens == 0 and usage.cached_input_tokens == 0:
            usage.input_tokens = approx_tokens(system) + approx_tokens(prompt)
        if usage.output_tokens == 0:
            usage.output_tokens = approx_tokens(text)
        return Completion(
            text=text,
            usage=usage,
            cost_usd=estimate_cost(
                self.model,
                usage.input_tokens,
                usage.output_tokens,
                usage.cached_input_tokens,
                usage.cache_write_tokens,
            ),
            model=self.model,
            provider=self.name,
            latency_ms=round((time.perf_counter() - started) * 1000.0, 2),
            finish_reason=finish_reason,
            raw=raw,
        )


class NullProvider(LLMProvider):
    """Stands in when no key is configured.

    It raises rather than returning a plausible answer: an unconfigured judge
    must surface as `insufficient_evidence`, never as a pass.
    """

    name = "none"

    def __init__(self, reason: str = "no LLM provider configured") -> None:
        super().__init__(model="none")
        self.reason = reason

    def supports_vision(self) -> bool:
        return False

    def complete(self, system: str, prompt: str, temperature: float = 0.0, max_tokens: int = 1024,
                 enable_cache: bool = True, stop: list[str] | None = None) -> Completion:
        raise LLMError(self.reason)

    def complete_vision(self, system: str, prompt: str, images: list[bytes], temperature: float = 0.0,
                        max_tokens: int = 1024, enable_cache: bool = True,
                        media_type: str = "image/png") -> Completion:
        raise LLMError(self.reason)


__all__ = [
    "Completion",
    "LLMError",
    "LLMProvider",
    "LLMRetryable",
    "NullProvider",
    "Usage",
    "classify_http_error",
    "with_retries",
]
