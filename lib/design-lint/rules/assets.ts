/**
 * Assets rules of the design lint (sloplint gates 30a 30b 33 40 41 49a 49b 76; Nutlope/hallmark,
 * MIT, see NOTICE.md), rewritten in gstack's voice. Rule ids: emoji-decoration, two-icon-libraries, unlabeled-decoration, low-contrast, gray-on-color, button-label-wraps, link-wraps, broken-image, stock-photo-hotlink.
 * The static tier can only suspect contrast and wrapping (it has no painted pixels and no
 * widths), so low-contrast, gray-on-color and button-label-wraps report at ask for a person to
 * confirm; the render tier proves them. hallmark's photo library (a credited Commons photo) is
 * not shipped, so the no-credit half of gate 76 is not ported.
 */
import { contrastRatio, oklchOf, parseColor, type Color } from '../color';
import { mergedRules, type LintContext } from '../context';
import { CONTRAST_SLACK, isTokenRule, resolveVars, pxOf, selectorNames, type MergedRule, type Tokens } from '../css';
import { ancestorsOf, getAttr, hasAttr, innerOf, stripTags, textOf, treeOf } from '../html';
import { trunc, type Finding, type Reporter } from '../report';

const EMOJI = /(?![©®™‼⁉←-⇿])\p{Extended_Pictographic}/u;
const GLYPH = /(?![©®™‼⁉←-⇿✓-✖])(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)/u;

// sloplint check30 (gate 30a)
function checkEmojiIcons(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const lines = new Set<number>();
    let n = 0;
    const quoted = (doc.cache.emojiQuoted ??= new Map<string, Finding[]>()) as Map<string, Finding[]>;
    const flag = (line: number, what: string, key?: string): void => {
      if (lines.has(line) || n >= 8) return;
      lines.add(line);
      n++;
      const found = r.report('emoji-decoration', doc.file, line, what);
      if (key && found) { const list = quoted.get(key); if (list) list.push(found); else quoted.set(key, [found]); }
    };
    for (let i = 0; i < doc.tags.length; i++) {
      const t = doc.tags[i];
      if (t.close || t.selfClosing) continue;
      const cls = getAttr(t.attrs, 'class') || '';
      const iconish = /icon|card|step|tier|feature|value|prop|badge/i.test(cls);
      const inner = innerOf(doc, i);
      if (!inner) continue;
      const content = stripTags(inner.inner, false, 4).replace(/\s+/g, ' ').trim();
      if (content && content.length <= 4 && EMOJI.test(content) && (iconish || !/<[a-z]/.test(inner.inner))) {
        flag(t.line, 'an emoji icon "' + content + '" in <' + t.name + ' class="' + trunc(cls, 28) + '">', content);
        lines.add(doc.lineOf(t.end + inner.inner.search(EMOJI)));
        continue;
      }
      if (!/^(h[1-6]|button|a|label|th|summary|option|legend|dt)$/.test(t.name) || /<(p|div|ul|ol|table|section)\b/i.test(inner.inner)) continue;
      const text = textOf(doc, i);
      const at = inner.inner.search(GLYPH);
      if (!text || at < 0) continue;
      flag(doc.lineOf(t.end + at), 'an emoji in <' + t.name + '> "' + trunc(text, 32) + '"', trunc(text, 32));
    }
    const raw = doc.raw;
    const body = doc.masked;
    for (const m of body.matchAll(/>\s*((?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)[^<>{}\n]{0,40})/gu)) flag(doc.lineOf(m.index! + m[0].length - m[1].length), 'text opens with an emoji: "' + trunc(m[1].trim(), 32) + '"', trunc(m[1].trim(), 32));
    for (const m of body.matchAll(/placeholder\s*=\s*["']([^"']*)["']/g)) if (GLYPH.test(m[1])) flag(doc.lineOf(m.index!), 'an emoji in a placeholder "' + trunc(m[1], 28) + '"', trunc(m[1], 28));
    if (doc.kind !== 'html') for (const m of raw.matchAll(/(["'`])\s*((?:(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F?)\u200D?){1,3})\s*\1/gu)) flag(doc.lineOf(m.index!), 'an emoji passed as an icon: ' + m[2]);
  }
}

const ICON_LIBS = new Map<string, RegExp>([
  ['material', /material-icons|material-symbols/i],
  ['heroicons', /heroicon/i],
  ['lucide', /lucide/i],
  ['phosphor', /phosphor|\bph-(?:bold|fill|light|duotone|[a-z]+-[a-z]+)/i],
  ['font-awesome', /font-?awesome|\bfa-(solid|regular|brands|light)\b/i],
  ['feather', /feather-icons|\bfeather\b/i],
  ['tabler', /tabler-icons/i],
  ['bootstrap-icons', /bootstrap-icons|\bbi-[a-z]/i],
]);

/** The class attributes, stylesheet and script references, and @import and url() targets of a context: where an icon library shows, prose left out. */
function iconSurfaces(ctx: LintContext): string {
  const out: string[] = [];
  for (const doc of ctx.docs) {
    for (const t of [...doc.tags, ...doc.comps]) {
      if (t.close) continue;
      const cls = getAttr(t.attrs, 'class') ?? getAttr(t.attrs, 'className');
      if (cls) out.push(cls);
      if (t.name === 'link' || t.name === 'script' || t.name === 'use') out.push(getAttr(t.attrs, 'href') ?? getAttr(t.attrs, 'src') ?? '');
    }
    for (const call of doc.virtuals) out.push(call.toks.join(' '));
    for (const toks of doc.classAt.values()) out.push(toks.join(' '));
    for (const m of doc.scripts.matchAll(/\b(?:import\s*(?:\(\s*)?|require\s*\(\s*|from\s+)['"]([^'"\n]+)['"]/g)) out.push(m[1]);
  }
  for (const f of ctx.cssFiles) for (const m of f.raw.matchAll(/@import\s+(?:url\()?['"]?([^'")\s;]+)|url\(\s*['"]?([^'")]+)/g)) out.push(m[1] ?? m[2]);
  return out.join('\n');
}

// sloplint check30 (gate 30b)
function checkIconLibraries(ctx: LintContext, r: Reporter): void {
  const hay = iconSurfaces(ctx);
  const found = [...ICON_LIBS].filter(([, re]) => re.test(hay)).map(([name]) => name);
  if (found.length < 2) return;
  const file = ctx.docs[0]?.file || ctx.cssFiles[0]?.file;
  if (file) r.report('two-icon-libraries', file, 1, 'icon libraries mixed on one page: ' + found.join(' and '));
}

// sloplint check33 (gate 33)
function checkUnlabeledDecoration(ctx: LintContext, r: Reporter): void {
  const labeled = (a: string): boolean => (getAttr(a, 'aria-hidden') || '').trim().toLowerCase() === 'true' || getAttr(a, 'aria-label') != null
    || getAttr(a, 'aria-labelledby') != null
    || ['img', 'presentation', 'none'].includes((getAttr(a, 'role') || '').toLowerCase());
  for (const doc of ctx.docs) {
    const { parent } = treeOf(doc);
    const labeledAt: boolean[] = [];
    for (let i = 0; i < doc.tags.length; i++) {
      const t = doc.tags[i];
      if (t.close) continue;
      labeledAt[i] = labeled(t.attrs);
      if (t.name !== 'svg' && t.name !== 'canvas') continue;
      const titled = t.name === 'svg' && !t.selfClosing && /<title\b[^>]*>\s*\S/i.test(innerOf(doc, i)?.inner || '');
      let inLabeled = false;
      for (let p = parent[i]; p >= 0 && !inLabeled; p = parent[p]) inLabeled = labeledAt[p];
      if (!labeledAt[i] && !inLabeled && !titled) {
        r.report('unlabeled-decoration', doc.file, t.line, '<' + t.name + '> with neither aria-hidden="true" nor a label');
      }
    }
  }
}

const localTokens = (rule: MergedRule): Tokens => {
  const local: Tokens = {};
  for (const d of rule.decls) if (d.prop.startsWith('--')) local[d.prop] = d.value;
  return local;
};
const bgDecl = (rule: MergedRule) => rule.decls.find((d) => d.prop === 'background-color') || rule.decls.find((d) => d.prop === 'background' && !/gradient|url\(/i.test(d.value));
const withinAStep = (a: Color, b: Color): boolean => {
  const x = oklchOf(a), y = oklchOf(b);
  return Math.abs(x.L - y.L) < 0.05 && Math.abs(x.C - y.C) < 0.05;
};

// sloplint check40_41 (gates 40 and 41), the per-rule pairs
function checkContrastPairs(ctx: LintContext, r: Reporter): void {
  const colorOf = (value: string, local: Tokens): Color | null => parseColor(resolveVars(value, ctx.tokens, local).trim());
  for (const rule of mergedRules(ctx)) {
    const local = localTokens(rule);
    const colorD = rule.decls.find((d) => d.prop === 'color');
    const bgD = bgDecl(rule);
    if (colorD && bgD && !/::selection|::placeholder|::-moz/.test(rule.selector)) {
      const fg = colorOf(colorD.value, local);
      const bg = colorOf(bgD.value, local);
      if (fg && bg && fg.alpha >= 1 && bg.alpha >= 1) {
        const sizeD = rule.decls.find((d) => d.prop === 'font-size');
        const weightD = rule.decls.find((d) => d.prop === 'font-weight');
        const sizePx = sizeD ? pxOf(resolveVars(sizeD.value, ctx.tokens, local)) : null;
        const weightRaw = weightD ? resolveVars(weightD.value, ctx.tokens, local).trim().toLowerCase() : '400';
        const weight = /^(bold|bolder)$/.test(weightRaw) ? 700 : parseInt(weightRaw, 10) || 400;
        const large = sizePx != null && (sizePx >= 24 || (sizePx >= 18 && weight >= 700));
        const threshold = large ? 3.0 : 4.5;
        const ratio = contrastRatio(fg, bg);
        if (ratio < threshold - CONTRAST_SLACK) {
          r.report('low-contrast', rule.file, colorD.line, ratio.toFixed(2) + ':1 under the ' + threshold + ':1 threshold on ' + rule.selector, { suspected: true });
        }
        if (/btn|button|cta|pill|chip/i.test(rule.selector) && withinAStep(fg, bg)) {
          r.report('gray-on-color', rule.file, colorD.line, 'button text within a step of its fill on ' + rule.selector + ' (lightness differs by ' + Math.abs(oklchOf(fg).L - oklchOf(bg).L).toFixed(3) + ')', { suspected: true });
        }
      }
    }
    const faceProp = Object.keys(local).find((k) => /(face|fill|bg)$/.test(k));
    const inkProp = Object.keys(local).find((k) => /(ink|text)$/.test(k));
    if (!faceProp || !inkProp) continue;
    const face = colorOf(local[faceProp], local);
    const ink = colorOf(local[inkProp], local);
    if (face && ink && face.alpha >= 1 && ink.alpha >= 1 && withinAStep(face, ink)) {
      r.report('gray-on-color', rule.file, rule.line, inkProp + ' sits within a step of ' + faceProp + ' on ' + rule.selector, { suspected: true });
    }
  }
}

// sloplint check40_41 (gate 41), the accent ink token and the dark surfaces
function checkSurfaceInk(ctx: LintContext, r: Reporter): void {
  const file = ctx.cssFiles[0]?.file || ctx.docs[0]?.file;
  const accent = ctx.tokens['--color-accent'], accentInk = ctx.tokens['--color-accent-ink'];
  if (file && accent && !accentInk) {
    const used = ctx.rules.some((rule) => !isTokenRule(rule) && rule.decls.some((d) => /^background(-color)?$/.test(d.prop) && /var\(\s*--color-accent\s*[),]/.test(d.value)));
    if (used) r.report('gray-on-color', file, 1, 'the accent fills a surface but --color-accent-ink is not defined', { suspected: true, fix: 'define --color-accent-ink and set it on text over the accent' });
  } else if (file && accent && accentInk) {
    const a = parseColor(resolveVars(accent, ctx.tokens));
    const i = parseColor(resolveVars(accentInk, ctx.tokens));
    if (a && i && contrastRatio(a, i) < 4.5 - CONTRAST_SLACK) r.report('gray-on-color', file, 1, '--color-accent-ink against --color-accent is only ' + contrastRatio(a, i).toFixed(2) + ':1', { suspected: true, fix: 'an accent ink at 4.5:1 or better against the accent' });
  }
  const sectionish = /section|panel|hero|footer|band|block|col\b|__col|card|cta|dark|invert/i;
  for (const rule of mergedRules(ctx)) {
    if (!sectionish.test(rule.selector) || /:hover|:focus|:active|::|@font-face/.test(rule.selector)) continue;
    const bgD = bgDecl(rule);
    if (!bgD) continue;
    const bg = parseColor(resolveVars(bgD.value, ctx.tokens, localTokens(rule)).trim());
    if (!bg || bg.alpha < 1) continue;
    const L = oklchOf(bg).L;
    if (L < 0.5 && !rule.decls.some((d) => d.prop === 'color')) {
      r.report('gray-on-color', rule.file, bgD.line, 'a dark surface (lightness ' + (L * 100).toFixed(0) + '%) on ' + rule.selector + ' sets no text colour', { suspected: true, fix: 'swap the text to the paper colour in the same rule' });
    }
  }
}

// sloplint check49 (gates 49a and 49b)
function checkWrappingLabels(ctx: LintContext, r: Reporter): void {
  const nowrap = selectorNames(ctx.rules.filter((rule) => rule.decls.some((d) => d.prop === 'white-space' && /nowrap/.test(d.value))).map((rule) => rule.selector));
  const covered = (cls: string, tag: string): boolean => nowrap.tags.has(tag) || cls.split(/\s+/).some((c) => c && nowrap.classes.has(c));
  for (const doc of ctx.docs) {
    for (let i = 0; i < doc.tags.length; i++) {
      const t = doc.tags[i];
      if (t.close || t.selfClosing) continue;
      const cls = getAttr(t.attrs, 'class') || '';
      const button = t.name === 'button' || (t.name === 'a' && /btn|cta|button|nav/i.test(cls))
        || (/(^|\s)(btn|button)(\s|$|__|--)/i.test(cls) && !/^(section|header|footer|main|article|aside|nav|form|ul|ol)$/.test(t.name));
      const link = !button && t.name === 'a' && (/tab|crumb/i.test(cls) || ancestorsOf(doc, i).includes('footer'));
      if (!button && !link) continue;
      const inner = innerOf(doc, i);
      if (!inner) continue;
      const label = stripTags(inner.inner, false, 40).replace(/\s+/g, ' ').trim();
      if (label.length <= 24 || covered(cls, t.name)) continue;
      if (button) r.report('button-label-wraps', doc.file, t.line, 'the long label "' + trunc(label, 36) + '" on <' + t.name + '> can wrap, and nothing sets nowrap', { suspected: true });
      else r.report('link-wraps', doc.file, t.line, 'the long link "' + trunc(label, 36) + '" can wrap, and nothing sets nowrap');
    }
  }
}

const STOCK = /(?:images|plus)\.unsplash\.com\/(premium_photo|photo)-[\w-]+|images\.pexels\.com\/photos\/\d+|cdn\.pixabay\.com\/photo\//g;

// sloplint check76 (gate 76): the stock hotlinks and the empty <img>; the library-credit half needs hallmark's photo index
function checkImages(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    let stock = 0, plus = 0;
    for (const m of doc.src.matchAll(STOCK)) {
      const host = /unsplash/.test(m[0]) ? 'Unsplash' : /pexels/.test(m[0]) ? 'Pexels' : 'Pixabay';
      if (m[1] === 'premium_photo') { if (!plus++) r.report('stock-photo-hotlink', doc.file, doc.lineOf(m.index!), 'an Unsplash+ photo hotlinked, which needs a paid licence'); }
      else if (!stock++) r.report('stock-photo-hotlink', doc.file, doc.lineOf(m.index!), 'a photo hotlinked from ' + host + ', whose terms bar images picked by an AI tool', { suspected: true });
    }
    if (doc.kind !== 'html') continue;
    for (const m of doc.src.matchAll(/<img\b([^>]*)>/gi)) {
      const src = getAttr(m[1], 'src');
      if ((src == null || !src.trim() || src.trim() === '#') && !getAttr(m[1], 'srcset') && !hasAttr(m[1], 'data-src')) {
        r.report('broken-image', doc.file, doc.lineOf(m.index!), 'an <img> with no source', { fix: 'the real file, or remove the element' });
        break;
      }
    }
  }
}

export function run(ctx: LintContext, r: Reporter): void {
  checkEmojiIcons(ctx, r);
  checkIconLibraries(ctx, r);
  checkUnlabeledDecoration(ctx, r);
  checkContrastPairs(ctx, r);
  checkSurfaceInk(ctx, r);
  checkWrappingLabels(ctx, r);
  checkImages(ctx, r);
}
