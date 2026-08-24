"""Channel-spec conformance against the shape the registry actually ships.

The bug these cover: the analyzer read `width`/`height`/`maxFileSizeKb` and the
registry publishes `referenceSize`/`aspectRatios`/`maxBytes`, so a
blocker-severity rule looked at a real Meta Story spec, recognised nothing, and
returned `not_applicable` — a silent pass on the one check in the product that
is pure arithmetic. Most of what follows is therefore written against verbatim
copies of registry rows rather than against invented specs.
"""

from __future__ import annotations

from pathlib import Path

import pymupdf
import pytest
from PIL import Image

from brandlens_engine.channel_spec import (
    SPEC_KEYS,
    check_conformance,
    legal_font_floor_pt,
    resolve_spec,
    safe_zone_rects,
)
from tests.conftest import make_rule

# --- verbatim registry rows -------------------------------------------------
META_STORY = {
    "referenceSize": {"width": 1080, "height": 1920},
    "aspectRatios": [{"w": 9, "h": 16, "tolerance": 0.01, "preferred": True}],
    "minWidth": 1080,
    "minHeight": 1920,
    "maxBytes": 30 * 1024 * 1024,
    "formats": ["jpg", "jpeg", "png"],
    "colorSpace": "sRGB",
    "safeZones": {"top": 250, "right": 0, "bottom": 340, "left": 0},
    "textLimits": {"primary": 125},
    "notes": "Keep logo, headline and any legal copy inside the middle 1330px.",
}

TIKTOK_VIDEO = {
    "referenceSize": {"width": 1080, "height": 1920},
    "aspectRatios": [{"w": 9, "h": 16, "tolerance": 0.01, "preferred": True}],
    "minWidth": 720,
    "minHeight": 1280,
    "maxBytes": 500 * 1024 * 1024,
    "formats": ["mp4", "mov"],
    "durationMs": {"min": 5000, "max": 60_000},
    "fps": {"min": 23, "max": 60},
    "videoCodec": ["h264"],
    "safeZones": {"top": 120, "right": 120, "bottom": 310, "left": 60},
}

PRINT_A4 = {
    "referenceSize": {"width": 2551, "height": 3579},
    "trimSize": {"widthMm": 210, "heightMm": 297},
    "bleedMm": 3,
    "safetyMarginMm": 5,
    "aspectRatios": [{"w": 210, "h": 297, "tolerance": 0.02}],
    "minDpi": 300,
    "maxBytes": 200 * 1024 * 1024,
    "formats": ["pdf", "tiff", "png"],
    "colorSpace": "CMYK",
    "safeZones": {"top": 94, "right": 94, "bottom": 94, "left": 94},
    "minLegalFontPt": 6,
    "requiresCropMarks": True,
    "requiresOutlinedFonts": True,
    "totalInkCoverageMaxPct": 300,
}


def _png(path: Path, size: tuple[int, int], dpi: tuple[int, int] | None = None, mode: str = "RGB") -> str:
    img = Image.new(mode, size, "white" if mode != "CMYK" else (0, 0, 0, 0))
    img.save(path, dpi=dpi) if dpi else img.save(path)
    return str(path)


def _run(context_for, uri: str, spec: dict, **asset):
    ctx = context_for(uri, **asset)
    ctx.request.brand.channel_spec = spec
    rule = make_rule("channel", "channel_spec.conformance", "channel_spec", severity="blocker")
    return ctx, check_conformance(ctx, rule)


def _constraints(result) -> set[str]:
    return {v["constraint"] for v in result.evidence.measured["violations"]}


# ---------------------------------------------------------------------------
# resolution of the spec itself
# ---------------------------------------------------------------------------
class TestResolveSpec:
    def test_recognises_a_flat_registry_row(self):
        """The API selects one row by platform/placement and sends it flat.

        This returning `(None, "none")` is the whole original defect: the flat
        test looked for `width`/`aspectRatio`/`maxFileSizeKb`, none of which a
        registry row has ever contained.
        """
        spec, key = resolve_spec(META_STORY, "meta-story", "image")
        assert key == "flat"
        assert spec is not None and spec["minHeight"] == 1920

    def test_prefers_the_channel_keyed_entry(self):
        bundle = {"meta-story:image": META_STORY, "_default": {"minWidth": 1}}
        _, key = resolve_spec(bundle, "meta-story", "image")
        assert key == "meta-story:image"

    def test_a_map_of_placements_is_not_a_flat_spec(self):
        # Placement names are not vocabulary, so a bundle with no match falls
        # through to "none" rather than being read as one giant spec.
        spec, key = resolve_spec({"some-other-channel": META_STORY}, "meta-story", "image")
        assert (spec, key) == (None, "none")


# ---------------------------------------------------------------------------
# the social placements
# ---------------------------------------------------------------------------
class TestSocialConformance:
    def test_a_square_image_fails_a_story_placement(self, scratch, context_for):
        uri = _png(scratch / "square.png", (1080, 1080))
        _, result = _run(context_for, uri, META_STORY, channel="meta-story", asset_type="image")
        assert result.verdict == "fail"
        assert _constraints(result) == {"minHeight", "aspectRatios"}
        assert "9:16" in str(result.evidence.threshold) or "0.5625" in result.evidence.observation

    def test_a_correct_story_image_passes(self, scratch, context_for):
        uri = _png(scratch / "story.png", (1080, 1920))
        _, result = _run(context_for, uri, META_STORY, channel="meta-story", asset_type="image")
        assert result.verdict == "pass", result.evidence.observation

    def test_a_permitted_but_non_preferred_ratio_is_advisory_not_a_failure(self, scratch, context_for):
        spec = dict(META_STORY)
        spec["aspectRatios"] = [
            {"w": 9, "h": 16, "tolerance": 0.01, "preferred": True},
            {"w": 4, "h": 5, "tolerance": 0.01},
        ]
        spec["minHeight"] = 1000
        uri = _png(scratch / "fourfive.png", (1080, 1350))
        _, result = _run(context_for, uri, spec, channel="meta-story", asset_type="image")
        assert result.verdict == "pass"
        assert any("preferred" in a for a in result.evidence.measured["advisories"])

    def test_the_wrong_format_is_named_with_what_is_allowed(self, scratch, context_for):
        path = scratch / "story.gif"
        Image.new("RGB", (1080, 1920), "white").save(path)
        _, result = _run(context_for, str(path), META_STORY, channel="meta-story", asset_type="image")
        assert "formats" in _constraints(result)
        assert "'gif' is not in" in result.evidence.observation

    def test_an_oversized_file_reports_megabytes_not_bytes(self, scratch, context_for):
        spec = dict(META_STORY, maxBytes=4096)
        uri = _png(scratch / "story.png", (1080, 1920))
        _, result = _run(context_for, uri, spec, channel="meta-story", asset_type="image")
        assert "maxBytes" in _constraints(result)
        assert "MB against a" in result.evidence.observation


# ---------------------------------------------------------------------------
# every key accounted for
# ---------------------------------------------------------------------------
class TestAccounting:
    def test_video_keys_are_reported_as_unenforced_rather_than_ignored(self, scratch, context_for):
        uri = _png(scratch / "frame.png", (1080, 1920))
        ctx, result = _run(context_for, uri, TIKTOK_VIDEO, channel="tiktok-in-feed", asset_type="video")
        unenforced = {i["key"]: i for i in result.evidence.measured["notEnforcedHere"]}
        assert {"durationMs", "fps", "videoCodec"} <= set(unenforced)
        assert unenforced["fps"]["role"] == "unmeasurable"
        # And loudly, not just in a field nobody opens.
        assert any("fps was not enforced" in w for w in ctx.warnings)

    def test_delegated_keys_name_the_analyzer_that_does_enforce_them(self, scratch, context_for):
        uri = _png(scratch / "story.png", (1080, 1920))
        _, result = _run(context_for, uri, META_STORY, channel="meta-story", asset_type="image")
        delegated = {i["key"]: i["by"] for i in result.evidence.measured["notEnforcedHere"] if i["role"] == "delegated"}
        assert delegated["safeZones"] == "layout.safe_zone"
        assert "layout.safe_zone" in result.evidence.observation or "safeZones" in result.evidence.observation

    def test_a_key_nobody_reads_is_surfaced_as_a_warning(self, scratch, context_for):
        spec = dict(META_STORY, maxTextOverlayPct=20)
        uri = _png(scratch / "story.png", (1080, 1920))
        ctx, result = _run(context_for, uri, spec, channel="meta-story", asset_type="image")
        assert result.evidence.measured["unrecognisedKeys"] == ["maxTextOverlayPct"]
        assert any("unrecognised key" in w for w in ctx.warnings)

    def test_every_shipped_key_has_a_role(self):
        for spec in (META_STORY, TIKTOK_VIDEO, PRINT_A4):
            assert not (set(spec) - set(SPEC_KEYS))


# ---------------------------------------------------------------------------
# print
# ---------------------------------------------------------------------------
def _print_pdf(
    path: Path,
    *,
    trim_mm: tuple[float, float] = (210, 297),
    bleed_mm: float = 3.0,
    ink: tuple[float, float, float, float] = (0.1, 0.1, 0.1, 0.5),
    marks: bool = True,
    live_text: bool = True,
) -> str:
    """An A4 print PDF built as a raw content stream.

    Raw, because the drawing API only speaks RGB and the point of the exercise
    is a file carrying real DeviceCMYK separations — which is what makes total
    ink coverage a measurement rather than a guess.
    """
    pt = 72.0 / 25.4
    media = ((trim_mm[0] + 2 * bleed_mm) * pt, (trim_mm[1] + 2 * bleed_mm) * pt)
    x0, y0 = bleed_mm * pt, bleed_mm * pt
    x1, y1 = x0 + trim_mm[0] * pt, y0 + trim_mm[1] * pt

    ops = [f"{ink[0]} {ink[1]} {ink[2]} {ink[3]} k 0 0 {media[0]:.2f} {media[1]:.2f} re f"]
    if marks:
        # A crop mark: a short rule wholly outside the trim box.
        ops.append(f"0 0 0 1 K 1 w {x0 - 12:.2f} {y0:.2f} m {x0 - 4:.2f} {y0:.2f} l S")
    stream = "\n".join(ops).encode()

    objects = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        (
            f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 {media[0]:.2f} {media[1]:.2f}]"
            f"/TrimBox[{x0:.2f} {y0:.2f} {x1:.2f} {y1:.2f}]/Contents 4 0 R"
            f"/Resources<</Font<</F1 5 0 R>>>>>>"
        ).encode(),
        b"<</Length %d>>stream\n%s\nendstream" % (len(stream), stream),
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ]
    body = b"%PDF-1.4\n"
    for index, obj in enumerate(objects, start=1):
        body += b"%d 0 obj" % index + obj + b"endobj\n"
    body += b"trailer<</Root 1 0 R>>"
    path.write_bytes(body)

    if live_text:
        # Re-open and add extractable text, so `requiresOutlinedFonts` has
        # something real to find rather than a hand-written string in a stream.
        # A full rewrite, not an incremental one: MuPDF repairs the xref-less
        # file above on open and refuses to append to a repaired document.
        doc = pymupdf.open(path)
        doc[0].insert_text((x0 + 40, y0 + 60), "Terms apply.", fontname="helv", fontsize=6.5)
        data = doc.tobytes()
        doc.close()
        path.write_bytes(data)
    return str(path)


class TestPrint:
    def test_a_conforming_pdf_reports_its_trim_and_bleed(self, scratch, context_for):
        uri = _print_pdf(scratch / "ok.pdf", ink=(0.1, 0.1, 0.1, 0.4), live_text=False)
        _, result = _run(context_for, uri, PRINT_A4, kind="pdf", channel="print-a4", asset_type="image")
        printed = result.evidence.measured["print"]
        assert printed["trimMm"] == pytest.approx([210, 297], abs=0.5)
        assert printed["bleedMm"] == pytest.approx(3.0, abs=0.1)
        assert "bleedMm" not in _constraints(result)
        assert "trimSize" not in _constraints(result)

    def test_a_pdf_with_no_trim_box_is_a_bleed_failure(self, scratch, context_for):
        path = scratch / "notrim.pdf"
        doc = pymupdf.open()
        doc.new_page(width=595, height=842)
        doc.save(path)
        doc.close()
        _, result = _run(context_for, str(path), PRINT_A4, kind="pdf", channel="print-a4", asset_type="image")
        assert "bleedMm" in _constraints(result)
        assert "no trim box" in result.evidence.observation or "declares no trim box" in str(result.evidence.measured["violations"])

    def test_ink_coverage_is_measured_from_the_real_separations(self, scratch, context_for):
        # 60/50/50/100 is a rich black at 260%; the ceiling is 300%, so it
        # passes, and the number reported has to be the authored one.
        uri = _print_pdf(scratch / "rich.pdf", ink=(0.6, 0.5, 0.5, 1.0), live_text=False)
        _, result = _run(context_for, uri, PRINT_A4, kind="pdf", channel="print-a4", asset_type="image")
        assert result.evidence.measured["print"]["inkCoverageP999Pct"] == pytest.approx(260, abs=3)
        assert "totalInkCoverageMaxPct" not in _constraints(result)

    def test_ink_over_the_ceiling_fails_with_the_area_affected(self, scratch, context_for):
        uri = _print_pdf(scratch / "heavy.pdf", ink=(0.9, 0.9, 0.9, 1.0), live_text=False)
        _, result = _run(context_for, uri, PRINT_A4, kind="pdf", channel="print-a4", asset_type="image")
        assert "totalInkCoverageMaxPct" in _constraints(result)
        assert result.evidence.measured["print"]["inkOverLimitAreaPct"] > 50
        assert "will not dry" in result.evidence.observation or any(
            "will not dry" in str(v["detail"]) for v in result.evidence.measured["violations"]
        )

    def test_ink_is_not_guessed_from_an_rgb_source(self, scratch, context_for):
        """The false pass this refuses to produce is the reason it exists.

        Converting RGB to CMYK invents the black generation: solid RGB black
        becomes 100% K and reports a comfortable 100% for artwork that may
        carry 320% once it is separated properly.
        """
        uri = _png(scratch / "a4.png", (2551, 3579), dpi=(300, 300))
        ctx, result = _run(context_for, uri, PRINT_A4, channel="print-a4", asset_type="image")
        skipped = {i["constraint"] for i in result.evidence.measured["notMeasurable"]}
        assert "totalInkCoverageMaxPct" in skipped
        assert any("not CMYK" in w for w in ctx.warnings)

    def test_a_raster_at_trim_size_is_told_it_has_no_bleed(self, scratch, context_for):
        # 210x297mm at 300dpi with no bleed — the single most common reason a
        # print job comes back.
        uri = _png(scratch / "trimonly.png", (2480, 3508), dpi=(300, 300))
        _, result = _run(context_for, uri, PRINT_A4, channel="print-a4", asset_type="image")
        assert "bleedMm" in _constraints(result)
        assert "no bleed" in result.evidence.observation

    def test_a_correctly_bled_raster_passes_the_geometry(self, scratch, context_for):
        uri = _png(scratch / "bled.png", (2551, 3579), dpi=(300, 300))
        _, result = _run(context_for, uri, PRINT_A4, channel="print-a4", asset_type="image")
        assert "bleedMm" not in _constraints(result)
        assert "trimSize" not in _constraints(result)

    def test_a_file_declaring_no_resolution_is_not_treated_as_96dpi(self, scratch, context_for):
        uri = _png(scratch / "nodpi.png", (2551, 3579))
        _, result = _run(context_for, uri, PRINT_A4, channel="print-a4", asset_type="image")
        assert result.evidence.measured["dpiBasis"] == "implied by the trim size"
        assert result.evidence.measured["dpi"] == pytest.approx(300, abs=2)
        assert "minDpi" not in _constraints(result)
        # Bleed, though, cannot be checked from a resolution the pixels imply —
        # that comparison would be circular and would always pass.
        assert "bleedMm" in {i["constraint"] for i in result.evidence.measured["notMeasurable"]}

    def test_vector_artwork_does_not_fail_a_dpi_floor(self, scratch, context_for):
        uri = _print_pdf(scratch / "vector.pdf", live_text=False)
        _, result = _run(context_for, uri, PRINT_A4, kind="pdf", channel="print-a4", asset_type="image")
        assert "minDpi" not in _constraints(result)
        assert result.evidence.measured["dpiBasis"].startswith("vector artwork")

    def test_live_text_fails_an_outlined_fonts_requirement(self, scratch, context_for):
        uri = _print_pdf(scratch / "livetext.pdf", live_text=True)
        _, result = _run(context_for, uri, PRINT_A4, kind="pdf", channel="print-a4", asset_type="image")
        assert "requiresOutlinedFonts" in _constraints(result)

    def test_missing_crop_marks_are_caught(self, scratch, context_for):
        uri = _print_pdf(scratch / "nomarks.pdf", marks=False, live_text=False)
        _, result = _run(context_for, uri, PRINT_A4, kind="pdf", channel="print-a4", asset_type="image")
        assert "requiresCropMarks" in _constraints(result)

    def test_an_rgb_file_fails_a_cmyk_requirement(self, scratch, context_for):
        uri = _png(scratch / "rgb.png", (2551, 3579), dpi=(300, 300))
        _, result = _run(context_for, uri, PRINT_A4, channel="print-a4", asset_type="image")
        assert "colorSpace" in _constraints(result)


# ---------------------------------------------------------------------------
# geometry handed to the analyzers that enforce it
# ---------------------------------------------------------------------------
class TestDelegatedGeometry:
    def test_pixel_insets_scale_off_the_reference_size(self):
        zones = {z["name"]: z["bbox"] for z in safe_zone_rects(META_STORY)}
        # 250 of 1920 at the top, 340 at the bottom; the sides are zero and so
        # produce no zone at all rather than a degenerate one.
        assert zones["top chrome"] == pytest.approx([0, 0, 1, 250 / 1920], abs=1e-6)
        assert zones["bottom chrome"] == pytest.approx([0, 1 - 340 / 1920, 1, 1], abs=1e-6)
        assert set(zones) == {"top chrome", "bottom chrome"}

    def test_print_zones_come_out_of_millimetres_when_no_pixels_are_published(self):
        spec = {k: v for k, v in PRINT_A4.items() if k != "safeZones"}
        zones = {z["name"]: z["bbox"] for z in safe_zone_rects(spec)}
        # (3mm bleed + 5mm margin) of a 216mm-wide canvas.
        assert zones["left bleed + safety margin"][2] == pytest.approx(8 / 216, abs=1e-6)
        assert all(z["source"] == "trimSize" for z in safe_zone_rects(spec))

    def test_no_zones_without_a_reference_size_rather_than_wrong_ones(self):
        assert safe_zone_rects({"safeZones": {"top": 250}}) == []

    def test_the_legal_type_floor_converts_pixels_at_the_reference_resolution(self):
        assert legal_font_floor_pt({"minLegalFontPt": 6}, 300) == (6.0, "channelSpec.minLegalFontPt")
        floor, basis = legal_font_floor_pt({"minLegalFontPx": 10}, 96)
        assert floor == pytest.approx(7.5)
        assert basis == "channelSpec.minLegalFontPx"
        assert legal_font_floor_pt({}, 96) is None


class TestDelegationActuallyHappens:
    """The delegation has to be real, or `notEnforcedHere` is just an excuse."""

    def test_safe_zone_reads_the_channel_spec_when_the_rule_names_no_zones(self, scratch, context_for):
        from brandlens_engine.layout import check_safe_zone

        # A headline sitting in the top 13% of a Story canvas, under the
        # profile row Meta draws over the first 250px.
        img = Image.new("RGB", (1080, 1920), "white")
        img.paste(Image.new("RGB", (600, 90), "black"), (200, 60))
        path = scratch / "intrusion.png"
        img.save(path)

        ctx = context_for(str(path), channel="meta-story", asset_type="image")
        ctx.request.brand.channel_spec = META_STORY
        rule = make_rule("sz", "layout.safe_zone", "layout", tier="cv", params={"intrusionToleranceFrac": 0.02})
        result = check_safe_zone(ctx, rule)

        assert result.evidence.measured["zoneSource"] == "channelSpec[flat]"
        assert result.verdict == "fail"
        assert result.evidence.measured["intrusions"][0]["zone"] == "top chrome"

    def test_safe_zone_says_so_when_neither_source_has_zones(self, scratch, context_for):
        from brandlens_engine.layout import check_safe_zone

        uri = _png(scratch / "plain.png", (800, 600))
        ctx = context_for(uri, channel="unknown-channel", asset_type="image")
        result = check_safe_zone(ctx, make_rule("sz", "layout.safe_zone", "layout", tier="cv"))
        assert result.verdict == "not_applicable"
        assert result.evidence.measured["zoneSource"] == "none"
        assert "channel spec registry" in result.evidence.observation

    def test_min_size_applies_the_placement_floor_over_the_brand_one(self, scratch, context_for):
        from brandlens_engine.typography import check_min_size

        # Both floors apply and the larger wins, because each was set for a
        # reason: the brand's smallest approved style is 20pt here, so a 9pt
        # placement floor changes nothing and is merely reported.
        ctx = context_for(_pdf_with_small_type(scratch), kind="pdf", channel="display", asset_type="image")
        ctx.request.brand.channel_spec = {"minLegalFontPt": 9}
        floors = check_min_size(ctx, make_rule("ts", "typography.min_size", "typography"))
        assert floors.evidence.threshold["channelFloorPt"] == 9.0
        assert all("channelSpec" not in o["basis"] for o in floors.evidence.measured["offenders"])

        # Raise it above every style floor and the placement becomes the
        # binding constraint, which is the case a display banner is: there is
        # no room on a 300x250 unit for type the brand book considers legible.
        ctx2 = context_for(_pdf_with_small_type(scratch), kind="pdf", channel="display", asset_type="image")
        ctx2.request.brand.channel_spec = {"minLegalFontPt": 22}
        raised = check_min_size(ctx2, make_rule("ts", "typography.min_size", "typography"))
        assert raised.verdict == "fail"
        assert any(o["basis"].startswith("channelSpec.minLegalFontPt") for o in raised.evidence.measured["offenders"])

    def test_min_size_still_runs_on_a_brand_with_no_type_styles(self, scratch, context_for, brand):
        from brandlens_engine.typography import check_min_size

        # Without the channel floor this returns `not_applicable`, which on a
        # verdict list is indistinguishable from a pass.
        ctx = context_for(_pdf_with_small_type(scratch), kind="pdf", channel="display", asset_type="image")
        ctx.request.brand.type_styles = []
        ctx.request.brand.channel_spec = {"minLegalFontPt": 10}
        result = check_min_size(ctx, make_rule("ts", "typography.min_size", "typography"))
        assert result.verdict == "fail"


def _pdf_with_small_type(scratch) -> str:
    path = scratch / "smalltype.pdf"
    if not path.exists():
        doc = pymupdf.open()
        page = doc.new_page(width=300, height=250)
        page.insert_text((20, 60), "Headline here", fontname="helv", fontsize=24)
        page.insert_text((20, 220), "Terms apply. 18+ only.", fontname="helv", fontsize=6.5)
        doc.save(path)
        doc.close()
    return str(path)


class TestAssembleReadsTheSameVocabulary:
    """The planner and the validator have to agree on what a spec says.

    They did not: `build_plan` read `spec["width"]`, which a registry row has
    never carried, so every plan it produced named a null canvas size and
    ranked candidates with no target aspect to score against — the same bug as
    the validator's, in the half of the product that is supposed to prevent the
    violation rather than find it.
    """

    def _request(self, brand, poster_path):
        from brandlens_engine.models import AssembleBrief, AssembleCandidate, AssembleRequest

        brand.channel_spec = {"meta-story:image": META_STORY}
        request = AssembleRequest(
            request_id="r",
            org_id="o",
            brand=brand,
            brief=AssembleBrief(title="Spring", key_message="Move money the modern way"),
            candidate_assets=[
                AssembleCandidate(id="c1", name="Portrait", uri=poster_path, width=1080, height=1920),
                AssembleCandidate(id="c2", name="Wide", uri=poster_path, width=1200, height=400),
            ],
            rules=[],
            provider="anthropic",
            model="claude-sonnet-4-5-20250929",
        )
        request.brief.targets = [{"channel": "meta-story", "assetType": "image"}]
        return request

    def test_the_canvas_size_comes_from_the_reference_size(self, brand, poster_path):
        from brandlens_engine.assemble import build_plan

        items, _ = build_plan(self._request(brand, poster_path))
        assert (items[0]["widthPx"], items[0]["heightPx"]) == (1080, 1920)
        assert items[0]["backgroundAssetId"] == "c1", "a target aspect must exist for ranking to discriminate"

    def test_published_safe_zones_shape_the_layout_without_any_rule(self, brand, poster_path):
        from brandlens_engine.assemble import build_plan

        items, _ = build_plan(self._request(brand, poster_path))
        assert items[0]["constraintsEnforced"]["safeZoneCount"] == 2
        legal = next(s for s in items[0]["layout"] if s["slot"] == "legal")
        # Meta's CTA sticker covers the bottom 340px of 1920.
        assert legal["bbox"][3] <= 1 - 340 / 1920 + 1e-6

    def test_a_hard_requirement_beats_the_reference_size(self):
        from brandlens_engine.channel_spec import spec_dimensions

        # Where a spec states its size more than one way, the planner has to
        # design to the strictest: an exact size is what the platform rejects
        # on, the reference size is only what the rest of the spec is quoted at.
        assert spec_dimensions(
            {"referenceSize": {"width": 300, "height": 250}, "exactSizes": [{"width": 728, "height": 90}]}
        ) == (728, 90)
        assert spec_dimensions(
            {"recommendedWidth": 1080, "recommendedHeight": 1080, "referenceSize": {"width": 600, "height": 600}}
        ) == (1080, 1080)
        assert spec_dimensions({}) is None
