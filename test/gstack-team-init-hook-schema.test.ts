import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Regression guard for #2413: gstack-team-init required generated a
// PreToolUse hook that emitted a flat {"permissionDecision":...} payload and
// exited 0. Claude Code only nests decisions under hookSpecificOutput, and
// only exit code 2 reliably blocks a PreToolUse call. The old shape was
// silently ignored as a non-blocking error, so `required` mode enforced
// nothing — the BLOCKED text printed to stderr but the tool call proceeded.

const ROOT = path.resolve(import.meta.dir, '..');
const TEAM_INIT = path.join(ROOT, 'bin', 'gstack-team-init');

let repoDir: string;
let fakeHomeAbsent: string;
let fakeHomePresent: string;

describe('gstack-team-init required: PreToolUse hook schema (#2413)', () => {
  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-team-init-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync(TEAM_INIT, ['required'], { cwd: repoDir, encoding: 'utf-8' });

    fakeHomeAbsent = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-team-init-home-absent-'));

    fakeHomePresent = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-team-init-home-present-'));
    fs.mkdirSync(path.join(fakeHomePresent, '.claude', 'skills', 'gstack', 'bin'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(fakeHomeAbsent, { recursive: true, force: true });
    fs.rmSync(fakeHomePresent, { recursive: true, force: true });
  });

  // Run the command exactly as registered in settings.json, the way a hook
  // runner does: through a shell, with CLAUDE_PROJECT_DIR set.
  function runHook(home: string): { status: number; stdout: string; stderr: string } {
    const settings = JSON.parse(fs.readFileSync(path.join(repoDir, '.claude', 'settings.json'), 'utf-8'));
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    try {
      const stdout = execSync(command, {
        env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: repoDir, GSTACK_ROOT: '' },
        encoding: 'utf-8',
        timeout: 30_000,
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { status: e.status, stdout: e.stdout, stderr: e.stderr };
    }
  }

  test('generates the hook and registers it in settings.json', () => {
    expect(fs.existsSync(path.join(repoDir, '.claude', 'hooks', 'check-gstack.cjs'))).toBe(true);
    const settings = JSON.parse(
      fs.readFileSync(path.join(repoDir, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(JSON.stringify(settings)).toContain('check-gstack.cjs');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).not.toContain('$');
  });

  test('gstack absent: exits 2 (blocking) with schema-valid deny JSON', () => {
    const { status, stdout, stderr } = runHook(fakeHomeAbsent);
    expect(status).toBe(2);
    expect(stderr).toContain('BLOCKED: gstack is not installed globally.');

    const payload = JSON.parse(stdout.trim());
    expect(payload.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(payload.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(typeof payload.hookSpecificOutput.permissionDecisionReason).toBe('string');
    // The old top-level shape must be gone, not just supplemented.
    expect(payload.permissionDecision).toBeUndefined();
    expect(payload.message).toBeUndefined();
  });

  test('gstack present: exits 0 with an empty (no-opinion) payload', () => {
    const { status, stdout, stderr } = runHook(fakeHomePresent);
    expect(status).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout.trim())).toEqual({});
  });
});

// #3319: when the launcher itself cannot run, the hook prints nothing and exits
// with neither 0 nor 2, which Claude Code treats as a non-blocking error. The
// handler is registered with onFailure: block (Claude Code 2.1.295+) so those
// failures block the Skill call instead of letting it through.
describe('gstack-team-init required: the hook fails closed (#3319)', () => {
  let repo: string;
  let home: string;
  let noNodeBin: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-team-init-closed-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-team-init-closed-home-'));
    noNodeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-team-init-no-node-'));
  });

  afterEach(() => {
    for (const dir of [repo, home, noNodeBin]) fs.rmSync(dir, { recursive: true, force: true });
  });

  const init = () => execFileSync(TEAM_INIT, ['required'], { cwd: repo, encoding: 'utf-8', timeout: 30_000 });
  const settingsPath = () => path.join(repo, '.claude', 'settings.json');
  const ourHandlers = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')).hooks.PreToolUse
    .flatMap((e: { hooks: { command: string }[] }) => e.hooks)
    .filter((h: { command: string }) => h.command.includes('check-gstack'));

  function runRegistered(pathEnv: string): { status: number; stdout: string } {
    const [{ command }] = ourHandlers();
    try {
      const stdout = execSync(command, {
        env: { PATH: pathEnv, HOME: home, CLAUDE_PROJECT_DIR: repo },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      return { status: 0, stdout };
    } catch (err) {
      const e = err as { status: number; stdout: string };
      return { status: e.status, stdout: e.stdout };
    }
  }

  test('the check-gstack handler is registered with onFailure: block', () => {
    init();
    const handlers = ourHandlers();
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toEqual({ type: 'command', command: handlers[0].command, onFailure: 'block' });
  });

  test('node missing from PATH: no output and exit 127, a failure only onFailure turns into a block', () => {
    init();
    const { status, stdout } = runRegistered(noNodeBin);
    expect(status).toBe(127);
    expect(stdout).toBe('');
  });

  test('check-gstack.cjs missing: no output and exit 1, a failure only onFailure turns into a block', () => {
    init();
    fs.rmSync(path.join(repo, '.claude', 'hooks', 'check-gstack.cjs'));
    const { status, stdout } = runRegistered(process.env.PATH!);
    expect(status).toBe(1);
    expect(stdout).toBe('');
  });

  test('re-running upgrades a handler registered without onFailure, keeping one handler', () => {
    init();
    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
    const [{ command }] = ourHandlers();
    settings.hooks.PreToolUse = [{ matcher: 'Skill|skill', hooks: [{ type: 'command', command }] }];
    fs.writeFileSync(settingsPath(), JSON.stringify(settings));

    const out = init();
    expect(ourHandlers()).toEqual([{ type: 'command', command, onFailure: 'block' }]);
    expect(out).toContain('Claude Code 2.1.295 or later');
  });
});
