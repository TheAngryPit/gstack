/**
 * Structure rules of the design lint (sloplint gates 3 4 6a 24a 24b 34 44d 50 53 56 58; Nutlope/hallmark,
 * MIT, see NOTICE.md), rewritten in gstack's voice. Rule ids: template-cards, nested-cards, vh-height, raw-spacing,
 * off-scale-spacing, overflow-x-unclipped, wide-container, bare-fr-track, display-head-unwrapped, radio-tab-jump,
 * double-sticky, screen-word-budget. Gate 59 (section-gap) has no static check: the render tier owns it (render-probe-space.ts glGaps), as it owns
 * the render halves of 34 (horizontal-scroll) and 44d.
 */
import { COLOR_LITERAL, oklchOf, parseColor } from '../color';
import { isTokenRule, pxOf, resolveVars, selectorNames, type MergedRule } from '../css';
import { memo, mergedRules, type LintContext } from '../context';
import { getAttr, innerOf, stripTags, textOf, treeOf, wordsOf, type Doc } from '../html';
import { trunc, type Reporter } from '../report';
import { twGroup } from '../tailwind';
import { heroIndexOf } from './chrome-copy';

const SPACING_PROP = /^(padding|margin|gap|row-gap|column-gap)(-[a-z]+)?$/;

const selectorClasses = (sel: string): string[] => (sel.match(/\.[a-zA-Z][\w-]*/g) || []).map((c) => c.slice(1));

const stripVariants = (cls: string): string => cls.replace(/^(?:[\w-]+:)+/, '');

/** The inner HTML of every open element in the context whose class attribute carries one of the classes. */
function innerHtmlWithClass(ctx: LintContext, classes: string[]): string[] {
  if (!classes.length) return [];
  const byClass = memo(ctx, 'innerByClass', () => {
    const index = new Map<string, string[]>();
    for (const doc of ctx.docs) {
      for (let i = 0; i < doc.tags.length; i++) {
        const t = doc.tags[i];
        if (t.close || t.selfClosing) continue;
        const inner = innerOf(doc, i);
        if (!inner) continue;
        for (const c of new Set((getAttr(t.attrs, 'class') || '').split(/\s+/).filter(Boolean))) {
          let list = index.get(c);
          if (!list) index.set(c, list = []);
          list.push(inner.inner);
        }
      }
    }
    return index;
  });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of classes) for (const inner of byClass.get(c) ?? []) if (!seen.has(inner)) { seen.add(inner); out.push(inner); }
  return out;
}

const EQUAL_TRACK = String.raw`(?:1fr|minmax\(\s*0(?:px)?\s*,\s*1fr\s*\))`;
const THREE_EQUAL = [new RegExp(String.raw`^repeat\(\s*3\s*,\s*${EQUAL_TRACK}\s*\)$`), new RegExp(String.raw`^${EQUAL_TRACK}(?:\s+${EQUAL_TRACK}){2}$`)];

// sloplint check3 (gate 3)
function iconTiles(ctx: LintContext, r: Reporter): void {
  for (const rule of ctx.rules) {
    for (const d of rule.decls) {
      if (d.prop !== 'grid-template-columns') continue;
      const v = resolveVars(d.value, ctx.tokens).trim();
      if (!THREE_EQUAL.some((re) => re.test(v))) continue;
      const classes = selectorClasses(rule.selector);
      const tiles = (!ctx.docs.length && !classes.length)
        || innerHtmlWithClass(ctx, classes).some((inner) => (/class\s*=\s*["'][^"']*icon/i.test(inner) || /<svg\b/i.test(inner)) && /<h[2-6]\b/i.test(inner));
      if (tiles) r.report('template-cards', rule.file, d.line, `three equal columns of icon-above-heading tiles on ${rule.selector}`, { fix: 'vary the column widths, or set the icons inline and drop the tiles' });
    }
  }
}

// sloplint check3Stripe (gate 3)
function sideStripes(ctx: LintContext, r: Reporter): void {
  for (const rule of ctx.rules) {
    for (const d of rule.decls) {
      if (!/^border-(left|right|inline-start|inline-end)$/.test(d.prop)) continue;
      const m = /(\d+(?:\.\d+)?)px/.exec(d.value);
      if (!m || parseFloat(m[1]) < 3 || /transparent|none/i.test(d.value)) continue;
      const col = COLOR_LITERAL.exec(resolveVars(d.value, ctx.tokens));
      const parsed = col ? parseColor(col[0]) : null;
      const ok = parsed ? oklchOf(parsed) : null;
      if (parsed && ok && (parsed.alpha <= 0.05 || (ok.C < 0.04 && ok.L > 0.6))) continue;
      r.report('template-cards', rule.file, d.line, `a ${m[1]}px coloured side stripe (${d.prop}: ${trunc(d.value, 32)}) on ${rule.selector}`, { fix: 'a hairline all round, no border, or an accent square' });
    }
  }
}

const CARD_WORD = /(^|-)card(--[\w-]+)?$/i;
const CONTAINERISH = /(grid|list|rail|row|wrap|deck|group|stack|container|section|scroller|track)/i;

// sloplint check4 (gate 4)
function nestedCards(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const { parent } = treeOf(doc);
    const cardAt: boolean[] = [];
    for (let i = 0; i < doc.tags.length; i++) {
      const t = doc.tags[i];
      if (t.close || t.selfClosing) continue;
      const cls = getAttr(t.attrs, 'class') || '';
      cardAt[i] = cls.split(/\s+/).some((c) => { const base = c.split('--')[0]; return !!base && CARD_WORD.test(base) && !CONTAINERISH.test(base); });
      if (!cardAt[i]) continue;
      for (let p = parent[i]; p >= 0; p = parent[p]) {
        if (!cardAt[p]) continue;
        r.report('nested-cards', doc.file, t.line, `a card inside a card: class="${trunc(cls, 40)}"`);
        break;
      }
    }
  }
}

// sloplint heroClasses (gate 6a): the classes of the section or header that holds the h1
function heroClasses(ctx: LintContext): Set<string> {
  const out = new Set<string>();
  for (const doc of ctx.docs) {
    const h1 = doc.tags.findIndex((t) => !t.close && t.name === 'h1');
    const hero = h1 < 0 ? -1 : heroIndexOf(doc, h1);
    if (hero < 0) continue;
    for (const c of (getAttr(doc.tags[hero].attrs, 'class') || '').split(/\s+/)) if (c) out.add(c);
  }
  return out;
}

// sloplint check6a (gate 6a)
function vhHero(ctx: LintContext, r: Reporter): void {
  const heroCls = heroClasses(ctx);
  const isHero = (sel: string) => /hero/i.test(sel) || [...heroCls].some((c) => sel.includes('.' + c));
  const seen = new Set<string>();
  for (const rule of ctx.rules) {
    if (rule.keyframes || isTokenRule(rule) || !isHero(rule.selector)) continue;
    for (const d of rule.decls) {
      if (!/^(min-)?height$/.test(d.prop)) continue;
      const v = resolveVars(d.value, ctx.tokens);
      if (!/\d\s*vh\b/i.test(v) || seen.has(rule.selector)) continue;
      seen.add(rule.selector);
      r.report('vh-height', rule.file, d.line, `the hero is sized in vh: ${d.prop}: ${trunc(v, 24)} on ${rule.selector}`);
    }
  }
}

// sloplint check24 (gate 24b)
function offScaleSpacing(ctx: LintContext, r: Reporter): void {
  for (const rule of ctx.rules) {
    for (const d of rule.decls) {
      if (!SPACING_PROP.test(d.prop)) continue;
      for (const m of d.value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
        const v = Math.abs(parseFloat(m[1]));
        if (v > 2 && (v % 4 !== 0 || !Number.isInteger(v))) {
          r.report('off-scale-spacing', rule.file, d.line, `${d.prop}: ${trunc(d.value, 28)} on ${rule.selector} is off the 4px scale`, { fix: 'a step of the 4px spacing scale' });
        }
      }
    }
  }
}

// sloplint check24a (gate 24a)
/** Raw spacing lengths named per file before the rest fold into one count. */
const RAW_SPACING_PER_FILE = 8;

function rawSpacing(ctx: LintContext, r: Reporter): void {
  const spaceVals = new Map<number, string>();
  for (const [k, v] of Object.entries(ctx.tokens)) {
    if (!/^--space-/.test(k)) continue;
    const px = pxOf(resolveVars(v, ctx.tokens));
    if (px != null && px > 0) spaceVals.set(px, k);
  }
  if (!spaceVals.size) return;
  const counts = new Map<string, number>();
  for (const rule of ctx.rules) {
    if (rule.keyframes || isTokenRule(rule)) continue;
    for (const d of rule.decls) {
      if (!SPACING_PROP.test(d.prop)) continue;
      const raw = d.value.replace(/var\([^)]*\)/g, ' ');
      for (const m of raw.matchAll(/(?<![\w.-])(-?\d*\.?\d+)(px|rem)\b/g)) {
        const px = Math.abs(pxOf(m[1] + m[2]) ?? 0);
        const token = spaceVals.get(px);
        if (!px || !token) continue;
        const n = (counts.get(rule.file) || 0) + 1;
        counts.set(rule.file, n);
        if (n <= RAW_SPACING_PER_FILE) r.report('raw-spacing', rule.file, d.line, `${d.prop}: ${trunc(d.value, 28)} on ${trunc(rule.selector, 32)} where ${token} exists`, { fix: `var(${token})` });
        break;
      }
    }
  }
  for (const [file, n] of counts) if (n > RAW_SPACING_PER_FILE) r.report('raw-spacing', file, 1, `${n - RAW_SPACING_PER_FILE} more raw spacing lengths in this file have a matching --space-* token`, { fix: 'the tokens' });
}

/** An HTML file that is only an app shell: no styles, a module script, no local stylesheet. */
const isShell = (d: Doc): boolean => d.kind === 'html' && !d.styles.length
  && /<script\b[^>]*type\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["'][^"']+\.(?:tsx?|jsx?|mjs|vue|svelte)["']/i.test(d.src)
  && ![...d.src.matchAll(/<link\b[^>]*>/gi)].some((m) => /rel\s*=\s*["']stylesheet/i.test(m[0]) && !/href\s*=\s*["']https?:/i.test(m[0]));

// sloplint check34, static half (gate 34); the render tier owns horizontal-scroll
function overflowX(ctx: LintContext, r: Reporter): void {
  const clipped = new Set<string>();
  let hidden: { file: string; line: number; sel: string } | null = null;
  for (const rule of ctx.rules) {
    if (!/(^|[\s,])(html|body)\b/.test(rule.selector)) continue;
    const targets = rule.selector.split(',').map((p) => (/^\s*(html|body)\s*$/.exec(p) || [])[1]).filter((t): t is string => !!t);
    for (const d of rule.decls) {
      if (d.prop !== 'overflow-x' && d.prop !== 'overflow') continue;
      if (/\bclip\b/.test(d.value)) for (const t of targets) clipped.add(t);
      else if (/\bhidden\b/.test(d.value)) hidden = { file: rule.file, line: d.line, sel: rule.selector };
    }
  }
  const hiddenUtil: Array<{ file: string; line: number; tag: string; util: string }> = [];
  for (const it of twGroup(ctx).items) {
    if (it.idx < 0 || !/^(html|body)$/.test(it.tag)) continue;
    const base = it.info.classes.map(stripVariants);
    if (base.some((c) => c === 'overflow-x-clip' || c === 'overflow-clip')) clipped.add(it.tag);
    const util = base.find((c) => c === 'overflow-x-hidden');
    if (util) hiddenUtil.push({ file: it.file, line: it.line, tag: it.tag, util });
  }
  for (const it of hiddenUtil) r.report('overflow-x-unclipped', it.file, it.line, `${it.util} on <${it.tag}>: hidden breaks position: sticky`, { fix: 'overflow-x-clip on both html and body, never hidden' });
  const pageish = ctx.docs.some((d) => (d.kind === 'html' && !isShell(d)) || (d.kind !== 'html' && d.tags.some((t) => !t.close && (t.name === 'html' || t.name === 'body'))));
  const file = ctx.cssFiles[0]?.file || ctx.docs[0]?.file;
  const both = clipped.has('html') && clipped.has('body');
  if (!both && hidden) {
    r.report('overflow-x-unclipped', hidden.file, hidden.line, `overflow-x: hidden on ${hidden.sel}: hidden breaks position: sticky`, { fix: 'overflow-x: clip on both html and body, never hidden' });
  } else if (!both && file && ctx.docs.length && pageish && !hiddenUtil.length) {
    r.report('overflow-x-unclipped', file, 1, clipped.size ? `overflow-x: clip on ${[...clipped][0]} only` : 'no overflow-x: clip on html and body', { fix: 'overflow-x: clip on both html and body' });
  }
  for (const rule of ctx.rules) {
    for (const d of rule.decls) {
      if (/^(width|min-width)$/.test(d.prop) && /(^|[^\w.-])100vw\b/.test(d.value)) {
        r.report('overflow-x-unclipped', rule.file, d.line, `${d.prop}: ${trunc(d.value, 28)} on ${rule.selector}: 100vw counts the scrollbar and overflows`, { fix: 'width: 100% with the container\'s padding' });
      }
    }
  }
}

// sloplint check50 (gate 50)
function bareFrTrack(ctx: LintContext, r: Reporter): void {
  for (const rule of ctx.rules) {
    for (const d of rule.decls) {
      if (d.prop !== 'grid-template-columns') continue;
      let flat = resolveVars(d.value, ctx.tokens);
      for (let k = 0; k < 4 && /\((?:[^()]*)\)/.test(flat); k++) flat = flat.replace(/(calc|min|max|clamp|var|fit-content)\(([^()]*)\)/g, 'X');
      flat = flat.replace(/minmax\([^()]*\)/g, 'MM');
      const bare = /(?<![\w.-])\d*\.?\d+fr\b/.exec(flat);
      if (!bare) continue;
      const holdsImages = innerHtmlWithClass(ctx, selectorClasses(rule.selector)).some((inner) => /<(img|picture|video)\b/i.test(inner));
      if (holdsImages) r.report('bare-fr-track', rule.file, d.line, `a bare ${bare[0]} track holds images on ${rule.selector}: the image's min-content width can push the grid past its box`);
    }
  }
}

// sloplint check50Wrap (gate 50)
function displayHeadUnwrapped(ctx: LintContext, r: Reporter): void {
  const wrapping = ctx.rules.filter((rule) => rule.decls.some((d) =>
    (d.prop === 'overflow-wrap' && /anywhere|break-word/.test(d.value))
    || (d.prop === 'word-break' && /break-word|break-all/.test(d.value))
    || (d.prop === 'hyphens' && /auto/.test(d.value)))).map((rule) => rule.selector);
  const everywhere = wrapping.some((sel) => /^\*|:where\(|html|body/.test(sel));
  const wrap = selectorNames(wrapping);
  const wrapCovered = (cls: string, tag: string) => everywhere || wrap.tags.has(tag) || cls.split(/\s+/).some((c) => c && wrap.classes.has(c));
  for (const doc of ctx.docs) {
    for (let i = 0; i < doc.tags.length; i++) {
      const t = doc.tags[i];
      if (t.close || t.selfClosing) continue;
      const cls = getAttr(t.attrs, 'class') || '';
      if (!/^h[12]$/.test(t.name) && !/hero__(title|display)|section__title|__display/.test(cls)) continue;
      const inner = innerOf(doc, i);
      if (!inner) continue;
      const text = stripTags(inner.inner).replace(/\s+/g, ' ').trim();
      const risky = text.split(' ').find((word) => word.split('-').some((seg) => seg.replace(/[^\w]/g, '').length >= 16));
      if (risky && !wrapCovered(cls, t.name)) {
        r.report('display-head-unwrapped', doc.file, t.line, `the display head holds "${trunc(risky, 30)}" with no overflow-wrap: at 320px that word overflows`);
      }
    }
  }
}

// sloplint check53 (gate 53)
function radioTabJump(ctx: LintContext, r: Reporter): void {
  const guarded = ctx.docs.some((doc) => /preventScroll/.test(doc.scripts));
  for (const rule of ctx.rules) {
    if (!/input\[type=["']?radio["']?\]|\.(radio|tab-input|tab-radio)\b/i.test(rule.selector)) continue;
    const abs = rule.decls.some((d) => d.prop === 'position' && /absolute|fixed/.test(d.value));
    const topZero = rule.decls.some((d) => d.prop === 'top' && /^0(px|rem)?$/.test(d.value.trim()));
    if (abs && topZero && !guarded) {
      r.report('radio-tab-jump', rule.file, rule.line, `radio tabs at position: absolute; top: 0 on ${rule.selector} with no script guard: focusing a radio scrolls the page to the top`);
    }
  }
}

// sloplint check56 (gate 56)
function doubleSticky(ctx: LintContext, r: Reporter): void {
  const bySelector = new Map<string, MergedRule>();
  for (const m of mergedRules(ctx)) {
    if (m.decls.some((d) => d.prop === 'position' && /sticky/.test(d.value))
      && m.decls.some((d) => d.prop === 'top' && /^(0|0px|0rem|-1px)$/.test(resolveVars(d.value, ctx.tokens).trim())) && !bySelector.has(m.selector)) bySelector.set(m.selector, m);
  }
  const sticky = [...bySelector.values()];
  if (sticky.length < 2) return;
  const sels = sticky.map((m) => m.selector).join(' and ');
  r.report('double-sticky', sticky[1].file, sticky[1].line, `two elements stick at top: 0 (${trunc(sels, 52)}): the second slides under the first`);
}

const countWords = (t: string): number => t.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;

/** Words the visitor never sees: screen-reader-only, aria-hidden, hidden and credits blocks. */
function hiddenWordCount(doc: Doc): number {
  let words = 0, hiddenEnd = -1;
  for (let i = 0; i < doc.tags.length; i++) {
    const t = doc.tags[i];
    if (t.close || t.selfClosing || t.pos < hiddenEnd) continue;
    const cls = getAttr(t.attrs, 'class') || '';
    const hiddenish = /(^|\s)(sr-only|visually-hidden|screen-reader-text|skip|skip-link)(\s|$)/i.test(cls)
      || /aria-hidden\s*=\s*["']?true/i.test(t.attrs) || /(^|\s)hidden(\s|=|$)/i.test(t.attrs) || /(^|\s)data-credits(\s|=|$)/i.test(t.attrs);
    if (!hiddenish) continue;
    const inner = innerOf(doc, i);
    if (!inner) continue;
    words += countWords(textOf(doc, i));
    hiddenEnd = inner.endPos;
  }
  return words;
}

// sloplint check58Static (gate 58); the render tier measures the 900px window
function wordBudget(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const h1 = doc.tags.findIndex((t) => !t.close && t.name === 'h1');
    if (h1 >= 0) {
      const words = wordsOf(innerOf(doc, h1)?.inner || '');
      if (words.length > 7) r.report('screen-word-budget', doc.file, doc.tags[h1].line, `the h1 runs ${words.length} words ("${trunc(words.join(' '), 40)}")`, { fix: 'seven words or fewer, 50 characters or fewer' });
      const heroIdx = heroIndexOf(doc, h1);
      const hero = heroIdx >= 0 ? innerOf(doc, heroIdx) : null;
      if (hero) {
        for (let i = h1 + 1; i < doc.tags.length && doc.tags[i].pos < hero.endPos; i++) {
          const t = doc.tags[i];
          if (t.close || t.name !== 'p') continue;
          const pw = wordsOf(innerOf(doc, i)?.inner || '');
          if (pw.length > 12) r.report('screen-word-budget', doc.file, t.line, `the hero paragraph runs ${pw.length} words`, { fix: 'one sentence, twelve words or fewer' });
          break;
        }
      }
    }
    const sections = doc.tags.filter((t) => !t.close && t.name === 'section').length;
    const fullPage = sections >= 5 || doc.tags.some((t) => !t.close && t.name === 'footer');
    if (!fullPage || doc.kind !== 'html') continue;
    const total = countWords(doc.text) - hiddenWordCount(doc);
    if (total > 450) r.report('screen-word-budget', doc.file, 1, `${total} visible words on the page (450 at most)`, { fix: 'cut copy: one idea per screen; sections become objects' });
  }
}

/** The px of a media query's min-width clause (px, em or rem), or null when it has none. */
function minWidthPx(media: string | null): number | null {
  if (!media) return null;
  const m = /min-width\s*:\s*(\d+(?:\.\d+)?)(px|em|rem)|width\s*>=\s*(\d+(?:\.\d+)?)(px|em|rem)/i.exec(media);
  if (!m) return null;
  return pxOf((m[1] ?? m[3]) + (m[2] ?? m[4]));
}

/** How many columns a grid-template-columns value lays down; null when the count depends on the viewport (auto-fit, auto-fill) or on a var. */
function columnCount(value: string): number | null {
  if (/auto-fi(t|ll)|var\(/.test(value)) return null;
  let repeated = 0;
  const v = value.replace(/repeat\(\s*(\d+)\s*,\s*((?:[^()]|\([^()]*\))*)\)/g, (_, count: string, tracks: string) => {
    repeated += parseInt(count, 10) * tracks.replace(/\([^()]*\)/g, 'X').replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    return ' ';
  });
  if (/repeat\(/.test(v)) return null;
  return repeated + v.replace(/\([^()]*\)/g, 'X').replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

/** Whether some container is capped: a max-width paired with auto margins, a max-width of 900px or more, or a Tailwind container or max-w utility. */
function containerCapped(ctx: LintContext): boolean {
  for (const m of mergedRules(ctx)) {
    const cap = m.decls.find((d) => d.prop === 'max-width' || d.prop === 'max-inline-size')
      ?? m.decls.find((d) => (d.prop === 'width' || d.prop === 'inline-size') && /^(min|clamp)\(/.test(resolveVars(d.value, ctx.tokens).trim()) && /\d(px|rem|em|ch)\b/.test(d.value));
    if (!cap || /^(none|100%|100vw)$/.test(cap.value.trim())) continue;
    const px = pxOf(resolveVars(cap.value, ctx.tokens));
    const centred = m.decls.some((d) => /^margin(-inline|-left|-right)?$/.test(d.prop) && /\bauto\b/.test(d.value));
    if (centred || (px != null && px >= 900)) return true;
  }
  return twGroup(ctx).items.some((it) => it.info.classes.map(stripVariants).some((c) => c === 'container' || /^max-w-(?!none$|full$|screen$|\[100)/.test(c)));
}

const VISUAL_SEL = /(^|[\s,>+~(])(img|picture|video|figure|svg|canvas)\b|__(media|visual|image|img|photo|figure|art|cover|illustration)\b|\.(media|visual|image|img|photo|figure|art|cover|illustration|orb|blob)\b/i;

// gate 44d, static half (sloplint measures 44d in the render tier only): what the CSS alone proves about 1920px
function wideContainer(ctx: LintContext, r: Reporter): void {
  if (!ctx.docs.some((d) => d.kind === 'html') || containerCapped(ctx)) return;
  const merged = mergedRules(ctx);
  const columnsBelow = (selector: string): number => {
    let n = 0;
    for (const m of merged) {
      if (m.selector !== selector || (minWidthPx(m.media) ?? 0) > 1440) continue;
      for (const d of m.decls) if (d.prop === 'grid-template-columns') n = Math.max(n, columnCount(resolveVars(d.value, ctx.tokens)) ?? 0);
    }
    return n;
  };
  const seen = new Set<string>();
  for (const rule of ctx.rules) {
    if (rule.keyframes || isTokenRule(rule)) continue;
    const wide = minWidthPx(rule.media);
    for (const d of rule.decls) {
      if (d.prop === 'grid-template-columns' && wide != null && wide > 1440) {
        const n = columnCount(resolveVars(d.value, ctx.tokens));
        const below = columnsBelow(rule.selector);
        if (n != null && below > 0 && n > below && !seen.has('cols:' + rule.selector)) {
          seen.add('cols:' + rule.selector);
          r.report('wide-container', rule.file, d.line, `no container has a max-width, and ${rule.selector} gains columns at ${rule.media} (${below} to ${n})`, { fix: 'cap the container at 1360 to 1520px and centre it; hold the column count' });
        }
      }
      if (!/^(width|height|inline-size|block-size|flex-basis)$/.test(d.prop) || !VISUAL_SEL.test(rule.selector)) continue;
      const v = resolveVars(d.value, ctx.tokens);
      const capped = /clamp\(|min\(/.test(v) || rule.decls.some((x) => /^max-(width|height|inline-size|block-size)$/.test(x.prop));
      if (/\d\s*vw\b/i.test(v) && !capped && !seen.has('vw:' + rule.selector)) {
        seen.add('vw:' + rule.selector);
        r.report('wide-container', rule.file, d.line, `no container has a max-width, and ${rule.selector} is sized in vw with no cap (${d.prop}: ${trunc(v, 24)})`, { fix: 'cap the container at 1360 to 1520px; give the visual a max-width or a clamp()' });
      }
    }
  }
}

export function run(ctx: LintContext, r: Reporter): void {
  iconTiles(ctx, r);
  sideStripes(ctx, r);
  nestedCards(ctx, r);
  vhHero(ctx, r);
  offScaleSpacing(ctx, r);
  rawSpacing(ctx, r);
  overflowX(ctx, r);
  bareFrTrack(ctx, r);
  displayHeadUnwrapped(ctx, r);
  radioTabJump(ctx, r);
  doubleSticky(ctx, r);
  wordBudget(ctx, r);
  wideContainer(ctx, r);
}
