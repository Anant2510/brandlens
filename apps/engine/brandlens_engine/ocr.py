"""OCR drivers.

Text location is needed by contrast, clear-space and disclaimer proximity, but
only when there is no structured source — and there usually is. So OCR is a
fallback, and the default driver is `vlm`: it needs no native install, which is
the deciding constraint on a Windows VM with no compiler.

`none` is a first-class driver, not an error state. When it is selected the
analyzers that need spans return `insufficient_evidence` with an explanation.
Fabricating a pass because we could not look is the single worst failure mode a
compliance tool can have.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess  # noqa: S404 - only ever invoked with a configured absolute binary path
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

import numpy as np
from numpy.typing import NDArray

from .config import Settings, get_settings
from .logging import get_logger
from .media import encode_png, norm_bbox, resize_max_edge

if TYPE_CHECKING:  # avoid a hard import cycle: llm -> config -> ...
    from .llm.base import LLMProvider

log = get_logger(__name__)


@dataclass(slots=True)
class TextSpan:
    text: str
    #: Normalized to the image, origin top-left.
    bbox: tuple[float, float, float, float]
    confidence: float = 0.0
    source: str = "ocr"
    font_size_pt_estimate: float | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "text": self.text,
            "bbox": [round(v, 5) for v in self.bbox],
            "confidence": round(self.confidence, 3),
            "source": self.source,
        }


@dataclass(slots=True)
class OcrResult:
    spans: list[TextSpan] = field(default_factory=list)
    driver: str = "none"
    available: bool = False
    cost_usd: float = 0.0
    warnings: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n".join(s.text for s in self.spans if s.text.strip())


class OcrDriver(Protocol):
    name: str

    def available(self) -> bool: ...

    def read(self, rgb: NDArray[np.uint8]) -> OcrResult: ...


# ---------------------------------------------------------------------------
# none
# ---------------------------------------------------------------------------
class NullOcrDriver:
    name = "none"

    def available(self) -> bool:
        return False

    def read(self, rgb: NDArray[np.uint8]) -> OcrResult:
        return OcrResult(
            driver="none",
            available=False,
            warnings=["OCR driver is 'none'; no text spans could be located in pixels"],
        )


# ---------------------------------------------------------------------------
# tesseract (subprocess — the Python bindings are not on the allowed list)
# ---------------------------------------------------------------------------
class TesseractOcrDriver:
    name = "tesseract"

    def __init__(self, cmd: str = "") -> None:
        self.cmd = cmd or shutil.which("tesseract") or ""

    def available(self) -> bool:
        return bool(self.cmd) and Path(self.cmd).exists()

    def read(self, rgb: NDArray[np.uint8]) -> OcrResult:
        if not self.available():
            return OcrResult(
                driver=self.name,
                available=False,
                warnings=["tesseract binary not found; set TESSERACT_CMD"],
            )
        h, w = rgb.shape[:2]
        with tempfile.TemporaryDirectory(prefix="brandlens-ocr-") as tmp:
            src = Path(tmp) / "page.png"
            src.write_bytes(encode_png(rgb))
            try:
                proc = subprocess.run(  # noqa: S603 - path comes from operator config
                    [self.cmd, str(src), "stdout", "tsv"],
                    capture_output=True,
                    timeout=120,
                    check=False,
                )
            except (OSError, subprocess.SubprocessError) as exc:
                return OcrResult(driver=self.name, available=False, warnings=[f"tesseract failed: {exc}"])
            if proc.returncode != 0:
                return OcrResult(
                    driver=self.name,
                    available=False,
                    warnings=[f"tesseract exited {proc.returncode}: {proc.stderr.decode(errors='replace')[:200]}"],
                )

        spans: list[TextSpan] = []
        lines = proc.stdout.decode("utf-8", errors="replace").splitlines()
        for row in lines[1:]:
            cols = row.split("\t")
            if len(cols) < 12:
                continue
            text = cols[11].strip()
            if not text:
                continue
            try:
                left, top, width, height, conf = (
                    int(cols[6]), int(cols[7]), int(cols[8]), int(cols[9]), float(cols[10])
                )
            except ValueError:
                continue
            if conf < 0:
                continue
            spans.append(
                TextSpan(
                    text=text,
                    bbox=norm_bbox((left, top, left + width, top + height), w, h),
                    confidence=conf / 100.0,
                    source="tesseract",
                    font_size_pt_estimate=round(height * 72.0 / 96.0, 2),
                )
            )
        return OcrResult(spans=spans, driver=self.name, available=True)


# ---------------------------------------------------------------------------
# vlm
# ---------------------------------------------------------------------------
_VLM_OCR_PROMPT = """You are an OCR engine. Transcribe every visible text run in the image.

Return ONLY a JSON array. Each element:
{"text": "<exact characters>", "bbox": [x0, y0, x1, y1], "confidence": 0.0-1.0}

bbox is normalized to the image with origin top-left, values 0..1.
Group by visual line. Preserve casing, punctuation and diacritics exactly.
Do not translate, correct spelling, or omit small print — the small print is
often the legally required part. If there is no text, return [].
"""

_JSON_BLOCK = re.compile(r"\[.*\]", re.S)


class VlmOcrDriver:
    """OCR through the configured vision model.

    Slower and dearer per page than a native engine, but it needs no install,
    handles stylised display type that Tesseract mangles, and — because the
    engine already holds a provider for T2 — adds no new failure surface.
    """

    name = "vlm"

    def __init__(self, provider: LLMProvider | None = None, max_edge: int = 1568) -> None:
        self._provider = provider
        self.max_edge = max_edge

    def _get_provider(self) -> LLMProvider | None:
        if self._provider is not None:
            return self._provider
        try:
            from .llm.factory import build_provider

            s = get_settings()
            if not s.provider_configured(s.llm_judge_provider):
                return None
            self._provider = build_provider(s.llm_judge_provider, s.llm_judge_model, s)
        except Exception as exc:  # noqa: BLE001
            log.warning("vlm_ocr_provider_unavailable", error=str(exc))
            return None
        return self._provider

    def available(self) -> bool:
        return self._get_provider() is not None

    def read(self, rgb: NDArray[np.uint8]) -> OcrResult:
        provider = self._get_provider()
        if provider is None:
            return OcrResult(
                driver=self.name,
                available=False,
                warnings=["OCR driver 'vlm' selected but no vision provider is configured"],
            )
        h, w = rgb.shape[:2]
        small = resize_max_edge(rgb, self.max_edge)
        try:
            completion = provider.complete_vision(
                system="You transcribe text from images with exact fidelity.",
                prompt=_VLM_OCR_PROMPT,
                images=[encode_png(small)],
                temperature=0.0,
                max_tokens=4096,
            )
        except Exception as exc:  # noqa: BLE001 - provider outage degrades, never 500s
            return OcrResult(driver=self.name, available=False, warnings=[f"VLM OCR failed: {exc}"])

        spans = self._parse(completion.text, w, h)
        return OcrResult(spans=spans, driver=self.name, available=True, cost_usd=completion.cost_usd)

    @staticmethod
    def _parse(raw: str, width: int, height: int) -> list[TextSpan]:
        match = _JSON_BLOCK.search(raw or "")
        if not match:
            return []
        try:
            payload = json.loads(match.group(0))
        except json.JSONDecodeError:
            return []
        spans: list[TextSpan] = []
        for item in payload if isinstance(payload, list) else []:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text", "")).strip()
            box = item.get("bbox")
            if not text or not isinstance(box, (list, tuple)) or len(box) < 4:
                continue
            try:
                x0, y0, x1, y1 = (float(v) for v in box[:4])
            except (TypeError, ValueError):
                continue
            # Models sometimes answer in pixels despite the instruction; detect
            # and rescale rather than discarding a good transcription.
            if max(x0, y0, x1, y1) > 1.5:
                x0, x1 = x0 / max(width, 1), x1 / max(width, 1)
                y0, y1 = y0 / max(height, 1), y1 / max(height, 1)
            clamp = lambda v: float(min(1.0, max(0.0, v)))  # noqa: E731
            bbox = (clamp(min(x0, x1)), clamp(min(y0, y1)), clamp(max(x0, x1)), clamp(max(y0, y1)))
            if bbox[2] - bbox[0] <= 0 or bbox[3] - bbox[1] <= 0:
                continue
            spans.append(
                TextSpan(
                    text=text,
                    bbox=bbox,
                    confidence=float(item.get("confidence", 0.7) or 0.7),
                    source="vlm",
                    font_size_pt_estimate=round((bbox[3] - bbox[1]) * height * 72.0 / 96.0, 2),
                )
            )
        return spans


# ---------------------------------------------------------------------------
# factory
# ---------------------------------------------------------------------------
def build_ocr_driver(settings: Settings | None = None, provider: LLMProvider | None = None) -> OcrDriver:
    s = settings or get_settings()
    driver = s.ocr_driver
    if driver == "tesseract":
        return TesseractOcrDriver(s.tesseract_cmd)
    if driver == "vlm":
        return VlmOcrDriver(provider=provider, max_edge=s.judge_max_image_edge)
    # `paddle` is accepted in .env for other deployments; PaddleOCR is a
    # forbidden dependency here, so it resolves to the honest null driver.
    return NullOcrDriver()


def merge_spans_into_lines(spans: list[TextSpan], y_tolerance: float = 0.012) -> list[TextSpan]:
    """Group word-level spans (Tesseract) into reading lines."""
    if not spans:
        return []
    ordered = sorted(spans, key=lambda s: (round(s.bbox[1] / max(y_tolerance, 1e-6)), s.bbox[0]))
    lines: list[list[TextSpan]] = []
    for span in ordered:
        placed = False
        for line in lines:
            if abs(line[0].bbox[1] - span.bbox[1]) <= y_tolerance:
                line.append(span)
                placed = True
                break
        if not placed:
            lines.append([span])

    merged: list[TextSpan] = []
    for line in lines:
        line.sort(key=lambda s: s.bbox[0])
        merged.append(
            TextSpan(
                text=" ".join(s.text for s in line),
                bbox=(
                    min(s.bbox[0] for s in line),
                    min(s.bbox[1] for s in line),
                    max(s.bbox[2] for s in line),
                    max(s.bbox[3] for s in line),
                ),
                confidence=float(np.mean([s.confidence for s in line])),
                source=line[0].source,
                font_size_pt_estimate=line[0].font_size_pt_estimate,
            )
        )
    return merged


__all__ = [
    "NullOcrDriver",
    "OcrDriver",
    "OcrResult",
    "TesseractOcrDriver",
    "TextSpan",
    "VlmOcrDriver",
    "build_ocr_driver",
    "merge_spans_into_lines",
]
