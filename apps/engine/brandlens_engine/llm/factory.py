"""Provider construction from configuration."""

from __future__ import annotations

from ..config import Settings, get_settings
from ..logging import get_logger
from .anthropic import AnthropicProvider
from .azure_openai import AzureOpenAIProvider
from .base import LLMProvider, NullProvider
from .google import GoogleProvider
from .openai import OpenAIProvider
from .openai_compatible import OpenAICompatibleProvider

log = get_logger(__name__)

_ALIASES = {
    "azure_openai": "azure-openai",
    "azureopenai": "azure-openai",
    "azure": "azure-openai",
    "gemini": "google",
    "vertex": "google",
    "compatible": "openai-compatible",
    "openai_compatible": "openai-compatible",
    "ollama": "openai-compatible",
    "vllm": "openai-compatible",
    "lmstudio": "openai-compatible",
    "claude": "anthropic",
}


def canonical_provider(name: str) -> str:
    n = (name or "").strip().lower()
    return _ALIASES.get(n, n)


def build_provider(provider: str, model: str, settings: Settings | None = None) -> LLMProvider:
    """Build a provider, or a `NullProvider` that explains why it could not.

    Returning a null object rather than raising is deliberate: an unconfigured
    judge must show up as `insufficient_evidence` on the T2 criteria while the
    T0/T1 criteria still run and return real verdicts.
    """
    s = settings or get_settings()
    name = canonical_provider(provider)
    timeout = s.llm_timeout_s
    attempts = s.llm_max_attempts

    try:
        if name == "anthropic":
            key = s.anthropic_api_key
            if not key:
                return NullProvider("ANTHROPIC_API_KEY is not set")
            return AnthropicProvider(model=model, api_key=key, timeout=timeout, max_attempts=attempts)

        if name == "openai":
            key = s.openai_api_key
            if not key:
                return NullProvider("OPENAI_API_KEY is not set")
            return OpenAIProvider(model=model, api_key=key, timeout=timeout, max_attempts=attempts)

        if name == "azure-openai":
            if not (s.azure_openai_api_key and s.azure_openai_endpoint):
                return NullProvider("AZURE_OPENAI_API_KEY / AZURE_OPENAI_ENDPOINT are not set")
            return AzureOpenAIProvider(
                model=model,
                api_key=s.azure_openai_api_key,
                endpoint=s.azure_openai_endpoint,
                api_version=s.azure_openai_api_version,
                timeout=timeout,
                max_attempts=attempts,
            )

        if name == "google":
            if not s.google_api_key:
                return NullProvider("GOOGLE_API_KEY is not set")
            return GoogleProvider(model=model, api_key=s.google_api_key, timeout=timeout, max_attempts=attempts)

        if name == "openai-compatible":
            if not s.openai_compatible_base_url:
                return NullProvider("OPENAI_COMPATIBLE_BASE_URL is not set")
            return OpenAICompatibleProvider(
                model=model,
                api_key=s.openai_compatible_api_key,
                base_url=s.openai_compatible_base_url,
                timeout=max(timeout, 120.0),
                max_attempts=attempts,
            )

        if name in ("none", ""):
            return NullProvider("provider explicitly disabled")
    except Exception as exc:  # noqa: BLE001 - config errors degrade, never crash boot
        log.warning("provider_build_failed", provider=name, error=str(exc))
        return NullProvider(f"provider {name!r} could not be built: {exc}")

    return NullProvider(f"unknown provider {provider!r}")


def provider_status(settings: Settings | None = None) -> dict[str, dict[str, object]]:
    """Health-endpoint view of the three configured roles."""
    s = settings or get_settings()
    roles = {
        "judge": (s.llm_judge_provider, s.llm_judge_model),
        "extract": (s.llm_extract_provider, s.llm_extract_model),
        "text": (s.llm_text_provider, s.llm_text_model),
    }
    out: dict[str, dict[str, object]] = {}
    for role, (provider, model) in roles.items():
        out[role] = {
            "configured": s.provider_configured(canonical_provider(provider)),
            "provider": canonical_provider(provider),
            "model": model,
        }
    return out


__all__ = ["build_provider", "canonical_provider", "provider_status"]
