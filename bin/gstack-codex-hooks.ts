#!/usr/bin/env bun
/**
 * Reconcile the user-level Codex hooks.json entry owned by gstack.
 *
 * This helper only manages the five lifecycle events implemented by the
 * Codex-native bridge. It never edits Codex trust state: `/hooks` remains the
 * native review/trust boundary and Codex will hash the exact installed hook.
 * Foreign matcher groups and handlers are preserved, including when they
 * share a group with the gstack handler.
 */

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, normalize, resolve } from 'path';
import { fileURLToPath } from 'url';

export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'PreCompact',
  'SessionEnd',
] as const;

export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];
export type ReconcileAction = 'status' | 'plan' | 'install' | 'remove';

const DEFAULT_TIMEOUT_SECONDS = 3;
const MAX_TIMEOUT_SECONDS = 600;
const SOURCE_LABEL = 'gstack-codex-lifecycle';

type JsonObject = Record<string, unknown>;

interface HookHandler extends JsonObject {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
}

interface MatcherGroup extends JsonObject {
  hooks?: unknown;
}

export interface CodexHooksConfig extends JsonObject {
  hooks?: unknown;
}

export interface ReconcileOptions {
  configPath?: string;
  root?: string;
  command?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export interface EventStatus {
  event: CodexHookEvent;
  installed: boolean;
  count: number;
  duplicateCount: number;
  malformedGroupCount: number;
  staleCount: number;
  state: 'installed' | 'stale' | 'missing';
}

export interface ReconcileReport {
  schema: 1;
  action: ReconcileAction;
  configPath: string;
  configExists: boolean;
  command: string;
  timeout: number;
  source: string;
  changed: boolean;
  trust: 'native-review-required' | 'native-review-unchanged';
  events: EventStatus[];
  error?: string;
}

interface LoadedConfig {
  config: CodexHooksConfig;
  exists: boolean;
}

interface ReconcileResult {
  config: CodexHooksConfig;
  events: EventStatus[];
  changed: boolean;
}

function defaultRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function resolveConfigPath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicit) return resolve(explicit);
  const codexHome = env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
  return resolve(codexHome, 'hooks.json');
}

export function resolveHookCommand(
  root = defaultRoot(),
): string {
  const hook = resolve(root, 'hosts', 'codex', 'hooks', 'codex-lifecycle-hook');
  // Codex executes command hooks through a shell. Quote every executable path,
  // not only paths containing whitespace: a valid repository root may contain
  // shell metacharacters without spaces (for example `gstack;review`).
  return `"${hook.replace(/["\\$`]/g, '\\$&')}"`;
}

function normalizeCommand(command: string): string {
  // Keep whitespace inside quoted paths intact. Codex executes this as a
  // shell command, and a repository can legitimately contain repeated spaces.
  return command.trim();
}

function commandPath(command: string): string | null {
  const value = normalizeCommand(command);
  // Parse a single literal shell word, optionally behind a supported legacy
  // interpreter. isAbsolute() alone also accepts "/bin/true; /old/.../hook".
  // Never execute a command to establish ownership.
  const token = value.replace(/^(?:bash|sh|bun)[ \t]+/, '');
  if (!token || /[\0\r\n]/.test(token)) return null;
  let unquoted = '';
  if (token.startsWith("'")) {
    if (!/^'[^']*'$/.test(token)) return null;
    unquoted = token.slice(1, -1); // backslashes are literal in single quotes
  } else if (token.startsWith('"')) {
    if (!token.endsWith('"')) return null;
    for (let i = 1; i < token.length - 1; i++) {
      const char = token[i];
      if (char === '"' || char === '$' || char === '`') return null;
      if (char === '\\') {
        if (i + 1 >= token.length - 1) return null;
        const next = token[i + 1];
        if ('"\\$`'.includes(next)) { unquoted += next; i++; }
        else unquoted += char;
      } else unquoted += char;
    }
  } else {
    // No expansions, redirections, operators, escapes, whitespace or globs.
    if (!/^[a-zA-Z0-9_./:@%+=,-]+$/.test(token)) return null;
    unquoted = token;
  }
  return isAbsolute(unquoted) ? normalize(unquoted) : null;
}

function sameCommand(actual: unknown, wanted: string): boolean {
  if (typeof actual !== 'string') return false;
  const normalizedActual = normalizeCommand(actual);
  const normalizedWanted = normalizeCommand(wanted);
  if (normalizedActual === normalizedWanted) return true;
  const actualPath = commandPath(normalizedActual);
  const wantedPath = commandPath(normalizedWanted);
  return Boolean(actualPath && wantedPath && actualPath === wantedPath);
}

function lifecyclePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = commandPath(value);
  if (!parsed) return null;
  return parsed.replace(/\\/g, '/');
}

function ownsCommand(actual: unknown, wanted: string): boolean {
  if (sameCommand(actual, wanted)) return true;
  // A previous checkout can leave an absolute command pointing at an older
  // gstack root. Repoint only the unmistakable bridge suffix; do not claim a
  // basename-only or arbitrary foreign command.
  const actualPath = lifecyclePath(actual);
  const wantedPath = lifecyclePath(wanted);
  const suffix = '/hosts/codex/hooks/codex-lifecycle-hook';
  return Boolean(actualPath && wantedPath &&
    actualPath.endsWith(suffix) && wantedPath.endsWith(suffix));
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHandler(value: unknown): value is HookHandler {
  return isObject(value);
}

function isGroup(value: unknown): value is MatcherGroup {
  return isObject(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function loadConfig(configPath: string): LoadedConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { config: {}, exists: false };
    }
    throw new Error(`cannot read ${configPath}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in ${configPath}: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error(`${configPath} must contain a JSON object`);
  if (parsed.hooks !== undefined && !isObject(parsed.hooks)) {
    throw new Error(`${configPath}.hooks must be a JSON object`);
  }
  return { config: parsed as CodexHooksConfig, exists: true };
}

function validateTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeout must be greater than 0 and at most ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeout;
}

function eventEntries(config: CodexHooksConfig, event: CodexHookEvent): unknown[] {
  const hooks = config.hooks;
  if (!isObject(hooks)) return [];
  const value = hooks[event];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${event} hooks must be an array`);
  return value;
}

function inspectEvent(
  config: CodexHooksConfig,
  event: CodexHookEvent,
  command: string,
  timeout: number,
): EventStatus {
  const entries = eventEntries(config, event);
  let count = 0;
  let staleCount = 0;
  let duplicateCount = 0;
  let malformedGroupCount = 0;
  for (const entry of entries) {
    if (!isGroup(entry) || !Array.isArray(entry.hooks)) {
      malformedGroupCount += 1;
      continue;
    }
    for (const handler of entry.hooks) {
      if (!isHandler(handler)) continue;
      const owned = sameCommand(handler.command, command) || ownsCommand(handler.command, command);
      const managed = handler.type === 'command'
        && sameCommand(handler.command, command)
        && handler.timeout === timeout;
      if (managed) {
        count += 1;
      } else if (owned) {
        // A command match is not enough to prove Codex will execute the
        // handler we installed: a wrong type or stale timeout is a repairable
        // registration defect, not an installed lifecycle hook.
        staleCount += 1;
      }
    }
  }
  duplicateCount = Math.max(0, count - 1);
  const state = count > 0 ? 'installed' : staleCount > 0 ? 'stale' : 'missing';
  return { event, installed: count > 0, count, duplicateCount, malformedGroupCount, staleCount, state };
}

function ensureHandler(
  config: CodexHooksConfig,
  event: CodexHookEvent,
  command: string,
  timeout: number,
): EventStatus {
  const hooks = (config.hooks ??= {} as JsonObject) as JsonObject;
  const entries = eventEntries(config, event);
  let found = false;
  const nextEntries: unknown[] = [];
  for (const entry of entries) {
    if (!isGroup(entry) || !Array.isArray(entry.hooks)) {
      // Do not reinterpret malformed or foreign entries. Add our own matcher
      // group below instead of risking data loss.
      nextEntries.push(entry);
      continue;
    }
    if (entry.hooks.length === 0) {
      // An empty matcher group can still carry user intent or future fields;
      // do not erase it merely because it has no handlers today.
      nextEntries.push(entry);
      continue;
    }
    const nextHandlers: unknown[] = [];
    for (const handler of entry.hooks) {
      if (!isHandler(handler) || !ownsCommand(handler.command, command)) {
        nextHandlers.push(handler);
        continue;
      }
      if (found) continue;
      found = true;
      // Keep an equivalent legacy wrapper/quoting form intact. Reconciliation
      // should repair ownership and timeout without creating needless trust
      // churn from a cosmetic command-string rewrite.
      const owned = {
        ...handler,
        type: 'command',
        // Status accepts equivalent legacy forms, but installation always
        // writes the canonical shell-quoted executable so a metacharacter in
        // the root cannot be reinterpreted by Codex's shell.
        command,
        timeout,
      };
      nextHandlers.push(owned);
    }
    if (nextHandlers.length > 0) {
      nextEntries.push({ ...entry, hooks: nextHandlers });
    }
  }
  if (!found) {
    nextEntries.push({ hooks: [{ type: 'command', command, timeout }] });
  }
  hooks[event] = nextEntries;
  return inspectEvent(config, event, command, timeout);
}

function removeHandlers(
  config: CodexHooksConfig,
  event: CodexHookEvent,
  command: string,
  timeout: number,
): EventStatus {
  const hooks = config.hooks;
  if (!isObject(hooks) || hooks[event] === undefined) {
    return inspectEvent(config, event, command, timeout);
  }
  const entries = eventEntries(config, event);
  const nextEntries: unknown[] = [];
  for (const entry of entries) {
    if (!isGroup(entry) || !Array.isArray(entry.hooks)) {
      nextEntries.push(entry);
      continue;
    }
    const remaining = entry.hooks.filter((handler) =>
      !(isHandler(handler) && ownsCommand(handler.command, command)));
    if (remaining.length > 0 || entry.hooks.length === 0) {
      nextEntries.push({ ...entry, hooks: remaining });
    }
  }
  if (nextEntries.length > 0) hooks[event] = nextEntries;
  else delete hooks[event];
  if (Object.keys(hooks).length === 0) delete config.hooks;
  return inspectEvent(config, event, command, timeout);
}

function reconcile(
  config: CodexHooksConfig,
  action: Exclude<ReconcileAction, 'status'>,
  command: string,
  timeout: number,
): ReconcileResult {
  const next = clone(config);
  const events: EventStatus[] = [];
  for (const event of CODEX_HOOK_EVENTS) {
    if (action === 'remove') {
      events.push(removeHandlers(next, event, command, timeout));
    } else {
      events.push(ensureHandler(next, event, command, timeout));
    }
  }
  return { config: next, events, changed: !jsonEqual(config, next) };
}

function writeConfig(configPath: string, config: CodexHooksConfig, exists: boolean): void {
  if (exists) {
    const link = lstatSync(configPath);
    if (!link.isFile() || link.isSymbolicLink()) throw new Error(`${configPath} is not a regular file`);
  }
  mkdirSync(dirname(configPath), { recursive: true });
  const mode = exists ? (statSync(configPath).mode & 0o777) : 0o600;
  const temporary = `${configPath}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, configPath);
  } finally {
    try { unlinkSync(temporary); } catch { /* already renamed */ }
  }
}

function configReport(
  action: ReconcileAction,
  options: Required<Pick<ReconcileOptions, 'configPath' | 'command' | 'timeout'>>,
  loaded: LoadedConfig,
  events: EventStatus[],
  changed: boolean,
  error?: string,
): ReconcileReport {
  return {
    schema: 1,
    action,
    configPath: options.configPath,
    configExists: loaded.exists,
    command: options.command,
    timeout: options.timeout,
    source: SOURCE_LABEL,
    changed,
    trust: changed ? 'native-review-required' : 'native-review-unchanged',
    events,
    ...(error ? { error } : {}),
  };
}

export function reconcileCodexHooks(
  action: ReconcileAction,
  input: ReconcileOptions = {},
): ReconcileReport {
  const configPath = resolveConfigPath(input.configPath, input.env);
  const root = resolve(input.root || defaultRoot());
  const command = normalizeCommand(input.command || resolveHookCommand(root));
  const timeout = validateTimeout(input.timeout);
  const options = { configPath, command, timeout };
  const loaded = loadConfig(configPath);
  if (action === 'status') {
    return configReport(action, options, loaded,
      CODEX_HOOK_EVENTS.map((event) => inspectEvent(loaded.config, event, command, timeout)), false);
  }
  const result = reconcile(loaded.config, action, command, timeout);
  if (action === 'install' && result.changed) writeConfig(configPath, result.config, loaded.exists);
  if (action === 'remove' && result.changed) writeConfig(configPath, result.config, loaded.exists);
  return configReport(action, options, loaded, result.events, result.changed);
}

function parseArgs(argv: string[]): {
  action: ReconcileAction;
  options: ReconcileOptions;
  json: boolean;
} {
  let action: ReconcileAction | null = null;
  const options: ReconcileOptions = {};
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--config' || arg === '--root' || arg === '--command' || arg === '--timeout') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      if (arg === '--config') options.configPath = value;
      if (arg === '--root') options.root = value;
      if (arg === '--command') options.command = value;
      if (arg === '--timeout') options.timeout = Number(value);
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    if (!action) {
      if (!['status', 'plan', 'install', 'remove'].includes(arg)) throw new Error(`unknown action: ${arg}`);
      action = arg as ReconcileAction;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (!action) throw new Error('an action is required: status, plan, install, or remove');
  return { action, options, json };
}

function printUsage(): void {
  process.stdout.write(`Usage: gstack-codex-hooks <status|plan|install|remove> [options]\n\nOptions:\n  --config <path>   Codex hooks.json (default: $CODEX_HOME/hooks.json)\n  --root <path>     gstack repository root (default: this installation)\n  --command <cmd>   exact lifecycle hook command to reconcile\n  --timeout <sec>   native hook timeout (default: ${DEFAULT_TIMEOUT_SECONDS})\n  --json             emit one machine-readable JSON report\n`);
}

function printHuman(report: ReconcileReport): void {
  process.stdout.write(`${report.action}: ${report.changed ? 'changed' : 'unchanged'}\n`);
  process.stdout.write(`config: ${report.configPath}\ncommand: ${report.command}\n`);
  for (const status of report.events) {
    process.stdout.write(`  ${status.event}: ${status.state} (${status.count}${status.staleCount ? `, stale=${status.staleCount}` : ''})\n`);
  }
  process.stdout.write(`trust: ${report.trust} — review the exact hook with /hooks\n`);
}

export function cliMain(argv = process.argv.slice(2)): number {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
    const report = reconcileCodexHooks(parsed.action, parsed.options);
    if (parsed.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else printHuman(report);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const output = JSON.stringify({ schema: 1, error: message });
    process.stderr.write(`${output}\n`);
    return 2;
  }
}

if (import.meta.main) process.exit(cliMain());
