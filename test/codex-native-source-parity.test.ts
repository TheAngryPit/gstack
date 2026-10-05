import { describe, expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { adaptNativeTemplate } from '../scripts/resolvers/native-template';
import { replaceBlock } from '../scripts/resolvers/native-template-utils';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { RESOLVERS } from '../scripts/resolvers';
import { generateSpecReviewLoop } from '../scripts/resolvers/spec-review';
import { generateQuestionTuning } from '../scripts/resolvers/question-tuning';
import { runGeneration } from '../scripts/gen-skill-docs';

const root = resolve(import.meta.dir, '..');
const ORIGINAL: string = JSON.parse(readFileSync(resolve(root, 'codex-parity.json'), 'utf8')).upstream_commit;
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, timeout: 30_000 });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
const paths = git('ls-tree', '-r', '--name-only', ORIGINAL).trim().split('\n')
  .filter(path => /^(?:SKILL\.md\.tmpl|[^/]+\/SKILL\.md\.tmpl|[^/]+\/sections\/[^/]+\.md\.tmpl)$/.test(path));
function ctx(skillName: string, host = 'codex'): TemplateContext {
  return { skillName, tmplPath: `${skillName}/SKILL.md.tmpl`, host, paths: HOST_PATHS[host] };
}
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('original source to native obligations', () => {
  test('CEO native review preserves required metrics, failure stops and state-root resolution', () => {
    const source = git('show', `${ORIGINAL}:scripts/resolvers/spec-review.ts`);
    const native = generateSpecReviewLoop(ctx('plan-ceo-review'));
    for (const obligation of ['0H spec-review metrics', 'required when writing is permitted',
      'even if the reviewer failed', 'failed mkdir', 'failed append', 'JSON null',
      '## Reviewer Concerns', '0D', '0H approval', 'both inputs']) {
      expect(native).toContain(obligation);
    }
    expect(source).toContain('failed mkdir or append stops the review');
    expect(native).toContain('gstack-paths --get GSTACK_STATE_ROOT');
    expect(native).toContain('GSTACK_STATE_ROOT/analytics/spec-review.jsonl');
    expect(native).not.toContain('~/.gstack/analytics');
    expect(native).not.toContain('Append best-effort metrics');
    expect(generateSpecReviewLoop(ctx('plan-eng-review'))).toContain('best-effort');
    expect(generateSpecReviewLoop(ctx('plan-ceo-review', 'claude'))).toContain('failed mkdir or append stops the review');
  });

  test('all pinned upstream inputs remain present and every other-host adapter is identity', () => {
    expect(ORIGINAL).toMatch(/^[0-9a-f]{40}$/);
    git('merge-base', '--is-ancestor', ORIGINAL, 'HEAD');
    expect(git('show', `${ORIGINAL}:VERSION`).trim()).toBe(JSON.parse(read('codex-parity.json')).upstream_version);
    expect(paths.length).toBeGreaterThan(0);
    expect(read('VERSION').trim()).toBe(JSON.parse(read('codex-parity.json')).upstream_version);
    for (const path of paths) {
      const text = read(path);
      for (const host of ['claude', 'factory', 'kiro', 'opencode', 'slate', 'cursor', 'copilot', 'openclaw', 'hermes', 'gbrain']) {
        expect(adaptNativeTemplate(text, ctx(path.split('/')[0], host), path)).toBe(text);
      }
    }
  });

  test('every original autoplan reviewer criterion survives in its distinct native lens', () => {
    const phases = ['ceo', 'design', 'dx', 'eng'] as const;
    const criteriaByPhase: Record<(typeof phases)[number], string[]> = {
      ceo: ['Challenge the strategic foundations', '10x more impactful', 'What alternatives were dismissed', 'competitive or market risks'],
      design: ['information hierarchy', 'interaction states', 'responsive strategy', 'accessibility requirements'],
      dx: ['Time to hello world', 'Error messages', 'API/CLI design', 'Upgrade path'],
      eng: ['architectural issues', 'missing edge cases', 'hidden complexity', 'Section 3 (Test Review)'],
    };
    for (const phase of phases) {
      const path = `autoplan/sections/${phase}-phase.md.tmpl`;
      const source = git('show', `${ORIGINAL}:${path}`);
      const output = adaptNativeTemplate(read(path), ctx('autoplan'), path);
      for (const criterion of criteriaByPhase[phase]) {
        expect(normalize(source).toLowerCase()).toContain(criterion.toLowerCase());
        expect(normalize(output).toLowerCase()).toContain(criterion.toLowerCase());
      }
      expect(output).toContain('primary reviewer stays independent');
      expect(output).toContain('Native reviewer B');
      expect(output).toContain('review_not_run');
      expect(output).not.toContain('codex exec');
      expect(output).not.toContain('subagent_type');
      const originalOutputs = source.slice(source.indexOf('**Mandatory outputs'));
      if (source.includes('**Mandatory outputs')) {
        for (const line of originalOutputs.split('\n').filter(line => line.startsWith('- '))) {
          expect(output).toContain(line);
        }
      }
    }
  });

  test('autoplan retains all consensus dimensions, ordered phases, user challenges and reruns', () => {
    const path = 'autoplan/SKILL.md.tmpl';
    const output = adaptNativeTemplate(read(path), ctx('autoplan'), path);
    const headings = ['## Phase 1: CEO', '## Phase 2: Design', '## Phase 2.5: DX', '## Phase 3: Eng', '## Phase 4: Final'];
    expect(headings.map(h => output.indexOf(h))).toEqual(headings.map(h => output.indexOf(h)).sort((a,b) => a-b));
    for (const contract of ['The 6 Decision Principles', 'Mechanical', 'Taste', 'User Challenge', 'Never auto-decide User Challenges', 'Decision Audit Trail', '## Decision Audit Trail', '| # | Phase | Decision | Classification | Principle | Rationale | Rejected |', 'Max 3 cycles', 'Re-run Eng, then re-present the gate.', 'human gate']) expect(output).toContain(contract);
    expect(normalize(output).toLowerCase()).toContain('an unavailable required review stays pending');
    for (const phase of ['ceo', 'dx', 'eng']) {
      const path = `autoplan/sections/${phase}-phase.md.tmpl`;
      const source = git('show', `${ORIGINAL}:${path}`);
      const rendered = adaptNativeTemplate(read(path), ctx('autoplan'), path);
      for (const line of source.split('\n').filter(line => /^  [1-6]\. .*—/.test(line))) expect(rendered).toContain(line);
    }
    const dx = adaptNativeTemplate(read('autoplan/sections/dx-phase.md.tmpl'), ctx('autoplan'), 'autoplan/sections/dx-phase.md.tmpl');
    expect(dx).not.toContain('Eng: <insert Eng consensus');
    expect(dx).toContain('Design: <insert Design consensus summary');
    expect(dx).toContain('CEO: <insert CEO consensus summary');
  });

  test('native opinions keep mutually exclusive scope, all mode criteria and fail-closed order', () => {
    const output = RESOLVERS.NATIVE_OPINION_MODES(ctx('review'));
    for (const obligation of ['exactly ONE mode', 'base...HEAD', 'staged and unstaged', 'DIFF_START / DIFF_END', 'production failure modes', 'missing tests', 'maintainability', 'GATE FAIL', 'empty output', 'critical findings', 'untagged output', 'Only P2/advisory', '330-second', '600-second', 'silent data corruption', 'privilege escalation', 'logical gaps', 'unstated assumptions', 'missing dependencies', 'sequencing', 'Recommendation:', 'FULL actual output verbatim', 'same consultation', 'read-only allowlist', 'resume failure', 'usage or unknown', 'codex-review', 'findings_fixed']) expect(output).toContain(obligation);
    expect(output.indexOf('1. Failed/aborted')).toBeLessThan(output.indexOf('2. Empty'));
    expect(output.indexOf('2. Empty')).toBeLessThan(output.indexOf('3. Any [P0]'));
    expect(output.indexOf('3. Any [P0]')).toBeLessThan(output.indexOf('4. No P0'));
    expect(output.indexOf('4. No P0')).toBeLessThan(output.indexOf('5. Only P2'));
    expect(output).toContain('never interpret'.replace('n', 'N'));
    expect(output).not.toContain('claude -p');
    expect(output).not.toContain('codex exec');
  });

  test('generated Codex review, planning, ship and office-hours outputs retain current gates; design-shotgun keeps its CLI contract', async () => {
    const outputRoot = mkdtempSync(resolve(tmpdir(), 'gstack-codex-native-render-'));
    try {
      const generated = await runGeneration({ host: 'codex', outputRoot, contentLinkRoot: null, log: () => {} });
      expect(generated.exitCode).toBe(0);
      const rendered = (skill: string, file = 'SKILL.md') =>
        readFileSync(resolve(outputRoot, '.agents', 'skills', `gstack-${skill}`, file), 'utf8');

      const planEng = rendered('plan-eng-review', 'sections/review-sections.md');
      for (const clause of [
        '**Test value bar.** Propose or write a test only with all four answers',
        'protects=', 'fails_when=', 'why_new=', 'seam=',
        'Mark new contracts and optional depth choices pending until the decision gate below resolves them.',
        'STOP for each pending decision.',
        'Wait for its answer before applying that remedy',
      ]) expect(planEng).toContain(clause);

      const ship = rendered('ship', 'sections/test-coverage.md');
      for (const clause of ['**Test value bar.**', 'tests_rejected', 'no_credible_regression', 'covered_elsewhere', 'implementation_coupled']) expect(ship).toContain(clause);
      expect(ship).toContain('### Shared native worker dispatch');
      expect(ship).not.toMatch(/subagent_type|run_in_background|Agent tool/);

      const shipAdversarial = rendered('ship', 'sections/adversarial.md');
      for (const clause of [
        'DIFF_TOTAL >= 200',
        'Required primary native adversarial pass',
        'review_not_run',
        'status:"unavailable"',
        'Fixes queued after native completion',
        'pending Step 11.5',
        "never resets Step 9's three-cycle fix limit",
        'Native complete with no queued fixes',
      ]) expect(shipAdversarial).toContain(clause);
      expect(shipAdversarial).not.toMatch(/Agent tool|subagent_type|claude -p|codex exec/);

      const review = rendered('review');
      for (const clause of ['Native second-opinion modes', 'exactly ONE mode', 'GATE FAIL', 'logical gaps', 'Recommendation:']) expect(review).toContain(clause);
      const nativeReview = review.slice(review.indexOf('## Native second-opinion modes'));
      expect(nativeReview).not.toMatch(/codex exec|claude -p/);
      const reviewAdversarial = rendered('review', 'sections/adversarial.md');
      for (const clause of ['DIFF_TOTAL >= 200', 'Required primary native adversarial pass', 'Native contexts do not fill missing outside provider coverage', 'Return all findings and structured-review decisions to Step 5', 'do not start an inner repair loop']) expect(reviewAdversarial).toContain(clause);

      const officeHours = rendered('office-hours', 'sections/design-and-handoff.md');
      for (const clause of ['fresh task through', 'complete findings schema', 'all five review dimensions', 'complete verdict JSON', 'actual handle and await terminal completion']) expect(officeHours).toContain(clause);
      expect(officeHours).not.toMatch(/Use the Agent tool|run_in_background: false/);

      const shotgun = rendered('design-shotgun');
      expect(shotgun).toContain('Use AskUserQuestion to confirm before spending API credits:');
      expect(shotgun).toContain('Generate every variant with one `$D variants --briefs-file` call.');
      expect(shotgun).toContain('Codex permission boundary: the documented temporary directory is the normal staging');
      expect(shotgun).not.toMatch(/Launch N (?:Agent|native) workers|Native worker task template|fresh-context worker API/);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  test('source tracing and packet-only review have explicit different proof limits', () => {
    const output = RESOLVERS.REVIEW_ARMY(ctx('review'));
    expect(output).toContain('FULL selected specialist checklist');
    expect(output).toContain('bounded read-only source inspection');
    expect(output).toContain('Missing paths remain unverified');
    expect(output).toContain('timed-out or unavailable contexts are review_not_run');
    expect(output).toContain('zero returned findings from a failed attempt is not a clean review');
    expect(output).toContain('ASK-only');
    expect(output).toContain('quality_score = max(0, 10 -');
    expect(output).toContain('### Red Team dispatch (conditional)');
    expect(output).toContain('exact approved diff plus relevant source/test');
    expect(output).not.toMatch(/Agent tool|subagent_type|claude -p|codex exec/);
    const cso = adaptNativeTemplate(read('cso/SKILL.md.tmpl'), ctx('cso'), 'cso/SKILL.md.tmpl');
    for (const clause of ['already-authorized independent reviewer', 'Do not request broader tool access', 'exact authorised source/test paths and rubric', 'latest static/runtime evidence gates']) expect(cso).toContain(clause);
    expect(cso).toContain('For each candidate, use an already-authorized independent reviewer when available.');
    expect(cso).toContain('Use at most three; await them.');
    expect(cso).not.toContain('For each candidate finding, launch an independent verification');
    const changedCsoContract = read('cso/SKILL.md.tmpl').replace('Use at most three; await them.', 'Use at most three workers and await them.');
    expect(() => adaptNativeTemplate(changedCsoContract, ctx('cso'), 'cso/SKILL.md.tmpl')).toThrow('anchor drift');
  });

  test('native preference instructions separate optional choices from permission decisions', () => {
    const output = generateQuestionTuning(ctx('review'));
    expect(output).toContain('optional preference');
    expect(output).toContain('never authorises');
    expect(output).toContain('native question schema');
    expect(output).toContain('best-effort');
    expect(output).not.toContain('PreToolUse');
    expect(output).not.toContain('PostToolUse');
    expect(output).toContain('Exit code 2 = rejected as not user-originated; do not retry.');
  });

  test('source drift is an explicit failure instead of silently retaining legacy dispatch', () => {
    expect(() => replaceBlock('no matching section', 'start', 'end', 'native')).toThrow('anchor drift');
    expect(() => replaceBlock('start start end', 'start', 'end', 'native')).toThrow('anchor drift');
    const path = 'autoplan/sections/ceo-phase.md.tmpl';
    expect(() => adaptNativeTemplate(read(path).replace('{{OUTSIDE_INVOCATION:autoplan}}', '{{CHANGED_INVOCATION}}'), ctx('autoplan'), path)).toThrow('Autoplan ceo native dispatch anchor drift');
    const shotgunPath = 'design-shotgun/SKILL.md.tmpl';
    expect(() => adaptNativeTemplate(read(shotgunPath).replace('Generate every variant with one `$D variants --briefs-file` call.', 'Launch N Agent subagents'), ctx('design-shotgun'), shotgunPath)).toThrow('Codex design-shotgun generation contract anchor drift');
    expect(() => adaptNativeTemplate(read(shotgunPath).replace('while the temp dir works.', 'while a temp dir works.'), ctx('design-shotgun'), shotgunPath)).toThrow('Codex design-shotgun staging contract anchor drift');
  });
});
