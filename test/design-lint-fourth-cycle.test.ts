/**
 * The fourth review cycle's regressions: commented-out markup dead for every rule, the shared tree pairing behind
 * Tailwind frames and wireframe slots, a parser that cannot be driven exponential or recursive by hostile CSS, lint
 * roots and cwd reached through a symlink, files the lint could not read reported instead of passing silently, and
 * the render tier keeping its measured findings when a page answers in the wrong shape.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RenderResult, RenderSpec } from '../lib/aside-render';
import { parseCss, pxOf, resolveVars } from '../lib/design-lint/css';
import { parseDoc, scriptSites } from '../lib/design-lint/html';
import { lintRender, type Runner } from '../lib/design-lint/render';
import { Reporter, type Finding } from '../lib/design-lint/report';
import { lintStatic, MAX_FILE_BYTES } from '../lib/design-lint/static';
import { FLOOR_REFUSAL, OWN_RULE_REFUSAL, applyWaivers, resolveWaivers, suspectedRules } from '../lib/design-lint/waivers';

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const TOKENS = ':root { --color-paper: oklch(97% 0.01 80); --color-ink: oklch(20% 0.02 250); --color-accent: oklch(50% 0.16 30); --color-accent-ink: oklch(98% 0.01 30); --color-muted: oklch(50% 0.02 250); --font-display: "Literata", serif; --font-body: "Public Sans", sans-serif; }';
const HEAD = '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Harbour office</title><meta name="description" content="A test page."><link rel="icon" href="data:,">\n';

function page(css: string, body: string): string {
  return HEAD + '<style>\n' + TOKENS + '\n' + css + '\n</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';
}

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-cycle4-'));
  tmpDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const quiet = { warn: () => {} };
const run = (html: string, files: Record<string, string> = {}): Finding[] => {
  const dir = tree({ 'index.html': html, ...files });
  return lintStatic([dir], { cwd: dir, ...quiet }).findings;
};
const only = (f: Finding[], rule: string) => f.filter((x) => x.rule === rule);
const rules = (f: Finding[]) => [...new Set(f.map((x) => x.rule))].sort();

describe('design-lint fourth cycle: commented-out markup is dead for every rule', () => {
  test('tells inside an HTML comment report nothing: inline literal, italic word, broken image, fake avatar, emoji, craft copy', () => {
    const live = page('', '<main><h1>The harbour office</h1><p>Rows close in order.</p></main>');
    const dead = page('', '<main><h1>The harbour office</h1><p>Rows close in order.</p></main>\n<!--\n<img alt="x"> <div style="color:#ff0000">x</div> <h2>a <em>b</em> word here</h2>\n<img src="https://thispersondoesnotexist.com/a.jpg" alt="face">\n<p>🚀 Unlock the power of seamless, cutting-edge solutions.</p>\n<section class="hero"><h2>Meet Sarah.</h2></section>\n-->');
    const before = rules(run(live));
    const after = run(dead);
    expect(rules(after)).toEqual(before);
    expect(only(after, 'literal-outside-tokens').concat(only(after, 'italic-word-in-heading'), only(after, 'broken-image'), only(after, 'fake-avatar'), only(after, 'generic-hero-copy'))).toEqual([]);
  });

  test('a commented-out module script does not make the page a build-only shell, so its page rules still run', () => {
    const body = '<main><h1>Harbour</h1><p>Rows.</p></main>';
    const shell = HEAD + '<script type="module" src="/src/main.tsx"></script></head><body>' + body + '</body></html>';
    const commented = HEAD + '<!-- <script type="module" src="/src/main.tsx"></script> --></head><body>' + body + '</body></html>';
    expect(only(run(shell), 'overflow-x-unclipped')).toEqual([]);
    expect(only(run(commented), 'overflow-x-unclipped').length).toBe(1);
  });
});

describe('design-lint fourth cycle: one pairing for every tree reader', () => {
  test('an unclosed <li> list before an eyebrow does not hide kicker-above-heading from the Tailwind frames', () => {
    const body = (li: string) => '<main><h1>Hi there</h1><ol><li>one' + li + '<li>two' + li + '</ol><section><p class="text-xs uppercase tracking-wider">Our depots</p><h2>Bergen and Stavanger</h2></section></main>';
    const closed = run(page('', body('</li>')));
    const open = run(page('', body('')));
    expect(only(closed, 'kicker-above-heading').length).toBeGreaterThan(0);
    expect(only(open, 'kicker-above-heading').map((f) => f.line)).toEqual(only(closed, 'kicker-above-heading').map((f) => f.line));
  });

  test('wireframe-slots groups a row of unclosed <li data-slot> items under their list', () => {
    const items = (close: string) => Array.from({ length: 6 }, (_, i) => '<li data-slot="s' + i + '"><span>x</span>' + close).join('\n');
    const f = run(page('', '<main><h1>Hi there</h1><ul class="row">' + items('') + '</ul></main>'));
    const closed = run(page('', '<main><h1>Hi there</h1><ul class="row">' + items('</li>') + '</ul></main>'));
    expect(only(f, 'wireframe-slots').map((x) => x.evidence)).toEqual(only(closed, 'wireframe-slots').map((x) => x.evidence));
    expect(only(f, 'wireframe-slots').some((x) => /in one row or grid/.test(x.evidence))).toBe(true);
  });

  test('a heading start tag closes an open heading and a block start closes an open <p>, so an unclosed run costs its length', () => {
    const doc = parseDoc('x.html', '<body>' + '<h2>Title <em>x</em>\n'.repeat(3000) + '<p>a<div>b</div>' + '</body>');
    const heads = doc.tags.filter((t) => !t.close && t.name === 'h2');
    expect(heads.length).toBe(3000);
    for (const frag of ['<h2>x ', '<button>x ', '<h2>a <em>x ', '<span class="a">x ']) {
      const dir = tree({ 'index.html': '<!doctype html><html lang="en"><head><title>t</title></head><body>' + frag.repeat(10000) + '</body></html>' });
      const t = performance.now();
      lintStatic([dir], { cwd: dir, ...quiet });
      expect(performance.now() - t, frag).toBeLessThan(8000);
    }
  }, 40_000);

  test('a component file of unclosed <script> openers parses in linear time', () => {
    for (const ext of ['vue', 'svelte', 'astro']) {
      const t = performance.now();
      parseDoc('x.' + ext, '<script>'.repeat(48000));
      expect(performance.now() - t, ext).toBeLessThan(2000);
    }
    const t = performance.now();
    scriptSites('<template>' + '<script setup>\nconst a = 1;\n'.repeat(8000) + '</template>', 'vue');
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe('design-lint fourth cycle: hostile CSS', () => {
  test('a self-referential token resolves in bounded time and a chain resolves fully', () => {
    const t = performance.now();
    expect(resolveVars('var(--a)', { '--a': 'var(--a) ' + 'x'.repeat(40) })).toContain('x');
    expect(resolveVars('var(--a)', { '--a': 'var(--b)', '--b': 'var(--a)' })).toMatch(/var\(--[ab]\)/);
    expect(resolveVars('var(--a)', { '--a': 'var(--b) 1px', '--b': 'red' })).toBe('red 1px');
    expect(performance.now() - t).toBeLessThan(2000);
    const grown = resolveVars('var(--a)', { '--a': 'var(--b) var(--b)', '--b': 'var(--c) var(--c)', '--c': 'var(--d) var(--d)', '--d': 'var(--e) var(--e)', '--e': 'y'.repeat(2048) });
    expect(grown.length).toBeLessThan(40000);
  });

  test('parseCss bounds @media nesting the way it bounds rule nesting, inline or linked', () => {
    const depth = 20_000;
    const css = '@media (min-width:1px){'.repeat(depth) + 'a{color:red}' + '}'.repeat(depth);
    const t = performance.now();
    expect(() => parseCss(css, 'deep.css')).not.toThrow();
    expect(performance.now() - t).toBeLessThan(3000);
    const dir = tree({ 'index.html': HEAD + '<style>' + css + '</style></head><body><main><h1>Hi</h1><p>Body.</p></main></body></html>' });
    expect(() => lintStatic([dir], { cwd: dir, ...quiet })).not.toThrow();
  });

  test('pxOf reads leading-dot lengths', () => {
    expect(pxOf('.875rem')).toBe(14);
    expect(pxOf('-.5em')).toBe(-8);
    const f = run(page('.meta { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; }', '<main><h1>Hi there</h1><p class="meta">Our depots</p><p>Body copy here.</p></main>'));
    expect(only(f, 'wide-tracking').map((x) => x.evidence)).toEqual(['.meta: uppercase tracked 0.08em at 12px in a label role']);
  });
});

describe('design-lint fourth cycle: roots, cwd and files the lint could not read', () => {
  test('a lint root reached through a symlink prints cwd-relative paths and still attaches a root-relative stylesheet', () => {
    const real = tree({ 'css/a.css': TOKENS + '\nhtml, body { overflow-x: clip; }', 'index.html': HEAD + '<link rel="stylesheet" href="/css/a.css"></head><body><main><h1>Hi</h1><p>Body.</p></main></body></html>' });
    const link = real + '-link';
    fs.symlinkSync(real, link);
    tmpDirs.push(link);
    const r = lintStatic([link], { cwd: link, ...quiet });
    expect(r.findings.every((f) => !path.isAbsolute(f.file))).toBe(true);
    expect(only(r.findings, 'overflow-x-unclipped')).toEqual([]);
    expect(r.contexts.length).toBe(1);
    expect(r.contexts[0].cssFiles.map((c) => path.basename(c.file))).toEqual(['a.css']);
  });

  test('an oversize page is one internal-error finding, not a silent pass, and an oversize linked stylesheet is skipped with a warning', () => {
    const big = 'x'.repeat(MAX_FILE_BYTES + 1);
    const dir = tree({ 'index.html': page('', '<main><h1>Hi</h1><p>Body.</p></main>'), 'huge.html': '<!doctype html>' + big, 'huge.css': '/* ' + big + ' */', 'linked.html': HEAD + '<link rel="stylesheet" href="huge.css"></head><body><main><h1>Hi</h1><p>Body.</p></main></body></html>' });
    const warnings: string[] = [];
    const r = lintStatic([dir], { cwd: dir, warn: (l) => warnings.push(l) });
    expect(only(r.findings, 'internal-error').map((f) => [f.grade, f.file, /over the 2 MB limit/.test(f.evidence)]).sort()).toEqual([['ask', 'huge.css', true], ['ask', 'huge.html', true]]);
    expect(warnings.some((w) => /huge\.css.*over the 2 MB limit/.test(w))).toBe(true);
    expect(r.files.map((f) => path.basename(f)).sort()).toEqual(['index.html', 'linked.html']);
  });

  test('a stylesheet with a whitespace run in its name still waives its own finding', () => {
    const dir = tree({
      'index.html': HEAD + '<link rel="stylesheet" href="my  theme.css"></head><body><main><h1>The ledger</h1><p>The ledger keeps its grey rows grey.</p></main></body></html>',
      'my  theme.css': '/* gstack-lint-disable zero-chroma-neutrals: the ledger keeps its grey rows grey */\n' + TOKENS + '\n:root { --color-gray: oklch(55% 0 0); }\n.row { border-color: var(--color-gray); }',
    });
    const f = lintStatic([dir], { cwd: dir, ...quiet }).findings;
    expect(only(f, 'waiver')).toEqual([]);
    expect(only(f, 'zero-chroma-neutrals').map((x) => [x.grade, x.file])).toEqual([['waived', 'my theme.css']]);
  });
});

describe('design-lint fourth cycle: rule judgement', () => {
  test('overused-font catches the full family names of catalog stems and leaves a longer word alone', () => {
    for (const face of ['Cormorant Garamond', 'Crimson Pro', 'DM Serif Display', 'Geist Sans']) {
      const f = run(page(':root { --font-display: "' + face + '", serif; }', '<main><h1>Hi there</h1><p>Body.</p></main>'));
      expect(only(f, 'overused-font').length, face).toBeGreaterThan(0);
    }
    const inter = run(page(':root { --font-display: "Interstate", sans-serif; }', '<main><h1>Hi there</h1><p>Body.</p></main>'));
    expect(only(inter, 'overused-font')).toEqual([]);
  });

  test('a container capped with width: min() is not a wide-container finding', () => {
    const f = run(page('.wrap { width: min(100% - 2rem, 72rem); margin-inline: auto; }\n.hero__visual { width: 40vw; height: 300px; }', '<div class="wrap"><section class="hero"><h1>Hi there</h1><div class="hero__visual"></div></section></div>'));
    expect(only(f, 'wide-container')).toEqual([]);
    const bare = run(page('.wrap { width: 100%; }\n.hero__visual { width: 40vw; height: 300px; }', '<div class="wrap"><section class="hero"><h1>Hi there</h1><div class="hero__visual"></div></section></div>'));
    expect(only(bare, 'wide-container').length).toBeGreaterThan(0);
  });

  test('a box-shadow focus ring beside a border-colour change is not input-state-shift; a border-only focus state still is', () => {
    const body = '<main><h1>Hi there</h1><form><label for="e">Email</label><input id="e" type="text"><button>Go</button></form></main>';
    const ring = run(page('input { border: 1px solid var(--color-ink); }\ninput:focus { border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent); }', body));
    expect(only(ring, 'input-state-shift')).toEqual([]);
    const border = run(page('input { border: 1px solid var(--color-ink); }\ninput:focus { border-color: var(--color-accent); }', body));
    expect(only(border, 'input-state-shift').length).toBe(1);
  });

  test('a Meet heading below the hero is suspected, not the Floor; inside the hero it blocks', () => {
    const below = run(page('', '<section class="hero"><h1>Hi there</h1><p>Lead.</p></section><section><h2>Meet Sarah.</h2><p>Sarah runs the depot.</p></section>'));
    expect(only(below, 'generic-hero-copy').map((x) => x.grade)).toEqual(['ask']);
    const inside = run(page('', '<section class="hero"><h1>Hi there</h1><h2>Meet Sarah.</h2></section>'));
    expect(only(inside, 'generic-hero-copy').map((x) => x.grade)).toEqual(['blocks']);
  });
});

describe('design-lint fourth cycle: render answers of the wrong shape', () => {
  const PAGE = HEAD + '</head><body><main><h1>t</h1><p>Body.</p></main></body></html>';
  const SETUP = 1, FIRST = 2, FOCUS = 13;
  const runner = (patch: (evals: Record<number, string>, spec: RenderSpec) => void): Runner => async (spec: RenderSpec): Promise<RenderResult> => {
    const evals: Record<number, string> = { [SETUP]: '{"lost":[]}' };
    for (let i = FIRST; i <= FOCUS; i++) evals[i] = '[]';
    patch(evals, spec);
    return { ok: true, engine: 'browse', outputs: [], evals, stdout: '' };
  };

  test('a non-array measure, a null entry, a bad grade and an at without a tag each name their probe and keep the other measured findings', async () => {
    const dir = tree({ 'index.html': PAGE });
    const file = path.join(dir, 'index.html');
    for (const bad of ['5', '{}', '[null]', '{"error":5}']) {
      const r = await lintRender([file], { cwd: dir, run: runner((ev) => { ev[FIRST] = JSON.stringify([{ rule: 'horizontal-scroll', grade: 'fail', evidence: 'the hero overflows' }]); ev[FIRST + 2] = bad; }) });
      expect(only(r.findings, 'horizontal-scroll').map((f) => f.evidence), bad).toEqual(['[320px] the hero overflows']);
      expect(only(r.findings, 'render').map((f) => f.evidence), bad).toEqual([expect.stringMatching(/^the \w+ measurement at \d+px failed: /)]);
    }
    const odd = await lintRender([file], { cwd: dir, run: runner((ev) => {
      ev[FIRST] = JSON.stringify([{ rule: 'horizontal-scroll', grade: 'fail', evidence: 'the hero overflows' }, { rule: 'nested-cards', grade: 'fail', evidence: 'x', at: {} }, { rule: 'nested-cards', grade: 'maybe', evidence: 'y' }, { rule: 7, evidence: 'z' }]);
      ev[FOCUS] = JSON.stringify([{ bare: true }, { key: 'a.skip', bare: false, ratio: 5 }]);
    }) });
    expect(only(odd.findings, 'horizontal-scroll').map((f) => f.evidence)).toEqual(['[320px] the hero overflows']);
    expect(only(odd.findings, 'nested-cards').map((f) => [f.grade, f.line])).toEqual([['blocks', 1]]);
    expect(only(odd.findings, 'render').map((f) => /\((.*?)\)/.exec(f.evidence)![1])).toEqual(['nested-cards', '7', 'focus']);
    expect(only(odd.findings, 'missing-focus-visible')).toEqual([]);
  });

  test('a setup answer without a list of lost assets blocks as unprepared and the measures are still read', async () => {
    const dir = tree({ 'index.html': PAGE });
    const file = path.join(dir, 'index.html');
    const r = await lintRender([file], { cwd: dir, run: runner((ev) => { ev[SETUP] = '{}'; ev[FIRST] = JSON.stringify([{ rule: 'horizontal-scroll', grade: 'fail', evidence: 'the hero overflows' }]); }) });
    expect(only(r.findings, 'render').map((f) => f.evidence)).toEqual(['the page could not be prepared for measurement: the setup answer has no list of lost assets']);
    expect(only(r.findings, 'horizontal-scroll').length).toBe(1);
  });

  test('merging horizontal-scroll widths never repeats the kept width', async () => {
    const dir = tree({ 'index.html': PAGE });
    const file = path.join(dir, 'index.html');
    const r = await lintRender([file], { cwd: dir, run: runner((ev) => {
      ev[FIRST] = JSON.stringify([{ rule: 'horizontal-scroll', grade: 'warn', evidence: 'may' }, { rule: 'horizontal-scroll', grade: 'fail', evidence: 'does' }]);
      ev[FIRST + 1] = JSON.stringify([{ rule: 'horizontal-scroll', grade: 'warn', evidence: 'also' }]);
    }) });
    expect(only(r.findings, 'horizontal-scroll').map((f) => [f.grade, f.evidence])).toEqual([['blocks', '[320px] does (also at 375px)']]);
  });
});

describe('design-lint fourth cycle: never-waivable classes refuse by class before the reason is weighed', () => {
  test('a short reason on an own rule, a measured Floor rule and a Floor rule nobody found is refused by class, never for its length', () => {
    const measured = new Reporter('page', '/x');
    measured.report('nested-cards', '/x/a.html', 4, 'div.card > div.card');
    const claims = ['render', 'nested-cards', 'horizontal-scroll'].map((rule) => ({ rule, reason: 'fine here', file: '/x/a.html', line: 1 }));
    const set = resolveWaivers(claims, 'the ledger closes the month', '/x', suspectedRules(measured.findings));
    expect(set.refused.map((f) => f.evidence)).toEqual([
      `waiver on render refused: ${OWN_RULE_REFUSAL}`,
      `waiver on nested-cards refused: ${FLOOR_REFUSAL}`,
      `waiver on horizontal-scroll refused: ${FLOOR_REFUSAL}`,
    ]);
    expect(applyWaivers(measured.findings, set).map((f) => [f.rule, f.grade])).toEqual([['nested-cards', 'blocks'], ['waiver', 'ask'], ['waiver', 'ask'], ['waiver', 'ask']]);
  });
});

describe('design-lint fourth cycle: the pixel pass with a readable screenshot', () => {
  const PAGE = HEAD + '</head><body><main><h1>t</h1><p class="faint">Body.</p><a href="#">Go</a></main></body></html>';
  const SWATCH = path.join(path.resolve(import.meta.dir, '..'), 'test', 'fixtures', 'design-lint', 'render', 'swatch.png');
  const SETUP = 1, FIRST = 2, FOCUS = 13;

  test('a contrast claim is dropped when the pixels behind it clear the threshold, rewritten when they confirm it, and a weak ring that clears on the pixels around it is dropped', async () => {
    // swatch.png is 8x8, red on the left half and blue on the right; the page rects are in CSS pixels, scaled to the screenshot by its width
    const dir = tree({ 'index.html': PAGE });
    const file = path.join(dir, 'index.html');
    const white = { rule: 'low-contrast', grade: 'fail', evidence: 'computed contrast 2.50:1 under the 4.5:1 threshold on h1 (2.50:1)', probe: { path: 'main>h1', fg: [1, 1, 1], threshold: 4.5 } };
    const grey = { rule: 'low-contrast', grade: 'fail', evidence: 'computed contrast 2.50:1 under the 4.5:1 threshold on p.faint (2.50:1)', probe: { path: 'main>p', fg: [120 / 255, 120 / 255, 120 / 255], threshold: 4.5 } };
    const ring = { key: 'a', path: 'main>a', at: { tag: 'a', text: 'Go' }, bare: false, ratio: 1.2, ring: [1, 1, 1], pad: 2 };
    const shots: string[] = [];
    const run: Runner = async (spec: RenderSpec): Promise<RenderResult> => {
      const evals: Record<number, string> = {};
      const shot = spec.steps.findIndex((s) => s.kind === 'screenshot');
      if (shot < 0) {
        evals[SETUP] = '{"lost":[]}';
        for (let i = FIRST; i <= FOCUS; i++) evals[i] = '[]';
        evals[FIRST + 5] = JSON.stringify([white, grey]);
        evals[FOCUS] = JSON.stringify([ring]);
        return { ok: true, engine: 'browse', outputs: [], evals, stdout: '' };
      }
      spec.steps.forEach((s, i) => {
        if (s.kind !== 'screenshot') return;
        fs.copyFileSync(SWATCH, s.out);
        shots.push(path.basename(s.out));
        const width = s.width ?? 0, half = width / 2;
        evals[i - 1] = s.out.endsWith('text.png') ? JSON.stringify([{ x: 0, y: 0, w: half, h: width }, { x: half, y: 0, w: half, h: width }]) : JSON.stringify([{ x: 0, y: 0, w: half, h: width }]);
      });
      return { ok: true, engine: 'browse', outputs: [], evals, stdout: '' };
    };
    const r = await lintRender([file], { cwd: dir, run });
    expect(shots.sort()).toEqual(['ring.png', 'text.png']);
    expect(only(r.findings, 'low-contrast').map((f) => f.evidence)).toEqual(['[1280px] contrast 2.29:1 against the pixels behind, under the 4.5:1 threshold on p.faint (2.29:1)']);
    expect(only(r.findings, 'missing-focus-visible')).toEqual([]);
  });
});
