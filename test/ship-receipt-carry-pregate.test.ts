/**
 * gstack-ship-receipt carry with a pregate: eligibility is not publication. A receipt that recorded a
 * pregate rebinds to a new head only with a pregate current for that head (docs/ship-policy.md#receipt-carry).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt } from '../lib/ship-receipt';
import { cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const pregate = (repo: FixtureRepo) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands']);
const outFile = (repo: FixtureRepo) => path.join(repo.work, '.gstack/tmp/pregate.json');

describe('carry with a recorded pregate', () => {
  // Value: protects=a carried receipt never claims the old tree's pregate; fails_when=carry rebinds without a current pregate
  // or accepts a stale one; seam=none; no_claim=gh pr edit (--body stands in)
  test('refuses without a current --pregate, dry-run still reports eligibility, and a current pregate rebinds', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const reviewed = commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    expect(pregate(repo).status).toBe(EXIT.ok);
    const body = path.join(repo.root, 'body.md');
    const w = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--pregate', outFile(repo), '--body', body]);
    expect(w.status).toBe(EXIT.ok);
    const oldPregate = fs.readFileSync(outFile(repo), 'utf8');
    repo.git('checkout', '-q', 'main');
    write(repo.work, 'docs/README.md', '# docs moved on main\n');
    repo.git('commit', '-qam', 'main: docs'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feature');
    repo.git('merge', '-q', '--no-edit', 'origin/main');
    const head = repo.git('rev-parse', 'HEAD');

    const bare = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect(bare.status).toBe(EXIT.refused);
    expect(bare.out).toContain('CARRY: refused (RECEIPT_CARRY_PREGATE_STALE)');
    expect(bare.err).toContain(`run gstack-pregate at HEAD ${head.slice(0, 12)}`);
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.head).toBe(reviewed);

    const dry = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main', '--dry-run']);
    expect([dry.status, dry.out]).toEqual([EXIT.ok, expect.stringContaining('CARRY: would carry')]);

    const stalePath = path.join(repo.root, 'old-pregate.json');
    fs.writeFileSync(stalePath, oldPregate);
    const stale = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main', '--pregate', stalePath]);
    expect(stale.status).toBe(EXIT.refused);
    expect(stale.err).toContain('PREGATE_STALE');
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.head).toBe(reviewed);

    expect(pregate(repo).status).toBe(EXIT.ok);
    const carried = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main', '--pregate', outFile(repo)]);
    expect(carried.status).toBe(EXIT.ok);
    expect(carried.out).toContain(`CARRY: carried from ${reviewed.slice(0, 12)} to ${head.slice(0, 12)}`);
    const after = extractReceipt(fs.readFileSync(body, 'utf8')).receipt!;
    expect(after.head).toBe(head);
    expect(after.pregate).toContain(`current for ${head.slice(0, 12)}`);
  }, 60_000);

  // Value: protects=--head cannot borrow another tree's pregate; fails_when=carry verifies the checkout's tree but stamps the
  // pregate current for a different --head; seam=none; no_claim=gh pr edit (--body stands in)
  test('a --pregate from a checkout at another commit never rebinds the receipt to --head', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const reviewed = commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    expect(pregate(repo).status).toBe(EXIT.ok);
    const body = path.join(repo.root, 'body.md');
    expect(runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--pregate', outFile(repo), '--body', body]).status).toBe(EXIT.ok);
    const target = commit(repo, { 'test/util.test.js': "require('node:assert').strictEqual(1, 2);\n" });
    repo.git('checkout', '-q', reviewed);
    expect(pregate(repo).status).toBe(EXIT.ok);
    const borrowed = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main', '--head', target, '--pregate', outFile(repo)]);
    expect(borrowed.status).toBe(EXIT.refused);
    expect(borrowed.out).toContain('CARRY: refused (RECEIPT_CARRY_PREGATE_STALE)');
    expect(borrowed.err).toContain(`not the carried head ${target.slice(0, 12)}`);
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.head).toBe(reviewed);
  }, 60_000);
});
