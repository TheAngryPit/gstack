import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const SEARCH = path.join(ROOT, 'bin', 'gstack-learnings-search');
const LOG = path.join(ROOT, 'bin', 'gstack-learnings-log');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-learnings-cli-'));
const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-learnings-cli-cwd-'));
const slug = path.basename(tmpCwd).replace(/[^a-zA-Z0-9._-]/g, '');
const projDir = path.join(tmpHome, 'projects', slug);

function run(bin: string, args: string[]) {
  return spawnSync(bin, args, {
    timeout: 30_000,
    env: { ...process.env, GSTACK_HOME: tmpHome },
    cwd: tmpCwd,
    encoding: 'utf-8',
  });
}

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe('learnings bins explain themselves', () => {
  test('--help prints usage for both bins and writes no state', () => {
    for (const bin of [SEARCH, LOG]) {
      const r = run(bin, ['--help']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Usage: ' + path.basename(bin));
    }
    expect(fs.existsSync(path.join(tmpHome, 'projects'))).toBe(false);
  });

  test('an unknown flag exits 2, names the valid flags, and writes no state', () => {
    const search = run(SEARCH, ['--qeury', 'x']);
    expect(search.status).toBe(2);
    expect(search.stderr).toContain("unknown argument '--qeury'");
    expect(search.stderr).toContain('--query');
    const log = run(LOG, ['--remove']);
    expect(log.status).toBe(2);
    expect(log.stderr).toContain("unknown argument '--remove'");
    expect(run(LOG, []).status).toBe(2);
    expect(fs.existsSync(path.join(tmpHome, 'projects'))).toBe(false);
  });

  test('a missing value or a bad --limit exits 2 like an unknown flag, and writes no state', () => {
    for (const args of [['--limit'], ['--type'], ['--query'], ['--limit', 'abc'], ['--limit', '0'], ['--limit', '-1']]) {
      const r = run(SEARCH, args);
      expect(r.status).toBe(2);
      expect(r.stderr).toStartWith('gstack-learnings-search: ');
    }
    expect(fs.existsSync(path.join(tmpHome, 'projects'))).toBe(false);
  });

  test('an empty --query value is still accepted', () => {
    expect(run(SEARCH, ['--query', '', '--limit', '5']).status).toBe(0);
  });
});

describe('gstack-learnings-search --cross-project', () => {
  test('finds other projects when the state root sits under a directory named like the slug', () => {
    const nestedHome = path.join(tmpCwd, '.gstack-home');
    fs.mkdirSync(path.join(nestedHome, 'projects', slug), { recursive: true });
    fs.mkdirSync(path.join(nestedHome, 'projects', 'other-service'), { recursive: true });
    fs.writeFileSync(path.join(nestedHome, 'projects', 'other-service', 'learnings.jsonl'),
      JSON.stringify({ ts: '2026-10-10T00:00:00Z', type: 'pattern', key: 'docker-layer-cache', insight: 'Copy the lockfile first.', confidence: 9, source: 'user-stated', trusted: true }) + '\n');
    const r = spawnSync(SEARCH, ['--cross-project', '--query', 'docker'], {
      timeout: 30_000, cwd: tmpCwd, encoding: 'utf-8',
      env: { ...process.env, GSTACK_HOME: nestedHome, GSTACK_STATE_ROOT: nestedHome },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('docker-layer-cache');
    fs.rmSync(nestedHome, { recursive: true, force: true });
  });
});

describe('gstack-learnings-search --stats', () => {
  test('prints NO_LEARNINGS when nothing is recorded', () => {
    const r = run(SEARCH, ['--stats']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('NO_LEARNINGS');
  });

  test('counts raw rows and the latest entry per key+type', () => {
    fs.mkdirSync(projDir, { recursive: true });
    const rows = [
      { ts: '2026-05-01T00:00:00Z', type: 'pitfall', key: 'k1', insight: 'old', confidence: 4, source: 'observed' },
      { ts: '2026-05-02T00:00:00Z', type: 'pitfall', key: 'k1', insight: 'new', confidence: 8, source: 'observed' },
      { ts: '2026-05-03T00:00:00Z', type: 'pattern', key: 'k2', insight: 'two', confidence: 5, source: 'user-stated' },
    ];
    fs.writeFileSync(path.join(projDir, 'learnings.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\nnot json\n');
    const r = run(SEARCH, ['--stats']);
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n').filter(Boolean)).toEqual([
      'TOTAL: 4 entries',
      'UNIQUE: 2 (after dedup)',
      'RAW_ENTRIES: 4',
      'BY_TYPE: {"pitfall":1,"pattern":1}',
      'BY_SOURCE: {"observed":1,"user-stated":1}',
      'AVG_CONFIDENCE: 6.5',
    ]);
  });
});
