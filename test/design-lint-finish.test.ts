/**
 * The finish rule family of the design lint (lib/design-lint/rules/finish.ts):
 * for every rule id, one page that is clean for it and one with the tell
 * planted, checked by id, grade and line. Everything here prints at polish
 * except fake-avatar, which blocks.
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

function page(css: string, body: string, htmlAttrs = ' lang="en"'): string {
  return '<!doctype html>\n<html' + htmlAttrs + '>\n<head><meta charset="utf-8"><title>Harbour office</title><meta name="description" content="A test page."><link rel="icon" href="data:,">\n<style>\n' + TOKENS + '\n' + css + '\n</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';
}

const lineOf = (html: string, needle: string): number => {
  const at = html.indexOf(needle);
  if (at < 0) throw new Error('needle not in page: ' + needle);
  return html.slice(0, at).split('\n').length;
};

function run(html: string, files: Record<string, string> = {}): Finding[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-finish-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return lintStatic([dir], { cwd: dir, warn: (l) => { throw new Error(l); } }).findings;
}

const only = (findings: Finding[], rule: string) => findings.filter((f) => f.rule === rule);
const show = (findings: Finding[]) => findings.map(formatFinding);
const polishAt = (findings: Finding[], rule: string, line: number) => expect(only(findings, rule).map((f) => [f.grade, f.line])).toEqual([['polish', line]]);

describe('design-lint finish: prose (F1, F2)', () => {
  test('straight-quotes prints at polish with the count; curly quotes are clean', () => {
    const slop = page('', '<main>\n<p>Mari said "the close ran itself" and that\'s the review.</p>\n</main>');
    const hits = only(run(slop), 'straight-quotes');
    polishAt(hits, 'straight-quotes', lineOf(slop, 'Mari said'));
    expect(hits[0].evidence).toMatch(/^3 straight quotes in prose \(first: /);
    expect(only(run(page('', '<main><p>Mari said \u201cthe close ran itself\u201d and that\u2019s the review.</p></main>')), 'straight-quotes')).toEqual([]);
  });

  test('three-dot-ellipsis prints at polish; the ellipsis character is clean', () => {
    const slop = page('', '<main>\n<p>Wait for it...</p>\n</main>');
    polishAt(run(slop), 'three-dot-ellipsis', lineOf(slop, 'Wait for'));
    expect(only(run(page('', '<main><p>Wait for it\u2026</p></main>')), 'three-dot-ellipsis')).toEqual([]);
  });
});

describe('design-lint finish: heads and buttons (F3, F4, F6)', () => {
  test('balanced-display-head prints at polish when no display head has text-wrap: balance; one balanced head rule is clean', () => {
    const slop = page('h1 {\n  font-size: 3rem;\n}', '<main><h1>October closed in two days</h1></main>');
    const hits = only(run(slop), 'balanced-display-head');
    polishAt(hits, 'balanced-display-head', lineOf(slop, 'h1 {'));
    expect(hits[0].evidence).toBe('no text-wrap: balance on any display head (1 head rules, the first h1)');
    expect(only(run(page('h1 { font-size: 3rem; text-wrap: balance; }', '<main><h1>October closed in two days</h1></main>')), 'balanced-display-head')).toEqual([]);
  });

  test('two-primary-buttons prints at polish for two filled primary recipes; one filled recipe and an outline is clean', () => {
    const slop = page('.btn-book { background: var(--color-accent); }\n.btn-buy {\n  background: var(--color-ink);\n}', '<main><a class="btn-book" href="/book">Book</a><a class="btn-buy" href="/buy">Buy</a></main>');
    const hits = only(run(slop), 'two-primary-buttons');
    polishAt(hits, 'two-primary-buttons', lineOf(slop, 'background: var(--color-ink)'));
    expect(hits[0].evidence).toBe('2 filled primary-button recipes on one page: .btn-book and .btn-buy');
    expect(only(run(page('.btn-book { background: var(--color-accent); } .btn-quiet { background: transparent; border: 1px solid var(--color-accent); }', '<main><a class="btn-book" href="/book">Book</a><a class="btn-quiet" href="/method">Method</a></main>')), 'two-primary-buttons')).toEqual([]);
  });

  test('display-figures-tabular prints at polish for a display-size stat without tabular numerals; tabular-nums on the selector or the root is clean', () => {
    const slop = page('.stat__num {\n  font-size: 48px;\n}', '<main><p class="stat__num">1,140</p></main>');
    const hits = only(run(slop), 'display-figures-tabular');
    polishAt(hits, 'display-figures-tabular', lineOf(slop, 'font-size: 48px'));
    expect(hits[0].evidence).toBe('figures on .stat__num at display size without tabular numerals');
    expect(only(run(page('.stat__num { font-size: 48px; font-variant-numeric: tabular-nums; }', '<main><p class="stat__num">1,140</p></main>')), 'display-figures-tabular')).toEqual([]);
    expect(only(run(page('body { font-variant-numeric: tabular-nums; } .stat__num { font-size: 48px; }', '<main><p class="stat__num">1,140</p></main>')), 'display-figures-tabular')).toEqual([]);
  });
});

describe('design-lint finish: surfaces and recipes (F5, F7, F24)', () => {
  test('icon-coin prints at polish for a small round filled icon box; a bare inline icon is clean', () => {
    const slop = page('.feature__icon {\n  width: 40px;\n  border-radius: 50%;\n  background: var(--color-accent);\n}', '<main><span class="feature__icon" aria-hidden="true"></span></main>');
    const hits = only(run(slop), 'icon-coin');
    polishAt(hits, 'icon-coin', lineOf(slop, 'background: var(--color-accent)'));
    expect(hits[0].evidence).toBe('an icon in a coloured coin: .feature__icon');
    expect(only(run(page('.feature__icon { width: 20px; color: currentColor; }', '<main><span class="feature__icon" aria-hidden="true"></span></main>')), 'icon-coin')).toEqual([]);
  });

  test('stamped-recipe prints at polish for one container recipe on six selectors and for the pill radius on five non-controls; four varied boxes are clean', () => {
    const recipe = ' { border: 1px solid var(--color-muted); border-radius: 8px; background: var(--color-paper); }';
    const six = page(['.a', '.b', '.c', '.d', '.e', '.f'].map((s) => s + recipe).join('\n'), '<main><div class="a"></div></main>');
    const hits = only(run(six), 'stamped-recipe');
    polishAt(hits, 'stamped-recipe', lineOf(six, '.a {'));
    expect(hits[0].evidence).toBe('one container recipe on 6 selectors (.a, .b, .c, .d and more)');
    const pills = page('.card, .panel, .tile, .box, .media {\n  border-radius: 9999px;\n}', '<main><div class="card"></div></main>');
    const pillHits = only(run(pills), 'stamped-recipe');
    polishAt(pillHits, 'stamped-recipe', lineOf(pills, 'border-radius: 9999px'));
    expect(pillHits[0].evidence).toBe('the pill radius on 5 non-control selectors (.card, .panel, .tile, .box)');
    expect(only(run(page('.btn, .chip, .tag, .badge, .pill { border-radius: 9999px; } .a' + recipe + ' .b { border-radius: 4px; background: var(--color-paper); }', '<main><div class="a"></div></main>')), 'stamped-recipe')).toEqual([]);
  });

  test('hairline-under-shadow prints at polish for a 1px border under a wide soft shadow, in CSS or Tailwind classes; a shadow alone is clean', () => {
    const slop = page('.card {\n  border: 1px solid var(--color-muted);\n  box-shadow: 0 10px 30px -5px rgb(0 0 0 / 0.2);\n}', '<main><div class="card"></div></main>');
    const hits = only(run(slop), 'hairline-under-shadow');
    polishAt(hits, 'hairline-under-shadow', lineOf(slop, 'box-shadow'));
    expect(hits[0].evidence).toBe('a hairline border under a wide soft shadow on .card');
    const tw = page('', '<main>\n<div class="rounded-lg border shadow-xl"></div>\n</main>');
    expect(only(run(tw), 'hairline-under-shadow').map((f) => [f.grade, f.line])).toEqual([['polish', lineOf(tw, 'shadow-xl')]]);
    expect(only(run(page('.card { box-shadow: 0 10px 30px -5px rgb(0 0 0 / 0.2); }', '<main><div class="card"></div></main>')), 'hairline-under-shadow')).toEqual([]);
  });
});

describe('design-lint finish: motion and people (F8, F9)', () => {
  test('scroll-choreography-mix prints at polish for two scroll-driven families; one is clean', () => {
    const slop = page('.reveal { animation: rise linear both; animation-timeline: view(); }\n.bar {\n  animation: grow linear both;\n  animation-timeline: scroll();\n}', '<main><div class="reveal"></div><div class="bar"></div></main>');
    const hits = only(run(slop), 'scroll-choreography-mix');
    polishAt(hits, 'scroll-choreography-mix', lineOf(slop, 'animation-timeline: scroll()'));
    expect(hits[0].evidence).toBe('2 scroll-choreography patterns on one page (reveal, bar)');
    expect(only(run(page('.reveal { animation: rise linear both; animation-timeline: view(); }', '<main><div class="reveal"></div></main>')), 'scroll-choreography-mix')).toEqual([]);
  });

  test('fake-avatar blocks on a generated-face service; stock-person-photo prints at polish for a person-keyword stock URL; a named local portrait is clean', () => {
    const slop = page('.hero { background-image: url(https://images.unsplash.com/photo-1?portrait); }', '<main>\n<img src="https://i.pravatar.cc/80?u=mari" alt="Mari">\n<img src="https://images.unsplash.com/photo-15?headshot=1" alt="A customer">\n</main>');
    const findings = run(slop);
    expect(only(findings, 'fake-avatar').map((f) => [f.tier, f.grade, f.line, f.evidence])).toEqual([['blocks', 'blocks', lineOf(slop, 'pravatar'), 'a generated-face service (i.pravatar.cc) stands in for a person']]);
    expect(only(findings, 'stock-person-photo').map((f) => [f.grade, f.line]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([['polish', lineOf(slop, 'photo-1?portrait')], ['polish', lineOf(slop, 'headshot')]]);
    const clean = run(page('', '<main><img src="/people/mari-halvorsen.jpg" alt="Mari Halvorsen"></main>'));
    expect(only(clean, 'fake-avatar')).toEqual([]);
    expect(only(clean, 'stock-person-photo')).toEqual([]);
  });
});

describe('design-lint finish: page invariants and browser surfaces (F15, F16)', () => {
  test('page-invariants prints at polish for two container widths and for three column gaps; one width and one gap are clean', () => {
    const widths = page('.wrap { max-width: 1200px; }\n.container { max-width: 1360px; }', '<main class="wrap"></main>');
    const w = only(run(widths), 'page-invariants');
    expect(w.map((f) => [f.grade, f.line, f.evidence])).toEqual([['polish', 1, '2 container widths on one page (1200, 1360px)']]);
    const gaps = page('.a { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; } .b { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 32px; } .c { display: grid; grid-template-columns: repeat(2, 1fr); gap: 48px; }', '<main></main>');
    expect(only(run(gaps), 'page-invariants').map((f) => f.evidence)).toEqual(['3 different column gaps across multi-column sections (24px, 32px, 48px)']);
    expect(only(run(page('.wrap { max-width: 1360px; } .a, .b { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }', '<main class="wrap"></main>')), 'page-invariants')).toEqual([]);
  });

  test('unthemed-browser-surfaces prints at polish naming the missing surfaces on a page with an accent; themed CSS or Tailwind surfaces are clean, and a page without an accent is skipped', () => {
    const slop = page('', '<main><input type="email"></main>');
    const hits = only(run(slop), 'unthemed-browser-surfaces');
    expect(hits.map((f) => [f.grade, f.line, f.evidence])).toEqual([['polish', 1, 'browser surfaces left unthemed: ::selection, scrollbar-color, caret-color']]);
    expect(only(run(page('::selection { background: var(--color-accent); } html { scrollbar-color: var(--color-muted) var(--color-paper); } input { caret-color: var(--color-accent); }', '<main><input type="email"></main>')), 'unthemed-browser-surfaces')).toEqual([]);
    expect(only(run(page('', '<body class="selection:bg-accent [scrollbar-color:var(--color-muted)_var(--color-paper)]"><main><input type="email" class="caret-accent"></main></body>')), 'unthemed-browser-surfaces')).toEqual([]);
    expect(only(run(page('', '<main></main>').replace('--color-accent: oklch(50% 0.16 30); ', '')), 'unthemed-browser-surfaces')).toEqual([]);
  });
});

describe('design-lint finish: the document (F21, F22, F23)', () => {
  test('skipped-heading prints at polish when a level is skipped; stepped levels are clean', () => {
    const slop = page('', '<main>\n<h1>October</h1>\n<h3>Where the days went</h3>\n</main>');
    const hits = only(run(slop), 'skipped-heading');
    polishAt(hits, 'skipped-heading', lineOf(slop, '<h3>'));
    expect(hits[0].evidence).toBe('h1 is followed by h3 ("Where the days went")');
    expect(only(run(page('', '<main><h1>October</h1><h2>Where the days went</h2><h3>Matching</h3></main>')), 'skipped-heading')).toEqual([]);
  });

  test('justified-text prints at polish without hyphens: auto, in CSS or as text-justify; hyphenated justification is clean', () => {
    const slop = page('p {\n  text-align: justify;\n}', '<main><p>Three days were matching receipts.</p></main>');
    const hits = only(run(slop), 'justified-text');
    polishAt(hits, 'justified-text', lineOf(slop, 'text-align: justify'));
    expect(hits[0].evidence).toBe('justified text without hyphenation on p');
    const tw = page('', '<main>\n<p class="text-justify">Three days were matching receipts.</p>\n</main>');
    expect(only(run(tw), 'justified-text').map((f) => f.line)).toEqual([lineOf(tw, 'text-justify')]);
    expect(only(run(page('p { text-align: justify; hyphens: auto; }', '<main><p>Three days were matching receipts.</p></main>')), 'justified-text')).toEqual([]);
  });

  test('missing-lang prints at polish for <html> without lang; the title and description halves belong to the copy tier', () => {
    const slop = page('', '<main></main>', '');
    const hits = only(run(slop), 'missing-lang');
    polishAt(hits, 'missing-lang', lineOf(slop, '<html>'));
    expect(hits[0].evidence).toBe('<html> names no lang');
    expect(only(run(page('', '<main></main>')), 'missing-lang')).toEqual([]);
  });
});

describe('design-lint finish: fixtures', () => {
  test('the clean page raises nothing from this family; slopped.html plants the unbalanced head and the straight quotes; the waiver fixture waives balanced-display-head', async () => {
    const finish = new Set(['straight-quotes', 'three-dot-ellipsis', 'balanced-display-head', 'two-primary-buttons', 'icon-coin', 'display-figures-tabular', 'stamped-recipe', 'scroll-choreography-mix', 'fake-avatar', 'stock-person-photo', 'page-invariants', 'unthemed-browser-surfaces', 'skipped-heading', 'justified-text', 'missing-lang', 'hairline-under-shadow']);
    const clean = await lint([path.join(FIXTURES, 'clean')], { cwd: ROOT });
    expect(show(clean.findings.filter((f) => finish.has(f.rule)))).toEqual([]);
    const slopped = await lint([path.join(FIXTURES, 'slopped.html')], { cwd: ROOT });
    expect(only(slopped.findings, 'balanced-display-head').map((f) => [f.grade, f.line])).toEqual([['polish', 63]]);
    expect(only(slopped.findings, 'straight-quotes').map((f) => [f.grade, f.line])).toEqual([['polish', 141]]);
    const waiver = await lint([path.join(FIXTURES, 'waiver')], { cwd: ROOT });
    expect(only(waiver.findings, 'balanced-display-head').map((f) => f.grade)).toEqual(['waived']);
  });
});
