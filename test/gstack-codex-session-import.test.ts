/**
 * gstack-codex-session-import — backfill question-log from Codex JSONL.
 *
 * Plan-tune cathedral T9. Verifies the structured-file parser (D5) handles
 * the two-tier recovery strategy from docs/spikes/codex-session-format.md:
 *   - Marker-first: <gstack-qid:foo-bar> → source=codex-import-marker.
 *   - Pattern fallback: D-numbered brief → source=codex-import-pattern,
 *     hash-only question_id.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-codex-session-import');

let stateRoot: string;
let fixtureCwd: string;
let cwdSlug: string;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cdximp-'));
  cwdSlug = 'codex-fixture-slug';
  fixtureCwd = path.join(stateRoot, cwdSlug);
  fs.mkdirSync(fixtureCwd, { recursive: true });
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

function writeSessionFile(events: Array<Record<string, unknown>>, sessionId = 'sess-fixture'): string {
  const p = path.join(stateRoot, 'rollout-fixture.jsonl');
  const meta = {
    timestamp: new Date().toISOString(),
    type: 'session_meta',
    payload: { id: sessionId, cwd: fixtureCwd },
  };
  const lines = [JSON.stringify(meta), ...events.map((e) => JSON.stringify(e))];
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function agentMessage(text: string): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type: 'agent_message', message: text },
  };
}

function userMessage(text: string): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type: 'user_message', message: text },
  };
}

function nativeFunctionCall(
  callId: string,
  questions: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'request_user_input',
      call_id: callId,
      arguments: JSON.stringify({ questions }),
    },
  };
}

function nativeFunctionOutput(
  callId: string,
  answers: Record<string, unknown>,
): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify({ answers }),
    },
  };
}

function runImport(
  sessionPath: string,
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.GSTACK_STATE_ROOT = stateRoot;
  env.GSTACK_QUESTION_LOG_NO_DERIVE = '1';
  delete env.GSTACK_HOME;
  Object.assign(env, extraEnv);
  const res = spawnSync(BIN, [sessionPath], { env, encoding: 'utf-8', cwd: ROOT, timeout: 30_000 });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? -1,
  };
}

function readImportedEvents(): Array<Record<string, unknown>> {
  const f = path.join(stateRoot, 'projects', cwdSlug, 'question-log.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ----------------------------------------------------------------------
// Native request_user_input path
// ----------------------------------------------------------------------

describe('native request_user_input import (source=codex-import-native)', () => {
  test('preserves native question ids and exact answers without inferred recommendations', () => {
    const sessionPath = writeSessionFile([
      nativeFunctionCall('call-native-1', [
        {
          id: 'native_choice_01',
          header: 'Route',
          question: 'Which route should this session use?',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'Route A', description: 'First route' },
            { label: 'Route B', description: 'Second route' },
          ],
        },
        {
          id: 'native-second',
          header: 'Scope',
          question: 'What scope is acceptable?',
          isOther: true,
          isSecret: false,
          options: [{ label: 'Local', description: 'Keep it local' }],
        },
      ]),
      nativeFunctionOutput('call-native-1', {
        native_choice_01: { answers: ['Route B'] },
        'native-second': { answers: ['A free-form answer with no option inference'] },
      }),
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('IMPORTED: 2');
    const events = readImportedEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      source: 'codex-import-native',
      question_id: 'native_choice_01',
      native_question_id: 'native_choice_01',
      user_choice: 'Route B',
      native_answers: ['Route B'],
      codex_call_id: 'call-native-1',
      options_count: 2,
    });
    expect(events[0].tool_use_id).toMatch(/^codex-native-[a-f0-9]{64}$/);
    expect((events[0].tool_use_id as string).length).toBeLessThanOrEqual(128);
    expect(events[1]).toMatchObject({
      source: 'codex-import-native',
      question_id: 'native-second',
      user_choice: 'A free-form answer with no option inference',
      native_answers: ['A free-form answer with no option inference'],
      options_count: 1,
    });
    expect(events[0].recommended).toBeUndefined();
    expect(events[1].recommended).toBeUndefined();
  });

  test('does not treat unanswered or malformed native calls as preferences', () => {
    const sessionPath = writeSessionFile([
      nativeFunctionCall('call-unanswered', [{
        id: 'native-unanswered',
        question: 'This was interrupted',
        options: [{ label: 'A', description: 'A' }],
      }]),
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'request_user_input',
          call_id: 'call-invalid',
          arguments: '{not-json',
        },
      },
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DEGRADED:');
    expect(r.stdout).toContain('native-call-invalid-arguments');
    expect(r.stdout).toContain('IMPORTED: 0');
    expect(readImportedEvents()).toHaveLength(0);
  });

  test('ignores ordinary tool outputs and unsupported async acknowledgements', () => {
    const sessionPath = writeSessionFile([
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell',
          call_id: 'shell-call-1',
          arguments: JSON.stringify({ command: 'printf ordinary' }),
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'shell-call-1',
          output: JSON.stringify({ stdout: 'ordinary tool output' }),
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'request_user_input_async',
          call_id: 'async-call-1',
          arguments: JSON.stringify({ questions: [{ id: 'async-q', question: 'Unsupported async question' }] }),
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'async-call-1',
          output: JSON.stringify({ status: 'accepted' }),
        },
      },
      nativeFunctionCall('call-mixed-valid', [{
        id: 'mixed-valid',
        question: 'Which valid route?',
        options: [{ label: 'A', description: 'A' }],
      }]),
      nativeFunctionOutput('call-mixed-valid', {
        'mixed-valid': { answers: ['A'] },
      }),
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('IMPORTED: 1');
    expect(r.stdout).toContain('native-async-unsupported');
    expect(r.stdout).not.toContain('native-output-invalid');
    expect(readImportedEvents()).toHaveLength(1);
    expect(readImportedEvents()[0]).toMatchObject({
      native_question_id: 'mixed-valid',
      native_answers: ['A'],
    });
  });

  test('never persists answers from native secret questions', () => {
    const sentinel = 'SECRET_SENTINEL_DO_NOT_PERSIST_9a0d';
    const sessionPath = writeSessionFile([
      nativeFunctionCall('call-native-secret', [
        {
          id: 'native-secret',
          question: 'What is the credential?',
          isSecret: true,
          options: [{ label: 'Provided', description: 'Provide it' }],
        },
        {
          id: 'native-public',
          question: 'Should the public choice be retained?',
          isSecret: false,
          options: [{ label: 'Yes', description: 'Retain it' }],
        },
      ]),
      nativeFunctionOutput('call-native-secret', {
        'native-secret': { answers: [sentinel] },
        'native-public': { answers: ['Yes'] },
      }),
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('native-secret-skipped');
    expect(r.stdout).toContain('IMPORTED: 1');
    expect(r.stdout).not.toContain(sentinel);
    expect(r.stderr).not.toContain(sentinel);
    const serializedEvents = JSON.stringify(readImportedEvents());
    expect(serializedEvents).not.toContain(sentinel);
    expect(readImportedEvents()).toMatchObject([{
      native_question_id: 'native-public',
      native_answers: ['Yes'],
    }]);
  });

  test('preserves long free-form and multi-answer values in native_answers', () => {
    const longAnswer = 'A long free-form answer that exceeds the legacy scalar limit: ' + 'x'.repeat(180);
    const secondAnswer = 'second native answer';
    const sessionPath = writeSessionFile([
      nativeFunctionCall('call-native-lossless', [{
        id: 'native-multi-answer',
        question: 'What should be retained exactly?',
        isOther: true,
        options: [{ label: 'One', description: 'One' }],
      }]),
      nativeFunctionOutput('call-native-lossless', {
        'native-multi-answer': { answers: [longAnswer, secondAnswer] },
      }),
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('IMPORTED: 1');
    const events = readImportedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].native_answers).toEqual([longAnswer, secondAnswer]);
    expect(events[0].user_choice).toBe((longAnswer + ' | ' + secondAnswer).slice(0, 64));
    expect(events[0].codex_call_id).toBe('call-native-lossless');
    expect(events[0].native_question_id).toBe('native-multi-answer');
  });

  test('accepts the bounded native question id and rejects one byte over it', () => {
    const acceptedId = 'n'.repeat(128);
    const rejectedId = 'r'.repeat(129);
    const sessionPath = writeSessionFile([
      nativeFunctionCall('call-native-id-bound', [
        { id: acceptedId, question: 'Accepted id', options: [{ label: 'A', description: 'A' }] },
        { id: rejectedId, question: 'Rejected id', options: [{ label: 'B', description: 'B' }] },
      ]),
      nativeFunctionOutput('call-native-id-bound', {
        [acceptedId]: { answers: ['A'] },
        [rejectedId]: { answers: ['B'] },
      }),
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DEGRADED:');
    expect(r.stdout).toContain('IMPORTED: 1');
    const events = readImportedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].native_question_id).toBe(acceptedId);
    expect(events[0].native_answers).toEqual(['A']);
  });
});

// ----------------------------------------------------------------------
// Marker-first path
// ----------------------------------------------------------------------

describe('marker-first import (source=codex-import-marker)', () => {
  test('extracts marker id from agent_message and pairs with next user_message', () => {
    const sessionPath = writeSessionFile([
      agentMessage(
        'D1 — Test\nELI10: blah\n<gstack-qid:ship-test-failure-triage> Tests failed.\nRecommendation: A\nA) Fix now (recommended)\nB) Investigate\nC) Ack and ship',
      ),
      userMessage('A'),
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('IMPORTED: 1');
    const events = readImportedEvents();
    expect(events.length).toBe(1);
    expect(events[0].source).toBe('codex-import-marker');
    expect(events[0].question_id).toBe('ship-test-failure-triage');
    expect(events[0].user_choice).toContain('Fix now');
    expect(events[0].recommended).toContain('Fix now');
  });
});

// ----------------------------------------------------------------------
// Pattern fallback
// ----------------------------------------------------------------------

describe('pattern fallback (source=codex-import-pattern)', () => {
  test('D-numbered brief without marker → hash id + source=codex-import-pattern', () => {
    const sessionPath = writeSessionFile([
      agentMessage('D2 — Unmarked brief\nA) Foo (recommended)\nB) Bar'),
      userMessage('A'),
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    const events = readImportedEvents();
    expect(events.length).toBe(1);
    expect(events[0].source).toBe('codex-import-pattern');
    expect((events[0].question_id as string).startsWith('hook-')).toBe(true);
    expect(events[0].user_choice).toContain('Foo');
  });
});

// ----------------------------------------------------------------------
// Edge cases
// ----------------------------------------------------------------------

describe('edge cases', () => {
  test('no AUQ-shaped events → 0 imported, exit 0', () => {
    const sessionPath = writeSessionFile([
      agentMessage('Just doing some work, nothing to ask.'),
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('IMPORTED: 0');
  });

  test('agent_message with marker but no following user_message → skipped', () => {
    const sessionPath = writeSessionFile([
      agentMessage('<gstack-qid:test-q> D1 — Q\nA) Foo\nB) Bar'),
      // no user_message
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    expect(readImportedEvents().length).toBe(0);
  });

  test('two D-briefs in sequence → both imported', () => {
    const sessionPath = writeSessionFile([
      agentMessage('D1 — First <gstack-qid:q1>\nA) Foo (recommended)\nB) Bar'),
      userMessage('A'),
      agentMessage('D2 — Second <gstack-qid:q2>\nA) Baz (recommended)\nB) Qux'),
      userMessage('B'),
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    const events = readImportedEvents();
    expect(events.length).toBe(2);
    expect(events[0].question_id).toBe('q1');
    expect(events[1].question_id).toBe('q2');
  });

  test('numeric user response also resolves to letter index', () => {
    const sessionPath = writeSessionFile([
      agentMessage('D1 — Test <gstack-qid:numeric-q>\nA) Foo\nB) Bar\nC) Baz'),
      userMessage('B - I think B is right'),
    ]);
    runImport(sessionPath);
    const events = readImportedEvents();
    expect(events.length).toBe(1);
    expect(events[0].user_choice).toContain('Bar');
  });

  test('reports qlog nonzero and timeout as categorical degraded outcomes', () => {
    const sessionPath = writeSessionFile([
      nativeFunctionCall('call-qlog-status', [{
        id: 'native-qlog-status',
        question: 'Should this be recorded?',
        options: [{ label: 'Yes', description: 'Record it' }],
      }]),
      nativeFunctionOutput('call-qlog-status', {
        'native-qlog-status': { answers: ['Yes'] },
      }),
    ]);
    const nonzeroQlog = path.join(stateRoot, 'qlog-nonzero.sh');
    fs.writeFileSync(nonzeroQlog, '#!/usr/bin/env bash\nexit 7\n');
    fs.chmodSync(nonzeroQlog, 0o755);
    const nonzero = runImport(sessionPath, {
      GSTACK_CODEX_SESSION_IMPORT_QLOG_BIN: nonzeroQlog,
    });
    expect(nonzero.status).toBe(0);
    expect(nonzero.stdout).toContain('DEGRADED:');
    expect(nonzero.stdout).toContain('qlog-nonzero');
    expect(nonzero.stdout).toContain('IMPORTED: 0');

    const timeoutQlog = path.join(stateRoot, 'qlog-timeout.sh');
    fs.writeFileSync(timeoutQlog, '#!/usr/bin/env bash\nsleep 1\n');
    fs.chmodSync(timeoutQlog, 0o755);
    const timed = runImport(sessionPath, {
      GSTACK_CODEX_SESSION_IMPORT_QLOG_BIN: timeoutQlog,
      GSTACK_CODEX_SESSION_IMPORT_QLOG_TIMEOUT_MS: '10',
    });
    expect(timed.status).toBe(0);
    expect(timed.stdout).toContain('qlog-timeout');
    expect(timed.stdout).toContain('IMPORTED: 0');
  });

  test('rejects a transcript above the bounded 8MB parser input', () => {
    const sessionPath = path.join(stateRoot, 'oversized-rollout.jsonl');
    fs.writeFileSync(sessionPath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DEGRADED:');
    expect(r.stdout).toContain('transcript-too-large');
    expect(r.stdout).toContain('IMPORTED: 0');
  });
});

// ----------------------------------------------------------------------
// Default-mode (latest session) behavior
// ----------------------------------------------------------------------

describe('default mode (no args → latest)', () => {
  test('returns NO_SESSIONS when sessions dir is empty', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-empty-cdx-'));
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
      }
      env.GSTACK_STATE_ROOT = stateRoot;
      env.CODEX_SESSIONS_ROOT = emptyDir;
      const res = spawnSync(BIN, [], { env, encoding: 'utf-8', cwd: ROOT, timeout: 30_000 });
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/NO_SESSIONS/);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
