import { z } from 'zod';
import { Severity } from '@brandlens/contracts';

/**
 * DTOs for the ontology sub-resources that `@brandlens/contracts` does not
 * already define. Everything shared with the web client lives in contracts;
 * these are the server-side shapes for endpoints the contract package leaves
 * open, kept in zod so validation stays uniform.
 */

export const CreateLogoInput = z.object({
  name: z.string().min(1),
  kind: z
    .enum([
      'primary',
      'horizontal_lockup',
      'stacked_lockup',
      'monochrome_black',
      'monochrome_white',
      'knockout',
      'icon_only',
      'wordmark_only',
      'cobrand_lockup',
    ])
    .default('primary'),
  width: z.coerce.number().int().positive().optional(),
  height: z.coerce.number().int().positive().optional(),
  aspectRatio: z.coerce.number().positive().optional(),
  /** Height of the logomark inside this file — the "X" clear-space unit. */
  logomarkHeightPx: z.coerce.number().positive().optional(),
  palette: z.array(z.string()).optional(),
  constraints: z.record(z.unknown()).optional(),
  /** Set instead of a multipart file when the bytes are already in storage. */
  storageKey: z.string().optional(),
  contentHash: z.string().optional(),
  mimeType: z.string().optional(),
});

export const CreateTypeStyleInput = z.object({
  name: z.string().min(1),
  role: z.string().default('body'),
  fontFamily: z.string().min(1),
  fontAliases: z.array(z.string()).optional(),
  fontWeight: z.number().int().default(400),
  isItalic: z.boolean().optional(),
  minSizePx: z.number().optional(),
  minSizePt: z.number().optional(),
  minSizePctOfCanvas: z.number().optional(),
  maxSizePx: z.number().optional(),
  lineHeightRatio: z.number().optional(),
  letterSpacingEm: z.number().optional(),
  casingRules: z.record(z.unknown()).optional(),
  scaleRank: z.number().int().optional(),
});

export const UpdateTypeStyleInput = CreateTypeStyleInput.partial();

export const CreateVoiceAttributeInput = z.object({
  name: z.string().min(1),
  weAre: z.string().min(1),
  weAreNot: z.string().min(1),
  positiveExamples: z.array(z.string()).optional(),
  negativeExamples: z.array(z.string()).optional(),
  weight: z.number().optional(),
});

export const CreateLexiconTermInput = z.object({
  term: z.string().min(1),
  kind: z.enum(['banned', 'required', 'preferred', 'trademark']).default('banned'),
  replacement: z.string().optional(),
  caseSensitive: z.boolean().optional(),
  matchWholeWord: z.boolean().optional(),
  allowFuzzy: z.boolean().optional(),
  severity: Severity.optional(),
  marketCodes: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export const CreateClaimInput = z.object({
  text: z.string().min(1),
  variants: z.array(z.string()).optional(),
  category: z.string().optional(),
  substantiationRef: z.string().optional(),
  substantiationUrl: z.string().url().optional(),
  jurisdictions: z.array(z.string()).optional(),
  requiredDisclaimerId: z.string().uuid().optional(),
  approvedAt: z.string().optional(),
  expiresAt: z.string().optional(),
});

export const CreateDisclaimerInput = z.object({
  name: z.string().min(1),
  text: z.string().min(1),
  marketCodes: z.array(z.string()).optional(),
  channels: z.array(z.string()).optional(),
  minFontSizePt: z.number().optional(),
  minContrastRatio: z.number().optional(),
  maxProximityPct: z.number().optional(),
  isRequired: z.boolean().optional(),
  severity: Severity.optional(),
});

export const UpsertImageStyleProfileInput = z.object({
  name: z.string().min(1),
  featureStats: z.record(z.unknown()).optional(),
  centroid: z.array(z.number()).optional(),
  distanceP5: z.number().optional(),
  distanceP50: z.number().optional(),
  sampleSize: z.number().int().optional(),
  allowedMediums: z.array(z.string()).optional(),
  prohibitedSubjects: z.array(z.string()).optional(),
  embeddingModel: z.string().optional(),
});

export const CreateDocumentInput = z.object({
  name: z.string().min(1).optional(),
  kind: z.enum(['brandbook', 'tone-guide', 'legal', 'design-system', 'spec']).optional(),
});

export const InduceRulesInput = z.object({
  /** Percentile used as the proposed threshold, e.g. p5 for minima. */
  percentile: z.coerce.number().default(5),
  minSupport: z.coerce.number().int().default(20),
  assetIds: z.array(z.string().uuid()).optional(),
});
