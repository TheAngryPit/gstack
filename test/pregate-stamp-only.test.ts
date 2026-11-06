/**
 * pregate version-stamp-only (lib/pregate/stamp-only.ts, lib/pregate/lane-selection.ts):
 * a release manifest whose diff against the merge base changes only its
 * version values needs no test lane, so a restamp PR on a base whose
 * .gstack/pregate.json declares no lane for its manifests no longer fails
 * `lanes` with PREGATE_NO_LANE (gbrain #7625, #7606). A manifest whose other
 * content changed, one added, deleted or renamed, or one a test reads, keeps
 * its lane or its failure.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { stampFileKind, VERSION_TOKEN, versionStampOnly } from '../lib/pregate/stamp-only';
import { cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = (opts?: Parameters<typeof makeFixtureRepo>[0]) => { const r = makeFixtureRepo(opts); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const pregate = (repo: FixtureRepo, args: string[] = []) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', ...args]);
const lanes = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: any) => c.id === 'lanes');
const WAIVER = 'lanes: version-stamp-only (no lane needed): ';

const manifest = (version: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'gbrain', version, description: 'Personal knowledge brain', author: { name: 'Garry Tan' }, ...extra }, null, 2) + '\n';
const j = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

describe('versionStampOnly (pure)', () => {
  test('VERSION_TOKEN accepts bare versions and refuses ranges, words and dates', () => {
    for (const ok of ['1.2', '1.2.3', 'v1.2.3', '0.60.462.0', '1.2.3-rc.1', '1.2.3+build.7']) expect(VERSION_TOKEN.test(ok)).toBe(true);
    for (const no of ['^1.2.3', '~1.2.3', '>=1.2.3', '1', '1.2.3.4.5', 'latest', '1.2.3 ', 'v', '2026-10-26']) expect(VERSION_TOKEN.test(no)).toBe(false);
  });

  test('file kinds: JSON, plist and VERSION files (VERSION, VERSION.txt, version.txt, any case); nothing else', () => {
    expect(stampFileKind('.claude-plugin/plugin.json')).toBe('json');
    expect(stampFileKind('openclaw.plugin.json')).toBe('json');
    expect(stampFileKind('ios/App/Info.plist')).toBe('plist');
    expect(stampFileKind('VERSION')).toBe('version');
    expect(stampFileKind('packages/core/VERSION.txt')).toBe('version');
    expect(stampFileKind('version.txt')).toBe('version');
    expect(stampFileKind('sub\\dir\\Version')).toBe('version');
    for (const other of ['package-lock.json.bak', 'src/version.ts', 'Cargo.toml', 'pyproject.toml', 'CHANGELOG.md', 'llms-full.txt', 'versions', 'VERSIONS']) expect(stampFileKind(other)).toBeNull();
  });

  test('a JSON manifest whose only change is its top-level version value is stamp-only, naming the change; nothing nested qualifies', () => {
    expect(versionStampOnly('.claude-plugin/plugin.json', manifest('0.60.462.0'), manifest('0.60.463.0'))).toEqual({ stampOnly: true, changed: ['version 0.60.462.0 → 0.60.463.0'] });
    expect(versionStampOnly('x.json', '{"version":"v1.2.3","b":[1,2]}\n', '{"version":"v1.2.4","b":[1,2]}\n')).toEqual({ stampOnly: true, changed: ['version v1.2.3 → v1.2.4'] });
    expect(versionStampOnly('x.json', j({ plugin: { version: 'v1.2.3' } }), j({ plugin: { version: 'v1.2.4' } }))).toEqual({ stampOnly: false, reason: '.plugin.version changed and is not the top-level `version`' });
    expect(versionStampOnly('x.json', j({ version: '1.0.0', build: { version: '1.0.0' } }), j({ version: '1.0.1', build: { version: '1.0.1' } }))).toEqual({ stampOnly: false, reason: '.build.version changed and is not the top-level `version`' });
    expect(versionStampOnly('x.json', j([{ version: '1.0.0' }]), j([{ version: '1.0.1' }]))).toEqual({ stampOnly: false, reason: 'not a JSON object on both sides' });
    expect(versionStampOnly('x.json', '"1.0.0"', '"1.0.1"')).toEqual({ stampOnly: false, reason: 'not a JSON object on both sides' });
  });

  test('a JSON manifest whose non-version content changed is not stamp-only, with the path in the reason', () => {
    expect(versionStampOnly('p.json', manifest('1.0.0'), manifest('1.0.0', { description: 'Personal knowledge brain, now with RLS' }))).toEqual({ stampOnly: false, reason: '.description changed and its key is not `version`' });
    const mixed = versionStampOnly('p.json', manifest('1.0.0'), manifest('1.0.1', { description: 'changed too' }));
    expect(mixed).toEqual({ stampOnly: false, reason: '.description changed and its key is not `version`' });
    expect(versionStampOnly('p.json', manifest('1.0.0'), manifest('1.0.1', { keywords: ['a'] }))).toEqual({ stampOnly: false, reason: '.keywords added' });
    expect(versionStampOnly('p.json', manifest('1.0.0', { keywords: ['a'] }), manifest('1.0.1'))).toEqual({ stampOnly: false, reason: '.keywords removed' });
    expect(versionStampOnly('p.json', j({ version: '1.0.0', files: ['a', 'b'] }), j({ version: '1.0.1', files: ['b', 'a'] }))).toEqual({ stampOnly: false, reason: '.files[0] changed and its key is not `version`' });
    expect(versionStampOnly('p.json', j({ version: '1.0.0', files: ['a'] }), j({ version: '1.0.1', files: ['a', 'b'] }))).toEqual({ stampOnly: false, reason: '.files changed length (1 → 2)' });
    expect(versionStampOnly('p.json', j({ version: '1.0.0', count: 1 }), j({ version: '1.0.1', count: 2 }))).toEqual({ stampOnly: false, reason: '.count changed and is not a version string' });
    expect(versionStampOnly('p.json', j({ version: '1.0.0', count: 1 }), j({ version: '1.0.1', count: '1' }))).toEqual({ stampOnly: false, reason: '.count changed type (number → string)' });
    expect(versionStampOnly('p.json', j({ version: ['1.0.0'] }), j({ version: ['1.0.1'] }))).toEqual({ stampOnly: false, reason: '.version[0] changed and its key is not `version`' });
  });

  test('a reordered object is not a stamp even with a version bump (conditional exports resolve in key order)', () => {
    const before = j({ version: '1.0.0', exports: { '.': { import: './a.mjs', default: './a.cjs' } } });
    const after = j({ version: '1.0.1', exports: { '.': { default: './a.cjs', import: './a.mjs' } } });
    expect(versionStampOnly('package.json', before, after)).toEqual({ stampOnly: false, reason: '.exports.. keys reordered (import → default at position 0)' });
    expect(versionStampOnly('package.json', j({ name: 'x', version: '1.0.0' }), j({ version: '1.0.1', name: 'x' }))).toEqual({ stampOnly: false, reason: '$ keys reordered (name → version at position 0)' });
  });

  test('a key with a prototype name added, removed or changed is seen (own keys only)', () => {
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(versionStampOnly('p.json', '{"version":"1.0.0"}', `{"version":"1.0.1",${JSON.stringify(k)}:"evil"}`)).toEqual({ stampOnly: false, reason: `.${k} added` });
      expect(versionStampOnly('p.json', `{"version":"1.0.0",${JSON.stringify(k)}:"a"}`, '{"version":"1.0.1"}')).toEqual({ stampOnly: false, reason: `.${k} removed` });
      expect(versionStampOnly('p.json', `{"version":"1.0.0",${JSON.stringify(k)}:"a"}`, `{"version":"1.0.1",${JSON.stringify(k)}:"b"}`)).toEqual({ stampOnly: false, reason: `.${k} changed and its key is not \`version\`` });
    }
    expect(versionStampOnly('p.json', '{"version":"1.0.0","__proto__":{"x":1}}', '{"version":"1.0.1","__proto__":{"x":1}}').stampOnly).toBe(true);
  });

  test('only a key named exactly version qualifies: floors, schema versions, package names and dependency maps are not stamps', () => {
    expect(versionStampOnly('p.json', j({ version: '1.0.0', minHostVersion: '1.0.0' }), j({ version: '1.0.1', minHostVersion: '9.0.0' }))).toEqual({ stampOnly: false, reason: '.minHostVersion changed and its key is not `version`' });
    for (const k of ['schemaVersion', 'apiVersion', 'versionName', 'Version', 'VERSION', 'minimumVersion']) expect(versionStampOnly('p.json', j({ [k]: '1.0.0' }), j({ [k]: '1.0.1' })).stampOnly).toBe(false);
    expect(versionStampOnly('package.json', j({ version: '1.0.0', devDependencies: { 'standard-version': '9.5.0' } }), j({ version: '1.0.1', devDependencies: { 'standard-version': '9.5.1' } }))).toEqual({ stampOnly: false, reason: '.devDependencies.standard-version changed and its key is not `version`' });
    expect(versionStampOnly('package.json', j({ version: '1.0.0', dependencies: { version: '1.2.3' } }), j({ version: '1.0.1', dependencies: { version: '1.2.4' } }))).toEqual({ stampOnly: false, reason: '.dependencies.version changed and is not the top-level `version`' });
    expect(versionStampOnly('package-lock.json', j({ version: '1.0.0', packages: { 'node_modules/lodash': { version: '4.17.20' } } }), j({ version: '1.0.0', packages: { 'node_modules/lodash': { version: '4.17.21' } } }))).toEqual({ stampOnly: false, reason: '.packages.node_modules/lodash.version changed and is not the top-level `version`' });
    expect(versionStampOnly('composer.lock', j({ packages: [{ version: 'v1.0.0' }] }), j({ packages: [{ version: 'v1.0.1' }] })).stampOnly).toBe(false);
    expect(versionStampOnly('package.json', j({ version: '1.0.0', catalog: { version: '1.2.3' } }), j({ version: '1.0.1', catalog: { version: '1.2.4' } })).stampOnly).toBe(false);
    expect(versionStampOnly('.devcontainer/devcontainer.json', j({ features: { 'ghcr.io/x/node:1': { version: '20.1.0' } } }), j({ features: { 'ghcr.io/x/node:1': { version: '22.1.0' } } })).stampOnly).toBe(false);
    expect(versionStampOnly('package.json', j({ version: '1.0.0', engines: { node: '20.0.0' } }), j({ version: '1.0.0', engines: { node: '22.0.0' } })).stampOnly).toBe(false);
    expect(versionStampOnly('package.json', j({ version: '1.0.0', dependencies: { left: '^1.2.3' } }), j({ version: '1.0.1', dependencies: { left: '^1.2.4' } })).stampOnly).toBe(false);
    expect(versionStampOnly('p.json', j({ version: '1.0.0' }), j({ version: 'latest' }))).toEqual({ stampOnly: false, reason: '.version changed and a value is not a bare version ("1.0.0" → "latest")' });
    expect(versionStampOnly('p.json', j({ version: '1.0.0' }), j({ version: '^1.0.1' })).stampOnly).toBe(false);
  });

  test('a change the parser erases is still a change: big integers, duplicate keys, number spellings, a reflow with the stamp', () => {
    expect(versionStampOnly('p.json', '{"version":"1.0.0","id":9007199254740993}', '{"version":"1.0.1","id":9007199254740992}')).toEqual({ stampOnly: false, reason: 'line 1 changed beyond a version value' });
    expect(versionStampOnly('p.json', '{"version":"1.0.0","a":1,"a":2}', '{"version":"1.0.1","a":2}').stampOnly).toBe(false);
    expect(versionStampOnly('p.json', '{"version":"1.0.0","n":1.0}', '{"version":"1.0.1","n":1}').stampOnly).toBe(false);
    expect(versionStampOnly('p.json', '{"version":"1.0.0","s":"\\u0041"}', '{"version":"1.0.1","s":"A"}').stampOnly).toBe(false);
    expect(versionStampOnly('p.json', manifest('1.0.0'), JSON.stringify(JSON.parse(manifest('1.0.1'))))).toEqual({ stampOnly: false, reason: 'line count changed (9 → 1)' });
    expect(versionStampOnly('p.json', '{"version":"1.0.0",\n"name":"x"}', '{"version":"1.0.1",\n"name": "x"}')).toEqual({ stampOnly: false, reason: 'line 2 changed beyond a version value' });
    expect(versionStampOnly('p.json', '{"version":"1.0.0","name":"1.0.0"}', '{"version":"1.0.1","name":"1.0.0"}').stampOnly).toBe(true);
    // A shadowed duplicate key holding the old version on its own line: the parser sees one change, the text has two changed lines.
    expect(versionStampOnly('m.json', '{\n  "description": "1.0.0",\n  "description": "real",\n  "version": "1.0.0"\n}\n', '{\n  "description": "1.0.1",\n  "description": "real",\n  "version": "1.0.1"\n}\n')).toEqual({ stampOnly: false, reason: 'line 4 changed beyond a version value' });
    expect(versionStampOnly('m.json', '{\n  "x": "1.0.0",\n  "x": "keep",\n  "version": "1.0.0"\n}\n', '{\n  "x": "2.0.0",\n  "x": "keep",\n  "version": "2.0.0"\n}\n').stampOnly).toBe(false);
    const deep = (v: string) => `{"version":"${v}","a":${'['.repeat(200_000)}1${']'.repeat(200_000)}}`;
    expect(versionStampOnly('deep.json', deep('1.0.0'), deep('1.0.1'))).toEqual({ stampOnly: false, reason: 'could not compare (nested too deep)' });
  });

  test('an absent, unchanged, reformatted or unparseable manifest is not stamp-only, and a non-manifest file never is', () => {
    expect(versionStampOnly('p.json', null, manifest('1.0.0'))).toEqual({ stampOnly: false, reason: 'absent or unreadable at the merge base' });
    expect(versionStampOnly('p.json', manifest('1.0.0'), null)).toEqual({ stampOnly: false, reason: 'absent or unreadable in the working tree' });
    expect(versionStampOnly('p.json', manifest('1.0.0'), manifest('1.0.0'))).toEqual({ stampOnly: false, reason: 'unchanged' });
    expect(versionStampOnly('p.json', manifest('1.0.0'), JSON.stringify(JSON.parse(manifest('1.0.0'))))).toEqual({ stampOnly: false, reason: 'no value changed (whitespace or spelling only)' });
    expect(versionStampOnly('p.json', manifest('1.0.0'), '{ version: 1.0.1 }').stampOnly).toBe(false);
    expect(versionStampOnly('src/version.ts', "export const VERSION = '1.0.0';", "export const VERSION = '1.0.1';")).toEqual({ stampOnly: false, reason: 'not a JSON, plist or VERSION file' });
  });

  test('a VERSION file is stamp-only when both sides are one bare version with at most a trailing LF; a line-ending change is content', () => {
    expect(versionStampOnly('VERSION', '0.60.462.0\n', '0.60.463.0\n')).toEqual({ stampOnly: true, changed: ['0.60.462.0 → 0.60.463.0'] });
    expect(versionStampOnly('VERSION', '0.60.462.0', '0.60.463.0')).toEqual({ stampOnly: true, changed: ['0.60.462.0 → 0.60.463.0'] });
    expect(versionStampOnly('VERSION', '0.60.462.0\n', '0.60.463.0\r\n')).toEqual({ stampOnly: false, reason: 'content is not one bare version on both sides' });
    expect(versionStampOnly('p.json', '{\r\n"version": "1.0.0"\r\n}', '{\n"version": "1.0.1"\n}')).toEqual({ stampOnly: false, reason: 'line 1 changed beyond a version value' });
    expect(versionStampOnly('VERSION', '0.60.462.0\n', '0.60.463.0\nnotes\n').stampOnly).toBe(false);
    expect(versionStampOnly('VERSION', 'unreleased\n', '1.0.0\n').stampOnly).toBe(false);
    expect(versionStampOnly('VERSION', '1.0.0', '1.0.0\n')).toEqual({ stampOnly: false, reason: 'no version changed (trailing newline only)' });
    expect(versionStampOnly('VERSION', '1.0.0\n', ' 1.0.1\n')).toEqual({ stampOnly: false, reason: 'content is not one bare version on both sides' });
    expect(versionStampOnly('VERSION', '1.0.0\n', '\u00a01.0.0\u2028').stampOnly).toBe(false);
    expect(versionStampOnly('VERSION', '1.0.0\n', '\ufeff1.0.1\n').stampOnly).toBe(false);
  });

  test('a plist is stamp-only when only the <string> under CFBundleShortVersionString or CFBundleVersion changed', () => {
    const plist = (short: string, build: string, name = 'App', minOS = '15.0') => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${name}</string>
  <key>CFBundleShortVersionString</key>
  <string>${short}</string>
  <key>CFBundleVersion</key>
  <string>${build}</string>
  <key>MinimumOSVersion</key>
  <string>${minOS}</string>
</dict>
</plist>
`;
    expect(versionStampOnly('ios/Info.plist', plist('1.2.3', '1.2.3.45'), plist('1.2.4', '1.2.4.46'))).toEqual({ stampOnly: true, changed: ['CFBundleShortVersionString 1.2.3 → 1.2.4', 'CFBundleVersion 1.2.3.45 → 1.2.4.46'] });
    expect(versionStampOnly('ios/Info.plist', plist('1.2.3', '45'), plist('1.2.4', '46'))).toEqual({ stampOnly: false, reason: 'line 9 changed and a value is not a bare version' });
    expect(versionStampOnly('ios/Info.plist', plist('1.2.3', '1.2.3.45'), plist('1.2.4', '1.2.4.46', 'Other'))).toEqual({ stampOnly: false, reason: 'line 5 changed and a value is not a bare version' });
    expect(versionStampOnly('ios/Info.plist', plist('1.2.3', '1.2.3.45', '1.0.0'), plist('1.2.3', '1.2.3.45', '2.0.0'))).toEqual({ stampOnly: false, reason: 'line 5 changed under <key>CFBundleName</key>, not a bundle version key' });
    expect(versionStampOnly('ios/Info.plist', plist('1.2.3', '1.2.3.45'), plist('1.2.3', '1.2.3.45', 'App', '17.0'))).toEqual({ stampOnly: false, reason: 'line 11 changed under <key>MinimumOSVersion</key>, not a bundle version key' });
    expect(versionStampOnly('ios/Info.plist', plist('1.2.3', '1.2.3.45'), plist('1.2.4', '1.2.4.46').replace('<key>CFBundleVersion</key>', '<key>CFBundleVersions</key>'))).toEqual({ stampOnly: false, reason: 'line 8 changed and is not a <string> value' });
    expect(versionStampOnly('ios/Info.plist', plist('1.2.3', '1.2.3.45'), plist('1.2.4', '1.2.4.46') + '<!-- -->\n').stampOnly).toBe(false);
    expect(versionStampOnly('v.plist', '<string>1.0.0</string>\n', '<string>1.0.1</string>\n')).toEqual({ stampOnly: false, reason: 'line 1 changed under no <key>, not a bundle version key' });
  });
});

describe('gstack-pregate lanes and version-stamp-only manifests', () => {
  // The fixture's base pregate.json declares no lane for these manifests, as gbrain's master does not; every PR is judged by the base's policy.
  const base = { '.claude-plugin/plugin.json': manifest('1.0.0'), '.codex-plugin/plugin.json': manifest('1.0.0'), 'openclaw.plugin.json': manifest('1.0.0', { id: 'gbrain-context-engine' }), 'VERSION': '1.0.0\n' };
  const stamp = (v: string) => ({ '.claude-plugin/plugin.json': manifest(v), '.codex-plugin/plugin.json': manifest(v), 'openclaw.plugin.json': manifest(v, { id: 'gbrain-context-engine' }), 'VERSION': `${v}\n` });

  test('positive: a PR that only re-stamps the manifests and VERSION passes lanes with a line naming the waived files and why', () => {
    const repo = fixture({ baseFiles: base });
    commit(repo, stamp('1.0.1'), 'release: restamp 1.0.1');
    const r = pregate(repo);
    expect(r.err).not.toContain('PREGATE_NO_LANE');
    expect(r.out).not.toContain('has no test lane');
    expect(r.out).toContain(`${WAIVER}.claude-plugin/plugin.json .codex-plugin/plugin.json VERSION openclaw.plugin.json — only version values changed against the merge base; a manifest whose other content changed still needs a lane`);
    expect(r.status).toBe(EXIT.ok);
    expect(lanes(repo).status).toBe('pass');
    expect(lanes(repo).detail).toBe('version-stamp-only: 4 version-stamp-only manifest(s); nothing touched selects a test');
    const explain = pregate(repo, ['--explain']).out;
    expect(explain).toMatch(/\.claude-plugin\/plugin\.json: version-stamp-only against [0-9a-f]{12} \(version 1\.0\.0 → 1\.0\.1\); no lane needed/);
    expect(explain).toMatch(/VERSION: version-stamp-only against [0-9a-f]{12} \(1\.0\.0 → 1\.0\.1\); no lane needed/);
  });

  test('negative: a manifest whose non-version field changed still fails with PREGATE_NO_LANE and says why it was not a stamp', () => {
    const repo = fixture({ baseFiles: base });
    commit(repo, { '.claude-plugin/plugin.json': manifest('1.0.1', { description: 'Personal knowledge brain, with RLS' }), 'VERSION': '1.0.1\n' }, 'release: restamp and reword');
    const r = pregate(repo);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toContain('(PREGATE_NO_LANE)');
    expect(r.out).toContain('FAIL lanes — .claude-plugin/plugin.json has no test lane');
    expect(r.out).toContain(`${WAIVER}VERSION — `);
    expect(r.out).not.toContain(`${WAIVER}.claude-plugin`);
    expect(pregate(repo, ['--explain']).out).toContain('.claude-plugin/plugin.json: not version-stamp-only (.description changed and its key is not `version`)');
  });

  test('mixed diff: the stamped manifests are waived while an unmapped source file keeps its PREGATE_NO_LANE, and a mapped one still runs its test', () => {
    const repo = fixture({ baseFiles: base });
    commit(repo, { 'VERSION': '1.0.1\n', 'openclaw.plugin.json': manifest('1.0.1', { id: 'gbrain-context-engine' }), 'lib/orphan.js': 'exports.lonely = () => 2;\n' }, 'stamp plus an orphan');
    const orphan = pregate(repo);
    expect(orphan.status).toBe(EXIT.fail);
    expect(orphan.out).toContain('FAIL lanes — lib/orphan.js has no test lane');
    expect(orphan.out).toContain(`${WAIVER}VERSION openclaw.plugin.json — `);
    expect(pregate(repo, ['--explain']).out).not.toContain('lib/orphan.js: not version-stamp-only');
    const repo2 = fixture({ baseFiles: base });
    commit(repo2, { 'VERSION': '1.0.1\n', 'openclaw.plugin.json': manifest('1.0.1', { id: 'gbrain-context-engine' }), 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, 'stamp plus a mapped change');
    const mapped = pregate(repo2);
    expect(mapped.status).toBe(EXIT.ok);
    expect(mapped.out).toContain(`${WAIVER}VERSION openclaw.plugin.json — `);
    expect(lanes(repo2).detail).toMatch(/^1 tests ran in 1 file\(s\), exit 0/);
  });

  test('a manifest a test reads keeps its lane: the test runs and the file is not waived', () => {
    // lib/config.json is read by test/config-read.test.js through a repo-path literal in the fixture.
    const repo = fixture({ baseFiles: { 'lib/config.json': j({ version: '1.0.0', limit: 10 }) } });
    commit(repo, { 'lib/config.json': j({ version: '1.0.1', limit: 10 }) }, 'stamp a config a test reads');
    const r = pregate(repo);
    expect(r.out).not.toContain('version-stamp-only');
    expect(r.out).toContain("ran: node --test 'test/config-read.test.js'");
    expect(lanes(repo).detail).toMatch(/^1 tests ran in 1 file\(s\)/);
  });

  test('the comparison is against the merge base: main re-stamping after the fork does not change the verdict, and a later non-stamp commit on the branch does', () => {
    const repo = fixture({ baseFiles: base });
    commit(repo, stamp('1.0.1'), 'release: restamp 1.0.1');
    repo.git('checkout', '-q', 'main');
    for (const [rel, text] of Object.entries(stamp('1.0.5'))) write(repo.work, rel, text);
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'main restamps 1.0.5'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feature');
    const stamped = pregate(repo);
    expect(stamped.status).toBe(EXIT.ok);
    expect(pregate(repo, ['--explain']).out).toMatch(/VERSION: version-stamp-only against [0-9a-f]{12} \(1\.0\.0 → 1\.0\.1\)/);
    commit(repo, { 'openclaw.plugin.json': manifest('1.0.1', { id: 'gbrain-context-engine', description: 'reworded later' }) }, 'reword after the stamp');
    const reworded = pregate(repo);
    expect(reworded.status).toBe(EXIT.fail);
    expect(reworded.out).toContain('FAIL lanes — openclaw.plugin.json has no test lane');
    expect(reworded.out).toContain(`${WAIVER}.claude-plugin/plugin.json .codex-plugin/plugin.json VERSION — `);
  });

  test('a mode change or a symlink on either side is not a stamp', () => {
    const repo = fixture({ baseFiles: base });
    fs.chmodSync(path.join(repo.work, 'VERSION'), 0o755);
    commit(repo, { 'VERSION': '1.0.1\n' }, 'stamp with an exec bit');
    expect(pregate(repo).out).toContain('FAIL lanes — VERSION has no test lane');
    const link = fixture({ baseFiles: { 'target.txt': '1.0.0\n' } });
    fs.symlinkSync('target.txt', path.join(link.work, 'VERSION'));
    link.git('add', '-A'); link.git('commit', '-q', '-m', 'symlinked VERSION'); link.git('push', '-q', 'origin', 'HEAD:main'); link.git('fetch', '-q', 'origin');
    fs.unlinkSync(path.join(link.work, 'VERSION')); write(link.work, 'VERSION', '1.0.1\n');
    link.git('add', '-A'); link.git('commit', '-q', '-m', 'symlink becomes a file');
    const r = pregate(link, ['--explain']);
    expect(r.out).toContain('FAIL lanes — VERSION has no test lane');
    expect(r.out).toContain('VERSION: not version-stamp-only (absent or unreadable at the merge base)');
  });

  test('a renamed manifest, an added one and a deleted one are not stamps', () => {
    const repo = fixture({ baseFiles: base });
    fs.mkdirSync(path.join(repo.work, 'plugins'));
    repo.git('mv', 'openclaw.plugin.json', 'plugins/openclaw.plugin.json');
    commit(repo, { 'plugins/openclaw.plugin.json': manifest('1.0.1', { id: 'gbrain-context-engine' }), 'VERSION': null, 'new.plugin.json': manifest('1.0.1') }, 'move, add and delete');
    const r = pregate(repo);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toContain('FAIL lanes — new.plugin.json has no test lane');
    expect(r.out).toContain('FAIL lanes — plugins/openclaw.plugin.json has no test lane');
    expect(r.out).not.toContain('version-stamp-only (no lane needed)');
  });

  test('the working tree decides: an uncommitted stamp is waived, an uncommitted reword on top of a committed stamp is not, and an oversize or non-UTF-8 manifest is never a stamp', () => {
    const repo = fixture({ baseFiles: base });
    write(repo.work, 'VERSION', '1.0.1\n');
    expect(pregate(repo).status).toBe(EXIT.ok);
    expect(lanes(repo).detail).toBe('version-stamp-only: 1 version-stamp-only manifest(s); nothing touched selects a test');
    commit(repo, { 'openclaw.plugin.json': manifest('1.0.1', { id: 'gbrain-context-engine' }) }, 'stamp');
    write(repo.work, 'openclaw.plugin.json', manifest('1.0.1', { id: 'gbrain-context-engine', description: 'reworded in the working tree' }));
    const dirty = pregate(repo);
    expect(dirty.status).toBe(EXIT.fail);
    expect(dirty.out).toContain('FAIL lanes — openclaw.plugin.json has no test lane');
    const big = fixture({ baseFiles: { 'big.plugin.json': manifest('1.0.0', { pad: 'x'.repeat(1024 * 1024) }), 'bad.plugin.json': manifest('1.0.0'), 'bom.plugin.json': manifest('1.0.0') } });
    commit(big, { 'big.plugin.json': manifest('1.0.1', { pad: 'x'.repeat(1024 * 1024) }) }, 'oversize stamp');
    fs.writeFileSync(path.join(big.work, 'bad.plugin.json'), Buffer.concat([Buffer.from('{"version":"1.0.1","name":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
    fs.writeFileSync(path.join(big.work, 'bom.plugin.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(manifest('1.0.1'))]));
    big.git('add', '-A'); big.git('commit', '-q', '-m', 'invalid utf-8');
    const r = pregate(big, ['--explain']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toContain('FAIL lanes — big.plugin.json has no test lane');
    expect(r.out).toContain('FAIL lanes — bad.plugin.json has no test lane');
    expect(r.out).toContain('big.plugin.json: not version-stamp-only (absent or unreadable in the working tree)');
    expect(r.out).toContain('bad.plugin.json: not version-stamp-only (absent or unreadable in the working tree)');
    expect(r.out).toContain('FAIL lanes — bom.plugin.json has no test lane');
    expect(r.out).toMatch(/bom\.plugin\.json: not version-stamp-only \(not parseable JSON on both sides/);
  });

  test('a manifest under a test, fixture, golden, .gstack or workflow tree is never waived', () => {
    const files = { 'test/fixtures/golden.json': j({ version: '1.0.0', expect: 1 }), 'test/golden/expected.json': j({ version: '1.0.0' }), 'goldens/out.json': j({ version: '1.0.0' }), '.gstack/extra.json': j({ version: '1.0.0' }), '.github/workflows/meta.json': j({ version: '1.0.0' }), 'VERSION': '1.0.0\n' };
    const repo = fixture({ baseFiles: files });
    commit(repo, Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.replace('1.0.0', '1.0.1')])), 'stamp everything');
    const r = pregate(repo, ['--explain']);
    expect(r.status).toBe(EXIT.fail);
    for (const f of Object.keys(files).filter(f => f !== 'VERSION')) expect(r.out).toContain(`FAIL lanes — ${f} has no test lane`);
    expect(r.out).toContain(`${WAIVER}VERSION — `);
    expect(r.out).not.toContain('golden.json: not version-stamp-only');
  });

  test('the no-tests detail names the stamped manifests beside documentation and assets', () => {
    const repo = fixture({ baseFiles: base });
    commit(repo, { 'VERSION': '1.0.1\n', 'docs/README.md': '# docs, reworded\n' }, 'stamp plus docs');
    expect(pregate(repo).status).toBe(EXIT.ok);
    expect(lanes(repo).detail).toBe('docs/no-tests: 1 documentation file(s) and 1 version-stamp-only manifest(s); nothing touched selects a test');
    const repo2 = fixture({ baseFiles: base });
    commit(repo2, { 'VERSION': '1.0.1\n', 'assets/logo.png': 'not really a png\n' }, 'stamp plus an asset');
    expect(pregate(repo2).status).toBe(EXIT.ok);
    expect(lanes(repo2).detail).toBe('no-tests: 1 asset or tool-config file(s) and 1 version-stamp-only manifest(s); nothing touched selects a test');
  });
});
