/**
 * Colour parsing and contrast for the design lint: hex, rgb(), hsl() and
 * oklch() to linear sRGB, sRGB to OKLCH for hue and chroma questions, WCAG
 * relative luminance and contrast ratio.
 *
 * Ported from Nutlope/hallmark's sloplint.mjs (parseColor, oklchToSrgb,
 * srgbToOklch, contrastRatio; MIT, see NOTICE.md).
 */

import { resolveVars, type Tokens } from './css';

export interface Rgb { r: number; g: number; b: number }
export interface Oklch { L: number; C: number; H: number }
export interface Color extends Rgb { alpha: number; okl?: Oklch }

const parseNum = (s: string): number | null => { const v = parseFloat(s); return Number.isNaN(v) ? null : v; };

function alphaOf(parts: string[], nums: string[]): number {
  if (parts[1] != null) return parts[1].trim().endsWith('%') ? (parseNum(parts[1]) ?? 100) / 100 : parseNum(parts[1]) ?? 1;
  if (nums.length === 4) return nums[3].endsWith('%') ? (parseNum(nums[3]) ?? 100) / 100 : parseNum(nums[3]) ?? 1;
  return 1;
}

function parseHex(h: string): Color | null {
  if (h.length === 3 || h.length === 4) {
    const r = parseInt(h[0] + h[0], 16) / 255, g = parseInt(h[1] + h[1], 16) / 255, b = parseInt(h[2] + h[2], 16) / 255;
    return { r, g, b, alpha: h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1 };
  }
  if (h.length === 6 || h.length === 8) {
    const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    return { r, g, b, alpha: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  return null;
}

function parseHsl(body: string): Color | null {
  const parts = body.split('/');
  const nums = parts[0].split(/[\s,]+/).filter(Boolean);
  if (nums.length < 3) return null;
  const h = parseNum(nums[0]);
  const s = (parseNum(nums[1]) ?? NaN) / 100, l = (parseNum(nums[2]) ?? NaN) / 100;
  if (h == null || Number.isNaN(s) || Number.isNaN(l)) return null;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number] = [0, 0, 0];
  if (hp < 1) rgb = [c, x, 0]; else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x]; else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c]; else rgb = [c, 0, x];
  const m = l - c / 2;
  return { r: rgb[0] + m, g: rgb[1] + m, b: rgb[2] + m, alpha: alphaOf(parts, nums) };
}

/** Parse one CSS colour literal (hex, rgb[a], hsl[a], oklch, white/black/transparent); null for anything else. */
export function parseColor(raw: string | null | undefined): Color | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'white') return { r: 1, g: 1, b: 1, alpha: 1 };
  if (v === 'black') return { r: 0, g: 0, b: 0, alpha: 1 };
  if (v === 'transparent') return { r: 0, g: 0, b: 0, alpha: 0 };
  let m: RegExpExecArray | null;
  if ((m = /^#([0-9a-f]{3,8})$/.exec(v))) return parseHex(m[1]);
  if ((m = /^rgba?\(([^)]+)\)$/.exec(v))) {
    const parts = m[1].split('/');
    const nums = parts[0].split(/[\s,]+/).filter(Boolean);
    if (nums.length < 3) return null;
    const chan = (s: string) => s.endsWith('%') ? (parseNum(s) ?? NaN) / 100 : (parseNum(s) ?? NaN) / 255;
    const [r, g, b] = nums.slice(0, 3).map(chan);
    if ([r, g, b].some((x) => Number.isNaN(x))) return null;
    return { r, g, b, alpha: alphaOf(parts, nums) };
  }
  if ((m = /^hsla?\(([^)]+)\)$/.exec(v))) return parseHsl(m[1]);
  if ((m = /^oklch\(([^)]+)\)$/.exec(v))) {
    const parts = m[1].split('/');
    const nums = parts[0].split(/\s+/).filter(Boolean);
    if (nums.length < 3) return null;
    let L = parseNum(nums[0]);
    if (L != null && nums[0].endsWith('%')) L = L / 100;
    const C = parseNum(nums[1]);
    const H = nums[2] === 'none' ? 0 : parseNum(nums[2]);
    if (L == null || C == null || H == null) return null;
    return { ...oklchToSrgb(L, C, H), alpha: alphaOf(parts, []), okl: { L, C, H } };
  }
  return null;
}

export function oklchToSrgb(L: number, C: number, H: number): Rgb {
  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr), b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, mm = m_ ** 3, s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.7076147010 * s,
  ].map((c) => Math.min(1, Math.max(0, c)));
  const enc = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  return { r: enc(lin[0]), g: enc(lin[1]), b: enc(lin[2]) };
}

export function srgbToOklch(col: Rgb): Oklch {
  const dec = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const r = dec(col.r), g = dec(col.g), b = dec(col.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const b2 = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const C = Math.sqrt(a * a + b2 * b2);
  let H = (Math.atan2(b2, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}

/** OKLCH of a colour, from its own oklch() literal when it had one. */
export function oklchOf(col: Color): Oklch {
  return col.okl ?? srgbToOklch(col);
}

export function luminance(col: Rgb): number {
  const dec = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * dec(col.r) + 0.7152 * dec(col.g) + 0.0722 * dec(col.b);
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a), lb = luminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Whether hue h (degrees) lies in [lo, hi], wrapping through 360 when lo > hi. */
export const hueIn = (h: number, lo: number, hi: number): boolean => (lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi);

export const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|oklch\([^)]*\)|rgba?\([^)]*\)|hsla?\([^)]*\)|color-mix\((?:[^()]|\([^()]*\))*\)|\b(white|black|transparent)\b/i;

/** Whether the page's paper token resolves to a dark colour (OKLCH lightness under 0.4). */
// sloplint paperIsDark (gate 2)
export function paperIsDark(tokens: Tokens): boolean {
  const p = parseColor(resolveVars(tokens['--color-paper'] || '', tokens));
  return !!p && oklchOf(p).L < 0.4;
}

/** Two indigo-to-violet stops this many degrees apart read as a ramp; closer is one hue shaded. */
const INDIGO_VIOLET_SPAN = 12;

/**
 * The banned ramp among a gradient's stop hues: purple to blue, purple to
 * pink, indigo to violet, or cyan on a dark paper. One classifier for a
 * stylesheet gradient and for Tailwind stops, so both tiers give one answer.
 */
// sloplint bannedGradient (gate 2a)
export function bannedGradient(hues: number[], tokens: Tokens): string | null {
  const purple = hues.some((h) => hueIn(h, 265, 330));
  const blue = hues.some((h) => hueIn(h, 200, 264));
  const pink = hues.some((h) => hueIn(h, 331, 25));
  const cyan = hues.some((h) => hueIn(h, 170, 230));
  if (purple && blue) return 'purple-to-blue';
  if (purple && pink) return 'purple-to-pink';
  const band = hues.filter((h) => hueIn(h, 250, 330));
  if (band.length >= 2 && Math.max(...band) - Math.min(...band) >= INDIGO_VIOLET_SPAN) return 'indigo-to-violet';
  if (cyan && paperIsDark(tokens)) return 'cyan-on-dark';
  return null;
}
