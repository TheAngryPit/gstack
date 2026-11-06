/**
 * Motion and interaction rules of the design lint (sloplint gates 10a 10b 11 12 15 17 18 26a 26b 27 28a 28b 39a 39b 62;
 * Nutlope/hallmark, MIT, see NOTICE.md), rewritten in gstack's voice. Rule ids: layout-transition, spacing-transition,
 * hover-tells, bounce-easing, focus-ring-fade, tooltip-focus-delay, autorotate-no-pause, missing-focus-visible,
 * missing-states, missing-reduced-motion, autoplay-unmuted, lazy-lcp, video-without-poster, input-state-shift,
 * control-height, content-hidden-at-rest.
 */
import { isTokenRule, pxOf, resolveVars, selectorIsInteractive, splitTop, stripComments } from '../css';
import { mergedRules, type LintContext, type SharedStyles } from '../context';
import { getAttr, hasAttr } from '../html';
import { trunc, type Reporter } from '../report';
import { twGroup, twVariants, type TwItem } from '../tailwind';

const baseSelector = (sel: string): string => sel.replace(/::?[a-z-]+(\([^)]*\))?/gi, '').replace(/\s+/g, ' ').trim();

const stripVariants = (cls: string): string => cls.replace(/^(?:[\w-]+:)+/, '');

const firstFile = (ctx: LintContext): string => ctx.cssFiles[0]?.file || ctx.docs[0]?.file || '?';

const SHARED_ONCE = new WeakMap<SharedStyles, Set<string>>();

/** True the first time a key is seen across the contexts that share one project's styles; always true when nothing is shared. */
function once(ctx: LintContext, key: string): boolean {
  if (!ctx.shared) return true;
  let seen = SHARED_ONCE.get(ctx.shared);
  if (!seen) { seen = new Set(); SHARED_ONCE.set(ctx.shared, seen); }
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

const HARD_PROP = /(?<![\w-])(width|height|top|left|right|bottom|inset(?:-[a-z-]+)?|flex-basis|grid-template-columns)(?![\w-])/;
const SOFT_PROP = /(?<![\w-])(margin(?:-[a-z]+)?|padding(?:-[a-z]+)?)(?![\w-])/;

// sloplint check10 and check10Motion (gates 10a, 10b)
function layoutTransitions(ctx: LintContext, r: Reporter): void {
  const fix = 'animate transform or opacity instead';
  for (const rule of ctx.rules) {
    for (const d of rule.decls) {
      if (d.prop === 'transition' && /(^|,)\s*all[\s,]|^all$|^all\s/.test(d.value.trim())) r.report('layout-transition', rule.file, d.line, `transition: all on ${rule.selector}`, { fix: 'list the transitioned properties' });
      if (d.prop === 'transition-property' && /\ball\b/.test(d.value)) r.report('layout-transition', rule.file, d.line, `transition-property: all on ${rule.selector}`, { fix: 'list the transitioned properties' });
    }
    if (/skip|sr-only|visually-hidden/i.test(rule.selector)) continue;
    if (rule.keyframes) {
      for (const d of rule.decls) {
        if (/^(min|max)-/.test(d.prop)) continue;
        if (HARD_PROP.test(d.prop)) r.report('layout-transition', rule.file, d.line, `@keyframes ${rule.keyframes} animates ${d.prop}`, { fix });
        else if (SOFT_PROP.test(d.prop)) r.report('spacing-transition', rule.file, d.line, `@keyframes ${rule.keyframes} animates ${d.prop}`, { fix });
      }
      continue;
    }
    for (const d of rule.decls) {
      if (d.prop !== 'transition' && d.prop !== 'transition-property') continue;
      const hard = HARD_PROP.exec(d.value);
      const soft = SOFT_PROP.exec(d.value);
      if (hard) r.report('layout-transition', rule.file, d.line, `transitioning ${hard[1]} on ${rule.selector}`, { fix });
      else if (soft) r.report('spacing-transition', rule.file, d.line, `transitioning ${soft[1]} on ${rule.selector}`, { fix });
    }
  }
}

const IMAGE_SEL = /(^|[\s>+~,])(img|picture|figure|video)\b|__(img|image|photo|thumb|cover)\b|\.(img|image|photo|thumb|cover)\b/i;

// sloplint check11 and check11Lift (gate 11)
function hoverTells(ctx: LintContext, r: Reporter): void {
  const byScale = new Map<string, Array<{ sel: string; file: string; line: number }>>();
  for (const rule of ctx.rules) {
    if (!/:hover/.test(rule.selector)) continue;
    for (const d of rule.decls) {
      if (d.prop !== 'transform') continue;
      const m = /scale\(\s*([\d.]+)\s*\)/.exec(d.value);
      if (!m || parseFloat(m[1]) === 1) continue;
      if (!byScale.has(m[1])) byScale.set(m[1], []);
      byScale.get(m[1])!.push({ sel: rule.selector, file: rule.file, line: d.line });
    }
  }
  for (const [k, list] of byScale) {
    const distinct = new Set(list.map((x) => x.sel));
    if (distinct.size >= 2) r.report('hover-tells', list[0].file, list[0].line, `the same hover scale(${k}) on ${distinct.size} selectors`, { fix: 'one hover signal per element' });
  }
  for (const rule of ctx.rules) {
    if (!/:hover/.test(rule.selector) || !IMAGE_SEL.test(rule.selector)) continue;
    const t = rule.decls.find((d) => d.prop === 'transform' && /scale|rotate/.test(d.value));
    if (t) r.report('hover-tells', rule.file, t.line, `an image transforms on hover (${rule.selector})`, { fix: 'imagery sits still; give the container the feedback' });
  }
  const lifts = new Map<string, { file: string; line: number }>();
  for (const m of mergedRules(ctx)) {
    if (!/:hover/.test(m.selector)) continue;
    const t = m.decls.find((d) => (d.prop === 'transform' && /translateY\(\s*-\s*\d/.test(resolveVars(d.value, ctx.tokens))) || (d.prop === 'translate' && /^0(px)?\s+-\d/.test(resolveVars(d.value, ctx.tokens))));
    if (!t || !m.decls.some((d) => d.prop === 'box-shadow')) continue;
    for (const part of m.selector.split(',')) lifts.set(baseSelector(part), { file: m.file, line: t.line });
  }
  if (lifts.size < 3) return;
  const third = [...lifts.values()][2];
  r.report('hover-tells', third.file, third.line, `the hover lift (translateY plus shadow) on ${lifts.size} selectors (${trunc([...lifts.keys()].slice(0, 3).join(', '), 44)})`, { fix: 'one signal per element; the same lift on every card is the template' });
}

const UI_SEL = /:hover|:active|:focus|\b(btn|button|modal|dialog|tooltip|dropdown|menu|popover|toast|tab|input|select|switch|toggle|accordion)\b/i;

// sloplint check12 (gate 12), with no genre exemption: every spring on UI state is reported
function bounceEasing(ctx: LintContext, r: Reporter): void {
  for (const rule of ctx.rules) {
    if (!UI_SEL.test(rule.selector)) continue;
    for (const d of rule.decls) {
      if (!/transition|animation/.test(d.prop)) continue;
      const value = resolveVars(d.value, ctx.tokens);
      for (const m of value.matchAll(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/g)) {
        const y1 = parseFloat(m[2]), y2 = parseFloat(m[4]);
        if (y1 > 1.05 || y2 > 1.05 || y1 < -0.05 || y2 < -0.05) r.report('bounce-easing', rule.file, d.line, `overshoot easing ${m[0]} on ${rule.selector}`);
      }
      const named = /^animation(-name)?$/.test(d.prop) ? /(?<![\w-])[\w-]*(bounce|spring|elastic|wobble|jello|rubber)[\w-]*/i.exec(value) : null;
      if (named) r.report('bounce-easing', rule.file, d.line, `bounce animation ${named[0]} on ${rule.selector}`);
    }
  }
}

// sloplint check15 and check15Fade (gate 15)
function focusRingFade(ctx: LintContext, r: Reporter): void {
  for (const rule of ctx.rules) {
    if (!/:focus(-visible|-within)?\b/.test(rule.selector)) continue;
    const withinOnly = !/:focus(-visible)?(?![\w-])/.test(rule.selector);
    for (const d of rule.decls) {
      if (d.prop === 'transition' && (withinOnly ? /outline|box-shadow|\ball\b/ : /outline|box-shadow|opacity|\ball\b/).test(d.value)) {
        r.report('focus-ring-fade', rule.file, d.line, `the focus ring transitions in on ${rule.selector}`, { fix: 'remove the transition; a ring appears instantly' });
      }
    }
  }
  const focusProps = new Map<string, Set<string>>();
  for (const rule of ctx.rules) {
    if (!/:focus-visible/.test(rule.selector)) continue;
    for (const part of rule.selector.split(',')) {
      if (!/:focus-visible/.test(part)) continue;
      const base = baseSelector(part).replace(/^\*$/, '');
      const set = focusProps.get(base) || new Set<string>();
      for (const d of rule.decls) {
        if (d.prop === 'box-shadow') set.add('box-shadow');
        if (/^outline/.test(d.prop)) set.add('outline');
      }
      focusProps.set(base, set);
    }
  }
  if (!focusProps.size) return;
  const global = focusProps.get('') || new Set<string>();
  for (const rule of ctx.rules) {
    if (rule.keyframes || /:focus|:hover|:active/.test(rule.selector)) continue;
    for (const d of rule.decls) {
      if (d.prop !== 'transition' && d.prop !== 'transition-property') continue;
      for (const prop of ['box-shadow', 'outline']) {
        if (!new RegExp(`(^|[\\s,])${prop}(-[a-z]+)?\\b`).test(d.value)) continue;
        const own = rule.selector.split(',').some((p) => (focusProps.get(baseSelector(p)) || new Set<string>()).has(prop));
        if (!global.has(prop) && !own) continue;
        r.report('focus-ring-fade', rule.file, d.line, `${trunc(rule.selector, 32)} transitions ${prop} while :focus-visible sets it, so the ring fades in`, { fix: 'transition the hover property only, or draw the ring with a property that is not transitioned' });
        break;
      }
    }
  }
}

// sloplint check17 (gate 17)
function tooltipDelay(ctx: LintContext, r: Reporter): void {
  const tips = ctx.rules.filter((rule) => /tooltip|tip\b/i.test(rule.selector));
  const delayed = (sel: RegExp): { file: string; line: number } | null => {
    for (const rule of tips) {
      if (!sel.test(rule.selector)) continue;
      const d = rule.decls.find((x) => /^transition(-delay)?$/.test(x.prop) && splitTop(x.value).some((part) => {
        const ms = [...part.matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g)].map((m) => m[2] === 'ms' ? Number(m[1]) : Number(m[1]) * 1000);
        return (x.prop === 'transition-delay' ? ms[0] : ms[1]) >= 100;
      }));
      if (d) return { file: rule.file, line: d.line };
    }
    return null;
  };
  const focus = delayed(/:focus/);
  if (focus && delayed(/:hover/)) r.report('tooltip-focus-delay', focus.file, focus.line, 'the tooltip waits as long on focus as on hover', { suspected: true });
}

// sloplint check18 (gate 18)
function autorotate(ctx: LintContext, r: Reporter): void {
  const paused = ctx.rules.some((rule) => /:hover|:focus|\[data-loop\]/.test(rule.selector) && rule.decls.some((d) => d.prop === 'animation-play-state' && /paused/.test(d.value)));
  if (paused) return;
  for (const rule of ctx.rules) {
    if (rule.keyframes || !/carousel|marquee|ticker|rotate|slider|scroll|auto/i.test(rule.selector)) continue;
    for (const d of rule.decls) {
      if (/^animation(-iteration-count)?$/.test(d.prop) && /\binfinite\b/.test(d.value)) {
        r.report('autorotate-no-pause', rule.file, d.line, `an infinite animation on ${rule.selector} with no paused state on hover or focus`, { suspected: true });
      }
    }
  }
}

// sloplint check26 (gates 26a, 26b); ctx.shared carries a project's global state styles
/** An outline value that takes the ring away: none, or a zero width; `0.25rem solid` is a ring. */
const OUTLINE_REMOVED = /^(?:none|0(?:px|rem|em)?)(?![\w.%])/i;

function focusAndStates(ctx: LintContext, r: Reporter): void {
  const hasInteractive = ctx.docs.some((doc) => /<(a|button|input|select|textarea)\b|role\s*=\s*["']button/i.test(doc.src))
    || ctx.rules.some((rule) => selectorIsInteractive(rule.selector));
  if (!hasInteractive) return;
  const has = (pseudo: string) => ctx.rules.some((rule) => rule.selector.includes(pseudo));
  const tv = twVariants(ctx);
  const shared = ctx.shared;
  const file = firstFile(ctx);
  if (!has(':focus-visible') && !has(':focus') && !shared?.focus && ![...tv].some((v) => /^focus(?:-visible|-within)?$/.test(v)) && once(ctx, '26a')) {
    r.report('missing-focus-visible', file, 1, 'no :focus-visible style anywhere: keyboard users cannot see where they are');
  }
  const ringDecl = (d: { prop: string; value: string }) => (/^outline(-style|-width|-color)?$/.test(d.prop) && !OUTLINE_REMOVED.test(d.value.trim())) || (d.prop === 'box-shadow' && !/^none\b/i.test(d.value.trim()));
  const ringAnywhere = ctx.rules.some((rule) => /:focus/.test(rule.selector) && rule.decls.some(ringDecl)) || !!shared?.focus || [...tv].some((v) => /^focus(?:-visible|-within)?$/.test(v));
  if (!ringAnywhere) {
    const removed = ctx.rules.find((rule) => /:focus/.test(rule.selector) && rule.decls.some((d) => /^outline(-style)?$/.test(d.prop) && OUTLINE_REMOVED.test(d.value.trim())));
    const outlineD = removed?.decls.find((d) => /^outline(-style)?$/.test(d.prop));
    if (removed && outlineD && once(ctx, '26a:removed')) r.report('missing-focus-visible', removed.file, outlineD.line, `${outlineD.prop}: ${outlineD.value.trim()} on ${trunc(removed.selector, 40)} with nothing in its place: keyboard users cannot see where they are`, { fix: 'a :focus-visible ring at 3:1 or better, instant; never remove an outline without putting one back' });
  }
  if (!has(':active') && !shared?.active && !tv.has('active') && once(ctx, '26b:active')) {
    r.report('missing-states', file, 1, 'no :active style anywhere', { fix: 'every state a control can be in: hover, active, focus-visible, disabled' });
  }
  const hasFormish = ctx.docs.some((doc) => /<(button|input|select|textarea)\b/i.test(doc.src));
  if (hasFormish && !has(':disabled') && !shared?.disabled && !tv.has('disabled') && !tv.has('aria-disabled') && !ctx.rules.some((rule) => /\[disabled\]|aria-disabled/.test(rule.selector)) && once(ctx, '26b:disabled')) {
    r.report('missing-states', file, 1, 'no :disabled style anywhere', { fix: 'every state a control can be in: hover, active, focus-visible, disabled' });
  }
}

/** The first Tailwind element that moves: an animate-* utility, or a transition on a transform utility. */
function twMotion(ctx: LintContext): { item: TwItem; what: string } | null {
  for (const item of twGroup(ctx).items) {
    const base = item.info.classes.map(stripVariants);
    const animate = base.find((c) => /^animate-(?!none$)/.test(c));
    if (animate) return { item, what: animate };
    if (base.some((c) => /^transition(-transform|-all)?$/.test(c)) && base.some((c) => /^-?(scale|translate|rotate|skew)-/.test(c))) return { item, what: 'a transition on a transform' };
  }
  return null;
}

// sloplint check27 (gate 27); ctx.shared.reducedMotion is the project's fallback
function reducedMotion(ctx: LintContext, r: Reporter): void {
  const moves = (decls: Array<{ prop: string; value: string }>) => decls.some((d) => /^(transform|translate|scale|rotate)$/.test(d.prop) && !/^none\b/.test(d.value.trim()));
  const hasMotion = ctx.rules.some((rule) => rule.keyframes)
    || ctx.rules.some((rule) => rule.decls.some((d) => /^transition/.test(d.prop) && /transform/.test(d.value)))
    || (ctx.rules.some((rule) => rule.decls.some((d) => /^transition/.test(d.prop) && /(^|[\s,])all\b/.test(d.value))) && ctx.rules.some((rule) => /:(hover|active|focus)/.test(rule.selector) && moves(rule.decls)));
  const tw = twMotion(ctx);
  if (!hasMotion && !tw) return;
  const tv = twVariants(ctx);
  const hasFallback = ctx.rules.some((rule) => rule.media && /prefers-reduced-motion/i.test(rule.media))
    || ctx.cssFiles.some((f) => /prefers-reduced-motion/i.test(stripComments(f.raw)))
    || ctx.docs.some((doc) => doc.styles.some((s) => /prefers-reduced-motion/i.test(stripComments(s.css))))
    || tv.has('motion-reduce') || tv.has('motion-safe') || !!ctx.shared?.reducedMotion;
  if (hasFallback || !once(ctx, '27')) return;
  if (!hasMotion && tw) {
    r.report('missing-reduced-motion', tw.item.file, tw.item.line, `motion utilities (${tw.what}) with no motion-reduce: or motion-safe: variant anywhere`, { fix: 'add motion-reduce: fallbacks, or put the motion behind motion-safe:' });
    return;
  }
  const kf = ctx.rules.find((rule) => rule.keyframes);
  r.report('missing-reduced-motion', kf ? kf.file : firstFile(ctx), kf ? kf.line : 1, 'motion present and no prefers-reduced-motion block anywhere');
}

// sloplint check28 (gates 28a, 28b)
function media(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    let firstMedia = true, seenH1 = false, heroPassed = false;
    for (const t of doc.tags) {
      if (t.close) { if (seenH1 && (t.name === 'section' || t.name === 'header')) heroPassed = true; continue; }
      if (t.name === 'h1') seenH1 = true;
      if (t.name === 'video') {
        if (hasAttr(t.attrs, 'autoplay') && !hasAttr(t.attrs, 'muted')) r.report('autoplay-unmuted', doc.file, t.line, 'a video autoplays without muted, so browsers block it or it plays sound unasked');
        if (!getAttr(t.attrs, 'poster')) r.report('video-without-poster', doc.file, t.line, 'a video with no poster frame', { fix: 'a poster frame; below the fold it may also load lazily' });
        if ((getAttr(t.attrs, 'loading') || '').toLowerCase() === 'lazy' && firstMedia) r.report('lazy-lcp', doc.file, t.line, 'the first video loads lazily and is likely the largest paint', { fix: 'never lazy on the LCP video; preload its poster with fetchpriority="high"', suspected: true });
        firstMedia = false;
      }
      if (t.name === 'img') {
        if (firstMedia && !heroPassed && (getAttr(t.attrs, 'loading') || '').toLowerCase() === 'lazy') r.report('lazy-lcp', doc.file, t.line, 'the first image loads lazily and is likely the largest paint', { suspected: true });
        firstMedia = false;
      }
    }
  }
}

const INPUT_SEL = /(^|[\s,>+~])(input|textarea|select)\b|__input|__field|\.(input|field)\b/;

// sloplint check39 (gate 39a)
function inputStates(ctx: LintContext, r: Reporter): void {
  const hasInputs = ctx.docs.some((doc) => /<(input|textarea|select)\b/i.test(doc.src)) || ctx.rules.some((rule) => /(^|[\s,>+~])(input|textarea|select)\b/.test(rule.selector));
  if (!hasInputs) return;
  const widthOf = (v: string) => { const m = /(\d+(?:\.\d+)?)px/.exec(v); return m ? parseFloat(m[1]) : null; };
  let baseW: number | null = null;
  for (const rule of ctx.rules) {
    if (!INPUT_SEL.test(rule.selector) || /:hover|:focus|:active|:disabled|:checked|\[(?:disabled|aria-invalid|aria-disabled|data-state)/.test(rule.selector)) continue;
    for (const d of rule.decls) {
      if (d.prop !== 'border' && d.prop !== 'border-width') continue;
      const w = widthOf(d.value);
      if (w != null && baseW == null) baseW = w;
    }
  }
  for (const rule of ctx.rules) {
    if (!INPUT_SEL.test(rule.selector) || !/:hover|:focus|\.is-error|\[aria-invalid/.test(rule.selector)) continue;
    for (const d of rule.decls) {
      if (d.prop !== 'border' && d.prop !== 'border-width') continue;
      const w = widthOf(d.value);
      if (w != null && baseW != null && w !== baseW) r.report('input-state-shift', rule.file, d.line, `the border goes from ${baseW}px to ${w}px on ${rule.selector}, so the field shifts`, { fix: 'keep the border width constant; move the state to outline' });
    }
    if (/:focus/.test(rule.selector) && rule.decls.some((d) => /^border(-color)?$/.test(d.prop)) && !rule.decls.some((d) => (/^outline/.test(d.prop) && !OUTLINE_REMOVED.test(d.value.trim())) || (d.prop === 'box-shadow' && !/^none\b/i.test(d.value.trim())))) {
      r.report('input-state-shift', rule.file, rule.line, `the focus state is drawn with border on ${rule.selector}`, { fix: 'a focus ring with outline, not border' });
    }
  }
  for (const rule of ctx.rules) {
    if (!/:disabled|\[disabled\]/.test(rule.selector)) continue;
    if (rule.decls.some((d) => d.prop === 'opacity') && !rule.decls.some((d) => d.prop === 'cursor' && /not-allowed/.test(d.value))) {
      r.report('input-state-shift', rule.file, rule.line, `disabled by opacity alone on ${rule.selector}`, { fix: 'three disabled channels: fill, ink and cursor: not-allowed, plus the disabled attribute' });
    }
  }
}

const CONTROL_SEL = /(^|[\s,>+~(])(button|input|select|textarea)\b|\.(btn|button|cta|input|field|control)\b/i;
const CONTROL_SKIP = /:hover|:focus|:active|:disabled|:checked|\[type=["']?(radio|checkbox|range|hidden|color|file)|sr-only|visually-hidden|icon|close|toggle|switch|chip|tag|badge|pill|__dot|__mark/i;

// gate 39b, static half (sloplint measures 39b in the render tier only): a control whose CSS fixes its height outside 44 to 52px
function controlHeight(ctx: LintContext, r: Reporter): void {
  const seen = new Set<string>();
  for (const rule of ctx.rules) {
    if (rule.keyframes || isTokenRule(rule) || !CONTROL_SEL.test(rule.selector) || CONTROL_SKIP.test(rule.selector)) continue;
    if (rule.media && /max-width/i.test(rule.media)) continue;
    const multiline = /(^|[\s,>+~(])textarea\b/i.test(rule.selector);
    for (const d of rule.decls) {
      if (!/^(min-)?height$/.test(d.prop) || (multiline && d.prop === 'min-height')) continue;
      const px = pxOf(resolveVars(d.value, ctx.tokens));
      if (px == null || (px >= 44 && px <= 52) || seen.has(rule.selector)) continue;
      seen.add(rule.selector);
      r.report('control-height', rule.file, d.line, `${d.prop}: ${trunc(d.value, 20)} (${px}px) on ${rule.selector}: controls stand 44 to 52px`, { fix: 'min-height: 48px' });
    }
  }
}

// sloplint HIDE_OK (gate 62): states and parts that are hidden at rest by nature
const HIDE_OK = /tooltip|popover|menu|dropdown|modal|dialog|toast|overlay|backdrop|sheet|drawer|panel|:hover|:focus|:checked|:target|\[open|\[aria-(?:expanded|selected|current|pressed)|::before|::after|\.is-|\[hidden|\[aria-hidden|sr-only|visually-hidden|skip|placeholder|::marker|\[data-slot/i;
const REVEALISH = /reveal|fade|animate|aos|in-view|inview|appear|enter|rise|slide|stagger|observe|lazy/i;

// sloplint startingStyleText (gate 62): the selectors every @starting-style block declares, plus the selector it sits under, as whole comma parts (a substring test let `.reveal-wrap` in one block silence `.reveal`); a block inside one already taken is part of it, so an unclosed block costs the rest of the sheet once
function startingSelectors(css: string): Set<string> {
  const out = new Set<string>();
  const add = (text: string) => { for (const part of splitTop(text)) if (part.trim()) out.add(part.trim().replace(/\s+/g, ' ')); };
  let taken = 0;
  for (const m of css.matchAll(/@starting-style\s*\{/gi)) {
    if (m.index! < taken) continue;
    let depth = 1, k = m.index! + m[0].length;
    while (k < css.length && depth > 0) { if (css[k] === '{') depth++; else if (css[k] === '}') depth--; k++; }
    taken = k;
    for (const s of css.slice(m.index! + m[0].length, k).matchAll(/([^{};]+)\{/g)) add(s[1]);
    const open = css.lastIndexOf('{', m.index! - 1), close = css.lastIndexOf('}', m.index! - 1);
    if (open > close) add(css.slice(Math.max(close + 1, 0), open));
  }
  return out;
}

// sloplint check62 (gate 62)
function hiddenAtRest(ctx: LintContext, r: Reporter): void {
  const starting = startingSelectors(ctx.allCss);
  const jsScoped = (sel: string) => /(^|[\s,])(html|body)?\.js\b|\[data-js|\.no-js|html\.has-js/i.test(sel);
  const animated = new Map<string, Array<{ selector: string; decls: Array<{ prop: string; value: string }> }>>();
  for (const rule of ctx.rules) if (rule.keyframes) {
    if (!animated.has(rule.keyframes)) animated.set(rule.keyframes, []);
    animated.get(rule.keyframes)!.push(rule);
  }
  const animatesVisible = (name: string) => (animated.get(name) || []).some((rule) => /to|100%/.test(rule.selector) && rule.decls.some((d) => d.prop === 'opacity' && parseFloat(d.value) === 1));
  const seen = new Set<string>();
  for (const rule of ctx.rules) {
    if (rule.keyframes || (rule.media && /\bprint\b/i.test(rule.media)) || rule.selector === '@font-face') continue;
    const hidden = rule.decls.find((d) => (d.prop === 'opacity' && parseFloat(resolveVars(d.value, ctx.tokens)) === 0) || (d.prop === 'visibility' && /hidden/.test(d.value)));
    if (!hidden) continue;
    if (HIDE_OK.test(rule.selector.replace(/:not\([^)]*\)/g, '')) || jsScoped(rule.selector) || (starting.size > 0 && splitTop(rule.selector).some((part) => starting.has(part.trim().replace(/\s+/g, ' '))))) continue;
    const revealish = REVEALISH.test(rule.selector) || rule.decls.some((d) => d.prop === 'transform' && /translate|scale/.test(d.value));
    if (!revealish) continue;
    const anim = rule.decls.find((d) => d.prop === 'animation' || d.prop === 'animation-name');
    const animName = anim ? anim.value.split(/\s+/).find((w) => animated.has(w)) : null;
    if (animName && animatesVisible(animName)) continue;
    if (seen.has(rule.selector)) continue;
    seen.add(rule.selector);
    r.report('content-hidden-at-rest', rule.file, hidden.line, `${rule.selector} is hidden at rest (${hidden.prop}: ${hidden.value}) and needs a script to appear`);
  }
}

export function run(ctx: LintContext, r: Reporter): void {
  layoutTransitions(ctx, r);
  hoverTells(ctx, r);
  bounceEasing(ctx, r);
  focusRingFade(ctx, r);
  tooltipDelay(ctx, r);
  autorotate(ctx, r);
  focusAndStates(ctx, r);
  reducedMotion(ctx, r);
  media(ctx, r);
  inputStates(ctx, r);
  controlHeight(ctx, r);
  hiddenAtRest(ctx, r);
}
