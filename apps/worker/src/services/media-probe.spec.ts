import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { probeMedia, sniffMimeType } from './media-probe';

/* --------------------------------------------------------------------------
 * Minimal, valid container fixtures built in-memory. Using real headers rather
 * than mocks is the point: the probe's whole job is byte-level parsing.
 * ------------------------------------------------------------------------ */

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  // CRC is not validated by the probe, so a placeholder keeps the fixture small.
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

function makePng(options: { width: number; height: number; dpi?: number; colorType?: number; iccName?: string }): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(options.width, 0);
  ihdr.writeUInt32BE(options.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = options.colorType ?? 6; // RGBA
  const chunks = [signature, pngChunk('IHDR', ihdr)];

  if (options.dpi) {
    const phys = Buffer.alloc(9);
    const ppu = Math.round(options.dpi / 0.0254);
    phys.writeUInt32BE(ppu, 0);
    phys.writeUInt32BE(ppu, 4);
    phys[8] = 1; // unit = metre
    chunks.push(pngChunk('pHYs', phys));
  }

  if (options.iccName) {
    const body = Buffer.concat([
      Buffer.from(options.iccName, 'latin1'),
      Buffer.from([0x00, 0x00]),
      deflateSync(Buffer.from('fake-profile')),
    ]);
    chunks.push(pngChunk('iCCP', body));
  }

  chunks.push(pngChunk('IDAT', Buffer.alloc(4)), pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function makeJpeg(options: { width: number; height: number; dpi?: number }): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];

  if (options.dpi) {
    // APP0/JFIF layout, offsets relative to the start of the length field:
    // 0 length | 2 "JFIF\0" | 7 version | 9 units | 10 Xdensity | 12 Ydensity
    const jfif = Buffer.alloc(16);
    jfif.writeUInt16BE(16, 0);
    jfif.write('JFIF\0', 2, 'ascii');
    jfif[7] = 1; // version major
    jfif[9] = 1; // units = dots per inch
    jfif.writeUInt16BE(options.dpi, 10);
    jfif.writeUInt16BE(options.dpi, 12);
    parts.push(Buffer.from([0xff, 0xe0]), jfif);
  }

  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(11, 0);
  sof[2] = 8; // precision
  sof.writeUInt16BE(options.height, 3);
  sof.writeUInt16BE(options.width, 5);
  parts.push(Buffer.from([0xff, 0xc0]), sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

describe('probeMedia — PNG', () => {
  it('reads dimensions from IHDR', () => {
    const probe = probeMedia(makePng({ width: 1200, height: 628 }));
    expect(probe.width).toBe(1200);
    expect(probe.height).toBe(628);
    expect(probe.format).toBe('png');
    expect(probe.mimeType).toBe('image/png');
  });

  it('converts pHYs pixels-per-metre to DPI', () => {
    const probe = probeMedia(makePng({ width: 100, height: 100, dpi: 300 }));
    expect(probe.dpi).toBeGreaterThanOrEqual(299);
    expect(probe.dpi).toBeLessThanOrEqual(301);
  });

  it('detects alpha from the colour type', () => {
    expect(probeMedia(makePng({ width: 8, height: 8, colorType: 6 })).hasAlpha).toBe(true);
    expect(probeMedia(makePng({ width: 8, height: 8, colorType: 2 })).hasAlpha).toBe(false);
  });

  it('names the embedded ICC profile — the difference between a real finding and 40 false ones', () => {
    const probe = probeMedia(makePng({ width: 8, height: 8, iccName: 'Display P3' }));
    expect(probe.colorProfile).toBe('Display P3');
  });
});

describe('probeMedia — JPEG', () => {
  it('reads dimensions from the SOF0 marker', () => {
    const probe = probeMedia(makeJpeg({ width: 1080, height: 1350 }));
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1350);
    expect(probe.format).toBe('jpeg');
  });

  it('reads JFIF density as DPI', () => {
    expect(probeMedia(makeJpeg({ width: 10, height: 10, dpi: 72 })).dpi).toBe(72);
  });

  it('assumes sRGB when no profile is embedded, and says so', () => {
    expect(probeMedia(makeJpeg({ width: 10, height: 10 })).colorProfile).toBe('sRGB (assumed)');
  });
});

describe('probeMedia — other containers', () => {
  it('reads a GIF header', () => {
    const gif = Buffer.alloc(13);
    gif.write('GIF89a', 0, 'ascii');
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(240, 8);
    const probe = probeMedia(gif);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
  });

  it('reads a lossy WebP header', () => {
    const webp = Buffer.alloc(40);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBP', 8, 'ascii');
    webp.write('VP8 ', 12, 'ascii');
    webp.writeUInt16LE(640, 26);
    webp.writeUInt16LE(480, 28);
    const probe = probeMedia(webp);
    expect(probe.width).toBe(640);
    expect(probe.height).toBe(480);
  });

  it('reads a PDF MediaBox and page count', () => {
    const pdf = Buffer.from(
      '%PDF-1.7\n1 0 obj\n<< /Type /Pages /Count 3 >>\nendobj\n2 0 obj\n<< /Type /Page /MediaBox [0 0 595 842] >>\nendobj\n',
      'latin1',
    );
    const probe = probeMedia(pdf);
    expect(probe.pageCount).toBe(3);
    expect(probe.width).toBe(595);
    expect(probe.height).toBe(842);
    expect(probe.dpi).toBe(72);
  });

  it('reads SVG dimensions, falling back to the viewBox', () => {
    expect(probeMedia(Buffer.from('<svg width="100" height="50"></svg>')).width).toBe(100);
    const viaViewBox = probeMedia(Buffer.from('<svg viewBox="0 0 400 300"></svg>'));
    expect(viaViewBox.width).toBe(400);
    expect(viaViewBox.height).toBe(300);
  });

  it('returns empty rather than throwing on unknown or truncated bytes', () => {
    expect(probeMedia(Buffer.from('not an image at all'))).toMatchObject({ width: null, format: null });
    expect(probeMedia(Buffer.alloc(3))).toMatchObject({ width: null });
    expect(() => probeMedia(Buffer.alloc(0))).not.toThrow();
  });

  it('sniffs a MIME type for uploads that arrived without one', () => {
    expect(sniffMimeType(makePng({ width: 4, height: 4 }))).toBe('image/png');
    expect(sniffMimeType(Buffer.from('nope'))).toBeNull();
  });
});
