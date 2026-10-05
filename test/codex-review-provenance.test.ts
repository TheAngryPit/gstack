import {describe, expect, test} from 'bun:test';
import {RESOLVERS} from '../scripts/resolvers';
import {HOST_PATHS, type TemplateContext} from '../scripts/resolvers/types';

const ctx: TemplateContext = {skillName:'review', tmplPath:'review/SKILL.md.tmpl', host:'codex', paths:HOST_PATHS.codex};
describe('native review navigation and provenance', () => {
  test('section navigation does not require a provider removed from native execution', () => {
    for (const output of [RESOLVERS.SECTION(ctx,['adversarial']), RESOLVERS.SECTION_INDEX(ctx,['review'])]) {
      expect(output).toContain('adversarial');
      expect(output).not.toContain('Claude subagent');
    }
  });
  test('same-model independent reviews are not reported as cross-model agreement', () => {
    const output = RESOLVERS.LEARNINGS_LOG(ctx);
    expect(output).not.toContain('both Claude and Codex agree');
    expect(output).toContain('distinct actual models');
    expect(output).toContain('same-model reviewers do not qualify');
    expect(RESOLVERS.LEARNINGS_LOG({...ctx,host:'claude',paths:HOST_PATHS.claude})).toContain('both Claude and Codex agree');
  });
});
