/**
 * Chrome rules, the copy half (sloplint gate 19, the hero half of gate 42 and
 * the two-filled-buttons half of F4; Nutlope/hallmark, MIT, see NOTICE.md),
 * rewritten in gstack's voice. Rule ids: aphoristic-cadence,
 * generic-hero-copy, generic-cta-copy, em-dash-overuse, template-footer-line,
 * two-primary-buttons. The prose mask these rules read is maskedProse in
 * ../html.ts. Placeholder names, brands, lorem and buzzwords are the copy
 * tier's (rules/copy.ts) and are not reported here.
 */
import { styleFor, type LintContext } from '../context';
import { resolveVars } from '../css';
import { ancestorsOf, getAttr, innerOf, maskedProse, textOf, treeOf, type Doc, type Tag } from '../html';
import { trunc, type Reporter } from '../report';


// sloplint TELLS19 (gate 19), less the lines the copy tier owns
const HERO_TELLS: Array<[RegExp, string]> = [
  [/\bwhether you['’]?re\b/i, 'a filler opener'],
  [/\bbuilt for the modern\b/i, 'a filler opener'],
  [/\bin today['’]s\b/i, 'a filler opener'],
  [/\bquietly (?:trusted|in use)\b/i, 'the quiet-proof line'],
  [/\bwe['’]?ve got you covered\b/i, 'a stock line'],
  [/\bsay goodbye to\b/i, 'a stock line'],
  [/\bno credit card required\b/i, 'a template line'],
  [/\beverything you need to\b/i, 'a stock line'],
  [/\ball in one place\b/i, 'a stock line'],
  [/\ball-in-one solution\b/i, 'a stock line'],
  [/\bwelcome to\b/i, 'a stock opener'],
  [/\bmade with\s*(?:♥|❤|\u{1f9e1}|\u{1f49b}|\u{1f49a}|\u{1f499}|\u{1f49c}|\u{1f5a4}|\u{1f90d}|&hearts;|&#9829;|&#10084;|<3)/iu, 'the made-with-a-heart line'],
];
const FOOTER_LINE = /\ball rights reserved\b/i;
const STOCK_LINK = /^(learn more|read more|find out more|click here|more info|see more)$/i;

// sloplint check19Tells (gate 19)
function checkHeroCopy(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const prose = maskedProse(doc);
    const lines = new Set<number>();
    const hero = heroRange(doc);
    const tell = (rule: string, idx: number, what: string, text: string, heading = false): void => {
      const line = doc.lineOf(idx);
      if (lines.has(line)) return;
      lines.add(line);
      const inHero = !heading || (hero != null && idx >= hero[0] && idx < hero[1]);
      r.report(rule, doc.file, line, `${what}: "${trunc(text, 40)}"`, inHero ? {} : { suspected: true, fix: 'a heading in the product\'s own voice; below the hero this is a suspicion, so a waiver can answer it' });
    };
    for (const [re, what] of HERO_TELLS) {
      const all = [...prose.matchAll(new RegExp(re.source, re.flags + 'g'))];
      const inHero = all.find((m) => hero && m.index! >= hero[0] && m.index! < hero[1]);
      const m = inHero ?? all[0];
      if (!m) continue;
      const line = doc.lineOf(m.index!);
      if (lines.has(line)) continue;
      lines.add(line);
      r.report('generic-hero-copy', doc.file, line, `${what}: "${trunc(m[0], 40)}"`, inHero ? {} : { suspected: true, fix: 'a line in the product\'s own voice; in body copy this is a suspicion, so a waiver can answer it' });
    }
    const footer = FOOTER_LINE.exec(prose);
    if (footer) tell('template-footer-line', footer.index, 'a stock footer line', footer[0]);
    const stock: Array<{ t: Tag; label: string }> = [];
    for (let i = 0; i < doc.tags.length; i++) {
      const t = doc.tags[i];
      if (t.close) continue;
      if (t.name === 'a') {
        const label = textOf(doc, i).replace(/[\u2192\u203a\u00bb]|->/g, '').trim();
        if (STOCK_LINK.test(label)) stock.push({ t, label });
        continue;
      }
      if (!/^h[1-6]$/.test(t.name)) continue;
      const text = textOf(doc, i);
      if (/^Meet\s+[A-Z][\w-]*[.!]?$/.test(text)) tell('generic-hero-copy', t.pos, 'the "Meet <Name>" heading', text, true);
      else if (/^[A-Z][a-z]+\.\s+[A-Z][a-z]+\.\s+[A-Z][a-z]+\.$/.test(text)) tell('generic-hero-copy', t.pos, 'the three-word triad heading', text, true);
    }
    if (stock.length >= 2) {
      r.report('generic-cta-copy', doc.file, stock[0].t.line, `the stock link label "${stock[0].label}" on ${stock.length} links`, { fix: 'say where each link goes: the thing it opens, in its own noun' });
    }
  }
}

const DASH = /\w\s--\s\w|[\u2014\u2013]|&mdash;|&ndash;|&#8212;|&#8211;/g;
const CADENCE = /(^|[.!?]\s+)(not|no)\s+[a-z][^.!?\n]{0,40}[.]\s+(just|only|a|an)?\s*[a-z][^.!?\n]{0,40}[.]/gi;

// sloplint checkCopyTell (gate 19): the cadence and the dashes; the buzzwords are the copy tier's
function checkCadenceAndDashes(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const prose = maskedProse(doc);
    const dashes = [...prose.matchAll(DASH)].filter((m) => !(/\d/.test(prose[m.index! - 1] || '') && /\d/.test(prose[m.index! + m[0].length] || '')));
    if (dashes.length >= 3) {
      const at = dashes[0].index ?? 0;
      const around = prose.slice(Math.max(0, at - 16), at + 16).replace(/\s+/g, ' ').trim();
      r.report('em-dash-overuse', doc.file, doc.lineOf(at), `${dashes.length} dashes carry the prose (first: "${trunc(around, 40)}")`);
    }
    const cadence = prose.match(CADENCE);
    if (cadence && cadence.length >= 3) {
      const first = cadence[0].trim();
      r.report('aphoristic-cadence', doc.file, doc.lineOf(Math.max(0, prose.indexOf(first))), `the rebuttal cadence ${cadence.length} times ("${trunc(first, 40)}")`, { fix: 'once is voice, three times is a tic: say what the product does, in its own nouns' });
    }
  }
}

const SECOND_CTA = /^(learn more|see how it works|watch (the )?demo|get started|book a demo)$/i;

/** The source range the hero copy lives in: the section or header holding the h1, else the h1's parent; null without an h1. A tell here is the Floor, elsewhere it is suspected. */
function heroRange(doc: Doc): [number, number] | null {
  const h1 = doc.tags.findIndex((t) => !t.close && t.name === 'h1');
  if (h1 < 0) return null;
  const heroIdx = heroIndexOf(doc, h1);
  const holder = heroIdx >= 0 ? heroIdx : treeOf(doc).parent[h1];
  if (holder < 0) return null;
  const inner = innerOf(doc, holder);
  return inner ? [doc.tags[holder].end, inner.endPos] : null;
}

/** The <section> or <header> that holds the h1, by tag index; -1 when none does. */
// sloplint heroIndexOf
export function heroIndexOf(doc: Doc, h1Idx: number): number {
  for (let i = h1Idx - 1; i >= 0; i--) {
    const t = doc.tags[i];
    if (t.close || !/^(section|header)$/.test(t.name)) continue;
    const inner = innerOf(doc, i);
    if (inner && inner.endPos > doc.tags[h1Idx].pos) return i;
  }
  return -1;
}

interface HeroControl { t: Tag; cls: string; label: string }

/** Whether a control's resting background is a fill (not none, transparent or the paper). */
function isFilled(ctx: LintContext, c: HeroControl): boolean {
  let raw: string | null = null;
  for (const d of styleFor(ctx, c.cls, c.t.name, true)) if (d.prop === 'background-color' || d.prop === 'background') raw = d.value;
  if (!raw || /--color-paper\b/.test(raw)) return false;
  const bg = resolveVars(raw, ctx.tokens);
  return !/^(none|transparent|inherit|initial|unset)$/i.test(bg.trim()) && !/transparent/i.test(bg);
}

// sloplint check42TwoButton (gate 19 and F4)
function checkHeroActions(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    const h1 = doc.tags.findIndex((t) => !t.close && t.name === 'h1');
    if (h1 < 0) continue;
    const heroIdx = heroIndexOf(doc, h1);
    const hero = heroIdx >= 0 ? innerOf(doc, heroIdx) : null;
    if (!hero) continue;
    const controls: HeroControl[] = [];
    for (let i = heroIdx + 1; i < doc.tags.length && doc.tags[i].pos < hero.endPos; i++) {
      const t = doc.tags[i];
      if (t.close || t.selfClosing || !(t.name === 'button' || t.name === 'a')) continue;
      const cls = getAttr(t.attrs, 'class') || '';
      if (t.name === 'a' && !/btn|cta|button/i.test(cls)) continue;
      if (ancestorsOf(doc, i).includes('nav')) continue;
      controls.push({ t, cls, label: textOf(doc, i).trim() });
    }
    if (controls.length < 2) continue;
    const firstFilled = isFilled(ctx, controls[0]);
    if (firstFilled && isFilled(ctx, controls[1])) {
      r.report('two-primary-buttons', doc.file, controls[1].t.line, `two filled buttons side by side in the hero: "${trunc(controls[0].label, 20)}" and "${trunc(controls[1].label, 20)}"`);
      continue;
    }
    if (!firstFilled || !SECOND_CTA.test(controls[1].label)) continue;
    r.report('generic-cta-copy', doc.file, controls[1].t.line, `the stock second action in the hero: "${trunc(controls[0].label, 20)}" then "${controls[1].label}"`, { fix: 'one action in the hero, or a second that names where it goes' });
  }
}

export function runChromeCopy(ctx: LintContext, r: Reporter): void {
  checkHeroCopy(ctx, r);
  checkCadenceAndDashes(ctx, r);
  checkHeroActions(ctx, r);
}
