"""Google Gemini (generateContent)."""

from __future__ import annotations

import base64
import time
from typing import Any

from .base import Completion, LLMError, LLMProvider, Usage, with_retries

DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


class GoogleProvider(LLMProvider):
    name = "google"

    def __init__(
        self,
        model: str,
        api_key: str,
        timeout: float = 90.0,
        max_attempts: int = 3,
        base_url: str = DEFAULT_BASE_URL,
    ) -> None:
        super().__init__(model=model, api_key=api_key, timeout=timeout, max_attempts=max_attempts)
        self.base_url = base_url.rstrip("/")

    def _endpoint(self) -> str:
        return f"{self.base_url}/models/{self.model}:generateContent"

    def _headers(self) -> dict[str, str]:
        return {"content-type": "application/json", "x-goog-api-key": self.api_key}

    @staticmethod
    def _usage(payload: dict[str, Any]) -> Usage:
        u = payload.get("usageMetadata") or {}
        cached = int(u.get("cachedContentTokenCount", 0) or 0)
        prompt = int(u.get("promptTokenCount", 0) or 0)
        return Usage(
            input_tokens=max(0, prompt - cached),
            output_tokens=int(u.get("candidatesTokenCount", 0) or 0),
            cached_input_tokens=cached,
        )

    @staticmethod
    def _text(payload: dict[str, Any]) -> str:
        out: list[str] = []
        for cand in payload.get("candidates", []) or []:
            for part in (cand.get("content") or {}).get("parts", []) or []:
                if isinstance(part, dict) and "text" in part:
                    out.append(str(part["text"]))
        return "".join(out)

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
            raise LLMError(f"google call failed: {exc}") from exc

        candidates = data.get("candidates") or [{}]
        return self._finalize(
            text=self._text(data),
            usage=self._usage(data),
            started=started,
            system=system,
            prompt=prompt,
            finish_reason=candidates[0].get("finishReason"),
        )

    def _build(self, system: str, parts: list[dict[str, Any]], temperature: float, max_tokens: int) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
        }
        if system:
            # Gemini's implicit caching keys on a stable leading prefix, so the
            # static half goes in systemInstruction and never moves.
            payload["systemInstruction"] = {"parts": [{"text": system}]}
        return payload

    def complete(
        self,
        system: str,
        prompt: str,
        temperature: float = 0.0,
        max_tokens: int = 1024,
        enable_cache: bool = True,
        stop: list[str] | None = None,
    ) -> Completion:
        payload = self._build(system, [{"text": prompt}], temperature, max_tokens)
        if stop:
            payload["generationConfig"]["stopSequences"] = stop
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
        parts: list[dict[str, Any]] = [
            {"inlineData": {"mimeType": media_type, "data": base64.b64encode(img).decode("ascii")}}
            for img in images
        ]
        parts.append({"text": prompt})
        return self._run(self._build(system, parts, temperature, max_tokens), system, prompt)


__all__ = ["GoogleProvider"]
