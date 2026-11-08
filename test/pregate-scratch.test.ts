/**
 * Lane D (GSTA-112, E6b): every run gets its own scratch directory under the
 * state root (`<state root>/projects/<slug>/pregate/runs/<run id>/`) for the
 * secrets scan files, lane and guard logs and the remote gate's files, instead
 * of os.tmpdir(): two pregates in parallel never share a path, the logs a
 * `fix:` line names survive a Capy wake that wipes /tmp (gbrain 16), and the
 * record names the directory. Old runs are pruned best-effort.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { pruneScratch, scratchRunId } from '../lib/pregate/run-scratch';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const SLUG = 'scratchslug';
const pregate = (repo: FixtureRepo, args: string[]) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', ...args], { GSTACK_PROJECT_SLUG: SLUG });
const readOut = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8'));
const runsDir = (repo: FixtureRepo) => path.join(repo.home, 'projects', SLUG, 'pregate', 'runs');

describe('per-run scratch under the state root', () => {
  // Value: protects=lane and guard logs and the record's scratch path sit under the state root's per-run directory, named by
  //   --run, and two runs never share one; fails_when=logs land under os.tmpdir() (the behaviour before this change) or two runs
  //   collide; why_new=the scratch layout is new; seam=none; no_claim=none
  test('logs and the record name the run directory; two --run ids get two directories', () => {
    const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, guards: [{ id: 'echo', when: ['lib/**'], command: 'node -e "console.log(1)"' }] } });
    repos.push(repo);
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => b + a;\n' });
    const a = pregate(repo, ['--run', 'run-a', '--only', 'lanes,guards']);
    expect(a.status).toBe(EXIT.ok);
    const dirA = path.join(runsDir(repo), 'run-a');
    expect(readOut(repo).scratch).toBe(dirA);
    expect(a.out).toContain(`scratch: ${dirA}`);
    const logLines = a.out.split('\n').filter(l => /\blog \S+|\(log \S+\)/.test(l));
    expect(logLines.length).toBeGreaterThan(0);
    for (const l of logLines) { expect(l).toContain(dirA); expect(l).not.toMatch(/gstack-pregate-(?:lanes|guards|secrets|remote)-/); }
    expect(fs.existsSync(path.join(dirA, 'lanes', 'lanes.log'))).toBe(true);
    expect(fs.existsSync(path.join(dirA, 'guards', 'echo.log'))).toBe(true);
    expect((fs.statSync(dirA).mode & 0o777)).toBe(0o700);
    pregate(repo, ['--run', 'run-b', '--only', 'lanes']);
    expect(readOut(repo).scratch).toBe(path.join(runsDir(repo), 'run-b'));
    expect(fs.existsSync(path.join(dirA, 'lanes', 'lanes.log'))).toBe(true);
    // A taken --run id is never shared (a second run would truncate the first's logs): it takes a numbered sibling and the record names it.
    const again = pregate(repo, ['--run', 'run-a', '--only', 'lanes']);
    expect(readOut(repo).scratch).toBe(`${dirA}-2`);
    expect(again.out).toContain(`scratch: ${dirA}-2`);
    expect(fs.existsSync(path.join(dirA, 'guards', 'echo.log'))).toBe(true);
  });

  // Value: protects=without --run the id is unique per process and the secrets scan files are gone after the scan; fails_when=two
  //   runs in one second share an id, or added-line copies linger under the state root; why_new=new; seam=none; no_claim=none
  test('an unnamed run gets a unique id, and the secrets scan leaves no added-line copies behind', () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => b + a;\n' });
    pregate(repo, ['--only', 'secrets']);
    pregate(repo, ['--only', 'secrets']);
    const runs = fs.readdirSync(runsDir(repo));
    expect(runs.length).toBe(2);
    for (const run of runs) expect(fs.existsSync(path.join(runsDir(repo), run, 'secrets'))).toBe(false);
    expect(scratchRunId('weird id/with:chars')).toBe('weird-id-with-chars');
    expect(scratchRunId(undefined, 123)).toMatch(/^\d{8}T\d{6}Z-123-[0-9a-f]{4}$/);
    expect(scratchRunId('...', 123)).toMatch(/^\d{8}T\d{6}Z-123-[0-9a-f]{4}$/);
    expect(scratchRunId('a'.repeat(200))).toHaveLength(96);
  });

  // Value: protects=pruning removes only run directories older than the retention and never the current one; fails_when=a fresh
  //   run or the current run is deleted, or an old one is kept; why_new=new; seam=none; no_claim=none
  test('prune drops runs older than 7 days and keeps fresh ones and the current run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pregate-prune-'));
    try {
      const old = path.join(root, 'old'); const fresh = path.join(root, 'fresh'); const current = path.join(root, 'current');
      for (const d of [old, fresh, current]) fs.mkdirSync(d);
      const eightDays = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
      fs.utimesSync(old, eightDays, eightDays);
      fs.utimesSync(current, eightDays, eightDays);
      pruneScratch(root, 'current');
      expect(fs.readdirSync(root).sort()).toEqual(['current', 'fresh']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('an unwritable state root', () => {
  // Value: protects=a state root whose projects dir cannot be created still runs pregate, in a private per-run directory under
  //   os.tmpdir(), and says so under --explain; fails_when=the mkdir error escapes buildContext or the note is dropped; why_new=the
  //   fallback is new; seam=none; no_claim=none
  test('falls back to a per-run tmpdir and says so', () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    fs.writeFileSync(path.join(repo.home, 'projects'), 'not a directory');
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => b + a;\n' });
    const r = pregate(repo, ['--only', 'secrets', '--explain']);
    expect(r.status).toBe(EXIT.ok);
    expect(readOut(repo).scratch.startsWith(os.tmpdir())).toBe(true);
    expect(r.out + r.err).toContain('scratch: state root not writable');
  });
});
