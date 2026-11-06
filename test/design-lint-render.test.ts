/**
 * The design lint's render tier: every render rule id gets a page that passes
 * it (the clean fixture) and a page with the tell planted, measured through
 * whichever browser lib/aside-render picks (gstack's own browse daemon on the
 * free lane). Skipped with a named reason when neither browser is available;
 * the skipped and render-failure paths run everywhere.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lint } from '../lib/design-lint/index';
import { lintRender, lineOf } from '../lib/design-lint/render';
import { installScript } from '../lib/design-lint/render-probe';
import { decodePng, medianRgb } from '../lib/design-lint/render-png';
import { formatFinding, type Finding } from '../lib/design-lint/report';
import { RULES } from '../lib/design-lint/rules/ids';
import { NO_BROWSER, buildRenderScript, pickEngine, renderWithBrowse, resolveBrowseBin, type EngineChoice } from '../lib/aside-render';
import { asideAvailable } from './helpers/aside-available';
import { browserAvailable, NO_BROWSER_REASON } from './helpers/browser-available';

const ROOT = path.resolve(import.meta.dir, '..');
const CLEAN = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'design-lint', 'clean', 'index.html'), 'utf8');
const hasBrowser = browserAvailable();
if (!hasBrowser) process.stderr.write(`design-lint-render: SKIPPED — ${NO_BROWSER_REASON}\n`);

const RENDER_RULES = Object.entries(RULES).filter(([, m]) => m.render).map(([id]) => id);

/** The engine for these pages, chosen here rather than read from lib/aside-render's per-process cache, which other test files prime with fakes. */
const engine = (): EngineChoice => {
  if (asideAvailable()) return pickEngine(true);
  const bin = resolveBrowseBin();
  return bin ? { engine: 'browse', bin } : { engine: null, probe: { ok: false, reason: 'NEEDS_ASIDE', detail: NO_BROWSER_REASON }, error: NO_BROWSER_REASON };
};

function tmpPage(html: string): { file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-render-'));
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html);
  return { file, dir };
}

/** The clean fixture with extra CSS in its head and extra markup before </main>. */
const pageWith = (css: string, body: string, swap: Array<[string, string]> = []): string => {
  let html = CLEAN.replace('</style>', css + '\n</style>').replace('</main>', body + '\n</main>');
  for (const [from, to] of swap) { if (!html.includes(from)) throw new Error('swap target missing: ' + from); html = html.replace(from, to); }
  return html;
};

const lineIn = (html: string, needle: string): number => { const i = html.indexOf(needle); if (i < 0) throw new Error('needle missing: ' + needle); return html.slice(0, i).split('\n').length; };

async function measure(html: string): Promise<{ html: string; findings: Finding[]; status: string; of: (rule: string) => Finding[]; lines: string }> {
  const { file, dir } = tmpPage(html);
  try {
    const r = await lintRender([file], { cwd: dir, engine });
    return { html, findings: r.findings, status: r.status, of: (rule) => r.findings.filter((f) => f.rule === rule), lines: r.findings.map(formatFinding).join('\n') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SVG_IMG = (w: number, h: number, fill: string) => `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'%3E%3Crect width='${w}' height='${h}' fill='%23${fill}'/%3E%3C/svg%3E`;
const WORDS = (n: number) => Array.from({ length: n }, (_, i) => ['ledger', 'invoice', 'carrier', 'receipt', 'review', 'close', 'depot', 'month'][i % 8]).join(' ');

describe('design-lint render: the pure parts', () => {
  test('lineOf finds the element by tag, class and opening text; falls back to the tag, then line 1', () => {
    const src = '<main>\n<p class="lede">First words here</p>\n<p class="lede">Second words here</p>\n<button class="button">Go</button>\n</main>';
    expect(lineOf(src, { tag: 'p', cls: 'lede', text: 'Second words here' })).toBe(3);
    expect(lineOf(src, { tag: 'p', cls: 'lede', text: 'no such text' })).toBe(2);
    expect(lineOf(src, { tag: 'button', cls: '', text: '' })).toBe(4);
    expect(lineOf(src, { tag: 'h1', cls: '', text: '' })).toBe(1);
    expect(lineOf(src + '\n<div data-slot="a"></div>\n<div data-slot="b"></div>', { tag: 'div', cls: '', text: '', attr: 'data-slot="b"' })).toBe(7);
    expect(lineOf(null, { tag: 'p', cls: '', text: '' })).toBe(1);
  });

  test('the install script carries every probe and no module-scope reference', () => {
    const js = installScript();
    for (const name of ['setup', 'layout', 'contrast', 'accent', 'focus', 'occlusion', 'space', 'quality', 'hide', 'restore']) expect(js).toContain(name + ': (');
    expect(js).not.toMatch(/\bimport\b|\bexport\b|require\(/);
  });

  test('decodePng reads an RGB PNG and medianRgb samples a rectangle, leaving out an inner one', () => {
    const png = decodePng(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'design-lint', 'render', 'swatch.png')))!;
    expect([png.width, png.height, png.channels]).toEqual([8, 8, 3]);
    expect(medianRgb(png, { x: 0, y: 0, w: 4, h: 8 })!.map((v) => Math.round(v * 255))).toEqual([200, 30, 30]);
    expect(medianRgb(png, { x: 0, y: 0, w: 8, h: 8, inner: { l: 0, t: 0, r: 4, b: 8 } })!.map((v) => Math.round(v * 255))).toEqual([30, 30, 200]);
    expect(decodePng(Buffer.from('not a png'))).toBeNull();
  });

  test('no browser: findings are empty and the status names the reason', async () => {
    const r = await lintRender(['/nowhere/index.html'], { engine: () => ({ engine: null, probe: { ok: false, reason: 'NEEDS_ASIDE', detail: 'test' }, error: `${NO_BROWSER}: open Aside or run ./setup (NEEDS_ASIDE: test)` }) });
    expect(r.findings).toEqual([]);
    expect(r.status).toBe(`skipped: ${NO_BROWSER}: open Aside or run ./setup (NEEDS_ASIDE: test)`);
    expect((await lintRender([])).status).toBe('skipped: no HTML page to render');
  });
});

describe.skipIf(process.platform === 'win32')('design-lint render: the eval viewport and URL targets on both engines', () => {
  test('the Aside script sets the device metrics before a sized eval and clears them after', () => {
    const script = buildRenderScript('http://127.0.0.1:1/x.html', { file: '/x.html', steps: [{ kind: 'eval', expression: 'innerWidth', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, { kind: 'eval', expression: 'document.title' }] });
    const set = script.indexOf('Emulation.setDeviceMetricsOverride", {"width":1440,"height":900,"deviceScaleFactor":1,"mobile":false}');
    const run = script.indexOf('pg.evaluate((src) => (0, eval)(src), "innerWidth")');
    const clear = script.indexOf('Emulation.clearDeviceMetricsOverride');
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(run);
    expect(run).toBeLessThan(clear);
    expect(script.indexOf('"document.title"')).toBeGreaterThan(clear);
    expect(script.match(/setDeviceMetricsOverride/g)).toHaveLength(1);
  });

  test('the browse path sets the viewport before a sized eval, restores the default after, and opens an http target without serving anything', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-fake-browse-'));
    try {
      const log = path.join(tmp, 'argv.log');
      const bin = path.join(tmp, 'browse');
      fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1" in newtab) echo '{"tabId":7}' ;; js) echo 42 ;; *) : ;; esac\n`, { mode: 0o755 });
      const doc = path.join(tmp, 'doc.html');
      fs.writeFileSync(doc, '<!doctype html><title>Doc</title>');
      const r = await renderWithBrowse({ file: doc, steps: [{ kind: 'eval', expression: 'innerWidth', width: 1440, height: 900 }, { kind: 'eval', expression: '1' }] }, bin);
      expect(r.error).toBeUndefined();
      expect(r.evals).toEqual({ 0: '42', 1: '42' });
      const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).filter((l) => !/^js \(\(\) => \{ window\.__gstackErrs|^js JSON\.stringify\(window\.__gstackErrs/.test(l));
      expect(lines.slice(0, 6)).toEqual(['newtab --json', expect.stringMatching(/^goto http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/doc\.html --tab-id 7$/), 'viewport 1440x900 --tab-id 7', 'js innerWidth --tab-id 7', 'viewport 1280x720 --tab-id 7', 'js 1 --tab-id 7']);
      fs.rmSync(log);
      const u = await renderWithBrowse({ file: 'http://example.test/page', steps: [{ kind: 'eval', expression: '1' }] }, bin);
      expect(u.error).toBeUndefined();
      expect(fs.readFileSync(log, 'utf8')).toContain('goto http://example.test/page --tab-id 7');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasBrowser)('design-lint render: the browser tier', () => {
  test('the clean fixture passes every render rule; status is ran', async () => {
    const r = await measure(CLEAN);
    expect(r.status).toBe('ran');
    expect(r.findings.filter((f) => RENDER_RULES.includes(f.rule) || f.rule === 'render').map(formatFinding)).toEqual([]);
  }, 60_000);

  test('a URL nobody answers and a file that is not there each report render; the status still says ran', async () => {
    const r = await lintRender(['http://127.0.0.1:9/', '/nowhere/missing.html'], { engine });
    expect(r.status).toBe('ran');
    const render = r.findings.filter((f) => f.rule === 'render');
    expect(render).toHaveLength(2);
    expect(render[0].grade).toBe('blocks');
    expect(render[0].evidence).toMatch(/^could not reach http:\/\/127\.0\.0\.1:9\//);
    expect(render[1].evidence).toMatch(/^the page did not render: HTML file not found/);
  }, 60_000);

  test('layout tells: horizontal scroll, a wrapping button and link, the headline past the fold, a stylesheet that did not load', async () => {
    const html = pageWith(
      '.hero { padding-top: 760px; } .narrow { width: 120px; } .wide { width: 2400px; height: 8px; background: var(--color-line); }',
      '<div class="wide"></div>\n<div class="narrow"><a class="button" href="/book">Book the complete walkthrough today</a></div>\n<footer><div class="narrow"><a class="quiet" href="/method">Read how the close works for you</a></div></footer>',
      [['</head>', '<link rel="stylesheet" href="missing.css">\n</head>']],
    );
    const r = await measure(html);
    expect(r.of('render').map((f) => [f.grade, f.evidence])).toEqual([['ask', 'fonts or stylesheets did not load (missing.css): the measurements show a fallback face']]);
    expect(r.findings.every((f) => f.source === 'render')).toBe(true);
    expect(r.of('horizontal-scroll').map((f) => [f.grade, f.line, f.evidence])).toEqual([['blocks', lineIn(html, 'class="wide"'), "[375px] div.wide runs 2057px past the 375px screen, hidden only by the page's clip"]]);
    const unclipped = await measure(html.replace('html, body { overflow-x: clip; }', ''));
    expect(unclipped.of('horizontal-scroll').map((f) => [f.grade, f.evidence])).toEqual([['blocks', '[320px] the page scrolls sideways: it is 2432px wide in a 320px viewport (also at 375, 414, 768, 1024, 1280, 1920px)']]);
    const wraps = r.of('button-label-wraps');
    expect(wraps.map((f) => [f.grade, f.line])).toEqual([['blocks', lineIn(html, 'Book the complete walkthrough today')]]);
    expect(wraps[0].evidence).toMatch(/^\[320px\] control "Book the complete walkthrough to" wraps to \d lines \(a\.button\)$/);
    expect(r.of('link-wraps').map((f) => [f.grade, f.line])).toEqual([['ask', lineIn(html, 'Read how the close works for you')]]);
    expect(r.of('hero-fold').map((f) => [f.grade, f.line, f.evidence])).toEqual([['blocks', lineIn(html, '<h1>'), expect.stringMatching(/^\[1280px\] the headline crosses the 1280x800 fold/)]]);
  }, 60_000);

  test('contrast and focus: low contrast confirmed against the pixels, button text on its fill, a weak field edge, a bare focus state and a faint ring; white text over a dark picture is not a finding', async () => {
    const html = pageWith(
      '.faint { color: #b8b8b8; } .flat { background: #777; color: #808080; border-color: #777; } .edge { border: 1px solid #f2f2f2; background: #fff; height: 44px; } .bare:focus-visible { outline: none; } .weak:focus-visible { outline: 3px solid #e4e4e4; outline-offset: 2px; } .over { position: relative; width: 600px; } .over p { position: absolute; left: 24px; top: 24px; color: #fff; margin: 0; }',
      '<section class="extra">\n<p class="faint">The faint paragraph nobody can read on the paper.</p>\n<a class="button flat" href="/buy">Buy the ledger</a>\n<label>Email <input class="edge" type="email" name="email"></label>\n<button class="button bare">Bare of focus</button>\n<button class="button weak">Weak ring</button>\n<div class="over"><img src="' + SVG_IMG(600, 200, '222222') + '" width="600" height="200" alt="A dark depot at night"><p>White on the night photograph</p></div>\n</section>',
    );
    const r = await measure(html);
    const low = r.of('low-contrast');
    expect(low.find((f) => f.line === lineIn(html, 'class="faint"'))?.evidence).toMatch(/^\[1280px\] contrast 1\.\d\d:1 against the pixels behind, under 4\.5:1 on p\.faint "The faint paragraph nobo"$/);
    expect(low.find((f) => /field's edge/.test(f.evidence))?.evidence).toMatch(/^\[1440px\] a field's edge is under 3:1 against what surrounds it: input\.edge 1\.\d\d:1$/);
    expect(low.some((f) => /White on the night/.test(f.evidence))).toBe(false);
    expect(r.of('gray-on-color').map((f) => [f.grade, f.line, f.evidence])).toEqual([['blocks', lineIn(html, 'class="button flat"'), expect.stringMatching(/^\[1280px\] button text within a step of its fill on a\.button\.flat \(1\.\d\d:1\)$/)]]);
    const focus = r.of('missing-focus-visible');
    expect(focus.map((f) => f.grade)).toEqual(['blocks', 'blocks']);
    expect(focus.find((f) => /nothing shows/.test(f.evidence))).toMatchObject({ line: lineIn(html, 'class="button bare"'), evidence: '[1440px] nothing shows keyboard focus on button.button "Bare of focus"' });
    expect(focus.find((f) => /focus ring/.test(f.evidence))).toMatchObject({ line: lineIn(html, 'class="button weak"'), evidence: expect.stringMatching(/^\[1440px\] focus ring 1\.\d\d:1 against what is behind it on button\.button "Weak ring"$/) });
  }, 90_000);

  test('type and space tells at 1440: the word budget, a drawn SVG, an empty slot, counting marks, a tiny slot, a sliver, a lonely grid item, five weights, tiny text, long lines, crowded heads and a cramped box', async () => {
    const html = pageWith(
      '.marks { display: flex; gap: 4px; } .marks i { display: block; width: 8px; height: 8px; background: var(--color-ink); border-radius: 50%; } .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; } .tiles div { min-height: 120px; background: var(--color-line); } .sliver { width: 60px; } .w3 { font-weight: 300; } .w6 { font-weight: 600; } .w9 { font-weight: 900; } .tiny { font-size: 10px; } .long { max-width: none; font-size: 15px; } .crowd h3 { margin: 2px 0 48px; } .box { background: var(--color-line); padding: 1px; width: 320px; }',
      '<section class="extra">\n<h2>Everything the close touches</h2>\n<p class="budget">' + WORDS(120) + '</p>\n<svg class="plant" width="200" height="200" viewBox="0 0 200 200" aria-hidden="true"><path d="M20 180 C 60 20, 140 20, 180 180" fill="#8a6"/><path d="M40 160 Q 100 40 160 160" fill="#6a8"/><path d="M60 140 S 100 60 140 140" fill="#a86"/></svg>\n<div data-slot="product-shot" style="width: 420px; height: 300px; background: var(--color-line);"></div>\n<div class="marks" aria-hidden="true">' + '<i></i>'.repeat(30) + '</div>\n<div data-slot="mark" style="width: 20px; height: 20px; background: var(--color-line);"></div>\n<p class="sliver">A paragraph squeezed into a sliver of a column that runs for many lines.</p>\n<div class="tiles"><div></div><div></div><div></div><div></div></div>\n<p class="w3">Light weight runs across thirty characters.</p><p class="w6">Semibold weight runs across thirty characters.</p><p class="w9">Black weight runs across thirty characters here.</p>\n<p class="tiny">Ten pixel text that strains the eye across a whole paragraph of running prose.</p>\n<p class="long">' + WORDS(160) + '</p>\n<div class="crowd"><p>A paragraph above.</p><h3>Crowded head one</h3><p>The text it heads.</p><p>Another paragraph above.</p><h3>Crowded head two</h3><p>The text it heads.</p></div>\n<div class="box">Text pressed against the edge of its filled box.</div>\n</section>',
    );
    const r = await measure(html);
    const one = (rule: string) => { const f = r.of(rule); expect(f.length, rule + '\n' + r.lines).toBeGreaterThan(0); return f[0]; };
    expect(one('screen-word-budget')).toMatchObject({ grade: 'ask', evidence: expect.stringMatching(/^\[1440px\] \d+ words on one 900px screen/) });
    expect(one('hand-drawn-svg')).toMatchObject({ grade: 'ask', line: lineIn(html, '<svg class="plant"'), evidence: '[1440px] drawn illustration: section.extra (200x200, 3 shapes)' });
    expect(one('empty-picture')).toMatchObject({ grade: 'ask', line: lineIn(html, 'data-slot="product-shot"'), evidence: '[1440px] 1 empty picture: div[data-slot=product-shot] 420x300' });
    expect(one('counting-marks')).toMatchObject({ grade: 'ask', line: lineIn(html, 'class="marks"'), evidence: '[1440px] counting device: div.marks holds 30 identical marks' });
    expect(r.of('tiny-slot').map((f) => [f.grade, f.line, f.evidence])).toEqual([
      ['polish', lineIn(html, 'data-slot="mark"'), '[375px] slot "mark" renders at 20 x 20px on a phone'],
      ['polish', lineIn(html, 'data-slot="mark"'), '[1440px] slot "mark" renders at 20 x 20px'],
    ]);
    expect(one('text-sliver')).toMatchObject({ grade: 'polish', line: lineIn(html, 'class="sliver"'), evidence: expect.stringMatching(/^\[1440px\] "A paragraph squeezed into a " squeezed to 60px wide over \d+ lines \(p\.sliver\)$/) });
    expect(one('lonely-grid-item')).toMatchObject({ grade: 'polish', line: lineIn(html, 'class="tiles"'), evidence: '[1440px] div.tiles leaves one item alone on its last row (3 + 1)' });
    expect(one('font-weight-count')).toMatchObject({ grade: 'polish', evidence: '[1440px] 5 font weights in running use (300, 400, 600, 700, 900)' });
    expect(one('tiny-text')).toMatchObject({ grade: 'ask', line: lineIn(html, 'class="tiny"'), evidence: '[1440px] text that strains the eye: p.tiny at 10px' });
    expect(one('line-length')).toMatchObject({ grade: 'ask', line: lineIn(html, 'class="long"'), evidence: expect.stringMatching(/^\[1440px\] running prose set too wide: p\.long about \d{2,3} characters a line$/) });
    expect(one('heading-rhythm')).toMatchObject({ grade: 'ask', line: lineIn(html, 'Crowded head one'), evidence: expect.stringMatching(/^\[1440px\] heads nearer what precedes them than what they head: h3 "Crowded head one" 24px over, 48px under; h3 "Crowded/) });
    expect(one('cramped-padding')).toMatchObject({ grade: 'ask', line: lineIn(html, 'class="box"'), evidence: expect.stringMatching(/^\[1440px\] text crowds the edge of its box: div\.box left \dpx/) });
  }, 90_000);

  test('the hero and its sections: a dead band, small section heads, thin sections, text under a cover, and the 1920 container', async () => {
    const html = pageWith(
      '.hero { align-items: start; justify-content: start; } .hero figure { display: none; } .wrap { max-width: none; padding: 0; } h2 { font-size: 24px; } p { max-width: none; } .cover { position: absolute; left: 0; width: 300px; height: 80px; margin-top: -80px; background: var(--color-ink); }',
      '<section class="thin"><h2>A thin section</h2><p style="max-width: 30ch">A short body on a wide canvas with nothing else in it.</p></section>\n<section class="under"><p class="hidden-run" style="max-width: 20ch">This paragraph is painted under the cover.</p><div class="cover" aria-hidden="true"></div><p class="wide-run">' + WORDS(60) + '.</p></section>',
      [['<section class="story">', '<section class="story" style="display: none">'], ['<section class="ledger">', '<section class="ledger" style="display: none">'], ['<section class="close">', '<section class="close" style="display: none">']],
    );
    const r = await measure(html);
    expect(r.of('dead-band').map((f) => [f.grade, f.line, f.evidence])).toEqual([['ask', lineIn(html, '<section class="hero">'), expect.stringMatching(/^\[1440px\] \d{3}px of nothing between the hero's last content \(y \d+\) and the fold$/)]]);
    expect(r.of('small-section-heads').map((f) => [f.grade, f.evidence])).toEqual([['ask', expect.stringMatching(/^\[1440px\] section heads render at 24px under a \d+px hero head$/)]]);
    expect(r.of('thin-section').map((f) => [f.grade, f.line])).toEqual([['ask', lineIn(html, '<section class="thin">')]]);
    expect(r.of('thin-section')[0].evidence).toMatch(/^\[1440px\] \d thin sections?: "A thin section" \(\d+% wide, no mass\)/);
    expect(r.of('text-occlusion').map((f) => [f.grade, f.line, f.evidence])).toEqual([['blocks', lineIn(html, 'class="hidden-run"'), expect.stringMatching(/^\[1440px\] text painted under another element: div\.cover over "This paragraph i"/)]]);
    const wide = r.of('wide-container');
    expect(wide.map((f) => f.grade)).toEqual(wide.map(() => 'blocks'));
    expect(wide.map((f) => f.evidence)).toEqual(expect.arrayContaining([expect.stringMatching(/^\[1920px\] the hero text starts \d+px from the edge at 1920$/), expect.stringMatching(/^\[1920px\] \d text blocks? runs? wider than 1600px at 1920/)]));
  }, 90_000);

  test('the photo wall, the accent footprint and hero content sitting low', async () => {
    const photo = (fill: string) => '<section class="shot"><img src="' + SVG_IMG(1200, 520, fill) + '" width="1200" height="520" alt="A depot"></section>';
    const html = pageWith(
      '.band { background: var(--color-accent); height: 220px; } .shot img { width: 100%; height: auto; display: block; }',
      '<div class="band"></div>\n' + photo('778866') + '\n' + photo('667788') + '\n' + photo('886677'),
      [['<section class="hero">', '<div class="band"></div>\n  <section class="hero">'], ['<section class="story">', '<section class="story" style="display: none">'], ['<section class="ledger">', '<section class="ledger" style="display: none">'], ['align-items: center;', 'align-items: end;'], ['<figure>', '<figure style="display: none">']],
    );
    const r = await measure(html);
    const balance = r.of('hero-balance');
    expect(balance.map((f) => f.grade)).toEqual(balance.map(() => 'ask'));
    expect(balance.map((f) => f.evidence)).toContainEqual(expect.stringMatching(/^\[1440px\] the hero content sits low: \d+px above it, \d+px below$/));
    expect(r.of('photo-wall').map((f) => [f.grade, f.evidence])).toEqual([['ask', expect.stringMatching(/^\[1440px\] photographs cover \d\d% of the page below the hero \(3 pictures\)$/)]]);
    expect(r.of('accent-footprint').map((f) => [f.grade, f.evidence])).toEqual([['ask', expect.stringMatching(/^\[1280px\] the accent paints about \d+\.\d% of the 1280x800 viewport \(over 8%\)$/)]]);
  }, 60_000);

  test('a hero with more than two actions reports the count under screen-word-budget; the clean two do not', async () => {
    const html = pageWith('', '', [['<a class="quiet" href="/method">Read how the close works</a>', '<a class="quiet" href="/method">Read how the close works</a>\n        <a class="quiet" href="/pricing">See the pricing</a>\n        <a class="quiet" href="/tour">Take the tour</a>']]);
    const r = await measure(html);
    expect(r.of('screen-word-budget').map((f) => [f.grade, f.line, f.evidence])).toEqual([['ask', lineIn(html, 'href="/pricing"'), '[1440px] the hero offers 4 actions']]);
  }, 60_000);

  test('section gaps: sections crowded together, every gap the same, and more than nine sections', async () => {
    const block = (n: number) => '<section class="gap' + n + '"><h2>Section ' + n + ' of the close</h2><p>' + WORDS(24) + '.</p></section>';
    const crowded = await measure(pageWith('.gap1, .gap2, .gap3 { padding: 0; margin: 4px 0; }', block(1) + '\n' + block(2) + '\n' + block(3)));
    expect(crowded.of('section-gap').map((f) => [f.grade, f.evidence])).toEqual([['ask', expect.stringMatching(/^\[1440px\] the smallest gap between sections is \d+px \(gaps: [-\d, ]+\)$/)]]);
    const same = await measure(pageWith(
      '.wrap > section { padding: 0; margin: 0 0 140px; } .wrap > section:last-child { margin-bottom: 0; } .hero { min-height: 0; } .hero figure { display: none; }',
      block(1) + '\n' + block(2) + '\n' + block(3),
      [['<section class="story">', '<section class="story" style="display: none">'], ['<section class="ledger">', '<section class="ledger" style="display: none">'], ['<section class="close">', '<section class="close" style="display: none">']],
    ));
    expect(same.of('section-gap').map((f) => [f.grade, f.evidence])).toEqual([['ask', expect.stringMatching(/^\[1440px\] every section gap is \d+px$/)]]);
    const many = await measure(pageWith('.wrap > section { padding: 0; margin: 0 0 160px; }', Array.from({ length: 7 }, (_, i) => block(i + 1)).join('\n')));
    expect(many.of('section-gap').map((f) => [f.grade, f.evidence])).toContainEqual(['ask', '[1440px] 11 sections on one page']);
    expect(many.of('section-gap').find((f) => f.evidence.endsWith('sections on one page'))!.line).toBe(lineIn(many.html, 'class="gap6"'));
  }, 90_000);
});

describe('design-lint render: hardening (ship review)', () => {
  test('lineOf tolerates regex metacharacters in a tag name the page reports', () => {
    expect(() => lineOf('<x>\n<a(b class="c">hi</a(b>', { tag: 'a(b', cls: 'c', text: 'hi' })).not.toThrow();
    expect(lineOf('<x>\n<a(b class="c">hi</a(b>', { tag: 'a(b', cls: 'c', text: 'hi' })).toBe(2);
  });

  test.skipIf(!hasBrowser)('a waiver on low-contrast is refused once the render tier measures it: the measured finding blocks, nothing is waived', async () => {
    const html = '<!-- gstack-lint-disable low-contrast: the faint paragraph is the ledger watermark for the paper -->\n' + pageWith('.faint { color: #b8b8b8; background: #fff; }', '<p class="faint">The faint paragraph nobody can read on the paper ledger.</p>');
    const { dir } = tmpPage(html);
    try {
      const r = await lint([dir], { cwd: dir, render: true, warn: () => {}, engine });
      expect(r.findings.filter((f) => f.rule === 'low-contrast' && f.source === 'render').map((f) => f.grade)).toEqual(['blocks']);
      expect(r.findings.filter((f) => f.rule === 'waiver').map((f) => f.evidence)).toEqual(['waiver on low-contrast refused: it blocks; the Floor is never waivable']);
      expect(r.summary.waived).toBe(0);
      expect(r.exitCode).toBe(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);

  test.skipIf(!hasBrowser)('a page whose script redefines the probes gets a blocking render finding, not a quiet pass', async () => {
    const html = pageWith('', '<script>Object.defineProperty(window, "__gstackLint", { configurable: false, get() { return { setup: () => ({ lost: [] }), layout: () => [{ rule: "nope", grade: "fail", evidence: "x" }], contrast: () => [], accent: () => [], space: () => [], quality: () => [], occlusion: () => [], focus: () => [], hide: () => [], restore: () => 0 }; }, set() {} });</script>');
    const { dir } = tmpPage(html);
    try {
      const r = await lint([dir], { cwd: dir, render: true, warn: () => {}, engine });
      expect(r.findings.filter((f) => f.rule === 'render').map((f) => [f.grade, /does not know|could not be prepared|did not render|measurement/.test(f.evidence)])).toContainEqual(['blocks', true]);
      expect(r.exitCode).toBe(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);

  test.skipIf(!hasBrowser)('a page waiving section-gap sees its render section-gap finding at waived, not ask', async () => {
    const block = (n: number) => `<section class="gap${n}"><h2>Section ${n} of the close</h2><p>${WORDS(24)}.</p></section>`;
    const html = '<!-- gstack-lint-disable section-gap: the ledger separates its close sections with hairline rules, not air -->\n'
      + pageWith('.gap1,.gap2,.gap3{padding:0;margin:4px 0}', block(1) + block(2) + block(3));
    const { file, dir } = tmpPage(html);
    try {
      const r = await lint([dir], { cwd: dir, render: true, warn: () => {}, engine });
      expect(r.findings.filter((f) => f.rule === 'waiver')).toEqual([]);
      expect(r.findings.filter((f) => f.rule === 'section-gap').map((f) => [f.grade, f.file, f.source])).toEqual([['waived', 'index.html', 'render']]);
      expect(r.summary.waived).toBe(1);
      void file;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
});
