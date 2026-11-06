/**
 * The seventh review cycle's regressions: the stray-`<` tail that made every `[^>]*>` scan quadratic, the JSX scanner's
 * mismatched-closer cascade, the token table read in one colour mode, a theme class block as tokens, the component
 * directory's per-file claims under either scope with their own suspected rules, the Reporter's own file key in the
 * Tailwind dedupe, and the rule judgements the design pass asked for (outline: none is not a ring, a sign-in form is
 * not a mailing-list band, a token finding points at the declaration that won, one control-tracking ceiling).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { jsxPseudo, parseDoc } from '../lib/design-lint/html';
import { lintStatic } from '../lib/design-lint/static';
import type { Finding } from '../lib/design-lint/report';

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const TOKENS = ':root { --color-paper: oklch(97% 0.01 80); --color-ink: oklch(20% 0.02 250); --color-accent: oklch(50% 0.16 30); --color-accent-ink: oklch(98% 0.01 30); --color-muted: oklch(50% 0.02 250); --font-display: "Literata", serif; --font-body: "Public Sans", sans-serif; }';
const HEAD = '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Harbour office</title><meta name="description" content="A test page."><link rel="icon" href="data:,">\n';
const page = (css: string, body: string): string => HEAD + '<style>\n' + TOKENS + '\n' + css + '\n</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';
const sheet = (css: string, body: string): string => HEAD + '<style>\n' + css + '\n</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-cycle7-'));
  tmpDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const quiet = { warn: () => {} };
const run = (html: string, files: Record<string, string> = {}): Finding[] => { const dir = tree({ 'index.html': html, ...files }); return lintStatic([dir], { cwd: dir, ...quiet }).findings; };
const only = (f: Finding[], rule: string) => f.filter((x) => x.rule === rule);
const timed = (fn: () => void): number => { const t = performance.now(); fn(); return performance.now() - t; };
const DASHES = 'The ledger \u2014 the month \u2014 the close \u2014 the depot \u2014 the review \u2014 the rule \u2014 the row \u2014 the sum';
const CARD = 'export function Card() { return <p>' + DASHES + '</p>; }';

describe('design-lint seventh cycle: a file costs its length', () => {
  test('a page whose tail is thousands of unclosed <img starts lints in linear time, and its tags are still read', () => {
    const dir = tree({ 'index.html': HEAD + '</head><body><main><h1>Hello there</h1><p>Some prose about a thing.</p></main>' + '<img '.repeat(80_000) });
    let f: Finding[] = [];
    expect(timed(() => { f = lintStatic([dir], { cwd: dir, ...quiet }).findings; })).toBeLessThan(5000);
    expect(only(f, 'broken-image')).toEqual([]);
    const doc = parseDoc('/tmp/t.html', '<main><h1>Hi</h1><img <img src="a.png"></main>');
    expect(doc.tags.filter((t) => t.name === 'img').length).toBe(1);
    expect(doc.src.indexOf('<img')).toBe(doc.src.lastIndexOf('<img'));
  });

  test('a box-shadow of many paren-free layers costs its length', () => {
    const dir = tree({ 's.css': ':root{--x:1}\n.card{border:1px solid #ccc;box-shadow:' + Array.from({ length: 32000 }, () => '0 1px 2px red').join(', ') + '}\n' });
    expect(timed(() => lintStatic([dir], { cwd: dir, ...quiet }))).toBeLessThan(2000);
  });

  test('a generic element and a stray or ancestor-closing tag cost a JSX file its length, not its depth', () => {
    const build = (depth: number) => 'export default function A() { return (' + '<div className="a">'.repeat(depth) + '<Table<Row> rows={rows}>' + '<p className="x">hello <b>b</b></p>'.repeat(4000) + '</Table>' + '</div>'.repeat(depth) + '); }';
    expect(timed(() => jsxPseudo(build(60)))).toBeLessThan(500);
    expect(jsxPseudo(build(2)).classAt.size).toBe(4002);
    const stray = 'export default function A() { return (' + '<div className="a">'.repeat(150) + '</span>' + '<p className="x">hello</p>'.repeat(8000) + '</div>'.repeat(150) + '); }';
    expect(timed(() => jsxPseudo(stray))).toBeLessThan(500);
    expect(parseDoc('/tmp/A.tsx', stray).tags.filter((t) => !t.close && t.name === 'p').length).toBe(8000);
    expect(parseDoc('/tmp/B.tsx', 'export default function B() { return (<div><span>text</div>); }').tags.map((t) => (t.close ? '/' : '') + t.name)).toEqual(['div', 'span', '/div']);
  });
});

describe('design-lint seventh cycle: the token table in one mode', () => {
  test('a class-scoped theme block and a component-local custom property are token definitions, not literals', () => {
    const f = run(page('.dark { --color-paper: oklch(15% 0.01 80); --color-ink: oklch(95% 0.01 80); } .card { --accent: #f00; }', '<main><h1>Ledger of the dark</h1><p>Read it in either mode.</p></main>'));
    expect(only(f, 'literal-outside-tokens')).toEqual([]);
  });

  test('a prefers-color-scheme override does not mix modes in the token table', () => {
    const css = ':root { --color-paper: oklch(98% 0.01 80); --color-ink: oklch(20% 0.02 80); --color-muted: oklch(45% 0.02 80); }\n@media (prefers-color-scheme: dark) { :root { --color-paper: oklch(15% 0.01 80); --color-ink: oklch(95% 0.01 80); } }\n.note { color: var(--color-muted); background: var(--color-paper); }';
    expect(only(run(sheet(css, '<main><h1>Ledger</h1><p class="note">A note in the muted ink.</p></main>')), 'low-contrast')).toEqual([]);
  });

  test('a token finding points at the declaration whose value won', () => {
    const last = run(sheet(':root{--font-display:Georgia}\n:root{--font-display:Papyrus}', '<main><h1>Hello there</h1><p>Body.</p></main>'));
    expect(only(last, 'banned-font').map((x) => [x.line, x.evidence])).toEqual([[6, '"papyrus" (--font-display)']]);
    const dark = run(sheet(':root{--font-display:Georgia}\n[data-theme=dark]{--font-display:Papyrus}', '<main><h1>Hello there</h1><p>Body.</p></main>'));
    expect(only(dark, 'banned-font')).toEqual([]);
  });
});

describe('design-lint seventh cycle: waivers in a directory of components', () => {
  test('a component claim never covers a sibling file, whatever the scope, and a short one is refused at its line', () => {
    const dir = tree({ 'Card.tsx': CARD, 'Hero.tsx': '// gstack-lint-disable em-dash-overuse: the ledger sets its dashes as the month closes on the depot\nexport function Hero() { return <h1>The ledger closes the month on the depot</h1>; }' });
    const f = lintStatic([dir], { cwd: dir, ...quiet }).findings;
    expect(only(f, 'em-dash-overuse').map((x) => [x.file, x.grade])).toEqual([['Card.tsx', 'ask']]);
    expect(only(f, 'waiver')).toEqual([]);
    const short = tree({ 'Card.tsx': '// gstack-lint-disable em-dash-overuse: short\n' + CARD, 'Hero.tsx': 'export function Hero() { return <h1>The ledger</h1>; }' });
    const g = lintStatic([short], { cwd: short, ...quiet }).findings;
    expect(only(g, 'em-dash-overuse').map((x) => x.grade)).toEqual(['ask']);
    expect(only(g, 'waiver').map((x) => [x.file, x.line, x.evidence])).toEqual([['Card.tsx', 1, 'waiver on em-dash-overuse refused: reason under 24 characters']]);
  });

  test("a sibling that measures a blocking rule does not turn another file's suspected finding into the Floor", () => {
    const files = { 'Hero.tsx': 'export function Hero() { return <section className="hero"><h1>Welcome to the depot</h1></section>; }', 'Card.tsx': '// gstack-lint-disable generic-hero-copy: the card quotes the printed welcome sign that hangs over the depot door\nexport function Card() { return <p>Welcome to the depot, the sign over the door says.</p>; }' };
    for (const scope of ['component', 'page'] as const) {
      const dir = tree(files);
      const f = lintStatic([dir], { cwd: dir, ...quiet, scope }).findings;
      expect(only(f, 'generic-hero-copy').map((x) => [x.file, x.grade]).sort()).toEqual([['Card.tsx', 'waived'], ['Hero.tsx', 'blocks']]);
      expect(only(f, 'waiver')).toEqual([]);
    }
  });

  test('a stylesheet beside the components answers for itself: accepted without a shared word, refused at its line', () => {
    const comps = (reason: string) => { const dir = tree({ 'Card.tsx': 'export function Card() { return <p className="row">The ledger.</p>; }', 'theme.css': '/* gstack-lint-disable zero-chroma-neutrals: ' + reason + ' */\n' + TOKENS + '\n:root { --color-gray: oklch(55% 0 0); }\n.row { border-color: var(--color-gray); }' }); return lintStatic([dir], { cwd: dir, ...quiet, scope: 'component' }).findings; };
    const ok = comps('the ledger keeps its grey rows grey in the theme sheet');
    expect(only(ok, 'waiver')).toEqual([]);
    expect(only(ok, 'zero-chroma-neutrals').map((x) => [x.file, x.grade])).toEqual([['theme.css', 'waived']]);
    const bad = comps('short');
    expect(only(bad, 'zero-chroma-neutrals').map((x) => [x.file, x.grade])).toEqual([['theme.css', 'ask']]);
    expect(only(bad, 'waiver').map((x) => [x.file, x.line])).toEqual([['theme.css', 1]]);
  });
});

describe('design-lint seventh cycle: rule judgements', () => {
  test('a Tailwind tell on a line the stylesheet families reported prints once, whatever the page is named', () => {
    const html = page('.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.08em}', '<main><h1>Hi there</h1><section><p class="eyebrow text-xs uppercase tracking-wider">Our depots</p><h2>Bergen and Stavanger</h2></section></main>');
    const counts = ['plain.html', 'two  spaces.html'].map((name) => { const dir = tree({ [name]: html }); const f = lintStatic([dir], { cwd: dir, ...quiet }).findings; return [only(f, 'wide-tracking').length, only(f, 'kicker-above-heading').length]; });
    expect(counts[1]).toEqual(counts[0]);
    expect(counts[0][1]).toBe(1);
  });

  test('outline: none beside a focus border change is input-state-shift; a sign-in form closing the page is not an email band', () => {
    const focus = run(page('input { border: 1px solid var(--color-ink) }\ninput:focus { outline: none; border-color: var(--color-accent) }\nbutton:focus-visible { outline: 2px solid var(--color-accent) }', '<main><h1>Sign in</h1><form><label for="e">Email</label><input id="e" type="email"><button>Send</button></form></main>'));
    expect(only(focus, 'input-state-shift').map((x) => x.evidence)).toEqual(['the focus state is drawn with border on input:focus']);
    const signin = run(page('input { height: 48px }', '<main><h1>Sign in to the ledger</h1><section><p>Your ledger waits behind the door.</p></section><section><form action="/session" method="post"><label for="e">Email</label><input id="e" type="email"><label for="p">Password</label><input id="p" type="password"><button>Sign in</button></form></section></main>'));
    expect(only(signin, 'email-band-close')).toEqual([]);
  });

  test('an uppercase control under an uppercase display may carry 0.04em in a stylesheet as in a class string, no more', () => {
    const f = run(page('h1 { text-transform: uppercase; } .btn{text-transform:uppercase;letter-spacing:0.045em;font-size:14px} .cta{text-transform:uppercase;letter-spacing:0.04em;font-size:14px}', '<main><h1>HELLO THERE</h1><a class="btn" href="#">Go now</a><a class="cta" href="#">Stay</a></main>'));
    expect(only(f, 'wide-tracking').map((x) => x.evidence)).toEqual(['.btn: an uppercase control tracked 0.045em']);
  });

  test('a linked stylesheet that does not exist is warned about and otherwise ignored', () => {
    const warned: string[] = [];
    const dir = tree({ 'index.html': HEAD + '<link rel="stylesheet" href="missing.css"></head><body><main><h1>Hello</h1><p>Body.</p></main></body></html>' });
    const r = lintStatic([dir], { cwd: dir, warn: (l) => warned.push(l) });
    expect(warned).toEqual([expect.stringMatching(/skipped .*missing\.css, not found$/)]);
    expect(only(r.findings, 'internal-error')).toEqual([]);
  });
});
