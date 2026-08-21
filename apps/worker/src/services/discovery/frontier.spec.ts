import { describe, expect, it } from 'vitest';
import { CrawlFrontier, classifyRole, isInScope, normalizeUrl } from './frontier';

const ORIGIN = 'https://acme.com';

describe('normalizeUrl', () => {
  it('resolves a relative href against the page it was found on', () => {
    expect(normalizeUrl('/about', 'https://acme.com/products/x')).toBe('https://acme.com/about');
    expect(normalizeUrl('../pricing', 'https://acme.com/a/b/c')).toBe('https://acme.com/a/pricing');
  });

  it('drops the fragment, which never identifies a distinct page', () => {
    expect(normalizeUrl('https://acme.com/about#team')).toBe('https://acme.com/about');
  });

  it('strips campaign parameters so one page is not crawled ten times', () => {
    expect(normalizeUrl('https://acme.com/?utm_source=x&utm_medium=y&gclid=z')).toBe('https://acme.com/');
    expect(normalizeUrl('https://acme.com/p?fbclid=abc&id=7')).toBe('https://acme.com/p?id=7');
  });

  it('keeps parameters that do identify a page', () => {
    expect(normalizeUrl('https://acme.com/p?sku=123')).toBe('https://acme.com/p?sku=123');
  });

  it('orders parameters so two spellings collapse to one URL', () => {
    expect(normalizeUrl('https://acme.com/p?b=2&a=1')).toBe(normalizeUrl('https://acme.com/p?a=1&b=2'));
  });

  it('collapses the trailing slash but keeps the root slash', () => {
    expect(normalizeUrl('https://acme.com/about/')).toBe('https://acme.com/about');
    expect(normalizeUrl('https://acme.com/')).toBe('https://acme.com/');
  });

  it('collapses an explicit index.html onto its directory', () => {
    expect(normalizeUrl('https://acme.com/about/index.html')).toBe('https://acme.com/about');
    expect(normalizeUrl('https://acme.com/index.html')).toBe('https://acme.com/');
  });

  it('drops a default port', () => {
    expect(normalizeUrl('https://acme.com:443/about')).toBe('https://acme.com/about');
    expect(normalizeUrl('http://acme.com:80/about')).toBe('http://acme.com/about');
  });

  it('rejects non-http schemes found in href attributes', () => {
    expect(normalizeUrl('mailto:hi@acme.com')).toBeNull();
    expect(normalizeUrl('tel:+441234567890')).toBeNull();
    expect(normalizeUrl('javascript:void(0)')).toBeNull();
    expect(normalizeUrl('#top', 'https://acme.com/')).toBe('https://acme.com/');
  });
});

describe('classifyRole', () => {
  it.each([
    ['https://acme.com/', 'home'],
    ['https://acme.com/about-us', 'about'],
    ['https://acme.com/our-story', 'about'],
    ['https://acme.com/pricing', 'pricing'],
    ['https://acme.com/careers/engineering', 'careers'],
    ['https://acme.com/legal/privacy', 'legal'],
    ['https://acme.com/terms', 'legal'],
    ['https://acme.com/contact', 'contact'],
    ['https://acme.com/blog/a-post', 'blog'],
    ['https://acme.com/products/widget', 'product'],
    ['https://acme.com/solutions', 'product'],
    ['https://acme.com/xyzzy', 'other'],
  ])('classifies %s as %s', (url, role) => {
    expect(classifyRole(url)).toBe(role);
  });
});

describe('isInScope', () => {
  it('keeps the crawl on one host by default', () => {
    expect(isInScope('https://acme.com/a', ORIGIN, false)).toBe(true);
    expect(isInScope('https://blog.acme.com/a', ORIGIN, false)).toBe(false);
    expect(isInScope('https://evil.example/a', ORIGIN, false)).toBe(false);
  });

  it('admits subdomains only when asked', () => {
    expect(isInScope('https://blog.acme.com/a', ORIGIN, true)).toBe(true);
    expect(isInScope('https://evil.example/a', ORIGIN, true)).toBe(false);
  });

  it('is not fooled by a hostname that merely ends with the brand', () => {
    expect(isInScope('https://notacme.com/a', ORIGIN, true)).toBe(false);
    expect(isInScope('https://acme.com.evil.example/a', ORIGIN, true)).toBe(false);
  });
});

describe('CrawlFrontier', () => {
  const make = (over: Partial<ConstructorParameters<typeof CrawlFrontier>[0]> = {}) =>
    new CrawlFrontier({ originUrl: ORIGIN, maxPages: 8, maxDepth: 2, includeSubdomains: false, ...over });

  it('deduplicates URLs that normalise to the same page', () => {
    const f = make();
    expect(f.add('https://acme.com/about', 1)).toBe(true);
    expect(f.add('https://acme.com/about/', 1)).toBe(false);
    expect(f.add('https://acme.com/about#team', 1)).toBe(false);
    expect(f.add('https://acme.com/about?utm_source=x', 1)).toBe(false);
    expect(f.discovered).toBe(1);
  });

  it('refuses to leave the origin', () => {
    const f = make();
    expect(f.add('https://evil.example/', 1)).toBe(false);
    expect(f.add('https://blog.acme.com/', 1)).toBe(false);
  });

  it('refuses links that point at a private address', () => {
    // A public page linking to an internal host is the SSRF path that a
    // seed-only check would miss entirely.
    const f = make();
    expect(f.add('http://192.168.1.1/admin', 1)).toBe(false);
    expect(f.add('http://localhost:4000/v1/brands', 1)).toBe(false);
    expect(f.add('http://169.254.169.254/latest/meta-data/', 1)).toBe(false);
  });

  it('skips assets that are not pages', () => {
    const f = make();
    expect(f.add('https://acme.com/brochure.pdf', 1)).toBe(false);
    expect(f.add('https://acme.com/hero.jpg', 1)).toBe(false);
    expect(f.add('https://acme.com/app.js', 1)).toBe(false);
  });

  it('honours the depth ceiling', () => {
    const f = make({ maxDepth: 1 });
    expect(f.add('https://acme.com/a', 1)).toBe(true);
    expect(f.add('https://acme.com/b', 2)).toBe(false);
  });

  it('honours a robots predicate', () => {
    const f = make({ isAllowed: (url) => !url.includes('/private') });
    expect(f.add('https://acme.com/public', 1)).toBe(true);
    expect(f.add('https://acme.com/private', 1)).toBe(false);
  });

  it('stops handing out pages once the budget is spent', () => {
    const f = make({ maxPages: 3 });
    for (let i = 0; i < 10; i += 1) f.add(`https://acme.com/p${i}`, 1);
    expect([f.next(), f.next(), f.next()].every(Boolean)).toBe(true);
    expect(f.next()).toBeNull();
  });

  it('spreads the budget across roles instead of draining one', () => {
    // Six product pages and one each of about/legal, with room for four.
    // Breadth-first order would return four product pages and induce rules
    // from a corpus with no variance in it.
    const f = make({ maxPages: 4 });
    for (let i = 0; i < 6; i += 1) f.add(`https://acme.com/products/p${i}`, 1);
    f.add('https://acme.com/about', 1);
    f.add('https://acme.com/legal/privacy', 1);

    const roles = [f.next(), f.next(), f.next(), f.next()].map((e) => e?.role);

    // Only three roles exist here, so the fourth pick must repeat one. What
    // matters is that every role got a slot BEFORE any role got a second.
    expect(new Set(roles).size).toBe(3);
    expect(roles).toContain('about');
    expect(roles).toContain('legal');
    expect(roles.filter((r) => r === 'product')).toHaveLength(2);
    expect(new Set(roles.slice(0, 3)).size).toBe(3);
  });

  it('drains the remaining roles only after every role has one page', () => {
    const f = make({ maxPages: 6 });
    for (let i = 0; i < 5; i += 1) f.add(`https://acme.com/products/p${i}`, 1);
    f.add('https://acme.com/about', 1);

    const roles = Array.from({ length: 6 }, () => f.next()?.role);
    expect(roles.slice(0, 2).sort()).toEqual(['about', 'product']);
    expect(roles.slice(2)).toEqual(['product', 'product', 'product', 'product']);
  });

  it('takes the seed page first', () => {
    const f = make();
    f.add('https://acme.com/products/x', 1);
    f.add('https://acme.com/', 0);
    expect(f.next()?.role).toBe('home');
  });

  it('prefers shallower pages within a role', () => {
    const f = make();
    f.add('https://acme.com/blog/2026/01/deep-post', 2);
    f.add('https://acme.com/blog', 1);
    expect(f.next()?.url).toBe('https://acme.com/blog');
  });

  it('reports what it never got to, so the report can admit its gaps', () => {
    const f = make({ maxPages: 1 });
    f.add('https://acme.com/', 0);
    f.add('https://acme.com/about', 1);
    f.next();
    expect(f.skipped().map((e) => e.url)).toEqual(['https://acme.com/about']);
  });
});
