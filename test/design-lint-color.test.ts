import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatFinding, type Finding } from '../lib/design-lint/report';
import { lintStatic } from '../lib/design-lint/static';

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'design-lint');

/** 1-based line of the first line holding the needle. */
const lineOf = (text: string, needle: string): number => {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`needle not in page: ${needle}`);
  return text.slice(0, i).split('\n').length;
};

const TOKENS = `:root {
  --color-paper: oklch(97% 0.01 250);
  --color-ink: oklch(20% 0.02 250);
  --color-muted: oklch(45% 0.02 250);
  --color-accent: oklch(55% 0.15 250);
  --color-accent-ink: oklch(98% 0.01 250);
  --font-display: "Literata", Georgia, serif;
  --font-body: "Public Sans", sans-serif;
}`;

/** A page whose <style> holds the tokens and the css, and whose <body> holds the markup. */
const page = (css: string, body = '<h1>Ledger</h1><p>The books close on the first.</p>', tokens = TOKENS): string =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Ledger</title>\n<style>\n${tokens}\n${css}\n</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

function lintPage(html: string, name = 'index.html'): { html: string; findings: Finding[]; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-color-'));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, html);
  return { html, dir, findings: lintStatic([file], { cwd: dir, warn: (l) => { throw new Error(l); } }).findings };
}

const byRule = (findings: Finding[], rule: string): Finding[] => findings.filter((f) => f.rule === rule);
const lines = (findings: Finding[]): string[] => findings.map(formatFinding);

describe('design-lint colour: purple-blue-gradient (2a, blocks)', () => {
  test('a single-hue ramp and a repeating pattern are not findings', () => {
    const { findings } = lintPage(page('.band { background: linear-gradient(90deg, oklch(60% 0.2 250), oklch(75% 0.15 250)); }\n.grain { background: repeating-linear-gradient(45deg, oklch(60% 0.2 300) 0 2px, oklch(60% 0.2 240) 2px 4px); }'));
    expect(lines(byRule(findings, 'purple-blue-gradient'))).toEqual([]);
  });
  test('purple to blue on a band, purple to pink as text, and cyan on dark paper each block at the declaration', () => {
    const band = lintPage(page('.band { background: linear-gradient(90deg, oklch(60% 0.2 300), oklch(60% 0.2 240)); }'));
    const f = byRule(band.findings, 'purple-blue-gradient');
    expect(f.map((x) => [x.grade, x.line, x.evidence, x.fix])).toEqual([['blocks', lineOf(band.html, '.band {'), 'purple-to-blue gradient on .band', 'one anchor hue; drop the gradient']]);
    const text = lintPage(page('h1 {\n  background: linear-gradient(90deg, oklch(60% 0.2 300), oklch(65% 0.2 350));\n  -webkit-background-clip: text;\n  color: transparent;\n}'));
    expect(byRule(text.findings, 'purple-blue-gradient').map((x) => [x.grade, x.line, x.evidence])).toEqual([['blocks', lineOf(text.html, '-webkit-background-clip'), 'purple-to-pink gradient text on h1']]);
    expect(byRule(text.findings, 'gradient-text')).toEqual([]);
    const dark = TOKENS.replace('--color-paper: oklch(97% 0.01 250)', '--color-paper: oklch(18% 0.02 250)');
    const cyan = lintPage(page('.glow { background: radial-gradient(circle, oklch(70% 0.15 200), transparent); }', undefined, dark));
    expect(byRule(cyan.findings, 'purple-blue-gradient').map((x) => x.evidence)).toEqual(['cyan-on-dark gradient on .glow']);
    const light = lintPage(page('.glow { background: radial-gradient(circle, oklch(70% 0.15 200), transparent); }'));
    expect(byRule(light.findings, 'purple-blue-gradient')).toEqual([]);
  });
});

describe('design-lint colour: gradient-text (2b, ask)', () => {
  test('a solid heading is clean', () => {
    const { findings } = lintPage(page('h1 { color: var(--color-ink); }'));
    expect(byRule(findings, 'gradient-text')).toEqual([]);
  });
  test('text clipped to a one-hue ramp asks at the background-clip line', () => {
    const { html, findings } = lintPage(page('h1 {\n  background: linear-gradient(90deg, oklch(60% 0.2 250), oklch(70% 0.15 250));\n  background-clip: text;\n  color: transparent;\n}'));
    expect(byRule(findings, 'gradient-text').map((x) => [x.grade, x.line, x.evidence])).toEqual([['ask', lineOf(html, 'background-clip: text'), 'gradient text on h1']]);
  });
});

describe('design-lint colour: pure-black-white (7a, blocks) and absolute-surface-token (7b, ask)', () => {
  test('tinted ink and paper, and a translucent white, are clean', () => {
    const { findings } = lintPage(page('.card { color: oklch(10% 0.02 250); background: rgb(255 255 255 / 0.6); border-color: oklch(99% 0.005 250); }'));
    expect(lines([...byRule(findings, 'pure-black-white'), ...byRule(findings, 'absolute-surface-token')])).toEqual([]);
  });
  test('#000 written on a rule blocks; a token that resolves to pure white asks, as does every use of it', () => {
    const { html, findings } = lintPage(page('.card { color: #000; }\n.panel { background: var(--color-sheet); }', undefined, TOKENS + '\n:root { --color-sheet: #ffffff; }'));
    expect(byRule(findings, 'pure-black-white').map((x) => [x.grade, x.line, x.evidence])).toEqual([['blocks', lineOf(html, '.card {'), 'color: #000 on .card is pure black (#000)']]);
    expect(byRule(findings, 'absolute-surface-token').map((x) => [x.grade, x.line, x.evidence])).toEqual([
      ['ask', lineOf(html, '--color-sheet: #ffffff'), '--color-sheet: #ffffff on :root is pure white (#fff)'],
      ['ask', lineOf(html, '.panel {'), 'background: var(--color-sheet) on .panel is pure white (#fff)'],
    ]);
  });
});

describe('design-lint colour: zero-chroma-neutrals (22, ask)', () => {
  test('a neutral with chroma, a translucent grey and a filter value are clean', () => {
    const { findings } = lintPage(page('.rule { border-color: oklch(85% 0.005 250); background: oklch(50% 0 0 / 0.4); filter: drop-shadow(0 1px oklch(50% 0 0)); }'));
    expect(byRule(findings, 'zero-chroma-neutrals')).toEqual([]);
  });
  test('a zero-chroma oklch token asks at its line', () => {
    const { html, findings } = lintPage(page('.rule { border-color: var(--color-gray); }', undefined, TOKENS + '\n:root { --color-gray: oklch(55% 0 0); }'));
    expect(byRule(findings, 'zero-chroma-neutrals').map((x) => [x.grade, x.line, x.evidence])).toEqual([['ask', lineOf(html, '--color-gray:'), 'zero-chroma oklch(55% 0 0) as --color-gray on :root']]);
  });
});

describe('design-lint colour: accent-footprint (23, ask)', () => {
  test('the accent on a button, a faint accent wash and a soft token are clean', () => {
    const { findings } = lintPage(page('.button { background: var(--color-accent); }\nsection.hero { background: var(--color-accent-soft); }\n.band { background: oklch(from var(--color-accent) l c h / 0.1); }\n.stat { color: var(--color-accent); font-size: 1.5rem; }'));
    expect(byRule(findings, 'accent-footprint')).toEqual([]);
  });
  test('an accent fill on a surface or a tall block, and display-size accent text, each ask with a specific fix', () => {
    const { html, findings } = lintPage(page('section.hero { background: var(--color-accent); }\n.tall { min-height: 50vh; background: var(--color-accent); }\n.stat { color: var(--color-accent); font-size: clamp(2rem, 5vw, 4rem); }'));
    expect(byRule(findings, 'accent-footprint').map((x) => [x.grade, x.line, x.evidence, x.fix])).toEqual([
      ['ask', lineOf(html, 'section.hero {'), 'accent background on the viewport-scale rule "section.hero"', 'retreat the accent to actions and one signal; a large fill belongs to the paper or a field token'],
      ['ask', lineOf(html, '.tall {'), 'accent background on the viewport-scale rule ".tall"', 'retreat the accent to actions and one signal; a large fill belongs to the paper or a field token'],
      ['ask', lineOf(html, '.stat {'), 'display-size text set in the accent on ".stat"', 'set display type in ink; the accent marks small signals'],
    ]);
  });
});

describe('design-lint colour: glow-wash (29, ask)', () => {
  test('an offset neutral shadow, a mild blur and an opaque backdrop are clean', () => {
    const { findings } = lintPage(page('.card { box-shadow: 0 4px 24px oklch(20% 0.02 250 / 0.2); }\n.hero::before { position: absolute; filter: blur(20px); }\n.nav { backdrop-filter: blur(12px); background: var(--color-paper); }'));
    expect(byRule(findings, 'glow-wash')).toEqual([]);
  });
  test('a glass panel, a coloured zero-offset glow and a blurred orb each ask once', () => {
    const { html, findings } = lintPage(page('.nav {\n  backdrop-filter: blur(12px);\n  background: rgb(255 255 255 / 0.1);\n}\n.button { box-shadow: 0 0 40px oklch(60% 0.2 300), 0 0 60px oklch(60% 0.2 300); }\n.hero::before {\n  position: absolute;\n  filter: blur(80px);\n}'));
    expect(byRule(findings, 'glow-wash').map((x) => [x.grade, x.line, x.evidence, x.fix])).toEqual([
      ['ask', lineOf(html, 'backdrop-filter: blur(12px)'), 'glass panel: backdrop-filter blur over a translucent white on .nav', 'a solid or grained surface; elevation by lightness'],
      ['ask', lineOf(html, '.button {'), 'coloured zero-offset glow (blur 40px) on .button', 'shadows carry offset and blur in a neutral; colour is not depth'],
      ['ask', lineOf(html, 'filter: blur(80px)'), 'blurred orb: filter blur(80px) on the positioned .hero::before', 'delete the wash; a surface is paper or ground, not a light show'],
    ]);
  });
});

describe('design-lint colour: cream-palette (65, ask)', () => {
  const cream = TOKENS.replace('--color-paper: oklch(97% 0.01 250)', '--color-paper: oklch(97% 0.012 80)').replace('--color-accent: oklch(55% 0.15 250)', '--color-accent: oklch(52% 0.16 30)');
  test('cream paper and a clay accent under a display face that is not a high-contrast serif are clean', () => {
    const { findings } = lintPage(page('', undefined, cream));
    expect(byRule(findings, 'cream-palette')).toEqual([]);
  });
  test('cream paper, Fraunces and a clay accent together ask at line 1', () => {
    const { findings } = lintPage(page('', undefined, cream.replace('"Literata"', '"Fraunces"')));
    expect(byRule(findings, 'cream-palette').map((x) => [x.grade, x.line, x.evidence])).toEqual([['ask', 1, 'the default tasteful look: cream paper (L 97%, hue 80), fraunces as the display and a clay accent (hue 30)']]);
  });
});

describe('design-lint colour: framework-palette (74, ask)', () => {
  test('a colour mixed for the page is clean', () => {
    const { findings } = lintPage(page(''));
    expect(byRule(findings, 'framework-palette')).toEqual([]);
  });
  test('a Tailwind default swatch as a token asks at its line', () => {
    const { html, findings } = lintPage(page('', undefined, TOKENS + '\n:root { --color-brand: #6366F1; }'));
    expect(byRule(findings, 'framework-palette').map((x) => [x.grade, x.line, x.evidence])).toEqual([['ask', lineOf(html, '--color-brand'), "Tailwind's default #6366F1 as --color-brand"]]);
  });
});

describe('design-lint colour: literal-outside-tokens (48, blocks)', () => {
  test('token references, generic families and a fully transparent literal are clean', () => {
    const { findings } = lintPage(page('.card { color: var(--color-ink); font-family: sans-serif; background: rgba(0, 0, 0, 0); }', '<p style="margin: 0">Ledger</p>'));
    expect(byRule(findings, 'literal-outside-tokens')).toEqual([]);
  });
  test('a colour literal, a font-family literal and an inline style colour each block at their line', () => {
    const { html, findings } = lintPage(page('.promo { color: #e91e63; }\n.quote { font-family: "Playfair Display", serif; }', '<p style="color: #333">Ledger</p>'));
    expect(byRule(findings, 'literal-outside-tokens').map((x) => [x.grade, x.line, x.evidence])).toEqual([
      ['blocks', lineOf(html, '.promo {'), 'colour literal #e91e63 outside the token block (color on .promo)'],
      ['blocks', lineOf(html, '.quote {'), 'font-family literal ""Playfair Display", serif" on .quote'],
      ['blocks', lineOf(html, 'style="color: #333"'), 'inline style colour literal #333'],
    ]);
  });
});

// The Tailwind forms of 2a/2b are the component family's (rules/component.ts, test/design-lint-tailwind.test.ts).

describe('design-lint colour: fixtures', () => {
  const MINE = new Set(['purple-blue-gradient', 'gradient-text', 'pure-black-white', 'absolute-surface-token', 'zero-chroma-neutrals', 'accent-footprint', 'glow-wash', 'cream-palette', 'framework-palette', 'literal-outside-tokens']);
  test('the clean page has no colour finding', () => {
    const { findings } = lintStatic([path.join(FIXTURES, 'clean')], { cwd: ROOT });
    expect(lines(findings.filter((f) => MINE.has(f.rule)))).toEqual([]);
  });
  test('slopped.html: the purple-to-blue gradient text blocks, the three literals block, the pure tokens and the zero-chroma grey ask', () => {
    const file = path.join(FIXTURES, 'slopped.html');
    const html = fs.readFileSync(file, 'utf8');
    const { findings } = lintStatic([file], { cwd: ROOT });
    const mine = findings.filter((f) => MINE.has(f.rule)).map((f) => [f.rule, f.grade, f.line]);
    expect(mine).toEqual(expect.arrayContaining([
      ['purple-blue-gradient', 'blocks', lineOf(html, '-webkit-background-clip: text')],
      ['literal-outside-tokens', 'blocks', lineOf(html, 'linear-gradient(90deg, #8b5cf6, #3b82f6)')],
      ['literal-outside-tokens', 'blocks', lineOf(html, '.promo { color: #e91e63; }')],
      ['absolute-surface-token', 'ask', lineOf(html, '--color-paper: #ffffff')],
      ['absolute-surface-token', 'ask', lineOf(html, '--color-ink: #000000')],
      ['zero-chroma-neutrals', 'ask', lineOf(html, '--color-gray: oklch(55% 0 0)')],
    ]));
    expect(mine.filter((m) => m[0] === 'gradient-text')).toEqual([]);
    expect(mine.filter((m) => m[0] === 'absolute-surface-token')).toHaveLength(5);
    expect(mine.filter((m) => m[0] === 'literal-outside-tokens')).toHaveLength(3);
  });
  test('the waiver fixture: the black paper and the grey ink are waived on the record, never blocked', () => {
    const { findings } = lintStatic([path.join(FIXTURES, 'waiver')], { cwd: ROOT });
    expect(byRule(findings, 'absolute-surface-token').map((f) => f.grade)).toEqual(['waived', 'waived']);
    expect(byRule(findings, 'zero-chroma-neutrals').map((f) => f.grade)).toEqual(['waived']);
    expect(byRule(findings, 'pure-black-white')).toEqual([]);
  });
});

describe('design-lint colour: the indigo-to-violet ramp (third review cycle)', () => {
  test('a near single-hue indigo ramp is not the indigo-to-violet gradient; stops twelve degrees apart are', () => {
    const near = lintPage(page('.band { background: linear-gradient(90deg, oklch(60% 0.2 253), oklch(70% 0.15 258)); }'));
    expect(lines(byRule(near.findings, 'purple-blue-gradient'))).toEqual([]);
    const ramp = lintPage(page('.band { background: linear-gradient(90deg, oklch(60% 0.2 275), oklch(70% 0.15 300)); }'));
    expect(byRule(ramp.findings, 'purple-blue-gradient').map((f) => [f.grade, f.evidence])).toEqual([['blocks', expect.stringContaining('indigo-to-violet')]]);
  });
});
