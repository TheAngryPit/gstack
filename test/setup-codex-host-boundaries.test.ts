import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dir, '..');
const setup = readFileSync(resolve(root, 'setup'), 'utf8');
const bash = process.platform === 'win32'
  ? process.env.PATH?.split(delimiter).map(directory => join(directory, 'bash.exe')).find(existsSync) ?? 'bash'
  : 'bash';

test('setup remains syntactically valid', () => {
  expect(spawnSync(bash, ['-n', resolve(root, 'setup')]).status).toBe(0);
});

test('setup defaults to status and only explicit installation writes synthetic hook definitions', () => {
  expect(setup).toContain('CODEX_HOOKS_ACTION="status"');
  expect(setup).toContain('--codex-hooks) CODEX_HOOKS_ACTION="install"');
  const start = setup.indexOf('  # Native lifecycle inspection only');
  const end = setup.indexOf('\nfi\n\n# 6.', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const fixture = mkdtempSync(join(tmpdir(), 'gstack-codex-setup-hook-'));
  const config = join(fixture, 'hooks.json');
  const script = `log() { :; }\nbun_cmd() { "$BUN_BIN" "$@"; }\n${setup.slice(start, end)}`;
  try {
    for (const action of ['status', 'install']) {
      const result = spawnSync(bash, ['-eu', '-c', script], {
        encoding: 'utf8', timeout: 5000,
        env: { PATH: '/usr/bin:/bin', BUN_BIN: process.execPath, CODEX_HOME: fixture,
          SOURCE_GSTACK_DIR: root, CODEX_GSTACK: root, CODEX_HOOKS_ACTION: action },
      });
      expect(result.status).toBe(0);
      expect(existsSync(config)).toBe(action === 'install');
    }
    const hooks = JSON.parse(readFileSync(config, 'utf8'));
    expect(Object.keys(hooks.hooks)).toHaveLength(5);
    expect(JSON.stringify(hooks)).not.toContain('trusted');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('minimal Codex runtime includes native lifecycle assets without Claude assets', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'gstack-codex-assets-'));
  const source = join(fixture, 'source');
  const target = join(fixture, 'runtime');
  mkdirSync(join(source, 'hosts/codex/hooks'), { recursive: true });
  mkdirSync(join(source, 'hosts/claude/hooks'), { recursive: true });
  writeFileSync(join(source, 'hosts/codex/hooks/native-hook'), 'codex lifecycle asset');
  const start = setup.indexOf('create_codex_runtime_root() {');
  const end = setup.indexOf('\n}', start) + 2;
  const linkDistsStart = setup.indexOf('_link_runtime_dists() {');
  const linkDistsEnd = setup.indexOf('\n}', linkDistsStart) + 2;
  const linkDists = setup.slice(linkDistsStart, linkDistsEnd);
  try {
    const result = spawnSync(bash, ['-eu', '-c', `_link_or_copy() { ln -s "$1" "$2"; }\n${linkDists}\n${setup.slice(start, end)}\ncreate_codex_runtime_root "$1" "$2"`, 'fixture', source, target], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', IS_WINDOWS: '0' }, timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(readFileSync(join(target, 'hosts/codex/hooks/native-hook'), 'utf8')).toBe('codex lifecycle asset');
    expect(existsSync(join(target, 'hosts/claude'))).toBe(false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

for (const [first, last] of [
  ['if [ "$INSTALL_CLAUDE" -eq 1 ]; then\nSETTINGS_HOOK=', 'fi # INSTALL_CLAUDE: canonical hook healing and team hooks'],
  ['if [ "$INSTALL_CLAUDE" -eq 1 ]; then\nDETECT_BIN=', 'fi # INSTALL_CLAUDE: legacy GBrain detection and render'],
  ['if [ "$INSTALL_CLAUDE" -eq 1 ]; then\n# 11.', 'fi # INSTALL_CLAUDE: question and timeline hooks'],
]) {
  test(`Codex-only setup does not enter ${last.split(': ')[1]}`, () => {
    const start = setup.indexOf(first);
    const end = setup.indexOf(last, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = setup.slice(start, end + last.length);
    // Unset source/home variables plus nounset fail before any accidental
    // invocation if the host guard regresses. No real config/home is touched.
    const result = spawnSync(bash, ['-u', '-s'], {
      input: `INSTALL_CLAUDE=0\n${block}`,
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
}
