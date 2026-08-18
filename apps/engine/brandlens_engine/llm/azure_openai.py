"""Azure OpenAI.

Same wire format as OpenAI, different routing: the model name is a *deployment*
name in the path and auth is `api-key`, not a bearer token. Enterprise tenants
overwhelmingly land here, so it is a first-class provider rather than a variant
of `openai-compatible`.
"""

from __future__ import annotations

from .openai import OpenAIProvider


class AzureOpenAIProvider(OpenAIProvider):
    name = "azure-openai"

    def __init__(
        self,
        model: str,
        api_key: str,
        endpoint: str,
        api_version: str = "2024-10-21",
        timeout: float = 90.0,
        max_attempts: int = 3,
    ) -> None:
        super().__init__(
            model=model,
            api_key=api_key,
            timeout=timeout,
            max_attempts=max_attempts,
            base_url=endpoint.rstrip("/"),
        )
        self.api_version = api_version
        self.deployment = model

    def _headers(self) -> dict[str, str]:
        return {"api-key": self.api_key, "content-type": "application/json"}

    def _endpoint(self) -> str:
        return (
            f"{self.base_url}/openai/deployments/{self.deployment}"
            f"/chat/completions?api-version={self.api_version}"
        )


__all__ = ["AzureOpenAIProvider"]
