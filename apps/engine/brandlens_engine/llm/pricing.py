"""Per-model token pricing -> `cost_usd`.

Cost accounting is a product requirement, not telemetry: the budget guard
degrades a run to deterministic-only when a ceiling is breached, and the control
plane bills against `costUsd`. Prices are USD per **million** tokens and are
matched by longest prefix so a dated model id (`claude-sonnet-4-5-20250929`)
resolves without a new table entry every release.

Unknown models fall back to a conservative default rather than 0 — under-
reporting cost is worse than over-reporting it, because a silent zero disables
the budget guard entirely.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ModelPrice:
    input_per_mtok: float
    output_per_mtok: float
    #: Cache *reads* are heavily discounted; cache writes carry a premium.
    cached_input_per_mtok: float | None = None
    cache_write_per_mtok: float | None = None

    def resolved_cached_input(self) -> float:
        return self.cached_input_per_mtok if self.cached_input_per_mtok is not None else self.input_per_mtok * 0.1

    def resolved_cache_write(self) -> float:
        return self.cache_write_per_mtok if self.cache_write_per_mtok is not None else self.input_per_mtok * 1.25


# Longest-prefix match. Keep sorted-by-specificity within each family.
PRICES: dict[str, ModelPrice] = {
    # --- Anthropic ---
    "claude-opus-4": ModelPrice(15.0, 75.0, 1.5, 18.75),
    "claude-sonnet-4": ModelPrice(3.0, 15.0, 0.3, 3.75),
    "claude-haiku-4": ModelPrice(1.0, 5.0, 0.1, 1.25),
    "claude-3-7-sonnet": ModelPrice(3.0, 15.0, 0.3, 3.75),
    "claude-3-5-sonnet": ModelPrice(3.0, 15.0, 0.3, 3.75),
    "claude-3-5-haiku": ModelPrice(0.8, 4.0, 0.08, 1.0),
    "claude-3-opus": ModelPrice(15.0, 75.0, 1.5, 18.75),
    "claude-3-haiku": ModelPrice(0.25, 1.25, 0.03, 0.3),
    "claude-": ModelPrice(3.0, 15.0, 0.3, 3.75),
    # --- OpenAI ---
    "gpt-4o-mini": ModelPrice(0.15, 0.6, 0.075),
    "gpt-4o": ModelPrice(2.5, 10.0, 1.25),
    "gpt-4.1-mini": ModelPrice(0.4, 1.6, 0.1),
    "gpt-4.1-nano": ModelPrice(0.1, 0.4, 0.025),
    "gpt-4.1": ModelPrice(2.0, 8.0, 0.5),
    "gpt-4-turbo": ModelPrice(10.0, 30.0),
    "gpt-4": ModelPrice(30.0, 60.0),
    "gpt-5-mini": ModelPrice(0.25, 2.0, 0.025),
    "gpt-5": ModelPrice(1.25, 10.0, 0.125),
    "o4-mini": ModelPrice(1.1, 4.4, 0.275),
    "o3-mini": ModelPrice(1.1, 4.4, 0.55),
    "o3": ModelPrice(2.0, 8.0, 0.5),
    "gpt-3.5": ModelPrice(0.5, 1.5),
    # --- Google ---
    "gemini-2.5-pro": ModelPrice(1.25, 10.0, 0.31),
    "gemini-2.5-flash-lite": ModelPrice(0.1, 0.4, 0.025),
    "gemini-2.5-flash": ModelPrice(0.3, 2.5, 0.075),
    "gemini-2.0-flash": ModelPrice(0.1, 0.4, 0.025),
    "gemini-1.5-pro": ModelPrice(1.25, 5.0, 0.3125),
    "gemini-1.5-flash": ModelPrice(0.075, 0.3, 0.01875),
    "gemini-": ModelPrice(1.25, 5.0),
    # --- Embeddings ---
    "text-embedding-3-large": ModelPrice(0.13, 0.0),
    "text-embedding-3-small": ModelPrice(0.02, 0.0),
    # --- Self-hosted / OpenAI-compatible: electricity, not licence fees.
    "local": ModelPrice(0.0, 0.0, 0.0, 0.0),
    "ollama": ModelPrice(0.0, 0.0, 0.0, 0.0),
    "vllm": ModelPrice(0.0, 0.0, 0.0, 0.0),
}

#: Used when nothing matches. Deliberately mid-market, never zero.
DEFAULT_PRICE = ModelPrice(3.0, 15.0)


def price_for(model: str) -> ModelPrice:
    key = (model or "").strip().lower()
    best: tuple[int, ModelPrice] | None = None
    for prefix, price in PRICES.items():
        if key.startswith(prefix) and (best is None or len(prefix) > best[0]):
            best = (len(prefix), price)
    return best[1] if best else DEFAULT_PRICE


def estimate_cost(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cached_input_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> float:
    """USD for one call. `input_tokens` excludes the cached/written portions."""
    p = price_for(model)
    total = (
        max(0, input_tokens) * p.input_per_mtok
        + max(0, output_tokens) * p.output_per_mtok
        + max(0, cached_input_tokens) * p.resolved_cached_input()
        + max(0, cache_write_tokens) * p.resolved_cache_write()
    ) / 1_000_000.0
    return round(total, 8)


def approx_tokens(text: str) -> int:
    """~4 chars/token. Only used when a provider returns no usage block."""
    return max(1, len(text or "") // 4)


def approx_image_tokens(width: int, height: int) -> int:
    """Anthropic's published (w*h)/750 heuristic; close enough for budgeting on
    every vendor, and it is only a fallback when usage is absent."""
    return max(1, int(width * height / 750))


__all__ = [
    "DEFAULT_PRICE",
    "PRICES",
    "ModelPrice",
    "approx_image_tokens",
    "approx_tokens",
    "estimate_cost",
    "price_for",
]
