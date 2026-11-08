/**
 * The render tier's in-page measurements. Each function here runs inside the
 * page: it is serialised with Function.prototype.toString, installed once on
 * window.__gstackLint by the first eval step, and called by later steps at
 * the viewport they need. Nothing here may touch module scope: a function
 * sees only its arguments, the helpers object and the DOM.
 *
 * Ported from Nutlope/hallmark's sloplint-render.mjs (MIT, see NOTICE.md):
 * observe (gates 34, 44b, 49a, 49b, 40, 41, 23, F18 and 72 at 375),
 * focusRing (26a), observeOcclusion (73) and pixelBehind's preparation. The
 * space and quality measurements are in render-probe-space.ts and
 * render-probe-quality.ts.
 */
import { glGaps, glHero, glHeroSpace, glMarks, glPhotos, glPictures, glSlots, glSpace, glThin, glWide, glWords } from './render-probe-space';
import { glFields, glGrid, glPadding, glProse, glQuality, glRhythm, glStrain } from './render-probe-quality';
import type { SampleRect } from './render-png';

export interface ProbeAt { tag: string; cls: string; text: string; /** A distinguishing attribute in the open tag, like data-slot="hero" or id="main". */ attr?: string }

export interface ProbeFinding {
  rule: string;
  /** fail: the tell is measured; warn: suspected (a blocking rule lands at ask). */
  grade: 'fail' | 'warn';
  evidence: string;
  fix?: string;
  at?: ProbeAt;
  /** A contrast claim to confirm against painted pixels: the element's path, its ink and its threshold. */
  probe?: { path: string; fg: number[]; threshold: number };
}

export interface RingProbe {
  key: string;
  path: string;
  at: ProbeAt;
  bare: boolean;
  ratio: number | null;
  ring?: number[];
  pad?: number;
}

export interface SetupReport { lost: string[] }

export interface PixelItem { path: string; kind: 'text' | 'ring'; pad?: number }

/** Shared in-page helpers; built once by the install step. */
export function glHelpers() {
  const vis = (el: Element): boolean => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const clsOf = (el: Element): string[] => (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
  const describe = (el: Element): string => el.tagName.toLowerCase() + (clsOf(el).length ? '.' + clsOf(el).slice(0, 2).join('.') : '');
  const name = (el: Element): string => el.tagName.toLowerCase() + (clsOf(el)[0] ? '.' + clsOf(el)[0] : '');
  const text = (el: Element): string => ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const at = (el: Element): ProbeAt => {
    const hint = el.getAttribute('data-slot') ? 'data-slot="' + el.getAttribute('data-slot') + '"' : el.id ? 'id="' + el.id + '"' : '';
    return { tag: el.tagName.toLowerCase(), cls: clsOf(el)[0] || '', text: text(el).slice(0, 40), ...(hint ? { attr: hint } : {}) };
  };
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
      const p = n.parentElement;
      parts.unshift(n.tagName.toLowerCase() + ':nth-child(' + (p ? Array.prototype.indexOf.call(p.children, n) + 1 : 1) + ')');
    }
    return 'html > ' + parts.join(' > ');
  };
  const abs = (el: Element) => { const r = el.getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right, w: r.width, h: r.height }; };
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const rgb = (s: string): number[] => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = 'rgba(0, 0, 0, 0)'; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255]; };
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const over = (c: number[], b: number[]) => [0, 1, 2].map((i) => c[i] * c[3] + b[i] * (1 - c[3]));
  const clear = (c: string) => /^(transparent|rgba\(0, 0, 0, 0\))$/.test(c);
  const bgOf = (n0: Element | null): number[] => {
    for (let n = n0; n && n !== document.documentElement; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c[3] >= 0.9) return c; }
    const b = rgb(getComputedStyle(document.body).backgroundColor);
    return b[3] > 0 ? b : [1, 1, 1, 1];
  };
  const settle = async () => {
    if (document.fonts && document.fonts.status !== 'loaded') await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  };
  return { vis, clsOf, describe, name, text, at, pathOf, abs, rgb, lum, ratio, over, clear, bgOf, settle };
}

export type Helpers = ReturnType<typeof glHelpers>;

const PROBE_FNS = { setup: glSetup, layout: glLayout, contrast: glContrast, accent: glAccent, focus: glFocus, occlusion: glOcclusion, hide: glHide, restore: glRestore, hero: glHero, space: glSpace, words: glWords, slots: glSlots, pictures: glPictures, marks: glMarks, photos: glPhotos, heroSpace: glHeroSpace, thin: glThin, gaps: glGaps, wide: glWide, quality: glQuality, rhythm: glRhythm, padding: glPadding, prose: glProse, fields: glFields, strain: glStrain, grid: glGrid };

/** Everything installed on window.__gstackLint: the helpers and every measurement, typed from PROBE_FNS so a probe is declared once. */
export interface Probes extends ProbeFns { H: Helpers }
type ProbeFns = typeof PROBE_FNS;

export const PROBE_GLOBAL = 'window.__gstackLint';

/** The JS that installs every probe on the page, as one expression. */
export function installScript(): string {
  const entries = Object.entries(PROBE_FNS).map(([k, fn]) => k + ': (' + fn.toString() + ')');
  return '(' + PROBE_GLOBAL + ' = { H: (' + glHelpers.toString() + ')(), ' + entries.join(', ') + ' })';
}

/**
 * An eval expression that runs one probe and returns its JSON, or {error} when
 * it throws. Written without the word await: the browse daemon wraps an
 * expression that mentions it, and a wrapper it cannot parse drops the value.
 */
export function probeScript(call: string): string {
  return '(() => { const P = ' + PROBE_GLOBAL + '; return Promise.resolve().then(() => (' + call + ')).then((v) => JSON.stringify(v), (e) => JSON.stringify({ error: String((e && e.stack) || e).slice(0, 300) })); })()';
}

// sloplint-render renderCheck's page preparation: the quiet style, running animations finished through document.getAnimations(), lazy images eager-loaded and settled
export async function glSetup(P: Probes): Promise<SetupReport> {
  const quiet = document.createElement('style');
  quiet.textContent = 'nextjs-portal, astro-dev-toolbar { display: none !important } * { transition: none !important } html, body { scroll-behavior: auto !important }';
  document.head.appendChild(quiet);
  for (const a of document.getAnimations()) { try { a.finish(); } catch { /* an infinite animation keeps running */ } }
  for (const i of document.querySelectorAll('img[loading="lazy"]')) (i as HTMLImageElement).loading = 'eager';
  for (let y = 0; y < document.documentElement.scrollHeight; y += 700) { window.scrollTo(0, y); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }
  window.scrollTo(0, 0);
  const waiting = Array.from(document.images).filter((i) => !i.complete);
  await Promise.race([Promise.all(waiting.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))), new Promise((r) => setTimeout(r, 5000))]);
  await Promise.all(Array.from(document.images).map((i) => (i.complete && i.naturalWidth && i.decode ? i.decode().catch(() => {}) : null)));
  await P.H.settle();
  const lost: string[] = [];
  for (const l of document.querySelectorAll('link[rel~="stylesheet"][href]')) if (!(l as HTMLLinkElement).sheet) lost.push((l.getAttribute('href') || '').split('/').pop() || 'stylesheet');
  for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) if ((e.initiatorType === 'link' || e.initiatorType === 'css') && e.responseStatus >= 400) lost.push(e.name.split('?')[0].split('/').pop() || e.name);
  if (document.fonts) for (const f of document.fonts) if (f.status === 'error') lost.push(f.family.replace(/^["']|["']$/g, ''));
  return { lost: Array.from(new Set(lost)) };
}

// sloplint-render observe (gates 34, 49a, 49b, 44b; F18 and 72 at 375)
export function glLayout(P: Probes, checkFold: boolean): ProbeFinding[] {
  const { vis, describe, at, text } = P.H;
  const out: ProbeFinding[] = [];
  const vw = innerWidth, sw = document.documentElement.scrollWidth;
  if (sw > vw + 1) out.push({ rule: 'horizontal-scroll', grade: 'fail', evidence: 'the page scrolls sideways: it is ' + sw + 'px wide in a ' + vw + 'px viewport', fix: 'overflow-x: clip on html and body, then find the block that overflows' });
  if (vw === 375) {
    const clipped = (el: Element) => { for (let q = el.parentElement; q && q !== document.body && q !== document.documentElement; q = q.parentElement) { const cs = getComputedStyle(q); if (/hidden|clip|auto|scroll/.test(cs.overflowX + ' ' + cs.overflow)) return true; } return false; };
    const spill = Array.from(document.querySelectorAll('body *')).find((el) => { if (!vis(el) || getComputedStyle(el).position === 'fixed' || el.closest('svg') || clipped(el)) return false; const r = el.getBoundingClientRect(); return r.right > vw + 2 || r.left < -2; });
    if (spill && sw <= vw + 1) { const r = spill.getBoundingClientRect(); out.push({ rule: 'horizontal-scroll', grade: 'fail', evidence: describe(spill) + ' runs ' + Math.round(Math.max(r.right - vw, -r.left)) + 'px past the 375px screen, hidden only by the page\'s clip', fix: 'stack it below 60rem: drop the desktop column gap, widths and offsets on the phone', at: at(spill) }); }
    for (const sl of document.querySelectorAll('[data-slot]')) {
      const cs = getComputedStyle(sl);
      if (cs.display === 'none' || !sl.getClientRects().length || sl.closest('[hidden]')) continue;
      const r = sl.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) { out.push({ rule: 'tiny-slot', grade: 'warn', evidence: 'slot "' + sl.getAttribute('data-slot') + '" renders at ' + Math.round(r.width) + ' x ' + Math.round(r.height) + 'px on a phone', fix: 'the slot collapsed: give it width: 100% and an aspect-ratio in the stacked layout', at: at(sl) }); break; }
    }
    const flush = Array.from(document.querySelectorAll('p, li, h1, h2, h3, blockquote, dd')).find((el) => {
      if (!vis(el) || el.closest('nav, pre, table, [data-slot]')) return false;
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && (n.textContent || '').trim().length >= 20);
      if (own.reduce((n, t) => n + (t.textContent || '').trim().length, 0) < 40) return false;
      let left = Infinity, right = -Infinity;
      for (const t of own) { const range = document.createRange(); range.selectNodeContents(t); for (const r of range.getClientRects()) { if (r.width < 2) continue; left = Math.min(left, r.left); right = Math.max(right, r.right); } }
      return right - left > 120 && right <= vw + 1 && (left < 8 || right > vw - 8);
    });
    if (flush) out.push({ rule: 'cramped-padding', grade: 'fail', evidence: 'text runs to the edge of the phone screen (' + describe(flush) + ')', fix: 'give the page a gutter: 16px or more at each side on a phone', at: at(flush) });
  }
  for (const el of document.querySelectorAll('a, button, [role="button"], [role="tab"]')) {
    if (!vis(el)) continue;
    const label = (el.textContent || '').trim();
    if (!label) continue;
    const isButton = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || /btn|button|cta/i.test(el.getAttribute('class') || '');
    const block = el.closest('p, li, dd, td, blockquote, figcaption');
    if (!isButton && block && text(block).length > label.length + 12) continue;
    if (Array.from(el.querySelectorAll('*')).some((d) => !d.closest('svg') && /^(block|flex|grid|list-item|table)$/.test(getComputedStyle(d).display))) continue;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    const tops: number[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const host = n.parentElement;
      if (!(n.textContent || '').trim() || !host || host.closest('svg')) continue;
      const hr = host.getBoundingClientRect();
      if (hr.width <= 2 || hr.height <= 2) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) tops.push(r.top);
    }
    tops.sort((a, b) => a - b);
    let lines = tops.length ? 1 : 0;
    for (let i = 1; i < tops.length; i++) if (tops[i] - tops[i - 1] > lh * 0.6) lines++;
    if (lines <= 1) continue;
    const primary = isButton || (!!el.closest('nav') && !el.closest('footer') && !el.closest('nav[aria-label*="bread" i]'));
    out.push({ rule: primary ? 'button-label-wraps' : 'link-wraps', grade: 'fail', evidence: (primary ? 'control' : 'link') + ' "' + label.slice(0, 32) + '" wraps to ' + lines + ' lines (' + describe(el) + ')', fix: 'shorten the label, or white-space: nowrap', at: at(el) });
  }
  if (checkFold) {
    const h1 = document.querySelector('h1');
    if (h1 && vis(h1)) {
      const hr = h1.getBoundingClientRect();
      const scope = h1.closest('section, header, main, div') || document.body;
      const cta = Array.from(scope.querySelectorAll('a, button')).find((c) => vis(c) && (c.textContent || '').trim());
      const fold = innerHeight, view = innerWidth + 'x' + innerHeight;
      if (hr.bottom > fold || hr.top < 0) out.push({ rule: 'hero-fold', grade: 'fail', evidence: 'the headline crosses the ' + view + ' fold (its bottom is at ' + Math.round(hr.bottom) + 'px)', fix: 'pull the display clamp down so the headline fits the fold', at: at(h1) });
      else if (cta) {
        const cr = cta.getBoundingClientRect();
        if (cr.bottom > fold) out.push({ rule: 'hero-fold', grade: 'fail', evidence: 'the primary action sits below the ' + view + ' fold (its bottom is at ' + Math.round(cr.bottom) + 'px)', fix: 'trim the hero padding so the action fits the fold', at: at(cta) });
      }
    }
  }
  return out;
}

// sloplint-render observe, the contrast walk (gates 40 and 41); pixelBehind confirms the probes afterwards
export function glContrast(P: Probes): ProbeFinding[] {
  const { vis, describe, at, text, rgb, ratio, over, pathOf } = P.H;
  const out: ProbeFinding[] = [];
  const parse = (s: string): number[] | null => {
    if (!s || s === 'transparent') return null;
    const m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(s.trim());
    if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] == null ? 1 : +m[4]];
    const alpha = /\/\s*([\d.]+%?)\s*\)$/.exec(s);
    const c = rgb(s);
    if (alpha) c[3] = alpha[1].endsWith('%') ? parseFloat(alpha[1]) / 100 : parseFloat(alpha[1]);
    return c;
  };
  const bgOf = (el: Element): number[] => {
    for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) { const c = parse(getComputedStyle(node).backgroundColor); if (c && c[3] >= 0.9) return c; }
    const root = parse(getComputedStyle(document.body).backgroundColor);
    return root && root[3] > 0 ? root : [1, 1, 1, 1];
  };
  const gradStops = (el: Element, base: number[]): number[][] => {
    const stops: number[][] = [];
    for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
      const cs2 = getComputedStyle(node);
      if (/gradient/.test(cs2.backgroundImage)) {
        const layers: string[] = []; let depth = 0, cur = '';
        for (const ch of cs2.backgroundImage) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { layers.push(cur); cur = ''; } else cur += ch; }
        layers.push(cur);
        const sizes = cs2.backgroundSize.split(',');
        layers.forEach((layer, li) => {
          const bh = /\s([\d.]+)px\s*$/.exec((sizes[li] || sizes[0] || '').trim()); if (bh && parseFloat(bh[1]) <= 6) return;
          if (!/^\s*(linear|radial|conic)-gradient/.test(layer) || /[\s,(]\d(?:\.\d+)?px\b/.test(layer)) return;
          for (const m of layer.matchAll(/(?:oklch|oklab|lab|lch|rgba?|hsla?|color)\([^()]*\)|#[0-9a-fA-F]{3,8}\b/g)) stops.push(over(rgb(m[0]), base));
        });
      }
      const c = parse(cs2.backgroundColor);
      if (c && c[3] >= 0.9) break;
    }
    return stops;
  };
  let reported = 0;
  const seen = new Set<string>();
  for (const el of document.querySelectorAll('body *')) {
    if (reported >= 10) break;
    if (!vis(el) || el.closest('svg')) continue;
    if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 2)) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg || fg[3] < 0.9) continue;
    const bg = bgOf(el);
    const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
    const threshold = size >= 24 || (size >= 18 && weight >= 700) ? 3.0 : 4.5;
    const key = describe(el);
    const where = key + ' "' + text(el).slice(0, 24) + '"';
    const stops = gradStops(el, bg);
    if (stops.length && !seen.has(key)) {
      const rs = stops.map((c) => ratio(fg, c));
      const worst = Math.min(...rs), best = Math.max(...rs);
      if (best < threshold - 0.05) { seen.add(key); reported++; out.push({ rule: 'low-contrast', grade: 'fail', evidence: 'contrast ' + best.toFixed(2) + ':1 at best over the gradient behind ' + where, fix: 'raise the contrast to threshold, or give the text its own ground', at: at(el) }); }
      else if (worst < threshold - 0.05) { seen.add(key); reported++; out.push({ rule: 'low-contrast', grade: 'warn', evidence: 'contrast drops to ' + worst.toFixed(2) + ':1 over the gradient behind ' + where, fix: 'check the text where the gradient is darkest or lightest; give the label its own ground', at: at(el) }); }
      continue;
    }
    const r = ratio(fg, bg);
    if (r >= threshold - 0.05 || seen.has(key)) continue;
    seen.add(key);
    reported++;
    const probe = { path: pathOf(el), fg: fg.slice(0, 3), threshold };
    out.push({ rule: 'low-contrast', grade: 'fail', evidence: 'computed contrast ' + r.toFixed(2) + ':1 under ' + threshold + ':1 on ' + where, at: at(el), probe });
    if (el.closest('a, button, [class*="btn"], [class*="cta"]') && r < 1.6) out.push({ rule: 'gray-on-color', grade: 'fail', evidence: 'button text within a step of its fill on ' + key + ' (' + r.toFixed(2) + ':1)', fix: 'the paired ink token: the accent\'s ink or the paper for the label', at: at(el), probe });
  }
  return out;
}

// sloplint-render observe, the accent footprint (gate 23): the strict form, no posture and no genre
export function glAccent(P: Probes): ProbeFinding[] {
  const { vis } = P.H;
  const out: ProbeFinding[] = [];
  const cs0 = getComputedStyle(document.documentElement);
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const toRgb = (raw: string): number[] | null => {
    const s = (raw || '').trim();
    if (!s || s === 'transparent') return null;
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = 'rgba(1, 2, 3, 0.5)'; cx.fillStyle = s;
    if (cx.fillStyle === 'rgba(1, 2, 3, 0.5)') return null;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const targets = ['--color-accent', '--color-accent-2', '--accent', '--accent-2'].map((t) => toRgb(cs0.getPropertyValue(t))).filter((c): c is number[] => !!c);
  if (!targets.length) return out;
  const near = (str: string) => { const p = toRgb(str); return !!p && p[3] >= 0.5 && targets.some((t) => Math.abs(t[0] - p[0]) + Math.abs(t[1] - p[1]) + Math.abs(t[2] - p[2]) <= 30); };
  const CW = 16, COLS = Math.ceil(innerWidth / CW), ROWS = Math.ceil(innerHeight / CW), view = innerWidth + 'x' + innerHeight;
  const grid = new Uint8Array(COLS * ROWS);
  let walked = 0;
  for (const el of document.querySelectorAll('body, body *')) {
    if (++walked > 4000) break;
    if (el !== document.body && !vis(el)) continue;
    const cs = getComputedStyle(el);
    const isBg = near(cs.backgroundColor);
    const isTxt = near(cs.color) && parseFloat(cs.fontSize) >= 32 && Array.from(el.childNodes).some((nd) => nd.nodeType === 3 && (nd.textContent || '').trim());
    if (!isBg && !isTxt) continue;
    const r = el.getBoundingClientRect();
    const x0 = Math.max(0, Math.floor(r.left / CW)), x1 = Math.min(COLS - 1, Math.floor((Math.min(r.right, innerWidth) - 1) / CW));
    const y0 = Math.max(0, Math.floor(r.top / CW)), y1 = Math.min(ROWS - 1, Math.floor((Math.min(r.bottom, innerHeight) - 1) / CW));
    const turned = cs.transform !== 'none' && !/^matrix\(1, 0, 0, 1, /.test(cs.transform);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (turned) { const hit = document.elementFromPoint(x * CW + CW / 2, y * CW + CW / 2); if (!hit || !(hit === el || el.contains(hit))) continue; }
      grid[y * COLS + x] = 1;
    }
  }
  let filled = 0;
  for (const c of grid) filled += c;
  const pct = (100 * filled) / (COLS * ROWS);
  if (pct > 8) out.push({ rule: 'accent-footprint', grade: 'fail', evidence: 'the accent paints about ' + pct.toFixed(1) + '% of the ' + view + ' viewport (over 8%)', fix: 'retreat the accent to 5% or less: large colour belongs to the paper and field tokens' });
  else if (pct > 5) out.push({ rule: 'accent-footprint', grade: 'warn', evidence: 'the accent paints about ' + pct.toFixed(1) + '% of the ' + view + ' viewport', fix: 'retreat the accent to 5% or less, or keep the surface on the record' });
  return out;
}

// sloplint-render focusRing (gate 26a): each focusable element is focused in turn instead of pressing Tab
export function glFocus(P: Probes): RingProbe[] {
  const { vis, rgb, lum, pathOf, at } = P.H;
  const out: RingProbe[] = [];
  const seen = new Set<string>();
  const declared = (el: Element): boolean => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const r of Array.from(rules)) {
        const sel = (r as CSSStyleRule).selectorText;
        if (!sel || !/:focus-visible/.test(sel)) continue;
        try { if (el.matches(sel.replace(/:focus-visible/g, '')) || el.matches(sel.replace(/:focus-visible/g, '*'))) return true; } catch { /* a selector the engine cannot test */ }
      }
    }
    return false;
  };
  const candidates = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')).filter((el) => vis(el) && el.getAttribute('tabindex') !== '-1' && !(el as HTMLButtonElement).disabled && !el.closest('[hidden], dialog:not([open])')).slice(0, 16);
  for (const target of candidates) {
    (target as HTMLElement).focus({ preventScroll: true });
    if (document.activeElement !== target) continue;
    let el: Element | null = target;
    const box = el.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) el = ((target as HTMLInputElement).labels && (target as HTMLInputElement).labels![0]) || target.closest('label') || target.parentElement;
    if (!el) continue;
    (el as HTMLElement).style.setProperty('transition', 'none', 'important');
    const cs = getComputedStyle(el);
    const key = el.tagName.toLowerCase() + (el.classList[0] ? '.' + el.classList[0] : '') + ((el.textContent || '').trim() ? ' "' + (el.textContent || '').trim().slice(0, 18) + '"' : '');
    if (seen.has(key)) continue;
    seen.add(key);
    const base = { key, path: pathOf(target), at: at(target) };
    if (cs.outlineStyle === 'none' || !(parseFloat(cs.outlineWidth) > 0)) {
      if (!target.matches(':focus-visible')) { out.push({ ...base, bare: !declared(target), ratio: null }); continue; }
      const chain: Element[] = []; for (let n: Element | null = el, i = 0; n && n !== document.body && i < 5; n = n.parentElement, i++) chain.push(n);
      const look = () => chain.flatMap((n) => [null, '::before', '::after'].map((ps) => { const c = getComputedStyle(n, ps); return [c.outlineStyle, c.outlineWidth, c.boxShadow, c.borderTopColor, c.borderBottomColor, c.borderLeftColor, c.borderBottomWidth, c.backgroundColor, c.backgroundImage, c.color, c.textDecorationLine, c.opacity].join('|'); })).join('~');
      const focused = look();
      (target as HTMLElement).blur();
      const rest = look();
      (target as HTMLElement).focus({ preventScroll: true });
      out.push({ ...base, bare: focused === rest, ratio: null });
      continue;
    }
    let node: Element | null = parseFloat(cs.outlineOffset) < 0 ? el : el.parentElement;
    let bg: number[] | null = null;
    for (; node && node !== document.documentElement; node = node.parentElement) { const c = rgb(getComputedStyle(node).backgroundColor); if (c[3] >= 0.9) { bg = c; break; } }
    if (!bg) { const b = rgb(getComputedStyle(document.body).backgroundColor); bg = b[3] > 0 ? b : [1, 1, 1, 1]; }
    const ring = rgb(cs.outlineColor);
    if (ring[3] < 0.5) { out.push({ ...base, bare: false, ratio: null }); continue; }
    const a = lum(ring), b = lum(bg);
    out.push({ ...base, bare: false, ring: ring.slice(0, 3), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), pad: Math.max(0, parseFloat(cs.outlineOffset)) + parseFloat(cs.outlineWidth) + 3 });
  }
  if (document.activeElement && document.activeElement !== document.body) (document.activeElement as HTMLElement).blur();
  window.scrollTo(0, 0);
  return out;
}

// sloplint-render observeOcclusion (gate 73)
export async function glOcclusion(P: Probes): Promise<ProbeFinding[]> {
  const { text, at } = P.H;
  const out: ProbeFinding[] = [];
  const vis = (el: Element) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 3 && r.height > 3; };
  const pinnedMemo = new Map<Element, boolean>();
  const pinned = (el: Element): boolean => {
    const hit = pinnedMemo.get(el);
    if (hit !== undefined) return hit;
    let out = false;
    for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) if (/fixed|sticky/.test(getComputedStyle(p).position)) { out = true; break; }
    pinnedMemo.set(el, out);
    return out;
  };
  const unseen = (el: Element) => { const cs = getComputedStyle(el); return parseFloat(cs.opacity) < 0.05 || (/^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor) && cs.backgroundImage === 'none' && !text(el) && !/^(IMG|svg|CANVAS|VIDEO|PICTURE)$/.test(el.tagName) && !el.querySelector('img, svg, canvas, video')); };
  const runs: Array<{ t: Node; host: Element }> = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = tw.nextNode(); t; t = tw.nextNode()) {
    const host = t.parentElement; const txt = (t.textContent || '').trim();
    if (!txt || !host || host.closest('script, style, noscript, svg, [aria-hidden="true"], nav, header, dialog, [popover], [role="menu"], details:not([open]), [hidden]')) continue;
    let gone = false;
    for (let p: Element | null = host; p && p !== document.body; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) { gone = true; break; } }
    if (!gone && !host.closest('[data-slot]') && vis(host)) runs.push({ t, host });
  }
  const bad: Array<{ text: string; el: Element }> = [];
  const H = document.documentElement.scrollHeight;
  for (let y = 0; y < H && bad.length < 3; y += Math.max(200, innerHeight - 100)) {
    window.scrollTo(0, y);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (const { t, host } of runs) {
      if (bad.length >= 3) break;
      if (pinned(host)) continue;
      const rg = document.createRange(); rg.selectNodeContents(t);
      for (const q of rg.getClientRects()) {
        if (q.width < 6 || q.height < 6) continue;
        const cx = q.left + q.width / 2, cy = q.top + q.height / 2;
        if (cy < 0 || cy >= innerHeight || cx < 0 || cx >= innerWidth) continue;
        const ghost = getComputedStyle(host).pointerEvents === 'none'; if (ghost) (host as HTMLElement).style.setProperty('pointer-events', 'auto', 'important');
        const top = document.elementFromPoint(cx, cy);
        if (ghost) (host as HTMLElement).style.removeProperty('pointer-events');
        if (!top || top === host || host.contains(top) || top.contains(host) || pinned(top) || unseen(top)) continue;
        const tr = top.getBoundingClientRect();
        if (!(cx >= tr.left && cx <= tr.right && cy >= tr.top && cy <= tr.bottom)) {
          const clearPseudo = (ps: CSSStyleDeclaration) => /^(none|normal)$/.test(ps.content) || (/^(transparent|rgba\(0, 0, 0, 0\))$/.test(ps.backgroundColor) && ps.backgroundImage === 'none');
          if (clearPseudo(getComputedStyle(top, '::after')) && clearPseudo(getComputedStyle(top, '::before'))) continue;
        }
        bad.push({ text: top.tagName.toLowerCase() + (top.classList[0] ? '.' + top.classList[0] : '') + ' over "' + (t.textContent || '').trim().slice(0, 16) + '"', el: host });
        break;
      }
    }
  }
  window.scrollTo(0, 0);
  if (bad.length) out.push({ rule: 'text-occlusion', grade: 'fail', evidence: 'text painted under another element: ' + bad.map((b) => b.text).join('; '), at: at(bad[0].el) });
  return out;
}

// sloplint-render pixelBehind and pixelsAroundRing, the preparation half: hide the ink, report where to sample in page coordinates
export function glHide(P: Probes, items: PixelItem[]): Array<SampleRect | null> {
  window.scrollTo(0, 0);
  const vw = innerWidth;
  const els = items.map((item) => document.querySelector(item.path) as HTMLElement | null);
  els.forEach((el, i) => {
    if (!el) return;
    if (items[i].kind === 'text') { for (const [k, v] of [['color', 'transparent'], ['text-shadow', 'none'], ['-webkit-text-stroke', '0'], ['text-decoration-color', 'transparent']]) el.style.setProperty(k, v, 'important'); return; }
    el.style.setProperty('outline-style', 'none', 'important');
    el.style.setProperty('box-shadow', 'none', 'important');
  });
  return items.map((item, i) => {
    const el = els[i];
    if (!el) return null;
    if (item.kind === 'text') {
      const r = el.getBoundingClientRect();
      const x = Math.max(0, r.left), y = Math.max(0, r.top + scrollY);
      return { x, y, w: Math.min(r.right, vw) - x, h: Math.min(r.bottom + scrollY, y + 400) - y };
    }
    const r = el.getBoundingClientRect(), pad = item.pad || 4;
    const x = Math.max(0, r.left - pad), y = Math.max(0, r.top + scrollY - pad);
    return { x, y, w: Math.min(vw, r.right + pad) - x, h: r.bottom + scrollY + pad - y, inner: { l: r.left - x, t: r.top + scrollY - y, r: r.right - x, b: r.bottom + scrollY - y } };
  });
}

// sloplint-render pixelBehind's restore
export function glRestore(P: Probes, items: PixelItem[]): number {
  let n = 0;
  for (const item of items) {
    const el = document.querySelector(item.path) as HTMLElement | null;
    if (!el) continue;
    for (const k of ['color', 'text-shadow', '-webkit-text-stroke', 'text-decoration-color', 'outline-style', 'box-shadow']) el.style.removeProperty(k);
    n++;
  }
  window.scrollTo(0, 0);
  return n;
}
