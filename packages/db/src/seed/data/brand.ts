/* ==========================================================================
 * Type styles, forbidden fonts, voice attributes, lexicon, claims and
 * disclaimers for Northwind Coffee Co.
 * ========================================================================== */

export interface SeedTypeStyle {
  name: string;
  role: string;
  fontFamily: string;
  fontAliases: string[];
  fontWeight: number;
  isItalic?: boolean;
  minSizePx?: number;
  minSizePt?: number;
  minSizePctOfCanvas?: number;
  maxSizePx?: number;
  lineHeightRatio?: number;
  letterSpacingEm?: number;
  casingRules?: Record<string, unknown>;
  scaleRank: number;
}

/**
 * Font identification is a closed-set verification problem, not an open-set
 * classification one: this tenant has three approved faces, so the engine
 * renders candidates and compares rather than trying to identify an arbitrary
 * font. `fontAliases` is the list of every string that must resolve to the
 * same face — PDF and PPTX name the same font half a dozen ways, and a
 * missing alias is a false positive on a perfectly compliant asset.
 */
export const SEED_TYPE_STYLES: SeedTypeStyle[] = [
  {
    name: 'Display',
    role: 'display',
    fontFamily: 'Sole Serif Display',
    fontAliases: [
      'Sole Serif Display',
      'SoleSerifDisplay',
      'SoleSerif-Display',
      'Sole Serif Display Bold',
      'SoleSerifDisplay-Bold',
      'Sole Serif',
    ],
    fontWeight: 700,
    minSizePx: 48,
    maxSizePx: 240,
    lineHeightRatio: 1.05,
    letterSpacingEm: -0.02,
    casingRules: { allCaps: false, forbidFauxBold: true, forbidFauxItalic: true, maxWords: 9 },
    scaleRank: 1,
  },
  {
    name: 'H1',
    role: 'heading',
    fontFamily: 'Sole Serif Display',
    fontAliases: ['Sole Serif Display', 'SoleSerifDisplay', 'SoleSerifDisplay-Bold'],
    fontWeight: 700,
    minSizePx: 32,
    maxSizePx: 96,
    minSizePctOfCanvas: 0.035,
    lineHeightRatio: 1.15,
    letterSpacingEm: -0.01,
    casingRules: { allCaps: false, forbidFauxBold: true },
    scaleRank: 2,
  },
  {
    name: 'H2',
    role: 'heading',
    fontFamily: 'Inter',
    fontAliases: ['Inter', 'Inter-SemiBold', 'Inter SemiBold', 'Inter 600', 'InterVariable'],
    fontWeight: 600,
    minSizePx: 22,
    maxSizePx: 48,
    lineHeightRatio: 1.25,
    letterSpacingEm: 0,
    casingRules: { allCaps: false, forbidFauxBold: true },
    scaleRank: 3,
  },
  {
    name: 'Body',
    role: 'body',
    fontFamily: 'Inter',
    fontAliases: ['Inter', 'Inter-Regular', 'Inter Regular', 'Inter 400', 'InterVariable'],
    fontWeight: 400,
    minSizePx: 15,
    maxSizePx: 22,
    lineHeightRatio: 1.5,
    letterSpacingEm: 0,
    casingRules: { allCaps: false, forbidFauxBold: true, forbidFauxItalic: true },
    scaleRank: 4,
  },
  {
    name: 'Caption',
    role: 'caption',
    fontFamily: 'Inter',
    fontAliases: ['Inter', 'Inter-Medium', 'Inter Medium', 'Inter 500'],
    fontWeight: 500,
    minSizePx: 13,
    maxSizePx: 16,
    lineHeightRatio: 1.4,
    letterSpacingEm: 0.005,
    casingRules: { allCaps: false },
    scaleRank: 5,
  },
  {
    name: 'Legal',
    role: 'legal',
    fontFamily: 'Inter',
    fontAliases: ['Inter', 'Inter-Regular', 'Inter Regular'],
    fontWeight: 400,
    // 11px / 8pt is the hard floor. Below it the copy is not legible on a
    // handset, which is exactly the argument a regulator makes about a
    // disclaimer that technically appeared on the asset.
    minSizePx: 11,
    minSizePt: 8,
    minSizePctOfCanvas: 0.009,
    maxSizePx: 14,
    lineHeightRatio: 1.35,
    letterSpacingEm: 0.01,
    casingRules: { allCaps: false, forbidFauxBold: true, minContrastRatio: 4.5 },
    scaleRank: 6,
  },
];

export interface SeedForbiddenFont {
  fontFamily: string;
  reason: string;
  severity: 'blocker' | 'major' | 'minor' | 'advisory';
}

/**
 * These are not aesthetic objections. Each one indicates a broken pipeline:
 * a missing font substituted by the renderer, or a template opened in the
 * wrong tool. That is why they carry real severities.
 */
export const SEED_FORBIDDEN_FONTS: SeedForbiddenFont[] = [
  { fontFamily: 'Comic Sans MS', reason: 'Never approved. Its presence means the layout was rebuilt outside the template.', severity: 'blocker' },
  { fontFamily: 'Papyrus', reason: 'Never approved.', severity: 'blocker' },
  { fontFamily: 'Times New Roman', reason: 'The classic Word/PDF fallback when Sole Serif Display is unavailable.', severity: 'major' },
  { fontFamily: 'Calibri', reason: 'The Office default. Indicates a deck rebuilt from scratch rather than from the template.', severity: 'major' },
  { fontFamily: 'Arial', reason: 'The browser fallback for Inter. Allowed only in the declared CSS fallback stack, never as the resolved face.', severity: 'minor' },
  { fontFamily: 'Helvetica', reason: 'Substituted for Inter by macOS renderers. Same failure mode as Arial.', severity: 'minor' },
];

/* --------------------------------------------------------------------------
 * Voice
 *
 * "Warm, not folksy" is unjudgeable as written. Decomposed into an axis with
 * a we-are / we-are-not pair and three exemplars on each side, it becomes a
 * rubric a judge can apply consistently — and, more importantly, one a human
 * reviewer can disagree with specifically.
 * ------------------------------------------------------------------------ */

export interface SeedVoiceAttribute {
  name: string;
  weAre: string;
  weAreNot: string;
  positiveExamples: string[];
  negativeExamples: string[];
  weight: number;
}

export const SEED_VOICE: SeedVoiceAttribute[] = [
  {
    name: 'Warm, not folksy',
    weAre:
      'We write the way a good barista talks to a regular: direct, unhurried, glad you are here. Contractions are fine. Second person is preferred.',
    weAreNot:
      'We are not homespun. No "y’all", no invented rustic vocabulary, no pretending the roastery is a barn. Warmth comes from specificity, not from folksiness.',
    positiveExamples: [
      'Your morning, better sorted.',
      'We roast on Tuesdays, so Wednesday’s bag is the one to order.',
      'Same beans, better grind. Here’s why that matters.',
    ],
    negativeExamples: [
      'Howdy folks, come on down to the ol’ coffee barn!',
      'Grandma’s secret recipe, straight from our humble little kitchen.',
      'A hug in a mug, y’all.',
    ],
    weight: 1.2,
  },
  {
    name: 'Precise, not technical',
    weAre:
      'We name the origin, the roast date and the process, because those are the facts that change the cup. Numbers are welcome when they are real.',
    weAreNot:
      'We are not a spec sheet. No unexplained jargon, no agtron numbers in consumer copy, no chemistry for its own sake.',
    positiveExamples: [
      'Washed Ethiopian, roasted eleven days ago. Bright, with a lemon finish.',
      'Ground for filter. If you brew espresso, choose the finer grind at checkout.',
      'Single origin, one farm, one harvest.',
    ],
    negativeExamples: [
      'Agtron 58, 1.38% TDS, 21.2% extraction yield.',
      'Our proprietary thermodynamic roast curve optimises Maillard development.',
      'The best coffee ever, honestly, just trust us.',
    ],
    weight: 1.0,
  },
  {
    name: 'Confident, not superior',
    weAre:
      'We have a point of view and we say it plainly. We recommend. We are comfortable saying a product is not for everyone.',
    weAreNot:
      'We are not snobs. We never imply the reader’s current coffee — or their taste — is beneath us. No gatekeeping, no coffee-shaming.',
    positiveExamples: [
      'This one divides people. Order it if you like a sharper cup.',
      'If you take milk, start with the Harbour blend.',
      'We think the darker roast is the better everyday coffee. Try both.',
    ],
    negativeExamples: [
      'If you still drink instant, this conversation is not for you.',
      'Finally, coffee for people with actual taste.',
      'Real coffee drinkers know the difference.',
    ],
    weight: 1.1,
  },
  {
    name: 'Grounded, not preachy',
    weAre:
      'When we talk about sourcing and sustainability we give a verifiable fact and a link. We describe what we did, not what we believe.',
    weAreNot:
      'We are not a manifesto. No saving the planet one cup at a time, no virtue as a headline, no unsubstantiated environmental claims.',
    positiveExamples: [
      'We paid 38% above the C-price on this lot. The contract is published.',
      'Our bags are kerbside-recyclable in the UK and Germany. Check your local scheme.',
      'Three farms, named on every bag, visited twice a year.',
    ],
    negativeExamples: [
      'Together we can save the planet, one cup at a time.',
      'The world’s most sustainable coffee.',
      'Ethically sourced, obviously.',
    ],
    weight: 1.0,
  },
];

/* --------------------------------------------------------------------------
 * Lexicon
 *
 * Matched with an Aho–Corasick automaton over the submitted copy, so the cost
 * is one linear pass regardless of how many terms a tenant registers.
 * ------------------------------------------------------------------------ */

export interface SeedLexiconTerm {
  term: string;
  kind: 'banned' | 'required' | 'preferred' | 'trademark';
  replacement?: string;
  caseSensitive?: boolean;
  matchWholeWord?: boolean;
  allowFuzzy?: boolean;
  severity: 'blocker' | 'major' | 'minor' | 'advisory';
  marketCodes?: string[];
  notes?: string;
}

export const SEED_LEXICON: SeedLexiconTerm[] = [
  /* --- banned: regulatory ------------------------------------------- */
  { term: 'detox', kind: 'banned', severity: 'blocker', notes: 'Unsubstantiated health claim. Prohibited in all markets.' },
  { term: 'cures', kind: 'banned', severity: 'blocker', notes: 'Medicinal claim. Coffee is a food, not a medicine.' },
  { term: 'clinically proven', kind: 'banned', severity: 'blocker', notes: 'We hold no clinical evidence for any product claim.' },
  { term: 'fat burning', kind: 'banned', severity: 'blocker', notes: 'Health claim requiring EFSA authorisation we do not hold.' },
  { term: 'boosts metabolism', kind: 'banned', severity: 'blocker', notes: 'Health claim. Not authorised under EU Reg. 1924/2006.' },
  { term: 'zero waste', kind: 'banned', severity: 'major', replacement: 'lower waste', notes: 'Absolute environmental claim we cannot substantiate.' },
  { term: 'carbon neutral', kind: 'banned', severity: 'blocker', notes: 'Withdrawn 2025 pending revised offset methodology. Legal sign-off required to reinstate.' },
  { term: '100% sustainable', kind: 'banned', severity: 'blocker', notes: 'Absolute claim. CMA Green Claims Code and EU Green Claims Directive both bite.' },

  /* --- banned: brand ------------------------------------------------ */
  { term: 'cheap', kind: 'banned', severity: 'major', replacement: 'good value', notes: 'Off-positioning. We are not the cheap option.' },
  { term: 'artisanal', kind: 'banned', severity: 'minor', replacement: 'small-batch', notes: 'Exhausted category cliché.' },
  { term: 'game-changing', kind: 'banned', severity: 'minor', notes: 'Marketing filler. Say what changed instead.' },
  { term: 'revolutionary', kind: 'banned', severity: 'minor', notes: 'Marketing filler.' },
  { term: 'guys', kind: 'banned', severity: 'minor', replacement: 'everyone', notes: 'Non-inclusive as a collective address.' },
  { term: 'crack open', kind: 'banned', severity: 'minor', notes: 'Reads as alcohol marketing.' },

  /* --- banned: competitors ------------------------------------------ */
  { term: 'Starbucks', kind: 'banned', caseSensitive: true, severity: 'blocker', notes: 'Never name a competitor. Comparative advertising requires legal sign-off in every market.' },
  { term: 'Nespresso', kind: 'banned', caseSensitive: true, severity: 'blocker', notes: 'Third-party trademark. Do not use.' },

  /* --- required ----------------------------------------------------- */
  { term: 'Northwind', kind: 'required', caseSensitive: true, severity: 'major', notes: 'The brand must be named in body copy at least once, not only in the logo.' },
  { term: 'Best before', kind: 'required', severity: 'blocker', marketCodes: ['en-GB', 'de-DE'], notes: 'Mandatory date marking on any packaging artwork in the UK and EU.' },

  /* --- preferred ---------------------------------------------------- */
  { term: 'coffee beans', kind: 'preferred', replacement: 'whole bean coffee', severity: 'advisory', notes: 'House style.' },
  { term: 'eco-friendly', kind: 'preferred', replacement: 'lower impact', severity: 'minor', notes: 'Vaguer and legally weaker than the specific claim.' },
  { term: 'customers', kind: 'preferred', replacement: 'people who drink our coffee', severity: 'advisory', notes: 'House style in consumer-facing copy.' },
  { term: 'purchase', kind: 'preferred', replacement: 'buy', severity: 'advisory', notes: 'Plain English.' },

  /* --- trademark ---------------------------------------------------- */
  { term: 'Northwind Reserve', kind: 'trademark', caseSensitive: true, severity: 'major', notes: 'Registered. Always title case, never possessive, never hyphenated.' },
  { term: 'Slow Roast', kind: 'trademark', caseSensitive: true, severity: 'major', notes: 'Registered process mark. Requires ® on first use in en-US.', marketCodes: ['en-US'] },
  { term: 'Harbour Blend', kind: 'trademark', caseSensitive: true, severity: 'minor', notes: 'Registered en-GB. Note the -our spelling; "Harbor Blend" is the en-US registration.' },
];

/* --------------------------------------------------------------------------
 * Claims register
 *
 * The highest-willingness-to-pay object in the product. Two of these six are
 * deliberately broken so the demo catches something real on first run:
 *
 *   claim.origin-single-farm    EXPIRED — approval lapsed
 *   claim.recyclable-packaging  WRONG JURISDICTION — approved for en-GB and
 *                               de-DE only, and the seeded asset uses it in
 *                               en-US
 * ------------------------------------------------------------------------ */

export interface SeedClaim {
  key: string;
  text: string;
  variants: string[];
  category: string;
  substantiationRef: string;
  substantiationUrl?: string;
  jurisdictions: string[];
  requiredDisclaimerKey?: string;
  approvedAt: string;
  expiresAt?: string;
  isActive: boolean;
  note: string;
}

export const SEED_CLAIMS: SeedClaim[] = [
  {
    key: 'claim.arabica-100',
    text: '100% Arabica',
    variants: ['100 % Arabica', 'One hundred percent Arabica', 'Nur Arabica-Bohnen', 'Reiner Arabica'],
    category: 'compositional',
    substantiationRef: 'QA-2026-014 — green coffee purchase specifications, all lots',
    substantiationUrl: 'https://intranet.northwind.test/quality/QA-2026-014',
    jurisdictions: ['en-US', 'en-GB', 'de-DE'],
    approvedAt: '2026-01-08T00:00:00Z',
    expiresAt: '2027-01-08T00:00:00Z',
    isActive: true,
    note: 'Valid everywhere. The control case.',
  },
  {
    key: 'claim.roasted-in-portland',
    text: 'Roasted in Portland, Oregon',
    variants: ['Roasted in Portland', 'Portland-roasted', 'Roasted in Oregon'],
    category: 'origin',
    substantiationRef: 'OPS-2025-221 — roastery lease and production records',
    jurisdictions: ['en-US'],
    approvedAt: '2025-11-02T00:00:00Z',
    expiresAt: '2027-11-02T00:00:00Z',
    isActive: true,
    note: 'US only — the UK and German lots are roasted in Rotterdam.',
  },
  {
    key: 'claim.fairly-paid',
    text: 'We pay farmers above the C-price on every lot',
    variants: ['Above C-price on every lot', 'We pay above market on every lot', 'Über dem C-Preis bezahlt'],
    category: 'sourcing',
    substantiationRef: 'SRC-2026-003 — signed purchase contracts, FY26, published quarterly',
    substantiationUrl: 'https://northwind.test/sourcing/contracts',
    jurisdictions: ['en-US', 'en-GB', 'de-DE'],
    requiredDisclaimerKey: 'disclaimer.sourcing',
    approvedAt: '2026-02-14T00:00:00Z',
    expiresAt: '2026-12-31T00:00:00Z',
    isActive: true,
    note: 'Requires the sourcing disclaimer adjacent to the claim.',
  },
  {
    key: 'claim.recyclable-packaging',
    text: 'Kerbside-recyclable packaging',
    variants: ['Recyclable packaging', 'Kerbside recyclable', 'Recycelbare Verpackung', 'Curbside recyclable'],
    category: 'environmental',
    substantiationRef: 'PKG-2025-088 — OPRL assessment (UK) and Grüner Punkt classification (DE)',
    substantiationUrl: 'https://intranet.northwind.test/packaging/PKG-2025-088',
    // WRONG JURISDICTION: no US assessment exists, because US kerbside
    // programmes vary by municipality and the claim cannot be made nationally.
    jurisdictions: ['en-GB', 'de-DE'],
    requiredDisclaimerKey: 'disclaimer.recycling',
    approvedAt: '2025-09-30T00:00:00Z',
    expiresAt: '2027-09-30T00:00:00Z',
    isActive: true,
    note: 'DEMO CATCH — used on a seeded en-US asset, which is out of jurisdiction.',
  },
  {
    key: 'claim.origin-single-farm',
    text: 'Single-farm, single-harvest',
    variants: ['One farm, one harvest', 'Single farm origin', 'Single estate'],
    category: 'origin',
    substantiationRef: 'SRC-2024-141 — Finca La Ventana supply agreement (2024/25 harvest)',
    jurisdictions: ['en-US', 'en-GB', 'de-DE'],
    // EXPIRED: the supply agreement covered one harvest and was not renewed,
    // so the claim lapsed. The copy is still in circulation.
    approvedAt: '2024-10-01T00:00:00Z',
    expiresAt: '2025-10-01T00:00:00Z',
    isActive: true,
    note: 'DEMO CATCH — expired 2025-10-01 but still present on a seeded asset.',
  },
  {
    key: 'claim.awarded-2026',
    text: 'Winner, Best Independent Roaster 2026',
    variants: ['Best Independent Roaster 2026', 'Award-winning roaster 2026'],
    category: 'endorsement',
    substantiationRef: 'MKT-2026-019 — Guild of Fine Food certificate, 2026 cycle',
    jurisdictions: ['en-GB'],
    requiredDisclaimerKey: 'disclaimer.award',
    approvedAt: '2026-03-20T00:00:00Z',
    expiresAt: '2027-03-20T00:00:00Z',
    isActive: true,
    note: 'UK only. Requires the award-year disclaimer.',
  },
];

/* --------------------------------------------------------------------------
 * Disclaimers
 *
 * Most tools check only that the text is present. BrandLens checks four
 * things — present, ≥ min font size, ≥ min contrast, and adjacent to the
 * claim it qualifies — because a disclaimer at 6px in stone grey at the
 * opposite corner of the canvas satisfies "present" and nothing else.
 * ------------------------------------------------------------------------ */

export interface SeedDisclaimer {
  key: string;
  name: string;
  text: string;
  marketCodes: string[];
  channels: string[];
  minFontSizePt: number;
  minContrastRatio: number;
  maxProximityPct: number;
  isRequired: boolean;
  severity: 'blocker' | 'major' | 'minor' | 'advisory';
}

export const SEED_DISCLAIMERS: SeedDisclaimer[] = [
  {
    key: 'disclaimer.sourcing',
    name: 'Sourcing premium',
    text: 'Premium calculated against the ICE Arabica “C” price at contract date. Contracts published quarterly at northwind.test/sourcing.',
    marketCodes: ['en-US', 'en-GB', 'de-DE'],
    channels: ['meta-feed', 'meta-story', 'linkedin-feed', 'print-a4', 'display'],
    minFontSizePt: 8,
    minContrastRatio: 4.5,
    // Within a quarter of the canvas height of the claim: far enough to allow
    // a footer, close enough that it cannot be argued to be unrelated.
    maxProximityPct: 0.25,
    isRequired: true,
    severity: 'blocker',
  },
  {
    key: 'disclaimer.recycling',
    name: 'Recycling qualification',
    text: 'Kerbside recycling availability varies by local authority. Check your local scheme before disposal.',
    marketCodes: ['en-GB', 'de-DE'],
    channels: ['meta-feed', 'meta-story', 'display', 'print-a4', 'amazon-a-plus'],
    minFontSizePt: 8,
    minContrastRatio: 4.5,
    maxProximityPct: 0.2,
    isRequired: true,
    severity: 'blocker',
  },
  {
    key: 'disclaimer.award',
    name: 'Award year and body',
    text: 'Guild of Fine Food, Best Independent Roaster, 2026. Awarded in the United Kingdom only.',
    marketCodes: ['en-GB'],
    channels: ['meta-feed', 'linkedin-feed', 'print-a4', 'display'],
    minFontSizePt: 8,
    minContrastRatio: 4.5,
    maxProximityPct: 0.3,
    isRequired: true,
    severity: 'major',
  },
];

/* --------------------------------------------------------------------------
 * Markets
 * ------------------------------------------------------------------------ */

export interface SeedMarket {
  code: string;
  name: string;
  localeRules: Record<string, unknown>;
}

export const SEED_MARKETS: SeedMarket[] = [
  {
    code: 'en-US',
    name: 'United States',
    localeRules: {
      spelling: 'en-US',
      currency: 'USD',
      currencyFormat: '$0,0.00',
      dateFormat: 'MM/DD/YYYY',
      legalEntity: 'Northwind Coffee Co. Inc.',
      decimalSeparator: '.',
      requiresTrademarkSymbolOnFirstUse: true,
      forbiddenSpellings: ['colour', 'flavour', 'harbour', 'litre', 'organise'],
    },
  },
  {
    code: 'en-GB',
    name: 'United Kingdom',
    localeRules: {
      spelling: 'en-GB',
      currency: 'GBP',
      currencyFormat: '£0,0.00',
      dateFormat: 'DD/MM/YYYY',
      legalEntity: 'Northwind Coffee Co. Ltd',
      decimalSeparator: '.',
      requiresTrademarkSymbolOnFirstUse: false,
      forbiddenSpellings: ['color', 'flavor', 'harbor', 'liter', 'organize'],
      regulator: 'ASA / CAP Code; CMA Green Claims Code',
    },
  },
  {
    code: 'de-DE',
    name: 'Germany',
    localeRules: {
      spelling: 'de-DE',
      currency: 'EUR',
      currencyFormat: '0.000,00 €',
      dateFormat: 'DD.MM.YYYY',
      legalEntity: 'Northwind Coffee Co. GmbH',
      decimalSeparator: ',',
      // German compounds run long: a headline that fits in English routinely
      // overflows its box at 1:1, which is why the layout rules scope by market.
      textExpansionFactor: 1.35,
      requiresImpressum: true,
      regulator: 'UWG; EU Reg. 1924/2006 (health claims)',
      forbiddenSpellings: [],
    },
  },
];
