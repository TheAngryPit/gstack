import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CODEX_HOOK_EVENTS,
  reconcileCodexHooks,
  resolveHookCommand,
} from '../bin/gstack-codex-hooks.ts';
// Keep the import on the typed implementation; the extensionless sibling is
// the executable shell shim used by Codex/setup.
import { validateCurrentTranscript } from '../hosts/codex/hooks/codex-lifecycle-hook.ts';

const ROOT = path.resolve(import.meta.dir, '..');
const INSTALLER = path.join(ROOT, 'bin', 'gstack-codex-hooks');
const HOOK = path.join(ROOT, 'hosts', 'codex', 'hooks', 'codex-lifecycle-hook');
const HOOK_TS = path.join(ROOT, 'hosts', 'codex', 'hooks', 'codex-lifecycle-hook.ts');

let tmpDir: string;
let configPath: string;
let stateRoot: string;
let projectDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-native-'));
  configPath = path.join(tmpDir, 'hooks.json');
  stateRoot = path.join(tmpDir, 'state');
  projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readConfig(): any {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function writeConfig(value: unknown): void {
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
}

// The grandchild declares readiness only once armed. Its marker is impossible
// before explicit release, so slow parent-side observation cannot fake survival.
function armedImporter(started: string, release: string, late: string): string {
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  return `#!/usr/bin/env bash
trap '' TERM INT HUP
(
  printf armed > ${quote(started)}
  for ((attempt=0; attempt<200; attempt++)); do
    if [ -f ${quote(release)} ]; then printf late > ${quote(late)}; exit 0; fi
    sleep 0.05
  done
) &
wait
`;
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(fs.existsSync(file)).toBe(true);
}

function runInstaller(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(INSTALLER, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runHook(payload: unknown, env: Record<string, string> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(HOOK, [], {
    cwd: ROOT,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      GSTACK_ROOT: ROOT,
      GSTACK_STATE_ROOT: stateRoot,
      GSTACK_PROJECT_SLUG: 'codex-native-lifecycle-test',
      ...env,
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function timeline(): any[] {
  const file = path.join(stateRoot, 'projects', 'codex-native-lifecycle-test', 'timeline.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function payload(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'sess-native-test',
    transcript_path: null,
    cwd: projectDir,
    hook_event_name: event,
    turn_id: 'turn-1',
    ...extra,
  };
}

describe('Codex hook reconciler', () => {
  test('install and remove preserve foreign composite commands ending in the lifecycle suffix', () => {
    const old = '/old/gstack/hosts/codex/hooks/codex-lifecycle-hook';
    const foreign = [
      '/usr/bin/printf ready; ' + old,
      '/usr/bin/true && ' + old,
      '/usr/bin/printf ready | ' + old,
      old + ' > /tmp/foreign-output',
      '"' + old + '" ; "' + old + '"',
      'bash ' + old + '; ' + old,
      '"/old/$(touch marker)/hosts/codex/hooks/codex-lifecycle-hook"',
      '"/old/`touch marker`/hosts/codex/hooks/codex-lifecycle-hook"',
      '/old/gstack*/hosts/codex/hooks/codex-lifecycle-hook',
    ];
    const handlers = foreign.map(command => ({ type: 'command', command, timeout: 3 }));
    writeConfig({ hooks: { Stop: [{ matcher: 'foreign', hooks: handlers }] } });
    const status = reconcileCodexHooks('status', { configPath, root: ROOT });
    expect(status.events.find(event => event.event === 'Stop')?.staleCount).toBe(0);
    reconcileCodexHooks('install', { configPath, root: ROOT });
    const installed = readConfig().hooks.Stop.flatMap((group: any) => group.hooks);
    for (const handler of handlers) expect(installed).toContainEqual(handler);
    reconcileCodexHooks('remove', { configPath, root: ROOT });
    expect(readConfig().hooks.Stop).toEqual([{ matcher: 'foreign', hooks: handlers }]);
  });

  test('recognizes only supported literal executable and wrapper forms, including quoted metacharacters', () => {
    const suffix = '/hosts/codex/hooks/codex-lifecycle-hook';
    const commands = [
      '/old/gstack' + suffix,
      'bash "/old/gstack space' + suffix + '"',
      "sh '/old/gstack;literal" + suffix + "'",
      'bun "/old/gstack\\$literal\\`tick\\\"quote' + suffix + '"',
    ];
    for (const command of commands) {
      writeConfig({ hooks: { Stop: [{ hooks: [{ type: 'command', command, timeout: 3 }] }] } });
      expect(reconcileCodexHooks('status', { configPath, root: ROOT }).events.find(event => event.event === 'Stop')?.staleCount).toBe(1);
      reconcileCodexHooks('install', { configPath, root: ROOT });
      expect(readConfig().hooks.Stop[0].hooks).toEqual([{ type: 'command', command: resolveHookCommand(ROOT), timeout: 3 }]);
    }
  });

  test('installs all supported lifecycle events and preserves foreign groups', () => {
    writeConfig({
      description: 'keep me',
      hooks: {
        Stop: [{ matcher: 'foreign', hooks: [{ type: 'command', command: '/foreign/stop' }] }],
        PreCompact: [{ matcher: 'reserved-for-later', hooks: [] }],
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/foreign/post' }] }],
      },
    });

    const report = reconcileCodexHooks('install', { configPath, root: ROOT, timeout: 2 });
    expect(report.changed).toBe(true);
    expect(report.trust).toBe('native-review-required');
    expect(report.events.map((event) => event.event)).toEqual([...CODEX_HOOK_EVENTS]);

    const installed = readConfig();
    expect(installed.description).toBe('keep me');
    expect(installed.hooks.PostToolUse[0].hooks[0].command).toBe('/foreign/post');
    expect(installed.hooks.Stop[0].hooks[0].command).toBe('/foreign/stop');
    expect(installed.hooks.PreCompact[0].matcher).toBe('reserved-for-later');
    for (const event of CODEX_HOOK_EVENTS) {
      const matches = installed.hooks[event].flatMap((group: any) => group.hooks ?? [])
        .filter((hook: any) => hook.command === resolveHookCommand(ROOT));
      expect(matches).toHaveLength(1);
      expect(matches[0].timeout).toBe(2);
    }
    const text = fs.readFileSync(configPath, 'utf8');
    expect(text).not.toContain('trusted');
    expect(text).not.toContain('hash');
  });

  test('is idempotent and repairs duplicate owned handlers without deleting a mixed foreign group', () => {
    const command = resolveHookCommand(ROOT);
    writeConfig({
      hooks: {
        Stop: [
          { hooks: [
            { type: 'command', command },
            { type: 'command', command: '/foreign/keep' },
          ] },
          { hooks: [{ type: 'command', command }] },
        ],
      },
    });

    const first = reconcileCodexHooks('install', { configPath, root: ROOT });
    expect(first.events.find((event) => event.event === 'Stop')?.count).toBe(1);
    const afterFirst = fs.readFileSync(configPath, 'utf8');
    const second = reconcileCodexHooks('install', { configPath, root: ROOT });
    expect(second.changed).toBe(false);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(afterFirst);
    const stop = readConfig().hooks.Stop;
    expect(stop).toHaveLength(1);
    expect(stop[0].hooks.map((hook: any) => hook.command)).toEqual([command, '/foreign/keep']);
  });

  test('repoints an older absolute gstack root without claiming a same-named foreign command', () => {
    writeConfig({
      hooks: {
        SessionEnd: [{ hooks: [
          { type: 'command', command: '/old/gstack/hosts/codex/hooks/codex-lifecycle-hook' },
          { type: 'command', command: '/foreign/codex-lifecycle-hook' },
        ] }],
      },
    });
    const report = reconcileCodexHooks('install', { configPath, root: ROOT });
    expect(report.events.find((event) => event.event === 'SessionEnd')?.count).toBe(1);
    expect(readConfig().hooks.SessionEnd[0].hooks.map((hook: any) => hook.command)).toEqual([
      resolveHookCommand(ROOT),
      '/foreign/codex-lifecycle-hook',
    ]);
  });

  test('status reports stale lifecycle paths as stale, not installed', () => {
    const command = resolveHookCommand(ROOT);
    expect(command.startsWith('"')).toBe(true);
    expect(command.endsWith('"')).toBe(true);
    writeConfig({
      hooks: {
        SessionEnd: [{ hooks: [
          { type: 'command', command: '"/old/gstack/hosts/codex/hooks/codex-lifecycle-hook"' },
        ] }],
      },
    });

    const report = reconcileCodexHooks('status', { configPath, root: ROOT });
    const status = report.events.find((event) => event.event === 'SessionEnd');
    expect(status).toMatchObject({ installed: false, count: 0, staleCount: 1, state: 'stale' });
  });

  test('status reports a matching command with the wrong type or timeout as stale', () => {
    const command = resolveHookCommand(ROOT);
    writeConfig({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'prompt', command, timeout: 30 }] }],
        PreCompact: [{ hooks: [{ type: 'command', command, timeout: 30 }] }],
      },
    });

    const report = reconcileCodexHooks('status', { configPath, root: ROOT, timeout: 3 });
    expect(report.events.find((event) => event.event === 'SessionEnd')).toMatchObject({
      installed: false,
      count: 0,
      staleCount: 1,
      state: 'stale',
    });
    expect(report.events.find((event) => event.event === 'PreCompact')).toMatchObject({
      installed: false,
      count: 0,
      staleCount: 1,
      state: 'stale',
    });

    const repaired = reconcileCodexHooks('install', { configPath, root: ROOT, timeout: 3 });
    expect(repaired.events.every((event) => event.installed)).toBe(true);
    expect(readConfig().hooks.SessionEnd[0].hooks[0]).toMatchObject({ type: 'command', command, timeout: 3 });
    expect(readConfig().hooks.PreCompact[0].hooks[0]).toMatchObject({ type: 'command', command, timeout: 3 });
  });

  test('quotes executable paths containing shell metacharacters without spaces', () => {
    const metacharRoot = path.join(tmpDir, 'gstack;review');
    const command = resolveHookCommand(metacharRoot);
    expect(command).toBe(`"${path.join(metacharRoot, 'hosts', 'codex', 'hooks', 'codex-lifecycle-hook')}"`);
    writeConfig({});
    const report = reconcileCodexHooks('install', { configPath, root: metacharRoot });
    expect(report.events.every((event) => event.installed)).toBe(true);
    expect(readConfig().hooks.SessionEnd[0].hooks[0].command).toBe(command);

    const unsafePath = path.join(metacharRoot, 'hosts', 'codex', 'hooks', 'codex-lifecycle-hook');
    writeConfig({ hooks: { Stop: [{ hooks: [{ type: 'command', command: unsafePath }] }] } });
    reconcileCodexHooks('install', { configPath, root: metacharRoot });
    // Unquoted ";" is shell composition, not proof of a literal owned path.
    expect(readConfig().hooks.Stop.flatMap((group: any) => group.hooks.map((hook: any) => hook.command))).toEqual([unsafePath, command]);
  });

  test('plan is read-only and remove preserves foreign handlers', () => {
    writeConfig({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: '/foreign/end' }] }] } });
    const before = fs.readFileSync(configPath, 'utf8');
    const plan = reconcileCodexHooks('plan', { configPath, root: ROOT });
    expect(plan.changed).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);

    reconcileCodexHooks('install', { configPath, root: ROOT });
    reconcileCodexHooks('remove', { configPath, root: ROOT });
    expect(readConfig()).toEqual({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: '/foreign/end' }] }] } });
  });

  test('refuses malformed event arrays without overwriting the config', () => {
    writeConfig({ hooks: { Stop: { not: 'an array' } }, keep: true });
    const before = fs.readFileSync(configPath, 'utf8');
    const result = runInstaller(['install', '--config', configPath, '--root', ROOT, '--json']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Stop hooks must be an array');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });
});

describe('Codex lifecycle bridge', () => {
  test('emits a fail-open continuation and records each supported event once', () => {
    for (const event of CODEX_HOOK_EVENTS) {
      const result = runHook(payload(event));
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ continue: true });
      expect(result.stderr).toBe('');
    }
    const firstCount = timeline().length;
    expect(firstCount).toBe(CODEX_HOOK_EVENTS.length);
    expect(runHook(payload('Stop')).status).toBe(0);
    expect(timeline()).toHaveLength(firstCount);
  });

  test('keeps legitimate repeated lifecycle events when native turn_id is absent', () => {
    const prompt = payload('UserPromptSubmit');
    const stop = payload('Stop');
    const compact = payload('PreCompact');
    delete prompt.turn_id;
    delete stop.turn_id;
    delete compact.turn_id;

    expect(runHook(prompt).status).toBe(0);
    expect(runHook({ ...prompt }).status).toBe(0);
    expect(runHook(stop).status).toBe(0);
    expect(runHook(compact).status).toBe(0);
    expect(timeline().map((entry) => entry.event)).toEqual([
      'prompt-submitted',
      'prompt-submitted',
      'stop',
      'pre-compact',
    ]);
    expect(timeline().every((entry) => entry.turn_id === undefined)).toBe(true);
  });

  test('malformed, unsupported, interrupted, and zero-budget inputs remain non-blocking', () => {
    for (const input of ['', '{', JSON.stringify({ hook_event_name: 'Unknown' })]) {
      const result = runHook(input);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ continue: true });
    }
    const timed = runHook(payload('Stop'), { GSTACK_CODEX_LIFECYCLE_BUDGET_MS: '0' });
    expect(timed.status).toBe(0);
    expect(JSON.parse(timed.stdout)).toEqual({ continue: true });
    expect(timeline()).toHaveLength(0);
  });

  test('nullable and non-native transcript paths are rejected without discovery fallback', () => {
    const base = { sessionId: 'session', cwd: projectDir };
    expect(validateCurrentTranscript({ ...base, transcriptPath: null })).toMatchObject({
      ok: false,
      reason: 'missing-transcript-path',
    });
    expect(validateCurrentTranscript({ ...base, transcriptPath: 'relative.jsonl' })).toMatchObject({
      ok: false,
      reason: 'invalid-transcript-path',
    });
    expect(validateCurrentTranscript({ ...base, transcriptPath: path.join(tmpDir, 'missing.jsonl') })).toMatchObject({
      ok: false,
      reason: 'unreadable-transcript',
    });
  });

  test('requires matching Codex session and workspace, and rejects partial unless explicitly allowed', () => {
    const transcript = path.join(tmpDir, 'rollout.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'other-session', cwd: projectDir } }),
      '{"type":"event_msg"',
    ].join('\n') + '\n');
    expect(validateCurrentTranscript({ sessionId: 'session', cwd: projectDir, transcriptPath: transcript })).toMatchObject({
      ok: false,
      reason: 'session-mismatch',
      partial: true,
    });

    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'session', cwd: path.join(tmpDir, 'other') } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'x' } }),
    ].join('\n') + '\n');
    expect(validateCurrentTranscript({ sessionId: 'session', cwd: projectDir, transcriptPath: transcript })).toMatchObject({
      ok: false,
      reason: 'workspace-mismatch',
    });

    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'session', cwd: projectDir } }),
      '{"type":"event_msg"',
    ].join('\n') + '\n');
    expect(validateCurrentTranscript({ sessionId: 'session', cwd: projectDir, transcriptPath: transcript })).toMatchObject({
      ok: false,
      reason: 'partial-transcript',
      partial: true,
    });
    const previous = process.env.GSTACK_CODEX_LIFECYCLE_ALLOW_PARTIAL;
    process.env.GSTACK_CODEX_LIFECYCLE_ALLOW_PARTIAL = '1';
    try {
      expect(validateCurrentTranscript({ sessionId: 'session', cwd: projectDir, transcriptPath: transcript })).toMatchObject({
        ok: true,
        reason: 'ok',
        partial: true,
      });
    } finally {
      if (previous === undefined) delete process.env.GSTACK_CODEX_LIFECYCLE_ALLOW_PARTIAL;
      else process.env.GSTACK_CODEX_LIFECYCLE_ALLOW_PARTIAL = previous;
    }

    fs.writeFileSync(transcript, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    expect(validateCurrentTranscript({ sessionId: 'session', cwd: projectDir, transcriptPath: transcript })).toMatchObject({
      ok: false,
      reason: 'transcript-too-large',
      partial: false,
    });
  });

  test('records categorical nonzero helper results without blocking the native hook', () => {
    const fakeRoot = path.join(tmpDir, 'fake-root');
    fs.mkdirSync(path.join(fakeRoot, 'bin'), { recursive: true });
    const logger = path.join(fakeRoot, 'bin', 'gstack-timeline-log');
    fs.writeFileSync(logger, '#!/usr/bin/env bash\nexit 7\n');
    fs.chmodSync(logger, 0o755);

    const result = runHook(payload('Stop'), {
      GSTACK_ROOT: fakeRoot,
      GSTACK_PROJECT_SLUG: 'codex-native-lifecycle-test',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
    expect(fs.readFileSync(path.join(stateRoot, 'hook-errors.log'), 'utf8')).toContain('timeline-write-nonzero');
  });

  test('records a categorical importer failure while keeping SessionEnd fail-open', () => {
    const fakeRoot = path.join(tmpDir, 'fake-import-root');
    fs.mkdirSync(path.join(fakeRoot, 'bin'), { recursive: true });
    const importer = path.join(fakeRoot, 'bin', 'gstack-codex-session-import');
    fs.writeFileSync(importer, '#!/usr/bin/env bash\nexit 7\n');
    fs.chmodSync(importer, 0o755);
    const transcript = path.join(tmpDir, 'current-rollout.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'sess-native-test', cwd: projectDir } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n') + '\n');

    const result = runHook(payload('SessionEnd', { transcript_path: transcript }), {
      GSTACK_ROOT: fakeRoot,
      GSTACK_PROJECT_SLUG: 'codex-native-lifecycle-test',
      GSTACK_CODEX_LIFECYCLE_INGEST_CURRENT_SESSION: '1',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
    expect(fs.readFileSync(path.join(stateRoot, 'hook-errors.log'), 'utf8')).toContain('session-import-nonzero');
  });

  test('records semantic importer degradation as partial while keeping successful import count', () => {
    const fakeRoot = path.join(tmpDir, 'semantic-import-root');
    fs.mkdirSync(path.join(fakeRoot, 'bin'), { recursive: true });
    const importer = path.join(fakeRoot, 'bin', 'gstack-codex-session-import');
    fs.writeFileSync(importer, '#!/usr/bin/env bash\nprintf "DEGRADED: qlog-timeout\\nIMPORTED: 1 events from 1 session(s)\\n"\n');
    fs.chmodSync(importer, 0o755);
    const transcript = path.join(tmpDir, 'semantic-rollout.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'sess-native-test', cwd: projectDir } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n') + '\n');

    const result = runHook(payload('SessionEnd', { transcript_path: transcript }), {
      GSTACK_ROOT: fakeRoot,
      GSTACK_PROJECT_SLUG: 'codex-native-lifecycle-test',
      GSTACK_CODEX_LIFECYCLE_INGEST_CURRENT_SESSION: '1',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
    const errors = fs.readFileSync(path.join(stateRoot, 'hook-errors.log'), 'utf8');
    expect(errors).toContain('session-import-partial');
    expect(errors).toContain('session-import-reason-qlog-timeout');
  });

  test('records semantic importer failure when no event was imported', () => {
    const fakeRoot = path.join(tmpDir, 'semantic-failure-root');
    fs.mkdirSync(path.join(fakeRoot, 'bin'), { recursive: true });
    const importer = path.join(fakeRoot, 'bin', 'gstack-codex-session-import');
    fs.writeFileSync(importer, '#!/usr/bin/env bash\nprintf "DEGRADED: qlog-timeout\\nIMPORTED: 0 events from 1 session(s)\\n"\n');
    fs.chmodSync(importer, 0o755);
    const transcript = path.join(tmpDir, 'semantic-failure-rollout.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'sess-native-test', cwd: projectDir } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n') + '\n');

    const result = runHook(payload('SessionEnd', { transcript_path: transcript }), {
      GSTACK_ROOT: fakeRoot,
      GSTACK_PROJECT_SLUG: 'codex-native-lifecycle-test',
      GSTACK_CODEX_LIFECYCLE_INGEST_CURRENT_SESSION: '1',
    });
    expect(result.status).toBe(0);
    const errors = fs.readFileSync(path.join(stateRoot, 'hook-errors.log'), 'utf8');
    expect(errors).toContain('session-import-failed');
    expect(errors).toContain('session-import-reason-qlog-timeout');
  });

  test('recomputes the deadline after slug resolution before starting import', () => {
    const fakeRoot = path.join(tmpDir, 'slug-budget-root');
    fs.mkdirSync(path.join(fakeRoot, 'bin'), { recursive: true });
    const slugCount = path.join(tmpDir, 'slug-count');
    const lateImporter = path.join(tmpDir, 'importer-ran');
    const slug = path.join(fakeRoot, 'bin', 'gstack-slug');
    fs.writeFileSync(slug, `#!/usr/bin/env bash\ncount=0\nif [ -f '${slugCount}' ]; then count=$(cat '${slugCount}'); fi\nprintf '%s' "$((count + 1))" > '${slugCount}'\nif [ "$count" -ge 1 ]; then sleep 1; fi\nprintf 'slug-budget-test\\n'\n`);
    fs.chmodSync(slug, 0o755);
    fs.writeFileSync(path.join(fakeRoot, 'bin', 'gstack-timeline-log'), '#!/usr/bin/env bash\nexit 0\n');
    fs.chmodSync(path.join(fakeRoot, 'bin', 'gstack-timeline-log'), 0o755);
    const importer = path.join(fakeRoot, 'bin', 'gstack-codex-session-import');
    fs.writeFileSync(importer, `#!/usr/bin/env bash\nprintf ran > '${lateImporter}'\n`);
    fs.chmodSync(importer, 0o755);
    const transcript = path.join(tmpDir, 'slug-budget-rollout.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'sess-native-test', cwd: projectDir } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n') + '\n');

    const result = runHook(payload('SessionEnd', { transcript_path: transcript }), {
      GSTACK_ROOT: fakeRoot,
      GSTACK_PROJECT_SLUG: '',
      GSTACK_CODEX_LIFECYCLE_INGEST_CURRENT_SESSION: '1',
      GSTACK_CODEX_LIFECYCLE_BUDGET_MS: '500',
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(lateImporter)).toBe(false);
    const errors = fs.readFileSync(path.join(stateRoot, 'hook-errors.log'), 'utf8');
    expect(errors).toContain('budget-exhausted-before-transcript-import');
  });

  test('kills a timed-out importer process group before a delayed descendant can write', () => {
    const fakeRoot = path.join(tmpDir, 'delayed-import-root');
    fs.mkdirSync(path.join(fakeRoot, 'bin'), { recursive: true });
    const importer = path.join(fakeRoot, 'bin', 'gstack-codex-session-import');
    const lateWrite = path.join(tmpDir, 'late-import-write');
    fs.writeFileSync(importer, `#!/usr/bin/env bash\ntrap '' TERM INT HUP\n( sleep 1; printf late > '${lateWrite.replace(/'/g, "'\\''")}' ) &\nsleep 5\n`);
    fs.chmodSync(importer, 0o755);
    const transcript = path.join(tmpDir, 'delayed-rollout.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'sess-native-test', cwd: projectDir } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n') + '\n');

    const result = runHook(payload('SessionEnd', { transcript_path: transcript }), {
      GSTACK_ROOT: fakeRoot,
      GSTACK_PROJECT_SLUG: 'codex-native-lifecycle-test',
      GSTACK_CODEX_LIFECYCLE_INGEST_CURRENT_SESSION: '1',
      GSTACK_CODEX_LIFECYCLE_BUDGET_MS: '300',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
    spawnSync('sleep', ['2'], { timeout: 3_000 });
    expect(fs.existsSync(lateWrite)).toBe(false);
    expect(fs.readFileSync(path.join(stateRoot, 'hook-errors.log'), 'utf8')).toContain('session-import-timeout');
  });

  test('bounds a direct helper that ignores SIGTERM and prevents a late marker', () => {
    const fakeRoot = path.join(tmpDir, 'term-immune-root');
    fs.mkdirSync(path.join(fakeRoot, 'bin'), { recursive: true });
    const importer = path.join(fakeRoot, 'bin', 'gstack-codex-session-import');
    const started = path.join(tmpDir, 'term-immune-started');
    const lateWrite = path.join(tmpDir, 'term-immune-late');
    fs.writeFileSync(importer, `#!/usr/bin/env bash\nprintf started > '${started.replace(/'/g, "'\\''")}'\ntrap '' TERM INT HUP\nsleep 1\nprintf late > '${lateWrite.replace(/'/g, "'\\''")}'\n`);
    fs.chmodSync(importer, 0o755);
    const transcript = path.join(tmpDir, 'term-immune-rollout.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'sess-native-test', cwd: projectDir } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n') + '\n');

    const startedAt = Date.now();
    const result = runHook(payload('SessionEnd', { transcript_path: transcript }), {
      GSTACK_ROOT: fakeRoot,
      GSTACK_PROJECT_SLUG: 'codex-native-lifecycle-test',
      GSTACK_CODEX_LIFECYCLE_INGEST_CURRENT_SESSION: '1',
      GSTACK_CODEX_LIFECYCLE_BUDGET_MS: '300',
    });
    expect(result.status).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
    expect(fs.existsSync(started)).toBe(true);
    spawnSync('sleep', ['1.5'], { timeout: 3_000 });
    expect(fs.existsSync(lateWrite)).toBe(false);
    expect(fs.readFileSync(path.join(stateRoot, 'hook-errors.log'), 'utf8')).toContain('session-import-timeout');
  });

  test('parent-termination fixture positive control writes only after release', async () => {
    const started = path.join(tmpDir, 'control-started');
    const release = path.join(tmpDir, 'control-release');
    const late = path.join(tmpDir, 'control-late');
    const importer = path.join(tmpDir, 'control-importer');
    fs.writeFileSync(importer, armedImporter(started, release, late));
    const child = spawn('bash', [importer], { detached: true, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      await waitForFile(started);
      spawnSync('sleep', ['1.2'], { timeout: 3_000 });
      expect(fs.existsSync(late)).toBe(false);
      fs.writeFileSync(release, 'go');
      await waitForFile(late);
      await exited;
    } finally {
      // Only this fixture's detached, directly spawned process group is ours.
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    }
  });

  test.each([0, 1_200])('on parent termination, kills the active helper group before exiting (observation delay %ims)', async (observationDelay) => {
    const fakeRoot = path.join(tmpDir, 'parent-term-root');
    fs.mkdirSync(path.join(fakeRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, 'bin', 'gstack-timeline-log'), '#!/usr/bin/env bash\nexit 0\n');
    fs.chmodSync(path.join(fakeRoot, 'bin', 'gstack-timeline-log'), 0o755);
    const importer = path.join(fakeRoot, 'bin', 'gstack-codex-session-import');
    const started = path.join(tmpDir, 'parent-term-started');
    const release = path.join(tmpDir, 'parent-term-release');
    const lateWrite = path.join(tmpDir, 'parent-term-late');
    fs.writeFileSync(importer, armedImporter(started, release, lateWrite));
    fs.chmodSync(importer, 0o755);
    const transcript = path.join(tmpDir, 'parent-term-rollout.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'sess-native-test', cwd: projectDir } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n') + '\n');

    const child = spawn(process.execPath, [HOOK_TS], {
      cwd: ROOT,
      env: {
        ...process.env,
        GSTACK_ROOT: fakeRoot,
        GSTACK_STATE_ROOT: stateRoot,
        GSTACK_PROJECT_SLUG: 'codex-native-lifecycle-test',
        GSTACK_CODEX_LIFECYCLE_INGEST_CURRENT_SESSION: '1',
        GSTACK_CODEX_LIFECYCLE_BUDGET_MS: '4000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(JSON.stringify(payload('SessionEnd', { transcript_path: transcript })));
    const output: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    await waitForFile(started);
    // Reproduce delayed observation from synchronous work elsewhere in a suite.
    if (observationDelay) spawnSync('sleep', [String(observationDelay / 1000)], { timeout: 3_000 });
    expect(fs.existsSync(lateWrite)).toBe(false);
    const signalAt = Date.now();
    child.kill('SIGTERM');
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    expect(Date.now() - signalAt).toBeLessThan(1_500);
    expect(exit).toMatchObject({ code: 143, signal: null });
    // Release only AFTER the parent has exited: any escaped descendant can
    // now expose a real post-termination write, independently of startup time.
    fs.writeFileSync(release, 'go');
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    if (fs.existsSync(lateWrite)) {
      console.error('owned-child termination timing', JSON.stringify({
        signalAt, readyAt: fs.statSync(started).mtimeMs,
        lateAt: fs.statSync(lateWrite).mtimeMs,
        readyBeforeSignalMs: signalAt - fs.statSync(started).mtimeMs,
        lateAfterSignalMs: fs.statSync(lateWrite).mtimeMs - signalAt,
      }));
    }
    expect(fs.existsSync(lateWrite)).toBe(false);
    expect(Buffer.concat(output).toString()).toBe('');
  }, 15_000);
});
