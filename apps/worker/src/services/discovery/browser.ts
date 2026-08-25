import type { Browser, BrowserContext, Page } from 'playwright';
import { logger } from '../../logger';

/**
 * The headless-browser half of discovery.
 *
 * Playwright is imported lazily, for two reasons. It pulls a ~150MB Chromium
 * behind it, and the worker must still start and run every other job on a
 * machine where that install never happened — a discovery job should fail with
 * "install the browser" rather than the whole worker refusing to boot. It is
 * also the only import in this codebase heavy enough for the deferral to
 * matter at process start.
 */

export const DISCOVERY_USER_AGENT = 'brandlens-discovery';

/** Advertised to the sites we visit, with a way to reach a human. */
export const FULL_USER_AGENT =
  'Mozilla/5.0 (compatible; brandlens-discovery/1.0; +https://github.com/brandlens/brandlens#discovery)';

/**
 * Chromium reporting that an HTTP/2 connection died mid-stream.
 *
 * This is not a 403, a timeout, or a missing page. The TLS handshake succeeded
 * and then the h2 stream was reset, which happens for two reasons that look
 * identical from here: a TLS-inspecting proxy re-encrypting traffic and
 * mangling the framing on the way through -- the normal state of affairs on a
 * corporate network -- or an edge whose h2 configuration Chromium disagrees
 * with. Either way the site is reachable and willing; only the protocol is
 * failing, and HTTP/1.1 to the same host returns 200.
 *
 * Worth being precise about what this is NOT: it is not a way past a site that
 * has decided to refuse a crawler. A WAF turning an identified bot away
 * answers 403, and the honest response to a 403 is to stop.
 */
export function isHttp2ProtocolError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // ERR_SPDY_PROTOCOL_ERROR is the same failure under Chromium's older name
  // for the stack, still emitted by some builds.
  return /ERR_HTTP2_PROTOCOL_ERROR|ERR_SPDY_PROTOCOL_ERROR/.test(message);
}

/* --------------------------------------------------------------------------
 * Telling apart the three ways harvesting fails.
 *
 * A page.goto that throws has told us almost nothing on its own: a reset
 * connection, a protocol error and a 30-second timeout are three different
 * words for "the browser did not get a page", and the report was showing the
 * raw string, which is how "this site blocks bots" reached a person as
 * `Timeout 30000ms exceeded`.
 *
 * The signal that separates them is cheap: try the same origin with a plain
 * HTTP client. A site that a bare fetch can reach but a real browser cannot is
 * not down and is not slow -- it is refusing the automated browser, which is
 * what Akamai, Cloudflare and the rest do by resetting or stalling the
 * connection rather than answering 403. A site a bare fetch also cannot reach
 * is genuinely unreachable. Same throw, opposite meaning, and the difference
 * is the whole thing a person needs to know.
 * ------------------------------------------------------------------------ */
export type HarvestFailureKind = 'bot-refused' | 'unreachable' | 'timeout' | 'unknown';

export interface HarvestDiagnosis {
  kind: HarvestFailureKind;
  /** The underlying Chromium error, kept for logs. */
  detail: string;
  /** One sentence a person can act on, for the report. */
  hint: string;
  originReached: boolean;
}

const NAV_NETWORK_ERROR =
  /ERR_(CONNECTION_(RESET|CLOSED|ABORTED|FAILED|REFUSED)|HTTP2_PROTOCOL_ERROR|SPDY_PROTOCOL_ERROR|EMPTY_RESPONSE|SSL|TIMED_OUT)/;
const NAV_TIMEOUT = /Timeout .*exceeded|ERR_TIMED_OUT/;
const NAV_DNS = /ERR_NAME_NOT_RESOLVED/;

export type OriginProbe = { reached: boolean; status?: number; error?: string };

/**
 * One plain-HTTP request to the origin, no browser involved. Any HTTP response
 * -- even a 403 -- means "reached": the server is up and talking to a
 * non-browser client, which is exactly the state that distinguishes a bot wall
 * from an outage.
 */
export async function probeOrigin(url: string, timeoutMs = 10_000): Promise<OriginProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(url).origin, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // The honest discovery UA, and a browser-shaped Accept so a server
        // that varies on it returns HTML rather than an API error.
        'user-agent': FULL_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    await res.body?.cancel().catch(() => undefined);
    return { reached: true, status: res.status };
  } catch (err) {
    return { reached: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classifies a navigation failure, using a plain-HTTP probe to disambiguate.
 * The probe is injectable so the branching can be tested without a network.
 */
export async function diagnoseHarvestFailure(
  url: string,
  error: unknown,
  probe: (url: string) => Promise<OriginProbe> = probeOrigin,
): Promise<HarvestDiagnosis> {
  const detail = error instanceof Error ? error.message : String(error);

  if (NAV_DNS.test(detail)) {
    return { kind: 'unreachable', detail, originReached: false, hint: 'The domain did not resolve — check the URL is spelt correctly and is public.' };
  }

  const networkish = NAV_NETWORK_ERROR.test(detail) || NAV_TIMEOUT.test(detail);
  if (!networkish) {
    return { kind: 'unknown', detail, originReached: false, hint: 'The page could not be rendered.' };
  }

  const result = await probe(url);
  if (result.reached) {
    return {
      kind: 'bot-refused',
      detail,
      originReached: true,
      hint:
        'The site answered a plain request but refused the automated browser. It uses bot mitigation ' +
        '(Akamai, Cloudflare and similar) that blocks headless crawlers, so discovery cannot harvest it. ' +
        'Upload the brand book or brand assets directly, or point discovery at a press or brand-guidelines page.',
    };
  }
  if (NAV_TIMEOUT.test(detail)) {
    return { kind: 'timeout', detail, originReached: false, hint: 'The site did not respond in time and a plain request could not reach it either — it may be down or blocking this network.' };
  }
  return { kind: 'unreachable', detail, originReached: false, hint: `The site could not be reached from this host (${result.error ?? 'no response'}).` };
}

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, isMobile: false, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 },
} as const;

export type ViewportName = keyof typeof VIEWPORTS;

export interface TextRun {
  selector: string;
  text: string;
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  lineHeightPx: number | null;
  letterSpacingPx: number | null;
  textTransform: string;
  color: string;
  /** The colour actually painted behind this text, walked up the ancestors. */
  backgroundColor: string;
  role: string;
  bbox: { x: number; y: number; width: number; height: number };
}

export interface PaintedColor {
  color: string;
  property: 'background-color' | 'color' | 'border-color';
  selector: string;
  /** Painted area in CSS pixels — the weight behind "dominant colour". */
  area: number;
}

export interface ImageCandidate {
  src: string;
  alt: string | null;
  selector: string;
  width: number;
  height: number;
  isVector: boolean;
  /** header|footer|hero|content — where on the page it sits. */
  region: string;
}

export interface PageHarvest {
  url: string;
  finalUrl: string;
  httpStatus: number | null;
  title: string | null;
  description: string | null;
  siteName: string | null;
  lang: string | null;
  screenshot: Buffer;
  screenshotWidth: number;
  screenshotHeight: number;
  textRuns: TextRun[];
  colors: PaintedColor[];
  images: ImageCandidate[];
  logoCandidates: ImageCandidate[];
  faviconUrl: string | null;
  ogImageUrl: string | null;
  links: string[];
  /** Visible body copy, for the voice and claims passes. */
  bodyText: string;
  renderMs: number;
}

/**
 * Everything below runs INSIDE the page, so it must be a self-contained
 * function with no closure over worker code. Written as a string-free
 * function passed to `page.evaluate`, which Playwright serialises for us.
 */
/* c8 ignore start — executes in the browser, not under the test runner */
function collectFromDom() {
  const MAX_RUNS = 400;
  const MAX_COLORS = 800;
  const MAX_IMAGES = 120;

  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += `#${node.id}`;
        parts.unshift(part);
        break;
      }
      const cls = (node.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) part += `.${cls.join('.')}`;
      parts.unshift(part);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  };

  const isVisible = (el: Element, style: CSSStyleDeclaration, rect: DOMRect): boolean =>
    style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    Number(style.opacity) > 0.05 &&
    rect.width > 1 &&
    rect.height > 1;

  /**
   * Walks up until it finds an ancestor that actually paints. A transparent
   * background is not "no background" — it is whatever is behind it, and
   * contrast measured against `rgba(0,0,0,0)` is meaningless.
   */
  const effectiveBackground = (el: Element): string => {
    let node: Element | null = el;
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(bg)) return bg;
      node = node.parentElement;
    }
    return 'rgb(255, 255, 255)';
  };

  const regionOf = (el: Element): string => {
    if (el.closest('header, [role="banner"], nav')) return 'header';
    if (el.closest('footer, [role="contentinfo"]')) return 'footer';
    const rect = el.getBoundingClientRect();
    if (rect.top + window.scrollY < window.innerHeight * 0.9) return 'hero';
    return 'content';
  };

  const roleOf = (el: Element, sizePx: number, weight: number): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'h1') return 'display';
    if (tag === 'h2') return 'heading';
    if (tag === 'h3' || tag === 'h4') return 'subheading';
    if (tag === 'button' || el.closest('button, [role="button"], .btn, .button')) return 'button';
    if (el.closest('footer')) return sizePx <= 13 ? 'legal' : 'body';
    if (sizePx >= 40) return 'display';
    if (sizePx >= 28) return 'heading';
    if (sizePx <= 12) return 'caption';
    if (weight >= 600 && sizePx >= 18) return 'subheading';
    return 'body';
  };

  const textRuns: unknown[] = [];
  const colors: unknown[] = [];
  const images: unknown[] = [];

  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (textRuns.length >= MAX_RUNS && colors.length >= MAX_COLORS) break;

    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, style, rect)) continue;

    if (colors.length < MAX_COLORS) {
      const area = rect.width * rect.height;
      const bg = style.backgroundColor;
      if (bg && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(bg) && bg !== 'transparent') {
        colors.push({ color: bg, property: 'background-color', selector: cssPath(el), area });
      }
      const bc = style.borderTopColor;
      if (bc && style.borderTopWidth !== '0px' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(bc)) {
        colors.push({ color: bc, property: 'border-color', selector: cssPath(el), area: rect.width * 2 });
      }
    }

    // Only elements whose OWN text node is non-empty, so a wrapper div does
    // not get credited with the text of everything inside it.
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent ?? '').trim())
      .join(' ')
      .trim();

    if (own && textRuns.length < MAX_RUNS) {
      const sizePx = parseFloat(style.fontSize) || 0;
      const weight = parseInt(style.fontWeight, 10) || 400;
      const lh = parseFloat(style.lineHeight);
      const ls = parseFloat(style.letterSpacing);
      textRuns.push({
        selector: cssPath(el),
        text: own.slice(0, 400),
        fontFamily: style.fontFamily,
        fontSizePx: sizePx,
        fontWeight: weight,
        lineHeightPx: Number.isFinite(lh) ? lh : null,
        letterSpacingPx: Number.isFinite(ls) ? ls : null,
        textTransform: style.textTransform,
        color: style.color,
        backgroundColor: effectiveBackground(el),
        role: roleOf(el, sizePx, weight),
        bbox: { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height },
      });
      if (colors.length < MAX_COLORS) {
        colors.push({ color: style.color, property: 'color', selector: cssPath(el), area: own.length * sizePx });
      }
    }
  }

  for (const el of Array.from(document.querySelectorAll('img, svg')).slice(0, MAX_IMAGES)) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    const isSvg = el.tagName.toLowerCase() === 'svg';
    const src = isSvg ? '' : (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || '';
    images.push({
      src,
      alt: el.getAttribute('alt'),
      selector: cssPath(el),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      isVector: isSvg || /\.svg(\?|$)/i.test(src),
      region: regionOf(el),
    });
  }

  const meta = (selector: string): string | null =>
    document.querySelector(selector)?.getAttribute('content')?.trim() || null;

  const links = Array.from(document.querySelectorAll('a[href]'))
    .map((a) => (a as HTMLAnchorElement).href)
    .filter(Boolean)
    .slice(0, 600);

  const icon =
    document.querySelector('link[rel="apple-touch-icon"]') ??
    document.querySelector('link[rel~="icon"]') ??
    null;

  return {
    title: document.title || null,
    description: meta('meta[name="description"]') ?? meta('meta[property="og:description"]'),
    siteName: meta('meta[property="og:site_name"]'),
    lang: document.documentElement.getAttribute('lang'),
    textRuns,
    colors,
    images,
    faviconUrl: icon ? new URL(icon.getAttribute('href') ?? '', document.baseURI).toString() : null,
    ogImageUrl: meta('meta[property="og:image"]'),
    links,
    bodyText: (document.body.innerText ?? '').slice(0, 24_000),
    docHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
  };
}
/* c8 ignore stop */

export class DiscoveryBrowser {
  private browser: Browser | null = null;
  /**
   * A second Chromium that speaks only HTTP/1.1, launched on demand.
   *
   * `--disable-http2` is a process-level switch: Chromium negotiates the
   * protocol by ALPN at connection time and there is no per-page or
   * per-context override. So recovering from a protocol error means a separate
   * browser, and it is worth the ~100MB of RSS only on the runs that need it.
   */
  private http1Only: Browser | null = null;
  /** True when every navigation should skip h2 from the start. */
  private readonly forceHttp1 = /^(1|true|yes)$/i.test(process.env.DISCOVERY_DISABLE_HTTP2?.trim() ?? '');

  /**
   * Chromium is resolved from PLAYWRIGHT_BROWSERS_PATH when set, which is how
   * the Windows VM points at a shared install rather than one copy per
   * node_modules tree.
   */
  async launch(): Promise<void> {
    if (this.browser) return;
    this.browser = await this.spawn(this.forceHttp1);
    if (this.forceHttp1) {
      this.http1Only = this.browser;
      logger.info({ reason: 'DISCOVERY_DISABLE_HTTP2' }, 'discovery browser is HTTP/1.1 only');
    }
  }

  private async spawn(disableHttp2: boolean): Promise<Browser> {
    let chromium: typeof import('playwright').chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch (err) {
      throw new Error(
        'Playwright is not installed. Discovery needs a headless browser: run ' +
          '`pnpm --filter @brandlens/worker exec playwright install chromium`. ' +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }

    // An explicit path wins over Playwright's own resolution. Playwright pins
    // an exact Chromium build number per release, so a browser installed by a
    // slightly different version is invisible to it even though it works
    // perfectly — and re-downloading 150MB onto a locked-down VM to satisfy a
    // build-number match is not a reasonable ask. This is also how an operator
    // points at a Chrome the organisation already manages.
    const executablePath = process.env.DISCOVERY_BROWSER_EXECUTABLE?.trim() || undefined;
    const args = ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox'];
    if (disableHttp2) args.push('--disable-http2');

    try {
      return await chromium.launch({ headless: true, executablePath, args });
    } catch (err) {
      throw new Error(
        'Chromium failed to launch. Install it with ' +
          '`pnpm --filter @brandlens/worker exec playwright install chromium`, or point ' +
          'DISCOVERY_BROWSER_EXECUTABLE at an existing Chrome or Chromium binary. ' +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  /** The HTTP/1.1-only browser, launched the first time something needs it. */
  private async http1Browser(): Promise<Browser> {
    if (!this.http1Only) {
      this.http1Only = await this.spawn(true);
      logger.warn(
        {},
        'HTTP/2 failed against a reachable host; retrying over HTTP/1.1. Set DISCOVERY_DISABLE_HTTP2=1 ' +
          'to skip the failed attempt on every page if this is persistent on your network.',
      );
    }
    return this.http1Only;
  }

  async close(): Promise<void> {
    const both = [this.browser, this.http1Only === this.browser ? null : this.http1Only];
    this.browser = null;
    this.http1Only = null;
    for (const browser of both) await browser?.close().catch(() => undefined);
  }

  private async context(browser: Browser, viewport: ViewportName): Promise<BrowserContext> {
    const vp = VIEWPORTS[viewport];
    return browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.deviceScaleFactor,
      isMobile: vp.isMobile,
      hasTouch: vp.isMobile,
      userAgent: FULL_USER_AGENT,
      // Reduced motion stops carousels and entrance animations mid-flight,
      // which would otherwise put a half-faded hero in the screenshot and
      // produce a contrast finding that does not exist for a real visitor.
      reducedMotion: 'reduce',
      javaScriptEnabled: true,
      ignoreHTTPSErrors: false,
      locale: 'en-US',
    });
  }

  /** Renders one page and returns everything discovery needs from it. */
  async harvest(url: string, viewport: ViewportName, timeoutMs = 30_000): Promise<PageHarvest> {
    if (!this.browser) throw new Error('Browser not launched');
    try {
      return await this.render(this.browser, url, viewport, timeoutMs);
    } catch (err) {
      // Retry ONLY this one failure, and only once. A host that answers 403,
      // times out, or serves an error page has told us something, and repeating
      // the request over a different protocol would just be ignoring it.
      if (!isHttp2ProtocolError(err) || this.http1Only === this.browser) throw err;
      logger.warn({ url, error: err instanceof Error ? err.message : String(err) }, 'http2 navigation failed');
      return await this.render(await this.http1Browser(), url, viewport, timeoutMs);
    }
  }

  private async render(
    browser: Browser,
    url: string,
    viewport: ViewportName,
    timeoutMs: number,
  ): Promise<PageHarvest> {
    const started = Date.now();
    const context = await this.context(browser, viewport);
    let page: Page | null = null;

    try {
      page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);

      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

      // `networkidle` hangs forever on sites with analytics heartbeats or open
      // websockets, which is most of them. Settling for a short quiet period
      // after DOM-ready renders reliably and finishes.
      await page.waitForLoadState('load', { timeout: Math.min(timeoutMs, 15_000) }).catch(() => undefined);
      await page.waitForTimeout(1200);

      await dismissConsentBanners(page);
      await scrollThroughPage(page);

      const dom = (await page.evaluate(collectFromDom)) as ReturnType<typeof collectFromDom>;

      const screenshot = await page.screenshot({
        fullPage: true,
        type: 'png',
        // Some marketing sites are 30,000px tall. Beyond a few screens the
        // extra pixels add nothing an analyzer can use and cost a lot of
        // memory to encode.
        clip: undefined,
        animations: 'disabled',
        scale: 'css',
      });

      const vp = VIEWPORTS[viewport];
      const logoCandidates = (dom.images as ImageCandidate[]).filter(isLikelyLogo);

      return {
        url,
        finalUrl: page.url(),
        httpStatus: response?.status() ?? null,
        title: dom.title,
        description: dom.description,
        siteName: dom.siteName,
        lang: dom.lang,
        screenshot,
        screenshotWidth: vp.width,
        screenshotHeight: Math.min(dom.docHeight, 20_000),
        textRuns: dom.textRuns as TextRun[],
        colors: dom.colors as PaintedColor[],
        images: dom.images as ImageCandidate[],
        logoCandidates,
        faviconUrl: dom.faviconUrl,
        ogImageUrl: dom.ogImageUrl ? new URL(dom.ogImageUrl, page.url()).toString() : null,
        links: dom.links,
        bodyText: dom.bodyText,
        renderMs: Date.now() - started,
      };
    } finally {
      await page?.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }
}

/**
 * A logo is an image in the header, near the top, wider than tall, of modest
 * size — or one whose markup says so outright. Scored rather than matched:
 * "the first img in the header" is right on most sites and catastrophically
 * wrong on the ones that put a promo banner above the masthead.
 */
export function isLikelyLogo(image: ImageCandidate): boolean {
  const hay = `${image.src} ${image.alt ?? ''} ${image.selector}`.toLowerCase();
  if (/logo|brandmark|wordmark|masthead/.test(hay)) return true;

  const ratio = image.height > 0 ? image.width / image.height : 0;
  return image.region === 'header' && ratio >= 0.5 && ratio <= 8 && image.width <= 480 && image.height <= 200;
}

/**
 * Cookie walls cover the page and would otherwise be the first thing every
 * screenshot shows — and the thing every layout analyzer measures.
 *
 * Best-effort: a banner that survives is a finding about the page, not an
 * error. Buttons are matched by accessible name because consent tools all
 * generate different class names but agree on the words.
 */
async function dismissConsentBanners(page: Page): Promise<void> {
  const labels = [
    /^(accept|allow|agree)( all)?( cookies)?$/i,
    /^(i )?(accept|agree|understand|got it|ok)$/i,
    /^(reject|decline)( all)?$/i,
    /^continue$/i,
  ];

  for (const label of labels) {
    try {
      const button = page.getByRole('button', { name: label }).first();
      if (await button.isVisible({ timeout: 700 })) {
        await button.click({ timeout: 1500, noWaitAfter: true });
        await page.waitForTimeout(400);
        return;
      }
    } catch {
      // No such button, or it vanished mid-click. Either way, move on.
    }
  }

  // Some walls are pure CSS overlays with no dismiss control at all.
  await page
    .evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('[id*="cookie" i], [class*="cookie" i]'))) {
        const style = getComputedStyle(el);
        if (style.position === 'fixed' && el.getBoundingClientRect().height > 60) {
          (el as HTMLElement).style.display = 'none';
        }
      }
    })
    .catch(() => undefined);
}

/**
 * Scrolls to the bottom and back.
 *
 * Lazy-loaded images below the fold are `data-src` placeholders until they
 * scroll into view. Screenshotting without this produces a page of grey boxes
 * and an imagery analysis of nothing.
 */
async function scrollThroughPage(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      const step = window.innerHeight * 0.8;
      const limit = Math.min(document.body.scrollHeight, 20_000);
      for (let y = 0; y < limit; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 300));
    });
  } catch (err) {
    logger.debug({ err }, 'lazy-load scroll failed; continuing with what rendered');
  }
}
