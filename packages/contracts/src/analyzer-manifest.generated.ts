// GENERATED FILE — do not edit.
// Source: apps/engine/scripts/analyzer_params.py (run it after touching any analyzer)
//
// What each analyzer actually reads, extracted from the Python source by AST:
//   params    the `check.params` keys it looks up, and the default it falls
//             back to when the key is absent — which is what a rule silently
//             enforces instead of the threshold it displays.
//   ontology  the `ctx.brand.*` attributes it needs. A rule whose ontology
//             dependency is empty returns `not_applicable`, never `fail`.
//   asset     the `ctx.asset.*` fields it reads.

import type { AnalyzerContract, SpecKeyContract } from './analyzer-manifest.js';

export const GENERATED_ANALYZER_MANIFEST = {
  "accessibility.alt_text": {
    fn: "accessibility.check_alt_text",
    params: {
      "maxChars": 250,
      "minChars": 12,
    },
    ontology: [],
    asset: ["copy_fields", "kind", "structured_source"],
  },
  "accessibility.contrast": {
    fn: "accessibility.check_contrast",
    params: {
      "level": "AA",
      "maxRuns": null,
      "minRatio": null,
    },
    ontology: [],
    asset: [],
  },
  "accessibility.font_size_floor": {
    fn: "accessibility.check_font_size_floor",
    params: {
      "minSizePt": 9.0,
    },
    ontology: [],
    asset: [],
  },
  "channel_spec.conformance": {
    fn: "channel_spec.check_conformance",
    params: {
      "spec": null,
    },
    ontology: ["channel_spec"],
    asset: ["asset_type", "channel", "height", "mime_type", "uri", "width"],
  },
  "color.dominance_ratio": {
    fn: "color.check_dominance_ratio",
    params: {
      "excludePhotoRegions": true,
      "forcePixels": null,
      "k": 8,
      "maxDeltaE": 8.0,
      "roleRatios": null,
      "tolerancePct": 15.0,
    },
    ontology: ["color_tokens"],
    asset: [],
  },
  "color.forbidden": {
    fn: "color.check_forbidden",
    params: {
      "excludePhotoRegions": true,
      "forbiddenHexes": null,
      "forcePixels": null,
      "k": 8,
      "maxDeltaE": 6.0,
      "minShare": 0.02,
    },
    ontology: ["forbidden_colors"],
    asset: [],
  },
  "color.palette_conformance": {
    fn: "color.check_palette_conformance",
    params: {
      "allowTints": true,
      "excludePhotoRegions": true,
      "forcePixels": null,
      "ignoreNeutrals": true,
      "k": 8,
      "maxClusterSpread": 12.0,
      "maxDeltaE": 3.0,
      "maxOffendingShare": 0.05,
      "minShare": 0.03,
    },
    ontology: ["color_tokens"],
    asset: [],
  },
  "copy.banned_terms": {
    fn: "copy_checks.check_banned_terms",
    params: {
      "terms": null,
    },
    ontology: ["lexicon"],
    asset: ["market"],
  },
  "copy.claim_substantiation": {
    fn: "copy_checks.check_claim_substantiation",
    params: {
      "asOfDate": null,
      "fuzzyThreshold": 88.0,
      "jurisdiction": null,
    },
    ontology: ["claims", "disclaimers"],
    asset: ["market"],
  },
  "copy.cta_allowlist": {
    fn: "copy_checks.check_cta_allowlist",
    params: {
      "allowed": null,
      "allowedCtas": null,
      "caseSensitive": false,
    },
    ontology: [],
    asset: ["copy_fields"],
  },
  "copy.disclaimer_present": {
    fn: "copy_checks.check_disclaimer_present",
    params: {
      "disclaimerIds": null,
      "fuzzyThreshold": 85.0,
    },
    ontology: ["claims", "disclaimers"],
    asset: ["channel", "market"],
  },
  "copy.locale_spelling": {
    fn: "copy_checks.check_locale_spelling",
    params: {
      "locale": null,
    },
    ontology: [],
    asset: ["locale"],
  },
  "copy.readability": {
    fn: "copy_checks.check_readability",
    params: {
      "maxFleschKincaidGrade": null,
      "minFleschReadingEase": null,
      "minWords": 20,
    },
    ontology: [],
    asset: [],
  },
  "copy.required_terms": {
    fn: "copy_checks.check_required_terms",
    params: {
      "terms": null,
    },
    ontology: ["lexicon"],
    asset: ["market"],
  },
  "imagery.medium": {
    fn: "imagery.check_medium",
    params: {
      "allowedMediums": null,
      "minConfidence": 0.45,
    },
    ontology: ["image_style_profile"],
    asset: ["kind"],
  },
  "imagery.prohibited_subject": {
    fn: "imagery.check_prohibited_subject",
    params: {
      "prohibitedSubjects": null,
    },
    ontology: ["image_style_profile"],
    asset: ["kind"],
  },
  "imagery.reuse": {
    fn: "imagery.check_reuse",
    params: {
      "comparisonUris": null,
      "knownHashes": null,
      "maxHammingDistance": 8,
    },
    ontology: [],
    asset: ["kind"],
  },
  "imagery.style_conformance": {
    fn: "imagery.check_style_conformance",
    params: {
      "maxDistance": null,
    },
    ontology: ["image_style_profile"],
    asset: ["kind"],
  },
  "layout.element_overlap": {
    fn: "layout.check_element_overlap",
    params: {
      "kinds": null,
      "maxIou": 0.08,
    },
    ontology: [],
    asset: [],
  },
  "layout.grid_alignment": {
    fn: "layout.check_grid_alignment",
    params: {
      "columns": 0,
      "gutterPct": 2.0,
      "marginPct": 5.0,
      "maxOffGridRatio": 0.25,
      "tolerancePct": 1.0,
    },
    ontology: [],
    asset: [],
  },
  "layout.margins": {
    fn: "layout.check_margins",
    params: {
      "minMarginPct": null,
      "minPct": 4.0,
      "perEdgePct": null,
    },
    ontology: [],
    asset: ["kind"],
  },
  "layout.safe_zone": {
    fn: "layout.check_safe_zone",
    params: {
      "insetPct": null,
      "intrusionToleranceFrac": 0.02,
      "safeZones": null,
      "zones": null,
    },
    ontology: ["channel_spec"],
    asset: ["asset_type", "channel"],
  },
  "layout.text_density": {
    fn: "layout.check_text_density",
    params: {
      "cells": 5,
      "maxOccupiedCells": 5,
    },
    ontology: [],
    asset: [],
  },
  "logo.clearspace": {
    fn: "logo.check_clearspace",
    params: {
      "basis": null,
      "clearSpaceMultiple": null,
    },
    ontology: ["logo_variants"],
    asset: ["kind"],
  },
  "logo.distortion": {
    fn: "logo.check_distortion",
    params: {
      "maxAspectDistortion": 1.02,
      "maxPerspective": 0.0006,
      "maxRotationDeg": 1.5,
      "maxShear": 0.02,
    },
    ontology: ["logo_variants"],
    asset: ["kind"],
  },
  "logo.min_size": {
    fn: "logo.check_min_size",
    params: {
      "minHeightMm": null,
      "minHeightPct": null,
      "minHeightPx": null,
    },
    ontology: ["logo_variants"],
    asset: ["kind"],
  },
  "logo.occlusion": {
    fn: "logo.check_occlusion",
    params: {
      "maxCoverageFrac": 0.02,
      "maxIou": 0.02,
    },
    ontology: ["logo_variants"],
    asset: ["kind"],
  },
  "logo.placement": {
    fn: "logo.check_placement",
    params: {
      "allowedAnchors": null,
      "allowedRegion": null,
      "cobrandOrder": null,
    },
    ontology: ["logo_variants"],
    asset: ["kind"],
  },
  "logo.presence": {
    fn: "logo.check_presence",
    params: {
      "minScore": 0.0,
      "requiredVariantIds": null,
    },
    ontology: ["logo_variants"],
    asset: ["kind"],
  },
  "logo.recolor": {
    fn: "logo.check_recolor",
    params: {
      "allowedHexes": null,
      "ignoreNeutrals": true,
      "k": 6,
      "maxDeltaE": 5.0,
      "minClusterShare": 0.08,
    },
    ontology: ["color_tokens", "logo_variants"],
    asset: ["kind"],
  },
  "typography.approved_family": {
    fn: "typography.check_approved_family",
    params: {
      "fuzzyThreshold": 88.0,
      "minChars": 3,
    },
    ontology: ["forbidden_fonts", "type_styles"],
    asset: ["kind"],
  },
  "typography.casing": {
    fn: "typography.check_casing",
    params: {
      "casing": null,
      "maxAllCapsRatio": null,
      "minChars": 8,
    },
    ontology: ["type_styles"],
    asset: ["kind"],
  },
  "typography.fallback_font": {
    fn: "typography.check_fallback_font",
    params: {},
    ontology: ["type_styles"],
    asset: ["kind"],
  },
  "typography.hierarchy": {
    fn: "typography.check_hierarchy",
    params: {
      "minStepRatio": 1.15,
    },
    ontology: ["type_styles"],
    asset: ["kind"],
  },
  "typography.min_size": {
    fn: "typography.check_min_size",
    params: {
      "minSizePt": null,
    },
    ontology: ["channel_spec", "type_styles"],
    asset: ["asset_type", "channel", "height", "kind"],
  },
  "vlm.mood": {
    fn: "judge.check_mood",
    params: {
      "mood": null,
    },
    ontology: [],
    asset: [],
  },
  "vlm.overall_judgment": {
    fn: "judge.check_overall_judgment",
    params: {},
    ontology: [],
    asset: [],
  },
  "vlm.rubric": {
    fn: "judge.check_rubric",
    params: {
      "includeCopy": null,
      "maxCopyChars": 4000,
      "requireImage": null,
    },
    ontology: [],
    asset: [],
  },
  "vlm.rule_adjudication": {
    fn: "judge.check_rule_adjudication",
    params: {
      "adjudicatePasses": false,
      "measureParams": null,
      "measuredBy": null,
      "measurements": null,
    },
    ontology: [],
    asset: [],
  },
  "vlm.subject_appropriateness": {
    fn: "judge.check_subject_appropriateness",
    params: {
      "prohibitedSubjects": null,
      "sensitivities": null,
    },
    ontology: ["image_style_profile"],
    asset: ["channel", "locale", "market"],
  },
  "vlm.voice_tone": {
    fn: "judge.check_voice_tone",
    params: {},
    ontology: ["voice_attributes"],
    asset: [],
  },
} as const satisfies Record<string, AnalyzerContract>;

// Every key `channel_spec.conformance` recognises, and what it does with it.
//
// The registry (packages/db/src/seed/data/channel-specs.ts) and the analyzer
// that consumes it are the same two-vocabularies problem as rules and their
// params, one level down: a spec key nobody reads is not an error, it is a
// published constraint that constrains nothing. They once shared three keys
// out of forty, which is how a blocker-severity rule came to check minimum
// dimensions and DPI while the safe zones, bleed and ink limits sat unread.
//
// roles:
//   enforced      channel_spec.conformance measures it
//   delegated     another analyzer measures it, automatically — `by` names it
//   authorable    `by` CAN measure it, but only if somebody writes that rule
//   unmeasurable  the engine cannot; `detail` says why
//   reference     not a constraint — other keys are expressed relative to it

export const GENERATED_SPEC_KEYS = {
  "referenceSize": { role: "reference", summary: "The resolution this spec's pixel figures are quoted at.", by: "", detail: "Safe zones especially: they are published in pixels at this size and scaled from it." },
  "notes": { role: "reference", summary: "Prose for whoever reads the spec.", by: "", detail: "Guidance for a human, deliberately not a constraint \u2014 nothing here is machine-checkable." },
  "exactSizes": { role: "enforced", summary: "The asset must be one of these exact pixel sizes.", by: "", detail: "" },
  "minWidth": { role: "enforced", summary: "Minimum width in pixels.", by: "", detail: "" },
  "minHeight": { role: "enforced", summary: "Minimum height in pixels.", by: "", detail: "" },
  "maxWidth": { role: "enforced", summary: "Maximum width in pixels.", by: "", detail: "" },
  "maxHeight": { role: "enforced", summary: "Maximum height in pixels.", by: "", detail: "" },
  "recommendedWidth": { role: "enforced", summary: "Advisory width. Reported, never failed.", by: "", detail: "" },
  "recommendedHeight": { role: "enforced", summary: "Advisory height. Reported, never failed.", by: "", detail: "" },
  "aspectRatios": { role: "enforced", summary: "The asset must match one ratio within its tolerance.", by: "", detail: "" },
  "maxBytes": { role: "enforced", summary: "Maximum file size in bytes.", by: "", detail: "" },
  "formats": { role: "enforced", summary: "Permitted file extensions.", by: "", detail: "" },
  "colorSpace": { role: "enforced", summary: "The colour space the file must be delivered in.", by: "", detail: "" },
  "minDpi": { role: "enforced", summary: "Minimum resolution, declared or implied by the trim size.", by: "", detail: "" },
  "trimSize": { role: "enforced", summary: "Finished page size in millimetres, after cutting.", by: "", detail: "" },
  "bleedMm": { role: "enforced", summary: "Artwork must extend this far beyond the trim on every edge.", by: "", detail: "" },
  "totalInkCoverageMaxPct": { role: "enforced", summary: "Ceiling on the sum of the four separations.", by: "", detail: "" },
  "requiresCropMarks": { role: "enforced", summary: "Prepress marks must sit outside the trim box.", by: "", detail: "" },
  "requiresOutlinedFonts": { role: "enforced", summary: "Type must be converted to outlines.", by: "", detail: "" },
  "safeZones": { role: "delegated", summary: "Regions the channel covers with its own furniture.", by: "layout.safe_zone", detail: "Intrusion is a question about where elements sit, so it is measured where elements are located. That analyzer reads these zones from the channel spec when its rule names none." },
  "safetyMarginMm": { role: "delegated", summary: "Print safe area, inside the trim.", by: "layout.safe_zone", detail: "Converted to a safe zone alongside the bleed and checked with the rest of them." },
  "minLegalFontPx": { role: "delegated", summary: "Floor on legal copy, in pixels at the reference size.", by: "typography.min_size", detail: "Applied as a floor on top of the brand's own per-style minimums, whichever is larger." },
  "minLegalFontPt": { role: "delegated", summary: "Floor on legal copy, in points.", by: "typography.min_size", detail: "Applied as a floor on top of the brand's own per-style minimums, whichever is larger." },
  "textDensityAdvisoryPct": { role: "delegated", summary: "Share of the canvas the platform prefers text not to exceed.", by: "layout.text_density", detail: "Advisory by construction \u2014 the platform suppresses delivery, it does not reject the upload." },
  "prohibitedContent": { role: "authorable", summary: "Subject matter the platform rejects on review.", by: "vlm.rubric", detail: "A semantic judgement, not arithmetic. Author a rule on `vlm.rubric` whose question quotes these, and the judge adjudicates them against the asset with a citable rationale." },
  "textLimits": { role: "unmeasurable", summary: "Character ceilings on the ad's copy fields.", by: "", detail: "Headline, primary text and description are typed into the ad platform's own form. They are not in the uploaded file, so nothing here can count them." },
  "durationMs": { role: "unmeasurable", summary: "Permitted clip length.", by: "", detail: "a property of the video container. The engine decodes no video \u2014 every dependency has to resolve to a prebuilt wheel on the target VM, which rules out a decoder \u2014 so it reads one rasterised frame and cannot see the timeline." },
  "maxDurationSec": { role: "unmeasurable", summary: "Maximum clip length.", by: "", detail: "a property of the video container. The engine decodes no video \u2014 every dependency has to resolve to a prebuilt wheel on the target VM, which rules out a decoder \u2014 so it reads one rasterised frame and cannot see the timeline." },
  "fps": { role: "unmeasurable", summary: "Permitted frame rate.", by: "", detail: "a property of the video container. The engine decodes no video \u2014 every dependency has to resolve to a prebuilt wheel on the target VM, which rules out a decoder \u2014 so it reads one rasterised frame and cannot see the timeline." },
  "bitrateKbps": { role: "unmeasurable", summary: "Permitted bitrate.", by: "", detail: "a property of the video container. The engine decodes no video \u2014 every dependency has to resolve to a prebuilt wheel on the target VM, which rules out a decoder \u2014 so it reads one rasterised frame and cannot see the timeline." },
  "audio": { role: "unmeasurable", summary: "Required audio codec and sample rate.", by: "", detail: "a property of the video container. The engine decodes no video \u2014 every dependency has to resolve to a prebuilt wheel on the target VM, which rules out a decoder \u2014 so it reads one rasterised frame and cannot see the timeline." },
  "videoCodec": { role: "unmeasurable", summary: "Permitted video codecs.", by: "", detail: "a property of the video container. The engine decodes no video \u2014 every dependency has to resolve to a prebuilt wheel on the target VM, which rules out a decoder \u2014 so it reads one rasterised frame and cannot see the timeline." },
  "animation": { role: "unmeasurable", summary: "Animation length and loop ceiling.", by: "", detail: "a property of the video container. The engine decodes no video \u2014 every dependency has to resolve to a prebuilt wheel on the target VM, which rules out a decoder \u2014 so it reads one rasterised frame and cannot see the timeline." },
  "captionsRequired": { role: "unmeasurable", summary: "Captions must be burned in or supplied as a sidecar.", by: "", detail: "Captions appear across the timeline and the engine sees a single frame." },
  "width": { role: "enforced", summary: "Exact width in pixels. Prefer `exactSizes`.", by: "", detail: "" },
  "height": { role: "enforced", summary: "Exact height in pixels. Prefer `exactSizes`.", by: "", detail: "" },
  "aspectRatio": { role: "enforced", summary: "Single permitted ratio as a decimal. Prefer `aspectRatios`.", by: "", detail: "" },
  "aspectTolerance": { role: "enforced", summary: "Tolerance for `aspectRatio`.", by: "", detail: "" },
  "maxFileSizeKb": { role: "enforced", summary: "Maximum file size in KB. Prefer `maxBytes`.", by: "", detail: "" },
  "allowedFormats": { role: "enforced", summary: "Permitted file extensions. Prefer `formats`.", by: "", detail: "" },
} as const satisfies Record<string, SpecKeyContract>;
