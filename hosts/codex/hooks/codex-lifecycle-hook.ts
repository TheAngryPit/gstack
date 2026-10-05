#!/usr/bin/env bun
/**
 * Codex-native lifecycle bridge.
 *
 * This command is deliberately small and fail-open. It records bounded
 * lifecycle markers in the existing gstack timeline and, only when the
 * operator opts in, imports the one transcript named by the native hook
 * payload through gstack-codex-session-import.
 *
 * The transcript format is not a hook contract. The bridge therefore never
 * discovers a "latest" session, walks ~/.codex/sessions, or invents a trust
 * hash. A transcript is eligible only when the native payload supplies a
 * regular file and the existing memory-ingest parser confirms both its Codex
 * session id and workspace.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'fs';
import { dirname, isAbsolute, normalize, resolve, join } from 'path';
import { fileURLToPath } from 'url';

import { parseTranscriptJsonl } from '../../../bin/gstack-memory-ingest';
import { runExternal } from '../../claude/hooks/spawn-bin.ts';
import { resolveStateRoot } from '../../../lib/state-root';

export const CODEX_LIFECYCLE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'PreCompact',
  'SessionEnd',
] as const;

export type CodexLifecycleEvent = (typeof CODEX_LIFECYCLE_EVENTS)[number];

export const CURRENT_SESSION_INGEST_ENV = 'GSTACK_CODEX_LIFECYCLE_INGEST_CURRENT_SESSION';
export const ALLOW_PARTIAL_ENV = 'GSTACK_CODEX_LIFECYCLE_ALLOW_PARTIAL';
export const BRIDGE_BUDGET_ENV = 'GSTACK_CODEX_LIFECYCLE_BUDGET_MS';

const DEFAULT_BUDGET_MS = 2_000;
const MAX_BUDGET_MS = 5_000;
const MAX_STDIN_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const TIMELINE_TAIL_BYTES = 256 * 1024;
const IMPORT_TIMEOUT_MS = 1_500;

const EVENT_NAMES: Record<CodexLifecycleEvent, string> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'prompt-submitted',
  Stop: 'stop',
  PreCompact: 'pre-compact',
  SessionEnd: 'session-end',
};

interface SpawnOwnedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  encoding?: BufferEncoding | 'buffer';
  timeout?: number;
}

interface SpawnOwnedResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string | Buffer;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

type KillOwnedGroup = () => void;

const ACTIVE_GROUPS = new Set<KillOwnedGroup>();
const PARENT_SIGNAL_LISTENERS = new Map<NodeJS.Signals, () => void>();
let parentSignalHandlersInstalled = false;
let parentTerminating = false;

const PARENT_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129;
}

function onParentTermination(signal: NodeJS.Signals): void {
  if (parentTerminating) return;
  parentTerminating = true;
  // The native hook host may terminate this process while the child is
  // ignoring SIGTERM. Kill every detached group before exiting so neither the
  // helper nor a descendant can outlive the hook and write a late marker.
  for (const killGroup of ACTIVE_GROUPS) {
    try { killGroup(); } catch { /* best effort during process teardown */ }
  }
  process.exit(exitCodeForSignal(signal));
}

function installParentSignalHandlers(): void {
  if (parentSignalHandlersInstalled) return;
  parentSignalHandlersInstalled = true;
  for (const signal of PARENT_SIGNALS) {
    const listener = () => onParentTermination(signal);
    PARENT_SIGNAL_LISTENERS.set(signal, listener);
    process.on(signal, listener);
  }
}

function uninstallParentSignalHandlers(): void {
  if (!parentSignalHandlersInstalled || ACTIVE_GROUPS.size > 0) return;
  parentSignalHandlersInstalled = false;
  for (const [signal, listener] of PARENT_SIGNAL_LISTENERS) process.removeListener(signal, listener);
  PARENT_SIGNAL_LISTENERS.clear();
}

function trackOwnedGroup(killGroup: KillOwnedGroup): () => void {
  ACTIVE_GROUPS.add(killGroup);
  installParentSignalHandlers();
  return () => {
    ACTIVE_GROUPS.delete(killGroup);
    uninstallParentSignalHandlers();
  };
}

async function spawnOwned(
  command: string,
  args: string[],
  options: SpawnOwnedOptions,
): Promise<SpawnOwnedResult> {
  let unregister: (() => void) | undefined;
  const result = await runExternal(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: Math.max(1, options.timeout ?? 1),
    onSpawn: (killGroup) => {
      unregister = trackOwnedGroup(killGroup);
    },
  });
  unregister?.();
  const encoding = options.encoding === 'buffer' ? undefined : (options.encoding ?? 'utf8');
  const error = result.error
    ? Object.assign(new Error(result.error), { code: result.error }) as NodeJS.ErrnoException
    : undefined;
  return {
    status: result.status,
    signal: result.signal,
    stdout: encoding ? result.stdout.toString(encoding) : result.stdout,
    stderr: result.stderrTail,
    ...(error ? { error } : {}),
  };
}

export interface CodexHookInput {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  model?: unknown;
  permission_mode?: unknown;
  turn_id?: unknown;
  source?: unknown;
  trigger?: unknown;
  prompt?: unknown;
  [key: string]: unknown;
}

interface NormalizedInput {
  sessionId: string;
  cwd: string;
  event: CodexLifecycleEvent;
  transcriptPath: string | null;
  turnId: string | null;
  detail: string | null;
}

export interface TranscriptCheck {
  ok: boolean;
  reason:
    | 'ok'
    | 'missing-transcript-path'
    | 'invalid-transcript-path'
    | 'transcript-not-regular-file'
    | 'transcript-too-large'
    | 'workspace-missing'
    | 'workspace-mismatch'
    | 'session-mismatch'
    | 'not-codex-transcript'
    | 'partial-transcript'
    | 'unreadable-transcript';
  transcriptPath: string | null;
  partial: boolean;
}

function stateRoot(): string {
  return resolveStateRoot();
}

function repoRoot(): string {
  const explicit = process.env.GSTACK_ROOT;
  if (explicit && isAbsolute(explicit)) return explicit;
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}

function budgetMs(): number {
  const raw = process.env[BRIDGE_BUDGET_ENV];
  if (raw === undefined) return DEFAULT_BUDGET_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_BUDGET_MS;
  return Math.min(value, MAX_BUDGET_MS);
}

function isEnabled(name: string): boolean {
  return process.env[name] === '1';
}

function safeString(value: unknown, max = 4_096): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || trimmed.includes('\u0000')) return null;
  return trimmed;
}

function parseInput(raw: string): CodexHookInput | null {
  if (Buffer.byteLength(raw, 'utf8') > MAX_STDIN_BYTES) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as CodexHookInput)
      : null;
  } catch {
    return null;
  }
}

function supportedEvent(value: unknown): CodexLifecycleEvent | null {
  return typeof value === 'string' && (CODEX_LIFECYCLE_EVENTS as readonly string[]).includes(value)
    ? (value as CodexLifecycleEvent)
    : null;
}

function normalizeInput(input: CodexHookInput): NormalizedInput | null {
  const event = supportedEvent(input.hook_event_name);
  const sessionId = safeString(input.session_id, 256);
  const cwd = safeString(input.cwd);
  if (!event || !sessionId || !cwd || !isAbsolute(cwd)) return null;

  const transcriptPath = input.transcript_path === null || input.transcript_path === undefined
    ? null
    : safeString(input.transcript_path, 8_192);
  const turnId = safeString(input.turn_id, 256);
  const detail = event === 'SessionStart'
    ? safeString(input.source, 64)
    : event === 'PreCompact'
      ? safeString(input.trigger, 64)
      : null;

  return {
    sessionId,
    cwd,
    event,
    transcriptPath,
    turnId,
    detail,
  };
}

function logHookError(reason: string): void {
  // Keep diagnostics categorical. Hook input can contain private paths and
  // prompt text; neither belongs in a durable error log.
  try {
    const root = stateRoot();
    mkdirSync(root, { recursive: true });
    const line = `${new Date().toISOString()} codex-lifecycle-hook: ${reason}\n`;
    appendFileSync(join(root, 'hook-errors.log'), line);
  } catch {
    // A lifecycle marker must never block the Codex turn.
  }
}

function normalizeWorkspace(value: string): string {
  try {
    return normalize(resolve(value));
  } catch {
    return normalize(value);
  }
}

function readTimelineTail(timelinePath: string): string {
  const st = statSync(timelinePath);
  const fd = openSync(timelinePath, 'r');
  try {
    const offset = Math.max(0, st.size - TIMELINE_TAIL_BYTES);
    const length = st.size - offset;
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, offset);
    let text = buffer.subarray(0, read).toString('utf8');
    if (offset > 0) {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

async function resolveSlug(cwd: string, startedAt?: number): Promise<string | null> {
  const override = process.env.GSTACK_PROJECT_SLUG?.replace(/[^A-Za-z0-9._-]/g, '');
  if (override) return override;
  const slugBin = join(repoRoot(), 'bin', 'gstack-slug');
  if (!existsSync(slugBin)) {
    logHookError('slug-helper-missing');
    return null;
  }
  const remaining = startedAt === undefined ? 500 : budgetMs() - (Date.now() - startedAt);
  if (remaining <= 0) {
    logHookError('budget-exhausted-before-slug');
    return null;
  }
  try {
    const result = await spawnOwned(slugBin, [], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GSTACK_HOME: stateRoot() },
      timeout: Math.min(500, Math.max(1, remaining)),
    });
    if (result.error) {
      logHookError(result.error.code === 'ETIMEDOUT' ? 'slug-timeout' : 'slug-spawn-error');
      return null;
    }
    if (result.signal) {
      logHookError('slug-signaled');
      return null;
    }
    if (result.status !== 0) {
      logHookError('slug-nonzero');
      return null;
    }
    const match = String(result.stdout || '').match(/^SLUG=([A-Za-z0-9._-]+)$/m);
    if (!match?.[1]) logHookError('slug-output-invalid');
    return match?.[1] || null;
  } catch {
    logHookError('slug-failed');
    return null;
  }
}

function eventAlreadyRecorded(
  timelinePath: string,
  entry: Record<string, unknown>,
): boolean {
  // Codex may omit turn_id for lifecycle events. Without a native turn
  // identity, repeated UserPromptSubmit/Stop/PreCompact events are all
  // legitimate and must not be collapsed into one marker.
  if (entry.turn_id === undefined) return false;
  if (!existsSync(timelinePath)) return false;
  let raw: string;
  try {
    raw = readTimelineTail(timelinePath);
  } catch {
    return false;
  }
  return raw.split('\n').some((line) => {
    if (!line.trim()) return false;
    try {
      const prior = JSON.parse(line) as Record<string, unknown>;
      return prior.skill === entry.skill
        && prior.event === entry.event
        && prior.session === entry.session
        && (prior.turn_id ?? null) === (entry.turn_id ?? null)
        && (prior.detail ?? null) === (entry.detail ?? null);
    } catch {
      return false;
    }
  });
}

async function appendTimelineOnce(input: NormalizedInput, partial = false, startedAt: number): Promise<void> {
  if (Date.now() - startedAt >= budgetMs()) return;
  const slug = await resolveSlug(input.cwd, startedAt);
  if (!slug) return;
  const root = stateRoot();
  const timelinePath = join(root, 'projects', slug, 'timeline.jsonl');
  const entry: Record<string, unknown> = {
    skill: 'codex-lifecycle',
    event: EVENT_NAMES[input.event],
    source: 'codex-hook',
    hook_event_name: input.event,
    session: input.sessionId,
    ...(input.turnId ? { turn_id: input.turnId } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(partial ? { partial: true } : {}),
  };
  if (eventAlreadyRecorded(timelinePath, entry)) return;

  const logger = join(repoRoot(), 'bin', 'gstack-timeline-log');
  if (!existsSync(logger)) return;
  try {
    const remaining = Math.max(1, budgetMs() - (Date.now() - startedAt));
    const result = await spawnOwned(logger, [JSON.stringify(entry)], {
      cwd: input.cwd,
      env: {
        ...process.env,
        GSTACK_HOME: root,
        GSTACK_STATE_ROOT: root,
        GSTACK_PROJECT_SLUG: slug,
      },
      timeout: Math.min(remaining, 800),
    });
    if (result.error) {
      logHookError(result.error.code === 'ETIMEDOUT' ? 'timeline-write-timeout' : 'timeline-write-spawn-error');
    } else if (result.signal) {
      logHookError('timeline-write-signaled');
    } else if (result.status !== 0) {
      logHookError('timeline-write-nonzero');
    }
  } catch {
    logHookError('timeline-write-failed');
  }
}

export function validateCurrentTranscript(
  input: Pick<NormalizedInput, 'sessionId' | 'cwd' | 'transcriptPath'>,
): TranscriptCheck {
  const transcriptPath = input.transcriptPath;
  if (!transcriptPath) {
    return { ok: false, reason: 'missing-transcript-path', transcriptPath: null, partial: false };
  }
  if (!isAbsolute(transcriptPath)) {
    return { ok: false, reason: 'invalid-transcript-path', transcriptPath: null, partial: false };
  }

  let st;
  try {
    const link = lstatSync(transcriptPath);
    if (!link.isFile() || link.isSymbolicLink()) {
      return { ok: false, reason: 'transcript-not-regular-file', transcriptPath, partial: false };
    }
    st = statSync(transcriptPath);
  } catch {
    return { ok: false, reason: 'unreadable-transcript', transcriptPath, partial: false };
  }
  if (st.size > MAX_TRANSCRIPT_BYTES) {
    return { ok: false, reason: 'transcript-too-large', transcriptPath, partial: false };
  }
  if (!isAbsolute(input.cwd)) {
    return { ok: false, reason: 'workspace-missing', transcriptPath, partial: false };
  }

  let parsed;
  try {
    parsed = parseTranscriptJsonl(transcriptPath);
  } catch {
    return { ok: false, reason: 'unreadable-transcript', transcriptPath, partial: false };
  }
  if (!parsed) {
    return { ok: false, reason: 'unreadable-transcript', transcriptPath, partial: false };
  }
  if (parsed.agent !== 'codex') {
    return { ok: false, reason: 'not-codex-transcript', transcriptPath, partial: parsed.partial };
  }
  if (parsed.session_id !== input.sessionId) {
    return { ok: false, reason: 'session-mismatch', transcriptPath, partial: parsed.partial };
  }
  if (!parsed.cwd || normalizeWorkspace(parsed.cwd) !== normalizeWorkspace(input.cwd)) {
    return { ok: false, reason: 'workspace-mismatch', transcriptPath, partial: parsed.partial };
  }
  if (parsed.partial && !isEnabled(ALLOW_PARTIAL_ENV)) {
    return { ok: false, reason: 'partial-transcript', transcriptPath, partial: true };
  }
  return { ok: true, reason: 'ok', transcriptPath, partial: parsed.partial };
}

interface ImporterOutcome {
  degraded: boolean;
  imported: number | null;
  reasons: string[];
}

function parseImporterOutcome(stdout: unknown, stderr: unknown): ImporterOutcome {
  const output = `${String(stdout ?? '')}\n${String(stderr ?? '')}`;
  const degradedLines = output.split(/\r?\n/).filter((line) => /^DEGRADED:\s*/.test(line));
  const reasons = [...new Set(degradedLines.flatMap((line) => line.replace(/^DEGRADED:\s*/, '').split(',')))]
    .map((reason) => reason.trim())
    .filter((reason) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(reason) && reason.length <= 64);
  const importedMatch = output.match(/^IMPORTED:\s+(\d+)\s+events?\b/m);
  return {
    degraded: degradedLines.length > 0,
    imported: importedMatch ? Number(importedMatch[1]) : null,
    reasons,
  };
}

function recordImporterOutcome(result: SpawnOwnedResult): void {
  const outcome = parseImporterOutcome(result.stdout, result.stderr);
  if (!outcome.degraded) {
    if (result.status === 0 && outcome.imported === null) logHookError('session-import-output-invalid');
    return;
  }

  const nonFailureReasons = new Set(['native-secret-skipped', 'native-async-unsupported']);
  const onlyNonFailureReasons = outcome.reasons.length > 0
    && outcome.reasons.every((reason) => nonFailureReasons.has(reason));
  if (outcome.imported !== null && outcome.imported > 0) {
    logHookError('session-import-partial');
  } else if (onlyNonFailureReasons) {
    logHookError('session-import-degraded');
  } else {
    logHookError('session-import-failed');
  }
  for (const reason of outcome.reasons) logHookError(`session-import-reason-${reason}`);
}

async function importCurrentSession(input: NormalizedInput, startedAt: number): Promise<void> {
  if (input.event !== 'SessionEnd' || !isEnabled(CURRENT_SESSION_INGEST_ENV)) return;
  if (Date.now() - startedAt >= budgetMs()) {
    logHookError('budget-exhausted-before-transcript-validation');
    return;
  }
  const check = validateCurrentTranscript(input);
  if (!check.ok) {
    logHookError(`transcript-${check.reason}`);
    return;
  }
  if (Date.now() - startedAt >= budgetMs()) {
    logHookError('budget-exhausted-before-transcript-import');
    return;
  }

  const importer = join(repoRoot(), 'bin', 'gstack-codex-session-import');
  if (!existsSync(importer)) {
    logHookError('session-importer-missing');
    return;
  }
  try {
    const slug = await resolveSlug(input.cwd, startedAt);
    const remainingAfterSlug = budgetMs() - (Date.now() - startedAt);
    if (remainingAfterSlug <= 0) {
      logHookError('budget-exhausted-before-transcript-import');
      return;
    }
    const result = await spawnOwned('bash', [importer, check.transcriptPath!], {
      cwd: input.cwd,
      env: {
        ...process.env,
        GSTACK_HOME: stateRoot(),
        GSTACK_STATE_ROOT: stateRoot(),
        ...(slug ? { GSTACK_PROJECT_SLUG: slug } : {}),
      },
      timeout: Math.min(remainingAfterSlug, IMPORT_TIMEOUT_MS),
    });
    recordImporterOutcome(result);
    if (result.error) {
      logHookError(result.error.code === 'ETIMEDOUT' ? 'session-import-timeout' : 'session-import-spawn-error');
    } else if (result.signal) {
      logHookError('session-import-signaled');
    } else if (result.status !== 0) {
      logHookError('session-import-nonzero');
    }
  } catch {
    logHookError('session-import-failed-or-timeout');
  }
}

function writeOutput(): void {
  // Never return prompt/transcript data. Explicitly affirm continuation for
  // Stop and UserPromptSubmit, whose native contract accepts JSON on stdout.
  process.stdout.write('{"continue":true}\n');
}

export async function runLifecycle(raw: string): Promise<void> {
  const startedAt = Date.now();
  const input = parseInput(raw);
  const normalized = input ? normalizeInput(input) : null;
  if (!normalized) {
    logHookError('malformed-or-unsupported-input');
    return;
  }
  if (budgetMs() === 0) {
    logHookError('budget-exhausted');
    return;
  }
  // Marker writes are safe and contain no prompt/transcript content. The
  // SessionEnd marker is written even when opt-in ingestion is absent; this
  // keeps lifecycle/artifact state useful without silently capturing data.
  await appendTimelineOnce(normalized, false, startedAt);
  await importCurrentSession(normalized, startedAt);
}

async function main(): Promise<void> {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
    await runLifecycle(raw);
  } catch {
    logHookError('hook-runtime-failed');
  } finally {
    writeOutput();
  }
}

if (import.meta.main) void main();
