/**
 * The render tier's in-page measurements of space: the hero, the word budget,
 * slots and slivers, drawn illustrations, empty pictures, counting marks, the
 * photo wall, the dead band, thin sections and the 1920 checks. Same rules as
 * render-probe.ts: each function is serialised into the page and may touch
 * nothing outside its arguments.
 *
 * Ported from Nutlope/hallmark's sloplint-render.mjs observeSpace (MIT, see
 * NOTICE.md): gates 44a, 44c, 44d, 58, 59, 77, 78, 79, 80, 81, 82, 83, F17, F18.
 * The posture, hero-shape, photo-shape and job guards are gone: the strict
 * form applies.
 */
import type { ProbeFinding, Probes } from './render-probe';

export interface Box { top: number; bottom: number; left: number; right: number }
export interface Fig extends Box { w: number; h: number; el: Element; side: 'left' | 'right'; colEdge: number }

export interface HeroCtx {
  secs: Element[];
  hero: Element | null;
  h1: HTMLElement | null;
  heroEnd: number | null;
  /** Text blocks in the hero before its first action. */
  stack: number;
  textBox: Box | null;
  fig: Fig | null;
  /** The painted extent of a section's content, in page coordinates. */
  content: (s: Element) => { top: number; bottom: number };
}

// sloplint-render observeSpace, the hero: its sections, text block, visual and content extents
export function glHero(P: Probes): HeroCtx {
  const { vis, abs, text } = P.H;
  const vw = innerWidth;
  let secs = Array.from(document.querySelectorAll('section, main > div, footer')).filter((s) => vis(s) && s.getBoundingClientRect().height > 40);
  secs = secs.filter((s) => !secs.some((o) => o !== s && o.contains(s)));
  const h1 = document.querySelector('h1');
  const heroish = (el: Element) => /^(SECTION|HEADER)$/.test(el.tagName) || Array.from(el.classList).some((c) => /^hero(-[\w-]+)?$/i.test(c) || /(^|-)hero$/i.test(c));
  let hero: Element | null = null;
  for (let n: Element | null = h1; n && n !== document.body; n = n.parentElement) if (heroish(n)) { hero = n; break; }
  hero = hero || Array.from(document.querySelectorAll('section, header, [class]')).find(heroish) || secs[0] || null;
  const heroEnd = hero ? abs(hero).bottom : null;
  let stack = 0, textBox: Box | null = null;
  const best: { fig: Fig | null; area: number } = { fig: null, area: 0 };
  if (hero && h1) {
    const cta = Array.from(hero.querySelectorAll('a, button')).filter((c) => vis(c) && (c.textContent || '').trim() && !c.closest('nav'))[0];
    const ctaTop = cta ? abs(cta).top : Infinity;
    const texts = Array.from(hero.querySelectorAll('h1, h2, p, small, [class*="sub"], [class*="lede"], [class*="eyebrow"], [class*="kicker"], [class*="label"]')).filter((e) => vis(e) && text(e) && !e.closest('nav, svg, table, figure, [data-slot], form, fieldset, label, output, [role="tabpanel"], [role="group"]') && abs(e).top < ctaTop);
    const seen: Element[] = [];
    for (const e of texts) { if (seen.some((o) => o.contains(e) || e.contains(o))) continue; seen.push(e); }
    stack = seen.length;
    const ink = (el: Element): Box => {
      let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode(); t; t = w.nextNode()) { if (!(t.textContent || '').trim() || t.parentElement!.closest('svg')) continue; const rg = document.createRange(); rg.selectNodeContents(t); for (const q of rg.getClientRects()) { if (!q.width || !q.height) continue; L = Math.min(L, q.left); T = Math.min(T, q.top); R = Math.max(R, q.right); B = Math.max(B, q.bottom); } }
      return L === Infinity ? abs(el) : { top: T + scrollY, bottom: B + scrollY, left: L, right: R };
    };
    const boxes = [h1, ...seen.filter((e) => Math.abs(abs(e).left - abs(h1).left) < 40)].map(ink);
    const tb: Box = { top: Math.min(...boxes.map((b) => b.top)), bottom: Math.max(...boxes.map((b) => b.bottom), cta ? abs(cta).bottom : 0), left: Math.min(...boxes.map((b) => b.left)), right: Math.max(...boxes.map((b) => b.right)) };
    textBox = tb;
    const clipped = (el: Element) => { const r = el.getBoundingClientRect(); let L = r.left, T = r.top, R = r.right, B = r.bottom; for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const cs = getComputedStyle(p); if (/hidden|clip/.test(cs.overflow + ' ' + cs.overflowX + ' ' + cs.overflowY)) { const q = p.getBoundingClientRect(); L = Math.max(L, q.left); T = Math.max(T, q.top); R = Math.min(R, q.right); B = Math.min(B, q.bottom); } } R = Math.min(R, vw); return { top: T + scrollY, bottom: B + scrollY, left: L, right: R, w: Math.max(0, R - L), h: Math.max(0, B - T) }; };
    const beside = (b: Box) => b.left >= tb.right - 40 || b.right <= tb.left + 40;
    const consider = (e: Element) => {
      if (!vis(e) || e.closest('nav') || e.contains(h1) || seen.some((t) => e.contains(t))) return;
      const b = clipped(e); const a = b.w * b.h;
      if (b.w > 160 && b.h > 120 && a > best.area && b.w < vw * 0.95 && beside(b)) { best.fig = { ...b, el: e, side: 'right', colEdge: 0 }; best.area = a; }
    };
    for (const e of hero.querySelectorAll('svg, canvas, img, figure, video, picture, [data-slot], [class*="fig"], [class*="visual"], [class*="device"], [class*="demo"], [class*="shot"], [class*="illus"], [class*="panel"]')) consider(e);
    if (!best.fig) {
      const heroBg = getComputedStyle(hero).backgroundColor;
      for (const e of hero.querySelectorAll('div, span, aside, i, b')) {
        const cs = getComputedStyle(e);
        if (cs.backgroundImage !== 'none' || (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== heroBg) || parseFloat(cs.borderTopWidth) > 0) consider(e);
      }
    }
    const f = best.fig;
    if (f) {
      f.side = f.left >= tb.right - 40 ? 'right' : 'left';
      let lca = h1.parentElement;
      while (lca && !lca.contains(f.el)) lca = lca.parentElement;
      let col: Element = h1;
      while (col.parentElement && col.parentElement !== lca) col = col.parentElement;
      const cb = abs(col);
      f.colEdge = f.side === 'right' ? Math.max(tb.right, cb.right) : Math.min(tb.left, cb.left);
    }
  }
  const clipAbs = (el: Element, stop: Element) => { const r0 = el.getBoundingClientRect(); let T = r0.top, B = r0.bottom; for (let q = el.parentElement; q && q !== document.body; q = q.parentElement) { const cs = getComputedStyle(q); if (/hidden|clip/.test(cs.overflow + ' ' + cs.overflowY)) { const qr = q.getBoundingClientRect(); T = Math.max(T, qr.top); B = Math.min(B, qr.bottom); } if (q === stop) break; } return { top: T + scrollY, bottom: B + scrollY }; };
  const content = (s: Element) => {
    let top = Infinity, bottom = -Infinity;
    for (const c of s.querySelectorAll('*')) {
      if (!vis(c)) continue;
      const painted = text(c) || /^(SVG|IMG|CANVAS|VIDEO)$/i.test(c.tagName) || getComputedStyle(c).backgroundColor !== 'rgba(0, 0, 0, 0)';
      if (!painted) continue;
      if (c.children.length && !Array.from(c.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim()) && !/^svg$/i.test(c.tagName) && getComputedStyle(c).backgroundColor === 'rgba(0, 0, 0, 0)') continue;
      const b = clipAbs(c, s);
      if (b.bottom <= b.top) continue;
      top = Math.min(top, b.top); bottom = Math.max(bottom, b.bottom);
    }
    return top === Infinity ? abs(s) : { top, bottom };
  };
  return { secs, hero, h1, heroEnd, stack, textBox, fig: best.fig, content };
}

// sloplint-render observeSpace at 1440 and 1920: the space checks in one eval
export function glSpace(P: Probes, atLaptop: boolean): ProbeFinding[] {
  const ctx = P.hero(P);
  if (!atLaptop) return P.wide(P, ctx);
  return [...P.words(P, ctx), ...P.slots(P), ...P.pictures(P), ...P.marks(P), ...P.photos(P, ctx), ...P.heroSpace(P, ctx), ...P.thin(P, ctx), ...P.gaps(P, ctx)];
}

// sloplint-render observeSpace, the gaps between sections at 1440 and the section count (gate 59)
export function glGaps(P: Probes, ctx: HeroCtx): ProbeFinding[] {
  const { at } = P.H;
  const out: ProbeFinding[] = [];
  const { secs, content } = ctx;
  const paperOf = (el: Element): string => {
    for (let q: Element | null = el; q; q = q.parentElement) {
      const cs = getComputedStyle(q);
      if (/gradient|url\(/.test(cs.backgroundImage)) return cs.backgroundColor + '|' + cs.backgroundImage;
      if (!/^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor)) return cs.backgroundColor;
    }
    return 'none';
  };
  const gaps: number[] = [], shifts: boolean[] = [];
  for (let i = 0; i < secs.length - 1; i++) {
    gaps.push(Math.round(content(secs[i + 1]).top - content(secs[i]).bottom));
    shifts.push(paperOf(secs[i]) !== paperOf(secs[i + 1]));
  }
  const real = gaps.filter((g) => g > -50);
  const short = gaps.filter((g, i) => g > -50 && g < (shifts[i] ? 64 : 112));
  if (real.length) {
    if (short.length) {
      const i = gaps.indexOf(Math.min(...short));
      out.push({ rule: 'section-gap', grade: 'fail', evidence: 'the smallest gap between sections is ' + Math.min(...short) + 'px (gaps: ' + real.join(', ') + ')', fix: '120px or more between sections (64px where the paper changes)', at: at(secs[i + 1]) });
    } else if (real.length > 2 && new Set(real).size === 1) {
      out.push({ rule: 'section-gap', grade: 'fail', evidence: 'every section gap is ' + real[0] + 'px', fix: 'vary the rhythm: a small, a regular and a large section gap', at: at(secs[1]) });
    }
  }
  if (secs.length > 9) out.push({ rule: 'section-gap', grade: 'warn', evidence: secs.length + ' sections on one page', fix: 'six to nine sections a page, hero and footer included; merge or cut', at: at(secs[9]) });
  return out;
}

// sloplint-render observeSpace, the word budget (gate 58)
export function glWords(P: Probes, ctx: HeroCtx): ProbeFinding[] {
  const { vis } = P.H;
  const out: ProbeFinding[] = [];
  const words: Array<{ top: number; bottom: number; c: number }> = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const p = n.parentElement; if (!p || !vis(p) || p.closest('script, style, noscript, svg, [data-slot], [data-credits]')) continue;
    const t = (n.textContent || '').trim(); if (!t) continue;
    const pr = p.getBoundingClientRect(); const c = t.split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w)).length;
    if (c) words.push({ top: pr.top + scrollY, bottom: pr.bottom + scrollY, c });
  }
  const H = document.documentElement.scrollHeight;
  let maxWords = 0, at = 0;
  for (let y = 0; y < H; y += 50) {
    const w = Math.round(words.reduce((a, x) => { const h = Math.max(1, x.bottom - x.top); const ov = Math.max(0, Math.min(x.bottom, y + innerHeight) - Math.max(x.top, y)); return a + x.c * Math.min(1, ov / h); }, 0));
    if (w > maxWords) { maxWords = w; at = y; }
  }
  if (maxWords > 95) out.push({ rule: 'screen-word-budget', grade: 'fail', evidence: maxWords + ' words on one ' + innerHeight + 'px screen (from y=' + at + ')', fix: 'one idea per screen: cut to about 80 words and make the section an object' });
  else if (maxWords > 80) out.push({ rule: 'screen-word-budget', grade: 'warn', evidence: maxWords + ' words on one ' + innerHeight + 'px screen (from y=' + at + '), close to the 80-word budget' });
  if (ctx.stack > 2) out.push({ rule: 'screen-word-budget', grade: 'fail', evidence: 'the hero carries ' + ctx.stack + ' text blocks before its actions', fix: 'headline, one sentence, actions; delete the rest', at: ctx.h1 ? P.H.at(ctx.h1) : undefined });
  if (ctx.hero && ctx.h1) {
    const actions = Array.from(ctx.hero.querySelectorAll('a, button')).filter((c) => vis(c) && (c.textContent || '').trim() && !c.closest('nav, form, figure, footer'));
    if (actions.length > 2) out.push({ rule: 'screen-word-budget', grade: 'fail', evidence: 'the hero offers ' + actions.length + ' actions', fix: 'one primary action and at most one quiet second; the rest belong to their sections', at: P.H.at(actions[2]) });
  }
  return out;
}

// sloplint-render observeSpace, slots and slivers at 1440 (gates F18 and F17)
export function glSlots(P: Probes): ProbeFinding[] {
  const { vis, at, text, name } = P.H;
  const out: ProbeFinding[] = [];
  for (const sl of document.querySelectorAll('[data-slot]')) {
    const cs = getComputedStyle(sl);
    if (cs.display === 'none' || cs.visibility === 'hidden' || !sl.getClientRects().length || sl.closest('[hidden]')) continue;
    const r = sl.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) { out.push({ rule: 'tiny-slot', grade: 'warn', evidence: 'slot "' + sl.getAttribute('data-slot') + '" renders at ' + Math.round(r.width) + ' x ' + Math.round(r.height) + 'px', fix: 'the slot collapsed: give it a width from its track and a real aspect-ratio, never a percentage of a shrink-to-fit parent', at: at(sl) }); break; }
  }
  for (const e of document.querySelectorAll('p, li, dd, td, th, h2, h3, h4, figcaption, blockquote')) {
    if (!vis(e) || e.closest('nav, svg, [aria-hidden="true"]')) continue;
    const t = text(e);
    if (t.length < 24) continue;
    const cs = getComputedStyle(e);
    const fs = parseFloat(cs.fontSize) || 16;
    const lh = parseFloat(cs.lineHeight) || fs * 1.4;
    const r = e.getBoundingClientRect();
    if (r.width < fs * 8 && r.height / lh >= 3.6) { out.push({ rule: 'text-sliver', grade: 'warn', evidence: '"' + t.slice(0, 28) + '" squeezed to ' + Math.round(r.width) + 'px wide over ' + Math.round(r.height / lh) + ' lines (' + name(e) + ')', fix: 'a grid placement or a span ran wide; give the text its column back', at: at(e) }); break; }
  }
  return out;
}

// sloplint-render observeSpace, drawn illustrations and empty pictures (gates 80 and 81)
export function glPictures(P: Probes): ProbeFinding[] {
  const { vis, at, text } = P.H;
  const out: ProbeFinding[] = [];
  const vw = innerWidth;
  const nameOf = (e: Element) => e.tagName.toLowerCase() + (e.getAttribute('data-slot') ? '[data-slot=' + e.getAttribute('data-slot') + ']' : e.classList[0] ? '.' + e.classList[0] : '');
  const dataish = /chart|graph|plot|spark|map|diagram|logo|wordmark|brand|icon|flag|qr|avatar/i;
  const drawn: Array<{ text: string; el: Element }> = [];
  for (const svg of document.querySelectorAll('svg')) {
    if (!vis(svg) || !svg.parentElement || svg.parentElement.closest('svg')) continue;
    const r = svg.getBoundingClientRect();
    if (r.width < 120 || r.height < 120) continue;
    let named = false;
    for (let q: Element | null = svg; q && q !== document.body && !named; q = q.parentElement) named = dataish.test((q.getAttribute('class') || '') + ' ' + (q.id || '') + ' ' + (q.getAttribute('aria-label') || '') + ' ' + (q.getAttribute('data-kind') || ''));
    if (named || svg.querySelector('text')) continue;
    const shapes = Array.from(svg.querySelectorAll('path, ellipse, circle, polygon'));
    const curvy = shapes.filter((s) => s.tagName === 'ellipse' || (s.tagName === 'circle' && parseFloat(s.getAttribute('r') || '0') > 6) || /[CcQqSsAa]/.test(s.getAttribute('d') || '')).length;
    const fills = new Set(shapes.map((s) => getComputedStyle(s).fill).filter((f) => f && f !== 'none'));
    if (curvy >= 3 || (shapes.length >= 6 && fills.size >= 3)) drawn.push({ text: nameOf(svg.parentElement || svg) + ' (' + Math.round(r.width) + 'x' + Math.round(r.height) + ', ' + shapes.length + ' shapes)', el: svg });
  }
  if (drawn.length) out.push({ rule: 'hand-drawn-svg', grade: 'fail', evidence: 'drawn illustration: ' + drawn.slice(0, 3).map((d) => d.text).join('; '), fix: 'a photograph, the product built, or type at scale; SVG is for icons, logos and labelled charts or diagrams', at: at(drawn[0].el) });
  const empty: Array<{ text: string; el: Element }> = [];
  const shows = (box: Element) => {
    const b = box.getBoundingClientRect();
    let area = 0;
    for (const m of box.querySelectorAll('img, video, picture, canvas, iframe, svg')) {
      if (!vis(m) || (m.tagName.toLowerCase() === 'svg' && m.parentElement && m.parentElement.closest('svg'))) continue;
      if (m.tagName === 'IMG' && !(m.getAttribute('src') || m.getAttribute('srcset') || '').trim()) continue;
      const q = m.getBoundingClientRect(); area += q.width * q.height;
      if (area >= b.width * b.height * 0.25) return true;
    }
    const bits = Array.from(box.querySelectorAll('*')).filter((e) => vis(e) && (text(e) || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.tagName)) && !e.children.length);
    return bits.length >= 4 || text(box).length >= 80 || box.matches('[data-kind="product"]') || !!box.closest('[data-kind="product"]');
  };
  for (const sl of document.querySelectorAll('[data-slot]')) { if (!vis(sl) || sl.closest('[hidden]')) continue; const r = sl.getBoundingClientRect(); if (r.width < 160 || r.height < 120) continue; if (!shows(sl)) empty.push({ text: nameOf(sl) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height), el: sl }); }
  for (const e of document.querySelectorAll('div, figure, span, i, aside')) {
    if (e.hasAttribute('data-slot') || e.closest('[data-slot]') || !vis(e)) continue;
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    if (r.width < 300 || r.height < 200 || r.width > vw * 0.9 || !/gradient/.test(cs.backgroundImage) || /url\(/.test(cs.backgroundImage)) continue;
    if (text(e).length > 60 || e.querySelector('img, video, canvas, svg, picture, input, table')) continue;
    if (!shows(e)) empty.push({ text: nameOf(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ', a gradient with nothing in it', el: e });
  }
  if (empty.length) out.push({ rule: 'empty-picture', grade: 'fail', evidence: empty.length + ' empty picture' + (empty.length > 1 ? 's' : '') + ': ' + empty.slice(0, 3).map((d) => d.text).join('; '), fix: 'put the picture in: the user\'s image, a credited photograph or the product at full fidelity; the wash is only a loading colour', at: at(empty[0].el) });
  return out;
}

// sloplint-render observeSpace, the counting device (gate 82)
export function glMarks(P: Probes): ProbeFinding[] {
  const { vis, at } = P.H;
  const out: ProbeFinding[] = [];
  const nameOf = (e: Element) => e.tagName.toLowerCase() + (e.getAttribute('data-slot') ? '[data-slot=' + e.getAttribute('data-slot') + ']' : e.classList[0] ? '.' + e.classList[0] : '');
  const marks: Array<{ el: Element; text: string }> = [];
  const colourOf = (e: Element) => { const cs = getComputedStyle(e); return e instanceof SVGElement ? cs.fill + '|' + cs.stroke : cs.backgroundColor + '|' + cs.borderTopColor + '|' + cs.color; };
  for (const p of document.querySelectorAll('*')) {
    if (p.children.length < 24 || !vis(p)) continue;
    const kids = Array.from(p.children).filter((k) => !/^(defs|title|desc|style|script)$/i.test(k.tagName));
    if (kids.length < 24) continue;
    const small = kids.filter((k) => { const q = k.getBoundingClientRect(); return !(k.textContent || '').trim() && q.width > 0 && q.height > 0 && ((q.width <= 24 && q.height <= 48) || q.width <= 6 || q.height <= 6); });
    if (small.length < 24 || small.length < kids.length * 0.8) continue;
    const tally = new Map<string, number>(); for (const k of small) { const c = colourOf(k); tally.set(c, (tally.get(c) || 0) + 1); }
    if (Math.max(...tally.values()) < small.length * 0.6 || tally.size > 4) continue;
    const sizes = small.map((k) => { const q = k.getBoundingClientRect(); return Math.round(q.width) * 1000 + Math.round(q.height); });
    const common = Math.max(...Array.from(new Set(sizes)).map((s) => sizes.filter((x) => x === s).length));
    if (common < small.length * 0.7) continue;
    if (marks.some((m) => m.el.contains(p) || p.contains(m.el))) continue;
    marks.push({ el: p, text: nameOf(p) + ' holds ' + small.length + ' identical marks' });
  }
  const ONE_FOR_EACH = /\bone (?:mark|dot|stroke|tick|line|square|bar|cell|pin|block|circle|seed|bead|stripe|notch)s? (?:for|per) (?:each|every)\b/i;
  const ONE_FOR_EACH_BARE = /\bone (?:for|per) (?:each|every)\b/i;
  for (const e of document.querySelectorAll('[aria-label], figcaption, svg title, p, small, span')) {
    if (marks.length >= 2) break;
    const t = (e.getAttribute('aria-label') || '') + ' ' + ((e.textContent || '').length < 160 ? e.textContent : '');
    const counting = ONE_FOR_EACH.test(t) || (ONE_FOR_EACH_BARE.test(t) && (e.matches('figcaption') || (e.getAttribute('aria-label') && e.closest('svg, figure, [role="img"]'))));
    if (counting && !marks.some((m) => m.el.contains(e))) marks.push({ el: e, text: '"' + t.trim().slice(0, 60) + '"' });
  }
  if (marks.length) out.push({ rule: 'counting-marks', grade: 'fail', evidence: 'counting device: ' + marks.slice(0, 2).map((m) => m.text).join('; '), fix: 'set the number in type at the size it deserves; never one mark for each thing', at: at(marks[0].el) });
  return out;
}

// sloplint-render observeSpace, the photo wall (gate 83): the strict third, no photographic shape
export function glPhotos(P: Probes, ctx: HeroCtx): ProbeFinding[] {
  const { vis, abs } = P.H;
  const out: ProbeFinding[] = [];
  if (ctx.heroEnd == null) return out;
  const vw = innerWidth, vh = innerHeight;
  const foot = Array.from(document.querySelectorAll('body footer, [role="contentinfo"]')).filter(vis).pop();
  const docH = foot ? Math.min(document.documentElement.scrollHeight, abs(foot).top) : document.documentElement.scrollHeight, from = Math.max(ctx.heroEnd, vh);
  const box = document.querySelector('.container') || document.body;
  const cw = Math.min(box.getBoundingClientRect().width || vw, vw);
  let area = 0, n = 0;
  const seenA: Element[] = [];
  let first: Element | null = null;
  const add = (el: Element) => {
    if (!vis(el) || el.closest('footer') || seenA.some((o) => o.contains(el))) return;
    const b = abs(el); const top = Math.max(b.top, from), bot = Math.min(b.bottom, docH);
    if (bot - top < 80 || b.w < 160) return;
    seenA.push(el); area += (bot - top) * Math.min(b.w, cw); n++;
    first = first || el;
  };
  for (const m of document.querySelectorAll('img, video')) {
    if (m.closest('[data-kind="product"], [data-product]')) continue;
    const nw = (m as HTMLImageElement).naturalWidth || (m as HTMLVideoElement).videoWidth || 0;
    if (m.tagName === 'IMG' && /\.svg(\?|$)/i.test((m as HTMLImageElement).currentSrc || (m as HTMLImageElement).src || '')) continue;
    if (m.tagName === 'IMG' && nw && nw < 200) continue;
    add(m);
  }
  for (const e of document.querySelectorAll('section *, main *')) { const bi = getComputedStyle(e).backgroundImage; if (/url\(/.test(bi) && !/svg|data:image\/svg/i.test(bi)) add(e); }
  const share = area / Math.max(1, (docH - from) * cw);
  if (share > 0.36 && n >= 3) out.push({ rule: 'photo-wall', grade: 'fail', evidence: 'photographs cover ' + Math.round(share * 100) + '% of the page below the hero (' + n + ' pictures)', fix: 'cut or shrink pictures until they cover a quarter to a third of the page, and carry the freed sections in type, figures, the product or a list', at: first ? P.H.at(first) : undefined });
  return out;
}

// sloplint-render observeSpace, the hero's balance and its dead band (gates 44a, 44c, 79)
export function glHeroSpace(P: Probes, ctx: HeroCtx): ProbeFinding[] {
  const { vis, abs, text, at } = P.H;
  const out: ProbeFinding[] = [];
  const { hero, secs, heroEnd, textBox, fig } = ctx;
  const vw = innerWidth, vh = innerHeight;
  const heroAt = hero ? at(hero) : undefined;
  let heroFoot: { cBottom: number; navBottom: number } | null = null;
  if (hero) {
    const hb = abs(hero);
    let cTop = Infinity, cBottom = -Infinity;
    for (const c of hero.querySelectorAll('*')) {
      const nv = c.closest('nav');
      if (!vis(c) || (nv && abs(nv).top <= hb.top + 220) || c === hero) continue;
      const cs = getComputedStyle(c);
      const painted = text(c) || /^(SVG|IMG|CANVAS|VIDEO|PICTURE)$/i.test(c.tagName) || cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.backgroundImage !== 'none' || parseFloat(cs.borderTopWidth) > 0;
      if (!painted || /fixed|sticky/.test(cs.position)) continue;
      const b = abs(c); cTop = Math.min(cTop, b.top); cBottom = Math.max(cBottom, Math.min(b.bottom, hb.bottom));
    }
    let navBottom = hb.top;
    for (const n of document.querySelectorAll('header, nav, [class*="nav"], [class*="bar"]')) {
      if (!vis(n) || (hero.contains(n) && !/fixed|sticky/.test(getComputedStyle(n).position))) continue;
      const cs = getComputedStyle(n); const b = abs(n);
      if ((/fixed|sticky/.test(cs.position) || hero.contains(n)) && b.top <= hb.top + 40 && b.bottom < hb.top + 220) navBottom = Math.max(navBottom, b.bottom);
    }
    const after = secs.find((x) => x !== hero && !hero.contains(x) && abs(x).top >= hb.bottom - 4);
    const bottomEdge = after ? Math.min(ctx.content(after).top, hb.bottom + 240) : hb.bottom;
    const topPad = cTop - navBottom, bottomPad = bottomEdge - cBottom;
    if (isFinite(topPad) && isFinite(bottomPad) && topPad > 24 && bottomPad < topPad - 8) out.push({ rule: 'hero-balance', grade: 'fail', evidence: 'the hero content sits low: ' + Math.round(topPad) + 'px above it, ' + Math.round(bottomPad) + 'px below', fix: 'centre the content in its screen: the space below 1.0 to 1.5 times the space above', at: heroAt });
    heroFoot = { cBottom, navBottom };
  }
  if (heroEnd != null) {
    if (heroEnd > vh + 8) out.push({ rule: 'hero-balance', grade: 'fail', evidence: 'the hero runs past the ' + innerWidth + 'x' + innerHeight + ' fold (it ends at ' + Math.round(heroEnd) + 'px)', fix: 'size the display and the visual so the hero is one screen', at: heroAt });
    else if (heroEnd < vh * 0.84 && secs.length > 1) out.push({ rule: 'hero-balance', grade: 'fail', evidence: 'the hero ends at ' + Math.round(heroEnd) + 'px of a ' + innerHeight + 'px screen', fix: 'fill the first screen with the visual or the headline, not with copy', at: heroAt });
  }
  if (fig && textBox) {
    const off = Math.round((fig.top + fig.bottom) / 2 - (textBox.top + textBox.bottom) / 2);
    const gap = Math.round(fig.side === 'right' ? fig.left - fig.colEdge : fig.colEdge - fig.right);
    const edge = Math.round(fig.side === 'right' ? vw - fig.right : fig.left);
    const figAt = at(fig.el);
    if (Math.abs(off) > 60) out.push({ rule: 'hero-balance', grade: 'fail', evidence: 'the hero visual\'s centre is ' + off + 'px from the text block\'s centre', fix: 'align the visual beside the text', at: figAt });
    const inkGap = Math.round(fig.side === 'right' ? fig.left - textBox.right : textBox.left - fig.right);
    if (inkGap > 240 && gap <= 120) out.push({ rule: 'hero-balance', grade: 'fail', evidence: 'the hero text ends ' + inkGap + 'px short of its visual', fix: 'widen the text column or bring the visual in: text and visual stand 48 to 120px apart', at: figAt });
    if (gap > 120 || (edge < 8 && gap > 48)) out.push({ rule: 'hero-balance', grade: 'fail', evidence: 'the hero visual sits ' + gap + 'px from the text and ' + edge + 'px from the viewport edge', fix: 'bring the visual to within 48 to 120px of the text; never pin it to the corner', at: figAt });
  }
  if (heroFoot && hero && isFinite(heroFoot.cBottom)) {
    const hb = abs(hero);
    const after = secs.find((x) => x !== hero && !hero.contains(x) && abs(x).top >= hb.bottom - 4);
    const nextTop = after ? ctx.content(after).top : Infinity;
    const band = Math.round(Math.min(vh, nextTop) - heroFoot.cBottom);
    if (heroFoot.cBottom < vh && band > 160) out.push({ rule: 'dead-band', grade: 'fail', evidence: band + 'px of nothing between the hero\'s last content (y ' + Math.round(heroFoot.cBottom) + ') and ' + (nextTop < vh ? 'the next section' : 'the fold'), at: heroAt });
  }
  return out;
}

// sloplint-render observeSpace, section heads and thin sections below the hero (gates 78 and 77)
export function glThin(P: Probes, ctx: HeroCtx): ProbeFinding[] {
  const { vis, abs, text, at } = P.H;
  const out: ProbeFinding[] = [];
  const { hero, secs, h1 } = ctx;
  const vw = innerWidth;
  const below = secs.filter((x) => x !== hero && !(hero && (hero.contains(x) || x.contains(hero))) && x.tagName !== 'FOOTER' && !x.closest('footer, nav') && (!hero || abs(x).top >= abs(hero).bottom - 4));
  const leavesOf = (root: Element): Box[] => {
    const leaves: Box[] = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) { if (!(t.textContent || '').trim()) continue; const p = t.parentElement; if (!p || !vis(p) || p.closest('script, style, noscript')) continue; const rg = document.createRange(); rg.selectNodeContents(t); for (const q of rg.getClientRects()) if (q.width > 1 && q.height > 1) leaves.push({ top: q.top + scrollY, bottom: q.bottom + scrollY, left: q.left, right: q.right }); }
    for (const e of root.querySelectorAll('*')) {
      if (!vis(e) || (e.closest('svg') && e.tagName.toLowerCase() !== 'svg')) continue;
      const cs = getComputedStyle(e);
      const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0) + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
      const painted = /^(IMG|SVG|CANVAS|VIDEO|PICTURE|IFRAME|INPUT|TEXTAREA|SELECT|TABLE)$/i.test(e.tagName) || e.hasAttribute('data-slot') || cs.backgroundImage !== 'none' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || border >= 2;
      if (!painted) continue;
      const b = e.getBoundingClientRect(); if (b.width * b.height < 64 || (b.width > vw * 0.97 && !/^(IMG|PICTURE|VIDEO|CANVAS|SVG)$/i.test(e.tagName) && !e.hasAttribute('data-slot'))) continue;
      leaves.push({ top: b.top + scrollY, bottom: b.bottom + scrollY, left: b.left, right: b.right });
    }
    return leaves;
  };
  const span = (ls: Box[]) => ls.filter((b) => b.right > 0 && b.left < vw).reduce((a, b) => ({ left: Math.min(a.left, Math.max(0, b.left)), right: Math.max(a.right, Math.min(vw, b.right)) }), { left: Infinity, right: -Infinity });
  const all = span([...(hero ? [hero] : []), ...below].flatMap(leavesOf));
  const W = all.right - all.left;
  const h1fs = h1 ? parseFloat(getComputedStyle(h1).fontSize) : 0;
  const heads = below.flatMap((x) => Array.from(x.querySelectorAll('h2'))).filter((h) => vis(h) && !h.closest('nav, footer'));
  if (heads.length) {
    const sizes = heads.map((h) => parseFloat(getComputedStyle(h).fontSize)).sort((a, b) => a - b);
    const med = sizes[Math.floor(sizes.length / 2)];
    if (med < 40) out.push({ rule: 'small-section-heads', grade: 'fail', evidence: 'section heads render at ' + Math.round(med) + 'px' + (h1fs ? ' under a ' + Math.round(h1fs) + 'px hero head' : ''), fix: 'h2 at the section size (about 52px at 1440), item titles at the title size', at: at(heads[0]) });
  }
  const thin: Array<{ text: string; el: Element }> = [];
  let bands = 0;
  if (W > 400) for (const sec of below) {
    const ls = leavesOf(sec);
    if (!ls.length) continue;
    const u = span(ls);
    const wPct = (Math.min(u.right, all.right) - Math.max(u.left, all.left)) / W;
    const words = text(sec).split(/\s+/).filter((x) => /[A-Za-z0-9]/.test(x)).length;
    let mass = false, statement = false;
    const secBg = getComputedStyle(sec).backgroundColor;
    for (const e of sec.querySelectorAll('img, svg, canvas, video, picture, figure, iframe, [data-slot]')) { if (!vis(e) || (e.tagName.toLowerCase() === 'svg' && e.closest('[data-slot], figure') && e.closest('[data-slot], figure') !== e)) continue; if (e.getBoundingClientRect().height >= 300) { mass = true; break; } }
    if (!mass) for (const e of sec.querySelectorAll('div, article, aside, ul, ol, dl, table, form, a')) {
      if (!vis(e)) continue;
      const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
      const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0) + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
      const filled = (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== secBg) || cs.backgroundImage !== 'none' || border >= 2;
      if (filled && r.height >= 240 && r.width >= W * 0.35 && r.width < vw * 0.97) { mass = true; break; }
    }
    if (!mass) for (const t of sec.querySelectorAll('table, ul, ol, dl, div, [class]')) {
      if (!vis(t)) continue;
      if (t.tagName === 'TABLE') { const r = t.getBoundingClientRect(); if (t.querySelectorAll('tr').length >= 4 && r.width >= W * 0.6) { mass = true; break; } continue; }
      const kids = Array.from(t.children).filter((k) => vis(k) && k.getBoundingClientRect().height > 20);
      if (kids.length < 3) continue;
      const rs = kids.map((k) => k.getBoundingClientRect());
      const across = rs.every((r) => Math.abs(r.top - rs[0].top) < 12) && new Set(rs.map((r) => Math.round(r.left))).size === rs.length;
      const spread = Math.max(...rs.map((r) => r.right)) - Math.min(...rs.map((r) => r.left));
      const tall = Math.max(...rs.map((r) => r.bottom)) - Math.min(...rs.map((r) => r.top));
      if ((across && spread >= W * 0.7) || (!across && spread >= W * 0.4 && tall >= 120)) { mass = true; break; }
    }
    if (!mass && Array.from(sec.querySelectorAll('input:not([type=hidden]), select, textarea')).filter(vis).length >= 2) mass = true;
    for (const e of sec.querySelectorAll('h2, h3, p, blockquote, h2 span, p span, div, output, [contenteditable]')) {
      if (!vis(e) || (/^(DIV|OUTPUT)$/.test(e.tagName) && !Array.from(e.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim()))) continue;
      const cs = getComputedStyle(e); const fs = parseFloat(cs.fontSize); const lh = parseFloat(cs.lineHeight) || fs * 1.15; const r = e.getBoundingClientRect(); const n = text(e).split(/\s+/).filter(Boolean).length;
      if ((fs >= 40 && n <= 40 && r.height >= lh * 1.8 && r.width >= W * 0.5) || fs >= 72) { statement = true; break; }
    }
    if (statement) mass = true;
    const painted = getComputedStyle(sec).backgroundColor !== 'rgba(0, 0, 0, 0)' || getComputedStyle(sec).backgroundImage !== 'none';
    if (!mass && painted && words <= 40 && sec.querySelector('a, button, form') && !bands) { bands++; continue; }
    if ((wPct < 0.72 && !statement) || !mass) {
      const head = sec.querySelector('h2, h3');
      thin.push({ text: (head && text(head) ? '"' + text(head).slice(0, 28) + '"' : sec.tagName.toLowerCase() + (sec.classList[0] ? '.' + sec.classList[0] : '')) + ' (' + Math.round(wPct * 100) + '% wide' + (mass ? '' : ', no mass') + ')', el: sec });
    }
  }
  if (thin.length) out.push({ rule: 'thin-section', grade: 'fail', evidence: thin.length + ' thin section' + (thin.length > 1 ? 's' : '') + ': ' + thin.slice(0, 3).map((t) => t.text).join('; '), fix: 'widen the body to ten of twelve columns and give it mass: a visual 300px tall or more, a set of three across, rows, or a statement', at: at(thin[0].el) });
  return out;
}

// sloplint-render observeSpace at 1920 (gate 44d)
export function glWide(P: Probes, ctx: HeroCtx): ProbeFinding[] {
  const { vis, text, at } = P.H;
  const out: ProbeFinding[] = [];
  const vh = innerHeight;
  if (ctx.textBox && ctx.textBox.left < 120) out.push({ rule: 'wide-container', grade: 'fail', evidence: 'the hero text starts ' + Math.round(ctx.textBox.left) + 'px from the edge at ' + innerWidth, fix: 'cap the container at 1360 to 1520px and centre it', at: ctx.h1 ? at(ctx.h1) : undefined });
  if (ctx.heroEnd != null && ctx.heroEnd > vh + 8) out.push({ rule: 'wide-container', grade: 'fail', evidence: 'the hero runs past the ' + innerWidth + 'x' + innerHeight + ' screen (it ends at ' + Math.round(ctx.heroEnd) + 'px)', fix: 'cap vw-sized visuals and display sizes', at: ctx.hero ? at(ctx.hero) : undefined });
  const inkWidth = (e: Element) => { const range = document.createRange(); range.selectNodeContents(e); return range.getBoundingClientRect().width; };
  const wide = Array.from(document.querySelectorAll('p, h1, h2, h3, li')).filter((e) => vis(e) && !e.querySelector('p, h1, h2, h3, h4, div, figure, ul, ol, table, section') && text(e).length > 40 && inkWidth(e) > 1600);
  if (wide.length) out.push({ rule: 'wide-container', grade: 'fail', evidence: wide.length + ' text block' + (wide.length > 1 ? 's run' : ' runs') + ' wider than 1600px at ' + innerWidth + ' (first: ' + wide[0].tagName.toLowerCase() + ' "' + text(wide[0]).slice(0, 28) + '")', fix: 'cap the container; hold the measure', at: at(wide[0]) });
  return out;
}
