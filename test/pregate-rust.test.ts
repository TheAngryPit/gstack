/**
 * C8 `lanes` for a Rust repo: a `.rs` file of a crate (the nearest Cargo.toml
 * with `[package]`) is a test when it sits under `<crate>/tests/` or holds a
 * `#[cfg(test)]`; every `.rs` file of a crate and its Cargo.toml select that
 * crate's tests and the tests of every crate depending on it; selected tests
 * run as `cargo test -p <name>` from the workspace root, judged on the summed
 * `test result:` lines. The end-to-end fixture carries no workflows, so every
 * selected test is a local lane on any host platform; `cargo` is a PATH shim.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { EXIT } from '../lib/headless-artifacts';
import { parseSummary, planRuns } from '../lib/pregate/checks/lanes';
import { DEFAULT_CONFIG } from '../lib/pregate/config';
import { buildGraph, testsFor } from '../lib/pregate/import-graph';
import { draftConfig } from '../lib/pregate/init-draft';
import { cargoModel, hasCfgTest, rustEdges } from '../lib/pregate/rust';
import type { PregateContext } from '../lib/pregate/types';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const RUST_FILES: Record<string, string> = {
  'engine/Cargo.toml': '[workspace]\nresolver = "3"\nmembers = ["crates/*"]\n\n[workspace.dependencies]\nalpha = { path = "crates/alpha" }\n',
  'engine/crates/alpha/Cargo.toml': '[package]\nname = "alpha"\nversion = "0.1.0"\nedition = "2024"\n',
  'engine/crates/alpha/src/lib.rs': 'pub mod util;\npub fn one() -> u32 { 1 }\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn one_is_one() { assert_eq!(super::one(), 1); }\n}\n',
  'engine/crates/alpha/src/util.rs': 'pub fn two() -> u32 { 2 }\n',
  'engine/crates/alpha/src/flags.rs': '#[cfg(feature = "test")]\npub fn only_with_the_test_feature() {}\n',
  'engine/crates/alpha/tests/it.rs': '#[test]\nfn it() { assert_eq!(alpha::one(), 1); }\n',
  'engine/crates/beta/Cargo.toml': '[package]\nname = "beta-core"\nversion = "0.1.0"\n\n[dependencies]\nalpha = { workspace = true } # the shared base\n',
  'engine/crates/beta/src/lib.rs': 'pub fn b() -> u32 { alpha::one() }\n\n#[cfg(all(test, unix))]\nmod tests {\n    #[test]\n    fn b() {}\n}\n',
  'engine/crates/gamma/Cargo.toml': '[package]\nname = "gamma"\nversion = "0.1.0"\n\n[target.\'cfg(unix)\'.dev-dependencies.base]\npackage = "beta-core"\npath = "../beta"\n',
  'engine/crates/gamma/src/lib.rs': 'pub fn g() {}\n',
  'engine/crates/gamma/tests/g.rs': '#[test]\nfn g() {}\n',
  'engine/crates/lonely/Cargo.toml': '[package]\nname = "lonely"\nversion = "0.1.0"\n',
  'engine/crates/lonely/src/lib.rs': 'pub fn alone() {}\n',
  'standalone/Cargo.toml': '[package]\nname = "standalone"\nversion = "0.1.0"\n',
  'standalone/src/main.rs': 'fn main() {}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {}\n}\n',
  'tools/tests/loose.rs': 'fn main() {}\n',
};

const ALPHA_TESTS = ['engine/crates/alpha/src/lib.rs', 'engine/crates/alpha/tests/it.rs'];

/** The fixture plus RUST_FILES on main, with no base policy and no workflows, so every selected test runs locally. */
function rustRepo(): FixtureRepo {
  const repo = makeFixtureRepo({ pregate: null });
  repos.push(repo);
  commit(repo, { ...RUST_FILES, '.github/workflows/free-tests.yml': null, '.github/workflows/windows.yml': null }, 'rust');
  repo.git('push', '-q', 'origin', 'HEAD:main');
  repo.git('fetch', '-q', 'origin');
  return repo;
}

const CARGO_OK = [
  'echo "ran in $(basename "$PWD"): $*"',
  'echo "running 2 tests"',
  'echo "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s"',
  'echo "   Doc-tests $3"',
  'echo "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s"',
].join('\n');

/**
 * A `cargo` on PATH running `body` (default: reports its cwd and argv, then two passed tests and an empty doc-test binary).
 * The lane puts its Bun's directory first on PATH, and that directory can hold a real cargo (/usr/local/bin,
 * /opt/homebrew/bin), so on POSIX the lane's bash puts the shim first again through BASH_ENV.
 */
function cargoShim(repo: FixtureRepo, body = CARGO_OK): Record<string, string> {
  const dir = path.join(repo.root, 'shim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cargo'), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'path.sh'), `PATH='${dir}':"$PATH"\n`);
  const PATH = [dir, process.env.PATH ?? ''].join(path.delimiter);
  return process.platform === 'win32' ? { PATH } : { PATH, BASH_ENV: path.join(dir, 'path.sh') };
}

const rustTests = (tests: Iterable<string>) => [...tests].filter(t => t.endsWith('.rs')).sort();

describe('Rust import graph', () => {
  // Value: protects=in-source `#[cfg(test)]` modules and `<crate>/tests/` files are tests only inside a crate, and a cfg naming a
  //   feature called "test" is not; fails_when=Rust tests are never recognised (every touched .rs is PREGATE_NO_LANE) or any
  //   tests/*.rs counts without a Cargo.toml; why_new=no Rust support existed; seam=none; no_claim=a Rust parser (a cfg attribute scan)
  test('cfg(test) files and <crate>/tests/ files are tests; a loose tests/*.rs and a cfg(feature = "test") file are not', () => {
    const g = buildGraph(rustRepo().work);
    expect(rustTests(g.tests)).toEqual([...ALPHA_TESTS, 'engine/crates/beta/src/lib.rs', 'engine/crates/gamma/tests/g.rs', 'standalone/src/main.rs']);
  });

  // Value: protects=a src file without its own tests selects its crate's tests and, transitively, the tests of crates depending on it
  //   (workspace = true, a renamed target-specific dev-dependency); an in-source test selects itself; a crate with no tests stays
  //   no-lane; fails_when=the mapping narrows to the file, misses dependents, or invents a lane; why_new=no Rust mapping existed;
  //   seam=none; no_claim=cargo's own resolver (manifest dependency keys are read)
  test('a crate file selects its crate and every crate depending on it; a crate without tests has no lane', () => {
    const g = buildGraph(rustRepo().work);
    const everyAlphaDependent = [...ALPHA_TESTS, 'engine/crates/beta/src/lib.rs', 'engine/crates/gamma/tests/g.rs'];
    expect(testsFor(g, 'engine/crates/alpha/src/util.rs').tests).toEqual(everyAlphaDependent);
    expect(testsFor(g, 'engine/crates/alpha/src/lib.rs').tests).toEqual(everyAlphaDependent);
    expect(testsFor(g, 'engine/crates/alpha/Cargo.toml').tests).toEqual(everyAlphaDependent);
    expect(testsFor(g, 'engine/crates/beta/src/lib.rs').tests).toEqual(['engine/crates/beta/src/lib.rs', 'engine/crates/gamma/tests/g.rs']);
    expect(testsFor(g, 'engine/crates/gamma/src/lib.rs').tests).toEqual(['engine/crates/gamma/tests/g.rs']);
    expect(testsFor(g, 'standalone/src/main.rs').tests).toEqual(['standalone/src/main.rs']);
    expect(testsFor(g, 'engine/crates/lonely/src/lib.rs').tests).toEqual([]);
    expect(testsFor(g, 'tools/tests/loose.rs').tests).toEqual([]);
  });

  // Value: protects=`gstack-pregate init` tells a Rust repo its tests run per crate (no runner to declare), and Rust does not make a
  //   JS selection "mixed"; fails_when=init tells the user to set a runner for Rust tests, which would override the per-crate plan;
  //   why_new=init grouped .rs tests as "other"; seam=none; no_claim=none beyond protects
  test('init notes that Rust tests run per crate with cargo test, not that a runner must be set', () => {
    const note = draftConfig(rustRepo().work).runnerNote;
    expect(note).toContain('5 Rust test file(s) run per crate with cargo test -p');
    expect(note).not.toContain('needs runner set');
    expect(note).not.toMatch(/no runner detected for \d+ (?:other|rust)/);
  });
});

describe('Rust runner and summary (pure)', () => {
  // Value: protects=cargo prints one `test result:` line per test binary (unit, each integration test, doc-tests); all are summed,
  //   ignored and filtered tests are not runs, and an all-zero run is ZERO-RUN; fails_when=only the first or last line counts, or the
  //   generic `N passed` fallback reads cargo output; why_new=cargo output was unparsed (ran: null); seam=none; no_claim=a real cargo
  test('cargo test: every test result line counts, doc-tests included; all zeros are a zero run', () => {
    const cargo = 'cargo test -p alpha';
    const ok = [
      '   Compiling alpha v0.1.0', '     Running unittests src/lib.rs (target/debug/deps/alpha-1)', '', 'running 2 tests', 'test tests::a ... ok', 'test tests::b ... ok', '',
      'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s', '',
      '     Running tests/it.rs (target/debug/deps/it-2)', '', 'running 2 tests', 'test it ... ok', 'test slow ... ignored', '',
      'test result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s', '',
      '   Doc-tests alpha', '', 'running 3 tests', 'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.31s',
    ].join('\n');
    expect(parseSummary(ok, cargo)).toEqual({ ran: 6, failed: 0 });
    const failed = 'test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\nfailures:\n    tests::b\n\ntest result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n\nerror: test failed, to rerun pass `-p alpha --lib`';
    expect(parseSummary(failed, cargo)).toEqual({ ran: 7, failed: 2 });
    const zero = 'running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n   Doc-tests alpha\n\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s';
    expect(parseSummary(zero, cargo)).toEqual({ ran: 0, failed: 0 });
    expect(parseSummary('\x1b[1m\x1b[32mtest result: ok\x1b[0m. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s', cargo)).toEqual({ ran: 5, failed: 0 });
    expect(parseSummary('error[E0425]: cannot find value `x` in this scope\nerror: could not compile `alpha`', cargo)).toEqual({ ran: null, failed: null });
  });

  // Value: protects=each selected crate runs once as `cargo test -p <name>` from its workspace root (else its own directory), crates
  //   group apart, a .rs file outside any crate is unclaimed, and a missing cargo is incomplete; fails_when=.rs files reach the JS
  //   runner, run from the repo root, merge across crates, or a missing cargo is judged as a test failure (exit 127); why_new=no cargo
  //   runner existed; seam=none; no_claim=the runners themselves (plan only)
  test('without a declared runner, Rust tests group by crate from the workspace root; a declared runner takes every file', () => {
    const repo = rustRepo();
    const ctx = { repoRoot: repo.work, config: DEFAULT_CONFIG, env: cargoShim(repo) } as unknown as PregateContext;
    const files = [...ALPHA_TESTS, 'engine/crates/beta/src/lib.rs', 'standalone/src/main.rs', 'tools/tests/loose.rs'];
    expect(planRuns(ctx, files)).toEqual({ groups: [
      { runner: "cargo test -p 'alpha'", cwd: 'engine', files: ['crates/alpha/src/lib.rs', 'crates/alpha/tests/it.rs'] },
      { runner: "cargo test -p 'beta-core'", cwd: 'engine', files: ['crates/beta/src/lib.rs'] },
      { runner: "cargo test -p 'standalone'", cwd: 'standalone', files: ['src/main.rs'] },
    ], unclaimed: ['tools/tests/loose.rs'], missing: [], noPubspec: [] });
    const noCargo = { ...ctx, env: { PATH: path.join(repo.root, 'empty-path') } } as PregateContext;
    expect(planRuns(noCargo, ALPHA_TESTS)).toEqual({ groups: [], unclaimed: ALPHA_TESTS, missing: ['cargo'], noPubspec: [] });
    const declared = { ...ctx, config: { ...DEFAULT_CONFIG, runner: 'bash scripts/test.sh {files}' } } as PregateContext;
    expect(planRuns(declared, files).groups).toEqual([{ runner: 'bash scripts/test.sh {files}', cwd: '', files }]);
  });
});

/**
 * Manifest shapes a line scan misreads (review of the first cut): a renamed
 * dependency inherited from `[workspace.dependencies]`, TOML dotted keys, the
 * `[dependencies.<name>]` table form, target-specific tables, and a crate the
 * workspace excludes. Dependencies resolve by path first, then by package name.
 */
const MANIFEST_FILES: Record<string, string> = {
  'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/helper"]\n\n[workspace.dependencies]\nbase = { package = "alpha", path = "crates/a" }\n',
  'crates/a/Cargo.toml': '[package]\nname = "alpha"\nversion = "0.1.0"\n',
  'crates/a/src/lib.rs': 'pub fn a() {}\n',
  'crates/a/tests/a.rs': '#[test]\nfn a() {}\n',
  'crates/beta/Cargo.toml': '[package]\nname = "beta"\nversion = "0.1.0"\n\n[dependencies]\nbase = { workspace = true }\n',
  'crates/beta/tests/b.rs': '#[test]\nfn b() {}\n',
  'crates/dotted/Cargo.toml': '[package]\nname = "dotted"\nversion = "0.1.0"\n\n[dependencies]\nfoo.path = "../a"\n',
  'crates/dotted/tests/d.rs': '#[test]\nfn d() {}\n',
  'crates/table/Cargo.toml': '[package]\nname = "table"\nversion = "0.1.0"\n\n[dev-dependencies.whatever]\npath = "../a"\n',
  'crates/table/tests/t.rs': '#[test]\nfn t() {}\n',
  'crates/targeted/Cargo.toml': '[package]\nname = "targeted"\nversion = "0.1.0"\n\n[target.\'cfg(unix)\'.build-dependencies]\nrenamed = { path = "../a" }\n',
  'crates/targeted/tests/x.rs': '#[test]\nfn x() {}\n',
  'crates/plain/Cargo.toml': '[package]\nname = "plain"\nversion = "0.1.0"\n',
  'crates/plain/tests/p.rs': '#[test]\nfn p() {}\n',
  'crates/helper/Cargo.toml': '[package]\nname = "helper"\nversion = "0.1.0"\n',
  'crates/helper/src/lib.rs': '#[cfg(test)]\nmod tests {\n    #[test]\n    fn h() {}\n}\n',
};

function manifestRepo(): FixtureRepo {
  const repo = makeFixtureRepo({ pregate: null });
  repos.push(repo);
  commit(repo, MANIFEST_FILES, 'cargo manifests');
  return repo;
}

describe('Cargo manifests are parsed as TOML', () => {
  // Value: protects=every dependency spelling Cargo accepts links a crate to its dependents: an inherited renamed workspace dependency,
  //   a dotted `foo.path` key, a `[dev-dependencies.<name>]` table and a target-specific build dependency, all resolved by path;
  //   fails_when=the manifest is read by a line scan again and alpha's change misses these dependents (a false green);
  //   why_new=the first cut matched dependency keys against package names only; seam=none; no_claim=cargo's own resolver
  test('renamed, inherited, dotted, table-form and target-specific dependencies all select the dependent crates', () => {
    const g = buildGraph(manifestRepo().work);
    expect(testsFor(g, 'crates/a/src/lib.rs').tests).toEqual(['crates/a/tests/a.rs', 'crates/beta/tests/b.rs', 'crates/dotted/tests/d.rs', 'crates/table/tests/t.rs', 'crates/targeted/tests/x.rs']);
  });

  // Value: protects=a crate the workspace excludes runs from its own directory, a member from the workspace root; fails_when=the
  //   nearest [workspace] is taken without checking members/exclude and `cargo test -p helper` runs where helper is no member
  //   (cargo fails, or tests a same-named member); why_new=membership was not read; seam=none; no_claim=a real cargo (plan only)
  test('an excluded crate runs from its own directory; a member runs from the workspace root', () => {
    const repo = manifestRepo();
    const ctx = { repoRoot: repo.work, config: DEFAULT_CONFIG, env: cargoShim(repo) } as unknown as PregateContext;
    expect(planRuns(ctx, ['crates/beta/tests/b.rs', 'crates/helper/src/lib.rs']).groups).toEqual([
      { runner: "cargo test -p 'beta'", cwd: '', files: ['crates/beta/tests/b.rs'] },
      { runner: "cargo test -p 'helper'", cwd: 'crates/helper', files: ['src/lib.rs'] },
    ]);
  });
});

describe('Cargo membership and test detection (port review)', () => {
  const inMemory = (files: Record<string, string>) => [Object.keys(files), (f: string) => files[f] ?? null] as const;
  const pkg = (name: string, deps = '') => `[package]\nname = "${name}"\nversion = "0.1.0"\n${deps}`;
  const dependentsOf = (files: Record<string, string>, manifest: string) => rustEdges(...inMemory(files)).edges.filter(e => e.dependency === manifest).map(e => e.dependent).sort();

  // Value: protects=Cargo's member globs ([ab] classes, ** spans) admit the crates Cargo admits, so a member inherits
  //   [workspace.dependencies] and its tests are selected; fails_when=a character class is matched literally, the crate is
  //   no member, the inherited path dependency is dropped and alpha's change misses beta's tests (a false green);
  //   why_new=port review found classes escaped; seam=none; no_claim=cargo's own glob crate
  test('a members glob with a character class or ** admits the crate, so an inherited dependency links its dependent', () => {
    const files = {
      'Cargo.toml': '[workspace]\nmembers = ["crates/[ab]", "nested/**/leaf", "unicode/?"]\n\n[workspace.dependencies]\nbase = { package = "alpha", path = "crates/a" }\n',
      'crates/a/Cargo.toml': pkg('alpha'), 'crates/a/tests/a.rs': '#[test]\nfn a() {}\n',
      'crates/b/Cargo.toml': pkg('beta', '\n[dependencies]\nbase = { workspace = true }\n'), 'crates/b/tests/b.rs': '#[test]\nfn b() {}\n',
      'crates/c/Cargo.toml': pkg('gamma'),
      'nested/x/y/leaf/Cargo.toml': pkg('leaf'),
      'unicode/📦/Cargo.toml': pkg('boxed'),
    };
    const { crates } = cargoModel(...inMemory(files));
    expect(['crates/a', 'crates/b', 'crates/c', 'nested/x/y/leaf', 'unicode/📦'].map(r => crates.get(r)!.workspace)).toEqual(['', '', 'crates/c', '', '']);
    expect(dependentsOf(files, 'crates/a/Cargo.toml')).toEqual(['crates/a/tests/a.rs', 'crates/b/tests/b.rs']);
  });

  // Value: protects=a plain #[test] function or a #[tokio::test] in src is a Rust test, so a dependent crate tested that way
  //   runs when its dependency changes; fails_when=only cfg(test) modules and tests/ count and the dependent's failing test
  //   never runs (a false green); why_new=port review; seam=none; no_claim=custom [[test]] targets outside tests/
  test('a plain #[test] or #[tokio::test] in src is a test; cfg(feature = "test") and #[testing] are not', () => {
    expect(['#[test]\nfn a() {}', '#[tokio::test(flavor = "multi_thread")]\nasync fn a() {}', '#[ test ]\nfn a() {}'].map(hasCfgTest)).toEqual([true, true, true]);
    expect(['#[cfg(feature = "test")]\nfn a() {}', '#[testing]\nfn a() {}', '// attests', '#[cfg(feature = "a]b")]\nfn a() {}'].map(hasCfgTest)).toEqual([false, false, false, false]);
    expect(hasCfgTest(`#[cfg(any(test, feature = "${'f'.repeat(300)}"))]\nmod t {}`)).toBe(true);
    const files = {
      'a/Cargo.toml': pkg('a'), 'a/src/lib.rs': 'pub fn one() -> u32 { 1 }\n#[cfg(test)]\nmod t { #[test] fn one() {} }\n',
      'b/Cargo.toml': pkg('b', '\n[dependencies]\na = { path = "../a" }\n'), 'b/src/lib.rs': 'pub fn two() -> u32 { a::one() + 1 }\n#[test]\nfn two() { assert_eq!(super::two(), 2); }\n',
    };
    expect(dependentsOf(files, 'a/Cargo.toml')).toEqual(['a/src/lib.rs', 'b/src/lib.rs']);
  });

  // Value: protects=past the members-glob size cap, where a crate's tests run is undecided, so its files are unclaimed (the
  //   lane incomplete) instead of running `cargo test -p <name>` from a root where a same-named member answers; fails_when=an
  //   oversized workspace admits every crate as runnable and the orphan's failing test is replaced by the member's passing
  //   ones (a false green); why_new=third port review round; seam=none; no_claim=a real cargo (plan only)
  test('past the members size cap a same-named non-member is unclaimed, not run as the member', () => {
    const repo = makeFixtureRepo({ pregate: null });
    repos.push(repo);
    commit(repo, {
      'Cargo.toml': `[workspace]\nmembers = ["[${'m'.repeat(4100)}]ember"]\n`,
      'member/Cargo.toml': pkg('same'), 'member/tests/m.rs': '#[test]\nfn m() {}\n',
      'orphan/Cargo.toml': pkg('same'), 'orphan/tests/t.rs': '#[test]\nfn t() { panic!() }\n',
    }, 'oversized members');
    const ctx = { repoRoot: repo.work, config: DEFAULT_CONFIG, env: cargoShim(repo) } as unknown as PregateContext;
    expect(planRuns(ctx, ['orphan/tests/t.rs'])).toEqual({ groups: [], unclaimed: ['orphan/tests/t.rs'], missing: [], noPubspec: [] });
  });

  // Value: protects=a hostile members glob or a file of unclosed cfg attributes cannot stall lane selection, which runs before
  //   any runner deadline; each probe runs in its own supervised Bun so a regression is killed and fails instead of hanging the
  //   file; fails_when=member globs backtrack again (an exponential '*a*a…b', or a rescan per unmatched '[') or the cfg scan
  //   rescans from every start (quadratic: about 80 s on 600 KB, against tens of ms now); why_new=port review; seam=none;
  //   no_claim=a wall-clock budget for selection (the 30 s kill only separates linear from super-linear)
  const supervised = (code: string) => spawnSync(process.execPath, [...bunIsolationArgs(), '-e', `import { cargoModel, hasCfgTest } from ${JSON.stringify(path.join(import.meta.dir, '..', 'lib', 'pregate', 'rust.ts'))};\n${code}`], { encoding: 'utf8', timeout: 30_000 });
  test('a hostile members glob is matched without backtracking', () => {
    const r = supervised(`
      const pkg = n => '[package]\\nname = "' + n + '"\\nversion = "0.1.0"\\n';
      const run = (members, dirs) => { const files = { 'Cargo.toml': '[workspace]\\nmembers = ' + JSON.stringify(members) + '\\n' }; dirs.forEach((d, i) => { files[d + '/Cargo.toml'] = pkg('k' + i); }); return cargoModel(Object.keys(files), f => files[f] ?? null); };
      const exp = run(['*a'.repeat(20) + 'b'], ['a'.repeat(40)]).crates.get('a'.repeat(40)).workspace;
      const brackets = run(['['.repeat(1000000)], Array.from({ length: 10 }, (_, i) => 'c' + i)).crates.get('c0').workspace;
      console.log(JSON.stringify([exp, brackets]));`);
    expect(r.error).toBeUndefined();
    expect(r.stdout.trim()).toBe(JSON.stringify(['a'.repeat(40), null]));
  }, 60_000);

  test('a run of unclosed cfg attributes is scanned once and counts as a test', () => {
    const r = supervised(`console.log(JSON.stringify([hasCfgTest('#[cfg('.repeat(100000)), hasCfgTest('#[cfg(unix)] fn a() {}\\n'.repeat(50000))]));`);
    expect(r.error).toBeUndefined();
    expect(r.stdout.trim()).toBe('[true,false]');
  }, 60_000);
});

describe('gstack-pregate on a Rust workspace', () => {
  const run = (repo: FixtureRepo, env: Record<string, string>) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--only', 'lanes'], env);
  // The cargo stand-in is a bash script the lane's Git Bash must find before the runner's real cargo; on windows-latest it
  // never did (three PATH repairs, the lane still exited 1 with an empty log), so the two cases that run it are POSIX-only,
  // like test/pregate-dart.test.ts's stand-ins. Selection, planning and the hostile-name case still run on Windows.
  const posixShim = test.skipIf(process.platform === 'win32');
  const log = (out: string) => fs.readFileSync(/log: (\S+)/.exec(out)![1]!, 'utf8');

  // Value: protects=the reported case end to end: a touched src file of a workspace crate is not PREGATE_NO_LANE, its crate and the
  //   dependent crates run with `cargo test -p` from the workspace root, and the summed count is reported; fails_when=any link of
  //   graph, plan or summary regresses; why_new=no Rust run existed; seam=none; no_claim=a real cargo (PATH shim reports cwd and argv)
  // TODO(#3380): Windows gap. This case is skipped on win32 until the cargo stand-in runs under the lane's Git Bash there; https://github.com/garrytan/gstack/pull/3380
  posixShim('a touched src file runs its crate and the crates depending on it from the workspace root', () => {
    const repo = rustRepo();
    commit(repo, { 'engine/crates/alpha/src/util.rs': 'pub fn two() -> u32 { 1 + 1 }\n' });
    const r = run(repo, cargoShim(repo));
    expect(r.out).not.toContain('has no test lane');
    expect(r.out).toMatch(/^tests {6}lanes {5}pass .*6 tests ran in 4 file\(s\), exit 0/m);
    expect(r.out).toContain("ran: (cd 'engine' && cargo test -p 'alpha') && (cd 'engine' && cargo test -p 'beta-core') && (cd 'engine' && cargo test -p 'gamma')");
    expect(log(r.out)).toContain('ran in engine: test -p alpha');
    expect(r.status).toBe(EXIT.ok);
  }, 60_000);

  // Value: protects=a crate whose test binaries all report 0 tests is ZERO-RUN (exit 0 is not a pass), and a failing cargo run is
  //   PREGATE_LANE_FAILED with its counts; fails_when=cargo's summary is unparsed (count unavailable passes) or the exit is ignored;
  //   why_new=the pure parser test does not run the lane; seam=none; no_claim=a real cargo (PATH shim)
  // TODO(#3380): Windows gap. This case is skipped on win32 until the cargo stand-in runs under the lane's Git Bash there; https://github.com/garrytan/gstack/pull/3380
  posixShim('zero tests is ZERO-RUN; a failing cargo run is PREGATE_LANE_FAILED', () => {
    const repo = rustRepo();
    commit(repo, { 'engine/crates/gamma/src/lib.rs': 'pub fn g() { }\n' });
    const zero = run(repo, cargoShim(repo, 'echo "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s"'));
    expect(zero.status).not.toBe(EXIT.ok);
    expect(zero.out).toMatch(/^tests {6}lanes {5}fail .*ZERO-RUN: the runner reported 0 tests in \(cd 'engine' && cargo test -p 'gamma'\)/m);
    const red = run(repo, cargoShim(repo, 'echo "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s"\nexit 101'));
    expect(red.status).not.toBe(EXIT.ok);
    expect(red.out).toMatch(/^tests {6}lanes {5}fail .*local lane exited 101 \(1 failed of 2 ran; 1 files; pipefail\)/m);
  }, 60_000);

  // Value: protects=a crate name is data from the repo's Cargo.toml that reaches the lane's shell and the {files} expansion,
  //   so a name Cargo would reject never runs (its files are unclaimed, the lane incomplete) and a valid one, Unicode
  //   included, still runs quoted; fails_when=the name is interpolated unchecked (`;touch` runs a command, `{files}` splices
  //   the quoted file list into the name); why_new=the crate runner was new; seam=none; no_claim=a real cargo (PATH shim)
  test('a crate name with shell syntax or {files} never reaches the shell; a valid Unicode name still runs', () => {
    const repo = rustRepo();
    const lib = '#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {}\n}\n';
    commit(repo, {
      'engine/crates/evil/Cargo.toml': '[package]\nname = "evil;touch pwned-by-crate-name"\nversion = "0.1.0"\n',
      'engine/crates/evil/src/lib.rs': lib,
      'engine/crates/splice/Cargo.toml': '[package]\nname = "evil{files}"\nversion = "0.1.0"\n',
      'engine/crates/splice/src/lib.rs': lib,
      'engine/crates/uni/Cargo.toml': '[package]\nname = "naïve_crate-2"\nversion = "0.1.0"\n',
      'engine/crates/uni/src/lib.rs': lib,
    }, 'odd crate names');
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    const env = cargoShim(repo);
    const ctx = { repoRoot: repo.work, config: DEFAULT_CONFIG, env } as unknown as PregateContext;
    expect(planRuns(ctx, ['engine/crates/evil/src/lib.rs', 'engine/crates/splice/src/lib.rs', 'engine/crates/uni/src/lib.rs'])).toEqual({
      groups: [{ runner: "cargo test -p 'naïve_crate-2'", cwd: 'engine', files: ['crates/uni/src/lib.rs'] }],
      unclaimed: ['engine/crates/evil/src/lib.rs', 'engine/crates/splice/src/lib.rs'], missing: [], noPubspec: [],
    });
    commit(repo, { 'engine/crates/evil/src/lib.rs': lib.replace('fn t() {}', 'fn t() { }') });
    const r = run(repo, env);
    expect(fs.existsSync(path.join(repo.work, 'engine', 'pwned-by-crate-name'))).toBe(false);
    expect(r.out).not.toContain('cargo test -p');
    expect(r.out).toContain('engine/crates/evil/src/lib.rs');
    expect(r.status).not.toBe(EXIT.ok);
  }, 60_000);

  // Value: protects=a crate with no tests still fails closed (no lane), so the crate mapping never invents coverage;
  //   fails_when=crate membership alone counts as a lane; why_new=negative control for the new mapping; seam=none; no_claim=none
  test('a touched file of a crate without tests still has no test lane', () => {
    const repo = rustRepo();
    commit(repo, { 'engine/crates/lonely/src/lib.rs': 'pub fn alone() { }\n' });
    const r = run(repo, cargoShim(repo));
    expect(r.out).toContain('(PREGATE_NO_POLICY)');
    expect(r.out).toContain('no policy: engine/crates/lonely/src/lib.rs have no test lane');
    expect(r.out).not.toMatch(/^tests {6}lanes {5}pass /m);
  }, 60_000);
});
