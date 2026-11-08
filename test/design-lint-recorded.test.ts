/**
 * The lint over the repository's recorded design slop page (the review eval's
 * ground truth, test/fixtures/review-eval-design-slop.{html,css}): every issue
 * the page annotates that the lint has a rule for is reported, the clean
 * fixture is not, and both agree with hallmark's own sloplint on the same
 * files (checked by hand at hallmark 7ec8682; the gate set is identical).
 * Phase 1 of the hallmark absorption plan, item D7: the free regression that a
 * recorded output keeps linting the same way.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lint } from '../lib/design-lint';
import { exitCodeOf, formatSummary } from '../lib/design-lint/report';

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

/** The recorded page as it was served: index.html beside the styles.css it links. */
function recordedPage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-recorded-'));
  fs.copyFileSync(path.join(FIXTURES, 'review-eval-design-slop.html'), path.join(dir, 'index.html'));
  fs.copyFileSync(path.join(FIXTURES, 'review-eval-design-slop.css'), path.join(dir, 'styles.css'));
  return dir;
}

describe('design-lint over the recorded review slop page', () => {
  test('each annotated issue the lint has a rule for is reported, with its line, and the page exits 2', async () => {
    const dir = recordedPage();
    try {
      const r = await lint([dir], { cwd: dir });
      const at = (rule: string) => r.findings.filter((f) => f.rule === rule).map((f) => [f.grade, path.basename(f.file), f.line]);
      // Issue 1: the blacklisted face (Papyrus) is a banned face in any role
      expect(at('banned-font')).toEqual([['ask', 'styles.css', 6]]);
      // Issue 5: the indigo-to-violet gradient is the banned gradient
      expect(at('purple-blue-gradient')).toEqual([['blocks', 'styles.css', 14]]);
      // The page declares no --color-* or --font-* token, so its literals bypass nothing and literal-outside-tokens stays quiet
      expect(at('literal-outside-tokens')).toEqual([]);
      // Issue 3: outline: none with nothing in its place
      expect(at('missing-focus-visible')).toEqual([['blocks', 'styles.css', 1]]);
      // Issue 7: the three-column icon-tile grid and its coins
      expect(at('template-cards')).toEqual([['ask', 'styles.css', 33]]);
      expect(at('icon-coin')).toEqual([['polish', 'styles.css', 51]]);
      // Issue 6: generic hero copy, the two lines the design catalog names for it and the buzzword behind them
      expect(at('generic-hero-copy')).toEqual([['blocks', 'index.html', 12], ['blocks', 'index.html', 13]]);
      expect(at('marketing-buzzword')).toEqual([['ask', 'index.html', 32], ['ask', 'index.html', 37]]);
      // Tells the page does not annotate but hallmark's sloplint reports on the same files
      expect(at('pure-black-white').map((f) => f[2])).toEqual([17, 63, 85]);
      expect(at('overflow-x-unclipped')).toEqual([['ask', 'styles.css', 1]]);
      expect(at('off-scale-spacing')).toEqual([['ask', 'styles.css', 78]]);
      expect(at('skipped-heading')).toEqual([['polish', 'index.html', 21]]);
      expect(r.findings.some((f) => f.grade === 'waived')).toBe(false);
      expect(exitCodeOf(r.summary)).toBe(2);
      expect(formatSummary(r.summary)).toMatch(/^LINT_SUMMARY: blocks=7 ask=\d+ waived=0 polish=4 render=skipped: not requested$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
