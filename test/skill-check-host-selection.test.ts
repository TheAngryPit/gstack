import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'path';
import { discoverTemplates } from '../scripts/discover-skills';
import { runGeneration } from '../scripts/gen-skill-docs';
import { getHostConfig } from '../hosts';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');

describe('health-check template selection matches generation', () => {
  test('Claude excludes the intentional non-Claude outside voice', () => {
    const templates = discoverTemplates(ROOT, getHostConfig('claude').generation);
    expect(templates.some(t => t.output === 'claude/SKILL.md')).toBe(false);
    expect(templates.some(t => t.output === 'codex/SKILL.md')).toBe(true);
    expect(templates.some(t => t.output === 'SKILL.md')).toBe(true);
  });

  test('Codex uses native review and excludes both legacy provider wrappers', () => {
    const templates = discoverTemplates(ROOT, getHostConfig('codex').generation);
    expect(templates.some(t => t.output === 'claude/SKILL.md')).toBe(false);
    expect(templates.some(t => t.output === 'codex/SKILL.md')).toBe(false);
  });

  test('allowlist minus denylist uses the generator contract', () => {
    const templates = discoverTemplates(ROOT, { includeSkills: ['ship', 'claude'], skipSkills: ['claude'] });
    expect(templates.map(t => t.output)).toEqual(['ship/SKILL.md']);
  });

  test('unfiltered discovery still includes every source template', () => {
    const templates = discoverTemplates(ROOT);
    expect(templates).toContainEqual({ tmpl: 'SKILL.md.tmpl', output: 'SKILL.md' });
    expect(templates).toContainEqual({ tmpl: 'codex/SKILL.md.tmpl', output: 'codex/SKILL.md' });
  });

  test('invalid and missing explicit models fail before any generator runs', () => {
    for (const args of [[], ['unsupported-model']]) {
      const result = spawnSync(process.execPath, ['run', 'scripts/skill-check.ts', '--codex-model', ...args], {
        cwd: ROOT, encoding: 'utf8', timeout: 10_000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--codex-model requires a supported generation model');
      expect(result.stdout).not.toContain('Generating all hosts');
      expect(result.stdout).not.toContain('Freshness');
    }
  });

  test('an explicit Codex model override only changes the Codex render', async () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-model-check-'));
    try {
      const result = await runGeneration({ host: 'all', outputRoot: output, contentLinkRoot: null, codexModel: 'gpt-6-astra' });
      expect(result.exitCode).toBe(0);
      const codex = fs.readFileSync(path.join(output, '.agents', 'skills', 'gstack-review', 'SKILL.md'), 'utf8');
      const claude = fs.readFileSync(path.join(output, 'review', 'SKILL.md'), 'utf8');
      expect(codex).toContain('--skill "review" --model "gpt-6-astra"');
      expect(claude).toContain('--skill "review" --model "claude"');
      expect(claude).not.toContain('Model-Specific Behavioral Patch (gpt-6-astra)');
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
  });
});
