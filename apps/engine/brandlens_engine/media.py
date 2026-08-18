"""Image ingestion and derivative writing.

Everything downstream assumes one canonical representation: an `RGB uint8`
ndarray already converted to sRGB, plus an optional alpha plane kept separate
(compositing alpha onto white before measuring would silently change every
colour we report).

All writes go under `settings.derivatives_dir` / `settings.temp_dir`. Nothing
else on the filesystem is touched — a deployment constraint on the customer's
Windows VM, and the reason paths are resolved through `safe_output_path`.
"""

from __future__ import annotations

import hashlib
import io
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote, urlparse

import numpy as np
from numpy.typing import NDArray
from PIL import Image, ImageCms, ImageDraw, ImageFont

from .config import Settings, get_settings
from .logging import get_logger

log = get_logger(__name__)

Image.MAX_IMAGE_PIXELS = 400_000_000  # generous, but still a decompression-bomb guard

_SRGB_PROFILE = ImageCms.createProfile("sRGB")


class MediaError(RuntimeError):
    """Raised when bytes cannot be turned into an image. Callers degrade."""


@dataclass(slots=True)
class LoadedImage:
    rgb: NDArray[np.uint8]
    alpha: NDArray[np.uint8] | None = None
    width: int = 0
    height: int = 0
    dpi: float = 96.0
    source_profile: str | None = None
    converted_to_srgb: bool = False
    warnings: list[str] = field(default_factory=list)

    @property
    def shape(self) -> tuple[int, int]:
        return self.height, self.width

    @property
    def megapixels(self) -> float:
        return self.width * self.height / 1e6

    def crop_px(self, box: tuple[int, int, int, int]) -> NDArray[np.uint8]:
        x0, y0, x1, y1 = box
        x0 = max(0, min(self.width, int(x0)))
        x1 = max(0, min(self.width, int(x1)))
        y0 = max(0, min(self.height, int(y0)))
        y1 = max(0, min(self.height, int(y1)))
        if x1 <= x0 or y1 <= y0:
            return np.zeros((0, 0, 3), dtype=np.uint8)
        return self.rgb[y0:y1, x0:x1]

    def crop_norm(self, bbox: tuple[float, float, float, float], pad_pct: float = 0.0) -> NDArray[np.uint8]:
        return self.crop_px(denorm_bbox(bbox, self.width, self.height, pad_pct))


# ---------------------------------------------------------------------------
# URI resolution
# ---------------------------------------------------------------------------
def resolve_uri(uri: str, timeout: float = 30.0) -> bytes:
    """Read a local path, a `file://` URL or an http(s) presigned URL."""
    if not uri:
        raise MediaError("empty uri")
    parsed = urlparse(uri)
    if parsed.scheme in ("http", "https"):
        import httpx  # imported lazily: the hot path is local files

        try:
            resp = httpx.get(uri, timeout=timeout, follow_redirects=True)
            resp.raise_for_status()
            return resp.content
        except Exception as exc:  # noqa: BLE001 - any transport failure degrades identically
            raise MediaError(f"fetch failed for {uri!r}: {exc}") from exc
    path = Path(unquote(parsed.path)) if parsed.scheme == "file" else Path(uri)
    if not path.is_file():
        raise MediaError(f"no such file: {path}")
    try:
        return path.read_bytes()
    except OSError as exc:
        raise MediaError(f"unreadable file {path}: {exc}") from exc


def content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------
def _icc_to_srgb(img: Image.Image) -> tuple[Image.Image, str | None, bool]:
    """Convert an embedded ICC profile to sRGB.

    Skipping this makes every dE we report wrong for Adobe RGB / CMYK assets —
    which is most print-origin artwork — so it happens before anything else.
    """
    icc = img.info.get("icc_profile")
    if not icc:
        return img, None, False
    try:
        src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        name = ImageCms.getProfileDescription(src).strip()
        if "srgb" in name.lower():
            return img, name, False
        mode = "RGBA" if img.mode in ("RGBA", "LA", "PA") else "RGB"
        converted = ImageCms.profileToProfile(img, src, _SRGB_PROFILE, outputMode=mode)
        return (converted or img), name, converted is not None
    except Exception as exc:  # noqa: BLE001 - a broken profile must not fail the run
        log.warning("icc_conversion_failed", error=str(exc))
        return img, None, False


def load_image_bytes(data: bytes, dpi_hint: float | None = None) -> LoadedImage:
    warnings: list[str] = []
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:  # noqa: BLE001
        raise MediaError(f"cannot decode image: {exc}") from exc

    dpi = float(dpi_hint) if dpi_hint else 96.0
    info_dpi = img.info.get("dpi")
    if not dpi_hint and isinstance(info_dpi, tuple) and info_dpi and float(info_dpi[0]) > 1:
        dpi = float(info_dpi[0])

    if img.mode == "P":
        img = img.convert("RGBA" if "transparency" in img.info else "RGB")
    if img.mode == "CMYK":
        warnings.append("CMYK source converted to sRGB; measured colours are an approximation")

    img, profile_name, converted = _icc_to_srgb(img)

    alpha: NDArray[np.uint8] | None = None
    if img.mode in ("RGBA", "LA", "PA"):
        rgba = img.convert("RGBA")
        arr = np.asarray(rgba, dtype=np.uint8)
        alpha = np.ascontiguousarray(arr[..., 3])
        rgb = np.ascontiguousarray(arr[..., :3])
    else:
        rgb = np.asarray(img.convert("RGB"), dtype=np.uint8)

    return LoadedImage(
        rgb=np.ascontiguousarray(rgb),
        alpha=alpha,
        width=int(rgb.shape[1]),
        height=int(rgb.shape[0]),
        dpi=dpi,
        source_profile=profile_name,
        converted_to_srgb=converted,
        warnings=warnings,
    )


def load_image(uri: str, dpi_hint: float | None = None, timeout: float = 30.0) -> LoadedImage:
    return load_image_bytes(resolve_uri(uri, timeout=timeout), dpi_hint=dpi_hint)


def render_pdf_page(data: bytes, page_index: int = 0, dpi: float = 150.0) -> LoadedImage:
    """Rasterise one PDF page. Structured text still comes from `structured.py`;
    this is only for the pixel-side checks (colour, logo, layout)."""
    try:
        import pymupdf as fitz  # `fitz` is the legacy alias; import the new name
    except ImportError as exc:  # pragma: no cover
        raise MediaError("PyMuPDF not installed") from exc
    try:
        with fitz.open(stream=data, filetype="pdf") as doc:
            if doc.page_count == 0:
                raise MediaError("pdf has no pages")
            page = doc[max(0, min(page_index, doc.page_count - 1))]
            pix = page.get_pixmap(dpi=int(dpi), alpha=False)
            arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            rgb = np.ascontiguousarray(arr[..., :3])
    except MediaError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise MediaError(f"cannot rasterise pdf: {exc}") from exc
    return LoadedImage(rgb=rgb, width=rgb.shape[1], height=rgb.shape[0], dpi=dpi)


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------
def denorm_bbox(
    bbox: tuple[float, float, float, float], width: int, height: int, pad_pct: float = 0.0
) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = bbox
    if pad_pct:
        dw, dh = (x1 - x0) * pad_pct, (y1 - y0) * pad_pct
        x0, y0, x1, y1 = x0 - dw, y0 - dh, x1 + dw, y1 + dh
    return (
        max(0, int(math.floor(x0 * width))),
        max(0, int(math.floor(y0 * height))),
        min(width, int(math.ceil(x1 * width))),
        min(height, int(math.ceil(y1 * height))),
    )


def norm_bbox(box_px: tuple[float, float, float, float], width: int, height: int) -> tuple[float, float, float, float]:
    w = max(1.0, float(width))
    h = max(1.0, float(height))
    x0, y0, x1, y1 = box_px
    clamp = lambda v: float(min(1.0, max(0.0, v)))  # noqa: E731
    return (clamp(x0 / w), clamp(y0 / h), clamp(x1 / w), clamp(y1 / h))


def bbox_iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    area_a = max(0.0, ax1 - ax0) * max(0.0, ay1 - ay0)
    area_b = max(0.0, bx1 - bx0) * max(0.0, by1 - by0)
    union = area_a + area_b - inter
    return float(inter / union) if union > 0 else 0.0


def bbox_union(boxes: list[tuple[float, float, float, float]]) -> tuple[float, float, float, float] | None:
    if not boxes:
        return None
    xs0 = min(b[0] for b in boxes)
    ys0 = min(b[1] for b in boxes)
    xs1 = max(b[2] for b in boxes)
    ys1 = max(b[3] for b in boxes)
    return (xs0, ys0, xs1, ys1)


def resize_max_edge(rgb: NDArray[np.uint8], max_edge: int) -> NDArray[np.uint8]:
    h, w = rgb.shape[:2]
    longest = max(h, w)
    if longest <= max_edge or longest == 0:
        return rgb
    scale = max_edge / longest
    img = Image.fromarray(rgb).resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    return np.asarray(img, dtype=np.uint8)


@dataclass(slots=True)
class Tile:
    rgb: NDArray[np.uint8]
    box_px: tuple[int, int, int, int]
    index: int


def tile_image(rgb: NDArray[np.uint8], tile: int = 768, overlap: int = 96) -> list[Tile]:
    """Overlapping tiles so an element straddling a seam is whole in one tile."""
    h, w = rgb.shape[:2]
    step = max(1, tile - overlap)
    out: list[Tile] = []
    idx = 0
    for y0 in range(0, max(1, h), step):
        for x0 in range(0, max(1, w), step):
            x1, y1 = min(w, x0 + tile), min(h, y0 + tile)
            if x1 - x0 < 8 or y1 - y0 < 8:
                continue
            out.append(Tile(rgb=rgb[y0:y1, x0:x1], box_px=(x0, y0, x1, y1), index=idx))
            idx += 1
            if x1 >= w:
                break
        if y0 + tile >= h:
            break
    return out


# ---------------------------------------------------------------------------
# Derivative / evidence writing
# ---------------------------------------------------------------------------
def safe_output_path(key: str, settings: Settings | None = None, subdir: str = "") -> Path:
    """Resolve `key` under the derivatives root, refusing traversal."""
    s = settings or get_settings()
    root = (s.derivatives_dir / subdir) if subdir else s.derivatives_dir
    root.mkdir(parents=True, exist_ok=True)
    cleaned = key.replace("\\", "/").lstrip("/")
    target = (root / cleaned).resolve()
    if not str(target).startswith(str(root.resolve())):
        raise MediaError(f"refusing to write outside derivatives root: {key!r}")
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def write_derivative(
    rgb: NDArray[np.uint8],
    key: str,
    settings: Settings | None = None,
    fmt: str = "PNG",
    quality: int = 88,
) -> str:
    """Write an evidence crop/overlay and return its URI (a local path here)."""
    path = safe_output_path(key, settings)
    img = Image.fromarray(np.asarray(rgb, dtype=np.uint8))
    if fmt.upper() in ("JPEG", "JPG"):
        img.convert("RGB").save(path, format="JPEG", quality=quality, optimize=True)
    else:
        img.save(path, format="PNG", optimize=True)
    return str(path)


def encode_png(rgb: NDArray[np.uint8]) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.asarray(rgb, dtype=np.uint8)).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def encode_jpeg(rgb: NDArray[np.uint8], quality: int = 85) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.asarray(rgb, dtype=np.uint8)).convert("RGB").save(
        buf, format="JPEG", quality=quality, optimize=True
    )
    return buf.getvalue()


_MARK_COLORS: tuple[tuple[int, int, int], ...] = (
    (255, 59, 48),
    (0, 122, 255),
    (52, 199, 89),
    (255, 149, 0),
    (175, 82, 222),
    (255, 204, 0),
    (90, 200, 250),
    (255, 45, 85),
)


def _mark_font(size: int) -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    for name in ("DejaVuSans-Bold.ttf", "arialbd.ttf", "Arial Bold.ttf", "DejaVuSans.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_set_of_mark(
    rgb: NDArray[np.uint8],
    boxes: list[tuple[float, float, float, float]],
    labels: list[str] | None = None,
) -> NDArray[np.uint8]:
    """Overlay numbered boxes for Set-of-Mark grounding.

    The VLM is asked to *reference a number*, never to emit coordinates: models
    are competent at "which box" and unreliable at "what pixel", and a returned
    index can be validated against the detector while a returned bbox cannot.
    """
    img = Image.fromarray(np.asarray(rgb, dtype=np.uint8).copy()).convert("RGB")
    draw = ImageDraw.Draw(img)
    w, h = img.size
    stroke = max(2, int(round(min(w, h) / 300)))
    font = _mark_font(max(12, int(round(min(w, h) / 34))))

    for i, box in enumerate(boxes):
        color = _MARK_COLORS[i % len(_MARK_COLORS)]
        x0, y0, x1, y1 = denorm_bbox(box, w, h)
        draw.rectangle([x0, y0, max(x0 + 1, x1), max(y0 + 1, y1)], outline=color, width=stroke)
        tag = labels[i] if labels and i < len(labels) else str(i + 1)
        try:
            tw = int(draw.textlength(tag, font=font))
        except (TypeError, AttributeError):  # pragma: no cover - very old Pillow
            tw = 10 * len(tag)
        th = max(14, int(font.size if hasattr(font, "size") else 14))
        bx0, by0 = x0, max(0, y0 - th - 4)
        draw.rectangle([bx0, by0, bx0 + tw + 8, by0 + th + 4], fill=color)
        draw.text((bx0 + 4, by0 + 2), tag, fill=(255, 255, 255), font=font)
    return np.asarray(img, dtype=np.uint8)


def file_size_bytes(uri: str) -> int | None:
    parsed = urlparse(uri)
    if parsed.scheme in ("http", "https"):
        return None
    path = Path(unquote(parsed.path)) if parsed.scheme == "file" else Path(uri)
    try:
        return os.path.getsize(path)
    except OSError:
        return None


__all__ = [
    "LoadedImage",
    "MediaError",
    "Tile",
    "bbox_iou",
    "bbox_union",
    "content_hash",
    "denorm_bbox",
    "draw_set_of_mark",
    "encode_jpeg",
    "encode_png",
    "file_size_bytes",
    "load_image",
    "load_image_bytes",
    "norm_bbox",
    "render_pdf_page",
    "resize_max_edge",
    "resolve_uri",
    "safe_output_path",
    "tile_image",
    "write_derivative",
]
