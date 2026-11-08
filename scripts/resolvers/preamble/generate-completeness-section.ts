import type { TemplateContext } from '../types';

export function generateCompletenessSection(ctx?: TemplateContext): string {
  if (ctx?.explainLevel === 'terse') return '';
  if (ctx?.model === 'gpt-5.6-sol') {
    return `## Completeness Principle — Boil the Ocean Within Scope

AI makes completeness cheap, so do the complete thing **inside the user's explicit task boundary**. The requested target, allowed files or systems, and acceptance criteria define the lake. Within that lake, cover the relevant tests, edge cases, and error paths. Related but unnecessary refactors, speculative hardening, cleanup, and migrations are separate scope: report them, do not implement them.

When options differ in in-scope coverage, include \`Completeness: X/10\` (10 = all relevant in-scope edge cases, 7 = happy path, 3 = shortcut). When options differ in kind, write: \`Note: options differ in kind, not coverage — no completeness score.\` Do not fabricate scores or expand the lake to raise one.`;
  }
  return `## Completeness Principle — Boil the Ocean

Complete coverage, minimal code. Recommend full coverage of the requirement (tests, edge cases, error paths) and no code beyond it: on equal coverage, prefer the smaller diff; no checks for impossible states. Unrelated work (rewrites, multi-quarter migrations) is separate scope: flag it; it never excuses a gap.

When options differ in coverage, include \`Completeness: X/10\` (10 = all edge cases, 7 = happy path, 3 = shortcut). When options differ in kind, write: \`Note: options differ in kind, not coverage — no completeness score.\` Do not fabricate scores.`;
}
