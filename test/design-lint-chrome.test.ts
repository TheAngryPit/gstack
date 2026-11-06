/**
 * The chrome rule family of the design lint (lib/design-lint/rules/chrome.ts,
 * chrome-copy.ts, chrome-eyebrow.ts): for every rule id, one page that is
 * clean for it and one with the tell planted, checked by id, grade and line.
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

/** A page with the css in one <style> and the body as given; the tokens block keeps the other families quiet where it can. */
function page(css: string, body: string): string {
  return '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Harbour office</title><meta name="description" content="A test page."><link rel="icon" href="data:,">\n<style>\n' + TOKENS + '\n' + css + '\n</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';
}

const lineOf = (html: string, needle: string): number => {
  const at = html.indexOf(needle);
  if (at < 0) throw new Error('needle not in page: ' + needle);
  return html.slice(0, at).split('\n').length;
};

function run(html: string, opts: { job?: string | null; scope?: 'page' | 'component'; files?: Record<string, string> } = {}): Finding[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-chrome-'));
  tmpDirs.push(dir);
  const { files = {}, ...rest } = opts;
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return lintStatic([dir], { cwd: dir, warn: (l) => { throw new Error(l); }, ...rest }).findings;
}

const only = (findings: Finding[], rule: string) => findings.filter((f) => f.rule === rule);
const show = (findings: Finding[]) => findings.map(formatFinding);

describe('design-lint chrome: copy (gate 19)', () => {
  test('aphoristic-cadence: the rebuttal cadence three times blocks; once is voice', () => {
    const tic = page('', '<main>\n<p>Ship it. Not a feature. A platform. Fast. Not a tool. A system. Clean. Not a demo. A product.</p>\n</main>');
    const hits = only(run(tic), 'aphoristic-cadence');
    expect(show(hits)).toHaveLength(1);
    expect(hits[0].grade).toBe('blocks');
    expect(hits[0].line).toBe(lineOf(tic, 'Not a feature'));
    expect(hits[0].evidence).toContain('3 times');
    expect(only(run(page('', '<main><p>Not a feature. A platform. The ledger closes on the second of the month.</p></main>')), 'aphoristic-cadence')).toEqual([]);
  });

  test('generic-hero-copy: a filler opener, the quiet-proof line and the Meet heading block; plain prose is clean', () => {
    const slop = page('', '<main>\n<h1>Built for the modern team</h1>\n<p>Quietly trusted by the people who ship.</p>\n<h2>Meet Ledgerline</h2>\n</main>');
    const hits = only(run(slop), 'generic-hero-copy');
    expect(hits.map((f) => [f.grade, f.line])).toEqual([['blocks', lineOf(slop, 'Built for')], ['blocks', lineOf(slop, 'Quietly')], ['blocks', lineOf(slop, 'Meet ')]]);
    expect(hits[0].evidence).toContain('a filler opener');
    expect(only(run(page('', '<main><h1>October closed in two days</h1><p>Halvorsen Freight reconciles 1,140 invoices a month.</p></main>')), 'generic-hero-copy')).toEqual([]);
  });

  test('generic-cta-copy: the stock second action beside a filled primary asks, and so do two "Learn more" links; a second action that names its destination is clean', () => {
    const css = '.btn { background: var(--color-accent); color: var(--color-accent-ink); } .cta-quiet { color: var(--color-ink); }';
    const stock = page(css, '<section class="hero">\n<h1>October closed in two days</h1>\n<a class="btn" href="/book">Book the walkthrough</a>\n<a class="cta-quiet" href="/tour">Learn more</a>\n</section>');
    const hits = only(run(stock), 'generic-cta-copy');
    expect(show(hits)).toHaveLength(1);
    expect(hits[0].grade).toBe('ask');
    expect(hits[0].line).toBe(lineOf(stock, 'Learn more'));
    const links = page(css, '<main>\n<p><a href="/a">Read more</a></p>\n<p><a href="/b">Read more</a></p>\n</main>');
    const linkHits = only(run(links), 'generic-cta-copy');
    expect(linkHits.map((f) => f.line)).toEqual([lineOf(links, '<a href="/a">')]);
    expect(linkHits[0].evidence).toContain('on 2 links');
    const named = page(css, '<section class="hero"><h1>October closed in two days</h1><a class="btn" href="/book">Book the walkthrough</a><a class="cta-quiet" href="/method">Read how the close works</a></section>');
    expect(only(run(named), 'generic-cta-copy')).toEqual([]);
  });

  test('em-dash-overuse: three dashes ask with the count; two are not overuse', () => {
    const dashy = page('', '<main>\n<p>The close ran in two days \u2014 not nine \u2014 and the review \u2013 the slow part \u2014 started on the first.</p>\n</main>');
    const hits = only(run(dashy), 'em-dash-overuse');
    expect(show(hits)).toHaveLength(1);
    expect(hits[0].grade).toBe('ask');
    expect(hits[0].line).toBe(lineOf(dashy, 'two days'));
    expect(hits[0].evidence).toMatch(/^4 dashes/);
    expect(only(run(page('', '<main><p>The close ran in two days \u2014 not nine \u2014 and the review started on the first.</p></main>')), 'em-dash-overuse')).toEqual([]);
  });

  test('template-footer-line: "All rights reserved" asks; the page\'s own footer line is clean', () => {
    const stock = page('', '<main><h1>Ledgerline</h1></main>\n<footer>\n<p>&copy; 2026 Ledgerline. All rights reserved.</p>\n</footer>');
    const hits = only(run(stock), 'template-footer-line');
    expect(hits.map((f) => [f.grade, f.line])).toEqual([['ask', lineOf(stock, 'All rights')]]);
    expect(only(run(page('', '<footer><p>Ledgerline, Bergen. Photographs by Halvorsen Freight.</p></footer>')), 'template-footer-line')).toEqual([]);
  });
});

describe('design-lint chrome: the reflex nav and footer (gate 42)', () => {
  test('template-nav: four to six inline links, a button and a 1px hairline ask; three links and no hairline are clean', () => {
    const css = 'nav { display: flex; border-bottom: 1px solid var(--color-muted); }';
    const reflex = page(css, '<nav class="nav">\n<a href="/">Ledgerline</a><a href="/method">Method</a><a href="/pricing">Pricing</a><a href="/customers">Customers</a><a href="/docs">Docs</a>\n<a class="btn" href="/book">Book</a>\n</nav>\n<main><h1>Ledgerline</h1></main>');
    const hits = only(run(reflex), 'template-nav');
    expect(hits.map((f) => [f.grade, f.line])).toEqual([['ask', lineOf(reflex, '<nav')]]);
    expect(hits[0].evidence).toBe('the reflex nav shape: 6 inline links, a button and a 1px hairline under');
    expect(only(run(page('nav { display: flex; }', '<nav><a href="/">Ledgerline</a><a href="/method">Method</a><a href="/pricing">Pricing</a></nav><main><h1>Ledgerline</h1></main>')), 'template-nav')).toEqual([]);
    expect(only(run(reflex, { scope: 'component' }), 'template-nav')).toEqual([]);
  });

  test('template-footer: four link columns ask; a one-line footer is clean', () => {
    const col = '<ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li><li><a href="/c">C</a></li></ul>';
    const reflex = page('', '<main><h1>Ledgerline</h1></main>\n<footer>\n' + col + '\n' + col + '\n' + col + '\n' + col + '\n</footer>');
    const hits = only(run(reflex), 'template-footer');
    expect(hits.map((f) => [f.grade, f.line])).toEqual([['ask', lineOf(reflex, '<footer')]]);
    expect(hits[0].evidence).toContain('4 link columns');
    expect(only(run(page('', '<footer><p>Ledgerline, Bergen.</p></footer>')), 'template-footer')).toEqual([]);
  });
});

describe('design-lint chrome: proof, drawn chrome and material (gates 46a, 47)', () => {
  test('invented-proof: a metric the page cannot source lands at ask for a person to confirm; a plain count is clean', () => {
    const slop = page('', '<main>\n<p>Trusted by 50,000+ teams shipping 10x faster.</p>\n</main>');
    const hits = only(run(slop), 'invented-proof');
    expect(hits.map((f) => [f.tier, f.grade, f.line])).toEqual([['ask', 'ask', lineOf(slop, 'Trusted by')]]);
    expect(only(run(page('', '<main><p>Halvorsen Freight reconciles 1,140 invoices a month.</p></main>')), 'invented-proof')).toEqual([]);
  });

  test('drawn-browser-chrome blocks on a traffic-light bar class or selector; device-frame asks on a phone frame; a real figure is clean', () => {
    const drawn = page('.window-frame { border: 1px solid var(--color-muted); }', '<main>\n<div class="browser-bar"><span class="dot"></span></div>\n<div class="phone-frame"></div>\n</main>');
    const findings = run(drawn);
    const bar = only(findings, 'drawn-browser-chrome');
    expect(bar.map((f) => [f.grade, f.line])).toEqual([['blocks', lineOf(drawn, 'browser-bar')]]);
    expect(bar[0].evidence).toContain('class "browser-bar"');
    const frame = only(findings, 'device-frame');
    expect(frame.map((f) => [f.grade, f.line]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([['ask', lineOf(drawn, '.window-frame')], ['ask', lineOf(drawn, 'phone-frame"')]]);
    const clean = run(page('', '<main><figure><img src="shot.png" alt="The close screen"><figcaption>The close screen.</figcaption></figure></main>'));
    expect(only(clean, 'drawn-browser-chrome')).toEqual([]);
    expect(only(clean, 'device-frame')).toEqual([]);
  });

  test('imitation-material: a placeholder image service asks, in markup or CSS; a real asset is clean', () => {
    const fake = page('', '<main>\n<img src="https://via.placeholder.com/300" alt="">\n</main>').replace('<style>', '<link rel="stylesheet" href="style.css"><style>');
    const css = '.hero {\n  background: url(https://placehold.co/600x400);\n}\n';
    const hits = only(run(fake, { files: { 'style.css': css } }), 'imitation-material');
    expect(hits.map((f) => [f.grade, f.file, f.line]).sort((a, b) => String(a[1]).localeCompare(String(b[1])))).toEqual([['ask', 'index.html', lineOf(fake, 'via.placeholder')], ['ask', 'style.css', 2]]);
    expect(hits[0].evidence).toMatch(/^a placeholder image service \((placehold\.co|via\.placeholder\.com)\) stands in for a picture$/);
    expect(only(run(page('', '<main><img src="shot.png" alt="The close screen"></main>')), 'imitation-material')).toEqual([]);
  });
});

describe('design-lint chrome: the eyebrow (gate 54)', () => {
  test('kicker-above-heading asks on a labelled span before a heading and on a section labelled by a non-heading; a figcaption before a heading is clean', () => {
    const slop = page('.eyebrow { text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.1em; }', '<main>\n<section>\n<div>\n<span class="eyebrow">01 / Features</span>\n<h2>What it does</h2>\n</div>\n</section>\n<section aria-labelledby="plans">\n<p id="plans" class="eyebrow">Plans</p>\n<p>Three plans, one ledger.</p>\n</section>\n</main>');
    const hits = only(run(slop), 'kicker-above-heading');
    expect(hits.map((f) => [f.grade, f.line])).toEqual([['ask', lineOf(slop, '<span class="eyebrow">')], ['ask', lineOf(slop, 'id="plans"')]]);
    expect(hits[0].evidence).toBe('the eyebrow "01 / Features" before <h2>');
    expect(hits[1].evidence).toContain('labelled by <p>');
    expect(only(run(page('', '<main><figure><figcaption>Plate 4</figcaption><h3>Off the grid</h3></figure></main>')), 'kicker-above-heading')).toEqual([]);
    expect(only(run(slop, { scope: 'component' }), 'kicker-above-heading')).toEqual([]);
  });

  test('the eyebrow fixtures: six on eyebrow-fail, none on eyebrow-pass', async () => {
    const fail = await lint([path.join(FIXTURES, 'eyebrow-fail')], { cwd: ROOT });
    expect(only(fail.findings, 'kicker-above-heading').map((f) => f.line)).toEqual([65, 74, 83, 92, 101, 110]);
    const pass = await lint([path.join(FIXTURES, 'eyebrow-pass')], { cwd: ROOT });
    expect(show(only(pass.findings, 'kicker-above-heading'))).toEqual([]);
  });
});

describe('design-lint chrome: punctuation, slots, echoes and sends (gates 63, 68, 69, 70)', () => {
  test('template-punctuation blocks on middle-dot meta strings, a glued arrow and three decorative dots; one dot in a byline is clean', () => {
    const slop = page('', '<main>\n<p class="meta">Design \u00b7 12 min read \u00b7 March</p>\n<a href="/method">Learn how it works \u2192</a>\n<ul><li><span class="dot"></span>Live</li><li><span class="dot"></span>Beta</li><li><span class="dot"></span>Soon</li></ul>\n</main>');
    const hits = only(run(slop), 'template-punctuation');
    expect(hits.map((f) => [f.grade, f.line])).toEqual([['blocks', lineOf(slop, 'class="meta"')], ['blocks', lineOf(slop, '<a href="/method">')], ['blocks', lineOf(slop, '<ul>')]]);
    expect(hits.map((f) => f.evidence.split(':')[0].split(' "')[0])).toEqual(['middle dots join a meta string', 'an arrow glued to the label', 'decorative status dots (dot) repeated across the page']);
    expect(only(run(page('', '<main><p class="byline">Marta Silveira \u00b7 14 March 2026</p><a href="/method">Read the method</a></main>')), 'template-punctuation')).toEqual([]);
  });

  test('wireframe-slots asks past five empty slots on a page and at four in one row; two slots holding pictures are clean', () => {
    const slots = (n: number) => Array.from({ length: n }, (_, i) => '<div data-slot="s' + i + '"></div>').join('\n');
    const many = page('', '<main>\n<section class="team">\n' + slots(6) + '\n</section>\n</main>');
    const hits = only(run(many), 'wireframe-slots');
    expect(hits.map((f) => [f.grade, f.line, f.evidence])).toEqual([
      ['ask', lineOf(many, 'data-slot="s5"'), '6 empty slots on one page'],
      ['ask', lineOf(many, '<section class="team">'), '6 empty slots in one row or grid'],
    ]);
    const row = page('', '<main><section><div class="row">\n' + slots(4) + '\n</div></section></main>');
    expect(only(run(row), 'wireframe-slots').map((f) => f.evidence)).toEqual(['4 empty slots in one row or grid']);
    expect(only(run(page('', '<main><div data-slot="a"><img src="a.jpg" alt="Mari"></div><div data-slot="b"><img src="b.jpg" alt="Depot"></div></main>')), 'wireframe-slots')).toEqual([]);
  });

  test('repeated-fact asks when one fact is printed in four sections; the same fact twice is clean', () => {
    const band = (i: number) => '<section id="s' + i + '"><p>From $49 a month.</p></section>';
    const echo = page('', '<main>\n' + [1, 2, 3, 4].map(band).join('\n') + '\n</main>');
    const hits = only(run(echo), 'repeated-fact');
    expect(hits.map((f) => [f.grade, f.line, f.evidence])).toEqual([['ask', 1, 'the same fact printed in 4 sections: $49 (4)']]);
    expect(only(run(page('', '<main>' + [1, 2].map(band).join('') + '</main>')), 'repeated-fact')).toEqual([]);
  });

  test('fake-send lands at ask when a script prints success with no request behind it; the same script with fetch() is clean', () => {
    const script = (send: string) => '<main>\n<form id="f"><input type="email" name="email"><button>Join</button></form>\n<script>\ndocument.getElementById("f").addEventListener("submit", (e) => {\n  e.preventDefault();\n  ' + send + '\n  document.getElementById("f").textContent = "Thanks, you are on the list";\n});\n</script>\n</main>';
    const fake = page('', script(''));
    const hits = only(run(fake), 'fake-send');
    expect(hits.map((f) => [f.tier, f.grade, f.line])).toEqual([['ask', 'ask', lineOf(fake, '"Thanks, you are')]]);
    expect(hits[0].evidence).toContain('a script prints success');
    expect(only(run(page('', script('fetch("/api/join", { method: "POST", body: new FormData(e.target) });'))), 'fake-send')).toEqual([]);
  });
});

describe('design-lint chrome: the email band close (gate 85)', () => {
  const signup = '<form class="newsletter">\n<label for="e">Email</label><input id="e" type="email" name="email"><button>Subscribe</button>\n</form>';
  test('email-band-close asks when the last section before the footer is an email sign-up and no job was named; a subscribe job, a booking form and a component context are clean', () => {
    const close = page('', '<main>\n<section class="story"><h2>Where the seven days went</h2><p>Three days were matching receipts.</p></section>\n<section class="band">\n' + signup + '\n</section>\n</main>\n<footer><p>Ledgerline, Bergen.</p></footer>');
    const hits = only(run(close), 'email-band-close');
    expect(hits.map((f) => [f.grade, f.line])).toEqual([['ask', lineOf(close, '<form class="newsletter">')]]);
    expect(hits[0].evidence).toBe('the page closes on an email sign-up <form class="newsletter"> as its last section, and no job was named (--job)');
    expect(only(run(close, { job: 'buy' }), 'email-band-close')[0].evidence).toContain('on a buy page');
    expect(only(run(close, { job: 'subscribe' }), 'email-band-close')).toEqual([]);
    expect(only(run(close, { scope: 'component' }), 'email-band-close')).toEqual([]);
    const footerForm = page('', '<main><section class="story"><h2>Where the seven days went</h2></section></main>\n<footer>\n' + signup + '\n</footer>');
    expect(only(run(footerForm), 'email-band-close')[0].evidence).toContain('in the footer');
    const booking = page('', '<main><section class="close"><form><input type="email" name="email"><button>Book the walkthrough</button></form></section></main><footer><p>Ledgerline, Bergen.</p></footer>');
    expect(only(run(booking), 'email-band-close')).toEqual([]);
    const notLast = page('', '<main><section class="band">' + signup + '</section><section class="close"><h2>See your own close</h2><a href="/book">Book the walkthrough</a></section></main><footer><p>Ledgerline, Bergen.</p></footer>');
    expect(only(run(notLast), 'email-band-close')).toEqual([]);
  });
});

describe('design-lint chrome: two filled buttons in the hero (F4 half)', () => {
  test('two-primary-buttons prints at polish for two filled buttons side by side in the hero; a filled primary beside a quiet link is clean', () => {
    const css = '.btn { background: var(--color-accent); color: var(--color-accent-ink); } .quiet { color: var(--color-ink); text-decoration: underline; }';
    const two = page(css, '<section class="hero">\n<h1>October closed in two days</h1>\n<a class="btn" href="/book">Book the walkthrough</a>\n<a class="btn" href="/tour">Take the tour</a>\n</section>');
    const hits = only(run(two), 'two-primary-buttons');
    expect(hits.map((f) => [f.grade, f.line])).toEqual([['polish', lineOf(two, 'Take the tour')]]);
    expect(hits[0].evidence).toBe('two filled buttons side by side in the hero: "Book the walkthrough" and "Take the tour"');
    expect(only(run(page(css, '<section class="hero"><h1>October closed in two days</h1><a class="btn" href="/book">Book the walkthrough</a><a class="quiet" href="/method">Read how the close works</a></section>')), 'two-primary-buttons')).toEqual([]);
  });
});

describe('design-lint chrome: fixtures', () => {
  test('the clean page raises nothing from this family; slopped.html plants the invented metric and the eyebrow', async () => {
    const chrome = new Set(['aphoristic-cadence', 'generic-hero-copy', 'generic-cta-copy', 'em-dash-overuse', 'template-footer-line', 'template-nav', 'template-footer', 'invented-proof', 'drawn-browser-chrome', 'device-frame', 'imitation-material', 'kicker-above-heading', 'template-punctuation', 'wireframe-slots', 'repeated-fact', 'fake-send', 'email-band-close']);
    const clean = await lint([path.join(FIXTURES, 'clean')], { cwd: ROOT });
    expect(show(clean.findings.filter((f) => chrome.has(f.rule)))).toEqual([]);
    const slopped = await lint([path.join(FIXTURES, 'slopped.html')], { cwd: ROOT });
    expect(only(slopped.findings, 'invented-proof').map((f) => [f.grade, f.line])).toEqual([['ask', 113]]);
    expect(only(slopped.findings, 'kicker-above-heading').map((f) => [f.grade, f.line, f.evidence])).toEqual([['ask', 120, 'the eyebrow "01 / FEATURES" before <h2>']]);
  });
});

describe('design-lint chrome: third review cycle', () => {
  test('repeated-fact counts a percentage printed in four sections', () => {
    const band = (i: number) => '<section id="s' + i + '"><p>Save 30% off this month.</p></section>';
    const hits = only(run(page('', '<main>\n' + [1, 2, 3, 4].map(band).join('\n') + '\n</main>')), 'repeated-fact');
    expect(hits.map((f) => [f.grade, f.evidence])).toEqual([['ask', 'the same fact printed in 4 sections: 30% (4)']]);
  });
  test('a stock line in the hero blocks; the same line in body copy below the hero is suspected, so it sits at ask and a waiver can answer it', () => {
    const inHero = page('', '<main>\n<header class="hero"><h1>Ledger</h1><p>Everything you need to close the month.</p></header>\n<section><h2>Notes</h2><p>The books close on the first.</p></section>\n</main>');
    expect(only(run(inHero), 'generic-hero-copy').map((f) => [f.grade, f.line])).toEqual([['blocks', lineOf(inHero, 'Everything you need')]]);
    const below = page('', '<main>\n<header class="hero"><h1>Ledger</h1><p>The books close on the first.</p></header>\n<section><h2>Help</h2><p>Whether you\'re logged in or not, your cart stays.</p></section>\n</main>');
    expect(only(run(below), 'generic-hero-copy').map((f) => [f.grade, f.line])).toEqual([['ask', lineOf(below, 'Whether you')]]);
    const waived = run('<!-- gstack-lint-disable generic-hero-copy: the help page quotes the cart notice word for word -->\n' + below);
    expect(only(waived, 'generic-hero-copy').map((f) => f.grade)).toEqual(['waived']);
    expect(only(waived, 'waiver')).toEqual([]);
  });
  test('a region whose list items leave their end tags out still counts facts per section', () => {
    const band = (i: number) => '<section id="s' + i + '"><ul><li>From $49 a month.<li>Second item</ul></section>';
    const hits = only(run(page('', '<main>\n' + [1, 2, 3, 4].map(band).join('\n') + '\n</main>')), 'repeated-fact');
    expect(hits.map((f) => f.evidence)).toEqual(['the same fact printed in 4 sections: $49 (4)']);
  });
});
