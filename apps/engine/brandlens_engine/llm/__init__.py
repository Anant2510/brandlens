"""Model-agnostic LLM/VLM access.

BrandLens is deliberately not tied to one vendor: the judge should be a
different model family from whatever generated the asset, or self-preference
bias inflates every score. That is a configuration decision, so the provider
layer is a thin, uniform interface and nothing above it knows the vendor.
"""

from .base import Completion, LLMError, LLMProvider, Usage
from .factory import build_provider, provider_status
from .pricing import estimate_cost, price_for

__all__ = [
    "Completion",
    "LLMError",
    "LLMProvider",
    "Usage",
    "build_provider",
    "estimate_cost",
    "price_for",
    "provider_status",
]
