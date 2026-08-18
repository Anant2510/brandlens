"""Engine configuration.

Reads the single repo-root `.env` shared by every BrandLens service (see
`.env.example`). We deliberately do NOT invent engine-only env var names: the
control plane and the engine must agree on `ENGINE_SHARED_SECRET`,
`LLM_JUDGE_*`, `OCR_DRIVER` and the cost ceilings, so they read the same keys
from the same file.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

OcrDriver = Literal["vlm", "tesseract", "paddle", "none"]
ProviderName = Literal["anthropic", "openai", "azure-openai", "google", "openai-compatible", "none"]


def _repo_root() -> Path:
    """apps/engine/brandlens_engine/config.py -> repo root."""
    return Path(__file__).resolve().parents[3]


def _env_files() -> tuple[str, ...]:
    """`.env` wins over `.env.example`; a local override wins over both.

    pydantic-settings applies later files with higher precedence.
    """
    root = _repo_root()
    candidates = [root / ".env.example", root / ".env", Path.cwd() / ".env"]
    return tuple(str(p) for p in candidates if p.is_file())


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_env_files(),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- service ------------------------------------------------------------
    node_env: str = Field(default="development", alias="NODE_ENV")
    log_level: str = Field(default="info", alias="LOG_LEVEL")
    engine_port: int = Field(default=8000, alias="ENGINE_PORT")
    engine_host: str = Field(default="0.0.0.0", alias="API_HOST")
    engine_shared_secret: str = Field(default="", alias="ENGINE_SHARED_SECRET")
    engine_timeout_ms: int = Field(default=180_000, alias="ENGINE_TIMEOUT_MS")

    # --- storage / scratch --------------------------------------------------
    # The engine only ever writes under these two roots. Nothing else on the
    # filesystem is touched, which keeps the Windows deployment auditable.
    storage_local_root: str = Field(default="./.storage", alias="STORAGE_LOCAL_ROOT")
    engine_temp_dir: str = Field(default="", alias="ENGINE_TEMP_DIR")
    engine_derivatives_dir: str = Field(default="", alias="ENGINE_DERIVATIVES_DIR")
    engine_disk_cache_mb: int = Field(default=512, alias="ENGINE_DISK_CACHE_MB")

    # --- LLM providers ------------------------------------------------------
    llm_judge_provider: str = Field(default="anthropic", alias="LLM_JUDGE_PROVIDER")
    llm_judge_model: str = Field(default="claude-sonnet-4-5-20250929", alias="LLM_JUDGE_MODEL")
    llm_extract_provider: str = Field(default="anthropic", alias="LLM_EXTRACT_PROVIDER")
    llm_extract_model: str = Field(default="claude-sonnet-4-5-20250929", alias="LLM_EXTRACT_MODEL")
    llm_text_provider: str = Field(default="anthropic", alias="LLM_TEXT_PROVIDER")
    llm_text_model: str = Field(default="claude-sonnet-4-5-20250929", alias="LLM_TEXT_MODEL")

    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
    azure_openai_api_key: str = Field(default="", alias="AZURE_OPENAI_API_KEY")
    azure_openai_endpoint: str = Field(default="", alias="AZURE_OPENAI_ENDPOINT")
    azure_openai_api_version: str = Field(default="2024-10-21", alias="AZURE_OPENAI_API_VERSION")
    google_api_key: str = Field(default="", alias="GOOGLE_API_KEY")
    openai_compatible_base_url: str = Field(default="", alias="OPENAI_COMPATIBLE_BASE_URL")
    openai_compatible_api_key: str = Field(default="", alias="OPENAI_COMPATIBLE_API_KEY")

    llm_timeout_s: float = Field(default=90.0, alias="LLM_TIMEOUT_S")
    llm_max_attempts: int = Field(default=3, alias="LLM_MAX_ATTEMPTS")

    # --- embeddings ---------------------------------------------------------
    embedding_provider: str = Field(default="hash", alias="EMBEDDING_PROVIDER")
    embedding_model: str = Field(default="text-embedding-3-small", alias="EMBEDDING_MODEL")
    embedding_dim: int = Field(default=1024, alias="EMBEDDING_DIM")
    image_embedding_provider: str = Field(default="hash", alias="IMAGE_EMBEDDING_PROVIDER")
    image_embedding_dim: int = Field(default=1024, alias="IMAGE_EMBEDDING_DIM")

    # --- judge --------------------------------------------------------------
    judge_temperature: float = Field(default=0.0, alias="JUDGE_TEMPERATURE")
    judge_self_consistency_k: int = Field(default=1, alias="JUDGE_SELF_CONSISTENCY_K")
    judge_escalate_k: int = Field(default=3, alias="JUDGE_SELF_CONSISTENCY_ESCALATE_K")
    judge_precedent_k: int = Field(default=6, alias="JUDGE_PRECEDENT_K")
    judge_max_image_edge: int = Field(default=1568, alias="JUDGE_MAX_IMAGE_EDGE")
    judge_abstain_confidence: float = Field(default=0.55, alias="JUDGE_ABSTAIN_CONFIDENCE")
    judge_enable_prompt_cache: bool = Field(default=True, alias="JUDGE_ENABLE_PROMPT_CACHE")
    # Self-consistency samples need spread to be informative; a k>1 vote at T=0
    # is k identical samples and a meaningless entropy of 0.
    judge_sampling_temperature: float = Field(default=0.7, alias="JUDGE_SAMPLING_TEMPERATURE")

    # --- cost ---------------------------------------------------------------
    cost_tenant_daily_usd_limit: float = Field(default=25.0, alias="COST_TENANT_DAILY_USD_LIMIT")
    cost_job_usd_limit: float = Field(default=2.5, alias="COST_JOB_USD_LIMIT")
    cost_degrade_gracefully: bool = Field(default=True, alias="COST_DEGRADE_GRACEFULLY")

    # --- OCR ----------------------------------------------------------------
    ocr_driver: OcrDriver = Field(default="vlm", alias="OCR_DRIVER")
    tesseract_cmd: str = Field(default="", alias="TESSERACT_CMD")

    @field_validator("ocr_driver", mode="before")
    @classmethod
    def _normalize_ocr(cls, v: object) -> object:
        if not v:
            return "none"
        s = str(v).strip().lower()
        # `paddle` is configurable in .env for other deployments but PaddleOCR
        # is a forbidden dependency here; degrade rather than crash at boot.
        return s if s in {"vlm", "tesseract", "paddle", "none"} else "none"

    @field_validator("judge_enable_prompt_cache", "cost_degrade_gracefully", mode="before")
    @classmethod
    def _coerce_bool(cls, v: object) -> object:
        if isinstance(v, str):
            return v.strip().lower() in {"1", "true", "yes", "on"}
        return v

    # --- derived paths ------------------------------------------------------
    @property
    def storage_root(self) -> Path:
        root = Path(self.storage_local_root)
        if not root.is_absolute():
            root = _repo_root() / root
        return root

    @property
    def temp_dir(self) -> Path:
        p = Path(self.engine_temp_dir) if self.engine_temp_dir else self.storage_root / "engine-tmp"
        return p if p.is_absolute() else _repo_root() / p

    @property
    def derivatives_dir(self) -> Path:
        p = (
            Path(self.engine_derivatives_dir)
            if self.engine_derivatives_dir
            else self.storage_root / "derivatives"
        )
        return p if p.is_absolute() else _repo_root() / p

    def ensure_dirs(self) -> None:
        for p in (self.temp_dir, self.derivatives_dir):
            p.mkdir(parents=True, exist_ok=True)

    def api_key_for(self, provider: str) -> str:
        return {
            "anthropic": self.anthropic_api_key,
            "openai": self.openai_api_key,
            "azure-openai": self.azure_openai_api_key,
            "azure_openai": self.azure_openai_api_key,
            "google": self.google_api_key,
            "openai-compatible": self.openai_compatible_api_key,
        }.get(provider.strip().lower(), "")

    def provider_configured(self, provider: str) -> bool:
        name = provider.strip().lower()
        if name == "openai-compatible":
            # Local servers (Ollama, LM Studio) frequently need no key at all.
            return bool(self.openai_compatible_base_url)
        if name in {"azure-openai", "azure_openai"}:
            return bool(self.azure_openai_api_key and self.azure_openai_endpoint)
        return bool(self.api_key_for(name))


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


def reset_settings_cache() -> None:
    """Test hook — env mutation between tests must not be masked by the cache."""
    get_settings.cache_clear()
    os.environ.pop("_BRANDLENS_SETTINGS_SENTINEL", None)
