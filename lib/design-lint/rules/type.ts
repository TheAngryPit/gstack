/**
 * Type rules of the design lint (sloplint gates 1 25 37 38i 38ii 38iii 55a 55b 64 67; Nutlope/hallmark,
 * MIT, see NOTICE.md), rewritten in gstack's voice. Rule ids: overused-font, line-length, font-family-count, italic-word-in-heading, italic-serif-display, accented-word, caps-leading, caps-lockup-leading, monospace-costume, wide-tracking.
 *
 * Gate 75 (tiny text) is render-only and lives in the render tier.
 */
import { BANNED_FONTS, OVERUSED_FONTS_DISPLAY } from '../../design-catalog';
import type { LintContext } from '../context';
import { fontPx, memo, mergedRules, styleFor, trackingEm, valueOf } from '../context';
import { CONTROL_TRACK_MAX_EM, GENERIC_FAMILIES, HEADING_SEL, LABEL_PX, MONO_FACE, TRACKED_EM, famKey, firstFamily, isTokenRule, pxOf, resolveVars, selectorNames, tokenSites, type CssDecl, type CssRule, type MergedRule } from '../css';
import { ancestorsOf, closeIndex, getAttr, innerOf, openTags, plainText, stripTags, textOf, type Doc } from '../html';
import type { Reporter } from '../report';
import { trunc } from '../report';
import { twMonoIsMaterial } from '../tailwind';
import { capsRatio } from './chrome-eyebrow';

/** A selector without its pseudo-classes and pseudo-elements, whitespace folded. */
const baseSelector = (sel: string): string => sel.replace(/::?[a-z-]+(\([^)]*\))?/gi, '').replace(/\s+/g, ' ').trim();

const em3 = (em: number): string => String(Math.round(em * 1000) / 1000);

/** The declaration a token's value was read from (the same choice buildTokens makes), for the finding's file and line. */
function tokenSite(ctx: LintContext, prop: string): { file: string; line: number } {
  const site = memo(ctx, 'tokenSites', () => tokenSites(ctx.rules)).get(prop);
  return site ? { file: site.file, line: site.line } : { file: ctx.rules[0]?.file ?? ctx.key, line: 1 };
}

/** gstack's own catalog of training-data display faces, plus the system stacks sloplint names. */
const OVERUSED = [...OVERUSED_FONTS_DISPLAY, 'system-ui', '-apple-system', 'helvetica neue', 'segoe ui'].map((f) => f.toLowerCase());

/** gstack's catalog of faces banned in any role (Papyrus, Comic Sans, Impact and kin). */
const BANNED_WORDS = BANNED_FONTS.map((f) => f.toLowerCase());

/** The catalog names a family by its stem ("Comic Sans", "Cormorant", "DM Serif"); a declaration says "Comic Sans MS", "Cormorant Garamond" or "DM Serif Display". A stem matches the whole name or its first words, never a longer word ("Inter" is not "Interstate"). */
function namesFace(fam: string, stems: readonly string[]): boolean {
  const k = famKey(fam);
  const words = fam.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  return stems.some((s) => k === famKey(s) || words.startsWith(s + ' '));
}
const isBanned = (fam: string): boolean => namesFace(fam, BANNED_WORDS);

// gstack's own: a banned face anywhere, display or body (lib/design-catalog.ts BANNED_FONTS)
function bannedFont(ctx: LintContext, r: Reporter): void {
  const seen = new Set<string>();
  const flag = (fam: string, file: string, line: number, where: string) => {
    if (!isBanned(fam) || seen.has(fam + where)) return;
    seen.add(fam + where);
    r.report('banned-font', file, line, `"${fam}" (${where})`);
  };
  for (const [prop, val] of Object.entries(ctx.tokens)) {
    if (!/^--font-/.test(prop)) continue;
    const site = tokenSite(ctx, prop);
    flag(firstFamily(resolveVars(val, ctx.tokens)), site.file, site.line, prop);
  }
  for (const rule of ctx.rules) {
    if (isTokenRule(rule)) continue;
    for (const d of rule.decls) if (d.prop === 'font-family' && !d.value.includes('var(')) flag(firstFamily(d.value), rule.file, d.line, rule.selector);
  }
}

// sloplint check1 (gate 1)
function check1(ctx: LintContext, r: Reporter): void {
  const seen = new Set<string>();
  const flag = (fam: string, file: string, line: number, where: string) => {
    if (!namesFace(fam, OVERUSED) || seen.has(fam + where)) return;
    seen.add(fam + where);
    r.report('overused-font', file, line, `"${fam}" as the display face (${where})`);
  };
  for (const [prop, val] of Object.entries(ctx.tokens)) {
    if (!/^--font-(display|heading|title|hero)/.test(prop)) continue;
    const site = tokenSite(ctx, prop);
    flag(firstFamily(resolveVars(val, ctx.tokens)), site.file, site.line, prop);
  }
  for (const rule of ctx.rules) {
    if (isTokenRule(rule) || !HEADING_SEL.test(rule.selector)) continue;
    for (const d of rule.decls) if (d.prop === 'font-family') flag(firstFamily(resolveVars(d.value, ctx.tokens)), rule.file, d.line, rule.selector);
  }
}

// sloplint shortProse (gate 25): every paragraph under the selector is one or two short sentences; answered once per class, since a sheet may name the same class in many rules
function shortProse(ctx: LintContext, sel: string): boolean {
  const cls = [...sel.matchAll(/\.([\w-]+)/g)].map((m) => m[1]).pop();
  if (!cls) return false;
  const known = memo(ctx, 'shortProse25', () => new Map<string, boolean>());
  const hit = known.get(cls);
  if (hit !== undefined) return hit;
  const short = shortProseOf(ctx, cls);
  known.set(cls, short);
  return short;
}

/** The open tags of a document by class, indexed once. */
function byClass(doc: Doc): Map<string, number[]> {
  const cached = doc.cache.byClass as Map<string, number[]> | undefined;
  if (cached) return cached;
  const index = new Map<string, number[]>();
  for (let i = 0; i < doc.tags.length; i++) {
    const t = doc.tags[i];
    if (t.close || t.selfClosing) continue;
    for (const c of (getAttr(t.attrs, 'class') || '').split(/\s+/)) if (c) { const list = index.get(c); if (list) list.push(i); else index.set(c, [i]); }
  }
  doc.cache.byClass = index;
  return index;
}

function shortProseOf(ctx: LintContext, cls: string): boolean {
  const texts: string[] = [];
  for (const doc of ctx.docs) {
    for (const idx of byClass(doc).get(cls) ?? []) {
      const el = innerOf(doc, idx);
      if (!el) continue;
      const paras = doc.tags[idx].name === 'p' ? [el.inner] : openTags(doc, /^p$/, idx + 1, closeIndex(doc, idx)).map((p) => p.inner);
      for (const p of paras) texts.push(stripTags(p).replace(/\s+/g, ' ').trim());
    }
  }
  return texts.length > 0 && texts.every((t) => t.length <= 200 && (t.match(/[.!?](?:\s|$)/g) || []).length <= 2);
}

// sloplint check25 (gate 25), the static half: the measure declared in ch
function check25(ctx: LintContext, r: Reporter): void {
  const proseish = /(^|[\s,>+~(])p\b|lede|prose|copy|__body|__text|__desc|paragraph/i;
  for (const rule of ctx.rules) {
    if (!proseish.test(rule.selector) || HEADING_SEL.test(rule.selector)) continue;
    for (const d of rule.decls) {
      if (d.prop !== 'max-width') continue;
      const m = /^([\d.]+)ch$/.exec(resolveVars(d.value, ctx.tokens).trim());
      if (!m) continue;
      const ch = parseFloat(m[1]);
      if (ch >= 45 && ch <= 75) continue;
      const floor = /lede|hero|caption|figcaption|__line|__sub|subhead|tagline/i.test(rule.selector) || shortProse(ctx, rule.selector) ? 28 : 45;
      if (ch < floor || ch > 75) {
        r.report('line-length', rule.file, d.line, `a measure of ${ch}ch on ${rule.selector} (${floor} to 75ch reads well)`,
          { fix: `max-width between ${floor === 28 ? '28' : '45'} and 75ch${floor === 28 ? ' for a one-sentence lede or caption' : ''}` });
      }
    }
  }
}

// sloplint check37 (gate 37)
function check37(ctx: LintContext, r: Reporter): void {
  const families = new Map<string, { file: string; line: number }>();
  const keys = new Set<string>();
  for (const rule of ctx.rules) {
    if (rule.selector === '@font-face') continue;
    for (const d of rule.decls) {
      if (d.prop !== 'font-family' && !/^--font-/.test(d.prop)) continue;
      if (/^--font-/.test(d.prop) && !isTokenRule(rule)) continue;
      const fam = firstFamily(resolveVars(d.value, ctx.tokens));
      if (!fam || GENERIC_FAMILIES.has(fam) || fam.startsWith('var(')) continue;
      const key = famKey(fam);
      if (!keys.has(key)) { keys.add(key); families.set(fam, { file: rule.file, line: d.line }); }
    }
  }
  if (families.size <= 3) return;
  const fourth = [...families.values()][3];
  r.report('font-family-count', fourth.file, fourth.line, `${families.size} font families: ${trunc([...families.keys()].join(', '), 56)}`);
}

// sloplint check38a (gates 38i, 38ii)
function check38a(ctx: LintContext, r: Reporter): void {
  const inlineLast = (sel: string) => sel.split(',').every((p) => /^(?:em|i|b|strong|span|mark)(?![\w-])/.test(baseSelector(p).split(/[\s>+~]+/).pop() || ''));
  for (const rule of ctx.rules) {
    if (!HEADING_SEL.test(rule.selector) || inlineLast(rule.selector)) continue;
    for (const d of rule.decls) {
      if (d.prop === 'font-style' && /italic|oblique/.test(d.value)) r.report('italic-serif-display', rule.file, d.line, `italic display type on ${rule.selector}`);
    }
  }
  const normSel = ctx.rules.filter((rule) => /(^|[\s,>+~])(em|i)\b/.test(rule.selector)
    && rule.decls.some((d) => d.prop === 'font-style' && /normal/.test(d.value))).flatMap((rule) => rule.selector.split(',').map((x) => x.trim()));
  const norm = selectorNames(normSel), bareNorm = normSel.some((sel) => /^(em|i)$/.test(sel));
  const normalised = (level: string, classes: string[]) => bareNorm || norm.tags.has('h' + level) || classes.some((c) => norm.classes.has(c));
  for (const doc of ctx.docs) {
    for (const head of openTags(doc, /^h[1-6]$/)) {
      const level = head.tag.name.slice(1);
      const classes = (getAttr(head.tag.attrs, 'class') || '').split(/\s+/).filter(Boolean);
      if (normalised(level, classes)) continue;
      const headLen = textOf(doc, head.idx).length;
      const tag = openTags(doc, /^(em|i)$/, head.idx + 1, closeIndex(doc, head.idx)).find((t) => {
        const italic = textOf(doc, t.idx);
        return /[A-Za-z0-9]/.test(italic) && !/aria-hidden/i.test(t.tag.attrs) && italic.length < 0.8 * headLen;
      });
      if (!tag) continue;
      r.report('italic-word-in-heading', doc.file, head.tag.line, `an <${tag.tag.name}> inside an otherwise roman <h${level}>`);
    }
  }
}

const ACCENT38 = /(?:^|[\s,])((?:h[1-3]|\.display|\.headline|\.title|[.\w-]*__(?:title|display|headline))[^\s,>+~]*)\s*(?:>|\s)\s*(em|i|b|strong|span|mark|\.[\w-]+)(?::nth-child\([^)]*\))?(?:::?[\w-]+)?\s*$/i;
const INHERITED38 = /^(inherit|currentcolor|unset|initial|normal)$/i;
const MARK38 = /^(color|background|background-color|-webkit-text-stroke|font-weight|text-decoration|text-decoration-color|border-bottom|box-shadow|font-style)$/;
const marks38 = (rule: CssRule): CssDecl[] => rule.decls.filter((d) => MARK38.test(d.prop) && !INHERITED38.test(d.value.trim()));

/** The rules that mark one word of a heading apart from the rest: by selector shape, or by a classed span inside an h1 to h3 that covers under 80% of the head. */
// sloplint accentedHeads (gate 38iii)
function accentedHeads(ctx: LintContext): CssRule[] {
  const out: CssRule[] = [];
  const seen = new Set<string>();
  for (const rule of ctx.rules) {
    if (rule.keyframes || isTokenRule(rule) || !ACCENT38.test(rule.selector)) continue;
    if (!marks38(rule).length || seen.has(rule.selector)) continue;
    seen.add(rule.selector);
    out.push(rule);
  }
  const norm = (v: string | null) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const byClass = memo(ctx, 'rulesByClass38', () => {
    const index = new Map<string, CssRule[]>();
    for (const rule of ctx.rules) {
      if (rule.keyframes || isTokenRule(rule)) continue;
      for (const part of rule.selector.split(',')) {
        if (/::?(before|after)\b/.test(part)) continue;
        const base = baseSelector(part);
        if (!/^\.[\w-]+$/.test(base)) continue;
        const list = index.get(base.slice(1)) ?? [];
        list.push(rule);
        index.set(base.slice(1), list);
      }
    }
    return index;
  });
  for (const doc of ctx.docs) {
    for (let i = 0; i < doc.tags.length; i++) {
      const t = doc.tags[i];
      if (t.close || !/^h[1-3]$/.test(t.name)) continue;
      const inner = innerOf(doc, i);
      if (!inner) continue;
      const headLen = textOf(doc, i).replace(/\s+/g, '').length || 1;
      const spans = openTags(doc, /^(span|em|strong|b|i|mark)$/, i + 1, closeIndex(doc, i), (s) => !!(getAttr(s.attrs, 'class') || '').trim())
        .map((el) => ({ classes: (getAttr(el.tag.attrs, 'class') || '').split(/\s+/).filter(Boolean), text: plainText(el.inner) }));
      const covered = new Map<string, number>();
      for (const x of spans) for (const cls of x.classes) covered.set(cls, (covered.get(cls) ?? 0) + x.text.replace(/\s+/g, '').length);
      const cover = (cls: string) => (covered.get(cls) ?? 0) / headLen;
      const headDecls = styleFor(ctx, getAttr(t.attrs, 'class'), t.name, true);
      const own = (prop: string) => valueOf(ctx, headDecls, prop) ?? (prop === 'color' ? resolveVars('var(--color-ink)', ctx.tokens) : null);
      for (const m of spans) {
        if (!/[A-Za-z0-9]/.test(m.text)) continue;
        for (const cls of m.classes) {
          if (cover(cls) >= 0.8) continue;
          for (const rule of byClass.get(cls) ?? []) {
            if (seen.has(rule.selector)) continue;
            if (rule.decls.some((d) => (d.prop === 'display' && /^(block|flex|grid|table)/.test(d.value.trim())) || (d.prop === 'position' && /absolute|fixed/.test(d.value)))) continue;
            const marking = marks38(rule);
            if (!marking.length) continue;
            if (marking.every((d) => /^(color|font-weight)$/.test(d.prop) && own(d.prop) != null && norm(resolveVars(d.value, ctx.tokens)) === norm(own(d.prop)))) continue;
            seen.add(rule.selector);
            out.push(rule);
          }
        }
      }
    }
  }
  return out;
}

// sloplint check38c (gate 38iii); hallmark's hero-signature exemption read the stamp, so every accented word reports here
function check38c(ctx: LintContext, r: Reporter): void {
  for (const rule of accentedHeads(ctx)) r.report('accented-word', rule.file, rule.line, `one word of a heading set apart (${rule.selector})`);
}

// sloplint check55 (gates 55a, 55b)
function check55(ctx: LintContext, r: Reporter): void {
  for (const rule of mergedRules(ctx)) {
    if (!rule.decls.some((d) => d.prop === 'text-transform' && /uppercase/.test(d.value))) continue;
    const lhD = rule.decls.find((d) => d.prop === 'line-height');
    if (!lhD) continue;
    const lhV = resolveVars(lhD.value, ctx.tokens).trim();
    const lh = /%$/.test(lhV) ? parseFloat(lhV) / 100 : /(?:px|r?em)$/i.test(lhV) ? NaN : parseFloat(lhV);
    if (Number.isNaN(lh) || lh >= 1.02) continue;
    const bigType = rule.decls.some((d) => d.prop === 'font-size' && (pxOf(resolveVars(d.value, ctx.tokens)) ?? 0) >= 28);
    if (!HEADING_SEL.test(rule.selector) && !bigType) continue;
    const nowrap = rule.decls.some((d) => d.prop === 'white-space' && /nowrap/.test(d.value));
    if (!nowrap && lh >= 1.0) continue;
    r.report(nowrap ? 'caps-lockup-leading' : 'caps-leading', rule.file, lhD.line, `uppercase at line-height ${lh} on ${rule.selector}: the caps collide`);
  }
}


// sloplint check64 (gate 64); twMonoIsMaterial is sloplint's monoIsMaterial: a mono face declared as the display, body or outlier is the page's material, not a costume
function check64(ctx: LintContext, r: Reporter): void {
  if (twMonoIsMaterial(ctx.tokens)) return;
  const monoFam = (v: string) => MONO_FACE.test(firstFamily(resolveVars(v, ctx.tokens)));
  const LABELISH = /label|caption|meta|eyebrow|kicker|tag\b|badge|chip|small|folio|footnote|legend|\bth\b|thead|figcaption|overline|dateline|byline|credit|note\b/i;
  const DATAISH = /code|pre\b|kbd|samp|num|figure|stat|price|value|data|tabular|counter|timer|clock|coord|amount|total|score|version|hash|\bid\b|sku|time|date|hour|utc|\beta\b|\blot\b|edition|ref\b|dimension|measure|reading|plate-?no|tag-?no|url|uri\b|path|endpoint|command|cmd|snippet|install/i;
  const seen = new Set<string>();
  for (const rule of ctx.rules) {
    if (rule.keyframes || rule.selector === '@font-face' || isTokenRule(rule)) continue;
    if (!LABELISH.test(rule.selector) || DATAISH.test(rule.selector)) continue;
    const fam = rule.decls.find((d) => d.prop === 'font-family' || (d.prop === 'font' && /var\(--font|mono/i.test(d.value)));
    if (!fam) continue;
    const raw = fam.prop === 'font' ? (/var\(--font-[\w-]+\)/.exec(fam.value) || [fam.value])[0] : fam.value;
    if (!monoFam(raw)) continue;
    const key = baseSelector(rule.selector);
    if (seen.has(key)) continue;
    seen.add(key);
    r.report('monospace-costume', rule.file, fam.line, `monospace as the label voice on ${rule.selector}`);
  }
}

// sloplint fontSizePxOf (gate 67)
function fontSizePxOf(rule: MergedRule, ctx: LintContext): number | null {
  const fs = rule.decls.find((d) => d.prop === 'font-size');
  if (fs) return pxOf(resolveVars(fs.value, ctx.tokens));
  const f = rule.decls.find((d) => d.prop === 'font');
  if (!f) return null;
  const m = /(?:^|\s)(\d+(?:\.\d+)?(?:px|rem|em))(?:\/[\d.]+(?:px|rem|em)?)?\s/.exec(resolveVars(f.value, ctx.tokens) + ' ');
  return m ? pxOf(m[1]) : null;
}

const LABEL67 = /label|caption|meta|eyebrow|kicker|tag\b|badge|chip|small|folio|footnote|legend|\bth\b|thead|figcaption|overline|dateline|byline|credit|note\b|\bnav\b|menu|link|pill|status|unit|smallcaps|count|placard/i;
const CONTROL67 = /btn|button|cta|\.sign\b|plate|control/i;
const EXEMPT67_NAME = /^(wordmark|marquee|ticker|logo|brand|abbr|logo-?(mark|type|text)|brand-?(mark|name|type))$/i;
const EXEMPT67_PART = /(^|[-_])(wordmark|marquee|ticker|logotype|logo|brand)([-_]|$)|(^|[-_])(slab|nav|site|head|header|masthead|bar)[-_]+mark([-_]|$)/i;
const exemptName67 = (n: string): boolean => !!n && (EXEMPT67_NAME.test(n.split('--')[0].split('__').pop() || '') || EXEMPT67_PART.test(n));
const SCROLLER67 = /(^|[-_])(marquee|ticker)([-_]|$)/i;

// sloplint exempt67 (gate 67): wordmarks, logos, marquees and tickers may be set in capitals
function exempt67(sel: string): boolean {
  return sel.split(',').some((part) => {
    const comps = baseSelector(part).split(/[\s>+~]+/).filter(Boolean);
    const comp = comps[comps.length - 1] || '';
    const names = (comp.match(/\.[a-zA-Z_][\w-]*/g) || []).map((c) => c.slice(1));
    names.push((/^[a-zA-Z][\w-]*/.exec(comp) || [''])[0]);
    if (names.some(exemptName67)) return true;
    return comps.slice(0, -1).some((c) => (c.match(/\.[a-zA-Z_][\w-]*/g) || []).some((x) => SCROLLER67.test(x.slice(1))));
  });
}

/** The merged rules that can pass a value down, indexed by each selector part's base, so a lookup probes the subject's own prefixes instead of walking every rule of the sheet. */
type Ancestors67 = Map<string, MergedRule[]>;

function ancestors67(bySel: MergedRule[]): Ancestors67 {
  const byBase: Ancestors67 = new Map();
  for (const o of bySel) {
    if (/:hover|:focus|:active/.test(o.selector) || (o.media && /max-width/i.test(o.media))) continue;
    for (const ob of o.selector.split(',').map(baseSelector)) {
      if (!ob) continue;
      const list = byBase.get(ob);
      if (list) list.push(o); else byBase.set(ob, [o]);
    }
  }
  return byBase;
}

// sloplint inherited67 (gate 67): the nearest ancestor selector's value for a property; the longest prefix of the subject that ends before a combinator and declares it
function inherited67(up: Ancestors67, sel: string, prop: string): string | null {
  const base = baseSelector(sel);
  for (let k = base.length - 1; k > 0; k--) {
    if (!/[\s>+~]/.test(base[k])) continue;
    const rules = up.get(base.slice(0, k));
    if (!rules) continue;
    for (const o of rules) {
      const d = o.decls.filter((x) => x.prop === prop).pop();
      if (d) return d.value;
    }
  }
  return null;
}

const isSmallCaps67 = (prop: string, v: string): boolean => (/^font-variant(-caps)?$/.test(prop) && /\b(all-)?(small|petite)-caps\b/.test(v))
  || (prop === 'font-feature-settings' && /\b(smcp|c2sc)\b/.test(v));

interface Caps67 { upper: boolean; smallCaps: boolean; em: number | null; px: number | null }

/** What a rule says about case and tracking, its own declarations first and the nearest ancestor's where it is silent. */
function caps67(ctx: LintContext, bySel: Ancestors67, rule: MergedRule): Caps67 | null {
  const isUpper = (v: string | null) => v != null && /uppercase/.test(resolveVars(v, ctx.tokens));
  const ownTT = rule.decls.filter((d) => d.prop === 'text-transform').pop();
  const ownUpper = ownTT ? isUpper(ownTT.value) : null;
  const ownSmallCaps = rule.decls.some((d) => isSmallCaps67(d.prop, resolveVars(d.value, ctx.tokens)));
  const px = fontSizePxOf(rule, ctx);
  const ownEm = trackingEm(ctx, rule.decls, px || 16);
  if (!(ownUpper === true || ownSmallCaps || (ownEm != null && ownEm > TRACKED_EM))) return null;
  const upper = ownUpper != null ? ownUpper : isUpper(inherited67(bySel, rule.selector, 'text-transform'));
  const smallCaps = ownSmallCaps || ['font-variant', 'font-variant-caps', 'font-feature-settings'].some((prop) => {
    const v = inherited67(bySel, rule.selector, prop);
    return v != null && isSmallCaps67(prop, resolveVars(v, ctx.tokens));
  });
  let em = ownEm;
  if (em == null) {
    const v = inherited67(bySel, rule.selector, 'letter-spacing');
    if (v != null) em = trackingEm(ctx, [{ prop: 'letter-spacing', value: v, line: 0 }], px || 16);
  }
  return { upper, smallCaps, em, px };
}

// sloplint check67 (gate 67), the CSS half
function check67(ctx: LintContext, r: Reporter): void {
  const bySel = mergedRules(ctx);
  const displayish = (rule: MergedRule) => HEADING_SEL.test(rule.selector) || /display|title|headline|bill|poster|banner/i.test(rule.selector)
    || rule.decls.some((d) => (d.prop === 'font-family' || d.prop === 'font') && /--font-display/.test(d.value)) || (fontSizePxOf(rule, ctx) || 0) >= 28;
  const upperDisplay = bySel.some((rule) => displayish(rule) && !LABEL67.test(rule.selector) && rule.decls.some((d) => d.prop === 'text-transform' && /uppercase/.test(d.value)));
  const seen = new Set<string>();
  const up = ancestors67(bySel);
  for (const rule of bySel) {
    if (isTokenRule(rule) || exempt67(rule.selector) || /::first-letter\s*(,|$)/.test(rule.selector)) continue;
    const caps = caps67(ctx, up, rule);
    if (!caps) continue;
    const { upper, smallCaps, em, px } = caps;
    const tracked = em != null && em > TRACKED_EM;
    const subject = rule.selector.split(',').map((p) => baseSelector(p).split(/[\s>+~]+/).filter(Boolean).pop() || '');
    const bigToken = rule.decls.some((d) => d.prop === 'font-size' && /--text-(display|section|title)|clamp\(\s*(?:[2-9]|\d{2,})(?:\.\d+)?rem/.test(d.value));
    const labelish = subject.some((s) => LABEL67.test(s)) ? !((px != null && px >= 28) || bigToken)
      : LABEL67.test(rule.selector) && !subject.every((s) => /^h[1-6]\b/i.test(s)) && (px == null || px < 20);
    const control = CONTROL67.test(rule.selector);
    if (HEADING_SEL.test(rule.selector) && !labelish && !control) continue;
    const key = baseSelector(rule.selector);
    if (seen.has(key)) continue;
    const small = px != null && px <= LABEL_PX;
    const at = px != null ? ` at ${Math.round(px)}px` : '';
    const tracking = tracked ? ` tracked ${em3(em)}em` : '';
    if (control && !labelish) {
      if (!upper && !smallCaps) { if (!(tracked && small)) continue; }
      else if (upperDisplay && (em == null || em <= CONTROL_TRACK_MAX_EM)) continue;
      seen.add(key);
      r.report('wide-tracking', rule.file, rule.line, !upper && !smallCaps ? `${rule.selector}: a control tracked ${em3(em!)}em${at}` : upperDisplay ? `${rule.selector}: an uppercase control tracked ${em3(em!)}em` : `${rule.selector}: an uppercase control on a page whose display is not uppercase`,
        { fix: 'controls follow the display voice: sentence case here, or tracking 0.04em at most where the display itself is uppercase' });
      continue;
    }
    const isCaps = upper || smallCaps;
    if ((isCaps && (labelish || smallCaps || tracked || small)) || (tracked && (labelish || small))) {
      seen.add(key);
      const what = smallCaps ? 'small caps' : upper ? 'uppercase' : 'letter-spaced';
      r.report('wide-tracking', rule.file, rule.line, `${rule.selector}: ${what}${tracking}${at} in a label role`);
    }
  }
}

const CAPS_TAGS = /^(p|span|small|a|li|div|figcaption|td|th|dt|dd|label|time|cite|strong|b|em|button|summary)$/;

// sloplint check67Html (gate 67), the markup half: text typed in capitals at label size or tracked
function check67Html(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const seen = new Set<string>();
    for (let i = 0; i < doc.tags.length; i++) {
      const t = doc.tags[i];
      if (t.close || t.selfClosing || !CAPS_TAGS.test(t.name)) continue;
      const cls = getAttr(t.attrs, 'class') || '';
      if (cls.split(/\s+/).some(exemptName67)) continue;
      if (ancestorsOf(doc, i).some((n) => /^(svg|pre|code|abbr|kbd|samp)$/.test(n))) continue;
      const inner = innerOf(doc, i);
      if (!inner || /<(p|div|ul|ol|h[1-6]|table|section|article|svg|img|abbr|code|kbd)\b/i.test(inner.inner)) continue;
      const text = textOf(doc, i);
      const letters = text.replace(/[^A-Za-z]/g, '');
      if (letters.length < 5 || capsRatio(text) < 0.95 || /^[A-Z]{2,5}$/.test(text) || /^\(?\s*(CC0|CC BY(-SA|-NC|-ND)*( [0-9.]+)?|PD|GFDL)\b/.test(text)) continue;
      const decls = styleFor(ctx, cls, t.name);
      const px = fontPx(ctx, decls);
      const em = trackingEm(ctx, decls, px || 16);
      const tracked = em != null && em > TRACKED_EM;
      if (!((px != null && px <= LABEL_PX) || tracked)) continue;
      const key = cls || t.name;
      if (seen.has(key)) continue;
      seen.add(key);
      r.report('wide-tracking', doc.file, t.line, `"${trunc(text, 32)}" typed in capitals${px != null ? ` at ${Math.round(px)}px` : ''}${tracked ? ` tracked ${em3(em)}em` : ''} (<${t.name}${cls ? ` class="${trunc(cls, 24)}"` : ''}>)`,
        { fix: 'sentence case in the body face; capitals survive only as a wordmark or as the display voice' });
    }
  }
}

export function run(ctx: LintContext, r: Reporter): void {
  check1(ctx, r);
  bannedFont(ctx, r);
  check25(ctx, r);
  check37(ctx, r);
  check38a(ctx, r);
  check38c(ctx, r);
  check55(ctx, r);
  check64(ctx, r);
  check67(ctx, r);
  check67Html(ctx, r);
}
