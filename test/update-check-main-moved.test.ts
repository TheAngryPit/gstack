import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'bin', 'gstack-update-check');

interface Fx { root: string; gstack: string; state: string; raw: string; gitLog: string; env: Record<string, string> }
let fx: Fx;

function sh(cwd: string, cmd: string, env: Record<string, string> = fx.env): string {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(cmd + ' failed: ' + r.stderr);
  return r.stdout.trim();
}

function serveVersion(version: string): void {
  fs.writeFileSync(path.join(fx.raw, 'VERSION'), version + '\n');
}

function run(args: string[] = [], extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...fx.env, GSTACK_DIR: fx.gstack, GSTACK_STATE_DIR: fx.state, GSTACK_REMOTE_REPO: 'https://github.com/garrytan/gstack.git', GSTACK_REMOTE_URL: 'file://' + path.join(fx.raw, 'VERSION'), PATH: path.join(fx.root, 'shim') + ':' + process.env.PATH, ...extra };
  for (const k of ['GSTACK_STATE_ROOT', 'GSTACK_HOME']) if (!(k in extra)) delete env[k];
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000, env });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: r.stderr ?? '' };
}

const cache = () => fs.readFileSync(path.join(fx.state, 'last-update-check'), 'utf8').split('\n');
const head = () => sh(fx.gstack, 'git rev-parse HEAD');

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-upd-main-'));
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = t\n\temail = t@test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  fx = { root, gstack: path.join(root, 'gstack'), state: path.join(root, 'state'), raw: path.join(root, 'raw'), gitLog: path.join(root, 'git.log'), env: { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', HOME: root } };
  for (const d of [fx.gstack, fx.state, fx.raw, path.join(root, 'shim'), path.join(fx.gstack, 'bin')]) fs.mkdirSync(d, { recursive: true });
  const realGit = sh(root, 'command -v git');
  fs.writeFileSync(path.join(root, 'shim', 'git'), '#!/usr/bin/env bash\ncase "$1" in fetch|pull|merge) echo "git $*" >> "' + fx.gitLog + '" ;; esac\nexec "' + realGit + '" "$@"\n', { mode: 0o755 });
  for (const name of ['gstack-config', 'gstack-egress-lib.sh', 'gstack-state-root.sh', 'gstack-egress-receipt']) fs.symlinkSync(path.join(ROOT, 'bin', name), path.join(fx.gstack, 'bin', name));
  fs.writeFileSync(path.join(fx.gstack, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(fx.gstack, '.gitignore'), 'bin/\n');
  sh(fx.gstack, 'git init -q -b main && git add -A && git commit -q -m base && git remote add origin https://github.com/garrytan/gstack.git');
  serveVersion('1.0.0');
});
afterEach(() => {
  expect(fs.existsSync(fx.gitLog) ? fs.readFileSync(fx.gitLog, 'utf8') : '').toBe('');
  fs.rmSync(fx.root, { recursive: true, force: true });
});

describe('manual-origin version checks stay separate from trusted activation', () => {
  test('an equal remote VERSION stays silent and caches the manual route', () => {
    const r = run();
    expect(r.stdout).toBe('');
    expect(cache()).toEqual(['UP_TO_DATE 1.0.0 ' + head() + ' manual:garrytan/gstack', '']);
  });

  test('a newer VERSION reports manual-only guidance and replays the cached result', () => {
    serveVersion('1.1.0');
    const line = 'MANUAL_UPGRADE_AVAILABLE 1.0.0 1.1.0 1.1.0 garrytan/gstack';
    expect(run().stdout).toBe(line);
    expect(cache()).toEqual(['MANUAL_UPGRADE_AVAILABLE 1.0.0 1.1.0 1.1.0 ' + head() + ' garrytan/gstack', '']);
    fs.rmSync(path.join(fx.raw, 'VERSION'));
    expect(run().stdout).toBe(line);
    const old = new Date(Date.now() - 13 * 3600_000);
    fs.utimesSync(path.join(fx.state, 'last-update-check'), old, old);
    serveVersion('1.2.0');
    expect(run().stdout).toBe('MANUAL_UPGRADE_AVAILABLE 1.0.0 1.2.0 1.2.0 garrytan/gstack');
  });

  test('a local source update invalidates cached identity and recomputes version status', () => {
    serveVersion('1.1.0');
    expect(run().stdout).toContain('MANUAL_UPGRADE_AVAILABLE');
    sh(fx.gstack, 'echo local >> LOCAL && git add LOCAL && git commit -q -m local');
    serveVersion('1.0.0');
    expect(run().stdout).toBe('');
    expect(cache()).toEqual(['UP_TO_DATE 1.0.0 ' + head() + ' manual:garrytan/gstack', '']);
  });

  test('an unreadable manual VERSION is unknown, not up to date', () => {
    fs.rmSync(path.join(fx.raw, 'VERSION'));
    expect(run().stdout).toBe('');
    expect(cache()[0]).toBe('CHECK_FAILED 1.0.0 ' + head() + ' manual:garrytan/gstack');
    expect(run(['--force']).stdout).toContain('CHECK_FAILED could not read the VERSION');
  });

  test('changing manual origin invalidates a cached result', () => {
    expect(run().stdout).toBe('');
    const mirror = 'https://github.com/another/gstack-mirror.git';
    expect(run([], { GSTACK_REMOTE_REPO: mirror }).stdout).toBe('');
    expect(cache()).toEqual(['UP_TO_DATE 1.0.0 ' + head() + ' manual:another/gstack-mirror', '']);
  });

  test('a snooze for one manual version does not hide a later remote VERSION', () => {
    serveVersion('1.1.0');
    fs.writeFileSync(path.join(fx.state, 'update-snoozed'), '1.1.0 1 ' + Math.floor(Date.now() / 1000) + '\n');
    expect(run().stdout).toBe('');
    expect(cache()[0]).toStartWith('MANUAL_UPGRADE_AVAILABLE 1.0.0 1.1.0');
    serveVersion('1.2.0');
    fs.utimesSync(path.join(fx.state, 'last-update-check'), new Date(Date.now() - 13 * 3600_000), new Date(Date.now() - 13 * 3600_000));
    expect(run().stdout).toContain('MANUAL_UPGRADE_AVAILABLE 1.0.0 1.2.0');
  });

  test('unattended skill-end reports the exact trusted candidate SHA from the current cache format', () => {
    fs.writeFileSync(path.join(fx.state, 'last-update-check'), 'UPGRADE_AVAILABLE 1.0.0 1.0.0+2 ' + 'a'.repeat(40) + ' ' + head() + ' trusted\n');
    const env: Record<string, string | undefined> = { ...process.env, ...fx.env, GSTACK_HOME: fx.state, GSTACK_SESSION_KIND: 'unattended' };
    delete env.GSTACK_STATE_ROOT;
    const r = spawnSync(path.join(ROOT, 'bin', 'gstack-skill-end'), ['--skill', 'review', '--outcome', 'success', '--session-id', 'sid-w12', '--tel-start', '1'], { cwd: fx.root, encoding: 'utf8', timeout: 30_000, env });
    expect(r.stdout).toContain('UPGRADE_AVAILABLE: 1.0.0+2 (main at ' + 'a'.repeat(40) + '); run /gstack-upgrade');
  });
});
