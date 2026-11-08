#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// gstack-motion-capture — deterministic frame capture for /design-motion.
//
//   gstack-motion-capture.ts <page.html|url> --size <W>x<H> --cycle <s> --out <dir> [--pre 15] [--tail 10] [--mask <css>]
//   gstack-motion-capture.ts <page.html|url> --size <W>x<H> --still <out.png> [--scale <n>]
//
// A capture never records in real time. It installs Playwright's fake clock,
// loads <page>?capture, and for each frame advances the clock by whole
// milliseconds averaging 1000/60, calls window.__start() on frame PRE and
// window.__tick(dt) from then on inside the same evaluate, seeks every CSS
// animation to the fake clock from window.__mark (the page sets it when its
// state classes change; 0 when absent) or, for an animation first seen in a
// frame where __mark did not move (a story's class toggle), from that frame,
// and screenshots. Output in <dir>:
// frames/%05d.png, still.png (<page>?still at the capture scale, CSS animations
// finished), mask.png with --mask, and
// capture.json (sizes, window, per-frame clock and loop time) for
// gstack-motion-encode. --still renders <page>?still alone (--scale 2 for the
// fidelity reference).
//
// Chromium is gstack's own Playwright Chromium (bin/gstack-browser-ensure
// installs it); GSTACK_CHROMIUM_PATH overrides it and GSTACK_CHROMIUM_NO_SANDBOX=1
// adds --no-sandbox, as for the browse daemon. Last line: CAPTURE_OK ... (exit 0),
// or an error naming its code (exit 1 browser or page, exit 2 usage).
//
// Adapted from Elaya's design-to-motion (MIT, (c) 2026 Elaya). See NOTICE.md.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  CAPTURE_USAGE, captureScale, clockMs, maskCss, parseCaptureArgs, planCapture, stepMs, withMode, FPS,
} from '../lib/motion-capture';

function die(code: number, line: string): never {
  console.error(line);
  process.exit(code);
}

const parsed = parseCaptureArgs(process.argv.slice(2));
if ('error' in parsed) die(2, `gstack-motion-capture: ${parsed.error}\n${CAPTURE_USAGE}`);
const opts = parsed;
if (process.platform === 'win32') {
  die(1, 'MOTION_CAPTURE_UNSUPPORTED: Bun cannot launch Chromium on native Windows; run the capture from WSL, macOS or Linux');
}

let url = opts.target;
if (!/^https?:\/\//i.test(url)) {
  const file = path.resolve(url);
  if (!fs.existsSync(file)) die(2, `gstack-motion-capture: ${url} does not exist`);
  url = pathToFileURL(file).href;
}

const { chromium } = await import('playwright');
const executablePath = process.env.GSTACK_CHROMIUM_PATH || undefined;
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: process.env.GSTACK_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
}).catch((err: Error) => die(1, `BROWSER_UNAVAILABLE ${String(err.message).split('\n')[0]}\nfix: run ${path.join(import.meta.dir, 'gstack-browser-ensure')}, or point GSTACK_CHROMIUM_PATH at a working Chromium`));

async function openPage(mode: 'capture' | 'still', scale: number) {
  const context = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: scale, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  await page.clock.install({ time: 0 });
  await page.goto(withMode(url, mode), { waitUntil: 'load' });
  const settled = page.evaluate(async () => {
    await document.fonts.ready;
    for (const img of document.images) img.loading = 'eager';
    await Promise.all([...document.images].map(img => img.decode().catch(() => undefined)));
  }).then(() => true);
  if (!await Promise.race([settled, new Promise<false>(resolve => setTimeout(resolve, 30_000, false).unref())])) {
    console.error('gstack-motion-capture: fonts or images were still loading after 30 s; rendering anyway');
  }
  await page.clock.pauseAt(Math.max(10_000, await page.evaluate(() => Date.now()) + 1_000));
  return page;
}

try {
  if (opts.still) {
    const page = await openPage('still', opts.scale ?? captureScale(opts.width, opts.height));
    fs.mkdirSync(path.dirname(path.resolve(opts.still)), { recursive: true });
    await page.screenshot({ path: opts.still, animations: 'disabled' });
    console.log(`STILL_OK ${opts.still}`);
  } else {
    const out = path.resolve(opts.out!);
    const scale = captureScale(opts.width, opts.height);
    const plan = planCapture({ cycleSeconds: opts.cycle!, pre: opts.pre, tail: opts.tail });
    const marker = path.join(out, '.gstack-motion-capture');
    const present = ['frames', 'capture.json', 'still.png', 'mask.png', 'contact-sheet.png'].filter(f => fs.existsSync(path.join(out, f)));
    if (present.length > 0 && !fs.existsSync(marker)) {
      die(2, `gstack-motion-capture: ${out} already holds ${present.join(', ')} but no .gstack-motion-capture marker, so this tool did not write it; pick an empty --out`);
    }
    for (const f of present) fs.rmSync(path.join(out, f), { recursive: true, force: true });
    fs.mkdirSync(path.join(out, 'frames'), { recursive: true });
    fs.writeFileSync(marker, '');
    const page = await openPage('capture', scale);
    const contract = await page.evaluate(() => typeof (window as any).__start === 'function' && typeof (window as any).__tick === 'function');
    if (!contract) die(1, `MOTION_CONTRACT_MISSING: ${opts.target}?capture does not expose window.__start() and window.__tick(dt); add the capture mode before recording`);
    if (opts.mask && await page.evaluate(selector => document.querySelectorAll(selector).length, opts.mask) === 0) {
      die(1, `MOTION_MASK_EMPTY: --mask '${opts.mask}' matches no element on ${opts.target}; mark each clip container with data-motion-clip or fix the selector`);
    }
    const loopTime: number[] = [];
    for (let i = 0; i < plan.frames; i++) {
      const dt = stepMs(i);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stuck = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`frame ${i} took longer than 10 s; a __tick, timer or animation callback never returned`)), 10_000);
      });
      loopTime.push(await Promise.race([stuck, page.clock.runFor(dt).then(() => page.evaluate(([i, pre, dt]) => {
        const w = window as any;
        if (i === pre) w.__start();
        if (i >= pre) w.__tick(dt / 1000);
        const now = performance.now();
        const mark = w.__mark ?? 0;
        const marked = mark !== w.__seenMark;
        w.__seenMark = mark;
        for (const a of document.getAnimations() as any[]) {
          a.__m ??= marked ? mark : now;
          a.pause();
          a.currentTime = Math.max(0, now - a.__m);
        }
        return i >= pre ? Number(w.__lt) || 0 : 0;
      }, [i, plan.pre, dt] as const))]).finally(() => clearTimeout(timer)));
      await page.screenshot({ path: path.join(out, 'frames', `${String(i).padStart(5, '0')}.png`) });
    }
    const still = await openPage('still', scale);
    await still.screenshot({ path: path.join(out, 'still.png'), animations: 'disabled' });
    if (opts.mask) {
      await still.addStyleTag({ content: maskCss(opts.mask) });
      await still.screenshot({ path: path.join(out, 'mask.png'), animations: 'disabled' });
    }
    const manifest = {
      schema: 1, target: opts.target, width: opts.width, height: opts.height, scale, fps: FPS, cycle: opts.cycle!,
      pre: plan.pre, windowStart: plan.windowStart, windowFrames: plan.windowFrames, frames: plan.frames,
      clockMs: Array.from({ length: plan.frames }, (_, i) => clockMs(i, plan.pre)), loopTime,
      still: 'still.png', ...(opts.mask ? { mask: 'mask.png' } : {}),
    };
    fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`CAPTURE_OK frames=${plan.frames} window=${plan.windowStart}+${plan.windowFrames} scale=${scale.toFixed(4)} dir=${out}`);
  }
} catch (err) {
  die(1, `MOTION_CAPTURE_FAILED: ${String((err as Error).message).split('\n')[0]}`);
} finally {
  await browser.close();
}
