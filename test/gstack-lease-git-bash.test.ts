/**
 * #3330: gstack-lease took its lock with `ln -s <holder token> .lock`. Git
 * for Windows' default symlink mode (MSYS unset) cannot link to a target that
 * does not exist, so the lock was never taken and every skill start waited out
 * 300 tries (one report: 499 s) and still wrote no lease. The lock is now a
 * directory (mkdir) with an owner file. test/gstack-lease.test.ts pins the full
 * contract but is POSIX-bound (mode bits, sleep children), so this file is the
 * one the curated windows-free-tests lane runs: it launches the bin through
 * lib/script-invocation.ts, which is Git Bash on windows-latest.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BIN_DIR, runBashSync, runScriptSync } from '../lib/script-invocation';

const LEASE = path.join(BIN_DIR, 'gstack-lease');
const fwd = (p: string) => p.replace(/\\/g, '/');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// No inherited lease dir from the test preload, and Git Bash's default symlink mode (no winsymlinks).
const { GSTACK_LEASE_DIR: _preload, MSYS: _msys, CYGWIN: _cygwin, GSTACK_LEASE_LOCK_TRIES: _tries, ...baseEnv } = process.env as Record<string, string>;

function checkout() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lease-gb-')));
  dirs.push(dir);
  const r = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return { dir, leases: path.join(dir, '.git', 'gstack-leases') };
}

/** A BASH_ENV file in which `ln -s` behaves as Git Bash's default: linking to a missing target fails. */
function gitBashLn(dir: string): string {
  const file = path.join(dir, 'git-bash-ln.sh');
  fs.writeFileSync(file, 'ln() { if [ "$1" = -s ] && [ ! -e "$2" ]; then echo "ln: failed to create symbolic link \'$3\': No such file or directory" >&2; return 1; fi; command ln "$@"; }\n');
  return file;
}

/** A BASH_ENV file that logs every `sleep` (one per failed lock try) to $WAITS. */
function sleepLog(dir: string): string {
  const file = path.join(dir, 'sleep-log.sh');
  fs.writeFileSync(file, 'sleep() { echo "$*" >> "$WAITS"; command sleep "$@"; }\n');
  return file;
}

describe('gstack-lease under Git Bash semantics (#3330)', () => {
  test('touch takes the lock on its first try with the default tries and writes the lease, leaving no lock behind', () => {
    const { dir, leases } = checkout();
    const waits = path.join(dir, 'waits.log');
    const r = runScriptSync(LEASE, ['touch', '--root', fwd(dir), '--pid', '4242'], { encoding: 'utf8', env: { ...baseEnv, BASH_ENV: fwd(sleepLog(dir)), WAITS: fwd(waits) }, timeout: 120_000 });
    expect(r.status, `${r.error ?? ''}${r.stdout}${r.stderr}`).toBe(0);
    expect(fs.existsSync(waits), 'lock() slept between tries').toBe(false);
    expect(fs.readdirSync(leases)).toEqual(['4242']);
  });

  test('a host whose ln -s cannot link to a missing target still takes the lock (negative control: the shim really fails ln -s)', () => {
    const { dir, leases } = checkout();
    const shim = gitBashLn(dir);
    const probe = runBashSync('ln -s "1 2" "$PROBE"', { encoding: 'utf8', env: { ...baseEnv, BASH_ENV: fwd(shim), PROBE: fwd(path.join(dir, 'probe')) }, timeout: 30_000 });
    expect(probe.status, `${probe.error ?? ''}${probe.stderr}`).not.toBe(0);
    expect(probe.stderr).toContain('failed to create symbolic link');
    const r = runScriptSync(LEASE, ['touch', '--root', fwd(dir), '--pid', '4243'], { encoding: 'utf8', env: { ...baseEnv, BASH_ENV: fwd(shim), GSTACK_LEASE_LOCK_TRIES: '3' }, timeout: 120_000 });
    expect(r.status, `${r.error ?? ''}${r.stdout}${r.stderr}`).toBe(0);
    expect(fs.readdirSync(leases)).toEqual(['4243']);
  });

  test('a lock held by a live Git Bash process is kept (touch exits 3 naming it); a dead holder\'s lock is broken', () => {
    const { dir, leases } = checkout();
    const script = [
      'set -u',
      'mkdir -p "$LEASES/.lock" && printf "%s \\n" "$$" > "$LEASES/.lock/owner"',
      'GSTACK_LEASE_LOCK_TRIES=2 bash "$LEASE" touch --root "$ROOT" --pid 4244; echo "held=$? holder=$$ owner=$(head -1 "$LEASES/.lock/owner")"',
      '( exit 0 ) & dead=$!; wait "$dead"',
      'printf "%s \\n" "$dead" > "$LEASES/.lock/owner"',
      'GSTACK_LEASE_LOCK_TRIES=2 bash "$LEASE" touch --root "$ROOT" --pid 4245; echo "dead=$?"',
    ].join('\n');
    const r = runBashSync(script, {
      encoding: 'utf8', timeout: 120_000,
      env: { ...baseEnv, LEASE: fwd(LEASE), ROOT: fwd(dir), LEASES: fwd(leases) },
    });
    const out = `${r.error ?? ''}${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(0);
    const holder = /held=(\d+) holder=(\d+) owner=(\d+)/.exec(r.stdout);
    expect(holder?.[1], out).toBe('3');
    expect(holder?.[3], out).toBe(holder?.[2]);
    expect(r.stderr).toContain(`locked by live process ${holder?.[2]}`);
    expect(r.stdout, out).toContain('dead=0');
    expect(fs.readdirSync(leases).sort()).toEqual(['4245']);
  });
});
