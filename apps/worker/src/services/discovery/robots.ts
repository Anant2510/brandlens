/**
 * robots.txt parsing and matching.
 *
 * BrandLens points a headless browser at servers that belong to somebody
 * else. Honouring robots.txt is not a legal position, it is the difference
 * between a tool a brand team can run against a competitor's site and one
 * that gets the company's IP range blocked. The parser is deliberately strict
 * about the ambiguous cases rather than permissive.
 */

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelayMs: number | null;
}

export interface RobotsTxt {
  groups: RobotsGroup[];
  sitemaps: string[];
}

/** An empty ruleset — used when robots.txt is missing, which means "allowed". */
export const EMPTY_ROBOTS: RobotsTxt = { groups: [], sitemaps: [] };

export function parseRobotsTxt(text: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let current: RobotsGroup | null = null;
  // Consecutive User-agent lines share one group; a rule line closes the
  // agent list, so the next User-agent starts a new group.
  let acceptingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;

    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!current || !acceptingAgents) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
        acceptingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }

    if (!current) continue;
    acceptingAgents = false;

    if (field === 'allow' || field === 'disallow') {
      // "Disallow:" with an empty value means "allow everything" and must not
      // be stored as a zero-length disallow, which would match every path.
      if (field === 'disallow' && value === '') continue;
      current.rules.push({ allow: field === 'allow', path: value });
      continue;
    }

    if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        current.crawlDelayMs = Math.min(seconds * 1000, 30_000);
      }
    }
  }

  return { groups, sitemaps };
}

/**
 * Picks the group that applies to us.
 *
 * The standard says the most specific matching user-agent wins and that only
 * ONE group applies — not the union of the specific group and `*`. Merging
 * them is the classic mistake: a site that blocks everyone with `*` but
 * carves out an exception for a named bot would otherwise still be blocked.
 */
export function groupFor(robots: RobotsTxt, userAgent: string): RobotsGroup | null {
  const ua = userAgent.toLowerCase();
  let best: { group: RobotsGroup; score: number } | null = null;

  for (const group of robots.groups) {
    for (const agent of group.agents) {
      let score = -1;
      if (agent === '*') score = 0;
      else if (ua.includes(agent)) score = agent.length; // longer token = more specific
      if (score > (best?.score ?? -1)) best = { group, score };
    }
  }

  return best?.group ?? null;
}

/**
 * Matches a robots path pattern against a URL path.
 *
 * Supports the two wildcards every major crawler implements: `*` for any run
 * of characters and `$` anchoring the end. Built by escaping the literal
 * parts rather than by string manipulation, because a pattern from a stranger's
 * server reaching a RegExp unescaped is a denial-of-service waiting to happen.
 */
export function matchesPath(pattern: string, path: string): boolean {
  if (pattern === '') return false;

  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const source = body
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  const re = new RegExp(`^${source}${anchored ? '$' : ''}`);
  return re.test(path);
}

/**
 * Is this path fetchable?
 *
 * Longest match wins; on an equal-length tie, Allow beats Disallow. That tie
 * rule is what lets `Disallow: /admin` plus `Allow: /admin` mean "allowed",
 * and it is the behaviour Google documents.
 */
export function isAllowed(robots: RobotsTxt, userAgent: string, url: string): boolean {
  const group = groupFor(robots, userAgent);
  if (!group || group.rules.length === 0) return true;

  let path: string;
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    return false;
  }

  let verdict = true;
  let bestLength = -1;

  for (const rule of group.rules) {
    if (!matchesPath(rule.path, path)) continue;
    const length = rule.path.replace(/\$$/, '').length;
    if (length > bestLength || (length === bestLength && rule.allow)) {
      bestLength = length;
      verdict = rule.allow;
    }
  }

  return verdict;
}

export function crawlDelayMsFor(robots: RobotsTxt, userAgent: string): number | null {
  return groupFor(robots, userAgent)?.crawlDelayMs ?? null;
}
