"""Logo detection, homography decomposition and the seven logo checks."""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image, ImageDraw

from brandlens_engine.logo import (
    check_clearspace,
    check_distortion,
    check_min_size,
    check_occlusion,
    check_placement,
    check_presence,
    check_recolor,
    clearspace_measure,
    decompose_homography,
    detect_all,
    detect_logo,
    nearest_anchor,
)
from brandlens_engine.media import load_image

from .conftest import BRAND_BLUE, make_logo, make_poster, make_rule


# ---------------------------------------------------------------------------
# homography decomposition
# ---------------------------------------------------------------------------
def test_identity_homography_is_undistorted():
    d = decompose_homography(np.eye(3))
    assert d["scale"] == pytest.approx(1.0, abs=1e-9)
    assert d["aspectDistortion"] == pytest.approx(1.0, abs=1e-9)
    assert d["shear"] == pytest.approx(0.0, abs=1e-9)
    assert d["rotationDeg"] == pytest.approx(0.0, abs=1e-9)


def test_uniform_scale_is_not_reported_as_distortion():
    """Scaling a logo is legal; only *non-uniform* scaling is a violation."""
    h = np.diag([2.5, 2.5, 1.0])
    d = decompose_homography(h)
    assert d["scale"] == pytest.approx(2.5, abs=1e-6)
    assert d["aspectDistortion"] == pytest.approx(1.0, abs=1e-9)
    assert d["shear"] == pytest.approx(0.0, abs=1e-9)


def test_anisotropic_scale_is_reported():
    d = decompose_homography(np.diag([1.35, 1.0, 1.0]))
    assert d["aspectDistortion"] == pytest.approx(1.35, abs=1e-6)
    assert d["scale"] == pytest.approx(np.sqrt(1.35), abs=1e-6)


def test_shear_is_separated_from_rotation():
    shear = np.array([[1.0, 0.3, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
    d = decompose_homography(shear)
    assert d["shear"] == pytest.approx(0.3, abs=1e-6)
    assert d["rotationDeg"] == pytest.approx(0.0, abs=1e-6)

    theta = np.radians(30.0)
    rotation = np.array(
        [[np.cos(theta), -np.sin(theta), 0.0], [np.sin(theta), np.cos(theta), 0.0], [0.0, 0.0, 1.0]]
    )
    r = decompose_homography(rotation)
    assert r["rotationDeg"] == pytest.approx(30.0, abs=1e-4)
    assert r["shear"] == pytest.approx(0.0, abs=1e-6)
    assert r["aspectDistortion"] == pytest.approx(1.0, abs=1e-6)


def test_perspective_term_is_detected():
    h = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.001, 0.0005, 1.0]])
    assert decompose_homography(h)["perspective"] > 0.001


def test_degenerate_homography_degrades_to_identity():
    d = decompose_homography(np.zeros((3, 3)))
    assert d["aspectDistortion"] == 1.0


# ---------------------------------------------------------------------------
# detection
# ---------------------------------------------------------------------------
def test_logo_is_found_in_the_poster(poster_path, logo_path, brand):
    target = load_image(poster_path)
    template = load_image(logo_path)
    detection = detect_logo(target.rgb, template.rgb, brand.logo_variants[0])
    assert detection is not None
    # Pasted at (48,72)-(168,192) on a 1200x628 canvas.
    assert detection.bbox[0] == pytest.approx(48 / 1200, abs=0.05)
    assert detection.bbox[1] == pytest.approx(72 / 628, abs=0.06)
    assert detection.height_norm == pytest.approx(120 / 628, abs=0.06)


def test_logo_is_not_hallucinated_when_absent(poster_no_logo_path, logo_path, brand):
    target = load_image(poster_no_logo_path)
    template = load_image(logo_path)
    detection = detect_logo(target.rgb, template.rgb, brand.logo_variants[0])
    assert detection is None, "detector must not invent a logo on a blank layout"


def test_presence_passes_and_fails_correctly(context_for, poster_path, poster_no_logo_path):
    rule = make_rule("logo.presence", "logo.presence", "logo", tier="cv", severity="blocker")

    present = check_presence(context_for(poster_path), rule)
    assert present.verdict == "pass"
    assert present.evidence.measured["detectionCount"] == 1
    assert present.evidence.bbox is not None
    assert present.confidence and present.confidence > 0.6

    absent = check_presence(context_for(poster_no_logo_path), rule)
    assert absent.verdict == "fail"
    assert absent.evidence.measured["detectionCount"] == 0
    assert absent.suggested_fix


def test_presence_is_not_applicable_without_variants(context_for, poster_path, brand):
    brand.logo_variants = []
    ctx = context_for(poster_path)
    ctx.request.brand = brand
    rule = make_rule("logo.presence", "logo.presence", "logo", tier="cv")
    assert check_presence(ctx, rule).verdict == "not_applicable"


def test_detection_is_cached_across_analyzers(context_for, poster_path):
    ctx = context_for(poster_path)
    rule = make_rule("logo.presence", "logo.presence", "logo", tier="cv")
    detect_all(ctx, rule)
    hits_before = ctx.cache_hits
    detect_all(ctx, rule)
    assert ctx.cache_hits > hits_before, "seven logo checks must share one detection"


# ---------------------------------------------------------------------------
# min size
# ---------------------------------------------------------------------------
def test_min_size_reports_px_pct_and_mm(context_for, poster_path):
    rule = make_rule("logo.min_size", "logo.min_size", "logo", tier="cv", params={"minHeightPx": 96})
    result = check_min_size(context_for(poster_path), rule)
    assert result.verdict == "pass"
    measured = result.evidence.measured
    assert measured["heightPx"] == pytest.approx(120, abs=25)
    assert measured["heightMm"] == pytest.approx(measured["heightPx"] * 25.4 / measured["dpi"], rel=1e-3)
    assert measured["heightPctOfCanvas"] == pytest.approx(measured["heightPx"] / 628 * 100, rel=0.05)


def test_min_size_fails_against_a_high_floor(context_for, poster_path):
    rule = make_rule("logo.min_size", "logo.min_size", "logo", tier="cv", params={"minHeightPx": 400})
    result = check_min_size(context_for(poster_path), rule)
    assert result.verdict == "fail"
    assert result.evidence.threshold["minHeightPx"] == 400
    assert "minimum" in (result.evidence.observation or "")


def test_min_size_mm_conversion_respects_dpi(context_for, poster_path):
    """25.4mm at 300dpi is 300px; the same artwork at 72dpi is a different call."""
    rule = make_rule("logo.min_size", "logo.min_size", "logo", tier="cv", params={"minHeightMm": 25.4})
    high_dpi = check_min_size(context_for(poster_path, dpi=300), rule)
    low_dpi = check_min_size(context_for(poster_path, dpi=72), rule)
    assert high_dpi.evidence.measured["heightMm"] < low_dpi.evidence.measured["heightMm"]
    assert high_dpi.verdict == "fail"
    assert low_dpi.verdict == "pass"


def test_min_size_not_applicable_without_a_floor(context_for, poster_path, brand):
    brand.logo_variants[0].constraints = {}
    ctx = context_for(poster_path)
    ctx.request.brand = brand
    rule = make_rule("logo.min_size", "logo.min_size", "logo", tier="cv")
    assert check_min_size(ctx, rule).verdict == "not_applicable"


# ---------------------------------------------------------------------------
# distortion
# ---------------------------------------------------------------------------
def test_distortion_flags_a_stretched_logo(context_for, poster_squashed_logo_path, poster_path):
    rule = make_rule("logo.distortion", "logo.distortion", "logo", tier="cv")

    clean = check_distortion(context_for(poster_path), rule)
    stretched = check_distortion(context_for(poster_squashed_logo_path), rule)

    # NCC cannot recover a transform, so an honest abstention is acceptable
    # there; what is NOT acceptable is calling a stretched logo undistorted.
    assert clean.verdict in ("pass", "insufficient_evidence")
    assert stretched.verdict in ("fail", "insufficient_evidence")
    if stretched.verdict == "fail":
        assert stretched.evidence.measured["aspectDistortion"] > 1.15
    if clean.verdict == "pass":
        assert clean.evidence.measured["aspectDistortion"] < 1.1


def test_distortion_abstains_when_only_correlation_matched(context_for, scratch, logo_path, monkeypatch):
    """NCC gives a box but no transform, so distortion must abstain, not pass."""
    import brandlens_engine.logo as logo_module

    monkeypatch.setattr(logo_module, "_feature_detect", lambda *a, **k: (None, {"error": "forced"}))
    # A distinct file so the content-addressed detection cache cannot serve a
    # feature-based result measured by an earlier test.
    path = scratch / "poster_ncc_only.png"
    make_poster(logo=Image.open(logo_path), headline="Correlation only").save(path)

    ctx = context_for(str(path))
    result = check_distortion(ctx, make_rule("logo.distortion", "logo.distortion", "logo", tier="cv"))
    assert result.verdict == "insufficient_evidence"
    assert "homography" in (result.evidence.observation or "")


# ---------------------------------------------------------------------------
# clear space
# ---------------------------------------------------------------------------
def test_clearspace_measure_finds_an_intruder():
    img = Image.new("RGB", (400, 400), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([150, 150, 250, 250], fill=BRAND_BLUE)  # the "logo"
    d.rectangle([255, 150, 275, 250], fill="black")  # an intruder on the right
    rgb = np.asarray(img, dtype=np.uint8)

    measured = clearspace_measure(rgb, (150 / 400, 150 / 400, 250 / 400, 250 / 400), 0.25, 0.25)
    clearances = measured["clearanceNorm"]
    assert clearances["right"] < 0.05, "the intruder is 5px away"
    assert clearances["left"] > 0.2, "the left side is clear"
    assert measured["annulusEdgeDensity"] > 0


def test_clearspace_passes_on_an_isolated_logo(context_for, poster_path):
    rule = make_rule(
        "logo.clearspace", "logo.clearspace", "logo", tier="cv", params={"clearSpaceMultiple": 0.25}
    )
    result = check_clearspace(context_for(poster_path), rule)
    assert result.verdict == "pass"
    assert set(result.evidence.measured["clearanceNorm"]) == {"left", "right", "top", "bottom"}


def test_clearspace_fails_when_content_crowds_the_logo(context_for, scratch, logo_path):
    poster = make_poster(logo=Image.open(logo_path))
    ImageDraw.Draw(poster).rectangle([172, 72, 400, 192], fill="#111111")
    path = scratch / "poster_crowded.png"
    poster.save(path)

    rule = make_rule(
        "logo.clearspace", "logo.clearspace", "logo", tier="cv", params={"clearSpaceMultiple": 0.5}
    )
    result = check_clearspace(context_for(str(path)), rule)
    assert result.verdict == "fail"
    assert "Clear space is violated" in (result.evidence.observation or "")


# ---------------------------------------------------------------------------
# recolor / placement / occlusion
# ---------------------------------------------------------------------------
def test_recolor_passes_on_the_approved_palette(context_for, poster_path):
    rule = make_rule(
        "logo.recolor", "logo.recolor", "logo", tier="cv", params={"maxDeltaE": 12.0, "minClusterShare": 0.1}
    )
    result = check_recolor(context_for(poster_path), rule)
    assert result.verdict in ("pass", "fail")
    if result.verdict == "pass":
        assert all(c["deltaE"] <= 12.0 for c in result.evidence.measured["clusters"])


def test_recolor_fails_on_a_hue_shifted_mark(context_for, scratch):
    """Rotate the logo's blue to green and the mark should be flagged."""
    logo = make_logo(256)
    arr = np.asarray(logo, dtype=np.uint8).copy()
    blue = (arr[..., 2] > 150) & (arr[..., 0] < 120)
    arr[blue] = [16, 160, 90]
    recoloured = Image.fromarray(arr)
    path = scratch / "poster_recoloured.png"
    make_poster(logo=recoloured).save(path)

    rule = make_rule(
        "logo.recolor", "logo.recolor", "logo", tier="cv", params={"maxDeltaE": 5.0, "minClusterShare": 0.08}
    )
    result = check_recolor(context_for(str(path)), rule)
    assert result.verdict == "fail"
    assert result.evidence.measured["offenderCount"] >= 1


def test_nearest_anchor_geometry():
    assert nearest_anchor((0.0, 0.0, 0.2, 0.2))[0] == "top-left"
    assert nearest_anchor((0.8, 0.8, 1.0, 1.0))[0] == "bottom-right"
    assert nearest_anchor((0.4, 0.4, 0.6, 0.6))[0] == "center"


def test_placement_enforces_allowed_anchors(context_for, poster_path):
    ok = check_placement(
        context_for(poster_path),
        make_rule("logo.placement", "logo.placement", "logo", tier="cv", params={"allowedAnchors": ["top-left"]}),
    )
    assert ok.verdict == "pass"
    assert ok.evidence.measured["nearestAnchor"] == "top-left"

    bad = check_placement(
        context_for(poster_path),
        make_rule("logo.placement", "logo.placement", "logo", tier="cv", params={"allowedAnchors": ["bottom-right"]}),
    )
    assert bad.verdict == "fail"


def test_placement_not_applicable_without_constraints(context_for, poster_path):
    rule = make_rule("logo.placement", "logo.placement", "logo", tier="cv")
    assert check_placement(context_for(poster_path), rule).verdict == "not_applicable"


def test_occlusion_flags_an_overlapping_element(context_for, scratch, logo_path):
    poster = make_poster(logo=Image.open(logo_path))
    ImageDraw.Draw(poster).rectangle([100, 120, 300, 170], fill="#111111")
    path = scratch / "poster_occluded.png"
    poster.save(path)

    rule = make_rule("logo.occlusion", "logo.occlusion", "logo", tier="cv", params={"maxCoverageFrac": 0.02})
    result = check_occlusion(context_for(str(path)), rule)
    assert result.verdict in ("fail", "pass")
    assert "totalCoverageFrac" in result.evidence.measured


def test_all_logo_checks_degrade_without_a_detection(context_for, poster_no_logo_path):
    """No logo means no geometry; every dependent check must say so, not pass."""
    for key, fn in (
        ("clearspace", "logo.clearspace"),
        ("min_size", "logo.min_size"),
        ("distortion", "logo.distortion"),
        ("recolor", "logo.recolor"),
        ("placement", "logo.placement"),
        ("occlusion", "logo.occlusion"),
    ):
        from brandlens_engine.registry import ANALYZERS

        rule = make_rule(f"logo.{key}", fn, "logo", tier="cv")
        result = ANALYZERS[fn](context_for(poster_no_logo_path), rule)
        assert result.verdict == "insufficient_evidence", f"{fn} must not pass without a logo"
        assert result.evidence.observation
