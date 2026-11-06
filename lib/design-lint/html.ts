/**
 * Markup reading for the design lint. A tag scanner over HTML (no DOM
 * dependency) that keeps source positions, so every finding has a file:line;
 * component files (.jsx .tsx .vue .svelte .astro) are first turned into
 * pseudo-HTML: JSX by a small scanner that keeps elements and class
 * attributes and blanks expressions, templates by masking frontmatter,
 * braces and attribute expressions. Class-name helper calls (cn, clsx, cva …)
 * are collected separately so Tailwind rules can read them.
 *
 * Ported from Nutlope/hallmark's sloplint.mjs (parseHtml, jsxPseudo,
 * templateMask, clsLits, classCalls; MIT, see NOTICE.md).
 */
import * as path from 'node:path';
import { lineIndex } from './css';

export type DocKind = 'html' | 'jsx' | 'vue' | 'svelte' | 'astro';

export interface Tag { close: boolean; name: string; attrs: string; pos: number; end: number; selfClosing: boolean; line: number }

/** A string as a literal inside a RegExp source. */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface StyleBlock { css: string; lineOffset: number }

export interface ClassCall { pos: number; name: string; toks: string[] }

export interface Doc {
  file: string;
  kind: DocKind;
  /** The text the tags were scanned from: the HTML, or the pseudo-HTML of a component, with comments blanked and every `<` that starts no tag (a tag start with no `>`, `<1`, `a < b`; a `<!` or `<?` declaration with a `>` ahead stays) spaced out, positions kept, so no rule reads markup the browser never renders and no `[^>]*>` scan over it runs past its tag. */
  src: string;
  /** The original file text. */
  raw: string;
  /** src with comments, scripts and styles blanked (positions preserved). */
  masked: string;
  styles: StyleBlock[];
  scripts: string;
  tags: Tag[];
  /** Non-HTML (component) tags in a component file. */
  comps: Tag[];
  /** Visible text with entities decoded and whitespace folded. */
  text: string;
  lineOf: (pos: number) => number;
  /** JSX only: class tokens by element start position. */
  classAt: Map<number, string[]>;
  /** Class-name helper calls (cn, clsx, cva …) found in scripts. */
  virtuals: ClassCall[];
  /** Per-doc caches for the rules. */
  cache: Record<string, unknown>;
}

export const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
export const HTML_NAMES = new Set(('a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup svg table tbody td template textarea tfoot th thead time title tr track u ul var video wbr').split(' '));

const pad = (t: string) => t.replace(/[^\n]/g, ' ');
const VISIBLE = /\S/g;

/** s lower-cased letter by letter (ASCII only, so every position still lines up with s). */
const asciiLower = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/** A span found by spansOf: the whole match and, for an element, the body between its open and close tags. */
interface Span { start: number; bodyStart: number; bodyEnd: number; end: number }

/**
 * Every `open … close` span of lower in one linear pass, so a file of
 * unclosed openers costs its length and not its square. An unclosed comment
 * runs to the end of the file, as a browser reads it; an element opener with
 * no closer after it is left alone, as a tag. For an element, open is
 * `<name`, which must end the name, and the span runs from that open tag
 * through `</name>` (spaces before the `>` allowed).
 */
function spansOf(lower: string, open: string, close: string, element: boolean): Span[] {
  const out: Span[] = [];
  let i = 0;
  for (;;) {
    const start = lower.indexOf(open, i);
    if (start < 0) break;
    const after = start + open.length;
    if (!element) {
      const c = lower.indexOf(close, after);
      if (c < 0) { out.push({ start, bodyStart: after, bodyEnd: lower.length, end: lower.length }); break; }
      out.push({ start, bodyStart: after, bodyEnd: c, end: c + close.length });
      i = c + close.length;
      continue;
    }
    if (/[\w-]/.test(lower[after] || '')) { i = after; continue; }
    const gt = lower.indexOf('>', after);
    if (gt < 0) break;
    let c = lower.indexOf(close, gt + 1), end = -1;
    while (c >= 0) {
      let k = c + close.length;
      while (k < lower.length && /\s/.test(lower[k])) k++;
      if (lower[k] === '>') { end = k + 1; break; }
      c = lower.indexOf(close, c + 1);
    }
    if (end < 0) break;
    out.push({ start, bodyStart: gt + 1, bodyEnd: c, end });
    i = end;
  }
  return out;
}

/** s with each [a, b) range padded to spaces (positions kept) or, with cut set, replaced by one space. */
function blankRanges(s: string, ranges: Array<[number, number]>, cut = false): string {
  if (!ranges.length) return s;
  let out = '', at = 0;
  for (const [a, b] of ranges) if (a >= at) { out += s.slice(at, a) + (cut ? ' ' : pad(s.slice(a, b))); at = b; }
  return out + s.slice(at);
}

/** s with every `<…>` run replaced by one space (or padded to spaces with keep set), in one linear pass; a `<` with no `>` after it is text. With a limit, the read stops once more than that many non-space characters are out, so a caller that only needs to know whether the text is short does not pay for an element that runs to the end of the file; a long whitespace run (a comment blanked to spaces) is skipped natively, so it costs its length once and the read still agrees with the unlimited one. */
export function stripTags(s: string, keep = false, limit = Infinity): string {
  let out = '', i = 0, seen = 0;
  for (;;) {
    if (limit < Infinity) for (let k = i, c = 0; k < s.length && s[k] !== '<'; k++) {
      if ((c = s.charCodeAt(k)) > 32 && (c < 128 || !/\s/.test(s[k])) && ++seen > limit) return out + s.slice(i, k + (c >= 0xd800 && c < 0xdc00 ? 2 : 1));
      if (k - i > 64 * limit + 4096) { VISIBLE.lastIndex = k + 1; const hit = VISIBLE.exec(s); if (!hit) return out + s.slice(i); k = hit.index - 1; }
    }
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) break;
    out += s.slice(i, lt) + (keep ? pad(s.slice(lt, gt + 1)) : ' ');
    i = gt + 1;
  }
  return out + s.slice(i);
}

/** Unquoted attribute text longer than this cannot be a tag; the scan gives the `<` up instead of reading on to the end of the file. */
const MAX_UNQUOTED_ATTRS = 8192;

/**
 * Every tag in s, in document order and in one linear pass: `<name attrs>` and
 * `</name>`, with quoted attribute values skipped whole. A `<` that never
 * reaches a `>`, or a quote that never closes, is text; a `<` that opens a
 * tag inside unquoted attribute text starts the next tag instead, as a
 * browser reads `<a <b>`. Every `<` that starts no tag is a stray, except
 * a `<!` or `<?` (a doctype, a declaration) with some `>` after it.
 */
function scanTags(s: string, onTag: (close: boolean, name: string, attrs: string, pos: number, end: number) => void, strays?: number[]): void {
  const n = s.length;
  const noQuoteFrom: Record<string, number> = { '"': n, "'": n };
  let i = 0, nextGt = -1;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    let j = lt + 1;
    const close = s[j] === '/';
    if (close) j++;
    if (!/[a-zA-Z]/.test(s[j] || '')) {
      if (nextGt < lt) { const g = s.indexOf('>', lt); nextGt = g < 0 ? n : g; }
      if (!/[!?]/.test(s[j] || '') || nextGt >= n) strays?.push(lt);
      i = lt + 1;
      continue;
    }
    let k = j + 1;
    while (k < n && /[a-zA-Z0-9-]/.test(s[k])) k++;
    let p = k, unquoted = 0, next = lt + 1, gt = -1;
    while (p < n) {
      const c = s[p];
      if (c === '>') { gt = p; break; }
      if (c === '"' || c === "'") {
        if (p + 1 >= noQuoteFrom[c]) break;
        const q = s.indexOf(c, p + 1);
        if (q < 0) { noQuoteFrom[c] = p + 1; break; }
        p = q + 1;
        continue;
      }
      if (c === '<' && /[a-zA-Z/]/.test(s[p + 1] || '')) { next = p; break; }
      if (++unquoted > MAX_UNQUOTED_ATTRS) break;
      p++;
    }
    if (gt < 0) { strays?.push(lt); i = next; continue; }
    onTag(close, s.slice(j, k), s.slice(k, gt), lt, gt + 1);
    i = gt + 1;
  }
}

/** The text with each stray `<` replaced by a space, so every `<` left starts a tag with its own `>`, a `<[^>]*>` regex over it costs its length, and a page whose tail is ten thousand unclosed `<img ` or `<1` costs its length. */
function blankStrays(s: string, strays: number[]): string {
  let out = '', from = 0;
  for (const i of strays) { out += s.slice(from, i) + ' '; from = i + 1; }
  return out + s.slice(from);
}

export function parseHtml(file: string, src: string, kind: DocKind = 'html'): Doc {
  const lineOf = lineIndex(src);
  const comments = spansOf(asciiLower(src), '<!--', '-->', false).map((s): [number, number] => [s.start, s.end]);
  const live = blankRanges(src, comments);
  const lower = asciiLower(live);
  const scriptSpans = spansOf(lower, '<script', '</script', true);
  const styleSpans = spansOf(lower, '<style', '</style', true);
  const styles: StyleBlock[] = styleSpans.map((s) => ({ css: live.slice(s.bodyStart, s.bodyEnd), lineOffset: lineOf(s.start) - 1 }));
  const scripts = scriptSpans.map((s) => live.slice(s.bodyStart, s.bodyEnd) + '\n').join('');
  const bodies = [...scriptSpans, ...styleSpans].map((s): [number, number] => [s.bodyStart, s.bodyEnd]).sort((a, b) => a[0] - b[0]);
  const strays: number[] = [];
  const tags: Tag[] = [];
  const comps: Tag[] = [];
  scanTags(blankRanges(live, bodies), (close, rawName, attrs, pos, end) => {
    if (kind !== 'html' && !HTML_NAMES.has(rawName)) {
      comps.push({ close, name: rawName, attrs, pos, end, selfClosing: /\/\s*$/.test(attrs), line: lineOf(pos) });
      return;
    }
    const name = rawName.toLowerCase();
    tags.push({ close, name, attrs, pos, end, selfClosing: /\/\s*$/.test(attrs) || VOID_TAGS.has(name), line: lineOf(pos) });
  }, strays);
  const src2 = blankStrays(live, strays);
  const masked = blankRanges(src2, bodies);
  const whole = [...scriptSpans, ...styleSpans].map((s): [number, number] => [s.start, s.end]).sort((a, b) => a[0] - b[0]);
  const text = stripTags(blankRanges(src2, whole, true))
    .replace(/&quot;|&#0?34;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&hellip;|&#8230;/g, '\u2026').replace(/&mdash;|&#8212;|&#x2014;/gi, '\u2014').replace(/&ndash;|&#8211;|&#x2013;/gi, '\u2013')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ');
  return { file, kind, src: src2, raw: src, masked, styles, scripts, tags, comps, text, lineOf, classAt: new Map(), virtuals: [], cache: {} };
}

/** The index of the brace that closes the one at j (strings skipped), or the string's length. */
export function braceEnd(s: string, j: number): number {
  let depth = 0;
  for (let i = j; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < s.length && s[i] !== c) { if (s[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return s.length;
}

export const FRONTMATTER = /^\s*---[^\n]*\n[\s\S]*?\n---/;

/** Blank Astro frontmatter, brace expressions in attributes (Svelte, Astro) and angle brackets inside attribute strings, keeping positions. */
export function templateMask(src: string, kind: DocKind): string {
  const n = src.length;
  let out: string[] | null = null;
  const put = (k: number, ch: string) => { if (!out) out = src.split(''); out[k] = ch; };
  const blank = (a: number, b: number) => { for (let k = a; k < b; k++) if (src[k] !== '\n' && src[k] !== ' ') put(k, ' '); };
  const lower = src.toLowerCase();
  const braces = kind === 'svelte' || kind === 'astro';
  let i = 0;
  if (kind === 'astro') {
    const fm = FRONTMATTER.exec(src);
    if (fm) { blank(0, fm[0].length); i = fm[0].length; }
  }
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (!/[A-Za-z]/.test(src[lt + 1] || '')) { i = lt + 1; continue; }
    let j = lt + 1;
    while (j < n && /[\w:.-]/.test(src[j])) j++;
    const name = lower.slice(lt + 1, j);
    while (j < n && src[j] !== '>') {
      const c = src[j];
      if (c === '"' || c === "'") {
        let e = src.indexOf(c, j + 1);
        if (e < 0) e = n;
        for (let k = j + 1; k < e; k++) if (src[k] === '<' || src[k] === '>') put(k, ' ');
        j = e + 1;
        continue;
      }
      if (c === '{' && braces) { const e = braceEnd(src, j); blank(j + 1, e); j = e + 1; continue; }
      j++;
    }
    i = j + 1;
    if (name === 'script' || name === 'style' || name === 'textarea') {
      const e = lower.indexOf('</' + name, i);
      i = e < 0 ? n : e;
    }
  }
  return out ? (out as string[]).join('') : src;
}

const cutGlued = (seg: string, after: boolean, before: boolean): string => {
  let s = seg;
  if (after) s = s.replace(/^\S+/, '');
  if (before) s = s.replace(/\S+$/, '');
  return s;
};

/** Every string literal's class tokens inside a JS expression, template literals included (${} parts recursed, glued halves dropped). */
export function clsLits(s: string, level = 0): string[] {
  if (level > 20) return [];
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c && s[j] !== '\n') { if (s[j] === '\\') j++; j++; }
      parts.push(s.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1, seg = '', after = false;
      while (j < s.length && s[j] !== '`') {
        if (s[j] === '\\') { seg += s[j + 1] || ''; j += 2; continue; }
        if (s[j] === '$' && s[j + 1] === '{') {
          parts.push(cutGlued(seg, after, true));
          const e = braceEnd(s, j + 1);
          parts.push(clsLits(s.slice(j + 2, e), level + 1).join(' '));
          j = e + 1; seg = ''; after = true;
          continue;
        }
        seg += s[j]; j++;
      }
      parts.push(cutGlued(seg, after, false));
      i = j + 1;
      continue;
    }
    i++;
  }
  return parts.join(' ').split(/\s+/).filter(Boolean);
}

const JS_EXPR_KW = new Set(['return', 'yield', 'await', 'case', 'default', 'else', 'do', 'throw', 'typeof', 'void', 'delete', 'in', 'of', 'new', 'instanceof']);
export const CLASS_FNS = new Set(['cn', 'clsx', 'classNames', 'classnames', 'twMerge', 'twJoin', 'cva', 'cx', 'tv']);
const CLASS_FN_CALL = new RegExp(`(?<![\\w$.])(?:${[...CLASS_FNS].join('|')})\\s*\\(`, 'g');

/** Failed element starts a component file may spend before the scanner stops pairing; jsScan carries the same budget. */
const MAX_FAILED_TAGS = 500;
/** An element whose content ran to the end of the file without any closer: no ancestor can close either, so each fails at once instead of rescanning the same text. */
const JSX_EOF = -2;

/**
 * Turn a JSX/TSX module into pseudo-HTML of the same length: elements and
 * their class attributes survive (an expression-valued className becomes the
 * literals it holds), everything else becomes spaces. Also records where
 * class-helper calls start. A close tag naming an open ancestor closes every
 * element under it, as a browser would; one naming nothing open is text.
 */
class JsxScanner {
  private readonly n: number;
  private readonly out: string[];
  readonly classes: Array<[number, string[]]> = [];
  readonly calls: number[] = [];
  private hi = 0;
  private fails = 0;
  private inClass = 0;
  private depth = 0;
  private readonly open: string[] = [];

  constructor(private readonly src: string) {
    this.n = src.length;
    this.out = new Array(this.n);
    for (let k = 0; k < this.n; k++) this.out[k] = src[k] === '\n' ? '\n' : ' ';
  }

  pseudo(): string { this.js(0, false); return this.out.join(''); }

  private blank(a: number, b: number): void { for (let k = a; k < b && k < this.n; k++) this.out[k] = this.src[k] === '\n' ? '\n' : ' '; }
  private paint(a: number, b: number): void { for (let k = a; k < b && k < this.n; k++) this.out[k] = this.src[k]; if (b > this.hi) this.hi = b; }
  private write(a: number, b: number, text: string): void {
    this.blank(a, b);
    let k = a;
    for (const ch of text) { while (k < b && this.src[k] === '\n') k++; if (k >= b) break; this.out[k++] = ch; }
    if (b > this.hi) this.hi = b;
  }
  private ws(i: number): number { while (i < this.n && /\s/.test(this.src[i])) i++; return i; }
  private gap(i: number): number {
    const { src, n } = this;
    for (;;) {
      i = this.ws(i);
      if (src[i] === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) return n; i = e + 2; continue; }
      if (src[i] === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); if (e < 0) return n; i = e; continue; }
      return i;
    }
  }
  private strEnd(i: number): number {
    const { src, n } = this;
    const q = src[i];
    let j = i + 1;
    while (j < n && src[j] !== q && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
    return Math.min(j + 1, n);
  }
  private tplEnd(i: number): number {
    const { src, n } = this;
    let j = i + 1;
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') { j = this.js(j + 2, true) + 1; continue; }
      j++;
    }
    return Math.min(j + 1, n);
  }
  private reEnd(i: number): number {
    const { src, n } = this;
    let j = i + 1, set = false;
    while (j < n && src[j] !== '\n') {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '[') set = true;
      else if (c === ']') set = false;
      else if (c === '/' && !set) { j++; while (j < n && /[a-z]/i.test(src[j])) j++; return j; }
      j++;
    }
    return -1;
  }
  private js(i: number, stop: boolean): number {
    if (this.depth > 200) return stop ? Math.min(braceEnd(this.src, i - 1), this.n) : this.n;
    this.depth++;
    const r = this.jsScan(i, stop);
    this.depth--;
    return r;
  }
  private jsScan(i: number, stop: boolean): number {
    const { src, n } = this;
    let level = 0, val = false;
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === '"' || c === "'") { i = this.strEnd(i); val = true; continue; }
      if (c === '`') { i = this.tplEnd(i); val = true; continue; }
      if (c === '{') { level++; i++; val = false; continue; }
      if (c === '}') { if (stop && level === 0) return i; level--; i++; val = true; continue; }
      if (c === ')' || c === ']') { i++; val = true; continue; }
      if (c === '<' && !val && this.fails < MAX_FAILED_TAGS && /[A-Za-z_$>]/.test(src[i + 1] || '')) {
        const e = this.el(i);
        if (e > 0) { i = e; val = true; continue; }
        this.fails++;
      }
      if (c === '/' && !val) { const e = this.reEnd(i); if (e > 0) { i = e; val = true; continue; } }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i + 1;
        while (j < n && /[\w$]/.test(src[j])) j++;
        const w = src.slice(i, j);
        val = !JS_EXPR_KW.has(w);
        if (!this.inClass && CLASS_FNS.has(w) && src[i - 1] !== '.' && src[this.ws(j)] === '(') this.calls.push(i);
        i = j;
        continue;
      }
      if (c >= '0' && c <= '9') { let j = i + 1; while (j < n && /[\w.]/.test(src[j])) j++; i = j; val = true; continue; }
      i++;
      val = false;
    }
    return n;
  }
  /** Starts that did not open an element: a retry from the same start fails the same way, so a run of unclosed elements costs its length, not two to its depth. */
  private failed = new Set<number>();
  /** Past MAX_FAILED_TAGS failed starts (jsScan and el together) every later start is text, so a run of unclosed elements under the depth cap costs its length. */
  private el(start: number): number {
    if (this.depth > 200 || this.fails >= MAX_FAILED_TAGS || this.failed.has(start)) return -1;
    const mc = this.classes.length, mk = this.calls.length;
    this.depth++;
    const e = this.tag(start);
    this.depth--;
    if (e < 0) { this.failed.add(start); this.fails++; this.blank(start, Math.max(this.hi, start + 1)); this.hi = start; this.classes.length = mc; this.calls.length = mk; }
    return e;
  }
  /** One attribute from i; returns the index after it, or -1 when the tag is not JSX after all. */
  private attr(i: number, cls: { v: string[] | null }): number {
    const { src, n } = this;
    let k = i + 1;
    while (k < n && /[\w$:.-]/.test(src[k])) k++;
    const attr = src.slice(i, k);
    let v = this.ws(k);
    if (src[v] !== '=') { this.paint(i, k); return k; }
    v = this.ws(v + 1);
    const q = src[v];
    const isCls = attr === 'className' || attr === 'class';
    let e: number;
    if (q === '"' || q === "'") {
      e = src.indexOf(q, v + 1);
      if (e < 0) return -1;
      if (isCls) cls.v = (cls.v || []).concat(src.slice(v + 1, e).split(/\s+/).filter(Boolean));
      else this.paint(i, e + 1);
    } else if (q === '{') {
      if (isCls) this.inClass++;
      e = this.js(v + 1, true);
      if (isCls) this.inClass--;
      if (e >= n) return JSX_EOF;
      if (isCls) cls.v = (cls.v || []).concat(clsLits(src.slice(v + 1, e)));
      else { this.paint(i, v); this.write(v, e + 1, '"' + src.slice(v + 1, e).replace(/[^\w$.\-/:#@]+/g, ' ') + '"'); }
    } else if (q === '<') {
      e = this.el(v) - 1; if (e === JSX_EOF - 1) return JSX_EOF;
      if (e < 0) return -1;
      this.blank(i, e + 1);
    } else return -1;
    if (isCls && cls.v) this.write(i, e + 1, 'class="' + cls.v.join(' ').replace(/"/g, "'").replace(/[<>]/g, ' ') + '"');
    return e + 1;
  }
  private tag(start: number): number {
    const { src, n } = this;
    let i = start + 1;
    if (src[i] === '>') return this.kids(i + 1, '');
    let j = i;
    while (j < n && /[\w$.:-]/.test(src[j])) j++;
    const name = src.slice(i, j);
    this.paint(start, j);
    i = j;
    if (src[i] === '<') {
      let d = 0, k = i;
      do { if (src[k] === '<') d++; else if (src[k] === '>') d--; k++; } while (k < n && d > 0);
      if (d) return -1;
      this.blank(i, k); i = k;
    }
    const cls: { v: string[] | null } = { v: null };
    for (;;) {
      i = this.gap(i);
      if (i >= n) return -1;
      const c = src[i];
      if (c === '/' && src[i + 1] === '>') { this.paint(i, i + 2); if (cls.v) this.classes.push([start, cls.v]); return i + 2; }
      if (c === '>') { this.paint(i, i + 1); i++; break; }
      if (c === '{') { const e = this.js(i + 1, true); if (e >= n) return JSX_EOF; this.blank(i, e + 1); i = e + 1; continue; }
      if (!/[A-Za-z_$]/.test(c)) return -1;
      i = this.attr(i, cls);
      if (i < 0) return i;
    }
    if (cls.v) this.classes.push([start, cls.v]);
    this.open.push(name);
    const e = this.kids(i, name);
    this.open.pop();
    return e;
  }
  private kids(i: number, name: string): number {
    const { src, n } = this;
    while (i < n) {
      const c = src[i];
      if (c === '{') { const e = this.js(i + 1, true); if (e >= n) return JSX_EOF; i = e + 1; continue; }
      if (c === '<') {
        if (src[i + 1] === '/') {
          const k = this.ws(i + 2);
          let j = k;
          while (j < n && /[\w$.:-]/.test(src[j])) j++;
          const e = this.ws(j);
          if (src[e] !== '>') { i = e; continue; }
          const closer = src.slice(k, j);
          if (closer === name) { if (name) this.paint(i, e + 1); return e + 1; }
          if (this.open.lastIndexOf(closer) >= 0 && this.open.lastIndexOf(closer) < this.open.length - 1) return i;
          i = e + 1;
          continue;
        }
        if (/[A-Za-z_$>]/.test(src[i + 1] || '')) { const e = this.el(i); if (e > 0) { i = e; continue; } if (e === JSX_EOF) return JSX_EOF; }
        i++;
        continue;
      }
      this.out[i] = c;
      if (i >= this.hi) this.hi = i + 1;
      i++;
    }
    return JSX_EOF;
  }
}

export function jsxPseudo(src: string): { pseudo: string; classAt: Map<number, string[]>; calls: number[] } {
  const scanner = new JsxScanner(src);
  const pseudo = scanner.pseudo();
  return { pseudo, classAt: new Map(scanner.classes), calls: scanner.calls };
}

/** The class tokens inside each helper call (cn(...), clsx(...)) that starts at one of the sites. */
export function classCalls(src: string, sites: number[]): ClassCall[] {
  const out: ClassCall[] = [];
  let last = -1;
  for (const pos of [...sites].sort((a, b) => a - b)) {
    if (pos < last) continue;
    const open = src.indexOf('(', pos);
    if (open < 0) continue;
    let depth = 0, i = open;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
      if (c === '"' || c === "'" || c === '`') { i++; while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; } continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    last = i;
    const toks = clsLits(src.slice(open + 1, i));
    if (toks.length) out.push({ pos, name: /^[\w$]+/.exec(src.slice(pos))![0], toks });
  }
  return out;
}

/** Positions of class-helper calls inside <script> blocks (and Astro frontmatter). */
export function scriptSites(src: string, kind: DocKind): number[] {
  const live = blankRanges(src, spansOf(asciiLower(src), '<!--', '-->', false).map((s): [number, number] => [s.start, s.end]));
  const ranges = spansOf(asciiLower(live), '<script', '</script', true).map((s): [number, number] => [s.bodyStart, s.bodyEnd]);
  const fm = kind === 'astro' ? FRONTMATTER.exec(live) : null;
  if (fm) ranges.push([0, fm[0].length]);
  const sites: number[] = [];
  for (const [a, b] of ranges) {
    for (const m of live.slice(a, b).matchAll(CLASS_FN_CALL)) sites.push(a + m.index!);
  }
  return sites;
}

export function docKindOf(file: string): DocKind | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.jsx' || ext === '.tsx') return 'jsx';
  if (ext === '.vue' || ext === '.svelte' || ext === '.astro') return ext.slice(1) as DocKind;
  return null;
}

/** Parse a page or component file into a Doc; kind comes from the extension. */
export function parseDoc(file: string, raw: string): Doc {
  const kind = docKindOf(file) ?? 'html';
  if (kind === 'jsx') {
    const j = jsxPseudo(raw);
    const doc = parseHtml(file, j.pseudo, 'jsx');
    doc.styles = [];
    doc.scripts = raw;
    doc.classAt = j.classAt;
    doc.virtuals = classCalls(raw, j.calls);
    doc.raw = raw;
    return doc;
  }
  const doc = parseHtml(file, kind === 'html' ? raw : templateMask(raw, kind), kind);
  doc.raw = raw;
  doc.virtuals = kind === 'html' ? [] : classCalls(raw, scriptSites(raw, kind));
  return doc;
}

export function getAttr(attrStr: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>/]+))`, 'i');
  const m = re.exec(attrStr);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? '';
}

export function hasAttr(attrStr: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?=[\\s=/]|$)`, 'i').test(attrStr);
}

/** Elements a browser closes when the same element opens again (optional end tags, and the elements that cannot nest in themselves), so a list of unclosed <li> or a run of unclosed <h2> does not read as nested. */
const IMPLICIT_CLOSE = new Set(['li', 'p', 'dt', 'dd', 'option', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'button', 'a', 'form', 'label', 'select']);
/** A heading start tag closes any open heading, and a block start tag closes an open <p>, as the browser does. */
const HEADING = /^h[1-6]$/;
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
/** Past this depth an open tag is read as empty: a real page nests tens deep, and a file that nests thousands deep must cost its length, not its square. */
const MAX_DEPTH = 512;

export interface Tree {
  /** For an open tag, the index of the tag that ends it: its own close tag, the sibling that implicitly closed it, or the close tag of an ancestor; -1 when it runs to the end of the document. */
  close: Int32Array;
  /** For every tag, the index of the nearest open ancestor, or -1 at the top. */
  parent: Int32Array;
}

/**
 * Open and close tags paired once per document. A close tag pops to its own
 * open tag, so a stray or missing end tag does not deepen everything after
 * it, and an element with an optional end tag ends where its next sibling
 * starts. Every tree reader (ancestors, innerOf, closeIndex, directChildren)
 * answers from this one pairing, so they agree on every element's extent.
 */
export function treeOf(doc: Doc): Tree {
  const cached = doc.cache.tree as Tree | undefined;
  if (cached) return cached;
  const n = doc.tags.length;
  const close = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  const openByName = new Map<string, Array<{ idx: number; depth: number }>>();
  for (let i = 0; i < n; i++) {
    const t = doc.tags[i];
    if (t.close) {
      const opens = openByName.get(t.name);
      if (!opens) continue;
      while (opens.length && stack[opens[opens.length - 1].depth] !== opens[opens.length - 1].idx) opens.pop();
      if (!opens.length) continue;
      const { depth } = opens.pop()!;
      for (let k = stack.length - 1; k >= depth; k--) close[stack[k]] = i;
      stack.length = depth;
      parent[i] = stack.length ? stack[stack.length - 1] : -1;
      continue;
    }
    if (stack.length) {
      const top = doc.tags[stack[stack.length - 1]].name;
      if ((IMPLICIT_CLOSE.has(t.name) && top === t.name) || (HEADING.test(t.name) && HEADING.test(top)) || (top === 'p' && CLOSES_P.has(t.name))) close[stack.pop()!] = i;
    }
    parent[i] = stack.length ? stack[stack.length - 1] : -1;
    if (t.selfClosing) continue;
    if (stack.length >= MAX_DEPTH) { close[i] = i; continue; }
    let opens = openByName.get(t.name);
    if (!opens) openByName.set(t.name, opens = []);
    opens.push({ idx: i, depth: stack.length });
    stack.push(i);
  }
  const tree = { close, parent };
  doc.cache.tree = tree;
  return tree;
}

/** The names of the open ancestors of the tag at idx, outermost first. */
export function ancestorsOf(doc: Doc, idx: number): string[] {
  const { parent } = treeOf(doc);
  const out: string[] = [];
  for (let p = parent[idx]; p >= 0; p = parent[p]) out.push(doc.tags[p].name);
  return out.reverse();
}

export interface Child { name: string; open: string; html: string; idx: number }

/** Where the element opened at idx ends in the source: after its own close tag, or where the tag that implicitly ended it starts. */
function outerEnd(doc: Doc, idx: number, closeAt: number): number {
  if (closeAt < 0) return doc.src.length;
  const c = doc.tags[closeAt];
  return c.close && c.name === doc.tags[idx].name ? c.end : c.pos;
}

/** The direct element children of the tag at idx, each with its open tag, outer HTML and tag index. */
export function directChildren(doc: Doc, idx: number): Child[] {
  const open = doc.tags[idx];
  if (open.close || open.selfClosing) return [];
  const { close, parent } = treeOf(doc);
  const end = close[idx] < 0 ? doc.tags.length : close[idx];
  const children: Child[] = [];
  for (let i = idx + 1; i < end; i++) {
    const t = doc.tags[i];
    if (t.close || parent[i] !== idx) continue;
    const openHtml = doc.src.slice(t.pos, t.end);
    children.push({ name: t.name, open: openHtml, html: t.selfClosing ? openHtml : doc.src.slice(t.pos, outerEnd(doc, i, close[i])), idx: i });
  }
  return children;
}

/** Visible text of an HTML fragment with the common entities decoded and whitespace folded. */
export function plainText(html: string): string {
  return stripTags(html)
    .replace(/&middot;|&#0?183;|&#x0?b7;/gi, '·').replace(/&bull;|&#8226;|&#x2022;/gi, '•').replace(/&mdash;|&#8212;|&#x2014;/gi, '\u2014').replace(/&ndash;|&#8211;|&#x2013;/gi, '\u2013')
    .replace(/&rarr;|&#8594;|&#x2192;|&xrarr;|&#10230;/gi, '\u2192').replace(/&raquo;|&#187;|&#xbb;/gi, '\u00bb').replace(/&rsaquo;|&#8250;|&#x203a;/gi, '\u203a')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&rsquo;|&lsquo;|&#8217;|&#8216;|&#x2019;|&#x2018;/gi, '\u2019').replace(/&rdquo;|&ldquo;|&#8220;|&#8221;/gi, '"')
    .replace(/&#\d+;|&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** The inner HTML of the element opened at idx and the position its close tag starts. */
export function innerOf(doc: Doc, idx: number): { inner: string; endPos: number } | null {
  const open = doc.tags[idx];
  if (open.close || open.selfClosing) return null;
  const c = treeOf(doc).close[idx];
  const endPos = c < 0 ? doc.src.length : doc.tags[c].pos;
  return { inner: doc.src.slice(open.end, endPos), endPos };
}

/** The visible text of the element opened at idx, computed once per element however many rules read it; '' for a close or void tag. */
export function textOf(doc: Doc, idx: number): string {
  const cache = (doc.cache.text ??= new Map<number, string>()) as Map<number, string>;
  const hit = cache.get(idx);
  if (hit != null) return hit;
  const text = plainText(innerOf(doc, idx)?.inner || '');
  cache.set(idx, text);
  return text;
}

export interface Element { idx: number; tag: Tag; inner: string }

/** The elements opened by a tag named by `name` between tag indices from and to, each with its inner HTML from the shared pairing; a tag walk, so an unclosed element costs its own extent and nothing scans to the end of the file for it. */
export function openTags(doc: Doc, name: RegExp, from = 0, to = doc.tags.length, pick: (t: Tag) => boolean = () => true): Element[] {
  const out: Element[] = [];
  for (let i = from; i < to; i++) {
    const t = doc.tags[i];
    if (t.close || t.selfClosing || !name.test(t.name) || !pick(t)) continue;
    const inner = innerOf(doc, i);
    if (inner) out.push({ idx: i, tag: t, inner: inner.inner });
  }
  return out;
}

/** The index of the tag that ends the element opened at idx: its close tag, or the tag that implicitly closed it (or the last tag when nothing does). */
export function closeIndex(doc: Doc, idx: number): number {
  const c = treeOf(doc).close[idx];
  return c < 0 ? doc.tags.length - 1 : c;
}

// sloplint proseRun
const proseRun = (run: string): string => {
  let r = run;
  for (let k = 0; k < 3 && /\{[^{}]*\}/.test(r); k++) r = r.replace(/\{[^{}]*\}/g, pad);
  return /[;=(){}]|\breturn\b/.test(r) ? pad(r) : r;
};

const CODE_ELEMENTS = ['script', 'style', 'pre', 'code', 'kbd', 'samp', 'textarea'];

/** The document's prose: tags, comments, scripts, styles and code blanked with positions preserved; component text runs that read as code are blanked too. */
// sloplint maskedProse
export function maskedProse(doc: Doc): string {
  const cached = doc.cache.prose as string | undefined;
  if (cached != null) return cached;
  let prose = doc.kind !== 'html' ? doc.src.replace(/(^|>)([^<>]*)(?=<|$)/g, (_m0, a: string, run: string) => a + proseRun(run)) : doc.src;
  for (const name of CODE_ELEMENTS) prose = blankRanges(prose, spansOf(asciiLower(prose), '<' + name, '</' + name, true).map((s): [number, number] => [s.start, s.end]));
  prose = stripTags(prose, true);
  doc.cache.prose = prose;
  return prose;
}

export const wordsOf = (t: string): string[] => plainText(t).split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
