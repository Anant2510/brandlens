"""Colour science and the three colour analyzers."""

from __future__ import annotations

import numpy as np
import pytest

from brandlens_engine.color import (
    check_dominance_ratio,
    check_forbidden,
    check_palette_conformance,
    ciede2000,
    delta_e_hex,
    extract_palette,
    hex_to_lab,
    is_neutral,
    lab_to_hex,
    nearest_token,
    parse_hex,
    photo_region_mask,
    rgb_to_lab,
    srgb_to_linear,
    tint_shade_distance,
    xyz_to_lab,
)

from .conftest import BRAND_BLUE, BRAND_SAND, OFF_PALETTE_RED, make_rule

# Sharma/Melgosa/Noor CIEDE2000 verification data. If any of these drift the
# implementation is wrong, full stop — these are the reference values every
# colour-management vendor is checked against.
SHARMA_CASES: list[tuple[tuple[float, float, float], tuple[float, float, float], float]] = [
    ((50.0000, 2.6772, -79.7751), (50.0000, 0.0000, -82.7485), 2.0425),
    ((50.0000, 3.1571, -77.2803), (50.0000, 0.0000, -82.7485), 2.8615),
    ((50.0000, 2.8361, -74.0200), (50.0000, 0.0000, -82.7485), 3.4412),
    ((50.0000, -1.3802, -84.2814), (50.0000, 0.0000, -82.7485), 1.0000),
    ((50.0000, -0.9009, -85.5211), (50.0000, 0.0000, -82.7485), 1.0000),
    ((50.0000, 0.0000, 0.0000), (50.0000, -1.0000, 2.0000), 2.3669),
    ((50.0000, 2.4900, -0.0010), (50.0000, -2.4900, 0.0009), 7.1792),
    ((50.0000, 2.4900, -0.0010), (50.0000, -2.4900, 0.0011), 7.2195),
    ((50.0000, -0.0010, 2.4900), (50.0000, 0.0009, -2.4900), 4.8045),
    ((50.0000, 2.5000, 0.0000), (50.0000, 0.0000, -2.5000), 4.3065),
    ((50.0000, 2.5000, 0.0000), (73.0000, 25.0000, -18.0000), 27.1492),
    ((50.0000, 2.5000, 0.0000), (61.0000, -5.0000, 29.0000), 22.8977),
    ((50.0000, 2.5000, 0.0000), (56.0000, -27.0000, -3.0000), 31.9030),
    ((50.0000, 2.5000, 0.0000), (58.0000, 24.0000, 15.0000), 19.4535),
    ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
    ((63.0109, -31.0961, -5.8663), (62.8187, -29.7946, -4.0864), 1.2630),
    ((22.7233, 20.0904, -46.6940), (23.0331, 14.9730, -42.5619), 2.0373),
    ((36.4612, 47.8580, 18.3852), (36.2715, 50.5065, 21.2231), 1.4146),
    ((90.8027, -2.0831, 1.4410), (91.1528, -1.6435, 0.0447), 1.4441),
    ((2.0776, 0.0795, -1.1350), (0.9033, -0.0636, -0.5514), 0.9082),
]


@pytest.mark.parametrize(("lab1", "lab2", "expected"), SHARMA_CASES)
def test_ciede2000_matches_sharma_reference(lab1, lab2, expected):
    got = float(ciede2000(np.array([lab1]), np.array([lab2]))[0])
    assert got == pytest.approx(expected, abs=1e-4)


def test_ciede2000_is_symmetric_and_zero_on_identity():
    a, b = (55.0, 12.0, -30.0), (60.0, -4.0, 18.0)
    assert float(ciede2000(np.array([a]), np.array([a]))[0]) == pytest.approx(0.0, abs=1e-9)
    forward = float(ciede2000(np.array([a]), np.array([b]))[0])
    backward = float(ciede2000(np.array([b]), np.array([a]))[0])
    assert forward == pytest.approx(backward, abs=1e-9)


def test_ciede2000_blue_rotation_term_is_present():
    """Near 275deg hue the R_T term makes dE2000 differ materially from a plain
    dL/dC/dH root-sum-square. If R_T were dropped these would agree."""
    lab1 = (50.0, 2.6772, -79.7751)
    lab2 = (50.0, 0.0, -82.7485)
    de = float(ciede2000(np.array([lab1]), np.array([lab2]))[0])
    naive = float(np.sqrt(sum((x - y) ** 2 for x, y in zip(lab1, lab2, strict=True))))
    assert de == pytest.approx(2.0425, abs=1e-4)
    assert abs(de - naive) > 0.5


def test_srgb_lab_roundtrip():
    for hex_value in ("#000000", "#FFFFFF", "#0B5FFF", "#D7263D", "#7F7F7F"):
        assert lab_to_hex(hex_to_lab(hex_value)) == hex_value.upper()


def test_known_lab_anchor_values():
    assert hex_to_lab("#FFFFFF")[0] == pytest.approx(100.0, abs=1e-3)
    assert hex_to_lab("#000000") == pytest.approx((0.0, 0.0, 0.0), abs=1e-6)
    # 50% mid grey in sRGB is L*~53.6, not 50 — the transfer function is not linear.
    assert hex_to_lab("#808080")[0] == pytest.approx(53.585, abs=0.01)


def test_srgb_to_linear_breakpoint():
    assert float(srgb_to_linear(np.array(0.04045))) == pytest.approx(0.04045 / 12.92, abs=1e-9)
    assert float(srgb_to_linear(np.array(1.0))) == pytest.approx(1.0, abs=1e-9)


def test_xyz_to_lab_on_d65_white():
    assert xyz_to_lab(np.array([95.047, 100.0, 108.883]))[0] == pytest.approx(100.0, abs=1e-6)


def test_parse_hex_forms():
    assert parse_hex("#fff") == (255, 255, 255)
    assert parse_hex("0B5FFF") == (11, 95, 255)
    assert parse_hex("#0B5FFFAA") == (11, 95, 255)
    with pytest.raises(ValueError):
        parse_hex("not-a-colour")


def test_black_white_delta_e_is_100():
    assert delta_e_hex("#000000", "#FFFFFF") == pytest.approx(100.0, abs=0.01)


def test_just_noticeable_difference_is_around_one():
    """A 1-unit dE is the classic JND. #0B5FFF vs a one-step neighbour must be small."""
    assert delta_e_hex("#0B5FFF", "#0C5FFF") < 1.0
    assert delta_e_hex("#0B5FFF", BRAND_SAND) > 40.0


def test_is_neutral_separates_greys_from_brand_colour():
    assert is_neutral(hex_to_lab("#7F7F7F"))
    assert is_neutral(hex_to_lab("#FFFFFF"))
    assert not is_neutral(hex_to_lab(BRAND_BLUE))


def test_nearest_token_picks_the_closest():
    tokens = [hex_to_lab(BRAND_BLUE), hex_to_lab(BRAND_SAND)]
    idx, de = nearest_token(hex_to_lab("#0C60FE"), tokens)
    assert idx == 0
    assert de < 1.5
    assert nearest_token(hex_to_lab("#123456"), [])[0] == -1


def test_extract_palette_recovers_flat_fills(flat_brand_image):
    palette = extract_palette(flat_brand_image, k=4)
    assert palette.entries
    top_two = sorted(palette.entries, key=lambda e: -e.share)[:2]
    for entry in top_two:
        assert min(delta_e_hex(entry.hex, BRAND_BLUE), delta_e_hex(entry.hex, BRAND_SAND)) < 3.0
    # Flat fills must have near-zero cluster spread; that is how we tell them
    # apart from gradients and photographic regions.
    assert all(e.spread < 3.0 for e in top_two)


def test_extract_palette_is_deterministic(flat_brand_image):
    first = [e.hex for e in extract_palette(flat_brand_image, k=5).entries]
    second = [e.hex for e in extract_palette(flat_brand_image, k=5).entries]
    assert first == second


def test_photo_region_mask_ignores_flat_art_and_flags_noise(flat_brand_image):
    assert photo_region_mask(flat_brand_image).mean() < 0.05
    rng = np.random.default_rng(3)
    noisy = rng.integers(0, 255, size=(160, 160, 3), dtype=np.uint8)
    assert photo_region_mask(noisy).mean() > 0.8


def test_tint_shade_accepts_a_legal_tint_and_rejects_a_foreign_hue():
    """40% brand blue on white is a legal tint; a red of similar lightness is not."""
    blue_lab = hex_to_lab(BRAND_BLUE)
    tint_rgb = tuple(int(round(0.4 * c + 0.6 * 255)) for c in parse_hex(BRAND_BLUE))
    tint_lab = tuple(float(v) for v in rgb_to_lab(np.array(tint_rgb, dtype=np.float64)))

    de_direct = float(ciede2000(np.array([tint_lab]), np.array([blue_lab]))[0])
    de_tint, fraction = tint_shade_distance(tint_lab, blue_lab, allowed_tints=[20, 40, 60, 80])
    assert de_direct > 15.0, "the tint is far from the token in plain dE"
    assert de_tint < 6.0, "but close to a legal point on the tint ramp"
    assert fraction == pytest.approx(0.4, abs=0.01)

    red_lab = hex_to_lab(OFF_PALETTE_RED)
    de_red, _ = tint_shade_distance(red_lab, blue_lab, allowed_tints=[20, 40, 60, 80])
    assert de_red > 20.0


def test_tint_shade_respects_a_restricted_stop_list():
    blue_lab = hex_to_lab(BRAND_BLUE)
    tint_rgb = tuple(int(round(0.4 * c + 0.6 * 255)) for c in parse_hex(BRAND_BLUE))
    tint_lab = tuple(float(v) for v in rgb_to_lab(np.array(tint_rgb, dtype=np.float64)))
    # A brand that lists only 80% does not thereby permit 40%.
    de, fraction = tint_shade_distance(tint_lab, blue_lab, allowed_tints=[80])
    assert fraction == pytest.approx(0.8, abs=0.01)
    assert de > 10.0


# ---------------------------------------------------------------------------
# analyzers
# ---------------------------------------------------------------------------
def test_palette_conformance_passes_on_brand_artwork(context_for, poster_path):
    rule = make_rule("color.palette", "color.palette_conformance", "color", tier="cv")
    result = check_palette_conformance(context_for(poster_path), rule)
    assert result.verdict == "pass"
    assert result.evidence.measured["offendingShare"] <= result.evidence.threshold["maxOffendingShare"]
    assert result.evidence.threshold["maxDeltaE"] == 3.0


def test_palette_conformance_fails_on_a_large_off_palette_band(context_for, poster_off_palette_path):
    rule = make_rule(
        "color.palette",
        "color.palette_conformance",
        "color",
        tier="cv",
        params={"maxOffendingShare": 0.02, "minShare": 0.02},
    )
    result = check_palette_conformance(context_for(poster_off_palette_path), rule)
    assert result.verdict == "fail"
    assert result.evidence.measured["offending"]
    assert "dE2000" in (result.evidence.observation or "")


def test_palette_conformance_is_not_applicable_without_tokens(context_for, poster_path, brand):
    brand.color_tokens = []
    ctx = context_for(poster_path)
    ctx.request.brand = brand
    rule = make_rule("color.palette", "color.palette_conformance", "color", tier="cv")
    assert check_palette_conformance(ctx, rule).verdict == "not_applicable"


def test_forbidden_colour_detected(context_for, poster_off_palette_path):
    rule = make_rule("color.forbidden", "color.forbidden", "color", tier="cv", params={"minShare": 0.02})
    result = check_forbidden(context_for(poster_off_palette_path), rule)
    assert result.verdict == "fail"
    assert result.evidence.measured["hits"][0]["forbiddenHex"] == OFF_PALETTE_RED
    assert "competitor" in (result.evidence.observation or "")


def test_forbidden_colour_absent_passes(context_for, poster_path):
    rule = make_rule("color.forbidden", "color.forbidden", "color", tier="cv", params={"minShare": 0.05})
    result = check_forbidden(context_for(poster_path), rule)
    assert result.verdict == "pass"
    assert result.evidence.measured["closestDeltaE"] is not None


def test_dominance_ratio_reports_role_mix(context_for, poster_path):
    rule = make_rule(
        "color.dominance",
        "color.dominance_ratio",
        "color",
        tier="cv",
        params={"roleRatios": {"primary": 0.2, "accent": 0.8}, "tolerancePct": 40},
    )
    result = check_dominance_ratio(context_for(poster_path), rule)
    assert result.verdict in ("pass", "fail")
    assert set(result.evidence.measured["roleShare"]).issubset({"primary", "secondary", "accent", "unassigned"})
    assert abs(sum(result.evidence.measured["roleShare"].values()) - 1.0) < 0.01


def test_colour_analyzers_degrade_when_the_asset_is_missing(context_for):
    ctx = context_for("/nonexistent/file.png")
    rule = make_rule("color.palette", "color.palette_conformance", "color", tier="cv")
    result = check_palette_conformance(ctx, rule)
    assert result.verdict == "insufficient_evidence"
    assert ctx.warnings
