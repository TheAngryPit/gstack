/**
 * Waivers on the record. A page answers a finding with a comment that names
 * the rule and gives a reason about this page:
 *
 *   <!-- gstack-lint-disable kicker-above-heading: the chapter number is the reader's bookmark through a 40-page spec -->
 *   /* gstack-lint-disable section-gap: the ledger separates its rows with rules, not air *\/
 *   // gstack-lint-disable template-nav: the three links are the product's three modes
 *
 * `impeccable-disable <rule>: <reason>` is accepted as an alias, so a comment
 * that already silences the impeccable engine silences the same tell here.
 *
 * What the lint refuses, each as its own `waiver` finding: an unknown rule; a
 * blocking rule (the Floor is never waivable; the one exception is a blocking
 * rule the lint could only suspect on this page, which it reports at ask and
 * which a waiver answers like any ask); a reason under 24 characters,
 * boilerplate ("by design", "intentional"), reused word for word on another
 * waiver, or sharing no word of four letters or more with the page's own
 * text; a second waiver of one rule; a claim on one of the lint's own rules
 * (waiver, house-style, render, internal-error). More than three waivers on
 * one page is a house style and belongs in DESIGN.md: reported at polish.
 *
 * Adapted from Nutlope/hallmark's sloplint.mjs applyWaivers (MIT, see
 * NOTICE.md); the guard evidence field is dropped because gstack has no theme
 * stamp to re-derive it from.
 */
import { oneLine, relPath, Reporter, type Finding } from './report';
import { lineIndex } from './css';
import { ruleMeta } from './rules/ids';

export interface WaiverClaim {
  rule: string;
  reason: string;
  file: string;
  line: number;
}

export interface WaiverSet {
  /** Waivers accepted, each with its recorded reason: keyed by rule id for a page claim, and by rule@file for a claim that answers for the file it is written in (a stylesheet, or a component), so two linked sheets may each waive the same rule for their own findings. */
  accepted: Map<string, string>;
  /** Refused waivers, already shaped as findings. */
  refused: Finding[];
}

/** A page claim is keyed by its rule; a claim that answers for its own file by rule@file. */
const waiverKey = (rule: string, file: string | null): string => (file ? `${rule}@${file}` : rule);

export const WAIVER_MIN_REASON = 24;
export const WAIVER_MAX = 3;

/** The reason runs to the end of its comment or line, so two waivers on one line are both read. */
const WAIVER_RE = /(?:gstack-lint-disable|impeccable-disable)\s+([a-z][a-z0-9-]*)\s*:\s*([^\r\n]*?)(?=-->|\*\/|[\r\n]|$)/g;
const WAIVER_REASON_MAX = 300;

const WAIVER_FILLER = /\b(a|an|the|is|it|this|that|was|are|and|but|so|very|just|really|here|quite|more|most)\b/gi;
const WAIVER_BOILERPLATE_PHRASES = [
  'design choice', 'design decision', 'intentionally', 'intentional', 'by design',
  'looks better', 'for the aesthetic', 'aesthetic', 'necessary here', 'necessary',
  'the prompt requires it', 'prompt requires', 'the brief requires it', 'brief requires', 'on purpose', 'deliberate', 'deliberately',
  'it works', 'works better', 'needed', 'required', 'fine', 'ok', 'okay', 'user agreed', 'agreed',
];

export function reasonIsBoilerplate(reason: string): boolean {
  let r = reason.toLowerCase();
  for (const p of WAIVER_BOILERPLATE_PHRASES) r = r.split(p).join(' ');
  r = r.replace(WAIVER_FILLER, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  return r.length < 12;
}

/** Every waiver comment in one source file, with its line. */
export function findWaivers(file: string, source: string): WaiverClaim[] {
  const out: WaiverClaim[] = [];
  const lineOf = lineIndex(source);
  for (const m of source.matchAll(WAIVER_RE)) {
    const reason = m[2].trim().slice(0, WAIVER_REASON_MAX);
    out.push({ rule: m[1], reason, file, line: lineOf(m.index!) });
  }
  return out;
}

const pageWordsOf = (text: string): Set<string> =>
  new Set((text.toLowerCase().replace(WAIVER_RE, ' ').match(/[a-z]{4,}/g) || []));

export const FLOOR_REFUSAL = 'it blocks; the Floor is never waivable';
export const OWN_RULE_REFUSAL = "the lint's own rule, never waivable";

/** The blocking rules a set of findings only suspected: every finding of the rule sits at ask (report.ts demotes a suspected blocking finding), none was measured. */
export function suspectedRules(findings: Finding[]): Set<string> {
  const measured = new Set(findings.filter((f) => f.tier === 'blocks').map((f) => f.rule));
  return new Set(findings.filter((f) => f.tier === 'ask' && ruleMeta(f.rule)?.tier === 'blocks' && !measured.has(f.rule)).map((f) => f.rule));
}

/**
 * Validate the claims of one context against its visible text. The text the
 * reason must share a word with is the page's own prose, waiver comments
 * removed, so a reason cannot vouch for itself; a claim written in a
 * stylesheet answers for that stylesheet on every page that links it, so the
 * shared-word check does not apply to it (nor to a stylesheet linted on its
 * own, which has no prose). `suspected` names
 * the blocking rules this context could only suspect (reported at ask): a
 * waiver on one of them is weighed like any ask; a waiver on any other
 * blocking rule, measured or not found, is refused. With `ownFile`, every
 * claim answers for the file it is written in (a component in a directory
 * of components), keyed like a stylesheet claim and weighed against
 * `pageText` as that file's own text.
 */
export function resolveWaivers(claims: WaiverClaim[], pageText: string, cwd = process.cwd(), suspected: ReadonlySet<string> = new Set(), ownFile = false): WaiverSet {
  const accepted = new Map<string, string>();
  const rep = new Reporter('page', cwd);
  const pageWords = pageWordsOf(pageText);
  const reasons = new Map<string, number>();
  for (const c of claims) reasons.set(c.reason.toLowerCase(), (reasons.get(c.reason.toLowerCase()) || 0) + 1);
  const refuse = (c: WaiverClaim, why: string) => rep.report('waiver', c.file, c.line, `waiver on ${c.rule} refused: ${why}`,
    { fix: 'fix the finding, or waive it with the rule id and a reason about this page (24 characters or more, not boilerplate)' });
  for (const c of claims) {
    const meta = ruleMeta(c.rule);
    if (!meta) { refuse(c, 'no such rule'); continue; }
    if (meta.gate === 'waiver' || meta.gate === 'render' || meta.gate === 'lint') { refuse(c, OWN_RULE_REFUSAL); continue; }
    if (meta.tier === 'blocks' && !suspected.has(c.rule)) { refuse(c, FLOOR_REFUSAL); continue; }
    const sheet = /\.css$/i.test(c.file);
    const key = waiverKey(c.rule, sheet || ownFile ? oneLine(relPath(c.file, cwd)) : null);
    if (accepted.has(key)) { refuse(c, 'one waiver per rule'); continue; }
    if (c.reason.length < WAIVER_MIN_REASON) { refuse(c, `reason under ${WAIVER_MIN_REASON} characters`); continue; }
    if (reasonIsBoilerplate(c.reason)) { refuse(c, 'boilerplate reason'); continue; }
    if ((reasons.get(c.reason.toLowerCase()) || 0) > 1) { refuse(c, 'reason reused on another waiver'); continue; }
    const words = c.reason.toLowerCase().match(/[a-z]{4,}/g) || [];
    if (pageWords.size && !sheet && !words.some((w) => pageWords.has(w))) { refuse(c, 'reason shares no word with the page'); continue; }
    accepted.set(key, c.reason);
  }
  const rulesWaived = [...new Set([...accepted.keys()].map((k) => k.split('@')[0]))];
  if (rulesWaived.length > WAIVER_MAX) {
    rep.report('house-style', claims[0].file, claims[0].line, `${rulesWaived.length} rules waived on one page (${rulesWaived.join(', ')}): that is a house style, not a set of exceptions`,
      { fix: 'lock the choices into DESIGN.md so later pages inherit them instead of re-arguing them' });
  }
  return { accepted, refused: rep.findings };
}

/** Mark waived ask and polish findings; blocking findings never change, and a claim keyed to its file reaches only findings in that file. Returns the findings plus the refusals. */
export function applyWaivers(findings: Finding[], set: WaiverSet): Finding[] {
  const out = findings.map((f) => {
    const reason = set.accepted.get(f.rule) ?? set.accepted.get(waiverKey(f.rule, f.file));
    if (f.tier === 'blocks' || reason == null) return f;
    return { ...f, grade: 'waived' as const, waiver: oneLine(reason) };
  });
  return [...out, ...set.refused];
}
