/**
 * GSTA-133 ratchet: every gstack bin a skill invokes exists, and every --flag a
 * skill passes to it appears in that bin's parser. scripts/skill-bin-drift.ts
 * reads templates, carved sections and Claude-host renders statically (it never
 * executes a bin). Today's misses live in test/fixtures/skill-bin-drift-allowlist.json,
 * which may only shrink: a new finding fails, and so does an entry that no
 * longer reproduces. PERMISSIVE and NO_HELP bins are reported, never failed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import {
  ALLOWLIST_FILE,
  FIX_LINE,
  compareAllowlist,
  formatFinding,
  loadAllowlist,
  scanRepo,
  scanText,
} from '../scripts/skill-bin-drift';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'skill-bin-drift.ts');

describe('skill-bin-drift: repository ratchet', () => {
  const report = scanRepo(ROOT);
  const allowlist = loadAllowlist(path.join(ROOT, ALLOWLIST_FILE));

  test('reads templates, carved sections and Claude-host renders', () => {
    expect(report.inputs).toEqual(expect.arrayContaining(['learn/SKILL.md.tmpl', 'learn/SKILL.md', 'ship/sections/pr-body.md.tmpl', 'ship/sections/pr-body.md']));
    expect(report.calls.length).toBeGreaterThan(500);
    expect(report.binsInvoked.length).toBeGreaterThan(50);
  });

  test('no drift outside the shrink-only allowlist', () => {
    const { unlisted } = compareAllowlist(report.findings, allowlist);
    if (unlisted.length > 0) throw new Error(`${unlisted.length} skill-to-bin drift finding(s):\n${unlisted.map(formatFinding).join('\n')}`);
  });

  test('every allowlist entry still reproduces, so the list only shrinks', () => {
    const { stale } = compareAllowlist(report.findings, allowlist);
    if (stale.length > 0) throw new Error(`delete these entries from ${ALLOWLIST_FILE}; they no longer reproduce:\n${stale.join('\n')}`);
  });

  test('allowlist is sorted, unique and explains itself', () => {
    expect(allowlist._comment).toContain('Shrink-only');
    expect(allowlist.entries).toEqual([...new Set(allowlist.entries)].sort());
  });

  test('help backlog and permissive parsers are listed, not failed', () => {
    for (const bin of [...report.noHelp, ...report.permissive]) expect(report.binsInvoked).toContain(bin);
    for (const bin of ['gstack-learnings-search', 'gstack-learnings-log']) {
      expect(report.permissive).not.toContain(bin);
      expect(report.noHelp).not.toContain(bin);
    }
  });
});

describe('skill-bin-drift: fixtures', () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

  function fixture(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-skill-bin-drift-'));
    roots.push(root);
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    return root;
  }

  const BASH_BIN = ['#!/usr/bin/env bash',
    '# gstack-notes-search — read notes',
    '# Usage: gstack-notes-search [--type TYPE] [--limit N]',
    'set -euo pipefail',
    'TYPE=""; LIMIT=10',
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    '    --type) TYPE="$2"; shift 2 ;;',
    '    --limit|--max) LIMIT="$2"; shift 2 ;;',
    '    -h|--help) sed -n 2,3p "$0"; exit 0 ;;',
    '    -*) echo "gstack-notes-search: unknown flag $1" >&2; exit 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    'echo "$TYPE $LIMIT"',
    ''].join('\n');
  const PERMISSIVE_BIN = ['#!/usr/bin/env bash',
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    '    --type) TYPE="$2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    ''].join('\n');
  const skill = (body: string) => `---\nname: demo\n---\n# Demo\n\n${body}\n`;
  const fence = (cmd: string) => ['```bash', cmd, '```'].join('\n');

  test('a real-shaped bash bin with case arms and a valid flag passes', () => {
    const root = fixture({
      'bin/gstack-notes-search': BASH_BIN,
      'demo/SKILL.md.tmpl': skill(fence('~/.claude/skills/gstack/bin/gstack-notes-search --type pitfall --max 5 2>/dev/null || true')),
    });
    const report = scanRepo(root);
    expect(report.calls).toEqual([{ file: 'demo/SKILL.md.tmpl', line: 7, bin: 'gstack-notes-search', flags: ['--type', '--max'] }]);
    expect(report.findings).toEqual([]);
    expect(report.permissive).toEqual([]);
    expect(report.noHelp).toEqual([]);
  });

  test('negative control: an invented flag on a real bin fails with file:line and the fix line', () => {
    const root = fixture({
      'bin/gstack-notes-search': BASH_BIN,
      'demo/SKILL.md.tmpl': skill(fence('~/.claude/skills/gstack/bin/gstack-notes-search --type pitfall --invented-flag')),
    });
    const [finding, ...rest] = scanRepo(root).findings;
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ code: 'DRIFT_UNKNOWN_FLAG', file: 'demo/SKILL.md.tmpl', line: 7, bin: 'gstack-notes-search', flag: '--invented-flag', key: 'demo/SKILL.md.tmpl:gstack-notes-search:--invented-flag', fix: FIX_LINE });
    expect(formatFinding(finding!)).toContain('DRIFT_UNKNOWN_FLAG demo/SKILL.md.tmpl:7');
  });

  test('flags after a pipe, ;, && or $( ) belong to the next command', () => {
    const cmds = [
      'bin/gstack-notes-search --type a | grep --count --fixed-strings x',
      'bin/gstack-notes-search --limit 3; git log --oneline',
      'bin/gstack-notes-search && jq --raw-output .x',
      'bin/gstack-notes-search --limit 2 2>&1 | grep --count x',
      'X=$(bin/gstack-notes-search --type a) || sort --unique',
    ].join('\n');
    const root = fixture({ 'bin/gstack-notes-search': BASH_BIN, 'demo/SKILL.md.tmpl': skill(fence(cmds)) });
    const report = scanRepo(root);
    expect(report.calls.map(c => c.flags)).toEqual([['--type'], ['--limit'], [], ['--limit'], ['--type']]);
    expect(report.findings).toEqual([]);
  });

  test('a redirect does not end the command: flags after it are still checked', () => {
    const cmds = [
      'bin/gstack-notes-search --type a 2>/dev/null --bogus',
      'bin/gstack-notes-search >> out.txt --max 3',
      'bin/gstack-notes-search 2> err.log --limit 1',
    ].join('\n');
    const root = fixture({ 'bin/gstack-notes-search': BASH_BIN, 'demo/SKILL.md.tmpl': skill(fence(cmds)) });
    const report = scanRepo(root);
    expect(report.calls.map(c => c.flags)).toEqual([['--type', '--bogus'], ['--max'], ['--limit']]);
    expect(report.findings.map(f => f.flag)).toEqual(['--bogus']);
  });

  test('a TS bin with string-literal flags one relative import deep passes; two deep does not count', () => {
    const root = fixture({
      'bin/gstack-ts-tool': `#!/usr/bin/env -S bun --no-env-file --config=/dev/null\nimport { parse } from '../lib/tool-args';\nparse(process.argv.slice(2));\n`,
      'lib/tool-args.ts': `import { deeper } from './tool-deeper';\nexport function parse(argv: string[]) { return argv.includes('--dry-run') || argv.includes("--json") || deeper(argv); }\n`,
      'lib/tool-deeper.ts': `export function deeper(argv: string[]) { return argv.includes('--too-deep'); }\n`,
      'demo/SKILL.md.tmpl': skill('Run `bin/gstack-ts-tool --dry-run --json`, then `bin/gstack-ts-tool --too-deep`.'),
    });
    const report = scanRepo(root);
    expect(report.findings.map(f => f.key)).toEqual(['demo/SKILL.md.tmpl:gstack-ts-tool:--too-deep']);
  });

  test('a bash bin that hands off to a .ts file gains its flags', () => {
    const root = fixture({
      'bin/gstack-wrapper': '#!/usr/bin/env bash\n# Usage: gstack-wrapper [--fast]\nexec bun run "$(dirname "$0")/../lib/wrapper-impl.ts" "$@"\n',
      'lib/wrapper-impl.ts': "const fast = process.argv.includes('--fast');\n",
      'demo/SKILL.md.tmpl': skill(fence('$GSTACK_BIN/gstack-wrapper --fast')),
    });
    expect(scanRepo(root).findings).toEqual([]);
  });

  test('a catch-all arg loop is PERMISSIVE, and its unknown flags still fail', () => {
    const root = fixture({
      'bin/gstack-loose': PERMISSIVE_BIN,
      'demo/SKILL.md.tmpl': skill(fence('{{BIN_DIR}}/gstack-loose --type x --ignored')),
    });
    const report = scanRepo(root);
    expect(report.permissive).toEqual(['gstack-loose']);
    expect(report.noHelp).toEqual(['gstack-loose']);
    expect(report.findings.map(f => f.key)).toEqual(['demo/SKILL.md.tmpl:gstack-loose:--ignored']);
  });

  test('a missing bin is DRIFT_UNKNOWN_BIN keyed without a flag', () => {
    const root = fixture({ 'bin/.keep': '', 'demo/SKILL.md.tmpl': skill(fence('~/.claude/skills/gstack/bin/gstack-gone --x')) });
    expect(scanRepo(root).findings.map(f => [f.code, f.key])).toEqual([['DRIFT_UNKNOWN_BIN', 'demo/SKILL.md.tmpl:gstack-gone']]);
  });

  test('prose and placeholders do not false-positive', () => {
    const text = [
      'Pass bin/gstack-notes-search --nope <VALUE> in prose: not code, not scanned.',
      '`bin/gstack-notes-search --type <TYPE> --limit {{LIMIT}}`',
      fence('bin/gstack-notes-search --type <kind of note> --limit "$N"  # --not-a-flag in a comment'),
    ].join('\n');
    const calls = scanText(text, 'demo/SKILL.md.tmpl');
    expect(calls.map(c => [c.line, c.flags])).toEqual([[2, ['--type', '--limit']], [4, ['--type', '--limit']]]);
  });

  test('a render finding its own template already reports is dropped; render-only findings stay', () => {
    const root = fixture({
      'bin/gstack-notes-search': BASH_BIN,
      'demo/SKILL.md.tmpl': skill(fence('bin/gstack-notes-search --bad')),
      'demo/SKILL.md': `<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n${fence('bin/gstack-notes-search --bad')}\n${fence('bin/gstack-notes-search --resolver-made')}\n`,
    });
    expect(scanRepo(root).findings.map(f => f.key)).toEqual(['demo/SKILL.md:gstack-notes-search:--resolver-made', 'demo/SKILL.md.tmpl:gstack-notes-search:--bad']);
  });

  test('allowlist comparison reports unlisted findings and stale entries', () => {
    const root = fixture({ 'bin/gstack-notes-search': BASH_BIN, 'demo/SKILL.md.tmpl': skill(fence('bin/gstack-notes-search --bad')) });
    const { findings } = scanRepo(root);
    expect(compareAllowlist(findings, { entries: [] }).unlisted.map(f => f.key)).toEqual(['demo/SKILL.md.tmpl:gstack-notes-search:--bad']);
    const result = compareAllowlist(findings, { entries: ['demo/SKILL.md.tmpl:gstack-notes-search:--bad', 'other/SKILL.md.tmpl:gstack-x:--y'] });
    expect(result).toEqual({ unlisted: [], stale: ['other/SKILL.md.tmpl:gstack-x:--y'] });
    expect(compareAllowlist(findings, { entries: ['other/SKILL.md.tmpl:gstack-x:--y'] }, ['demo/SKILL.md.tmpl']).stale).toEqual([]);
  });

  test('CLI: --skill scans one skill, --json reports, exit codes follow the allowlist', () => {
    const root = fixture({
      'bin/gstack-notes-search': BASH_BIN,
      'demo/SKILL.md.tmpl': skill(fence('bin/gstack-notes-search --bad')),
      'other/SKILL.md.tmpl': skill(fence('bin/gstack-notes-search --type ok')),
    });
    const run = (...args: string[]) => {
      const child = Bun.spawnSync([process.execPath, ...bunIsolationArgs(), SCRIPT, '--root', root, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
      return { code: child.exitCode, out: child.stdout.toString() + child.stderr.toString() };
    };
    const other = run('--skill', 'other', '--json');
    expect(other.code).toBe(0);
    expect(JSON.parse(other.out)).toMatchObject({ inputs: 1, calls: 1, unknownFlags: 0, unlisted: [] });
    const demo = run('--skill', 'demo');
    expect(demo.code).toBe(1);
    expect(demo.out).toContain('DRIFT_UNKNOWN_FLAG demo/SKILL.md.tmpl:7 bin=gstack-notes-search flag=--bad');
    expect(demo.out).toContain(FIX_LINE);
    expect(run('--skill', 'missing').code).toBe(2);
    expect(run('--help').code).toBe(0);
  });
});
