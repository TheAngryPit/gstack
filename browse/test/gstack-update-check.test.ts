/**
 * Tests for bin/gstack-update-check bash script.
 *
 * Uses Bun.spawnSync to invoke the script with temp dirs and
 * GSTACK_DIR / GSTACK_STATE_DIR overrides and a deterministic candidate fixture
 * for full isolation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync, symlinkSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';

const SCRIPT = join(import.meta.dir, '..', '..', 'bin', 'gstack-update-check');

let gstackDir: string;
let stateDir: string;
let localSha: string;

const candidateSha = (version: string) => createHash('sha1').update(`gstack-test-candidate:${version}`).digest('hex');
const publicUpgrade = (oldVersion: string, newVersion: string) => `UPGRADE_AVAILABLE ${oldVersion} ${newVersion} ${candidateSha(newVersion)}`;
const cachedUpgrade = (oldVersion: string, newVersion: string) => `${publicUpgrade(oldVersion, newVersion)} ${localSha} trusted\n`;
const cachedUpToDate = (version: string) => `UP_TO_DATE ${version} ${localSha} trusted\n`;
const cachedFailed = (version: string) => `CHECK_FAILED ${version} ${localSha} trusted\n`;

function run(extraEnv: Record<string, string> = {}, args: string[] = []) {
  // gstack-config (which this script shells out to for update_check) resolves
  // state as GSTACK_STATE_ROOT > GSTACK_HOME > GSTACK_STATE_DIR > ~/.gstack.
  // Strip the higher-precedence vars so harness-env leftovers can never
  // outrank the per-test GSTACK_STATE_DIR isolation.
  const env: Record<string, string | undefined> = {
    ...process.env,
    GSTACK_DIR: gstackDir,
    GSTACK_STATE_DIR: stateDir,
    GSTACK_REMOTE_URL: `file://${join(gstackDir, 'REMOTE_VERSION')}`,
  };
  delete env.GSTACK_STATE_ROOT;
  delete env.GSTACK_HOME;
  Object.assign(env, extraEnv); // per-test overrides always win, deliberately
  const result = Bun.spawnSync(['bash', SCRIPT, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

beforeEach(() => {
  gstackDir = mkdtempSync(join(tmpdir(), 'gstack-upd-test-'));
  stateDir = mkdtempSync(join(tmpdir(), 'gstack-state-test-'));
  // Link real gstack-config so update_check config check works
  const binDir = join(gstackDir, 'bin');
  mkdirSync(binDir);
  symlinkSync(join(import.meta.dir, '..', '..', 'bin', 'gstack-config'), join(binDir, 'gstack-config'));
  // v1.63+: the script sources bin/gstack-egress-lib.sh unconditionally
  // (receipted fetch helpers). A real install always has it beside
  // gstack-config; without this link every test failed at the source line —
  // masked until the suite-truncation fix because the runner died first.
  symlinkSync(
    join(import.meta.dir, '..', '..', 'bin', 'gstack-egress-lib.sh'),
    join(binDir, 'gstack-egress-lib.sh'),
  );
  // Same for the state-root twin every migrated bin sources (docs/state-root.md).
  symlinkSync(
    join(import.meta.dir, '..', '..', 'bin', 'gstack-state-root.sh'),
    join(binDir, 'gstack-state-root.sh'),
  );

  // This suite isolates update-check cache and snooze behavior behind a
  // deterministic resolver. Exact GitHub Actions authorization is covered by
  // test/gstack-update-candidate-cli.test.ts.
  execFileSync('git', ['init', '--quiet', gstackDir], { timeout: 30_000 });
  execFileSync('git', ['-C', gstackDir, 'config', 'user.name', 'Gstack Fixture'], { timeout: 30_000 });
  execFileSync('git', ['-C', gstackDir, 'config', 'user.email', 'fixture@example.invalid'], { timeout: 30_000 });
  execFileSync('git', ['-C', gstackDir, 'remote', 'add', 'origin', 'https://github.com/TheAngryPit/gstack.git'], { timeout: 30_000 });
  writeFileSync(join(gstackDir, '.fixture'), 'test install\n');
  execFileSync('git', ['-C', gstackDir, 'add', '.fixture'], { timeout: 30_000 });
  execFileSync('git', ['-C', gstackDir, '-c', 'user.name=Gstack Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { timeout: 30_000 });
  localSha = execFileSync('git', ['-C', gstackDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30_000 }).trim();
  writeFileSync(join(binDir, 'gstack-update-candidate'), `#!/usr/bin/env bash
set -eu
local_version=$(tr -d '[:space:]' < "$GSTACK_DIR/VERSION")
remote_file="$GSTACK_DIR/REMOTE_VERSION"
if [ ! -f "$remote_file" ]; then echo 'UPDATE_FAILED fixture_remote_unavailable'; exit 1; fi
remote_version=$(tr -d '[:space:]' < "$remote_file")
if ! printf '%s' "$remote_version" | grep -qE '^[0-9]+([.][0-9]+)+$'; then echo 'UPDATE_FAILED fixture_remote_invalid'; exit 1; fi
local_sha=$(git -C "$GSTACK_DIR" rev-parse HEAD)
if [ "$local_version" = "$remote_version" ] || [ "$(printf '%s\\n%s\\n' "$local_version" "$remote_version" | sort -V | tail -1)" != "$remote_version" ]; then
  echo "UP_TO_DATE $local_version $local_sha"
  exit 0
fi
candidate_sha=$(printf 'gstack-test-candidate:%s' "$remote_version" | shasum -a 1 | awk '{print $1}')
echo "UPGRADE_AVAILABLE $local_version $remote_version $candidate_sha"
`, { mode: 0o755 });
});

afterEach(() => {
  rmSync(gstackDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function writeSnooze(sha: string, level: number, epochSeconds: number) {
  writeFileSync(join(stateDir, 'update-snoozed'), `${sha} ${level} ${epochSeconds}`);
}

function writeConfig(content: string) {
  writeFileSync(join(stateDir, 'config.yaml'), content);
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

describe('gstack-update-check', () => {
  // ─── Path A: No VERSION file ────────────────────────────────
  test('exits 0 with no output when VERSION file is missing', () => {
    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // ─── Path B: Empty VERSION file ─────────────────────────────
  test('exits 0 with no output when VERSION file is empty', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '');
    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // ─── Path C: Just-upgraded marker ───────────────────────────
  test('outputs JUST_UPGRADED and deletes marker', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.4.0\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'just-upgraded-from'), '0.3.3\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('JUST_UPGRADED 0.3.3 0.4.0');
    // Marker should be deleted
    expect(existsSync(join(stateDir, 'just-upgraded-from'))).toBe(false);
    // Cache should be written
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── Path C2: Just-upgraded marker + newer remote ──────────
  test('just-upgraded marker does not mask newer remote version', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'just-upgraded-from'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.5.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    // Should output both the just-upgraded notice AND the new upgrade
    expect(stdout).toContain('JUST_UPGRADED 0.3.3 0.4.0');
    expect(stdout).toContain(publicUpgrade('0.4.0', '0.5.0'));
    // Cache should reflect the upgrade available, not UP_TO_DATE
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain(publicUpgrade('0.4.0', '0.5.0'));
  });

  // ─── Path C3: Just-upgraded marker + remote matches local ──
  test('just-upgraded with no further updates writes UP_TO_DATE cache', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'just-upgraded-from'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('JUST_UPGRADED 0.3.3 0.4.0');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── Path D1: Fresh cache, UP_TO_DATE ───────────────────────
  test('exits silently when cache says UP_TO_DATE and is fresh', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpToDate('0.3.3'));

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // ─── Path D1b: Fresh UP_TO_DATE cache, but local version changed ──
  test('re-checks when UP_TO_DATE cache version does not match local', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.4.0\n');
    // Cache says UP_TO_DATE for 0.3.3, but local is now 0.4.0
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpToDate('0.3.3'));
    // Candidate resolver says 0.5.0 — should detect upgrade
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.5.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(publicUpgrade('0.4.0', '0.5.0'));
  });

  // ─── Path D2: Fresh cache, UPGRADE_AVAILABLE ────────────────
  test('echoes cached UPGRADE_AVAILABLE when cache is fresh', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpgrade('0.3.3', '0.4.0'));

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(publicUpgrade('0.3.3', '0.4.0'));
  });

  test('cached manual-origin status hides cache-only metadata', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    execFileSync('git', ['-C', gstackDir, 'remote', 'set-url', 'origin', 'https://github.com/garrytan/gstack.git'], { timeout: 30_000 });
    writeFileSync(join(stateDir, 'last-update-check'),
      `MANUAL_UPGRADE_AVAILABLE 0.3.3 0.4.0 0.4.0 ${localSha} garrytan/gstack\n`);

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('MANUAL_UPGRADE_AVAILABLE 0.3.3 0.4.0 0.4.0 garrytan/gstack');
  });

  // ─── Path D3: Fresh cache, but local version changed ────────
  test('re-checks when local version does not match cached old version', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.4.0\n');
    // Cache says 0.3.3 → 0.4.0 but we're already on 0.4.0
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpgrade('0.3.3', '0.4.0'));
    // Remote also says 0.4.0 — should be up to date
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(''); // Up to date after re-check
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── Path E: Versions match (remote fetch) ─────────────────
  test('writes UP_TO_DATE cache when versions match', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.3.3\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── Path F: Versions differ (remote fetch) ─────────────────
  test('outputs UPGRADE_AVAILABLE when versions differ', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(publicUpgrade('0.3.3', '0.4.0'));
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain(publicUpgrade('0.3.3', '0.4.0'));
  });

  // ─── Path G: Invalid remote response ────────────────────────
  // #2786: an unreadable remote version is UNKNOWN, never cached as UP_TO_DATE.
  test('caches an invalid candidate response as CHECK_FAILED, silently', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '<html>404 Not Found</html>\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toBe(cachedFailed('0.3.3'));
    expect(cache).not.toContain('UP_TO_DATE');
  });

  // ─── Path H: Curl fails (bad URL) ──────────────────────────
  test('caches CHECK_FAILED when the trusted candidate resolver is unavailable, silently', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');

    const { exitCode, stdout } = run({
      GSTACK_REMOTE_URL: 'file:///nonexistent/path/VERSION',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toBe(cachedFailed('0.3.3'));
  });

  test('a fresh CHECK_FAILED replays silently without re-fetching', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedFailed('0.3.3'));
    // A remote that WOULD report an upgrade proves no fetch happened.
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(readFileSync(join(stateDir, 'last-update-check'), 'utf-8')).toStartWith('CHECK_FAILED');
  });

  test('an expired CHECK_FAILED (short TTL) re-fetches and can surface an upgrade', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    const cachePath = join(stateDir, 'last-update-check');
    writeFileSync(cachePath, cachedFailed('0.3.3'));
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(cachePath, old, old);
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(publicUpgrade('0.3.3', '0.4.0'));
  });

  test('--force reports resolver failure without exposing URL-shaped overrides', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');

    const { exitCode, stdout } = run(
      // Assembled at runtime so no credential-shaped URL literal is pushed.
      { GSTACK_REMOTE_URL: ['https://bob', ':s3cr3t-token', '@127.0.0.1:9/VERSION'].join('') },
      ['--force'],
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      'CHECK_FAILED trusted gstack update is deferred: fixture_remote_unavailable — update status UNKNOWN, not up-to-date',
    );
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).not.toContain('s3cr3t-token');
    expect(cache).not.toContain('bob');
  });

  // ─── Path I: Corrupt cache file ─────────────────────────────
  test('falls through to remote fetch when cache is corrupt', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'garbage data here');
    // Candidate resolver says same version — should end up UP_TO_DATE
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.3.3\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    // Cache should be overwritten with valid content
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── State dir creation ─────────────────────────────────────
  test('creates state dir if it does not exist', () => {
    const newStateDir = join(stateDir, 'nested', 'dir');
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.3.3\n');

    const { exitCode } = run({ GSTACK_STATE_DIR: newStateDir });
    expect(exitCode).toBe(0);
    expect(existsSync(join(newStateDir, 'last-update-check'))).toBe(true);
  });

  // ─── E2E regression: always exit 0 ───────────────────────────
  // Agents call this on every skill invocation. Exit code 1 breaks
  // the preamble and confuses the agent. This test guards against
  // regressions like the "exits 1 when up to date" bug.
  test('exits 0 with real project VERSION and unreachable remote', () => {
    // Simulate agent context: real VERSION file, network unavailable
    const projectRoot = join(import.meta.dir, '..', '..');
    const versionFile = join(projectRoot, 'VERSION');
    const version = readFileSync(versionFile, 'utf-8').trim();

    // Copy VERSION into test dir
    writeFileSync(join(gstackDir, 'VERSION'), version + '\n');

    // No fixture candidate is available, simulating an offline update check
    const { exitCode, stdout } = run({
      GSTACK_REMOTE_URL: 'file:///nonexistent/path/VERSION',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    // Should cache an unknown result (not crash, and not claim up-to-date: #2786)
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toBe(cachedFailed(version));
  });

  test('exits 0 when up to date (not exit 1)', () => {
    // Regression test: script previously exited 1 when versions matched.
    // This broke every skill preamble that called it without || true.
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.3.3\n');

    // First call: fetches remote, writes cache
    const first = run();
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe('');

    // Second call: reads fresh cache
    const second = run();
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe('');

    // Third call with upgrade available: still exit 0
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    rmSync(join(stateDir, 'last-update-check')); // force re-fetch
    const third = run();
    expect(third.exitCode).toBe(0);
    expect(third.stdout).toBe(publicUpgrade('0.3.3', '0.4.0'));
  });

  // ─── Snooze tests ───────────────────────────────────────────
  test('snoozed level 1 within 24h → silent (cached path)', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpgrade('0.3.3', '0.4.0'));
    writeSnooze(candidateSha('0.4.0'), 1, nowEpoch() - 3600); // 1h ago (within 24h)

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('snoozed level 1 expired (25h ago) → outputs UPGRADE_AVAILABLE', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpgrade('0.3.3', '0.4.0'));
    writeSnooze(candidateSha('0.4.0'), 1, nowEpoch() - 90000); // 25h ago

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(publicUpgrade('0.3.3', '0.4.0'));
  });

  test('snoozed level 2 within 48h → silent', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpgrade('0.3.3', '0.4.0'));
    writeSnooze(candidateSha('0.4.0'), 2, nowEpoch() - 86400); // 24h ago (within 48h)

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('snoozed level 2 expired (49h ago) → outputs', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpgrade('0.3.3', '0.4.0'));
    writeSnooze(candidateSha('0.4.0'), 2, nowEpoch() - 176400); // 49h ago

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(publicUpgrade('0.3.3', '0.4.0'));
  });

  test('snoozed level 3 within 7d → silent', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpgrade('0.3.3', '0.4.0'));
    writeSnooze(candidateSha('0.4.0'), 3, nowEpoch() - 518400); // 6d ago (within 7d)

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('snoozed level 3 expired (8d ago) → outputs', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpgrade('0.3.3', '0.4.0'));
    writeSnooze(candidateSha('0.4.0'), 3, nowEpoch() - 691200); // 8d ago

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(publicUpgrade('0.3.3', '0.4.0'));
  });

  test('snooze ignored when version differs (new version resets snooze)', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpgrade('0.3.3', '0.5.0'));
    // Snoozed for 0.4.0, but remote is now 0.5.0
    writeSnooze(candidateSha('0.4.0'), 3, nowEpoch() - 60); // very recent

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(publicUpgrade('0.3.3', '0.5.0'));
  });

  test('corrupt snooze file → outputs normally', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpgrade('0.3.3', '0.4.0'));
    writeFileSync(join(stateDir, 'update-snoozed'), 'garbage');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(publicUpgrade('0.3.3', '0.4.0'));
  });

  test('non-numeric epoch in snooze file → outputs', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpgrade('0.3.3', '0.4.0'));
    writeFileSync(join(stateDir, 'update-snoozed'), candidateSha('0.4.0') + ' 1 abc');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(publicUpgrade('0.3.3', '0.4.0'));
  });

  test('non-numeric level in snooze file → outputs', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpgrade('0.3.3', '0.4.0'));
    writeFileSync(join(stateDir, 'update-snoozed'), candidateSha('0.4.0') + ' abc ' + nowEpoch());

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(publicUpgrade('0.3.3', '0.4.0'));
  });

  test('snooze respected on remote fetch path (no cache)', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    // No cache file — goes to remote fetch path
    writeSnooze(candidateSha('0.4.0'), 1, nowEpoch() - 3600); // 1h ago

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    // Cache should still be written
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain(publicUpgrade('0.3.3', '0.4.0'));
  });

  test('just-upgraded clears snooze file', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'just-upgraded-from'), '0.3.3\n');
    writeSnooze(candidateSha('0.4.0'), 2, nowEpoch() - 3600);

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('JUST_UPGRADED 0.3.3 0.4.0');
    expect(existsSync(join(stateDir, 'update-snoozed'))).toBe(false);
  });

  // ─── Config tests ──────────────────────────────────────────
  test('update_check: false disables all checks', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    writeConfig('update_check: false\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    // No cache should be written
    expect(existsSync(join(stateDir, 'last-update-check'))).toBe(false);
  });

  test('missing config.yaml does not crash', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    // No config file — should use the isolated candidate resolver normally

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(publicUpgrade('0.3.3', '0.4.0'));
  });

  // ─── --force flag tests ──────────────────────────────────────

  test('--force busts fresh UP_TO_DATE cache', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpToDate('0.3.3'));

    // Without --force: cache hit, silent
    const cached = run();
    expect(cached.stdout).toBe('');

    // With --force: cache busted, re-resolves the candidate, finds upgrade
    const forced = run({}, ['--force']);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toBe(publicUpgrade('0.3.3', '0.4.0'));
  });

  test('--force busts fresh UPGRADE_AVAILABLE cache', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpgrade('0.3.3', '0.4.0'));

    // Without --force: cache hit, outputs stale upgrade
    const cached = run();
    expect(cached.stdout).toBe(publicUpgrade('0.3.3', '0.4.0'));

    // With --force: cache busted, re-resolves the candidate, now up to date
    const forced = run({}, ['--force']);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  test('--force clears snooze so user can upgrade after snoozing', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    writeSnooze(candidateSha('0.4.0'), 1, nowEpoch() - 60); // snoozed 1 min ago (within 24h)

    // Without --force: snoozed, silent
    const snoozed = run();
    expect(snoozed.exitCode).toBe(0);
    expect(snoozed.stdout).toBe('');

    // With --force: snooze cleared, outputs upgrade
    const forced = run({}, ['--force']);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toBe(publicUpgrade('0.3.3', '0.4.0'));
    // Snooze file should be deleted
    expect(existsSync(join(stateDir, 'update-snoozed'))).toBe(false);
  });

  // ─── Split TTL tests ─────────────────────────────────────────

  // ─── Semver-order guard ─────────────────────────────────────
  // When the upstream raw CDN serves a stale (older) VERSION right after a
  // release, the script previously emitted a backwards UPGRADE_AVAILABLE
  // line. The guard treats REMOTE < LOCAL as up-to-date.

  test('remote older than local (stale CDN) → silent, cache UP_TO_DATE', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '1.34.0.0\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '1.33.2.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain(cachedUpToDate('1.34.0.0'));
  });

  test('multi-segment sort: 1.9.0.0 < 1.10.0.0', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '1.9.0.0\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '1.10.0.0\n');

    const { stdout } = run();
    expect(stdout).toBe(publicUpgrade('1.9.0.0', '1.10.0.0'));
  });

  test('multi-segment reverse sort: 1.10.0.0 > 1.9.0.0 → no rewind', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '1.10.0.0\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '1.9.0.0\n');

    const { stdout } = run();
    expect(stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain(cachedUpToDate('1.10.0.0'));
  });

  test('UP_TO_DATE cache expires after 60 min (not 720)', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'last-update-check'), cachedUpToDate('0.3.3'));

    // Set cache mtime to 90 minutes ago (past 60-min TTL)
    const ninetyMinAgo = new Date(Date.now() - 90 * 60 * 1000);
    const cachePath = join(stateDir, 'last-update-check');
    utimesSync(cachePath, ninetyMinAgo, ninetyMinAgo);

    // Cache should be stale at 60-min TTL, re-fetches and finds upgrade
    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(publicUpgrade('0.3.3', '0.4.0'));
  });
});
