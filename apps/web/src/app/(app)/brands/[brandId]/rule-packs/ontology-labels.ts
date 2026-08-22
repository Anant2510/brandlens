/**
 * The engine's ontology attribute names, in words a brand manager uses.
 *
 * `ctx.brand.logo_variants` is what the analyzer reads and what a template's
 * `needs` records; "logo files" is what somebody has to go and upload. Showing
 * the raw attribute name would be accurate and useless — the point of the
 * waiting-on signal is that it tells a person what to do next.
 */
const LABELS: Record<string, { label: string; action: string; href?: (brandId: string) => string }> = {
  logo_variants: {
    label: 'logo files',
    action: 'Upload your logo variants',
    href: (b) => `/brands/${b}/ontology?tab=logos`,
  },
  type_styles: {
    label: 'type styles',
    action: 'Define your type scale',
    href: (b) => `/brands/${b}/ontology?tab=typography`,
  },
  forbidden_fonts: {
    label: 'forbidden fonts',
    action: 'List the fonts that must never appear',
    href: (b) => `/brands/${b}/ontology?tab=typography`,
  },
  color_tokens: {
    label: 'colour tokens',
    action: 'Import your palette',
    href: (b) => `/brands/${b}/ontology?tab=tokens`,
  },
  forbidden_colors: {
    label: 'forbidden colours',
    action: 'Mark competitor colours as forbidden',
    href: (b) => `/brands/${b}/ontology?tab=tokens`,
  },
  voice_attributes: {
    label: 'voice attributes',
    action: 'Describe your voice as we-are / we-are-not pairs',
    href: (b) => `/brands/${b}/ontology?tab=voice`,
  },
  lexicon: {
    label: 'lexicon terms',
    action: 'Add the words you require and avoid',
    href: (b) => `/brands/${b}/ontology?tab=lexicon`,
  },
  claims: {
    label: 'a claims register',
    action: 'Register the claims your copy makes',
    href: (b) => `/brands/${b}/ontology?tab=claims`,
  },
  disclaimers: {
    label: 'disclaimers',
    action: 'Add the disclaimers your claims require',
    href: (b) => `/brands/${b}/ontology?tab=claims`,
  },
  image_style_profile: {
    label: 'an image style profile',
    action: 'Fit a style profile from your approved photography',
    href: (b) => `/brands/${b}/ontology?tab=imagery`,
  },
  channel_spec: { label: 'channel specifications', action: 'Channel specs ship with BrandLens' },
};

export function ontologyLabel(attribute: string): string {
  return LABELS[attribute]?.label ?? attribute.replace(/_/g, ' ');
}

export function ontologyAction(attribute: string, brandId: string): { action: string; href?: string } {
  const entry = LABELS[attribute];
  if (!entry) return { action: `Populate ${attribute.replace(/_/g, ' ')}` };
  return { action: entry.action, href: entry.href?.(brandId) };
}

/**
 * "logo files, type styles and 3 more" — a phrase, not a list of identifiers.
 *
 * Capped because the honest answer on a brand with nothing configured is all
 * ten attributes, and a headline that lists ten things is one nobody reads.
 * The full set is still reachable: the state filter shows exactly which rules
 * are waiting and each says what it needs.
 */
export function ontologyPhrase(attributes: readonly string[], max = 3): string {
  const labels = attributes.map(ontologyLabel);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0]!;

  if (labels.length > max) {
    return `${labels.slice(0, max).join(', ')} and ${labels.length - max} more`;
  }
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
