/* ==========================================================================
 * Channel spec registry — GLOBAL rows (org_id = NULL).
 *
 * Boring, tedious, constantly drifting, and therefore a genuine moat. Every
 * platform changes its safe zones two to four times a year and nobody
 * maintains them well. Declarative, versioned specs validate with zero model
 * cost and 100% precision, which makes this the cheapest correct dimension in
 * the whole product.
 *
 * org_id IS NULL marks a row as part of the shipped registry. The RLS policy
 * on channel_specs lets every tenant READ null-org rows but only WRITE rows
 * carrying their own org_id, so a tenant override shadows a shipped spec
 * without being able to corrupt it for anyone else.
 *
 * SAFE ZONES are expressed in pixels at the reference resolution named in
 * `referenceSize`, because that is how the platforms publish them. The
 * layout.safe_zone analyzer scales them to the asset's actual dimensions.
 *
 * The values below are the published guidance as of the 2026.1 revision.
 * Treat the `docsUrl` on each row as authoritative and re-check quarterly —
 * docs/operations.md schedules that.
 * ========================================================================== */

export interface SeedChannelSpec {
  platform: string;
  placement: string;
  assetType: 'image' | 'video' | 'html5';
  version: string;
  spec: Record<string, unknown>;
  docsUrl?: string;
  notes?: string;
}

const VERSION = '2026.1';

export const SEED_CHANNEL_SPECS: SeedChannelSpec[] = [
  /* =====================================================================
   * Meta — Facebook / Instagram
   * ================================================================== */
  {
    platform: 'meta',
    placement: 'feed',
    assetType: 'image',
    version: VERSION,
    docsUrl: 'https://www.facebook.com/business/ads-guide/image/facebook-feed',
    notes: '1:1 is the safe default; 4:5 buys more vertical real estate and is preferred for mobile.',
    spec: {
      referenceSize: { width: 1080, height: 1080 },
      aspectRatios: [
        { w: 1, h: 1, tolerance: 0.01, preferred: true },
        { w: 4, h: 5, tolerance: 0.01 },
        { w: 1.91, h: 1, tolerance: 0.02 },
      ],
      minWidth: 600,
      minHeight: 600,
      recommendedWidth: 1080,
      recommendedHeight: 1080,
      maxBytes: 30 * 1024 * 1024,
      formats: ['jpg', 'jpeg', 'png'],
      colorSpace: 'sRGB',
      // Meta dropped the hard 20% text rule in 2021 but still suppresses
      // delivery on text-heavy creative. Advisory, not a failure.
      textDensityAdvisoryPct: 20,
      textLimits: { primary: 125, headline: 40, description: 30 },
      safeZones: { top: 0, right: 0, bottom: 0, left: 0 },
      notes: 'Feed images are not overlaid by chrome; the constraint is text density, not safe zones.',
    },
  },
  {
    platform: 'meta',
    placement: 'story',
    assetType: 'image',
    version: VERSION,
    docsUrl: 'https://www.facebook.com/business/ads-guide/image/instagram-stories',
    notes: 'The profile row sits at the top and the CTA sticker at the bottom. Both eat the canvas.',
    spec: {
      referenceSize: { width: 1080, height: 1920 },
      aspectRatios: [{ w: 9, h: 16, tolerance: 0.01, preferred: true }],
      minWidth: 1080,
      minHeight: 1920,
      maxBytes: 30 * 1024 * 1024,
      formats: ['jpg', 'jpeg', 'png'],
      colorSpace: 'sRGB',
      // 14% top / 20% bottom of 1920, the figures Meta publishes for Stories.
      safeZones: { top: 250, right: 0, bottom: 340, left: 0 },
      textLimits: { primary: 125 },
      notes: 'Keep logo, headline and any legal copy inside the middle 1330px.',
    },
  },
  {
    platform: 'meta',
    placement: 'reel',
    assetType: 'video',
    version: VERSION,
    docsUrl: 'https://www.facebook.com/business/ads-guide/video/instagram-reels',
    notes: 'The right rail (like/comment/share) and the caption block both overlay the video.',
    spec: {
      referenceSize: { width: 1080, height: 1920 },
      aspectRatios: [{ w: 9, h: 16, tolerance: 0.01, preferred: true }],
      minWidth: 1080,
      minHeight: 1920,
      maxBytes: 4 * 1024 * 1024 * 1024,
      formats: ['mp4', 'mov'],
      durationMs: { min: 1000, max: 900_000 },
      fps: { min: 24, max: 60 },
      bitrateKbps: { min: 4000, recommended: 8000 },
      audio: { codec: 'aac', sampleRate: 48_000, channels: 2, required: false },
      videoCodec: ['h264', 'hevc'],
      safeZones: { top: 220, right: 180, bottom: 420, left: 60 },
      captionsRequired: true,
      notes: 'Captions are effectively mandatory: most Reels impressions are watched muted.',
    },
  },

  /* =====================================================================
   * TikTok
   * ================================================================== */
  {
    platform: 'tiktok',
    placement: 'in-feed',
    assetType: 'video',
    version: VERSION,
    docsUrl: 'https://ads.tiktok.com/help/article/tiktok-video-ad-specifications',
    notes:
      'The heaviest UI overlay of any placement: username and caption bottom-left, action rail right, ad disclosure and CTA bottom.',
    spec: {
      referenceSize: { width: 1080, height: 1920 },
      aspectRatios: [
        { w: 9, h: 16, tolerance: 0.01, preferred: true },
        { w: 1, h: 1, tolerance: 0.01 },
      ],
      minWidth: 720,
      minHeight: 1280,
      recommendedWidth: 1080,
      recommendedHeight: 1920,
      maxBytes: 500 * 1024 * 1024,
      formats: ['mp4', 'mov', 'mpeg', 'avi'],
      durationMs: { min: 5000, max: 60_000, recommended: { min: 9000, max: 15_000 } },
      fps: { min: 23, max: 60, recommended: 30 },
      bitrateKbps: { min: 516, recommended: 2500 },
      audio: { codec: 'aac', sampleRate: 44_100, required: true },
      videoCodec: ['h264'],
      // The canonical 9:16 1080×1920 safe zone. Anything outside these bounds
      // is at risk of being covered by TikTok's own UI.
      safeZones: { top: 120, right: 120, bottom: 310, left: 60 },
      textLimits: { adText: 100, displayName: 20 },
      notes: 'Brand mark and any legal copy must sit inside x∈[60,960], y∈[120,1610].',
    },
  },
  {
    platform: 'tiktok',
    placement: 'in-feed',
    assetType: 'image',
    version: VERSION,
    docsUrl: 'https://ads.tiktok.com/help/article/carousel-ads',
    spec: {
      referenceSize: { width: 1080, height: 1350 },
      aspectRatios: [
        { w: 9, h: 16, tolerance: 0.01 },
        { w: 4, h: 5, tolerance: 0.01, preferred: true },
        { w: 1, h: 1, tolerance: 0.01 },
      ],
      minWidth: 720,
      minHeight: 720,
      maxBytes: 100 * 1024 * 1024,
      formats: ['jpg', 'jpeg', 'png'],
      safeZones: { top: 120, right: 120, bottom: 310, left: 60 },
      notes: 'Carousel images inherit the video placement’s overlay geometry.',
    },
  },

  /* =====================================================================
   * Google Display — IAB standard units
   * ================================================================== */
  {
    platform: 'google',
    placement: 'display-medium-rectangle',
    assetType: 'image',
    version: VERSION,
    docsUrl: 'https://support.google.com/google-ads/answer/1722096',
    notes: 'IAB Medium Rectangle. The highest-volume display unit by a wide margin.',
    spec: {
      referenceSize: { width: 300, height: 250 },
      exactSizes: [{ width: 300, height: 250 }],
      aspectRatios: [{ w: 6, h: 5, tolerance: 0.01 }],
      minWidth: 300,
      minHeight: 250,
      maxBytes: 150 * 1024,
      formats: ['jpg', 'jpeg', 'png', 'gif'],
      animation: { maxDurationMs: 30_000, maxLoops: 3 },
      safeZones: { top: 0, right: 0, bottom: 0, left: 0 },
      // A 300×250 unit is 250px tall. Legal copy at 8pt is unreadable there,
      // so the correct answer is a landing-page link, not smaller type.
      minLegalFontPx: 10,
      notes: 'Border required when the background is white, or the ad blends into the page.',
    },
  },
  {
    platform: 'google',
    placement: 'display-leaderboard',
    assetType: 'image',
    version: VERSION,
    docsUrl: 'https://support.google.com/google-ads/answer/1722096',
    notes: 'IAB Leaderboard. 90px tall — logo minimum width has to be relaxed here.',
    spec: {
      referenceSize: { width: 728, height: 90 },
      exactSizes: [{ width: 728, height: 90 }],
      aspectRatios: [{ w: 728, h: 90, tolerance: 0.01 }],
      minWidth: 728,
      minHeight: 90,
      maxBytes: 150 * 1024,
      formats: ['jpg', 'jpeg', 'png', 'gif'],
      animation: { maxDurationMs: 30_000, maxLoops: 3 },
      safeZones: { top: 0, right: 0, bottom: 0, left: 0 },
      minLegalFontPx: 10,
    },
  },
  {
    platform: 'google',
    placement: 'display-half-page',
    assetType: 'image',
    version: VERSION,
    docsUrl: 'https://support.google.com/google-ads/answer/1722096',
    notes: 'IAB Half Page. The only display unit with room for a real disclaimer.',
    spec: {
      referenceSize: { width: 300, height: 600 },
      exactSizes: [{ width: 300, height: 600 }],
      aspectRatios: [{ w: 1, h: 2, tolerance: 0.01 }],
      minWidth: 300,
      minHeight: 600,
      maxBytes: 150 * 1024,
      formats: ['jpg', 'jpeg', 'png', 'gif'],
      animation: { maxDurationMs: 30_000, maxLoops: 3 },
      safeZones: { top: 0, right: 0, bottom: 0, left: 0 },
      minLegalFontPx: 10,
    },
  },
  {
    platform: 'google',
    placement: 'display-mobile-banner',
    assetType: 'image',
    version: VERSION,
    docsUrl: 'https://support.google.com/google-ads/answer/1722096',
    notes: 'IAB Mobile Leaderboard, 320×50.',
    spec: {
      referenceSize: { width: 320, height: 50 },
      exactSizes: [{ width: 320, height: 50 }],
      aspectRatios: [{ w: 32, h: 5, tolerance: 0.01 }],
      minWidth: 320,
      minHeight: 50,
      maxBytes: 150 * 1024,
      formats: ['jpg', 'jpeg', 'png', 'gif'],
      safeZones: { top: 0, right: 0, bottom: 0, left: 0 },
      notes: 'No room for legal copy. Any claim needing a disclaimer is disallowed at this size.',
    },
  },

  /* =====================================================================
   * LinkedIn
   * ================================================================== */
  {
    platform: 'linkedin',
    placement: 'feed-single-image',
    assetType: 'image',
    version: VERSION,
    docsUrl: 'https://www.linkedin.com/help/lms/answer/a424270',
    spec: {
      referenceSize: { width: 1200, height: 1200 },
      aspectRatios: [
        { w: 1, h: 1, tolerance: 0.01, preferred: true },
        { w: 1.91, h: 1, tolerance: 0.02 },
        { w: 4, h: 5, tolerance: 0.01 },
      ],
      minWidth: 640,
      minHeight: 360,
      maxBytes: 5 * 1024 * 1024,
      formats: ['jpg', 'jpeg', 'png', 'gif'],
      textLimits: { introText: 150, headline: 70, description: 70 },
      safeZones: { top: 0, right: 0, bottom: 0, left: 0 },
      notes: 'Intro text truncates at ~150 characters on mobile; the headline overlays nothing.',
    },
  },
  {
    platform: 'linkedin',
    placement: 'feed-video',
    assetType: 'video',
    version: VERSION,
    docsUrl: 'https://www.linkedin.com/help/lms/answer/a423271',
    spec: {
      referenceSize: { width: 1920, height: 1080 },
      aspectRatios: [
        { w: 16, h: 9, tolerance: 0.02 },
        { w: 1, h: 1, tolerance: 0.01, preferred: true },
        { w: 9, h: 16, tolerance: 0.01 },
      ],
      minWidth: 640,
      minHeight: 360,
      maxBytes: 200 * 1024 * 1024,
      formats: ['mp4'],
      durationMs: { min: 3000, max: 1_800_000, recommended: { min: 15_000, max: 30_000 } },
      fps: { min: 10, max: 60 },
      bitrateKbps: { min: 192, max: 30_000 },
      audio: { codec: 'aac', sampleRate: 48_000, required: false },
      videoCodec: ['h264'],
      captionsRequired: true,
      safeZones: { top: 0, right: 0, bottom: 100, left: 0 },
      notes: 'Autoplay is muted. Burned-in captions or an uploaded SRT are required.',
    },
  },

  /* =====================================================================
   * Amazon
   * ================================================================== */
  {
    platform: 'amazon',
    placement: 'sponsored-brands',
    assetType: 'image',
    version: VERSION,
    docsUrl: 'https://advertising.amazon.com/resources/ad-specs/sponsored-brands',
    notes: 'Amazon rejects creative containing prices, "best seller" and time-limited claims.',
    spec: {
      referenceSize: { width: 1200, height: 628 },
      aspectRatios: [{ w: 1.91, h: 1, tolerance: 0.02 }],
      minWidth: 1200,
      minHeight: 628,
      maxBytes: 5 * 1024 * 1024,
      formats: ['jpg', 'jpeg', 'png'],
      safeZones: { top: 0, right: 0, bottom: 0, left: 0 },
      prohibitedContent: [
        'price or savings claims',
        'time-limited offers',
        'best seller / #1 claims',
        'Amazon trademarks or lookalike badges',
        'customer review quotations',
        'a white or very light background that blends into the page',
      ],
      textLimits: { headline: 50 },
    },
  },
  {
    platform: 'amazon',
    placement: 'a-plus-standard-image',
    assetType: 'image',
    version: VERSION,
    docsUrl: 'https://sellercentral.amazon.com/help/hub/reference/GHFCFQAA9SPVJ8AC',
    spec: {
      referenceSize: { width: 970, height: 600 },
      aspectRatios: [{ w: 970, h: 600, tolerance: 0.02 }],
      minWidth: 970,
      minHeight: 300,
      maxBytes: 2 * 1024 * 1024,
      formats: ['jpg', 'jpeg', 'png'],
      safeZones: { top: 0, right: 0, bottom: 0, left: 0 },
      prohibitedContent: ['warranty or guarantee language', 'shipping claims', 'contact details', 'external URLs'],
      minLegalFontPx: 12,
    },
  },

  /* =====================================================================
   * Print
   * ================================================================== */
  {
    platform: 'print',
    placement: 'a4-portrait',
    assetType: 'image',
    version: VERSION,
    notes: 'ISO 216 A4 at 300dpi, with 3mm bleed and a 5mm safety margin.',
    spec: {
      // 210×297mm at 300dpi, plus 3mm bleed on each edge.
      referenceSize: { width: 2551, height: 3579 },
      trimSize: { widthMm: 210, heightMm: 297 },
      bleedMm: 3,
      safetyMarginMm: 5,
      aspectRatios: [{ w: 210, h: 297, tolerance: 0.01 }],
      minDpi: 300,
      maxBytes: 200 * 1024 * 1024,
      formats: ['pdf', 'tiff', 'png'],
      colorSpace: 'CMYK',
      // Safe zone = bleed + safety margin, in pixels at 300dpi:
      // (3mm + 5mm) × 300 / 25.4 ≈ 94px.
      safeZones: { top: 94, right: 94, bottom: 94, left: 94 },
      minLegalFontPt: 6,
      requiresCropMarks: true,
      requiresOutlinedFonts: true,
      totalInkCoverageMaxPct: 300,
      notes: 'Colour is CMYK. sRGB values are converted at prepress; brand colours have Pantone equivalents.',
    },
  },
  {
    platform: 'print',
    placement: 'a5-landscape',
    assetType: 'image',
    version: VERSION,
    notes: 'A5 landscape at 300dpi. In-store and direct mail.',
    spec: {
      referenceSize: { width: 1819, height: 1276 },
      trimSize: { widthMm: 210, heightMm: 148 },
      bleedMm: 3,
      safetyMarginMm: 5,
      aspectRatios: [{ w: 210, h: 148, tolerance: 0.01 }],
      minDpi: 300,
      maxBytes: 200 * 1024 * 1024,
      formats: ['pdf', 'tiff', 'png'],
      colorSpace: 'CMYK',
      safeZones: { top: 94, right: 94, bottom: 94, left: 94 },
      minLegalFontPt: 6,
      requiresCropMarks: true,
      totalInkCoverageMaxPct: 300,
    },
  },
];
