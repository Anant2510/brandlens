import { describe, expect, it } from 'vitest';
import { isHttp2ProtocolError, isLikelyLogo } from './browser';

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
