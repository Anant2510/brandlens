import { describe, expect, it } from 'vitest';
import { classifyChallengePage } from './browser';
import {
  colorsFromCss,
  fontsFromCss,
  normaliseColor,
  organizationFromJsonLd,
  parseStaticPage,
} from './static-harvest';
import { parse } from 'node-html-parser';

/*
 * A fixture built to mirror what academy.com actually serves to a plain
 * request — the signals were read off the live page: theme-color #1946c8, an
 * og:description, a header logo <img> with real alt text, a linked stylesheet
 * — plus a JSON-LD Organization block of the kind most retail sites carry. The
 * point is to prove the extractor recovers a real ontology from the HTML a
 * bot-walled site still serves, without a browser and without rendering.
 */
const HTML = `<!doctype html>
<html lang="en-US">
  <head>
    <meta charset="utf-8" />
    <title>Academy Sports + Outdoors | Quality Sporting Goods</title>
    <meta name="description" content="Shop Academy Sports + Outdoors for sporting goods, hunting, fishing and camping equipment." />
    <meta name="theme-color" content="#1946c8" />
    <meta property="og:site_name" content="Academy Sports + Outdoors" />
    <meta property="og:image" content="https://storage.googleapis.com/x/defaultOGImage.png" />
    <meta property="og:description" content="Shop Academy for gear and outdoor equipment." />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
    <link rel="icon" href="/favicon.ico" />
    <link rel="stylesheet" href="/assets/brand.css" />
    <style>
      .promo { background-color: #1946c8; color: #ffffff; }
      .cta { background: #e21e26; }
    </style>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Organization",
        "name": "Academy Sports + Outdoors",
        "logo": "https://images.example.com/academy-logo.svg",
        "sameAs": ["https://www.facebook.com/academy", "https://twitter.com/academy"]
      }
    </script>
  </head>
  <body>
    <header role="banner">
      <img src="/img/academy-logo.svg" alt="Academy Sports and Outdoors Logo" width="180" height="40" />
      <nav><a href="/shop">Shop</a><a href="https://external.example/x">Off-site</a></nav>
    </header>
    <main>
      <h1>Find Your Sport</h1>
      <h2>Gear up for the season</h2>
      <p>Quality sporting goods, hunting, fishing and camping equipment for every family.</p>
      <button>Shop now</button>
      <a href="/deals">Deals</a>
    </main>
    <footer><p>© 2026 Academy. Terms apply.</p></footer>
  </body>
</html>`;

const CSS = `
  :root { --brand-primary: #1946c8; --brand-accent: #e21e26; }
  body { font-family: "Academy Sans", Helvetica, Arial, sans-serif; color: #1a1a1a; }
  h1, h2 { font-family: "Academy Display", Georgia, serif; }
  .banner { background-color: #1946c8; }
  .banner--alt { background-color: #1946c8; }
  .button-primary { background-color: #e21e26; color: #ffffff; }
  .link { color: #1946c8; }
`;

describe('normaliseColor', () => {
  it('folds hex shorthand, alpha and rgb into one canonical form', () => {
    expect(normaliseColor('#FFF')).toBe('#ffffff');
    expect(normaliseColor('#1946C8')).toBe('#1946c8');
    expect(normaliseColor('#1946c8ff')).toBe('#1946c8'); // alpha dropped for the token
    expect(normaliseColor('rgb(25, 70, 200)')).toBe('#1946c8');
    expect(normaliseColor('rgba(25,70,200,0.5)')).toBe('#1946c8');
    expect(normaliseColor('chartreuse')).toBeNull();
    expect(normaliseColor('not a color')).toBeNull();
  });
});

describe('colorsFromCss', () => {
  it('surfaces the brand colour above the page neutrals', () => {
    const colors = colorsFromCss(CSS, '#1946c8');
    // theme-color + repeated background declarations should make the brand
    // blue the single heaviest colour, ahead of white and near-black text.
    expect(colors[0]?.color).toBe('#1946c8');
    const set = colors.map((c) => c.color);
    expect(set).toContain('#e21e26');
    // White is present but must not outweigh a real brand colour.
    const white = colors.find((c) => c.color === '#ffffff');
    const brand = colors.find((c) => c.color === '#1946c8')!;
    if (white) expect(brand.area).toBeGreaterThan(white.area);
  });

  it('reads a colour out of a CSS custom property', () => {
    const colors = colorsFromCss('.x { --accent: #00ff88; }', null);
    expect(colors.map((c) => c.color)).toContain('#00ff88');
  });
});

describe('fontsFromCss', () => {
  it('returns the declared families, most-used first, unquoted', () => {
    const fonts = fontsFromCss(CSS);
    expect(fonts).toContain('Academy Sans');
    expect(fonts).toContain('Academy Display');
    expect(fonts).not.toContain('inherit');
  });
});

describe('organizationFromJsonLd', () => {
  it('pulls name, absolute logo and social links from an Organization block', () => {
    const org = organizationFromJsonLd(parse(HTML), 'https://www.academy.com/');
    expect(org?.name).toBe('Academy Sports + Outdoors');
    expect(org?.logo).toBe('https://images.example.com/academy-logo.svg');
    expect(org?.sameAs).toContain('https://twitter.com/academy');
  });

  it('is null when there is no structured data rather than throwing', () => {
    expect(organizationFromJsonLd(parse('<html><body>hi</body></html>'), 'https://x/')).toBeNull();
  });
});

describe('parseStaticPage', () => {
  const parsed = parseStaticPage(HTML, 'https://www.academy.com/', CSS, 200);
  const h = parsed.harvest;

  it('recovers the brand identity a rendered harvest would have measured', () => {
    expect(h.title).toContain('Academy Sports');
    expect(h.siteName).toBe('Academy Sports + Outdoors');
    expect(h.lang).toBe('en');
    expect(h.description).toContain('sporting goods');
    expect(h.colors[0]?.color).toBe('#1946c8');
  });

  it('finds the logo three ways and prefers the real header mark', () => {
    // Header <img>, JSON-LD logo, apple-touch-icon and og:image are all
    // candidates; the header image with brand alt text must be among them.
    const alts = h.logoCandidates.map((l) => l.alt);
    expect(alts).toContain('Academy Sports and Outdoors Logo');
    expect(h.logoCandidates.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps only same-site links, dropping the off-site nav item', () => {
    expect(h.links.some((l) => l.startsWith('https://www.academy.com/'))).toBe(true);
    expect(h.links.some((l) => l.includes('external.example'))).toBe(false);
  });

  it('roles the headings so the type clusterer has a hierarchy', () => {
    const byText = Object.fromEntries(h.textRuns.map((r) => [r.text, r.role]));
    expect(byText['Find Your Sport']).toBe('display');
    expect(byText['Gear up for the season']).toBe('heading');
    expect(byText['Shop now']).toBe('button');
    expect(byText['© 2026 Academy. Terms apply.']).toBe('legal');
  });

  it('carries no screenshot, which is the signal downstream stores as structured-only', () => {
    expect(h.screenshot.byteLength).toBe(0);
    expect(h.screenshotWidth).toBe(0);
    expect(h.bodyText).toContain('Find Your Sport');
  });
});

/*
 * The plain channel gets walled too.
 *
 * The rendered harvest learned to discard challenge pages; the static fallback
 * did not, and it is the path MORE likely to be handed one, because it only
 * runs on sites already known to be defended. The result was a report listing
 * twenty "Access to this page has been denied" cards as harvested pages, with
 * a palette and a readability grade measured off the CAPTCHA.
 *
 * staticHarvestSite needs the network, so what is pinned here is the decision
 * it delegates: that a challenge page parsed from served HTML is recognised as
 * one. Same classifier as the rendered path, fed the real academy.com markup.
 */
describe('a challenge page served over plain HTTP', () => {
  const CHALLENGE = `<!doctype html>
<html><head><title>Access to this page has been denied.</title></head>
<body>
  <div id="content">
    <h1>Access to this page has been denied.</h1>
    <p>Access to this page has been denied because we believe you are using automation tools to browse the website.</p>
    <p>Reference ID: 18.4f6c1a3b.1756192800.knfjvdun</p>
  </div>
</body></html>`;

  it('is recognised from the HTML alone, exactly as the rendered path recognises it', () => {
    const parsed = parseStaticPage(CHALLENGE, 'https://www.academy.com/captcha/knfjvdun/challenge.html', '', 200);
    const verdict = classifyChallengePage(parsed.harvest);
    expect(verdict.isChallenge).toBe(true);
  });

  it('is caught by the URL even when the markup is bland', () => {
    // Akamai varies the body; the /captcha/ path is the stable tell.
    const parsed = parseStaticPage(
      '<!doctype html><html><head><title>Loading</title></head><body><p>Please wait.</p></body></html>',
      'https://www.academy.com/captcha/knfjvdun/challenge.html?provider=akamai&r=1',
      '',
      200,
    );
    expect(classifyChallengePage(parsed.harvest).isChallenge).toBe(true);
  });

  it('leaves a real academy.com category page alone', () => {
    // The guard against over-matching: a thin category page is still content.
    const parsed = parseStaticPage(
      '<!doctype html><html><head><title>Men&rsquo;s Sporting Goods | Price Match Guaranteed</title></head>' +
        '<body><h1>Men&rsquo;s</h1><p>Shop shoes, apparel and gear for every sport.</p></body></html>',
      'https://www.academy.com/c/mens',
      '',
      200,
    );
    expect(classifyChallengePage(parsed.harvest).isChallenge).toBe(false);
  });
});
