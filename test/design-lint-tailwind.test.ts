/**
 * The component family of the design lint: the Tailwind reader (class
 * strings in HTML, JSX, Vue, Svelte and Astro, helper calls, shared tokens)
 * and the rules it feeds, each with a negative control and a planted tell.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lint, formatFinding, type Finding } from '../lib/design-lint/index';
import { lintStatic } from '../lib/design-lint/static';
import { twGroup, twParse, twVariants } from '../lib/design-lint/tailwind';

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'design-lint');

const MY_RULES = ['layout-transition', 'bounce-easing', 'purple-blue-gradient', 'gradient-text', 'glow-wash', 'literal-outside-tokens', 'hover-tells', 'wide-tracking', 'kicker-above-heading', 'monospace-costume', 'framework-palette', 'vh-height', 'template-cards', 'template-punctuation', 'emoji-decoration'];

function tmpDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-tw-'));
  tmpDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

async function lintFiles(files: Record<string, string>, opts: { scope?: 'page' | 'component' } = {}): Promise<Finding[]> {
  const dir = tmpDir(files);
  const result = await lint([dir], { cwd: dir, warn: (l: string) => { throw new Error(l); }, ...opts });
  return result.findings;
}

const only = (findings: Finding[], rule: string) => findings.filter((f) => f.rule === rule);
const lines = (findings: Finding[], rule: string) => only(findings, rule).map((f) => f.line);
const mine = (findings: Finding[]) => findings.filter((f) => MY_RULES.includes(f.rule)).map(formatFinding);

/** A page whose body line i (0-based) sits on line 5 + i. */
const page = (body: string[], head = ''): string => ['<!doctype html>', '<html lang="en">', `<head><meta charset="utf-8"><title>Fieldnote</title>${head}</head>`, '<body>', ...body, '</body></html>'].join('\n');
const BODY = 5;

describe('design-lint tailwind: the reader', () => {
  test('twParse splits variants, drops group-/peer- and /names, and reads the ! and - marks', () => {
    expect(twParse('md:hover:bg-accent')).toEqual({ variants: ['md', 'hover'], base: 'bg-accent', neg: false });
    expect(twParse('group-hover/card:-translate-y-1')).toEqual({ variants: ['hover'], base: 'translate-y-1', neg: true });
    expect(twParse('!text-[length:var(--x)]')).toEqual({ variants: [], base: 'text-[length:var(--x)]', neg: false });
    expect(twParse('[&:nth-child(2)]:pt-0').variants).toEqual(['[&:nth-child(2)]']);
  });

  test('class strings are read from class, className, :class, class:list, class: directives and cn()/clsx()/cva() calls; variants are collected', async () => {
    const dir = tmpDir({
      'package.json': '{}',
      'Hero.tsx': [
        'import { cva } from "cva";',
        'import { cn } from "./cn";',
        'const badge = cva("rounded-full text-xs uppercase tracking-widest");',
        'export function Hero({ on }: { on: boolean }) {',
        '  const row = clsx("flex", on && "transition-all");',
        '  return <a className={cn("px-3", on ? "hover:bg-accent focus-visible:outline-2" : "")}>Go</a>;',
        '}',
      ].join('\n'),
      'Card.vue': '<template>\n  <div :class="{ \'motion-reduce:transition-none\': true }" class="p-4"></div>\n</template>',
      'Band.astro': '---\nconst x = 1;\n---\n<div class:list={["bg-paper", { "disabled:opacity-50": true }]} class:active={x}></div>\n<p class="mt-2 {x ? \'text-sm\' : \'\'} tracking-wide">Hi</p>',
    });
    const { contexts } = lintStatic([dir], { cwd: dir, warn: (l: string) => { throw new Error(l); } });
    const ctx = contexts.find((c) => c.docs.length === 3)!;
    const tw = twGroup(ctx);
    const by = (tag: string) => tw.items.filter((i) => i.tag === tag).map((i) => i.info.classes.join(' '));
    expect(by('cva')).toEqual(['rounded-full text-xs uppercase tracking-widest']);
    expect(by('clsx')).toEqual(['flex transition-all']);
    expect(by('a')).toEqual(['px-3 hover:bg-accent focus-visible:outline-2']);
    expect(by('div')).toEqual(['bg-paper disabled:opacity-50 active', 'motion-reduce:transition-none p-4']);
    expect(by('p')).toEqual(['mt-2 text-sm tracking-wide']);
    expect([...twVariants(ctx)].sort()).toEqual(['disabled', 'focus-visible', 'hover', 'motion-reduce']);
  });

  test('a component directory borrows the project tokens from a sibling globals.css @theme block', async () => {
    const dir = tmpDir({
      'package.json': '{}',
      'app/globals.css': '@import "tailwindcss";\n@theme {\n  --color-paper: oklch(97% 0.01 80);\n  --color-accent: oklch(55% 0.2 300);\n  --text-label: 0.75rem;\n  --tracking-label: 0.1em;\n}\n.btn:focus-visible { outline: 2px solid var(--color-accent); }',
      'components/Label.tsx': [
        'export function Label() {',
        '  return <span className="text-label tracking-label">Field kit</span>;',
        '}',
        'export function Band() {',
        '  return <div aria-hidden="true" className="h-2 bg-linear-to-r from-accent to-sky-500" />;',
        '}',
      ].join('\n'),
    });
    const result = await lint([dir], { cwd: dir, warn: (l: string) => { throw new Error(l); } });
    expect(lines(result.findings, 'wide-tracking')).toEqual([2]);
    expect(only(result.findings, 'wide-tracking')[0].evidence).toContain('letter-spaced at 12px tracked 0.1em');
    expect(lines(result.findings, 'purple-blue-gradient')).toEqual([5]);
    expect(only(result.findings, 'purple-blue-gradient')[0].evidence).toContain('purple-to-blue gradient (from-accent to-sky-500)');
  });
});

describe('design-lint tailwind: motion rules', () => {
  test('layout-transition: transition-all and a transition naming a layout property block; transition-colors does not', async () => {
    const f = await lintFiles({ 'index.html': page([
      '<a href="/a" class="rounded-md px-3 transition-colors">Fine</a>',
      '<a href="/b" class="rounded-md px-3 transition-all">Everything</a>',
      '<div class="transition-[width,height]">Grows</div>',
    ]) });
    expect(only(f, 'layout-transition').map((x) => [x.line, x.grade])).toEqual([[BODY + 1, 'blocks'], [BODY + 2, 'blocks']]);
    expect(only(f, 'layout-transition')[0].evidence).toBe('transition-all on <a class="rounded-md px-3 transition-all">');
  });

  test('bounce-easing: animate-bounce and an overshooting cubic-bezier ask; animate-pulse does not', async () => {
    const f = await lintFiles({ 'index.html': page([
      '<div aria-hidden="true" class="h-2 w-2 animate-pulse"></div>',
      '<div aria-hidden="true" class="h-2 w-2 animate-bounce"></div>',
      '<button type="button" class="px-3 transition-transform ease-[cubic-bezier(0.34,1.56,0.64,1)]">Go</button>',
    ]) });
    expect(only(f, 'bounce-easing').map((x) => [x.line, x.grade])).toEqual([[BODY + 1, 'ask'], [BODY + 2, 'ask']]);
    expect(only(f, 'bounce-easing')[1].evidence).toContain('overshoot easing ease-[cubic-bezier(0.34,1.56,0.64,1)]');
  });

  test('hover-tells: an image that scales on hover, or hover scale on three elements in one file; a colour change does not', async () => {
    const clean = await lintFiles({ 'index.html': page([
      '<a href="/a" class="px-3 hover:bg-accent">One</a>',
      '<div class="p-4 hover:scale-105">A</div><div class="p-4 hover:scale-105">B</div>',
      '<img src="a.jpg" alt="The harbour" class="rounded-lg hover:opacity-90">',
    ]) });
    expect(mine(clean)).toEqual([]);
    const f = await lintFiles({ 'index.html': page([
      '<img src="a.jpg" alt="The harbour" class="rounded-lg hover:rotate-2">',
      '<div class="p-4 hover:scale-105">A</div>',
      '<div class="p-4 hover:scale-105">B</div>',
      '<div class="p-4 hover:scale-105">C</div>',
    ]) });
    expect(only(f, 'hover-tells').map((x) => [x.line, x.grade, x.evidence])).toEqual([
      [BODY, 'ask', 'hover:rotate-2 on <img class="rounded-lg hover:rotate-2">: the image moves on hover'],
      [BODY + 3, 'ask', 'hover scale on 3 elements in this file (hover:scale-105, hover:scale-105, hover:scale-105)'],
    ]);
  });
});

describe('design-lint tailwind: colour and surface rules', () => {
  test('purple-blue-gradient: purple-to-blue and purple-to-pink palette ramps block, as does cyan on a dark paper; an amber ramp does not', async () => {
    const dark = '<style>:root { --color-paper: oklch(18% 0.02 270); }</style>';
    const f = await lintFiles({ 'index.html': page([
      '<div aria-hidden="true" class="h-2 bg-gradient-to-r from-amber-400 to-orange-600"></div>',
      '<div aria-hidden="true" class="h-2 bg-gradient-to-r from-purple-500 to-blue-500"></div>',
      '<div aria-hidden="true" class="h-2 bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500"></div>',
      '<div aria-hidden="true" class="h-2 bg-gradient-to-r from-cyan-400 to-cyan-600"></div>',
    ], dark) });
    expect(only(f, 'purple-blue-gradient').map((x) => [x.line, x.grade])).toEqual([[BODY + 1, 'blocks'], [BODY + 2, 'blocks'], [BODY + 3, 'blocks']]);
    expect(only(f, 'purple-blue-gradient').map((x) => x.evidence.split(' gradient')[0])).toEqual(['purple-to-blue', 'purple-to-pink', 'cyan-on-dark']);
  });

  test('gradient-text: a ramp clipped to transparent text asks; solid ink and a banned ramp (reported as the gradient) do not', async () => {
    const f = await lintFiles({ 'index.html': page([
      '<h1 class="text-5xl text-ink">Logbooks your crew will keep</h1>',
      '<h1 class="text-5xl"><span class="bg-gradient-to-r from-amber-400 to-orange-600 bg-clip-text text-transparent">Field notes</span></h1>',
      '<h2 class="text-3xl bg-gradient-to-r from-purple-500 to-blue-500 bg-clip-text text-transparent">Banned</h2>',
    ]) });
    expect(only(f, 'gradient-text').map((x) => [x.line, x.grade])).toEqual([[BODY + 1, 'ask']]);
    expect(only(f, 'gradient-text')[0].evidence).toBe('gradient text (from-amber-400 to-orange-600) on <span class="bg-gradient-to-r from-amber-400…">');
    expect(only(f, 'purple-blue-gradient')[0].evidence).toContain('purple-to-blue gradient text');
  });

  test('glow-wash: glass (backdrop blur over a translucent fill), a blurred filled orb and a zero-offset coloured shadow ask; an offset grey shadow does not', async () => {
    const f = await lintFiles({ 'index.html': page([
      '<div class="rounded-lg shadow-lg">Card</div>',
      '<div class="rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.2)]">Card</div>',
      '<nav class="sticky top-0 bg-white/10 backdrop-blur-md px-6">Nav</nav>',
      '<div aria-hidden="true" class="absolute h-72 w-72 rounded-full bg-fuchsia-500 blur-3xl"></div>',
      '<button type="button" class="px-4 shadow-[0_0_40px_oklch(62%_0.25_300)]">Preview</button>',
      '<button type="button" class="px-4 shadow-[0_0_24px] shadow-violet-500">Glow by class</button>',
    ]) });
    expect(only(f, 'glow-wash').map((x) => [x.line, x.grade])).toEqual([[BODY + 2, 'ask'], [BODY + 3, 'ask'], [BODY + 4, 'ask'], [BODY + 5, 'ask']]);
    expect(only(f, 'glow-wash').map((x) => x.evidence.split(' on <')[0])).toEqual([
      'glass: backdrop-blur-md over bg-white/10',
      'blurred orb: blur-3xl on a filled absolute element',
      'glow: shadow-[0_0_40px_oklch(62%_0.25_300)]',
      'glow: shadow-[0_0_24px] with shadow-violet-500',
    ]);
  });

  test('literal-outside-tokens: a hex colour or a font family in a class blocks, an oklch literal lands at ask for a person to confirm; var() and url() do not fire', async () => {
    const f = await lintFiles({ 'index.html': page([
      '<div class="bg-[var(--color-well)] bg-[url(/paper.png)] font-[family-name:var(--font-display)]">Fine</div>',
      '<p class="bg-[#0b0b12] p-4">Hex</p>',
      '<p class="bg-[oklch(62%_0.25_300)] p-4">Oklch</p>',
      "<p class=\"font-['Inter'] p-4\">Family</p>",
    ]) });
    const byLine = only(f, 'literal-outside-tokens').sort((a, b) => a.line - b.line);
    expect(byLine.map((x) => [x.line, x.grade])).toEqual([[BODY + 1, 'blocks'], [BODY + 2, 'ask'], [BODY + 3, 'blocks']]);
    expect(byLine[2].evidence).toBe("font-family literal font-['Inter'] in a class on <p class=\"font-['Inter'] p-4\">");
  });

  test('framework-palette: five distinct palette classes in one file ask; four do not', async () => {
    const four = await lintFiles({ 'index.html': page(['<section class="bg-slate-950 text-slate-100 border-slate-800"><a href="/x" class="text-sky-400">Go</a></section>']) });
    expect(only(four, 'framework-palette')).toEqual([]);
    const f = await lintFiles({ 'index.html': page([
      '<section class="bg-slate-950 text-slate-100 border-slate-800">',
      '<a href="/x" class="text-sky-400 ring-indigo-500/50">Go</a>',
      '</section>',
    ]) });
    expect(only(f, 'framework-palette').map((x) => [x.line, x.grade])).toEqual([[BODY + 1, 'ask']]);
    expect(only(f, 'framework-palette')[0].evidence).toStartWith("a framework default palette instead of the page's tokens: 5 distinct palette classes (bg-slate-950 text-slate-100");
  });
});

describe('design-lint tailwind: type rules', () => {
  test('wide-tracking: small uppercase or tracked text blocks; a display head, a logo and a tracked line at 16px without caps do not', async () => {
    const f = await lintFiles({ 'index.html': page([
      '<h1 class="text-5xl uppercase tracking-tight">Field notes</h1>',
      '<a href="/" aria-label="Fieldnote logo" class="text-xs uppercase tracking-widest">FN</a>',
      '<p class="text-base tracking-wide">Sixteen pixels, lightly tracked</p>',
      '<span class="text-xs uppercase tracking-widest">Field kit</span>',
      '<div class="text-sm"><small class="uppercase">Inherited size</small></div>',
      '<p class="text-[11px] [font-variant-caps:small-caps]">Small caps label</p>',
    ]) });
    expect(only(f, 'wide-tracking').map((x) => [x.line, x.grade])).toEqual([[BODY + 3, 'blocks'], [BODY + 4, 'blocks'], [BODY + 5, 'blocks']]);
    expect(only(f, 'wide-tracking').map((x) => x.evidence)).toEqual([
      '"Field kit" uppercase at 12px tracked 0.1em on <span class="text-xs uppercase tracking-wide…">',
      '"Inherited size" uppercase at 14px on <small class="uppercase">',
      '"Small caps label" small caps at 11px on <p class="text-[11px] [font-variant-caps:…">',
    ]);
  });

  test('kicker-above-heading: a small uppercase, tracked or accent line right before an h1-h3 asks; a plain lede, a dated line and a component scope do not', async () => {
    const body = [
      '<section>',
      '<p class="text-sm text-muted">A plain line above the head</p>',
      '<h2 class="text-3xl">One log per watch</h2>',
      '<p class="text-sm uppercase">Features</p>',
      '<h2 class="text-3xl">What the crew gets</h2>',
      '<p class="text-sm text-indigo-600">Fewer handoffs</p>',
      '<h3 class="text-xl">Tide tables</h3>',
      '<p class="text-sm uppercase"><time datetime="2026-10-04">4 October</time></p>',
      '<h2 class="text-3xl">Dated, so not an eyebrow</h2>',
      '</section>',
    ];
    const f = await lintFiles({ 'index.html': page(body) });
    expect(only(f, 'kicker-above-heading').map((x) => [x.line, x.grade])).toEqual([[BODY + 3, 'ask'], [BODY + 5, 'ask']]);
    expect(only(f, 'kicker-above-heading').map((x) => x.evidence)).toEqual([
      'the eyebrow "Features" before <h2>',
      'eyebrow "Fewer handoffs" before <h3> (text-indigo-600 at 14px)',
    ]);
    expect(only(await lintFiles({ 'index.html': page(body) }, { scope: 'component' }), 'kicker-above-heading')).toEqual([]);
  });

  test('monospace-costume: font-mono on a small prose label asks; code, data text, a large line and a page whose body face is mono do not', async () => {
    const f = await lintFiles({ 'index.html': page([
      '<code class="font-mono text-xs">bun run lint</code>',
      '<p class="font-mono text-xs">v1.2.3</p>',
      '<p class="font-mono text-base">Sixteen pixels is not a label</p>',
      '<p class="font-mono text-xs">Updated weekly by the crew</p>',
    ]) });
    expect(only(f, 'monospace-costume').map((x) => [x.line, x.grade])).toEqual([[BODY + 3, 'ask']]);
    expect(only(f, 'monospace-costume')[0].evidence).toBe('font-mono on "Updated weekly by the c…" at 12px (<p class="font-mono text-xs">)');
    const material = await lintFiles({ 'index.html': page(['<p class="font-mono text-xs">Updated weekly by the crew</p>'], '<style>:root { --font-body: "JetBrains Mono", monospace; }</style>') });
    expect(only(material, 'monospace-costume')).toEqual([]);
  });
});

describe('design-lint tailwind: structure rules', () => {
  test('vh-height: min-h-screen on the first section or a hero blocks; min-h-dvh and a screen-tall inner panel do not', async () => {
    const clean = await lintFiles({ 'index.html': page([
      '<section class="min-h-dvh px-6">Hero</section>',
      '<section class="px-6"><div class="h-screen overflow-auto">A tall panel, not the hero</div></section>',
    ]) });
    expect(only(clean, 'vh-height')).toEqual([]);
    const f = await lintFiles({ 'index.html': page([
      '<section class="relative min-h-screen px-6">Hero</section>',
      '<div class="hero min-h-[100vh]">Also the hero</div>',
    ]) });
    expect(only(f, 'vh-height').map((x) => [x.line, x.grade, x.evidence])).toEqual([
      [BODY, 'blocks', 'hero sized in vh: min-h-screen on <section class="relative min-h-screen px-6">'],
      [BODY + 1, 'blocks', 'hero sized in vh: min-h-[100vh] on <div class="hero min-h-[100vh]">'],
    ]);
  });

  test('template-cards: three grid children opening on an icon in a rounded filled tile above an h3 ask; tiles with inline icons do not', async () => {
    const tile = (icon: string) => `<div class="rounded-xl p-6">${icon}<h3 class="mt-4 font-semibold">Tide tables</h3><p class="mt-2">Every reading on one chart.</p></div>`;
    const coin = '<div class="flex h-10 w-10 rounded-lg bg-indigo-600"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 12h16"/></svg></div>';
    const inline = '<svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5"><path d="M4 12h16"/></svg>';
    const clean = await lintFiles({ 'index.html': page([`<div class="grid md:grid-cols-3">${tile(inline)}${tile(inline)}${tile(inline)}</div>`]) });
    expect(only(clean, 'template-cards')).toEqual([]);
    const f = await lintFiles({ 'index.html': page(['<h2>What the crew gets</h2>', `<div class="grid gap-8 md:grid-cols-3">${tile(coin)}${tile(coin)}${tile(coin)}</div>`]) });
    expect(only(f, 'template-cards').map((x) => [x.line, x.grade])).toEqual([[BODY + 1, 'ask']]);
    expect(only(f, 'template-cards')[0].evidence).toStartWith('icon-tile row: 3 children of <div class="grid gap-8 md:grid-cols-3"> open on an icon in a rounded filled tile');
  });
});

describe('design-lint tailwind: component text', () => {
  const tsx = (jsx: string[]) => ['import { Link, Badge, Meta } from "./ui";', 'export function Page() {', '  return (', '    <section>', ...jsx.map((l) => '      ' + l), '    </section>', '  );', '}'].join('\n');
  const JSX = 5;

  test('template-punctuation: an arrow glued to a link label and a middle-dot meta string in a component block; a verb label and one dot do not', async () => {
    const clean = await lintFiles({ 'package.json': '{}', 'Page.tsx': tsx(['<Link href="/docs">Read the docs</Link>', '<Meta>3 min read · Design</Meta>']) });
    expect(only(clean, 'template-punctuation')).toEqual([]);
    const f = await lintFiles({ 'package.json': '{}', 'Page.tsx': tsx(['<Link href="/docs">Read more →</Link>', '<Meta>3 min · Oct 4 · Design</Meta>']) });
    expect(only(f, 'template-punctuation').map((x) => [x.line, x.grade, x.evidence])).toEqual([
      [JSX, 'blocks', 'arrow glued to the label "Read more →" (<Link>)'],
      [JSX + 1, 'blocks', 'middle-dot meta string "3 min · Oct 4 · Design"'],
    ]);
  });

  test('emoji-decoration: an emoji alone inside a component blocks; a word does not', async () => {
    const clean = await lintFiles({ 'package.json': '{}', 'Page.tsx': tsx(['<Badge>New</Badge>']) });
    expect(only(clean, 'emoji-decoration')).toEqual([]);
    const f = await lintFiles({ 'package.json': '{}', 'Page.tsx': tsx(['<Badge>✨</Badge>']) });
    expect(only(f, 'emoji-decoration').map((x) => [x.line, x.grade, x.evidence])).toEqual([[JSX, 'blocks', 'emoji icon "✨" in <Badge>']]);
  });

  test('component files: cn()/clsx()/cva() in a .tsx, :class in a .vue and class:list in an .astro are read for the same tells', async () => {
    const f = await lintFiles({
      'package.json': '{}',
      'Hero.tsx': [
        'import { cva } from "cva";',
        'import { cn } from "./cn";',
        'const badge = cva("rounded-full px-2 text-xs uppercase tracking-widest", { variants: { tone: { loud: "font-semibold" } } });',
        'export function Hero({ on }: { on: boolean }) {',
        '  return <a href="/x" className={cn("rounded-md px-3", on && "transition-all")}>Go</a>;',
        '}',
      ].join('\n'),
      'Feature.vue': '<template>\n  <div aria-hidden="true" :class="{ \'animate-bounce\': pulse }" class="h-4 w-4"></div>\n</template>',
      'Band.astro': '---\nconst on = true;\n---\n<div aria-hidden="true" class:list={["h-2 bg-gradient-to-r", on && "from-purple-500 to-blue-500"]}></div>',
    });
    expect(only(f, 'wide-tracking').map((x) => [path.basename(x.file), x.line, x.evidence])).toEqual([['Hero.tsx', 3, 'uppercase at 12px tracked 0.1em on cva() class string']]);
    expect(only(f, 'layout-transition').map((x) => [path.basename(x.file), x.line])).toEqual([['Hero.tsx', 5]]);
    expect(only(f, 'bounce-easing').map((x) => [path.basename(x.file), x.line])).toEqual([['Feature.vue', 2]]);
    expect(only(f, 'purple-blue-gradient').map((x) => [path.basename(x.file), x.line])).toEqual([['Band.astro', 4]]);
  });
});

describe('design-lint tailwind: fixtures', () => {
  test('tailwind-fail: every utility tell planted in the fixture is found at its line', async () => {
    const result = await lint([path.join(FIXTURES, 'tailwind-fail')], { cwd: ROOT, warn: (l: string) => { throw new Error(l); } });
    const got = result.findings.filter((f) => MY_RULES.includes(f.rule)).map((f) => `${f.grade} ${f.rule} ${path.basename(f.file)}:${f.line}`).sort();
    expect(got).toEqual([
      'ask bounce-easing Feature.vue:7', 'ask bounce-easing Hero.tsx:29', 'ask bounce-easing index.html:39',
      'ask framework-palette Hero.tsx:22', 'ask framework-palette index.html:30',
      'ask glow-wash Feature.vue:8', 'ask glow-wash index.html:16', 'ask glow-wash index.html:25', 'ask glow-wash index.html:37',
      'ask gradient-text index.html:30',
      'ask hover-tells Feature.vue:5', 'ask hover-tells index.html:59', 'ask hover-tells index.html:69',
      'ask kicker-above-heading Hero.tsx:17', 'ask kicker-above-heading index.html:27',
      'ask monospace-costume Hero.tsx:21', 'ask monospace-costume index.html:33',
      'ask template-cards index.html:48',
      'blocks layout-transition Feature.vue:6', 'blocks layout-transition Hero.tsx:22', 'blocks layout-transition index.html:35',
      'blocks literal-outside-tokens Hero.tsx:26', 'blocks literal-outside-tokens index.html:71',
      'blocks purple-blue-gradient Feature.vue:8', 'blocks purple-blue-gradient Hero.tsx:18', 'blocks purple-blue-gradient index.html:43',
      'blocks vh-height Hero.tsx:16', 'blocks vh-height index.html:23',
      'blocks wide-tracking Feature.vue:4', 'blocks wide-tracking Hero.tsx:6', 'blocks wide-tracking index.html:19',
    ].sort());
  });

  test('tailwind-pass and the clean page raise nothing from the component family', async () => {
    for (const fixture of ['tailwind-pass', 'clean']) {
      const result = await lint([path.join(FIXTURES, fixture)], { cwd: ROOT, warn: (l: string) => { throw new Error(l); } });
      expect(mine(result.findings)).toEqual([]);
    }
  });
});

describe('design-lint tailwind: one gradient classifier for both tiers (third review cycle)', () => {
  test('arbitrary indigo-to-violet stops report the same purple-blue-gradient the stylesheet form does', async () => {
    const tw = await lintFiles({ 'A.tsx': 'export const A = () => <div className="bg-gradient-to-r from-[#6366f1] to-[#8b5cf6] p-4">hello there</div>;' });
    expect(only(tw, 'purple-blue-gradient').map((f) => [f.grade, f.evidence])).toEqual([['blocks', expect.stringContaining('indigo-to-violet')]]);
    const css = await lintFiles({ 'a.css': '.g { background: linear-gradient(90deg, #6366f1, #8b5cf6); }' });
    expect(only(css, 'purple-blue-gradient').map((f) => [f.grade, f.evidence])).toEqual([['blocks', expect.stringContaining('indigo-to-violet')]]);
  });
});
