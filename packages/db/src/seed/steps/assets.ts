/* ==========================================================================
 * Step 3 — campaign, variant family, creatives, channel spec registry.
 *
 * Ten PNGs are generated, written to seed/assets/creatives/ and to the
 * content-addressed storage root, and registered as `assets` rows. Five are
 * marked `isApprovedExemplar` — that flag is what the rule-induction job
 * measures, so it is the difference between the learning loop having a corpus
 * and having nothing.
 *
 * Channel specs are written with org_id = NULL, which makes them part of the
 * shipped global registry rather than tenant data. That write needs
 * app.bypass_rls, because the channel_specs WITH CHECK clause requires
 * org_id = current tenant for any non-bypassed write.
 * ========================================================================== */

import { assets, assetMeasurements, campaigns, channelSpecs, variantFamilies } from '../../schema/index.js';
import type { Database } from '../../client.js';
import { seedId } from '../lib/ids.js';
import { upsertRows } from '../lib/upsert.js';
import { storeSeedFile } from '../lib/io.js';
import { generateCreatives, type GeneratedCreative } from '../generate/creatives.js';
import { SEED_CHANNEL_SPECS } from '../data/channel-specs.js';
import { assertChannelSpecsEnforceable } from '../data/validate.js';
import { USERS } from './tenant.js';

export interface SeededAsset extends GeneratedCreative {
  id: string;
  contentHash: string;
  storageKey: string;
  byteSize: number;
}

export interface AssetsResult {
  campaignId: string;
  variantFamilyId: string;
  assets: SeededAsset[];
  exemplarCount: number;
  violationCount: number;
  channelSpecCount: number;
}

export async function seedAssets(tx: Database, orgId: string, brandId: string): Promise<AssetsResult> {
  /* ------------------------------------------------------------------ *
   * Campaign + variant family
   *
   * A variant family groups a master with its resized derivatives so the
   * expensive semantic checks run ONCE on the master and only geometry and
   * channel-spec checks run per variant. For ad production that alone cuts
   * VLM spend by an order of magnitude.
   * ------------------------------------------------------------------ */
  const campaignId = seedId('campaign', brandId, 'autumn-2026');
  const variantFamilyId = seedId('family', brandId, 'autumn-2026-hero');

  await upsertRows(tx, campaigns, [
    {
      id: campaignId,
      orgId,
      brandId,
      name: 'Autumn 2026 — Better Sorted',
      code: 'AUT26-BS',
      brief:
        'Drive first orders on the new season blends. Lead with freshness and the roast date, not with romance. Three markets, four placements, one master per market.',
      audience: {
        primary: 'Coffee-curious 28–45, already buying supermarket specialty, not yet buying direct',
        markets: ['en-US', 'en-GB', 'de-DE'],
        objections: ['too expensive', 'too much faff', 'I cannot tell the difference'],
      },
      startsAt: new Date('2026-09-01T00:00:00Z'),
      endsAt: new Date('2026-11-30T00:00:00Z'),
      ruleExceptions: {
        // Campaign-level exceptions are the whole reason the campaign axis
        // exists in the scope lattice — an approved partner lockup would
        // otherwise fail the clear-space rule on every asset.
        note: 'No exceptions granted for this campaign.',
      },
    },
  ]);

  await upsertRows(tx, variantFamilies, [
    {
      id: variantFamilyId,
      orgId,
      brandId,
      name: 'Autumn 2026 — hero master and resizes',
      masterAssetId: null,
      campaignId,
    },
  ]);

  /* ------------------------------------------------------------------ *
   * Creatives
   * ------------------------------------------------------------------ */
  const creatives = generateCreatives();
  const seeded: SeededAsset[] = [];
  const assetRows: Record<string, unknown>[] = [];
  const measurementRows: Record<string, unknown>[] = [];

  for (const creative of creatives) {
    const stored = await storeSeedFile(`creatives/${creative.fileName}`, orgId, creative.png, 'png');
    const id = seedId('asset', brandId, creative.key);

    seeded.push({
      ...creative,
      id,
      contentHash: stored.hash,
      storageKey: stored.storageKey,
      byteSize: stored.bytes,
    });

    assetRows.push({
      id,
      orgId,
      brandId,
      campaignId,
      variantFamilyId: creative.key === 'creative.feed-hero' ? variantFamilyId : null,
      name: creative.name,
      kind: 'image',
      status: 'analyzed',
      contentHash: stored.hash,
      storageKey: stored.storageKey,
      mimeType: 'image/png',
      byteSize: stored.bytes,
      width: creative.width,
      height: creative.height,
      durationMs: null,
      // Reading the ICC profile is the most-missed step in the whole
      // pipeline: a Display-P3 asset analysed as sRGB reads as oversaturated
      // and produces mass false "off-palette" findings. The generator writes
      // an sRGB chunk, so this is measured, not assumed.
      colorProfile: 'sRGB',
      dpi: creative.channel.startsWith('print') ? 300 : 72,
      // These are flattened PNGs. Everything about their structure is
      // inference, which is exactly what `raster` means.
      sourceFidelity: 'raster',
      structuredSource: null,
      market: creative.market,
      channel: creative.channel,
      assetType: creative.assetType,
      locale: creative.market,
      copyFields: creative.copyFields,
      provenance: null,
      tags: creative.tags,
      isApprovedExemplar: creative.isApprovedExemplar,
      uploadedByUserId: USERS.creator.id,
      error: null,
    });

    // One cached measurement per asset. Measurements are a pure function of
    // (asset, analyzer, analyzer_version), which is why they are cached at
    // all — and why re-running a check on unchanged bytes costs nothing.
    measurementRows.push({
      id: seedId('measurement', id, 'seed.geometry'),
      orgId,
      assetId: id,
      analyzer: 'seed.geometry',
      analyzerVersion: '1.0.0',
      result: {
        width: creative.width,
        height: creative.height,
        aspectRatio: Math.round((creative.width / creative.height) * 10_000) / 10_000,
        ...creative.measured,
        generatedBy: '@brandlens/db seed',
        violation: creative.violation ?? null,
      },
      durationMs: 0,
    });
  }

  await upsertRows(tx, assets, assetRows);
  await upsertRows(tx, assetMeasurements, measurementRows);

  // Point the family at its master now that the asset row exists.
  await upsertRows(tx, variantFamilies, [
    {
      id: variantFamilyId,
      orgId,
      brandId,
      name: 'Autumn 2026 — hero master and resizes',
      masterAssetId: seeded.find((a) => a.key === 'creative.feed-hero')?.id ?? null,
      campaignId,
    },
  ]);

  return {
    campaignId,
    variantFamilyId,
    assets: seeded,
    exemplarCount: seeded.filter((a) => a.isApprovedExemplar).length,
    violationCount: seeded.filter((a) => a.violation).length,
    channelSpecCount: SEED_CHANNEL_SPECS.length,
  };
}

/**
 * The global channel-spec registry.
 *
 * Separate from seedAssets because it needs `app.bypass_rls` — org_id IS NULL
 * fails the channel_specs WITH CHECK clause under a bound tenant, by design.
 */
export async function seedChannelSpecs(tx: Database): Promise<number> {
  // Before a row is written, not after: a registry whose keys the engine never
  // reads publishes constraints that constrain nothing, and every asset passes
  // a check the console says is running.
  assertChannelSpecsEnforceable();
  await upsertRows(
    tx,
    channelSpecs,
    SEED_CHANNEL_SPECS.map((s) => ({
      id: seedId('channelspec', s.platform, s.placement, s.assetType, s.version),
      orgId: null,
      platform: s.platform,
      placement: s.placement,
      channel: s.channel,
      assetType: s.assetType,
      version: s.version,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      spec: s.spec,
      docsUrl: s.docsUrl ?? null,
      notes: s.notes ?? null,
    })),
  );
  return SEED_CHANNEL_SPECS.length;
}
