/**
 * The motion and interaction rule family of the design lint (lib/design-lint/rules/motion.ts): for every rule id, a
 * planted positive with its line and grade, and a negative control at the edge of the threshold. The shared fixtures
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
const FAMILY = ['layout-transition', 'spacing-transition', 'hover-tells', 'bounce-easing', 'focus-ring-fade', 'tooltip-focus-delay', 'autorotate-no-pause', 'missing-focus-visible', 'missing-states', 'missing-reduced-motion', 'autoplay-unmuted', 'lazy-lcp', 'video-without-poster', 'input-state-shift', 'control-height', 'content-hidden-at-rest'];

const TOKENS = ':root { --color-paper: oklch(97% 0.01 80); --color-ink: oklch(20% 0.02 250); --font-display: "Fraunces", serif; --font-body: "Source Serif 4", serif; }\nhtml, body { overflow-x: clip; }';
const STATES = 'a:focus-visible, .button:focus-visible { outline: 2px solid var(--color-ink); }\n.button:active { transform: translateY(1px); }\n.button:disabled { opacity: 0.5; cursor: not-allowed; }';
const REDUCE = '@media (prefers-reduced-motion: reduce) { * { animation: none; transition: none; } }';

function page(css: string, body: string, opts: { states?: boolean; reduce?: boolean } = {}): string {
  const base = [TOKENS, opts.states === false ? '' : STATES, opts.reduce ? REDUCE : ''].filter(Boolean).join('\n');
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Fixture</title>\n<style>\n${base}\n${css}\n</style>\n</head>\n<body>\n<main>\n${body}\n</main>\n</body>\n</html>\n`;
}

async function lintPage(html: string, opts: { scope?: 'page' | 'component' } = {}): Promise<Finding[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-motion-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html);
  return (await lint([file], { cwd: dir, scope: opts.scope, warn: (l: string) => { throw new Error(l); } })).findings;
}

const only = (findings: Finding[], rule: string) => findings.filter((f) => f.rule === rule);
const lineOf = (html: string, needle: string): number => html.split('\n').findIndex((l) => l.includes(needle)) + 1;
const hits = (findings: Finding[], rule: string) => only(findings, rule).map((f) => [f.grade, f.line]);
const none = (findings: Finding[], rule: string) => expect(only(findings, rule).map(formatFinding)).toEqual([]);
const BUTTON = '<a class="button" href="/book">Book the walkthrough</a>';

describe('design-lint motion: layout-transition (gate 10a)', () => {
  test('transition: all, a transitioned width, and a keyframe animating height each block', async () => {
    const html = page('.card { transition: all 0.3s ease; }\n.drawer { transition: width 200ms; }\n@keyframes grow {\n  from { height: 0; }\n  to { height: 10rem; }\n}', BUTTON, { reduce: true });
    const f = await lintPage(html);
    expect(hits(f, 'layout-transition')).toEqual([['blocks', lineOf(html, 'all 0.3s')], ['blocks', lineOf(html, 'width 200ms')], ['blocks', lineOf(html, 'height: 0')], ['blocks', lineOf(html, 'height: 10rem')]]);
    expect(only(f, 'layout-transition').map((x) => x.evidence)).toEqual(['transition: all on .card', 'transitioning width on .drawer', '@keyframes grow animates height', '@keyframes grow animates height']);
  });
  test('transform and opacity transitions, and a max-height keyframe, are not layout transitions', async () => {
    const html = page('.card { transition: transform 200ms, opacity 200ms; }\n@keyframes open { from { max-height: 0; opacity: 0; } to { max-height: 20rem; opacity: 1; } }', BUTTON, { reduce: true });
    none(await lintPage(html), 'layout-transition');
  });
});

describe('design-lint motion: spacing-transition (gate 10b)', () => {
  test('transitioning padding or animating margin reports at ask', async () => {
    const html = page('.card { transition: padding 200ms; }\n@keyframes nudge { to { margin-left: 1rem; } }', BUTTON, { reduce: true });
    const f = await lintPage(html);
    expect(hits(f, 'spacing-transition')).toEqual([['ask', lineOf(html, 'padding 200ms')], ['ask', lineOf(html, 'margin-left: 1rem')]]);
  });
  test('a transform transition is clean', async () => {
    none(await lintPage(page('.card { transition: transform 200ms; }', BUTTON, { reduce: true })), 'spacing-transition');
  });
});

describe('design-lint motion: hover-tells (gate 11)', () => {
  test('one hover scale stamped on two selectors, an image scaling on hover, and the lift on three cards each report at ask', async () => {
    const html = page([
      '.a:hover { transform: scale(1.05); }',
      '.b:hover { transform: scale(1.05); }',
      '.card__img:hover { transform: scale(1.1); }',
      '.c1:hover { transform: translateY(-4px); box-shadow: 0 8px 24px rgba(0 0 0 / 0.1); }',
      '.c2:hover { transform: translateY(-4px); box-shadow: 0 8px 24px rgba(0 0 0 / 0.1); }',
      '.c3:hover { transform: translateY(-4px); box-shadow: 0 8px 24px rgba(0 0 0 / 0.1); }',
    ].join('\n'), BUTTON, { reduce: true });
    const f = await lintPage(html);
    expect(hits(f, 'hover-tells')).toEqual([['ask', lineOf(html, '.a:hover')], ['ask', lineOf(html, '.card__img:hover')], ['ask', lineOf(html, '.c3:hover')]]);
    expect(only(f, 'hover-tells').map((x) => x.evidence)).toEqual([
      'the same hover scale(1.05) on 2 selectors',
      'an image transforms on hover (.card__img:hover)',
      'the hover lift (translateY plus shadow) on 3 selectors (.c1, .c2, .c3)',
    ]);
  });
  test('one hover scale on one selector, a colour change on an image, and a lift on two cards are within bounds', async () => {
    const html = page('.a:hover { transform: scale(1.02); }\n.card__img:hover { opacity: 0.9; }\n.c1:hover, .c2:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0 0 0 / 0.1); }', BUTTON, { reduce: true });
    none(await lintPage(html), 'hover-tells');
  });
});

describe('design-lint motion: bounce-easing (gate 12)', () => {
  test('an overshooting cubic-bezier on a UI state reports at ask, through a token too', async () => {
    const html = page(':root { --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1); }\n.button:hover { transition: transform 300ms var(--ease-spring); }\n.modal { animation: pop 300ms cubic-bezier(0.2, -0.3, 0.4, 1); }', BUTTON, { reduce: true });
    const f = await lintPage(html);
    expect(hits(f, 'bounce-easing')).toEqual([['ask', lineOf(html, '.button:hover')], ['ask', lineOf(html, '.modal')]]);
    expect(only(f, 'bounce-easing')[0].evidence).toBe('overshoot easing cubic-bezier(0.34, 1.56, 0.64, 1) on .button:hover');
  });
  test('an exponential ease-out is clean', async () => {
    none(await lintPage(page('.button:hover { transition: transform 300ms cubic-bezier(0.2, 0.8, 0.2, 1); }', BUTTON, { reduce: true })), 'bounce-easing');
  });
});

describe('design-lint motion: focus-ring-fade (gate 15)', () => {
  test('a transition on the focus rule, and a resting transition of the property the ring is drawn with, both block', async () => {
    const html = page('.cta:focus-visible { outline: 2px solid var(--color-ink); transition: outline 200ms ease; }\n.pill { transition: box-shadow 200ms; }\n.pill:focus-visible { box-shadow: 0 0 0 3px var(--color-ink); }', '<button class="cta">Go</button><button class="pill">Go</button>');
    const f = await lintPage(html);
    expect(hits(f, 'focus-ring-fade')).toEqual([['blocks', lineOf(html, 'transition: outline')], ['blocks', lineOf(html, 'transition: box-shadow')]]);
    expect(only(f, 'focus-ring-fade').map((x) => x.evidence)).toEqual(['the focus ring transitions in on .cta:focus-visible', '.pill transitions box-shadow while :focus-visible sets it, so the ring fades in']);
  });
  test('a ring drawn with outline while only background transitions is instant', async () => {
    none(await lintPage(page('.cta { transition: background 200ms; }\n.cta:focus-visible { outline: 2px solid var(--color-ink); }', '<button class="cta">Go</button>')), 'focus-ring-fade');
  });
});

describe('design-lint motion: tooltip-focus-delay (gate 17)', () => {
  test('a tooltip delayed as long on focus as on hover reports as a suspected tell, at ask', async () => {
    const html = page('.tooltip:hover .tip { transition-delay: 800ms; opacity: 1; }\n.tooltip:focus-within .tip { transition-delay: 800ms; opacity: 1; }', '<span class="tooltip" tabindex="0">?<span class="tip">Help</span></span>');
    const f = await lintPage(html);
    expect(only(f, 'tooltip-focus-delay').map((x) => [x.grade, x.tier, x.line])).toEqual([['ask', 'ask', lineOf(html, ':focus-within')]]);
  });
  test('an instant focus tooltip is clean', async () => {
    none(await lintPage(page('.tooltip:hover .tip { transition-delay: 800ms; opacity: 1; }\n.tooltip:focus-within .tip { transition-delay: 0ms; opacity: 1; }', '<span class="tooltip" tabindex="0">?<span class="tip">Help</span></span>')), 'tooltip-focus-delay');
  });
});

describe('design-lint motion: autorotate-no-pause (gate 18)', () => {
  test('an infinite animation on a marquee with no paused state reports as a suspected tell, at ask', async () => {
    const html = page('.marquee { animation: slide 20s linear infinite; }\n@keyframes slide { to { transform: translateX(-50%); } }', '<div class="marquee">Logos</div>', { reduce: true });
    const f = await lintPage(html);
    expect(only(f, 'autorotate-no-pause').map((x) => [x.grade, x.line, x.evidence])).toEqual([['ask', lineOf(html, 'infinite'), 'an infinite animation on .marquee with no paused state on hover or focus']]);
  });
  test('a marquee that pauses on hover is clean', async () => {
    none(await lintPage(page('.marquee { animation: slide 20s linear infinite; }\n.marquee:hover, .marquee:focus-within { animation-play-state: paused; }\n@keyframes slide { to { transform: translateX(-50%); } }', '<div class="marquee">Logos</div>', { reduce: true })), 'autorotate-no-pause');
  });
});

describe('design-lint motion: missing-focus-visible and missing-states (gates 26a, 26b)', () => {
  test('a page with a button and no :focus-visible, :active or :disabled style reports all three at the stylesheet', async () => {
    const html = page('.button { color: var(--color-ink); }', '<button class="button">Go</button>', { states: false });
    const f = await lintPage(html);
    expect(only(f, 'missing-focus-visible').map((x) => [x.grade, x.line, x.evidence])).toEqual([['blocks', 1, 'no :focus-visible style anywhere: keyboard users cannot see where they are']]);
    expect(only(f, 'missing-states').map((x) => [x.grade, x.line, x.evidence])).toEqual([['ask', 1, 'no :active style anywhere'], ['ask', 1, 'no :disabled style anywhere']]);
  });
  test('a ring, an active state and a disabled state satisfy both; a page with nothing interactive asks for none', async () => {
    const f = await lintPage(page('', BUTTON));
    none(f, 'missing-focus-visible');
    none(f, 'missing-states');
    const inert = await lintPage(page('', '<p>Only prose.</p>', { states: false }));
    none(inert, 'missing-focus-visible');
    none(inert, 'missing-states');
  });
  test('a link-only page needs no :disabled, and an aria-disabled selector counts as the disabled state', async () => {
    none(await lintPage(page('a:focus-visible { outline: 2px solid; }\na:active { color: red; }', '<a href="/">Home</a>', { states: false })), 'missing-states');
    none(await lintPage(page('.button:focus-visible { outline: 2px solid; }\n.button:active { color: red; }\n.button[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }', '<button class="button">Go</button>', { states: false })), 'missing-states');
  });
});

describe('design-lint motion: missing-reduced-motion (gate 27)', () => {
  test('keyframes with no prefers-reduced-motion block anywhere block at the keyframes', async () => {
    const html = page('.bar { animation: grow 2s ease infinite; }\n@keyframes grow { from { opacity: 0; } to { opacity: 1; } }', BUTTON);
    const f = await lintPage(html);
    expect(only(f, 'missing-reduced-motion').map((x) => [x.grade, x.line, x.evidence])).toEqual([['blocks', lineOf(html, 'from { opacity: 0'), 'motion present and no prefers-reduced-motion block anywhere']]);
    const transition = page('.card { transition: transform 200ms; }', BUTTON);
    expect(only(await lintPage(transition), 'missing-reduced-motion').map((x) => x.line)).toEqual([1]);
  });
  test('a prefers-reduced-motion block answers it, and a page with no motion needs none', async () => {
    none(await lintPage(page('.bar { animation: grow 2s ease infinite; }\n@keyframes grow { from { opacity: 0; } to { opacity: 1; } }', BUTTON, { reduce: true })), 'missing-reduced-motion');
    none(await lintPage(page('.card { transition: background 200ms; }', BUTTON)), 'missing-reduced-motion');
  });
});

describe('design-lint motion: autoplay-unmuted, lazy-lcp and video-without-poster (gates 28a, 28b)', () => {
  test('an autoplaying video without muted blocks; a video without poster asks; a lazy first image or video is a suspected LCP tell at ask', async () => {
    const html = page('', '<section class="hero">\n<h1>Two days to close</h1>\n<video autoplay loop playsinline src="a.mp4"></video>\n<img loading="lazy" src="a.png" alt="A">\n</section>');
    const f = await lintPage(html);
    expect(only(f, 'autoplay-unmuted').map((x) => [x.grade, x.line])).toEqual([['blocks', lineOf(html, '<video')]]);
    expect(only(f, 'video-without-poster').map((x) => [x.grade, x.line])).toEqual([['ask', lineOf(html, '<video')]]);
    none(f, 'lazy-lcp');
    const lazyImg = page('', '<section class="hero">\n<h1>Two days to close</h1>\n<img loading="lazy" src="a.png" alt="A">\n</section>');
    expect(only(await lintPage(lazyImg), 'lazy-lcp').map((x) => [x.grade, x.tier, x.line])).toEqual([['ask', 'ask', lineOf(lazyImg, '<img')]]);
    const lazyVideo = page('', '<video muted loading="lazy" poster="p.jpg" src="a.mp4"></video>');
    expect(only(await lintPage(lazyVideo), 'lazy-lcp').map((x) => x.evidence)).toEqual(['the first video loads lazily and is likely the largest paint']);
  });
  test('autoplay muted with a poster, an eager first image and a lazy second image are clean', async () => {
    const f = await lintPage(page('', '<section class="hero"><h1>Two days to close</h1><video autoplay muted loop playsinline poster="p.jpg" src="a.mp4"></video><img src="a.png" alt="A"></section>\n<img loading="lazy" src="b.png" alt="B">'));
    none(f, 'autoplay-unmuted');
    none(f, 'video-without-poster');
    none(f, 'lazy-lcp');
  });
});

describe('design-lint motion: input-state-shift (gate 39a)', () => {
  const field = '<form><label for="e">Email</label><input id="e" type="email"><button class="button" type="submit">Send</button></form>';
  test('a border that changes width on focus, a focus state drawn with border, and disabled by opacity alone each block', async () => {
    const html = page('input { border: 1px solid var(--color-ink); }\ninput:focus { border: 2px solid var(--color-ink); }\n.field:focus { border-color: var(--color-ink); }\n.button:disabled { opacity: 0.5; }', field, { states: false });
    const f = await lintPage(html);
    expect(only(f, 'input-state-shift').map((x) => [x.grade, x.line, x.evidence])).toEqual([
      ['blocks', lineOf(html, 'input:focus'), 'the border goes from 1px to 2px on input:focus, so the field shifts'],
      ['blocks', lineOf(html, 'input:focus'), 'the focus state is drawn with border on input:focus'],
      ['blocks', lineOf(html, '.field:focus'), 'the focus state is drawn with border on .field:focus'],
      ['blocks', lineOf(html, '.button:disabled'), 'disabled by opacity alone on .button:disabled'],
    ]);
  });
  test('a constant border with the focus state on outline, and a disabled state with cursor: not-allowed, are clean', async () => {
    none(await lintPage(page('input { border: 1px solid var(--color-ink); }\ninput:focus { border-color: var(--color-ink); outline: 2px solid var(--color-ink); outline-offset: 2px; }', field)), 'input-state-shift');
  });
});

describe('design-lint motion: control-height (gate 39b, static half)', () => {
  test('a control whose CSS fixes its height outside 44 to 52px reports at ask on a page', async () => {
    const html = page('.button { height: 36px; }\ninput { min-height: 3.5rem; }', '<form><input type="text" aria-label="Name">' + BUTTON + '</form>');
    const f = await lintPage(html);
    expect(only(f, 'control-height').map((x) => [x.grade, x.line, x.evidence])).toEqual([['ask', lineOf(html, 'height: 36px'), 'height: 36px (36px) on .button: controls stand 44 to 52px'], ['ask', lineOf(html, '3.5rem'), 'min-height: 3.5rem (56px) on input: controls stand 44 to 52px']]);
    none(await lintPage(html, { scope: 'component' }), 'control-height');
  });
  test('48px controls, a hidden radio, and an icon button are not reported', async () => {
    none(await lintPage(page('.button { min-height: 48px; }\ninput[type="radio"] { height: 1px; }\n.icon-button { height: 32px; }', '<form><input type="radio" aria-label="A"><button class="icon-button" aria-label="Close"></button>' + BUTTON + '</form>')), 'control-height');
  });
});

describe('design-lint motion: content-hidden-at-rest (gate 62)', () => {
  test('a reveal class hidden at rest with a transform, waiting for a script, blocks at the hiding declaration', async () => {
    const html = page('.reveal {\n  opacity: 0;\n  transform: translateY(20px);\n  transition: opacity 400ms, transform 400ms;\n}\n.reveal.is-visible { opacity: 1; transform: none; }', '<p class="reveal">Hidden until observed.</p>', { reduce: true });
    const f = await lintPage(html);
    expect(only(f, 'content-hidden-at-rest').map((x) => [x.grade, x.line, x.evidence])).toEqual([['blocks', lineOf(html, 'opacity: 0;'), '.reveal is hidden at rest (opacity: 0) and needs a script to appear']]);
  });
  test('hiding under a .js class, animating from hidden to visible, and a hidden tooltip are clean', async () => {
    none(await lintPage(page('.js .reveal { opacity: 0; transform: translateY(20px); }', '<p class="reveal">Hidden until observed.</p>', { reduce: true })), 'content-hidden-at-rest');
    none(await lintPage(page('.rise { opacity: 0; animation: rise 600ms ease-out forwards; }\n@keyframes rise { to { opacity: 1; } }', '<p class="rise">Rises.</p>', { reduce: true })), 'content-hidden-at-rest');
    none(await lintPage(page('.tooltip { opacity: 0; transform: translateY(4px); }', '<span class="tooltip">Help</span>', { reduce: true })), 'content-hidden-at-rest');
  });
});

describe('design-lint motion: the shared fixtures', () => {
  test('slopped.html trips the planted motion tells at their lines', async () => {
    const f = (await lint([path.join(FIXTURES, 'slopped.html')], { cwd: ROOT, warn: (l: string) => { throw new Error(l); } })).findings;
    const mine = f.filter((x) => FAMILY.includes(x.rule)).map((x) => [x.rule, x.grade, x.line]);
    expect(mine).toEqual([
      ['focus-ring-fade', 'blocks', 85],
      ['layout-transition', 'blocks', 79],
      ['layout-transition', 'blocks', 97],
      ['layout-transition', 'blocks', 98],
      ['missing-reduced-motion', 'blocks', 97],
      ['missing-states', 'ask', 1],
      ['missing-states', 'ask', 1],
    ]);
  });
  test('the clean page raises no motion finding', async () => {
    const f = (await lint([path.join(FIXTURES, 'clean')], { cwd: ROOT, warn: (l: string) => { throw new Error(l); } })).findings;
    expect(f.filter((x) => FAMILY.includes(x.rule)).map(formatFinding)).toEqual([]);
  });
});

describe('design-lint motion: the removed-outline check (third review cycle)', () => {
  test('a fractional outline on :focus-visible is a ring, so outline: none on :focus does not block', async () => {
    const f = await lintPage(page('a:focus { outline: none; }\na:focus-visible { outline: 0.25rem solid var(--color-ink); }', '<a href="/x">Go</a>', { states: false }).replace('a:focus-visible, .button:focus-visible { outline: 2px solid var(--color-ink); }\n', ''));
    none(f, 'missing-focus-visible');
  });
  test('the usual :focus:not(:focus-visible) reset with a ring, and a box-shadow ring beside outline: none, are clean; outline: 0 and outline-style: none with no ring block', async () => {
    const base = (css: string) => page(css, '<a href="/x">Go</a>', { states: false });
    none(await lintPage(base('a:focus:not(:focus-visible) { outline: none; }\na:focus-visible { outline: 2px solid var(--color-ink); }')), 'missing-focus-visible');
    none(await lintPage(base('a:focus { outline: none; box-shadow: 0 0 0 3px var(--color-ink); }')), 'missing-focus-visible');
    for (const removed of ['outline: 0', 'outline: 0px', 'outline-style: none']) {
      const html = base(`a:focus { ${removed}; }`);
      const f = await lintPage(html);
      expect(only(f, 'missing-focus-visible').map((x) => [x.grade, x.evidence.split(' on ')[0]])).toEqual([['blocks', removed]]);
    }
    const hoverOnly = await lintPage(base('a:focus { outline: none; }\na:hover { outline: 2px solid var(--color-ink); }'));
    expect(only(hoverOnly, 'missing-focus-visible').map((x) => x.grade)).toEqual(['blocks']);
  });
});
