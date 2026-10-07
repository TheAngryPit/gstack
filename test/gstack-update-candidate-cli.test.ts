import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dir, '..');
const CANONICAL = 'https://github.com/TheAngryPit/gstack.git';
const bases: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
}

type ApiState = {
  sha: string;
  version: string;
  event: string;
  branch: string;
  repository: string;
  headRepository: string;
  workflowPath: string;
  workflowRunStatus: string;
  workflowConclusion: string;
  attempt: number;
  jobStatus: Record<string, string>;
  jobConclusion: Record<string, string>;
  missingJobs?: string[];
  currentRun?: Record<string, unknown> | null;
  missingRun?: boolean;
  failOnRunList?: number;
  runListCount?: Record<string, number>;
};

const workflowIds: Record<string, string> = {
  'free-tests.yml': '101',
  'windows-free-tests.yml': '102',
  'codex-native-parity.yml': '103',
};
const jobNames: Record<string, string> = {
  'free-tests.yml': 'free-tests',
  'windows-free-tests.yml': 'windows-free-tests',
  'codex-native-parity.yml': 'parity',
};

async function githubFixture(state: ApiState) {
  const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const workflow = Object.keys(workflowIds).find(name => pathname.endsWith(`/actions/workflows/${name}`));
      if (workflow) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: Number(workflowIds[workflow]), path: `.github/workflows/${workflow}` }));
        return;
      }
      const workflowRuns = Object.entries(workflowIds).find(([, id]) => pathname.endsWith(`/actions/workflows/${id}/runs`));
      if (workflowRuns) {
        const [name, id] = workflowRuns;
        state.runListCount ??= {};
        state.runListCount[name] = (state.runListCount[name] ?? 0) + 1;
        if (state.runListCount[name] === state.failOnRunList) {
          state.attempt += 1;
          state.workflowConclusion = 'failure';
        }
        const workflowRun = {
          id: Number(id) * 100,
          workflow_id: Number(id),
          run_attempt: state.attempt,
          status: state.workflowRunStatus,
          conclusion: state.workflowConclusion,
          event: state.event,
          head_sha: state.sha,
          head_branch: state.branch,
          path: state.workflowPath || `.github/workflows/${name}`,
          repository: { full_name: state.repository },
          head_repository: { full_name: state.headRepository },
          created_at: '2026-10-06T12:00:00Z',
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ workflow_runs: [workflowRun] }));
        return;
      }
      const run = Object.entries(workflowIds).find(([, id]) => pathname.endsWith(`/actions/runs/${Number(id) * 100}`));
      if (run) {
        const [name, id] = run;
        if (state.missingRun) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end('{}');
          return;
        }
        const record = {
          id: Number(id) * 100,
          workflow_id: Number(id),
          run_attempt: state.attempt,
          status: state.workflowRunStatus,
          conclusion: state.workflowConclusion,
          event: state.event,
          head_sha: state.sha,
          head_branch: state.branch,
          path: state.workflowPath || `.github/workflows/${name}`,
          repository: { full_name: state.repository },
          head_repository: { full_name: state.headRepository },
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ...record, ...(state.currentRun ?? {}) }));
        return;
      }
      const jobs = Object.entries(workflowIds).find(([, id]) => pathname.includes(`/actions/runs/${Number(id) * 100}/attempts/`));
      if (jobs) {
        const [name] = jobs;
        const job = jobNames[name];
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jobs: [
          ...(state.missingJobs?.includes(job) ? [] : [{ name: job, status: state.jobStatus[job] ?? 'completed', conclusion: state.jobConclusion[job] ?? 'success' }]),
          { name: 'optional-duration-recording', status: 'completed', conclusion: 'skipped' },
        ] }));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture HTTP server did not bind to a TCP port');
  return { url: `http://127.0.0.1:${address.port}`, stop: () => server.close() };
}

function copyTrackedSource(destination: string, full: boolean) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, timeout: 30_000 }).toString().split('\0').filter(Boolean);
  const selected = full ? tracked : tracked.filter(file => file.startsWith('bin/') || file.startsWith('lib/') || file === 'VERSION');
  for (const relative of [...new Set([...selected, 'bin/gstack-update-candidate', 'bin/gstack-session-update-legacy'])]) {
    const source = path.join(ROOT, relative);
    if (!fs.existsSync(source)) continue;
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
    else {
      fs.copyFileSync(source, target);
      fs.chmodSync(target, stat.mode & 0o777);
    }
  }
}

function makeFixture(source: 'runtime' | 'full' = 'runtime') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-update-cli-'));
  bases.push(base);
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const install = path.join(base, 'install');
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  const stateDir = path.join(home, '.gstack');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000 });
  fs.mkdirSync(seed, { recursive: true });
  let version = '1.0.0';
  copyTrackedSource(seed, source === 'full');
  version = fs.readFileSync(path.join(seed, 'VERSION'), 'utf8').trim();
  fs.writeFileSync(path.join(seed, 'VERSION'), `${version}\n`);
  fs.writeFileSync(path.join(seed, 'payload.txt'), 'accepted fork source v1\n');
  if (source === 'full') {
    for (const relative of ['browse/dist/browse', 'design/dist/design', 'make-pdf/dist/pdf']) {
      const binary = path.join(seed, relative);
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
  }
  git(seed, 'init', '-q');
  git(seed, 'config', 'user.name', 'GStack fixture');
  git(seed, 'config', 'user.email', 'gstack-fixture@example.invalid');
  git(seed, 'add', '-A');
  if (source === 'full') git(seed, 'add', '-f', 'bin/gstack-global-discover.ts', 'browse/dist/browse', 'design/dist/design', 'make-pdf/dist/pdf');
  git(seed, 'commit', '-q', '-m', 'fixture v1');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, install], { timeout: 30_000 });
  git(install, 'remote', 'set-url', 'origin', CANONICAL);
  git(install, 'config', `url.file://${origin}.insteadOf`, CANONICAL);
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(install, 'node_modules'), 'dir');
    fs.appendFileSync(path.join(install, '.git', 'info', 'exclude'), '\n/node_modules\n');
  }
  if (source === 'full') {
    const sourceSha = git(install, 'rev-parse', 'HEAD');
    for (const relative of ['browse/dist/.version', 'design/dist/.version', 'make-pdf/dist/.version']) {
      fs.writeFileSync(path.join(install, relative), `${sourceSha}\n`);
    }
  }
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    'set -eu',
    '[ "${1:-}" = api ] || exit 2',
    'shift',
    'filter=.',
    'endpoint=',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in --paginate) shift ;; --jq) filter=$2; shift 2 ;; -H|--method|-f|-F|-q) shift 2 ;; --silent|--include|--slurp) shift ;; *) endpoint=$1; shift ;; esac',
    'done',
    '[ -n "$endpoint" ] || exit 2',
    '[ -z "${GSTACK_TEST_GH_DELAY:-}" ] || sleep "$GSTACK_TEST_GH_DELAY"',
    'curl --noproxy "*" -fsS "$GSTACK_TEST_GH_API/$endpoint" | jq -r "$filter"',
  ].join('\n') + '\n', { mode: 0o755 });
  return { base, origin, seed, install, home, stateDir, bin, version, source };
}

type Fixture = ReturnType<typeof makeFixture> & {
  failDiscoveryLinkAt?: { skillsDir: string; log: string; counter: string; after: number; concurrentScript?: string };
};

function publish(fx: Fixture, content = 'accepted fork source v2\n', version = fx.version): string {
  fs.writeFileSync(path.join(fx.seed, 'VERSION'), `${version}\n`);
  fs.writeFileSync(path.join(fx.seed, 'payload.txt'), content);
  git(fx.seed, 'add', '-A');
  git(fx.seed, 'commit', '-q', '-m', 'fixture v2');
  git(fx.seed, 'push', '-q', 'origin', 'main');
  return git(fx.seed, 'rev-parse', 'HEAD');
}

function registerCodex(fx: Fixture) {
  const source = fs.realpathSync(fx.install);
  const destination = path.join(fx.home, '.agents', 'skills');
  const root = path.join(destination, 'gstack');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime-user-data.txt'), 'keep this runtime data\n');
  fs.writeFileSync(path.join(root, 'SKILL.md'), '<!-- AUTO-GENERATED from fixture -->\nold installed Codex router\n');
  fs.writeFileSync(path.join(root, '.gstack-owned'), source);
  for (const relative of ['bin/gstack-config', 'bin/gstack-state-root.sh']) {
    const contents = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    const output = path.join(root, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, contents, { mode: relative.endsWith('.sh') ? 0o644 : 0o755 });
  }
  const sourceSha = git(fx.install, 'rev-parse', 'HEAD');
  for (const relative of ['browse/dist/browse', 'design/dist/design', 'make-pdf/dist/pdf']) {
    const binary = path.join(fx.install, relative);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    if (!fs.existsSync(binary)) fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(path.dirname(binary), '.version'), `${sourceSha}\n`);
  }
  fs.mkdirSync(fx.stateDir, { recursive: true });
  const row = [
    'codex', 'global', '-', destination, root, source, fx.version, 'true', 'committed',
    '2026-10-06T12:00:00Z', 'gpt-5.6-sol', git(fx.install, 'rev-parse', 'HEAD'),
  ].join('\t');
  fs.writeFileSync(path.join(fx.stateDir, 'installs.tsv'), `${row}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(fx.stateDir, 'config.yaml'), 'auto_upgrade: false\nupdate_check: true\n');
  return { destination, root, row };
}

function initialApiState(sha: string, version = '1.0.0'): ApiState {
  return {
    sha,
    version,
    event: 'push',
    branch: 'main',
    repository: 'TheAngryPit/gstack',
    headRepository: 'TheAngryPit/gstack',
    workflowPath: '',
    workflowRunStatus: 'completed',
    workflowConclusion: 'success',
    attempt: 1,
    jobStatus: {},
    jobConclusion: {},
    runListCount: {},
  };
}

function run(
  fx: Fixture,
  serverUrl: string,
  script: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 30_000,
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }>((resolve) => {
    const child = spawn(script, args, {
      env: {
      ...process.env,
      PATH: `${fx.bin}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: fx.home,
      CODEX_HOME: path.join(fx.home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(fx.home, '.claude'),
      XDG_CONFIG_HOME: path.join(fx.home, '.config'),
      GSTACK_DIR: fx.install,
      GSTACK_STATE_ROOT: fx.stateDir,
      ...(fx.source === 'full' ? {
        PLAYWRIGHT_BROWSERS_PATH: path.join(fx.base, 'isolated-playwright-cache'),
        GSTACK_TEST_BUNX_LOG: path.join(fx.base, 'bunx.log'),
      } : {}),
        GSTACK_TEST_GH_API: serverUrl,
        TMPDIR: fx.base,
        ...extraEnv,
      ...(fx.failDiscoveryLinkAt ? {
        GSTACK_TEST_SKILLS_DIR: fx.failDiscoveryLinkAt.skillsDir,
        GSTACK_TEST_LINK_LOG: fx.failDiscoveryLinkAt.log,
        GSTACK_TEST_LINK_COUNTER: fx.failDiscoveryLinkAt.counter,
        GSTACK_TEST_FAIL_DISCOVERY_AFTER: String(fx.failDiscoveryLinkAt.after),
        ...(fx.failDiscoveryLinkAt.concurrentScript ? {
          GSTACK_TEST_CONCURRENT_REGISTRATION_SCRIPT: fx.failDiscoveryLinkAt.concurrentScript,
          GSTACK_TEST_CONCURRENT_DEST: path.join(fx.home, 'other-agent', '.agents', 'skills'),
          GSTACK_TEST_CONCURRENT_SOURCE: path.join(fx.base, 'other-source', 'gstack'),
          GSTACK_TEST_CONCURRENT_COMMIT: git(fx.install, 'rev-parse', 'HEAD'),
        } : {}),
      } : {}),
      },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); resolve({ status: null, stdout, stderr, error }); });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status: timedOut ? null : status, stdout, stderr, ...(timedOut ? { error: new Error(`CLI timed out after ${timeoutMs}ms`) } : {}) });
    });
  });
}
const resolver = (fx: Fixture) => path.join(fx.install, 'bin/gstack-update-candidate');
const updater = (fx: Fixture) => path.join(fx.install, 'bin/gstack-session-update');

function treeSnapshot(root: string): string {
  const entries: string[] = [];
  const visit = (directory: string, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const relative = path.posix.join(prefix, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) entries.push(`${relative}\tlink\t${fs.readlinkSync(full)}`);
      else if (stat.isDirectory()) { entries.push(`${relative}\tdir`); visit(full, relative); }
      else entries.push(`${relative}\tfile\t${stat.mode & 0o777}\t${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  };
  visit(root);
  return entries.join('\n');
}

function installDiscoveryLinkFailure(fx: Fixture, skillsDir: string, after: number, concurrentScript?: string) {
  const log = path.join(fx.base, 'linked-skills.log');
  const counter = path.join(fx.base, 'linked-skills.count');
  fs.writeFileSync(path.join(fx.bin, 'ln'), [
    '#!/bin/sh',
    'set -eu',
    'for target do :; done',
    'case "$target" in',
    '  "$GSTACK_TEST_SKILLS_DIR"/gstack-*)',
    '    count=0; [ ! -f "$GSTACK_TEST_LINK_COUNTER" ] || count=$(cat "$GSTACK_TEST_LINK_COUNTER")',
    '    count=$((count + 1))',
    '    printf "%s\\n" "$count" > "$GSTACK_TEST_LINK_COUNTER"',
    '    printf "%s\\n" "$target" >> "$GSTACK_TEST_LINK_LOG"',
    '    if [ "$count" -eq 1 ] && [ -n "${GSTACK_TEST_CONCURRENT_REGISTRATION_SCRIPT:-}" ]; then "$GSTACK_TEST_CONCURRENT_REGISTRATION_SCRIPT"; fi',
    '    if [ "$count" -eq "$GSTACK_TEST_FAIL_DISCOVERY_AFTER" ]; then echo "injected link failure" >&2; exit 91; fi',
    '    ;;',
    'esac',
    'exec /bin/ln "$@"',
  ].join('\n') + '\n', { mode: 0o755 });
  fx.failDiscoveryLinkAt = { skillsDir, log, counter, after, concurrentScript };
  return { log, counter };
}

function installUpdaterAcquireCrash(fx: Fixture) {
  const mkdirPath = execFileSync('which', ['mkdir'], { encoding: 'utf8', timeout: 30_000 }).trim();
  fs.writeFileSync(path.join(fx.bin, 'mkdir'), [
    '#!/bin/sh', 'set -eu',
    `${mkdirPath} "$@"`,
    'for target do',
    '  if [ "$target" = "$GSTACK_STATE_ROOT/.setup-lock" ] && [ "${GSTACK_TEST_KILL_AFTER_LOCK_MKDIR:-0}" = 1 ]; then kill -KILL "$PPID"; fi',
    'done',
  ].join('\n') + '\n', { mode: 0o755 });
}

function installUpdaterRollbackCrash(fx: Fixture) {
  const mvPath = execFileSync('which', ['mv'], { encoding: 'utf8', timeout: 30_000 }).trim();
  fs.writeFileSync(path.join(fx.bin, 'mv'), [
    '#!/bin/sh', 'set -eu',
    `${mvPath} "$@"`,
    'last=', 'for target do last="$target"; done',
    'case "$last" in */source-new) kill -KILL "$PPID" ;; esac',
  ].join('\n') + '\n', { mode: 0o755 });
}

function installBunxSentinel(fx: Fixture) {
  fs.writeFileSync(path.join(fx.bin, 'bunx'), [
    '#!/bin/sh', 'set -eu',
    'printf "%s\\n" "$*" >> "$GSTACK_TEST_BUNX_LOG"',
    'exit 93',
  ].join('\n') + '\n', { mode: 0o755 });
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`fixture did not reach the expected state within ${timeoutMs}ms`);
}

afterEach(() => { for (const base of bases.splice(0)) fs.rmSync(base, { recursive: true, force: true }); });

describe('gstack update candidate CLI', () => {
  test('trusted candidate holds before the source transaction when an incoming hook does not parse', async () => {
    const fx = makeFixture('full');
    const incomingHook = path.join(fx.seed, 'hosts/claude/hooks/question-log-hook');
    fs.appendFileSync(incomingHook, '\nif then\n');
    const target = publish(fx);
    const api = await githubFixture(initialApiState(target));
    try {
      registerCodex(fx);
      const before = git(fx.install, 'rev-parse', 'HEAD');
      const resolved = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(resolved.status, resolved.stderr).toBe(0);
      const applied = await run(fx, api.url, updater(fx), ['--apply-candidate', target]);
      expect(applied.status, applied.stderr).toBe(0);
      expect(applied.stdout).toContain('UPDATE_DEFERRED hook-does-not-parse: hosts/claude/hooks/question-log-hook:');
      expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(before);
      expect(git(fx.install, 'status', '--porcelain', '--untracked-files=all')).toBe('');
      expect(fs.readFileSync(path.join(fx.stateDir, 'session-update-pending'), 'utf8')).toContain('reason=hook-does-not-parse:');
      expect(fs.existsSync(path.join(fx.stateDir, 'session-update-transaction'))).toBe(false);
      expect(fs.existsSync(path.join(fx.stateDir, 'just-upgraded-from'))).toBe(false);
    } finally { api.stop(); }
  }, 120_000);

  test('other-origin discovery emits manual guidance through the real skill-start entrypoint', async () => {
    const fx = makeFixture('full');
    git(fx.install, 'remote', 'set-url', 'origin', 'https://github.com/garrytan/gstack.git');
    const remoteVersion = path.join(fx.base, 'remote-VERSION');
    const nextVersion = `${fx.version}.1`;
    fs.writeFileSync(remoteVersion, `${nextVersion}\n`);
    const env = { GSTACK_REMOTE_URL: pathToFileURL(remoteVersion).href };
    const head = git(fx.install, 'rev-parse', 'HEAD');
    const sourceStatus = git(fx.install, 'status', '--porcelain', '--untracked-files=all');
    const stash = git(fx.install, 'stash', 'list');
    const check = await run(fx, 'http://127.0.0.1', path.join(fx.install, 'bin/gstack-update-check'), ['--force'], env);
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout.trim()).toBe(`MANUAL_UPGRADE_AVAILABLE ${fx.version} ${nextVersion} ${nextVersion} garrytan/gstack`);
    expect(fs.existsSync(path.join(fx.stateDir, 'update-candidate'))).toBe(false);
    const started = await run(fx, 'http://127.0.0.1', path.join(fx.install, 'bin/gstack-skill-start'), [
      '--skill', 'gstack-upgrade', '--parent-pid', String(process.pid),
    ], env);
    expect(started.status, started.stderr).toBe(0);
    expect(started.stdout).toContain('MANUAL_UPGRADE_AVAILABLE');
    expect(started.stdout).toContain('this notice is version-only and cannot authorize fork activation');
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(fx.install, 'status', '--porcelain', '--untracked-files=all')).toBe(sourceStatus);
    expect(git(fx.install, 'stash', 'list')).toBe(stash);
  }, 60_000);

  test('trusted .git slash origin stays on the gated route and never invokes the legacy updater', async () => {
    const fx = makeFixture('full');
    const trailingSlashOrigin = `${CANONICAL}/`;
    git(fx.install, 'remote', 'set-url', 'origin', trailingSlashOrigin);
    git(fx.install, 'config', `url.file://${fx.origin}.insteadOf`, trailingSlashOrigin);
    fs.mkdirSync(fx.stateDir, { recursive: true });
    fs.writeFileSync(path.join(fx.stateDir, 'config.yaml'), 'update_check: true\n');
    const head = git(fx.install, 'rev-parse', 'HEAD');
    const check = await run(fx, 'http://127.0.0.1', path.join(fx.install, 'bin/gstack-update-check'), ['--force']);
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout.trim(), check.stderr).toBe('');
    expect(fs.readFileSync(path.join(fx.stateDir, 'last-update-check'), 'utf8').trim()).toBe(`UP_TO_DATE ${fx.version} ${head} trusted`);

    registerCodex(fx);
    const legacyLog = path.join(fx.base, 'legacy-updater-called');
    fs.writeFileSync(path.join(fx.install, 'bin/gstack-session-update-legacy'), [
      '#!/usr/bin/env bash', 'printf called > "$GSTACK_TEST_LEGACY_CALLED"',
    ].join('\n') + '\n', { mode: 0o755 });
    const started = await run(fx, 'http://127.0.0.1', updater(fx), [], { GSTACK_TEST_LEGACY_CALLED: legacyLog });
    expect(started.status, started.stderr).toBe(0);
    expect(fs.existsSync(legacyLog)).toBe(false);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(head);
  }, 60_000);

  test('pins and verifies a same-version fork commit against exact successful main-push CI', async () => {
    const fx = makeFixture();
    const target = publish(fx);
    const state = initialApiState(target);
    const api = await githubFixture(state);
    try {
      const resolved = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(resolved.status, resolved.stderr).toBe(0);
      expect(resolved.stdout.trim()).toBe(`UPGRADE_AVAILABLE ${fx.version} ${fx.version} ${target}`);
      const record = fs.readFileSync(path.join(fx.stateDir, 'update-candidate'), 'utf8');
      expect(record).toContain(`repository=TheAngryPit/gstack\nref=refs/heads/main\n`);
      expect(record).toContain(`commit=${target}\n`);
      for (const name of Object.keys(workflowIds)) expect(record).toContain(`${name.replace(/\.yml$/, '')}_attempt=1\n`);
      const verified = await run(fx, api.url, resolver(fx), ['verify']);
      expect(verified.status, verified.stderr).toBe(0);
      expect(verified.stdout.trim()).toBe(target);
      const receipts = fs.readFileSync(path.join(fx.stateDir, 'security', 'egress.jsonl'), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line));
      expect(receipts.some(receipt => receipt.sink === 'update-check' && receipt.payload_class === 'github-actions-read')).toBe(true);
    } finally { api.stop(); }
  });

  test('continues to verify the selected exact SHA when main advances afterward', async () => {
    const fx = makeFixture();
    const selected = publish(fx);
    const state = initialApiState(selected);
    const api = await githubFixture(state);
    try {
      const resolved = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(resolved.status).toBe(0);
      const moved = publish(fx, 'later main commit\n');
      expect(moved).not.toBe(selected);
      const verified = await run(fx, api.url, resolver(fx), ['verify']);
      expect(verified.status, verified.stderr).toBe(0);
      expect(verified.stdout.trim()).toBe(selected);
    } finally { api.stop(); }
  });

  test.each([
    ['untrusted origin', (fx: Fixture) => git(fx.install, 'remote', 'set-url', 'origin', 'https://github.com/garrytan/gstack.git'), 'untrusted_origin'],
    ['insecure origin', (fx: Fixture) => git(fx.install, 'remote', 'set-url', 'origin', 'http://github.com/TheAngryPit/gstack.git'), 'unsupported_origin'],
    ['pull request run', (_fx: Fixture, state: ApiState) => { state.event = 'pull_request'; }, 'required_workflow_unverified'],
    ['wrong workflow repository', (_fx: Fixture, state: ApiState) => { state.repository = 'attacker/gstack'; }, 'required_workflow_unverified'],
    ['wrong source repository', (_fx: Fixture, state: ApiState) => { state.headRepository = 'attacker/gstack'; }, 'required_workflow_unverified'],
    ['wrong SHA', (_fx: Fixture, state: ApiState) => { state.sha = 'f'.repeat(40); }, 'required_workflow_unverified'],
    ['wrong branch', (_fx: Fixture, state: ApiState) => { state.branch = 'feature'; }, 'required_workflow_unverified'],
    ['wrong workflow path', (_fx: Fixture, state: ApiState) => { state.workflowPath = '.github/workflows/other.yml'; }, 'required_workflow_unverified'],
  ] as Array<[string, (fx: Fixture, state: ApiState) => void, string]>)('refuses %s before persisting an installable candidate', async (_label, mutate, reason) => {
    const fx = makeFixture();
    const target = publish(fx);
    const state = initialApiState(target);
    const api = await githubFixture(state);
    try {
      mutate(fx, state);
      const result = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain(`UPDATE_FAILED ${reason}`);
      expect(fs.existsSync(path.join(fx.stateDir, 'update-candidate'))).toBe(false);
    } finally { api.stop(); }
  });

  test.each([
    ['pending run', (state: ApiState) => { state.workflowRunStatus = 'in_progress'; }],
    ['failed run', (state: ApiState) => { state.workflowConclusion = 'failure'; }],
    ['missing required job', (state: ApiState) => { state.missingJobs = ['free-tests']; }],
    ['queued required job', (state: ApiState) => { state.jobStatus['free-tests'] = 'queued'; }],
    ['failed required job', (state: ApiState) => { state.jobConclusion['parity'] = 'failure'; }],
  ] as Array<[string, (state: ApiState) => void]>)('does not authorize a candidate with %s', async (_label, mutate) => {
    const fx = makeFixture();
    const target = publish(fx);
    const state = initialApiState(target);
    const api = await githubFixture(state);
    try {
      mutate(state);
      const result = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain('UPDATE_FAILED required_workflow_unverified');
      expect(fs.existsSync(path.join(fx.stateDir, 'update-candidate'))).toBe(false);
    } finally { api.stop(); }
  });

  test.each([
    ['run endpoint unavailable', (state: ApiState) => { state.missingRun = true; }],
    ['current run attempt changed', (state: ApiState) => { state.currentRun = { run_attempt: 2 }; }],
    ['current run status changed', (state: ApiState) => { state.currentRun = { status: 'in_progress', conclusion: null }; }],
    ['current run workflow changed', (state: ApiState) => { state.currentRun = { workflow_id: 999 }; }],
    ['current run repository changed', (state: ApiState) => { state.currentRun = { repository: { full_name: 'attacker/gstack' } }; }],
    ['current run head branch changed', (state: ApiState) => { state.currentRun = { head_branch: 'feature' }; }],
    ['current run SHA changed', (state: ApiState) => { state.currentRun = { head_sha: 'f'.repeat(40) }; }],
  ] as Array<[string, (state: ApiState) => void]>)('rechecks the full current workflow run before accepting %s', async (_label, mutate) => {
    const fx = makeFixture();
    const target = publish(fx);
    const state = initialApiState(target);
    const api = await githubFixture(state);
    try {
      const resolved = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(resolved.status).toBe(0);
      mutate(state);
      const verified = await run(fx, api.url, resolver(fx), ['verify']);
      expect(verified.status).not.toBe(0);
      expect(verified.stdout).toContain('UPDATE_FAILED');
    } finally { api.stop(); }
  });

  test('rejects an older version even when its exact CI passed', async () => {
    const fx = makeFixture();
    const target = publish(fx, 'version regressed\n', '0.9.9');
    const state = initialApiState(target);
    const api = await githubFixture(state);
    try {
      const result = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain('UPDATE_FAILED candidate_version_regressed');
    } finally { api.stop(); }
  });

  test.each(['browse/src/cli.ts', 'bin/gstack-global-discover.ts'])('defers before activation when a candidate changes generated runtime input %s', async (source) => {
    const fx = makeFixture();
    const sourcePath = path.join(fx.seed, source);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, '// candidate changes compiled runtime behavior\n');
    git(fx.seed, 'add', source);
    git(fx.seed, 'commit', '-q', '-m', 'runtime source changes');
    git(fx.seed, 'push', '-q', 'origin', 'main');
    const target = git(fx.seed, 'rev-parse', 'HEAD');
    const api = await githubFixture(initialApiState(target));
    try {
      const resolved = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(resolved.status).not.toBe(0);
      expect(resolved.stdout).toContain('UPDATE_FAILED runtime_build_required');
      expect(fs.existsSync(path.join(fx.stateDir, 'update-candidate'))).toBe(false);
      expect(git(fx.install, 'rev-parse', 'HEAD')).not.toBe(target);
    } finally { api.stop(); }
  });

  test('the updater refuses a persisted candidate that changes the retained global-discover runtime', async () => {
    const fx = makeFixture('full');
    const source = path.join(fx.seed, 'bin/gstack-global-discover.ts');
    fs.appendFileSync(source, '\n// candidate changes compiled runtime behavior\n');
    const target = publish(fx);
    git(fx.install, 'fetch', 'origin', target);
    const registered = registerCodex(fx);
    const previous = git(fx.install, 'rev-parse', 'HEAD');
    expect(git(fx.install, 'diff', '--name-only', previous, target, '--', 'bin/gstack-global-discover.ts')).toBe('bin/gstack-global-discover.ts');
    const tree = git(fx.install, 'rev-parse', `${target}^{tree}`);
    fs.writeFileSync(path.join(fx.stateDir, 'update-candidate'), [
      'schema=1', 'repository=TheAngryPit/gstack', 'ref=refs/heads/main',
      `previous=${previous}`, `commit=${target}`, `tree=${tree}`, `version=${fx.version}`,
    ].join('\n') + '\n');
    git(fx.install, 'update-index', '--assume-unchanged', 'bin/gstack-update-candidate');
    fs.writeFileSync(path.join(fx.install, 'bin/gstack-update-candidate'), [
      '#!/bin/sh', 'set -eu', '[ "${1:-}" = verify ] || exit 2', 'printf "%s\\n" "$GSTACK_TEST_TARGET"',
    ].join('\n') + '\n', { mode: 0o755 });
    const result = await run(fx, 'http://127.0.0.1', updater(fx), ['--apply-candidate', target], { GSTACK_TEST_TARGET: target });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('UPDATE_DEFERRED runtime_artifact_identity_unknown');
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(previous);
    expect(git(fx.install, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(fs.readFileSync(path.join(fx.stateDir, 'installs.tsv'), 'utf8')).toBe(`${registered.row}\n`);
    expect(fs.existsSync(path.join(fx.stateDir, 'just-upgraded-from'))).toBe(false);
  }, 120_000);

  test('bounded setup rejects a retained global-discover source change before refreshing installs', async () => {
    const fx = makeFixture('full');
    const source = path.join(fx.seed, 'bin/gstack-global-discover.ts');
    fs.appendFileSync(source, '\n// candidate changes compiled runtime behavior\n');
    const target = publish(fx);
    git(fx.install, 'fetch', 'origin', target);
    registerCodex(fx);
    const previous = git(fx.install, 'rev-parse', 'HEAD');
    const sourceDir = fs.realpathSync(fx.install);
    const transaction = `${sourceDir}.update-fixture`;
    const token = 'a'.repeat(32);
    fs.mkdirSync(transaction, { recursive: true });
    fs.writeFileSync(path.join(transaction, 'owner'), `${sourceDir}\n`);
    fs.writeFileSync(path.join(transaction, 'refresh-token'), `${token}\n`);
    fs.mkdirSync(path.join(fx.stateDir, '.setup-lock'), { recursive: true });
    fs.writeFileSync(path.join(fx.stateDir, '.setup-lock/pid'), `${process.pid}\n`);
    fs.writeFileSync(path.join(fx.stateDir, 'session-update-transaction'), [
      'schema=1', 'phase=active', `source=${sourceDir}`, `from=${previous}`, `target=${target}`, `transaction=${transaction}`,
    ].join('\n') + '\n');
    const result = await run(fx, 'http://127.0.0.1', 'bash', [path.join(fx.install, 'setup'), '--refresh-registered', '--host', 'codex', '-q'], {
      GSTACK_SETUP_AUTO_CODEX_REFRESH: '1', GSTACK_SETUP_REFRESH_PARENT: '1',
      GSTACK_SETUP_REFRESH_TOKEN: token, GSTACK_SETUP_REFRESH_TRANSACTION: transaction,
    }, 30_000);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('automatic Codex refresh requires a runtime build');
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(previous);
    expect(git(fx.install, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  }, 30_000);

  test('defers activation when compiled runtime sidecars do not identify a retained source', async () => {
    const fx = makeFixture('full');
    const target = publish(fx);
    const state = initialApiState(target);
    const api = await githubFixture(state);
    try {
      registerCodex(fx);
      fs.rmSync(path.join(fx.install, 'design/dist/.version'));
      expect((await run(fx, api.url, resolver(fx), ['resolve'])).status).toBe(0);
      const result = await run(fx, api.url, updater(fx), ['--apply-candidate', target]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('UPDATE_DEFERRED runtime_artifact_identity_unknown');
      expect(git(fx.install, 'rev-parse', 'HEAD')).not.toBe(target);
      expect(fs.existsSync(path.join(fx.stateDir, 'session-update-transaction'))).toBe(false);
    } finally { api.stop(); }
  }, 120_000);

  test('rejects automatic setup without the updater transaction owner token', async () => {
    const fx = makeFixture('full');
    const result = await run(fx, 'http://127.0.0.1', 'bash', [path.join(fx.install, 'setup'), '--host', 'codex', '--global', '--model', 'gpt-5.6-sol', '-q'], {
      GSTACK_SETUP_AUTO_CODEX_REFRESH: '1',
      GSTACK_SETUP_REFRESH_PARENT: '1',
    }, 30_000);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('requires a valid transaction token');
    expect(fs.existsSync(path.join(fx.stateDir, 'installs.tsv'))).toBe(false);
  }, 30_000);

  test('refuses a locally diverged checkout before candidate persistence', async () => {
    const fx = makeFixture();
    const target = publish(fx);
    git(fx.install, 'config', 'user.name', 'Local Fixture');
    git(fx.install, 'config', 'user.email', 'local-fixture@example.invalid');
    fs.writeFileSync(path.join(fx.install, 'local-divergence.txt'), 'local only\n');
    git(fx.install, 'add', 'local-divergence.txt');
    git(fx.install, 'commit', '-q', '-m', 'local divergence');
    const api = await githubFixture(initialApiState(target));
    try {
      const resolved = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(resolved.status).not.toBe(0);
      expect(resolved.stdout).toContain('UPDATE_FAILED candidate_diverged');
      expect(fs.existsSync(path.join(fx.stateDir, 'update-candidate'))).toBe(false);
      expect(git(fx.install, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    } finally { api.stop(); }
  });

  test.each(['tracked', 'staged', 'untracked'])('real session updater leaves %s source dirt untouched', async (kind) => {
    const fx = makeFixture();
    const target = publish(fx);
    const state = initialApiState(target);
    const api = await githubFixture(state);
    try {
      const resolved = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(resolved.status).toBe(0);
      const dirtyFile = path.join(fx.install, kind === 'untracked' ? 'local-note.txt' : 'payload.txt');
      fs.appendFileSync(dirtyFile, 'local user data\n');
      if (kind === 'staged') git(fx.install, 'add', 'payload.txt');
      const before = git(fx.install, 'status', '--porcelain', '--untracked-files=all');
      const stashBefore = git(fx.install, 'stash', 'list');
      const result = await run(fx, api.url, updater(fx), ['--apply-candidate', target]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('UPDATE_DEFERRED working_tree_not_clean');
      expect(git(fx.install, 'status', '--porcelain', '--untracked-files=all')).toBe(before);
      expect(git(fx.install, 'stash', 'list')).toBe(stashBefore);
      expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(git(fx.install, 'rev-parse', `${target}^`));
      expect(fs.existsSync(path.join(fx.stateDir, 'just-upgraded-from'))).toBe(false);
    } finally { api.stop(); }
  });

  test('rechecks the latest run attempt before activation', async () => {
    const fx = makeFixture('full');
    const target = publish(fx);
    const state = initialApiState(target);
    state.failOnRunList = 3;
    const api = await githubFixture(state);
    try {
      const resolved = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(resolved.status).toBe(0);
      const registered = registerCodex(fx);
      const originalRuntime = fs.readFileSync(path.join(registered.root, 'runtime-user-data.txt'), 'utf8');
      const applied = await run(fx, api.url, updater(fx), ['--apply-candidate', target]);
      expect(applied.status, applied.stderr).toBe(0);
      expect(applied.stdout).toContain('UPDATE_DEFERRED required_workflow_revalidation_failed');
      expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(git(fx.install, 'rev-parse', `${target}^`));
      expect(fs.readFileSync(path.join(registered.root, 'runtime-user-data.txt'), 'utf8')).toBe(originalRuntime);
      expect(fs.readFileSync(path.join(fx.stateDir, 'installs.tsv'), 'utf8')).toBe(`${registered.row}\n`);
      expect(fs.existsSync(path.join(fx.stateDir, 'just-upgraded-from'))).toBe(false);
    } finally { api.stop(); }
  }, 60_000);

  test.each([
    ['model', 10, '-'],
    ['source commit', 11, '-'],
    ['stale source commit', 11, 'f'.repeat(40)],
  ])('defers when the registered Codex %s cannot be verified', async (_label, field, value) => {
    const fx = makeFixture('full');
    const target = publish(fx);
    const state = initialApiState(target);
    const api = await githubFixture(state);
    try {
      const registered = registerCodex(fx);
      const columns = registered.row.split('\t');
      columns[field] = value;
      fs.writeFileSync(path.join(fx.stateDir, 'installs.tsv'), `${columns.join('\t')}\n`);
      const resolved = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(resolved.status).toBe(0);
      const result = await run(fx, api.url, updater(fx), ['--apply-candidate', target]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('UPDATE_DEFERRED registered_codex_target_unavailable');
      expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(git(fx.install, 'rev-parse', `${target}^`));
      expect(fs.readFileSync(path.join(fx.stateDir, 'installs.tsv'), 'utf8')).toBe(`${columns.join('\t')}\n`);
      expect(fs.existsSync(path.join(fx.stateDir, 'just-upgraded-from'))).toBe(false);
    } finally { api.stop(); }
  }, 60_000);

  test('refuses the native auto lane before candidate or runtime mutation when a Claude install shares the source', async () => {
    const fx = makeFixture('full');
    const target = publish(fx);
    const state = initialApiState(target);
    const api = await githubFixture(state);
    try {
      const registered = registerCodex(fx);
      const before = git(fx.install, 'rev-parse', 'HEAD');
      const claudeDestination = path.join(fx.home, '.claude', 'skills');
      const claudeRow = [
        'claude', 'global', '-', claudeDestination, path.join(claudeDestination, 'gstack'),
        fs.realpathSync(fx.install), fx.version, 'false', 'committed', '2026-10-06T12:00:00Z', '-', before,
      ].join('\t');
      const registryPath = path.join(fx.stateDir, 'installs.tsv');
      const registry = `${registered.row}\n${claudeRow}\n`;
      fs.writeFileSync(registryPath, registry);
      const runtime = treeSnapshot(registered.root);
      const result = await run(fx, api.url, updater(fx), ['--apply-candidate', target]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('UPDATE_DEFERRED native_codex_only_non_codex_registered');
      expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(before);
      expect(git(fx.install, 'status', '--porcelain', '--untracked-files=all')).toBe('');
      expect(treeSnapshot(registered.root)).toBe(runtime);
      expect(fs.readFileSync(registryPath, 'utf8')).toBe(registry);
      expect(fs.existsSync(path.join(fx.stateDir, 'update-candidate'))).toBe(false);
      expect(fs.existsSync(path.join(fx.stateDir, 'session-update-transaction'))).toBe(false);
      expect(fs.existsSync(path.join(fx.stateDir, 'just-upgraded-from'))).toBe(false);
      expect(state.runListCount).toEqual({});
    } finally { api.stop(); }
  }, 60_000);

  test('a concurrent updater observes the live lock and cannot activate twice', async () => {
    const fx = makeFixture('full');
    const target = publish(fx);
    const state = initialApiState(target);
    const api = await githubFixture(state);
    try {
      registerCodex(fx);
      const resolved = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(resolved.status, resolved.stderr).toBe(0);
      const stashBefore = git(fx.install, 'stash', 'list');
      const first = run(fx, api.url, updater(fx), ['--apply-candidate', target], { GSTACK_TEST_GH_DELAY: '0.1' }, 120_000);
      await new Promise(resolve => setTimeout(resolve, 150));
      const second = await run(fx, api.url, updater(fx), ['--apply-candidate', target]);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain('UPDATE_DEFERRED candidate_not_activated');
      const firstResult = await first;
      expect(firstResult.status, firstResult.stderr).toBe(0);
      expect(firstResult.stdout + fs.readFileSync(path.join(fx.stateDir, 'analytics/session-update.log'), 'utf8')).toContain(`UPDATED ${target}; registered Codex runtimes verified`);
      expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(target);
      expect(git(fx.install, 'stash', 'list')).toBe(stashBefore);
      expect(fs.readFileSync(path.join(fx.stateDir, 'analytics', 'session-update.log'), 'utf8')).toContain('SKIP locked_by=');
    } finally { api.stop(); }
  }, 120_000);

  test('reclaims a stale empty updater lock after an actual interrupted mkdir acquisition', async () => {
    const fx = makeFixture('full');
    const target = publish(fx);
    const api = await githubFixture(initialApiState(target));
    try {
      registerCodex(fx);
      const resolved = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(resolved.status).toBe(0);
      installUpdaterAcquireCrash(fx);
      const interrupted = await run(fx, api.url, updater(fx), ['--apply-candidate', target], { GSTACK_TEST_KILL_AFTER_LOCK_MKDIR: '1' });
      expect(interrupted.status).toBeNull();
      const lock = path.join(fx.stateDir, '.setup-lock');
      expect(fs.existsSync(lock)).toBe(true);
      expect(fs.existsSync(path.join(lock, 'pid'))).toBe(false);
      const old = new Date(Date.now() - 120_000);
      fs.utimesSync(lock, old, old);
      const retried = await run(fx, api.url, updater(fx), ['--apply-candidate', target], { GSTACK_UPDATE_LOCK_TTL_MINUTES: '1' }, 120_000);
      expect(retried.status, retried.stderr).toBe(0);
      expect(retried.stdout).toContain(`UPDATED ${target}; registered Codex runtimes verified`);
      expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(target);
      expect(fs.existsSync(lock)).toBe(false);
    } finally { api.stop(); }
  }, 120_000);

  test('respects a fresh empty updater lock instead of stealing it', async () => {
    const fx = makeFixture('full');
    const target = publish(fx);
    const api = await githubFixture(initialApiState(target));
    try {
      registerCodex(fx);
      expect((await run(fx, api.url, resolver(fx), ['resolve'])).status).toBe(0);
      const lock = path.join(fx.stateDir, '.setup-lock');
      fs.mkdirSync(lock);
      const result = await run(fx, api.url, updater(fx), ['--apply-candidate', target]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('UPDATE_DEFERRED candidate_not_activated');
      expect(fs.existsSync(lock)).toBe(true);
      expect(fs.existsSync(path.join(lock, 'pid'))).toBe(false);
      expect(git(fx.install, 'rev-parse', 'HEAD')).not.toBe(target);
    } finally { api.stop(); }
  }, 120_000);

  test('retains hourly throttling when the trusted fork is already current', async () => {
    const fx = makeFixture('full');
    const api = await githubFixture(initialApiState(git(fx.install, 'rev-parse', 'HEAD')));
    try {
      registerCodex(fx);
      fs.writeFileSync(path.join(fx.stateDir, 'config.yaml'), 'auto_upgrade: true\nupdate_check: true\n');
      const first = await run(fx, api.url, updater(fx), []);
      expect(first.status, first.stderr).toBe(0);
      await waitFor(() => fs.existsSync(path.join(fx.stateDir, 'analytics/session-update.log'))
        && fs.readFileSync(path.join(fx.stateDir, 'analytics/session-update.log'), 'utf8').includes('UP_TO_DATE'));
      const log = path.join(fx.stateDir, 'analytics/session-update.log');
      const before = fs.readFileSync(log, 'utf8');
      const timestamp = Number(fs.readFileSync(path.join(fx.stateDir, '.last-session-update'), 'utf8').trim());
      const second = await run(fx, api.url, updater(fx), []);
      expect(second.status, second.stderr).toBe(0);
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(fs.readFileSync(log, 'utf8')).toBe(before);
      expect(Number(fs.readFileSync(path.join(fx.stateDir, '.last-session-update'), 'utf8').trim())).toBe(timestamp);
    } finally { api.stop(); }
  }, 120_000);

  test('backs off repeated automatic CI failures at one hour, six hours and one day', async () => {
    const fx = makeFixture('full');
    const target = publish(fx);
    const state = initialApiState(target);
    state.workflowRunStatus = 'in_progress';
    const api = await githubFixture(state);
    try {
      registerCodex(fx);
      fs.writeFileSync(path.join(fx.stateDir, 'config.yaml'), 'auto_upgrade: true\nupdate_check: true\n');
      const invoke = () => run(fx, api.url, updater(fx), [], {}, 30_000);
      expect((await invoke()).status).toBe(0);
      await waitFor(() => Number(state.runListCount?.['free-tests.yml'] ?? 0) === 1
        && fs.existsSync(path.join(fx.stateDir, 'session-update-pending')));
      const pendingPath = path.join(fx.stateDir, 'session-update-pending');
      const first = fs.readFileSync(pendingPath, 'utf8');
      expect(first).toContain('failures=1\n');
      expect(Number(first.match(/next=(\d+)/)?.[1]) - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(3598);
      const log = path.join(fx.stateDir, 'analytics/session-update.log');
      const firstLog = fs.readFileSync(log, 'utf8');
      expect((await invoke()).status).toBe(0);
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(Number(state.runListCount?.['free-tests.yml'] ?? 0)).toBe(1);
      expect(fs.readFileSync(log, 'utf8')).toBe(firstLog);

      for (const [failures, delay] of [[1, 21_600], [2, 86_400]]) {
        fs.writeFileSync(pendingPath, `reason=fixture_pending\nfailures=${failures}\nnext=0\n`);
        fs.writeFileSync(path.join(fx.stateDir, '.last-session-update'), '0\n');
        expect((await invoke()).status).toBe(0);
        const expectedCount = failures + 1;
        await waitFor(() => Number(state.runListCount?.['free-tests.yml'] ?? 0) === expectedCount
          && fs.readFileSync(pendingPath, 'utf8').includes(`failures=${expectedCount}\n`));
        const retryState = fs.readFileSync(pendingPath, 'utf8');
        expect(Number(retryState.match(/next=(\d+)/)?.[1]) - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(delay - 2);
      }
    } finally { api.stop(); }
  }, 120_000);

  test('recovers a real source-swap interruption through the stable external entrypoint', async () => {
    const fx = makeFixture('full');
    const target = publish(fx);
    const api = await githubFixture(initialApiState(target));
    try {
      const registered = registerCodex(fx);
      const from = git(fx.install, 'rev-parse', 'HEAD');
      const resolved = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(resolved.status).toBe(0);
      installDiscoveryLinkFailure(fx, registered.destination, 3);
      installUpdaterRollbackCrash(fx);
      const interrupted = await run(fx, api.url, updater(fx), ['--apply-candidate', target]);
      expect(interrupted.status).toBeNull();
      expect(fs.existsSync(fx.install)).toBe(false);
      expect(fs.existsSync(path.join(fx.stateDir, 'session-update-recovery/recover'))).toBe(true);
      const recovery = await run(fx, api.url, path.join(fx.stateDir, 'session-update-recovery/recover'), [], {}, 30_000);
      expect(recovery.status, recovery.stderr).toBe(0);
      expect(recovery.stdout).toContain('RECOVERED interrupted GStack transaction');
      expect(fs.existsSync(fx.install)).toBe(true);
      expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(from);
      expect(fs.existsSync(path.join(fx.stateDir, 'session-update-transaction'))).toBe(false);
      expect(fs.existsSync(path.join(fx.stateDir, 'session-update-pending'))).toBe(true);
      expect(execFileSync(path.join(registered.root, 'bin/gstack-config'), ['get', 'auto_upgrade'], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: fx.home, GSTACK_HOME: fx.stateDir },
      }).trim()).toBe('false');
      expect(fs.existsSync(path.join(fx.stateDir, 'just-upgraded-from'))).toBe(false);
    } finally { api.stop(); }
  }, 120_000);

  test('rolls back source, rendered runtime, registry and unrelated home data after setup partially links skills', async () => {
    const fx = makeFixture('full');
    const target = publish(fx);
    const state = initialApiState(target);
    const api = await githubFixture(state);
    try {
      const registered = registerCodex(fx);
      const personalSkill = path.join(registered.destination, 'personal-skill');
      fs.mkdirSync(personalSkill, { recursive: true });
      fs.writeFileSync(path.join(personalSkill, 'SKILL.md'), 'unrelated skill stays\n');
      fs.mkdirSync(path.join(fx.home, '.codex', 'hooks'), { recursive: true });
      fs.mkdirSync(path.join(fx.home, '.codex', 'providers'), { recursive: true });
      fs.mkdirSync(path.join(fx.home, '.codex', 'memories'), { recursive: true });
      fs.writeFileSync(path.join(fx.home, '.codex', 'config.toml'), 'model = "gpt-5.6-sol"\nprovider = "local-fixture"\n');
      fs.writeFileSync(path.join(fx.home, '.codex', 'hooks', 'keep.sh'), '#!/bin/sh\necho keep\n');
      fs.writeFileSync(path.join(fx.home, '.codex', 'providers', 'local.toml'), 'name = "fixture"\n');
      fs.writeFileSync(path.join(fx.home, '.codex', 'memories', 'note.md'), 'private fixture memory\n');
      fs.mkdirSync(fx.stateDir, { recursive: true });
      const configPath = path.join(fx.stateDir, 'config.yaml');
      const config = 'telemetry: off\nupdate_check: false\nskill_prefix: true\n';
      fs.writeFileSync(configPath, config);
      const browserCache = path.join(fx.base, 'isolated-playwright-cache');
      fs.mkdirSync(browserCache, { recursive: true });
      const browserCacheBefore = treeSnapshot(browserCache);
      installBunxSentinel(fx);
      const sourceBefore = git(fx.install, 'rev-parse', 'HEAD');
      const runtimeBefore = treeSnapshot(registered.root);
      const unrelatedBefore = treeSnapshot(personalSkill);
      const codexHomeBefore = treeSnapshot(path.join(fx.home, '.codex'));
      const registryBefore = fs.readFileSync(path.join(fx.stateDir, 'installs.tsv'), 'utf8');
      const stashBefore = git(fx.install, 'stash', 'list');
      const renderPath = execFileSync('bash', ['-c', '. "$1/bin/gstack-install-registry.sh"; GSTACK_STATE_ROOT="$2"; export GSTACK_STATE_ROOT; gstack_install_render_dir codex "$3"', 'bash', fx.install, fx.stateDir, registered.root], { encoding: 'utf8', timeout: 30_000 }).trim();
      const concurrentRegistration = path.join(fx.base, 'record-concurrent-install.sh');
      fs.writeFileSync(concurrentRegistration, [
        '#!/usr/bin/env bash', 'set -eu',
        '. "$GSTACK_DIR/bin/gstack-install-registry.sh"',
        'gstack_install_registry_upsert codex global - "$GSTACK_TEST_CONCURRENT_DEST" "$GSTACK_TEST_CONCURRENT_DEST/gstack" "$GSTACK_TEST_CONCURRENT_SOURCE" 9.9.9 false committed gpt-5.6-sol "$GSTACK_TEST_CONCURRENT_COMMIT"',
      ].join('\n') + '\n', { mode: 0o755 });
      const linked = installDiscoveryLinkFailure(fx, registered.destination, 3, concurrentRegistration);
      const resolved = await run(fx, api.url, resolver(fx), ['resolve']);
      expect(resolved.status, resolved.stderr).toBe(0);
      const failed = await run(fx, api.url, updater(fx), ['--apply-candidate', target]);
      expect(failed.status, failed.stderr).toBe(0);
      expect(failed.stdout).toContain('UPDATE_DEFERRED setup_failed_rolled_back');
      expect(fs.existsSync(linked.log), 'setup reached discovery links before the injected failure').toBe(true);
      const linkedSkills = fs.readFileSync(linked.log, 'utf8').trim().split('\n');
      expect(linkedSkills).toHaveLength(3);
      expect(linkedSkills[0]).toMatch(new RegExp(`^${registered.destination}/gstack-`));
      expect(linkedSkills[1]).toMatch(new RegExp(`^${registered.destination}/gstack-`));
      expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(sourceBefore);
      expect(git(fx.install, 'status', '--porcelain', '--untracked-files=all')).toBe('');
      expect(git(fx.install, 'stash', 'list')).toBe(stashBefore);
      expect(treeSnapshot(registered.root)).toBe(runtimeBefore);
      expect(treeSnapshot(personalSkill)).toBe(unrelatedBefore);
      expect(treeSnapshot(path.join(fx.home, '.codex'))).toBe(codexHomeBefore);
      const rolledBackRegistry = fs.readFileSync(path.join(fx.stateDir, 'installs.tsv'), 'utf8');
      expect(rolledBackRegistry).toContain(registryBefore.trim());
      expect(rolledBackRegistry).toContain(`${path.join(fx.home, 'other-agent', '.agents', 'skills')}/gstack`);
      expect(execFileSync(path.join(registered.root, 'bin/gstack-config'), ['get', 'auto_upgrade'], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: fx.home, GSTACK_HOME: fx.stateDir },
      }).trim()).toBe('false');
      expect(fs.readFileSync(configPath, 'utf8')).toBe(config);
      expect(fs.existsSync(renderPath)).toBe(false);
      expect(fs.existsSync(path.join(fx.stateDir, 'skill-copies.tsv'))).toBe(false);
      expect(fs.existsSync(path.join(fx.stateDir, 'just-upgraded-from'))).toBe(false);
      expect(fs.existsSync(path.join(fx.base, 'bunx.log'))).toBe(false);
      expect(treeSnapshot(browserCache)).toBe(browserCacheBefore);

      const applied = await run(fx, api.url, updater(fx), ['--apply-candidate', target]);
      expect(applied.status, applied.stderr).toBe(0);
      expect(applied.stdout).toContain(`UPDATED ${target}; registered Codex runtimes verified`);
      const rows = fs.readFileSync(path.join(fx.stateDir, 'installs.tsv'), 'utf8').trim().split('\n').map(line => line.split('\t'));
      const row = rows.find(columns => columns[4] === registered.root);
      expect(row).toBeDefined();
      expect(row?.[3]).toBe(registered.destination);
      expect(row?.[5]).toBe(fs.realpathSync(fx.install));
      expect(row?.[10]).toBe('gpt-5.6-sol');
      expect(row?.[11]).toBe(target);
      expect(rows.some(columns => columns[5] === path.join(fx.base, 'other-source', 'gstack'))).toBe(true);
      expect(fs.existsSync(path.join(row![8], '.agents', 'skills', 'gstack-review', 'SKILL.md'))).toBe(true);
      expect(treeSnapshot(personalSkill)).toBe(unrelatedBefore);
      expect(treeSnapshot(path.join(fx.home, '.codex'))).toBe(codexHomeBefore);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(config);
      expect(fs.readFileSync(path.join(registered.root, 'SKILL.md'), 'utf8')).toContain('AUTO-GENERATED');
      expect(git(fx.install, 'stash', 'list')).toBe(stashBefore);
      expect(fs.existsSync(path.join(fx.base, 'bunx.log'))).toBe(false);
      expect(treeSnapshot(browserCache)).toBe(browserCacheBefore);
    } finally { api.stop(); }
  }, 120_000);
});
