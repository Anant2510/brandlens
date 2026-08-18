/* ==========================================================================
 * Media probing — pure TypeScript, zero native dependencies.
 *
 * `sharp` / ImageMagick would give more, but both are native builds and the
 * target is a Windows VM with no compiler toolchain. Everything below reads
 * container headers directly, which covers the fields that actually change
 * verdicts: pixel dimensions, DPI and — critically — the ICC profile.
 *
 * The ICC profile is the most-missed step in this whole domain. A Display-P3
 * asset analysed as sRGB reads as oversaturated, every colour lands outside
 * the brand's ΔE tolerance, and the customer gets a page of false positives on
 * their first upload. Detecting the profile lets the engine convert instead.
 * ========================================================================== */

export interface MediaProbe {
  width: number | null;
  height: number | null;
  dpi: number | null;
  colorProfile: string | null;
  mimeType: string | null;
  pageCount: number | null;
  hasAlpha: boolean | null;
  format: string | null;
}

const EMPTY: MediaProbe = {
  width: null,
  height: null,
  dpi: null,
  colorProfile: null,
  mimeType: null,
  pageCount: null,
  hasAlpha: null,
  format: null,
};

export function probeMedia(buf: Buffer): MediaProbe {
  if (buf.length < 12) return EMPTY;
  if (isPng(buf)) return probePng(buf);
  if (isJpeg(buf)) return probeJpeg(buf);
  if (isGif(buf)) return probeGif(buf);
  if (isWebp(buf)) return probeWebp(buf);
  if (isPdf(buf)) return probePdf(buf);
  if (isSvg(buf)) return probeSvg(buf);
  return EMPTY;
}

/* ------------------------------------------------------------------- PNG */

function isPng(b: Buffer): boolean {
  return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function probePng(buf: Buffer): MediaProbe {
  const out: MediaProbe = { ...EMPTY, format: 'png', mimeType: 'image/png' };
  let offset = 8;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;

    if (type === 'IHDR' && dataStart + 13 <= buf.length) {
      out.width = buf.readUInt32BE(dataStart);
      out.height = buf.readUInt32BE(dataStart + 4);
      const colorType = buf[dataStart + 9];
      out.hasAlpha = colorType === 4 || colorType === 6;
    } else if (type === 'pHYs' && dataStart + 9 <= buf.length) {
      const ppuX = buf.readUInt32BE(dataStart);
      // unit 1 = metres; 1 inch = 0.0254 m.
      if (buf[dataStart + 8] === 1) out.dpi = Math.round(ppuX * 0.0254);
    } else if (type === 'iCCP') {
      const nul = buf.indexOf(0, dataStart);
      if (nul > dataStart && nul < dataStart + Math.min(length, 80)) {
        out.colorProfile = buf.toString('latin1', dataStart, nul);
      } else {
        out.colorProfile = 'embedded-icc';
      }
    } else if (type === 'sRGB' && !out.colorProfile) {
      out.colorProfile = 'sRGB';
    } else if (type === 'IDAT' || type === 'IEND') {
      break; // metadata chunks all precede the pixel data
    }

    offset = dataStart + length + 4; // + CRC
    if (length > buf.length) break;
  }

  return out;
}

/* ------------------------------------------------------------------ JPEG */

function isJpeg(b: Buffer): boolean {
  return b[0] === 0xff && b[1] === 0xd8;
}

function probeJpeg(buf: Buffer): MediaProbe {
  const out: MediaProbe = { ...EMPTY, format: 'jpeg', mimeType: 'image/jpeg', hasAlpha: false };
  let offset = 2;

  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan

    const segLength = buf.readUInt16BE(offset + 2);
    const dataStart = offset + 4;

    // SOF0..SOF15, excluding the DHT/JPG/DAC markers interleaved in the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (dataStart + 5 <= buf.length) {
        out.height = buf.readUInt16BE(dataStart + 1);
        out.width = buf.readUInt16BE(dataStart + 3);
      }
    } else if (marker === 0xe0 && buf.toString('ascii', dataStart, dataStart + 4) === 'JFIF') {
      // JFIF density: units 1 = dpi, 2 = dots per cm.
      const units = buf[dataStart + 7];
      const xDensity = buf.readUInt16BE(dataStart + 8);
      if (units === 1) out.dpi = xDensity;
      else if (units === 2) out.dpi = Math.round(xDensity * 2.54);
    } else if (marker === 0xe2 && buf.toString('ascii', dataStart, dataStart + 11) === 'ICC_PROFILE') {
      out.colorProfile = readIccDescription(buf.subarray(dataStart + 14, dataStart + segLength - 2)) ?? 'embedded-icc';
    } else if (marker === 0xe1 && buf.toString('ascii', dataStart, dataStart + 4) === 'Exif') {
      const exifDpi = readExifDpi(buf.subarray(dataStart + 6, dataStart + segLength - 2));
      if (exifDpi && !out.dpi) out.dpi = exifDpi;
    }

    offset = dataStart + segLength - 2;
    if (segLength < 2) break;
  }

  if (!out.colorProfile) out.colorProfile = 'sRGB (assumed)';
  return out;
}

/**
 * Pulls the human-readable name out of an ICC profile's `desc` tag. Knowing it
 * says "Display P3" rather than just "there is a profile" is what lets an
 * operator understand a wave of colour findings at a glance.
 */
function readIccDescription(icc: Buffer): string | null {
  try {
    if (icc.length < 132) return null;
    const tagCount = icc.readUInt32BE(128);
    if (tagCount > 200) return null;
    for (let i = 0; i < tagCount; i += 1) {
      const entry = 132 + i * 12;
      if (entry + 12 > icc.length) break;
      const sig = icc.toString('ascii', entry, entry + 4);
      if (sig !== 'desc') continue;
      const offset = icc.readUInt32BE(entry + 4);
      const size = icc.readUInt32BE(entry + 8);
      if (offset + size > icc.length) return null;
      const type = icc.toString('ascii', offset, offset + 4);
      if (type === 'desc') {
        const len = icc.readUInt32BE(offset + 8);
        return icc.toString('latin1', offset + 12, offset + 12 + Math.max(0, len - 1)).trim() || null;
      }
      if (type === 'mluc') {
        const recOffset = icc.readUInt32BE(offset + 20);
        const recLength = icc.readUInt32BE(offset + 16);
        return icc.toString('utf16le', offset + recOffset, offset + recOffset + recLength).replace(/\0/g, '').trim() || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function readExifDpi(exif: Buffer): number | null {
  try {
    if (exif.length < 8) return null;
    const little = exif.toString('ascii', 0, 2) === 'II';
    const u16 = (o: number) => (little ? exif.readUInt16LE(o) : exif.readUInt16BE(o));
    const u32 = (o: number) => (little ? exif.readUInt32LE(o) : exif.readUInt32BE(o));

    const ifdOffset = u32(4);
    if (ifdOffset + 2 > exif.length) return null;
    const entries = u16(ifdOffset);

    for (let i = 0; i < entries; i += 1) {
      const entry = ifdOffset + 2 + i * 12;
      if (entry + 12 > exif.length) break;
      const tag = u16(entry);
      if (tag !== 0x011a) continue; // XResolution
      const valueOffset = u32(entry + 8);
      if (valueOffset + 8 > exif.length) return null;
      const numerator = u32(valueOffset);
      const denominator = u32(valueOffset + 4);
      if (!denominator) return null;
      return Math.round(numerator / denominator);
    }
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- GIF / WEBP */

function isGif(b: Buffer): boolean {
  return b.toString('ascii', 0, 3) === 'GIF';
}

function probeGif(buf: Buffer): MediaProbe {
  return {
    ...EMPTY,
    format: 'gif',
    mimeType: 'image/gif',
    width: buf.readUInt16LE(6),
    height: buf.readUInt16LE(8),
    hasAlpha: true,
  };
}

function isWebp(b: Buffer): boolean {
  return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
}

function probeWebp(buf: Buffer): MediaProbe {
  const out: MediaProbe = { ...EMPTY, format: 'webp', mimeType: 'image/webp' };
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && buf.length >= 30) {
    out.width = 1 + (buf.readUIntLE(24, 3) & 0xffffff);
    out.height = 1 + (buf.readUIntLE(27, 3) & 0xffffff);
    out.hasAlpha = Boolean(buf[20] & 0b0001_0000);
  } else if (chunk === 'VP8 ' && buf.length >= 30) {
    out.width = buf.readUInt16LE(26) & 0x3fff;
    out.height = buf.readUInt16LE(28) & 0x3fff;
    out.hasAlpha = false;
  } else if (chunk === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    out.width = (bits & 0x3fff) + 1;
    out.height = ((bits >> 14) & 0x3fff) + 1;
    out.hasAlpha = Boolean((bits >> 28) & 1);
  }
  return out;
}

/* -------------------------------------------------------------------- PDF */

function isPdf(b: Buffer): boolean {
  return b.toString('ascii', 0, 5) === '%PDF-';
}

/**
 * Page count and MediaBox without a PDF library.
 *
 * Deliberately shallow: the Python engine does the real structured extraction
 * (per-span fonts, sizes, colours, vector fills). All the control plane needs
 * is enough to size the asset and decide it is worth queueing.
 */
function probePdf(buf: Buffer): MediaProbe {
  const out: MediaProbe = { ...EMPTY, format: 'pdf', mimeType: 'application/pdf' };
  const head = buf.toString('latin1', 0, Math.min(buf.length, 2_000_000));

  const counts = [...head.matchAll(/\/Type\s*\/Page[^s]/g)].length;
  const declared = /\/Count\s+(\d+)/.exec(head);
  out.pageCount = declared ? Number(declared[1]) : counts || null;

  const mediaBox = /\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/.exec(head);
  if (mediaBox) {
    // PDF user-space units are 1/72 inch; report pixels at 72 dpi so downstream
    // percent-of-canvas maths works the same way it does for rasters.
    out.width = Math.round(Number(mediaBox[3]) - Number(mediaBox[1]));
    out.height = Math.round(Number(mediaBox[4]) - Number(mediaBox[2]));
    out.dpi = 72;
  }

  if (/\/OutputIntent/.test(head)) out.colorProfile = 'embedded-output-intent';
  return out;
}

/* -------------------------------------------------------------------- SVG */

function isSvg(b: Buffer): boolean {
  const head = b.toString('utf8', 0, Math.min(b.length, 512)).trimStart();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

function probeSvg(buf: Buffer): MediaProbe {
  const head = buf.toString('utf8', 0, Math.min(buf.length, 8_192));
  const out: MediaProbe = { ...EMPTY, format: 'svg', mimeType: 'image/svg+xml', hasAlpha: true };

  const width = /\bwidth\s*=\s*["']([\d.]+)/.exec(head);
  const height = /\bheight\s*=\s*["']([\d.]+)/.exec(head);
  if (width) out.width = Math.round(Number(width[1]));
  if (height) out.height = Math.round(Number(height[1]));

  if (!out.width || !out.height) {
    const viewBox = /viewBox\s*=\s*["']\s*([\d.-]+)[\s,]+([\d.-]+)[\s,]+([\d.-]+)[\s,]+([\d.-]+)/.exec(head);
    if (viewBox) {
      out.width = Math.round(Number(viewBox[3]));
      out.height = Math.round(Number(viewBox[4]));
    }
  }
  return out;
}

/** Best-effort MIME sniff for uploads that arrived without a content type. */
export function sniffMimeType(buf: Buffer): string | null {
  return probeMedia(buf).mimeType;
}
