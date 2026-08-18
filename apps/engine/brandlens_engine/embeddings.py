"""Embeddings with a deterministic, dependency-free fallback.

The `hash` provider is the default on purpose. It is a SimHash — random-projection
LSH over character n-grams for text, over per-tile colour/gradient statistics for
images — so it needs no model download, no GPU and no network. That matters
because BrandLens must boot and be *useful* on an air-gapped Windows VM the
moment it is installed.

What `hash` is good for: near-duplicate detection, precedent retrieval, asset
reuse. What it is not good for: semantic similarity. Nothing in the engine asks
it for semantics — the semantic questions go to the VLM, which is the whole
point of the tiering.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Protocol

import numpy as np
from numpy.typing import NDArray

from .config import Settings, get_settings
from .logging import get_logger
from .media import load_image, resize_max_edge

log = get_logger(__name__)

_WORD = re.compile(r"\w+", re.UNICODE)


@dataclass(slots=True)
class EmbeddingResult:
    vectors: list[list[float]]
    provider: str
    dim: int
    cost_usd: float = 0.0
    warnings: list[str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.warnings is None:
            self.warnings = []


class EmbeddingProvider(Protocol):
    name: str
    dim: int

    def embed_texts(self, texts: list[str]) -> EmbeddingResult: ...

    def embed_images(self, uris: list[str]) -> EmbeddingResult: ...


def _normalize(v: NDArray[np.float64]) -> NDArray[np.float64]:
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-12 else v


def _projection_matrix(feature_dim: int, out_dim: int, seed: int = 20240617) -> NDArray[np.float64]:
    """Fixed random projection. The seed is a constant, never `random`: two
    runs of the engine must produce byte-identical vectors or every stored
    similarity in the control plane silently rots."""
    rng = np.random.default_rng(seed)
    return rng.normal(0.0, 1.0 / np.sqrt(out_dim), size=(feature_dim, out_dim))


class HashEmbeddingProvider:
    """SimHash over char n-grams (text) and tile statistics (images)."""

    name = "hash"
    _FEATURE_DIM = 4096

    def __init__(self, dim: int = 1024) -> None:
        self.dim = max(16, int(dim))
        self._proj = _projection_matrix(self._FEATURE_DIM, self.dim)

    # -- text ---------------------------------------------------------------
    def _text_features(self, text: str) -> NDArray[np.float64]:
        feats = np.zeros(self._FEATURE_DIM, dtype=np.float64)
        cleaned = " ".join(_WORD.findall((text or "").lower()))
        if not cleaned:
            return feats
        grams: list[str] = []
        padded = f" {cleaned} "
        for n in (3, 4, 5):
            grams.extend(padded[i : i + n] for i in range(max(0, len(padded) - n + 1)))
        grams.extend(cleaned.split())
        for g in grams:
            h = int.from_bytes(hashlib.blake2b(g.encode("utf-8"), digest_size=8).digest(), "big")
            feats[h % self._FEATURE_DIM] += 1.0
        # Sublinear scaling: a word repeated 50 times should not dominate.
        return np.log1p(feats)

    def embed_texts(self, texts: list[str]) -> EmbeddingResult:
        vectors = [_normalize(self._text_features(t) @ self._proj).tolist() for t in texts]
        return EmbeddingResult(vectors=vectors, provider=self.name, dim=self.dim)

    # -- images -------------------------------------------------------------
    def _image_features(self, rgb: NDArray[np.uint8], grid: int = 8) -> NDArray[np.float64]:
        from .color import rgb_to_lab

        small = resize_max_edge(rgb, 256).astype(np.float64)
        h, w = small.shape[:2]
        lab = rgb_to_lab(small.reshape(-1, 3)).reshape(h, w, 3)
        gray = small[..., :3] @ np.array([0.2126, 0.7152, 0.0722])
        gy, gx = np.gradient(gray)
        energy = np.hypot(gx, gy)

        cells: list[float] = []
        for iy in range(grid):
            for ix in range(grid):
                y0, y1 = int(iy * h / grid), int((iy + 1) * h / grid)
                x0, x1 = int(ix * w / grid), int((ix + 1) * w / grid)
                tile = lab[y0:y1, x0:x1].reshape(-1, 3)
                e = energy[y0:y1, x0:x1]
                if tile.size == 0:
                    cells.extend([0.0] * 6)
                    continue
                cells.extend(
                    [
                        float(tile[:, 0].mean()) / 100.0,
                        float(tile[:, 1].mean()) / 128.0,
                        float(tile[:, 2].mean()) / 128.0,
                        float(tile[:, 0].std()) / 50.0,
                        float(e.mean()) / 64.0,
                        float(e.std()) / 64.0,
                    ]
                )
        raw = np.asarray(cells, dtype=np.float64)
        feats = np.zeros(self._FEATURE_DIM, dtype=np.float64)
        feats[: min(raw.size, self._FEATURE_DIM)] = raw[: self._FEATURE_DIM]
        return feats

    def embed_image_arrays(self, images: list[NDArray[np.uint8]]) -> EmbeddingResult:
        vectors = [_normalize(self._image_features(img) @ self._proj).tolist() for img in images]
        return EmbeddingResult(vectors=vectors, provider=self.name, dim=self.dim)

    def embed_images(self, uris: list[str]) -> EmbeddingResult:
        arrays: list[NDArray[np.uint8]] = []
        warnings: list[str] = []
        for uri in uris:
            try:
                arrays.append(load_image(uri).rgb)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"could not load {uri}: {exc}")
                arrays.append(np.zeros((8, 8, 3), dtype=np.uint8))
        result = self.embed_image_arrays(arrays)
        result.warnings = warnings
        return result


class OpenAIEmbeddingProvider:
    """Real text embeddings when the tenant has configured a key."""

    name = "openai"

    def __init__(self, api_key: str, model: str, dim: int, base_url: str = "https://api.openai.com/v1") -> None:
        self.api_key = api_key
        self.model = model
        self.dim = dim
        self.base_url = base_url.rstrip("/")

    def embed_texts(self, texts: list[str]) -> EmbeddingResult:
        import httpx

        if not texts:
            return EmbeddingResult(vectors=[], provider=self.name, dim=self.dim)
        payload: dict[str, object] = {"model": self.model, "input": texts}
        if self.dim:
            payload["dimensions"] = self.dim
        try:
            resp = httpx.post(
                f"{self.base_url}/embeddings",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json=payload,
                timeout=60.0,
            )
            resp.raise_for_status()
            data = resp.json()["data"]
        except Exception as exc:  # noqa: BLE001 - fall back rather than fail the request
            log.warning("openai_embedding_failed", error=str(exc))
            fallback = HashEmbeddingProvider(self.dim).embed_texts(texts)
            fallback.warnings = [f"OpenAI embeddings failed ({exc}); used deterministic hash fallback"]
            return fallback
        vectors = [list(map(float, item["embedding"])) for item in sorted(data, key=lambda d: d["index"])]
        tokens = sum(len(t.split()) for t in texts)
        return EmbeddingResult(
            vectors=vectors,
            provider=self.name,
            dim=len(vectors[0]) if vectors else self.dim,
            cost_usd=tokens * 1.3 * 0.02 / 1_000_000,  # text-embedding-3-small list price
        )

    def embed_images(self, uris: list[str]) -> EmbeddingResult:
        # No image endpoint on this API; image similarity stays deterministic.
        result = HashEmbeddingProvider(self.dim).embed_images(uris)
        result.warnings = list(result.warnings) + ["image embeddings use the deterministic hash provider"]
        return result


def build_embedding_provider(
    settings: Settings | None = None, kind: str = "text"
) -> EmbeddingProvider:
    s = settings or get_settings()
    name = (s.image_embedding_provider if kind == "image" else s.embedding_provider).strip().lower()
    dim = s.image_embedding_dim if kind == "image" else s.embedding_dim
    if name == "openai" and s.openai_api_key and kind == "text":
        return OpenAIEmbeddingProvider(s.openai_api_key, s.embedding_model, dim)
    if name not in ("hash", "", "local"):
        log.info("embedding_provider_fallback", requested=name, using="hash")
    return HashEmbeddingProvider(dim)


def cosine_similarity(a: list[float] | NDArray[np.float64], b: list[float] | NDArray[np.float64]) -> float:
    va = np.asarray(a, dtype=np.float64)
    vb = np.asarray(b, dtype=np.float64)
    if va.size == 0 or vb.size == 0 or va.size != vb.size:
        return 0.0
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
    return float(va @ vb / denom) if denom > 1e-12 else 0.0


__all__ = [
    "EmbeddingProvider",
    "EmbeddingResult",
    "HashEmbeddingProvider",
    "OpenAIEmbeddingProvider",
    "build_embedding_provider",
    "cosine_similarity",
]
