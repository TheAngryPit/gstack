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
const lineOf = (text: string, needle: string, nth = 1): number => {
  let i = -1;
  for (let n = 0; n < nth; n++) {
    i = text.indexOf(needle, i + 1);
    if (i < 0) throw new Error(`needle not in page: ${needle}`);
  }
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-type-'));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, html);
  return { html, dir, findings: lintStatic([file], { cwd: dir, warn: (l) => { throw new Error(l); } }).findings };
}

const byRule = (findings: Finding[], rule: string): Finding[] => findings.filter((f) => f.rule === rule);
const lines = (findings: Finding[]): string[] => findings.map(formatFinding);
describe('design-lint type: overused-font (1, ask)', () => {
  test('a chosen display face, and Inter as the body face only, are clean', () => {
    const { findings } = lintPage(page('h1 { font-family: var(--font-display); }', undefined, TOKENS.replace('"Public Sans", sans-serif', '"Inter", sans-serif')));
    expect(byRule(findings, 'overused-font')).toEqual([]);
  });
  test('Poppins as --font-display and Inter on an h2 each ask at their line, once per place', () => {
    const { html, findings } = lintPage(page('h1 { font-family: var(--font-display); }\nh2 { font-family: "Inter", sans-serif; }\nh2.alt { font-family: "Inter", sans-serif; }', undefined, TOKENS.replace('"Literata", Georgia, serif', '"Poppins", sans-serif')));
    expect(byRule(findings, 'overused-font').map((x) => [x.grade, x.line, x.evidence])).toEqual([
      ['ask', lineOf(html, '--font-display:'), '"poppins" as the display face (--font-display)'],
      ['ask', lineOf(html, 'h1 {'), '"poppins" as the display face (h1)'],
      ['ask', lineOf(html, 'h2 {'), '"inter" as the display face (h2)'],
      ['ask', lineOf(html, 'h2.alt {'), '"inter" as the display face (h2.alt)'],
    ]);
  });
});

describe('design-lint type: line-length (25, ask)', () => {
  test('a 62ch paragraph, a 30ch lede and a 32ch class whose paragraphs are one short sentence are clean', () => {
    const { findings } = lintPage(page('p { max-width: 62ch; }\n.lede { max-width: 30ch; }\n.copy { max-width: 32ch; }', '<p class="copy">One short sentence.</p>'));
    expect(byRule(findings, 'line-length')).toEqual([]);
  });
  test('a 90ch paragraph and a 40ch prose block ask with the range in the evidence', () => {
    const { html, findings } = lintPage(page('p { max-width: 90ch; }\n.prose { max-width: 40ch; }', '<div class="prose"><p>The first sentence runs on. The second does too. The third as well, so this is prose and not a lede.</p></div>'));
    expect(byRule(findings, 'line-length').map((x) => [x.grade, x.line, x.evidence, x.fix])).toEqual([
      ['ask', lineOf(html, 'p { max-width: 90ch'), 'a measure of 90ch on p (45 to 75ch reads well)', 'max-width between 45 and 75ch'],
      ['ask', lineOf(html, '.prose {'), 'a measure of 40ch on .prose (45 to 75ch reads well)', 'max-width between 45 and 75ch'],
    ]);
  });
});

describe('design-lint type: font-family-count (37, ask)', () => {
  test('three families plus generic names are clean', () => {
    const { findings } = lintPage(page('code { font-family: "JetBrains Mono", monospace; }\n.aside { font-family: monospace; }'));
    expect(byRule(findings, 'font-family-count')).toEqual([]);
  });
  test('a fourth family asks at the fourth declaration and lists them', () => {
    const { html, findings } = lintPage(page('code { font-family: "JetBrains Mono", monospace; }\nblockquote { font-family: var(--font-quote); }', undefined, TOKENS + '\n:root { --font-quote: "Playfair Display", serif; }'));
    expect(byRule(findings, 'font-family-count').map((x) => [x.grade, x.line, x.evidence])).toEqual([['ask', lineOf(html, 'code {'), '4 font families: literata, public sans, playfair display, jetbrains mono']]);
  });
});

describe('design-lint type: italic-word-in-heading (38i, blocks) and italic-serif-display (38ii, ask)', () => {
  test('a roman heading, and an <em> the stylesheet sets upright, are clean', () => {
    const { findings } = lintPage(page('h2 em { font-style: normal; font-weight: 600; }', '<h2>Fast <em>and</em> safe</h2>'));
    expect(lines([...byRule(findings, 'italic-word-in-heading'), ...byRule(findings, 'italic-serif-display')])).toEqual([]);
  });
  test('an <em> inside an h2 blocks at the heading line; an italic h1 asks at the font-style line', () => {
    const { html, findings } = lintPage(page('h1 {\n  font-style: italic;\n}', '<h2>Fast <em>and</em> safe</h2>'));
    expect(byRule(findings, 'italic-word-in-heading').map((x) => [x.grade, x.line, x.evidence])).toEqual([['blocks', lineOf(html, '<h2>Fast'), 'an <em> inside an otherwise roman <h2>']]);
    expect(byRule(findings, 'italic-serif-display').map((x) => [x.grade, x.line, x.evidence])).toEqual([['ask', lineOf(html, 'font-style: italic'), 'italic display type on h1']]);
  });
});

describe('design-lint type: accented-word (38iii, ask)', () => {
  test('a span that repeats the head\'s own colour, or covers most of the head, is clean', () => {
    const { findings } = lintPage(page('h1 { color: var(--color-ink); }\n.same { color: var(--color-ink); }\n.most { color: var(--color-accent); }', '<h1>Ship <span class="same">faster</span></h1><h2><span class="most">Everything the crew needs</span> now</h2>'));
    expect(byRule(findings, 'accented-word')).toEqual([]);
  });
  test('a coloured child selector of a heading, and a classed span coloured apart from its h1, each ask at the rule', () => {
    const { html, findings } = lintPage(page('h2 span { color: var(--color-accent); }\n.hi { color: var(--color-accent); }', '<h1>Ship <span class="hi">faster</span> every week</h1>'));
    expect(byRule(findings, 'accented-word').map((x) => [x.grade, x.line, x.evidence])).toEqual([
      ['ask', lineOf(html, 'h2 span {'), 'one word of a heading set apart (h2 span)'],
      ['ask', lineOf(html, '.hi {'), 'one word of a heading set apart (.hi)'],
    ]);
  });
});

describe('design-lint type: caps-leading (55a, blocks) and caps-lockup-leading (55b, ask)', () => {
  test('uppercase at 1.05, uppercase at 1.0 that can wrap, and uppercase small type are clean', () => {
    const { findings } = lintPage(page('h2 { text-transform: uppercase; line-height: 1.05; }\n.display { text-transform: uppercase; line-height: 1; }\n.tag { text-transform: uppercase; line-height: 0.9; font-size: 12px; }'));
    expect(lines([...byRule(findings, 'caps-leading'), ...byRule(findings, 'caps-lockup-leading')])).toEqual([]);
  });
  test('an uppercase h2 at 0.94 blocks at the line-height; a nowrap caps lockup at 1.0 asks', () => {
    const { html, findings } = lintPage(page('h2 {\n  text-transform: uppercase;\n  line-height: 0.94;\n}\n.lockup {\n  text-transform: uppercase;\n  white-space: nowrap;\n  font-size: 2rem;\n  line-height: 1;\n}'));
    expect(byRule(findings, 'caps-leading').map((x) => [x.grade, x.line, x.evidence])).toEqual([['blocks', lineOf(html, 'line-height: 0.94'), 'uppercase at line-height 0.94 on h2: the caps collide']]);
    expect(byRule(findings, 'caps-lockup-leading').map((x) => [x.grade, x.line, x.evidence])).toEqual([['ask', lineOf(html, 'line-height: 1;'), 'uppercase at line-height 1 on .lockup: the caps collide']]);
  });
});

describe('design-lint type: monospace-costume (64, ask)', () => {
  const mono = TOKENS + '\n:root { --font-mono: "JetBrains Mono", monospace; }';
  test('mono on a price, and mono as the body material, are clean', () => {
    const { findings } = lintPage(page('.price { font-family: var(--font-mono); }\n.caption { font-family: var(--font-body); }', undefined, mono));
    expect(byRule(findings, 'monospace-costume')).toEqual([]);
    const material = lintPage(page('.caption { font-family: var(--font-mono); }', undefined, mono.replace('--font-body: "Public Sans", sans-serif', '--font-body: "Geist Mono", monospace')));
    expect(byRule(material.findings, 'monospace-costume')).toEqual([]);
  });
  test('mono on a label asks at the font-family line, once per selector', () => {
    const { html, findings } = lintPage(page('.label {\n  font-family: var(--font-mono);\n}\n.label:hover { font-family: var(--font-mono); }', undefined, mono));
    expect(byRule(findings, 'monospace-costume').map((x) => [x.grade, x.line, x.evidence])).toEqual([['ask', lineOf(html, 'font-family: var(--font-mono)'), 'monospace as the label voice on .label']]);
  });
});

describe('design-lint type: wide-tracking (67, blocks)', () => {
  test('an uppercase heading, a wordmark, a tracked display line and sentence-case labels are clean', () => {
    const { findings } = lintPage(page('h2 { text-transform: uppercase; }\n.wordmark { text-transform: uppercase; letter-spacing: 0.1em; font-size: 12px; }\n.display { letter-spacing: 0.05em; font-size: 3rem; }\n.label { font-size: 13px; }', '<span class="label">Shipping weekly</span><span class="wordmark">LEDGERLINE</span>'));
    expect(byRule(findings, 'wide-tracking')).toEqual([]);
  });
  test('a tracked caps eyebrow, an uppercase control and markup typed in capitals each block at their line', () => {
    const { html, findings } = lintPage(page('.eyebrow { text-transform: uppercase; letter-spacing: 0.12em; font-size: 12px; }\n.button { text-transform: uppercase; font-size: 14px; }\n.tag { font-size: 12px; }', '<span class="tag">LIMITED TIME OFFER</span>'));
    expect(byRule(findings, 'wide-tracking').map((x) => [x.grade, x.line, x.evidence, x.fix])).toEqual([
      ['blocks', lineOf(html, '.eyebrow {'), '.eyebrow: uppercase tracked 0.12em at 12px in a label role', 'the body face, a step smaller, sentence case, untracked'],
      ['blocks', lineOf(html, '.button {'), '.button: an uppercase control on a page whose display is not uppercase', 'controls follow the display voice: sentence case here, or tracking 0.04em at most where the display itself is uppercase'],
      ['blocks', lineOf(html, '<span class="tag">'), '"LIMITED TIME OFFER" typed in capitals at 12px (<span class="tag">)', 'sentence case in the body face; capitals survive only as a wordmark or as the display voice'],
    ]);
  });
  test('where the display itself is uppercase, a control tracked past 0.045em blocks and one at 0.04em does not', () => {
    const base = 'h1 { text-transform: uppercase; }\n';
    const tight = lintPage(page(base + '.button { text-transform: uppercase; letter-spacing: 0.04em; font-size: 14px; }'));
    expect(byRule(tight.findings, 'wide-tracking')).toEqual([]);
    const loose = lintPage(page(base + '.button { text-transform: uppercase; letter-spacing: 0.08em; font-size: 14px; }'));
    expect(byRule(loose.findings, 'wide-tracking').map((x) => x.evidence)).toEqual(['.button: an uppercase control tracked 0.08em']);
  });
});

describe('design-lint type: fixtures', () => {
  const MINE = new Set(['overused-font', 'line-length', 'font-family-count', 'italic-word-in-heading', 'italic-serif-display', 'accented-word', 'caps-leading', 'caps-lockup-leading', 'monospace-costume', 'wide-tracking']);
  test('the clean page and the eyebrow carve-outs have no type finding', () => {
    for (const dir of ['clean', 'eyebrow-pass']) {
      const { findings } = lintStatic([path.join(FIXTURES, dir)], { cwd: ROOT });
      expect(lines(findings.filter((f) => MINE.has(f.rule)))).toEqual([]);
    }
  });
  test('slopped.html: the caps h2 blocks; Poppins, the fourth family, the italic h2 and the mono label ask', () => {
    const file = path.join(FIXTURES, 'slopped.html');
    const html = fs.readFileSync(file, 'utf8');
    const { findings } = lintStatic([file], { cwd: ROOT });
    expect(findings.filter((f) => MINE.has(f.rule)).map((f) => [f.rule, f.grade, f.line]).sort()).toEqual([
      ['caps-leading', 'blocks', lineOf(html, 'line-height: 0.94')],
      ['font-family-count', 'ask', lineOf(html, '--font-quote:')],
      ['italic-serif-display', 'ask', lineOf(html, 'font-style: italic')],
      ['monospace-costume', 'ask', lineOf(html, '.mono-label {')],
      ['overused-font', 'ask', lineOf(html, '--font-display:')],
      ['overused-font', 'ask', lineOf(html, 'font-family: var(--font-display);')],
      ['overused-font', 'ask', lineOf(html, 'font-family: var(--font-display);', 2)],
    ].sort());
  });
  test('eyebrow-fail: the four tracked caps labels block and the mono eyebrow asks', () => {
    const file = path.join(FIXTURES, 'eyebrow-fail', 'index.html');
    const html = fs.readFileSync(file, 'utf8');
    const { findings } = lintStatic([file], { cwd: ROOT });
    expect(byRule(findings, 'wide-tracking').map((f) => [f.grade, f.line])).toEqual(['.a__eyebrow {', '.b__strand {', '.e__mark {', '.overline {'].map((s) => ['blocks', lineOf(html, s)]));
    expect(byRule(findings, 'monospace-costume').map((f) => [f.grade, f.line])).toEqual([['ask', lineOf(html, '.a__eyebrow {')]]);
  });
});

describe('design-lint type: third review cycle', () => {
  test('banned-font: a banned face as the first family on a heading or in a --font-* token asks once; a fallback position, a var() and a near name are clean', () => {
    const { html, findings } = lintPage(page('h1 { font-family: "Comic Sans MS", cursive; }\nh2 { font-family: Impact, sans-serif; }\n.quote { font-family: var(--font-body); }\n.note { font-family: "Papyrus Variable Text", serif; }\n.last { font-family: Georgia, Papyrus, serif; }', '<h1>Ledger</h1><h2>Notes</h2><p class="quote">Q</p><p class="note">N</p><p class="last">L</p>', TOKENS.replace('--font-body: "Public Sans", sans-serif;', '--font-body: Papyrus, serif;')));
    const hits = byRule(findings, 'banned-font').map((f) => [f.grade, f.line, f.evidence]);
    expect(hits).toEqual([
      ['ask', lineOf(html, '--font-body: Papyrus'), '"papyrus" (--font-body)'],
      ['ask', lineOf(html, '"Comic Sans MS"'), '"comic sans ms" (h1)'],
      ['ask', lineOf(html, 'Impact'), '"impact" (h2)'],
      ['ask', lineOf(html, '"Papyrus Variable Text"'), '"papyrus variable text" (.note)'],
    ]);
  });
  test('an empty <i> icon glyph in a heading, and an <em> that is the whole heading, are not an italic word', () => {
    const icon = lintPage(page('', '<h2><i class="fa fa-star" aria-hidden="true"></i> Features</h2>'));
    expect(lines(byRule(icon.findings, 'italic-word-in-heading'))).toEqual([]);
    const whole = lintPage(page('', '<h3><em>Whole heading italic</em></h3>'));
    expect(lines(byRule(whole.findings, 'italic-word-in-heading'))).toEqual([]);
    const word = lintPage(page('', '<h2>Fast <em>and</em> safe</h2>'));
    expect(byRule(word.findings, 'italic-word-in-heading').map((f) => f.grade)).toEqual(['blocks']);
  });
});
