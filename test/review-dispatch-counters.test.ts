import { describe, test, expect } from 'bun:test';
import { summarizeReviewLoop, reviewLoopLine, FIX_CHECK_SKILL } from '../lib/review-scope';
import { parseReviewLoop, receiptSummaryLine } from '../lib/ship-receipt';

const since = '2026-10-27T10:00:00Z';
const row = (o: Record<string, unknown>) => ({ via: 'ship', review_scope: 'frozen', findings: [], ...o });

describe('review loop dispatch counters', () => {
  test('fix-check rows count as fix_checks, never passes, and dispatch events add up by role', () => {
    const rows = [
      row({ skill: 'review', timestamp: '2026-10-27T10:01:00Z', findings: [{ fingerprint: 'a:1:x', action: 'auto-fixed' }],
        dispatches: [{ role: 'specialist', prompt_bytes: 4000, diff_bytes: 8000 }, { role: 'specialist', prompt_bytes: 4000, diff_bytes: 8000 }, { role: 'red-team', prompt_bytes: 2000 }] }),
      row({ skill: 'adversarial-review', timestamp: '2026-10-27T10:05:00Z', dispatches: [{ role: 'adversarial-native', prompt_bytes: 1000 }, { role: 'outside-voice', status: 'unknown' }] }),
      row({ skill: FIX_CHECK_SKILL, timestamp: '2026-10-27T10:10:00Z', dispatches: [{ role: 'fix-check', prompt_bytes: 400, diff_bytes: 600 }] }),
      row({ skill: 'review', timestamp: '2026-10-27T09:00:00Z', dispatches: [{ role: 'specialist', prompt_bytes: 99999 }] }),
    ];
    const s = summarizeReviewLoop(rows, since);
    expect(s).toMatchObject({ passes: 1, fixed: 1, fix_checks: 1, dispatches: { specialist: 2, 'red-team': 1, 'adversarial-native': 1, 'outside-voice': 1, 'fix-check': 1 }, est_input_tokens: Math.round(28000 / 4) });
    expect(reviewLoopLine(s)).toBe('REVIEW_LOOP: passes=1 blocking_found=0 deferred=0 noted=0 fixed=1 scope=frozen fix_checks=1 dispatches=6 est_input_tokens=7000');
  });

  test('older rows without dispatch events fall back to the specialist stats and print the old line plus a count', () => {
    const rows = [row({ skill: 'review', timestamp: '2026-10-27T10:01:00Z', specialists: { testing: { dispatched: true }, security: { dispatched: false, reason: 'scope' }, 'red-team': { dispatched: true } } })];
    const s = summarizeReviewLoop(rows, since);
    expect(s.dispatches).toEqual({ specialist: 1, 'red-team': 1 });
    expect(s.est_input_tokens).toBeUndefined();
    expect(reviewLoopLine(s)).toBe('REVIEW_LOOP: passes=1 blocking_found=0 deferred=0 noted=0 fixed=0 scope=frozen dispatches=2');
  });

  test('rows with neither keep the historical line byte for byte', () => {
    const s = summarizeReviewLoop([row({ skill: 'review', timestamp: '2026-10-27T10:01:00Z' })], since);
    expect(reviewLoopLine(s)).toBe('REVIEW_LOOP: passes=1 blocking_found=0 deferred=0 noted=0 fixed=0 scope=frozen');
  });
});

describe('receipt round trip', () => {
  test('parseReviewLoop keeps the new counters and drops malformed ones; an old receipt parses unchanged', () => {
    expect(parseReviewLoop({ passes: 1, blocking_found: 0, deferred: 0 })).toEqual({ passes: 1, blocking_found: 0, deferred: 0 });
    expect(parseReviewLoop({ passes: 1, blocking_found: 0, deferred: 0, fix_checks: 1, est_input_tokens: 7000, dispatches: { specialist: 2, 'Bad Key': 3, 'red-team': -1, 'fix-check': 1 } }))
      .toEqual({ passes: 1, blocking_found: 0, deferred: 0, fix_checks: 1, est_input_tokens: 7000, dispatches: { specialist: 2, 'fix-check': 1 } });
  });
  test('the SHIP_RECEIPT line carries fix_checks and the dispatch total only when recorded', () => {
    const r = { schema: 1, skill: 'ship', head: 'a'.repeat(40), base: 'main', pr: 7 } as any;
    expect(receiptSummaryLine({ ...r, review_loop: { passes: 1, blocking_found: 0, deferred: 0 } })).toContain('passes=1 blocking_found=0 deferred=0');
    expect(receiptSummaryLine({ ...r, review_loop: { passes: 1, blocking_found: 0, deferred: 0 } })).not.toContain('dispatches=');
    expect(receiptSummaryLine({ ...r, review_loop: { passes: 1, blocking_found: 0, deferred: 0, fix_checks: 1, dispatches: { specialist: 2, 'fix-check': 1 } } })).toContain('deferred=0 fix_checks=1 dispatches=3');
  });
});
