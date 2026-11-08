/**
 * GSTA-131 token efficiency in the unattended /autoplan runner, on the
 * simulated Capy host: new unattended runs default to two review rounds (a
 * resumed run keeps what it persisted); `revise --incorporates` applies an
 * edit without re-review when every incorporated decision resolves below High
 * and nothing new comes into scope, and reopens on anything else; the gate at
 * the round cap prints ESCALATE while High findings stay open; a docs-only
 * plan runs CEO (native voice only) and Eng; export counts every dispatched
 * attempt and a relative input-token estimate. Every spawn has a timeout.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectDocsOnly, docsClassPath } from '../lib/autoplan-scope';
import { ROOT, SMALL_PLAN } from './helpers/autoplan-run-fixture';
import { capyRunner, phaseVia, readJsonl, readRunJson, writePlan } from './helpers/autoplan-capy';

const r = capyRunner();
afterAll(() => r.cleanup());
let n = 0;
const NONE = { native: [], outside: [] };
const V2 = SMALL_PLAN.replace('cap 30 s', 'cap 30 s, jitter drawn from a seeded source');
const DX_V2 = SMALL_PLAN.replace('Tests cover', 'Add a CLI flag --max-retries and an error message for a bad value. Tests cover');
const DOCS_PLAN = '# Retry docs\n\n## Implementation plan\n\nRewrite README.md and docs/howto-retry.md so they explain the retry backoff, and add a CHANGELOG.md entry.\n\n## Review record\n';
const journal = (out: string) => readJsonl(path.join(out, 'attempts.jsonl'));
const voices = (stdout: string) => stdout.split('\n').filter(l => l.startsWith('ATTEMPT: ')).map(l => /voice=(\w+)/.exec(l)![1]);
function start(args: string[] = [], text = SMALL_PLAN) {
  const dir = path.join(r.host.base, `tok${++n}`);
  const plan = writePlan(dir, text);
  const out = path.join(dir, 'run');
  const first = r.ap(['next', '--out', out, '--plan', plan, '--no-ui', ...args]);
  if (first.status !== 0) throw new Error(`first next failed: ${first.stderr}\n${first.stdout}`);
  return { out, dir, plan, first };
}
const v2File = (dir: string, text = V2) => { const f = path.join(dir, `plan-v2-${++n}.md`); fs.writeFileSync(f, text); return f; };
const disagreement = (native: string, outside: string) => ({
  native: [{ id: 'F1', severity: native, title: 'Jitter source is unstated', file: 'lib/worker.ts', line: 19, fix: 'name the source' }],
  outside: [{ id: 'O1', severity: outside, title: 'Jitter source is unstated', file: 'lib/worker.ts', line: 19, fix: 'name the source' }],
});
/** A run gated on one ceo disagreement d1, answered with its plan-changing option: amend_pending on d1. */
function amended(native: string, outside: string, args: string[] = []) {
  const s = start(args);
  phaseVia(r, s.out, 'ceo', disagreement(native, outside));
  expect(phaseVia(r, s.out, 'eng', NONE).outside.stdout).toContain('status=gate_pending');
  const res = r.ap(['answer', '--by', 'human', '--out', s.out, '--gate-rev', '1', '--reply', 'all except d1b']);
  expect(res.status, res.stderr).toBe(0);
  expect(readRunJson(s.out).status).toBe('amend_pending');
  return { ...s, run: readRunJson(s.out).run as string };
}
function bindNative(out: string) {
  const run = readRunJson(out);
  expect(r.review(path.join(out, 'ceo-native-prompt.md'), { FIXTURE_FINDINGS: '[]' }).status).toBe(0);
  return r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', run.phases.ceo.native.attempts[0].result, '--model', 'anthropic/claude-opus-5-5', '--attempt', run.phases.ceo.native.attempt]);
}

describe('a quiet revise after a capped one', () => {
  // Value: protects=the owner still sees an earlier capped delta; fails_when=a below-High revise after a capped one leaves the
  // answered gate in place (gate_rev unchanged, the delta item never rendered); seam=none; no_claim=none
  test('regates so the capped delta reaches the owner', () => {
    const s = start(['--max-rounds', '1']);
    phaseVia(r, s.out, 'ceo', {
      native: [{ id: 'F1', severity: 'High', title: 'Jitter source is unstated', file: 'lib/worker.ts', line: 19, fix: 'name the source' },
               { id: 'F2', severity: 'Medium', title: 'Cap value is unexplained', file: 'lib/config.ts', line: 3, fix: 'explain the cap' }],
      outside: [{ id: 'O1', severity: 'Low', title: 'Jitter source is unstated', file: 'lib/worker.ts', line: 19, fix: 'name the source' },
                { id: 'O2', severity: 'Informational', title: 'Cap value is unexplained', file: 'lib/config.ts', line: 3, fix: 'explain the cap' }],
    });
    phaseVia(r, s.out, 'eng', NONE);
    expect(r.ap(['answer', '--by', 'human', '--out', s.out, '--gate-rev', '1', '--reply', 'all except d1b d2b']).status).toBe(0);
    const first = r.ap(['revise', '--out', s.out, '--plan', v2File(s.dir), '--incorporates', 'd1']);
    expect(first.stdout).toMatch(/capped=/);
    const second = r.ap(['revise', '--out', s.out, '--plan', v2File(s.dir, SMALL_PLAN.replace('cap 30 s', 'cap 30 s (explained), jitter drawn from a seeded source')), '--incorporates', 'd2']);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('without re-review (below High; plan +');
    const run = readRunJson(s.out);
    expect(run.status).toBe('gate_pending');
    expect(run.gate_rev).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(s.out, 'gate.json'), 'utf8')).gate_rev).toBe(2);
  }, 30_000);
});

describe('round budget', () => {
  test('a new unattended run defaults to two rounds per phase', () => {
    const s = start();
    expect(s.first.stdout).toMatch(/^ROUNDS: ceo=1\/2 eng=1\/2 max_rounds=2 host_spend=unknown$/m);
    expect(readRunJson(s.out).max_rounds).toBe(2);
  });

  test('a resumed run keeps the max_rounds it persisted', () => {
    const s = start();
    fs.writeFileSync(path.join(s.out, 'run.json'), JSON.stringify({ ...readRunJson(s.out), max_rounds: 1 }, null, 2) + '\n');
    expect(r.ap(['resume', '--out', s.out]).status).toBe(0);
    expect(readRunJson(s.out).max_rounds).toBe(1);
    expect(r.ap(['status', '--out', s.out]).stdout).toMatch(/^ROUNDS: ceo=1\/1 eng=1\/1 max_rounds=1 /m);
  });
});

describe('revise by severity', () => {
  test('below-High decisions apply without re-review: no phase reopens, snapshots rebind, the run completes', () => {
    const g = amended('Medium', 'Informational');
    const before = readRunJson(g.out);
    const rev = r.ap(['revise', '--out', g.out, '--plan', v2File(g.dir), '--incorporates', 'd1']);
    expect(rev.status, rev.stderr).toBe(0);
    expect(rev.stdout).toMatch(/^REVISED: plan=[0-9a-f]{12} reopened=none$/m);
    expect(rev.stdout).toContain(`APPLIED: ${g.run}-d1 without re-review (below High; plan +`);
    expect(rev.stdout).toContain('GSTACK_RESULT: skill=autoplan status=complete');
    const run = readRunJson(g.out);
    const row = journal(g.out).find(e => e.event === 'applied_without_rereview');
    expect(row).toMatchObject({ decisions: [`${g.run}-d1`], severities: { [`${g.run}-d1`]: 'Medium' }, phases: ['ceo', 'eng'], old_plan_sha256: before.phases.ceo.snapshot });
    for (const p of ['ceo', 'eng']) {
      expect(run.phases[p].snapshot).toBe(row.new_plan_sha256);
      expect(run.phases[p].rebound).toEqual([expect.objectContaining({ from: before.phases[p].snapshot, to: row.new_plan_sha256, decisions: [`${g.run}-d1`] })]);
      expect(run.phases[p].closed_at).toBe(before.phases[p].closed_at);
    }
    expect(run.attempt_counter).toBe(before.attempt_counter);
    expect(journal(g.out).filter(e => e.event === 'reopened')).toEqual([]);
    expect(run.amendments[0]).toMatchObject({ status: 'incorporated' });
    const v = r.validate(g.out);
    expect(v.status, v.stdout + v.stderr).toBe(0);
  }, 30_000);

  test('a High decision reopens as before', () => {
    const g = amended('High', 'Low');
    const rev = r.ap(['revise', '--out', g.out, '--plan', v2File(g.dir), '--incorporates', 'd1']);
    expect(rev.stdout).toMatch(/^REVISED: plan=\S+ reopened=ceo,eng$/m);
    expect(rev.stdout).not.toContain('APPLIED:');
    expect(journal(g.out).some(e => e.event === 'applied_without_rereview')).toBe(false);
  }, 30_000);

  test('a decision of unknown severity reopens', () => {
    const g = amended('Medium', 'Informational');
    const file = path.join(g.out, 'decisions.jsonl');
    fs.writeFileSync(file, readJsonl(file).map(d => JSON.stringify(d.label === 'D1' ? { ...d, origin: undefined } : d)).join('\n') + '\n');
    const rev = r.ap(['revise', '--out', g.out, '--plan', v2File(g.dir), '--incorporates', 'd1']);
    expect(rev.status, rev.stderr).toBe(0);
    expect(rev.stdout).toMatch(/reopened=ceo,eng$/m);
    expect(rev.stdout).not.toContain('APPLIED:');
  }, 30_000);

  test('a below-High edit that brings a phase into scope reopens and adds it', () => {
    const g = amended('Medium', 'Informational');
    const rev = r.ap(['revise', '--out', g.out, '--plan', v2File(g.dir, DX_V2), '--incorporates', 'd1']);
    expect(rev.status, rev.stderr).toBe(0);
    expect(rev.stdout).toMatch(/^REVISED: plan=\S+ reopened=ceo,eng added=dx$/m);
    expect(rev.stdout).not.toContain('APPLIED:');
  }, 30_000);

  test('at the round cap a below-High edit applies without a capped delta; a High one keeps the unreviewed-delta gate item', () => {
    const low = amended('Medium', 'Informational', ['--max-rounds', '1']);
    const quiet = r.ap(['revise', '--out', low.out, '--plan', v2File(low.dir), '--incorporates', 'd1']);
    expect(quiet.stdout).toContain(`APPLIED: ${low.run}-d1 without re-review (below High; plan +`);
    expect(readRunJson(low.out).capped_deltas).toBeUndefined();
    const high = amended('High', 'Low', ['--max-rounds', '1']);
    const capped = r.ap(['revise', '--out', high.out, '--plan', v2File(high.dir), '--incorporates', 'd1']);
    expect(capped.stdout).toMatch(/^REVISED: plan=\S+ reopened=none capped=ceo,eng$/m);
    expect(capped.stdout).not.toContain('APPLIED:');
    expect(readRunJson(high.out).capped_deltas.map((d: any) => d.phase)).toEqual(['ceo', 'eng']);
  }, 30_000);
});

describe('ESCALATE at the round cap', () => {
  const HIGH = { native: [{ severity: 'High', title: 'Retries can double-charge', fix: 'idempotency key' }], outside: [] };
  test('the gate at the cap with a High finding open names the decision', () => {
    const s = start(['--max-rounds', '1']);
    phaseVia(r, s.out, 'ceo', HIGH);
    const eng = phaseVia(r, s.out, 'eng', NONE);
    expect(eng.outside.stdout).toMatch(/^GATE: gate_rev=1 /m);
    expect(eng.outside.stdout.split('\n').filter(l => l.startsWith('ESCALATE:'))).toEqual(['ESCALATE: evidence sufficient, decision needed (ceo: 1 High open)']);
  }, 30_000);
  test('control: below the cap, or at it with nothing High open, no ESCALATE', () => {
    const s = start();
    phaseVia(r, s.out, 'ceo', HIGH);
    expect(phaseVia(r, s.out, 'eng', NONE).outside.stdout).not.toContain('ESCALATE:');
    const m = start(['--max-rounds', '1']);
    phaseVia(r, m.out, 'ceo', { native: [{ severity: 'Medium', title: 'Jitter source is unstated' }], outside: [] });
    const gate = phaseVia(r, m.out, 'eng', NONE).outside.stdout;
    expect(gate).toMatch(/^GATE: /m);
    expect(gate).not.toContain('ESCALATE:');
  }, 30_000);
});

describe('docs-only', () => {
  test('docs-class paths', () => {
    for (const p of ['README.md', 'CHANGELOG.md', 'TODOS.md', 'docs/howto-retry.md', 'docs/designs/x/PLAN.md', 'notes.md', './README.md', 'docs/images/flow.png', 'docs/designs']) expect(docsClassPath(p, ROOT), p).toBe(true);
    for (const p of ['docs/review-policy.md', 'autoplan/SKILL.md.tmpl', 'autoplan/SKILL.md', 'review/sections/army.md', 'scripts/resolvers/autoplan-driver.ts', 'autoplan/DRIVER.md',
      'captain/templates/brief.md', 'autoplan/notes.md', 'AGENTS.md', 'CLAUDE.md', 'lib/worker.ts', 'bin/gstack-autoplan']) expect(docsClassPath(p, ROOT), p).toBe(false);
    expect(detectDocsOnly('Rewrite README.md and docs/howto.md.', ROOT)).toMatchObject({ docsOnly: true, code: [] });
    expect(detectDocsOnly('Rewrite README.md and docs/review-policy.md.', ROOT)).toMatchObject({ docsOnly: false, code: ['docs/review-policy.md'] });
    expect(detectDocsOnly('Make the retry docs clearer.', ROOT).docsOnly).toBe(false);
  });

  test('detected: CEO dispatches the native voice only, Eng both; SCOPE reports it; DISPATCHES counts what ran', () => {
    const s = start([], DOCS_PLAN);
    expect(s.first.stdout).toMatch(/^SCOPE: ui=no .* docs_only=yes \(detected\) source=ui:flag,dx:detected$/m);
    expect(s.first.stdout).toMatch(/^PHASE: ceo snapshot=[0-9a-f]{64} order=ceo,eng$/m);
    expect(s.first.stdout).toContain('OUTSIDE: ceo not_run reason=docs_only (native voice only)');
    expect(voices(s.first.stdout)).toEqual(['native']);
    expect(readRunJson(s.out).phases.ceo.outside).toMatchObject({ status: 'disabled', outcome: 'not_run', reason: 'docs_only' });
    expect(bindNative(s.out).stdout).toMatch(/^PHASE_CLOSED: ceo /m);
    const eng = phaseVia(r, s.out, 'eng', NONE);
    expect(voices(eng.next.stdout)).toEqual(['native', 'outside']);
    expect(eng.outside.stdout).toContain('status=gate_pending');
    const exp = r.ap(['export', '--out', s.out]);
    expect(exp.status, exp.stderr).toBe(0);
    const run = readRunJson(s.out);
    const bytes = journal(s.out).filter(e => e.event === 'dispatched').reduce((t, e) => t + e.prompt_bytes, 0);
    expect(run.dispatches).toEqual({ total: 3, by_phase: { ceo: { native: 1 }, eng: { native: 1, outside: 1 } } });
    expect(run.est_input_tokens).toBe(Math.round(bytes / 4));
    expect(exp.stdout).toContain(`DISPATCHES: 3 est_input_tokens=${run.est_input_tokens} (relative estimate)`);
    const v = r.validate(s.out);
    expect(v.status, v.stdout + v.stderr).toBe(0);
  }, 30_000);

  test('--docs-only on the first next forces CEO + Eng on a code plan; a phase-enabling flag outranks detection', () => {
    const flagged = start(['--docs-only', '--developer-tool']);
    expect(flagged.first.stdout).toMatch(/ docs_only=yes \(flag\) source=/m);
    expect(readRunJson(flagged.out).phase_order).toEqual(['ceo', 'eng']);
    const code = start();
    expect(code.first.stdout).toMatch(/ docs_only=no \(detected\) source=/m);
    expect(voices(code.first.stdout)).toEqual(['native', 'outside']);
    const dx = start(['--developer-tool'], DOCS_PLAN);
    expect(dx.first.stdout).toMatch(/ docs_only=no \(detected\) source=/m);
    expect(readRunJson(dx.out).phase_order).toEqual(['ceo', 'dx', 'eng']);
  });
});

describe('dispatch counts', () => {
  test('failed attempts count; a run.json without the fields still validates', () => {
    const s = start();
    expect(bindNative(s.out).status).toBe(0);
    expect(r.ap(['submit', '--out', s.out, '--phase', 'ceo', '--voice', 'outside', '--failed', 'runner crashed']).stdout).toMatch(/^PHASE_CLOSED: ceo /m);
    phaseVia(r, s.out, 'eng', NONE);
    const exp = r.ap(['export', '--out', s.out, '--json']);
    expect(JSON.parse(exp.stdout)).toMatchObject({ dispatches: { total: 4, by_phase: { ceo: { native: 1, outside: 1 }, eng: { native: 1, outside: 1 } } } });
    const run = readRunJson(s.out);
    expect(run.est_input_tokens).toBeGreaterThan(0);
    delete run.dispatches; delete run.est_input_tokens;
    fs.writeFileSync(path.join(s.out, 'run.json'), JSON.stringify(run, null, 2) + '\n');
    const v = r.validate(s.out);
    expect(v.status, v.stdout + v.stderr).toBe(0);
    expect(r.ap(['status', '--out', s.out]).status).toBe(0);
  }, 30_000);
});
