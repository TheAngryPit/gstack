/**
 * Craft resolvers shared by /design-review's craft audit and /plan-design-review.
 *
 * {{DESIGN_CRAFT_RULE:<lead>}} renders one paragraph of design-html's craft
 * section verbatim, found by its bold lead (`**Ship floor.**`), with the
 * bullets under it, so the audit holds a page to the rules /design-html builds
 * it to and the two cannot drift. A renamed lead fails generation.
 *
 * {{DESIGN_PERSUADE_CHECKS}} is the five conversion checks, phrased to hold for
 * a built page and for a plan of one. Adapted from Elaya's landing-page-design
 * and redesign-skill (MIT); see NOTICE.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ResolverFn } from './types';

const CRAFT_SECTION = path.resolve(import.meta.dir, '../../design-html/sections/craft.md.tmpl');

export const DESIGN_CRAFT_RULE: ResolverFn = (_ctx, args) => {
  const lead = args?.join(':');
  if (!lead) throw new Error('{{DESIGN_CRAFT_RULE:<lead>}} requires the bold lead of a craft paragraph');
  const matches = fs.readFileSync(CRAFT_SECTION, 'utf-8').split(/\n{2,}/).filter(p => p.startsWith(`**${lead}.**`) || p.startsWith(`**${lead},`));
  if (matches.length !== 1) throw new Error(`{{DESIGN_CRAFT_RULE:${lead}}}: ${matches.length} paragraphs starting "**${lead}.**" or "**${lead}," in design-html/sections/craft.md.tmpl; need exactly one`);
  return matches[0].trimEnd();
};

export const DESIGN_PERSUADE_CHECKS: ResolverFn = () => `1. **One primary action**, named; nothing competes with it above the fold, and the closing CTA repeats it.
2. **Named objections**: the visitor's top objections, each answered where it arises (FAQ of real questions, comparison, guarantee).
3. **Proof beside each claim**: a supplied customer, quote or figure next to the claim it supports, never a metric row; an unsupported claim is cut or marked \`[Needs proof: …]\`.
4. **A risk reversal** the business really offers (free plan, trial, no card, cancel anytime, refund); never an invented one.
5. **An index/noindex decision**: an ad-only or time-bound page is \`noindex\`; an indexed one has a real title and description, and its FAQ ships as FAQPage JSON-LD.`;
