/**
 * The assets rule family of the design lint (lib/design-lint/rules/assets.ts):
 * for every rule id, one page that is clean for it and one with the tell
 * planted, checked by id, grade and line.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lint } from '../lib/design-lint/index';
import { formatFinding, type Finding } from '../lib/design-lint/report';
import { lintStatic } from '../lib/design-lint/static';

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'design-lint');

const TOKENS = ':root { --color-paper: oklch(97% 0.01 80); --color-ink: oklch(20% 0.02 250); --color-accent: oklch(50% 0.16 30); --color-accent-ink: oklch(98% 0.01 30); --color-muted: oklch(50% 0.02 250); --font-display: "Fraunces", serif; --font-body: "Public Sans", sans-serif; }';

function page(css: string, body: string): string {
  return '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Harbour office</title><meta name="description" content="A test page."><link rel="icon" href="data:,">\n<style>\n' + TOKENS + '\n' + css + '\n</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';
}

const lineOf = (html: string, needle: string): number => {
  const at = html.indexOf(needle);
  if (at < 0) throw new Error('needle not in page: ' + needle);
  return html.slice(0, at).split('\n').length;
};

function run(html: string, files: Record<string, string> = {}): Finding[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-assets-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return lintStatic([dir], { cwd: dir, warn: (l) => { throw new Error(l); } }).findings;
}

const only = (findings: Finding[], rule: string) => findings.filter((f) => f.rule === rule);
const show = (findings: Finding[]) => findings.map(formatFinding);

describe('design-lint assets: icons (gate 30)', () => {
  test('emoji-decoration blocks on an emoji standing in for an icon, in a tile, a heading or a component string; an SVG icon is clean', () => {
    const slop = page('', '<main>\n<div class="feature__icon">\u2728</div>\n<h3>\ud83d\ude80 Ship faster</h3>\n<p>\ud83d\udc4b Welcome aboard</p>\n</main>');
    const hits = only(run(slop), 'emoji-decoration');
    expect(hits.map((f) => [f.grade, f.line])).toEqual([['blocks', lineOf(slop, 'feature__icon')], ['blocks', lineOf(slop, 'Ship faster')], ['blocks', lineOf(slop, 'Welcome aboard')]]);
    expect(hits[0].evidence).toBe('an emoji icon "\u2728" in <div class="feature__icon">');
    expect(hits[2].evidence).toContain('text opens with an emoji');
    const tsx = 'export const Icon = () => <Feature icon="\u2728" title="Sync" />;\n';
    expect(only(run(page('', '<main><p>Ready.</p></main>'), { 'Feature.tsx': tsx }), 'emoji-decoration').map((f) => [f.file, f.evidence])).toEqual([['Feature.tsx', 'an emoji passed as an icon: \u2728']]);
    expect(only(run(page('', '<main><div class="feature__icon"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg></div><h3>Ship faster</h3></main>')), 'emoji-decoration')).toEqual([]);
  });

  test('two-icon-libraries asks when two libraries share a page; one library is clean', () => {
    const mixed = page('', '<main>\n<i class="lucide lucide-check"></i>\n<svg class="heroicon" aria-hidden="true"></svg>\n</main>');
    const hits = only(run(mixed), 'two-icon-libraries');
    expect(hits.map((f) => [f.grade, f.line, f.evidence])).toEqual([['ask', 1, 'icon libraries mixed on one page: heroicons and lucide']]);
    expect(only(run(page('', '<main><i class="lucide lucide-check" aria-hidden="true"></i><i class="lucide lucide-x" aria-hidden="true"></i></main>')), 'two-icon-libraries')).toEqual([]);
  });
});

describe('design-lint assets: decoration labels (gate 33)', () => {
  test('unlabeled-decoration blocks on a bare <svg> or <canvas>; aria-hidden, a label, a <title> or a labelled ancestor is clean', () => {
    const slop = page('', '<main>\n<svg viewBox="0 0 10 10"><circle r="4"/></svg>\n<canvas width="10" height="10"></canvas>\n</main>');
    const hits = only(run(slop), 'unlabeled-decoration');
    expect(hits.map((f) => [f.grade, f.line, f.evidence])).toEqual([
      ['blocks', lineOf(slop, '<svg'), '<svg> with neither aria-hidden="true" nor a label'],
      ['blocks', lineOf(slop, '<canvas'), '<canvas> with neither aria-hidden="true" nor a label'],
    ]);
    const clean = page('', '<main><svg aria-hidden="true" viewBox="0 0 10 10"></svg><svg viewBox="0 0 10 10"><title>The depot</title></svg><a href="/x" aria-label="Home"><svg viewBox="0 0 10 10"></svg></a><canvas role="img" aria-label="Days to close"></canvas></main>');
    expect(show(only(run(clean), 'unlabeled-decoration'))).toEqual([]);
  });
});

describe('design-lint assets: contrast (gates 40, 41)', () => {
  test('low-contrast lands at ask (the static tier suspects, the render tier proves) for text under its threshold; large text at 3:1 and body text at 4.5:1 are clean', () => {
    const slop = page('.muted {\n  color: #999;\n  background: #fff;\n}\n.big { font-size: 32px; color: #767676; background: #fff; }', '<main><p class="muted">Faint</p><p class="big">Large</p></main>');
    const hits = only(run(slop), 'low-contrast');
    expect(hits.map((f) => [f.tier, f.grade, f.line])).toEqual([['ask', 'ask', lineOf(slop, 'color: #999')]]);
    expect(hits[0].evidence).toBe('2.85:1 under the 4.5:1 threshold on .muted');
    expect(only(run(page('.body { color: #595959; background: #fff; }', '<main><p class="body">Readable</p></main>')), 'low-contrast')).toEqual([]);
  });

  test('gray-on-color lands at ask for button text within a step of its fill, a dark surface that sets no text colour and a missing accent ink; a paired ink is clean', () => {
    const slop = page('.btn {\n  color: #7a7a7a;\n  background-color: #777;\n}\n.panel {\n  background: #222;\n  padding: 1rem;\n}', '<main><button class="btn">Go</button><section class="panel"><p>Dark</p></section></main>');
    const hits = only(run(slop), 'gray-on-color');
    expect(hits.map((f) => [f.tier, f.grade, f.line])).toEqual([['ask', 'ask', lineOf(slop, 'color: #7a7a7a')], ['ask', 'ask', lineOf(slop, 'background: #222')]]);
    expect(hits[0].evidence).toMatch(/^button text within a step of its fill on \.btn/);
    expect(hits[1].evidence).toBe('a dark surface (lightness 25%) on .panel sets no text colour');
    const noInk = page('.btn { background: var(--color-accent); color: white; }', '<main><button class="btn">Go</button></main>').replace('--color-accent-ink: oklch(98% 0.01 30); ', '');
    expect(only(run(noInk), 'gray-on-color').map((f) => f.evidence)).toEqual(['the accent fills a surface but --color-accent-ink is not defined']);
    expect(only(run(page('.btn { background: var(--color-accent); color: var(--color-accent-ink); } .panel { background: var(--color-ink); color: var(--color-paper); }', '<main><button class="btn">Go</button><section class="panel"><p>Dark</p></section></main>')), 'gray-on-color')).toEqual([]);
  });
});

describe('design-lint assets: labels that wrap (gate 49)', () => {
  test('button-label-wraps lands at ask for a long button or primary nav label with no nowrap; link-wraps asks for a long footer link; nowrap and short labels are clean', () => {
    const slop = page('', '<nav><a class="nav__link" href="/reports">Download the complete quarterly report</a></nav>\n<main>\n<button>Download the complete quarterly report</button>\n</main>\n<footer>\n<a href="/privacy">Read the complete privacy and cookie policy</a>\n</footer>');
    const findings = run(slop);
    const buttons = only(findings, 'button-label-wraps');
    expect(buttons.map((f) => [f.tier, f.grade, f.line])).toEqual([['ask', 'ask', lineOf(slop, '<nav>')], ['ask', 'ask', lineOf(slop, '<button>')]]);
    expect(buttons[1].evidence).toMatch(/^the long label "Download the complete quarterly rep…" on <button> can wrap, and nothing sets nowrap$/);
    const links = only(findings, 'link-wraps');
    expect(links.map((f) => [f.grade, f.line])).toEqual([['ask', lineOf(slop, 'href="/privacy"')]]);
    const clean = run(page('button, .nav__link { white-space: nowrap; }', '<nav><a class="nav__link" href="/reports">Download the complete quarterly report</a></nav><main><button>Download the complete quarterly report</button></main><footer><a href="/privacy">Privacy</a></footer>'));
    expect(only(clean, 'button-label-wraps')).toEqual([]);
    expect(only(clean, 'link-wraps')).toEqual([]);
  });
});

describe('design-lint assets: images (gate 76)', () => {
  test('broken-image blocks on an <img> with no source; srcset or data-src counts as a source', () => {
    const slop = page('', '<main>\n<img alt="The depot">\n<img src="#" alt="Also empty">\n</main>');
    const hits = only(run(slop), 'broken-image');
    expect(hits.map((f) => [f.grade, f.line, f.evidence])).toEqual([['blocks', lineOf(slop, '<img alt'), 'an <img> with no source']]);
    expect(only(run(page('', '<main><img src="depot.jpg" alt="The depot"><img srcset="a.jpg 1x" alt="Lazy"></main>')), 'broken-image')).toEqual([]);
  });

  test('stock-photo-hotlink blocks on an Unsplash+ photo and lands at ask for a free stock hotlink; a local photograph is clean', () => {
    const slop = page('', '<main>\n<img src="https://plus.unsplash.com/premium_photo-1661 ?w=800" alt="Paid">\n<img src="https://images.pexels.com/photos/12345/pexels-photo.jpeg" alt="Free">\n</main>');
    const hits = only(run(slop), 'stock-photo-hotlink').sort((a, b) => a.line - b.line);
    expect(hits.map((f) => [f.tier, f.grade, f.line])).toEqual([['blocks', 'blocks', lineOf(slop, 'premium_photo')], ['ask', 'ask', lineOf(slop, 'pexels')]]);
    expect(hits[0].evidence).toBe('an Unsplash+ photo hotlinked, which needs a paid licence');
    expect(hits[1].evidence).toBe('a photo hotlinked from Pexels, whose terms bar images picked by an AI tool');
    expect(only(run(page('', '<main><img src="/img/depot-1280.jpg" alt="The depot"></main>')), 'stock-photo-hotlink')).toEqual([]);
  });
});

describe('design-lint assets: fixtures', () => {
  test('the clean page raises nothing from this family; slopped.html plants the emoji icon and the bare svg', async () => {
    const assets = new Set(['emoji-decoration', 'two-icon-libraries', 'unlabeled-decoration', 'low-contrast', 'gray-on-color', 'button-label-wraps', 'link-wraps', 'broken-image', 'stock-photo-hotlink']);
    const clean = await lint([path.join(FIXTURES, 'clean')], { cwd: ROOT });
    expect(show(clean.findings.filter((f) => assets.has(f.rule)))).toEqual([]);
    const slopped = await lint([path.join(FIXTURES, 'slopped.html')], { cwd: ROOT });
    expect(only(slopped.findings, 'emoji-decoration').map((f) => [f.grade, f.line, f.evidence])).toEqual([['blocks', 126, 'an emoji icon "\u2728" in <div class="feature__icon">']]);
    expect(only(slopped.findings, 'unlabeled-decoration').map((f) => [f.grade, f.line])).toEqual([['blocks', 114]]);
  });
});

describe('design-lint assets: third review cycle', () => {
  test('large text passes at 3:1 and the same colour on body text asks; body text at the 4.5:1 edge is clean', () => {
    const big = page('.big { font-size: 32px; color: #959595; background: #fff; }', '<main><p class="big">Large text at three to one</p></main>');
    expect(only(run(big), 'low-contrast')).toEqual([]);
    const small = page('.small { font-size: 16px; color: #959595; background: #fff; }', '<main><p class="small">Body text at three to one</p></main>');
    expect(only(run(small), 'low-contrast').map((f) => [f.grade, f.evidence])).toEqual([['ask', '3.00:1 under the 4.5:1 threshold on .small']]);
    expect(only(run(page('.body { color: #767676; background: #fff; }', '<main><p class="body">Readable</p></main>')), 'low-contrast')).toEqual([]);
  });
  test('two-icon-libraries reads class tokens and asset references, not prose: feather-light and bi-weekly are words', () => {
    const prose = page('', '<main><i class="fa-solid fa-star"></i><p>A feather-light app with our bi-weekly newsletter.</p></main>');
    expect(only(run(prose), 'two-icon-libraries')).toEqual([]);
    const mixed = page('', '<main><i class="fa-solid fa-star"></i><i class="bi-star"></i></main>');
    expect(only(run(mixed), 'two-icon-libraries').map((f) => f.evidence)).toEqual(['icon libraries mixed on one page: font-awesome and bootstrap-icons']);
    const linked = page('', '<main><i class="fa-solid fa-star"></i><script src="https://unpkg.com/feather-icons"></script></main>');
    expect(only(run(linked), 'two-icon-libraries').map((f) => f.evidence)).toEqual(['icon libraries mixed on one page: font-awesome and feather']);
  });
  test('an svg inside a labelled list item whose end tag is left out is still labelled', () => {
    const f = run(page('', '<main><ul><li aria-label="Home"><svg viewBox="0 0 10 10"></svg><li aria-label="Away"><svg viewBox="0 0 10 10"></svg></ul></main>'));
    expect(only(f, 'unlabeled-decoration')).toEqual([]);
  });
});
