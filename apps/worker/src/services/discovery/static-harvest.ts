/**
 * Harvesting a brand's ontology from the HTML a site serves to a plain client,
 * when a headless browser is refused.
 *
 * WHY THIS IS NOT CRAWLER EVASION
 * -------------------------------
 * A site behind Akamai/Cloudflare bot management commonly does two things at
 * once: it resets or stalls an automated *browser*, and it answers a plain
 * HTTP request with 200. That is a deliberate policy — the abuse those systems
 * defend against (credential stuffing, checkout abuse, headless scraping
 * fleets) arrives through automated browsers, not through something reading the
 * markup a link-preview or a feed reader would read. academy.com is exactly
 * this: curl and a bare fetch get the full homepage; only headless Chromium is
 * turned away.
 *
 * So this path uses the channel the site keeps open, identifies itself
 * honestly as `brandlens-discovery`, obeys robots.txt, and takes only what is
 * served. It renders nothing and pretends to be nothing. It does NOT spoof a
 * browser's TLS fingerprint, hide automation, or route through residential
 * proxies — a site that closes even the plain-HTTP channel is left alone, and
 * the report says to upload the brand book instead.
 *
 * WHAT IT GIVES UP
 * ----------------
 * No JavaScript runs, so colours and type come from the CSS the page declares
 * rather than from what a browser painted, and there is no screenshot. It is a
 * thinner, lower-confidence ontology than a rendered harvest — every token it
 * proposes is marked so a reviewer knows it was read, not measured — but for a
 * server-rendered marketing site it recovers the brand name, palette, fonts,
 * logo, social links and body copy, which is most of the value.
 */

import { parse } from 'node-html-parser';
import { logger } from '../../logger';
import { FULL_USER_AGENT, type ImageCandidate, type PageHarvest, type PaintedColor, type TextRun, isLikelyLogo } from './browser';

/** node-html-parser's root node type, named without the DOM global's word. */
type Root = ReturnType<typeof parse>;

const log = logger.child({ service: 'static-harvest' });

const FETCH_TIMEOUT_MS = 15_000;
const MAX_STYLESHEETS = 8;
const MAX_CSS_BYTES = 2_000_000;
const MAX_TEXT_RUNS = 400;

export interface StaticFetch {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
}

/** One honest GET. Returns null on any network failure rather than throwing. */
export async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<StaticFetch | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': FULL_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/css,*/*;q=0.8',
      },
    });
    const contentType = res.headers.get('content-type') ?? '';
    // Cap the read so a pathological asset cannot exhaust memory.
    const body = (await res.text()).slice(0, MAX_CSS_BYTES);
    return { status: res.status, finalUrl: res.url || url, contentType, body };
  } catch (err) {
    log.debug({ url, err: err instanceof Error ? err.message : String(err) }, 'static fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// CSS colour + font extraction
//
// Not a full CSS parser: a targeted tokenizer over the declaration text. It
// pulls the two things an ontology needs — colours with their property, and
// font-family stacks — and nothing else. A real AST would be heavier and buy
// nothing here, because rendered geometry is exactly what a static read cannot
// know regardless of how well it parses.
// ---------------------------------------------------------------------------
const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const RGB = /rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*[\d.]+)?\s*\)/g;
const DECLARATION = /(background(?:-color)?|border(?:-[a-z]+)?-color|color|fill|--[\w-]+)\s*:\s*([^;{}]+)[;}]/gi;
const FONT_FAMILY = /font-family\s*:\s*([^;{}]+)[;}]/gi;

/** Normalises a hex/rgb string to lower-case hex, or null if not a colour. */
export function normaliseColor(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const hex = value.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 4 || h.length === 8) h = h.slice(0, 6); // drop alpha for the token
    if (h.length === 6) return `#${h}`;
    return null;
  }
  const rgb = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n)));
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }
  return null;
}

function propertyBucket(prop: string): PaintedColor['property'] {
  const p = prop.toLowerCase();
  if (p.startsWith('background')) return 'background-color';
  if (p.includes('border')) return 'border-color';
  return 'color'; // color, fill, and --custom properties count as foreground ink
}

/**
 * Colours declared in the CSS, weighted so a plausible dominant colour rises.
 *
 * `area` cannot be measured without rendering, so it is stood in for by how
 * often a colour is declared and whether it paints a surface — a background
 * colour declared twenty times is a better dominant-colour guess than a border
 * colour declared once. It is a proxy, and the tokens it feeds are flagged as
 * read-not-measured accordingly.
 */
export function colorsFromCss(css: string, themeColor: string | null): PaintedColor[] {
  const weight = new Map<string, { area: number; property: PaintedColor['property'] }>();
  const bump = (color: string | null, property: PaintedColor['property'], by: number) => {
    if (!color) return;
    // Pure white and near-black are the canvas of almost every site; keep them
    // but never let them outweigh an actual brand colour.
    const isNeutral = /^#(f{6}|0{6}|fefefe|010101)$/.test(color);
    const key = color;
    const prev = weight.get(key) ?? { area: 0, property };
    weight.set(key, { area: prev.area + (isNeutral ? by * 0.2 : by), property: prev.property });
  };

  // The theme-color meta is the single strongest declared brand signal a
  // browser would surface in the address bar; weight it like a large surface.
  if (themeColor) bump(normaliseColor(themeColor), 'background-color', 40);

  let m: RegExpExecArray | null;
  while ((m = DECLARATION.exec(css))) {
    const property = propertyBucket(m[1]);
    const value = m[2];
    for (const token of value.match(HEX) ?? []) bump(normaliseColor(token), property, property === 'background-color' ? 3 : 1);
    for (const token of value.match(RGB) ?? []) bump(normaliseColor(token), property, property === 'background-color' ? 3 : 1);
  }

  return [...weight.entries()]
    .map(([color, w]) => ({ color, property: w.property, selector: 'css', area: Math.round(w.area) }))
    .sort((a, b) => b.area - a.area)
    .slice(0, 60);
}

/** Distinct font-family stacks, most-declared first. */
export function fontsFromCss(css: string): string[] {
  const count = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = FONT_FAMILY.exec(css))) {
    const first = m[1].split(',')[0]?.trim().replace(/^["']|["']$/g, '');
    if (!first || /^(inherit|initial|unset|var\()/.test(first)) continue;
    count.set(first, (count.get(first) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------
const ROLE_SIZE: Record<string, number> = { display: 44, heading: 30, subheading: 22, body: 16, legal: 12, button: 15 };

function roleForTag(tag: string, inFooter: boolean): string {
  switch (tag) {
    case 'h1':
      return 'display';
    case 'h2':
      return 'heading';
    case 'h3':
    case 'h4':
      return 'subheading';
    case 'button':
      return 'button';
    default:
      return inFooter ? 'legal' : 'body';
  }
}

function meta(root: Root, names: string[]): string | null {
  for (const name of names) {
    const el =
      root.querySelector(`meta[property="${name}"]`) ??
      root.querySelector(`meta[name="${name}"]`);
    const content = el?.getAttribute('content')?.trim();
    if (content) return content;
  }
  return null;
}

function absolute(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export interface OrganizationLd {
  name?: string;
  logo?: string;
  description?: string;
  sameAs?: string[];
}

/** The Organization/WebSite node of any JSON-LD block, if present. */
export function organizationFromJsonLd(root: Root, base: string): OrganizationLd | null {
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    let data: unknown;
    try {
      data = JSON.parse(script.text);
    } catch {
      continue;
    }
    const nodes = Array.isArray(data) ? data : [data, ...(((data as { '@graph'?: unknown[] })?.['@graph']) ?? [])];
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const type = (node as { '@type'?: string | string[] })['@type'];
      const types = Array.isArray(type) ? type : [type];
      if (!types.some((t) => t === 'Organization' || t === 'Corporation' || t === 'WebSite' || t === 'LocalBusiness')) continue;
      const n = node as Record<string, unknown>;
      const logo = typeof n.logo === 'string' ? n.logo : (n.logo as { url?: string })?.url;
      const sameAs = Array.isArray(n.sameAs) ? (n.sameAs as string[]).filter((s) => typeof s === 'string') : undefined;
      return {
        name: typeof n.name === 'string' ? n.name : undefined,
        logo: absolute(logo, base) ?? undefined,
        description: typeof n.description === 'string' ? n.description : undefined,
        sameAs,
      };
    }
  }
  return null;
}

export interface ParsedStaticPage {
  harvest: PageHarvest;
  organization: OrganizationLd | null;
  stylesheetHrefs: string[];
}

/**
 * Parses one page's HTML into the shape the extract pipeline already consumes.
 * `css` is the concatenated text of the page's stylesheets, fetched separately
 * so this function stays pure and testable.
 */
export function parseStaticPage(html: string, url: string, css: string, httpStatus: number): ParsedStaticPage {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true } });

  const themeColor = meta(root, ['theme-color']);
  const inlineCss = root.querySelectorAll('style').map((s) => s.text).join('\n');
  const allCss = `${inlineCss}\n${css}`;

  const title = root.querySelector('title')?.text?.trim() || meta(root, ['og:title']) || null;
  const description = meta(root, ['description', 'og:description', 'twitter:description']);
  const siteName = meta(root, ['og:site_name']);
  const lang = root.querySelector('html')?.getAttribute('lang')?.split('-')[0] ?? null;
  const ogImageUrl = absolute(meta(root, ['og:image', 'twitter:image']) ?? undefined, url);
  const faviconUrl =
    absolute(root.querySelector('link[rel~="apple-touch-icon"]')?.getAttribute('href'), url) ??
    absolute(root.querySelector('link[rel~="icon"]')?.getAttribute('href'), url);

  const org = organizationFromJsonLd(root, url);

  // -- colours and type --------------------------------------------------
  const colors = colorsFromCss(allCss, themeColor);
  const fontStack = fontsFromCss(allCss);
  const primaryFont = fontStack[0] ?? 'sans-serif';

  // -- text runs ---------------------------------------------------------
  const runs: TextRun[] = [];
  const seen = new Set<string>();
  for (const el of root.querySelectorAll('h1, h2, h3, h4, p, li, button, a, span')) {
    if (runs.length >= MAX_TEXT_RUNS) break;
    if (el.closest('script, style, nav')) continue;
    const text = el.text.replace(/\s+/g, ' ').trim();
    if (text.length < 2 || text.length > 300 || seen.has(text)) continue;
    seen.add(text);
    const tag = el.tagName?.toLowerCase() ?? 'p';
    const inFooter = Boolean(el.closest('footer'));
    const role = roleForTag(tag, inFooter);
    runs.push({
      selector: tag,
      text,
      fontFamily: primaryFont,
      fontSizePx: ROLE_SIZE[role] ?? 16,
      fontWeight: role === 'display' || role === 'heading' ? 700 : 400,
      lineHeightPx: null,
      letterSpacingPx: null,
      textTransform: 'none',
      color: '',
      backgroundColor: '',
      role,
      // No geometry without rendering; width stands in for text length so the
      // clusterer still has a magnitude to weight by.
      bbox: { x: 0, y: 0, width: text.length, height: ROLE_SIZE[role] ?? 16 },
    });
  }

  // -- images and logo ---------------------------------------------------
  const images: ImageCandidate[] = [];
  for (const img of root.querySelectorAll('img')) {
    const src = absolute(img.getAttribute('src') ?? img.getAttribute('data-src'), url);
    if (!src) continue;
    const inHeader = Boolean(img.closest('header, [role="banner"], nav'));
    images.push({
      src,
      alt: img.getAttribute('alt') ?? null,
      selector: 'img',
      width: Number(img.getAttribute('width')) || 0,
      height: Number(img.getAttribute('height')) || 0,
      isVector: /\.svg(\?|$)/i.test(src),
      region: inHeader ? 'header' : 'content',
    });
  }
  const logoCandidates: ImageCandidate[] = images.filter((i) => isLikelyLogo(i));
  // The Organization logo and the apple-touch-icon are declared brand marks;
  // add them as candidates so a page with no obvious header <img> still yields
  // one.
  for (const declared of [org?.logo, faviconUrl, ogImageUrl]) {
    if (declared && !logoCandidates.some((l) => l.src === declared)) {
      logoCandidates.push({ src: declared, alt: siteName ?? title, selector: 'declared', width: 0, height: 0, isVector: /\.svg(\?|$)/i.test(declared), region: 'header' });
    }
  }

  // -- links -------------------------------------------------------------
  const origin = safeOrigin(url);
  const links = [
    ...new Set(
      root
        .querySelectorAll('a[href]')
        .map((a) => absolute(a.getAttribute('href'), url))
        .filter((h): h is string => Boolean(h) && safeOrigin(h!) === origin),
    ),
  ].slice(0, 200);

  const bodyText = (root.querySelector('body') ?? root).text.replace(/\s+/g, ' ').trim().slice(0, 20_000);

  const harvest: PageHarvest = {
    url,
    finalUrl: url,
    httpStatus,
    title,
    description,
    siteName: siteName ?? org?.name ?? null,
    lang,
    // No render, no pixels. Downstream is taught to treat an empty buffer as a
    // structured-only page.
    screenshot: Buffer.alloc(0),
    screenshotWidth: 0,
    screenshotHeight: 0,
    textRuns: runs,
    colors,
    images,
    logoCandidates,
    faviconUrl,
    ogImageUrl,
    links,
    bodyText,
    renderMs: 0,
  };

  return { harvest, organization: org, stylesheetHrefs: stylesheetHrefs(root, url) };
}

function stylesheetHrefs(root: Root, base: string): string[] {
  return [
    ...new Set(
      root
        .querySelectorAll('link[rel~="stylesheet"]')
        .map((l) => absolute(l.getAttribute('href'), base))
        .filter((h): h is string => Boolean(h)),
    ),
  ].slice(0, MAX_STYLESHEETS);
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Fetches one page and the stylesheets it links, and returns the parsed
 * ontology. Returns null when the page itself cannot be fetched — the caller
 * decides whether that means "try the next URL" or "give up".
 */
export async function staticHarvestPage(url: string): Promise<ParsedStaticPage | null> {
  const page = await fetchText(url);
  if (!page || page.status >= 400 || !/html/i.test(page.contentType)) {
    log.debug({ url, status: page?.status, contentType: page?.contentType }, 'static page not harvestable');
    return null;
  }

  // Parse once with no CSS to discover the stylesheet hrefs, fetch them, then
  // reparse with the CSS folded in. One extra parse is cheaper than threading
  // the href discovery through the fetch layer.
  const hrefs = stylesheetHrefs(parse(page.body), page.finalUrl);
  const sheets = await Promise.all(hrefs.map((h) => fetchText(h, 8_000)));
  let cssBytes = 0;
  const css = sheets
    .filter((s): s is StaticFetch => Boolean(s) && /css/i.test(s!.contentType))
    .map((s) => {
      cssBytes += s.body.length;
      return cssBytes <= MAX_CSS_BYTES ? s.body : '';
    })
    .join('\n');

  return parseStaticPage(page.body, page.finalUrl, css, page.status);
}

export interface StaticHarvestOptions {
  maxPages: number;
  isAllowed?: (url: string) => boolean;
  crawlDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A small, polite, plain-HTTP crawl starting at the seed. Follows same-site
 * links breadth-first up to `maxPages`, using only the channel the site serves
 * to non-browser clients. Returns whatever it could read; an empty array means
 * even the plain channel is closed, and the caller falls back to the honest
 * "upload the brand book" message.
 */
export async function staticHarvestSite(seedUrl: string, options: StaticHarvestOptions): Promise<PageHarvest[]> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const origin = safeOrigin(seedUrl);
  const queue: string[] = [seedUrl];
  const visited = new Set<string>();
  const harvests: PageHarvest[] = [];

  while (queue.length > 0 && harvests.length < options.maxPages) {
    const url = queue.shift()!;
    const key = url.replace(/#.*$/, '').replace(/\/$/, '');
    if (visited.has(key)) continue;
    visited.add(key);
    if (options.isAllowed && !options.isAllowed(url)) continue;

    const parsed = await staticHarvestPage(url);
    if (!parsed) continue;
    harvests.push(parsed.harvest);

    for (const link of parsed.harvest.links) {
      if (safeOrigin(link) === origin && !visited.has(link.replace(/#.*$/, '').replace(/\/$/, ''))) queue.push(link);
    }
    if (options.crawlDelayMs && options.crawlDelayMs > 0) await sleep(options.crawlDelayMs);
  }

  log.info({ seedUrl, pages: harvests.length }, 'static harvest complete');
  return harvests;
}
