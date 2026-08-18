/** One place for every cache key, so an invalidation is never a guess. */
export const qk = {
  brands: {
    all: ['brands'] as const,
    list: () => ['brands', 'list'] as const,
    detail: (brandId: string) => ['brands', 'detail', brandId] as const,
    overview: (brandId: string) => ['brands', 'overview', brandId] as const,
  },
  rules: {
    all: (brandId: string) => ['rules', brandId] as const,
    list: (brandId: string, filters: object) => ['rules', brandId, 'list', filters] as const,
    history: (brandId: string, key: string) => ['rules', brandId, 'history', key] as const,
  },
  rulesets: {
    all: (brandId: string) => ['rulesets', brandId] as const,
    list: (brandId: string) => ['rulesets', brandId, 'list'] as const,
    detail: (brandId: string, rulesetId: string) => ['rulesets', brandId, rulesetId] as const,
  },
  ontology: {
    all: (brandId: string) => ['ontology', brandId] as const,
    resource: (brandId: string, resource: string) => ['ontology', brandId, resource] as const,
    documentChunks: (brandId: string, docId: string) => ['ontology', brandId, 'documents', docId, 'chunks'] as const,
  },
  assets: {
    all: ['assets'] as const,
    list: (filters: object) => ['assets', 'list', filters] as const,
    detail: (assetId: string) => ['assets', 'detail', assetId] as const,
    derivatives: (assetId: string) => ['assets', 'derivatives', assetId] as const,
  },
  checks: {
    all: ['checks'] as const,
    list: (filters: object) => ['checks', 'list', filters] as const,
    detail: (checkRunId: string) => ['checks', 'detail', checkRunId] as const,
    traces: (checkRunId: string) => ['checks', 'traces', checkRunId] as const,
  },
  findings: {
    all: ['findings'] as const,
    list: (filters: object) => ['findings', 'list', filters] as const,
    explain: (findingId: string) => ['findings', 'explain', findingId] as const,
  },
  reviews: {
    all: ['reviews'] as const,
    list: (filters: object) => ['reviews', 'list', filters] as const,
    detail: (reviewId: string) => ['reviews', 'detail', reviewId] as const,
  },
  analytics: {
    all: ['analytics'] as const,
    summary: (filters: object) => ['analytics', 'summary', filters] as const,
    ruleHealth: (filters: object) => ['analytics', 'rule-health', filters] as const,
    cost: (filters: object) => ['analytics', 'cost', filters] as const,
    coverage: (filters: object) => ['analytics', 'coverage', filters] as const,
  },
  assemble: {
    all: ['briefs'] as const,
    list: (brandId?: string) => ['briefs', 'list', brandId ?? 'all'] as const,
    detail: (briefId: string) => ['briefs', 'detail', briefId] as const,
  },
  predict: {
    panels: (brandId?: string) => ['panels', brandId ?? 'all'] as const,
    prediction: (id: string) => ['predictions', id] as const,
  },
  platform: {
    members: ['members'] as const,
    organization: ['organization'] as const,
    apiKeys: ['api-keys'] as const,
    webhooks: ['webhooks'] as const,
    webhookDeliveries: (id: string) => ['webhooks', id, 'deliveries'] as const,
    auditLog: (filters: object) => ['audit-log', filters] as const,
    channelSpecs: (filters: object) => ['channel-specs', filters] as const,
  },
} as const;
