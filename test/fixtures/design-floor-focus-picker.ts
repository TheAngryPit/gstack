/**
 * Case-owned setup answer for test/skill-e2e-plan-design-finding-floor.test.ts.
 * It lives with the case's fixtures so a change to it starts that case's own
 * pass-rate series instead of every case's (scripts/eval-trial-series.ts).
 */
import type { NativePlanQuestionCall } from '../helpers/plan-count-transcript';

/**
 * The seed declares "Design: review all seven dimensions" for the pending Step 0D
 * focus menu. Pick its single all-seven option only when every other option
 * narrows the review and the brief approves no product action.
 */
export function pickDesignFocusAll(q: NativePlanQuestionCall['questions'][number]): number | null {
  if (q.multiSelect || q.options.length < 2 || q.options.length > 4 || new Set(q.options.map(o => o.label)).size !== q.options.length) return null;
  const text = q.question.trim();
  const unquote = (value: string) => value.replace(/`+[^`]*`+|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, '');
  const sources = [...text.matchAll(/^Project\/branch\/task:\s*([^\n]+)$/gm)].map(match => unquote(match[1]!));
  const explanatory = unquote([text, ...q.options.flatMap(o => [o.label, o.description ?? ''])].join('\n')).replace(/[✅❌*]/g, '');
  // The menu is identified by its structure, not one wording: a title or question about the
  // focus ("Review all 7 design dimensions, or focus?", census 36597762183; "Want me to focus on
  // specific areas instead?" and "Review focus for the landing page plan", GSTA-65 focused
  // trials) or about covering all seven dimensions ("Should the review cover all 7 dimensions?",
  // GSTA-92 at a65d492 and 62c0fa1), one all-seven option, and only narrowing alternatives.
  const sentences = text.split(/(?<=[.!?])\s+|\r?\n/);
  const title = text.split(/\r?\n/, 1)[0]!.replace(/^D[1-9]\d*\s*[—–:-]\s*/i, '');
  const asks = sentences.filter(sentence => sentence.includes('?'));
  const coverAll = (ask: string) => /\b(?:cover|review|check|walk)\b.*\ball (?:7|seven)\b.*\b(?:dimensions|passes|areas)\b/i.test(ask);
  if (!([title, ...asks].some(line => /\bfocus\b/i.test(line)) || asks.some(coverAll)) ||
      sources.length !== 1 || !/\b(?:PLAN\.md|Marketing landing page)\b/i.test(sources[0]!) ||
      /\b(?:historical|archived|quoted|example|foreign|other|another|previous)\b/i.test(sources[0]!) ||
      (text.match(/\?/g)?.length ?? 0) > 1 || /```|~~~|^\s*>/m.test(text) ||
      /(?:^|[.!?;:\n]|\b(?:and|while))\s*(?:(?:also|please|then|now)\s+)*(?:approv(?:e|ing)|deploy(?:ing)?|implement(?:ing)?|ship(?:ping)?|merg(?:e|ing)|delet(?:e|ing))\b/im.test(explanatory)) return null;
  const labels = q.options.map(o => o.label.trim().replace(/^[A-Z][).:]\s+/i, '').replace(/\s*\(recommended\)\s*$/i, ''));
  const all = labels.flatMap((label, i) => /^(?:Review )?All (?:7|seven) (?:design )?(?:dimensions|passes|areas)$/i.test(label) ? [i + 1] : []);
  if (all.length !== 1 || labels.some((label, i) => i + 1 !== all[0] && !/^(?:Only|Focus)\b|\bonly$/i.test(label))) return null;
  return all[0]!;
}
