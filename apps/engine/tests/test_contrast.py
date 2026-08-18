"""WCAG contrast math and local per-glyph sampling."""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image, ImageDraw

from brandlens_engine.accessibility import check_alt_text, check_contrast, check_font_size_floor
from brandlens_engine.contrast import (
    apca_lc,
    contrast_ratio,
    contrast_ratio_hex,
    glyph_mask_from_region,
    measure_local_contrast,
    mm_to_px,
    points_to_px,
    px_to_mm,
    relative_luminance,
    wcag_threshold,
    worst_case,
)

from .conftest import _font, make_rule


def test_black_on_white_is_exactly_21():
    assert contrast_ratio_hex("#000000", "#FFFFFF") == pytest.approx(21.0, abs=1e-9)
    assert contrast_ratio_hex("#FFFFFF", "#000000") == pytest.approx(21.0, abs=1e-9)


def test_identical_colours_are_exactly_1():
    assert contrast_ratio_hex("#0B5FFF", "#0B5FFF") == pytest.approx(1.0, abs=1e-12)


@pytest.mark.parametrize(
    ("fg", "bg", "expected"),
    [
        # Published WCAG reference values used by every contrast checker.
        ("#767676", "#FFFFFF", 4.54),
        ("#595959", "#FFFFFF", 7.00),
        ("#0000FF", "#FFFFFF", 8.59),
        ("#FF0000", "#FFFFFF", 4.00),
        ("#008000", "#FFFFFF", 5.13),
        ("#949494", "#000000", 6.92),
    ],
)
def test_known_contrast_pairs(fg, bg, expected):
    assert contrast_ratio_hex(fg, bg) == pytest.approx(expected, abs=0.01)


def test_relative_luminance_anchors():
    assert relative_luminance((255, 255, 255)) == pytest.approx(1.0, abs=1e-9)
    assert relative_luminance((0, 0, 0)) == pytest.approx(0.0, abs=1e-9)
    # The coefficients are the sRGB primaries' Y contributions.
    assert relative_luminance((0, 255, 0)) == pytest.approx(0.7152, abs=1e-4)
    assert relative_luminance((255, 0, 0)) == pytest.approx(0.2126, abs=1e-4)
    assert relative_luminance((0, 0, 255)) == pytest.approx(0.0722, abs=1e-4)


def test_contrast_is_order_independent():
    assert contrast_ratio((10, 20, 30), (200, 210, 220)) == pytest.approx(
        contrast_ratio((200, 210, 220), (10, 20, 30))
    )


def test_wcag_thresholds_follow_the_large_text_rule():
    assert wcag_threshold(12.0) == 4.5
    assert wcag_threshold(17.9) == 4.5
    assert wcag_threshold(18.0) == 3.0
    assert wcag_threshold(14.0, bold=True) == 3.0
    assert wcag_threshold(13.9, bold=True) == 4.5
    assert wcag_threshold(12.0, level="AAA") == 7.0
    assert wcag_threshold(18.0, level="AAA") == 4.5


def test_apca_reference_values_and_polarity():
    # APCA is advisory only, but it must still be right where it is reported.
    assert apca_lc((0, 0, 0), (255, 255, 255)) == pytest.approx(106.04, abs=0.05)
    assert apca_lc((255, 255, 255), (0, 0, 0)) == pytest.approx(-107.88, abs=0.05)
    assert apca_lc((128, 128, 128), (128, 128, 128)) == pytest.approx(0.0, abs=0.01)


def test_unit_conversions():
    assert points_to_px(12, dpi=96) == pytest.approx(16.0)
    assert px_to_mm(300, dpi=300) == pytest.approx(25.4)
    assert mm_to_px(25.4, dpi=150) == pytest.approx(150.0)


# ---------------------------------------------------------------------------
# local sampling
# ---------------------------------------------------------------------------
def _text_image(fg: str, bg: str, size: int = 34) -> np.ndarray:
    img = Image.new("RGB", (420, 90), bg)
    ImageDraw.Draw(img).text((14, 22), "Compliance", fill=fg, font=_font(size))
    return np.asarray(img, dtype=np.uint8)


def test_glyph_mask_finds_ink_as_the_minority_class():
    mask = glyph_mask_from_region(_text_image("#000000", "#FFFFFF"))
    assert 0.0 < mask.mean() < 0.5


def test_local_contrast_recovers_a_known_pair():
    rgb = _text_image("#767676", "#FFFFFF")
    measured = measure_local_contrast(rgb, (0, 0, 420, 90))
    assert measured.reliable
    assert measured.ratio == pytest.approx(4.54, abs=0.6)


def test_local_contrast_handles_light_on_dark():
    rgb = _text_image("#FFFFFF", "#111111")
    measured = measure_local_contrast(rgb, (0, 0, 420, 90))
    assert measured.ratio > 15.0
    assert measured.apca_lc < 0, "negative Lc encodes light-on-dark polarity"


def test_local_sampling_beats_whole_canvas_averaging():
    """The reason for local sampling: text on a bright patch of a split canvas.

    The page average would report a comfortable ratio while the actual text is
    illegible against the patch it sits on.
    """
    img = Image.new("RGB", (400, 200), "#000000")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 400, 100], fill="#FFFFFF")
    d.text((16, 30), "Low contrast", fill="#DDDDDD", font=_font(34))
    rgb = np.asarray(img, dtype=np.uint8)

    local = measure_local_contrast(rgb, (0, 0, 400, 100))
    page_average = contrast_ratio((221, 221, 221), rgb.reshape(-1, 3).mean(axis=0))
    assert local.ratio < 2.0, "the text really is illegible where it sits"
    assert page_average > local.ratio * 1.5, "averaging the page would have hidden that"


def test_worst_case_prefers_reliable_measurements():
    from brandlens_engine.contrast import LocalContrast

    unreliable = LocalContrast(1.2, (0, 0, 0), (0, 0, 0), 0.0, 0.0, (0, 0, 1, 1), reliable=False)
    reliable = LocalContrast(3.4, (0, 0, 0), (0, 0, 0), 0.5, 0.0, (0, 0, 1, 1), reliable=True)
    assert worst_case([unreliable, reliable]) is reliable
    assert worst_case([]) is None


# ---------------------------------------------------------------------------
# accessibility analyzers
# ---------------------------------------------------------------------------
def test_contrast_analyzer_uses_declared_colours_from_a_pdf(context_for, brand_pdf_path):
    """The exact foreground always comes from the PDF, never from Otsu."""
    ctx = context_for(brand_pdf_path, kind="pdf")
    rule = make_rule("a11y.contrast", "accessibility.contrast", "accessibility")
    result = check_contrast(ctx, rule)
    assert result.verdict in ("pass", "fail")
    assert result.evidence.measured["runCount"] >= 1
    assert result.evidence.measured["method"].startswith("declared")
    assert result.evidence.threshold["policy"] == "worst-case across runs"
    # Text painted on the blue header must be measured against that exact fill,
    # not against a sampled approximation of it.
    on_header = [r for r in result.evidence.measured["runs"] if r["method"] == "declared:pdf"]
    assert all(r["bg"].startswith("#") for r in result.evidence.measured["runs"])
    assert all(r["fg"].startswith("#") for r in result.evidence.measured["runs"])
    del on_header


def test_contrast_analyzer_flags_low_contrast_text_in_a_pdf(context_for, scratch):
    import pymupdf

    path = scratch / "low_contrast.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=200)
    page.draw_rect(pymupdf.Rect(0, 0, 400, 200), color=None, fill=(1, 1, 1))
    page.insert_text((20, 100), "Barely visible small print", fontname="helv", fontsize=9, color=(0.85, 0.85, 0.85))
    doc.save(path)
    doc.close()

    ctx = context_for(str(path), kind="pdf")
    result = check_contrast(ctx, make_rule("a11y.contrast", "accessibility.contrast", "accessibility"))
    assert result.verdict == "fail"
    assert result.evidence.measured["worstRatio"] < 4.5
    assert result.evidence.bbox is not None


def test_contrast_analyzer_reports_insufficient_evidence_without_text_geometry(context_for, poster_path):
    """OCR driver is `none` in tests, so a bare PNG offers no run positions.

    The right answer is an explained abstention, never a pass.
    """
    ctx = context_for(poster_path)
    result = check_contrast(ctx, make_rule("a11y.contrast", "accessibility.contrast", "accessibility"))
    assert result.verdict == "insufficient_evidence"
    assert "none" in (result.evidence.observation or "")


def test_font_size_floor_uses_exact_pdf_sizes(context_for, brand_pdf_path):
    ctx = context_for(brand_pdf_path, kind="pdf")
    rule = make_rule("a11y.size", "accessibility.font_size_floor", "accessibility", params={"minSizePt": 8})
    result = check_font_size_floor(ctx, rule)
    assert result.verdict == "fail"
    assert result.evidence.measured["exactSizes"] is True
    assert result.evidence.measured["smallestPt"] == pytest.approx(6.5, abs=0.1)


def test_alt_text_adequacy(context_for, poster_path):
    rule = make_rule("a11y.alt", "accessibility.alt_text", "accessibility")

    missing = check_alt_text(context_for(poster_path), rule)
    assert missing.verdict == "fail"

    generic = check_alt_text(context_for(poster_path, copy_fields={"altText": "image"}), rule)
    assert generic.verdict == "fail"
    assert any("generic" in issue for issue in generic.evidence.measured["evaluated"][0]["issues"])

    filename = check_alt_text(context_for(poster_path, copy_fields={"altText": "hero_banner_v3.png"}), rule)
    assert filename.verdict == "fail"

    redundant = check_alt_text(
        context_for(poster_path, copy_fields={"altText": "Image of a person using a banking app"}), rule
    )
    assert redundant.verdict == "fail"

    good = check_alt_text(
        context_for(poster_path, copy_fields={"altText": "A customer checks their balance on a phone at a cafe."}),
        rule,
    )
    assert good.verdict == "pass"
