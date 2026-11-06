/**
 * Capture math for /design-motion (bin/gstack-motion-capture.ts). Pure: no
 * browser, no filesystem, so the timing and argument rules are unit-tested
 * without Chromium (test/motion-capture.test.ts).
 *
 * The capture steps a fake clock in whole milliseconds that average exactly
 * 1000/fps (17, 16, 17, ... at 60 fps). Stepping by 1000/60 directly drifts,
 * and the seam check would then compare two frames that are not one cycle
 * apart. The page contract is window.__start(), window.__tick(dtSeconds) and
 * window.__lt (loop time); PRE frames are recorded before __start so the page
 * settles, and the export window starts on frame PRE - 1, the empty state at
 * loop time 0.
 *
 * Adapted from Elaya's design-to-motion (MIT, (c) 2026 Elaya). See NOTICE.md.
 */

export const FPS = 60;
export const DEFAULT_PRE = 15;
export const DEFAULT_TAIL = 10;
export const MAX_LONG = 1920;
export const MAX_SHORT = 1200;

/** Milliseconds the clock advances before frame i: whole numbers averaging 1000/fps. */
export function stepMs(i: number, fps = FPS): number {
  return Math.round((i + 1) * 1000 / fps) - Math.round(i * 1000 / fps);
}

/** Page-clock milliseconds shown by frame i: 0 before the start, then the ticks summed from frame pre. */
export function clockMs(i: number, pre: number, fps = FPS): number {
  if (i < pre) return 0;
  return Math.round((i + 1) * 1000 / fps) - Math.round(pre * 1000 / fps);
}

/** Device scale factor that puts the frame's long side on X's 1920x1200 limit (1200x1920 for a portrait frame). */
export function captureScale(width: number, height: number, maxLong = MAX_LONG, maxShort = MAX_SHORT): number {
  return Math.min(maxLong / Math.max(width, height), maxShort / Math.min(width, height));
}

export interface CapturePlan {
  pre: number;
  /** First frame of the export window: PRE - 1, loop time 0. */
  windowStart: number;
  /** Frames in one cycle: cycle x fps. */
  windowFrames: number;
  /** Frames recorded past the window for the seam check. */
  tail: number;
  /** Total frames to record (indices 0 .. frames - 1). */
  frames: number;
}

export function planCapture(o: { cycleSeconds: number; pre?: number; tail?: number; fps?: number }): CapturePlan {
  const pre = o.pre ?? DEFAULT_PRE;
  const tail = o.tail ?? DEFAULT_TAIL;
  const windowFrames = Math.round(o.cycleSeconds * (o.fps ?? FPS));
  const windowStart = pre - 1;
  return { pre, windowStart, windowFrames, tail, frames: windowStart + windowFrames + tail };
}

export interface CaptureOptions {
  target: string;
  width: number;
  height: number;
  out?: string;
  cycle?: number;
  pre: number;
  tail: number;
  still?: string;
  scale?: number;
  mask?: string;
}

export const CAPTURE_USAGE = `Usage:
  gstack-motion-capture.ts <page.html|url> --size <W>x<H> --cycle <seconds> --out <dir>
                           [--pre <n>] [--tail <n>] [--mask <css selector>]
  gstack-motion-capture.ts <page.html|url> --size <W>x<H> --still <out.png> [--scale <n>]`;

const OPTIONS = ['--size', '--cycle', '--out', '--pre', '--tail', '--still', '--scale', '--mask'];
const POSITIVE = /^\d+(\.\d+)?$/;

/** Parse argv (without the runtime and script). Returns the options or a one-line error. */
export function parseCaptureArgs(argv: string[]): CaptureOptions | { error: string } {
  const flags = new Map<string, string>();
  let target: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      if (target !== undefined) return { error: `unexpected argument '${arg}'` };
      target = arg;
      continue;
    }
    if (!OPTIONS.includes(arg)) return { error: `unknown option '${arg}'` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
    flags.set(arg, value);
    i++;
  }
  if (!target) return { error: 'name the page: a .html file or an http(s) URL' };
  const size = /^(\d+)x(\d+)$/.exec(flags.get('--size') ?? '');
  if (!size) return { error: '--size <W>x<H> is required: the design frame in CSS pixels, for example 1440x990' };
  const width = Number(size[1]);
  const height = Number(size[2]);
  if (width < 16 || height < 16) return { error: `--size ${width}x${height} is too small` };
  const nums: Record<string, number | undefined> = {};
  for (const flag of ['--cycle', '--scale', '--pre', '--tail']) {
    const raw = flags.get(flag);
    if (raw === undefined) continue;
    if (!POSITIVE.test(raw) || Number(raw) <= 0) return { error: `${flag} must be a positive number, got '${raw}'` };
    nums[flag] = Number(raw);
  }
  const pre = nums['--pre'] ?? DEFAULT_PRE;
  const tail = nums['--tail'] ?? DEFAULT_TAIL;
  if (!Number.isInteger(pre) || pre < 2) return { error: '--pre must be a whole number of at least 2' };
  if (!Number.isInteger(tail)) return { error: '--tail must be a whole number' };
  const still = flags.get('--still');
  const out = flags.get('--out');
  if (still && out) return { error: 'use --still or --out, not both' };
  if (!still && !out) return { error: '--out <dir> is required for a capture (or --still <out.png> for one still frame)' };
  if (out && nums['--cycle'] === undefined) return { error: '--cycle <seconds> is required for a capture' };
  if (nums['--cycle'] !== undefined && Math.abs(nums['--cycle'] * 20 - Math.round(nums['--cycle'] * 20)) > 1e-6) {
    return { error: `--cycle must be a multiple of 0.05 s (three ${FPS} fps frames, so the seam lands exactly one cycle later), got '${nums['--cycle']}' (nearest: ${Math.max(1, Math.round(nums['--cycle'] * 20)) / 20})` };
  }
  if (still && !/\.png$/i.test(still)) return { error: '--still must name a .png file' };
  if (still && flags.has('--mask')) return { error: '--mask belongs to a capture (--out), not a single still' };
  if (/[{};]/.test(flags.get('--mask') ?? '')) return { error: `--mask takes a CSS selector, got '${flags.get('--mask')}'` };
  if (out && flags.has('--scale')) return { error: '--scale belongs to --still; a capture always uses the 1920x1200 scale' };
  return { target, width, height, out, still, cycle: nums['--cycle'], scale: nums['--scale'], pre, tail, mask: flags.get('--mask') };
}

/** The page URL in one of the page's modes (capture, still), keeping any query and fragment it already has. */
export function withMode(url: string, mode: 'capture' | 'still'): string {
  const hash = url.indexOf('#');
  const base = hash === -1 ? url : url.slice(0, hash);
  const frag = hash === -1 ? '' : url.slice(hash);
  return `${base}${base.includes('?') ? '&' : '?'}${mode}${frag}`;
}

/**
 * CSS that paints the overflow mask on the still page: the containers the
 * selector matches become solid white shapes with their own radii; everything
 * else is black and unpainted.
 */
export function maskCss(selector: string): string {
  return `html, body { background: #000 !important; background-image: none !important; }
* { visibility: hidden !important; transition: none !important; animation: none !important; }
${selector} { visibility: visible !important; background: #fff !important; background-image: none !important;
  border-color: #fff !important; box-shadow: none !important; filter: none !important;
  backdrop-filter: none !important; opacity: 1 !important; outline: none !important; }`;
}
