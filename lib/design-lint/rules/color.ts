/**
 * Colour rules of the design lint (sloplint gates 2a 2b 7a 7b 22 23 29 48 65 74; Nutlope/hallmark,
 * MIT, see NOTICE.md), rewritten in gstack's voice. Rule ids: purple-blue-gradient, gradient-text, pure-black-white, absolute-surface-token, zero-chroma-neutrals, accent-footprint, glow-wash, cream-palette, framework-palette, literal-outside-tokens (48).
 *
 * hallmark's theme stamp is gone: no colour posture is ever declared, no
 * genre exempts a page, no theme is pinned by name, so every check here runs
 * in its strict form.
 */
import { bannedGradient, COLOR_LITERAL, oklchOf, parseColor } from '../color';
import type { LintContext } from '../context';
import { mergedRules } from '../context';
import { firstFamily, GENERIC_FAMILIES, isTokenRule, pxOf, resolveVars, splitTop, type CssDecl, type MergedRule, type Tokens } from '../css';
import type { Reporter } from '../report';
import { trunc } from '../report';

const COLOR_FN = /#[0-9a-fA-F]{3,8}\b|oklch\([^)]*\)|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

// sloplint gradientHues (gate 2)
function gradientHues(value: string, tokens: Tokens): number[] {
  const hues: number[] = [];
  for (const m of resolveVars(value, tokens).matchAll(COLOR_FN)) {
    const c = parseColor(m[0]);
    if (!c || c.alpha <= 0.05) continue;
    const ok = oklchOf(c);
    if (ok.C > 0.04) hues.push(ok.H);
  }
  return hues;
}

interface GradientText { r: MergedRule; clip: CssDecl; grad: CssDecl | undefined }

// sloplint gradientTextRules (gate 2b)
function gradientTextRules(ctx: LintContext): GradientText[] {
  const out: GradientText[] = [];
  for (const r of mergedRules(ctx)) {
    const clip = r.decls.find((d) => /background-clip/.test(d.prop) && /\btext\b/i.test(d.value));
    if (!clip) continue;
    const grad = r.decls.find((d) => /^background(-image)?$/.test(d.prop) && /gradient\(/i.test(d.value));
    const transparent = r.decls.find((d) => (d.prop === 'color' || d.prop === '-webkit-text-fill-color') && /transparent/i.test(d.value));
    if (grad || transparent) out.push({ r, clip, grad });
  }
  return out;
}

// sloplint withoutPatterns (gate 2): repeating gradients draw stripes and grain, not a wash
function withoutPatterns(value: string): string {
  let out = '', i = 0;
  const re = /repeating-(?:linear|radial|conic)-gradient\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    out += value.slice(i, m.index);
    let depth = 1, k = m.index + m[0].length;
    while (k < value.length && depth > 0) { if (value[k] === '(') depth++; else if (value[k] === ')') depth--; k++; }
    i = k; re.lastIndex = k;
  }
  return out + value.slice(i);
}

// sloplint check2 (gates 2a, 2b)
function check2(ctx: LintContext, r: Reporter): void {
  const textRules = new Set<string>();
  for (const { r: rule, clip, grad } of gradientTextRules(ctx)) {
    textRules.add(rule.selector);
    const banned = grad ? bannedGradient(gradientHues(grad.value, ctx.tokens), ctx.tokens) : null;
    if (banned) r.report('purple-blue-gradient', rule.file, clip.line, `${banned} gradient text on ${rule.selector}`);
    else r.report('gradient-text', rule.file, clip.line, `gradient text on ${rule.selector}`);
  }
  for (const rule of ctx.rules) {
    if (textRules.has(rule.selector)) continue;
    for (const d of rule.decls) {
      if (!/gradient\(/i.test(d.value)) continue;
      const washes = withoutPatterns(d.value);
      if (!/gradient\(/i.test(washes)) continue;
      const banned = bannedGradient(gradientHues(washes, ctx.tokens), ctx.tokens);
      if (banned) r.report('purple-blue-gradient', rule.file, d.line, `${banned} gradient on ${rule.selector}`, { fix: 'one anchor hue; drop the gradient' });
    }
  }
}

// sloplint check7 (gates 7a, 7b)
function check7(ctx: LintContext, r: Reporter): void {
  const props = /^(color|background|background-color|border-color|outline-color)$|^--color-/;
  for (const rule of ctx.rules) {
    if (rule.selector === '@font-face') continue;
    for (const d of rule.decls) {
      if (!props.test(d.prop)) continue;
      const c = parseColor(resolveVars(d.value, ctx.tokens).trim());
      if (!c || c.alpha < 1) continue;
      const isWhite = c.r > 0.999 && c.g > 0.999 && c.b > 0.999;
      const isBlack = c.r < 0.001 && c.g < 0.001 && c.b < 0.001;
      if (!isWhite && !isBlack) continue;
      const viaToken = d.prop.startsWith('--') || /var\(/.test(d.value);
      r.report(viaToken ? 'absolute-surface-token' : 'pure-black-white', rule.file, d.line,
        `${d.prop}: ${trunc(d.value, 28)} on ${rule.selector} is pure ${isBlack ? 'black (#000)' : 'white (#fff)'}`);
    }
  }
}

// sloplint check22 (gate 22)
function check22(ctx: LintContext, r: Reporter): void {
  const MASK_PROPS = /(^|-)mask(-image|-composite|-mode)?$|^filter$|^backdrop-filter$/;
  for (const rule of ctx.rules) {
    for (const d of rule.decls) {
      if (MASK_PROPS.test(d.prop)) continue;
      const re = /oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+[\d.]+(?:deg)?\s*(?:\/\s*([\d.]+%?))?\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(d.value))) {
        const chroma = parseFloat(m[2]);
        const alpha = m[3] ? (m[3].endsWith('%') ? parseFloat(m[3]) / 100 : parseFloat(m[3])) : 1;
        if (chroma === 0 && alpha >= 1) r.report('zero-chroma-neutrals', rule.file, d.line, `zero-chroma ${m[0]} as ${d.prop} on ${rule.selector}`);
      }
    }
  }
}

// sloplint check23 (gate 23): no colour posture is ever declared, so every large accent fill is a finding
function check23(ctx: LintContext, r: Reporter): void {
  const ACC = /var\(\s*--color-accent(?:-2)?\s*[,)]/;
  const SURFACE = /(^|[\s,>~+])(body|html|main|section|header|footer|aside)(\b|$)|\bhero\b|__hero|banner|\bstrip\b|\bband\b/i;
  const big = (decls: CssDecl[]) => decls.some((d) =>
    (/^(min-)?height$/.test(d.prop) && (parseFloat((/([\d.]+)\s*(vh|dvh|svh)/.exec(d.value) || [])[1] || '0') >= 40 || (pxOf(d.value) ?? 0) >= 320)) ||
    (d.prop === 'inset' && /^0(px)?(\s|$)/.test(d.value.trim())));
  for (const rule of ctx.rules) {
    if (isTokenRule(rule) || rule.keyframes) continue;
    for (const d of rule.decls) {
      if (!/^background(-color|-image)?$/.test(d.prop) || !ACC.test(d.value)) continue;
      if (/\/\s*0?\.[0-2]\d*/.test(d.value)) continue;
      if (SURFACE.test(rule.selector) || big(rule.decls)) {
        r.report('accent-footprint', rule.file, d.line, `accent background on the viewport-scale rule "${trunc(rule.selector, 44)}"`,
          { fix: 'retreat the accent to actions and one signal; a large fill belongs to the paper or a field token' });
      }
    }
    const col = rule.decls.find((d) => d.prop === 'color' && ACC.test(d.value));
    const fsDecl = rule.decls.find((d) => d.prop === 'font-size');
    if (!col || !fsDecl) continue;
    const rv = resolveVars(fsDecl.value, ctx.tokens);
    const clampMax = /,\s*([^,()]+)\)\s*$/.exec(rv);
    const maxPx = pxOf(rv) ?? (clampMax ? pxOf(clampMax[1].trim()) : null);
    if ((maxPx != null && maxPx >= 48) || /--text-display\b/.test(fsDecl.value)) {
      r.report('accent-footprint', rule.file, col.line, `display-size text set in the accent on "${trunc(rule.selector, 44)}"`,
        { fix: 'set display type in ink; the accent marks small signals' });
    }
  }
}

const lengthPx = (x: string): number | null => (x === '0' ? 0 : pxOf(x));

// sloplint check29Glow (gate 29): no atmospheric exemption
function check29Glow(ctx: LintContext, r: Reporter): void {
  const seen = new Set<string>();
  const once = (key: string, file: string, line: number, ev: string, fix: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    r.report('glow-wash', file, line, ev, { fix });
  };
  for (const rule of mergedRules(ctx)) {
    if (isTokenRule(rule)) continue;
    const local: Tokens = {};
    for (const d of rule.decls) if (d.prop.startsWith('--')) local[d.prop] = d.value;
    const name = trunc(rule.selector, 36);
    const bf = rule.decls.find((d) => /^(-webkit-)?backdrop-filter$/.test(d.prop) && /blur\(/i.test(d.value));
    if (bf) {
      const bgD = rule.decls.filter((d) => /^background(-color)?$/.test(d.prop)).pop();
      const rv = bgD ? resolveVars(bgD.value, ctx.tokens, local).trim() : '';
      const c = parseColor(rv);
      const mixed = /color-mix\([^)]*\b(white|black|--color-(paper|ink))\b[^)]*\btransparent\b/i.exec(rv);
      const nearWhite = !!c && c.r > 0.85 && c.g > 0.85 && c.b > 0.85;
      const nearBlack = c ? c.r < 0.15 && c.g < 0.15 && c.b < 0.15 : !!mixed && /^(black|--color-ink)$/i.test(mixed[1]);
      if ((c && c.alpha < 0.95 && (nearWhite || nearBlack)) || (!c && mixed)) {
        once('glass:' + rule.selector, rule.file, bf.line, `glass panel: backdrop-filter blur over a translucent ${nearBlack ? 'black' : 'white'} on ${name}`, 'a solid or grained surface; elevation by lightness');
      }
    }
    for (const d of rule.decls) {
      if (d.prop !== 'box-shadow') continue;
      for (const part of splitTop(resolveVars(d.value, ctx.tokens, local))) {
        const cm = COLOR_LITERAL.exec(part);
        if (!cm) continue;
        const c = parseColor(cm[0]);
        if (!c || c.alpha <= 0.05 || oklchOf(c).C <= 0.04) continue;
        const lens = part.replace(cm[0], ' ').replace(/\binset\b/, ' ').trim().split(/\s+/).filter(Boolean).map(lengthPx);
        if (lens.length >= 3 && lens[0] === 0 && lens[1] === 0 && lens[2] != null && lens[2] > 20) {
          once('glow:' + rule.selector, rule.file, d.line, `coloured zero-offset glow (blur ${Math.round(lens[2])}px) on ${name}`, 'shadows carry offset and blur in a neutral; colour is not depth');
          break;
        }
      }
    }
    if (!/::(before|after)/.test(rule.selector) || !rule.decls.some((d) => d.prop === 'position' && /absolute|fixed/.test(d.value))) continue;
    const f = rule.decls.find((d) => d.prop === 'filter' && /blur\(\s*(\d+(?:\.\d+)?)px/i.test(d.value));
    const n = f ? parseFloat(/blur\(\s*(\d+(?:\.\d+)?)px/i.exec(f.value)![1]) : 0;
    if (f && n > 40) once('orb:' + rule.selector, rule.file, f.line, `blurred orb: filter blur(${n}px) on the positioned ${name}`, 'delete the wash; a surface is paper or ground, not a light show');
  }
}

const HIGH_CONTRAST_SERIF = /bodoni|didot|didone|playfair|fraunces|instrument serif|cormorant|dm serif|libre caslon display|abril|prata|gloock|newsreader|editorial new|gt sectra|canela|freight|yeseva|rozha|boska|melodrama/i;

// sloplint check65 (gate 65): the look is never pinned by name here
function check65(ctx: LintContext, r: Reporter): void {
  const paper = parseColor(resolveVars(ctx.tokens['--color-paper'] || '', ctx.tokens));
  const accent = parseColor(resolveVars(ctx.tokens['--color-accent'] || '', ctx.tokens));
  if (!paper || !accent) return;
  const p = oklchOf(paper), a = oklchOf(accent);
  const cream = p.L >= 0.9 && p.C >= 0.006 && p.H >= 55 && p.H <= 105;
  const clay = a.C >= 0.08 && a.H >= 15 && a.H <= 55;
  const disp = firstFamily(resolveVars(ctx.tokens['--font-display'] || '', ctx.tokens));
  if (!cream || !clay || !HIGH_CONTRAST_SERIF.test(disp)) return;
  r.report('cream-palette', ctx.cssFiles[0]?.file || ctx.docs[0]?.file || ctx.key, 1,
    `the default tasteful look: cream paper (L ${Math.round(p.L * 100)}%, hue ${Math.round(p.H)}), ${disp} as the display and a clay accent (hue ${Math.round(a.H)})`);
}

const TAILWIND_HEX = /#(0f172a|1e293b|6366f1|8b5cf6|3b82f6|f8fafc|64748b)\b/i;

// sloplint check65Tailwind (gate 74, the token half; palette utility classes belong to the Tailwind rules)
function check74Tokens(ctx: LintContext, r: Reporter): void {
  for (const rule of ctx.rules) {
    if (!isTokenRule(rule) || rule.selector === '@font-face') continue;
    for (const d of rule.decls) {
      const m = TAILWIND_HEX.exec(d.value);
      if (m) r.report('framework-palette', rule.file, d.line, `Tailwind's default ${m[0]} as ${d.prop}`);
    }
  }
}

const COLOR_LIT_TEST = /#[0-9a-fA-F]{3,8}\b|(?<![\w-])rgba?\(|(?<![\w-])hsla?\(|(?<![\w-])oklch\(/;

// sloplint check48 (gate 48); hallmark's scaffold placeholder ("FILL ME") has no counterpart here.
// hallmark lints pages its own skill scaffolded, which always carry a token block; gstack also meets
// handwritten pages with no tokens at all, where a literal bypasses nothing, so the rule needs a
// --color-* or --font-* token to exist before a literal counts as a bypass.
function check48(ctx: LintContext, r: Reporter): void {
  if (!Object.keys({ ...ctx.twTokens, ...ctx.tokens }).some((k) => /^--(color|font)-/.test(k))) return;
  for (const rule of ctx.rules) {
    if (isTokenRule(rule)) continue;
    for (const d of rule.decls) {
      if (d.prop.startsWith('--')) continue;
      if (d.prop === 'font-family') {
        if (d.value.includes('var(') || GENERIC_FAMILIES.has(firstFamily(d.value))) continue;
        r.report('literal-outside-tokens', rule.file, d.line, `font-family literal "${trunc(d.value, 36)}" on ${rule.selector}`);
        continue;
      }
      if (!COLOR_LIT_TEST.test(d.value)) continue;
      for (const m of d.value.matchAll(COLOR_FN)) {
        const c = parseColor(m[0]);
        if (!c || c.alpha === 0) continue;
        r.report('literal-outside-tokens', rule.file, d.line, `colour literal ${trunc(m[0], 30)} outside the token block (${d.prop} on ${trunc(rule.selector, 30)})`);
      }
    }
  }
  for (const doc of ctx.docs) {
    for (const m of doc.src.matchAll(/style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const lit = new RegExp(COLOR_FN.source).exec(m[1] ?? m[2]);
      if (lit && parseColor(lit[0])) r.report('literal-outside-tokens', doc.file, doc.lineOf(m.index!), `inline style colour literal ${trunc(lit[0], 30)}`);
    }
  }
}

export function run(ctx: LintContext, r: Reporter): void {
  check2(ctx, r);
  check7(ctx, r);
  check22(ctx, r);
  check23(ctx, r);
  check29Glow(ctx, r);
  check65(ctx, r);
  check74Tokens(ctx, r);
  check48(ctx, r);
}
