import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiscoveryBrowser } from './browser';
import { extractPalette, extractTypeStyles, findContrastFailures, rankLogoCandidates } from './extract-identity';
import { synthesizeRules } from './synthesize-rules';

/**
 * End-to-end proof that the pipeline recovers a brand it has never seen.
 *
 * Every other test in this directory exercises pure functions against
 * hand-written fixtures, which proves the arithmetic but not that a real
 * browser produces the shape those functions expect. This one serves a site
 * with a KNOWN identity, renders it in Chromium, and checks that what comes
 * out the far end is the identity that went in.
 *
 * The planted defects matter as much as the planted identity: a grey that
 * fails WCAG and a 9px legal line are in the fixture on purpose, so the test
 * can assert discovery finds them rather than quietly averaging them away.
 *
 * Skipped automatically when Chromium is absent — CI installs the npm package
 * but not the ~150MB browser, and a missing browser is a environment fact
 * rather than a failure of this code.
 */

const BRAND_GREEN = 'rgb(0, 90, 60)';
const BRAND_CREAM = 'rgb(245, 240, 230)';

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Northwind Coffee — Roasted for people who notice</title>
  <meta name="description" content="Single-origin coffee, roasted on Tuesdays.">
  <meta property="og:site_name" content="Northwind Coffee">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body { font-family: Georgia, serif; background: ${BRAND_CREAM}; color: rgb(20,20,20); }
    header { background: ${BRAND_GREEN}; padding: 24px; }
    .hero { background: ${BRAND_GREEN}; min-height: 600px; padding: 80px 40px; }
    h1 { font-family: Georgia, serif; font-size: 56px; font-weight: 700; color: rgb(255,255,255); line-height: 64px; }
    h2 { font-family: Georgia, serif; font-size: 32px; font-weight: 700; color: rgb(20,20,20); }
    p  { font-family: Georgia, serif; font-size: 16px; font-weight: 400; line-height: 24px; }
    .body-block { background: ${BRAND_CREAM}; min-height: 500px; padding: 60px 40px; }
    /* Planted defect: 2.6:1 on cream — fails AA. */
    .faint { color: rgb(170, 170, 170); font-size: 16px; }
    /* Planted defect: below the 12px legibility floor. */
    footer small { font-size: 9px; color: rgb(20,20,20); display: block; }
    footer { background: ${BRAND_CREAM}; padding: 40px; }
  </style>
</head>
<body>
  <header>
    <img src="/acme-logo.png" alt="Northwind Coffee logo" width="160" height="44">
  </header>
  <section class="hero">
    <h1>Roasted for people who notice</h1>
    <p style="color:rgb(255,255,255)">We roast on Tuesdays and ship on Wednesdays.</p>
  </section>
  <section class="body-block">
    <h2>Our sourcing</h2>
    <p>We pay farmers above the C-price on every lot, every year, without exception.</p>
    <p>Every bag is traceable to a single farm and a single harvest window.</p>
    <p class="faint">This sentence is deliberately too faint to read.</p>
    <a href="/about">About us</a>
    <a href="/products/beans">Beans</a>
    <a href="/legal/privacy">Privacy</a>
    <a href="https://evil.example/tracker">Partner</a>
    <a href="http://192.168.1.1/admin">Router</a>
  </section>
  <footer>
    <small>Northwind Coffee Co. Registered in England. All claims substantiated on request.</small>
  </footer>
</body>
</html>`;

// A 1x1 PNG, enough for the logo candidate to have real bytes behind it.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let server: Server;
let origin = '';
let browserAvailable = false;
const browser = new DiscoveryBrowser();

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/acme-logo.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_1X1);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    await browser.launch();
    browserAvailable = true;
  } catch {
    browserAvailable = false;
  }
}, 120_000);

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('harvest → extract → synthesize, against a real rendered page', () => {
  it('recovers the brand that was planted in the fixture', async () => {
    if (!browserAvailable) {
      // eslint-disable-next-line no-console
      console.warn('Chromium unavailable — skipping the end-to-end harvest test.');
      return;
    }

    const harvest = await browser.harvest(origin, 'desktop');

    /* ---------------------------------------------------------- page facts */
    expect(harvest.httpStatus).toBe(200);
    expect(harvest.title).toContain('Northwind Coffee');
    expect(harvest.siteName).toBe('Northwind Coffee');
    expect(harvest.lang).toBe('en');
    expect(harvest.screenshot.byteLength).toBeGreaterThan(1000);
    expect(harvest.bodyText).toContain('above the C-price');

    /* ------------------------------------------------------------- palette */
    const palette = extractPalette([{ url: origin, colors: harvest.colors }]);
    const hexes = palette.map((c) => c.hex);

    // The two planted brand colours must both survive extraction.
    expect(hexes).toContain('#005a3c');
    expect(hexes).toContain('#f5f0e6');

    // ...and the green must be recognised as chromatic, not as a background.
    expect(palette.find((c) => c.hex === '#005a3c')?.role).toBe('primary');

    // Lab must be populated — it is what ΔE conformance is measured in.
    const green = palette.find((c) => c.hex === '#005a3c');
    expect(green?.lab[0]).toBeGreaterThan(0);
    expect(green?.lab[1]).toBeLessThan(0); // negative a* = green

    /* ---------------------------------------------------------------- type */
    const styles = extractTypeStyles([{ url: origin, runs: harvest.textRuns }]);
    expect(styles.length).toBeGreaterThan(0);
    expect(styles.every((s) => s.fontFamily === 'Georgia')).toBe(true);

    const roles = new Set(styles.map((s) => s.role));
    expect(roles.has('display')).toBe(true); // the 56px h1
    expect(roles.has('body')).toBe(true);

    /* ---------------------------------------------------------------- logo */
    const logos = rankLogoCandidates(harvest.logoCandidates);
    expect(logos.length).toBeGreaterThan(0);
    expect(logos[0].src).toContain('acme-logo.png');
    expect(logos[0].confidence).toBeGreaterThan(0.5);

    /* ----------------------------------------------- the planted defects */
    const failures = findContrastFailures([{ url: origin, runs: harvest.textRuns }]);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((f) => f.text.includes('too faint'))).toBe(true);

    const smallest = Math.min(...styles.filter((s) => s.role !== 'display').map((s) => s.fontSizePx));
    expect(smallest).toBeLessThanOrEqual(10); // the 9px footer line was seen

    /* --------------------------------------------------------------- links */
    // Off-origin and private-network links must be present in the raw harvest
    // (the browser saw them) — it is the frontier's job to refuse them, and
    // frontier.spec.ts proves it does.
    expect(harvest.links.some((l) => l.includes('/about'))).toBe(true);
    expect(harvest.links.some((l) => l.includes('192.168.1.1'))).toBe(true);

    /* ------------------------------------------------------------ synthesis */
    const rules = synthesizeRules({
      colors: palette.map((c) => ({ ...c, pageCount: 4 })), // simulate corroboration
      typeStyles: styles,
      pageCount: 4,
      logoDetected: true,
      contrastFailures: failures.length,
    });

    const keys = rules.map((r) => r.key);
    expect(keys).toContain('color.palette-conformance');
    expect(keys).toContain('typography.approved-family');
    expect(keys).toContain('accessibility.contrast');

    // Every rule proposed, none active — the governance invariant, proven on
    // real browser output rather than on a fixture.
    expect(rules.every((r) => r.status === 'proposed')).toBe(true);

    const family = rules.find((r) => r.key === 'typography.approved-family');
    expect(family?.check.params.families).toEqual(['Georgia']);

    // The 9px footer disclaimer must be SEEN (it gets its own floor) and must
    // NOT become the standard (the floor is clamped to 12px).
    const legalRule = rules.find((r) => r.key === 'typography.min-size-legal');
    expect(legalRule, 'the 9px footer line should produce a legal min-size rule').toBeTruthy();
    expect(legalRule?.check.params.minPx).toBe(12);
    expect(legalRule?.support?.note).toContain('currently violates');

    // Body copy keeps its own, higher floor rather than inheriting the
    // disclaimer's size.
    expect(rules.find((r) => r.key === 'typography.min-size')?.check.params.minPx).toBeGreaterThanOrEqual(12);
  }, 120_000);

  it('renders the same page at mobile width', async () => {
    if (!browserAvailable) return;

    const mobile = await browser.harvest(origin, 'mobile');
    expect(mobile.screenshotWidth).toBe(390);
    expect(mobile.textRuns.length).toBeGreaterThan(0);
  }, 120_000);
});
