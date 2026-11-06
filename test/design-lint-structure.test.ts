/**
 * The structure rule family of the design lint (lib/design-lint/rules/structure.ts): for every rule id, a planted
 * positive with its line and grade, and a negative control at the edge of the threshold. The shared fixtures
 * (slopped.html, clean/) are checked for this family's rules too.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatFinding, lint, type Finding } from '../lib/design-lint/index';

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'design-lint');
const FAMILY = ['template-cards', 'nested-cards', 'vh-height', 'raw-spacing', 'off-scale-spacing', 'overflow-x-unclipped', 'wide-container', 'bare-fr-track', 'display-head-unwrapped', 'radio-tab-jump', 'double-sticky', 'screen-word-budget'];

const TOKENS = ':root { --color-paper: oklch(97% 0.01 80); --color-ink: oklch(20% 0.02 250); --font-display: "Fraunces", serif; --font-body: "Source Serif 4", serif; }';
const CLIP = 'html, body { overflow-x: clip; }';
const STATES = 'a:focus-visible, .button:focus-visible { outline: 2px solid var(--color-ink); }\n.button:active { transform: translateY(1px); }\n.button:disabled { opacity: 0.5; cursor: not-allowed; }';

function page(css: string, body: string, opts: { clip?: boolean } = {}): string {
  const base = [TOKENS, opts.clip === false ? '' : CLIP, STATES].filter(Boolean).join('\n');
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Fixture</title>\n<style>\n${base}\n${css}\n</style>\n</head>\n<body>\n<main>\n${body}\n</main>\n</body>\n</html>\n`;
}

async function lintPage(html: string, opts: { scope?: 'page' | 'component'; name?: string } = {}): Promise<Finding[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-structure-'));
  tmpDirs.push(dir);
  const file = path.join(dir, opts.name ?? 'index.html');
  fs.writeFileSync(file, html);
  return (await lint([file], { cwd: dir, scope: opts.scope, warn: (l: string) => { throw new Error(l); } })).findings;
}

const only = (findings: Finding[], rule: string) => findings.filter((f) => f.rule === rule);
const lineOf = (html: string, needle: string): number => html.split('\n').findIndex((l) => l.includes(needle)) + 1;
const hits = (findings: Finding[], rule: string) => only(findings, rule).map((f) => [f.grade, f.line]);
const none = (findings: Finding[], rule: string) => expect(only(findings, rule).map(formatFinding)).toEqual([]);

describe('design-lint structure: template-cards (gate 3)', () => {
  test('three equal icon-above-heading tiles and a thick coloured side stripe report at ask', async () => {
    const html = page('.features { display: grid; grid-template-columns: repeat(3, 1fr); }\n.note { border-left: 4px solid var(--color-ink); }',
      '<section class="features"><div><span class="icon"></span><h3>Sync</h3></div><div><span class="icon"></span><h3>Share</h3></div><div><span class="icon"></span><h3>Ship</h3></div></section>\n<p class="note">A note</p>');
    const f = await lintPage(html);
    expect(hits(f, 'template-cards')).toEqual([['ask', lineOf(html, 'repeat(3, 1fr)')], ['ask', lineOf(html, 'border-left: 4px')]]);
    expect(only(f, 'template-cards')[0].evidence).toBe('three equal columns of icon-above-heading tiles on .features');
  });
  test('three text columns without icons and a hairline side border are not the template', async () => {
    const html = page('.features { display: grid; grid-template-columns: repeat(3, 1fr); }\n.note { border-left: 1px solid var(--color-ink); }',
      '<section class="features"><div><h3>Sync</h3><p>Once.</p></div><div><h3>Share</h3><p>Twice.</p></div><div><h3>Ship</h3><p>Daily.</p></div></section>\n<p class="note">A note</p>');
    none(await lintPage(html), 'template-cards');
  });
});

describe('design-lint structure: nested-cards (gate 4)', () => {
  test('a card inside a card blocks at the inner card', async () => {
    const html = page('.card { border: 1px solid var(--color-ink); }', '<div class="card">\n  <h3>Outer</h3>\n  <div class="card feature-card">\n    <p>Inner</p>\n  </div>\n</div>');
    const f = await lintPage(html);
    expect(hits(f, 'nested-cards')).toEqual([['blocks', lineOf(html, 'card feature-card')]]);
    expect(only(f, 'nested-cards')[0].evidence).toBe('a card inside a card: class="card feature-card"');
  });
  test('a card inside a card grid, and sibling cards, are one containment layer', async () => {
    const html = page('.card { border: 1px solid var(--color-ink); }', '<div class="card-grid"><div class="card"><p>One</p></div><div class="card"><p>Two</p></div></div>');
    none(await lintPage(html), 'nested-cards');
  });
});

describe('design-lint structure: vh-height (gate 6a)', () => {
  test('a hero sized in vh blocks, by the hero word or by the class of the section holding the h1', async () => {
    const html = page('.hero { min-height: 100vh; }\n.intro { height: 80vh; }', '<section class="intro"><h1>Two days to close</h1></section>\n<section class="hero"><p>More</p></section>');
    const f = await lintPage(html);
    expect(hits(f, 'vh-height')).toEqual([['blocks', lineOf(html, '100vh')], ['blocks', lineOf(html, '80vh')]]);
  });
  test('svh and dvh pass, and vh on a non-hero rule is not this rule', async () => {
    const html = page('.hero { min-height: 100svh; }\n.sheet { height: 100dvh; }\n.band { min-height: 40vh; }', '<section class="hero"><h1>Two days to close</h1></section>\n<div class="band"></div>');
    none(await lintPage(html), 'vh-height');
  });
});

describe('design-lint structure: raw-spacing (gate 24a)', () => {
  test('a raw length that matches a --space-* token blocks with that token as the fix; past eight in one file the rest fold into one line', async () => {
    const rules = Array.from({ length: 10 }, (_, i) => `.r${i} { padding: 32px; }`).join('\n');
    const html = page(':root { --space-4: 2rem; --space-2: 1rem; }\n.box { margin: 0 1rem; }\n' + rules, '<div class="box">x</div>');
    const f = only(await lintPage(html), 'raw-spacing');
    expect(f.find((x) => x.line === lineOf(html, 'margin: 0 1rem'))).toMatchObject({ grade: 'blocks', evidence: 'margin: 0 1rem on .box where --space-2 exists', fix: 'var(--space-2)' });
    expect(f).toHaveLength(9);
    expect(f.filter((x) => x.line === 1).map((x) => x.evidence)).toEqual(['3 more raw spacing lengths in this file have a matching --space-* token']);
  });
  test('tokens in use, a length no token matches, and a page with no spacing tokens are all clean', async () => {
    const withTokens = page(':root { --space-4: 2rem; }\n.box { padding: var(--space-4); margin: 0 36px; }', '<div class="box">x</div>');
    none(await lintPage(withTokens), 'raw-spacing');
    const noTokens = page('.box { padding: 32px; }', '<div class="box">x</div>');
    none(await lintPage(noTokens), 'raw-spacing');
  });
});

describe('design-lint structure: off-scale-spacing (gate 24b)', () => {
  test('a px spacing off the 4px scale reports at ask', async () => {
    const html = page('.nav { padding: 17px; }\n.gap { gap: 10px 8px; }', '<div class="nav">x</div>');
    const f = await lintPage(html);
    expect(hits(f, 'off-scale-spacing')).toEqual([['ask', lineOf(html, '17px')], ['ask', lineOf(html, '10px 8px')]]);
    expect(only(f, 'off-scale-spacing')[0].evidence).toBe('padding: 17px on .nav is off the 4px scale');
  });
  test('multiples of four, 1px and 2px nudges, and rem values are on the scale', async () => {
    const html = page('.nav { padding: 16px 2px; margin: 1px 0 1.25rem; gap: 24px; }', '<div class="nav">x</div>');
    none(await lintPage(html), 'off-scale-spacing');
  });
});

describe('design-lint structure: overflow-x-unclipped (gate 34, static half)', () => {
  test('overflow-x: hidden, a 100vw width, clip on one of html and body, and no clip at all each report at ask', async () => {
    const hidden = page('html { overflow-x: hidden; }\n.full { width: 100vw; }', '<div class="full">x</div>', { clip: false });
    const f = await lintPage(hidden);
    expect(hits(f, 'overflow-x-unclipped')).toEqual([['ask', lineOf(hidden, 'overflow-x: hidden')], ['ask', lineOf(hidden, '100vw')]]);
    expect(only(f, 'overflow-x-unclipped').map((x) => x.evidence)).toEqual(['overflow-x: hidden on html: hidden breaks position: sticky', 'width: 100vw on .full: 100vw counts the scrollbar and overflows']);
    const one = page('html { overflow-x: clip; }', '<p>x</p>', { clip: false });
    expect(only(await lintPage(one), 'overflow-x-unclipped').map((x) => [x.line, x.evidence])).toEqual([[1, 'overflow-x: clip on html only']]);
    const neither = page('', '<p>x</p>', { clip: false });
    expect(only(await lintPage(neither), 'overflow-x-unclipped').map((x) => [x.line, x.evidence])).toEqual([[1, 'no overflow-x: clip on html and body']]);
  });
  test('overflow-x: clip on both html and body with width: 100% is clean', async () => {
    const html = page('.full { width: 100%; }', '<div class="full">x</div>');
    none(await lintPage(html), 'overflow-x-unclipped');
  });
});

describe('design-lint structure: wide-container (gate 44d, static half)', () => {
  const grid = '.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }\n@media (min-width: 1600px) { .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }\n.hero__visual { width: 60vw; }';
  const body = '<section class="hero"><h1>Two days to close</h1><div class="hero__visual"></div></section>\n<ul class="grid"><li>a</li><li>b</li><li>c</li></ul>';
  test('with no capped container, a grid that gains a column past 1440px and a vw-sized visual with no cap block', async () => {
    const html = page(grid, body);
    const f = await lintPage(html);
    expect(hits(f, 'wide-container')).toEqual([['blocks', lineOf(html, 'repeat(4')], ['blocks', lineOf(html, '60vw')]]);
    expect(only(f, 'wide-container').map((x) => x.evidence)).toEqual([
      'no container has a max-width, and .grid gains columns at (min-width: 1600px) (3 to 4)',
      'no container has a max-width, and .hero__visual is sized in vw with no cap (width: 60vw)',
    ]);
  });
  test('a centred max-width container, a clamp() on the visual, or a column count that holds are clean', async () => {
    none(await lintPage(page('.wrap { max-width: 1360px; margin: 0 auto; }\n' + grid, '<div class="wrap">' + body + '</div>')), 'wide-container');
    const held = page('.grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }\n@media (min-width: 1600px) { .grid { gap: 2rem; grid-template-columns: repeat(3, minmax(0, 1fr)); } }\n.hero__visual { width: clamp(320px, 40vw, 720px); }', body);
    none(await lintPage(held), 'wide-container');
  });
});

describe('design-lint structure: bare-fr-track (gate 50)', () => {
  test('a bare 1fr grid track whose grid holds images blocks', async () => {
    const html = page('.gallery { display: grid; grid-template-columns: 1fr 1fr; }', '<section class="gallery"><img src="a.png" alt="A"><img src="b.png" alt="B"></section>');
    const f = await lintPage(html);
    expect(hits(f, 'bare-fr-track')).toEqual([['blocks', lineOf(html, '1fr 1fr')]]);
    expect(only(f, 'bare-fr-track')[0].evidence).toMatch(/^a bare 1fr track holds images on \.gallery/);
  });
  test('minmax(0, 1fr) tracks with images, and bare 1fr tracks holding only text, are clean', async () => {
    none(await lintPage(page('.gallery { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }', '<section class="gallery"><img src="a.png" alt="A"><img src="b.png" alt="B"></section>')), 'bare-fr-track');
    none(await lintPage(page('.cols { display: grid; grid-template-columns: 1fr 2fr; }', '<section class="cols"><p>Left</p><p>Right</p></section>')), 'bare-fr-track');
  });
});

describe('design-lint structure: display-head-unwrapped (gate 50)', () => {
  test('a display head holding a word of 16 letters or more, with no overflow-wrap anywhere that reaches it, blocks', async () => {
    const html = page('h1 { font-family: var(--font-display); }', '<section class="hero">\n<h1>Hyperproductivity for every crew</h1>\n</section>');
    const f = await lintPage(html);
    expect(hits(f, 'display-head-unwrapped')).toEqual([['blocks', lineOf(html, '<h1>')]]);
    expect(only(f, 'display-head-unwrapped')[0].evidence).toBe('the display head holds "Hyperproductivity" with no overflow-wrap: at 320px that word overflows');
  });
  test('overflow-wrap: break-word on the heading, or a short-word heading, is clean', async () => {
    none(await lintPage(page('h1 { overflow-wrap: break-word; min-width: 0; }', '<h1>Hyperproductivity for every crew</h1>')), 'display-head-unwrapped');
    none(await lintPage(page('', '<h1>Two days to close the books</h1>')), 'display-head-unwrapped');
  });
});

describe('design-lint structure: radio-tab-jump (gate 53)', () => {
  const tabs = '<div class="tabs"><input type="radio" name="t" id="a"><label for="a">A</label><input type="radio" name="t" id="b"><label for="b">B</label></div>';
  test('radio tabs parked at position: absolute; top: 0 with no preventScroll in a script block', async () => {
    const html = page('.tabs input[type="radio"] { position: absolute; top: 0; opacity: 0; }', tabs);
    const f = await lintPage(html);
    expect(hits(f, 'radio-tab-jump')).toEqual([['blocks', lineOf(html, 'position: absolute; top: 0')]]);
  });
  test('radios kept in flow at zero size, or a focus handler with preventScroll, are clean', async () => {
    none(await lintPage(page('.tabs input[type="radio"] { position: absolute; width: 0; height: 0; opacity: 0; }', tabs)), 'radio-tab-jump');
    none(await lintPage(page('.tabs input[type="radio"] { position: absolute; top: 0; opacity: 0; }', tabs + '\n<script>document.querySelector("#a").focus({ preventScroll: true });</script>')), 'radio-tab-jump');
  });
});

describe('design-lint structure: double-sticky (gate 56)', () => {
  test('two elements sticking at top: 0 block at the second', async () => {
    const html = page('.nav { position: sticky; top: 0; }\n.subnav { position: sticky; top: 0px; }', '<nav class="nav">n</nav><div class="subnav">s</div>');
    const f = await lintPage(html);
    expect(hits(f, 'double-sticky')).toEqual([['blocks', lineOf(html, '.subnav')]]);
    expect(only(f, 'double-sticky')[0].evidence).toBe('two elements stick at top: 0 (.nav and .subnav): the second slides under the first');
  });
  test('the second sticky offset by the banner height is clean', async () => {
    const html = page(':root { --banner-height: 64px; }\n.nav { position: sticky; top: 0; }\n.subnav { position: sticky; top: var(--banner-height); }', '<nav class="nav">n</nav><div class="subnav">s</div>');
    none(await lintPage(html), 'double-sticky');
  });
});

describe('design-lint structure: screen-word-budget (gate 58, static half)', () => {
  test('an h1 past seven words, a hero paragraph past twelve, and a full page past 450 visible words report at ask', async () => {
    const html = page('', '<section class="hero">\n<h1>A very long headline that keeps on going and going</h1>\n<p>Halvorsen Freight reconciles 1,140 invoices a month and their books now close before the third.</p>\n</section>');
    const f = await lintPage(html);
    expect(hits(f, 'screen-word-budget')).toEqual([['ask', lineOf(html, '<h1>')], ['ask', lineOf(html, '<p>Halvorsen')]]);
    expect(only(f, 'screen-word-budget').map((x) => x.evidence)).toEqual(['the h1 runs 10 words ("A very long headline that keeps on goin…")', 'the hero paragraph runs 15 words']);
    const words = Array.from({ length: 460 }, (_, i) => 'word' + i).join(' ');
    const long = page('', `<h1>Short head</h1>\n<p>${words}</p>\n<footer>End</footer>`);
    expect(only(await lintPage(long), 'screen-word-budget').map((x) => [x.line, x.evidence])).toEqual([[1, '464 visible words on the page (450 at most)']]);
  });
  test('seven words of h1, twelve of lede, and a page under 450 words are within the budget', async () => {
    const html = page('', '<section class="hero">\n<h1>October closed in two days, not nine</h1>\n<p>1,140 invoices a month, and the books now close before the third.</p>\n</section>\n<footer>End</footer>');
    none(await lintPage(html), 'screen-word-budget');
  });
});

describe('design-lint structure: the shared fixtures', () => {
  test('slopped.html trips the planted structure tells at their lines', async () => {
    const f = (await lint([path.join(FIXTURES, 'slopped.html')], { cwd: ROOT, warn: (l: string) => { throw new Error(l); } })).findings;
    const mine = f.filter((x) => FAMILY.includes(x.rule)).map((x) => [x.rule, x.grade, x.line]);
    expect(mine).toEqual([
      ['bare-fr-track', 'blocks', 93],
      ['display-head-unwrapped', 'blocks', 112],
      ['double-sticky', 'blocks', 59],
      ['nested-cards', 'blocks', 128],
      ['off-scale-spacing', 'ask', 57],
      ['overflow-x-unclipped', 'ask', 47],
    ]);
  });
  test('the clean page raises no structure finding', async () => {
    const f = (await lint([path.join(FIXTURES, 'clean')], { cwd: ROOT, warn: (l: string) => { throw new Error(l); } })).findings;
    expect(f.filter((x) => FAMILY.includes(x.rule)).map(formatFinding)).toEqual([]);
  });
});

describe('design-lint structure: third review cycle', () => {
  test('sibling cards in a list whose end tags are left out are not nested cards', async () => {
    const f = await lintPage(page('', '<ul><li class="card">One<li class="card">Two</ul>'));
    none(f, 'nested-cards');
    const nested = await lintPage(page('', '<ul><li class="card">One<div class="card">Inner</div></li></ul>'));
    expect(hits(nested, 'nested-cards').map(([g]) => g)).toEqual(['blocks']);
  });
  test('one selector sticky at two breakpoints is not a double sticky; two selectors are', async () => {
    none(await lintPage(page('.site-header { position: sticky; top: 0; }\n@media (min-width: 900px) { .site-header { position: sticky; top: 0; padding: 16px; } }', '<header class="site-header">H</header>')), 'double-sticky');
    const two = await lintPage(page('.site-header { position: sticky; top: 0; }\n.toolbar { position: sticky; top: 0; }', '<header class="site-header">H</header><div class="toolbar">T</div>'));
    expect(hits(two, 'double-sticky').map(([g]) => g)).toEqual(['blocks']);
  });
  test('a light grey side border on a blockquote is not the accent stripe; a dark ink stripe and a coloured one are', async () => {
    none(await lintPage(page('blockquote { border-left: 4px solid #dddddd; }', '<blockquote>A line</blockquote>')), 'template-cards');
    expect(hits(await lintPage(page('.note { border-left: 4px solid var(--color-ink); }', '<p class="note">A note</p>')), 'template-cards').map(([g]) => g)).toEqual(['ask']);
    expect(hits(await lintPage(page('.note { border-left: 4px solid oklch(60% 0.18 30); }', '<p class="note">A note</p>')), 'template-cards').map(([g]) => g)).toEqual(['ask']);
  });
  test('many grid rules with a bare fr track do not rescan the document per rule', async () => {
    let css = '';
    let body = '';
    for (let i = 0; i < 1500; i++) {
      css += `.c${i} { grid-template-columns: 1fr 2fr; }\n`;
      body += `<section class="c${i}"><h2>Heading ${i}</h2><p>Text.</p><div><img src="p${i}.jpg" alt="Photo ${i}"></div></section>`;
    }
    const t = performance.now();
    const f = await lintPage(page(css, body));
    expect(performance.now() - t).toBeLessThan(8000);
    expect(hits(f, 'bare-fr-track').length).toBe(1500);
  });
});
