/**
 * Live codex CLI flag-semantics smoke for `codex exec resume`.
 *
 * Closes the gap left by #1270's regex-only assertion against codex/SKILL.md.
 * That regex catches the SKILL.md regressing back to `-C/-s` flags, but it
 * does not catch the codex CLI itself flipping flag semantics again. This
 * test probes the live `codex exec resume --help` output and asserts the
 * surface the gstack /codex skill depends on.
 *
 * Skips silently when codex is not on PATH, so dev machines without codex
 * installed never see this fail. CI lanes that run with codex installed
 * (the periodic-tier eval runners) will exercise it.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const codexPath = Bun.which('codex');
const codexAvailable = Boolean(codexPath);

function runResumeHelp() {
  const root = mkdtempSync(join(tmpdir(), 'gstack-codex-resume-help-'));
  const home = join(root, 'home');
  const codexHome = join(root, 'codex-home');
  const temp = join(root, 'tmp');
  const appData = join(root, 'appdata');
  const localAppData = join(root, 'local-appdata');
  for (const directory of [home, codexHome, temp, appData, localAppData]) {
    mkdirSync(directory, { recursive: true });
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };
  // Never pass ambient model-provider credentials to this help-only probe.
  // The fresh CODEX_HOME is intentionally empty; no auth/config files are copied.
  const credentialName = /^(?:CODEX|OPENAI|ANTHROPIC|CLAUDE|GEMINI|GOOGLE|AZURE_OPENAI)_.*(?:API_KEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|SESSION_TOKEN|CREDENTIALS?)$/i;
  for (const name of Object.keys(env)) {
    if (credentialName.test(name)) delete env[name];
  }

  try {
    return spawnSync(codexPath!, ['exec', 'resume', '--help'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      env,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!codexAvailable)(
  'codex exec resume — flag semantics (live CLI smoke; closes #1270 regex-only gap)',
  () => {
    test('codex exec resume --help mentions sandbox_mode as a -c config key', () => {
      const result = runResumeHelp();
      const helpText = (result.stdout || '') + '\n' + (result.stderr || '');
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      // The /codex skill builds resume invocations with `-c 'sandbox_mode="read-only"'`.
      // If codex stops accepting `-c sandbox_mode=...` for the resume subcommand,
      // every resume invocation through gstack starts failing.
      expect(helpText).toMatch(/-c\b|--config\b|sandbox_mode/i);
    });

    test('codex exec resume --help does NOT advertise -C as a top-level flag', () => {
      const result = runResumeHelp();
      const helpText = (result.stdout || '') + '\n' + (result.stderr || '');
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      // The whole point of #1270 was that `codex exec resume` rejects `-C <dir>`.
      // If the help text starts listing `-C` again, the SKILL.md guidance to
      // drop `-C` is wrong and the surrounding `cd "$_REPO_ROOT"` workaround is
      // unnecessary. Either way, /codex needs an update.
      // Allow `-C` to appear in flag descriptions or option-name strings as long
      // as it isn't presented as a flag of the `resume` subcommand. The cheapest
      // signal: the `Options:` block (or first-column flag list) should not
      // contain a literal `-C ` flag entry on its own line.
      const optionLines = helpText
        .split('\n')
        .map((l) => l.trimStart())
        .filter((l) => /^-[A-Za-z],?\s/.test(l) || /^--[A-Za-z]/.test(l));
      const hasTopLevelDashC = optionLines.some((l) => /^-C[\s,]/.test(l));
      expect(hasTopLevelDashC).toBe(false);
    });
  },
);
