/**
 * The eighth review cycle's regressions: the waiver branch keyed to the context's shape rather than the --scope flag
 * (a lone component beside an unlinked stylesheet answers for its own file; a page under --scope component still
 * answers for the sheet it links), the bare `<` tails (`<1`, `< `, an unclosed comment), the craft check's lazy
 * scans over repeated unclosed openers, component tags paired once per file, an arithmetic repeat() count, an
 * unclosed @starting-style block, the import scan over a gradient class line, the render tier's locator on a class
 * value holding a `>`, tickers answered from the tree, a tooltip duration that is not a delay, a class attribute of
 * many tokens, and one emoji-decoration per emoji icon in a component file.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseCss, resolveVars, selectorNames } from '../lib/design-lint/css';
import { parseDoc, parseHtml, stripTags } from '../lib/design-lint/html';
import { lineOf } from '../lib/design-lint/render';
import { glAccent, glLayout } from '../lib/design-lint/render-probe';
import { glHeroSpace, glWide, glWords } from '../lib/design-lint/render-probe-space';
import { Reporter, type Finding } from '../lib/design-lint/report';
import { run as runAssets } from '../lib/design-lint/rules/assets';
import { run as runCopy } from '../lib/design-lint/rules/copy';
import { lintStatic } from '../lib/design-lint/static';
import { compInner } from '../lib/design-lint/tailwind';

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const TOKENS = ':root { --color-paper: oklch(97% 0.01 80); --color-ink: oklch(20% 0.02 250); --color-accent: oklch(50% 0.16 30); --color-accent-ink: oklch(98% 0.01 30); --color-muted: oklch(50% 0.02 250); --font-display: "Literata", serif; --font-body: "Public Sans", sans-serif; }';
const HEAD = '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Harbour office</title><meta name="description" content="A test page."><link rel="icon" href="data:,">\n';
const GREY = TOKENS + '\n:root { --color-gray: oklch(55% 0 0); }\n.row { border-color: var(--color-gray); }';
const DASHES = 'The ledger \u2014 the month \u2014 the close \u2014 the depot \u2014 the review \u2014 the rule \u2014 the row \u2014 the sum';
const CARD = 'export function Card() { return <p>' + DASHES + '</p>; }';

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-cycle8-'));
  tmpDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const quiet = { warn: () => {} };
const only = (f: Finding[], rule: string) => f.filter((x) => x.rule === rule);
const timed = (fn: () => void): number => { const t = performance.now(); fn(); return performance.now() - t; };
const lintDir = (files: Record<string, string>, scope?: 'page' | 'component'): { findings: Finding[]; warns: string[] } => {
  const dir = tree(files);
  const warns: string[] = [];
  return { findings: lintStatic([dir], { cwd: dir, warn: (l: string) => warns.push(l), ...(scope ? { scope } : {}) }).findings, warns };
};

describe('design-lint eighth cycle: the waiver branch follows the context, not the flag', () => {
  test('a lone component beside an unlinked stylesheet answers for its own file under either scope', () => {
    for (const scope of ['page', 'component'] as const) {
      const { findings } = lintDir({ 'Hero.tsx': '// gstack-lint-disable zero-chroma-neutrals: the ledger keeps its grey rows grey on the depot\nexport function Hero() { return <h1 className="row">The ledger keeps its grey rows grey on the depot</h1>; }', 'theme.css': GREY }, scope);
      expect(only(findings, 'zero-chroma-neutrals').map((x) => [x.file, x.grade]), scope).toEqual([['theme.css', 'ask']]);
    }
  });

  test('default scope, one component: a short claim is refused at its line and the finding stays ask', () => {
    const { findings } = lintDir({ 'Card.tsx': '// gstack-lint-disable em-dash-overuse: short\n' + CARD });
    expect(only(findings, 'em-dash-overuse').map((x) => [x.file, x.grade])).toEqual([['Card.tsx', 'ask']]);
    expect(only(findings, 'waiver').map((x) => [x.file, x.line, x.evidence])).toEqual([['Card.tsx', 1, 'waiver on em-dash-overuse refused: reason under 24 characters']]);
  });

  test('under --scope component a page claim still answers a finding in the stylesheet it links, and a short one is refused', () => {
    const page = (reason: string) => '<!-- gstack-lint-disable zero-chroma-neutrals: ' + reason + ' -->\n' + HEAD + '<link rel="stylesheet" href="theme.css"></head><body><main><h1>The ledger</h1><p>The ledger keeps its grey rows grey on the depot.</p></main></body></html>';
    const ok = lintDir({ 'index.html': page('the ledger keeps its grey rows grey on the depot'), 'theme.css': GREY }, 'component').findings;
    expect(only(ok, 'waiver')).toEqual([]);
    expect(only(ok, 'zero-chroma-neutrals').map((x) => [x.file, x.grade])).toEqual([['theme.css', 'waived']]);
    const bad = lintDir({ 'index.html': page('short'), 'theme.css': GREY }, 'component').findings;
    expect(only(bad, 'zero-chroma-neutrals').map((x) => [x.file, x.grade])).toEqual([['theme.css', 'ask']]);
    expect(only(bad, 'waiver').map((x) => [x.file, x.line, x.evidence])).toEqual([['index.html', 1, 'waiver on zero-chroma-neutrals refused: reason under 24 characters']]);
  });
});

describe('design-lint eighth cycle: a file costs its length', () => {
  test('a heading whose tail is thousands of bare < characters lints in linear time', () => {
    const dir = tree({ 'index.html': HEAD + '</head><body><h1>' + ' x <'.repeat(80_000) });
    expect(timed(() => lintStatic([dir], { cwd: dir, ...quiet }))).toBeLessThan(5000);
  }, 60_000);

  test('a page whose tail is a run of <1 or of unclosed comment starts costs its length, and a doctype survives', () => {
    const dir = tree({
      'a.html': HEAD + '</head><body><p>hi</p></body></html>' + '<1'.repeat(200_000),
      'b.html': HEAD + '</head><body>' + '<!-- x'.repeat(100_000) + '</body></html>',
    });
    expect(timed(() => lintStatic([dir], { cwd: dir, ...quiet }))).toBeLessThan(5000);
    const doc = parseHtml('x.html', '<!doctype html><p>a < b and 1<2</p><!-- gone');
    expect(doc.src.startsWith('<!doctype html>')).toBe(true);
    expect(doc.src.indexOf('<', '<!doctype html>'.length)).toBe(doc.src.indexOf('<p>'));
    expect(doc.src.includes('<!--')).toBe(false);
    expect(doc.tags.map((t) => t.name)).toEqual(['p', 'p']);
    expect(parseHtml('x.html', '<p>Fees are <1% of volume and <b>nothing</b> else</p>').text.replace(/\s+/g, ' ').trim()).toBe('Fees are 1% of volume and nothing else');
  }, 60_000);

  test('repeated unclosed <script>, <nav>, <style> and <template> openers cost the copy tier their length', () => {
    for (const tag of ['<script>', '<nav>', '<style>', '<template>', '<nav><a href="/a">A</a>']) {
      const doc = parseHtml('x.html', HEAD + '</head><body>' + tag.repeat(60_000) + '</body></html>');
      const reporter = new Reporter('page', '/');
      expect(timed(() => runCopy({ docs: [doc] } as never, reporter)), tag).toBeLessThan(3000);
    }
    const doc = parseHtml('x.html', HEAD + '</head><body><nav><a href="/a">A</a><a href="/b">B</a></nav><nav><main id="m"><h1>Hello there</h1></main></body></html>');
    const reporter = new Reporter('page', '/');
    runCopy({ docs: [doc] } as never, reporter);
    expect(reporter.findings.map((f) => f.rule)).toContain('missing-aria-current');
  }, 60_000);

  test('a template of thousands of unclosed component tags costs its length', () => {
    const dir = tree({ 'Card.vue': '<template>\n' + '<Foo class="p-4">x\n'.repeat(80_000) + '</template>' });
    expect(timed(() => lintStatic([dir], { cwd: dir, ...quiet }))).toBeLessThan(3000);
    const doc = parseDoc('/x/App.vue', '<template><Foo><Bar>in</Bar><Foo>deep</Foo>out</Foo><Baz /></template>');
    expect(doc.comps.filter((c) => !c.close && !c.selfClosing).map((_, i) => compInner(doc, doc.comps.indexOf(doc.comps.filter((c) => !c.close && !c.selfClosing)[i])))).toEqual(['<Bar>in</Bar><Foo>deep</Foo>out', 'in', 'deep']);
    expect(compInner(doc, doc.comps.length - 1)).toBe('');
  });

  test('a huge repeat() count in grid-template-columns neither throws nor allocates', () => {
    const { findings, warns } = lintDir({
      'index.html': HEAD + '<link rel="stylesheet" href="style.css"></head><body><section class="grid"><h1>Hi</h1><p>x</p></section></body></html>',
      'style.css': TOKENS + '\n.grid { grid-template-columns: 1fr 1fr; }\n@media (min-width: 1600px) { .grid { grid-template-columns: repeat(4294967296, 1fr); } }',
    });
    expect(warns.filter((w) => /internal error/.test(w))).toEqual([]);
    expect(only(findings, 'internal-error')).toEqual([]);
    expect(only(findings, 'wide-container').map((f) => f.evidence)).toEqual([expect.stringContaining('(2 to 4294967296)')]);
    const named = lintDir({
      'index.html': HEAD + '<link rel="stylesheet" href="style.css"></head><body><main><section class="grid"><h1>Hi</h1><p>x</p></section></main></body></html>',
      'style.css': TOKENS + '\n.grid { grid-template-columns: repeat(12, 1fr); }\n@media (min-width: 1600px) { .grid { grid-template-columns: repeat(12, [col-start] 1fr) [col-end]; } }',
    }).findings;
    expect(only(named, 'wide-container')).toEqual([]);
  });

  test('unclosed @starting-style blocks cost their length, not the sheet squared', () => {
    const dir = tree({ 'style.css': '.a { opacity: 0 }\n' + '@starting-style {\n'.repeat(8000) + '.b { color: red }\n'.repeat(8000) });
    const warns: string[] = [];
    expect(timed(() => lintStatic([dir], { cwd: dir, warn: (l: string) => warns.push(l) }))).toBeLessThan(2000);
    expect(warns.filter((w) => /internal error/.test(w))).toEqual([]);
  });

  test('ten thousand unclosed <em> under headings cost the assets rules their length', () => {
    const doc = parseDoc('x.html', HEAD + '</head><body>' + '<h2>a <em>x '.repeat(10000) + '</body></html>');
    const reporter = new Reporter('page', '/');
    expect(timed(() => runAssets({ docs: [doc], cssFiles: [], rules: [], tokens: {}, twTokens: null, allCss: '', cache: {} } as never, reporter))).toBeLessThan(3000);
  });

  test('a deeply nested comma selector list costs its length, not parts^depth', () => {
    const css = 'a,b{'.repeat(40) + 'color:red' + '}'.repeat(40);
    let rules: ReturnType<typeof parseCss> = [];
    expect(timed(() => { rules = parseCss(css, 'x.css'); })).toBeLessThan(2000);
    expect(rules.reduce((n, x) => n + x.selector.length, 0)).toBeLessThan(1_000_000);
    expect(parseCss('.a, .b { .c, .d { color: red } }', 'x.css').map((x) => x.selector)).toEqual(['.a, .b', ':is(.a, .b) .c, :is(.a, .b) .d']);
    const amp = '.' + 'a'.repeat(4000) + '{' + '&&&&&&&&&&&&&&&&{color:red}'.repeat(20_000) + '}';
    let nested: ReturnType<typeof parseCss> = [];
    expect(timed(() => { nested = parseCss(amp, 'x.css'); })).toBeLessThan(2000);
    expect(nested.length).toBe(20_001);
    expect(nested.every((x) => x.selector.length <= 8192)).toBe(true);
    const long = parseCss('.' + 'a'.repeat(50_000) + ', .b{' + '&{color:red}'.repeat(20_000) + '}', 'x.css');
    expect(long.length).toBe(20_001);
    expect(long.every((x) => x.selector.length <= 8192)).toBe(true);
    expect(long.slice(1).reduce((n, x) => n + x.selector.length, 0)).toBeLessThan(10_000_000);
    expect(timed(() => selectorNames(long.map((x) => x.selector)))).toBeLessThan(500);
  });

  test('a huge token value is not expanded into every reference', () => {
    const tokens = { '--a': 'x'.repeat(1_000_000), '--b': 'blue' };
    const value = 'var(--a) '.repeat(900).trim();
    let out = '';
    expect(timed(() => { out = resolveVars(value, tokens); })).toBeLessThan(200);
    expect(out).toBe(value);
    expect(resolveVars('1px solid var(--b)', tokens)).toBe('1px solid blue');
  });

  test('a stylesheet or <style> block the lint could not parse is an internal-error finding, not a silent pass', () => {
    const boom = 'a,b{'.repeat(30) + 'color:red' + '}'.repeat(30);
    const inline = lintDir({ 'index.html': HEAD + '<style>' + boom + ' * { transition: all .3s ease }</style></head><body><main><h1>Hi</h1></main></body></html>' }).findings;
    expect(only(inline, 'layout-transition').map((f) => f.grade)).toEqual(['blocks']);
    expect(only(inline, 'internal-error')).toEqual([]);
    const big = lintDir({ 'index.html': HEAD + '<link rel="stylesheet" href="big.css"></head><body><main><h1>Hi</h1></main></body></html>', 'big.css': '.a{color:red}\n'.repeat(160_000) }).findings;
    expect(only(big, 'internal-error').map((f) => [f.file, f.grade])).toEqual([['big.css', 'ask']]);
    const unreadable = lintDir({ 'index.html': HEAD + '<link rel="stylesheet" href="dir.css"></head><body><main><h1>Hi</h1></main></body></html>', 'dir.css/.keep': '' }).findings;
    expect(only(unreadable, 'internal-error').map((f) => [f.file, f.fix])).toEqual([['dir.css', 'check the path']]);
    expect(only(unreadable, 'internal-error')[0].evidence).toMatch(/cannot be read \(EISDIR\)/);
  });

  test('a long gradient className line, or an import word before a long whitespace run, costs the asset scan its length; ES imports still name their libraries', () => {
    const dir = tree({ 'Hero.tsx': 'export default function Hero(){ return (<div className="' + 'bg-gradient-to-r from-indigo-500 to-violet-500 '.repeat(20_000) + '">x</div>); }' });
    expect(timed(() => lintStatic([dir], { cwd: dir, ...quiet }))).toBeLessThan(5000);
    const spaced = tree({ 'Hero.tsx': 'export function Hero() { return <div>x</div>; }\n// import' + ' '.repeat(300_000) + 'x' });
    expect(timed(() => lintStatic([spaced], { cwd: spaced, ...quiet }))).toBeLessThan(3000);
    const nav = tree({ 'Nav.tsx': "import { Check } from 'lucide-react';\nimport { StarIcon } from '@heroicons/react/24/solid';\nexport const Nav = () => <nav><Check /><StarIcon /></nav>;\n" });
    expect(only(lintStatic([nav], { cwd: nav, ...quiet }).findings, 'two-icon-libraries').map((f) => f.evidence)).toEqual(['icon libraries mixed on one page: heroicons and lucide']);
  }, 60_000);

  test('thousands of distinct families, narrow prose classes, nowrap rules, wrapping rules or em rules beside thousands of elements cost their length', () => {
    const fams = tree({ 'style.css': Array.from({ length: 40_000 }, (_, i) => `.f${i}{font-family:"Fam${i}"}`).join('\n') });
    expect(timed(() => lintStatic([fams], { cwd: fams, ...quiet })), 'families').toBeLessThan(10_000);
    const prose = tree({ 'index.html': HEAD + '<link rel="stylesheet" href="style.css"></head><body><main>' + '<p class="x">hi</p>\n'.repeat(40_000) + '</main></body></html>', 'style.css': Array.from({ length: 20_000 }, (_, i) => `.copy${i}{max-width:30ch}`).join('\n') });
    expect(timed(() => lintStatic([prose], { cwd: prose, ...quiet })), 'prose').toBeLessThan(10_000);
    const nowrap = tree({ 'index.html': HEAD + '<link rel="stylesheet" href="style.css"></head><body><main>' + '<button class="btn">A long label that certainly wraps around</button>\n'.repeat(8_000) + '</main></body></html>', 'style.css': Array.from({ length: 20_000 }, (_, i) => `.nw${i}{white-space:nowrap}`).join('\n') });
    expect(timed(() => lintStatic([nowrap], { cwd: nowrap, ...quiet })), 'nowrap').toBeLessThan(10_000);
    const wrap = tree({ 'index.html': HEAD + '<link rel="stylesheet" href="style.css"></head><body>' + '<main><h1>Supercalifragilisticexpialidocious here</h1></main>\n'.repeat(8_000) + '</body></html>', 'style.css': Array.from({ length: 60_000 }, (_, i) => `.a${i}{color:red}`).join('\n') });
    expect(timed(() => lintStatic([wrap], { cwd: wrap, ...quiet })), 'wrap').toBeLessThan(10_000);
    const em = tree({ 'index.html': HEAD + '<link rel="stylesheet" href="style.css"></head><body><main>' + '<h2>Hello <em>there</em> friend</h2>\n'.repeat(10_000) + '</main></body></html>', 'style.css': Array.from({ length: 10_000 }, (_, i) => `.n${i} em{font-style:normal}`).join('\n') });
    expect(timed(() => lintStatic([em], { cwd: em, ...quiet })), 'em').toBeLessThan(10_000);
  }, 60_000);

  test('an unclosed JSX expression at the end of a deep element, or a malformed close tag under it, costs the file its length', () => {
    const src = 'export default function A(){ return (' + '<div>'.repeat(200) + '{ ' + 'x '.repeat(1_000_000) + ')';
    expect(timed(() => parseDoc('/x/App.tsx', src))).toBeLessThan(2000);
    const bad = 'export default function A(){ return (' + '<div>'.repeat(190) + 'x '.repeat(500_000) + '</div foo>' + '</div>'.repeat(189) + '); }';
    expect(timed(() => parseDoc('/x/App.tsx', bad))).toBeLessThan(500);
  });

  test('stripTags with a limit stops reading once the limit is passed, and a heading of thousands of classed spans costs its length', () => {
    const inner = '<p>' + 'lorem ipsum dolor '.repeat(60_000) + '</p>';
    expect(timed(() => { for (let k = 0; k < 500; k++) stripTags(inner, false, 4); })).toBeLessThan(500);
    expect(stripTags('<b>x</b> hi', false, 4)).toBe(' x  hi');
    expect(stripTags('<b>x</b> hi there friend', false, 4).length).toBeLessThan(' x  hi there friend'.length);
    expect(stripTags('\u00a0\u{1F680}\u00a0\u{1F680}\u00a0\u{1F680} more', false, 4)).toBe('\u00a0\u{1F680}\u00a0\u{1F680}\u00a0\u{1F680}');
    const padded = '\u{1F680}\u00a0\u00a0\u00a0\u00a0 hello world';
    expect(stripTags(padded, false, 4).replace(/\s+/g, ' ').trim().length > 4).toBe(stripTags(padded).replace(/\s+/g, ' ').trim().length > 4);
    const nested = tree({ 'index.html': HEAD + '</head><body>' + '<div>'.repeat(500) + '<p>' + 'lorem ipsum dolor '.repeat(60_000) + '</p>' + '</div>'.repeat(500) + '</body></html>' });
    expect(timed(() => lintStatic([nested], { cwd: nested, ...quiet })), 'nested').toBeLessThan(4000);
    const spans = Array.from({ length: 4000 }, (_, i) => '<span class="c">w' + i + '</span> ').join('');
    const dir = tree({ 'index.html': HEAD + '</head><body><main><h1>' + spans + '</h1><p>Body.</p></main></body></html>' });
    expect(timed(() => lintStatic([dir], { cwd: dir, ...quiet })), 'spans').toBeLessThan(1500);
  }, 60_000);

  test('the render locator costs the page its length when a class value holds a >, and refuses a tag that is not one', () => {
    const src = parseHtml('x.html', '<html><body><div class="' + 'a '.repeat(150_000) + '>"><p>x</p></div></body></html>').src;
    expect(timed(() => lineOf(src, { tag: 'div', cls: 'a', text: 'zzz' }))).toBeLessThan(2000);
    const tail = parseHtml('x.html', '<p>hi</p>' + '<1'.repeat(160_000)).src;
    expect(timed(() => expect(lineOf(tail, { tag: '1', cls: '', text: 'zz' })).toBe(1))).toBeLessThan(500);
    expect(lineOf('<x>\n<p class="lede big">Hello</p>', { tag: 'p', cls: 'big', text: 'hello' })).toBe(2);
    expect(lineOf('<x>\n<p data-class="x" class="lede big">Hello</p>', { tag: 'p', cls: 'big', text: 'hello' })).toBe(2);
    expect(lineOf('<x>\n<p class="lede big">Hello</p>', { tag: 'p', cls: 'x'.repeat(401), text: 'hello' })).toBe(2);
  }, 60_000);

  test('thousands of ticker elements beside thousands of text elements cost their length', () => {
    const dir = tree({ 'index.html': HEAD + '</head><body>' + '<i class="ticker"></i><span>x</span>'.repeat(40_000) + '</body></html>' });
    expect(timed(() => lintStatic([dir], { cwd: dir, ...quiet }))).toBeLessThan(4000);
    const f = lintDir({ 'index.html': HEAD + '</head><body><div class="ticker"><p><span>One · two · three</span></p></div><p>Four · five · six</p></body></html>' }).findings;
    expect(only(f, 'template-punctuation').map((x) => x.evidence)).toEqual(['middle dots join a meta string: "Four · five · six"']);
  }, 60_000);

  test('a class attribute with 700k tokens does not overflow the stack', () => {
    const { warns } = lintDir({ 'index.html': HEAD + '</head><body><div class="' + 'a '.repeat(700_000) + '"><h1>Hi</h1></div></body></html>\n' });
    expect(warns.filter((w) => /Maximum call stack/.test(w))).toEqual([]);
  });
});

describe('design-lint eighth cycle: rule judgements', () => {
  test('tooltip-focus-delay reads a delay, not a 0.2s fade', () => {
    const tip = (t: string) => lintDir({ 'index.html': HEAD + '<style>' + TOKENS + ' .tooltip:hover .tip { transition: ' + t + '; opacity: 1 } .tooltip:focus-within .tip { transition: ' + t + '; opacity: 1 }</style></head><body><main><h1>Hello there</h1><span class="tooltip" tabindex="0">?<span class="tip">Help</span></span></main></body></html>' }).findings;
    expect(only(tip('opacity 0.2s'), 'tooltip-focus-delay')).toEqual([]);
    expect(only(tip('opacity 200ms'), 'tooltip-focus-delay')).toEqual([]);
    expect(only(tip('opacity .5s ease'), 'tooltip-focus-delay')).toEqual([]);
    expect(only(tip('opacity 1s'), 'tooltip-focus-delay')).toEqual([]);
    expect(only(tip('opacity 0.2s 0.1s'), 'tooltip-focus-delay').map((f) => f.grade)).toEqual(['ask']);
    expect(only(tip('opacity 200ms cubic-bezier(0.4, 0, 0.2, 1) 500ms'), 'tooltip-focus-delay').map((f) => f.grade)).toEqual(['ask']);
    expect(only(tip('opacity 0.2s steps(4, end) 1s'), 'tooltip-focus-delay').map((f) => f.grade)).toEqual(['ask']);
    expect(only(tip('opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1)'), 'tooltip-focus-delay')).toEqual([]);
    expect(only(tip('opacity 0.2s 1s'), 'tooltip-focus-delay').map((f) => f.grade)).toEqual(['ask']);
    expect(only(tip('opacity 200ms 600ms'), 'tooltip-focus-delay').map((f) => f.grade)).toEqual(['ask']);
  });

  test('one emoji-decoration per emoji icon in a component file, however the parent wraps it', () => {
    const { findings } = lintDir({ 'Card.tsx': 'export function Card() { return <div>\n<div className="icon"><Icon>\u{1F680}</Icon></div>\n<div className="icon"><Icon>\u{1F680}</Icon></div>\n<div className="feature"><Icon>\u{1F680}</Icon><h3>Fast</h3></div>\n</div>; }' });
    expect(only(findings, 'emoji-decoration').map((f) => [f.line, f.evidence])).toEqual([[2, 'emoji icon "\u{1F680}" in <Icon>'], [3, 'emoji icon "\u{1F680}" in <Icon>'], [4, 'emoji icon "\u{1F680}" in <Icon>']]);
  });

  test('the probes read their viewport from the page, not a literal', () => {
    for (const fn of [glLayout, glAccent]) expect(fn.toString()).not.toMatch(/\b800\b|1280x800/);
    for (const fn of [glHeroSpace, glWide, glWords]) expect(fn.toString()).not.toMatch(/1440x900|\b900(?:px)?\b|1920x1080|at 1920/);
    expect([...selectorNames([':is(a, button)']).tags].sort()).toEqual(['a', 'button']);
    expect([...selectorNames(['nav :where(h1, h2) em']).tags].sort()).toEqual(['em', 'h1', 'h2', 'nav']);
  });

  test('thousands of nested children under a long parent cost the sheet its length, and a whitespace run does not defeat the stripTags limit', () => {
    const src = '.' + 'a'.repeat(8000) + '{' + '&{}'.repeat(200_000) + '}';
    let rules: ReturnType<typeof parseCss> = [];
    expect(timed(() => { rules = parseCss(src, 'x.css'); }), 'amp').toBeLessThan(3000);
    expect(rules.length).toBe(200_001);
    expect(rules.reduce((n, x) => n + x.selector.length, 0)).toBeLessThan(src.length * 8);
    expect(rules[1].selector.startsWith('.aaaa')).toBe(true);
    expect(rules[200_000].selector).toBe('&');
    const kids = Array.from({ length: 200_000 }, (_, k) => `.a${k}{}`).join('');
    const desc = parseCss('.' + 'a'.repeat(8000) + '{' + kids + '}', 'y.css');
    expect(desc.reduce((n, x) => n + x.selector.length, 0)).toBeLessThan((kids.length + 8002) * 8);
    expect(desc[200_000].selector).toBe('.a199999');
    const ws = ' '.repeat(1_000_000);
    expect(timed(() => { for (let k = 0; k < 500; k++) stripTags(ws, false, 4); }), 'spaces').toBeLessThan(2000);
    expect(timed(() => { for (let k = 0; k < 500; k++) stripTags('\u00a0'.repeat(1_000_000), false, 4); }), 'nbsp').toBeLessThan(2000);
    const label = ' '.repeat(10_000) + 'Start your fourteen day free trial now today';
    expect(stripTags(label, false, 40).trim()).toBe(stripTags(label).trim());
    expect(stripTags(' '.repeat(10_000) + '\u{1F680}', false, 4).trim()).toBe('\u{1F680}');
    for (const n of [4351, 4352, 4353]) expect(stripTags(' '.repeat(n) + '\u{1F600} more text', false, 4).isWellFormed()).toBe(true);
    expect(stripTags(' '.repeat(5000) + 'hello world', false, 4).trim()).toBe('hello');
  }, 60_000);

  test('an escaped quote does not rewrite the rest of a sheet, and a declaration string may hold ; or }', () => {
    const rules = parseCss('.q::before { content: "\\""; } .a { color: red } .b { content: "a;b}c"; color: blue } .c {}', 'x.css');
    expect(rules.map((x) => x.selector)).toEqual(['.q::before', '.a', '.b', '.c']);
    expect(rules[2].decls.map((d) => d.prop + '=' + d.value)).toEqual(['content="a;b}c"', 'color=blue']);
    expect(parseCss(".x { font-family: 'It\\'s'; } .y { color: red }", 'y.css').map((x) => x.selector)).toEqual(['.x', '.y']);
  });

  test('a @starting-style block waives content-hidden-at-rest only for the selectors it names, whole', () => {
    const sheet = '@starting-style { .reveal-wrap { opacity: 0 } } .reveal { opacity: 0; transform: translateY(24px) } .reveal-wrap { opacity: 0; transform: translateY(24px) } .fade { opacity: 0; transform: translateY(8px); @starting-style { opacity: 0 } }';
    const { findings } = lintDir({ 'theme.css': TOKENS + '\n' + sheet, 'index.html': HEAD + '<link rel="stylesheet" href="theme.css"></head><body><main><h1>The ledger</h1><p class="reveal">a</p><p class="reveal-wrap">b</p><p class="fade">c</p></main></body></html>' });
    expect(only(findings, 'content-hidden-at-rest').map((x) => x.evidence.split(' ')[0])).toEqual(['.reveal']);
  });

  test('aria-hidden must be "true" to count as hidden decoration', () => {
    const page = (hidden: string) => HEAD + '</head><body><main><h1>The ledger</h1><svg ' + hidden + ' width="10" height="10"></svg></main></body></html>';
    expect(only(lintDir({ 'index.html': page('aria-hidden="false"') }).findings, 'unlabeled-decoration').length).toBe(1);
    expect(only(lintDir({ 'index.html': page('aria-hidden="true"') }).findings, 'unlabeled-decoration').length).toBe(0);
  });

  test('outside any project a relative stylesheet href is bounded by the working directory', () => {
    const base = tree({ 'outside/secret.css': '.leak { color: #000; background: #fff }', 'site/index.html': HEAD + '<link rel="stylesheet" href="../outside/secret.css"></head><body><main><h1>The ledger</h1></main></body></html>' });
    const site = path.join(base, 'site');
    expect(lintStatic([site], { cwd: site, ...quiet }).findings.some((x) => x.file.includes('secret.css'))).toBe(false);
    expect(lintStatic([site], { cwd: base, ...quiet }).findings.some((x) => x.file.includes('secret.css'))).toBe(true);
    const inside = tree({ 'site/css/a.css': '.leak { color: #000; background: #fff }', 'site/index.html': HEAD + '<link rel="stylesheet" href="css/a.css"></head><body><main><h1>The ledger</h1></main></body></html>' });
    expect(lintStatic([path.join(inside, 'site')], { cwd: path.join(inside, 'site'), ...quiet }).findings.some((x) => x.file.includes('a.css'))).toBe(true);
  });

  test('the emoji classes spell their variation selector and joiner as escapes', () => {
    expect(fs.readFileSync(path.join(import.meta.dir, '../lib/design-lint/rules/assets.ts'), 'utf8')).not.toMatch(/[\uFE0F\u200D]/);
  });
});
