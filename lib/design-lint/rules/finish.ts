/**
 * Finish rules of the design lint (sloplint gates F1-F9 F15 F16 F21-F24; Nutlope/hallmark,
 * MIT, see NOTICE.md), rewritten in gstack's voice. Rule ids: straight-quotes, three-dot-ellipsis, balanced-display-head, two-primary-buttons, icon-coin, display-figures-tabular, stamped-recipe, scroll-choreography-mix, fake-avatar, stock-person-photo, page-invariants, unthemed-browser-surfaces, skipped-heading, justified-text, missing-lang, hairline-under-shadow.
 * Everything here is polish except fake-avatar, which blocks. F17 to F20 are render-only and
 * live in the render tier; the title and description halves of F23 are the copy tier's.
 */
import { mergedRules, type LintContext } from '../context';
import { HEADING_SEL, isTokenRule, lineIndex, pxOf, resolveVars, splitTop, type MergedRule } from '../css';
import { getAttr, maskedProse, openTags, plainText } from '../html';
import { trunc, type Reporter } from '../report';
import { twVariants } from '../tailwind';

/** The largest px, rem or em length in a value, at a 16px root; null when it has none. */
// sloplint maxPxIn
function maxPxIn(value: string): number | null {
  let best: number | null = null;
  for (const m of value.matchAll(/(-?\d*\.?\d+)(px|rem|em)/g)) {
    const px = m[2] === 'px' ? parseFloat(m[1]) : parseFloat(m[1]) * 16;
    if (best == null || px > best) best = px;
  }
  return best;
}

// sloplint baseSelector
const baseSelector = (sel: string): string => sel.replace(/::?[a-z-]+(\([^)]*\))?/gi, '').replace(/\s+/g, ' ').trim();

const firstFile = (ctx: LintContext): string | null => ctx.cssFiles[0]?.file || ctx.docs[0]?.file || null;


// sloplint checkF1 (F1)
function checkStraightQuotes(ctx: LintContext, r: Reporter): void {
  const dq = /(?:"|&quot;|&#0?34;)(?=[A-Za-z])|[A-Za-z](?:"|&quot;|&#0?34;)/g;
  const ap = /[A-Za-z](?:'|&#0?39;|&apos;)(?=[A-Za-z])/g;
  for (const doc of ctx.docs) {
    const prose = maskedProse(doc);
    const hits = [...prose.matchAll(dq), ...prose.matchAll(ap)].sort((a, b) => a.index! - b.index!);
    if (!hits.length) continue;
    const at = hits[0].index!;
    const around = prose.slice(Math.max(0, at - 16), at + 16).replace(/\s+/g, ' ').trim();
    r.report('straight-quotes', doc.file, doc.lineOf(at), hits.length + ' straight quote' + (hits.length === 1 ? '' : 's') + ' in prose (first: ' + trunc(around, 40) + ')', { fix: 'typographic quotes: \u201C \u201D \u2019' });
  }
}

// sloplint checkF2 (F2)
function checkEllipsis(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const prose = maskedProse(doc);
    const hits = [...prose.matchAll(/\.{3,}/g)];
    if (hits.length) r.report('three-dot-ellipsis', doc.file, doc.lineOf(hits[0].index!), hits.length + ' three-dot ellips' + (hits.length === 1 ? 'is' : 'es') + ' in prose', { fix: 'the ellipsis character (\u2026)' });
  }
}

// sloplint checkF3 (F3)
function checkBalancedHeads(ctx: LintContext, r: Reporter): void {
  const H12 = /(^|[\s,>+~(])h[12]\b/i;
  const targets: MergedRule[] = [];
  let satisfied = false;
  for (const rule of mergedRules(ctx)) {
    const isH12 = H12.test(rule.selector);
    const isDisplayClass = HEADING_SEL.test(rule.selector) && rule.decls.some((d) => d.prop === 'font-size' && (maxPxIn(resolveVars(d.value, ctx.tokens)) ?? 0) >= 40);
    if (!isH12 && !isDisplayClass) continue;
    targets.push(rule);
    if (rule.decls.some((d) => /^text-wrap(-style)?$/.test(d.prop) && /balance/.test(d.value))) satisfied = true;
  }
  if (targets.length && !satisfied) {
    r.report('balanced-display-head', targets[0].file, targets[0].line, 'no text-wrap: balance on any display head (' + targets.length + ' head rules, the first ' + trunc(targets[0].selector, 32) + ')', { fix: 'text-wrap: balance on the h1 and h2 level heads' });
  }
}

// sloplint checkF4 (F4): the recipe count; the side-by-side half is rules/chrome-copy.ts
function checkPrimaryRecipes(ctx: LintContext, r: Reporter): void {
  const BTN = /\b(btn|button|cta)\b|__(btn|button|cta)\b/i;
  const filled = new Map<string, { rule: MergedRule; line: number }>();
  for (const rule of mergedRules(ctx)) {
    if (isTokenRule(rule) || /:hover|:active|:focus|:disabled|\.is-|\[disabled/i.test(rule.selector)) continue;
    const first = baseSelector(rule.selector.split(',')[0]);
    if (!BTN.test(first)) continue;
    for (const d of rule.decls) {
      if (!/^background(-color)?$/.test(d.prop)) continue;
      if (/transparent|none/i.test(resolveVars(d.value, ctx.tokens))) continue;
      if (/var\(\s*--color-(?!paper|rule|muted|focus)[\w-]+/.test(d.value) && !filled.has(first)) filled.set(first, { rule, line: d.line });
    }
  }
  if (filled.size < 2) return;
  const sels = [...filled.keys()];
  const second = filled.get(sels[1])!;
  r.report('two-primary-buttons', second.rule.file, second.line, filled.size + ' filled primary-button recipes on one page: ' + trunc(sels.join(' and '), 52));
}

// sloplint checkF5 (F5)
function checkIconCoins(ctx: LintContext, r: Reporter): void {
  for (const rule of mergedRules(ctx)) {
    if (isTokenRule(rule) || !/icon|\bico\b/i.test(rule.selector)) continue;
    const radius = rule.decls.find((d) => d.prop === 'border-radius');
    if (!radius) continue;
    const rv = resolveVars(radius.value, ctx.tokens);
    const pct = /(\d+(?:\.\d+)?)%/.exec(rv);
    if (!((pct && parseFloat(pct[1]) >= 50) || (maxPxIn(rv) ?? 0) >= 999)) continue;
    const bg = rule.decls.find((d) => /^background(-color)?$/.test(d.prop) && !/^(none|transparent)$/i.test(resolveVars(d.value, ctx.tokens).trim()));
    if (!bg) continue;
    const small = rule.decls.some((d) => (d.prop === 'width' || d.prop === 'height') && (pxOf(resolveVars(d.value, ctx.tokens)) ?? 999) <= 64);
    if (small) r.report('icon-coin', rule.file, bg.line, 'an icon in a coloured coin: ' + trunc(rule.selector, 40), { fix: 'drop the tinted coin; the icon at text size in currentColor' });
  }
}

// sloplint checkF6 (F6)
function checkTabularFigures(ctx: LintContext, r: Reporter): void {
  const NUM_SEL = /\b(stat(?!ement)|price|table|figure|count|num)[\w-]*/i;
  const hasTnum = (rule: { decls: MergedRule['decls'] }): boolean => rule.decls.some((d) => d.prop === 'font-variant-numeric' || (d.prop === 'font-feature-settings' && /tnum/.test(d.value)));
  if (ctx.rules.some((rule) => /^(html|body|:root)\b/i.test(rule.selector.trim()) && hasTnum(rule))) return;
  const bySel = mergedRules(ctx);
  const covered = new Set(bySel.filter(hasTnum).map((rule) => baseSelector(rule.selector)));
  const warned = new Set<string>();
  for (const rule of bySel) {
    if (isTokenRule(rule) || !NUM_SEL.test(rule.selector)) continue;
    const base = baseSelector(rule.selector);
    if (warned.has(base) || covered.has(base)) continue;
    const size = rule.decls.find((d) => d.prop === 'font-size');
    if (!size || (maxPxIn(resolveVars(size.value, ctx.tokens)) ?? 0) < 24) continue;
    warned.add(base);
    r.report('display-figures-tabular', rule.file, size.line, 'figures on ' + trunc(base, 36) + ' at display size without tabular numerals');
  }
}

// sloplint checkF7 (F7)
function checkStampedRecipe(ctx: LintContext, r: Reporter): void {
  const byKey = new Map<string, { sels: Set<string>; rule: MergedRule }>();
  for (const rule of mergedRules(ctx)) {
    if (isTokenRule(rule) || /::(before|after)/.test(rule.selector)) continue;
    const get = (re: RegExp): string => {
      const d = rule.decls.filter((x) => re.test(x.prop)).pop();
      return d ? resolveVars(d.value, ctx.tokens).replace(/\s+/g, ' ').trim() : '';
    };
    const border = get(/^border$/) || [get(/^border-width$/), get(/^border-style$/), get(/^border-color$/)].filter(Boolean).join(' ');
    const radius = get(/^border-radius$/);
    const surface = get(/^background(-color)?$/);
    const shadow = get(/^box-shadow$/);
    if (!radius || (!border && !surface && !shadow)) continue;
    const key = [border, radius, surface, shadow].join(' | ');
    if (!byKey.has(key)) byKey.set(key, { sels: new Set(), rule });
    for (const part of rule.selector.split(',')) byKey.get(key)!.sels.add(baseSelector(part));
  }
  for (const v of byKey.values()) {
    if (v.sels.size < 6) continue;
    r.report('stamped-recipe', v.rule.file, v.rule.line, 'one container recipe on ' + v.sels.size + ' selectors (' + trunc([...v.sels].slice(0, 4).join(', '), 48) + ' and more)', { fix: 'vary weight, radius or fill by role; not every box is the same box' });
  }
}

// sloplint checkF7Pills (F7)
function checkPillRadius(ctx: LintContext, r: Reporter): void {
  const CONTROLISH = /btn|button|cta|input|select|textarea|switch|toggle|control|chip|pill|tag|badge|status/i;
  const sels = new Set<string>();
  let where: { rule: MergedRule; line: number } | null = null;
  for (const rule of mergedRules(ctx)) {
    if (isTokenRule(rule)) continue;
    const d = rule.decls.filter((x) => x.prop === 'border-radius').pop();
    if (!d || !/^(9999px|999px|50rem)$/.test(resolveVars(d.value, ctx.tokens).trim())) continue;
    for (const part of rule.selector.split(',')) {
      const b = baseSelector(part);
      if (!b || CONTROLISH.test(b)) continue;
      sels.add(b);
      where = where || { rule, line: d.line };
    }
  }
  if (sels.size >= 5 && where) r.report('stamped-recipe', where.rule.file, where.line, 'the pill radius on ' + sels.size + ' non-control selectors (' + trunc([...sels].slice(0, 4).join(', '), 48) + ')', { fix: 'pills on controls, tags and badges; boxes and media take the card radius' });
}

// sloplint checkF8 (F8)
function checkScrollChoreography(ctx: LintContext, r: Reporter): void {
  const famOf = (sel: string): string => {
    const m = /\.([a-z][\w-]*)/i.exec(sel) || /(^|[\s>+~])([a-z][\w-]*)/i.exec(sel);
    const name = m ? (m[1] || m[2]) : sel;
    return name.split('__')[0].split('--')[0].toLowerCase();
  };
  const NAVISH = /^(nav|header|topbar|masthead|banner)$/;
  type Site = { rule: MergedRule | typeof ctx.rules[number]; line: number };
  const timeline = new Map<string, Site>(), sticky = new Map<string, Site>(), animated = new Set<string>();
  for (const rule of ctx.rules) {
    if (rule.keyframes || isTokenRule(rule)) continue;
    for (const d of rule.decls) {
      if (d.prop === 'animation-timeline' && !/^(none|auto)$/i.test(d.value.trim()) && !timeline.has(famOf(rule.selector))) timeline.set(famOf(rule.selector), { rule, line: d.line });
      if (d.prop === 'animation' || d.prop === 'animation-name') animated.add(famOf(rule.selector));
      if (d.prop === 'position' && /sticky/i.test(d.value)) sticky.set(famOf(rule.selector), { rule, line: d.line });
    }
  }
  const families = new Map(timeline);
  for (const [fam, v] of sticky) if (!families.has(fam) && animated.has(fam) && !NAVISH.test(fam)) families.set(fam, v);
  if (families.size < 2) return;
  const names = [...families.keys()];
  const second = families.get(names[1])!;
  r.report('scroll-choreography-mix', second.rule.file, second.line, families.size + ' scroll-choreography patterns on one page (' + trunc(names.join(', '), 44) + ')', { fix: 'one scroll pattern a page; cut the rest' });
}

const FAKE_AVATAR = /(i\.pravatar\.cc|pravatar\.cc|api\.dicebear\.com|dicebear\.com|randomuser\.me|thispersondoesnotexist\.com|ui-avatars\.com)/i;
/** Each URL token is scanned once (a scheme is only tried at a token start), so a run of scheme prefixes costs its length. */
const UNSPLASH_URL = /(?<![^"'()\s])https?:\/\/[^"'()\s]*unsplash\.com[^"'()\s]*/gi;
const PERSONY = /person|face|portrait|people|headshot/i;

// sloplint checkF9 (F9)
function checkAvatars(ctx: LintContext, r: Reporter): void {
  const scan = (text: string, file: string, lineAt: (i: number) => number): void => {
    const f = FAKE_AVATAR.exec(text);
    if (f) r.report('fake-avatar', file, lineAt(f.index), 'a generated-face service (' + f[1] + ') stands in for a person', { fix: 'the real person\'s own photo, initials, or no portrait; a generated stranger is fabricated social proof' });
    for (const m of text.matchAll(UNSPLASH_URL)) {
      if (PERSONY.test(m[0])) r.report('stock-person-photo', file, lineAt(m.index!), 'a stock person-keyword URL ' + trunc(m[0], 44), { fix: 'faces as social proof need real people; a stock face is a stranger' });
    }
  };
  for (const doc of ctx.docs) scan(doc.src, doc.file, (i) => doc.lineOf(i));
  for (const c of ctx.cssFiles) scan(c.raw, c.file, lineIndex(c.raw));
}

// sloplint trackCount
function trackCount(v: string): number {
  const t = v.replace(/\[[^\]]*\]/g, ' ').trim();
  const rep = /^repeat\(\s*(\d+)/.exec(t);
  if (rep) return Number(rep[1]);
  let depth = 0, n = 0, inTok = false;
  for (const ch of t) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && /\s/.test(ch)) inTok = false;
    else if (!inTok) { inTok = true; n++; }
  }
  return n;
}

// sloplint checkF15 (F15)
function checkPageInvariants(ctx: LintContext, r: Reporter): void {
  const file = firstFile(ctx);
  if (!file) return;
  const widths = new Map<number, string>();
  for (const rule of ctx.rules) {
    if (rule.keyframes || rule.media || !/container|wrap|inner|shell|content|section|page|main/i.test(rule.selector)) continue;
    for (const d of rule.decls) {
      if (d.prop !== 'max-width') continue;
      const px = maxPxIn(resolveVars(d.value, ctx.tokens));
      if (px && px >= 900) widths.set(px, rule.selector);
    }
  }
  if (widths.size > 1) r.report('page-invariants', file, 1, widths.size + ' container widths on one page (' + [...widths.keys()].join(', ') + 'px)', { fix: 'one container width, applied the same way in every section' });
  const gaps = new Map<string, string>();
  for (const rule of ctx.rules) {
    if (rule.keyframes || rule.media || /hero|masthead|fold|\b(?:app|ui|demo|sample|screen|product|mock|device|console|editor|window)(?:\b|__|--)|\[data-slot/i.test(rule.selector)) continue;
    const cols = rule.decls.find((d) => d.prop === 'grid-template-columns' && trackCount(d.value) > 1 && !/^repeat\(\s*auto/.test(d.value.trim()));
    if (!cols) continue;
    const gap = rule.decls.find((d) => /^(gap|column-gap)$/.test(d.prop));
    if (!gap) continue;
    const v = resolveVars(gap.value, ctx.tokens).split(/\s+/).pop()!;
    const px = maxPxIn(v);
    if (px != null && px >= 24) gaps.set(v, rule.selector);
  }
  if (gaps.size > 2) r.report('page-invariants', file, 1, gaps.size + ' different column gaps across multi-column sections (' + [...gaps.keys()].join(', ') + ')', { fix: 'one column gap for every multi-column section' });
}

// sloplint checkF16 (F16)
function checkBrowserSurfaces(ctx: LintContext, r: Reporter): void {
  const file = firstFile(ctx);
  if (!file || ctx.tokensOnly || !ctx.tokens['--color-accent']) return;
  const classes = ctx.docs.map((d) => [...d.src.matchAll(/class(?:Name)?\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]).join(' ')).join(' ');
  const missing: string[] = [];
  if (!/::selection/.test(ctx.allCss) && !twVariants(ctx).has('selection') && !/(?<![\w-])selection:/.test(classes)) missing.push('::selection');
  if (!/scrollbar-color|::-webkit-scrollbar/.test(ctx.allCss) && !/(?<![\w-])\[?scrollbar/.test(classes)) missing.push('scrollbar-color');
  const hasInputs = ctx.docs.some((d) => /<(input|textarea)\b/i.test(d.src));
  if (hasInputs && !/caret-color/.test(ctx.allCss) && !/(?<![\w-])caret-/.test(classes)) missing.push('caret-color');
  if (missing.length) r.report('unthemed-browser-surfaces', file, 1, 'browser surfaces left unthemed: ' + missing.join(', '), { fix: 'theme the parts you did not draw from the palette' });
}

// sloplint checkF21 (F21)
function checkHeadingLevels(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    if (doc.kind !== 'html') continue;
    let prev = 0;
    for (const head of openTags(doc, /^h[1-6]$/)) {
      const level = Number(head.tag.name.slice(1));
      if (prev && level > prev + 1) {
        r.report('skipped-heading', doc.file, head.tag.line, 'h' + prev + ' is followed by h' + level + ' ("' + trunc(plainText(head.inner), 32) + '")', { fix: 'step the levels one at a time; size a head with CSS, never with its level' });
        break;
      }
      prev = level;
    }
  }
}

// sloplint checkF22 (F22)
function checkJustifiedText(ctx: LintContext, r: Reporter): void {
  for (const rule of ctx.rules) {
    const j = rule.decls.find((d) => d.prop === 'text-align' && /^justify\b/.test(d.value.trim()));
    if (j && !rule.decls.some((d) => d.prop === 'hyphens' && /auto/.test(d.value))) { r.report('justified-text', rule.file, j.line, 'justified text without hyphenation on ' + rule.selector); return; }
  }
  for (const doc of ctx.docs) {
    const m = /class(?:Name)?\s*=\s*["'][^"']*(?<![\w-])text-justify(?![\w-])/.exec(doc.src);
    if (m && !/(?<![\w-])hyphens-auto(?![\w-])/.test(doc.src)) { r.report('justified-text', doc.file, doc.lineOf(m.index), 'justified text without hyphenation (text-justify)', { fix: 'hyphens-auto, or left-aligned' }); return; }
  }
}

// sloplint checkF23 (F23), the lang half; the title and description are the copy tier's
function checkLang(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    if (doc.kind !== 'html') continue;
    const html = /<html\b([^>]*)>/i.exec(doc.src);
    if (!html) continue;
    if (!getAttr(html[1], 'lang')) r.report('missing-lang', doc.file, doc.lineOf(html.index), '<html> names no lang');
  }
}

// sloplint checkF24 (F24)
function checkHairlineUnderShadow(ctx: LintContext, r: Reporter): void {
  const wide = (value: string): boolean => splitTop(resolveVars(value, ctx.tokens)).some((layer) => {
    if (/\binset\b/.test(layer)) return false;
    const len = [...layer.replace(/(?:oklch|oklab|rgba?|hsla?|color|color-mix)\([^)]*\)/g, '').matchAll(/(-?\d*\.?\d+)(px|rem|em)?(?=\s|$)/g)].map((m) => parseFloat(m[1]) * (m[2] === 'rem' || m[2] === 'em' ? 16 : 1));
    return len.length >= 3 && len[2] + Math.min(0, len[3] || 0) >= 24;
  });
  for (const rule of ctx.rules) {
    const sh = rule.decls.find((d) => d.prop === 'box-shadow' && d.value.trim() !== 'none');
    if (!sh || !wide(sh.value)) continue;
    const edge = rule.decls.find((d) => /^border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$/.test(d.prop) && /(?:^|\s)(?:1px|0\.5px|thin|var\(--rule-hair\))(?:\s|$)/.test(d.value) && !/\b(?:none|transparent)\b/.test(d.value));
    if (edge) { r.report('hairline-under-shadow', rule.file, sh.line, 'a hairline border under a wide soft shadow on ' + rule.selector); return; }
  }
  for (const doc of ctx.docs) {
    for (const t of [...doc.tags, ...doc.comps]) {
      if (t.close) continue;
      const toks = (getAttr(t.attrs, 'class') ?? getAttr(t.attrs, 'className') ?? '').split(/\s+/);
      if (!toks.includes('border') || !(toks.includes('shadow-xl') || toks.includes('shadow-2xl'))) continue;
      r.report('hairline-under-shadow', doc.file, t.line, 'a hairline border under a wide soft shadow (border with shadow-xl or shadow-2xl)');
      return;
    }
  }
}

export function run(ctx: LintContext, r: Reporter): void {
  checkStraightQuotes(ctx, r);
  checkEllipsis(ctx, r);
  checkBalancedHeads(ctx, r);
  checkPrimaryRecipes(ctx, r);
  checkIconCoins(ctx, r);
  checkTabularFigures(ctx, r);
  checkStampedRecipe(ctx, r);
  checkPillRadius(ctx, r);
  checkScrollChoreography(ctx, r);
  checkAvatars(ctx, r);
  checkPageInvariants(ctx, r);
  checkBrowserSurfaces(ctx, r);
  checkHeadingLevels(ctx, r);
  checkJustifiedText(ctx, r);
  checkLang(ctx, r);
  checkHairlineUnderShadow(ctx, r);
}
