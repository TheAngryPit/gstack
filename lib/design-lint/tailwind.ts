/**
 * Tailwind reading for the design lint: utility class strings in HTML and
 * component files (class, className, :class, class:list and the cn/clsx/cva
 * helper calls), parsed into the facts the rules ask about (background and
 * text colours, gradients, sizes, tracking, case, families, variants), plus
 * the tells the component rules read off them (gradient, glow, tracked caps,
 * eyebrow, mono costume, icon tiles).
 *
 * Ported from Nutlope/hallmark's sloplint.mjs (twParse, twInfo, twGroup,
 * twGradient, twGlow, tw67, tw54, twTiles and kin; MIT, see NOTICE.md).
 */
import type { LintContext } from './context';
import { memo } from './context';
import { bannedGradient, COLOR_LITERAL, oklchOf, parseColor, type Color } from './color';
import { CONTROL_TRACK_MAX_EM, GENERIC_FAMILIES, LABEL_PX, MONO_FACE, TRACKED_EM, firstFamily, pxOf, resolveVars, splitTop, type Tokens } from './css';
import { braceEnd, closeIndex, clsLits, directChildren, getAttr, innerOf, plainText, treeOf, type Doc, type Tag } from './html';
import { trunc } from './report';
import { EYEBROW_ANCESTOR_SKIP, EYEBROW_ANNOUNCE, EYEBROW_BLOCKY } from './rules/chrome-eyebrow';

export const TW_SIZE: Record<string, number> = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128 };
const TW_TRACK: Record<string, number> = { tighter: -0.05, tight: -0.025, normal: 0, wide: 0.025, wider: 0.05, widest: 0.1 };
const TW_HUE: Record<string, number> = { red: 25, orange: 47, amber: 70, yellow: 86, lime: 131, green: 150, emerald: 163, teal: 183, cyan: 215, sky: 237, blue: 260, indigo: 277, violet: 293, purple: 304, fuchsia: 322, pink: 354, rose: 16 };
const TW_COLOURS = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
export const TW_PAL = new RegExp(`^(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|decoration|divide|from|via|to|fill|stroke|shadow|accent|caret|placeholder|inset-shadow|inset-ring|drop-shadow)-(?:${TW_COLOURS})-(?:50|[1-9]00|950)(?:\\/(?:\\d{1,3}|\\[[^\\]]*\\]))?$`);
const TW_SHADE = new RegExp(`^(${TW_COLOURS})-(?:50|[1-9]00|950)(?:\\/\\S*)?$`);
const TW_ACCENT = /^text-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:500|600|700)(?:\/\S*)?$/;
const TW_PURPLE = /^(?:purple|violet|fuchsia|indigo)$/;
const TW_BLUE = /^(?:blue|sky|cyan|indigo)$/;
const TW_PINK = /^(?:pink|rose)$/;
const TW_GREY = /^(?:slate|gray|zinc|neutral|stone)$/;
const TW_NONFILL = /^bg-(?:none|transparent|inherit|current|fixed|local|scroll|cover|contain|auto|center|top|bottom|left|right|no-repeat|repeat(?:-[\w-]+)?|(?:left|right|top|bottom)-(?:top|bottom|left|right)|clip-[\w-]+|origin-[\w-]+|blend-[\w-]+|gradient-to-[\w-]+|(?:linear|radial|conic)(?:-.*)?|size-.*|position-.*|\[(?:url|length|position|size|image|(?:repeating-)?(?:linear|radial|conic)-gradient)[^\]]*\].*)$/;
const TW_GLASS = /^bg-(?:white|black|(?:slate|gray|zinc|neutral|stone)-(?:50|100|900|950)|paper|ink|background|foreground)\/(\d{1,2}|\[(?:0?\.\d+|\d{1,2}%)\])$/;
const TW_LOGO = /logo|brand|wordmark/i;
const TW_COLOR_LIT = /#[0-9a-fA-F]{3,8}\b|oklch\([^)]*\)|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

export interface TwParsed { variants: string[]; base: string; neg: boolean }

/** One utility split into its variants (group-/peer- prefixes and /names dropped), its base and a leading minus. */
export function twParse(tok: string): TwParsed {
  const variants: string[] = [];
  let depth = 0, cur = '';
  for (const ch of tok) {
    if (ch === '[' || ch === '(') depth++;
    else if ((ch === ']' || ch === ')') && depth > 0) depth--;
    if (ch === ':' && depth === 0) { variants.push(cur); cur = ''; } else cur += ch;
  }
  let base = cur;
  if (base.startsWith('!')) base = base.slice(1);
  if (base.endsWith('!')) base = base.slice(0, -1);
  const neg = base.length > 1 && base.startsWith('-');
  if (neg) base = base.slice(1);
  return { variants: variants.map((v) => v.replace(/^(?:group|peer)-/, '').replace(/\/[\w-]+$/, '')), base, neg };
}

/** The tokens utilities resolve against: the project's shared tokens for a component directory, else the context's own. */
export const twTokens = (ctx: LintContext): Tokens => ctx.twTokens ?? ctx.tokens;

const twValue = (tok: Tokens, v: string): string => resolveVars(v, tok).trim().replace(/^(-?)\./, '$10.');

/** The px size a text-* utility sets: the scale, an arbitrary value, or a --text-* token. */
export function twSize(ctx: LintContext, b: string): number | null {
  const tok = twTokens(ctx);
  let m = /^text-(xs|sm|base|lg|[2-9]?xl)(?:\/\S+)?$/.exec(b);
  if (m) return TW_SIZE[m[1]];
  m = /^text-(?:\[(?:length:)?([^\]]+)\]|\((?:length:)?(--[\w-]+)\))(?:\/\S+)?$/.exec(b);
  let v: string | null = m ? (m[1] ? m[1].replace(/_/g, ' ') : `var(${m[2]})`) : null;
  if (!m) {
    m = /^text-([a-z][\w-]*?)(?:\/\S+)?$/.exec(b);
    v = m ? tok[`--text-${m[1]}`] ?? null : null;
  }
  if (!v) return null;
  const r = twValue(tok, v);
  const cl = /^clamp\(\s*([^,]+),/.exec(r);
  return pxOf(cl ? twValue(tok, cl[1]) : r);
}

export interface TwTrack { em: number | null; px: number | null }

/** The tracking a tracking-* utility sets, in em when it says em, else in px. */
export function twTrack(ctx: LintContext, b: string, neg: boolean): TwTrack | null {
  const tok = twTokens(ctx);
  let m = /^tracking-(tighter|tight|normal|wide|wider|widest)$/.exec(b);
  let v: string | null = null;
  if (m) v = `${TW_TRACK[m[1]]}em`;
  else if ((m = /^tracking-(?:\[([^\]]+)\]|\((--[\w-]+)\))$/.exec(b))) v = m[1] ? m[1].replace(/_/g, ' ') : `var(${m[2]})`;
  else if ((m = /^tracking-([a-z][\w-]*)$/.exec(b)) && tok[`--tracking-${m[1]}`]) v = tok[`--tracking-${m[1]}`];
  if (v == null) return null;
  const r = twValue(tok, v);
  const e = /^(-?\d*\.?\d+)em$/.exec(r);
  const px = e ? null : pxOf(r);
  if (e) { const em = parseFloat(e[1]); return { em: neg ? -em : em, px: null }; }
  if (px == null) return null;
  return { em: null, px: neg ? -px : px };
}

/** The OKLCH hue of a colour that has one: opaque enough and chroma past 0.04. */
export const twHue = (c: Color | null): number | null => {
  if (!c || c.alpha <= 0.05) return null;
  const ok = oklchOf(c);
  return ok.C > 0.04 ? ok.H : null;
};

export interface TwStop {
  kind: 'token' | 'palette' | 'literal' | 'other';
  hue: number | null;
  /** The stop's colour name or value as written after from-/via-/to-. */
  value: string;
  /** The whole utility. */
  tok: string;
  /** The palette family (violet, sky …) for a palette stop. */
  pal: string | null;
}

/** One gradient stop (from-x, via-x, to-x) as a kind and a hue; a percentage position is no stop. */
export function twStop(ctx: LintContext, v: string, tok: string): TwStop | null {
  if (/^\[?-?\d*\.?\d+%\]?$/.test(v)) return null;
  const tokens = twTokens(ctx);
  const pm = TW_SHADE.exec(v);
  if (pm) return { tok, value: v, kind: 'palette', pal: pm[1], hue: TW_GREY.test(pm[1]) ? null : TW_HUE[pm[1]] };
  if (/^(?:white|black|transparent|current|inherit)(?:\/\S*)?$/.test(v)) return { tok, value: v, kind: 'other', pal: null, hue: null };
  if (v.startsWith('(')) return { tok, value: v, kind: 'token', pal: null, hue: twHue(parseColor(twValue(tokens, `var${v.replace(/\/\S*$/, '').replace(/^\((?:color:)?/, '(')}`))) };
  if (v.startsWith('[')) {
    const inner = v.slice(1, v.lastIndexOf(']')).replace(/_/g, ' ');
    return { tok, value: v, kind: /var\(/.test(inner) ? 'token' : 'literal', pal: null, hue: twHue(parseColor(twValue(tokens, inner))) };
  }
  const tv = tokens[`--color-${v.replace(/\/\S*$/, '')}`];
  return { tok, value: v, kind: 'token', pal: null, hue: tv ? twHue(parseColor(twValue(tokens, tv))) : null };
}

/** The named family inside font-[…], or null for a token, a weight or a generic family. */
export function twFamily(v: string): string | null {
  if (/var\(/.test(v)) return null;
  const named = v.replace(/^family-name:/, '');
  if (named === v && !/^['"]/.test(v) && /^(?:\d|weight:|number:)/.test(v)) return null;
  const fam = firstFamily(named.replace(/_/g, ' '));
  return !fam || GENERIC_FAMILIES.has(fam) ? null : fam;
}

export interface TwColourLiteral { tok: string; oklch: boolean }
export interface TwShadow { v: string; tok: string }

/** What one element's class string says. */
export interface TwInfo {
  classes: string[];
  /** The first bg-* fill utility. */
  bg: string | null;
  /** The first text-* colour utility. */
  text: string | null;
  stops: TwStop[];
  /** Text clipped to a background and made transparent. */
  gradientText: boolean;
  sizePx: number | null;
  trackingEm: number | null;
  upper: boolean;
  smallCaps: boolean;
  mono: boolean;
  variants: Set<string>;
  normalCase: boolean;
  /** The first saturated palette text colour (text-indigo-600 and kin). */
  accent: string | null;
  /** transition-all, or a transition naming a layout property. */
  tAll: string | null;
  bounce: string | null;
  overshoot: string | null;
  hScale: string | null;
  hRotate: string | null;
  grad: boolean;
  clip: boolean;
  clear: boolean;
  bblur: string | null;
  glass: string | null;
  blur: number;
  blurTok: string | null;
  pos: string | null;
  fill: boolean;
  shadows: TwShadow[];
  shadowCol: string | null;
  vh: string | null;
  oxHidden: string | null;
  oxClip: boolean;
  colours: TwColourLiteral[];
  font: string | null;
  pal: string[];
  rounded: boolean;
  cols3: boolean;
  animate: string | null;
  transform: boolean;
  transition: boolean;
  hero: boolean;
  padded: boolean;
}

function twLiterals(b: string, tok: string, f: TwInfo): void {
  for (const m of b.matchAll(/\[([^\]]+)\]/g)) {
    const v = m[1].replace(/url\([^)]*\)/gi, ' ').replace(/_/g, ' ');
    const fam = /^font-family:(.+)$/.exec(v);
    if (fam && !/var\(/.test(fam[1]) && !GENERIC_FAMILIES.has(firstFamily(fam[1]))) f.font = f.font || tok;
    for (const c of v.matchAll(TW_COLOR_LIT)) {
      const col = parseColor(c[0]);
      if (col && col.alpha > 0) f.colours.push({ tok, oklch: /^oklch/i.test(c[0]) });
    }
  }
}

interface TwAcc { sizeV: number | null; tracks: Array<{ r: TwTrack; plain: boolean }> }

/** Case, size, tracking and family utilities; true when the token was one of them. */
function twReadType(ctx: LintContext, b: string, tok: string, p: TwParsed, f: TwInfo, acc: TwAcc): boolean {
  const plain = !p.variants.length;
  if (b === 'uppercase') { f.upper = true; return true; }
  if (b === 'normal-case') { if (plain) f.normalCase = true; return true; }
  if (b === 'small-caps' || /^\[font-variant(?:-caps)?:[^\]]*(?:small|petite)-caps/.test(b) || /^\[font-feature-settings:[^\]]*(?:smcp|c2sc)/.test(b)) { f.smallCaps = true; return true; }
  if (b.startsWith('text-')) {
    const px = twSize(ctx, b);
    if (px != null) {
      if (plain) f.sizePx = px; else acc.sizeV = acc.sizeV == null ? px : Math.min(acc.sizeV, px);
      return true;
    }
    if (b === 'text-transparent') { f.clear = true; return true; }
    if (!/^text-(?:left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/.test(b)) f.text = f.text || tok;
    if (TW_ACCENT.test(b)) f.accent = f.accent || tok;
    return true;
  }
  if (b.startsWith('tracking-')) {
    const r = twTrack(ctx, b, p.neg);
    if (r) acc.tracks.push({ r, plain });
    return true;
  }
  if (b === 'font-mono') { f.mono = true; return true; }
  if (b.startsWith('font-')) {
    const arb = /^font-\[(.+)\]$/.exec(b);
    const fam = arb ? twFamily(arb[1]) : null;
    if (fam) { f.font = f.font || tok; if (MONO_FACE.test(fam)) f.mono = true; }
    const named = !arb && /^font-([a-z][\w-]*)$/.exec(b);
    const tv = named ? twTokens(ctx)[`--font-${named[1]}`] : undefined;
    if (tv && MONO_FACE.test(firstFamily(resolveVars(tv, twTokens(ctx))))) f.mono = true;
    return true;
  }
  return false;
}

/** Motion, gradient, surface, shadow, size and layout utilities. */
function twReadSurface(ctx: LintContext, b: string, tok: string, p: TwParsed, f: TwInfo): void {
  const hover = p.variants.includes('hover');
  if (b === 'transition-all' || /^transition-\[[^\]]*\b(?:all|width|height|top|left|right|bottom|inset)\b/.test(b) || /^\[transition(?:-property)?:[^\]]*\b(?:all|width|height|top|left)\b/.test(b)) {
    f.tAll = f.tAll || tok; f.transition = true;
    return;
  }
  if (/^transition(?:-transform)?$/.test(b)) { f.transition = true; if (b !== 'transition') f.transform = true; return; }
  if (b.startsWith('animate-')) {
    if (b !== 'animate-none') f.animate = f.animate || tok;
    if (b === 'animate-bounce') f.bounce = f.bounce || tok;
    return;
  }
  const ez = /^ease-\[cubic-bezier\(([^)]*)\)\]$/.exec(b);
  if (ez) {
    const n = ez[1].split(/[,_\s]+/).filter(Boolean).map(Number);
    if (n.length === 4 && [n[1], n[3]].some((y) => y > 1.05 || y < -0.05)) f.overshoot = f.overshoot || tok;
    return;
  }
  if (/^(?:scale|translate|rotate|skew)-/.test(b)) {
    f.transform = true;
    if (hover && /^scale-/.test(b) && !/^scale-(?:[xy]-)?100$/.test(b)) f.hScale = f.hScale || tok;
    if (hover && /^rotate-/.test(b) && b !== 'rotate-0') f.hRotate = f.hRotate || tok;
    return;
  }
  if (/^bg-(?:gradient-to-|linear-|radial|conic)|^bg-\[(?:repeating-)?(?:linear|radial|conic)-gradient/.test(b) || /^\[background(?:-image)?:[^\]]*gradient\(/.test(b)) f.grad = true;
  const st = /^(?:from|via|to)-(.+)$/.exec(b);
  if (st) { const s = twStop(ctx, st[1], tok); if (s) f.stops.push(s); return; }
  if (b === 'bg-clip-text' || /^\[(?:-webkit-)?background-clip:text\]$/.test(b)) { f.clip = true; return; }
  if (b === '[-webkit-text-fill-color:transparent]') { f.clear = true; return; }
  if (/^backdrop-blur(?:-|$)/.test(b) || /^\[(?:-webkit-)?backdrop-filter:[^\]]*blur/.test(b)) { f.bblur = f.bblur || tok; return; }
  const bl = /^blur-(?:(2xl|3xl)|\[(\d*\.?\d+)(px|rem)\])$/.exec(b);
  if (bl) {
    const px = bl[1] ? (bl[1] === '2xl' ? 40 : 64) : parseFloat(bl[2]) * (bl[3] === 'rem' ? 16 : 1);
    if (px > f.blur) { f.blur = px; f.blurTok = tok; }
    return;
  }
  if (b === 'absolute' || b === 'fixed') { f.pos = f.pos || b; return; }
  if (b.startsWith('bg-')) {
    const gm = TW_GLASS.exec(b);
    if (gm) {
      const v = gm[1].replace(/^\[|\]$/g, '');
      const a = v.endsWith('%') ? parseFloat(v) / 100 : v.includes('.') ? parseFloat(v) : parseFloat(v) / 100;
      if (a < 0.95) f.glass = f.glass || tok;
    }
    if (!TW_NONFILL.test(b)) { f.fill = true; f.bg = f.bg || tok; }
    return;
  }
  if (b.startsWith('shadow-')) {
    const sm = /^shadow-\[(.+)\]$/.exec(b);
    if (sm) f.shadows.push({ v: sm[1], tok });
    else if (!/^shadow-(?:2xs|xs|sm|md|lg|xl|2xl|inner|none)$/.test(b)) f.shadowCol = f.shadowCol || b.slice(7);
    return;
  }
  if (/^(?:min-)?h-(?:screen|\[[^\]]*\d\s*vh[^\]]*\])$/.test(b)) { f.vh = f.vh || tok; return; }
  if (b === 'overflow-x-hidden') { f.oxHidden = f.oxHidden || tok; return; }
  if (b === 'overflow-x-clip' || b === 'overflow-clip') { f.oxClip = true; return; }
  if (/^rounded(?:-|$)/.test(b)) { if (b !== 'rounded-none') f.rounded = true; return; }
  if (b === 'grid-cols-3') { f.cols3 = true; return; }
  if (/^p[xytrblse]?-/.test(b)) { f.padded = true; return; }
}

/** Read one class string into its facts; the variants it uses land in the shared set as well as on the info. */
export function twInfo(ctx: LintContext, toks: string[], variants: Set<string>): TwInfo {
  const f: TwInfo = {
    classes: toks, bg: null, text: null, stops: [], gradientText: false, sizePx: null, trackingEm: null, upper: false, smallCaps: false, mono: false, variants: new Set<string>(),
    normalCase: false, accent: null, tAll: null, bounce: null, overshoot: null, hScale: null, hRotate: null, grad: false, clip: false, clear: false,
    bblur: null, glass: null, blur: 0, blurTok: null, pos: null, fill: false, shadows: [], shadowCol: null, vh: null, oxHidden: null, oxClip: false,
    colours: [], font: null, pal: [], rounded: false, cols3: false, animate: null, transform: false, transition: false, hero: false, padded: false,
  };
  const acc: TwAcc = { sizeV: null, tracks: [] };
  for (const tok of toks) {
    if (tok.includes('__')) continue;
    const p = twParse(tok);
    const b = p.base;
    if (!b) continue;
    for (const v of p.variants) { variants.add(v); f.variants.add(v); }
    if (TW_PAL.test(b)) f.pal.push(b.replace(/\/.*$/, ''));
    if (b.includes('[')) twLiterals(b, tok, f);
    if (/hero/i.test(b)) f.hero = true;
    if (!twReadType(ctx, b, tok, p, f, acc)) twReadSurface(ctx, b, tok, p, f);
  }
  if (f.sizePx == null) f.sizePx = acc.sizeV;
  let emV: number | null = null;
  for (const { r, plain } of acc.tracks) {
    const em = r.em != null ? r.em : (r.px ?? 0) / (f.sizePx || 16);
    if (plain) f.trackingEm = em; else emV = emV == null ? em : Math.max(emV, em);
  }
  if (f.trackingEm == null) f.trackingEm = emV;
  f.gradientText = f.clip && f.clear;
  return f;
}

const TW_CLASS_ATTR = /(?:^|\s)(class|className|:class|v-bind:class|x-bind:class|class:list)\s*=\s*/g;

const cutGlued = (seg: string, after: boolean, before: boolean): string => {
  let s = seg;
  if (after) s = s.replace(/^\S+/, '');
  if (before) s = s.replace(/\S+$/, '');
  return s;
};

/** Class tokens of a Svelte/Astro attribute value with {expressions} inside it, glued halves dropped. */
function twInterp(val: string): string[] {
  const parts: string[] = [];
  let i = 0, seg = '', after = false;
  while (i < val.length) {
    if (val[i] === '{') {
      parts.push(cutGlued(seg, after, true));
      const e = braceEnd(val, i);
      parts.push(clsLits(val.slice(i + 1, e)).join(' '));
      i = e + 1; seg = ''; after = true;
      continue;
    }
    seg += val[i++];
  }
  parts.push(cutGlued(seg, after, false));
  return parts.join(' ').split(/\s+/).filter(Boolean);
}

/** Every class token on a tag: the JSX scanner's record, or the class-bearing attributes of the raw tag text. */
export function twTokensOf(doc: Doc, t: Tag): string[] {
  if (doc.kind === 'jsx') return doc.classAt.get(t.pos) || [];
  const tag = doc.raw.slice(t.pos, t.end);
  if (!tag.includes('class')) return [];
  const out: string[] = [];
  for (const m of tag.matchAll(TW_CLASS_ATTR)) {
    const i = (m.index as number) + m[0].length;
    const q = tag[i];
    let val: string;
    let dyn = m[1] !== 'class' && m[1] !== 'className';
    if (q === '"' || q === "'") { const e = tag.indexOf(q, i + 1); val = tag.slice(i + 1, e < 0 ? tag.length : e); }
    else if (q === '{') { val = tag.slice(i + 1, braceEnd(tag, i)); dyn = true; }
    else val = (/^[^\s>]*/.exec(tag.slice(i)) || [''])[0];
    for (const tok of dyn ? clsLits(val) : val.includes('{') ? twInterp(val) : val.split(/\s+/)) out.push(tok);
  }
  for (const d of tag.matchAll(/(?:^|\s)class:(?!list\b)([\w-]+)/g)) out.push(d[1]);
  return out.filter(Boolean);
}

/** What an element inherits from its ancestors: size, tracking, case, and the contexts that exempt it. */
export interface TwFrame {
  size: number | null;
  em: number | null;
  upper: boolean;
  caps: boolean;
  noLabel: boolean;
  code: boolean;
  eyeSkip: boolean;
  inOl: boolean;
  logo: boolean;
  logoSelf: boolean;
}

const TW_ROOT: TwFrame = { size: null, em: null, upper: false, caps: false, noLabel: false, code: false, eyeSkip: false, inOl: false, logo: false, logoSelf: false };

function twFrame(parent: TwFrame, t: { name: string; attrs: string }, f: TwInfo | null): TwFrame {
  const logo = (f ? f.classes : []).some((x) => TW_LOGO.test(x)) || TW_LOGO.test(getAttr(t.attrs, 'aria-label') || '');
  return {
    size: f && f.sizePx != null ? f.sizePx : parent.size,
    em: f && f.trackingEm != null ? f.trackingEm : parent.em,
    upper: f ? f.upper || (!f.normalCase && parent.upper) : parent.upper,
    caps: (f != null && f.smallCaps) || parent.caps,
    noLabel: parent.noLabel || /^(?:svg|pre|code|abbr|kbd|samp)$/.test(t.name),
    code: parent.code || /^(?:pre|code|kbd|samp)$/.test(t.name),
    eyeSkip: parent.eyeSkip || EYEBROW_ANCESTOR_SKIP.test(t.name),
    inOl: parent.inOl || t.name === 'ol',
    logo: parent.logo || (t.name === 'a' && logo),
    logoSelf: logo,
  };
}

export interface TwItem {
  file: string;
  line: number;
  /** Tag index in the doc, or -1 for a component tag or a helper-call site. */
  idx: number;
  /** The tag name, the component name, or the helper's name for a call site. */
  tag: string;
  info: TwInfo;
  doc: Doc;
  /** Index into doc.comps for a component tag, else null. */
  comp: number | null;
  /** A cn()/clsx()/cva() call site rather than an element. */
  virtual: boolean;
  attrs: string;
  frame: TwFrame;
  text: string | null;
}

export interface TwGroup {
  items: TwItem[];
  variants: Set<string>;
  /** An h1 or h2 set uppercase, which excuses uppercase controls. */
  upperDisplay: boolean;
}

/** Give a component context the project's tokens and drop the Tailwind facts read before they were known. */
export function setTwTokens(ctx: LintContext, tokens: Tokens): void {
  ctx.twTokens = tokens;
  delete ctx.cache.tw;
}

/** Every class-bearing element, component tag and helper call in the context, parsed. */
export function twGroup(ctx: LintContext): TwGroup {
  return memo(ctx, 'tw', () => {
    const tw: TwGroup = { items: [], variants: new Set<string>(), upperDisplay: false };
    const add = (it: TwItem) => {
      tw.items.push(it);
      if (/^h[12]$/.test(it.tag) && it.info.upper) tw.upperDisplay = true;
    };
    for (const doc of ctx.docs) {
      const { parent } = treeOf(doc);
      const frames: TwFrame[] = [];
      for (let i = 0; i < doc.tags.length; i++) {
        const t = doc.tags[i];
        if (t.close) continue;
        const toks = twTokensOf(doc, t);
        const info = toks.length ? twInfo(ctx, toks, tw.variants) : null;
        const frame = twFrame(parent[i] >= 0 ? frames[parent[i]] : TW_ROOT, t, info);
        frames[i] = frame;
        if (info) add({ file: doc.file, line: t.line, idx: i, tag: t.name, info, doc, comp: null, virtual: false, attrs: t.attrs, frame, text: null });
      }
      for (let c = 0; c < doc.comps.length; c++) {
        const t = doc.comps[c];
        if (t.close) continue;
        const toks = twTokensOf(doc, t);
        if (!toks.length) continue;
        const info = twInfo(ctx, toks, tw.variants);
        add({ file: doc.file, line: t.line, idx: -1, tag: t.name, info, doc, comp: c, virtual: false, attrs: t.attrs, frame: twFrame(TW_ROOT, t, info), text: null });
      }
      for (const v of doc.virtuals) {
        const info = twInfo(ctx, v.toks, tw.variants);
        add({ file: doc.file, line: doc.lineOf(v.pos), idx: -1, tag: v.name, info, doc, comp: null, virtual: true, attrs: '', frame: twFrame(TW_ROOT, { name: v.name, attrs: '' }, info), text: null });
      }
    }
    return tw;
  });
}

/** The Tailwind variants (hover, focus-visible, motion-reduce …) used anywhere in the context. */
export function twVariants(ctx: LintContext): Set<string> {
  return twGroup(ctx).variants;
}

/** Where a finding points: the helper call, or the element with the start of its class string. */
export function twWhere(it: TwItem): string {
  return it.virtual ? `${it.tag}() class string` : `<${it.tag} class="${trunc(it.info.classes.join(' '), 32)}">`;
}

/** Component tags paired once per document: for each open tag the index of its own close tag, -1 when none closes it. */
function compCloses(doc: Doc): Int32Array {
  const cached = doc.cache.compCloses as Int32Array | undefined;
  if (cached) return cached;
  const closes = new Int32Array(doc.comps.length).fill(-1);
  const open = new Map<string, number[]>();
  for (let i = 0; i < doc.comps.length; i++) {
    const t = doc.comps[i];
    if (t.selfClosing) continue;
    if (!t.close) { const s = open.get(t.name); if (s) s.push(i); else open.set(t.name, [i]); continue; }
    const s = open.get(t.name);
    if (s?.length) closes[s.pop()!] = i;
  }
  doc.cache.compCloses = closes;
  return closes;
}

/** The source between a component tag and its matching close; empty when nothing closes it. */
export function compInner(doc: Doc, c: number): string {
  const k = compCloses(doc)[c];
  return k < 0 ? '' : doc.src.slice(doc.comps[c].end, doc.comps[k].pos);
}

/** Visible text of a fragment, with template expressions blanked in Vue, Svelte and Astro files. */
export function twPlain(doc: Doc, html: string): string {
  let s = html;
  if (doc.kind !== 'html' && doc.kind !== 'jsx') for (let k = 0; k < 3 && /\{[^{}]*\}/.test(s); k++) s = s.replace(/\{[^{}]*\}/g, ' ');
  return plainText(s);
}

/** The element's visible text, read once. */
export function twText(it: TwItem): string {
  if (it.text == null) {
    let inner = '';
    if (it.idx >= 0) inner = innerOf(it.doc, it.idx)?.inner || '';
    else if (it.comp != null) inner = compInner(it.doc, it.comp);
    it.text = twPlain(it.doc, inner);
  }
  return it.text;
}

export interface TwGradient { banned: string | null; text: boolean; list: string }

/** The gradient an element's stops describe: its banned pairing if any, whether it is text, and the stop classes. */
export function twGradient(ctx: LintContext, f: TwInfo): TwGradient | null {
  if (!f.stops.length || (!f.grad && f.stops.length < 2)) return null;
  const names = f.stops.map((s) => s.pal).filter((p): p is string => p != null);
  let banned: string | null = null;
  for (const a of names) {
    if (!TW_PURPLE.test(a)) continue;
    if (names.some((x) => x !== a && TW_BLUE.test(x))) { banned = 'purple-to-blue'; break; }
    if (names.some((x) => x !== a && TW_PINK.test(x))) { banned = 'purple-to-pink'; break; }
  }
  if (!banned) banned = bannedGradient(f.stops.map((s) => s.hue).filter((h): h is number => h != null), twTokens(ctx));
  return { banned, text: f.clip && f.clear, list: f.stops.map((s) => s.tok).join(' ') };
}

const lengthPx = (x: string): number | null => (x === '0' ? 0 : pxOf(x));

/** A zero-offset coloured shadow of 8px blur or more: a glow. */
export function twGlow(ctx: LintContext, f: TwInfo): string | null {
  const tokens = twTokens(ctx);
  for (const s of f.shadows) {
    for (const part of splitTop(resolveVars(s.v.replace(/_/g, ' '), tokens))) {
      const cm = COLOR_LITERAL.exec(part);
      const lens = (cm ? part.replace(cm[0], ' ') : part).replace(/\binset\b/, ' ').trim().split(/\s+/).filter(Boolean).map(lengthPx);
      if (lens.length < 3 || lens[0] !== 0 || lens[1] !== 0 || lens[2] == null || lens[2] < 8) continue;
      let chroma = 0;
      if (cm) {
        const c = parseColor(cm[0]);
        if (c && c.alpha > 0.05) chroma = oklchOf(c).C;
      } else if (f.shadowCol) {
        const name = f.shadowCol.replace(/\/\S*$/, '');
        const pm = TW_SHADE.exec(name);
        const tv = tokens[`--color-${name}`];
        chroma = pm ? (TW_GREY.test(pm[1]) ? 0 : 0.2) : tv ? (twHue(parseColor(resolveVars(tv, tokens).trim())) != null ? 0.2 : 0) : 0;
      }
      if (chroma > 0.04) return `glow: ${s.tok}${cm ? '' : ` with shadow-${f.shadowCol}`}`;
    }
  }
  return null;
}

/** Whether a mono face is one of the page's declared families, so font-mono labels are material, not costume. */
export function twMonoIsMaterial(tokens: Tokens): boolean {
  const mono = (v: string | undefined) => !!v && MONO_FACE.test(firstFamily(resolveVars(v, tokens)));
  return mono(tokens['--font-display']) || mono(tokens['--font-body']) || mono(tokens['--font-outlier']);
}

/** Text that reads as data (a version, a shortcut, a command, a path, a time): mono is material there. */
export function twDataText(s: string): boolean {
  const t = s.trim();
  if (t.length > 200) return false;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const digits = (t.match(/\d/g) || []).length;
  if (digits >= letters) return true;
  if (/^v?\d+(?:\.\d+)+/.test(t) || /[⌘⌥⇧⌃⎋↵]|^(?:ctrl|cmd|alt|shift|option)\s*[+-]/i.test(t)) return true;
  if (/[{}();=<>]|^\$\s|^(?:npm|npx|pnpm|yarn|bun|git|curl|cd|ls|brew|pip|docker|node) |^--?[a-z]|[\w-]+\.[a-z][a-z0-9]{0,3}$|^[#.]?[a-z]+(?:[-_][a-z0-9]+)+$|^[a-z]+[A-Z]\w*$|^\/[\w/.-]*$|^https?:/.test(t)) return true;
  return digits > 0 && /^(?:\d{1,2}:\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d)/i.test(t);
}

export interface TwTrackedCaps { what: string; size: number | null; em: number | null }

/** The tracked-caps label: small text set uppercase, small caps or letter-spaced past 0.03em, outside logos, code and display heads. */
export function twTrackedCaps(it: TwItem, tw: TwGroup): TwTrackedCaps | null {
  const f = it.info, fr = it.frame;
  if (!(f.upper || f.smallCaps || (f.trackingEm != null && f.trackingEm > TRACKED_EM))) return null;
  if (fr.logo || fr.logoSelf || fr.noLabel) return null;
  const size = fr.size, em = fr.em;
  if ((size != null && size >= 24) || (size == null && /^h[1-6]$/.test(it.tag))) return null;
  const caps = fr.upper || fr.caps;
  const small = size != null && size <= LABEL_PX;
  const tracked = em != null && em > TRACKED_EM;
  const control = /^(?:button|input)$/.test(it.tag) || /(?:button|btn|cta)$/i.test(it.tag) || (it.tag === 'a' && f.fill && f.padded) || /role\s*=\s*["']?button/i.test(it.attrs);
  if (tw.upperDisplay && control && (em == null || em <= CONTROL_TRACK_MAX_EM)) return null;
  if (!((caps && (small || tracked)) || (tracked && small))) return null;
  return { what: fr.caps ? 'small caps' : fr.upper ? 'uppercase' : 'letter-spaced', size, em: tracked && em != null ? Math.round(em * 1000) / 1000 : null };
}

export interface TwEyebrow { text: string; next: string; signal: string }

/** The eyebrow: a short, small, uppercase, tracked or accent-coloured line immediately before an h1 to h3. */
export function twEyebrow(it: TwItem): TwEyebrow | null {
  const f = it.info, fr = it.frame, doc = it.doc;
  if (it.idx < 0 || !/^(?:p|span|div|small)$/.test(it.tag) || fr.eyeSkip) return null;
  if (!(f.upper || (f.trackingEm != null && f.trackingEm > TRACKED_EM) || f.accent)) return null;
  if (fr.size == null || fr.size > 14) return null;
  const t = doc.tags[it.idx];
  if (/role\s*=\s*["']?status|aria-live|aria-current|aria-hidden\s*=\s*["']?true/i.test(t.attrs)) return null;
  const c = closeIndex(doc, it.idx);
  const nx = c > it.idx && !doc.tags[c].close ? doc.tags[c] : doc.tags[c + 1];
  if (!nx || nx.close || !/^h[1-3]$/.test(nx.name)) return null;
  const inner = c > it.idx ? doc.src.slice(t.end, doc.tags[c].pos) : '';
  if (EYEBROW_BLOCKY.test(inner) || /<br\b|<time\b/i.test(inner)) return null;
  const href = /<a\b[^>]*\shref\s*=\s*["']([^"']*)["']/i.exec(inner);
  if (href && !/^#?$/.test(href[1].trim())) return null;
  const text = twPlain(doc, inner);
  const signal = [f.upper ? 'uppercase' : null, f.trackingEm != null && f.trackingEm > TRACKED_EM ? `tracked ${Math.round(f.trackingEm * 1000) / 1000}em` : null, f.accent].filter(Boolean).join(', ');
  if (!text) return doc.kind !== 'html' && c > it.idx && doc.raw.slice(t.end, doc.tags[c].pos).includes('{') ? { text: '', next: nx.name, signal } : null;
  const words = text.split(/[\s·/|\u2014\u2013]+/).filter(Boolean);
  if (words.length > 7 || text.length > 56 || /[\w/-]+\.[a-z]{1,4}$/i.test(text)) return null;
  const stripped = text.replace(/^\s*(?:no\.?\s*)?\d{1,3}(?:\s*[·./\u2014\u2013-]\s*|\s+|$)/i, '').trim();
  if ((stripped.match(/\d/g) || []).length >= 2) return null;
  if (fr.inOl && stripped && !EYEBROW_ANNOUNCE.test(stripped)) return null;
  return { text, next: nx.name, signal };
}

/** How many direct children of a grid open on an icon alone in a rounded filled tile above an h3. */
export function twTiles(it: TwItem, byIdx: Map<number, TwItem>): number {
  const doc = it.doc;
  let tiles = 0;
  for (const k of directChildren(doc, it.idx)) {
    if (!/<h3\b/i.test(k.html)) continue;
    const end = closeIndex(doc, k.idx);
    for (let j = k.idx + 1; j < end; j++) {
      const t = doc.tags[j];
      if (t.close) continue;
      if (/^h[1-6]$/.test(t.name)) break;
      const ti = byIdx.get(j);
      if (!ti || !ti.info.rounded || !ti.info.fill) continue;
      const inner = innerOf(doc, j);
      if (inner && /<svg\b|<[A-Z][\w.]*Icon\b|<Icon\b|<i\b[^>]*class/.test(inner.inner) && !twPlain(doc, inner.inner)) { tiles++; break; }
    }
  }
  return tiles;
}
