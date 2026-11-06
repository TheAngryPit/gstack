/**
 * Encode and check arguments for /design-motion (bin/gstack-motion-encode).
 * Pure: builds ffmpeg argument lists and parses ffmpeg's PSNR stats, so the
 * recipes and verdicts are unit-tested without ffmpeg
 * (test/motion-encode.test.ts).
 *
 * The three export recipes (MP4 for X, the website loop GIF, the 800x500 GIF)
 * are Elaya's, with -y, -nostdin and quiet logging added so a non-interactive
 * run never stops on an overwrite prompt. The checks compare frames with
 * ffmpeg's psnr filter: identical frames report psnr_avg:inf.
 *
 * Adapted from Elaya's design-to-motion (MIT, (c) 2026 Elaya). See NOTICE.md.
 */
import * as path from 'path';

/** capture.json, written by bin/gstack-motion-capture.ts beside frames/. */
export interface CaptureManifest {
  schema: 1;
  target: string;
  width: number;
  height: number;
  scale: number;
  fps: number;
  cycle: number;
  pre: number;
  windowStart: number;
  windowFrames: number;
  frames: number;
  /** Page-clock milliseconds per frame (0 before __start). */
  clockMs: number[];
  /** window.__lt per frame, as the page reported it. */
  loopTime: number[];
  still: string;
  mask?: string;
}

const QUIET = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];

/** capture.json fields reach ffmpeg arguments and file paths, so a manifest this tool did not write is refused. */
export function manifestError(m: unknown): string | null {
  const o = (m ?? {}) as Record<string, unknown>;
  if (o.schema !== 1) return 'capture.json is not a schema 1 capture manifest';
  for (const k of ['fps', 'pre', 'windowStart', 'windowFrames', 'frames']) {
    if (!Number.isInteger(o[k]) || (o[k] as number) < 0) return `capture.json field ${k} must be a non-negative integer`;
  }
  if ((o.fps as number) < 1 || (o.windowFrames as number) < 1) return 'capture.json fields fps and windowFrames must be at least 1';
  if ((o.windowStart as number) + (o.windowFrames as number) > (o.frames as number)) return 'capture.json window runs past its frames (windowStart + windowFrames > frames)';
  if (typeof o.cycle !== 'number' || !(o.cycle > 0)) return 'capture.json field cycle must be a positive number';
  if (!Array.isArray(o.clockMs) || o.clockMs.length !== o.frames || !o.clockMs.every(t => Number.isFinite(t))) return 'capture.json field clockMs must hold one number per frame';
  for (const k of ['still', 'mask']) {
    const v = o[k];
    if (v === undefined && k === 'mask') continue;
    if (typeof v !== 'string' || !/^[\w-]+\.png$/.test(v)) return `capture.json field ${k} must be a .png file name inside the capture dir`;
  }
  return null;
}

export function framePattern(dir: string): string {
  return path.join(dir, 'frames', '%05d.png');
}

export function framePath(dir: string, i: number): string {
  return path.join(dir, 'frames', `${String(i).padStart(5, '0')}.png`);
}

/** <name>-x.mp4: H.264, yuv420p, 60 fps, CRF 15, preset slow, faststart, even dimensions. */
export function mp4Args(m: CaptureManifest, dir: string, out: string, crf = 15): string[] {
  return [...QUIET, '-start_number', String(m.windowStart), '-framerate', String(m.fps), '-i', framePattern(dir),
    '-frames:v', String(m.windowFrames), '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
}

export interface GifOptions {
  fps?: number;
  /** ffmpeg crop=w:h:x:y in capture pixels, applied before scaling (the 800x500 content crop). */
  crop?: string;
  /** Pad colour for the 800x500 fit, the page background. */
  pad?: string;
}

const PALETTE = 'split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';

function gifArgs(m: CaptureManifest, dir: string, out: string, chain: string[]): string[] {
  const filter = [`trim=end_frame=${m.windowFrames}`, ...chain, PALETTE].join(',');
  return [...QUIET, '-start_number', String(m.windowStart), '-framerate', String(m.fps), '-i', framePattern(dir),
    '-filter_complex', filter, '-loop', '0', out];
}

/** <name>-loop.gif: 960 px wide, 20 fps by default, for the website. */
export function loopGifArgs(m: CaptureManifest, dir: string, out: string, o: GifOptions = {}): string[] {
  return gifArgs(m, dir, out, [`fps=${o.fps ?? 20}`, ...(o.crop ? [`crop=${o.crop}`] : []), 'scale=960:-2:flags=lanczos']);
}

/** <name>-800x500.gif: cropped to content or fitted and padded with the page background. */
export function smallGifArgs(m: CaptureManifest, dir: string, out: string, o: GifOptions = {}): string[] {
  const pad = (o.pad ?? '#ffffff').replace(/^#/, '0x');
  return gifArgs(m, dir, out, [`fps=${o.fps ?? 20}`, ...(o.crop ? [`crop=${o.crop}`] : []),
    'scale=800:500:force_original_aspect_ratio=decrease:flags=lanczos', `pad=800:500:(ow-iw)/2:(oh-ih)/2:color=${pad}`]);
}

/** A crop must be w:h:x:y in whole pixels; for the 800x500 GIF (ratio) it must also be 1.6:1, one pixel of rounding allowed. */
export function cropError(crop: string, o: { ratio?: boolean } = { ratio: true }): string | null {
  const m = /^(\d+):(\d+):(\d+):(\d+)$/.exec(crop);
  if (!m) return `--crop must be w:h:x:y in capture pixels, got '${crop}'`;
  if (!o.ratio) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (Math.abs(w - h * 1.6) > 1) return `--crop ${w}x${h} is not 1.6:1 (for height ${h} use width ${Math.round(h * 1.6)})`;
  return null;
}

/** The 800x500 pad colour goes into the filter graph, so it must be a plain #RRGGBB[AA] hex colour (ffmpeg rejects #RGB). */
export function padError(pad: string): string | null {
  return /^#?(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(pad) ? null : `--pad must be a hex colour such as '#f4f1ea', got '${pad}'`;
}

/**
 * PSNR of a run of frames against one reference image. With a mask, pixels the
 * mask (grown by maskGrow pixels) marks white are blacked out on both sides,
 * so only the area outside the containers is compared. The reference and mask
 * are single images; the psnr and blend filters repeat their last frame.
 */
export function psnrArgs(o: { first: string; start?: number; count: number; reference: string; mask?: string; maskGrow?: number }): string[] {
  const seq = o.start !== undefined;
  const inputs = [...(seq ? ['-start_number', String(o.start)] : []), '-i', o.first, '-i', o.reference, ...(o.mask ? ['-i', o.mask] : [])];
  const head = `[0:v]trim=end_frame=${o.count},format=gbrp[f];[1:v]format=gbrp[r]`;
  let graph = `${head};[f][r]psnr=stats_file=-`;
  if (o.mask) {
    const grow = Array.from({ length: Math.max(0, o.maskGrow ?? 2) }, () => 'dilation').join(',');
    const blackout = "blend=all_expr='if(gt(B,127),0,A)'";
    graph = `${head};[2:v]format=gray${grow ? `,${grow}` : ''},format=gbrp,split[m1][m2];`
      + `[f][m1]${blackout}[fa];[r][m2]${blackout}[ra];[fa][ra]psnr=stats_file=-`;
  }
  return [...QUIET, ...inputs, '-filter_complex', graph, '-f', 'null', '-'];
}

/** Mean brightness of the grown mask, printed as lavfi.signalstats.YAVG (0-255), so check can refuse a mask that covers the frame. */
export function maskCoverageArgs(mask: string, maskGrow = 2): string[] {
  const grow = Array.from({ length: maskGrow }, () => 'dilation');
  return [...QUIET, '-i', mask, '-vf', ['format=gray', ...grow, 'signalstats', 'metadata=print:key=lavfi.signalstats.YAVG:file=-'].join(','), '-f', 'null', '-'];
}

/** Fraction of the frame the mask covers, from maskCoverageArgs output; null when ffmpeg printed no YAVG. */
export function parseMaskCoverage(text: string): number | null {
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(text);
  return m ? Number(m[1]) / 255 : null;
}

/** PSNR of two same-size images, optionally cropped and lightly blurred first (the still-fidelity check). */
export function compareArgs(a: string, b: string, o: { blur?: number; crop?: string } = {}): string[] {
  const chain = (i: number) => [`[${i}:v]format=gbrp`, ...(o.crop ? [`crop=${o.crop}`] : []), ...(o.blur ? [`gblur=sigma=${o.blur}`] : [])].join(',');
  return [...QUIET, '-i', a, '-i', b, '-filter_complex', `${chain(0)}[a];${chain(1)}[b];[a][b]psnr=stats_file=-`, '-f', 'null', '-'];
}

export interface PsnrFrame { n: number; psnr: number }

/** Parse psnr=stats_file=- lines (n:1 mse_avg:... psnr_avg:inf ...). inf becomes Infinity. */
export function parsePsnrStats(text: string): PsnrFrame[] {
  const frames: PsnrFrame[] = [];
  for (const line of text.split('\n')) {
    const n = /(?:^|\s)n:(\d+)/.exec(line);
    const p = /psnr_avg:(inf|-?\d+(?:\.\d+)?)/.exec(line);
    if (!n || !p) continue;
    frames.push({ n: Number(n[1]), psnr: p[1] === 'inf' ? Infinity : Number(p[1]) });
  }
  return frames;
}

export type CheckId = 'seam' | 'empty-beat' | 'rest' | 'overflow';

export interface CheckJob {
  id: CheckId;
  /** What is compared, for the report line. */
  what: string;
  args: string[];
  /** Frames the job must report; fewer means ffmpeg stopped early. */
  expected: number;
}

export interface CheckOptions {
  /** Loop time (s) the dissolve starts; the rest check uses the last frame before it. */
  dissolveAt: number;
  /** Loop time (s) the empty beat starts. */
  emptyFrom: number;
  /** Loop time (s) the intro has landed; the cards overflow check starts here. */
  introEnd: number;
  layout: 'app' | 'cards';
  maskGrow: number;
}

/** Window frame indices whose page clock (mod cycle) lies in [fromMs, toMs). */
export function framesBetween(m: CaptureManifest, fromMs: number, toMs: number): number[] {
  const cycleMs = Math.round(m.cycle * 1000);
  const out: number[] = [];
  for (let i = m.windowStart + 1; i < m.windowStart + m.windowFrames; i++) {
    const t = m.clockMs[i]! % cycleMs;
    if (t >= fromMs && t < toMs) out.push(i);
  }
  return out;
}

/** The ffmpeg jobs for the seam, empty-beat, rest and (with a mask) overflow checks. */
export function planChecks(m: CaptureManifest, dir: string, o: CheckOptions): CheckJob[] | { error: string } {
  const cycleMs = Math.round(m.cycle * 1000);
  const ms = (s: number) => Math.round(s * 1000);
  if (!(o.introEnd < o.dissolveAt && o.dissolveAt <= o.emptyFrom && o.emptyFrom < m.cycle)) {
    return { error: `expected intro-end < dissolve-at <= empty-from < cycle (got ${o.introEnd} / ${o.dissolveAt} / ${o.emptyFrom} / ${m.cycle})` };
  }
  const seamB = m.windowStart + m.windowFrames;
  if (seamB >= m.frames) return { error: `the capture stops at frame ${m.frames - 1}; the seam check needs frame ${seamB} (recapture with --tail 10)` };
  const empty = framesBetween(m, ms(o.emptyFrom), cycleMs);
  const beforeDissolve = framesBetween(m, 0, ms(o.dissolveAt));
  const rest = beforeDissolve[beforeDissolve.length - 1];
  if (!empty.length || rest === undefined) return { error: 'the window holds no empty-beat or pre-dissolve frame; check --cycle against the page' };
  const start = path.join(dir, 'frames', '%05d.png');
  const empty0 = framePath(dir, m.windowStart);
  const still = path.join(dir, m.still);
  const jobs: CheckJob[] = [
    { id: 'seam', what: `frame ${m.windowStart} vs ${seamB}`, args: psnrArgs({ first: framePath(dir, m.windowStart), count: 1, reference: framePath(dir, seamB) }), expected: 1 },
    { id: 'empty-beat', what: `frames ${empty[0]}-${empty[empty.length - 1]} vs ${m.windowStart}`, args: psnrArgs({ first: start, start: empty[0], count: empty.length, reference: empty0 }), expected: empty.length },
    { id: 'rest', what: `frame ${rest} vs ${m.still}`, args: psnrArgs({ first: framePath(dir, rest), count: 1, reference: still }), expected: 1 },
  ];
  if (m.mask) {
    const mask = path.join(dir, m.mask);
    const span = o.layout === 'app'
      ? { from: m.windowStart, count: m.windowFrames, reference: empty0, label: `every window frame vs ${m.windowStart}` }
      : (() => {
        const story = framesBetween(m, ms(o.introEnd), ms(o.dissolveAt));
        if (story.length === 0) return null;
        return { from: story[0]!, count: story.length, reference: still, label: `story frames ${story[0]}-${story[story.length - 1]} vs ${m.still}` };
      })();
    if (!span) return { error: 'no window frame lies between intro-end and dissolve-at, so overflow has no story frames to check' };
    jobs.push({ id: 'overflow', what: `${span.label}, outside the mask`, args: psnrArgs({ first: start, start: span.from, count: span.count, reference: span.reference, mask, maskGrow: o.maskGrow }), expected: span.count });
  }
  return jobs;
}

export interface CheckVerdict { id: CheckId; pass: boolean; line: string }

/** One verdict per job: pass when ffmpeg reported every frame and each is at or above minDb (Infinity = identical). */
export function judgeCheck(job: CheckJob, frames: PsnrFrame[], minDb = Infinity): CheckVerdict {
  if (job.expected === 0 || frames.length < job.expected) {
    return { id: job.id, pass: false, line: `MOTION_CHECK: ${job.id} fail ffmpeg compared ${frames.length} of ${job.expected} frames (${job.what})` };
  }
  const bad = frames.filter(f => f.psnr < minDb);
  if (bad.length === 0) return { id: job.id, pass: true, line: `MOTION_CHECK: ${job.id} pass (${job.what})` };
  const worst = bad.reduce((a, b) => (b.psnr < a.psnr ? b : a));
  return { id: job.id, pass: false, line: `MOTION_CHECK: ${job.id} fail ${bad.length} frame(s) differ, worst ${worst.psnr.toFixed(2)} dB at compared frame ${worst.n} (${job.what})` };
}

/** Contact sheet: twelve frames spread across the window, tiled 4x3 at 480 px. */
export function contactSheetArgs(m: CaptureManifest, dir: string, out: string): string[] {
  const picks = Array.from({ length: 12 }, (_, k) => Math.round((k * (m.windowFrames - 1)) / 11));
  const select = picks.map(p => `eq(n\\,${p})`).join('+');
  return [...QUIET, '-start_number', String(m.windowStart), '-i', framePattern(dir),
    '-vf', `select='${select}',scale=480:-2,tile=4x3:padding=8:color=0x808080`, '-frames:v', '1', out];
}

export const FFMPEG_MISSING = 'FFMPEG_MISSING: ffmpeg is not installed or not on PATH (set GSTACK_FFMPEG to its full path). '
  + 'Install it: macOS "brew install ffmpeg"; Debian/Ubuntu "sudo apt-get install -y ffmpeg"; Fedora "sudo dnf install ffmpeg"; '
  + 'Windows "winget install Gyan.FFmpeg". Then rerun.';

/** GSTACK_FFMPEG when it names an existing file, else ffmpeg on PATH, else null. */
export function resolveFfmpeg(env: Record<string, string | undefined>, which: (bin: string) => string | null, exists: (p: string) => boolean): string | null {
  const override = env.GSTACK_FFMPEG?.trim();
  if (override) return exists(override) ? override : null;
  return which('ffmpeg');
}
