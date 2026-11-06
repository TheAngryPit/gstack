/**
 * The render tier's in-page measurements of quality at 1440: heading rhythm,
 * cramped boxes, over-long prose lines, weak field edges, text that strains,
 * the weight count and the lonely grid item. Same rules as render-probe.ts:
 * each function is serialised into the page and may touch nothing outside its
 * arguments.
 *
 * Ported from Nutlope/hallmark's sloplint-render.mjs observeQuality (MIT, see
 * NOTICE.md): gates 71, 72, 25, 40 (field edges), 75, F19, F20.
 */
import type { ProbeFinding, Probes } from './render-probe';

// sloplint-render observeQuality: the quality checks in one eval
export function glQuality(P: Probes): ProbeFinding[] {
  const { vis } = P.H;
  const quiet = (el: Element) => !!el.closest('script, style, noscript, [aria-hidden="true"], dialog:not([open])') || !!(el.parentElement && el.parentElement.closest('svg'));
  const all = Array.from(document.body.querySelectorAll('*')).filter((el) => !quiet(el) && vis(el));
  return [...P.rhythm(P, all), ...P.padding(P, all), ...P.prose(P, all), ...P.fields(P, all), ...P.strain(P), ...P.grid(P, all)];
}

// sloplint-render observeQuality, the crowded head (gate 71)
export function glRhythm(P: Probes, all: Element[]): ProbeFinding[] {
  const { vis, name, text, clear, at } = P.H;
  const out: ProbeFinding[] = [];
  const quiet = (el: Element) => !!el.closest('script, style, noscript, [aria-hidden="true"], dialog:not([open])') || !!(el.parentElement && el.parentElement.closest('svg'));
  const abs = (r: DOMRect) => ({ top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right });
  const boxes: Array<{ el: Element; top: number; bottom: number; left: number; right: number }> = [];
  for (const el of all) {
    const media = /^(IMG|svg|CANVAS|VIDEO|PICTURE|IFRAME|INPUT|BUTTON|SELECT|TEXTAREA)$/.test(el.tagName) || el.hasAttribute('data-slot');
    if (!media && !Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim())) continue;
    boxes.push({ el, ...abs(el.getBoundingClientRect()) });
  }
  const overlapX = (a: { left: number; right: number }, b: { left: number; right: number }) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 8;
  const crowded: Array<{ text: string; el: Element }> = [];
  for (const h of document.querySelectorAll('h2, h3, h4')) {
    if (!vis(h) || quiet(h) || h.closest('nav, footer, table, [data-slot]')) continue;
    let small = false;
    for (let p = h.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (!clear(cs.backgroundColor) || parseFloat(cs.borderTopWidth) > 0 || cs.boxShadow !== 'none') { small = p.getBoundingClientRect().height < 200; break; }
    }
    if (small) continue;
    const hb = abs(h.getBoundingClientRect());
    let above: typeof boxes[number] | null = null, below: typeof boxes[number] | null = null;
    for (const b of boxes) {
      if (h.contains(b.el) || b.el.contains(h) || !overlapX(b, hb)) continue;
      if (b.bottom <= hb.top + 1 && (!above || b.bottom > above.bottom)) above = b;
      if (b.top >= hb.bottom - 1 && (!below || b.top < below.top)) below = b;
    }
    if (!above || !below) continue;
    const up = hb.top - above.bottom, down = below.top - hb.bottom;
    if (down < 6 || down > 160) continue;
    if (up < 0.75 * down && down - up >= 12) crowded.push({ text: name(h) + ' "' + text(h).slice(0, 18) + '" ' + Math.round(up) + 'px over, ' + Math.round(down) + 'px under', el: h });
  }
  if (crowded.length >= 2) out.push({ rule: 'heading-rhythm', grade: 'fail', evidence: 'heads nearer what precedes them than what they head: ' + crowded.slice(0, 2).map((c) => c.text).join('; '), at: at(crowded[0].el) });
  return out;
}

// sloplint-render observeQuality, the cramped box (gate 72)
export function glPadding(P: Probes, all: Element[]): ProbeFinding[] {
  const { vis, name, clear, at } = P.H;
  const out: ProbeFinding[] = [];
  const tight: Array<{ text: string; el: Element }> = [];
  for (const el of all) {
    if (tight.length >= 3) break;
    if (/^(SECTION|MAIN|HEADER|FOOTER|NAV|ARTICLE|INPUT|TEXTAREA|SELECT|svg|IMG|TABLE|THEAD|TBODY|TR|TD|TH|PRE|CODE|IFRAME|VIDEO|CANVAS|DIALOG)$/.test(el.tagName) || el.closest('[data-slot], table')) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 100 || r.height <= 30 || r.width > innerWidth * 0.9) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'inline') continue;
    if (/auto|scroll/.test(cs.overflowX + cs.overflowY)) continue;
    const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map((v) => parseFloat(v) || 0);
    const bc = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor];
    const inked = (k: number) => bw[k] >= 1 && !clear(bc[k]);
    let under = 'rgb(255, 255, 255)';
    for (let p = el.parentElement; p; p = p.parentElement) { const c = getComputedStyle(p).backgroundColor; if (!clear(c)) { under = c; break; } }
    const filled = !clear(cs.backgroundColor) && cs.backgroundColor !== under;
    if (!filled && !(inked(1) && inked(3))) continue;
    let L = Infinity, T = Infinity, Rr = -Infinity, B = -Infinity, fs = parseFloat(cs.fontSize) || 16;
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      const host = t.parentElement;
      if (!(t.textContent || '').trim() || !host || host.closest('svg') || !vis(host)) continue;
      let nested = false;
      for (let p: Element | null = host; p && p !== el; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (/absolute|fixed/.test(ps.position) || (!clear(ps.backgroundColor) && ps.backgroundColor !== cs.backgroundColor) || (parseFloat(ps.borderTopWidth) >= 1 && parseFloat(ps.borderLeftWidth) >= 1)) { nested = true; break; }
      }
      if (nested) continue;
      const rg = document.createRange(); rg.selectNodeContents(t);
      const hf = parseFloat(getComputedStyle(host).fontSize) || 16; const trim = hf >= 40 ? 0.2 * hf : 0;
      for (const q of rg.getClientRects()) { if (!q.width || !q.height) continue; L = Math.min(L, q.left); T = Math.min(T, q.top + trim); Rr = Math.max(Rr, q.right); B = Math.max(B, q.bottom - trim); fs = hf; }
    }
    if (L === Infinity) continue;
    const side = Math.max(8, Math.min(0.5 * fs, 24)) - 0.5, end = Math.max(4, Math.min(0.3 * fs, 12)) - 0.5;
    const inset: Array<[string, number, number]> = [['left', L - (r.left + bw[3]), side], ['right', r.right - bw[1] - Rr, side], ['top', T - (r.top + bw[0]), end], ['bottom', r.bottom - bw[2] - B, end]];
    const short = inset.filter(([, v, min]) => v < min);
    if (short.length) tight.push({ text: name(el) + ' ' + short.map(([k, v]) => k + ' ' + Math.round(v) + 'px').join(', '), el });
  }
  if (tight.length) out.push({ rule: 'cramped-padding', grade: 'fail', evidence: 'text crowds the edge of its box: ' + tight.map((t) => t.text).join('; '), fix: 'pad the box: max(8px, 0.5em) at the sides, max(4px, 0.3em) above and below', at: at(tight[0].el) });
  return out;
}

// sloplint-render observeQuality, running prose set too wide (gate 25)
export function glProse(P: Probes, all: Element[]): ProbeFinding[] {
  const { name, text, at } = P.H;
  const out: ProbeFinding[] = [];
  const long: Array<{ text: string; el: Element }> = [];
  for (const el of all) {
    if (long.length >= 2 || el.tagName !== 'P' || el.closest('nav, footer, table, figure, [data-slot]')) continue;
    const t = text(el);
    if (t.length < 240) continue;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    let cols = 1;
    for (let q: Element | null = el; q && q !== document.body && cols === 1; q = q.parentElement) { const qc = getComputedStyle(q); if (qc.columnCount !== 'auto' || qc.columnWidth !== 'auto') cols = Math.max(1, Math.round(q.getBoundingClientRect().width / Math.max(1, (el.getClientRects()[0] && el.getClientRects()[0].width) || q.getBoundingClientRect().width))); }
    const lines = Math.round(el.getBoundingClientRect().height / lh) * cols;
    if (lines >= 3 && t.length / lines > 88) long.push({ text: name(el) + ' about ' + Math.round(t.length / lines) + ' characters a line', el });
  }
  if (long.length) out.push({ rule: 'line-length', grade: 'fail', evidence: 'running prose set too wide: ' + long.map((l) => l.text).join(', '), fix: 'cap the measure at 45 to 75ch', at: at(long[0].el) });
  return out;
}

// sloplint-render observeQuality, a field's edge under 3:1 (gate 40)
export function glFields(P: Probes, all: Element[]): ProbeFinding[] {
  const { name, rgb, ratio, over, bgOf, at } = P.H;
  const out: ProbeFinding[] = [];
  const weak: Array<{ text: string; el: Element }> = [];
  const fields = all.filter((el) => /^(TEXTAREA|SELECT)$/.test(el.tagName) || (el.tagName === 'INPUT' && /^(text|email|search|tel|url|password|number|date|time)$/.test((el as HTMLInputElement).type)));
  for (const f of fields) {
    const fh = f.getBoundingClientRect().height;
    const around = bgOf(f.parentElement);
    let best = ratio(over(rgb(getComputedStyle(f).backgroundColor), around), around);
    for (let n: Element | null = f, d = 0; n && d < 3 && n.getBoundingClientRect().height <= fh + 48; n = n.parentElement, d++) {
      const cs = getComputedStyle(n); const back = d ? bgOf(n.parentElement) : around;
      const sides: Array<[string, string, string]> = [[cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor], [cs.borderRightWidth, cs.borderRightStyle, cs.borderRightColor], [cs.borderBottomWidth, cs.borderBottomStyle, cs.borderBottomColor], [cs.borderLeftWidth, cs.borderLeftStyle, cs.borderLeftColor]];
      for (const [w, s, c] of sides) if (parseFloat(w) >= 1 && s !== 'none') best = Math.max(best, ratio(over(rgb(c), back), back));
      for (const m of (cs.boxShadow || '').matchAll(/((?:rgba?|oklch|oklab|color)\([^)]*\)|#[0-9a-f]{3,8})\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+(-?[\d.]+)px/gi)) if (+m[4] === 0 && (+m[5] >= 1 || Math.abs(+m[3]) >= 1)) best = Math.max(best, ratio(over(rgb(m[1]), back), back));
    }
    if (best < 2.95) weak.push({ text: name(f) + ' ' + best.toFixed(2) + ':1', el: f });
  }
  if (weak.length) out.push({ rule: 'low-contrast', grade: 'fail', evidence: 'a field\'s edge is under 3:1 against what surrounds it: ' + weak.slice(0, 3).map((w) => w.text).join(', '), fix: 'draw the field in the muted token, or fill it a step off the surface it sits on', at: at(weak[0].el) });
  return out;
}

// sloplint-render observeQuality, text that strains and the weight count (gates 75 and F19)
export function glStrain(P: Probes): ProbeFinding[] {
  const { vis, name, at } = P.H;
  const out: ProbeFinding[] = [];
  const quiet = (el: Element) => !!el.closest('script, style, noscript, [aria-hidden="true"], dialog:not([open])') || !!(el.parentElement && el.parentElement.closest('svg'));
  const weights = new Map<number, number>();
  const strained: Array<{ el: Element; why: string }> = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = tw.nextNode(); t; t = tw.nextNode()) {
    const host = t.parentElement; const txt = (t.textContent || '').trim();
    if (!txt || !host || quiet(host) || host.closest('svg') || !vis(host)) continue;
    const hs = getComputedStyle(host);
    const w = Math.round((parseFloat(hs.fontWeight) || 400) / 100) * 100;
    weights.set(w, (weights.get(w) || 0) + txt.length);
    if (strained.length >= 4 || txt.length < 3 || host.closest('sup, sub, [data-slot], figure svg') || strained.some((x) => x.el === host)) continue;
    const size = parseFloat(hs.fontSize) || 16;
    const prose = !!host.closest('p, li, dd, blockquote') && txt.length > 60 && size < 28;
    const lh = parseFloat(hs.lineHeight);
    if (size < 11 || (prose && size < 12)) strained.push({ el: host, why: name(host) + ' at ' + Math.round(size * 10) / 10 + 'px' });
    else if (prose && lh && lh / size < 1.3 && host.getBoundingClientRect().height > lh * 2.2) strained.push({ el: host, why: name(host) + ' leaded ' + (lh / size).toFixed(2) });
  }
  if (strained.length) out.push({ rule: 'tiny-text', grade: 'fail', evidence: 'text that strains the eye: ' + strained.map((x) => x.why).join(', '), fix: 'running text 12px or more (16px for body), functional text 11px or more, multi-line prose leaded 1.3 or more', at: at(strained[0].el) });
  const used = Array.from(weights).filter(([, n]) => n >= 30).map(([w]) => w).sort((a, b) => a - b);
  if (used.length > 3) out.push({ rule: 'font-weight-count', grade: 'warn', evidence: used.length + ' font weights in running use (' + used.join(', ') + ')', fix: 'three weights at most, display and body together, picked as extremes' });
  return out;
}

// sloplint-render observeQuality, the lonely grid item (gate F20)
export function glGrid(P: Probes, all: Element[]): ProbeFinding[] {
  const { vis, name, at } = P.H;
  const out: ProbeFinding[] = [];
  for (const g of all) {
    const cs = getComputedStyle(g);
    const grid = /grid/.test(cs.display);
    const wrap = /flex/.test(cs.display) && cs.flexWrap === 'wrap' && cs.flexDirection.startsWith('row');
    if ((!grid && !wrap) || g.closest('nav, footer, form')) continue;
    const kids = Array.from(g.children).filter((c) => vis(c) && !/absolute|fixed/.test(getComputedStyle(c).position));
    if (kids.length < 3) continue;
    const rects = kids.map((c) => c.getBoundingClientRect());
    if (grid && Math.max(...rects.map((r) => r.width)) > Math.min(...rects.map((r) => r.width)) * 1.15) continue;
    if (wrap && !kids.every((c) => c.querySelector('img, svg') || /^(IMG|svg)$/.test(c.tagName) || c.getBoundingClientRect().width >= 120)) continue;
    const rows: Array<{ top: number; n: number }> = [];
    for (const r of rects) { const row = rows.find((x) => Math.abs(x.top - r.top) < 4); if (row) row.n++; else rows.push({ top: r.top, n: 1 }); }
    rows.sort((a, b) => a.top - b.top);
    if (rows.length >= 2 && rows[rows.length - 1].n === 1 && rows[rows.length - 2].n >= 2) { out.push({ rule: 'lonely-grid-item', grade: 'warn', evidence: name(g) + ' leaves one item alone on its last row (' + rows.map((x) => x.n).join(' + ') + ')', at: at(g) }); break; }
  }
  return out;
}
