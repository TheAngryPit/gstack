/** Explicit Codex stdio binding. Never infer a brain from registration order. */
import { readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join } from 'path';
import { createHash } from 'crypto';
import { buildGbrainEnv } from './gbrain-exec';
import { resolveStateRoot } from './state-root';

export interface CodexBrainBinding {
  schema: 1;
  server: string;
  codexHome: string;
  command: string;
  home: string;
  source: string;
  fingerprint: string;
}
export function bindingPath(env = process.env): string {
  return join(resolveStateRoot(env), 'gbrain-codex-binding.json');
}
function readSelection(server: string, codexHome: string): {binding: CodexBrainBinding; env: Record<string,string>} {
  if (!server || !isAbsolute(codexHome)) throw new Error('Select an explicit Codex MCP server and absolute Codex home.');
  let parsed: any;
  try { parsed = Bun.TOML.parse(readFileSync(join(codexHome, 'config.toml'), 'utf8')); }
  catch { throw new Error('Cannot read the Codex MCP configuration.'); }
  const entry = parsed.mcp_servers?.[server];
  if (!entry || entry.enabled === false || entry.url || !isAbsolute(entry.command || '') ||
      JSON.stringify(entry.args) !== '["serve"]' || !isAbsolute(entry.env?.GBRAIN_HOME || '') ||
      typeof entry.env?.GBRAIN_SOURCE !== 'string' || !entry.env.GBRAIN_SOURCE) {
    throw new Error('Selected server must be enabled local gbrain stdio with explicit GBRAIN_HOME and GBRAIN_SOURCE.');
  }
  if (Object.values(entry.env).some(v => typeof v !== 'string')) throw new Error('Invalid server environment.');
  // A direct CLI cannot enforce native MCP tool allowlists or per-tool
  // approvals. Refuse those (and unknown future controls), never bypass them.
  const supportedFields = new Set(['command','args','env','env_vars','enabled','required','startup_timeout_sec','startup_timeout_ms','tool_timeout_sec']);
  if (Object.keys(entry).some(key => !supportedFields.has(key))) throw new Error('Constrained or unsupported MCP registrations must use their native tool surface.');
  if (entry.env_vars?.length) throw new Error('Inherited Codex env_vars are unsupported; use an explicitly configured stdio environment.');
  if (entry.env.GBRAIN_BRAIN_ID && entry.env.GBRAIN_BRAIN_ID !== 'host') throw new Error('This binding supports the configured host brain, not mounted brains.');
  const command = realpathSync(entry.command);
  if (basename(command) !== 'gbrain') throw new Error('Selected executable must be named gbrain so detector probes use that exact command.');
  const home = entry.env.GBRAIN_HOME;
  const source = entry.env.GBRAIN_SOURCE;
  const config = readFileSync(join(home, '.gbrain', 'config.json'));
  let engine: unknown;
  try { engine = JSON.parse(config.toString()).engine; }
  catch { throw new Error('Cannot read the selected brain configuration.'); }
  if (engine !== 'postgres') throw new Error('CLI enrichment requires an explicit Postgres engine. PGLite must use its owning native MCP server.');
  const fingerprint = createHash('sha256').update(JSON.stringify({command, registration: entry})).update(config).digest('hex');
  return {binding: {schema: 1, server, codexHome, command, home, source, fingerprint}, env: entry.env};
}
export function selectCodexBrain(server: string, codexHome = process.env.CODEX_HOME || join(process.env.HOME || homedir(), '.codex')): CodexBrainBinding {
  return readSelection(server,codexHome).binding;
}
export function loadCodexBrain(): CodexBrainBinding {
  let saved: CodexBrainBinding;
  try { saved = JSON.parse(readFileSync(bindingPath(), 'utf8')); }
  catch { throw new Error('No valid Codex GBrain binding. Refresh with an explicit --server.'); }
  if (saved.schema !== 1) throw new Error('Unsupported GBrain binding. Refresh explicitly.');
  const current = selectCodexBrain(saved.server, saved.codexHome);
  if (JSON.stringify(current) !== JSON.stringify(saved)) throw new Error('GBrain binding changed. Refresh explicitly before use.');
  return current;
}
export function codexBrainEnv(binding: CodexBrainBinding): NodeJS.ProcessEnv {
  // Explicit binding wins over an unrelated caller's environment. Database
  // credentials stay in the existing brain config and are never persisted here.
  const current=readSelection(binding.server,binding.codexHome);
  if (current.binding.fingerprint !== binding.fingerprint) throw new Error('GBrain binding changed before invocation. Refresh explicitly.');
  const base: NodeJS.ProcessEnv = {...process.env};
  for (const key of Object.keys(base)) {
    if (key.startsWith('GBRAIN_') || key.startsWith('PG') || key === 'DATABASE_URL') delete base[key];
  }
  Object.assign(base,current.env);
  base.GBRAIN_BRAIN_ID='host';
  delete base.GSTACK_RESPECT_ENV_DATABASE_URL;
  // The helper protects against ambient DATABASE_URL, not an explicit native
  // registration. Carry this derived opt-out through nested detector helpers.
  if (current.env.DATABASE_URL) base.GSTACK_RESPECT_ENV_DATABASE_URL='1';
  const result=buildGbrainEnv({baseEnv: base});
  // The installed CLI prioritizes this over DATABASE_URL and cwd dotenv.
  if (!current.env.GBRAIN_DATABASE_URL && result.DATABASE_URL) result.GBRAIN_DATABASE_URL=result.DATABASE_URL;
  return result;
}

/** Detector finds `gbrain` on PATH; retain the native interpreter/helper PATH. */
export function codexBrainProbeEnv(binding: CodexBrainBinding): NodeJS.ProcessEnv {
  const env = codexBrainEnv(binding);
  env.PATH = `${dirname(binding.command)}:${env.PATH || ''}`;
  return env;
}
