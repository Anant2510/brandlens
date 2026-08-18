"""Anthropic Messages API."""

from __future__ import annotations

import base64
from typing import Any

from .base import Completion, LLMError, LLMProvider, Usage, with_retries

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"


class AnthropicProvider(LLMProvider):
    name = "anthropic"

    def __init__(
        self,
        model: str,
        api_key: str,
        timeout: float = 90.0,
        max_attempts: int = 3,
        base_url: str = API_URL,
    ) -> None:
        super().__init__(model=model, api_key=api_key, timeout=timeout, max_attempts=max_attempts)
        self.base_url = base_url

    def _headers(self) -> dict[str, str]:
        return {
            "x-api-key": self.api_key,
            "anthropic-version": API_VERSION,
            "content-type": "application/json",
        }

    def _system_blocks(self, system: str, enable_cache: bool) -> list[dict[str, Any]]:
        if not system:
            return []
        block: dict[str, Any] = {"type": "text", "text": system}
        if enable_cache:
            # The system block holds the brand ontology + rubric + exemplars and
            # is byte-identical across every criterion for one brand, so it is
            # exactly what the cache breakpoint is for.
            block["cache_control"] = {"type": "ephemeral"}
        return [block]

    @staticmethod
    def _usage(payload: dict[str, Any]) -> Usage:
        u = payload.get("usage") or {}
        return Usage(
            input_tokens=int(u.get("input_tokens", 0) or 0),
            output_tokens=int(u.get("output_tokens", 0) or 0),
            cached_input_tokens=int(u.get("cache_read_input_tokens", 0) or 0),
            cache_write_tokens=int(u.get("cache_creation_input_tokens", 0) or 0),
        )

    @staticmethod
    def _text(payload: dict[str, Any]) -> str:
        return "".join(
            block.get("text", "")
            for block in payload.get("content", [])
            if isinstance(block, dict) and block.get("type") == "text"
        )

    def _run(self, payload: dict[str, Any], system: str, prompt: str) -> Completion:
        import time

        started = time.perf_counter()

        @with_retries(self.max_attempts)
        def _call() -> dict[str, Any]:
            return self._post(self.base_url, self._headers(), payload)

        try:
            data = _call()
        except LLMError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise LLMError(f"anthropic call failed: {exc}") from exc

        return self._finalize(
            text=self._text(data),
            usage=self._usage(data),
            started=started,
            system=system,
            prompt=prompt,
            finish_reason=data.get("stop_reason"),
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
        payload: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "system": self._system_blocks(system, enable_cache),
            "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
        }
        if stop:
            payload["stop_sequences"] = stop
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
            content.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": base64.b64encode(img).decode("ascii"),
                    },
                }
            )
        # Text after the image: the question should be the last thing the model
        # reads, and the image is the variable half that must not be cached.
        content.append({"type": "text", "text": prompt})
        payload: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "system": self._system_blocks(system, enable_cache),
            "messages": [{"role": "user", "content": content}],
        }
        return self._run(payload, system, prompt)


__all__ = ["AnthropicProvider"]
