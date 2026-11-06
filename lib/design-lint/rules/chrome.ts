/**
 * Chrome rules of the design lint (sloplint gates 19 42 46a 47a 47b 47c 54 63 68 69 70 85; Nutlope/hallmark,
 * MIT, see NOTICE.md), rewritten in gstack's voice. Rule ids: aphoristic-cadence, generic-hero-copy, generic-cta-copy, em-dash-overuse, template-footer-line, template-nav, template-footer, invented-proof, drawn-browser-chrome, device-frame, imitation-material, kicker-above-heading, template-punctuation, wireframe-slots, repeated-fact, fake-send, email-band-close.
 * Gate 19 lives in rules/chrome-copy.ts (with the two-filled-buttons half of F4), gate 54 in rules/chrome-eyebrow.ts.
 * hallmark's theme stamp does not exist here: the nav and footer shapes always report, and the
 * visitor's job comes from --job alone.
 */
import type { LintContext } from '../context';
import { lineIndex } from '../css';
import { closeIndex, getAttr, innerOf, maskedProse, openTags, plainText, textOf, treeOf, type Doc, type Tag } from '../html';
import { trunc, type Reporter } from '../report';
import { runChromeCopy } from './chrome-copy';
import { runEyebrow } from './chrome-eyebrow';

// sloplint check42 (gate 42)
function checkNavShape(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const navIdx = doc.tags.findIndex((t) => !t.close && (t.name === 'nav' || (t.name === 'header' && /banner|nav/i.test(t.attrs))));
    if (navIdx === -1) continue;
    const inner = innerOf(doc, navIdx);
    if (!inner) continue;
    const links = (inner.inner.match(/<a\b/gi) || []).length;
    const navTag = doc.tags[navIdx];
    const navCls = (getAttr(navTag.attrs, 'class') || '').split(/\s+/)[0];
    const hairline = ctx.rules.some((rule) => ((navCls && rule.selector.includes(navCls)) || /(^|[\s,])(nav|header)\b/.test(rule.selector))
      && rule.decls.some((d) => /^border(-bottom)?$/.test(d.prop) && /\b1px\b/.test(d.value)));
    const hasCta = /btn|cta|button/i.test(inner.inner);
    if (links >= 4 && links <= 6 && hairline && hasCta) {
      r.report('template-nav', doc.file, navTag.line, 'the reflex nav shape: ' + links + ' inline links, a button and a 1px hairline under');
    }
  }
}

// sloplint check42Footer (gate 42)
function checkFooterShape(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const idx = doc.tags.findIndex((t) => !t.close && t.name === 'footer');
    if (idx === -1) continue;
    const inner = innerOf(doc, idx);
    if (!inner) continue;
    const uls = (inner.inner.match(/<ul\b/gi) || []).length;
    const fourEqualCol = ctx.rules.some((rule) => /footer/i.test(rule.selector) && rule.decls.some((d) =>
      d.prop === 'grid-template-columns'
      && (/repeat\(\s*4\s*,/.test(d.value) || /^(1fr|minmax\([^)]*\))(\s+(1fr|minmax\([^)]*\))){3,}$/.test(d.value.trim()))));
    let linkGroups = 0;
    const end = closeIndex(doc, idx);
    for (const el of openTags(doc, /^(ul|div|p|nav)$/, idx + 1, end)) {
      const column = el.tag.name === 'ul' || /col|column|links|group/.test(getAttr(el.tag.attrs, 'class') || '');
      if (column && openTags(doc, /^a$/, el.idx + 1, closeIndex(doc, el.idx)).length >= 3) linkGroups++;
    }
    if (uls >= 4 || (fourEqualCol && linkGroups >= 3)) {
      r.report('template-footer', doc.file, doc.tags[idx].line, 'the reflex footer shape: ' + (uls >= 4 ? uls + ' link columns' : 'four equal columns of links'));
    }
  }
}

const PROOF_SHAPES = [
  /\b\d+(\.\d+)?\s*[x×]\s*faster\b/i,
  /trusted by [\d,.]+\s*\+?/i,
  /\b99\.9+\s*%/,
  /\b[\d,]{4,}\s*\+\s*(teams|users|customers|developers|companies|creators)\b/i,
  /\b\d+(\.\d+)?\s*%\s*(faster|uptime|conversion|accuracy|retention|growth|fewer|less|more)\b/i,
  /\+\s*\d+(\.\d+)?\s*%\s*(conversion|growth|revenue|retention)\b/i,
  /\bsaves?\s+\d+\s+hours?\b/i,
];

// sloplint check46 (gate 46a)
function checkInventedProof(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const prose = maskedProse(doc);
    const lines = new Set<number>();
    for (const re of PROOF_SHAPES) {
      const m = re.exec(prose);
      if (!m) continue;
      const line = doc.lineOf(m.index);
      if (lines.has(line)) continue;
      lines.add(line);
      r.report('invented-proof', doc.file, line, 'the metric "' + m[0].trim() + '" has no source on the page', { suspected: true, fix: 'the number the user supplied, or drop the claim' });
    }
  }
}

const CHROME_47: Array<[string, string, RegExp]> = [
  ['drawn-browser-chrome', 'a drawn browser bar', /(browser|window|mac|osx)[-_]?(bar|chrome|dots|controls)|traffic[-_]?light|title[-_]?bar|window[-_]?(dots|buttons)|url[-_]?(bar|pill)/i],
  ['device-frame', 'a device frame', /phone[-_]?(frame|mock(up)?)|device[-_]?frame|\bnotch\b|terminal[-_]?(chrome|frame|bar|dots|header)|(ide|editor)[-_]?(chrome|frame)|(browser|window)[-_]?frame/i],
];

// sloplint check47 (gates 47a and 47b)
function checkDrawnChrome(ctx: LintContext, r: Reporter): void {
  for (const [rule, what, re] of CHROME_47) {
    for (const doc of ctx.docs) {
      for (const t of doc.tags) {
        if (t.close) continue;
        const cls = getAttr(t.attrs, 'class');
        const m = cls ? re.exec(cls) : null;
        if (m) { r.report(rule, doc.file, t.line, what + ' drawn in CSS: class "' + m[0] + '" (class="' + trunc(cls!, 32) + '")'); break; }
      }
    }
    for (const cssRule of ctx.rules) {
      const m = re.exec(cssRule.selector);
      if (m) { r.report(rule, cssRule.file, cssRule.line, what + ' drawn in CSS: selector ' + cssRule.selector); break; }
    }
  }
}

const PLACEHOLDER_IMG = /placehold\.co|via\.placeholder\.com|source\.unsplash\.com\/random|dummyimage\.com/i;

// sloplint check47Placeholders (gate 47c)
function checkPlaceholderImages(ctx: LintContext, r: Reporter): void {
  const fix = 'a real asset, or a labelled slot in the page\'s own colours';
  for (const doc of ctx.docs) {
    const m = PLACEHOLDER_IMG.exec(doc.src);
    if (m) r.report('imitation-material', doc.file, doc.lineOf(m.index), 'a placeholder image service (' + m[0] + ') stands in for a picture', { fix });
  }
  for (const c of ctx.cssFiles) {
    const m = PLACEHOLDER_IMG.exec(c.raw);
    if (m) r.report('imitation-material', c.file, lineIndex(c.raw)(m.index), 'a placeholder image service (' + m[0] + ') stands in for a picture', { fix });
  }
}

const TEXT_TAGS = new Set(['p', 'span', 'li', 'small', 'a', 'div', 'figcaption', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'time', 'dd', 'dt', 'cite', 'strong', 'em', 'b', 'label', 'button', 'summary']);
const TICKER = /marquee|ticker|tape|crawl/i;

// sloplint check63 (gate 63)
function checkTemplatePunctuation(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const dotLines = new Set<number>(), arrowLines = new Set<number>();
    const { parent } = treeOf(doc);
    const inTicker = new Uint8Array(doc.tags.length);
    for (let i = 0; i < doc.tags.length; i++) {
      const t = doc.tags[i];
      inTicker[i] = (parent[i] >= 0 && inTicker[parent[i]]) || (!t.close && !t.selfClosing && TICKER.test(getAttr(t.attrs, 'class') || '') ? 1 : 0);
    }
    for (let i = 0; i < doc.tags.length; i++) {
      const t = doc.tags[i];
      if (t.close || t.selfClosing || !TEXT_TAGS.has(t.name) || inTicker[i]) continue;
      const inner = innerOf(doc, i);
      if (!inner || /<(p|div|li|section|article|ul|ol|table)\b/i.test(inner.inner)) continue;
      const text = textOf(doc, i);
      if (!text) continue;
      const dots = (text.match(/\s[·•]\s/g) || []).length;
      if (dots >= 2 && !dotLines.has(t.line)) {
        dotLines.add(t.line);
        r.report('template-punctuation', doc.file, t.line, 'middle dots join a meta string: "' + trunc(text, 50) + '"', { fix: 'line breaks, columns or hairlines; one dot in a byline at most' });
      }
      if ((t.name === 'a' || t.name === 'button') && /(\u2192|->|\u203a|\u00bb|\u27f6)\s*$/.test(text) && !arrowLines.has(t.line)) {
        arrowLines.add(t.line);
        r.report('template-punctuation', doc.file, t.line, 'an arrow glued to the label "' + trunc(text, 40) + '"', { fix: 'a verb as the label; the link already says it goes somewhere' });
      }
      if (/^[A-Z]{3,}\s+-\s+\S/.test(text) && text.length < 60) {
        r.report('template-punctuation', doc.file, t.line, 'a WORD - fragment label "' + trunc(text, 40) + '"', { fix: 'say it as a sentence or a heading' });
      }
    }
    let dotCount = 0;
    for (let i = 0; i < doc.tags.length; i++) {
      const t = doc.tags[i];
      if (t.close || !/^(span|i|b|em|s)$/.test(t.name)) continue;
      const cls = getAttr(t.attrs, 'class') || '';
      if (!/(^|\s)(dot|status-dot|indicator|bullet|pip|blip)(\s|$|__|-)/i.test(cls)) continue;
      if (/aria-live|role\s*=\s*"status"/i.test(t.attrs)) continue;
      if (textOf(doc, i)) continue;
      dotCount++;
      if (dotCount === 3) r.report('template-punctuation', doc.file, t.line, 'decorative status dots (' + cls.trim() + ') repeated across the page', { fix: 'delete them; a dot means live state, and only where it is one' });
    }
  }
}

// sloplint check68 (gate 68); the no-slot-script half (F18) is render-only and not ported
function checkWireframeSlots(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    if (doc.kind !== 'html') continue;
    const { parent } = treeOf(doc);
    const slots: Array<{ i: number; t: Tag }> = [];
    for (let i = 0; i < doc.tags.length; i++) {
      const t = doc.tags[i];
      if (t.close || !/\bdata-slot\s*=/.test(t.attrs)) continue;
      const inner = t.selfClosing ? null : innerOf(doc, i);
      if (inner && /<img\b[^>]*\bsrc\s*=\s*["'][^"']+["']/i.test(inner.inner)) continue;
      if (inner && (inner.inner.match(/<[a-z][\w-]*\b[^>]*>\s*[^<\s]/gi) || []).length >= 6) continue;
      let hiddenUp = false;
      for (let k = parent[i]; k >= 0 && !hiddenUp; k = parent[k]) if (/(?:^|\s)hidden(?:\s|=|$)/.test(doc.tags[k].attrs)) hiddenUp = true;
      if (hiddenUp) continue;
      slots.push({ i, t });
    }
    if (slots.length > 5) r.report('wireframe-slots', doc.file, slots[5].t.line, slots.length + ' empty slots on one page', { fix: 'two to four slots carry a page; set the rest in type, with names and facts in a list or table' });
    const byRun = new Map<number, number>();
    for (const sl of slots) {
      const p = parent[sl.i];
      const gp = p >= 0 ? parent[p] : -1;
      const ggp = gp >= 0 ? parent[gp] : -1;
      for (const key of new Set([p, gp, ggp])) { if (key < 0) continue; byRun.set(key, (byRun.get(key) || 0) + 1); }
    }
    for (const [key, n] of byRun) {
      if (n < 4) continue;
      r.report('wireframe-slots', doc.file, doc.tags[key].line, n + ' empty slots in one row or grid', { fix: 'a set the page has no pictures of is set in type, with one slot at most' });
      break;
    }
  }
}

const FACT = /(?:[£$€¥]\s?\d[\d,.]*|(?<![\d,.])\d[\d,.]*\s?(?:%|(?:pm|am|MAD|kg|g|ml|km|mi|miles)\b)|\b\d{1,2}:\d{2}\b)/gi;
const REGION = /^(section|header|footer|article|aside|nav|form|dialog)$/;

// sloplint check69 (gate 69)
function checkRepeatedFact(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    if (doc.kind !== 'html') continue;
    const bodyAt = doc.tags.findIndex((t) => !t.close && t.name === 'body');
    const { parent } = treeOf(doc);
    const seen = new Map<string, Set<number | string>>();
    const regionOf = (i: number): number | string => {
      const t = doc.tags[i];
      const chain: number[] = [];
      for (let p = t.close || t.selfClosing ? parent[i] : i; p >= 0; p = parent[p]) chain.push(p);
      chain.reverse();
      const region = chain.find((p) => REGION.test(doc.tags[p].name));
      if (region != null) return region;
      const band = chain.find((p, k) => k > 0 && /^(body|main)$/.test(doc.tags[chain[k - 1]].name) && doc.tags[p].name !== 'main');
      return band ?? 'root';
    };
    for (let i = Math.max(bodyAt, 0); i < doc.tags.length; i++) {
      const t = doc.tags[i];
      const next = doc.tags[i + 1];
      if (/^(script|style|template|noscript)$/.test(t.name) && !t.close) continue;
      const chunk = doc.masked.slice(t.end, next ? next.pos : doc.masked.length)
        .replace(/&pound;/g, '£').replace(/&euro;/g, '€').replace(/&nbsp;|&#160;/g, ' ');
      if (!chunk.trim()) continue;
      const region = regionOf(i);
      for (const f of chunk.match(FACT) || []) {
        const k = f.replace(/\s+/g, '').toLowerCase();
        if (!seen.has(k)) seen.set(k, new Set());
        seen.get(k)!.add(region);
      }
    }
    const loud = [...seen].map(([k, s]) => [k, s.size] as const).filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1]);
    if (loud.length) r.report('repeated-fact', doc.file, 1, 'the same fact printed in ' + loud[0][1] + ' sections: ' + loud.slice(0, 3).map(([k, n]) => k + ' (' + n + ')').join(', '));
  }
}

const SUCCESS = /\b(sent|thanks|thank you|reserved|booked|on the list|subscribed|in touch|received|confirmed|ordered|chosen|on its way|signed up|all set|you're in|you are in|done)\b/i;
const NEGATED = /\b(not|nothing|no|never|isn't|wasn't|didn't|cannot|can't|failed|try again|soon)\b/i;
const REQUEST = /\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|\.submit\s*\(\s*\)|axios|\$\.ajax/;
const JS_STRING = /(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;

// sloplint check70 (gate 70); string literals are paired in sequence so a short literal earlier in the script cannot desync the scan
function checkFakeSend(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const js = doc.scripts || '';
    if (!/<form\b|type\s*=\s*["']submit/i.test(doc.src) || !js.trim()) continue;
    let hit: string | null = null;
    for (const x of js.matchAll(JS_STRING)) {
      if (x[2].length < 4 || x[2].length > 140) continue;
      const words = x[2].trim().split(/\s+/);
      if (words.length >= 2 && SUCCESS.test(words.slice(0, 4).join(' ')) && !NEGATED.test(x[2])) { hit = x[0]; break; }
    }
    if (!hit || REQUEST.test(js)) continue;
    const at = (doc.scripts === doc.raw ? doc.raw : doc.src).indexOf(hit);
    r.report('fake-send', doc.file, doc.lineOf(at >= 0 ? at : 0), 'a script prints success ("' + trunc(hit.replace(/["'`]/g, ''), 30) + '") with no request behind it', { suspected: true });
  }
}

const NATIVE_LIST_JOB = /subscribe|join|attend|listen|visit|newsletter|waitlist/i;
const ASKS = /\b(book|enquir|inquir|request|contact|walkthrough|demo|quote|reserve|apply|start|create|order|buy|download|try|sign ?in|log ?in|continue)/i;
const LIST_WORDS = /newsletter|updates|subscribe|the list|mailing/i;

/** Whether the form opened at idx is an email sign-up: one or two fields, one of them email, under a button that does not book, order or ask. */
function isEmailSignup(doc: Doc, idx: number): boolean {
  const inner = innerOf(doc, idx);
  if (!inner) return false;
  const html = inner.inner;
  const end = closeIndex(doc, idx);
  const buttons = [...openTags(doc, /^button$/, idx + 1, end).map((b) => plainText(b.inner)),
    ...doc.tags.slice(idx + 1, end).filter((t) => !t.close && t.name === 'input' && /^submit$/i.test(getAttr(t.attrs, 'type') || '')).map((t) => getAttr(t.attrs, 'value') || '')].join(' ');
  if (ASKS.test(buttons) && !LIST_WORDS.test(buttons)) return false;
  const fields: string[] = [];
  for (const m of html.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
    const type = (getAttr(m[2], 'type') || 'text').toLowerCase();
    if (m[1].toLowerCase() === 'input' && /^(hidden|submit|checkbox|radio|button|reset|image)$/.test(type)) continue;
    if (type === 'password' || /\bpassword\b/i.test(getAttr(m[2], 'autocomplete') || '')) return false;
    fields.push(type + ' ' + [getAttr(m[2], 'name'), getAttr(m[2], 'id'), getAttr(m[2], 'placeholder'), getAttr(m[2], 'autocomplete')].filter(Boolean).join(' '));
  }
  return fields.length >= 1 && fields.length <= 2 && fields.some((f) => /^email\b/.test(f) || /e-?mail/i.test(f));
}

interface Open { t: Tag; i: number }

// gate 85, written for the static tier: the render tier's email-band close, read from the markup
function checkEmailBandClose(ctx: LintContext, r: Reporter): void {
  if (ctx.job && NATIVE_LIST_JOB.test(ctx.job)) return;
  for (const doc of ctx.docs) {
    if (doc.kind !== 'html') continue;
    const opens: Open[] = doc.tags.map((t, i) => ({ t, i })).filter(({ t }) => !t.close && !t.selfClosing);
    const endOf = (o: Open): number => innerOf(doc, o.i)?.endPos ?? doc.src.length;
    const footer = opens.filter(({ t }) => t.name === 'footer').pop() ?? null;
    const limit = footer ? footer.t.pos : doc.src.length;
    const before = opens.filter((o) => /^(section|form|article)$/.test(o.t.name) && o.t.pos < limit && endOf(o) <= limit).pop() ?? null;
    for (const box of [before, footer]) {
      if (!box) continue;
      const end = endOf(box);
      const form = opens.filter((o) => o.t.name === 'form' && o.i >= box.i && o.t.pos < end).find((o) => isEmailSignup(doc, o.i));
      if (!form) continue;
      const cls = getAttr(form.t.attrs, 'class');
      const name = cls ? '<form class="' + trunc(cls, 24) + '">' : '<form>';
      const where = box === footer ? 'in the footer' : 'as its last section';
      const job = ctx.job ? ' on a ' + ctx.job + ' page' : ', and no job was named (--job)';
      r.report('email-band-close', doc.file, form.t.line, 'the page closes on an email sign-up ' + name + ' ' + where + job);
      return;
    }
  }
}

export function run(ctx: LintContext, r: Reporter): void {
  runChromeCopy(ctx, r);
  runEyebrow(ctx, r);
  checkNavShape(ctx, r);
  checkFooterShape(ctx, r);
  checkInventedProof(ctx, r);
  checkDrawnChrome(ctx, r);
  checkPlaceholderImages(ctx, r);
  checkTemplatePunctuation(ctx, r);
  checkWireframeSlots(ctx, r);
  checkRepeatedFact(ctx, r);
  checkFakeSend(ctx, r);
  checkEmailBandClose(ctx, r);
}
