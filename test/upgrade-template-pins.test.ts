/**
 * Static pins for the v1.68 wave's prose-tier behaviors — the coverage audit
 * flagged these as the only surfaces a future template edit could silently
 * revert without failing anything.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('gstack-upgrade template: exact-SHA transactional activation', () => {
  const tmpl = read('gstack-upgrade/SKILL.md.tmpl');

  test('the accepted commit is pinned by its required latest Actions attempts', () => {
    expect(tmpl).toContain('UPGRADE_AVAILABLE <old> <new> <sha>');
    expect(tmpl).toContain('required latest Actions attempts');
    expect(tmpl).toContain('exact SHA from UPGRADE_AVAILABLE');
    expect(tmpl).toContain('--apply-candidate "<sha from UPGRADE_AVAILABLE>"');
  });

  test('the skill leaves source activation and rollback to the transactional updater', () => {
    expect(tmpl).toContain('gstack-session-update owns trusted-fork activation, rollback, and verification');
    expect(tmpl).toContain('On failure after activation began, the updater restores the retained source');
    expect(tmpl).toContain('never call it current');
  });

  test('model-run commands contain no source-mutating Git fallback', () => {
    const commands = [...tmpl.matchAll(/^(`{3,}|~{3,})bash\n([\s\S]*?)\n\1$/gm)].map(match => match[2]);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).not.toMatch(/\bgit\s+(pull|reset|stash|fetch|clone|checkout|merge)\b/);
    }
  });
});

describe('untrusted-content warning injection points (#2441)', () => {
  test('scrape and skillify templates carry the shared token', () => {
    // The wording lives in ONE exported const (resolvers/browse.ts); these
    // pins keep the injection POINTS from silently disappearing.
    expect(read('scrape/SKILL.md.tmpl')).toContain('{{UNTRUSTED_CONTENT_WARNING}}');
    expect(read('skillify/SKILL.md.tmpl')).toContain('{{UNTRUSTED_CONTENT_WARNING}}');
  });
});

describe('brain-uninstall removes the spool queue', () => {
  test('uninstall cleans .brain-queue.d alongside the legacy queue file', () => {
    const src = read('bin/gstack-brain-uninstall');
    expect(src).toContain('.brain-queue.d');
    expect(src).toContain('.brain-queue.jsonl');
  });
});
