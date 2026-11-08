/**
 * Chrome rules, the eyebrow half (sloplint gate 54; Nutlope/hallmark, MIT, see
 * NOTICE.md), rewritten in gstack's voice. Rule id: kicker-above-heading. The
 * eyebrow is short inert type before a heading that only announces it; a
 * caption, a table head, a form label, a nav label, a byline, a unit after
 * its figure, a real filename, a live status chip and a link that goes
 * somewhere real are not eyebrows.
 */
import { fontPx, styleFor, trackingEm, valueOf, type LintContext } from '../context';
import { escapeRe, ancestorsOf, directChildren, getAttr, innerOf, plainText, type Child } from '../html';
import { trunc, type Reporter } from '../report';

const EYEBROW_CONTAINER = /^(div|header|footer|section|article|aside|hgroup|li|main|figure|a|body|blockquote)$/;
const EYEBROW_SKIP_TAGS = /^(figcaption|label|legend|caption|th|dt|summary|option|code|kbd|button|select|nav|time)$/;
/** Shared with the Tailwind reader of the same rule, so both tiers agree on what an eyebrow is. */
export const EYEBROW_ANCESTOR_SKIP = /^(form|fieldset|table|thead|tbody|nav|menu|dl|select|figcaption|label|button)$/;
export const EYEBROW_BLOCKY = /<(p|ul|ol|hr|h[1-6]|img|table|figure|section|article|blockquote|form|dl)\b/i;
const EYEBROW_CLASS = /\b(eyebrow|kicker|overline|superhead|suphead|rubric|strap(line)?|pre-?(title|head(ing)?)|section-?label|num-?label|chapter|ordinal|topic|category|dept)\b|__(num|label|tag|kicker|chip|badge|meta|index|caps|micro)\b|\b(tag|chip|badge|meta|caps|micro|label|index)\b/i;
export const EYEBROW_ANNOUNCE = /^(features?|benefits?|introducing|new|how it works?|the (process|tour)|our (process|story|work|team|approach|values?)|why (us|choose|we)|pricing|plans?|faq|questions?|testimonials?|reviews?|trusted by|as seen in|what we do|about( us)?|services?|solutions?|use cases?|get started|contact|team|work|projects?|gallery|blog|news|resources?|examples?|overview)$/i;

// sloplint capsRatio
export function capsRatio(s: string): number {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (!letters) return 0;
  return (letters.match(/[A-Z]/g) || []).length / letters.length;
}

// sloplint eyebrowHeadingBearing (gate 54)
function eyebrowHeadingBearing(ctx: LintContext, B: Child, aPx: number | null): boolean {
  if (/^h[1-6]$/.test(B.name)) return true;
  if (/<h[1-6][\s>]/i.test(B.html)) return true;
  const cls = getAttr(B.open, 'class') || '';
  if (!/__(title|display|head(line)?|h\d)\b|hero__/i.test(cls)) return false;
  const bPx = fontPx(ctx, styleFor(ctx, cls, B.name));
  return bPx != null && aPx != null && bPx >= 1.5 * aPx;
}

/** The text of A when A is an eyebrow before B; null when A carries a fact, a destination or an identifier. */
// sloplint eyebrowHit (gate 54)
function eyebrowHit(ctx: LintContext, A: Child, B: Child, inOrderedList: boolean): { text: string } | null {
  if (EYEBROW_SKIP_TAGS.test(A.name)) return null;
  if (/(^|\s)for\s*=/i.test(A.open)) return null;
  if (/role\s*=\s*["']status|aria-live|aria-current|aria-hidden\s*=\s*["']true/i.test(A.open)) return null;
  const inner = A.html.slice(A.open.length);
  if (EYEBROW_BLOCKY.test(inner) || /<br\b/i.test(inner)) return null;
  if (/<time\b[^>]*\sdatetime\s*=/i.test(A.html)) return null;
  if (/<img\b[^>]*\salt\s*=\s*["'][^"']+/i.test(A.html)) return null;

  const ownHref = A.name === 'a' ? getAttr(A.open, 'href') : null;
  if (ownHref && !/^#?$/.test(ownHref.trim())) return null;
  const innerHref = /<a\b[^>]*\shref\s*=\s*["']([^"']*)["']/i.exec(inner);
  if (innerHref && !/^#?$/.test(innerHref[1].trim())) return null;

  const text = plainText(A.html);
  if (!text) return null;
  const words = text.split(/[\s·/|\u2014\u2013]+/).filter(Boolean);
  if (words.length > 7 || text.length > 56) return null;
  if (/[\w/-]+\.[a-z]{1,4}$/i.test(text)) return null;

  if (/^[\d.,]+\s*(?:[%°+]|[a-z]{1,3})$/i.test(text)) return null;
  const stripped = text.replace(/^\s*(?:no\.?\s*)?\d{1,3}(?:\s*[·./\u2014\u2013-]\s*|\s+|$)/i, '').trim();
  if ((stripped.match(/\d/g) || []).length >= 2) return null;

  if (inOrderedList && stripped && !EYEBROW_ANNOUNCE.test(stripped)) return null;

  const cls = getAttr(A.open, 'class') || '';
  const aDecls = styleFor(ctx, cls, A.name);
  const pos = valueOf(ctx, aDecls, 'position');
  if (pos && /absolute|fixed/.test(pos)) return null;
  const aPx = fontPx(ctx, aDecls);
  if (!eyebrowHeadingBearing(ctx, B, aPx)) return null;

  if (EYEBROW_CLASS.test(cls)) return { text };
  let signals = 0;
  const tt = valueOf(ctx, aDecls, 'text-transform');
  if ((tt && /uppercase/.test(tt)) || (capsRatio(text) >= 0.6 && /[A-Z]/.test(text))) signals++;
  const tr = trackingEm(ctx, aDecls, aPx || 16);
  if (tr != null && tr >= 0.04) signals++;
  if (aPx != null && aPx <= 15) signals++;
  const ff = valueOf(ctx, aDecls, 'font-family');
  if (ff && /mono|--font-label/i.test(ff)) signals++;
  const fv = valueOf(ctx, aDecls, 'font-variant-caps');
  if (fv && /small-caps/.test(fv)) signals++;
  if (signals >= 2) return { text };
  if (EYEBROW_ANNOUNCE.test(stripped)) return { text };
  return null;
}

// sloplint check54 (gate 54)
function checkEyebrow(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    for (let i = 0; i < doc.tags.length; i++) {
      const t = doc.tags[i];
      if (t.close || t.selfClosing || !EYEBROW_CONTAINER.test(t.name)) continue;
      const ancestors = ancestorsOf(doc, i);
      if (ancestors.some((n) => EYEBROW_ANCESTOR_SKIP.test(n))) continue;
      const inOl = ancestors.includes('ol');
      const kids = directChildren(doc, i);
      for (let k = 0; k < kids.length - 1; k++) {
        const A = kids[k];
        let B: Child | null = null;
        for (let j = k + 1; j < Math.min(kids.length, k + 3); j++) {
          const c = kids[j];
          if (c.name === 'hr' || /aria-hidden\s*=\s*["']true/i.test(c.open)) continue;
          B = c;
          break;
        }
        if (!B) continue;
        const hit = eyebrowHit(ctx, A, B, inOl);
        if (!hit) continue;
        r.report('kicker-above-heading', doc.file, doc.tags[A.idx]?.line || t.line, 'the eyebrow "' + trunc(hit.text, 32) + '" before <' + B.name + '>', { fix: 'cut it; the heading already says this. Where the heading is figurative, the label becomes the heading' });
        break;
      }
    }
  }
}

// sloplint check54Unheaded (gate 54)
function checkUnheadedSection(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    for (let i = 0; i < doc.tags.length; i++) {
      const t = doc.tags[i];
      if (t.close || t.selfClosing || !/^(section|article)$/.test(t.name)) continue;
      const labelledBy = getAttr(t.attrs, 'aria-labelledby');
      if (!labelledBy) continue;
      const body = innerOf(doc, i);
      if (!body || /<h[1-6][\s>]/i.test(body.inner)) continue;
      const idRe = new RegExp('<([a-z][\\w-]*)\\b[^>]*\\sid\\s*=\\s*["\']' + escapeRe(labelledBy.split(/\s+/)[0]) + '["\'][^>]*>', 'i');
      const m = idRe.exec(body.inner);
      if (!m || /^h[1-6]$/i.test(m[1])) continue;
      r.report('kicker-above-heading', doc.file, doc.lineOf(body.endPos - body.inner.length + m.index), 'a section labelled by <' + m[1].toLowerCase() + '> with no heading element', { fix: 'promote the label to a heading; a label doing heading duty is a heading' });
    }
  }
}

export function runEyebrow(ctx: LintContext, r: Reporter): void {
  checkEyebrow(ctx, r);
  checkUnheadedSection(ctx, r);
}
