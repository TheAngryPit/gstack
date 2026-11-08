/**
 * gstack-config proactive (GSTA-93 fix 12, Garry 2026-10-25 "do it"): core | all | off,
 * default core. core auto-invokes only /office-hours, /review, /qa and /ship; all
 * auto-invokes any matching skill; off suggests nothing. true and false, which
 * every pre-core config and the old one-time prompt wrote, still work as all and
 * off. An unknown value warns and stores core.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runBin } from './helpers/run-bin';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN_CONFIG = path.join(ROOT, 'bin', 'gstack-config');

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-proactive-cfg-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function run(args: string[]) {
  return runBin(BIN_CONFIG, args, { gstackHome: tmpHome, cwd: ROOT, trim: true });
}

describe('gstack-config proactive', () => {
  test('defaults to core, in get, list and defaults', () => {
    expect(run(['get', 'proactive']).stdout).toBe('core');
    expect(run(['defaults']).stdout).toMatch(/proactive:\s+core$/m);
    expect(run(['list']).stdout).toMatch(/proactive:\s+core \(default\)$/m);
  });

  test('accepts core, all and off, and stores each verbatim', () => {
    for (const value of ['all', 'off', 'core']) {
      expect(run(['set', 'proactive', value]).status).toBe(0);
      expect(run(['get', 'proactive']).stdout).toBe(value);
      expect(run(['list']).stdout).toMatch(new RegExp(`proactive:\\s+${value} \\(set\\)$`, 'm'));
    }
  });

  test('true and false keep working as the pre-core spellings of all and off', () => {
    expect(run(['set', 'proactive', 'true']).status).toBe(0);
    expect(run(['get', 'proactive']).stdout).toBe('true');
    expect(run(['set', 'proactive', 'false']).status).toBe(0);
    expect(run(['get', 'proactive']).stdout).toBe('false');
  });

  test('an upper-case opt-out stores off, not core (set is case-insensitive like skill-start)', () => {
    const r = run(['set', 'proactive', 'OFF']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(run(['get', 'proactive']).stdout).toBe('off');
  });

  test('the YAML yes/no family maps to all/off on set (an opt-out never fails open)', () => {
    for (const [value, stored] of [['no', 'off'], ['None', 'off'], ['0', 'off'], ['disabled', 'off'], ['yes', 'all'], ['on', 'all'], ['1', 'all']]) {
      const r = run(['set', 'proactive', value]);
      expect(r.status, value).toBe(0);
      expect(r.stderr, value).toBe('');
      expect(run(['get', 'proactive']).stdout, value).toBe(stored);
    }
  });

  test('an unknown value warns and stores core (negative control: maybe is not a value)', () => {
    run(['set', 'proactive', 'off']);
    const junk = run(['set', 'proactive', 'maybe']);
    expect(junk.status).toBe(0);
    expect(junk.stderr).toContain("proactive 'maybe' not recognized");
    expect(junk.stderr).toContain('core, all, off');
    expect(run(['get', 'proactive']).stdout).toBe('core');
  });
});
