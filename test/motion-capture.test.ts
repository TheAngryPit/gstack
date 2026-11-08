import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import {
  captureScale, clockMs, maskCss, parseCaptureArgs, planCapture, stepMs, withMode, type CaptureOptions,
} from '../lib/motion-capture';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-motion-capture.ts');

describe('capture timing', () => {
  test('steps are whole milliseconds averaging 1000/60', () => {
    expect(Array.from({ length: 6 }, (_, i) => stepMs(i))).toEqual([17, 16, 17, 17, 16, 17]);
    const steps = Array.from({ length: 720 }, (_, i) => stepMs(i));
    expect(steps.every(s => s === 16 || s === 17)).toBe(true);
    expect(steps.slice(0, 60).reduce((a, b) => a + b, 0)).toBe(1000);
    expect(steps.reduce((a, b) => a + b, 0)).toBe(12_000);
  });

  test('the page clock is 0 before the start and sums the steps from PRE on', () => {
    expect(clockMs(0, 15)).toBe(0);
    expect(clockMs(14, 15)).toBe(0);
    expect(clockMs(15, 15)).toBe(stepMs(15));
    let sum = 0;
    for (let i = 15; i < 200; i++) {
      sum += stepMs(i);
      expect(clockMs(i, 15)).toBe(sum);
    }
  });

  test('the seam frame lands exactly one cycle after the window start for any PRE and cycle', () => {
    for (const cycle of [4, 6, 12, 12.5, 15]) {
      for (let pre = 2; pre <= 30; pre++) {
        const plan = planCapture({ cycleSeconds: cycle, pre });
        expect(clockMs(plan.windowStart, pre)).toBe(0);
        expect(clockMs(plan.windowStart + plan.windowFrames, pre)).toBe(cycle * 1000);
        expect(plan.frames).toBeGreaterThan(plan.windowStart + plan.windowFrames);
      }
    }
  });

  test('a default 12 s plan records PRE, one cycle from PRE - 1, and 10 frames past it', () => {
    expect(planCapture({ cycleSeconds: 12 })).toEqual({ pre: 15, windowStart: 14, windowFrames: 720, tail: 10, frames: 744 });
  });

  test('the scale puts the long side on 1920x1200', () => {
    expect(captureScale(1440, 990)).toBeCloseTo(1200 / 990, 10);
    expect(Math.floor(1440 * captureScale(1440, 990))).toBe(1745);
    expect(captureScale(1920, 1080)).toBe(1);
    expect(captureScale(600, 400)).toBe(3);
    // Value: protects=a portrait frame scales its long side to 1920 and short side within 1200, like a landscape one;
    //   fails_when=the scale again treats width as the long side and under-scales phone frames; why_new=every case above is landscape;
    //   seam=none; no_claim=scale math only; the capture's screenshot size is covered by test/motion-pipeline.test.ts
    expect(captureScale(390, 844)).toBeCloseTo(1920 / 844, 10);
    expect(captureScale(1080, 1920)).toBe(1);
  });
});

describe('capture arguments', () => {
  test('a capture and a still parse', () => {
    expect(parseCaptureArgs(['page.html', '--size', '1440x990', '--cycle', '12', '--out', 'cap', '--mask', '.card'])).toEqual({
      target: 'page.html', width: 1440, height: 990, out: 'cap', still: undefined, cycle: 12, scale: undefined, pre: 15, tail: 10, mask: '.card',
    } satisfies CaptureOptions);
    const still = parseCaptureArgs(['https://example.com/a', '--size', '640x400', '--still', 'ref.png', '--scale', '2']) as CaptureOptions;
    expect([still.still, still.scale, still.out]).toEqual(['ref.png', 2, undefined]);
  });

  test('each bad invocation names its problem', () => {
    const err = (argv: string[]) => (parseCaptureArgs(argv) as { error: string }).error;
    expect(err(['--size', '10x10'])).toContain('name the page');
    expect(err(['p.html', '--cycle', '12', '--out', 'c'])).toContain('--size');
    expect(err(['p.html', '--size', '640x400', '--out', 'c'])).toContain('--cycle');
    expect(err(['p.html', '--size', '640x400', '--cycle', '4'])).toContain('--out');
    expect(err(['p.html', '--size', '640x400', '--cycle', '4', '--out', 'c', '--still', 's.png'])).toContain('not both');
    expect(err(['p.html', '--size', '640x400', '--cycle', '4', '--out', 'c', '--pre', '1'])).toContain('--pre');
    expect(err(['p.html', '--size', '640x400', '--cycle', 'abc', '--out', 'c'])).toContain('positive number');
    expect(err(['p.html', '--size', '640x400', '--still', 's.jpg'])).toContain('.png');
    expect(err(['p.html', '--size', '640x400', '--still', 's.png', '--mask', '.card'])).toContain('--mask');
    expect(err(['p.html', '--size', '640x400', '--cycle', '4', '--out', 'c', '--scale', '2'])).toContain('--scale');
    expect(err(['p.html', '--size', '640x400', '--fps', '30'])).toContain("unknown option '--fps'");
    expect(err(['p.html', 'q.html', '--size', '640x400'])).toContain("unexpected argument 'q.html'");
    expect(err(['p.html', '--size'])).toContain('needs a value');
    expect(err(['p.html', '--size', '640x400', '--cycle', '4', '--out', 'c', '--mask', '.card} body {'])).toContain('--mask takes a CSS selector');
    // Value: protects=a degenerate frame, a zero cycle and a fractional tail are refused at parse time with exit-2 wording;
    //   fails_when=the size floor, the >0 check or the tail integer check is dropped; why_new=no row hit these three guards; seam=none;
    //   no_claim=parser only; Chromium's behaviour on such a frame is not exercised
    expect(err(['p.html', '--size', '10x10', '--still', 's.png'])).toContain('--size 10x10 is too small');
    expect(err(['p.html', '--size', '640x400', '--cycle', '0', '--out', 'c'])).toContain("--cycle must be a positive number, got '0'");
    expect(err(['p.html', '--size', '640x400', '--cycle', '4', '--out', 'c', '--tail', '2.5'])).toContain('--tail must be a whole number');
    // Value: protects=a cycle that is not a multiple of 0.05 s is refused with a nearest cycle the same guard accepts;
    //   fails_when=the guard is dropped or loosened to whole frames, where the seam frame's clock depends on PRE; why_new=new guard;
    //   seam=none; no_claim=parser and clock math only
    expect(err(['p.html', '--size', '640x400', '--cycle', '6.01', '--out', 'c'])).toContain('--cycle must be a multiple of 0.05 s');
    expect(err(['p.html', '--size', '640x400', '--cycle', '6.01', '--out', 'c'])).toContain('nearest: 6)');
    expect(err(['p.html', '--size', '640x400', '--cycle', '0.5167', '--out', 'c'])).toContain('nearest: 0.5)');
    expect(err(['p.html', '--size', '640x400', '--cycle', '0.01', '--out', 'c'])).toContain('nearest: 0.05)');
    expect(parseCaptureArgs(['p.html', '--size', '640x400', '--cycle', '0.55', '--out', 'c'])).not.toHaveProperty('error');
    expect(new Set([14, 15, 16, 17].map(pre => clockMs(pre - 1 + 31, pre)))).toEqual(new Set([516, 517]));
    for (const pre of [14, 15, 16, 17]) expect(clockMs(pre - 1 + 33, pre)).toBe(550);
  });

  test('modes keep the existing query and fragment', () => {
    expect(withMode('file:///tmp/page.html', 'capture')).toBe('file:///tmp/page.html?capture');
    expect(withMode('https://x.dev/y?a=1#top', 'still')).toBe('https://x.dev/y?a=1&still#top');
  });

  test('the mask paints only the matched containers white', () => {
    const css = maskCss('.card, .panel');
    expect(css).toContain('* { visibility: hidden !important;');
    expect(css).toContain('.card, .panel { visibility: visible !important; background: #fff !important;');
    expect(css).toContain('box-shadow: none !important');
  });
});

describe('gstack-motion-capture CLI', () => {
  test('a usage error exits 2 before any browser starts', () => {
    const r = Bun.spawnSync([BIN, 'page.html', '--size', '640x400'], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain('--out <dir> is required');
    expect(r.stderr.toString()).toContain('Usage:');
  });

  test('a missing page file exits 2', () => {
    const r = Bun.spawnSync([BIN, path.join(ROOT, 'no-such-page.html'), '--size', '640x400', '--still', '/tmp/x.png'], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain('does not exist');
  });
});
