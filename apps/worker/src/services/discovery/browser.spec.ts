import { describe, expect, it } from 'vitest';
import { diagnoseHarvestFailure, isHttp2ProtocolError, isLikelyLogo } from './browser';

describe('isHttp2ProtocolError', () => {
  /*
   * This predicate decides whether a failed navigation is retried over
   * HTTP/1.1, so its job is as much about what it REFUSES as what it matches.
   *
   * A reset h2 stream means the host is reachable and willing and only the
   * protocol failed — a TLS-inspecting proxy mangling the framing, typically.
   * Retrying that is a compatibility measure. Retrying anything else would be
   * ignoring an answer we were given: a 403 is a decision, a timeout is a
   * capacity signal, a bad certificate is a warning. None of them get a second
   * attempt through a different protocol.
   */
  it('matches a reset HTTP/2 stream, under either of Chromium names for it', () => {
    expect(isHttp2ProtocolError(new Error('page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://www.example.com/'))).toBe(
      true,
    );
    expect(isHttp2ProtocolError(new Error('net::ERR_SPDY_PROTOCOL_ERROR at https://www.example.com/'))).toBe(true);
  });

  it('matches a bare string, since not every thrown value is an Error', () => {
    expect(isHttp2ProtocolError('ERR_HTTP2_PROTOCOL_ERROR')).toBe(true);
  });

  it('refuses every other navigation failure', () => {
    for (const message of [
      'page.goto: net::ERR_CONNECTION_REFUSED',
      'Timeout 30000ms exceeded',
      'net::ERR_CERT_AUTHORITY_INVALID',
      'net::ERR_TUNNEL_CONNECTION_FAILED',
      'net::ERR_NAME_NOT_RESOLVED',
      'net::ERR_TOO_MANY_REDIRECTS',
      'Navigation failed because page was closed',
    ]) {
      expect({ message, retried: isHttp2ProtocolError(new Error(message)) }).toMatchObject({ retried: false });
    }
  });

  it('refuses null and undefined rather than throwing', () => {
    expect(isHttp2ProtocolError(null)).toBe(false);
    expect(isHttp2ProtocolError(undefined)).toBe(false);
  });
});

describe('isLikelyLogo', () => {
  const image = (over: Partial<Parameters<typeof isLikelyLogo>[0]>) =>
    ({
      src: 'https://example.com/a.png',
      alt: null,
      selector: 'img',
      width: 160,
      height: 40,
      region: 'header',
      ...over,
    }) as Parameters<typeof isLikelyLogo>[0];

  it('takes the markup at its word when it says logo', () => {
    expect(isLikelyLogo(image({ src: 'https://example.com/brand-logo.svg', region: 'footer' }))).toBe(true);
    expect(isLikelyLogo(image({ alt: 'Northwind wordmark', region: 'main' }))).toBe(true);
  });

  it('accepts a modest header image on shape alone', () => {
    expect(isLikelyLogo(image({}))).toBe(true);
  });

  it('rejects a full-width hero banner sitting in the header', () => {
    // The case that makes "first img in the header" wrong: a promo strip above
    // the masthead is in the header, and is not the logo.
    expect(isLikelyLogo(image({ width: 1440, height: 90 }))).toBe(false);
  });

  it('rejects an image outside the header with nothing to recommend it', () => {
    expect(isLikelyLogo(image({ region: 'main' }))).toBe(false);
  });
});

describe('diagnoseHarvestFailure', () => {
  const reached = async () => ({ reached: true, status: 200 });
  const reached403 = async () => ({ reached: true, status: 403 });
  const unreached = async () => ({ reached: false, error: 'fetch failed' });

  it('calls it bot mitigation when a browser is reset but a plain request gets through', async () => {
    /*
     * The academy.com case exactly: three different Chromium errors across
     * three attempts — a reset, a protocol error, a timeout — while curl and a
     * bare fetch both get 200. A site that answers everything except a real
     * browser is not down and is not slow; it is refusing the crawler.
     */
    for (const detail of [
      'page.goto: net::ERR_CONNECTION_RESET at https://www.academy.com/',
      'page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://www.academy.com/',
      'page.goto: Timeout 30000ms exceeded.',
    ]) {
      const d = await diagnoseHarvestFailure('https://www.academy.com/', new Error(detail), reached);
      expect({ detail, kind: d.kind }).toMatchObject({ kind: 'bot-refused' });
      expect(d.hint).toMatch(/bot mitigation|refused the automated browser/i);
    }
  });

  it('treats a 403 to the plain probe as reached — the server is up and choosing to refuse', async () => {
    const d = await diagnoseHarvestFailure('https://x/', new Error('net::ERR_CONNECTION_RESET'), reached403);
    expect(d.kind).toBe('bot-refused');
    expect(d.originReached).toBe(true);
  });

  it('calls it unreachable when neither the browser nor a plain request can connect', async () => {
    const d = await diagnoseHarvestFailure('https://nope/', new Error('net::ERR_CONNECTION_RESET'), unreached);
    expect(d.kind).toBe('unreachable');
    expect(d.hint).toContain('could not be reached');
  });

  it('separates a timeout that no plain request can reach from a bot wall', async () => {
    const d = await diagnoseHarvestFailure('https://slow/', new Error('Timeout 30000ms exceeded.'), unreached);
    expect(d.kind).toBe('timeout');
  });

  it('does not probe, and does not cry bot, on a DNS failure', async () => {
    let probed = false;
    const probe = async () => {
      probed = true;
      return { reached: true };
    };
    const d = await diagnoseHarvestFailure('https://typo/', new Error('net::ERR_NAME_NOT_RESOLVED'), probe);
    expect(d.kind).toBe('unreachable');
    expect(probed).toBe(false);
  });

  it('stays honest about an error it does not recognise rather than guessing bot mitigation', async () => {
    // A non-network throw must never be labelled bot-refused, even if the
    // origin happens to be reachable — that would cry wolf on every render bug.
    const d = await diagnoseHarvestFailure('https://x/', new Error('page.evaluate: something threw'), reached);
    expect(d.kind).toBe('unknown');
  });
});
