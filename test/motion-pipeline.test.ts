/**
 * /design-motion capture -> check -> export, end to end on real Chromium and
 * real ffmpeg (bin/gstack-motion-capture.ts feeding bin/gstack-motion-encode).
 * The unit tests pin the argument lists and the PSNR parser on synthetic
 * lines; this file proves the two bins agree on the capture directory
 * (frame names from the window start, capture.json, still.png and mask.png at
 * the frame scale) and that the checks judge real ffmpeg output both ways.
 * The fixture page is a 0.5 s loop at 640x100 (captured 1920x300), so a run is
 * 54 frames. Self-skips when the Playwright Chromium bundle, ffmpeg or ffprobe
 * is missing.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium } from 'playwright';
import { clockMs, stepMs } from '../lib/motion-capture';
import { resolveFfmpeg, type CaptureManifest } from '../lib/motion-encode';

const ROOT = path.resolve(import.meta.dir, '..');
const CAPTURE = path.join(ROOT, 'bin', 'gstack-motion-capture.ts');
const ENCODE = path.join(ROOT, 'bin', 'gstack-motion-encode');
const CHROMIUM = process.env.GSTACK_CHROMIUM_PATH || (() => { try { return chromium.executablePath(); } catch { return ''; } })();
const FFMPEG = resolveFfmpeg(process.env, bin => Bun.which(bin), p => fs.existsSync(p));
const FFPROBE = Bun.which('ffprobe');
const READY = Boolean(CHROMIUM) && fs.existsSync(CHROMIUM) && Boolean(FFMPEG) && Boolean(FFPROBE) && process.platform !== 'win32';
const PHASES = ['--intro-end', '0.1', '--dissolve-at', '0.3', '--empty-from', '0.4', '--layout', 'cards'];

function page(o: { loops: boolean; contract?: boolean }): string {
  const contract = o.contract === false ? '' : `
  window.__lt = 0;
  window.__start = () => { window.__lt = 0; paint(0); };
  window.__tick = dt => { window.__lt = ${o.loops ? '(window.__lt + dt) % 0.5' : 'window.__lt + dt'}; paint(window.__lt); };`;
  return `<!doctype html><html><head><style>
html, body { margin: 0; background: #f4f1ea; }
.card { position: absolute; left: 40px; top: 20px; width: 400px; height: 60px; background: #fff; border-radius: 8px; overflow: hidden; }
.bar { position: absolute; left: 0; top: 20px; width: 80px; height: 20px; background: #2a6f4f; }
</style></head><body><section class="card"><div class="bar"></div></section><script>
const card = document.querySelector('.card');
const bar = document.querySelector('.bar');
function paint(lt) {
  card.style.visibility = lt >= 0.05 && ${o.loops ? 'lt < 0.3' : 'true'} ? 'visible' : 'hidden';
  bar.style.transform = 'translateX(' + Math.round(Math.min(1, Math.max(0, (lt - 0.05) / 0.1)) * 300) + 'px)';
}
if (location.search.slice(1).split('&').includes('still')) paint(0.25);
else { paint(0);${contract} }
</script></body></html>
`;
}

function run(argv: string[]) {
  const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', timeout: 150_000, env: process.env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function capture(dir: string, html: string, o: { mask?: string | false } = {}) {
  const file = path.join(dir, 'page.html');
  fs.writeFileSync(file, html);
  return run([CAPTURE, file, '--size', '640x100', '--cycle', '0.5', '--out', path.join(dir, 'cap'), ...(o.mask === false ? [] : ['--mask', o.mask ?? '.card'])]);
}

describe.skipIf(!READY)('design-motion pipeline on real Chromium and ffmpeg', () => {
  // Value: protects=a looping page captures 54 frames whose manifest, still and mask the encoder accepts, checks clean and exports a one-cycle MP4;
  //   fails_when=frame naming, start frame, tick units, still/mask scale or the export window drift between the two bins, a failed re-export
  //   truncates the last good file, or a GIF fps that drifts against the cycle is accepted; why_new=only the paid marathon case runs both bins;
  //   seam=none; no_claim=a 0.5 s synthetic loop stands in for an agent-built page; GIF quality and X upload acceptance are not checked
  test('a looping page captures, checks clean and exports one cycle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-pipeline-'));
    try {
      const cap = path.join(dir, 'cap');
      const c = capture(dir, page({ loops: true }));
      expect(c.code, c.err).toBe(0);
      expect(c.out.trim().split('\n').pop()).toBe(`CAPTURE_OK frames=54 window=14+30 scale=3.0000 dir=${cap}`);
      expect(fs.readdirSync(path.join(cap, 'frames')).sort()).toEqual(Array.from({ length: 54 }, (_, i) => `${String(i).padStart(5, '0')}.png`));
      expect(fs.existsSync(path.join(cap, 'still.png')) && fs.existsSync(path.join(cap, 'mask.png'))).toBe(true);
      const m = JSON.parse(fs.readFileSync(path.join(cap, 'capture.json'), 'utf-8')) as CaptureManifest;
      expect([m.scale, m.windowStart, m.windowFrames, m.frames, m.mask]).toEqual([3, 14, 30, 54, 'mask.png']);
      expect(m.loopTime.length).toBe(54);
      expect(m.loopTime.slice(0, 15).every(t => t === 0)).toBe(true);
      expect(m.loopTime[15]).toBeCloseTo(stepMs(15) / 1000, 9);
      for (let i = 15; i < 44; i++) expect(m.loopTime[i]!).toBeCloseTo(clockMs(i, 15) / 1000, 6);

      const check = run([ENCODE, 'check', cap, ...PHASES]);
      expect(check.code, check.out + check.err).toBe(0);
      for (const id of ['seam', 'empty-beat', 'rest', 'overflow']) expect(check.out).toContain(`MOTION_CHECK: ${id} pass`);
      expect(check.out).toContain(`CONTACT_SHEET ${path.join(cap, 'contact-sheet.png')}`);
      expect(check.out.trim().split('\n').pop()).toBe('MOTION_RESULT: clean');

      const exp = run([ENCODE, 'export', cap, '--name', 'pipe', '--formats', 'mp4,800', '--pad', '#f4f1ea']);
      expect(exp.code, exp.out + exp.err).toBe(0);
      const gifSize = fs.statSync(path.join(cap, 'pipe-800x500.gif')).size;
      const broken = run([ENCODE, 'export', cap, '--name', 'pipe', '--formats', '800', '--crop', '4000:2500:0:0']);
      expect(broken.code).toBe(1);
      expect(broken.out).toContain('EXPORT_FAILED pipe-800x500.gif');
      expect(fs.statSync(path.join(cap, 'pipe-800x500.gif')).size).toBe(gifSize);
      expect(fs.readdirSync(cap).filter(f => f.startsWith('.partial-'))).toEqual([]);
      const drift = run([ENCODE, 'export', cap, '--name', 'pipe', '--formats', 'loop', '--gif-fps', '7']);
      expect(drift.code).toBe(2);
      expect(drift.err).toContain('must be a whole fps from 1 to 50');
      expect(run([ENCODE, 'export', cap, '--name', 'pipe', '--formats', '800', '--small-fps', '60']).code).toBe(2);
      expect(exp.out).toContain(`EXPORT_OK ${path.join(cap, 'pipe-x.mp4')}`);
      expect(exp.out).toContain(`EXPORT_OK ${path.join(cap, 'pipe-800x500.gif')}`);
      const probe = run([FFPROBE!, '-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'csv=p=0', path.join(cap, 'pipe-x.mp4')]);
      expect(probe.out.trim()).toBe('1920,300,30');

      const same = run([ENCODE, 'compare', path.join(cap, 'still.png'), path.join(cap, 'still.png')]);
      expect(same.code).toBe(0);
      expect(same.out).toStartWith('PSNR inf dB');
      const sizes = run([ENCODE, 'compare', path.join(cap, 'still.png'), path.join(cap, 'contact-sheet.png')]);
      expect(sizes.code).toBe(1);
      expect(sizes.err).toContain('COMPARE_FAILED');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  // Value: protects=a page that never returns to its empty state fails the seam and empty-beat checks on real ffmpeg output and exits 1;
  //   fails_when=finite psnr_avg lines stop parsing or a failed job stops counting toward MOTION_RESULT; why_new=unit verdicts use hand-written stats lines; seam=none;
  //   no_claim=only the seam/empty-beat failure class; a rest or overflow failure is not reproduced here
  test('a page that does not loop fails the seam and the empty beat', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-pipeline-'));
    try {
      const c = capture(dir, page({ loops: false }));
      expect(c.code, c.err).toBe(0);
      const check = run([ENCODE, 'check', path.join(dir, 'cap'), ...PHASES]);
      expect(check.code).toBe(1);
      expect(check.out).toMatch(/MOTION_CHECK: seam fail 1 frame\(s\) differ, worst \d+\.\d\d dB at compared frame \d+ \(frame 14 vs 44\)/);
      expect(check.out).toMatch(/MOTION_CHECK: empty-beat fail \d+ frame\(s\) differ/);
      expect(check.out).toContain('MOTION_CHECK: rest pass');
      expect(check.out).toContain('MOTION_CHECK: overflow pass');
      expect(check.out.trim().split('\n').pop()).toBe('MOTION_RESULT: 2 failed');
      const relaxed = run([ENCODE, 'check', path.join(dir, 'cap'), ...PHASES, '--min-db', '0']);
      expect(relaxed.code, relaxed.out + relaxed.err).toBe(0);
      expect(relaxed.out).toMatch(/^MOTION_SETTINGS: .*--min-db 0; defaults otherwise$/m);
      const blank = run([ENCODE, 'check', path.join(dir, 'cap'), ...PHASES, '--min-db', '']);
      expect(blank.code).toBe(2);
      expect(blank.err).toContain("--min-db must be a non-negative number, got ''");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  // Value: protects=a page without window.__start/__tick stops with MOTION_CONTRACT_MISSING and exit 1 before writing capture.json;
  //   fails_when=the contract probe is dropped and frames of an unanimated page are recorded as a capture; why_new=no test loads a page in the capture bin; seam=none;
  //   no_claim=only the missing-contract case; a contract that throws mid-capture is not exercised
  test('a page without the capture contract is refused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-pipeline-'));
    try {
      const c = capture(dir, page({ loops: true, contract: false }));
      expect(c.code).toBe(1);
      expect(c.err).toContain('MOTION_CONTRACT_MISSING');
      expect(fs.existsSync(path.join(dir, 'cap', 'capture.json'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  // Value: protects=a capture reuses an --out only when its own marker is there: a foreign still.png is refused and kept, the retry after a
  //   refused page succeeds, and a later failed capture clears the previous manifest; the no-mask run ends 'clean (overflow not checked)'
  //   and an unbounded --mask-grow is refused; fails_when=the marker test, the cleanup, the no-mask result or the grow bound is dropped;
  //   why_new=review cycles found a refused retry and a deleted foreign dir; seam=none; no_claim=a crash mid-frame-loop is not simulated
  test('an --out is reused only when this tool wrote it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-pipeline-'));
    try {
      const cap = path.join(dir, 'cap');
      fs.mkdirSync(cap);
      fs.writeFileSync(path.join(cap, 'still.png'), 'not ours');
      const foreign = capture(dir, page({ loops: true, contract: false }));
      expect(foreign.code).toBe(2);
      expect(foreign.err).toContain('already holds still.png but no .gstack-motion-capture marker');
      expect(fs.readFileSync(path.join(cap, 'still.png'), 'utf-8')).toBe('not ours');
      fs.rmSync(path.join(cap, 'still.png'));

      const c = capture(dir, page({ loops: true, contract: false }));
      expect(c.code).toBe(1);
      expect(c.err).toContain('MOTION_CONTRACT_MISSING');
      const retry = capture(dir, page({ loops: true }), { mask: false });
      expect(retry.code, retry.err).toBe(0);
      expect(retry.out).toContain('CAPTURE_OK frames=54');
      const check = run([ENCODE, 'check', cap, ...PHASES]);
      expect(check.code, check.out + check.err).toBe(0);
      expect(check.out).toContain('MOTION_CHECK: overflow skipped');
      expect(check.out.trim().split('\n').pop()).toBe('MOTION_RESULT: clean (overflow not checked)');
      const grow = run([ENCODE, 'check', cap, ...PHASES, '--mask-grow', '33']);
      expect(grow.code).toBe(2);
      expect(grow.err).toContain('--mask-grow must be a whole number of pixels from 0 to 32');

      expect(capture(dir, page({ loops: true, contract: false })).code).toBe(1);
      expect(fs.existsSync(path.join(cap, 'capture.json')) || fs.existsSync(path.join(cap, 'still.png'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  // Value: protects=a mask that paints the whole frame fails overflow in a cards layout and is reported as not checked only for an app
  //   frame, instead of blacking out every pixel and passing; a --mask that matches nothing stops the capture before any frame;
  //   fails_when=the coverage guard, its app-only skip or the empty-mask check is dropped; why_new=adversarial review reproduced each;
  //   seam=none; no_claim=only a full-frame mask; the 90% line and a grow-driven failure are not swept
  test('a mask that covers the frame fails cards and is not checked for an app frame; an empty mask stops the capture', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-pipeline-'));
    try {
      expect(capture(dir, page({ loops: true }), { mask: 'html' }).code).toBe(0);
      const cards = run([ENCODE, 'check', path.join(dir, 'cap'), ...PHASES]);
      expect(cards.code).toBe(1);
      expect(cards.out).toMatch(/MOTION_CHECK: overflow fail the mask covers \d+% of the frame; in a cards layout mark only the card containers/);
      const app = run([ENCODE, 'check', path.join(dir, 'cap'), ...PHASES, '--layout', 'app']);
      expect(app.code, app.out + app.err).toBe(0);
      expect(app.out).toMatch(/MOTION_CHECK: overflow skipped \(the app frame's surfaces cover \d+% of the frame/);
      expect(app.out.trim().split('\n').pop()).toBe('MOTION_RESULT: clean (overflow not checked)');
      const empty = capture(dir, page({ loops: true }), { mask: '[data-nope]' });
      expect(empty.code).toBe(1);
      expect(empty.err).toContain("MOTION_MASK_EMPTY: --mask '[data-nope]' matches no element");
      expect(fs.readdirSync(path.join(dir, 'cap', 'frames'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  // Value: protects=a CSS transition that a story starts with a class toggle is seeked from the frame it appears, not from the last
  //   __mark, so it eases instead of popping; fails_when=new animations are seeded at __mark again; why_new=adversarial probe showed a
  //   story transition exported ~100 ms ahead while every check passed; seam=none; no_claim=one linear opacity transition
  test('a story transition started by a class toggle eases from the frame it starts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-pipeline-'));
    try {
      const c = capture(dir, `<!doctype html><html><head><style>html, body { margin: 0; background: #000; }
#s { position: absolute; inset: 0; background: #fff; opacity: 0; transition: opacity 0.2s linear; } #s.on { opacity: 1; }</style></head>
<body><div id="s"></div><script>const s = document.getElementById('s'); window.__lt = 0;
window.__start = () => { window.__lt = 0; window.__mark = performance.now(); };
window.__tick = dt => { window.__lt += dt; if (window.__lt >= 0.1) s.classList.add('on'); };
if (location.search.includes('still')) s.classList.add('on');</script></body></html>`, { mask: false });
      expect(c.code, c.err).toBe(0);
      const probe = run([FFMPEG!, '-hide_banner', '-loglevel', 'error', '-i', path.join(dir, 'cap', 'frames', '00026.png'), '-vf', 'format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']);
      const yavg = Number(/YAVG=([\d.]+)/.exec(probe.out)?.[1]);
      expect(yavg).toBeGreaterThan(90);
      expect(yavg).toBeLessThan(170);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  // Value: protects=a page whose __tick never returns stops with MOTION_CAPTURE_FAILED instead of hanging the capture forever;
  //   fails_when=the per-frame 10 s bound is dropped; why_new=adversarial probe hung at 100% renderer CPU; seam=none;
  //   no_claim=only a spinning __tick; a hung screenshot is not bounded
  test('a __tick that never returns fails the capture', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-pipeline-'));
    try {
      const c = capture(dir, '<!doctype html><body><script>window.__lt = 0; window.__start = () => {}; window.__tick = dt => { window.__lt += dt; if (window.__lt > 0.05) for (;;) {} };</script></body>', { mask: false });
      expect(c.code).toBe(1);
      expect(c.err).toMatch(/MOTION_CAPTURE_FAILED: frame \d+ took longer than 10 s/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  // Value: protects=an offscreen loading=lazy image no longer hangs the still render (img.decode() never settles on it), and --still writes
  //   one PNG at --scale (the Step 3 fidelity reference);
  //   fails_when=the eager switch and the 30 s bound are both dropped and --still waits forever; why_new=adversarial probe hung at 90 s; seam=none;
  //   no_claim=one lazy image on a local page; a slow network image is bounded only by the 30 s timer
  test('a page with an offscreen lazy image renders its still', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-pipeline-'));
    try {
      fs.writeFileSync(path.join(dir, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
      const file = path.join(dir, 'lazy.html');
      fs.writeFileSync(file, '<!doctype html><body style="margin:0"><div style="height:5000px"></div><img loading="lazy" src="dot.png" width="4" height="4"></body>');
      const out = path.join(dir, 'still.png');
      const still = run([CAPTURE, file, '--size', '640x100', '--still', out, '--scale', '2']);
      expect(still.code, still.err).toBe(0);
      expect(still.out.trim()).toBe(`STILL_OK ${out}`);
      expect(still.err).not.toContain('still loading');
      const png = fs.readFileSync(out);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 200]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 200_000);
});
