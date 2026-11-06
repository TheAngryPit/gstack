/**
 * The render tier: what only a browser can measure. Drives the same engine
 * gstack-render picks (Aside when it is running, otherwise gstack's own
 * headless browser) through lib/aside-render, so nothing is installed and no
 * puppeteer is needed. Each page is opened once, the probes in
 * render-probe*.ts are installed, and one eval runs per viewport; a second
 * pass takes full-page screenshots only when a contrast claim needs the
 * painted pixels behind it (hallmark's pixelBehind and pixelsAroundRing).
 *
 * Ported from Nutlope/hallmark's sloplint-render.mjs renderCheck (MIT, see
 * NOTICE.md). Gates covered here and in the probe files: 23, 25, 26a, 34, 40,
 * 41, 44a, 44b, 44c, 44d, 49a, 49b, 58, 71, 72, 73, 75, 77, 78, 79, 80, 81,
 * 82, 83, F17, F18, F19, F20, plus the page that did not render.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pickEngine, render, renderWithBrowse, type EngineChoice, type RenderResult as EngineResult, type RenderSpec, type RenderStep } from '../aside-render';
import { contrastRatio } from './color';
import { CONTRAST_SLACK, lineIndex } from './css';
import { escapeRe, parseHtml, plainText } from './html';
import { decodePng, medianRgb, type SampleRect } from './render-png';
import { installScript, probeScript, type PixelItem, type ProbeAt, type ProbeFinding, type RingProbe, type SetupReport } from './render-probe';
import { Reporter, type Finding } from './report';
import { ruleMeta } from './rules/ids';

export interface RenderOptions {
  cwd?: string;
  scope?: 'page' | 'component';
  /** Replaces the engine choice (tests inject one); defaults to lib/aside-render's pickEngine. */
  engine?: () => EngineChoice;
  /** Replaces the page runner itself, so every answer the browser could give (none, null, malformed, a probe error) can be settled without a browser. */
  run?: Runner;
}

export interface RenderResult {
  findings: Finding[];
  /** 'ran', or 'skipped: <reason>' naming why no page was measured. */
  status: string;
}

const WIDTHS = [320, 375, 414, 768, 1024, 1280, 1920];
const LAPTOP = { width: 1440, height: 900 };
/** The viewport of the contrast walk and of the pixel pass that confirms it. */
const CONTRAST_VIEW = { width: 1280, height: 800 };
const RING_FLOOR = 2.95;
const RENDER_TIMEOUT_MS = 120_000;

export type Runner = (spec: RenderSpec) => Promise<EngineResult>;

export async function lintRender(targets: string[], opts: RenderOptions = {}): Promise<RenderResult> {
  if (!targets.length) return { findings: [], status: 'skipped: no HTML page to render' };
  let run = opts.run;
  if (!run) {
    const choice = (opts.engine ?? pickEngine)();
    if (!choice.engine) return { findings: [], status: `skipped: ${choice.error}` };
    run = (spec) => (choice.engine === 'browse' ? renderWithBrowse(spec, choice.bin) : render(spec));
  }
  const r = new Reporter(opts.scope ?? 'page', opts.cwd ?? process.cwd());
  for (const target of targets) {
    try { await lintPage(target, r, run); } catch (e) {
      r.report('render', isUrl(target) ? target : path.resolve(target), 1, `the page could not be measured: ${(e as Error).message}`, { source: 'render' });
    }
  }
  return { findings: r.findings, status: 'ran' };
}

const isUrl = (t: string): boolean => /^https?:\/\//.test(t);

async function unreachable(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
    return res.ok || res.status === 304 ? null : `HTTP ${res.status}`;
  } catch (e) {
    return (e as Error).message;
  }
}

interface Measure { label: string; width: number; height: number; call: string }

/** The first pass: one eval per viewport, the 1280 one carrying the fold, contrast and accent walks. */
function measures(): Measure[] {
  const m: Measure[] = WIDTHS.map((w) => ({ label: `${w}px`, width: w, height: CONTRAST_VIEW.height, call: w === CONTRAST_VIEW.width ? 'P.layout(P, true).concat(P.contrast(P), P.accent(P))' : 'P.layout(P, false)' }));
  m.push({ label: `${LAPTOP.width}px`, ...LAPTOP, call: 'P.space(P, true)' });
  m.push({ label: '1920px', width: 1920, height: 1080, call: 'P.space(P, false)' });
  for (const call of ['P.quality(P)', 'P.occlusion(P)', 'P.focus(P)']) m.push({ label: `${LAPTOP.width}px`, ...LAPTOP, call });
  return m;
}

const evalStep = (call: string, width: number, height: number): RenderStep =>
  ({ kind: 'eval', expression: probeScript(call), width, height, deviceScaleFactor: 1, mobile: false, maxInline: 200_000 });

/** The probes are installed by a step of their own: its value is not read, so whatever wrapper the engine puts around 70KB of source does not matter. */
const openingSteps = (): RenderStep[] => [{ kind: 'eval', expression: installScript(), width: LAPTOP.width, height: LAPTOP.height, deviceScaleFactor: 1, mobile: false, maxInline: 10 }, evalStep('P.setup(P)', LAPTOP.width, LAPTOP.height)];

type Parsed<T> = { value: T } | { error: string };

function parsed<T>(text: string | undefined): Parsed<T> {
  if (text === undefined) return { error: 'no result came back' };
  try {
    const v = JSON.parse(text) as T | { error: string } | null;
    if (v === null) return { error: 'empty result' };
    if (typeof v === 'object' && 'error' in v && typeof v.error === 'string') return { error: v.error };
    return { value: v as T };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** A probe's locator field: a string no longer than a class name or an opening line could be; anything else locates nothing. */
const SHORT = (v: unknown): v is string => typeof v === 'string' && v.length <= 400;

/** The source line of the element a finding names: its tag, first class, a distinguishing attribute and its opening text. Best effort; 1 when nothing matches, or when the locator is not shaped like one the probes emit. */
export function lineOf(src: string | null, at?: ProbeAt, lineAt: (i: number) => number = src ? lineIndex(src) : () => 1): number {
  if (!src || !at || !SHORT(at.tag) || !/^[a-z]/i.test(at.tag) || !SHORT(at.text)) return 1;
  const cls = SHORT(at.cls) && at.cls ? at.cls : null;
  const attr = SHORT(at.attr) && at.attr ? at.attr : null;
  const want = at.text.toLowerCase();
  let fallback = -1;
  for (const m of src.matchAll(new RegExp(`<${escapeRe(at.tag)}\\b[^>]*>`, 'gi'))) {
    const pos = m.index ?? 0;
    if (cls && !(/(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[0]) ?? ['', '']).slice(1).join(' ').split(/\s+/).includes(cls)) continue;
    if (attr && !m[0].includes(attr)) continue;
    if (!want) { fallback = pos; break; }
    if (plainText(src.slice(pos + m[0].length, pos + m[0].length + 600)).toLowerCase().startsWith(want)) { fallback = pos; break; }
    if (fallback < 0) fallback = pos;
  }
  return fallback < 0 ? 1 : lineAt(fallback);
}

const isRgb = (v: unknown): v is number[] => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n));

/** Whether a page's finding carries a pixel probe the lint can act on; a probe of another shape is dropped so the computed ratio stands. */
const probeOk = (f: ProbeFinding): boolean => !f.probe || (typeof f.probe === 'object' && typeof f.probe.path === 'string' && isRgb(f.probe.fg) && typeof f.probe.threshold === 'number');

/** Whether a focus-walk entry has the shape the ring confirmation reads. */
const ringOk = (x: RingProbe): boolean => typeof x.key === 'string' && typeof x.path === 'string' && typeof x.bare === 'boolean'
  && (x.ratio == null || (typeof x.ratio === 'number' && Number.isFinite(x.ratio) && (x.ratio >= RING_FLOOR || isRgb(x.ring))));

interface Found extends ProbeFinding { label: string }

async function lintPage(target: string, r: Reporter, run: Runner): Promise<void> {
  const file = isUrl(target) ? target : path.resolve(target);
  let lineAt: (i: number) => number = () => 1;
  const report = (f: Found | ProbeFinding, src: string | null) => {
    const meta = ruleMeta(f.rule);
    if (!meta || (f.grade !== 'fail' && f.grade !== 'warn')) {
      r.report('render', file, 1, `the page handed back a measurement the lint does not know (${String(f.rule).slice(0, 40)}); its scripts may be tampering with the probes`, { fix: 'a page must not touch the lint; remove whatever redefines window.__gstackLint or the layout APIs', source: 'render' });
      return;
    }
    r.report(f.rule, file, lineOf(src, f.at, lineAt), ('label' in f ? `[${f.label}] ` : '') + f.evidence, { fix: f.fix, suspected: f.grade === 'warn', source: 'render' });
  };
  if (isUrl(target)) {
    const err = await unreachable(target);
    if (err) { report({ rule: 'render', grade: 'fail', evidence: `could not reach ${target}: ${err}` }, null); return; }
  }
  let src: string | null = null;
  if (!isUrl(target)) { try { src = parseHtml(file, fs.readFileSync(file, 'utf8')).src; } catch { src = null; } }
  if (src) lineAt = lineIndex(src);
  const plan = measures();
  const opening = openingSteps();
  const steps: RenderStep[] = [...opening, ...plan.map((m) => evalStep(m.call, m.width, m.height))];
  const res = await run({ file, steps, timeoutMs: RENDER_TIMEOUT_MS });
  if (!res.ok) { report({ rule: 'render', grade: 'fail', evidence: `the page did not render: ${res.error ?? 'unknown error'}` }, null); return; }

  const setup = parsed<SetupReport>(res.evals[opening.length - 1]);
  if ('error' in setup || !Array.isArray(setup.value?.lost)) report({ rule: 'render', grade: 'fail', evidence: `the page could not be prepared for measurement: ${'error' in setup ? setup.error : 'the setup answer has no list of lost assets'}` }, null);
  else if (setup.value.lost.length) report({ rule: 'render', grade: 'warn', evidence: `fonts or stylesheets did not load (${setup.value.lost.slice(0, 2).join(', ')}): the measurements show a fallback face`, fix: 'fix the path or wait for the host, then measure again; never sign off a fallback face' }, null);
  const errs = parsed<string[]>(res.stdout.match(/^PAGE_ERRORS=(.+)$/m)?.[1]);
  const uncaught = 'value' in errs && Array.isArray(errs.value) ? errs.value.find((e) => typeof e === 'string' && e.startsWith('uncaught: ')) : undefined;
  if (uncaught) report({ rule: 'render', grade: 'fail', evidence: `a script threw on load: ${uncaught.slice(10, 100)}`, fix: 'fix the script; a page that throws ships half-working' }, null);

  const found: Found[] = [];
  let rings: RingProbe[] = [];
  const seen = new Map<string, Found>();
  plan.forEach((m, i) => {
    const p = parsed<ProbeFinding[] | RingProbe[]>(res.evals[opening.length + i]);
    const list = 'error' in p ? null : (p.value as unknown);
    const bad = 'error' in p ? p.error : !Array.isArray(list) ? 'the answer is not a list' : (list as unknown[]).some((f) => !f || typeof f !== 'object') ? 'the list holds a non-object entry' : null;
    if (bad != null) { report({ rule: 'render', grade: 'fail', evidence: `the ${m.call.replace(/^P\.(\w+).*/, '$1')} measurement at ${m.label} failed: ${bad}` }, null); return; }
    if (m.call === 'P.focus(P)') {
      rings = (list as RingProbe[]).filter(ringOk);
      if (rings.length < (list as RingProbe[]).length) report({ rule: 'focus', grade: 'malformed' as ProbeFinding['grade'], evidence: '' }, null);
      return;
    }
    for (const f of list as ProbeFinding[]) {
      if (typeof f.rule !== 'string' || typeof f.evidence !== 'string' || (f.grade !== 'fail' && f.grade !== 'warn') || !ruleMeta(f.rule)) { report({ rule: String(f.rule ?? '?'), grade: 'malformed' as ProbeFinding['grade'], evidence: '' }, null); continue; }
      const key = f.rule + '|' + f.evidence;
      const earlier = seen.get(key);
      if (earlier) { if (f.grade === 'fail' && earlier.grade === 'warn') { earlier.grade = 'fail'; earlier.label = m.label; } continue; }
      const item: Found = { ...f, fix: typeof f.fix === 'string' ? f.fix : undefined, label: m.label, probe: probeOk(f) ? f.probe : undefined };
      seen.set(key, item);
      found.push(item);
    }
  });
  const scrolls = found.filter((f) => f.rule === 'horizontal-scroll' && !f.at);
  if (scrolls.length > 1) {
    const keep = scrolls.find((f) => f.grade === 'fail') ?? scrolls[0];
    const rest = scrolls.filter((f) => f !== keep);
    const widths = [...new Set(rest.map((f) => f.label.replace(/px$/, '')))].filter((w) => w !== keep.label.replace(/px$/, ''));
    if (widths.length) keep.evidence += ` (also at ${widths.join(', ')}px)`;
    for (const f of rest) found.splice(found.indexOf(f), 1);
  }
  const bare = rings.filter((x) => x.bare);
  if (bare.length) report({ rule: 'missing-focus-visible', grade: 'fail', evidence: `[${LAPTOP.width}px] nothing shows keyboard focus on ${bare.slice(0, 4).map((x) => x.key).join(', ')}`, fix: 'give every control a :focus-visible ring; never remove an outline without putting one back', at: bare[0].at }, src);

  const textProbes = found.filter((f) => f.probe);
  const weakRings = rings.filter((x) => x.ratio != null && x.ratio < RING_FLOOR);
  const confirmed = textProbes.length || weakRings.length ? await confirmPixels(file, run, textProbes, weakRings).catch(() => null) : null;
  const dropped = new Set<string>();
  for (const f of textProbes) {
    const real = confirmed?.text.get(f.probe!.path);
    if (real == null) continue;
    if (real >= f.probe!.threshold - CONTRAST_SLACK) { dropped.add(f.probe!.path); continue; }
    f.evidence = f.evidence.replace(/computed contrast [\d.]+:1 under/, `contrast ${real.toFixed(2)}:1 against the pixels behind, under`).replace(/\([\d.]+:1\)$/, `(${real.toFixed(2)}:1)`);
  }
  for (const f of found) if (!(f.probe && dropped.has(f.probe.path))) report(f, src);
  for (const ring of weakRings) {
    const real = confirmed?.ring.get(ring.path) ?? ring.ratio!;
    if (real < RING_FLOOR) report({ rule: 'missing-focus-visible', grade: 'fail', evidence: `[${LAPTOP.width}px] focus ring ${real.toFixed(2)}:1 against what is behind it on ${ring.key}`, fix: 'a ring at 3:1 or better against the surface it is drawn over', at: ring.at }, src);
  }
}

interface Confirmed { text: Map<string, number>; ring: Map<string, number> }

/** hallmark's pixelBehind and pixelsAroundRing: hide the ink, screenshot the whole page, sample the median colour behind each claim. */
async function confirmPixels(file: string, run: Runner, textProbes: Found[], weakRings: RingProbe[]): Promise<Confirmed | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-design-lint-'));
  try {
    const textItems: PixelItem[] = [...new Map(textProbes.map((f) => [f.probe!.path, { path: f.probe!.path, kind: 'text' as const }])).values()];
    const ringItems: PixelItem[] = weakRings.map((x) => ({ path: x.path, kind: 'ring' as const, pad: x.pad }));
    const groups: Array<{ items: PixelItem[]; width: number; height: number; shot: string; evalIdx: number }> = [];
    if (textItems.length) groups.push({ items: textItems, ...CONTRAST_VIEW, shot: path.join(dir, 'text.png'), evalIdx: -1 });
    if (ringItems.length) groups.push({ items: ringItems, width: LAPTOP.width, height: LAPTOP.height, shot: path.join(dir, 'ring.png'), evalIdx: -1 });
    const steps: RenderStep[] = openingSteps();
    for (const g of groups) {
      g.evalIdx = steps.length;
      steps.push(evalStep(`P.hide(P, ${JSON.stringify(g.items)})`, g.width, g.height));
      steps.push({ kind: 'screenshot', out: g.shot, width: g.width, height: g.height, deviceScaleFactor: 1, fullPage: true, type: 'png', mobile: false });
      steps.push(evalStep(`P.restore(P, ${JSON.stringify(g.items)})`, g.width, g.height));
    }
    const res = await run({ file, steps, timeoutMs: RENDER_TIMEOUT_MS });
    if (!res.ok) return null;
    const out: Confirmed = { text: new Map(), ring: new Map() };
    groups.forEach((g) => {
      const rects = parsed<Array<SampleRect | null>>(res.evals[g.evalIdx]);
      if ('error' in rects || !fs.existsSync(g.shot)) return;
      const png = decodePng(fs.readFileSync(g.shot));
      if (!png) return;
      const scale = png.width / g.width;
      g.items.forEach((item, i) => {
        const rect = rects.value[i];
        if (!rect || rect.w < 2 || rect.h < 2) return;
        const scaled: SampleRect = { x: rect.x * scale, y: rect.y * scale, w: rect.w * scale, h: rect.h * scale, inner: rect.inner && { l: rect.inner.l * scale, t: rect.inner.t * scale, r: rect.inner.r * scale, b: rect.inner.b * scale } };
        const bg = medianRgb(png, scaled);
        if (!bg) return;
        const under = { r: bg[0], g: bg[1], b: bg[2] };
        if (item.kind === 'text') {
          const fg = textProbes.find((f) => f.probe!.path === item.path)!.probe!.fg;
          out.text.set(item.path, contrastRatio({ r: fg[0], g: fg[1], b: fg[2] }, under));
        } else {
          const ring = weakRings.find((x) => x.path === item.path)!.ring!;
          out.ring.set(item.path, contrastRatio({ r: ring[0], g: ring[1], b: ring[2] }, under));
        }
      });
    });
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
