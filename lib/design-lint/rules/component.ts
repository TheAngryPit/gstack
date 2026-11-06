/**
 * Component rules of the design lint (sloplint checkTailwind and
 * checkComponentText; Nutlope/hallmark, MIT, see NOTICE.md), rewritten in
 * gstack's voice: the Tailwind form of gates 2a 2b 3 6a 10a 11 12 29 48 54 64
 * 67 and 74 read off utility class strings in pages and components, plus
 * emoji icons and template punctuation (30a, 63) in component text.
 */
import type { LintContext } from '../context';
import { oneLine, relPath, trunc, type Finding, type Reporter } from '../report';
import { compInner, twEyebrow, twGlow, twGradient, twGroup, twMonoIsMaterial, twPlain, twText, twTiles, twTokens, twTrackedCaps, twWhere, twDataText, type TwItem } from '../tailwind';

const EMOJI_ICON = /(?![©®™‼⁉←-⇿])\p{Extended_Pictographic}/u;

/** Findings already on the record, keyed rule|file|line, so a Tailwind tell on a line the stylesheet rules already reported is not repeated; O(1) per lookup however many labels a page holds. */
function reported(r: Reporter): Set<string> {
  return new Set(r.findings.map((x) => `${x.rule}|${x.file}|${x.line}`));
}

/** The tells one class string carries on its own: motion, gradient, glow, literals, a moving image, tracked caps, the eyebrow, mono costume. */
function reportItem(ctx: LintContext, r: Reporter, it: TwItem, monoOk: boolean, seen: Set<string>): void {
  const { doc, info: f } = it;
  const where = twWhere(it);
  const file = oneLine(relPath(doc.file, r.cwd));
  const had = (rule: string) => seen.has(`${rule}|${file}|${it.line}`);
  if (f.tAll) r.report('layout-transition', doc.file, it.line, `${f.tAll} on ${where}`, { fix: 'name the properties: transition-colors, transition-opacity or transition-transform' });
  if (f.bounce || f.overshoot) r.report('bounce-easing', doc.file, it.line, `${f.bounce ? 'bounce' : 'overshoot easing'} ${f.bounce || f.overshoot} on ${where}`, { fix: 'an exponential ease-out on UI state; no bounce or overshoot' });
  const g = twGradient(ctx, f);
  if (g && g.banned) r.report('purple-blue-gradient', doc.file, it.line, `${g.banned} gradient${g.text ? ' text' : ''} (${g.list}) on ${where}`);
  else if (g && g.text) r.report('gradient-text', doc.file, it.line, `gradient text (${g.list}) on ${where}`);
  const glow = f.bblur && f.glass ? `glass: ${f.bblur} over ${f.glass}`
    : f.blur >= 40 && f.pos && (f.fill || f.grad || f.stops.length) ? `blurred orb: ${f.blurTok} on a filled ${f.pos} element`
      : twGlow(ctx, f);
  if (glow) r.report('glow-wash', doc.file, it.line, `${glow} on ${where}`);
  if (f.colours.length || f.font) {
    const what = [f.colours.length ? `colour literal ${f.colours[0].tok}` : null, f.font ? `font-family literal ${f.font}` : null].filter(Boolean).join(' and ');
    const certain = !!f.font || f.colours.some((c) => !c.oklch);
    r.report('literal-outside-tokens', doc.file, it.line, `${what} in a class on ${where}`, { fix: 'lift the value into the token block (@theme or :root) and use its utility name', suspected: !certain });
  }
  if ((f.hScale || f.hRotate) && /^(?:img|picture|image)$/i.test(it.tag)) r.report('hover-tells', doc.file, it.line, `${f.hScale || f.hRotate} on ${where}: the image moves on hover`, { fix: 'imagery sits still; give the container the feedback' });
  const caps = twTrackedCaps(it, twGroup(ctx));
  if (caps && !had('wide-tracking')) {
    const text = it.virtual ? '' : twText(it);
    r.report('wide-tracking', doc.file, it.line, `${text ? `"${trunc(text, 24)}" ` : ''}${caps.what}${caps.size != null ? ` at ${caps.size}px` : ''}${caps.em != null ? ` tracked ${caps.em}em` : ''} on ${where}`, { fix: 'sentence case in the body face, a step smaller, untracked: drop uppercase and the tracking-* class' });
  }
  const eyebrow = twEyebrow(it);
  if (eyebrow && !had('kicker-above-heading')) {
    r.report('kicker-above-heading', doc.file, it.line, `eyebrow ${eyebrow.text ? `"${trunc(eyebrow.text, 24)}" ` : ''}before <${eyebrow.next}> (${eyebrow.signal} at ${it.frame.size}px)`);
  }
  if (!monoOk && f.mono && !it.virtual && !it.frame.code && !/^(?:code|pre|kbd|samp|time|var)$/.test(it.tag) && it.frame.size != null && it.frame.size <= 14) {
    const text = twText(it);
    if (/[A-Za-z]/.test(text) && !twDataText(text)) r.report('monospace-costume', doc.file, it.line, `font-mono on "${trunc(text, 24)}" at ${it.frame.size}px (${where})`, { fix: 'labels in the body face at a smaller size and normal case; font-mono only for code and figures' });
  }
}

/** The tells a file carries as a whole: a default palette, hover scale everywhere, a vh hero, three icon tiles. */
function reportFile(r: Reporter, list: TwItem[]): void {
  const doc = list[0].doc;
  const pal = new Map<string, TwItem>();
  let palAt: TwItem | null = null;
  for (const it of list) for (const p of it.info.pal) if (!pal.has(p)) { pal.set(p, it); if (pal.size === 5) palAt = it; }
  if (palAt) r.report('framework-palette', doc.file, palAt.line, `a framework default palette instead of the page's tokens: ${pal.size} distinct palette classes (${[...pal.keys()].slice(0, 4).join(' ')})`, { fix: "extend the Tailwind theme with the page's tokens and use those names" });
  const scaled = list.filter((it) => it.info.hScale);
  if (scaled.length >= 3) r.report('hover-tells', doc.file, scaled[2].line, `hover scale on ${scaled.length} elements in this file (${scaled.slice(0, 3).map((it) => it.info.hScale).join(', ')})`, { fix: 'one hover signal per element; not every card grows' });
  const first = new Set(['section', 'header'].map((n) => doc.tags.findIndex((t) => !t.close && t.name === n)).filter((x) => x >= 0));
  const byIdx = new Map<number, TwItem>();
  for (const it of list) if (it.idx >= 0) byIdx.set(it.idx, it);
  for (const it of list) {
    if (it.info.vh && !it.virtual && (first.has(it.idx) || it.info.hero)) r.report('vh-height', doc.file, it.line, `hero sized in vh: ${it.info.vh} on ${twWhere(it)}`, { fix: 'min-h-dvh or min-h-svh' });
    if (it.info.cols3 && it.idx >= 0) {
      const n = twTiles(it, byIdx);
      if (n >= 3) r.report('template-cards', doc.file, it.line, `icon-tile row: ${n} children of ${twWhere(it)} open on an icon in a rounded filled tile above an h3`, { fix: 'vary the column widths or drop the icon tiles' });
    }
  }
}

// sloplint checkTailwind (gates 10a 12 2a 2b 29 48 11 67 54 64 74 6a 3)
function checkTailwind(ctx: LintContext, r: Reporter): void {
  const tw = twGroup(ctx);
  if (!tw.items.length) return;
  const monoOk = twMonoIsMaterial(twTokens(ctx));
  const byDoc = new Map<string, TwItem[]>();
  const seen = reported(r);
  for (const it of tw.items) {
    if (!byDoc.has(it.file)) byDoc.set(it.file, []);
    byDoc.get(it.file)!.push(it);
    const before = r.findings.length;
    reportItem(ctx, r, it, monoOk, seen);
    for (let k = before; k < r.findings.length; k++) seen.add(`${r.findings[k].rule}|${r.findings[k].file}|${r.findings[k].line}`);
  }
  for (const list of byDoc.values()) reportFile(r, list);
}

// sloplint checkComponentText (gates 63 30a)
function checkComponentText(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    for (let c = 0; c < doc.comps.length; c++) {
      const t = doc.comps[c];
      if (t.close || t.selfClosing) continue;
      const inner = compInner(doc, c);
      if (!inner || /<(?:p|div|li|section|article|ul|ol|table)\b/i.test(inner)) continue;
      const text = twPlain(doc, inner);
      if (!text) continue;
      if (/(?:link|button|btn|cta)$/i.test(t.name) && /(→|->|›|»|⟶)\s*$/.test(text)) r.report('template-punctuation', doc.file, t.line, `arrow glued to the label "${trunc(text, 40)}" (<${t.name}>)`, { fix: 'a verb as the label; the link already says it goes somewhere' });
      if ((text.match(/\s[·•]\s/g) || []).length >= 2) r.report('template-punctuation', doc.file, t.line, `middle-dot meta string "${trunc(text, 50)}"`, { fix: 'line breaks, columns or hairlines; one dot in a byline at most' });
      if (text.length <= 4 && EMOJI_ICON.test(text)) {
        const recorded = (doc.cache.emojiQuoted as Map<string, Finding[]> | undefined)?.get(text) ?? [];
        const icon = recorded.find((f) => f.line === t.line) ?? recorded[0];
        if (icon) { recorded.splice(recorded.indexOf(icon), 1); const outer = r.findings.indexOf(icon); if (outer >= 0) r.findings.splice(outer, 1); }
        r.report('emoji-decoration', doc.file, t.line, `emoji icon "${text}" in <${t.name}>`, { fix: 'one icon library or custom SVG' });
      }
    }
  }
}

export function run(ctx: LintContext, r: Reporter): void {
  checkTailwind(ctx, r);
  checkComponentText(ctx, r);
}
