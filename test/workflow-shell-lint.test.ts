/**
 * Workflow run-step shells (free).
 *
 * GitHub's default shell for a `run` step is `bash -e {0}` on a Linux runner
 * but `sh -e {0}` inside a container job (actions/runner picks sh when the
 * step runs in a job container), and the `sh` in gstack's CI image is dash. A
 * step that leans on a bash expansion under that default dies before its first
 * command: run 40456150409 (evals.yml, train-bisect (1)(2)(3)) failed every
 * prefix at "Verify the prefix checkout" with `sh: 6: Bad substitution` on
 * `${PREFIX_SHA:0:12}`, so no bisect had ever run a case in CI. The job now
 * declares `defaults.run.shell: bash`.
 *
 * This test computes each run step's effective shell (step `shell` → job
 * `defaults.run.shell` → workflow `defaults.run.shell` → GitHub's default for
 * the job: sh for a container job, pwsh on Windows, bash otherwise; composite
 * actions always name a shell) and fails when a step whose effective shell is
 * sh uses a bash-only construct. Static, offline, parses every workflow and
 * composite action under .github/.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const GITHUB_DIR = path.join(ROOT, '.github');

/** Bash-only constructs POSIX sh (dash) rejects or misreads, by name. */
export const BASHISMS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // ${x:0:12}, ${x: -3}, ${x:$a:$b}, ${@:2}, ${1:0:2}; ${x:-d} ${x:=d} ${x:?m} ${x:+a} are POSIX.
  { name: 'substring expansion ${x:offset:length}', pattern: /\$\{(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*]):(?![-+?=])/ },
  // ${x/a/b}, ${x//a/b}, ${x^^}, ${x,,}, ${x@Q}, ${!x}; ${x#p} ${x%s} are POSIX.
  { name: 'pattern or case expansion ${x/…} ${x^^} ${x,,} ${x@…}', pattern: /\$\{[A-Za-z_][A-Za-z0-9_]*[/^,@]/ },
  { name: 'indirect expansion ${!x}', pattern: /\$\{![A-Za-z_]/ },
  { name: '[[ … ]] test', pattern: /(?:^|[\s;(&|!])\[\[(?:\s|$)/m },
  { name: 'array assignment name=(…)', pattern: /(?:^|[\s;(])[A-Za-z_][A-Za-z0-9_]*(?:\+)?=\(/m },
  { name: 'array expansion ${x[…]}', pattern: /\$\{[A-Za-z_][A-Za-z0-9_]*\[/ },
  { name: 'declare/local/readonly -a or -A, mapfile, readarray', pattern: /(?:^|[\s;])(?:(?:declare|local|readonly|typeset)\s+-[a-zA-Z]*[aA]|mapfile|readarray)\b/m },
  { name: 'set -o pipefail', pattern: /(?:^|[\s;&|])set\s+(?:-[a-zA-Z]*\s+)*-(?:[a-zA-Z]*o\s+pipefail|o\s+pipefail)\b/m },
  { name: 'PIPESTATUS', pattern: /\bPIPESTATUS\b/ },
  { name: 'here-string <<<', pattern: /<<</ },
  { name: 'process substitution <(…) >(…)', pattern: /(?:^|[\s=])[<>]\(/m },
  { name: "ANSI-C quoting $'…'", pattern: /\$'/ },
  { name: 'source (use .)', pattern: /(?:^|[\s;&|])source\s/m },
  { name: 'function keyword', pattern: /(?:^|[\s;])function\s+[A-Za-z_]/m },
];

/** Shell lines, comment lines dropped so a prose mention of a construct does not count. */
function scriptLines(script: string): string {
  return script.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
}

/** Names of the bash-only constructs a script uses. */
export function bashisms(script: string): string[] {
  const body = scriptLines(script);
  return BASHISMS.filter(({ pattern }) => pattern.test(body)).map(({ name }) => name);
}

/** sh, bash, pwsh, python, cmd… from a `shell:` value such as `bash -e {0}` or `/usr/bin/sh`. */
export function shellKind(shell: unknown): string | null {
  if (typeof shell !== 'string' || shell.trim() === '') return null;
  const command = shell.trim().split(/\s+/)[0]!;
  const base = command.slice(command.lastIndexOf('/') + 1).toLowerCase();
  return base === 'dash' ? 'sh' : base;
}

/** GitHub's default shell for a job with no `shell` anywhere in its chain. */
export function defaultShellForJob(job: any): string {
  if (job?.container !== undefined && job?.container !== null) return 'sh';
  const runsOn = JSON.stringify(job?.['runs-on'] ?? '').toLowerCase();
  return runsOn.includes('windows') ? 'pwsh' : 'bash';
}

export function effectiveShell(step: any, job: any, workflow: any): string {
  return shellKind(step?.shell) ?? shellKind(job?.defaults?.run?.shell) ?? shellKind(workflow?.defaults?.run?.shell) ?? defaultShellForJob(job);
}

type RunStep = { file: string; job: string; step: string; shell: string; run: string };

/** Every run step in the repository's workflows and composite actions with its effective shell. */
export function runSteps(): RunStep[] {
  const steps: RunStep[] = [];
  const workflows = path.join(GITHUB_DIR, 'workflows');
  for (const name of fs.readdirSync(workflows).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const file = path.join('.github', 'workflows', name);
    const workflow = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) as any;
    for (const [jobName, job] of Object.entries<any>(workflow?.jobs ?? {})) {
      for (const [index, step] of (Array.isArray(job?.steps) ? job.steps : []).entries()) {
        if (typeof step?.run !== 'string') continue;
        steps.push({ file, job: jobName, step: step.name ?? step.id ?? `step ${index + 1}`, shell: effectiveShell(step, job, workflow), run: step.run });
      }
    }
  }
  const actions = path.join(GITHUB_DIR, 'actions');
  for (const name of fs.existsSync(actions) ? fs.readdirSync(actions).sort() : []) {
    for (const base of ['action.yml', 'action.yaml']) {
      const file = path.join('.github', 'actions', name, base);
      if (!fs.existsSync(path.join(ROOT, file))) continue;
      const action = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) as any;
      for (const [index, step] of (Array.isArray(action?.runs?.steps) ? action.runs.steps : []).entries()) {
        if (typeof step?.run !== 'string') continue;
        steps.push({ file, job: 'runs', step: step.name ?? step.id ?? `step ${index + 1}`, shell: shellKind(step.shell) ?? 'sh', run: step.run });
      }
    }
  }
  return steps;
}

describe('workflow run-step shells', () => {
  test('the detector names bash-only constructs and accepts POSIX sh', () => {
    const cases: Array<[string, string]> = [
      ['echo "short=${PREFIX_SHA:0:12}" >> "$GITHUB_OUTPUT"', 'substring expansion'],
      ['x=${name: -3}', 'substring expansion'],
      ['set -- "${@:2}"', 'substring expansion'],
      ['echo "${1:0:2}"', 'substring expansion'],
      ['echo "${path//\\//_}"', 'pattern or case expansion'],
      ['echo "${name^^}"', 'pattern or case expansion'],
      ['echo "${!ref}"', 'indirect expansion'],
      ['if [[ -n "$x" ]]; then echo y; fi', '[[ … ]] test'],
      ['args=(--one --two)', 'array assignment'],
      ['echo "${args[@]}"', 'array expansion'],
      ['declare -a list', 'declare/local/readonly -a'],
      ['set -euo pipefail', 'set -o pipefail'],
      ['set -o pipefail', 'set -o pipefail'],
      ['cmd | tee log; test "${PIPESTATUS[0]}" = 0', 'PIPESTATUS'],
      ['read -r a <<< "$line"', 'here-string'],
      ['diff <(sort a) <(sort b)', 'process substitution'],
      ["printf $'a\\tb'", 'ANSI-C quoting'],
      ['source ./env.sh', 'source (use .)'],
      ['function greet { echo hi; }', 'function keyword'],
    ];
    for (const [script, expected] of cases) {
      expect(bashisms(script).join('; '), script).toContain(expected);
    }
    for (const posix of [
      'echo "${HOME:-/tmp}" "${X:=d}" "${Y:?missing}" "${Z:+alt}" "${1:-x}" "${@}" "$*"',
      'echo "${file#*/}" "${file##*/}" "${file%.ts}" "${file%%.*}" "${#name}"',
      'out=$(git rev-parse HEAD); if [ "$out" != "$PREFIX_SHA" ]; then exit 1; fi',
      '. ./env.sh && printf "%s\\n" "$out" >> "$GITHUB_OUTPUT"',
      'case "$x" in a) echo a ;; *) echo b ;; esac',
      'set -eu\nmkdir -p "$dir"',
      'echo "$(( 1 + 2 ))"',
      '# [[ in a comment, ${x:0:1} too\necho ok',
    ]) {
      expect(bashisms(posix), posix).toEqual([]);
    }
  });

  test('the effective shell follows step, job defaults, workflow defaults, then the runner default', () => {
    const container = { 'runs-on': 'ubicloud-standard-8', container: { image: 'ghcr.io/x/ci' } };
    const linux = { 'runs-on': 'ubuntu-24.04' };
    const windows = { 'runs-on': 'windows-latest' };
    expect(effectiveShell({}, container, {})).toBe('sh');
    expect(effectiveShell({}, linux, {})).toBe('bash');
    expect(effectiveShell({}, windows, {})).toBe('pwsh');
    expect(effectiveShell({}, { 'runs-on': '${{ matrix.os }}' }, {})).toBe('bash');
    expect(effectiveShell({ shell: 'bash' }, container, {})).toBe('bash');
    expect(effectiveShell({}, { ...container, defaults: { run: { shell: 'bash' } } }, {})).toBe('bash');
    expect(effectiveShell({}, container, { defaults: { run: { shell: '/usr/bin/bash -e {0}' } } })).toBe('bash');
    expect(effectiveShell({ shell: 'sh' }, { ...linux, defaults: { run: { shell: 'bash' } } }, {})).toBe('sh');
    expect(effectiveShell({ shell: 'dash -e {0}' }, linux, {})).toBe('sh');
    expect(effectiveShell({ shell: 'python' }, container, {})).toBe('python');
  });

  test('no run step whose effective shell is sh uses a bash-only construct', () => {
    const steps = runSteps();
    expect(steps.length).toBeGreaterThan(100);
    const sh = steps.filter((step) => step.shell === 'sh');
    // Container jobs without a shell default are where this bites; a parse that
    // found none would pass vacuously.
    expect(sh.length, 'expected at least one sh-defaulted container step to lint').toBeGreaterThan(0);
    const problems = sh.flatMap((step) => bashisms(step.run).map((name) => `${step.file} ${step.job} / "${step.step}": ${name}`));
    expect(problems, 'give the job defaults.run.shell: bash (or the step shell: bash)').toEqual([]);
  });

  test('evals.yml train-bisect runs its steps under bash (run 40456150409 died at ${PREFIX_SHA:0:12} under sh)', () => {
    const steps = runSteps().filter((step) => step.file === path.join('.github', 'workflows', 'evals.yml') && step.job === 'train-bisect');
    expect(steps.map((step) => step.step)).toContain('Verify the prefix checkout');
    for (const step of steps) expect(step.shell, step.step).toBe('bash');
  });
});
