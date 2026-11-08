/**
 * The copy tier: content realism and the ship floor (Elaya-derived, MIT; see
 * NOTICE.md), each tell reported at its line. Copy rules read the visible
 * text (comments, scripts, styles and templates removed, entities decoded);
 * code rules read script bodies and inline handlers; tag rules read the
 * parsed tags, so a hydration payload or commented-out markup is never
 * counted. Head rules run only on a document with a <head>. A page whose body
 * holds no text and loads a script is an empty mount node: script renders it,
 * so nothing here saw its content, and it says so instead of passing.
 */
import type { LintContext } from '../context';
import { getAttr, hasAttr, stripTags, textOf, treeOf, type Doc, type Tag } from '../html';
import type { Reporter } from '../report';
import { RULES } from './ids';

/** The catalog's marketing-buzzword words plus Elaya's AI cliché words. */
export const BUZZWORDS: readonly string[] = [
  'seamless', 'effortless', 'supercharge', 'streamline', 'revolutionize', 'unlock', 'empower', 'elevate',
  'unleash', 'next-gen', 'game-changer', 'delve', 'tapestry', 'in the world of',
];

const stem = (w: string) => w.replace(/-/g, '[- ]').replace(/e$/, '');

const TEXT_RULES: Array<[string, RegExp]> = [
  ['placeholder-name', /\b(?:John|Jane) Doe\b/gi],
  ['placeholder-brand', /\b(?:Acme|Nexus|SmartFlow)\b/g],
  ['lorem', /\blorem ipsum\b/gi],
  ['marketing-buzzword', new RegExp(`\\b(?:${BUZZWORDS.map(stem).join('|')})(?:e|es|ed|ing|ly|er|ers|s|d|eration)?\\b`, 'gi')],
  ['round-number', /(?<![\d.])(?:99\.9+|[1-9]0|100)%\s+(?:uptime|faster|more|less|fewer|better|growth|increase|reduction|of (?:teams|users|customers|companies))\b|\b(?:\d+0|\d+(?:,\d{3})+)\+?\s+(?:happy |active )?(?:users|customers|teams|companies)\b|(?<![\d.])10x\s+(?:faster|more|better)\b/gi],
  ['needs-proof', /\[Needs proof:/g],
  ['oops', /\boops\b/gi],
];

const SCRIPT_RULES: Array<[string, RegExp]> = [
  ['scroll-listener', /addEventListener\(\s*['"`]scroll['"`]/g],
  ['alert', /(?<![\w.$])(?:window\.)?alert\s*\(/g],
];

/** Every id the copy tier can print. */
export const COPY_IDS: readonly string[] = [
  ...TEXT_RULES.map(([id]) => id), ...SCRIPT_RULES.map(([id]) => id), 'dead-link', 'img-no-alt',
  'missing-title', 'missing-meta-description', 'missing-favicon', 'missing-skip-link', 'missing-aria-current', 'empty-mount-node',
];

const ENTITY = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(nbsp|lt|gt|quot|apos|amp));/iy;
const NAMED: Record<string, string> = { nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

/** The visible text with each character's source position: tags, comments, scripts, styles and the dropped elements removed, entities decoded, whitespace folded. */
function visible(doc: Doc, drop: ReadonlySet<string>): { text: string; at: number[] } {
  const { close } = treeOf(doc);
  const ranges: Array<[number, number]> = [];
  doc.tags.forEach((t, i) => {
    if (!t.close && !t.selfClosing && drop.has(t.name)) ranges.push([t.pos, close[i] < 0 ? doc.masked.length : doc.tags[close[i]].end]);
  });
  let blanked = '', from = 0;
  for (const [a, b] of ranges) if (a >= from) { blanked += doc.masked.slice(from, a) + ' '.repeat(b - a); from = b; }
  const src = stripTags(blanked + doc.masked.slice(from), true);
  let text = '';
  const at: number[] = [];
  const push = (ch: string, pos: number) => {
    if (/\s/.test(ch)) { if (!text.endsWith(' ')) { text += ' '; at.push(pos); } return; }
    for (let k = 0; k < ch.length; k++) at.push(pos);
    text += ch;
  };
  for (let i = 0; i < src.length;) {
    if (src[i] === '&') {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(src);
      const cp = m && (m[1] ? Number(m[1]) : m[2] ? parseInt(m[2], 16) : -1);
      if (m && (cp === -1 || cp! <= 0x10ffff)) {
        push(m[3] ? NAMED[m[3].toLowerCase()] : String.fromCodePoint(cp!), i);
        i += m[0].length;
        continue;
      }
    }
    const c = src.codePointAt(i)!;
    const ch = String.fromCodePoint(c);
    push(ch, i);
    i += ch.length;
  }
  return { text, at };
}

/** Each script body and inline event handler, with the position its code starts. */
function codeOf(doc: Doc): Array<{ code: string; pos: number }> {
  const { close } = treeOf(doc);
  const out: Array<{ code: string; pos: number }> = [];
  doc.tags.forEach((t, i) => {
    if (t.close) return;
    if (t.name === 'script' && close[i] >= 0) out.push({ code: doc.src.slice(t.end, doc.tags[close[i]].pos), pos: t.end });
    for (const m of t.attrs.matchAll(/(?:^|\s)on[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const code = m[1] ?? m[2];
      out.push({ code, pos: t.pos + 1 + t.name.length + m.index! + m[0].length - 1 - code.length });
    }
  });
  return out;
}

const firstOpen = (doc: Doc, name: string): number => doc.tags.findIndex((t) => !t.close && t.name === name);

export function run(ctx: LintContext, r: Reporter): void {
  for (const doc of ctx.docs) {
    if (doc.kind !== 'html') continue;
    const hits = new Map<string, Map<number, string[]>>();
    const hit = (id: string, pos: number, what: string) => {
      const byLine = hits.get(id) ?? hits.set(id, new Map()).get(id)!;
      const line = doc.lineOf(pos);
      const found = byLine.get(line);
      if (found) found.push(what);
      else byLine.set(line, [what]);
    };
    const { text, at } = visible(doc, new Set(['template']));
    for (const [id, re] of TEXT_RULES) for (const m of text.matchAll(re)) hit(id, at[m.index!], `"${m[0]}"`);
    for (const { code, pos } of codeOf(doc)) for (const [id, re] of SCRIPT_RULES) for (const m of code.matchAll(re)) hit(id, pos + m.index!, '');
    for (const t of doc.tags) {
      if (t.close) continue;
      if (getAttr(t.attrs, 'href')?.trim() === '#') hit('dead-link', t.pos, '');
      if (t.name === 'img' && !hasAttr(t.attrs, 'alt')) hit('img-no-alt', t.pos, '');
    }
    const head = firstOpen(doc, 'head');
    const bodyIdx = firstOpen(doc, 'body');
    const bodyTag: Tag | undefined = doc.tags[bodyIdx];
    if (head >= 0) {
      const at0 = doc.tags[head].pos;
      const opens = (name: string) => doc.tags.map((t, i) => [t, i] as const).filter(([t]) => !t.close && t.name === name);
      if (!opens('title').some(([, i]) => textOf(doc, i).trim() !== '')) hit('missing-title', at0, '');
      if (!opens('meta').some(([t]) => getAttr(t.attrs, 'name')?.trim().toLowerCase() === 'description')) hit('missing-meta-description', at0, '');
      if (!opens('link').some(([t]) => /\bicon\b/i.test(getAttr(t.attrs, 'rel') ?? ''))) hit('missing-favicon', at0, '');
      const focusable = doc.tags.slice(Math.max(bodyIdx, 0)).find((t) => !t.close && ((t.name === 'a' && hasAttr(t.attrs, 'href')) || /^(?:button|input|select|textarea)$/.test(t.name)));
      const skipTarget = focusable?.name === 'a' ? getAttr(focusable.attrs, 'href')?.match(/^#(.+)$/)?.[1] : undefined;
      const mainTag = doc.tags.find((t) => !t.close && t.name === 'main' && getAttr(t.attrs, 'id'))
        ?? doc.tags.find((t) => !t.close && getAttr(t.attrs, 'role') === 'main' && getAttr(t.attrs, 'id'));
      if (!skipTarget || skipTarget !== getAttr(mainTag?.attrs ?? '', 'id')) hit('missing-skip-link', bodyTag?.pos ?? at0, '');
      const { close } = treeOf(doc);
      let firstNav = -1, navEnd = -1, routeLinks = 0;
      for (let i = 0; i < doc.tags.length && routeLinks < 2; i++) {
        const t = doc.tags[i];
        if (t.close) continue;
        if (t.name === 'nav') {
          if (firstNav < 0) firstNav = i;
          navEnd = Math.max(navEnd, close[i] < 0 ? doc.tags.length : close[i]);
        } else if (i < navEnd && t.name === 'a' && /^[^#]/.test(getAttr(t.attrs, 'href') ?? '')) routeLinks++;
      }
      if (routeLinks >= 2 && !doc.tags.some((t) => !t.close && getAttr(t.attrs, 'aria-current') === 'page')) hit('missing-aria-current', doc.tags[firstNav].pos, '');
    }
    const headClose = head >= 0 ? treeOf(doc).close[head] : -1;
    const bodyFrom = bodyTag?.pos ?? (headClose >= 0 ? doc.tags[headClose].end : 0);
    const shellText = visible(doc, new Set(['template', 'noscript']));
    const bodyStart = shellText.at.findIndex((p) => p >= bodyFrom);
    const bodyText = bodyStart < 0 ? '' : shellText.text.slice(bodyStart);
    if (!/[\p{L}\p{N}]/u.test(bodyText) && doc.tags.some((t) => !t.close && t.name === 'script')) {
      const { close } = treeOf(doc);
      const mount = doc.tags.find((t, i) => !t.close && t.pos >= bodyFrom && !t.selfClosing && t.name !== 'script' && t.name !== 'noscript' && t.name !== 'body'
        && (getAttr(t.attrs, 'id') !== null || t.name.includes('-')) && close[i] === i + 1);
      hit('empty-mount-node', mount?.pos ?? bodyFrom, mount ? `<${mount.name}${getAttr(mount.attrs, 'id') ? ` id="${getAttr(mount.attrs, 'id')}"` : ''}>` : '');
    }
    for (const [id, byLine] of hits) {
      const title = RULES[id].title;
      for (const [line, found] of byLine) {
        const named = [...new Set(found.filter(Boolean))];
        const evidence = named.length ? `${title}: ${named.join(', ')}` : found.length > 1 ? `${title}, ${found.length} on this line` : title;
        r.report(id, doc.file, line, evidence, { source: 'copy' });
      }
    }
  }
}
