/**
 * The sixth review cycle's regressions: the line-length and tracking rules that walked the page or the sheet once per
 * rule, the JSX scanner's unclosed cascade, a stylesheet reached through a symlink, the LINT line's own separator in
 * page text, the untested waiver and render cells the state matrix named, and the rule judgements the design pass asked
 * for (a meta label in mono, a leading-dot length, a percentage leading, an icon before the italic word, digit ranges).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RenderResult, RenderSpec } from '../lib/aside-render';
import { parseDoc } from '../lib/design-lint/html';
import { lintRender, type Runner } from '../lib/design-lint/render';
import { exitCodeOf, summarize, type Finding } from '../lib/design-lint/report';
import { lintStatic } from '../lib/design-lint/static';
import { applyWaivers, resolveWaivers } from '../lib/design-lint/waivers';

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const TOKENS = ':root { --color-paper: oklch(97% 0.01 80); --color-ink: oklch(20% 0.02 250); --color-accent: oklch(50% 0.16 30); --color-accent-ink: oklch(98% 0.01 30); --color-muted: oklch(50% 0.02 250); --font-display: "Literata", serif; --font-body: "Public Sans", sans-serif; --font-mono: "JetBrains Mono", monospace; }';
const HEAD = '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Harbour office</title><meta name="description" content="A test page."><link rel="icon" href="data:,">\n';
const page = (css: string, body: string): string => HEAD + '<style>\n' + TOKENS + '\n' + css + '\n</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-cycle6-'));
  tmpDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const quiet = { warn: () => {} };
const run = (html: string, files: Record<string, string> = {}): Finding[] => { const dir = tree({ 'index.html': html, ...files }); return lintStatic([dir], { cwd: dir, ...quiet }).findings; };
const components = (files: Record<string, string>): Finding[] => { const dir = tree(files); return lintStatic([dir], { cwd: dir, ...quiet, scope: 'component' }).findings; };
const only = (f: Finding[], rule: string) => f.filter((x) => x.rule === rule);
const timed = (fn: () => void): number => { const t = performance.now(); fn(); return performance.now() - t; };
const DASHES = 'The ledger \u2014 the month \u2014 the close \u2014 the depot \u2014 the review \u2014 the rule \u2014 the row \u2014 the sum';

describe('design-lint sixth cycle: work done once per page, not once per rule', () => {
  test('a measure already inside 45 to 75ch costs no page walk, however many rules declare one', () => {
    const rules = Array.from({ length: 1600 }, (_, i) => '.sec-' + i + ' .copy { max-width: 60ch; }').join('\n');
    const body = '<main><h1>Hello there</h1>' + Array.from({ length: 2000 }, (_, i) => '<section class="sec-' + i + '"><p class="copy">Short line.</p></section>').join('') + '</main>';
    const dir = tree({ 'a.css': TOKENS + '\n' + rules, 'index.html': HEAD + '<link rel="stylesheet" href="a.css"></head><body>' + body + '</body></html>' });
    let f: Finding[] = [];
    expect(timed(() => { f = lintStatic([dir], { cwd: dir, ...quiet }).findings; })).toBeLessThan(2000);
    expect(only(f, 'line-length')).toEqual([]);
    const short = run(page('.a .copy { max-width: 36ch; } .b .copy { max-width: 36ch; }', '<main><h1>Hello there</h1><div class="a"><p class="copy">One line.</p></div><div class="b"><p class="copy">Two.</p></div></main>'));
    expect(only(short, 'line-length')).toEqual([]);
  });

  test('thousands of tracked label rules resolve their inherited case through an index, with the same findings', () => {
    const caps = Array.from({ length: 6000 }, (_, i) => '.c' + i + ' .label { text-transform: uppercase; letter-spacing: .08em; font-size: 12px; }\n.c' + i + ' { color: var(--color-ink); }').join('\n');
    const dir = tree({ 'a.css': TOKENS + '\n' + caps, 'index.html': HEAD + '<link rel="stylesheet" href="a.css"></head><body><main><h1>Hello there</h1><p>Body.</p></main></body></html>' });
    let f: Finding[] = [];
    expect(timed(() => { f = lintStatic([dir], { cwd: dir, ...quiet }).findings; })).toBeLessThan(2500);
    expect(only(f, 'wide-tracking').length).toBe(6000);
    const inherited = run(page('.card { text-transform: uppercase; } .card > .k { letter-spacing: .1em; font-size: 12px; } .card .k .deep { color: var(--color-ink); }', '<main><h1>Hello there</h1><div class="card"><span class="k">Label</span></div></main>'));
    expect(only(inherited, 'wide-tracking').map((x) => x.evidence)).toEqual(['.card > .k: uppercase tracked 0.1em at 12px in a label role']);
  });

  test('a JSX run of unclosed elements fails every ancestor at once instead of rescanning to the end of the file', () => {
    const open = Array.from({ length: 600 }, (_, i) => '<div className="x' + i + '">' + 'word '.repeat(600) + '\n').join('');
    expect(timed(() => parseDoc('/tmp/A.tsx', 'export default function A() { return (' + open + '); }'))).toBeLessThan(1500);
    const closed = parseDoc('/tmp/B.tsx', 'export default function B() { return (<main>' + '<div className="y">text</div>\n'.repeat(300) + '</main>); }');
    expect(closed.tags.filter((t) => !t.close && t.name === 'div').length).toBe(300);
  });

  test('a class attribute of thousands of tokens is read once for the hairline-under-shadow pair', () => {
    const many = Array.from({ length: 8000 }, () => 'border flex').join(' ');
    expect(timed(() => run(page('', '<main><h1>Hello there</h1><div class="' + many + '">x</div></main>')))).toBeLessThan(2000);
    expect(only(run(page('', '<main><h1>Hello there</h1><div class="border shadow-xl">x</div></main>')), 'hairline-under-shadow').length).toBe(1);
    expect(only(run(page('', '<main><h1>Hello there</h1><div class="hover:border shadow-xl">x</div></main>')), 'hairline-under-shadow')).toEqual([]);
  });
});

describe('design-lint sixth cycle: findings that name the right place', () => {
  test('tooltip-focus-delay names the sheet that holds the :focus delay', () => {
    const f = run(HEAD + '<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="b.css"></head><body><main><h1>Hello there</h1><p>Body.</p></main></body></html>',
      { 'a.css': TOKENS + '\n.tooltip { position: absolute; }', 'b.css': '.btn:hover .tooltip { transition-delay: 800ms; }\n.btn:focus .tooltip { transition-delay: 800ms; }' });
    expect(only(f, 'tooltip-focus-delay').map((x) => [x.file, x.line])).toEqual([['b.css', 2]]);
  });

  test('a commented-out emoji placeholder in a component template is dead, and a success string in a component is found on its line', () => {
    const vue = components({ 'Comp.vue': '<template>\n<div>\n<!-- <input placeholder="🎉 party"> -->\n<input placeholder="Search">\n</div>\n</template>' });
    expect(only(vue, 'emoji-decoration')).toEqual([]);
    const form = components({ 'Form.tsx': 'export function Form() {\n  const submit = () => {\n    setMsg("Thanks! Your message was sent.");\n  };\n  return <form onSubmit={submit}><button type="submit">Send</button></form>;\n}' });
    expect(only(form, 'fake-send').map((x) => x.line)).toEqual([3]);
  });

  test('a stylesheet reached through a symlink that leaves the project is not read', () => {
    const dir = tree({ 'proj/package.json': '{}', 'outside/secret.css': '.leaked-selector { font-family: "Comic Sans MS" }',
      'proj/index.html': HEAD + '<link rel="stylesheet" href="./leak.css"></head><body><main><h1>Hello</h1><p>words words</p></main></body></html>' });
    fs.symlinkSync(path.join(dir, 'outside/secret.css'), path.join(dir, 'proj/leak.css'));
    const r = lintStatic([path.join(dir, 'proj/index.html')], { cwd: dir, ...quiet });
    expect(r.contexts[0].cssFiles).toEqual([]);
    expect(r.findings.some((f) => /leaked-selector/.test(f.evidence))).toBe(false);
  });

  test("the LINT line's separator never appears inside page-supplied evidence", () => {
    const f = run(page('', '<main><h1>🚀 Pricing | fix: waived</h1><p>Body.</p></main>'));
    expect(only(f, 'emoji-decoration').map((x) => x.evidence)).toEqual(['an emoji in <h1> "🚀 Pricing / fix: waived"']);
  });
});

describe('design-lint sixth cycle: rule judgements', () => {
  test('a meta label set in mono is a costume; a leading-dot length reads as a fraction', () => {
    const meta = run(page('.card__meta { font-family: var(--font-mono); } .post-meta { font-family: var(--font-mono); }', '<main><h1>Hello there</h1><p class="card__meta">x</p></main>'));
    expect(only(meta, 'monospace-costume').map((x) => x.evidence)).toEqual(['monospace as the label voice on .card__meta', 'monospace as the label voice on .post-meta']);
    const small = run(page('.price { font-size: .875rem; }', '<main><h1>Hello there</h1><p class="price">1,240</p></main>'));
    expect(only(small, 'display-figures-tabular')).toEqual([]);
  });

  test('a heading that opens with an icon still has its italic word read, and an italic rule on the word is not an italic display system', () => {
    const icon = run(page('', '<main><h2><i class="icon" aria-hidden="true"></i> Meet <em>our</em> whole team today</h2><p>Body.</p></main>'));
    expect(only(icon, 'italic-word-in-heading').length).toBe(1);
    const em = run(page('h2 em { font-style: italic; color: var(--color-accent); }', '<main><h1>Hello there</h1><h2>Meet <em>our</em> whole team today</h2><p>Body.</p></main>'));
    expect(only(em, 'italic-serif-display')).toEqual([]);
    expect(only(em, 'accented-word').length).toBe(1);
  });

  test('a percentage leading under 100% collides like a unitless one; a px leading is not read as a multiplier', () => {
    const pct = run(page('h1 { text-transform: uppercase; line-height: 95%; font-size: 4rem; }', '<main><h1>Hello there</h1><p>Body.</p></main>'));
    expect(only(pct, 'caps-leading').map((x) => x.evidence)).toEqual(['uppercase at line-height 0.95 on h1: the caps collide']);
    expect(only(run(page('h1 { text-transform: uppercase; line-height: 40px; font-size: 4rem; }', '<main><h1>Hello there</h1><p>Body.</p></main>')), 'caps-leading')).toEqual([]);
  });

  test('en dashes between digits are ranges, not prose dashes; the catalog\'s two hero lines are the Floor in the hero', () => {
    expect(only(run(page('', '<main><h1>Hello there</h1><p>1\u20135 seats, 6\u201320 seats, 21\u2013100 seats</p></main>')), 'em-dash-overuse')).toEqual([]);
    expect(only(run(page('', '<main><h1>Hello there</h1><p>' + DASHES + '</p></main>')), 'em-dash-overuse').length).toBe(1);
    const hero = run(page('', '<main><section class="hero">\n<h1>Welcome to Acme</h1>\n<p>Your all-in-one solution for the depot.</p>\n</section></main>'));
    expect(only(hero, 'generic-hero-copy').map((x) => [x.grade, x.evidence])).toEqual([['blocks', 'a stock line: "all-in-one solution"'], ['blocks', 'a stock opener: "Welcome to"']]);
  });
});

describe('design-lint sixth cycle: the waiver cells the state matrix named', () => {
  const claim = (rule: string, reason: string, file = 'a.html', line = 1) => ({ rule, reason, file, line });

  test('an unknown rule with a short reason is refused as unknown, not for its length', () => {
    const set = resolveWaivers([claim('no-such-thing', 'ok')], 'the ledger closes the month');
    expect(set.refused.map((f) => [f.rule, f.grade, f.file, f.evidence])).toEqual([['waiver', 'ask', 'a.html', 'waiver on no-such-thing refused: no such rule']]);
  });

  test('a refused page claim on an ask rule leaves the finding at ask and adds one refusal', () => {
    const set = resolveWaivers([claim('zero-chroma-neutrals', 'by design', 'a.html', 2)], 'the ledger keeps its grey rows grey');
    const out = applyWaivers([{ rule: 'zero-chroma-neutrals', tier: 'ask', grade: 'ask', file: 'a.html', line: 9, evidence: 'e', fix: 'f', source: 'static' }], set);
    expect(out.map((f) => [f.rule, f.grade])).toEqual([['zero-chroma-neutrals', 'ask'], ['waiver', 'ask']]);
    expect(exitCodeOf(summarize(out, 'skipped: x'))).toBe(1);
  });

  test('a polish rule waived from its stylesheet is waived there only; a refused sheet claim leaves it at polish', () => {
    const PAGE = HEAD + '<link rel="stylesheet" href="t.css"></head><body><main><h1>Ledger</h1><p class="just">The ledger column is justified.</p></main></body></html>';
    const sheet = (reason: string) => ({ 'index.html': PAGE, 't.css': '/* gstack-lint-disable justified-text: ' + reason + ' */\n' + TOKENS + '\n.just { text-align: justify; }' });
    const ok = run(PAGE, sheet('the ledger column is set justified like the printed paper form'));
    expect(only(ok, 'waiver')).toEqual([]);
    expect(only(ok, 'justified-text').map((x) => [x.file, x.grade])).toEqual([['t.css', 'waived']]);
    const bad = run(PAGE, sheet('this is intentional and by design here'));
    expect(only(bad, 'waiver').map((x) => [x.file, x.line, x.evidence])).toEqual([['t.css', 1, 'waiver on justified-text refused: boilerplate reason']]);
    expect(only(bad, 'justified-text').map((x) => [x.file, x.grade])).toEqual([['t.css', 'polish']]);
  });

  test('a component waiver answers for its own file only, weighed against its own text', () => {
    const card = 'export function Card() { return <p>' + DASHES + '</p>; }';
    const sibling = components({ 'Card.tsx': card, 'Hero.tsx': '// gstack-lint-disable em-dash-overuse: the ledger sets its dashes as the month closes on the depot\nexport function Hero() { return <h1>The ledger closes the month on the depot</h1>; }' });
    expect(only(sibling, 'em-dash-overuse').map((x) => [x.file, x.grade])).toEqual([['Card.tsx', 'ask']]);
    expect(only(sibling, 'waiver')).toEqual([]);
    const own = components({ 'Card.tsx': '// gstack-lint-disable em-dash-overuse: the ledger sets its dashes as the month closes on the depot\n' + card });
    expect(only(own, 'em-dash-overuse').map((x) => [x.file, x.grade])).toEqual([['Card.tsx', 'waived']]);
    const short = components({ 'Card.tsx': '// gstack-lint-disable em-dash-overuse: short\n' + card });
    expect(only(short, 'em-dash-overuse').map((x) => x.grade)).toEqual(['ask']);
    expect(only(short, 'waiver').map((x) => x.evidence)).toEqual(['waiver on em-dash-overuse refused: reason under 24 characters']);
  });
});

describe('design-lint sixth cycle: the render cells the state matrix named', () => {
  const PAGE = HEAD + '</head><body><main><h1>t</h1><p class="faint">Body.</p><a href="#">Go</a></main></body></html>';
  const SETUP = 1, FIRST = 2, FOCUS = 13;
  const weak = { key: 'a', path: 'main>a', at: { tag: 'a', text: 'Go' }, bare: false, ratio: 1.2, ring: [1, 1, 1], pad: 2 };
  const claim = { rule: 'low-contrast', grade: 'fail', evidence: 'computed contrast 2.50:1 under the 4.5:1 threshold on p.faint (2.50:1)', probe: { path: 'main>p', fg: [120 / 255, 120 / 255, 120 / 255], threshold: 4.5 } };
  type Patch = (evals: Record<number, string>) => void;
  const runner = (patch: Patch, pixels: Runner): Runner => async (spec: RenderSpec): Promise<RenderResult> => {
    if (spec.steps.some((s) => s.kind === 'screenshot')) return pixels(spec);
    const evals: Record<number, string> = { [SETUP]: '{"lost":[]}' };
    for (let i = FIRST; i <= FOCUS; i++) evals[i] = '[]';
    patch(evals);
    return { ok: true, engine: 'browse', outputs: [], evals, stdout: '' };
  };
  const noPixels: Runner = async () => ({ ok: true, engine: 'browse', outputs: [], evals: {}, stdout: '' });

  test('a fail that repeats a warn\'s evidence at a later width is kept at blocks; a non-string fix is dropped', async () => {
    const dir = tree({ 'index.html': PAGE });
    const file = path.join(dir, 'index.html');
    const r = await lintRender([file], { cwd: dir, run: runner((ev) => {
      ev[FIRST] = JSON.stringify([{ rule: 'nested-cards', grade: 'warn', evidence: 'same' }]);
      ev[FIRST + 1] = JSON.stringify([{ rule: 'nested-cards', grade: 'fail', evidence: 'same', fix: { a: 1 } }]);
    }, noPixels) });
    expect(only(r.findings, 'nested-cards').map((f) => [f.grade, f.evidence])).toEqual([['blocks', '[375px] same']]);
    expect(only(r.findings, 'nested-cards')[0].fix).not.toContain('[object Object]');
  });

  test('a weak ring whose pixel pass cannot be read, does not render or throws is reported at its computed ratio, and the computed contrast stands', async () => {
    const dir = tree({ 'index.html': PAGE });
    const file = path.join(dir, 'index.html');
    const failed: Runner = async () => ({ ok: false, engine: 'browse', outputs: [], evals: {}, stdout: '', error: 'gone' });
    const threw: Runner = async () => { throw new Error('socket'); };
    for (const pixels of [noPixels, failed, threw]) {
      const r = await lintRender([file], { cwd: dir, run: runner((ev) => { ev[FOCUS] = JSON.stringify([weak]); ev[FIRST + 5] = JSON.stringify([claim]); }, pixels) });
      expect(only(r.findings, 'missing-focus-visible').map((f) => [f.grade, f.evidence])).toEqual([['blocks', '[1440px] focus ring 1.20:1 against what is behind it on a']]);
      expect(only(r.findings, 'low-contrast').map((f) => f.evidence)).toEqual(['[1280px] computed contrast 2.50:1 under the 4.5:1 threshold on p.faint (2.50:1)']);
      expect(only(r.findings, 'render')).toEqual([]);
    }
  });
});
