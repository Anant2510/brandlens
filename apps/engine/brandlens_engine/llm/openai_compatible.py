"""OpenAI-compatible endpoints: vLLM, Ollama, LM Studio, Together, OpenRouter.

The escape hatch that keeps BrandLens deployable inside a bank: point
`OPENAI_COMPATIBLE_BASE_URL` at a self-hosted model and no asset bytes leave the
customer's network. Pricing resolves to zero for known local runtimes, so the
budget guard measures *tokens* there instead of dollars.
"""

from __future__ import annotations

from .openai import OpenAIProvider


class OpenAICompatibleProvider(OpenAIProvider):
    name = "openai-compatible"

    def __init__(
        self,
        model: str,
        api_key: str,
        base_url: str,
        timeout: float = 120.0,
        max_attempts: int = 3,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        if not base_url:
            raise ValueError("OPENAI_COMPATIBLE_BASE_URL is required for the openai-compatible provider")
        # Local runtimes are usually slower per token than a hosted API; the
        # default timeout here is deliberately more generous.
        super().__init__(
            model=model,
            api_key=api_key,
            timeout=timeout,
            max_attempts=max_attempts,
            base_url=base_url,
            extra_headers=extra_headers,
        )

    def supports_vision(self) -> bool:
        # Unknowable in advance — many local servers are text-only. The judge
        # catches the failure and degrades that criterion rather than the run.
        return True


__all__ = ["OpenAICompatibleProvider"]
