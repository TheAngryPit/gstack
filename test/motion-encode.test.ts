import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clockMs, planCapture } from '../lib/motion-capture';
import {
  compareArgs, contactSheetArgs, cropError, judgeCheck, loopGifArgs, manifestError, maskCoverageArgs, mp4Args, padError, parseMaskCoverage, parsePsnrStats, planChecks, psnrArgs,
  resolveFfmpeg, smallGifArgs, FFMPEG_MISSING, type CaptureManifest, type CheckJob, type CheckOptions,
} from '../lib/motion-encode';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-motion-encode');
const QUIET = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];

function manifest(cycle = 12, mask = true): CaptureManifest {
  const plan = planCapture({ cycleSeconds: cycle });
  return {
    schema: 1, target: 'page.html', width: 1440, height: 990, scale: 1200 / 990, fps: 60, cycle,
    pre: plan.pre, windowStart: plan.windowStart, windowFrames: plan.windowFrames, frames: plan.frames,
    clockMs: Array.from({ length: plan.frames }, (_, i) => clockMs(i, plan.pre)),
    loopTime: [], still: 'still.png', ...(mask ? { mask: 'mask.png' } : {}),
  };
}

const OPTS: CheckOptions = { dissolveAt: 11, emptyFrom: 11.6, introEnd: 2.4, layout: 'cards', maskGrow: 2 };

describe('export recipes', () => {
  const m = manifest();

  test('MP4 for X: H.264 yuv420p, 60 fps, CRF 15, preset slow, faststart, even crop, one cycle from the window start', () => {
    expect(mp4Args(m, '/c', '/c/n-x.mp4')).toEqual([...QUIET,
      '-start_number', '14', '-framerate', '60', '-i', '/c/frames/%05d.png', '-frames:v', '720',
      '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '/c/n-x.mp4']);
  });

  test('loop GIF: trim to the cycle, 20 fps, 960 wide lanczos, 192-colour diff palette, bayer 4, loop forever', () => {
    const args = loopGifArgs(m, '/c', '/c/n-loop.gif');
    expect(args.slice(args.indexOf('-filter_complex') + 1)).toEqual([
      'trim=end_frame=720,fps=20,scale=960:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
      '-loop', '0', '/c/n-loop.gif']);
  });

  test('800x500 GIF: optional content crop, fit, pad with the page background', () => {
    const args = smallGifArgs(m, '/c', '/c/n.gif', { crop: '1600:1000:72:100', pad: '#f4f1ea', fps: 12 });
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    expect(filter.startsWith('trim=end_frame=720,fps=12,crop=1600:1000:72:100,scale=800:500:force_original_aspect_ratio=decrease:flags=lanczos,pad=800:500:(ow-iw)/2:(oh-ih)/2:color=0xf4f1ea,split[a][b];')).toBe(true);
    expect(smallGifArgs(m, '/c', '/c/n.gif').join(' ')).toContain('fps=20,scale=800:500');
  });

  test('a crop must be 1.6:1', () => {
    expect(cropError('1600:1000:0:0')).toBeNull();
    expect(cropError('801:500:0:0')).toBeNull();
    expect(cropError('1000:1000:0:0')).toContain('width 1600');
    expect(cropError('1600x1000')).toContain('w:h:x:y');
  });

  // Value: protects=values that reach the ffmpeg filter graph (--pad, compare's --crop) are plain colours and w:h:x:y;
  //   fails_when=a value with ',' or ';' reaches the graph and adds filters or inputs; why_new=pad and compare's crop were unvalidated;
  //   seam=none; no_claim=validators only; the CLI refusal rows are in the exit-2 test below
  test('filter-graph values are validated: a hex pad and a w:h:x:y crop', () => {
    expect(padError('#f4f1ea')).toBeNull();
    expect(padError('f4f1eaff')).toBeNull();
    expect(padError('#fff')).toContain('hex colour');
    expect(padError('#ffffff,hue=s=0')).toContain('hex colour');
    expect(cropError('1000:1000:0:0', { ratio: false })).toBeNull();
    expect(cropError('100:100:0:0,hue=s=0', { ratio: false })).toContain('w:h:x:y');
  });

  test('the contact sheet tiles twelve frames from the first to the last of the window', () => {
    const args = contactSheetArgs(m, '/c', '/c/sheet.png');
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toContain(String.raw`eq(n\,0)+`);
    expect(vf).toContain(String.raw`eq(n\,719)'`);
    expect(vf).toContain('tile=4x3');
  });
});

describe('check planning', () => {
  test('seam, empty beat, rest and overflow compare the right frames', () => {
    const m = manifest();
    const jobs = planChecks(m, '/c', OPTS) as CheckJob[];
    expect(jobs.map(j => j.id)).toEqual(['seam', 'empty-beat', 'rest', 'overflow']);
    const [seam, empty, rest, overflow] = jobs;
    expect(seam!.what).toBe('frame 14 vs 734');
    expect(seam!.args).toContain('/c/frames/00014.png');
    expect(seam!.args).toContain('/c/frames/00734.png');
    // Empty beat: clock in [11.6 s, 12 s) inside the window, compared with the pre-start frame.
    const emptyFrames = Array.from({ length: m.frames }, (_, i) => i)
      .filter(i => i > 14 && i < 734 && m.clockMs[i]! >= 11_600);
    expect(empty!.expected).toBe(emptyFrames.length);
    expect(empty!.what).toBe(`frames ${emptyFrames[0]}-733 vs 14`);
    expect(empty!.args.slice(empty!.args.indexOf('-start_number'), empty!.args.indexOf('-start_number') + 2)).toEqual(['-start_number', String(emptyFrames[0])]);
    // Rest: the last frame whose clock is still before the dissolve.
    const restFrame = Math.max(...Array.from({ length: 734 }, (_, i) => i).filter(i => i > 14 && m.clockMs[i]! < 11_000));
    expect(rest!.what).toBe(`frame ${restFrame} vs still.png`);
    expect(m.clockMs[restFrame + 1]).toBeGreaterThanOrEqual(11_000);
    // Cards overflow: story frames (intro landed .. dissolve) against the still, through the mask.
    expect(overflow!.what).toContain('story frames');
    expect(overflow!.args.join(' ')).toContain('/c/mask.png');
    expect(overflow!.args.join(' ')).toContain('/c/still.png');
  });

  test('an app frame compares every window frame with the empty first frame', () => {
    const jobs = planChecks(manifest(), '/c', { ...OPTS, layout: 'app' }) as CheckJob[];
    const overflow = jobs.find(j => j.id === 'overflow')!;
    expect(overflow.expected).toBe(720);
    expect(overflow.what).toBe('every window frame vs 14, outside the mask');
  });

  test('no mask, no overflow job; bad phases and a short tail are refused', () => {
    expect((planChecks(manifest(12, false), '/c', OPTS) as CheckJob[]).map(j => j.id)).toEqual(['seam', 'empty-beat', 'rest']);
    expect((planChecks(manifest(), '/c', { ...OPTS, dissolveAt: 12.5 }) as { error: string }).error).toContain('intro-end < dissolve-at');
    const short = { ...manifest(), frames: 734 };
    expect((planChecks(short, '/c', OPTS) as { error: string }).error).toContain('--tail');
  });

  test('the mask is grown by one dilation per pixel and blacks out the containers on both sides', () => {
    const args = psnrArgs({ first: '/c/frames/%05d.png', start: 20, count: 5, reference: '/c/still.png', mask: '/c/mask.png', maskGrow: 3 });
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('format=gray,dilation,dilation,dilation,format=gbrp,split[m1][m2]');
    expect(graph).toContain("[f][m1]blend=all_expr='if(gt(B,127),0,A)'[fa]");
    expect(graph).toContain('[fa][ra]psnr=stats_file=-');
    expect(graph).toContain('trim=end_frame=5');
  });

  test('compare crops and blurs both sides the same way', () => {
    const args = compareArgs('a.png', 'b.png', { blur: 1.2, crop: '100:100:10:10' });
    expect(args[args.indexOf('-filter_complex') + 1]).toBe('[0:v]format=gbrp,crop=100:100:10:10,gblur=sigma=1.2[a];[1:v]format=gbrp,crop=100:100:10:10,gblur=sigma=1.2[b];[a][b]psnr=stats_file=-');
  });
});

describe('PSNR parsing and verdicts', () => {
  const STATS = [
    'n:1 mse_avg:0.00 mse_r:0.00 mse_g:0.00 mse_b:0.00 psnr_avg:inf psnr_r:inf psnr_g:inf psnr_b:inf',
    'n:2 mse_avg:1.53 mse_r:1.40 mse_g:1.60 mse_b:1.59 psnr_avg:46.28 psnr_r:46.67 psnr_g:46.09 psnr_b:46.12',
    'garbage line',
    'n:3 mse_avg:0.00 mse_r:0.00 mse_g:0.00 mse_b:0.00 psnr_avg:inf psnr_r:inf psnr_g:inf psnr_b:inf',
  ].join('\n');
  const job: CheckJob = { id: 'empty-beat', what: 'frames 711-733 vs 14', args: [], expected: 3 };

  test('inf becomes Infinity and junk lines are skipped', () => {
    expect(parsePsnrStats(STATS)).toEqual([{ n: 1, psnr: Infinity }, { n: 2, psnr: 46.28 }, { n: 3, psnr: Infinity }]);
    expect(parsePsnrStats('')).toEqual([]);
  });

  test('identical frames pass; one differing frame fails with its worst value', () => {
    const allInf = parsePsnrStats(STATS.replace('psnr_avg:46.28', 'psnr_avg:inf'));
    expect(judgeCheck(job, allInf)).toEqual({ id: 'empty-beat', pass: true, line: 'MOTION_CHECK: empty-beat pass (frames 711-733 vs 14)' });
    const v = judgeCheck(job, parsePsnrStats(STATS));
    expect(v.pass).toBe(false);
    expect(v.line).toBe('MOTION_CHECK: empty-beat fail 1 frame(s) differ, worst 46.28 dB at compared frame 2 (frames 711-733 vs 14)');
    expect(judgeCheck(job, parsePsnrStats(STATS), 45).pass).toBe(true);
  });

  test('fewer compared frames than planned is a failure, never a pass', () => {
    const v = judgeCheck({ ...job, expected: 23 }, parsePsnrStats(STATS.replace('psnr_avg:46.28', 'psnr_avg:inf')));
    expect(v.pass).toBe(false);
    expect(v.line).toContain('compared 3 of 23 frames');
    expect(judgeCheck({ ...job, expected: 0 }, []).pass).toBe(false);
  });

  // Value: protects=phase overrides that leave no story frame refuse the check instead of passing overflow on zero frames;
  //   fails_when=the empty-span guard is dropped and overflow reports pass for 'story frames undefined-undefined'; why_new=new guard; seam=none;
  //   no_claim=planning only
  test('a cards overflow with no story frames is a planning error', () => {
    const r = planChecks(manifest(), '/c', { ...OPTS, introEnd: 10.99, dissolveAt: 11 });
    expect(r).toEqual({ error: 'no window frame lies between intro-end and dissolve-at, so overflow has no story frames to check' });
  });

  // Value: protects=a capture.json this tool did not write cannot put text into ffmpeg filter graphs or paths outside the capture dir;
  //   fails_when=a field check is dropped and a string windowFrames or a ../ still reaches the encoder; why_new=new validator; seam=none;
  //   no_claim=validator only; the bin calls it before building any job
  test('a capture manifest is checked before its fields reach ffmpeg', () => {
    expect(manifestError(manifest())).toBeNull();
    expect(manifestError(manifest(12, false))).toBeNull();
    expect(manifestError({ ...manifest(), schema: 2 })).toContain('schema 1');
    expect(manifestError({ ...manifest(), windowFrames: '60,metadata=mode=print' })).toContain('windowFrames must be a non-negative integer');
    expect(manifestError({ ...manifest(), cycle: 0 })).toContain('cycle must be a positive number');
    expect(manifestError({ ...manifest(), clockMs: [0] })).toContain('one number per frame');
    expect(manifestError({ ...manifest(), still: '../still.png' })).toContain('still must be a .png file name');
    expect(manifestError({ ...manifest(), mask: 'mask.png,hue=s=0' })).toContain('mask must be a .png file name');
    expect(manifestError(null)).toContain('schema 1');
    expect(manifestError({ ...manifest(), fps: 0 })).toContain('at least 1');
    expect(manifestError({ ...manifest(), windowFrames: 1_000_000_000 })).toContain('runs past its frames');
  });

  test('mask coverage reads signalstats YAVG as a fraction of white', () => {
    const args = maskCoverageArgs('/c/mask.png', 2);
    expect(args[args.indexOf('-vf') + 1]).toBe('format=gray,dilation,dilation,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-');
    expect(parseMaskCoverage('frame:0    pts:0       pts_time:0\nlavfi.signalstats.YAVG=127.5\n')).toBe(0.5);
    expect(parseMaskCoverage('')).toBeNull();
  });
});

describe('ffmpeg is optional and named when missing', () => {
  test('resolution prefers GSTACK_FFMPEG, refuses a missing override, else uses PATH', () => {
    const which = (b: string) => (b === 'ffmpeg' ? '/usr/bin/ffmpeg' : null);
    expect(resolveFfmpeg({ GSTACK_FFMPEG: '/opt/ff' }, which, p => p === '/opt/ff')).toBe('/opt/ff');
    expect(resolveFfmpeg({ GSTACK_FFMPEG: '/opt/ff' }, which, () => false)).toBeNull();
    expect(resolveFfmpeg({}, which, () => true)).toBe('/usr/bin/ffmpeg');
    expect(resolveFfmpeg({}, () => null, () => true)).toBeNull();
  });

  test('the CLI prints FFMPEG_MISSING with install hints and exits 3', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-encode-'));
    try {
      const r = Bun.spawnSync([BIN, 'check', dir], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000, env: { ...process.env, GSTACK_FFMPEG: path.join(dir, 'no-ffmpeg') } });
      expect(r.exitCode).toBe(3);
      expect(r.stdout.toString().trim()).toBe(FFMPEG_MISSING);
      expect(r.stderr.toString()).toContain(`GSTACK_FFMPEG=${path.join(dir, 'no-ffmpeg')} does not exist`);
      expect(FFMPEG_MISSING).toContain('brew install ffmpeg');
      expect(FFMPEG_MISSING).toContain('apt-get install -y ffmpeg');
      expect(FFMPEG_MISSING).toContain('winget install');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a usage error exits 2 without touching ffmpeg', () => {
    const r = Bun.spawnSync([BIN, 'encode'], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000, env: { ...process.env, GSTACK_FFMPEG: '/nonexistent/ffmpeg' } });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain('Usage: gstack-motion-encode check');
  });

  // Value: protects=an unreadable capture, a bad --layout, impossible phases, a missing --name and a non-1.6:1 crop exit 2 before any ffmpeg run;
  //   fails_when=a guard is dropped and ffmpeg runs on bad input or the CLI exits 0/1; why_new=only the no-subcommand usage path was tested; seam=none;
  //   no_claim=a stand-in file satisfies GSTACK_FFMPEG resolution and is never executed, so real ffmpeg is not exercised
  test('bad captures and bad options exit 2 once ffmpeg resolves, before it runs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-encode-usage-'));
    try {
      const fake = path.join(dir, 'fake-ffmpeg');
      fs.writeFileSync(fake, '');
      const cli = (...args: string[]) => {
        const r = Bun.spawnSync([BIN, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000, env: { ...process.env, GSTACK_FFMPEG: fake } });
        return { code: r.exitCode, err: r.stderr.toString() };
      };
      const empty = path.join(dir, 'empty');
      fs.mkdirSync(empty);
      const missing = cli('check', empty);
      expect(missing.code).toBe(2);
      expect(missing.err).toContain('capture.json');
      expect(missing.err).toContain('capture first with gstack-motion-capture.ts');
      const cap = path.join(dir, 'cap');
      fs.mkdirSync(cap);
      fs.writeFileSync(path.join(cap, 'capture.json'), JSON.stringify(manifest()));
      expect(cli('check', cap, '--layout', 'grid')).toEqual({ code: 2, err: '--layout must be app or cards\n' });
      const phases = cli('check', cap, '--dissolve-at', '13');
      expect(phases.code).toBe(2);
      expect(phases.err).toContain('intro-end < dissolve-at <= empty-from < cycle');
      const name = cli('export', cap, '--name', 'Bad Name');
      expect(name.code).toBe(2);
      expect(name.err).toContain('--name <kebab-case-name> is required');
      const crop = cli('export', cap, '--name', 'ok', '--crop', '1000:1000:0:0');
      expect(crop.code).toBe(2);
      expect(crop.err).toContain('is not 1.6:1');
      // Value: protects=unknown flags, unknown formats, a non-hex pad, a malformed compare crop and missing frames exit 2 before ffmpeg;
      //   fails_when=a typo'd threshold or format is ignored, or export encodes a truncated capture and prints EXPORT_OK;
      //   why_new=these guards are new; seam=none; no_claim=the stand-in ffmpeg is never executed
      expect(cli('check', cap, '--dissolveat', '10').err).toContain("unknown option '--dissolveat' for check");
      expect(cli('check', cap, '--dissolveat', '10').code).toBe(2);
      expect(cli('export', cap, '--name', 'ok', '--formats', 'mp4,gif')).toMatchObject({ code: 2, err: expect.stringContaining("got 'gif'") });
      expect(cli('export', cap, '--name', 'ok', '--pad', '#ffffff,hue=s=0')).toMatchObject({ code: 2, err: expect.stringContaining('--pad must be a hex colour') });
      expect(cli('compare', 'a.png', 'b.png', '--crop', '1:1:0:0,hue=s=0')).toMatchObject({ code: 2, err: expect.stringContaining('--crop must be w:h:x:y') });
      expect(cli('export', cap, '--name', 'ok')).toMatchObject({ code: 2, err: expect.stringContaining('the capture is incomplete') });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
