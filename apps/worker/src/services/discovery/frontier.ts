import { checkDiscoveryUrl } from '@brandlens/contracts';

/**
 * Which pages to visit, in what order, and when to stop.
 *
 * Kept pure and browser-free so the crawl policy can be tested exhaustively
 * without launching Chromium. Every decision that costs somebody else a page
 * view is made here.
 */

/** Roles worth one page each — a corpus of six product pages induces nothing. */
export const PAGE_ROLES = [
  'home',
  'product',
  'about',
  'pricing',
  'contact',
  'careers',
  'legal',
  'blog',
  'other',
] as const;
export type PageRole = (typeof PAGE_ROLES)[number];

const ROLE_PATTERNS: Array<{ role: PageRole; re: RegExp }> = [
  { role: 'about', re: /\/(about|about-us|who-we-are|our-story|company|mission)(\/|$)/i },
  { role: 'pricing', re: /\/(pricing|plans|packages|subscribe)(\/|$)/i },
  { role: 'careers', re: /\/(careers?|jobs|work-with-us|life-at)(\/|$)/i },
  { role: 'legal', re: /\/(legal|terms|privacy|policy|policies|disclaimer|imprint|cookies?)(\/|$)/i },
  { role: 'contact', re: /\/(contact|contact-us|support|help)(\/|$)/i },
  { role: 'blog', re: /\/(blog|news|press|insights|articles?|stories)(\/|$)/i },
  { role: 'product', re: /\/(products?|solutions?|services?|features?|shop|collections?|menu|platform)(\/|$)/i },
];

export function classifyRole(url: string): PageRole {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return 'other';
  }
  if (path === '/' || path === '') return 'home';
  for (const { role, re } of ROLE_PATTERNS) {
    if (re.test(path)) return role;
  }
  return 'other';
}

/**
 * Query parameters that identify a visitor rather than a page.
 *
 * Left in place they multiply one page into a dozen "distinct" URLs, and the
 * crawl budget gets spent re-rendering the homepage with different campaign
 * tags instead of finding the pricing page.
 */
const TRACKING_PARAMS = /^(utm_|ga_|mc_|pk_|hsa_|_hs|ref$|referrer$|gclid$|fbclid$|msclkid$|igshid$|mkt_tok$)/i;

/** Extensions that are never an HTML page. Cheaper to skip than to fetch. */
const NON_PAGE_EXT =
  /\.(pdf|zip|gz|tar|rar|dmg|exe|msi|pkg|deb|rpm|mp4|webm|mov|avi|mp3|wav|ogg|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|css|js|mjs|json|xml|rss|atom|txt|csv|xlsx?|docx?|pptx?|woff2?|ttf|otf|eot)$/i;

/** Normalises a URL so two spellings of one page collapse to a single entry. */
export function normalizeUrl(raw: string, base?: string): string | null {
  let parsed: URL;
  try {
    parsed = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';

  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key);
  }
  // Stable ordering, so ?a=1&b=2 and ?b=2&a=1 are one page rather than two.
  parsed.searchParams.sort();

  // "/about/" and "/about" are the same page on essentially every site; "/"
  // is not the same as "" and must keep its slash.
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }
  parsed.pathname = parsed.pathname.replace(/\/index\.html?$/i, '') || '/';

  // Default ports are noise that would otherwise split the origin.
  if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
    parsed.port = '';
  }

  return parsed.toString();
}

function registrableSuffix(hostname: string): string {
  // Not a public-suffix-list implementation: this only needs to decide whether
  // blog.acme.com belongs with acme.com, and the last two labels answer that
  // for the overwhelming majority of brand sites. A brand on acme.co.uk gets a
  // slightly wider net, never a narrower one, and the same-origin default is
  // off anyway.
  const labels = hostname.toLowerCase().split('.');
  return labels.slice(-2).join('.');
}

export function isInScope(candidate: string, originUrl: string, includeSubdomains: boolean): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(candidate);
    b = new URL(originUrl);
  } catch {
    return false;
  }

  if (includeSubdomains) {
    return registrableSuffix(a.hostname) === registrableSuffix(b.hostname);
  }
  return a.hostname.toLowerCase() === b.hostname.toLowerCase();
}

export interface FrontierEntry {
  url: string;
  depth: number;
  role: PageRole;
}

export interface FrontierOptions {
  originUrl: string;
  maxPages: number;
  maxDepth: number;
  includeSubdomains: boolean;
  isAllowed?: (url: string) => boolean;
}

/**
 * The crawl frontier: a visited set plus a role-diverse priority queue.
 *
 * The ordering is the interesting part. A naive breadth-first crawl of a
 * marketing site spends all eight page slots on eight product pages, because
 * that is what the nav links to most. The resulting "corpus" then induces
 * rules with no variance in them — every page looks the same, so every
 * measurement looks like a rule, and the report is confidently wrong.
 *
 * Taking the first unseen page of each ROLE before taking a second page of any
 * role produces a corpus that spans the brand's registers: the marketing
 * homepage, the legal boilerplate, the careers page written by HR. That spread
 * is what makes an induced rule mean something.
 */
export class CrawlFrontier {
  private readonly queue: FrontierEntry[] = [];
  private readonly seen = new Set<string>();
  private readonly takenByRole = new Map<PageRole, number>();
  private taken = 0;

  constructor(private readonly options: FrontierOptions) {}

  /** Returns true when the URL was newly enqueued. */
  add(rawUrl: string, depth: number, base?: string): boolean {
    if (depth > this.options.maxDepth) return false;

    const url = normalizeUrl(rawUrl, base);
    if (!url) return false;
    if (this.seen.has(url)) return false;
    if (NON_PAGE_EXT.test(new URL(url).pathname)) return false;
    if (!isInScope(url, this.options.originUrl, this.options.includeSubdomains)) return false;

    // The SSRF gate again, on every discovered link and not just the seed: a
    // page on a public site can link to http://192.168.1.1/ and the crawler
    // would happily fetch it from inside the network.
    if (!checkDiscoveryUrl(url).ok) return false;

    if (this.options.isAllowed && !this.options.isAllowed(url)) return false;

    this.seen.add(url);
    this.queue.push({ url, depth, role: classifyRole(url) });
    return true;
  }

  get discovered(): number {
    return this.seen.size;
  }

  get remaining(): number {
    return this.queue.length;
  }

  /** Next page to render, or null when the budget is spent or nothing is left. */
  next(): FrontierEntry | null {
    if (this.taken >= this.options.maxPages) return null;
    if (this.queue.length === 0) return null;

    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let i = 0; i < this.queue.length; i += 1) {
      const entry = this.queue[i];
      const roleCount = this.takenByRole.get(entry.role) ?? 0;
      // Role saturation dominates; depth breaks ties; queue order settles the
      // rest, which keeps the traversal deterministic and therefore testable.
      const score = roleCount * 1000 + entry.depth * 10 + (entry.role === 'home' ? 0 : 1);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    const [entry] = this.queue.splice(bestIndex, 1);
    this.takenByRole.set(entry.role, (this.takenByRole.get(entry.role) ?? 0) + 1);
    this.taken += 1;
    return entry;
  }

  /** URLs enqueued but never rendered, so the report can name what it missed. */
  skipped(): FrontierEntry[] {
    return [...this.queue];
  }
}
