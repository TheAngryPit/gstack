import { describe, expect, test } from 'bun:test';
import codex from '../hosts/codex';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { RESOLVERS } from '../scripts/resolvers';
import { generateAskUserFormat } from '../scripts/resolvers/preamble/generate-ask-user-format';

const ctx: TemplateContext = { skillName: 'review', tmplPath: 'review/SKILL.md.tmpl', host: 'codex', paths: HOST_PATHS.codex };

describe('Codex native capability parity', () => {
  test('legacy recursive/provider wrappers are excluded, review capability remains', () => {
    expect(codex.generation.skipSkills).toEqual(['codex']);
    for (const name of ['DESIGN_OUTSIDE_VOICES', 'ADVERSARIAL_STEP', 'CODEX_SECOND_OPINION', 'CODEX_PLAN_REVIEW', 'CODEX_DOC_REVIEW', 'REVIEW_ARMY']) {
      expect(codex.suppressedResolvers).not.toContain(name);
      const output = RESOLVERS[name](name === 'DESIGN_OUTSIDE_VOICES' ? { ...ctx, skillName: 'plan-design-review' } : ctx);
      expect(output).toContain('Codex independent review');
      expect(output).toContain('fork_turns: "none"');
      expect(output).toContain('advertised');
      expect(output).toContain('NOT');
      expect(output).toContain('OS/filesystem isolation');
      expect(output).toContain('review_not_run');
      expect(output).toContain('no tools');
      expect(output).toContain('current owner');
      expect(output).not.toContain('claude -p');
      expect(output).not.toContain('codex exec');
    }
  });

  test('native questions respect schema and authority without fabricated hooks', () => {
    const output = generateAskUserFormat(ctx);
    expect(output).toContain('request_user_input');
    expect(output).toContain('two or three');
    expect(output).toContain('Never use it for permission');
    expect(output).toContain('No answer');
    expect(output).not.toContain('Auto-choose');
    expect(output).not.toContain('Tool resolution (read first)');
  });

  test('Codex MCP setup preserves binding and distinguishes readback proof', () => {
    const output = RESOLVERS.GBRAIN_HOST_MCP(ctx);
    expect(output).toContain('codex mcp add gbrain --env');
    expect(output).toContain('GBRAIN_HOME');
    expect(output).toContain('GBRAIN_SOURCE');
    expect(output).toContain('--bearer-token-env-var');
    expect(output).toContain('not proof of absence');
    expect(output).toContain('not MCP runtime proof');
    expect(output).not.toContain('claude mcp');
    expect(output).not.toContain('mcp remove');
    expect(RESOLVERS.GBRAIN_HOST_MCP({ ...ctx, host: 'claude' })).toContain('claude mcp add');
  });

  test('transcript guidance never conflates source type, scope, capture or sync', () => {
    const output = RESOLVERS.GBRAIN_HOST_TRANSCRIPTS(ctx);
    expect(output).toContain('no current-repo filter');
    expect(output).toContain('not automatically ingest');
    expect(output).toContain('off` means never ingest');
    expect(output).toContain('NOT a read-only probe');
    expect(output).toContain('configured provider');
    expect(output).not.toContain('silent bulk');
    expect(output).not.toContain('--full --no-brain-sync');
  });

  test('spec execution keeps native worker and completion handle', () => {
    const output = RESOLVERS.SPEC_HOST_DISPATCH(ctx);
    expect(output).toContain('native Codex worker');
    expect(output).toContain('spec_executed: false');
    expect(output).toContain('native waiting');
    expect(output).not.toContain('claude -p');
    expect(RESOLVERS.SPEC_HOST_DISPATCH({ ...ctx, host: 'claude' })).toContain('claude -p');
  });
});
