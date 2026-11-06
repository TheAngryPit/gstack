/**
 * Credential rejections are INFRA (Captain, 2026-10-23). Train gate run
 * 39696775546 ran with a rejected ANTHROPIC_API_KEY: every case failed on a
 * 401 before the model ran, and the report called them 131 assertion reds and
 * launched 131 rule-16 reruns with the same key. A rejected key fails every
 * case the same way, so these failures are INFRA: never rerun, and counted as
 * INFRA in the verdict. The captures below are trimmed from that run
 * (test/fixtures/credential-rejection-39696775546.json). Each runner's own
 * evidence path is replayed: the claude -p stream observer, the PTY screen,
 * the judge's API error and the Agent SDK's error result. The negative controls
 * are real assertion failures that mention a key; they keep their class and
 * are still rerun.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { credentialRejection } from './helpers/eval-store';
import { SessionObserver } from './helpers/session-ledger';
import { safePanelEnd } from './helpers/pty/session';
import { classifyTrialShard } from '../scripts/test-paid-shards';

const ROOT = path.resolve(import.meta.dir, '..');
const CAPTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/credential-rejection-39696775546.json'), 'utf8'));
const REJECTED = 'Invalid API key · Fix external API key';
/** Real assertion failures that mention a key, an API key or an auth word, with no provider rejection. */
const KEY_ASSERTIONS = [
  'expect(received).toContain(expected)\n\nExpected to contain: "Invalid API key"\nReceived: "ok"',
  "Expected config to contain key \"api_key\"; the Invalid API key handling section is missing",
  'README should explain how to rotate the ANTHROPIC_API_KEY',
  'authentication rejected by the fixture server was not reported to the user',
  'expect(received).toBe(expected)\n\nExpected: "success"\nReceived: "exit_code_1"',
];

/** The ledger row the claude -p runner writes from its observer (session-runner.ts: structured end, else error). */
function claudePLedgerRow(events: unknown[]): Record<string, unknown> {
  const observer = new SessionObserver(0);
  events.forEach((event, i) => observer.observe(event, i * 100));
  const verdict = observer.verdict();
  return { key: 'claude-p:ship-docsync-store#1', test_name: 'ship-docsync-store', runner: 'claude-p', started_at: '2026-10-22T00:00:33.527Z',
    budget_ms: 584957, elapsed_ms: 1540, end: verdict?.end ?? 'error', ...(verdict ? { evidence: verdict.evidence } : {}), billed: true };
}
/** The ledger row the PTY runner writes: its observer timed out, unless the screen shows an end panel. */
function ptyLedgerRow(screen: string): Record<string, unknown> {
  return { key: 'pty:session#1', runner: 'pty', started_at: '2026-10-22T00:00:35.294Z', budget_ms: 420000, elapsed_ms: 420002,
    end: 'observer_timeout', ...safePanelEnd({ visibleText: () => screen }), billed: false };
}

describe('each runner records the rejection it saw (run 39696775546)', () => {
  test('claude -p: the CLI\'s synthetic 401 message ends the session as an API error', () => {
    expect(claudePLedgerRow(CAPTURE.claude_p_events)).toMatchObject({ end: 'api_error', evidence: REJECTED });
  });

  test('PTY: a session parked at the plan-mode footer after the rejection still records it', () => {
    expect(ptyLedgerRow(CAPTURE.pty_screen)).toMatchObject({ end: 'api_error', evidence: expect.stringContaining(REJECTED) });
    expect(ptyLedgerRow('❯ /plan-ceo-review\n✻Baked for 3s · done 12:00 AM\n❯ \n')).toMatchObject({ end: 'observer_timeout' });
  });

  test('every runner\'s evidence reads as a credential rejection', () => {
    expect(credentialRejection({ error: CAPTURE.judge_error })).toContain('"type":"authentication_error"');
    expect(credentialRejection({ error: CAPTURE.agent_sdk_error })).toContain(REJECTED);
    expect(credentialRejection({ error: CAPTURE.pty_junit_message + CAPTURE.pty_screen })).toContain(REJECTED);
    expect(credentialRejection({ error: 'x', sessions: [{ end: 'api_error', evidence: REJECTED }] })).toBe(REJECTED);
    expect(credentialRejection({ error: '401 {"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}' })).toContain('invalid_api_key');
  });
});

describe('negative controls: a failure that only mentions a key keeps its class', () => {
  test('assertion text alone is never a rejection', () => {
    for (const error of KEY_ASSERTIONS) expect(credentialRejection({ error }), error).toBeUndefined();
  });

  test('a session must have ended as an API error, and a non-credential API error is not one', () => {
    expect(credentialRejection({ sessions: [{ end: 'completed', evidence: REJECTED }] })).toBeUndefined();
    expect(credentialRejection({ sessions: [{ end: 'api_error', evidence: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}' }] })).toBeUndefined();
  });
});

describe('trial panels: classifyTrialShard', () => {
  const plan = { kind: 'behavior' as const, panel: { n: 3, k: 2 }, quarantined: false };
  const shard = { status: 'failed' as const, executedTests: 1, skippedTests: 0, elapsedMs: 1540 };
  const rejected = { sessions: [claudePLedgerRow(CAPTURE.claude_p_events) as any] };

  test('a rejected session makes the trial INFRA, and its error names the rejection', () => {
    expect(classifyTrialShard(shard, 'ship-docsync-store', 1, plan, { records: [CAPTURE.claude_p_record], contract: null, ...rejected }))
      .toMatchObject({ outcome: 'failed', failure_class: 'infra', error: `credentials rejected: ${REJECTED}`, failure_cause: 'pre_turn_infra' });
    expect(classifyTrialShard(shard, 'c', 1, plan, { records: [{ passed: false, error: CAPTURE.agent_sdk_error }], contract: null }))
      .toMatchObject({ failure_class: 'infra' });
  });

  test('contract evidence still wins, and a key-mentioning assertion stays an assertion', () => {
    expect(classifyTrialShard(shard, 'c', 1, plan, { records: [CAPTURE.claude_p_record], contract: 'handoff missing', ...rejected }))
      .toMatchObject({ failure_class: 'contract' });
    for (const error of KEY_ASSERTIONS) {
      expect(classifyTrialShard(shard, 'c', 1, plan, { records: [{ passed: false, error }], contract: null, sessions: [] }), error)
        .toMatchObject({ failure_class: 'assertion' });
    }
  });
});

// ── The real --report and --rerun-plan CLI paths on a trimmed two-shard capture ──
const STORE = 'test/skill-e2e-ship-docsync.test.ts#ship-docsync-store';
const PTY = 'test/skill-e2e-plan-ceo-plan-mode.test.ts';
const CASES = ['ship-docsync-store', 'plan-ceo-review-plan-mode'];
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
const junit = (file: string, suite: string, name: string, message: string) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" assertions="0" failures="1" skipped="0" time="1.6">
  <testsuite name="${file}" file="${file}" tests="1" assertions="0" failures="1" skipped="0" time="1.6">
    <testsuite name="${suite}" file="${file}" line="1" tests="1" assertions="0" failures="1" skipped="0" time="1.6">
      <testcase name="${name}" classname="${suite}" time="1.6" file="${file}" line="1" assertions="0">
        <failure type="Error" message="${xml(message)}" />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>
`;
interface Shard { key: string; slug: string; junit: string; ledger: Record<string, unknown>; record?: Record<string, unknown>; budget?: Record<string, unknown> }
const storeShard = (message: string, ledger: Record<string, unknown>): Shard => ({ key: STORE, slug: 'skill-e2e-ship-docsync--ship-docsync-store', ledger,
  budget: { timeoutMs: 720000, source: 'registered', policyId: 'skill-e2e-ship-docsync-existing-retry-v1' },
  junit: junit('test/skill-e2e-ship-docsync.test.ts', 'Ship doc-sync lifecycle > Ship doc-sync lifecycle E2E (gate)', 'ship-docsync-store', message),
  record: { ...CAPTURE.claude_p_record, transcript: CAPTURE.claude_p_events } });
const ptyShard: Shard = { key: PTY, slug: 'skill-e2e-plan-ceo-plan-mode', ledger: ptyLedgerRow(CAPTURE.pty_screen),
  junit: junit(PTY, 'plan-ceo-review plan-mode smoke (gate)', 'first terminal outcome is asked (Step 0 fires before any plan write)', CAPTURE.pty_junit_message + CAPTURE.pty_screen) };

let base: string;
let counter = 0;
beforeAll(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-rejection-')); });
afterAll(() => { fs.rmSync(base, { recursive: true, force: true }); });

function reportDir(shards: Shard[]): string {
  const dir = path.join(base, `case-${++counter}`);
  const e2e = CASES.filter((_, i) => shards.some(s => s.key === [STORE, PTY][i]));
  const selection = { e2e, judges: [] };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, tier: 'gate', evalsAll: false, sliceCount: 1, profile: 'pr', selection,
    selectionReason: 'trimmed replay of run 39696775546',
    prCoverage: { mode: 'dependents', e2e, judges: [], deferred: [], unknownFiles: [], unknownFileLabels: [], directCases: [], derivedFiles: [], noConsumerFiles: [],
      deferredPromptFiles: [], missingCoverage: [], needsFullValidation: false, reasons: [] },
    plan: { sliceBudgetMs: 420000, jobs: 2, estimatedSliceMs: [420000], ciTimeoutMinutes: 50, sliceCiTimeoutMinutes: [50], codexSlices: [] },
    entries: shards.map(s => ({ file: s.key, slice: 1, status: 'planned', estimatedMs: 120000, ...(s.budget ? { budget: s.budget } : {}) })) }));
  for (const s of shards) {
    const shardDir = path.join(dir, 'paid-slice-1-a1', 'shards', s.slug);
    fs.mkdirSync(shardDir, { recursive: true });
    fs.writeFileSync(path.join(shardDir, 'junit.xml'), s.junit);
    fs.writeFileSync(path.join(shardDir, 'session-ledger.jsonl'), JSON.stringify(s.ledger) + '\n');
    if (s.record) {
      fs.writeFileSync(path.join(shardDir, '1.91.176-train-gate.train-437b2f2a3e80-514fbfdc9799-5bc2e6-e2e-ship-docsync-2026-10-22-0000.json'),
        JSON.stringify({ schema_version: 2, version: '1.91.176', tier: 'e2e-ship-docsync', total_tests: 1, executed_tests: 1, passed: 0, failed: 1, total_cost_usd: 0, tests: [s.record] }));
    }
  }
  fs.writeFileSync(path.join(dir, 'paid-slice-1-a1', 'slice-1.json'), JSON.stringify({ version: 1, tier: 'gate', profile: 'pr', selection, sliceIndex: 1, sliceCount: 1, attempt: 1,
    startedAt: 1792627232000, finishedAt: 1792627653000,
    outcomes: shards.map(s => ({ files: [s.key], status: 'failed', exitCode: 1, elapsedMs: 1655, executedTests: 1, skippedTests: 0,
      budget: s.budget ?? { timeoutMs: 1800000, source: 'default', policyId: null } })) }));
  return dir;
}
const cli = (args: string[]) => spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(ROOT, 'scripts/test-paid-shards.ts'), '--tier', 'gate', ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, EVALS_TIER: 'gate', GITHUB_RUN_ID: '39696775546', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: '', GSTACK_GATE_PR: '', GSTACK_GATE_HEAD_SHA: '' } });
function planRerun(dir: string) {
  const out = path.join(dir, 'rerun-plan-a1');
  const r = cli(['--report', dir, '--rerun-plan', out]);
  expect(r.status, r.stdout + r.stderr).toBe(0);
  const file = path.join(out, 'manifest.json');
  return { out: r.stdout, manifest: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}

describe('replay of run 39696775546 through --report and --rerun-plan', () => {
  test('every case died on the rejected key: no rule-16 rerun, and the verdict counts INFRA, not assertion reds', () => {
    const dir = reportDir([storeShard(CAPTURE.claude_p_junit_message, claudePLedgerRow(CAPTURE.claude_p_events)), ptyShard]);
    const plan = planRerun(dir);
    expect(plan.manifest).toBeNull();
    for (const id of CASES) expect(plan.out).toContain(`not rerun: ${id} (never rerun: INFRA failure class)`);
    fs.rmSync(path.join(dir, 'collector-outcomes.json'), { force: true });
    const r = cli(['--report', dir]);
    const out = r.stdout + r.stderr;
    expect(r.status, out).toBe(1);
    expect(out).toContain('VERDICT RED');
    expect(out).toContain('INFRA 2');
    for (const id of CASES) expect(out).toMatch(new RegExp(`✗ ${id}  rule  FAIL  infra — credentials rejected: `));
    expect(out).not.toMatch(/FAIL {2}assertion/);
  });

  test('negative control: a real assertion red that mentions a key is still rerun once', () => {
    const completed = { ...claudePLedgerRow([]), end: 'completed' };
    const dir = reportDir([{ ...storeShard(KEY_ASSERTIONS[1], completed), record: { ...CAPTURE.claude_p_record, output: 'done', exit_reason: 'success', error: KEY_ASSERTIONS[1] } }]);
    const plan = planRerun(dir);
    expect(plan.manifest?.rerun).toEqual({ attempt: 1, cases: ['ship-docsync-store'] });
  });
});
