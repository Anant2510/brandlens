/**
 * Folding provider brand data into what the crawl discovered.
 *
 * The rule throughout: enrichment ADDS, it never overrides. A colour the crawl
 * measured on the live site keeps its measured coverage and simply gains a
 * second citation noting the provider agrees; a colour only the provider knows
 * enters as a candidate with provider provenance and zero page-coverage, so a
 * reviewer can see it was declared by Brandfetch, not seen on the site. That
 * ordering matters — the site is the source of truth, the provider is a
 * witness — and it is what keeps a brand-verification tool honest when its two
 * sources disagree.
 */

import { deltaE76, hexToLab, parseHex } from '@brandlens/api/common/color';
import type { DiscoveredColor, DiscoveredTypeStyle } from '@brandlens/contracts';
import type { BrandEnrichment } from './brand-enrichment';
import type { ImageCandidate } from './browser';

const MERGE_DELTA_E = 3;

/** A citation URL that records which provider a token came from. */
export function providerCitation(provider: string, domain: string): string {
  return `provider:${provider}:${domain}`;
}

export interface MergedIdentity {
  colors: DiscoveredColor[];
  typeStyles: DiscoveredTypeStyle[];
  logos: Array<ImageCandidate & { confidence: number }>;
}

/**
 * Returns new arrays; never mutates the inputs. Provider colours already
 * present in the crawled palette (within ΔE 3) are annotated, not duplicated;
 * genuinely new ones are appended as candidates.
 */
export function mergeEnrichment(
  palette: DiscoveredColor[],
  styles: DiscoveredTypeStyle[],
  logos: Array<ImageCandidate & { confidence: number }>,
  enrichment: BrandEnrichment,
): MergedIdentity {
  const citation = providerCitation(enrichment.provider, enrichment.domain);
  const colors = palette.map((c) => ({ ...c, citations: [...c.citations] }));

  for (const ec of enrichment.colors) {
    const parsed = parseHex(ec.hex);
    const lab = hexToLab(ec.hex);
    if (!parsed || !lab) continue;
    const match = colors.find((c) => deltaE76(c.lab, lab) <= MERGE_DELTA_E);
    if (match) {
      // The site already paints this colour; record that the provider agrees,
      // which is real corroboration a reviewer should see.
      if (!match.citations.some((c) => c.url === citation)) {
        match.citations.push({ url: citation, selector: enrichment.provider, property: `role:${ec.role}` });
      }
    } else {
      // The provider knows a colour the crawl never saw — the SPA case. It
      // enters as a candidate: zero page-coverage, provider provenance, so it
      // is visibly declared-not-measured and sorts below anything real.
      colors.push({
        hex: parsed.hex,
        lab,
        coverage: 0,
        pageCount: 0,
        role: ec.role === 'unknown' ? 'accent' : ec.role,
        citations: [{ url: citation, selector: enrichment.provider, property: `role:${ec.role}` }],
      });
    }
  }

  const typeStyles = styles.map((s) => ({ ...s, citations: [...s.citations] }));
  const known = new Set(typeStyles.map((s) => s.fontFamily.toLowerCase()));
  for (const font of enrichment.fonts) {
    if (known.has(font.name.toLowerCase())) continue;
    known.add(font.name.toLowerCase());
    typeStyles.push({
      name: `${font.name} (via ${enrichment.provider})`,
      fontFamily: font.name,
      fontWeight: font.role === 'display' ? 700 : 400,
      // A provider tells us the brand uses this typeface. It does not tell us
      // what size the brand sets it at, and 40/16 was this file's own guess
      // wearing the same field name as a measured value.
      fontSizePx: null,
      lineHeightPx: null,
      letterSpacingPx: null,
      role: font.role === 'unknown' ? 'body' : font.role,
      occurrences: 0,
      citations: [{ url: citation, selector: enrichment.provider }],
    });
  }

  // Provider logos are appended below anything the crawl ranked, at a
  // confidence that reflects a declared-not-detected mark. A vector is worth
  // more — it is the actual asset, not a rendered thumbnail.
  const mergedLogos = [...logos];
  const seen = new Set(logos.map((l) => l.src));
  for (const logo of enrichment.logos) {
    if (seen.has(logo.src)) continue;
    seen.add(logo.src);
    mergedLogos.push({
      src: logo.src,
      alt: enrichment.name,
      selector: `provider:${enrichment.provider}`,
      width: 0,
      height: 0,
      isVector: logo.isVector,
      region: 'header',
      confidence: logo.isVector ? 0.6 : 0.45,
    });
  }
  mergedLogos.sort((a, b) => b.confidence - a.confidence);

  return { colors, typeStyles, logos: mergedLogos };
}
