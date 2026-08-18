"""OpenAI Chat Completions API (also the base for OpenAI-compatible servers)."""

from __future__ import annotations

import base64
import time
from typing import Any

from .base import Completion, LLMError, LLMProvider, Usage, with_retries

DEFAULT_BASE_URL = "https://api.openai.com/v1"

# Reasoning models reject `temperature` and meter output as `max_completion_tokens`.
_REASONING_PREFIXES = ("o1", "o3", "o4", "gpt-5")


class OpenAIProvider(LLMProvider):
    name = "openai"

    def __init__(
        self,
        model: str,
        api_key: str,
        timeout: float = 90.0,
        max_attempts: int = 3,
        base_url: str = DEFAULT_BASE_URL,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(model=model, api_key=api_key, timeout=timeout, max_attempts=max_attempts)
        self.base_url = base_url.rstrip("/")
        self.extra_headers = extra_headers or {}

    def _headers(self) -> dict[str, str]:
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        headers.update(self.extra_headers)
        return headers

    def _endpoint(self) -> str:
        return f"{self.base_url}/chat/completions"

    def _is_reasoning(self) -> bool:
        m = (self.model or "").lower()
        return any(m.startswith(p) for p in _REASONING_PREFIXES)

    @staticmethod
    def _usage(payload: dict[str, Any]) -> Usage:
        u = payload.get("usage") or {}
        details = u.get("prompt_tokens_details") or {}
        cached = int(details.get("cached_tokens", 0) or 0)
        prompt_tokens = int(u.get("prompt_tokens", 0) or 0)
        return Usage(
            # OpenAI reports cached tokens *inside* prompt_tokens; subtract so
            # the two are not billed twice by `estimate_cost`.
            input_tokens=max(0, prompt_tokens - cached),
            output_tokens=int(u.get("completion_tokens", 0) or 0),
            cached_input_tokens=cached,
        )

    @staticmethod
    def _text(payload: dict[str, Any]) -> str:
        choices = payload.get("choices") or []
        if not choices:
            return ""
        message = choices[0].get("message") or {}
        content = message.get("content")
        if isinstance(content, list):  # some compatible servers return blocks
            return "".join(c.get("text", "") for c in content if isinstance(c, dict))
        return str(content or "")

    def _build(self, system: str, content: list[dict[str, Any]] | str, temperature: float, max_tokens: int) -> dict[str, Any]:
        messages: list[dict[str, Any]] = []
        if system:
            # System first, verbatim and stable — providers key their automatic
            # prefix cache on the leading tokens of the request.
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": content})
        payload: dict[str, Any] = {"model": self.model, "messages": messages}
        if self._is_reasoning():
            payload["max_completion_tokens"] = max_tokens
        else:
            payload["max_tokens"] = max_tokens
            payload["temperature"] = temperature
        return payload

    def _run(self, payload: dict[str, Any], system: str, prompt: str) -> Completion:
        started = time.perf_counter()

        @with_retries(self.max_attempts)
        def _call() -> dict[str, Any]:
            return self._post(self._endpoint(), self._headers(), payload)

        try:
            data = _call()
        except LLMError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise LLMError(f"{self.name} call failed: {exc}") from exc

        choices = data.get("choices") or [{}]
        return self._finalize(
            text=self._text(data),
            usage=self._usage(data),
            started=started,
            system=system,
            prompt=prompt,
            finish_reason=choices[0].get("finish_reason"),
        )

    def complete(
        self,
        system: str,
        prompt: str,
        temperature: float = 0.0,
        max_tokens: int = 1024,
        enable_cache: bool = True,
        stop: list[str] | None = None,
    ) -> Completion:
        payload = self._build(system, prompt, temperature, max_tokens)
        if stop:
            payload["stop"] = stop
        return self._run(payload, system, prompt)

    def complete_vision(
        self,
        system: str,
        prompt: str,
        images: list[bytes],
        temperature: float = 0.0,
        max_tokens: int = 1024,
        enable_cache: bool = True,
        media_type: str = "image/png",
    ) -> Completion:
        content: list[dict[str, Any]] = []
        for img in images:
            b64 = base64.b64encode(img).decode("ascii")
            content.append({"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{b64}"}})
        content.append({"type": "text", "text": prompt})
        return self._run(self._build(system, content, temperature, max_tokens), system, prompt)


__all__ = ["OpenAIProvider"]
