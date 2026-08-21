import { describe, expect, it } from 'vitest';
import { crawlDelayMsFor, isAllowed, matchesPath, parseRobotsTxt } from './robots';

const UA = 'brandlens-discovery';

describe('parseRobotsTxt', () => {
  it('collects sitemaps regardless of which group they sit near', () => {
    const r = parseRobotsTxt(`
      Sitemap: https://acme.com/sitemap.xml
      User-agent: *
      Disallow: /admin
      Sitemap: https://acme.com/news-sitemap.xml
    `);
    expect(r.sitemaps).toEqual(['https://acme.com/sitemap.xml', 'https://acme.com/news-sitemap.xml']);
  });

  it('groups consecutive user-agent lines together', () => {
    const r = parseRobotsTxt(`
      User-agent: googlebot
      User-agent: bingbot
      Disallow: /search
    `);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].agents).toEqual(['googlebot', 'bingbot']);
  });

  it('starts a new group when a user-agent follows a rule', () => {
    const r = parseRobotsTxt(`
      User-agent: *
      Disallow: /a
      User-agent: googlebot
      Disallow: /b
    `);
    expect(r.groups).toHaveLength(2);
  });

  it('ignores comments and blank lines', () => {
    const r = parseRobotsTxt(`
      # nothing to see
      User-agent: *   # inline comment
      Disallow: /admin  # another
    `);
    expect(r.groups[0].rules).toEqual([{ allow: false, path: '/admin' }]);
  });

  it('treats an empty Disallow as "allow everything", not "block everything"', () => {
    // Disallow: with no value is the documented way to say "no restrictions".
    // Storing it as a zero-length pattern would match every path and silently
    // block the entire crawl.
    const r = parseRobotsTxt('User-agent: *\nDisallow:');
    expect(r.groups[0].rules).toEqual([]);
    expect(isAllowed(r, UA, 'https://acme.com/anything')).toBe(true);
  });

  it('reads crawl-delay in seconds and caps it', () => {
    expect(crawlDelayMsFor(parseRobotsTxt('User-agent: *\nCrawl-delay: 2'), UA)).toBe(2000);
    expect(crawlDelayMsFor(parseRobotsTxt('User-agent: *\nCrawl-delay: 9999'), UA)).toBe(30_000);
    expect(crawlDelayMsFor(parseRobotsTxt('User-agent: *\nCrawl-delay: nonsense'), UA)).toBeNull();
  });
});

describe('matchesPath', () => {
  it('matches by prefix', () => {
    expect(matchesPath('/admin', '/admin/users')).toBe(true);
    expect(matchesPath('/admin', '/public')).toBe(false);
  });

  it('supports the * wildcard', () => {
    expect(matchesPath('/*/private', '/a/private')).toBe(true);
    expect(matchesPath('/p/*/x', '/p/anything/x')).toBe(true);
  });

  it('supports the $ end anchor', () => {
    expect(matchesPath('/page$', '/page')).toBe(true);
    expect(matchesPath('/page$', '/page/sub')).toBe(false);
  });

  it('treats regex metacharacters in the pattern as literals', () => {
    // A pattern is attacker-controlled text from someone else's server. If it
    // reached RegExp unescaped, "/(a+)+$" would be a catastrophic-backtracking
    // denial of service against our own worker.
    expect(matchesPath('/a.b', '/axb')).toBe(false);
    expect(matchesPath('/a.b', '/a.b')).toBe(true);
    expect(matchesPath('/(a+)+', '/(a+)+')).toBe(true);
  });

  it('never matches on an empty pattern', () => {
    expect(matchesPath('', '/anything')).toBe(false);
  });
});

describe('isAllowed', () => {
  it('allows everything when robots.txt is absent or empty', () => {
    expect(isAllowed(parseRobotsTxt(''), UA, 'https://acme.com/x')).toBe(true);
  });

  it('applies the wildcard group', () => {
    const r = parseRobotsTxt('User-agent: *\nDisallow: /admin');
    expect(isAllowed(r, UA, 'https://acme.com/admin/users')).toBe(false);
    expect(isAllowed(r, UA, 'https://acme.com/about')).toBe(true);
  });

  it('lets the longest match win', () => {
    const r = parseRobotsTxt('User-agent: *\nDisallow: /a\nAllow: /a/b');
    expect(isAllowed(r, UA, 'https://acme.com/a/x')).toBe(false);
    expect(isAllowed(r, UA, 'https://acme.com/a/b/c')).toBe(true);
  });

  it('breaks an equal-length tie in favour of Allow', () => {
    const r = parseRobotsTxt('User-agent: *\nDisallow: /x\nAllow: /x');
    expect(isAllowed(r, UA, 'https://acme.com/x')).toBe(true);
  });

  it('uses only the most specific matching group, never the union', () => {
    // The specific group must fully replace the wildcard group. Merging them
    // would keep the site-wide block and throw away the carve-out that was
    // written for us.
    const r = parseRobotsTxt(`
      User-agent: *
      Disallow: /

      User-agent: brandlens-discovery
      Allow: /
      Disallow: /admin
    `);
    expect(isAllowed(r, UA, 'https://acme.com/about')).toBe(true);
    expect(isAllowed(r, UA, 'https://acme.com/admin')).toBe(false);
    expect(isAllowed(r, 'SomeOtherBot', 'https://acme.com/about')).toBe(false);
  });

  it('matches the path with its query string, as the standard requires', () => {
    const r = parseRobotsTxt('User-agent: *\nDisallow: /*?sessionid=');
    expect(isAllowed(r, UA, 'https://acme.com/p?sessionid=7')).toBe(false);
    expect(isAllowed(r, UA, 'https://acme.com/p?id=7')).toBe(true);
  });

  it('refuses a malformed URL rather than defaulting to allowed', () => {
    expect(isAllowed(parseRobotsTxt('User-agent: *\nDisallow: /x'), UA, 'not-a-url')).toBe(false);
  });
});
