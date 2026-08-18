/* ==========================================================================
 * A minimal PNG encoder and raster canvas.
 *
 * The seed has to produce real image files: logo variants that a clear-space
 * check can measure, and creatives that contain actual off-palette pixels and
 * actual low-contrast text. Fake bytes would make every seeded finding a lie.
 *
 * This is hand-rolled rather than taken from `pngjs`/`sharp` because
 * @brandlens/db has four runtime dependencies (dotenv, drizzle, pg, postgres)
 * and adding an image library — with its own native build on Windows, in the
 * case of sharp — to run a demo seed would be a poor trade. Node's zlib does
 * the only hard part.
 *
 * Format: 8-bit RGBA, non-interlaced, one IDAT, filter type 0 (None) on every
 * scanline. Filtering exists to help the compressor on photographic data; on
 * flat brand graphics it wins almost nothing and costs a per-pixel pass.
 * ========================================================================== */

import { deflateSync } from 'node:zlib';
import { GLYPHS, GLYPH_HEIGHT, GLYPH_WIDTH } from './font.js';
import { parseHex, rgbToLab, type Rgb } from './color.js';

/* --------------------------------------------------------------------------
 * CRC-32 (ISO 3309), as required by the PNG chunk format.
 * ------------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* --------------------------------------------------------------------------
 * Canvas
 * ------------------------------------------------------------------------ */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class Canvas {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  private readonly pixels: Uint8Array;

  constructor(width: number, height: number, background = '#ffffff') {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.pixels = new Uint8Array(this.width * this.height * 4);
    this.fill(background);
  }

  private index(x: number, y: number): number {
    return (y * this.width + x) * 4;
  }

  /** Source-over alpha compositing. Out-of-bounds writes are dropped. */
  setPixel(x: number, y: number, rgb: Rgb, alpha = 1): void {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const i = this.index(px, py);

    if (alpha >= 1) {
      this.pixels[i] = rgb[0];
      this.pixels[i + 1] = rgb[1];
      this.pixels[i + 2] = rgb[2];
      this.pixels[i + 3] = 255;
      return;
    }
    if (alpha <= 0) return;

    const dstA = this.pixels[i + 3] / 255;
    const outA = alpha + dstA * (1 - alpha);
    if (outA <= 0) return;
    for (let c = 0; c < 3; c += 1) {
      const src = rgb[c] / 255;
      const dst = this.pixels[i + c] / 255;
      this.pixels[i + c] = Math.round(((src * alpha + dst * dstA * (1 - alpha)) / outA) * 255);
    }
    this.pixels[i + 3] = Math.round(outA * 255);
  }

  getPixel(x: number, y: number): [number, number, number, number] {
    const i = this.index(x, y);
    return [this.pixels[i], this.pixels[i + 1], this.pixels[i + 2], this.pixels[i + 3]];
  }

  fill(hex: string): void {
    this.rect({ x: 0, y: 0, w: this.width, h: this.height }, hex);
  }

  /** Fully transparent — used for logo files that must sit on any background. */
  clear(): void {
    this.pixels.fill(0);
  }

  rect(r: Rect, hex: string, alpha = 1): void {
    const { rgb } = parseHex(hex);
    const x0 = Math.max(0, Math.round(r.x));
    const y0 = Math.max(0, Math.round(r.y));
    const x1 = Math.min(this.width, Math.round(r.x + r.w));
    const y1 = Math.min(this.height, Math.round(r.y + r.h));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) this.setPixel(x, y, rgb, alpha);
    }
  }

  strokeRect(r: Rect, hex: string, weight = 1): void {
    this.rect({ x: r.x, y: r.y, w: r.w, h: weight }, hex);
    this.rect({ x: r.x, y: r.y + r.h - weight, w: r.w, h: weight }, hex);
    this.rect({ x: r.x, y: r.y, w: weight, h: r.h }, hex);
    this.rect({ x: r.x + r.w - weight, y: r.y, w: weight, h: r.h }, hex);
  }

  /** Antialiased disc. 4×4 supersampling on the boundary ring only. */
  circle(cx: number, cy: number, radius: number, hex: string, alpha = 1): void {
    const { rgb } = parseHex(hex);
    const x0 = Math.max(0, Math.floor(cx - radius - 1));
    const x1 = Math.min(this.width, Math.ceil(cx + radius + 1));
    const y0 = Math.max(0, Math.floor(cy - radius - 1));
    const y1 = Math.min(this.height, Math.ceil(cy + radius + 1));
    const inner = (radius - 1) ** 2;
    const outer = (radius + 1) ** 2;

    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const d = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
        if (d <= inner) {
          this.setPixel(x, y, rgb, alpha);
        } else if (d <= outer) {
          let hits = 0;
          for (let sy = 0; sy < 4; sy += 1) {
            for (let sx = 0; sx < 4; sx += 1) {
              const px = x + (sx + 0.5) / 4;
              const py = y + (sy + 0.5) / 4;
              if ((px - cx) ** 2 + (py - cy) ** 2 <= radius * radius) hits += 1;
            }
          }
          if (hits > 0) this.setPixel(x, y, rgb, alpha * (hits / 16));
        }
      }
    }
  }

  ring(cx: number, cy: number, outerRadius: number, thickness: number, hex: string): void {
    this.circle(cx, cy, outerRadius, hex);
    // Punch the hole by writing the background back. Callers draw rings on a
    // known flat background, which is true for every logo variant here.
    this.circleTransparent(cx, cy, outerRadius - thickness);
  }

  /** Clears a disc to fully transparent — the counter of a ring or a letter. */
  circleTransparent(cx: number, cy: number, radius: number): void {
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(this.width, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(this.height, Math.ceil(cy + radius));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius * radius) {
          const i = this.index(x, y);
          this.pixels[i] = 0;
          this.pixels[i + 1] = 0;
          this.pixels[i + 2] = 0;
          this.pixels[i + 3] = 0;
        }
      }
    }
  }

  /** Vertical linear gradient between two hex colours. */
  verticalGradient(r: Rect, fromHex: string, toHex: string): void {
    const a = parseHex(fromHex).rgb;
    const b = parseHex(toHex).rgb;
    const y0 = Math.max(0, Math.round(r.y));
    const y1 = Math.min(this.height, Math.round(r.y + r.h));
    const span = Math.max(1, y1 - y0 - 1);
    for (let y = y0; y < y1; y += 1) {
      const t = (y - y0) / span;
      const rgb: Rgb = [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
      ];
      for (let x = Math.max(0, Math.round(r.x)); x < Math.min(this.width, Math.round(r.x + r.w)); x += 1) {
        this.setPixel(x, y, rgb);
      }
    }
  }

  /* ---------------------------------------------------------------------
   * Text
   *
   * A 5×7 bitmap font scaled by an integer factor. Crude, but it produces
   * genuinely readable pixels, which is what matters: the OCR and contrast
   * analyzers in the engine read these images, and "text" made of random
   * rectangles would not exercise them.
   * ------------------------------------------------------------------- */

  /** Rendered width of `text` at `scale`, including inter-glyph spacing. */
  static textWidth(text: string, scale: number, tracking = 1): number {
    if (text.length === 0) return 0;
    return text.length * (GLYPH_WIDTH + tracking) * scale - tracking * scale;
  }

  static textHeight(scale: number): number {
    return GLYPH_HEIGHT * scale;
  }

  text(
    value: string,
    x: number,
    y: number,
    options: { hex: string; scale?: number; tracking?: number; alpha?: number } = { hex: '#000000' },
  ): { width: number; height: number } {
    const scale = Math.max(1, Math.round(options.scale ?? 2));
    const tracking = options.tracking ?? 1;
    const { rgb } = parseHex(options.hex);
    const alpha = options.alpha ?? 1;

    let cursor = x;
    for (const char of value.toUpperCase()) {
      const glyph = GLYPHS[char] ?? GLYPHS['?'];
      for (let gy = 0; gy < GLYPH_HEIGHT; gy += 1) {
        const row = glyph[gy];
        for (let gx = 0; gx < GLYPH_WIDTH; gx += 1) {
          if ((row >> (GLYPH_WIDTH - 1 - gx)) & 1) {
            this.rect(
              { x: cursor + gx * scale, y: y + gy * scale, w: scale, h: scale },
              options.hex,
              alpha,
            );
          }
        }
      }
      cursor += (GLYPH_WIDTH + tracking) * scale;
      void rgb;
    }
    return { width: cursor - x - tracking * scale, height: GLYPH_HEIGHT * scale };
  }

  /** Centre `value` horizontally within [x, x+w). */
  textCentered(
    value: string,
    x: number,
    w: number,
    y: number,
    options: { hex: string; scale?: number; tracking?: number; alpha?: number },
  ): { width: number; height: number } {
    const scale = Math.max(1, Math.round(options.scale ?? 2));
    const tracking = options.tracking ?? 1;
    const width = Canvas.textWidth(value, scale, tracking);
    return this.text(value, x + (w - width) / 2, y, options);
  }

  /**
   * Word-wraps into `maxWidth` and returns the drawn lines. Returned rather
   * than discarded because the seed records the real bbox of every text block
   * in the decision-trace evidence.
   */
  paragraph(
    value: string,
    x: number,
    y: number,
    maxWidth: number,
    options: { hex: string; scale?: number; tracking?: number; lineGap?: number },
  ): { lines: string[]; width: number; height: number } {
    const scale = Math.max(1, Math.round(options.scale ?? 2));
    const tracking = options.tracking ?? 1;
    const lineGap = options.lineGap ?? Math.round(scale * 3);

    const words = value.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (Canvas.textWidth(candidate, scale, tracking) <= maxWidth || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);

    let cursorY = y;
    let widest = 0;
    for (const line of lines) {
      this.text(line, x, cursorY, options);
      widest = Math.max(widest, Canvas.textWidth(line, scale, tracking));
      cursorY += GLYPH_HEIGHT * scale + lineGap;
    }
    return { lines, width: widest, height: cursorY - y - lineGap };
  }

  /**
   * Fraction of pixels within `deltaEMax` of any of `hexes`.
   *
   * This is the same question `color.dominance_ratio` and
   * `color.palette_conformance` ask, answered the same way — ΔE in CIELAB
   * rather than an exact RGB match, so antialiased edges and gradient bands
   * are counted the way the analyzer would count them. The seeded traces read
   * these numbers, which is why they are measured here rather than asserted
   * in the trace definition.
   *
   * `sampleStep` subsamples the grid; at 2 the error on a 1080² canvas is
   * well under a tenth of a percentage point and it is four times faster.
   */
  surfaceShare(hexes: readonly string[], deltaEMax = 5, sampleStep = 2): number {
    const targets = hexes.map((h) => rgbToLab(parseHex(h).rgb));
    const limit = deltaEMax * deltaEMax;
    let hits = 0;
    let total = 0;

    for (let y = 0; y < this.height; y += sampleStep) {
      for (let x = 0; x < this.width; x += sampleStep) {
        const i = this.index(x, y);
        if (this.pixels[i + 3] === 0) continue; // transparent pixels are not surface
        total += 1;
        const lab = rgbToLab([this.pixels[i], this.pixels[i + 1], this.pixels[i + 2]]);
        for (const t of targets) {
          const d = (lab[0] - t[0]) ** 2 + (lab[1] - t[1]) ** 2 + (lab[2] - t[2]) ** 2;
          if (d <= limit) {
            hits += 1;
            break;
          }
        }
      }
    }
    return total === 0 ? 0 : hits / total;
  }

  /** Draws `src` at (x, y), compositing with its alpha. */
  drawImage(src: Canvas, x: number, y: number): void {
    for (let sy = 0; sy < src.height; sy += 1) {
      for (let sx = 0; sx < src.width; sx += 1) {
        const [r, g, b, a] = src.getPixel(sx, sy);
        if (a === 0) continue;
        this.setPixel(x + sx, y + sy, [r, g, b], a / 255);
      }
    }
  }

  /** Nearest-neighbour scale. Exact for the integer factors used here. */
  scaled(width: number, height: number): Canvas {
    const out = new Canvas(width, height, '#00000000');
    out.clear();
    for (let y = 0; y < height; y += 1) {
      const sy = Math.min(this.height - 1, Math.floor((y * this.height) / height));
      for (let x = 0; x < width; x += 1) {
        const sx = Math.min(this.width - 1, Math.floor((x * this.width) / width));
        const [r, g, b, a] = this.getPixel(sx, sy);
        if (a === 0) continue;
        out.setPixel(x, y, [r, g, b], a / 255);
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------------
   * Encoding
   * ------------------------------------------------------------------- */

  toPng(): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr.writeUInt8(8, 8); // bit depth
    ihdr.writeUInt8(6, 9); // colour type 6 = truecolour with alpha
    ihdr.writeUInt8(0, 10); // deflate
    ihdr.writeUInt8(0, 11); // adaptive filtering
    ihdr.writeUInt8(0, 12); // no interlace

    // One filter byte per scanline, then the raw RGBA bytes.
    const stride = this.width * 4;
    const raw = Buffer.alloc((stride + 1) * this.height);
    for (let y = 0; y < this.height; y += 1) {
      const offset = y * (stride + 1);
      raw[offset] = 0; // filter: None
      Buffer.from(this.pixels.buffer, this.pixels.byteOffset + y * stride, stride).copy(raw, offset + 1);
    }

    // level 9: these are tiny flat images, and a byte-identical output for
    // identical input keeps the content hash stable across runs — which the
    // whole idempotency story depends on.
    const idat = deflateSync(raw, { level: 9 });

    return Buffer.concat([
      PNG_SIGNATURE,
      chunk('IHDR', ihdr),
      // sRGB + gAMA, so a colour-managed reader does not re-interpret the
      // pixels. Assets whose profile is misread are a real source of false
      // "off-palette" findings, and the fixtures must not be an example of it.
      chunk('sRGB', Buffer.from([0])),
      chunk('gAMA', (() => { const b = Buffer.alloc(4); b.writeUInt32BE(45455, 0); return b; })()),
      chunk('IDAT', idat),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}
