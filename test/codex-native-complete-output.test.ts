/** Full generated Codex skills AND carved sections, never the live install. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const scratch = mkdtempSync(join(tmpdir(), 'gstack-codex-complete-output-'));
const rendered = join(scratch, 'render');
const skills = join(rendered, '.agents', 'skills');

function read(skill: string, section?: string): string {
  return readFileSync(join(skills, `gstack-${skill}`, section ? `sections/${section}.md` : 'SKILL.md'), 'utf8');
}

function readComplete(skill: string): string {
  return corpus(join(skills, `gstack-${skill}`)).map(file => file.text).join('\n');
}

function corpus(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? corpus(path)
      : /\.(?:md|yaml)$/.test(entry.name) ? [{ path: relative(skills, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }] : [];
  });
}

beforeAll(() => {
  for (const host of ['codex', 'claude']) {
    const child = Bun.spawnSync([process.execPath, '--no-env-file', 'run', 'scripts/gen-skill-docs.ts', '--host', host, '--out-dir', rendered], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(scratch, 'home'), GSTACK_HOME: join(scratch, 'state'), CODEX_HOME: join(scratch, 'codex'), TMPDIR: scratch },
      timeout: 120_000,
    });
    if (child.exitCode !== 0) throw new Error(`isolated ${host} render failed: ${child.stderr.toString()}`);
  }
}, 120_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('complete native Codex output', () => {
  test('all generated skills and sections reject executable legacy dispatch dependencies', () => {
    const files = corpus(skills).filter(file => !file.path.startsWith('gstack-claude-code/'));
    expect(files.some(file => file.path === 'gstack-office-hours/sections/design-and-handoff.md')).toBe(true);
    expect(files.some(file => file.path === 'gstack-ship/sections/pr-body.md')).toBe(true);
    const legacy = /subagent_type:\s*["']general-purpose|run_in_background:\s*false|\bclaude\s+-p\b/;
    const violations = files.flatMap(file => file.text.split('\n').flatMap((line, index) => legacy.test(line) ? [`${file.path}:${index + 1}: ${line}`] : []));
    expect(violations).toEqual([]);
    expect(read('claude-code')).toContain('claude -p');
    expect(read('review')).toContain('Fix-First');
    const officeHours = readComplete('office-hours');
    expect(officeHours).toContain('## Phase 4: Alternatives Generation');
    expect(officeHours).toContain('Produce 2-3 distinct implementation approaches.');
    expect(officeHours).toContain('Emit ONE AskUserQuestion that lists every alternative (A/B and optionally C) as numbered options');
    expect(officeHours).toContain('**STOP.** Do NOT proceed to Phase 4.5 (Founder Signal Synthesis), Phase 5 (Design Doc), Phase 6 (Closing), or any design-doc generation until the user responds.');
    expect(officeHours).toContain('A "clearly winning approach" is still an approach decision and still needs explicit user approval before it lands in the design doc.');
  });

  test('office hours retains both mode-specific cold reads and two design lenses', () => {
    const output = readComplete('office-hours');
    for (const criterion of ['STRONGEST version', 'COOLEST version', '48 hours', 'weekend', 'visual thesis', 'hero → support → detail → CTA', 'specific font names, hex', 'color values, and spacing values', 'label unverified font availability']) {
      expect(output).toContain(criterion);
    }
    expect(output).toContain('fork_turns: "none"');
    expect(output).toContain('not cross-model');
    expect(output).toContain('review_not_run');
  });

  test('spec review retains all five dimensions, bounded revisions, and concern persistence', () => {
    const output = read('office-hours', 'design-and-handoff');
    for (const criterion of ['Completeness', 'Consistency', 'Clarity', 'Scope', 'Feasibility', 'Maximum 3 iterations', 'Reviewer Concerns', 'quality_score']) expect(output).toContain(criterion);
    expect(output).toContain('fork_turns: "none"');
    expect(output).toContain('unreviewed doc');
  });

  test('plan and documentation reviews retain their distinct acceptance criteria', () => {
    const plan = read('plan-ceo-review', 'review-sections');
    const planAll = read('plan-ceo-review') + plan;
    for (const criterion of ['logical gaps', 'overcomplexity', 'feasibility', 'sequencing', 'strategic', 'user decides']) expect(planAll).toContain(criterion);
    const docs = readComplete('document-release');
    for (const criterion of ['DOC_DIFF_BASE', 'commands, flags, config keys', 'stale examples', 'CHANGELOG', 'Decide per-finding', 'codex-doc-review']) expect(docs).toContain(criterion);
  });

  test('readiness and report consumers preserve review data without promising Claude or recursive wrappers', () => {
    for (const skill of ['ship', 'plan-ceo-review', 'plan-eng-review', 'plan-devex-review', 'devex-review']) {
      const output = readComplete(skill);
      expect(output).toContain('Review Readiness Dashboard');
      expect(output).toContain('| Runs | Last');
      expect(output).toContain('VERDICT:');
      expect(output).not.toContain('Every diff gets both Claude');
    }
  });

  test('plan mode preserves developer authority and real user approval gates', () => {
    const output = read('office-hours');
    expect(output).toContain('System and developer instructions determine the active mode');
    expect(output).toContain('plain-text question');
    expect(output).toContain('takes precedence over generic plan mode behavior');
    expect(output).toContain('only within those constraints');
    expect(output).toContain('PLAN MODE EXCEPTION — ALWAYS RUN');
    expect(output).toContain('Call ExitPlanMode only after the skill workflow completes');
    expect(read('plan-eng-review')).toContain('NO UNRESOLVED DECISIONS');
  });

  test('ship documentation keeps full workflow and JSON completion without auto-approving gates', () => {
    const output = read('ship', 'pr-body');
    for (const criterion of ['CHANGELOG', 'documentation_section', 'pushed']) expect(output).toContain(criterion);
    const documentation = read('ship', 'documentation');
    for (const criterion of ['/document-release', 'files_updated', 'documentation_section', 'decisions', 'native Codex worker', 'never auto-approve']) expect(documentation).toContain(criterion);
    expect(documentation).not.toContain('auto-choose the RECOMMENDED option');
  });

  test('spec metadata matches the host and engine lock advice preserves process ownership', () => {
    expect(read('spec').split('\n---')[0]).toContain('Codex');
    expect(read('spec').split('\n---')[0]).not.toContain('Claude Code agent');
    const sync = read('sync-gbrain');
    expect(sync).toContain('engine-locked');
    expect(sync).toContain('do not stop or kill');
    expect(sync).not.toContain('Stop that process');
  });

  test('other-host workflows retain their legacy execution paths and review dimensions', () => {
    const claude = (skill: string, section?: string): string => readFileSync(join(rendered, skill, section ? `sections/${section}.md` : 'SKILL.md'), 'utf8');
    expect(claude('office-hours')).toContain('Claude subagent');
    expect(claude('office-hours', 'design-and-handoff')).toContain('Use the Agent tool');
    expect(claude('spec')).toContain('Claude Code agent');
    expect(claude('ship', 'documentation')).toContain('subagent_type: "general-purpose"');
  });
});
