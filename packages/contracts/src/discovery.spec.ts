import { describe, expect, it } from 'vitest';
import { DiscoveryOptions, checkDiscoveryUrl } from './discovery';

/**
 * These are security tests, not validation tests.
 *
 * Discovery takes a URL from an authenticated user and fetches it from a
 * server inside a private network. Every case below is a real SSRF technique;
 * a regression here does not produce a bad report, it produces credential
 * disclosure or an internal port scan. Treat a failure as a release blocker.
 */

const blocked = (url: string) => {
  const r = checkDiscoveryUrl(url);
  return { ok: r.ok, reason: r.reason };
};

describe('checkDiscoveryUrl — accepts real public sites', () => {
  it('accepts an ordinary https URL', () => {
    const r = checkDiscoveryUrl('https://www.example.com/products');
    expect(r.ok).toBe(true);
    expect(r.origin).toBe('https://www.example.com');
    expect(r.url).toBe('https://www.example.com/products');
  });

  it('accepts a bare hostname the way an address bar does', () => {
    const r = checkDiscoveryUrl('example.com');
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://example.com/');
  });

  it('trims surrounding whitespace', () => {
    expect(checkDiscoveryUrl('  https://example.com  ').ok).toBe(true);
  });

  it('keeps the query string but drops the fragment', () => {
    const r = checkDiscoveryUrl('https://example.com/p?a=1#section');
    expect(r.url).toBe('https://example.com/p?a=1');
  });

  it('allows plain http, since plenty of small brand sites still are', () => {
    expect(checkDiscoveryUrl('http://example.com').ok).toBe(true);
  });

  it('allows a public IP address', () => {
    expect(checkDiscoveryUrl('http://93.184.216.34/').ok).toBe(true);
  });
});

describe('checkDiscoveryUrl — blocks loopback and localhost', () => {
  it.each([
    'http://localhost:3000',
    'http://localhost',
    'http://127.0.0.1:4000/v1/assets',
    'http://127.1.2.3/',
    'http://[::1]:8000/',
    'http://app.localhost/',
  ])('blocks %s', (url) => {
    expect(blocked(url).ok).toBe(false);
  });

  it("blocks BrandLens's own API, the most tempting internal target", () => {
    expect(checkDiscoveryUrl('http://localhost:4000/v1/brands').ok).toBe(false);
  });
});

describe('checkDiscoveryUrl — blocks cloud instance metadata', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata/computeMetadata/v1/',
    'http://instance-data/latest/meta-data/',
    'http://169.254.170.2/v2/credentials/',
  ])('blocks %s', (url) => {
    expect(blocked(url).ok).toBe(false);
  });
});

describe('checkDiscoveryUrl — blocks private ranges', () => {
  it.each([
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://192.168.1.1/',
    'http://100.64.0.1/', // CGNAT
    'http://0.0.0.0/',
    'http://[fe80::1]/', // link-local
    'http://[fc00::1]/', // unique local
    'http://[fd12:3456::1]/',
  ])('blocks %s', (url) => {
    expect(blocked(url).ok).toBe(false);
  });

  it('allows 172.32.x, which is public despite neighbouring the private block', () => {
    expect(checkDiscoveryUrl('http://172.32.0.1/').ok).toBe(true);
  });

  it('allows 11.x, which is public despite neighbouring 10.x', () => {
    expect(checkDiscoveryUrl('http://11.0.0.1/').ok).toBe(true);
  });
});

describe('checkDiscoveryUrl — blocks obfuscated loopback', () => {
  it('blocks an IPv4-mapped IPv6 loopback', () => {
    // new URL() rewrites this to [::ffff:7f00:1], so a rule written against
    // the dotted spelling silently never fires. Both forms must be blocked.
    expect(blocked('http://[::ffff:127.0.0.1]/').ok).toBe(false);
    expect(blocked('http://[::ffff:7f00:1]/').ok).toBe(false);
  });

  it('blocks IPv4-mapped private ranges, not just loopback', () => {
    expect(blocked('http://[::ffff:10.0.0.1]/').ok).toBe(false);
    expect(blocked('http://[::ffff:169.254.169.254]/').ok).toBe(false);
  });

  it('blocks NAT64 and 6to4 wrappers around a private address', () => {
    expect(blocked('http://[64:ff9b::127.0.0.1]/').ok).toBe(false);
    expect(blocked('http://[2002:7f00:1::]/').ok).toBe(false);
  });

  it('blocks the whole fe80::/10 link-local range, not only literal fe80', () => {
    expect(blocked('http://[fea0::1]/').ok).toBe(false);
    expect(blocked('http://[febf::1]/').ok).toBe(false);
  });

  it('blocks the whole fc00::/7 unique-local range', () => {
    expect(blocked('http://[fdff::1]/').ok).toBe(false);
  });

  it('still allows a genuinely public IPv6 address', () => {
    expect(checkDiscoveryUrl('http://[2606:2800:220:1:248:1893:25c8:1946]/').ok).toBe(true);
  });

  it('blocks octal-padded loopback rather than reading it as a public host', () => {
    // 0177.0.0.1 IS 127.0.0.1 to a resolver. Rejecting non-decimal octets
    // means this never reaches the fetch, whichever way libc parses it.
    expect(blocked('http://0177.0.0.1/').ok).toBe(false);
  });

  it('blocks hex-form loopback', () => {
    expect(blocked('http://0x7f.0.0.1/').ok).toBe(false);
  });
});

describe('checkDiscoveryUrl — blocks internal-only name shapes', () => {
  it.each([
    'http://wiki/', // search-domain lookup, no dot
    'http://printer.local/',
    'http://vault.internal/',
    'http://jenkins.intranet/',
    'http://nas.lan/',
    'http://router.home.arpa/',
  ])('blocks %s', (url) => {
    expect(blocked(url).ok).toBe(false);
  });
});

describe('checkDiscoveryUrl — blocks non-http schemes and injection', () => {
  it.each([
    'file:///C:/brandlens/.env',
    'file:///etc/passwd',
    'gopher://evil.example:6379/_SET%20foo%20bar',
    'ftp://example.com/',
    'javascript:alert(1)',
    'data:text/html,<script>',
    'redis://localhost:6379',
  ])('blocks %s', (url) => {
    expect(blocked(url).ok).toBe(false);
  });

  it('blocks embedded credentials', () => {
    // http://expected.com@evil.example/ fetches evil.example. The userinfo
    // section is a display trick, not an authority.
    expect(blocked('http://example.com@evil.example/').ok).toBe(false);
  });

  it('blocks control characters used for request smuggling', () => {
    expect(blocked('http://example.com/\r\nX-Injected: 1').ok).toBe(false);
    expect(blocked('http://example.com/\u0000').ok).toBe(false);
  });

  it('rejects empty and absurd input without throwing', () => {
    expect(blocked('').ok).toBe(false);
    expect(blocked('   ').ok).toBe(false);
    expect(blocked('not a url at all').ok).toBe(false);
    expect(blocked(`https://example.com/${'a'.repeat(3000)}`).ok).toBe(false);
  });
});

describe('checkDiscoveryUrl — never returns a URL it rejected', () => {
  it('nulls the url and origin on every rejection', () => {
    for (const bad of ['http://localhost/', 'file:///etc/passwd', 'http://10.0.0.1/', '']) {
      const r = checkDiscoveryUrl(bad);
      expect(r.ok).toBe(false);
      expect(r.url).toBeNull();
      expect(r.origin).toBeNull();
      expect(r.reason).toBeTruthy();
    }
  });
});

describe('DiscoveryOptions', () => {
  it('has demo-safe defaults', () => {
    const o = DiscoveryOptions.parse({});
    expect(o.maxPages).toBe(8);
    expect(o.maxDepth).toBe(2);
    expect(o.respectRobots).toBe(true);
    expect(o.runSelfCheck).toBe(true);
    expect(o.viewports).toEqual(['desktop', 'mobile']);
  });

  it('refuses a crawl budget beyond the hard ceiling', () => {
    expect(DiscoveryOptions.safeParse({ maxPages: 500 }).success).toBe(false);
    expect(DiscoveryOptions.safeParse({ maxDepth: 12 }).success).toBe(false);
  });

  it('refuses a crawl with no pages at all', () => {
    expect(DiscoveryOptions.safeParse({ maxPages: 0 }).success).toBe(false);
  });
});
