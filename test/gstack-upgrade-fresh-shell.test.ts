/**
 * Upgrade and /spec command contracts in fresh host renders.
 * The upgrade flow carries the selected exact SHA to the reviewed updater;
 * project-mutating git workflows remain outside that skill. /spec keeps its
 * independent path-safety checks across native host renders.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { runGeneration } from '../scripts/gen-skill-docs';
import { ALL_HOST_CONFIGS } from '../hosts/index';

const IS_WINDOWS = process.platform === 'win32';
let root = '';
let renders = '';

function sh(cwd: string, cmd: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...fixtureEnv(), ...env } });
}
function fixtureEnv(): Record<string, string> {
  return {
    HOME: join(root, 'home'),
    GIT_CONFIG_GLOBAL: join(root, 'home', '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
  };
}
function mustSh(cwd: string, cmd: string) {
  const r = sh(cwd, cmd);
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

/** A directory that looks like a gstack checkout (VERSION, setup, bin/gstack-config). */
function makeGstackLike(dir: string, git: boolean) {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'VERSION'), '1.0.0.0\n');
  writeFileSync(join(dir, 'setup'), '#!/bin/sh\necho SETUP_RAN "$@"\n', { mode: 0o755 });
  writeFileSync(join(dir, 'bin', 'gstack-config'), '#!/bin/sh\necho false\n', { mode: 0o755 });
  if (git) mustSh(dir, 'git init -q -b main && git add -A && git commit -q -m init');
}

function bashFences(text: string): string[] {
  return [...text.matchAll(/^(```|~~~)bash\n([\s\S]*?)\n\1$/gm)].map(m => m[2]);
}

function fence(fences: string[], marker: string): string {
  const hits = fences.filter(f => f.includes(marker));
  if (hits.length !== 1) throw new Error(`expected one fence containing ${marker}, found ${hits.length}`);
  return hits[0];
}

const execFileAsync = promisify(execFile);
async function bashAsync(cwd: string, script: string, env: Record<string, string>) {
  try {
    const r = await execFileAsync('bash', ['-c', script], { cwd, timeout: 20_000, env: { ...process.env, ...fixtureEnv(), ...env } });
    return { status: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string };
    return { status: typeof e.code === 'number' ? e.code : -1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(error) };
  }
}

/** Tree snapshot of the scratch project: file bytes + git HEAD, index, status and stash. */
async function snapshot(dir: string): Promise<string> {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === '.git') continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(`${p}\0`).update(readFileSync(p));
    }
  };
  walk(dir);
  const state = await bashAsync(dir, 'git rev-parse HEAD; git status --porcelain=v1 -uall; git stash list; git ls-files -s; git worktree list --porcelain', {});
  h.update(state.stdout);
  return h.digest('hex');
}

interface HostRender { host: string; upgrade: string[]; upgradeText: string; spec: string[]; localDir: string }
const hostRenders: HostRender[] = [];

beforeAll(async () => {
  if (IS_WINDOWS) return;
  root = mkdtempSync(join(tmpdir(), 'gstack-c9-'));
  mkdirSync(join(root, 'home'), { recursive: true });
  writeFileSync(join(root, 'home', '.gitconfig'), '[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
  renders = join(root, 'render');
  const result = await runGeneration({ host: 'all', outputRoot: renders });
  if (result.exitCode !== 0) throw new Error(result.diagnostics.map(d => d.message).join('\n'));
  for (const config of ALL_HOST_CONFIGS) {
    const base = config.name === 'claude' ? renders : join(renders, config.hostSubdir, 'skills');
    const upgradePath = config.name === 'claude' ? join(base, 'gstack-upgrade', 'SKILL.md') : join(base, 'gstack-upgrade', 'SKILL.md');
    const specPath = config.name === 'claude' ? join(base, 'spec', 'sections', 'gate-and-file.md') : join(base, 'gstack-spec', 'SKILL.md');
    const upgradeText = readFileSync(upgradePath, 'utf8');
    const upgrade = bashFences(upgradeText);
    const specBody = config.name === 'codex' ? readFileSync(join(base, 'gstack-spec', 'sections', 'gate-and-file.md'), 'utf8') : readFileSync(specPath, 'utf8');
    const spec = bashFences(specBody);
    hostRenders.push({ host: config.name, upgrade, upgradeText, spec, localDir: config.localSkillRoot });
  }
});

afterAll(() => {
  if (!root) return;
  spawnSync('chmod', ['-R', 'u+rwx', root], { timeout: 20_000 });
  rmSync(root, { recursive: true, force: true });
});

/** Per-host world: a user project with a vendored copy and a dirty tracked file. */
function world(host: HostRender) {
  const w = mkdtempSync(join(root, `${host.host}-`));
  const project = join(w, 'project');
  const stub = join(w, 'stub');
  mkdirSync(join(project, 'app'), { recursive: true });
  mkdirSync(stub);
  makeGstackLike(join(project, host.localDir), false);
  writeFileSync(join(project, 'app', 'SKILL.md'), 'committed\n');
  mustSh(project, 'git init -q -b main && git add -A && git commit -q -m init');
  writeFileSync(join(project, 'app', 'SKILL.md'), 'user edit in progress\n');
  writeFileSync(join(project, 'notes.txt'), 'untracked user work\n');
  const gitLog = join(w, 'git.log');
  const realGit = mustSh(w, 'command -v git').trim();
  // Logs every call; clone never reaches the network (the vendored fence would fetch GitHub).
  writeFileSync(join(stub, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${gitLog}"\n[ "$1" = clone ] && exit 128\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(stub, 'claude'), `#!/bin/sh\ncat > /dev/null\necho spawned >> "${join(w, 'claude.log')}"\n`, { mode: 0o755 });
  const gstack = join(w, 'gstack');
  makeGstackLike(gstack, true);
  mustSh(w, `git clone -q --bare gstack origin.git && cd gstack && git remote add origin "${join(w, 'origin.git')}"`);
  const plainRepo = join(w, 'plain');
  mkdirSync(join(plainRepo, 'bin'), { recursive: true });
  writeFileSync(join(plainRepo, 'VERSION'), '0.1.0\n');
  writeFileSync(join(plainRepo, 'setup'), '#!/bin/sh\n');
  mustSh(plainRepo, 'git init -q -b main && git add -A && git commit -q -m init');
  return { w, project, stub, gitLog, gstack, plainRepo };
}

async function run(wd: ReturnType<typeof world>, script: string, vars: Record<string, string | undefined>) {
  writeFileSync(wd.gitLog, '');
  const env: Record<string, string> = { PATH: `${wd.stub}:${process.env.PATH}`, GSTACK_ROOT: wd.gstack, GSTACK_BIN: join(wd.gstack, 'bin') };
  const unset: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) unset.push(k); else env[k] = v;
  }
  const r = await bashAsync(wd.project, `unset ${unset.join(' ') || '_NONE_'}\n${script}`, env);
  const gitCalls = readFileSync(wd.gitLog, 'utf8').split('\n').filter(Boolean);
  return { ...r, gitCalls };
}

const BAD_VALUES = ['unset', 'empty', 'nonexistent', 'unreadable', 'wrong-repo', 'subdirectory'] as const;
function badValue(wd: ReturnType<typeof world>, kind: typeof BAD_VALUES[number]): string | undefined {
  switch (kind) {
    case 'unset': return undefined;
    case 'empty': return '';
    case 'nonexistent': return join(wd.w, 'missing');
    case 'unreadable': {
      const locked = join(wd.w, 'locked');
      if (!existsSync(locked)) { mkdirSync(locked); chmodSync(locked, 0o000); }
      return locked;
    }
    case 'wrong-repo': return wd.plainRepo;
    case 'subdirectory': return join(wd.gstack, 'bin');
  }
}

describe.skipIf(IS_WINDOWS)('gstack-upgrade rendered command contract', () => {
  test('every host routes the exact selected SHA through the transactional updater', () => {
    expect(hostRenders.length).toBe(ALL_HOST_CONFIGS.length);
    for (const host of hostRenders) {
      expect(host.upgradeText).toContain('UPGRADE_AVAILABLE <old> <new> <sha>');
      expect(host.upgradeText).toContain('--apply-candidate "<sha from UPGRADE_AVAILABLE>"');
      expect(host.upgradeText).toContain('required latest Actions attempts');
      for (const command of host.upgrade) {
        expect(command).not.toMatch(/\bgit\s+(pull|reset|stash|fetch|clone|checkout|merge)\b/);
      }
    }
  });
});

describe.skipIf(IS_WINDOWS)('/spec fences refuse bad paths on every host', () => {
  type Kind = typeof BAD_VALUES[number];
  const UNUSABLE: Kind[] = ['unset', 'empty', 'nonexistent', 'unreadable'];
  const cases: Array<{ name: string; marker: string; target: string; kinds?: Kind[]; others: (wd: ReturnType<typeof world>) => Record<string, string> }> = [
    { name: 'spec worktree add', marker: 'git worktree add', target: 'SPAWN_PATH', kinds: ['unset', 'empty'], others: () => ({ SPAWN_BRANCH: 'spec/x-1', PIN_SHA: 'HEAD' }) },
    { name: 'spec spawn', marker: 'claude -p', target: 'SPAWN_PATH', kinds: [...UNUSABLE, 'subdirectory'], others: (wd) => ({ SPAWN_BRANCH: 'spec/x-1', ARCHIVE_PATH: join(wd.gstack, 'VERSION') }) },
  ];

  async function refusals(host: HostRender): Promise<string[]> {
    const wd = world(host);
    const failures: string[] = [];
    const baseline = await snapshot(wd.project);
    for (const c of cases) {
      const marker = host.host === 'codex' && c.name === 'spec spawn' ? 'Native dispatch preflight ready' : c.marker;
      const script = fence(host.spec, marker);
      for (const kind of c.kinds ?? BAD_VALUES) {
        const r = await run(wd, script, { ...c.others(wd), [c.target]: badValue(wd, kind) });
        const mutating = r.gitCalls.filter(call => !/^rev-parse\b/.test(call));
        const changed = (await snapshot(wd.project)) !== baseline;
        const spawned = existsSync(join(wd.w, 'claude.log'));
        if (r.status === 0 || mutating.length > 0 || changed || spawned) {
          failures.push(`${host.host}: ${c.name} with ${c.target} ${kind}: exit=${r.status} git=[${mutating.join(' | ')}] changed=${changed} spawned=${spawned}\n${r.stderr.slice(0, 400)}`);
        }
      }
    }
    return failures;
  }

  test('every host: guarded spec fences leave the user project unchanged', async () => {
    expect((await Promise.all(hostRenders.map(refusals))).flat()).toEqual([]);
  }, 120_000);

  test('every host: positive spec controls still run', async () => {
    const problems: string[] = [];
    for (const host of hostRenders) {
      const wd = world(host);
      mustSh(wd.project, `git worktree add -q "${join(wd.w, 'wt')}" -b spec/x-1 HEAD`);
      const marker = host.host === 'codex' ? 'Native dispatch preflight ready' : 'claude -p';
      const spawn = await run(wd, fence(host.spec, marker), { SPAWN_PATH: join(wd.w, 'wt'), SPAWN_BRANCH: 'spec/x-1', ARCHIVE_PATH: join(wd.gstack, 'VERSION') });
      if (host.host === 'codex') {
        if (spawn.status !== 0 || !spawn.stdout.includes('Native dispatch preflight ready') || existsSync(join(wd.w, 'claude.log'))) problems.push(`${host.host}: native preflight failed: ${spawn.stderr}`);
      } else {
        const deadline = Date.now() + 5_000;
        while (!existsSync(join(wd.w, 'claude.log')) && Date.now() < deadline) await Bun.sleep(50);
        if (spawn.status !== 0 || !existsSync(join(wd.w, 'claude.log'))) problems.push(`${host.host}: spec spawn did not start claude: ${spawn.stderr}`);
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);
});

describe.skipIf(IS_WINDOWS)('gstack-upgrade resolves its registered source', () => {
  test('uses the source row for the current host and refuses a missing registration', async () => {
    for (const host of hostRenders) {
      const w = mkdtempSync(join(root, `source-${host.host}-`));
      const state = join(w, 'state');
      const source = join(w, 'source');
      const runtime = join(w, 'runtime');
      const home = join(w, 'home');
      mkdirSync(state, { recursive: true });
      mkdirSync(join(runtime, 'bin'), { recursive: true });
      mkdirSync(join(runtime, 'lib'), { recursive: true });
      mkdirSync(home, { recursive: true });
      makeGstackLike(source, true);
      mustSh(source, 'git remote add origin https://github.com/TheAngryPit/gstack.git');
      writeFileSync(join(source, 'bin', 'gstack-session-update'), '#!/bin/sh\n', { mode: 0o755 });
      writeFileSync(join(runtime, 'bin', 'gstack-paths'), `#!/bin/sh\necho "${state}"\n`, { mode: 0o755 });
      const destination = join(home, 'skills');
      const row = [host.host, 'global', '-', destination, join(destination, 'gstack'), source, '1.0.0', 'false', 'committed', 'now', 'gpt-5.6-sol', 'a'.repeat(40)].join('\t');
      const other = [host.host === 'codex' ? 'claude' : 'codex', 'global', '-', '/other', '/other/gstack', '/wrong/source', '1.0.0', 'false', 'committed', 'now', '-', '-'].join('\t');
      const registry = join(state, 'installs.tsv');
      writeFileSync(registry, `${other}\n${row}\n`);
      const sourceLookup = fence(host.upgrade, 'GSTACK_STATE_ROOT=$(');
      const runLookup = () => bashAsync(w, sourceLookup, { HOME: home, GSTACK_ROOT: runtime });
      const found = await runLookup();
      if (host.host === 'codex') {
        expect(found.status, found.stderr).toBe(0);
        expect(found.stdout).toContain(`SOURCE_DIR=${source}`);
      } else {
        expect(found.status).not.toBe(0);
        expect(found.stderr + found.stdout).toContain('DEFERRED: trusted-fork auto-activation is limited to registered Codex runtimes');
        expect(found.stderr + found.stdout).toContain('Use the host\'s normal manual setup workflow.');
      }
      rmSync(registry);
      const missing = await runLookup();
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain('trusted registered GStack source was not found');

      writeFileSync(registry, `${row}\n`);
      mustSh(source, 'git remote set-url origin https://github.com/TheAngryPit/gstack.git/');
      const trailingSlash = await runLookup();
      if (host.host === 'codex') {
        expect(trailingSlash.status, trailingSlash.stderr).toBe(0);
        expect(trailingSlash.stdout).toContain('UPDATE_LANE=trusted-fork');
        expect(trailingSlash.stderr + trailingSlash.stdout).not.toContain('DEFERRED: trusted-fork auto-activation');
      } else {
        expect(trailingSlash.status).not.toBe(0);
        expect(trailingSlash.stderr + trailingSlash.stdout).toContain('DEFERRED: trusted-fork auto-activation is limited to registered Codex runtimes');
      }
      mustSh(source, 'git remote set-url origin https://github.com/garrytan/gstack.git');
      const manual = await runLookup();
      expect(manual.status, manual.stderr).toBe(0);
      expect(manual.stdout).toContain('UPDATE_LANE=manual-origin');
      expect(manual.stderr + manual.stdout).not.toContain('DEFERRED: trusted-fork auto-activation');
      expect(host.upgradeText).toContain('MANUAL_UPGRADE_AVAILABLE <old> <new> <target> <repo>');
      expect(host.upgradeText).toContain('Other origins stay manual');
    }
  }, 60_000);
});
