"""Shared fixtures.

Everything the suite needs is synthesised with PIL at test time: no network, no
API keys, no checked-in binaries. That is a hard requirement — this engine ships
to an air-gapped Windows VM and CI must prove it works there.

Scratch paths are redirected into pytest's tmp dir *before* any engine module is
imported, because the measurement cache is a process-global built on first use.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

# --- must happen before importing brandlens_engine ---------------------------
_SCRATCH = Path(tempfile.mkdtemp(prefix="brandlens-tests-"))
os.environ.setdefault("ENGINE_TEMP_DIR", str(_SCRATCH / "tmp"))
os.environ.setdefault("ENGINE_DERIVATIVES_DIR", str(_SCRATCH / "derivatives"))
os.environ.setdefault("STORAGE_LOCAL_ROOT", str(_SCRATCH / "storage"))
os.environ.setdefault("ENGINE_SHARED_SECRET", "test-secret")
os.environ.setdefault("OCR_DRIVER", "none")
os.environ.setdefault("ANTHROPIC_API_KEY", "")
os.environ.setdefault("OPENAI_API_KEY", "")
os.environ.setdefault("GOOGLE_API_KEY", "")
os.environ.setdefault("LOG_LEVEL", "warning")

import numpy as np  # noqa: E402
import pytest  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from brandlens_engine.config import get_settings, reset_settings_cache  # noqa: E402
from brandlens_engine.models import (  # noqa: E402
    AnalyzeRequest,
    ColorToken,
    DisclaimerEntry,
    EngineAssetRef,
    EngineBrandContext,
    EngineJudgeConfig,
    ForbiddenColor,
    LexiconEntry,
    LogoVariant,
    RuleCheckSpec,
    RuleDefinition,
    TypeStyle,
)

BRAND_BLUE = "#0B5FFF"
BRAND_INK = "#0A1633"
BRAND_SAND = "#F4EFE6"
OFF_PALETTE_RED = "#D7263D"


# ---------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def scratch() -> Path:
    _SCRATCH.mkdir(parents=True, exist_ok=True)
    return _SCRATCH


@pytest.fixture(scope="session", autouse=True)
def _settings(scratch: Path):
    reset_settings_cache()
    s = get_settings()
    s.ensure_dirs()
    return s


def _font(size: int):
    for name in ("DejaVuSans.ttf", "arial.ttf", "LiberationSans-Regular.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


# ---------------------------------------------------------------------------
# synthetic imagery
# ---------------------------------------------------------------------------
def make_logo(size: int = 256) -> Image.Image:
    """A mark with enough internal structure for both feature matching and NCC."""
    img = Image.new("RGB", (size, size), "white")
    d = ImageDraw.Draw(img)
    u = size / 16
    d.ellipse([u * 1, u * 1, u * 7, u * 7], fill=BRAND_BLUE)
    d.polygon([(u * 9, u * 7), (u * 15, u * 7), (u * 12, u * 1)], fill=BRAND_INK)
    d.rectangle([u * 1, u * 9, u * 15, u * 11], fill=BRAND_BLUE)
    d.rectangle([u * 1, u * 12, u * 9, u * 14], fill=BRAND_INK)
    d.ellipse([u * 11, u * 12, u * 15, u * 15], fill=OFF_PALETTE_RED)
    # A little texture so SIFT/ORB have corners to lock onto.
    for i in range(6):
        d.rectangle([u * (1 + i * 2.3), u * 9.4, u * (1.9 + i * 2.3), u * 10.6], fill="white")
    return img


@pytest.fixture(scope="session")
def logo_path(scratch: Path) -> str:
    path = scratch / "logo.png"
    make_logo(256).save(path)
    return str(path)


def make_poster(
    width: int = 1200,
    height: int = 628,
    logo: Image.Image | None = None,
    logo_box: tuple[int, int, int, int] = (48, 72, 168, 192),
    headline: str = "Move money the modern way",
    disclaimer: str = "Terms apply. Rates shown are illustrative only.",
    disclaimer_fill: str = "#1A1A1A",
    off_palette_band: bool = False,
) -> Image.Image:
    img = Image.new("RGB", (width, height), BRAND_SAND)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, width, 24], fill=BRAND_BLUE)
    if off_palette_band:
        d.rectangle([0, height - 190, width, height - 90], fill=OFF_PALETTE_RED)
    if logo is not None:
        resized = logo.resize((logo_box[2] - logo_box[0], logo_box[3] - logo_box[1]), Image.LANCZOS)
        img.paste(resized, (logo_box[0], logo_box[1]))
    d.text((48, 260), headline, fill=BRAND_INK, font=_font(52))
    d.text((48, 340), "Open an account in minutes.", fill=BRAND_INK, font=_font(28))
    d.text((48, height - 46), disclaimer, fill=disclaimer_fill, font=_font(13))
    return img


@pytest.fixture(scope="session")
def poster_path(scratch: Path, logo_path: str) -> str:
    path = scratch / "poster.png"
    make_poster(logo=Image.open(logo_path)).save(path)
    return str(path)


@pytest.fixture(scope="session")
def poster_no_logo_path(scratch: Path) -> str:
    path = scratch / "poster_no_logo.png"
    make_poster(logo=None).save(path)
    return str(path)


@pytest.fixture(scope="session")
def poster_squashed_logo_path(scratch: Path, logo_path: str) -> str:
    """Logo stretched 35% on one axis — a classic distortion violation."""
    path = scratch / "poster_squashed.png"
    make_poster(logo=Image.open(logo_path), logo_box=(48, 40, 210, 160)).save(path)
    return str(path)


@pytest.fixture(scope="session")
def poster_off_palette_path(scratch: Path, logo_path: str) -> str:
    path = scratch / "poster_off_palette.png"
    make_poster(logo=Image.open(logo_path), off_palette_band=True).save(path)
    return str(path)


@pytest.fixture(scope="session")
def flat_brand_image() -> np.ndarray:
    """Two flat brand fills, no photography — the ideal palette-check subject."""
    img = Image.new("RGB", (400, 200), BRAND_BLUE)
    ImageDraw.Draw(img).rectangle([200, 0, 400, 200], fill=BRAND_SAND)
    return np.asarray(img, dtype=np.uint8)


# ---------------------------------------------------------------------------
# synthetic PDF (structured source)
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def brand_pdf_path(scratch: Path) -> str:
    import pymupdf

    path = scratch / "brochure.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.draw_rect(pymupdf.Rect(0, 0, 595, 90), color=None, fill=(0.043, 0.373, 1.0))
    page.insert_text((48, 200), "Move money the modern way", fontname="helv", fontsize=28, color=(0.04, 0.09, 0.2))
    page.insert_text((48, 240), "Open an account in minutes.", fontname="helv", fontsize=14, color=(0.04, 0.09, 0.2))
    page.insert_text((48, 700), "Terms apply. Rates shown are illustrative only.", fontname="helv", fontsize=6.5)
    page.insert_text((48, 730), "Best rates guaranteed for all customers.", fontname="hebo", fontsize=11)
    doc.save(path)
    doc.close()
    return str(path)


# ---------------------------------------------------------------------------
# brand context / requests
# ---------------------------------------------------------------------------
@pytest.fixture
def brand(logo_path: str) -> EngineBrandContext:
    return EngineBrandContext(
        brand_id="brand-1",
        name="Northgate",
        positioning="Straightforward banking for people who have better things to do.",
        color_tokens=[
            ColorToken(path="color.primary", hex=BRAND_BLUE, role="primary", allowed_tints=[20, 40, 60, 80]),
            ColorToken(path="color.ink", hex=BRAND_INK, role="secondary"),
            ColorToken(path="color.sand", hex=BRAND_SAND, role="accent"),
        ],
        forbidden_colors=[ForbiddenColor(hex=OFF_PALETTE_RED, reason="reserved by a competitor")],
        logo_variants=[
            LogoVariant(
                id="logo-primary",
                name="Primary lockup",
                kind="primary",
                uri=logo_path,
                aspect_ratio=1.0,
                palette=[BRAND_BLUE, BRAND_INK],
                constraints={"clearSpaceMultiple": 0.5, "minHeightPx": 96},
            )
        ],
        type_styles=[
            TypeStyle(
                name="Headline",
                role="headline",
                font_family="Helvetica",
                font_aliases=["Helvetica Neue", "Arial"],
                font_weight=700,
                min_size_pt=20,
                scale_rank=1,
                casing_rules={"casing": "sentence"},
            ),
            TypeStyle(
                name="Body",
                role="body",
                font_family="Helvetica",
                font_aliases=["Arial"],
                font_weight=400,
                min_size_pt=10,
                scale_rank=2,
            ),
        ],
        lexicon=[
            LexiconEntry(term="guaranteed", kind="banned", replacement="designed to", severity="major"),
            LexiconEntry(term="Northgate", kind="required", severity="blocker", allow_fuzzy=False),
        ],
        disclaimers=[
            DisclaimerEntry(
                id="disc-rates",
                name="Illustrative rates",
                text="Terms apply. Rates shown are illustrative only.",
                min_font_size_pt=8.0,
                min_contrast_ratio=4.5,
                severity="blocker",
            )
        ],
    )


@pytest.fixture
def judge_config() -> EngineJudgeConfig:
    return EngineJudgeConfig(provider="anthropic", model="claude-sonnet-4-5-20250929", cost_ceiling_usd=2.5)


def make_rule(
    key: str,
    fn: str,
    dimension: str,
    tier: str = "deterministic",
    severity: str = "major",
    params: dict | None = None,
    statement: str | None = None,
) -> RuleDefinition:
    return RuleDefinition(
        key=key,
        statement=statement or f"Rule {key}",
        dimension=dimension,  # type: ignore[arg-type]
        tier=tier,  # type: ignore[arg-type]
        severity=severity,  # type: ignore[arg-type]
        check=RuleCheckSpec(fn=fn, params=params or {}),
        status="active",
    )


@pytest.fixture
def make_request(brand: EngineBrandContext, judge_config: EngineJudgeConfig):
    def _make(
        uri: str,
        rules: list[RuleDefinition],
        kind: str = "image",
        copy_fields: dict[str, str] | None = None,
        **asset_kwargs,
    ) -> AnalyzeRequest:
        return AnalyzeRequest(
            request_id="req-test",
            org_id="org-1",
            asset=EngineAssetRef(
                id="asset-1",
                kind=kind,  # type: ignore[arg-type]
                uri=uri,
                content_hash=f"hash-{abs(hash(uri)) % 10**12}",
                copy_fields=copy_fields or {},
                **asset_kwargs,
            ),
            brand=brand,
            rules=rules,
            judge=judge_config,
        )

    return _make


@pytest.fixture
def context_for(make_request):
    """An `AnalysisContext` wired the same way the pipeline wires one."""
    from brandlens_engine.cache import get_cache
    from brandlens_engine.pipeline import AnalysisContext

    def _make(uri: str, rules: list[RuleDefinition] | None = None, **kwargs) -> AnalysisContext:
        request = make_request(uri, rules or [], **kwargs)
        return AnalysisContext(request=request, settings=get_settings(), cache=get_cache())

    return _make


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from brandlens_engine.main import create_app

    return TestClient(create_app(get_settings()))


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"X-Engine-Secret": get_settings().engine_shared_secret}
