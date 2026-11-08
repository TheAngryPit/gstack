/**
 * A small PNG reader for the render tier: 8-bit greyscale, RGB, palette and
 * alpha variants, non-interlaced, inflated with node:zlib. Enough to sample
 * the pixels behind a run of text or around a focus ring in a screenshot the
 * browser took; anything else returns null and the caller keeps its computed
 * estimate.
 */
import { inflateSync } from 'node:zlib';

export interface Png { width: number; height: number; channels: number; data: Uint8Array }

export interface SampleRect { x: number; y: number; w: number; h: number; inner?: { l: number; t: number; r: number; b: number } }

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePng(buf: Uint8Array): Png | null {
  if (buf.length < 8 || SIGNATURE.some((b, i) => buf[i] !== b)) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let pos = 8; pos + 8 <= buf.length;) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = view.getUint32(pos + 8); height = view.getUint32(pos + 12); depth = buf[pos + 16]; colorType = buf[pos + 17]; interlace = buf[pos + 20]; }
    else if (type === 'PLTE') palette = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!width || !height || depth !== 8 || interlace !== 0 || !channels || (colorType === 3 && !palette)) return null;
  let raw: Uint8Array;
  try { raw = inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c)))); } catch { return null; }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, prev = (y - 1) * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? out[dst + i - channels] : 0;
      const b = y > 0 ? out[prev + i] : 0;
      const c = y > 0 && i >= channels ? out[prev + i - channels] : 0;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else return null;
      out[dst + i] = v & 255;
    }
  }
  if (colorType !== 3) return { width, height, channels, data: out };
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) { const p = out[i] * 3; rgb[i * 3] = palette![p]; rgb[i * 3 + 1] = palette![p + 1]; rgb[i * 3 + 2] = palette![p + 2]; }
  return { width, height, channels: 3, data: rgb };
}

/** The median colour (0..1 per channel) of a rectangle, leaving out an inner rectangle when one is given; null when nothing is sampled. */
export function medianRgb(png: Png, rect: SampleRect): number[] | null {
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(png.width, Math.ceil(rect.x + rect.w)), y1 = Math.min(png.height, Math.ceil(rect.y + rect.h));
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const grey = png.channels < 3;
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (rect.inner) { const ix = x - rect.x, iy = y - rect.y; if (ix >= rect.inner.l && ix < rect.inner.r && iy >= rect.inner.t && iy < rect.inner.b) continue; }
    const i = (y * png.width + x) * png.channels;
    hist[0][png.data[i]]++; hist[1][png.data[grey ? i : i + 1]]++; hist[2][png.data[grey ? i : i + 2]]++;
    n++;
  }
  if (!n) return null;
  return hist.map((h) => { let seen = 0; for (let v = 0; v < 256; v++) { seen += h[v]; if (seen > n >> 1) return v / 255; } return 1; });
}
