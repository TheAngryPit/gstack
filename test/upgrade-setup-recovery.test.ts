import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dir, '..');
const template = readFileSync(join(root, 'gstack-upgrade/SKILL.md.tmpl'), 'utf8');
const updater = readFileSync(join(root, 'bin/gstack-session-update'), 'utf8');

describe('upgrade setup recovery ownership', () => {
  test('the skill passes the exact accepted SHA to the transactional updater', () => {
    expect(template).toContain('UPGRADE_AVAILABLE <old> <new> <sha>');
    expect(template).toContain('--apply-candidate "<sha from UPGRADE_AVAILABLE>"');
    expect(template).toMatch(/rollback\/recovery\s+failure/);
    expect(template).toContain('preserve the transaction snapshot path');

    const commands = [...template.matchAll(/^(`{3,}|~{3,})bash\n([\s\S]*?)\n\1$/gm)].map(match => match[2]);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).not.toMatch(/\bgit\s+(pull|reset|stash|fetch|clone|checkout|merge)\b/);
      expect(command).not.toMatch(/\b(mktemp|mv|rm\s+-rf)\b/);
    }
  });

  test('the updater snapshots source and registered runtimes before fast-forward activation', () => {
    const snapshot = updater.indexOf('cp -a "$GSTACK_DIR" "$txn/source-old"');
    const runtimeSnapshot = updater.indexOf('if ! snapshot_registered_runtime;');
    const prepared = updater.indexOf('write_journal prepared "$from" "$target" "$txn"');
    const activate = updater.indexOf('git -C "$GSTACK_DIR" merge --ff-only "$target"');
    expect(snapshot).toBeGreaterThan(-1);
    expect(runtimeSnapshot).toBeGreaterThan(snapshot);
    expect(prepared).toBeGreaterThan(runtimeSnapshot);
    expect(activate).toBeGreaterThan(prepared);
  });

  test('an interrupted or failed activation retains a recovery path and source snapshot', () => {
    expect(updater).toContain('install_recovery_runner ||');
    expect(updater).toContain('recover_interrupted_transaction ||');
    expect(updater).toContain('rollback_transaction "$txn" "$from" "$target"');
    expect(updater).toContain('--recover-interrupted');
    expect(updater).toContain('ROLLBACK_FAILED runtime_restore_failed snapshot=$txn');
  });
});
