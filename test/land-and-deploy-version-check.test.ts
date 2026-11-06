/**
 * /land-and-deploy Step 3.4 VERSION check (#3318). The old step compared the
 * branch VERSION with the next free patch slot, so it stopped stamp-at-merge
 * PRs that share a tentative stamp, a claim-at-open PR whose sibling claimed a
 * higher slot, and every MICRO bump. These tests run the template's own block
 * against a real git fixture and the real gstack-ship-policy, with a stubbed
 * gstack-next-version reply, and pin each verdict, including the real stops.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dir, '..');
const STUB = `process.stdout.write(process.env.FAKE_QUEUE_JSON ?? '');
process.exit(Number(process.env.FAKE_QUEUE_CODE ?? 0));
`;

function step34(): string {
  const tmpl = readFileSync(join(ROOT, 'land-and-deploy', 'SKILL.md.tmpl'), 'utf8');
  const step = tmpl.slice(tmpl.indexOf('## Step 3.4:'), tmpl.indexOf('{{SECTION:readiness-gate}}'));
  const blocks = [...step.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(m => m[1]);
  expect(blocks).toHaveLength(1);
  return blocks[0];
}

let root: string;
let dir: string;
let repo: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lad-version-'));
  writeFileSync(join(root, 'next-version.ts'), STUB);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function git(...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const changelog = (...versions: string[]) => `# Changelog\n\n${versions.map(v => `## [${v}] - 2026-10-24\n\n- entry\n`).join('\n')}`;

interface Tree { version?: string; changelog?: string; policy?: string }
function commit(tree: Tree, message: string): string {
  for (const [file, body] of [['VERSION', tree.version], ['CHANGELOG.md', tree.changelog], ['.gstack/ship-policy.json', tree.policy]] as const) {
    if (body === undefined) continue;
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), body.endsWith('\n') ? body : `${body}\n`);
  }
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', message);
  return git('rev-parse', 'HEAD');
}

interface Case {
  mode?: 'stamp-at-merge' | 'claim-at-open' | 'none' | 'invalid';
  base: Tree;
  head: Tree;
  queue?: object | string;
  queueCode?: number;
  shell?: 'bash' | 'zsh';
}
function verdict(c: Case): string {
  dir = mkdtempSync(join(root, 'case-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  const policy = c.mode === 'none' || c.mode === undefined ? undefined
    : c.mode === 'invalid' ? '{"queue_mode": '
    : JSON.stringify({ queue_mode: c.mode, bump: 'patch' });
  const baseSha = commit({ ...c.base, policy }, 'base');
  spawnSync('git', ['init', '-q', '--bare', join(dir, 'origin.git')], { timeout: 15_000 });
  git('remote', 'add', 'origin', join(dir, 'origin.git'));
  git('push', '-q', 'origin', 'main');
  git('checkout', '-q', '-b', 'feature');
  const head = commit(c.head, 'head');
  const queue = c.queue ?? { offline: false, claimed: [], complete: true };
  const block = step34()
    .replaceAll('~/.claude/skills/gstack/bin/gstack-ship-policy', join(ROOT, 'bin', 'gstack-ship-policy'))
    .replaceAll('~/.claude/skills/gstack/bin/gstack-next-version', join(root, 'next-version.ts'));
  const r = spawnSync(c.shell ?? 'bash', ['-c', block], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PR_HEAD: head, BASE_SHA: baseSha, BASE_BRANCH: 'main', PR_NUMBER: '7',
      FAKE_QUEUE_JSON: typeof queue === 'string' ? queue : JSON.stringify(queue),
      FAKE_QUEUE_CODE: String(c.queueCode ?? 0),
    },
  });
  const line = r.stdout.split('\n').find(l => l.startsWith('VERSION_CHECK: '));
  if (!line) throw new Error(`no VERSION_CHECK line (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  return line;
}

const claim = (pr: number, version: string) => ({ pr, branch: `b${pr}`, version });
const BASE: Tree = { version: '1.91.186.0', changelog: changelog('1.91.186.0') };
const stamped = (version: string, below = '1.91.186.0'): Tree => ({ version, changelog: changelog(version, below) });

describe('stamp-at-merge: verify the exact head stamp, ignore claims', () => {
  test('a sibling sharing the tentative stamp no longer stops the PR', () => {
    expect(verdict({ mode: 'stamp-at-merge', base: BASE, head: stamped('1.91.187.0'), queue: { offline: false, claimed: [claim(8, '1.91.187.0')], complete: true } }))
      .toBe('VERSION_CHECK: ok (stamp-at-merge: 1.91.187.0, base 1.91.186.0)');
  });

  test('a numeric one-bump stamp passes (9 -> 10)', () => {
    expect(verdict({ mode: 'stamp-at-merge', base: { version: '1.91.9.0', changelog: changelog('1.91.9.0') }, head: { version: '1.91.10.0', changelog: changelog('1.91.10.0', '1.91.9.0') } })).toStartWith('VERSION_CHECK: ok (stamp-at-merge:');
  });

  test('a MICRO stamp is one bump and passes', () => {
    expect(verdict({ mode: 'stamp-at-merge', base: BASE, head: stamped('1.91.186.1') })).toStartWith('VERSION_CHECK: ok (stamp-at-merge:');
  });

  test('claims offline do not matter under stamp-at-merge', () => {
    expect(verdict({ mode: 'stamp-at-merge', base: BASE, head: stamped('1.91.187.0'), queue: '', queueCode: 1 })).toStartWith('VERSION_CHECK: ok (stamp-at-merge:');
  });

  test('stops when the base already reached the stamp (a sibling landed first)', () => {
    expect(verdict({ mode: 'stamp-at-merge', base: stamped('1.91.187.0'), head: stamped('1.91.187.0') }))
      .toBe('VERSION_CHECK: STOP stamp stale (stamp-at-merge: 1.91.187.0, base 1.91.187.0)');
  });

  test('stops when the base moved under a stamp that is still one bump above it', () => {
    expect(verdict({ mode: 'stamp-at-merge', base: stamped('1.91.186.1'), head: stamped('1.91.187.0') })).toStartWith('VERSION_CHECK: STOP stamp stale');
  });

  test('stops on an unstamped [Unreleased] entry and on a stamp more than one bump up', () => {
    expect(verdict({ mode: 'stamp-at-merge', base: BASE, head: { version: '1.91.187.0', changelog: changelog('Unreleased', '1.91.186.0') } })).toStartWith('VERSION_CHECK: STOP stamp stale');
    expect(verdict({ mode: 'stamp-at-merge', base: BASE, head: stamped('1.91.188.0') })).toStartWith('VERSION_CHECK: STOP stamp stale');
  });
});

describe('claim-at-open: stop only on a real collision', () => {
  test('versions compare numerically, and 3-digit semver works', () => {
    expect(verdict({ mode: 'claim-at-open', base: { version: '1.91.9.0' }, head: { version: '1.91.10.0' } })).toStartWith('VERSION_CHECK: ok (claim-at-open:');
    expect(verdict({ mode: 'claim-at-open', base: { version: '1.91.10.0' }, head: { version: '1.91.9.0' } })).toStartWith('VERSION_CHECK: STOP base is at or above it');
    expect(verdict({ mode: 'claim-at-open', base: { version: '2.14.9' }, head: { version: '2.14.10' } })).toStartWith('VERSION_CHECK: ok (claim-at-open:');
    expect(verdict({ mode: 'claim-at-open', base: { version: '2.14.9' }, head: { version: '2.14.9.1' } })).toStartWith('VERSION_CHECK: unavailable: bad version');
  });

  test('a sibling holding a higher claim no longer stops the PR', () => {
    expect(verdict({ mode: 'claim-at-open', base: BASE, head: stamped('1.91.187.0'), queue: { offline: false, claimed: [claim(8, '1.91.188.0')], complete: true } }))
      .toBe('VERSION_CHECK: ok (claim-at-open: 1.91.187.0, base 1.91.186.0)');
  });

  test('a MICRO bump passes', () => {
    expect(verdict({ mode: 'claim-at-open', base: BASE, head: stamped('1.91.186.1') })).toStartWith('VERSION_CHECK: ok (claim-at-open:');
  });

  test('stops when another open PR holds the same VERSION', () => {
    expect(verdict({ mode: 'claim-at-open', base: BASE, head: stamped('1.91.187.0'), queue: { offline: false, claimed: [claim(8, '1.91.187.0'), claim(9, '1.91.188.0')], complete: true } }))
      .toBe('VERSION_CHECK: STOP also claimed by #8 (claim-at-open: 1.91.187.0, base 1.91.186.0)');
  });

  test('stops when the base is at or above the branch VERSION', () => {
    expect(verdict({ mode: 'claim-at-open', base: stamped('1.91.187.0'), head: stamped('1.91.187.0') })).toStartWith('VERSION_CHECK: STOP base is at or above it');
    expect(verdict({ mode: 'claim-at-open', base: stamped('1.91.188.0'), head: stamped('1.91.187.0') })).toStartWith('VERSION_CHECK: STOP base is at or above it');
  });

  test('a repo with no policy file gets the claim-at-open default', () => {
    expect(verdict({ mode: 'none', base: BASE, head: stamped('1.91.187.0'), queue: { offline: false, claimed: [claim(8, '1.91.187.0')], complete: true } })).toStartWith('VERSION_CHECK: STOP also claimed by #8');
  });

  test('offline claims and unreadable claims are unavailable, but a known collision still stops', () => {
    expect(verdict({ mode: 'claim-at-open', base: BASE, head: stamped('1.91.187.0'), queue: { offline: true } })).toStartWith('VERSION_CHECK: unavailable: claims unread');
    expect(verdict({ mode: 'claim-at-open', base: BASE, head: stamped('1.91.187.0'), queue: { offline: false, claimed: [], unknown_claims: [9], complete: false } })).toStartWith('VERSION_CHECK: unavailable: claims unread');
    expect(verdict({ mode: 'claim-at-open', base: BASE, head: stamped('1.91.187.0'), queue: { offline: false, claimed: [claim(8, '1.91.187.0')], unknown_claims: [9], complete: false } })).toStartWith('VERSION_CHECK: STOP also claimed by #8');
  });
});

describe('either mode', () => {
  test.skipIf(!Bun.which('zsh'))('the block gives the same verdicts under zsh', () => {
    expect(verdict({ shell: 'zsh', mode: 'stamp-at-merge', base: BASE, head: stamped('1.91.187.0'), queue: { offline: false, claimed: [claim(8, '1.91.187.0')], complete: true } })).toStartWith('VERSION_CHECK: ok (stamp-at-merge:');
    expect(verdict({ shell: 'zsh', mode: 'stamp-at-merge', base: stamped('1.91.186.1'), head: stamped('1.91.187.0') })).toStartWith('VERSION_CHECK: STOP stamp stale');
    expect(verdict({ shell: 'zsh', mode: 'claim-at-open', base: BASE, head: stamped('1.91.187.0'), queue: { offline: false, claimed: [claim(8, '1.91.187.0')], complete: true } })).toStartWith('VERSION_CHECK: STOP also claimed by #8');
  });

  test('no configured version source is not applicable', () => {
    expect(verdict({ mode: 'stamp-at-merge', base: {}, head: {}, queue: { no_version: true, version: null } })).toStartWith('VERSION_CHECK: NO_VERSION');
  });

  test('a VERSION missing on one side is unavailable, not green', () => {
    expect(verdict({ mode: 'claim-at-open', base: { changelog: changelog('1.91.186.0') }, head: stamped('1.91.187.0') })).toStartWith('VERSION_CHECK: unavailable: bad version');
  });

  test('an invalid policy is unavailable, but a base at or above the branch still stops', () => {
    expect(verdict({ mode: 'invalid', base: BASE, head: stamped('1.91.187.0'), queue: { offline: false, claimed: [claim(8, '1.91.187.0')], complete: true } })).toStartWith('VERSION_CHECK: unavailable: no policy');
    expect(verdict({ mode: 'invalid', base: stamped('1.91.187.0'), head: stamped('1.91.187.0') })).toStartWith('VERSION_CHECK: STOP base is at or above it');
  });
});
