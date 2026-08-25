import { z } from 'zod';

/* ==========================================================================
 * DISCOVERY CONTRACTS
 *
 * Shapes shared by the API, the worker and the console for "URL in, brand
 * ontology out". The URL guard lives here rather than in the API because the
 * worker re-validates before every single fetch: a redirect can move an
 * origin between the moment a run is accepted and the moment a page is
 * requested, and only one of those two moments is covered by validating the
 * seed once.
 * ========================================================================== */

/* -------------------------------------------------------------- URL safety */

/**
 * Hostnames that must never be fetched, however the user spells them.
 *
 * BrandLens fetches a URL that an authenticated but untrusted user supplies,
 * from a server that sits inside a private network. That is the textbook
 * server-side request forgery setup: `http://169.254.169.254/` returns cloud
 * instance credentials, `http://localhost:4000/v1/...` reaches BrandLens's own
 * API with whatever the browser context carries, and `http://10.0.0.5/` maps
 * the customer's internal estate. The crawler is a confused deputy unless the
 * target is provably public.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
  // AWS/GCP/Azure/DigitalOcean instance metadata, and the Alibaba variant.
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/** Suffixes that only ever resolve inside a private network. */
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa'];

function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map((p) => {
    // Reject anything that is not plain decimal: 0177.0.0.1 and 0x7f.0.0.1
    // are both 127.0.0.1 to a resolver, and both pass a naive Number() check.
    if (!/^\d{1,3}$/.test(p)) return NaN;
    return Number(p);
  });
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;

  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * Expands an IPv6 literal to its eight 16-bit groups.
 *
 * Textual comparison on IPv6 does not work, because the same address has many
 * spellings and `new URL()` picks its own: `[::ffff:127.0.0.1]` comes back as
 * `[::ffff:7f00:1]`, so a rule matching the dotted form never fires. Only the
 * numeric form can be reasoned about safely.
 */
function expandIPv6(raw: string): number[] | null {
  let text = raw;

  // A trailing dotted quad (::ffff:127.0.0.1) becomes two hex groups.
  const tail = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const octets = tail[1].split('.').map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, tail.index)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || rest === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;

  const gap = 8 - head.length - rest.length;
  if (gap < 1) return null;
  return [...head, ...Array<number>(gap).fill(0), ...rest];
}

function isPrivateIPv6(host: string): boolean {
  // URL parsing leaves IPv6 literals in brackets.
  const raw = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!raw.includes(':')) return false;

  const g = expandIPv6(raw);
  if (!g) return true; // unparseable IPv6 is never a brand site — refuse it

  const allZero = (upTo: number) => g.slice(0, upTo).every((x) => x === 0);
  const embeddedV4 = (hi: number, lo: number) =>
    isPrivateIPv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.'));

  // :: (unspecified) and ::1 (loopback)
  if (allZero(7) && (g[7] === 0 || g[7] === 1)) return true;
  // fe80::/10 link-local — the range runs fe80 through febf, so a prefix
  // match on the literal "fe80" would miss most of it.
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  // fc00::/7 unique local (fc00–fdff)
  if ((g[0] & 0xfe00) === 0xfc00) return true;

  // Addresses that carry an IPv4 address inside them are only as safe as the
  // IPv4 they carry. Each of these three forms routes to that v4 address.
  if (allZero(5) && g[5] === 0xffff) return embeddedV4(g[6], g[7]); // ::ffff:0:0/96 mapped
  if (allZero(5) && g[5] === 0 && (g[6] !== 0 || g[7] > 1)) return embeddedV4(g[6], g[7]); // ::/96 compatible
  if (g[0] === 0x0064 && g[1] === 0xff9b) return embeddedV4(g[6], g[7]); // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return embeddedV4(g[1], g[2]); // 2002::/16 6to4

  return false;
}

export interface UrlCheckResult {
  ok: boolean;
  /** Normalised origin + path, safe to store and fetch. Null when !ok. */
  url: string | null;
  origin: string | null;
  reason: string | null;
}

/**
 * The single gate every outbound discovery fetch passes through.
 *
 * Returns a normalised URL rather than a boolean so callers cannot
 * accidentally validate one string and then fetch a different one — the
 * classic time-of-check/time-of-use gap in URL allowlisting.
 *
 * DNS is deliberately NOT resolved here: this module is shared with the
 * browser bundle and must stay synchronous and dependency-free. A hostname
 * that looks public but resolves to 10.0.0.1 (DNS rebinding) is caught in the
 * worker, which re-checks the resolved address before connecting. This
 * function is the first of two gates, not the only one.
 */
export function checkDiscoveryUrl(input: string): UrlCheckResult {
  const fail = (reason: string): UrlCheckResult => ({ ok: false, url: null, origin: null, reason });

  const trimmed = (input ?? '').trim();
  if (!trimmed) return fail('Enter a URL.');
  if (trimmed.length > 2048) return fail('That URL is too long.');
  // Control characters smuggle CRLF into a request line.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return fail('That URL contains control characters.');

  // Accept "acme.com" the way a browser address bar does.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return fail('That does not look like a valid URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('Only http and https URLs can be discovered.');
  }
  if (parsed.username || parsed.password) {
    return fail('Remove the credentials from the URL.');
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) return fail('That URL has no hostname.');
  if (BLOCKED_HOSTNAMES.has(host)) return fail('That host is not publicly reachable.');
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return fail('That host is not publicly reachable.');
  }
  if (isPrivateIPv4(host) || isPrivateIPv6(host)) {
    return fail('That address is on a private network.');
  }
  // A bare hostname with no dot is a search-domain lookup on an internal
  // network ("http://wiki/"), never a public site.
  if (!host.includes('.') && !host.includes(':')) {
    return fail('That host is not publicly reachable.');
  }

  parsed.hash = '';
  return { ok: true, url: parsed.toString(), origin: parsed.origin, reason: null };
}

/* ------------------------------------------------------------- Run options */

export const DiscoveryViewport = z.enum(['desktop', 'mobile']);
export type DiscoveryViewport = z.infer<typeof DiscoveryViewport>;

/**
 * Crawl budget. Every bound is enforced again in the worker; these numbers
 * exist so an operator can dial a live demo down to something that finishes
 * while people are watching, and dial real analysis up.
 */
export const DiscoveryOptions = z.object({
  /** Pages to render. The dominant cost — each is a full browser navigation. */
  maxPages: z.number().int().min(1).max(25).default(8),
  /** Link distance from the seed. 2 reaches nav plus one level of detail. */
  maxDepth: z.number().int().min(0).max(3).default(2),
  viewports: z.array(DiscoveryViewport).min(1).max(2).default(['desktop', 'mobile']),
  /** Follow links on blog.acme.com from acme.com. Off: sub-brands drift. */
  includeSubdomains: z.boolean().default(false),
  /**
   * Honour robots.txt. Exposed but defaulting to true, and the UI marks
   * turning it off as an explicit choice: BrandLens is a crawler pointed at
   * someone else's servers and should behave like a polite one.
   */
  respectRobots: z.boolean().default(true),
  /** Milliseconds between navigations. Politeness, and it steadies renders. */
  crawlDelayMs: z.number().int().min(0).max(10_000).default(500),
  /** Run the 40 analyzers over the harvested pages after inducing rules. */
  runSelfCheck: z.boolean().default(true),
  /**
   * When a site refuses the rendered browser but still serves plain HTTP,
   * read the ontology from the HTML it serves rather than failing. On by
   * default: a brand should be analysable even when its marketing site runs a
   * bot wall. Uses only the open channel, identifies honestly, obeys robots —
   * it does not defeat the bot mitigation, and a site that closes the plain
   * channel too still fails with the "upload the brand book" hint.
   */
  staticFallback: z.boolean().default(true),
  /** Attach to an existing brand instead of creating one. */
  brandId: z.string().uuid().nullish(),
});
export type DiscoveryOptions = z.infer<typeof DiscoveryOptions>;

export const StartDiscoveryRequest = z.object({
  url: z.string().min(1),
  options: DiscoveryOptions.partial().optional(),
});
export type StartDiscoveryRequest = z.infer<typeof StartDiscoveryRequest>;

/* ----------------------------------------------------------------- Results */

export const DiscoveryStage = z.enum([
  'pending',
  'harvesting',
  'extracting',
  'inducing',
  'checking',
  'reporting',
  'done',
]);
export type DiscoveryStage = z.infer<typeof DiscoveryStage>;

export const DiscoveryStatus = z.enum(['queued', 'running', 'completed', 'partial', 'failed', 'cancelled']);
export type DiscoveryStatus = z.infer<typeof DiscoveryStatus>;

export const DiscoveredPageDTO = z.object({
  id: z.string().uuid(),
  url: z.string(),
  depth: z.number().int(),
  role: z.string(),
  title: z.string().nullish(),
  httpStatus: z.number().int().nullish(),
  viewport: DiscoveryViewport,
  assetId: z.string().uuid().nullish(),
  previewUrl: z.string().nullish(),
  renderMs: z.number().nullish(),
  error: z.string().nullish(),
});
export type DiscoveredPageDTO = z.infer<typeof DiscoveredPageDTO>;

/** A colour the site actually uses, with the evidence for it. */
export const DiscoveredColor = z.object({
  hex: z.string(),
  lab: z.tuple([z.number(), z.number(), z.number()]),
  /** Share of painted area across the corpus, 0..1. Drives primary vs accent. */
  coverage: z.number(),
  /** How many distinct pages it appears on — one page is a fluke, six is a rule. */
  pageCount: z.number().int(),
  role: z.string(), // primary|secondary|accent|background|surface|text|border
  /** Where we saw it: url + CSS selector + property. */
  citations: z.array(z.object({ url: z.string(), selector: z.string(), property: z.string() })).default([]),
});
export type DiscoveredColor = z.infer<typeof DiscoveredColor>;

export const DiscoveredTypeStyle = z.object({
  name: z.string(),
  fontFamily: z.string(),
  fontWeight: z.number().int().nullish(),
  fontSizePx: z.number(),
  lineHeightPx: z.number().nullish(),
  letterSpacingPx: z.number().nullish(),
  role: z.string(), // display|heading|subheading|body|caption|button|legal
  occurrences: z.number().int(),
  citations: z.array(z.object({ url: z.string(), selector: z.string() })).default([]),
});
export type DiscoveredTypeStyle = z.infer<typeof DiscoveredTypeStyle>;

export const DiscoveredLogo = z.object({
  source: z.string(), // header|favicon|og:image|footer
  url: z.string(),
  assetId: z.string().uuid().nullish(),
  previewUrl: z.string().nullish(),
  width: z.number().int().nullish(),
  height: z.number().int().nullish(),
  isVector: z.boolean().default(false),
  confidence: z.number(),
});
export type DiscoveredLogo = z.infer<typeof DiscoveredLogo>;

export const DiscoveryReport = z.object({
  brandName: z.string(),
  tagline: z.string().nullish(),
  positioning: z.string().nullish(),

  identity: z.object({
    colors: z.array(DiscoveredColor).default([]),
    typeStyles: z.array(DiscoveredTypeStyle).default([]),
    logos: z.array(DiscoveredLogo).default([]),
    imagery: z.record(z.unknown()).default({}),
  }),

  voice: z.object({
    /**
     * Named axes with a 0..1 position and the sentences that evidence it.
     *
     * Every string in `evidence` is verified to appear verbatim in the
     * brand's own copy before it gets here. An axis whose supporting
     * quotations could not be found is discarded rather than shown, because a
     * confident voice reading with invented evidence is worse than none.
     */
    axes: z.array(
      z.object({
        name: z.string(),
        lowLabel: z.string(),
        highLabel: z.string(),
        value: z.number(),
        rationale: z.string().nullish(),
        evidence: z.array(z.string()).default([]),
      }),
    ).default([]),
    lexicon: z.array(
      z.object({
        term: z.string(),
        kind: z.string(),
        note: z.string().nullish(),
        uses: z.number().int().default(0),
        pageCount: z.number().int().default(0),
      }),
    ).default([]),
    /** Flesch, Flesch-Kincaid and friends, plus counted sentence statistics. */
    readability: z.record(z.unknown()).default({}),
    /** True when textstat was unavailable and the vendored fallback ran. */
    readabilityDegraded: z.boolean().default(false),
  }),

  legal: z.object({
    claims: z.array(
      z.object({
        text: z.string(),
        url: z.string(),
        needsSubstantiation: z.boolean(),
        claimType: z.string().default('other'),
        triggers: z.array(z.string()).default([]),
        suggestedEvidence: z.string().nullish(),
        /** False when no model reached this candidate; it still defaults to
         *  needing substantiation, because silence about regulated copy must
         *  resolve toward review. */
        judged: z.boolean().default(false),
      }),
    ).default([]),
    disclaimers: z.array(
      z.object({ text: z.string(), url: z.string(), triggerCondition: z.string().nullish() }),
    ).default([]),
  }),

  ruleset: z.object({
    rulesetId: z.string().uuid().nullish(),
    hash: z.string().nullish(),
    proposed: z.number().int().default(0),
    byDimension: z.record(z.number()).default({}),
  }),

  selfCheck: z.object({
    ran: z.boolean().default(false),
    consistencyScore: z.number().nullish(),
    pagesChecked: z.number().int().default(0),
    findingsTotal: z.number().int().default(0),
    blockersTotal: z.number().int().default(0),
    /** Rules the site breaks on its own pages, worst first. */
    topViolations: z.array(
      z.object({
        ruleKey: z.string(),
        title: z.string(),
        dimension: z.string(),
        severity: z.string(),
        pageCount: z.number().int(),
        example: z.object({ url: z.string(), detail: z.string() }).nullish(),
      }),
    ).default([]),
  }),

  coverage: z.object({
    pagesHarvested: z.number().int(),
    pagesFailed: z.number().int(),
    /** Named explicitly so the report never implies coverage it did not have. */
    skipped: z.array(z.object({ url: z.string(), reason: z.string() })).default([]),
    /**
     * How the pages were read. `rendered` is the full headless-browser harvest;
     * `static` means the site refused the browser and the ontology was read
     * from the HTML it serves — colours and type are declared, not measured, so
     * the whole report is lower-confidence and the UI says so.
     */
    harvestMode: z.enum(['rendered', 'static']).default('rendered'),
  }),
});
export type DiscoveryReport = z.infer<typeof DiscoveryReport>;

export const DiscoveryRunDTO = z.object({
  id: z.string().uuid(),
  brandId: z.string().uuid().nullish(),
  rulesetId: z.string().uuid().nullish(),
  seedUrl: z.string(),
  originUrl: z.string(),
  options: DiscoveryOptions,
  status: DiscoveryStatus,
  stage: DiscoveryStage,
  stageProgress: z.number(),
  pagesDiscovered: z.number().int(),
  pagesHarvested: z.number().int(),
  pagesFailed: z.number().int(),
  tokensProposed: z.number().int(),
  rulesProposed: z.number().int(),
  consistencyScore: z.number().nullish(),
  findingsTotal: z.number().int(),
  blockersTotal: z.number().int(),
  costUsd: z.number(),
  durationMs: z.number().nullish(),
  report: DiscoveryReport.nullish(),
  stageErrors: z.array(z.object({ stage: z.string(), message: z.string(), url: z.string().nullish() })).default([]),
  error: z.string().nullish(),
  startedAt: z.string().nullish(),
  completedAt: z.string().nullish(),
  createdAt: z.string(),
});
export type DiscoveryRunDTO = z.infer<typeof DiscoveryRunDTO>;

export const DiscoveryJobPayload = z.object({
  discoveryRunId: z.string().uuid(),
  orgId: z.string().uuid(),
  userId: z.string().uuid().nullish(),
});
export type DiscoveryJobPayload = z.infer<typeof DiscoveryJobPayload>;
