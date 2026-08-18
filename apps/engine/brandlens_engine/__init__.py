"""BrandLens analysis engine.

Owns measurement and judgment; the TypeScript control plane owns orchestration,
tenancy and persistence. This service is stateless by design: every request
carries the brand ontology, the ruleset and the asset reference it needs.
"""

from __future__ import annotations

ENGINE_VERSION = "1.0.0"
PIPELINE_VERSION = "1.0.0"

__all__ = ["ENGINE_VERSION", "PIPELINE_VERSION"]
