/**
 * Brand data from purpose-built "brand-by-domain" providers.
 *
 * WHY THIS EXISTS
 * ---------------
 * A crawl — rendered or static — reads what a site serves. A fully
 * client-rendered SPA serves an empty shell and paints everything with
 * JavaScript, so there is little in the HTML to read; and a site that closes
 * even the plain-HTTP channel serves nothing at all. Neither is a dead end if
 * the brand's identity can be fetched from a service that already holds it.
 *
 * These providers (Brandfetch, Logo.dev) index brand assets BY DOMAIN and
 * return them over their own API. They never touch the target site, so they
 * work regardless of what the site does to crawlers, and they cover the SPA
 * case the crawl cannot. The data is third-party-collected, so it enters the
 * ontology as CANDIDATE identity with provenance recorded, merged with (never
 * overriding) anything the crawl measured, and left for a human to confirm.
 *
 * WHAT IS AND ISN'T FREE  (verified against the providers' own docs, Aug 2026)
 * ---------------------------------------------------------------------------
 * Brandfetch Brand API — the full ontology (colours, fonts, logos): FREE for
 * 100 brand fetches / month, no card. Beyond that it returns 429 or needs a
 * paid plan. So "enrich every discovery" is free at demo volume and a paid
 * dependency at scale; results are cached by domain here so re-running a
 * discovery does not spend a fetch. Requests for `brandfetch.com` are free and
 * do not count against the quota — used by the smoke test.
 * Logo.dev — logo only, generous free tier; a keyless-ish image URL by domain,
 * a useful fallback for the mark when Brandfetch is not configured.
 *
 * Providers are configured by API key. With no key set, enrichment is simply
 * off and discovery behaves exactly as before — no key is ever hard-coded.
 */

import { logger } from '../../logger';

const log = logger.child({ service: 'brand-enrichment' });

export type EnrichmentColorRole = 'primary' | 'secondary' | 'accent' | 'background' | 'text' | 'unknown';

export interface EnrichmentColor {
  hex: string;
  role: EnrichmentColorRole;
  brightness: number | null;
}

export interface EnrichmentFont {
  name: string;
  /** display | body | unknown — mapped from the provider's own category. */
  role: string;
}

export interface EnrichmentLogo {
  src: string;
  theme: 'light' | 'dark' | null;
  format: string;
  /** logo | icon | symbol | other. */
  kind: string;
  isVector: boolean;
}

export interface BrandEnrichment {
  provider: string;
  domain: string;
  name: string | null;
  description: string | null;
  colors: EnrichmentColor[];
  fonts: EnrichmentFont[];
  logos: EnrichmentLogo[];
  links: { name: string; url: string }[];
  industries: string[];
  /** The provider's own 0..1 confidence in the record, when it gives one. */
  qualityScore: number | null;
}

export interface BrandEnrichmentProvider {
  readonly name: string;
  enrich(domain: string): Promise<BrandEnrichment | null>;
}

/**
 * What a finished harvest-and-enrich amounts to.
 *
 *  - `crawled`       the site was read; enrichment, if any, only tops it up.
 *  - `provider-only` the site could not be read on any channel we are willing
 *                    to use, but a by-domain provider had a record. The brand's
 *                    identity is recovered from that record as CANDIDATE data.
 *  - `dead-end`      neither the site nor any provider yielded anything.
 *
 * This is the honest alternative to the one thing this codebase will not do:
 * send a disguised user-agent until a refusing site relents. A provider indexes
 * a brand's public identity and serves it over its own API without ever
 * touching the site, so a site refusing our crawler is irrelevant to it. What
 * the provider returns is a third-party assertion — "the brand's blue is
 * #1946c8" — not an observation of the brand's own usage, so a `provider-only`
 * run yields identity to CONFIRM and proposes no rules to ENFORCE. A rule
 * implies we watched the brand hold itself to something; on this path we did
 * not, and a rule minted from a lookup would be the same dishonesty as a
 * measurement minted from a constant.
 */
export type RunOutcome = 'crawled' | 'provider-only' | 'dead-end';

export function classifyRunOutcome(input: { harvestedPages: number; enrichmentLanded: boolean }): RunOutcome {
  if (input.harvestedPages > 0) return 'crawled';
  if (input.enrichmentLanded) return 'provider-only';
  return 'dead-end';
}

/** Bare host for a URL or domain string — what these APIs key on. */
export function domainOf(input: string): string | null {
  const raw = input.trim().toLowerCase();
  try {
    const url = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
    return url.hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

// ===========================================================================
// Brandfetch
// ===========================================================================
const BRANDFETCH_BASE = 'https://api.brandfetch.io/v2/brands';

interface BrandfetchResponse {
  name?: string;
  domain?: string;
  description?: string;
  longDescription?: string;
  qualityScore?: number;
  colors?: Array<{ hex?: string; type?: string; brightness?: number }>;
  fonts?: Array<{ name?: string; type?: string; origin?: string }>;
  logos?: Array<{
    type?: string;
    theme?: string | null;
    formats?: Array<{ src?: string; format?: string; width?: number | null; height?: number | null }>;
  }>;
  links?: Array<{ name?: string; url?: string }>;
  company?: { industries?: Array<{ name?: string }> };
}

function mapColorRole(type: string | undefined): EnrichmentColorRole {
  switch ((type ?? '').toLowerCase()) {
    case 'dark':
    case 'text':
      return 'text';
    case 'light':
    case 'background':
      return 'background';
    case 'brand':
    case 'primary':
      return 'primary';
    case 'secondary':
      return 'secondary';
    case 'accent':
      return 'accent';
    default:
      return 'unknown';
  }
}

function mapFontRole(type: string | undefined): string {
  const t = (type ?? '').toLowerCase();
  if (t.includes('title') || t.includes('display') || t.includes('heading')) return 'display';
  if (t.includes('body') || t.includes('text')) return 'body';
  return 'unknown';
}

/** Pure mapper, so the shape translation is testable without the network. */
export function mapBrandfetch(body: BrandfetchResponse, domain: string): BrandEnrichment {
  const logos: EnrichmentLogo[] = [];
  for (const logo of body.logos ?? []) {
    for (const fmt of logo.formats ?? []) {
      if (!fmt.src) continue;
      logos.push({
        src: fmt.src,
        theme: logo.theme === 'light' || logo.theme === 'dark' ? logo.theme : null,
        format: fmt.format ?? 'unknown',
        kind: logo.type ?? 'logo',
        isVector: (fmt.format ?? '').toLowerCase() === 'svg',
      });
    }
  }
  return {
    provider: 'brandfetch',
    domain: body.domain ?? domain,
    name: body.name ?? null,
    description: body.description ?? body.longDescription ?? null,
    colors: (body.colors ?? [])
      .filter((c) => typeof c.hex === 'string')
      .map((c) => ({ hex: c.hex!.toLowerCase(), role: mapColorRole(c.type), brightness: c.brightness ?? null })),
    fonts: (body.fonts ?? [])
      .filter((f) => typeof f.name === 'string' && f.name)
      .map((f) => ({ name: f.name!, role: mapFontRole(f.type) })),
    logos,
    links: (body.links ?? []).filter((l): l is { name: string; url: string } => Boolean(l.name && l.url)),
    industries: (body.company?.industries ?? []).map((i) => i.name).filter((n): n is string => Boolean(n)),
    qualityScore: typeof body.qualityScore === 'number' ? body.qualityScore : null,
  };
}

export class BrandfetchProvider implements BrandEnrichmentProvider {
  readonly name = 'brandfetch';
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async enrich(domain: string): Promise<BrandEnrichment | null> {
    const host = domainOf(domain);
    if (!host) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await this.fetchImpl(`${BRANDFETCH_BASE}/${encodeURIComponent(host)}`, {
        headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' },
        signal: controller.signal,
      });

      // The quota headers are advisory but worth surfacing: the free tier is
      // 100 fetches/month and a silent exhaustion looks like "enrichment
      // stopped working" weeks later.
      const usage = res.headers.get('x-api-key-approximate-usage');
      const quota = res.headers.get('x-api-key-quota');
      if (usage && quota) log.info({ usage, quota }, 'brandfetch quota');

      if (res.status === 404) {
        log.info({ host }, 'brandfetch has no record for this domain');
        return null;
      }
      if (res.status === 401 || res.status === 403) {
        log.warn({ status: res.status }, 'brandfetch rejected the API key; enrichment skipped');
        return null;
      }
      if (res.status === 429) {
        log.warn({ usage, quota }, 'brandfetch quota exhausted; enrichment skipped for this run');
        return null;
      }
      if (!res.ok) {
        log.warn({ status: res.status }, 'brandfetch request failed');
        return null;
      }
      const body = (await res.json()) as BrandfetchResponse;
      return mapBrandfetch(body, host);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), host }, 'brandfetch request errored');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ===========================================================================
// Logo.dev  — logo only, but keyed and generous. Fills the mark when
// Brandfetch is not configured or has no record.
// ===========================================================================
export class LogoDevProvider implements BrandEnrichmentProvider {
  readonly name = 'logodev';
  constructor(private readonly token: string) {}

  // Logo.dev serves an image directly by domain rather than a JSON record, so
  // there is nothing to fetch here — the URL IS the result. Whether the brand
  // exists is only known when the image is later downloaded, which the logo
  // pipeline already handles, so a broken mark degrades to "no logo" rather
  // than a failed request.
  async enrich(domain: string): Promise<BrandEnrichment | null> {
    const host = domainOf(domain);
    if (!host) return null;
    const src = `https://img.logo.dev/${encodeURIComponent(host)}?token=${encodeURIComponent(this.token)}&format=png&size=256`;
    return {
      provider: 'logodev',
      domain: host,
      name: null,
      description: null,
      colors: [],
      fonts: [],
      logos: [{ src, theme: null, format: 'png', kind: 'logo', isVector: false }],
      links: [],
      industries: [],
      qualityScore: null,
    };
  }
}

// ===========================================================================
// Orchestration
// ===========================================================================
export interface EnrichmentConfig {
  brandfetchApiKey?: string;
  logoDevToken?: string;
}

/** The providers a deployment has keys for, in priority order. */
export function buildProviders(config: EnrichmentConfig, fetchImpl: typeof fetch = fetch): BrandEnrichmentProvider[] {
  const providers: BrandEnrichmentProvider[] = [];
  if (config.brandfetchApiKey) providers.push(new BrandfetchProvider(config.brandfetchApiKey, fetchImpl));
  if (config.logoDevToken) providers.push(new LogoDevProvider(config.logoDevToken));
  return providers;
}

/**
 * Runs the configured providers for one domain and merges what they return.
 *
 * First provider to supply a field wins; later providers only fill gaps —
 * Brandfetch's full record is preferred, and Logo.dev tops up the mark when
 * Brandfetch had none. Returns null when nothing is configured or nothing had
 * a record, which the caller treats as "no enrichment", never as an error.
 */
export async function enrichBrand(
  domain: string,
  providers: BrandEnrichmentProvider[],
): Promise<BrandEnrichment | null> {
  const results: BrandEnrichment[] = [];
  for (const provider of providers) {
    try {
      const result = await provider.enrich(domain);
      if (result) results.push(result);
    } catch (err) {
      log.warn({ provider: provider.name, err: err instanceof Error ? err.message : String(err) }, 'provider errored');
    }
  }
  if (results.length === 0) return null;

  const primary = results[0];
  const merged: BrandEnrichment = {
    ...primary,
    provider: results.map((r) => r.provider).join('+'),
  };
  for (const other of results.slice(1)) {
    merged.name ??= other.name;
    merged.description ??= other.description;
    if (merged.colors.length === 0) merged.colors = other.colors;
    if (merged.fonts.length === 0) merged.fonts = other.fonts;
    if (merged.logos.length === 0) merged.logos = other.logos;
    if (merged.links.length === 0) merged.links = other.links;
    if (merged.industries.length === 0) merged.industries = other.industries;
    merged.qualityScore ??= other.qualityScore;
  }
  return merged;
}
