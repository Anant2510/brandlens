import { describe, expect, it, vi } from 'vitest';
import {
  BrandfetchProvider,
  LogoDevProvider,
  buildProviders,
  domainOf,
  enrichBrand,
  mapBrandfetch,
} from './brand-enrichment';

/*
 * A faithful slice of a Brandfetch Brand API response, shaped from the schema
 * and the Stripe example in their docs: colors[{hex,type,brightness}],
 * fonts[{name,type}], logos[{type,theme,formats[{src,format}]}], links, and
 * company.industries.
 */
const BRANDFETCH_STRIPE = {
  name: 'Stripe',
  domain: 'stripe.com',
  description: 'Online payment processing for internet businesses.',
  qualityScore: 0.76,
  colors: [
    { hex: '#635BFF', type: 'primary', brightness: 0.5 },
    { hex: '#0A2540', type: 'dark', brightness: 0.1 },
  ],
  fonts: [
    { name: 'Camphor', type: 'title', origin: 'custom' },
    { name: 'Söhne', type: 'body', origin: 'custom' },
  ],
  logos: [
    {
      type: 'logo',
      theme: 'light',
      formats: [{ src: 'https://asset.brandfetch.io/stripe/logo.svg', format: 'svg', width: null, height: null }],
    },
    {
      type: 'icon',
      theme: 'dark',
      formats: [{ src: 'https://asset.brandfetch.io/stripe/icon.png', format: 'png', width: 512, height: 512 }],
    },
  ],
  links: [{ name: 'twitter', url: 'https://twitter.com/stripe' }],
  company: { industries: [{ name: 'Financial Software' }] },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('domainOf', () => {
  it('reduces a URL or bare host to the registrable host', () => {
    expect(domainOf('https://www.academy.com/shop?x=1')).toBe('academy.com');
    expect(domainOf('academy.com')).toBe('academy.com');
    expect(domainOf('WWW.Stripe.com')).toBe('stripe.com');
    expect(domainOf('not a url')).toBeNull();
  });
});

describe('mapBrandfetch', () => {
  const e = mapBrandfetch(BRANDFETCH_STRIPE, 'stripe.com');

  it('pulls the brand colours with roles, lower-cased', () => {
    expect(e.colors.map((c) => c.hex)).toEqual(['#635bff', '#0a2540']);
    expect(e.colors[0]).toMatchObject({ role: 'primary' });
    expect(e.colors[1]).toMatchObject({ role: 'text' }); // 'dark' → text ink
  });

  it('pulls the fonts and maps the provider category to a role', () => {
    expect(e.fonts).toEqual([
      { name: 'Camphor', role: 'display' },
      { name: 'Söhne', role: 'body' },
    ]);
  });

  it('flattens every logo format into a candidate, keeping theme and vector-ness', () => {
    expect(e.logos).toHaveLength(2);
    expect(e.logos[0]).toMatchObject({ format: 'svg', theme: 'light', isVector: true, kind: 'logo' });
    expect(e.logos[1]).toMatchObject({ format: 'png', theme: 'dark', isVector: false, kind: 'icon' });
  });

  it('carries name, description, social links, industry and quality score', () => {
    expect(e.name).toBe('Stripe');
    expect(e.description).toContain('payment processing');
    expect(e.links).toEqual([{ name: 'twitter', url: 'https://twitter.com/stripe' }]);
    expect(e.industries).toEqual(['Financial Software']);
    expect(e.qualityScore).toBe(0.76);
  });

  it('does not choke on the empty arrays a sparse record returns', () => {
    const empty = mapBrandfetch({ name: 'X', domain: 'x.com' }, 'x.com');
    expect(empty.colors).toEqual([]);
    expect(empty.logos).toEqual([]);
  });
});

describe('BrandfetchProvider', () => {
  it('authenticates with a bearer key and returns the mapped record', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.brandfetch.io/v2/brands/stripe.com');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test-key');
      return jsonResponse(BRANDFETCH_STRIPE);
    }) as unknown as typeof fetch;

    const e = await new BrandfetchProvider('test-key', fetchImpl).enrich('https://stripe.com/');
    expect(e?.name).toBe('Stripe');
    expect(e?.colors[0].hex).toBe('#635bff');
  });

  it('returns null (not an error) when the brand is unknown, the key is bad, or the quota is spent', async () => {
    for (const status of [404, 401, 403, 429, 500]) {
      const fetchImpl = vi.fn(async () => jsonResponse({}, status)) as unknown as typeof fetch;
      const e = await new BrandfetchProvider('k', fetchImpl).enrich('acme.com');
      expect({ status, e }).toMatchObject({ e: null });
    }
  });

  it('returns null when the request itself throws, so enrichment never breaks a run', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await new BrandfetchProvider('k', fetchImpl).enrich('acme.com')).toBeNull();
  });
});

describe('LogoDevProvider', () => {
  it('produces a logo URL by domain without a network call', async () => {
    const e = await new LogoDevProvider('pk_test').enrich('https://acme.com/');
    expect(e?.logos[0].src).toBe('https://img.logo.dev/acme.com?token=pk_test&format=png&size=256');
    expect(e?.colors).toEqual([]);
  });
});

describe('buildProviders', () => {
  it('includes only the providers a key is set for, Brandfetch first', () => {
    expect(buildProviders({}).length).toBe(0);
    expect(buildProviders({ brandfetchApiKey: 'k' }).map((p) => p.name)).toEqual(['brandfetch']);
    expect(buildProviders({ brandfetchApiKey: 'k', logoDevToken: 't' }).map((p) => p.name)).toEqual([
      'brandfetch',
      'logodev',
    ]);
  });
});

describe('enrichBrand', () => {
  it('lets a later provider fill only the gaps the first left', async () => {
    const rich = new BrandfetchProvider('k', (async () => jsonResponse(BRANDFETCH_STRIPE)) as unknown as typeof fetch);
    const logo = new LogoDevProvider('t');
    const merged = await enrichBrand('stripe.com', [rich, logo]);
    // Brandfetch supplied logos, so logo.dev's URL must NOT displace them.
    expect(merged?.logos.every((l) => l.src.includes('brandfetch.io'))).toBe(true);
    expect(merged?.provider).toBe('brandfetch+logodev');
  });

  it('falls back to the logo-only provider when the rich one has no record', async () => {
    const rich = new BrandfetchProvider('k', (async () => jsonResponse({}, 404)) as unknown as typeof fetch);
    const logo = new LogoDevProvider('t');
    const merged = await enrichBrand('spa-only.com', [rich, logo]);
    expect(merged?.provider).toBe('logodev');
    expect(merged?.logos[0].src).toContain('img.logo.dev');
  });

  it('returns null when nothing is configured or nothing has a record', async () => {
    expect(await enrichBrand('x.com', [])).toBeNull();
  });
});
